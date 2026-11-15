import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  RepositoryCredentialRuntimeBinding,
  ComputeDriver,
  OpenRepositorySessionInput,
  RepositoryCredentialSessionStatus,
} from "../../packages/contracts/src/index.ts";
import type { ControllerWorkState } from "../../packages/occ/src/controller-work.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { advanceCleanupRetries, completion } from "../helpers/postgres-worker-revision-queue.ts";
import {
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import {
  required,
  type RevisionSetup,
  readWorkerEvent,
  type WorkerEvent,
} from "./postgres-worker-agent-revision-teardown-fixture.ts";

export function testRepositoryCleanup(setup: RevisionSetup) {
  for (const change of ["revoked", "stopped", "expired", "superseded"] as const) {
    test(
      `an unfinished repository admission cannot reopen after its revision is ${change}`,
      requiresPostgres,
      async (context) => {
        const repository = repositoryBoundary();
        const fixture = await setup(context, { repoDriver: repository.driver });
        const owner = await fixture.agent(`repository-${change}`);
        if (change === "expired") {
          repository.snapshot.deadlineWallMs = Date.now() + 3_000;
        }
        let actorId = fixture.actor.id;
        if (change === "revoked") {
          actorId = `principal-${randomUUID()}`;
          await fixture.observerPool.query<never>(
            `INSERT INTO occ.iam_identities (id, kind, issuer, subject)
             SELECT $1, kind, issuer, $1 FROM occ.iam_identities WHERE id = $2`,
            [actorId, fixture.actor.id],
          );
          const granted = await fixture.observerPool.query<never>(
            `INSERT INTO occ.iam_access_bindings
              (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
             SELECT gen_random_uuid()::text, namespace_id, $1, NULL, role_id, resource_kind, resource_id
             FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
            [actorId, fixture.actor.id],
          );
          assert.ok((granted.rowCount ?? 0) > 0);
        }
        const candidate = await fixture.revision(owner, 1, {
          repositoryCredentials: repository.snapshot,
          actorId,
        });
        const open = repository.driver.open;
        let lostSessionId: string | undefined;
        repository.driver.open = async (input, signal) => {
          const result = await open(input, signal);
          if (lostSessionId === undefined && result.kind === "created") {
            lostSessionId = result.session.sessionId;
            // Change real authority while its external admission result is lost.
            // Cleanup may recover that admission but cannot deliver or replace it.
            if (change === "revoked") {
              // Restrictions are the supported app-role mutation that revokes
              // effective authority; identity deletion requires a different role.
              await fixture.observerPool.query<never>(
                `INSERT INTO occ.iam_restrictions
                   (id, namespace_id, action, resource_kind, resource_id, effect)
                 VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
                [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
              );
            } else if (change === "stopped") {
              await fixture.requestStop(owner);
            } else if (change === "expired") {
              await delay(Math.max(0, repository.snapshot.deadlineWallMs - Date.now()) + 30);
            } else {
              const replacement = await fixture.revision(owner, 2);
              await fixture.state.transact((unit) =>
                unit.agents.compareAndSetActiveRevision(
                  fixture.namespace.id,
                  owner.id,
                  undefined,
                  replacement.id,
                ),
              );
            }
            throw new Error("repository admission response lost during authority change");
          }
          return result;
        };
        const prepared: string[] = [];
        const events: WorkerEvent[] = [];
        await fixture.start(
          {
            ...fixture.compute,
            async prepareRevision(revision, deploymentContext) {
              prepared.push(revision.id);
              return fixture.compute.prepareRevision(revision, deploymentContext);
            },
          },
          { emit: (event) => events.push(readWorkerEvent(event)) },
        );
        if (change === "superseded") {
          await waitFor("the superseded revision to finish without new authority", async () => {
            const result = await fixture.observerPool.query<{ state: ControllerWorkState }>(
              "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
              [candidate.idempotencyKey],
            );
            const state = result.rows[0]?.state;
            return state === "succeeded" || state === "failed_permanent" ? true : undefined;
          });
        } else {
          await fixture.work(candidate, change === "stopped" ? "succeeded" : "failed_permanent");
        }
        await waitFor("the unfinished admission to settle without renewed authority", async () => {
          const attempts = await repositoryAttempts(fixture, candidate);
          return attempts.length === 1 && attempts[0]?.phase === "disposed" ? attempts : undefined;
        });
        assert.ok(lostSessionId);
        assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
        assert.ok(repository.calls.some(({ operation }) => operation === "recover"));
        assert.ok(
          repository.calls.some(
            (call) => call.operation === "close" && call.sessionId === lostSessionId,
          ),
        );
        assert.equal(prepared.includes(candidate.id), false);
        const reasons = {
          revoked: ["AUTHORIZATION_DENIED"],
          stopped: ["REVISION_STOPPED"],
          expired: ["REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED"],
          superseded: ["REPOSITORY_REVISION_SUPERSEDED", "REVISION_SUPERSEDED"],
        };
        await waitFor("the worker's exact terminal authority reason", async () =>
          events.find(
            ({ event, workId, code }) =>
              event === "worker.completed" &&
              workId === candidate.idempotencyKey &&
              code !== undefined &&
              reasons[change].includes(code),
          ),
        );
        if (change === "revoked") {
          const cleanup = await fixture.observerPool.query<{ actor_id: string }>(
            `SELECT actor_id FROM occ.controller_work
             WHERE revision_id = $1 AND idempotency_key LIKE $2`,
            [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
          );
          assert.ok((cleanup.rowCount ?? 0) > 0);
          assert.ok(cleanup.rows.every(({ actor_id }) => actor_id === actorId));
        }
      },
    );
  }

  test(
    "repository service outage during Agent stop still stops Compute and retains durable closing work",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const { owner, candidate } = await fixture.admitInitialRevision("repository-stop-outage", {
        revision: { repositoryCredentials: repository.snapshot },
      });
      const stopped: string[] = [];
      await fixture.start({
        ...fixture.compute,
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
      });
      await fixture.work(candidate, "succeeded");
      const close = repository.driver.close;
      let unavailable = true;
      repository.driver.close = async (sessionId, signal) => {
        if (unavailable) {
          throw new Error("repository service temporarily unavailable");
        }
        return close(sessionId, signal);
      };
      const stop = await fixture.requestStop(owner);
      await waitFor("Compute shutdown despite the credential service outage", async () =>
        stopped.includes(candidate.id) ? true : undefined,
      );
      const attempts = await repositoryAttempts(fixture, candidate);
      assert.equal(attempts.length, 1);
      const attempt = required(attempts[0], "original attempt");
      assert.equal(attempt.phase, "closing");
      const cleanup = await fixture.observerPool.query<{
        actor_id: string;
        state: ControllerWorkState;
      }>(
        `SELECT actor_id, state FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      assert.ok(cleanup.rows.length >= 1);
      assert.ok(
        cleanup.rows.every(
          ({ actor_id, state }) =>
            actor_id === fixture.actor.id && ["queued", "claimed"].includes(state),
        ),
      );
      assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
      // Hold the outage through a completed cleanup pass. Otherwise recovery can
      // race the first close and never exercise the durable retry schedule.
      await waitFor("outage cleanup to defer at the Driver interval", async () => {
        const deferred = await fixture.observerPool.query<{ state: ControllerWorkState }>(
          `SELECT state FROM occ.controller_work
           WHERE idempotency_key LIKE $1 AND state = 'queued'
             AND available_at - updated_at >= $2::double precision * interval '1 millisecond'`,
          [
            `agent_revision:${candidate.id}:repository_cleanup:%`,
            repository.driver.maintenanceIntervalMs - 1_000,
          ],
        );
        return deferred.rowCount === 1 ? true : undefined;
      });
      // A provider outage leaves cleanup pending without making fleet inventory
      // unavailable, marking the stopped Agent as deploying, or settling the cleanup.
      // This does not guard the inventory's repository-cleanup filter (#2572): while
      // the Agent lives, its cleanup work resolves to the revision's settled
      // :reconcile work, so the read passes with or without the filter. Cleanup that
      // Agent deletion detached from its owners needs the filter; the -stop sibling's
      // inventory reads after Agent deletion cover it.
      const pendingCleanup = async () =>
        (
          await fixture.observerPool.query<{
            idempotency_key: string;
            agent_id: string | null;
            revision_id: string | null;
            state: ControllerWorkState;
            attempt_count: number;
            available_at: Date;
          }>(
            `SELECT idempotency_key, agent_id, revision_id, state, attempt_count, available_at
             FROM occ.controller_work WHERE idempotency_key LIKE $1 ORDER BY idempotency_key`,
            [`agent_revision:${candidate.id}:repository_cleanup:%`],
          )
        ).rows;
      const cleanupBeforeInventory = await pendingCleanup();
      const inventory = await fixture.controller.getInstallationDeploymentInventory(
        fixture.actor.id,
      );
      const namespace = required(
        inventory.namespaces.find(({ id }) => id === fixture.namespace.id),
        "fixture Namespace inventory",
      );
      const agents = namespace.agents;
      assert.deepEqual(
        agents
          .filter(({ id }) => id === owner.id)
          .map(({ desiredRuntimeState, deploymentInProgress }) => ({
            desiredRuntimeState,
            deploymentInProgress,
          })),
        [{ desiredRuntimeState: "stopped", deploymentInProgress: false }],
      );
      assert.deepEqual(await pendingCleanup(), cleanupBeforeInventory);
      assert.equal((await repositoryAttempts(fixture, candidate))[0]?.phase, "closing");
      unavailable = false;
      await advanceCleanupRetries(fixture, candidate);
      await waitFor(
        "the persisted shutdown obligation to settle after service recovery",
        async () => {
          const current = await repositoryAttempts(fixture, candidate);
          return current[0]?.phase === "disposed" ? true : undefined;
        },
      );
      await fixture.work(stop, "succeeded");
    },
  );

  test(
    "terminal repository retirement survives repeated Compute failures and restart without reopening authority",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const { owner, candidate } = await fixture.admitInitialRevision("repository-grant-drift", {
        revision: { repositoryCredentials: repository.snapshot },
      });
      const prepared: string[] = [];
      const stopped: string[] = [];
      let unavailable = true;
      const compute: ComputeDriver = {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
        async stopRevision(revision) {
          stopped.push(revision.id);
          if (unavailable) {
            throw new Error("Compute retirement temporarily unavailable");
          }
          return fixture.compute.stopRevision(revision);
        },
      };
      await fixture.start(compute);
      await fixture.work(candidate, "succeeded");
      await fixture.stop();
      const [original] = await repositoryAttempts(fixture, candidate);
      assert.ok(original, "expected original repository attempt");
      repository.driver.resolve = () => ({
        sessionDurationSeconds: 60,
        bindings: repository.snapshot.bindings.map((binding) => ({
          ...binding,
          grant: { ...binding.grant, grantId: "replacement-grant" },
        })),
      });
      const maintenance = await fixture.advanceMaintenance(candidate);
      assert.equal(maintenance.rowCount, 1);
      const maintenanceRow = required(maintenance.rows[0], "scheduled maintenance");
      await fixture.start(compute, { pool: fixture.createWorkerPool() });
      await fixture.work(
        { id: candidate.id, idempotencyKey: maintenanceRow.idempotency_key },
        "failed_permanent",
      );
      await waitFor("the old grant's existing session to be disposed", async () => {
        const attempts = await repositoryAttempts(fixture, candidate);
        return attempts.length === 1 && attempts[0]?.phase === "disposed" ? true : undefined;
      });
      // The foreground is already terminal and every session is disposed. Compute
      // must retain a separate durable obligation beyond its ordinary failure budget.
      await waitFor("retirement to retry beyond the foreground's five attempts", async () => {
        if (stopped.length <= 5) {
          await advanceCleanupRetries(fixture, candidate);
          return undefined;
        }
        // Join the final failed pass before shutdown; aborting it mid-claim would
        // leave a stale lease instead of the deferred work this restart exercises.
        const deferred = await fixture.observerPool.query<{ state: ControllerWorkState }>(
          "SELECT state FROM occ.controller_work WHERE idempotency_key LIKE $1 AND state = 'queued'",
          [`agent_revision:${candidate.id}:repository_cleanup:retire:%`],
        );
        return deferred.rowCount === 1 ? true : undefined;
      });
      await fixture.stop();
      const retirement = await fixture.observerPool.query<{
        idempotency_key: string;
        state: ControllerWorkState;
        actor_id: string;
      }>(
        `SELECT idempotency_key, state, actor_id FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
      );
      assert.equal(retirement.rowCount, 1);
      const retirementRow = required(retirement.rows[0], "retirement work");
      assert.equal(retirementRow.state, "queued");
      assert.equal(retirementRow.actor_id, fixture.actor.id);
      assert.deepEqual(prepared, [candidate.id]);
      assert.equal(
        required(await fixture.currentAgent(owner), "fixture Agent").activeRevisionId,
        candidate.id,
      );

      // A restart may retire only the failed revision, even after a newer revision
      // and another Agent become active. Neither needs this expired repository grant.
      const sibling = await fixture.agent("repository-retirement-sibling");
      const newer = await fixture.revision(owner, 2);
      const siblingRevision = await fixture.revision(sibling, 1);
      const stopsBeforeRestart = stopped.length;
      await fixture.start(compute, { pool: fixture.createWorkerPool() });
      await fixture.work(newer, "succeeded");
      await fixture.work(siblingRevision, "succeeded");
      await waitFor("the restarted worker to resume exact retirement", async () => {
        if (stopped.length > stopsBeforeRestart) {
          return true;
        }
        await advanceCleanupRetries(fixture, candidate);
        return undefined;
      });
      await fixture.work(
        { id: candidate.id, idempotencyKey: retirementRow.idempotency_key },
        "queued",
      );
      unavailable = false;
      await advanceCleanupRetries(fixture, candidate);
      await fixture.work(
        { id: candidate.id, idempotencyKey: retirementRow.idempotency_key },
        "succeeded",
      );
      assert.ok(stopped.every((id) => id === candidate.id));
      assert.equal(prepared.filter((id) => id === candidate.id).length, 1);
      const active = await fixture.state.read(async (view) => [
        await view.agents.findAgent(fixture.namespace.id, owner.id),
        await view.agents.findAgent(fixture.namespace.id, sibling.id),
      ]);
      assert.deepEqual(
        active.map((agent) => required(agent, "fixture Agent").activeRevisionId),
        [newer.id, siblingRevision.id],
      );
      assert.deepEqual(
        (await repositoryAttempts(fixture, candidate)).map(({ phase }) => phase),
        ["disposed"],
      );
      assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
      assert.ok(
        repository.calls.some(
          (call) => call.operation === "close" && call.sessionId === original.sessionId,
        ),
      );
      const failure = await fixture.observerPool.query<{ code: string | null }>(
        `SELECT details->>'reasonCode' AS code FROM occ.audit_events
         WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'`,
        [candidate.id],
      );
      assert.ok(failure.rows.some(({ code }) => code === "REPOSITORY_BINDING_CHANGED"));
    },
  );

  test(
    "repository stop rechecks locked intent after a newer deployment commits while cleanup waits",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const { owner, candidate: first } = await fixture.admitInitialRevision(
        "repository-stop-admission-race",
        { revision: { repositoryCredentials: repository.snapshot } },
      );
      await fixture.start(fixture.compute);
      await fixture.work(first, "succeeded");
      await fixture.stop();
      const [original] = await repositoryAttempts(fixture, first);
      assert.ok(original, "expected original repository attempt");
      const stop = await fixture.requestStop(owner);
      const { idempotencyKey: _workKey, ...firstRevision } = first;
      const replacement = {
        ...firstRevision,
        id: `rev_${randomUUID()}`,
        revision: 2,
        configuration: { revision: "2" },
        createdAt: new Date().toISOString(),
      };
      const replacementKey = `agent_revision:${replacement.id}:reconcile`;
      const commitAdmission = Promise.withResolvers<void>();
      const releaseCompute = Promise.withResolvers<void>();
      let locked = false;
      let preparingReplacement = false;
      const stopped: string[] = [];
      const events: WorkerEvent[] = [];
      // Follow production Namespace→Agent lock ordering. The stop worker can read
      // committed stopped intent, then waits while admission atomically publishes
      // its newer revision, running intent, and queue item.
      const admission = fixture.state.transactWithQueue(async (unit, queue) => {
        await unit.namespaces.lockNamespace(fixture.namespace.id);
        await unit.agents.lockAgent(fixture.namespace.id, owner.id);
        locked = true;
        await commitAdmission.promise;
        await unit.revisions.createRevision(replacement);
        await unit.agents.transitionAgentDesiredRuntimeState(
          fixture.namespace.id,
          owner.id,
          ["stopped"],
          "running",
        );
        await queue.enqueue({
          idempotencyKey: replacementKey,
          namespaceId: fixture.namespace.id,
          agentId: owner.id,
          revisionId: replacement.id,
          actorId: fixture.actor.id,
          availableAt: new Date(0),
        });
      });
      // Keep a rejected setup promise observed while the finally block owns its join.
      void admission.catch(() => {});
      try {
        await waitFor("replacement admission to hold its resource locks", async () =>
          locked ? true : undefined,
        );
        const workerPool = fixture.createWorkerPool();
        const backend = await workerPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await fixture.start(
          {
            ...fixture.compute,
            async prepareRevision(revision, deploymentContext) {
              if (revision.id === replacement.id) {
                preparingReplacement = true;
                await releaseCompute.promise;
              }
              return fixture.compute.prepareRevision(revision, deploymentContext);
            },
            async stopRevision(revision) {
              stopped.push(revision.id);
              return fixture.compute.stopRevision(revision);
            },
          },
          { emit: (event) => events.push(readWorkerEvent(event)), pool: workerPool },
        );
        await waitFor("the stop worker's real database lock wait", async () => {
          const waiting = await fixture.observerPool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'
             AND query LIKE '%FROM occ.namespaces%' AND query LIKE '%FOR UPDATE%'
             AND cardinality(pg_blocking_pids(pid)) > 0`,
            [required(backend.rows[0], "worker backend").pid],
          );
          return waiting.rowCount === 1 ? true : undefined;
        });
        assert.equal((await fixture.work(stop, "claimed")).attempt_count, 1);
        commitAdmission.resolve();
        await admission;
        await waitFor("the newer revision to reach Compute preparation", async () =>
          preparingReplacement ? true : undefined,
        );
        assert.equal((await fixture.work(stop, "succeeded")).attempt_count, 1);
        await completion(
          events,
          "the stop's STOP_SUPERSEDED completion",
          ({ event, workId, code }) =>
            event === "worker.completed" &&
            workId === stop.idempotencyKey &&
            code === "STOP_SUPERSEDED",
        );
        assert.deepEqual(stopped, []);
        assert.equal(
          repository.calls.some(
            (call) => call.operation === "close" && call.sessionId === original.sessionId,
          ),
          false,
        );
        const [retained] = await repositoryAttempts(fixture, first);
        assert.ok(retained, "expected retained repository attempt");
        assert.equal(retained.phase, "open");
        assert.equal(retained.sessionId, original.sessionId);
        const current = required(await fixture.currentAgent(owner), "fixture Agent");
        assert.equal(current.desiredRuntimeState, "running");
        assert.equal(current.activeRevisionId, first.id);
      } finally {
        commitAdmission.resolve();
        releaseCompute.resolve();
        await admission;
      }
      await fixture.work({ id: replacement.id, idempotencyKey: replacementKey }, "succeeded");
      const current = required(await fixture.currentAgent(owner), "fixture Agent");
      assert.equal(current.activeRevisionId, replacement.id);
    },
  );

  test(
    "repository cleanup rereads obligations added while its external close is outstanding",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary({ count: 2 });
      const fixture = await setup(context, { repoDriver: repository.driver });
      const { owner, candidate } = await fixture.admitInitialRevision("repository-cleanup-reread", {
        revision: { repositoryCredentials: repository.snapshot },
      });
      const open = repository.driver.open;
      const close = repository.driver.close;
      const releaseCleanup = Promise.withResolvers<void>();
      let firstSession: RepositoryCredentialSessionStatus | undefined;
      let cleanupWaiting = false;
      let preparations = 0;
      const stopped: string[] = [];
      repository.driver.open = async (input, signal) => {
        const result = await open(input, signal);
        if (result.kind === "created" && firstSession === undefined) {
          firstSession = result.session;
        }
        return result;
      };
      repository.driver.close = async (sessionId, signal) => {
        if (sessionId === firstSession?.sessionId && !cleanupWaiting) {
          const source = await fixture.observerPool.query<{ state: ControllerWorkState }>(
            "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
            [candidate.idempotencyKey],
          );
          if (required(source.rows[0], "source work").state === "claimed") {
            // A failed repair leaves its first binding closing while the other
            // binding remains open until foreground exhaustion transfers it.
            throw new Error("repository close temporarily unavailable");
          }
          cleanupWaiting = true;
          await releaseCleanup.promise;
        }
        return close(sessionId, signal);
      };
      await fixture.start({
        ...fixture.compute,
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
        async prepareRevision(revision, deploymentContext) {
          preparations += 1;
          if (preparations > 1) {
            throw new Error("Compute unavailable during repair");
          }
          const observation = await fixture.compute.prepareRevision(revision, deploymentContext);
          assert.ok(deploymentContext?.repositoryCredentials);
          const [binding] = deploymentContext.repositoryCredentials;
          assert.ok(binding, "expected repository material");
          return {
            ...observation,
            ready: false,
            repositoryCredentialMaterialMissing: [
              {
                repositoryRef: binding.repositoryRef,
                sessionId: binding.sessionId,
              },
            ],
          };
        },
      });
      let cleanupKey: string | undefined;
      try {
        await waitFor("the durable cleanup worker to enter its pending close", async () =>
          cleanupWaiting ? true : undefined,
        );
        const before = await repositoryAttempts(fixture, candidate);
        assert.equal(before.length, 2);
        assert.deepEqual(before.map(({ phase }) => phase).sort(), ["closing", "open"]);
        const cleanup = await fixture.observerPool.query<{
          idempotency_key: string;
          state: ControllerWorkState;
          actor_id: string;
          claim_token: string | null;
        }>(
          `SELECT idempotency_key, state, actor_id, claim_token FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key LIKE $2`,
          [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
        );
        assert.equal(cleanup.rowCount, 1);
        const cleanupRow = required(cleanup.rows[0], "cleanup work");
        assert.equal(cleanupRow.state, "claimed");
        assert.equal(cleanupRow.actor_id, fixture.actor.id);
        cleanupKey = cleanupRow.idempotency_key;

        // Recovery transfers another stop's session cleanup while the first
        // worker is in the external close. The Agent remains running, as when
        // later intent supersedes an earlier stop; recovery must retain the claim.
        const stopKey = `agent:${owner.id}:reconcile:stopped:${randomUUID()}`;
        await fixture.state.transactWithQueue((_unit, queue) =>
          queue.enqueue({
            idempotencyKey: stopKey,
            namespaceId: candidate.namespaceId,
            agentId: candidate.agentId,
            agentTarget: "stopped",
            actorId: fixture.actor.id,
          }),
        );
        await fixture.observerPool.query<never>(
          "UPDATE occ.controller_work SET attempt_count = 1 WHERE idempotency_key = $1",
          [stopKey],
        );
        // A separately configured queue can exhaust the original queued source
        // while its already-claimed session cleanup retains its own purpose.
        const recovery = new fixture.PostgresWorkQueue(fixture.observerPool, {
          leaseDurationMs: 30_000,
          maxAttempts: 1,
          random: () => 0,
        });
        assert.ok((await recovery.recoverStale()).exhaustedQueued >= 2);
        await fixture.work(candidate, "failed_permanent");
        const stillClaimed = await fixture.observerPool.query<{
          state: ControllerWorkState;
          claim_token: string | null;
        }>("SELECT state, claim_token FROM occ.controller_work WHERE idempotency_key = $1", [
          cleanupKey,
        ]);
        assert.deepEqual(stillClaimed.rows[0], {
          state: "claimed",
          claim_token: cleanupRow.claim_token,
        });
        assert.ok(
          (await repositoryAttempts(fixture, candidate)).every(({ phase }) => phase === "closing"),
        );
      } finally {
        releaseCleanup.resolve();
      }
      await waitFor(
        "cleanup to close the newly transferred obligation before completion",
        async () => {
          const attempts = await repositoryAttempts(fixture, candidate);
          return attempts.length === 2 && attempts.every(({ phase }) => phase === "disposed")
            ? true
            : undefined;
        },
      );
      await advanceCleanupRetries(fixture, candidate);
      await fixture.work(
        { id: candidate.id, idempotencyKey: required(cleanupKey, "cleanup work key") },
        "succeeded",
      );
      const cleanup = await fixture.observerPool.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      assert.equal(cleanup.rowCount, 2);
      const retirement = cleanup.rows.find(({ idempotency_key }) =>
        idempotency_key.includes(":repository_cleanup:retire:"),
      );
      assert.ok(retirement);
      await fixture.work(
        { id: candidate.id, idempotencyKey: retirement.idempotency_key },
        "succeeded",
      );
      assert.deepEqual(stopped, [candidate.id]);
      assert.equal(preparations, 1);
      assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 2);
    },
  );

  test(
    "a PostgreSQL claim lost during repository admission aborts its signal and rejects late material",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, {
        leaseDurationMs: 600,
        repoDriver: repository.driver,
      });
      const { owner, candidate } = await fixture.admitInitialRevision("repository-stale-claim", {
        revision: { repositoryCredentials: repository.snapshot },
      });
      const release = Promise.withResolvers<void>();
      const open = repository.driver.open;
      let firstInput: OpenRepositorySessionInput | undefined;
      let operationSignal: AbortSignal | undefined;
      let staleSessionId: string | undefined;
      repository.driver.open = async (input, signal) => {
        const result = await open(input, signal);
        if (firstInput === undefined) {
          assert.equal(result.kind, "created");
          firstInput = input;
          operationSignal = signal;
          staleSessionId = result.session.sessionId;
          // A remote response can arrive even after cancellation. The worker must
          // fence the successful result, independently of Driver cooperation.
          await release.promise;
        }
        return result;
      };
      const prepared: RepositoryCredentialRuntimeBinding[] = [];
      let preparations = 0;
      const events: WorkerEvent[] = [];
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision, deploymentContext) {
            preparations += 1;
            assert.ok(deploymentContext?.repositoryCredentials);
            prepared.push(...deploymentContext.repositoryCredentials);
            return fixture.compute.prepareRevision(revision, deploymentContext);
          },
        },
        { emit: (event) => events.push(readWorkerEvent(event)) },
      );
      let recoveryQueue;
      let recovered;
      try {
        await waitFor("the worker to dispatch its first repository admission", async () =>
          firstInput === undefined ? undefined : true,
        );
        const original = await fixture.work(candidate, "claimed");
        assert.ok(original.claim_token, "claimed work must have a token");
        await fixture.expireClaim(candidate, original.claim_token);
        recoveryQueue = new fixture.PostgresWorkQueue(fixture.observerPool, {
          leaseDurationMs: 30_000,
          maxAttempts: 5,
          random: () => 0,
        });
        assert.ok((await recoveryQueue.recoverStale()).recovered >= 1);
        recovered = await recoveryQueue.claim();
        assert.equal(recovered?.idempotencyKey, candidate.idempotencyKey);
        assert.equal(recovered.attemptCount, 2);
        assert.notEqual(recovered.claimToken, original.claim_token);
        await waitFor("the lost PostgreSQL claim to abort the outstanding admission", async () =>
          required(operationSignal, "admission signal").aborted ? true : undefined,
        );
        assert.equal(prepared.length, 0);
        assert.equal(preparations, 0);
      } finally {
        release.resolve();
      }
      await waitFor("the stale worker to reject the late admission response", async () =>
        events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
      );
      assert.equal(prepared.length, 0);
      assert.equal(preparations, 0);
      const attempts = await repositoryAttempts(fixture, candidate);
      assert.equal(attempts.length, 1);
      const attempt = required(attempts[0], "original attempt");
      const admissionId = required(firstInput, "first admission input").admissionId;
      assert.equal(attempt.admissionId, admissionId);
      assert.equal(attempt.phase, "opening");
      assert.equal(attempt.sessionId, undefined);
      const unchanged = await fixture.observerPool.query<{
        state: ControllerWorkState;
        claim_token: string | null;
        attempt_count: number;
        completed_at: Date | null;
      }>(
        `SELECT state, claim_token, attempt_count, completed_at
         FROM occ.controller_work WHERE idempotency_key = $1`,
        [candidate.idempotencyKey],
      );
      assert.deepEqual(unchanged.rows, [
        {
          state: "claimed",
          claim_token: recovered.claimToken,
          attempt_count: 2,
          completed_at: null,
        },
      ]);
      const inactive = required(await fixture.currentAgent(owner), "fixture Agent");
      assert.equal(inactive.activeRevisionId, undefined);
      await recoveryQueue.retry(recovered, { code: "TEST_RECOVERY_HANDOFF" });
      await fixture.work(candidate, "succeeded");
      assert.equal(prepared.length, 1);
      assert.equal(preparations, 1);
      const material = required(prepared.at(0), "delivered material");
      assert.notEqual(material.sessionId, staleSessionId);
      assert.equal(
        (await repositoryAttempts(fixture, candidate)).find(
          (entry) => entry.admissionId === admissionId,
        )?.phase,
        "disposed",
      );
    },
  );
}
