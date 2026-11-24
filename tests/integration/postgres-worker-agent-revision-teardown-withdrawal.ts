import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  admitRepositoryNetworkPolicy,
  type ComputeDriver,
} from "../../packages/contracts/src/index.ts";
import { repositoryRemovalWorkKey } from "../../packages/occ/src/repository-withdrawal.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import {
  advanceCleanupRetries,
  completion,
  deferWork,
  makeWorkDue,
} from "../helpers/postgres-worker-revision-queue.ts";
import {
  removeAccessBindings,
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import {
  required,
  type RevisionSetup,
  readWorkerEvent,
  type WorkerEvent,
} from "./postgres-worker-agent-revision-teardown-fixture.ts";

type Withdrawal = NonNullable<ComputeDriver["retireExpiredRepositoryAccess"]>;
type WithdrawalObservation = Awaited<ReturnType<Withdrawal>> | "unconfirmed";

const deadlineCases = [
  ["withdrawn", "withdrawn"],
  ["pending then stop", "pending"],
  ["pending then superseded", "pending"],
  ["unconfirmed then withdrawn", "unconfirmed"],
  ["lost maintenance claim", "withdrawn"],
  ["retire-runtime", "retire-runtime"],
  ["unsupported", "withdrawn"],
] as const satisfies readonly (readonly [string, WithdrawalObservation])[];

export function testDeadlineWithdrawal(setup: RevisionSetup) {
  testPolicyWithdrawal(setup);
  for (const [scenario, initialObservation] of deadlineCases) {
    test(
      `scheduled maintenance at the admitted Git deadline: ${scenario}`,
      requiresPostgres,
      async (t) => {
        const repository = repositoryBoundary();
        const fixture = await setup(t, { repoDriver: repository.driver });
        repository.snapshot.deadlineWallMs = Date.now() + 4_000;
        const { owner, candidate } = await fixture.admitInitialRevision("git-expiry", {
          revision: { repositoryCredentials: repository.snapshot },
        });
        const stopped: string[] = [];
        const events: WorkerEvent[] = [];
        let preparations = 0;
        let observations = 0;
        let result: WithdrawalObservation = initialObservation;
        const compute: ComputeDriver = {
          ...fixture.compute,
          async prepareRevision(revision, context) {
            if (revision.id === candidate.id) {
              preparations++;
            }
            return fixture.compute.prepareRevision(revision, context);
          },
          ...(scenario === "unsupported"
            ? {}
            : {
                async retireExpiredRepositoryAccess(revision, signal) {
                  assert.equal(revision.id, candidate.id);
                  signal.throwIfAborted();
                  observations++;
                  if (result === "unconfirmed") {
                    throw new Error("withdrawal reply lost");
                  }
                  return result;
                },
              }),
          async stopRevision(revision) {
            stopped.push(revision.id);
            return fixture.compute.stopRevision(revision);
          },
        };
        const start = () =>
          fixture.start(compute, { emit: (event) => events.push(readWorkerEvent(event)) });
        const completed = (label: string) =>
          completion(
            events,
            label,
            (event) =>
              event.event === "worker.completed" &&
              event.revisionId === candidate.id &&
              event.workId?.includes(":repository_cleanup:"),
          );
        await start();
        await fixture.work(candidate, "succeeded");
        await fixture.stop();
        const [original] = await repositoryAttempts(fixture, candidate);
        assert.ok(original, "expected original repository attempt");
        assert.equal(original.phase, "open");
        assert.equal(original.deadlineWallMs, repository.snapshot.deadlineWallMs);
        const remaining = original.deadlineWallMs - Date.now();
        assert.ok(remaining > 0, "activate with a live Git grant before its admitted deadline");
        await delay(remaining + 20);
        const {
          rowCount,
          rows: [maintenance],
        } = await fixture.advanceMaintenance(candidate);
        assert.equal(rowCount, 1, "use ordinary maintenance scheduled by activation");
        assert.ok(maintenance);
        if (scenario === "lost maintenance claim") {
          const queue = new fixture.PostgresWorkQueue(fixture.observerPool, { maxAttempts: 1 });
          const abandoned = required(await queue.claim(), "claimed work");
          assert.equal(abandoned.idempotencyKey, maintenance.idempotency_key);
          await fixture.expireClaim(abandoned, abandoned.claimToken);
          assert.equal((await queue.recoverStale()).failedPermanent, 1);
        }
        await start();
        const first = await completed("durable Git expiry outcome");
        const observed = await fixture.workResult({
          id: candidate.id,
          idempotencyKey: maintenance.idempotency_key,
        });
        assert.equal(
          required(observed.rows[0], "completed work result").reason_code,
          scenario === "lost maintenance claim"
            ? "LEASE_EXPIRED"
            : "REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED",
        );
        assert.equal(
          required((await fixture.workResult(candidate)).rows[0], "completed work result")
            .reason_code,
          "REVISION_ACTIVATED",
        );
        const checkNoNewGit = async () => {
          assert.deepEqual(
            (await repositoryAttempts(fixture, candidate)).map(({ phase, sessionId }) => [
              phase,
              sessionId,
            ]),
            [["disposed", original.sessionId]],
          );
          assert.equal(repository.calls.filter((call) => call.operation === "open").length, 1);
          assert.equal(preparations, 1);
        };
        await checkNoNewGit();
        if (scenario === "retire-runtime" || scenario === "unsupported") {
          assert.equal(first.code, "REPOSITORY_RUNTIME_RETIREMENT_QUEUED");
          await waitFor("confirmed retirement clears only this active revision", async () =>
            required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId ===
            undefined
              ? true
              : undefined,
          );
          assert.deepEqual(stopped, [candidate.id]);
          assert.equal(observations, scenario === "unsupported" ? 0 : 1);
          return;
        }
        assert.equal(
          stopped.length,
          0,
          "the Git deadline alone must not stop the serving revision",
        );
        if (scenario.startsWith("pending") || scenario.startsWith("unconfirmed")) {
          assert.equal(first.code, "REPOSITORY_CLEANUP_PENDING");
          assert.equal(
            required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId,
            candidate.id,
          );
          await fixture.stop();
          events.length = 0;
          await start();
          await advanceCleanupRetries(fixture, candidate);
          assert.equal((await completed("cold worker still owes withdrawal")).code, first.code);
          assert.equal(stopped.length, 0);
          if (scenario === "pending then stop") {
            const stop = await fixture.requestStop(owner);
            await fixture.work(stop, "succeeded");
            const agent = required(await fixture.currentAgent(owner), "fixture Agent");
            assert.equal(agent.activeRevisionId, undefined);
            assert.equal(agent.desiredRuntimeState, "stopped");
            assert.ok(stopped.includes(candidate.id));
            return;
          }
          if (scenario === "pending then superseded") {
            const newer = await fixture.revision(owner, 2);
            await fixture.work(newer, "succeeded");
            const previous = observations;
            events.length = 0;
            await advanceCleanupRetries(fixture, candidate);
            assert.equal(
              (await completed("superseded expiry transfers to retirement")).code,
              "REPOSITORY_RUNTIME_RETIREMENT_QUEUED",
            );
            assert.equal(observations, previous, "cannot preserve a superseded revision");
            assert.equal(
              required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId,
              newer.id,
            );
            assert.ok(stopped.every((id) => id === candidate.id));
            return;
          }
          result = "withdrawn";
          events.length = 0;
          await advanceCleanupRetries(fixture, candidate);
          assert.equal(
            (await completed("withdrawal confirmation")).code,
            "REPOSITORY_ACCESS_WITHDRAWN",
          );
        } else {
          assert.equal(first.code, "REPOSITORY_ACCESS_WITHDRAWN");
        }
        assert.equal(
          required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId,
          candidate.id,
        );
        await fixture.stop();
        const previous = observations;
        const {
          rowCount: count,
          rows: [next],
        } = await fixture.advanceMaintenance(candidate);
        assert.equal(count, 1, "continue normal maintenance after confirmed Git withdrawal");
        assert.ok(next);
        await start();
        const work = { id: candidate.id, idempotencyKey: next.idempotency_key };
        await fixture.work(work, "succeeded");
        assert.equal(
          required((await fixture.workResult(work)).rows[0], "completed work result").reason_code,
          "REPOSITORY_ACCESS_WITHDRAWN",
        );
        assert.ok(observations > previous, "cold maintenance verifies the reduced runtime");
        await checkNoNewGit();
        assert.equal(stopped.length, 0);
        const agent = required(await fixture.currentAgent(owner), "fixture Agent");
        assert.equal(agent.activeRevisionId, candidate.id);
        assert.equal(agent.desiredRuntimeState, "running");

        // Offboard the requester after Git withdrawal. IAM now denies this exact revision.
        const removed = await removeAccessBindings(fixture, fixture.actor.id);
        assert.ok((removed.rowCount ?? 0) > 0, "remove the requester's actual access bindings");
        await fixture.advanceMaintenance(candidate);
        await waitFor("runtime authority loss retires exact revision", async () =>
          required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId ===
          undefined
            ? true
            : undefined,
        );
        assert.deepEqual(stopped, [candidate.id]);
        await checkNoNewGit();
      },
    );
  }
}

function testPolicyWithdrawal(setup: RevisionSetup) {
  for (const { name, recovery } of [
    {
      name: "finite Git removal survives a restarted Compute refusing the stored repository policy",
      recovery: "removal",
    },
    {
      name: "the original deployment withdraws finite Git after losing policy-edit authority",
      recovery: "original-removal",
    },
    {
      name: "the original deployment handles Stop after losing policy-edit authority",
      recovery: "stop",
    },
  ] as const) {
    test(name, requiresPostgres, async (t) => {
      const unacknowledged = recovery !== "removal";
      const repository = repositoryBoundary();
      const fixture = await setup(t, { repoDriver: repository.driver });
      const namespaceId = fixture.namespace.id;
      const owner = await fixture.agent("repository-policy-withdrawal");
      const binding = required(repository.snapshot.bindings[0], "finite repository binding");
      const grants = [{ repository: "organization/repository", access: "read" }] as const;
      // Seed the desired policy and binding in the ordinary, non-Proxy topology.
      // Protected Proxy deployment currently refuses this policy combination.
      const desired = await fixture.state.transact(async (unit) => {
        await unit.namespaces.lockNamespace(namespaceId);
        await unit.agents.lockAgent(namespaceId, owner.id);
        const previous = required(
          await unit.sandboxPolicies.find(namespaceId, owner.id),
          "initial Sandbox policy",
        );
        assert.ok(
          await unit.agents.updateConfiguration(
            namespaceId,
            owner.id,
            owner.configurationId,
            undefined,
            undefined,
            undefined,
            undefined,
            [{ repositoryRef: binding.repositoryRef, profile: binding.profile }],
          ),
        );
        return required(
          await unit.sandboxPolicies.save(
            { ...previous, version: previous.version + 1, repositoryNetworkPolicy: grants },
            previous.version,
          ),
          "saved repository network policy",
        );
      });
      const sandboxDriverId = "repository-policy-test-sandbox";
      const candidate = await fixture.revision(owner, 1, {
        sandboxDriverId,
        sandboxPolicy: {
          driverId: sandboxDriverId,
          implementation: "test",
          version: desired.version,
          additions: [],
          defaults: {},
          repositoryNetworkPolicy: required(
            admitRepositoryNetworkPolicy(grants, grants),
            "explicit repository network policy",
          ),
        },
        repositoryCredentials: repository.snapshot,
      });
      const removalKey = repositoryRemovalWorkKey(candidate.id);
      const events: WorkerEvent[] = [];
      const prepared: string[] = [];
      const activations: string[] = [];
      const detached: string[] = [];
      const stopped: string[] = [];
      const queue = new fixture.PostgresWorkQueue(fixture.observerPool);
      async function removeGit() {
        assert.equal(
          required(await fixture.currentAgent(owner), "active Agent").activeRevisionId,
          candidate.id,
        );
        await fixture.controller.updateAgent(fixture.actor.id, {
          namespaceId,
          agentId: owner.id,
          configurationId: owner.configurationId,
          repositoryBindings: [],
        });
        assert.equal(
          await queue.repositoryExpiryState({
            namespaceId,
            agentId: owner.id,
            revisionId: candidate.id,
          }),
          "removal",
        );
      }
      const compute: ComputeDriver = {
        ...fixture.compute,
        validateRepositoryCredentials(harness, sandbox) {
          assert.equal(harness.mode, "embedded");
          assert.equal(sandbox, sandboxDriverId);
        },
        validateProtectedRepositoryNetworkPolicy() {},
        async prepareRevision(revision, context) {
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, context);
        },
        async activateRevision(revision) {
          activations.push(revision.id);
          if (recovery === "original-removal") {
            await removeGit();
            // Keep independent cleanup queued so the original deployment claim
            // must handle the withdrawal after losing its activation reply.
            assert.equal(
              (await deferWork(fixture.observerPool, { key: removalKey, state: "queued" }))
                .rowCount,
              1,
            );
          }
          if (unacknowledged) {
            throw new Error("Controlled activation acknowledgment lost");
          }
        },
        async retireExpiredRepositoryAccess(revision, signal) {
          signal.throwIfAborted();
          detached.push(revision.id);
          return "withdrawn";
        },
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
      };
      const ended = (key: string) =>
        completion(
          events,
          `completed withdrawal pass for ${key}`,
          (event) => event.event === "worker.completed" && event.workId === key,
        );
      let stoppedAfterLostAck: Promise<void> | undefined;
      await fixture.start(compute, {
        emit(event) {
          const observed = readWorkerEvent(event);
          events.push(observed);
          if (
            unacknowledged &&
            observed.event === "worker.completed" &&
            observed.workId === candidate.idempotencyKey &&
            observed.code === "REVISION_FINALIZATION_INCOMPLETE"
          ) {
            stoppedAfterLostAck = fixture.stop();
          }
        },
      });
      if (unacknowledged) {
        assert.equal(
          (await ended(candidate.idempotencyKey)).code,
          "REVISION_FINALIZATION_INCOMPLETE",
        );
        await required(stoppedAfterLostAck, "stopped worker after lost reply");
      } else {
        await fixture.work(candidate, "succeeded");
        await fixture.stop();
      }
      const [original] = await repositoryAttempts(fixture, candidate);
      assert.ok(original?.sessionId, "deployment opened the original finite session");
      assert.equal(original.phase, recovery === "original-removal" ? "closing" : "open");
      if (recovery === "stop") {
        // Let the committed Stop set desired state, but keep its independent
        // Work queued so it cannot conceal a refusal by the original claim.
        const stop = await fixture.requestStop(owner);
        assert.equal(
          (await deferWork(fixture.observerPool, { key: stop.idempotencyKey, state: "queued" }))
            .rowCount,
          1,
        );
      }
      if (unacknowledged) {
        // Remove only SandboxPolicy edit authority. Deploy, operate, and
        // the Harness Secret remain authorized.
        await fixture.observerPool.query(
          `INSERT INTO occ.iam_restrictions
           (id, namespace_id, action, resource_kind, resource_id, effect)
           VALUES ($1, $2, 'update', 'sandbox_policy', $3, 'deny')`,
          [`restriction-${randomUUID()}`, namespaceId, desired.id],
        );
        assert.equal(
          (
            await makeWorkDue(fixture.observerPool, {
              key: candidate.idempotencyKey,
              state: "queued",
            })
          ).rowCount,
          1,
        );
      } else {
        await removeGit();
      }
      events.length = 0;
      const restarted = unacknowledged
        ? compute
        : ({
            ...compute,
            async validateProtectedRepositoryNetworkPolicy() {
              throw new Error("Restarted Compute cannot admit this repository network policy.");
            },
          } satisfies ComputeDriver);
      await fixture.start(restarted, { emit: (event) => events.push(readWorkerEvent(event)) });
      const withdrawalKey = unacknowledged ? candidate.idempotencyKey : removalKey;
      const reason = recovery === "stop" ? "REVISION_STOPPED" : "REPOSITORY_ACCESS_WITHDRAWN";
      assert.equal((await ended(withdrawalKey)).code, reason);
      await fixture.stop();

      if (recovery === "stop") {
        assert.deepEqual(stopped, [candidate.id], "the original claim stops the exact runtime");
        assert.deepEqual(detached, [], "Stop owns retirement of the whole runtime");
      } else {
        assert.deepEqual(detached, [candidate.id], "Compute detached Git from the exact recipient");
        assert.deepEqual(stopped, [], "withdrawal preserves the serving runtime");
      }
      assert.deepEqual(prepared, [candidate.id], "withdrawal does not prepare a new revision");
      assert.deepEqual(activations, [candidate.id], "withdrawal does not replay activation");
      const active = required(await fixture.currentAgent(owner), "retained Agent");
      assert.equal(active.desiredRuntimeState, recovery === "stop" ? "stopped" : "running");
      if (recovery !== "stop") {
        assert.equal(active.activeRevisionId, candidate.id);
      }
      assert.deepEqual(
        (await repositoryAttempts(fixture, candidate)).map(({ phase, sessionId }) => [
          phase,
          sessionId,
        ]),
        [["disposed", original.sessionId]],
      );
      assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
      const settled = required(await queue.findWork(withdrawalKey), "settled withdrawal work");
      assert.equal(settled.state, "succeeded");
      assert.equal(settled.reasonCode, reason);
      if (recovery !== "stop") {
        const deployment = await fixture.deploymentStatus(owner, candidate);
        assert.equal(deployment.status, unacknowledged ? "failed" : "succeeded");
        assert.equal(
          await queue.repositoryExpiryState({
            namespaceId,
            agentId: owner.id,
            revisionId: candidate.id,
          }),
          "removal",
          "withdrawal preserves the removal fence without queuing terminal retirement",
        );
      }
    });
  }
}
