import assert from "node:assert/strict";
import test from "node:test";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import type { ControllerWorkState } from "../../packages/occ/src/controller-work.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { completedPasses, expireWorkLease } from "../helpers/postgres-worker-revision-queue.ts";
import {
  repositoryBoundary,
  withUnavailableIAM,
} from "../helpers/postgres-worker-revision-support.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import {
  required,
  type RevisionSetup,
  readWorkerEvent,
  type WorkerEvent,
} from "./postgres-worker-agent-revision-teardown-fixture.ts";

type PublishedDeploymentCase = {
  name: string;
  crashes: 1 | 2;
  finish: "succeeds" | "lease-expires" | "dependency-unavailable" | "quarantined";
  newAgent?: true;
};

export function testActiveRevisionAuthority(setup: RevisionSetup) {
  test(
    "exhausted repository maintenance during a dependency outage keeps the active runtime",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      // One attempt makes the first unavailable dependency exhaust the claim, as
      // a longer outage exhausts the default retries.
      const fixture = await setup(context, { repoDriver: repository.driver, maxAttempts: 1 });
      const { owner, candidate } = await fixture.admitInitialRevision(
        "repository-maintenance-outage",
        { revision: { repositoryCredentials: repository.snapshot } },
      );
      const stopped: string[] = [];
      let iamUnavailable = false;
      const compute: ComputeDriver = {
        ...fixture.compute,
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
      };
      const events: WorkerEvent[] = [];
      const startWorker = () =>
        fixture.start(compute, {
          emit: (event) => events.push(readWorkerEvent(event)),
          pool: fixture.createWorkerPool(),
          transformDrivers: withUnavailableIAM(() => iamUnavailable),
        });
      await startWorker();
      await fixture.work(candidate, "succeeded");
      await fixture.stop();

      iamUnavailable = true;
      const maintenance = await fixture.advanceMaintenance(candidate);
      assert.equal(maintenance.rowCount, 1);
      const maintenanceRow = required(maintenance.rows[0], "scheduled maintenance");
      const outage = { id: candidate.id, idempotencyKey: maintenanceRow.idempotency_key };
      await startWorker();
      await fixture.work(outage, "failed_permanent");
      await fixture.stop();
      // The log says why the exhausted pass failed (finding 1743).
      const ended = required(
        (await completedPasses(events, outage, "retry")).at(-1),
        "final retry event",
      );
      assert.equal(ended.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(ended.cause, "Error");
      const failed = await fixture.observerPool.query<{ reason_code: string | null }>(
        "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
        [outage.idempotencyKey],
      );
      assert.equal(
        required(failed.rows[0], "completed work result").reason_code,
        "DEPENDENCY_UNAVAILABLE",
      );
      const retirement = await fixture.observerPool.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
      );
      assert.equal(retirement.rowCount, 0, "an outage must not retire the authorized runtime");
      assert.deepEqual(stopped, []);
      const agent = required(await fixture.currentAgent(owner), "fixture Agent");
      assert.equal(agent.activeRevisionId, candidate.id);
      assert.equal(agent.desiredRuntimeState, "running");

      // The maintenance chain continues, so the runtime is kept current once
      // the dependency recovers.
      iamUnavailable = false;
      const next = await fixture.advanceMaintenance(candidate);
      assert.equal(next.rowCount, 1);
      const nextRow = required(next.rows[0], "next maintenance");
      assert.notEqual(nextRow.idempotency_key, outage.idempotencyKey);
      await startWorker();
      await fixture.work(
        { id: candidate.id, idempotencyKey: nextRow.idempotency_key },
        "succeeded",
      );
      await fixture.stop();
      assert.deepEqual(stopped, []);
    },
  );

  test(
    "a repository authority check that fails before the pointer commit logs its cause",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver, maxAttempts: 1 });
      const { candidate } = await fixture.admitInitialRevision("repository-commit-outage", {
        revision: { repositoryCredentials: repository.snapshot },
      });
      let iamUnavailable = false;
      let activations = 0;
      const events: WorkerEvent[] = [];
      // Preparation passes its own authority check; IAM then fails the one made again just
      // before the pointer commit.
      await fixture.start(
        {
          ...fixture.compute,
          activationOrder: "beforeCommit",
          async activateRevision() {
            activations += 1;
            iamUnavailable = true;
          },
        },
        {
          emit: (event: Parameters<typeof readWorkerEvent>[0]) =>
            events.push(readWorkerEvent(event)),
          transformDrivers: withUnavailableIAM(() => iamUnavailable),
        },
      );
      await fixture.work(candidate, "failed_permanent");
      await fixture.stop();
      assert.equal(activations, 1, "only the check after activation met the outage");
      // The retry says why the check failed (finding 2272).
      const ended = required(
        (await completedPasses(events, candidate, "retry")).at(-1),
        "final retry event",
      );
      assert.equal(ended.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(ended.cause, "Error");
    },
  );

  test(
    "an expired exhausted repository maintenance claim keeps the active runtime",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver, maxAttempts: 1 });
      const { owner, candidate } = await fixture.admitInitialRevision(
        "repository-maintenance-lease-expiry",
        { revision: { repositoryCredentials: repository.snapshot } },
      );
      const stopped: string[] = [];
      const compute: ComputeDriver = {
        ...fixture.compute,
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
      };
      await fixture.start(compute);
      await fixture.work(candidate, "succeeded");
      await fixture.stop();

      // A worker claims the maintenance item on its last attempt and crashes
      // before it finishes, so only lease expiry can release the claim.
      const maintenance = await fixture.advanceMaintenance(candidate);
      assert.equal(maintenance.rowCount, 1);
      const maintenanceRow = required(maintenance.rows[0], "scheduled maintenance");
      const crashedKey = maintenanceRow.idempotency_key;
      const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
        leaseDurationMs: 30_000,
        maxAttempts: 1,
        random: () => 0,
      });
      const crashed = required(await queue.claim(), "claimed work");
      assert.equal(crashed.idempotencyKey, crashedKey);
      await expireWorkLease(fixture.observerPool, {
        key: crashedKey,
        claimToken: crashed.claimToken,
      });
      const recovery = await queue.recoverStale();
      assert.equal(recovery.recovered, 1);

      const failed = await fixture.observerPool.query<{
        state: ControllerWorkState;
        reason_code: string | null;
      }>("SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1", [
        crashedKey,
      ]);
      assert.deepEqual(failed.rows[0], { state: "failed_permanent", reason_code: "LEASE_EXPIRED" });
      const retirement = await fixture.observerPool.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
      );
      assert.equal(retirement.rowCount, 0, "a crashed worker must not retire the active runtime");
      const agent = required(await fixture.currentAgent(owner), "fixture Agent");
      assert.equal(agent.activeRevisionId, candidate.id);
      assert.equal(agent.desiredRuntimeState, "running");

      // The maintenance chain continues with the next bucket.
      const next = await fixture.advanceMaintenance(candidate);
      assert.equal(next.rowCount, 1);
      const nextRow = required(next.rows[0], "next maintenance");
      const bucket = BigInt(crashedKey.slice(crashedKey.lastIndexOf(":") + 1));
      assert.deepEqual(nextRow, {
        idempotency_key: `agent_revision:${candidate.id}:maintenance:${bucket + 1n}`,
        attempt_count: 0,
        actor_id: crashed.actorId,
      });
      await fixture.start(compute);
      await fixture.work(
        { id: candidate.id, idempotencyKey: nextRow.idempotency_key },
        "succeeded",
      );
      await fixture.stop();
      assert.deepEqual(stopped, []);
    },
  );

  for (const { name, crashes, finish, newAgent = false } of [
    {
      name: "a deployment whose lease expires on its last attempt after publishing its revision gets one more attempt",
      crashes: 1,
      finish: "succeeds",
    },
    {
      name: "a published deployment that loses its lease again fails without retiring the active runtime",
      crashes: 2,
      finish: "lease-expires",
    },
    {
      name: "a published deployment whose extra attempt fails ends without retiring the active runtime",
      crashes: 1,
      finish: "dependency-unavailable",
    },
    // Owner decision 2026-10-28 (finding 2425): a new Agent whose native version has no Git token
    // fails and is retired, also when its published deployment recovered from a lost lease.
    {
      name: "a new Agent's recovered native deployment fails and retires when its Git token is quarantined",
      crashes: 1,
      finish: "quarantined",
      newAgent: true,
    },
    {
      name: "a new Agent's recovered native deployment whose extra attempt fails retires without a Git token",
      crashes: 1,
      finish: "dependency-unavailable",
      newAgent: true,
    },
  ] satisfies readonly PublishedDeploymentCase[]) {
    test(name, requiresPostgres, async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver, maxAttempts: 1 });
      const { owner, candidate: first } = await fixture.admitInitialRevision(
        `publish-crash-${crashes}-${finish}-${newAgent === true}`,
        { revision: { repositoryCredentials: repository.snapshot } },
      );
      const stopped: string[] = [];
      const retired: string[] = [];
      let iamUnavailable = false;
      const compute: ComputeDriver = {
        ...fixture.compute,
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
        async retireRevision(revision) {
          retired.push(revision.id);
          return fixture.compute.retireRevision(revision);
        },
      };
      if (!newAgent) {
        await fixture.start(compute);
        await fixture.work(first, "succeeded");
        await fixture.stop();
      }

      // A worker claims the replacement (a new Agent's first version) on its last attempt,
      // publishes the active pointer and crashes before activation, predecessor retirement and
      // completion.
      const second = newAgent
        ? first
        : await fixture.revision(owner, 2, { repositoryCredentials: repository.snapshot });
      const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
        leaseDurationMs: 30_000,
        maxAttempts: 1,
        random: () => 0,
      });
      const crash = async () => {
        const claim = required(await queue.claim(), "claimed work");
        assert.equal(claim.idempotencyKey, second.idempotencyKey);
        await fixture.expireClaim(claim, claim.claimToken);
        assert.equal((await queue.recoverStale()).recovered, 1);
      };
      await fixture.state.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(
          fixture.namespace.id,
          owner.id,
          newAgent ? undefined : first.id,
          second.id,
        ),
      );
      for (let crash_ = 0; crash_ < crashes; crash_ += 1) {
        await crash();
      }
      const row = async () =>
        (
          await fixture.observerPool.query<{
            state: ControllerWorkState;
            reason_code: string | null;
            attempt_count: number;
          }>(
            "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
            [second.idempotencyKey],
          )
        ).rows[0];
      const retirement = await fixture.observerPool.query<never>(
        "SELECT 1 FROM occ.controller_work WHERE idempotency_key LIKE $1",
        [`agent_revision:${second.id}:repository_cleanup:retire:%`],
      );
      assert.equal(retirement.rowCount, 0, "recovery must not retire the active runtime");
      const evidence = await fixture.observerPool.query<{ reason_code: string | null }>(
        `SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events
           WHERE kind = 'mutation' AND action = 'reconcile' AND details->>'workId' = $1
           ORDER BY occurred_at, id`,
        [second.idempotencyKey],
      );
      if (crashes === 2) {
        // The extra attempt is granted once; a second loss ends the deployment.
        assert.deepEqual(await row(), {
          state: "failed_permanent",
          reason_code: "LEASE_EXPIRED",
          attempt_count: 1,
        });
        assert.deepEqual(evidence.rows.map(({ reason_code }) => reason_code).slice(-2), [
          "ACTIVE_REVISION_RECOVERY",
          "LEASE_EXPIRED",
        ]);
        assert.deepEqual(stopped, []);
        assert.deepEqual(retired, []);
        return;
      }
      assert.deepEqual(await row(), { state: "queued", reason_code: null, attempt_count: 0 });
      assert.equal(evidence.rows.at(-1)?.reason_code, "ACTIVE_REVISION_RECOVERY");
      const progress = await fixture.state.read((view) =>
        view.operations.findWorkAttempt(second.idempotencyKey),
      );
      assert.equal(progress?.code, "ACTIVE_REVISION_RECOVERY");

      if (newAgent) {
        // The version never got its first token: GitHub's answer quarantined it, or the extra
        // attempt ends on an unavailable dependency before it committed.
        iamUnavailable = finish === "dependency-unavailable";
        await fixture.start(compute, {
          transformDrivers: withUnavailableIAM(() => iamUnavailable),
          repositoryGitMaterial: async () => (finish === "quarantined" ? "quarantined" : "pending"),
        });
        await fixture.work(second, "failed_permanent");
        iamUnavailable = false;
        assert.equal(
          (await row())?.reason_code,
          finish === "quarantined" ? "REPOSITORY_GIT_TOKEN_QUARANTINED" : "DEPENDENCY_UNAVAILABLE",
        );
        await waitFor("the new Agent's failed version retirement", async () => {
          const retire = await fixture.observerPool.query<{ state: ControllerWorkState }>(
            "SELECT state FROM occ.controller_work WHERE idempotency_key LIKE $1",
            [`agent_revision:${second.id}:repository_cleanup:retire:%`],
          );
          return retire.rows[0]?.state === "succeeded" ? true : undefined;
        });
        await fixture.stop();
        assert.deepEqual(stopped, [second.id]);
        assert.equal(
          required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId,
          undefined,
        );
        return;
      }

      if (finish === "dependency-unavailable") {
        // A retry outcome on the extra (last) attempt fails the deployment but keeps the
        // runtime it already activated.
        iamUnavailable = true;
        await fixture.start(compute, {
          transformDrivers: withUnavailableIAM(() => iamUnavailable),
        });
        await fixture.work(second, "failed_permanent");
        await fixture.stop();
        assert.deepEqual(await row(), {
          state: "failed_permanent",
          reason_code: "DEPENDENCY_UNAVAILABLE",
          attempt_count: 1,
        });
        const retireAfterFailure = await fixture.observerPool.query<never>(
          "SELECT 1 FROM occ.controller_work WHERE idempotency_key LIKE $1",
          [`agent_revision:${second.id}:repository_cleanup:retire:%`],
        );
        assert.equal(retireAfterFailure.rowCount, 0, "a failed finish must not retire the runtime");
        assert.deepEqual(stopped, []);
        assert.deepEqual(retired, []);
        return;
      }

      // A worker finishes the published deployment through the already-active path.
      await fixture.start(compute);
      await fixture.work(second, "succeeded");
      await fixture.stop();
      assert.equal((await row())?.reason_code, "REVISION_ALREADY_ACTIVE");
      assert.deepEqual(retired, [first.id], "the predecessor must be retired");
      assert.deepEqual(stopped, [], "the active revision must keep running");
      const agent = required(await fixture.currentAgent(owner), "fixture Agent");
      assert.equal(agent.activeRevisionId, second.id);
    });
  }

  // Finding 1743: a deployment that published the active pointer and then exhausts its retries keeps
  // the runtime it activated (above), and its log line says why its last pass failed. Whether it
  // should also start the maintenance chain its activation would have is finding 1743's open design
  // question: today it queues no maintenance, declared or not. The declared case pins that; the
  // undeclared one is its control (no interval, so no chain whatever the answer).
  for (const maintained of [true, false]) {
    test(
      `an exhausted deployment of the published active revision logs its failure${maintained ? " (maintenance declared)" : ""}`,
      requiresPostgres,
      async (context) => {
        const fixture = await setup(context, { maxAttempts: 1 });
        const { owner, candidate: first } = await fixture.admitInitialRevision(
          `exhausted-published-${maintained}`,
        );
        const stopped: string[] = [];
        let iamUnavailable = false;
        const compute: ComputeDriver = {
          ...fixture.compute,
          ...(maintained ? { maintenanceIntervalMs: 3_600_000 } : {}),
          async stopRevision(revision) {
            stopped.push(revision.id);
            return fixture.compute.stopRevision(revision);
          },
        };
        const events: WorkerEvent[] = [];
        const options = {
          emit: (event: Parameters<typeof readWorkerEvent>[0]) =>
            events.push(readWorkerEvent(event)),
          transformDrivers: withUnavailableIAM(() => iamUnavailable),
        };
        await fixture.start(compute, options);
        await fixture.work(first, "succeeded");
        await fixture.stop();

        // An earlier pass of the replacement published the active pointer; its last attempt then
        // meets an IAM outage.
        const second = await fixture.revision(owner, 2);
        await fixture.state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(
            fixture.namespace.id,
            owner.id,
            first.id,
            second.id,
          ),
        );
        iamUnavailable = true;
        await fixture.start(compute, options);
        await fixture.work(second, "failed_permanent");
        await fixture.stop();
        const ended = required(
          (await completedPasses(events, second, "retry")).at(-1),
          "final retry event",
        );
        assert.equal(ended.code, "DEPENDENCY_UNAVAILABLE");
        assert.equal(
          ended.cause,
          "Error",
          "the log names the failure that exhausted the deployment",
        );
        const maintenance = await fixture.observerPool.query<{ idempotency_key: string }>(
          `SELECT idempotency_key FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key LIKE $2`,
          [second.id, `agent_revision:${second.id}:maintenance:%`],
        );
        assert.equal(maintenance.rowCount, 0, "finding 1743: the chain question is still open");
        assert.deepEqual(stopped, []);
        const agent = required(await fixture.currentAgent(owner), "fixture Agent");
        assert.equal(agent.activeRevisionId, second.id);
        assert.equal(agent.desiredRuntimeState, "running");
        if (!maintained) {
          return;
        }
        // Finding 2895: a later pass can still queue this version's maintenance (a credential
        // withdrawal on the running version does). Maintenance never prepares a version whose
        // deployment failed for good; only a version kept without Git (REPOSITORY_GIT_TOKEN_*)
        // keeps its chain. The refusal leaves the runtime alone.
        const key = `agent_revision:${second.id}:maintenance:0`;
        await fixture.state.transactWithQueue(async (unit, queue) => {
          await unit.namespaces.lockNamespace(fixture.namespace.id);
          await queue.enqueue({
            idempotencyKey: key,
            namespaceId: fixture.namespace.id,
            agentId: owner.id,
            revisionId: second.id,
            actorId: fixture.actor.id,
            availableAt: new Date(0),
          });
        });
        const prepared: string[] = [];
        iamUnavailable = false;
        await fixture.start(
          {
            ...compute,
            async prepareRevision(revision, deploymentContext) {
              prepared.push(revision.id);
              return compute.prepareRevision(revision, deploymentContext);
            },
          },
          options,
        );
        await fixture.work({ id: second.id, idempotencyKey: key }, "failed_permanent");
        await fixture.stop();
        const refused = await fixture.observerPool.query<{ reason_code: string | null }>(
          "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
          [key],
        );
        assert.equal(
          required(refused.rows[0], "completed work result").reason_code,
          "REVISION_SUPERSEDED",
        );
        assert.deepEqual(prepared, []);
        assert.deepEqual(stopped, []);
        assert.equal(
          required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId,
          second.id,
        );
      },
    );
  }
}
