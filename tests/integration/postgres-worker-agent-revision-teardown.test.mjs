import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { createOccLogger, createWorkerLogEmitter } from "../../apps/controller/src/logging.ts";
import { PostgresMetricsSnapshot } from "../../packages/occ/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  advanceCleanupRetries,
  completion,
  removeAccessBindings,
  repositoryAttempts,
  repositoryBoundary,
} from "../helpers/postgres-worker-revision-support.mjs";

// Repository sessions through admission, maintenance and cleanup, Agent stop, Agent
// deletion and Namespace teardown. Withdrawal, deployment and dispatch cases, and the
// persisted deploy, stop and delete lifecycle, are in postgres-worker-agent-revision.test.mjs.

const { setup, cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

async function coldSshComputeDriver(fixture, operations) {
  const { SshComputeDriver } =
    await import("../../apps/controller/src/drivers/compute/ssh/index.ts");
  return new SshComputeDriver(
    {
      ssh: { identityFile: "/fixture/identity", knownHostsFile: "/fixture/hosts" },
      hosts: { [fixture.namespace.name]: { address: "127.0.0.1", user: "root" } },
      runtime: {
        nodePath: "/usr/bin/node",
        openclawPath: "/opt/openclaw/index.js",
        user: "runtime",
        root: "/var/lib/openclaw-enterprise",
      },
      network: { gatewayPortRange: { start: 18800, end: 18899 } },
    },
    {
      id: fixture.compute.id,
      implementation: fixture.compute.implementation,
      executor: {
        async execute(request) {
          operations.push(JSON.parse(Buffer.from(request.operation, "base64").toString()));
          return { code: 0, stdout: '{"ok":true}', stderr: "" };
        },
      },
    },
  );
}

test(
  "repository admission persists its opening request before dispatch and session ID before Compute",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const { candidate } = await fixture.admitInitialRevision("repository-ordering", {
      revision: { repositoryCredentials: repository.snapshot },
    });
    const open = repository.driver.open;
    repository.driver.open = async (input, signal) => {
      const attempts = await repositoryAttempts(fixture, candidate);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].phase, "opening");
      assert.equal(attempts[0].sessionId, undefined);
      assert.equal(attempts[0].admissionId, input.admissionId);
      assert.equal(attempts[0].repositoryRef, input.binding.repositoryRef);
      assert.equal(attempts[0].durationSeconds, input.durationSeconds);
      assert.equal(attempts[0].deadlineWallMs, input.deadlineWallMs);
      return open(input, signal);
    };
    const material = [];
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          const attempts = await repositoryAttempts(fixture, revision);
          const [binding] = deploymentContext.repositoryCredentials;
          assert.equal(attempts.length, 1);
          assert.equal(attempts[0].phase, "open");
          assert.equal(attempts[0].sessionId, binding.sessionId);
          assert.equal(binding.kind, "new");
          assert.equal(binding.repositoryRef, repository.snapshot.bindings[0].repositoryRef);
          material.push(binding.files.bearer);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      { emit: (event) => events.push(event) },
    );
    assert.equal((await fixture.work(candidate, "succeeded")).attempt_count, 1);
    assert.equal(material.length, 1);
    const persisted = await fixture.observerPool.query(
      `SELECT to_jsonb(attempt) AS value FROM occ.repository_session_attempts AS attempt
       WHERE revision_id = $1
       UNION ALL SELECT to_jsonb(work) FROM occ.controller_work AS work WHERE revision_id = $1
       UNION ALL SELECT to_jsonb(audit) FROM occ.audit_events AS audit WHERE namespace_id = $2`,
      [candidate.id, candidate.namespaceId],
    );
    assert.equal(JSON.stringify(persisted.rows).includes(material[0]), false);
    assert.equal(JSON.stringify(events).includes(material[0]), false);
  },
);

for (const alreadyDisposed of [false, true]) {
  test(
    alreadyDisposed
      ? "a dropped repository-open response preserves recovered disposal after service pruning"
      : "a dropped repository-open response recovers and closes its admission before opening fresh material",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const { candidate } = await fixture.admitInitialRevision("repository-lost-response", {
        revision: { repositoryCredentials: repository.snapshot },
      });
      const open = repository.driver.open;
      let lostSessionId;
      repository.driver.open = async (input, signal) => {
        const result = await open(input, signal);
        if (lostSessionId === undefined && result.kind === "created") {
          lostSessionId = result.session.sessionId;
          throw new Error("repository admission response lost after creation");
        }
        if (alreadyDisposed && result.kind === "recovered") {
          return { ...result, status: { ...result.status, state: "DISPOSED" } };
        }
        return result;
      };
      if (alreadyDisposed) {
        // The service's terminal observation is authoritative even if another
        // admission prunes that inventory before a redundant close could arrive.
        repository.driver.close = async (sessionId) => {
          repository.calls.push({ operation: "close", sessionId });
          return undefined;
        };
      }
      const material = [];
      await fixture.start({
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          material.push(...deploymentContext.repositoryCredentials);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      });
      const completed = await fixture.work(candidate, "succeeded");
      assert.equal(completed.attempt_count, 2);
      const attempts = await repositoryAttempts(fixture, candidate);
      assert.equal(attempts.find(({ sessionId }) => sessionId === lostSessionId).phase, "disposed");
      assert.deepEqual(
        repository.calls.map(({ operation }) => operation),
        alreadyDisposed ? ["open", "recover", "open"] : ["open", "recover", "close", "open"],
      );
      const [original, recovered] = repository.calls;
      const fresh = repository.calls.at(-1);
      assert.deepEqual(recovered.input, { ...original.input, recoverOnly: true });
      if (!alreadyDisposed) {
        assert.equal(repository.calls[2].sessionId, lostSessionId);
      }
      assert.notEqual(fresh.input.admissionId, original.input.admissionId);
      assert.deepEqual(fresh.input.binding, original.input.binding);
      assert.equal(fresh.input.deadlineWallMs, original.input.deadlineWallMs);
      assert.ok(fresh.input.durationSeconds <= original.input.durationSeconds);
      assert.equal(
        attempts.find(({ admissionId }) => admissionId === fresh.input.admissionId).phase,
        "open",
      );
      assert.equal(material.length, 1);
      assert.equal(material[0].kind, "new");
      assert.notEqual(material[0].sessionId, lostSessionId);
    },
  );
}

test(
  "a missing never-delivered repository opening can recover without inventing disposal",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const { candidate } = await fixture.admitInitialRevision("repository-unseen-opening", {
      revision: { repositoryCredentials: repository.snapshot },
    });
    const open = repository.driver.open;
    let undelivered;
    repository.driver.open = async (input, signal) => {
      if (undelivered === undefined) {
        undelivered = input.admissionId;
        throw new Error("control request did not reach the service");
      }
      return open(input, signal);
    };
    const material = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        material.push(...deploymentContext.repositoryCredentials);
        return fixture.compute.prepareRevision(revision, deploymentContext);
      },
    });
    await fixture.work(candidate, "succeeded");
    const attempts = await repositoryAttempts(fixture, candidate);
    const missing = attempts.find(({ admissionId }) => admissionId === undelivered);
    assert.equal(missing.phase, "invalidated");
    assert.equal(missing.sessionId, undefined);
    assert.equal(missing.liveRevisionId, candidate.id);
    assert.equal(attempts.length, 2);
    assert.equal(material.length, 1);
    assert.equal(material[0].sessionId, attempts.find(({ phase }) => phase === "open").sessionId);
    assert.deepEqual(
      repository.calls.map(({ operation }) => operation),
      ["recover", "open"],
    );
    await fixture.stop();
  },
);

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
    const stopped = [];
    let iamUnavailable = false;
    const compute = {
      ...fixture.compute,
      async stopRevision(revision) {
        stopped.push(revision.id);
        return fixture.compute.stopRevision(revision);
      },
    };
    const withUnavailableIAM = (drivers) => {
      const createIAMDriver = drivers.createIAMDriver;
      return {
        ...drivers,
        createIAMDriver(state) {
          const iam = createIAMDriver(state);
          return {
            id: iam.id,
            implementation: iam.implementation,
            capability: iam.capability,
            lookupIdentity: iam.lookupIdentity.bind(iam),
            async authorize(request) {
              if (iamUnavailable) {
                throw new Error("IAM is temporarily unavailable");
              }
              return iam.authorize(request);
            },
          };
        },
      };
    };
    const startWorker = () =>
      fixture.start(compute, {
        pool: fixture.createWorkerPool(),
        transformDrivers: withUnavailableIAM,
      });
    await startWorker();
    await fixture.work(candidate, "succeeded");
    await fixture.stop();

    iamUnavailable = true;
    const maintenance = await fixture.advanceMaintenance(candidate);
    assert.equal(maintenance.rowCount, 1);
    const outage = { id: candidate.id, idempotencyKey: maintenance.rows[0].idempotency_key };
    await startWorker();
    await fixture.work(outage, "failed_permanent");
    await fixture.stop();
    const failed = await fixture.observerPool.query(
      "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
      [outage.idempotencyKey],
    );
    assert.equal(failed.rows[0].reason_code, "DEPENDENCY_UNAVAILABLE");
    const retirement = await fixture.observerPool.query(
      `SELECT idempotency_key FROM occ.controller_work
       WHERE revision_id = $1 AND idempotency_key LIKE $2`,
      [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
    );
    assert.equal(retirement.rowCount, 0, "an outage must not retire the authorized runtime");
    assert.deepEqual(stopped, []);
    const agent = await fixture.currentAgent(owner);
    assert.equal(agent.activeRevisionId, candidate.id);
    assert.equal(agent.desiredRuntimeState, "running");

    // The maintenance chain continues, so the runtime is kept current once
    // the dependency recovers.
    iamUnavailable = false;
    const next = await fixture.advanceMaintenance(candidate);
    assert.equal(next.rowCount, 1);
    assert.notEqual(next.rows[0].idempotency_key, outage.idempotencyKey);
    await startWorker();
    await fixture.work(
      { id: candidate.id, idempotencyKey: next.rows[0].idempotency_key },
      "succeeded",
    );
    await fixture.stop();
    assert.deepEqual(stopped, []);
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
    const stopped = [];
    const compute = {
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
    const crashedKey = maintenance.rows[0].idempotency_key;
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 1,
      random: () => 0,
    });
    const crashed = await queue.claim();
    assert.equal(crashed?.idempotencyKey, crashedKey);
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1 AND claim_token = $2::uuid`,
      [crashedKey, crashed.claimToken],
    );
    const recovery = await queue.recoverStale();
    assert.equal(recovery.recovered, 1);

    const failed = await fixture.observerPool.query(
      "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
      [crashedKey],
    );
    assert.deepEqual(failed.rows[0], { state: "failed_permanent", reason_code: "LEASE_EXPIRED" });
    const retirement = await fixture.observerPool.query(
      `SELECT idempotency_key FROM occ.controller_work
       WHERE revision_id = $1 AND idempotency_key LIKE $2`,
      [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
    );
    assert.equal(retirement.rowCount, 0, "a crashed worker must not retire the active runtime");
    const agent = await fixture.currentAgent(owner);
    assert.equal(agent.activeRevisionId, candidate.id);
    assert.equal(agent.desiredRuntimeState, "running");

    // The maintenance chain continues with the next bucket.
    const next = await fixture.advanceMaintenance(candidate);
    assert.equal(next.rowCount, 1);
    const bucket = BigInt(crashedKey.slice(crashedKey.lastIndexOf(":") + 1));
    assert.deepEqual(next.rows[0], {
      idempotency_key: `agent_revision:${candidate.id}:maintenance:${bucket + 1n}`,
      attempt_count: 0,
      actor_id: crashed.actorId,
    });
    await fixture.start(compute);
    await fixture.work(
      { id: candidate.id, idempotencyKey: next.rows[0].idempotency_key },
      "succeeded",
    );
    await fixture.stop();
    assert.deepEqual(stopped, []);
  },
);

for (const { name, crashes, finish } of [
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
]) {
  test(name, requiresPostgres, async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver, maxAttempts: 1 });
    const { owner, candidate: first } = await fixture.admitInitialRevision(
      `publish-crash-${crashes}-${finish === "dependency-unavailable"}`,
      { revision: { repositoryCredentials: repository.snapshot } },
    );
    const stopped = [];
    const retired = [];
    let iamUnavailable = false;
    const compute = {
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
    await fixture.start(compute);
    await fixture.work(first, "succeeded");
    await fixture.stop();

    // A worker claims the replacement on its last attempt, publishes the active pointer and
    // crashes before activation, predecessor retirement and completion.
    const second = await fixture.revision(owner, 2, { repositoryCredentials: repository.snapshot });
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 1,
      random: () => 0,
    });
    const crash = async () => {
      const claim = await queue.claim();
      assert.equal(claim?.idempotencyKey, second.idempotencyKey);
      await fixture.expireClaim(claim, claim.claimToken);
      assert.equal((await queue.recoverStale()).recovered, 1);
    };
    await fixture.state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(fixture.namespace.id, owner.id, first.id, second.id),
    );
    for (let crash_ = 0; crash_ < crashes; crash_ += 1) {
      await crash();
    }
    const row = async () =>
      (
        await fixture.observerPool.query(
          "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
          [second.idempotencyKey],
        )
      ).rows[0];
    const retirement = await fixture.observerPool.query(
      "SELECT 1 FROM occ.controller_work WHERE idempotency_key LIKE $1",
      [`agent_revision:${second.id}:repository_cleanup:retire:%`],
    );
    assert.equal(retirement.rowCount, 0, "recovery must not retire the active runtime");
    const evidence = await fixture.observerPool.query(
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
    assert.equal(evidence.rows.at(-1).reason_code, "ACTIVE_REVISION_RECOVERY");
    const progress = await fixture.state.read((view) =>
      view.operations.findWorkAttempt(second.idempotencyKey),
    );
    assert.equal(progress?.code, "ACTIVE_REVISION_RECOVERY");

    if (finish === "dependency-unavailable") {
      // A retry outcome on the extra (last) attempt fails the deployment but keeps the
      // runtime it already activated.
      iamUnavailable = true;
      await fixture.start(compute, {
        transformDrivers: (drivers) => {
          const createIAMDriver = drivers.createIAMDriver;
          return {
            ...drivers,
            createIAMDriver(state) {
              const iam = createIAMDriver(state);
              return {
                id: iam.id,
                implementation: iam.implementation,
                capability: iam.capability,
                lookupIdentity: iam.lookupIdentity.bind(iam),
                async authorize(request) {
                  if (iamUnavailable) {
                    throw new Error("IAM is temporarily unavailable");
                  }
                  return iam.authorize(request);
                },
              };
            },
          };
        },
      });
      await fixture.work(second, "failed_permanent");
      await fixture.stop();
      assert.deepEqual(await row(), {
        state: "failed_permanent",
        reason_code: "DEPENDENCY_UNAVAILABLE",
        attempt_count: 1,
      });
      const retireAfterFailure = await fixture.observerPool.query(
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
    assert.equal((await row()).reason_code, "REVISION_ALREADY_ACTIVE");
    assert.deepEqual(retired, [first.id], "the predecessor must be retired");
    assert.deepEqual(stopped, [], "the active revision must keep running");
    const agent = await fixture.currentAgent(owner);
    assert.equal(agent.activeRevisionId, second.id);
  });
}

for (const loss of ["missing", "closed-repair"]) {
  test(
    loss === "missing"
      ? "repository missing refuses replacement after exposure and retains refusal across worker restart"
      : "repository closed-repair waits across worker restart and replaces material only after disposal",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, {
        repoDriver: repository.driver,
        leaseDurationMs: 600,
      });
      const { owner, candidate } = await fixture.admitInitialRevision(`repository-${loss}`, {
        revision: { repositoryCredentials: repository.snapshot },
      });
      const delivered = [];
      const stopped = [];
      let missingMaterial = false;
      const compute = {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          delivered.push(...deploymentContext.repositoryCredentials);
          const observation = await fixture.compute.prepareRevision(revision, deploymentContext);
          return missingMaterial
            ? {
                ...observation,
                ready: false,
                repositoryCredentialMaterialMissing: [
                  {
                    repositoryRef: delivered[0].repositoryRef,
                    sessionId: delivered[0].sessionId,
                  },
                ],
              }
            : observation;
        },
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
      };
      await fixture.start(compute);
      await fixture.work(candidate, "succeeded");
      await fixture.stop();
      const [original] = await repositoryAttempts(fixture, candidate);
      const status = await repository.driver.status(original.sessionId);
      const close = repository.driver.close;
      // These are Driver protocol observations. Real PostgreSQL and worker
      // admission must refuse replacement without inferring provider settlement.
      if (loss === "missing") {
        repository.driver.status = async () => undefined;
        repository.driver.close = async () => undefined;
      } else {
        missingMaterial = true;
        repository.driver.close = async () => ({ ...status, state: "CLOSED" });
      }
      const maintenance = await fixture.advanceMaintenance(candidate);
      assert.equal(maintenance.rowCount, 1);
      await fixture.start(compute, { pool: fixture.createWorkerPool() });
      if (loss === "closed-repair") {
        await waitFor("known closing session to retain cleanup ownership", async () => {
          const [attempt] = await repositoryAttempts(fixture, candidate);
          return attempt.phase === "closing" ? attempt : undefined;
        });
        await fixture.work(
          { id: candidate.id, idempotencyKey: maintenance.rows[0].idempotency_key },
          "failed_permanent",
        );
        await fixture.stop();
        const [pending] = await repositoryAttempts(fixture, candidate);
        assert.equal(pending.sessionId, original.sessionId);
        assert.equal(pending.liveRevisionId, candidate.id);
        assert.deepEqual(pending.cleanupContext, original.cleanupContext);
        assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
        assert.equal(delivered.filter(({ kind }) => kind === "new").length, 1);

        // A restarted worker must still wait; CLOSED has not settled the
        // original session's provider obligations or authorized new material.
        const queued = await fixture.advanceMaintenance(candidate);
        assert.equal(queued.rowCount, 1);
        const retry = { id: candidate.id, idempotencyKey: queued.rows[0].idempotency_key };
        await fixture.start(compute, { pool: fixture.createWorkerPool() });
        await fixture.work(retry, "failed_permanent");
        await fixture.stop();
        const refusal = await fixture.observerPool.query(
          "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
          [retry.idempotencyKey],
        );
        assert.equal(refusal.rows[0].reason_code, "REVISION_FINALIZATION_INCOMPLETE");
        assert.equal((await repositoryAttempts(fixture, candidate)).length, 1);
        assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
        assert.equal(delivered.filter(({ kind }) => kind === "new").length, 1);
        assert.deepEqual(stopped, []);

        // Only confirmed disposal permits the existing bounded continuation
        // to obtain a fresh session under the original revision deadline.
        repository.driver.close = close;
        missingMaterial = false;
        const continuation = await fixture.advanceMaintenance(candidate);
        assert.ok(continuation.rowCount > 0);
        await fixture.start(compute, { pool: fixture.createWorkerPool() });
        await fixture.work(
          { id: candidate.id, idempotencyKey: continuation.rows[0].idempotency_key },
          "succeeded",
        );
        await fixture.stop();
        const attempts = await repositoryAttempts(fixture, candidate);
        assert.equal(
          attempts.find(({ sessionId }) => sessionId === original.sessionId).phase,
          "disposed",
        );
        const fresh = attempts.find(({ phase }) => phase === "open");
        assert.ok(fresh);
        assert.notEqual(fresh.sessionId, original.sessionId);
        assert.notEqual(fresh.admissionId, original.admissionId);
        assert.equal(fresh.deadlineWallMs, original.deadlineWallMs);
        assert.ok(fresh.durationSeconds <= original.durationSeconds);
        assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 2);
        assert.equal(delivered.filter(({ kind }) => kind === "new").length, 2);
        assert.deepEqual(stopped, []);
        return;
      }
      await fixture.work(
        { id: candidate.id, idempotencyKey: maintenance.rows[0].idempotency_key },
        "failed_permanent",
      );
      await waitFor("unsafe revision runtime to retire", async () =>
        stopped.includes(candidate.id) ? true : undefined,
      );
      if (loss === "missing") {
        await waitFor("invalidated cleanup to wait for Driver maintenance", async () => {
          const delayed = await fixture.observerPool.query(
            `SELECT EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
             FROM occ.controller_work
             WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2`,
            [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
          );
          return Number(delayed.rows[0]?.delay_ms) >=
            repository.driver.maintenanceIntervalMs - 1_000
            ? true
            : undefined;
        });
      }
      await fixture.stop();
      const refusal = await fixture.observerPool.query(
        "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
        [maintenance.rows[0].idempotency_key],
      );
      assert.equal(refusal.rows[0].reason_code, "REPOSITORY_SESSION_RECOVERY_UNSAFE");
      const [retained] = await repositoryAttempts(fixture, candidate);
      assert.equal(retained.phase, loss === "missing" ? "invalidated" : "closing");
      assert.equal(retained.sessionId, original.sessionId);
      assert.equal(retained.liveRevisionId, candidate.id);
      assert.deepEqual(retained.cleanupContext, original.cleanupContext);
      const cleanup = await fixture.observerPool.query(
        `SELECT state, actor_id FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
      );
      assert.equal(cleanup.rowCount, 1);
      assert.equal(cleanup.rows[0].state, "queued");
      assert.equal(cleanup.rows[0].actor_id, fixture.actor.id);

      // Previously admitted maintenance observations must keep refusing the
      // lost session without multiplying the durable retirement obligation.
      await fixture.start(compute, { pool: fixture.createWorkerPool() });
      for (let index = 0; index < 4; index += 1) {
        const another = {
          id: candidate.id,
          idempotencyKey: `agent_revision:${candidate.id}:maintenance:${Math.floor(Date.now() / repository.driver.maintenanceIntervalMs) + 2 + index}`,
        };
        await fixture.state.transactWithQueue((_unit, queue) =>
          queue.enqueue({
            idempotencyKey: another.idempotencyKey,
            namespaceId: candidate.namespaceId,
            agentId: candidate.agentId,
            revisionId: candidate.id,
            actorId: fixture.actor.id,
            availableAt: new Date(0),
          }),
        );
        await fixture.work(another, "failed_permanent");
      }
      await fixture.stop();
      const repeatedCleanup = await fixture.observerPool.query(
        `SELECT state, actor_id FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
      );
      assert.equal(repeatedCleanup.rowCount, 1);
      assert.equal(repeatedCleanup.rows[0].state, "queued");
      assert.equal(repeatedCleanup.rows[0].actor_id, fixture.actor.id);
      assert.equal((await repositoryAttempts(fixture, candidate)).length, 1);
      assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
      assert.equal(delivered.filter(({ kind }) => kind === "new").length, 1);
      assert.ok(stopped.every((id) => id === candidate.id));

      // A separately admitted revision is a new user request. It must not erase
      // the old unresolved evidence or inherit the old session's authority.
      missingMaterial = false;
      const replacement = await fixture.revision(owner, 2, {
        repositoryCredentials: repository.snapshot,
      });
      await fixture.start(compute, { pool: fixture.createWorkerPool() });
      await fixture.work(replacement, "succeeded");
      await fixture.stop();
      const [fresh] = await repositoryAttempts(fixture, replacement);
      assert.equal(fresh.phase, "open");
      assert.notEqual(fresh.sessionId, original.sessionId);
      assert.notEqual(fresh.admissionId, original.admissionId);
      assert.equal((await repositoryAttempts(fixture, candidate))[0].phase, retained.phase);
      assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 2);
    },
  );
}

test(
  "worker restart resumes repository maintenance and repairs only Compute's exact missing subset once",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary({ count: 2 });
    const fixture = await setup(context, { repoDriver: repository.driver });
    const { candidate } = await fixture.admitInitialRevision("repository-maintenance-restart", {
      revision: { repositoryCredentials: repository.snapshot },
    });
    const initial = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        initial.push(...deploymentContext.repositoryCredentials);
        return fixture.compute.prepareRevision(revision, deploymentContext);
      },
    });
    await fixture.work(candidate, "succeeded");
    await fixture.stop();
    assert.equal(initial.length, 2);
    const initialAttempts = await repositoryAttempts(fixture, candidate);
    for (const binding of initial) {
      const attempt = initialAttempts.find(
        (entry) =>
          entry.repositoryRef === binding.repositoryRef && entry.sessionId === binding.sessionId,
      );
      assert.ok(attempt);
      assert.equal(binding.admissionId, attempt.admissionId);
    }

    // Successful activation already owns a queued observation with its original
    // actor. Advancing this owned work's due time models a restart at that time.
    const maintenance = await fixture.advanceMaintenance(candidate);
    assert.equal(maintenance.rowCount, 1);
    assert.equal(maintenance.rows[0].actor_id, fixture.actor.id);
    const observed = [];
    const stopped = [];
    const callsBeforeRestart = repository.calls.length;
    await fixture.start(
      {
        ...fixture.compute,
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
        async prepareRevision(revision, deploymentContext) {
          observed.push(deploymentContext.repositoryCredentials);
          const result = await fixture.compute.prepareRevision(revision, deploymentContext);
          return observed.length === 1
            ? {
                ...result,
                ready: false,
                repositoryCredentialMaterialMissing: [
                  { repositoryRef: initial[0].repositoryRef, sessionId: initial[0].sessionId },
                ],
              }
            : result;
        },
      },
      { pool: fixture.createWorkerPool() },
    );
    await fixture.work(
      { id: candidate.id, idempotencyKey: maintenance.rows[0].idempotency_key },
      "succeeded",
    );
    assert.equal(observed.length, 2, "one missing observation permits one bounded repair");
    assert.deepEqual(
      observed[0].map(({ kind, repositoryRef, sessionId, admissionId }) => ({
        kind,
        repositoryRef,
        sessionId,
        admissionId,
      })),
      initial.map(({ repositoryRef, sessionId, admissionId }) => ({
        kind: "retained",
        repositoryRef,
        sessionId,
        admissionId,
      })),
    );
    const repaired = observed[1].find(
      ({ repositoryRef }) => repositoryRef === initial[0].repositoryRef,
    );
    const retained = observed[1].find(
      ({ repositoryRef }) => repositoryRef === initial[1].repositoryRef,
    );
    assert.equal(repaired.kind, "new");
    assert.notEqual(repaired.sessionId, initial[0].sessionId);
    assert.notEqual(repaired.admissionId, initial[0].admissionId);
    assert.deepEqual(retained, observed[0][1]);
    const repairedAttempts = await repositoryAttempts(fixture, candidate);
    const repairedAttempt = repairedAttempts.find(
      (entry) => entry.sessionId === repaired.sessionId,
    );
    assert.ok(repairedAttempt);
    assert.equal(repaired.admissionId, repairedAttempt.admissionId);
    const recoveryCalls = repository.calls.slice(callsBeforeRestart);
    assert.deepEqual(
      recoveryCalls
        .filter(({ operation }) => operation === "status")
        .map(({ sessionId }) => sessionId)
        .sort(),
      initial.map(({ sessionId }) => sessionId).sort(),
    );
    assert.deepEqual(
      recoveryCalls
        .filter(({ operation }) => operation === "close")
        .map(({ sessionId }) => sessionId),
      [initial[0].sessionId],
    );
    assert.equal(recoveryCalls.filter(({ operation }) => operation === "open").length, 1);
    await waitFor("session-only repair cleanup to settle", async () => {
      const cleanup = await fixture.observerPool.query(
        `SELECT state FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      return cleanup.rowCount === 1 && cleanup.rows[0].state === "succeeded" ? true : undefined;
    });
    assert.deepEqual(stopped, []);
  },
);

test(
  "repeated missing repository material fails the observation after one repair and cannot activate",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const { owner, candidate } = await fixture.admitInitialRevision("repository-repair-bound", {
      revision: { repositoryCredentials: repository.snapshot },
    });
    let preparations = 0;
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        preparations += 1;
        const observation = await fixture.compute.prepareRevision(revision, deploymentContext);
        const [binding] = deploymentContext.repositoryCredentials;
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
    assert.equal((await fixture.work(candidate, "failed_permanent")).attempt_count, 1);
    assert.equal(preparations, 2);
    assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 2);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.activeRevisionId, undefined);
    await waitFor("both unusable material attempts to be disposed", async () => {
      const attempts = await repositoryAttempts(fixture, candidate);
      return attempts.length === 2 && attempts.every(({ phase }) => phase === "disposed")
        ? true
        : undefined;
    });
  },
);

for (const change of ["revoked", "stopped", "expired", "superseded"]) {
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
        await fixture.observerPool.query(
          `INSERT INTO occ.iam_identities (id, kind, issuer, subject)
           SELECT $1, kind, issuer, $1 FROM occ.iam_identities WHERE id = $2`,
          [actorId, fixture.actor.id],
        );
        const granted = await fixture.observerPool.query(
          `INSERT INTO occ.iam_access_bindings
            (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
           SELECT gen_random_uuid()::text, namespace_id, $1, NULL, role_id, resource_kind, resource_id
           FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
          [actorId, fixture.actor.id],
        );
        assert.ok(granted.rowCount > 0);
      }
      const candidate = await fixture.revision(owner, 1, {
        repositoryCredentials: repository.snapshot,
        actorId,
      });
      const open = repository.driver.open;
      let lostSessionId;
      repository.driver.open = async (input, signal) => {
        const result = await open(input, signal);
        if (lostSessionId === undefined && result.kind === "created") {
          lostSessionId = result.session.sessionId;
          // Change real authority while its external admission result is lost.
          // Cleanup may recover that admission but cannot deliver or replace it.
          if (change === "revoked") {
            // Restrictions are the supported app-role mutation that revokes
            // effective authority; identity deletion requires a different role.
            await fixture.observerPool.query(
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
      const prepared = [];
      const events = [];
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision, deploymentContext) {
            prepared.push(revision.id);
            return fixture.compute.prepareRevision(revision, deploymentContext);
          },
        },
        { emit: (event) => events.push(event) },
      );
      if (change === "superseded") {
        await waitFor("the superseded revision to finish without new authority", async () => {
          const result = await fixture.observerPool.query(
            "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
            [candidate.idempotencyKey],
          );
          return ["succeeded", "failed_permanent"].includes(result.rows[0]?.state)
            ? true
            : undefined;
        });
      } else {
        await fixture.work(candidate, change === "stopped" ? "succeeded" : "failed_permanent");
      }
      await waitFor("the unfinished admission to settle without renewed authority", async () => {
        const attempts = await repositoryAttempts(fixture, candidate);
        return attempts.length === 1 && attempts[0].phase === "disposed" ? attempts : undefined;
      });
      assert.ok(lostSessionId);
      assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
      assert.ok(repository.calls.some(({ operation }) => operation === "recover"));
      assert.ok(
        repository.calls.some(
          ({ operation, sessionId }) => operation === "close" && sessionId === lostSessionId,
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
            reasons[change].includes(code),
        ),
      );
      if (change === "revoked") {
        const cleanup = await fixture.observerPool.query(
          `SELECT actor_id FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key LIKE $2`,
          [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
        );
        assert.ok(cleanup.rowCount > 0);
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
    const stopped = [];
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
    assert.equal(attempts[0].phase, "closing");
    const cleanup = await fixture.observerPool.query(
      `SELECT actor_id, state FROM occ.controller_work
       WHERE revision_id = $1 AND idempotency_key LIKE $2`,
      [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
    );
    assert.ok(cleanup.rowCount >= 1);
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
      const deferred = await fixture.observerPool.query(
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
    const prepared = [];
    const stopped = [];
    let unavailable = true;
    const compute = {
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
    repository.driver.resolve = () => ({
      sessionDurationSeconds: 60,
      bindings: repository.snapshot.bindings.map((binding) => ({
        ...binding,
        grant: { ...binding.grant, grantId: "replacement-grant" },
      })),
    });
    const maintenance = await fixture.advanceMaintenance(candidate);
    assert.equal(maintenance.rowCount, 1);
    await fixture.start(compute, { pool: fixture.createWorkerPool() });
    await fixture.work(
      { id: candidate.id, idempotencyKey: maintenance.rows[0].idempotency_key },
      "failed_permanent",
    );
    await waitFor("the old grant's existing session to be disposed", async () => {
      const attempts = await repositoryAttempts(fixture, candidate);
      return attempts.length === 1 && attempts[0].phase === "disposed" ? true : undefined;
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
      const deferred = await fixture.observerPool.query(
        "SELECT state FROM occ.controller_work WHERE idempotency_key LIKE $1 AND state = 'queued'",
        [`agent_revision:${candidate.id}:repository_cleanup:retire:%`],
      );
      return deferred.rowCount === 1 ? true : undefined;
    });
    await fixture.stop();
    const retirement = await fixture.observerPool.query(
      `SELECT idempotency_key, state, actor_id FROM occ.controller_work
       WHERE revision_id = $1 AND idempotency_key LIKE $2`,
      [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
    );
    assert.equal(retirement.rowCount, 1);
    assert.equal(retirement.rows[0].state, "queued");
    assert.equal(retirement.rows[0].actor_id, fixture.actor.id);
    assert.deepEqual(prepared, [candidate.id]);

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
      { id: candidate.id, idempotencyKey: retirement.rows[0].idempotency_key },
      "queued",
    );
    unavailable = false;
    await advanceCleanupRetries(fixture, candidate);
    await fixture.work(
      { id: candidate.id, idempotencyKey: retirement.rows[0].idempotency_key },
      "succeeded",
    );
    assert.ok(stopped.every((id) => id === candidate.id));
    assert.equal(prepared.filter((id) => id === candidate.id).length, 1);
    const active = await fixture.state.read(async (view) => [
      await view.agents.findAgent(fixture.namespace.id, owner.id),
      await view.agents.findAgent(fixture.namespace.id, sibling.id),
    ]);
    assert.deepEqual(
      active.map((agent) => agent.activeRevisionId),
      [newer.id, siblingRevision.id],
    );
    assert.deepEqual(
      (await repositoryAttempts(fixture, candidate)).map(({ phase }) => phase),
      ["disposed"],
    );
    assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
    assert.ok(
      repository.calls.some(
        ({ operation, sessionId }) => operation === "close" && sessionId === original.sessionId,
      ),
    );
    const failure = await fixture.observerPool.query(
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
    const stop = await fixture.requestStop(owner);
    const replacement = {
      ...first,
      id: `rev_${randomUUID()}`,
      revision: 2,
      configuration: { revision: "2" },
      createdAt: new Date().toISOString(),
    };
    delete replacement.idempotencyKey;
    const replacementKey = `agent_revision:${replacement.id}:reconcile`;
    const commitAdmission = Promise.withResolvers();
    const releaseCompute = Promise.withResolvers();
    let locked = false;
    let preparingReplacement = false;
    const stopped = [];
    const events = [];
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
      const backend = await workerPool.query("SELECT pg_backend_pid() AS pid");
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
        { emit: (event) => events.push(event), pool: workerPool },
      );
      await waitFor("the stop worker's real database lock wait", async () => {
        const waiting = await fixture.observerPool.query(
          `SELECT pid FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'
           AND query LIKE '%FROM occ.namespaces%' AND query LIKE '%FOR UPDATE%'
           AND cardinality(pg_blocking_pids(pid)) > 0`,
          [backend.rows[0].pid],
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
          ({ operation, sessionId }) => operation === "close" && sessionId === original.sessionId,
        ),
        false,
      );
      const [retained] = await repositoryAttempts(fixture, first);
      assert.equal(retained.phase, "open");
      assert.equal(retained.sessionId, original.sessionId);
      const current = await fixture.currentAgent(owner);
      assert.equal(current.desiredRuntimeState, "running");
      assert.equal(current.activeRevisionId, first.id);
    } finally {
      commitAdmission.resolve();
      releaseCompute.resolve();
      await admission;
    }
    await fixture.work({ id: replacement.id, idempotencyKey: replacementKey }, "succeeded");
    const current = await fixture.currentAgent(owner);
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
    const releaseCleanup = Promise.withResolvers();
    let firstSession;
    let cleanupWaiting = false;
    let preparations = 0;
    const stopped = [];
    repository.driver.open = async (input, signal) => {
      const result = await open(input, signal);
      if (result.kind === "created" && firstSession === undefined) {
        firstSession = result.session;
      }
      return result;
    };
    repository.driver.close = async (sessionId, signal) => {
      if (sessionId === firstSession?.sessionId && !cleanupWaiting) {
        const source = await fixture.observerPool.query(
          "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
          [candidate.idempotencyKey],
        );
        if (source.rows[0].state === "claimed") {
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
        const [binding] = deploymentContext.repositoryCredentials;
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
    let cleanupKey;
    try {
      await waitFor("the durable cleanup worker to enter its pending close", async () =>
        cleanupWaiting ? true : undefined,
      );
      const before = await repositoryAttempts(fixture, candidate);
      assert.equal(before.length, 2);
      assert.deepEqual(before.map(({ phase }) => phase).sort(), ["closing", "open"]);
      const cleanup = await fixture.observerPool.query(
        `SELECT idempotency_key, state, actor_id, claim_token FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      assert.equal(cleanup.rowCount, 1);
      assert.equal(cleanup.rows[0].state, "claimed");
      assert.equal(cleanup.rows[0].actor_id, fixture.actor.id);
      cleanupKey = cleanup.rows[0].idempotency_key;

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
      await fixture.observerPool.query(
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
      const stillClaimed = await fixture.observerPool.query(
        "SELECT state, claim_token FROM occ.controller_work WHERE idempotency_key = $1",
        [cleanupKey],
      );
      assert.deepEqual(stillClaimed.rows[0], {
        state: "claimed",
        claim_token: cleanup.rows[0].claim_token,
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
    await fixture.work({ id: candidate.id, idempotencyKey: cleanupKey }, "succeeded");
    const cleanup = await fixture.observerPool.query(
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
    const release = Promise.withResolvers();
    const open = repository.driver.open;
    let firstInput;
    let operationSignal;
    let staleSessionId;
    repository.driver.open = async (input, signal) => {
      const result = await open(input, signal);
      if (firstInput === undefined) {
        firstInput = input;
        operationSignal = signal;
        staleSessionId = result.session.sessionId;
        // A remote response can arrive even after cancellation. The worker must
        // fence the successful result, independently of Driver cooperation.
        await release.promise;
      }
      return result;
    };
    const prepared = [];
    let preparations = 0;
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          preparations += 1;
          prepared.push(...deploymentContext.repositoryCredentials);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      { emit: (event) => events.push(event) },
    );
    let recoveryQueue;
    let recovered;
    try {
      await waitFor("the worker to dispatch its first repository admission", async () =>
        firstInput === undefined ? undefined : true,
      );
      const original = await fixture.work(candidate, "claimed");
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
        operationSignal.aborted ? true : undefined,
      );
      assert.deepEqual(prepared, []);
      assert.equal(preparations, 0);
    } finally {
      release.resolve();
    }
    await waitFor("the stale worker to reject the late admission response", async () =>
      events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
    );
    assert.deepEqual(prepared, []);
    assert.equal(preparations, 0);
    const attempts = await repositoryAttempts(fixture, candidate);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].admissionId, firstInput.admissionId);
    assert.equal(attempts[0].phase, "opening");
    assert.equal(attempts[0].sessionId, undefined);
    const unchanged = await fixture.observerPool.query(
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
    const inactive = await fixture.currentAgent(owner);
    assert.equal(inactive.activeRevisionId, undefined);
    await recoveryQueue.retry(recovered, { code: "TEST_RECOVERY_HANDOFF" });
    await fixture.work(candidate, "succeeded");
    assert.equal(prepared.length, 1);
    assert.equal(preparations, 1);
    assert.notEqual(prepared[0].sessionId, staleSessionId);
    assert.equal(
      (await repositoryAttempts(fixture, candidate)).find(
        ({ admissionId }) => admissionId === firstInput.admissionId,
      ).phase,
      "disposed",
    );
  },
);

test(
  "Agent stop clears only the exact active pointer after Compute shutdown and retries safely",
  requiresPostgres,
  async (context) => {
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics });
    const before = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
    const owner = await fixture.agent("stop-target");
    const sibling = await fixture.agent("stop-sibling");
    const targetRevision = await fixture.revision(owner, 1);
    const siblingRevision = await fixture.revision(sibling, 1);
    const stoppedRevisions = [];
    let failStopOnce = true;
    let failedCandidate;
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          const observation = await fixture.compute.prepareRevision(revision);
          return revision.namespaceId === fixture.namespace.id && revision.revision === 2
            ? { ...observation, ready: false }
            : observation;
        },
        async stopRevision(revision) {
          // The real queue can dispatch due work from earlier Namespaces. Keep
          // this failure injection and its ownership assertions in this fixture.
          if (revision.namespaceId !== fixture.namespace.id) {
            return fixture.compute.stopRevision(revision);
          }
          const during = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
          assert.equal(
            during.agents.stopping,
            before.agents.stopping + 1,
            "stop stays in progress until Compute shutdown commits",
          );
          const current = await fixture.currentAgent(owner);
          if (stoppedRevisions.length < 3) {
            assert.equal(
              current.activeRevisionId,
              targetRevision.id,
              "the serving pointer remains until candidate cleanup succeeds",
            );
          }
          if (revision.id === failedCandidate.id && failStopOnce) {
            failStopOnce = false;
            throw new Error("transient Compute stop failure");
          }
          stoppedRevisions.push(revision.id);
        },
      },
      { convergenceTimeoutMs: 50 },
    );
    await Promise.all([
      fixture.work(targetRevision, "succeeded"),
      fixture.work(siblingRevision, "succeeded"),
    ]);

    // The replacement owns resources but never becomes ready. Terminal queue
    // failure must not make it invisible to the real Agent-stop workflow.
    failedCandidate = await fixture.revision(owner, 2);
    await fixture.work(failedCandidate, "failed_permanent");
    const firstStop = await fixture.requestStop(owner);
    const completedStop = await fixture.work(firstStop, "succeeded");
    assert.equal(completedStop.attempt_count, 2);
    // Stop work must retain its own bounded kind and committed retry/success
    // outcomes after integrating stop support with metrics instrumentation. Both
    // are recorded after the stop commits, the attempt outcome last.
    const exposition = await waitFor("the stop's successful attempt metric", async () => {
      const text = await metrics.exposition();
      return /occ_reconciliation_attempts_total\{[^\n]*work_kind="agent_stop"[^\n]*outcome="success"/.test(
        text,
      )
        ? text
        : undefined;
    });
    assert.match(
      exposition,
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="stop"[^\n]*\} 1(?:\n|$)/,
    );
    const after = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
    assert.equal(after.agents.stopped, before.agents.stopped + 1);
    assert.equal(after.agents.running, before.agents.running + 1);
    for (const outcome of ["retry", "success"]) {
      assert.match(
        exposition,
        new RegExp(
          `occ_reconciliation_attempts_total\\{[^\\n]*work_kind="agent_stop"[^\\n]*outcome="${outcome}"[^\\n]*\\} 1(?:\\n|$)`,
        ),
      );
    }
    const [stopped, unaffected, retainedRevision] = await fixture.state.read(async (view) =>
      Promise.all([
        view.agents.findAgent(fixture.namespace.id, owner.id),
        view.agents.findAgent(fixture.namespace.id, sibling.id),
        view.revisions.findRevision(fixture.namespace.id, owner.id, targetRevision.id),
      ]),
    );
    assert.equal(stopped.desiredRuntimeState, "stopped");
    assert.equal(stopped.activeRevisionId, undefined);
    assert.equal(unaffected.activeRevisionId, siblingRevision.id);
    assert.equal(retainedRevision.id, targetRevision.id);
    assert.deepEqual(stoppedRevisions, [targetRevision.id, targetRevision.id, failedCandidate.id]);

    const repeatedStop = await fixture.requestStop(owner);
    await fixture.work(repeatedStop, "succeeded");
    assert.deepEqual(stoppedRevisions, [
      targetRevision.id,
      targetRevision.id,
      failedCandidate.id,
      targetRevision.id,
      failedCandidate.id,
    ]);
    const audit = await fixture.observerPool.query(
      `SELECT action, resource_id, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.stop'
       ORDER BY occurred_at`,
      [fixture.namespace.id],
    );
    assert.deepEqual(audit.rows, [
      {
        action: "openclaw.agents.lifecycle.stop",
        resource_id: owner.id,
        reason_code: "AGENT_STOPPED",
      },
      {
        action: "openclaw.agents.lifecycle.stop",
        resource_id: owner.id,
        reason_code: "AGENT_ALREADY_STOPPED",
      },
    ]);
  },
);

for (const recovery of [false, true]) {
  revisionTest(
    `fresh worker binds SSH ownership before ${recovery ? "stopped revision recovery" : "Agent stop"}`,
    async (fixture) => {
      const owner = await fixture.agent("cold-stop", { auth: "runtime" });
      let candidate = await fixture.revision(owner, 1);
      await fixture.start(fixture.compute);
      await fixture.work(candidate, "succeeded");
      await fixture.stop();
      if (recovery) {
        const previous = candidate;
        candidate = await fixture.revision(owner, 2);
        // A worker can exit after publication but before completing revision work.
        await fixture.state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(
            fixture.namespace.id,
            owner.id,
            previous.id,
            candidate.id,
          ),
        );
      }
      const stop = await fixture.requestStop(owner);
      const operations = [];
      // Exercise the bundled SSH Driver's actual cold binding validation. Only
      // remote SSH execution is controlled; the queue and worker use PostgreSQL.
      const cold = await coldSshComputeDriver(fixture, operations);
      await fixture.start(
        {
          ...fixture.compute,
          bindAgent: cold.bindAgent.bind(cold),
          stopRevision: cold.stopRevision.bind(cold),
          retireRevision: cold.retireRevision.bind(cold),
        },
        { pool: fixture.createWorkerPool() },
      );
      if (recovery) {
        assert.equal((await fixture.work(candidate, "succeeded")).attempt_count, 1);
      }
      assert.equal((await fixture.work(stop, "succeeded")).attempt_count, 1);
      const current = await fixture.currentAgent(owner);
      assert.equal(current.activeRevisionId, undefined);
      assert.equal(current.desiredRuntimeState, "stopped");
      assert.ok(operations.some((op) => op.operation === "stop-revision"));
      assert.ok(
        operations.every(
          (op) => op.namespace.id === fixture.namespace.id && op.revision.agentId === owner.id,
        ),
      );
      if (recovery) {
        assert.ok(operations.some((op) => op.operation === "retire-revision"));
      }
    },
  );
}

revisionTest("fresh worker binds SSH ownership before Agent deletion", async (fixture) => {
  const { owner, candidate } = await fixture.admitInitialRevision("cold-delete", {
    agent: { auth: "runtime" },
  });
  await fixture.start(fixture.compute);
  await fixture.work(candidate, "succeeded");
  await fixture.stop();

  // Deletion is admitted while the Agent is running, then a fresh worker must
  // reconstruct the SSH binding before it can retire the persisted revision.
  await fixture.requestDeletion(owner);
  const operations = [];
  const cold = await coldSshComputeDriver(fixture, operations);
  await fixture.start(
    {
      ...fixture.compute,
      bindAgent: cold.bindAgent.bind(cold),
      retireRevision: cold.retireRevision.bind(cold),
    },
    { pool: fixture.createWorkerPool() },
  );

  await waitFor(`Agent ${owner.id} deletion to complete`, async () => {
    const deleted = await fixture.currentAgent(owner);
    return deleted === undefined ? true : undefined;
  });
  const audit = await fixture.observerPool.query(
    `SELECT (details->>'attemptCount')::integer AS attempt_count
       FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2
         AND action = 'openclaw.agents.lifecycle.delete' AND outcome = 'success'`,
    [fixture.namespace.id, owner.id],
  );
  assert.deepEqual(audit.rows, [{ attempt_count: 1 }]);
  assert.deepEqual(
    operations.map(({ operation }) => operation),
    ["retire-revision"],
  );
  assert.ok(
    operations.every(
      (operation) =>
        operation.namespace.id === fixture.namespace.id && operation.revision.agentId === owner.id,
    ),
  );
});

test(
  "a repository cleanup stuck on an invalidated attempt logs its cause once and backs off",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary({ count: 2 });
    // The production default; the fixture's hour-long interval would hide the backoff.
    repository.driver.maintenanceIntervalMs = 30_000;
    const fixture = await setup(context, { repoDriver: repository.driver });
    const { owner, candidate } = await fixture.admitInitialRevision("cleanup-invalidated", {
      revision: { repositoryCredentials: repository.snapshot },
    });
    const events = [];
    await fixture.start(fixture.compute, { emit: (event) => events.push(event) });
    await fixture.work(candidate, "succeeded");
    const [attempt, sibling] = await repositoryAttempts(fixture, candidate);
    // An invalidated attempt has no outgoing transition, so no pass can settle this cleanup.
    await fixture.observerPool.query(
      `UPDATE occ.repository_session_attempts
       SET phase = 'invalidated', updated_at = clock_timestamp()
       WHERE admission_id = $1`,
      [attempt.admissionId],
    );
    const cleanupKey = `agent_revision:${candidate.id}:repository_cleanup:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.controller_work
         (idempotency_key, namespace_id, agent_id, revision_id, actor_id,
          namespace_target, agent_target, state, available_at, attempt_count, created_at,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'queued',
          clock_timestamp(), 0, clock_timestamp() - interval '1 day', clock_timestamp())`,
      [cleanupKey, fixture.namespace.id, owner.id, candidate.id, fixture.actor.id],
    );
    const deferred = async (passes) =>
      waitFor(`cleanup pass ${passes} to defer`, async () => {
        const completed = events.filter(
          (event) => event.event === "worker.completed" && event.workId === cleanupKey,
        );
        if (completed.length < passes) {
          return undefined;
        }
        const { rows } = await fixture.observerPool.query(
          `SELECT state, EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
           FROM occ.controller_work WHERE idempotency_key = $1`,
          [cleanupKey],
        );
        return rows[0]?.state === "queued" ? rows[0] : undefined;
      });
    // A day-old stuck cleanup rechecks every 10 minutes, not every 30 s.
    const first = await deferred(1);
    assert.ok(Number(first.delay_ms) >= 590_000, `delay ${first.delay_ms} ms`);
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1",
      [cleanupKey],
    );
    await deferred(2);
    // The cause is logged once, not on every recheck.
    assert.deepEqual(
      events
        .filter(
          (event) =>
            event.event === "worker.repository-cleanup-warning" && event.workId === cleanupKey,
        )
        .map(({ code, cause }) => ({ code, cause })),
      [{ code: "REPOSITORY_CLEANUP_STALLED", cause: "REPOSITORY_ATTEMPT_INVALIDATED" }],
    );
    // A session still closing keeps the configured cadence, even next to an invalidated one.
    repository.driver.close = async () => {
      throw new Error("REPOSITORY_BROKER_UNAVAILABLE");
    };
    await fixture.observerPool.query(
      `UPDATE occ.repository_session_attempts
       SET phase = 'closing', updated_at = clock_timestamp()
       WHERE admission_id = $1`,
      [sibling.admissionId],
    );
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1",
      [cleanupKey],
    );
    const closing = await deferred(3);
    assert.ok(Number(closing.delay_ms) < 60_000, `delay ${closing.delay_ms} ms`);
    // Retain the unsettled obligation while keeping it out of later scheduling.
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = 'infinity' WHERE idempotency_key = $1",
      [cleanupKey],
    );
    await fixture.stop();
  },
);

test(
  "Agent deletion completes with unresolved repository sessions retained as evidence",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary({ count: 2 });
    // Release blocked broker calls before setup's worker shutdown hook, including on failure.
    const cleanupBarrier = Promise.withResolvers();
    context.after(() => cleanupBarrier.resolve());
    const fixture = await setup(context, { repoDriver: repository.driver });
    const pendingOwner = await fixture.agent("delete-repository-unresolved");
    const missingOwner = await fixture.agent("delete-repository-missing");
    const pendingRevision = await fixture.revision(pendingOwner, 1, {
      repositoryCredentials: repository.snapshot,
    });
    const missingRevision = await fixture.revision(missingOwner, 1);
    const close = repository.driver.close.bind(repository.driver);
    repository.driver.close = async (...args) => {
      await cleanupBarrier.promise;
      return close(...args);
    };
    await fixture.start(fixture.compute);
    await Promise.all([
      fixture.work(pendingRevision, "succeeded"),
      fixture.work(missingRevision, "succeeded"),
    ]);
    const opened = await repositoryAttempts(fixture, pendingRevision);
    assert.deepEqual(
      opened.map(({ phase, liveRevisionId }) => ({ phase, liveRevisionId })),
      [
        { phase: "open", liveRevisionId: pendingRevision.id },
        { phase: "open", liveRevisionId: pendingRevision.id },
      ],
    );
    await fixture.observerPool.query(
      `UPDATE occ.repository_session_attempts
       SET phase = 'invalidated', updated_at = clock_timestamp()
       WHERE admission_id = $1`,
      [opened[0].admissionId],
    );
    const missingAdmissionId = `missing-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.repository_session_attempts
         (namespace_id, agent_id, revision_id, repository_ref, admission_id,
          duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at,
          broker_protocol)
       VALUES ($1, $2, $3, $4, $5, 60, $6, 'opening', NULL, clock_timestamp(),
          clock_timestamp(), 0)`,
      [
        fixture.namespace.id,
        pendingOwner.id,
        pendingRevision.id,
        repository.snapshot.bindings[0].repositoryRef,
        missingAdmissionId,
        repository.snapshot.deadlineWallMs,
      ],
    );
    await fixture.stop();
    await fixture.requestDeletion(pendingOwner);
    await fixture.requestDeletion(missingOwner);
    const retireCleanupKey = `agent_revision:${pendingRevision.id}:repository_cleanup:retire:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.controller_work
         (idempotency_key, namespace_id, agent_id, revision_id, actor_id,
          namespace_target, agent_target, state, available_at, attempt_count, created_at,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'queued',
          clock_timestamp(), 0, clock_timestamp(), clock_timestamp())`,
      [
        retireCleanupKey,
        fixture.namespace.id,
        pendingOwner.id,
        pendingRevision.id,
        fixture.actor.id,
      ],
    );
    await fixture.start(fixture.compute);
    await waitFor("Agent deletion to finish despite unresolved repository sessions", async () =>
      (await fixture.currentAgent(pendingOwner)) === undefined &&
      (await fixture.currentAgent(missingOwner)) === undefined
        ? true
        : undefined,
    );
    await Promise.all([
      fixture.requestDeletion(pendingOwner).then(
        () => assert.fail("repeated DELETE after completion should not recreate the Agent"),
        (error) => assert.match(error.message, /exact Namespace/),
      ),
      fixture.requestDeletion(missingOwner).then(
        () => assert.fail("repeated DELETE after completion should not recreate the Agent"),
        (error) => assert.match(error.message, /exact Namespace/),
      ),
    ]);

    const retained = await repositoryAttempts(fixture, pendingRevision);
    assert.deepEqual(
      retained.map(({ phase, liveRevisionId, cleanupContext }) => ({
        phase,
        liveRevisionId,
        repositoryRef: cleanupContext.binding.repositoryRef,
      })),
      [
        {
          phase: "invalidated",
          liveRevisionId: null,
          repositoryRef: repository.snapshot.bindings[0].repositoryRef,
        },
        {
          phase: "closing",
          liveRevisionId: null,
          repositoryRef: repository.snapshot.bindings[1].repositoryRef,
        },
        {
          phase: "closing",
          liveRevisionId: null,
          repositoryRef: repository.snapshot.bindings[0].repositoryRef,
        },
      ],
    );
    await waitFor("retained runtime cleanup to claim without live owner", async () => {
      const { rows } = await fixture.observerPool.query(
        `SELECT agent_id, revision_id, state
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [retireCleanupKey],
      );
      return rows[0]?.agent_id === null &&
        rows[0]?.revision_id === null &&
        rows[0]?.state === "claimed"
        ? true
        : undefined;
    });
    assert.equal(
      retained.some(({ phase }) => phase === "disposed"),
      false,
      "deletion must not fabricate disposal for unresolved repository sessions",
    );
    const retainedCounts = await fixture.observerPool.query(
      `SELECT
         (SELECT count(*)::integer FROM occ.repository_session_attempts
          WHERE agent_id = $1) AS attempts,
         (SELECT count(*)::integer FROM occ.agent_revisions
          WHERE agent_id IN ($1, $2)) AS revisions,
         (SELECT count(*)::integer FROM occ.controller_work
          WHERE agent_id IN ($1, $2) OR idempotency_key LIKE $3) AS work`,
      [
        pendingOwner.id,
        missingOwner.id,
        `agent_revision:${pendingRevision.id}:repository_cleanup:%`,
      ],
    );
    assert.deepEqual(retainedCounts.rows, [{ attempts: 3, revisions: 0, work: 2 }]);
    cleanupBarrier.resolve();
    let missing;
    await waitFor("retained repository cleanup to run after Agent deletion", async () => {
      const afterCleanup = await repositoryAttempts(fixture, pendingRevision);
      missing = await fixture.state.read((view) =>
        view.repositorySessions.findAttempt(missingAdmissionId),
      );
      if (
        missing.phase !== "closing" &&
        afterCleanup.some(
          ({ phase, repositoryRef, liveRevisionId }) =>
            repositoryRef === repository.snapshot.bindings[1].repositoryRef &&
            phase === "disposed" &&
            liveRevisionId === null,
        )
      ) {
        return true;
      }
      // Incomplete cleanup defers by the boundary Driver's hourly interval.
      await advanceCleanupRetries(fixture, pendingRevision);
      return undefined;
    });
    assert.equal(missing.phase, "invalidated");
    assert.equal(missing.liveRevisionId, null);
    assert.equal(missing.sessionId, undefined);
  },
);

test(
  "Agent deletion retries teardown, removes owned state, and preserves sibling resources",
  requiresPostgres,
  async (context) => {
    let snapshot;
    const metrics = createOccMetrics("worker", () => snapshot.collect());
    const fixture = await setup(context, { metrics });
    snapshot = new PostgresMetricsSnapshot(fixture.observerPool);
    const owner = await fixture.agent("delete-target");
    const sibling = await fixture.agent("delete-sibling");
    const targetRevision = await fixture.revision(owner, 1);
    const siblingRevision = await fixture.revision(sibling, 1);
    const retiredRevisions = [];
    const deletedCredentialOwners = [];
    let failRetirementOnce = true;
    await fixture.start({
      ...fixture.compute,
      async retireRevision(revision) {
        retiredRevisions.push(revision.id);
        if (revision.id === targetRevision.id && failRetirementOnce) {
          failRetirementOnce = false;
          throw new Error("transient Compute retirement failure");
        }
      },
      async deleteAgentRuntimeCredentials({ agent }) {
        deletedCredentialOwners.push(agent.id);
      },
    });
    await Promise.all([
      fixture.work(targetRevision, "succeeded"),
      fixture.work(siblingRevision, "succeeded"),
    ]);

    // Use an exact Namespace-local role so the binding is realistic and the
    // finalizer must remove it without relying on a foreign-key cascade.
    const revisionRoleId = `role-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        revisionRoleId,
        fixture.namespace.id,
        `Agent revision reader ${randomUUID()}`,
        JSON.stringify([{ action: "read", resourceKind: "agent_revision" }]),
      ],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, $4, 'agent_revision', $5)`,
      [
        `binding-${randomUUID()}`,
        fixture.namespace.id,
        owner.servicePrincipalId,
        revisionRoleId,
        targetRevision.id,
      ],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.apikey
         (id, config_id, reference_id, key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), randomUUID(), owner.servicePrincipalId, randomUUID()],
    );

    await fixture.requestDeletion(owner);
    await waitFor(`Agent ${owner.id} to be removed`, async () => {
      const deleted = await fixture.currentAgent(owner);
      return deleted === undefined ? true : undefined;
    });

    await fixture.stop();
    // Deletion passes have their own work kind and record the committed retry
    // and completion, rather than appearing as Namespace errors.
    const exposition = await metrics.exposition();
    assert.match(
      exposition,
      /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_delete"[^}]*outcome="retry"[^}]*\} 1/,
    );
    assert.match(
      exposition,
      /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_delete"[^}]*outcome="success"[^}]*\} 1/,
    );
    assert.doesNotMatch(exposition, /work_kind="namespace_ensure"[^}]*outcome="error"/);

    const [survivingAgent, survivingRevision, survivingConfiguration] = await fixture.state.read(
      async (view) =>
        Promise.all([
          view.agents.findAgent(fixture.namespace.id, sibling.id),
          view.revisions.findRevision(fixture.namespace.id, sibling.id, siblingRevision.id),
          view.configurations.findConfiguration(fixture.namespace.id, owner.configurationId),
        ]),
    );
    assert.equal(survivingAgent?.activeRevisionId, siblingRevision.id);
    assert.equal(survivingRevision?.id, siblingRevision.id);
    assert.equal(survivingConfiguration?.id, owner.configurationId);
    assert.deepEqual(
      retiredRevisions.filter((id) => id === targetRevision.id),
      [targetRevision.id, targetRevision.id],
    );
    assert.equal(retiredRevisions.includes(siblingRevision.id), false);
    assert.deepEqual(
      deletedCredentialOwners.filter((id) => id === owner.id),
      [owner.id],
    );
    assert.equal(deletedCredentialOwners.includes(sibling.id), false);

    const leftovers = await fixture.observerPool.query(
      `SELECT
         (SELECT count(*)::integer FROM occ.agent_revisions
           WHERE namespace_id = $1 AND agent_id = $2) AS revisions,
         (SELECT count(*)::integer FROM occ.iam_identities WHERE id = $3) AS identities,
         (SELECT count(*)::integer FROM occ.iam_access_bindings
           WHERE identity_subject_id = $3 OR resource_id IN ($2, $4)) AS bindings,
         (SELECT count(*)::integer FROM occ.iam_restrictions
           WHERE resource_id IN ($2, $4)) AS restrictions,
         (SELECT count(*)::integer FROM occ.apikey WHERE reference_id = $3) AS api_keys,
         (SELECT count(*)::integer FROM occ.controller_work
           WHERE namespace_id = $1 AND agent_id = $2) AS work`,
      [fixture.namespace.id, owner.id, owner.servicePrincipalId, targetRevision.id],
    );
    assert.deepEqual(leftovers.rows, [
      { revisions: 0, identities: 0, bindings: 0, restrictions: 0, api_keys: 0, work: 0 },
    ]);
    const audit = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS reason_code,
              (details->>'attemptCount')::integer AS attempt_count
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.delete'
         AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(audit.rows, [
      { outcome: "success", reason_code: "AGENT_DELETED", attempt_count: 2 },
    ]);
  },
);

test(
  "repeating Agent deletion recovers exhausted teardown without resetting an active claim",
  requiresPostgres,
  async (context) => {
    const retirement = Promise.withResolvers();
    context.after(() => retirement.resolve());
    const fixture = await setup(context, { maxAttempts: 1 });
    const owner = await fixture.agent("delete-exhausted");
    const sibling = await fixture.agent("delete-retry-sibling");
    const revision = await fixture.revision(owner, 1);
    const siblingRevision = await fixture.revision(sibling, 1);
    let unavailable = true;
    let retirementAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async retireRevision(target) {
        assert.equal(target.id, revision.id);
        retirementAttempts += 1;
        if (unavailable) {
          throw new Error("Compute temporarily unavailable during teardown");
        }
        await retirement.promise;
      },
    });
    await Promise.all([
      fixture.work(revision, "succeeded"),
      fixture.work(siblingRevision, "succeeded"),
    ]);
    const deletion = await fixture.requestDeletion(owner);
    await fixture.work(deletion, "failed_permanent");
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    const exhausted = await observe();
    assert.equal(exhausted.attemptCount, 1);
    assert.equal(exhausted.reasonCode, "DEPENDENCY_UNAVAILABLE");

    // A rejected caller cannot replenish the worker's attempt budget.
    await assert.rejects(
      fixture.controller.deleteAgent(
        `unprivileged-${randomUUID()}`,
        fixture.namespace.id,
        owner.id,
      ),
    );
    assert.deepEqual(await observe(), exhausted);

    const otherActor = `delete-operator-${randomUUID()}`;
    await fixture.copyActorGrants(otherActor);
    await assert.rejects(
      fixture.controller.deleteAgent(otherActor, fixture.namespace.id, owner.id),
      {
        name: "DeletionRetryOwnedError",
        message: /Only the actor that started this deletion can retry it/,
        initiatingActorId: fixture.actor.id,
        authorization: {
          action: "delete",
          resource: { kind: "agent", id: owner.id, namespaceId: fixture.namespace.id },
        },
      },
    );
    assert.deepEqual(await observe(), exhausted);

    unavailable = false;
    await fixture.requestDeletion(owner);
    const retried = await observe();
    assert.ok(
      ["queued", "claimed"].includes(retried.state),
      "authorized repeated DELETE must requeue the exhausted teardown",
    );
    assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    assert.equal(retried.actorId, exhausted.actorId);
    assert.equal(retried.createdAt.getTime(), exhausted.createdAt.getTime());
    assert.equal(retried.reasonCode, undefined);
    await waitFor("retried teardown to hold a live claim", async () => {
      const work = await observe();
      return work.state === "claimed" && retirementAttempts === 2 ? work : undefined;
    });
    const claimed = await observe();
    await Promise.all([fixture.requestDeletion(owner), fixture.requestDeletion(owner)]);
    const repeated = await observe();
    assert.equal(repeated.state, "claimed");
    assert.equal(repeated.claimToken, claimed.claimToken);
    assert.equal(repeated.attemptCount, claimed.attemptCount);

    retirement.resolve();
    await waitFor("retried deletion to remove its Agent", async () =>
      (await fixture.currentAgent(owner)) === undefined ? true : undefined,
    );
    assert.equal(retirementAttempts, 2);
    assert.equal(await observe(), undefined);
    const surviving = await fixture.currentAgent(sibling);
    assert.equal(surviving.activeRevisionId, siblingRevision.id);
    const { rows: ownedAudit } = await fixture.observerPool.query(
      `SELECT action, actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.equal(
      ownedAudit.filter((event) => event.action === "reconcile" && event.outcome === "failure")
        .length,
      1,
      "retry must retain the original failure evidence",
    );
    assert.deepEqual(
      ownedAudit
        .filter((event) => event.action === "openclaw.agents.delete.retry")
        .map((event) => ({
          actorId: event.actorId,
          outcome: event.outcome,
          details: {
            workId: event.details.workId,
            previousAttemptCount: event.details.previousAttemptCount,
            previousReasonCode: event.details.previousReasonCode,
          },
        })),
      [
        {
          actorId: fixture.actor.id,
          outcome: "success",
          details: {
            workId: deletion.idempotencyKey,
            previousAttemptCount: 1,
            previousReasonCode: "DEPENDENCY_UNAVAILABLE",
          },
        },
      ],
    );
  },
);

test(
  "another authorized actor takes over failed Agent deletion once the initiator loses permission",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 1 });
    const { owner, candidate: revision } = await fixture.admitInitialRevision("delete-takeover");
    let unavailable = true;
    let retirementAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async retireRevision(target) {
        assert.equal(target.id, revision.id);
        retirementAttempts += 1;
        if (unavailable) {
          throw new Error("Compute temporarily unavailable during teardown");
        }
      },
    });
    await fixture.work(revision, "succeeded");
    const deletion = await fixture.requestDeletion(owner);
    await fixture.work(deletion, "failed_permanent");
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    const exhausted = await observe();
    assert.equal(exhausted.actorId, fixture.actor.id);

    const otherActor = `delete-successor-${randomUUID()}`;
    await fixture.copyActorGrants(otherActor);
    // The initiator is offboarded: it no longer holds any access.
    await removeAccessBindings(fixture, fixture.actor.id);
    // A caller without delete permission still cannot take over.
    await assert.rejects(
      fixture.controller.deleteAgent(
        `unprivileged-${randomUUID()}`,
        fixture.namespace.id,
        owner.id,
      ),
    );
    assert.deepEqual(await observe(), exhausted);

    unavailable = false;
    await fixture.controller.deleteAgent(otherActor, fixture.namespace.id, owner.id);
    const retried = await observe();
    assert.ok(
      retried === undefined || ["queued", "claimed"].includes(retried.state),
      "an authorized takeover must requeue the exhausted teardown",
    );
    if (retried !== undefined) {
      assert.equal(retried.actorId, otherActor);
      assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    }
    await waitFor("taken-over deletion to remove its Agent", async () =>
      (await fixture.currentAgent(owner)) === undefined ? true : undefined,
    );
    assert.equal(retirementAttempts, 2);
    const { rows: retryAudit } = await fixture.observerPool.query(
      `SELECT actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2 AND action = 'openclaw.agents.delete.retry'`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(
      retryAudit.map((event) => ({
        actorId: event.actorId,
        outcome: event.outcome,
        takeover: event.details.takeover,
        previousActorId: event.details.previousActorId,
      })),
      [
        {
          actorId: otherActor,
          outcome: "success",
          takeover: true,
          previousActorId: fixture.actor.id,
        },
      ],
    );
  },
);

revisionTest(
  "repeating Namespace deletion recovers a teardown that exceeded its convergence deadline",
  async (fixture) => {
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-exhausted-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    // A stuck finalizer keeps the Namespace terminating past the deadline.
    let terminating = true;
    let deleteAttempts = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async deleteNamespace(target) {
          assert.equal(target.id, namespace.id);
          deleteAttempts += 1;
          return { namespaceId: target.id, namespaceDeleted: !terminating };
        },
      },
      { convergenceTimeoutMs: 1 },
    );
    const deletion = {
      id: namespace.id,
      idempotencyKey: `namespace:${namespace.id}:reconcile:deleted`,
    };
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "failed_permanent");
    const exhausted = await observe();
    assert.equal(exhausted.reasonCode, "CONVERGENCE_DEADLINE_EXCEEDED");
    assert.equal(deleteAttempts, 1);
    const stranded = await fixture.state.read((view) =>
      view.namespaces.findNamespace(namespace.id),
    );
    assert.equal(stranded.status, "deleting");

    // A rejected caller cannot replenish the worker's attempt budget.
    await assert.rejects(
      fixture.controller.deleteNamespace(`unprivileged-${randomUUID()}`, namespace.id),
    );
    assert.deepEqual(await observe(), exhausted);

    // Retrying before the teardown is repaired keeps the original deadline and
    // fails again after one pass instead of looping.
    const repeated = await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    assert.equal(repeated.status, "deleting");
    const retried = await observe();
    assert.ok(
      ["queued", "claimed"].includes(retried.state),
      "authorized repeated DELETE must requeue the failed Namespace teardown",
    );
    assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    assert.equal(retried.actorId, exhausted.actorId);
    assert.equal(retried.reasonCode, undefined);
    await waitFor("unrepaired retry to fail again", async () => {
      const work = await observe();
      return deleteAttempts === 2 && work.state === "failed_permanent" ? work : undefined;
    });

    terminating = false;
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "succeeded");
    assert.equal(deleteAttempts, 3);
    assert.equal(
      await fixture.state.read((view) => view.namespaces.findNamespace(namespace.id)),
      undefined,
    );
    const { rows: retryAudit } = await fixture.observerPool.query(
      `SELECT actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.delete.retry'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      retryAudit.map(({ actorId, outcome, details }) => ({
        actorId,
        outcome,
        workId: details.workId,
        previousReasonCode: details.previousReasonCode,
      })),
      Array.from({ length: 2 }, () => ({
        actorId: fixture.actor.id,
        outcome: "success",
        workId: deletion.idempotencyKey,
        previousReasonCode: "CONVERGENCE_DEADLINE_EXCEEDED",
      })),
    );
  },
);

revisionTest(
  "Namespace teardown audits one pending pass and the terminal pass, not every pass",
  async (fixture) => {
    // D323: each worker pass while Kubernetes namespaces terminated wrote its own
    // lifecycle.delete audit row (38 rows for one deletion).
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-audit-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    let deleteAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async deleteNamespace(target) {
        assert.equal(target.id, namespace.id);
        deleteAttempts += 1;
        return { namespaceId: target.id, namespaceDeleted: deleteAttempts >= 4 };
      },
    });
    const deletion = {
      id: namespace.id,
      idempotencyKey: `namespace:${namespace.id}:reconcile:deleted`,
    };
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "succeeded");
    assert.equal(deleteAttempts, 4);
    const { rows } = await fixture.observerPool.query(
      `SELECT outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.lifecycle.delete'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      rows.map(({ outcome, details }) => ({
        outcome,
        namespaceDeleted: details.namespaceDeleted,
        convergencePending: details.convergencePending,
      })),
      [
        { outcome: "success", namespaceDeleted: false, convergencePending: true },
        { outcome: "success", namespaceDeleted: true, convergencePending: undefined },
      ],
    );
    // The queue's own reconcile evidence follows the same rule: one row for the
    // unchanged waiting state, one for completion.
    const reconcile = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS code FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'reconcile' AND resource_kind = 'namespace'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      reconcile.rows.map(({ outcome, code }) => ({ outcome, code })),
      [
        { outcome: "success", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "success", code: "RECONCILE_SUCCEEDED" },
      ],
    );
  },
);

test(
  "a failed Namespace logs the Compute refusal reason while status and audit keep only the failure",
  requiresPostgres,
  async (context) => {
    // D521: a refused existing-namespace selection ended `failed` with no reason anywhere.
    const fixture = await setup(context);
    const reason =
      "Existing Kubernetes namespace customer-support belongs to another tenant: its openclaw.dev/namespace label names a different Namespace.";
    const timedOut = "Kubernetes API request timed out.";
    const results = [
      { failure: "retryable", reason: timedOut },
      // Only a failed pass keeps a reason, and only bounded printable text: the worker drops
      // the rest itself, before the logger sees it.
      { reason: timedOut },
      { failure: "retryable", reason: "line\nbreak" },
      { failure: "retryable", reason: "x".repeat(257) },
      { failure: "permanent", reason },
    ];
    let attempts = 0;
    let deletes = 0;
    const output = [];
    const events = [];
    const logger = createWorkerLogEmitter(
      createOccLogger({
        component: "occ-worker",
        destination: {
          write(chunk) {
            for (const line of String(chunk).split("\n")) {
              if (line.length > 0) {
                output.push(JSON.parse(line));
              }
            }
            return true;
          },
        },
      }),
    );
    const log = (event) => {
      events.push(event);
      logger(event);
    };
    await fixture.start(
      {
        ...fixture.compute,
        async deleteNamespace(target) {
          deletes += 1;
          return deletes === 1
            ? {
                namespaceId: target.id,
                namespaceDeleted: false,
                failure: "retryable",
                reason: timedOut,
              }
            : { namespaceId: target.id, namespaceDeleted: true };
        },
        async ensureNamespace(target) {
          const result = results[Math.min(attempts, results.length - 1)];
          attempts += 1;
          return { namespaceId: target.id, namespaceReady: false, ...result };
        },
      },
      { emit: log },
    );
    const namespace = await fixture.controller.createNamespace(fixture.actor.id, {
      name: `refused-${randomUUID()}`,
    });
    assert.equal(namespace.status, "provisioning");
    await fixture.work(
      { id: namespace.id, idempotencyKey: `namespace:${namespace.id}:reconcile:ready` },
      "failed_permanent",
      // The retries back off, under 10 s in all; the pending pass uses no attempt.
      40_000,
    );
    const ensured = (lines) =>
      lines.filter(
        (line) =>
          line.event === "worker.completed" &&
          line.namespaceId === namespace.id &&
          line.operation === "namespace.ensure",
      );
    const completed = await waitFor("every logged Namespace pass", async () =>
      ensured(output).length === results.length ? ensured(output) : undefined,
    );
    const passes = [
      ["retry", timedOut],
      ["pending", undefined],
      ["retry", undefined],
      ["retry", undefined],
      ["permanent", reason],
    ];
    assert.deepEqual(
      completed.map(({ outcome, code, reason }) => [outcome, code, reason]),
      passes.map(([outcome, reason]) => [outcome, "NAMESPACE_INCOMPLETE", reason]),
    );
    // The worker's own events already lack the dropped reasons.
    assert.deepEqual(
      ensured(events).map((event) => event.reason),
      passes.map(([, reason]) => reason),
    );
    const failed = await fixture.state.read((view) => view.namespaces.findNamespace(namespace.id));
    assert.equal(failed.status, "failed");
    // The reason stays in the operator log: the Namespace and its audit events carry none.
    assert.equal(JSON.stringify(failed).includes("another tenant"), false);
    const { rows } = await fixture.observerPool.query(
      `SELECT details FROM occ.audit_events WHERE namespace_id = $1`,
      [namespace.id],
    );
    assert.ok(rows.length > 0);
    assert.equal(JSON.stringify(rows).includes("another tenant"), false);
    assert.equal(JSON.stringify(rows).includes("timed out"), false);
    // A delete pass logs no reason, even when its Driver returns one.
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(
      { id: namespace.id, idempotencyKey: `namespace:${namespace.id}:reconcile:deleted` },
      "succeeded",
    );
    const deleted = await waitFor("both Namespace delete passes", async () => {
      const passes = events.filter(
        (event) =>
          event.event === "worker.completed" &&
          event.namespaceId === namespace.id &&
          event.operation === "namespace.delete",
      );
      return passes.length === 2 ? passes : undefined;
    });
    assert.deepEqual(
      deleted.map((event) => Object.hasOwn(event, "reason")),
      [false, false],
    );
  },
);

revisionTest(
  "Namespace teardown records the same waiting state again after a retry in between",
  async (fixture) => {
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-retry-audit-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    let deleteAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async deleteNamespace(target) {
        deleteAttempts += 1;
        // waiting, waiting, retryable failure, waiting, waiting, deleted
        return deleteAttempts === 3
          ? { namespaceId: target.id, namespaceDeleted: false, failure: "retryable" }
          : { namespaceId: target.id, namespaceDeleted: deleteAttempts >= 6 };
      },
    });
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(
      { id: namespace.id, idempotencyKey: `namespace:${namespace.id}:reconcile:deleted` },
      "succeeded",
    );
    assert.equal(deleteAttempts, 6);
    const { rows } = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS code FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'reconcile' AND resource_kind = 'namespace'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      rows.map(({ outcome, code }) => ({ outcome, code })),
      [
        { outcome: "success", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "failure", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "success", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "success", code: "RECONCILE_SUCCEEDED" },
      ],
    );
  },
);

revisionTest(
  "another authorized actor takes over failed Namespace deletion once the initiator loses permission",
  async (fixture) => {
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-takeover-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    // A stuck finalizer keeps the Namespace terminating past the deadline.
    let terminating = true;
    let deleteAttempts = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async deleteNamespace(target) {
          assert.equal(target.id, namespace.id);
          deleteAttempts += 1;
          return { namespaceId: target.id, namespaceDeleted: !terminating };
        },
      },
      { convergenceTimeoutMs: 1 },
    );
    const deletion = {
      id: namespace.id,
      idempotencyKey: `namespace:${namespace.id}:reconcile:deleted`,
    };
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "failed_permanent");
    const exhausted = await observe();
    assert.equal(exhausted.actorId, fixture.actor.id);

    const otherActor = `delete-successor-${randomUUID()}`;
    await fixture.copyActorGrants(otherActor);
    // While the initiator still holds delete permission, it keeps ownership.
    await assert.rejects(fixture.controller.deleteNamespace(otherActor, namespace.id), {
      name: "DeletionRetryOwnedError",
      message: /Only the actor that started this deletion can retry it/,
      initiatingActorId: fixture.actor.id,
      authorization: {
        action: "delete",
        resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
      },
    });
    assert.deepEqual(await observe(), exhausted);

    // The initiator is offboarded: it no longer holds any access.
    await removeAccessBindings(fixture, fixture.actor.id);
    // A caller without delete permission still cannot take over.
    await assert.rejects(
      fixture.controller.deleteNamespace(`unprivileged-${randomUUID()}`, namespace.id),
    );
    assert.deepEqual(await observe(), exhausted);

    terminating = false;
    const repeated = await fixture.controller.deleteNamespace(otherActor, namespace.id);
    assert.equal(repeated.status, "deleting");
    const retried = await observe();
    assert.ok(
      retried === undefined || ["queued", "claimed", "succeeded"].includes(retried.state),
      "an authorized takeover must requeue the exhausted teardown",
    );
    if (retried !== undefined) {
      assert.equal(retried.actorId, otherActor);
      assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    }
    // Namespace policy left at teardown is removed with the tombstone and audited.
    const policyRole = `role-${randomUUID()}`;
    const policyBinding = `binding-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, NULL, '[{"action":"read","resourceKind":"namespace"}]'::jsonb)`,
      [policyRole, namespace.id],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, $4, 'namespace', $2)`,
      [policyBinding, namespace.id, otherActor, policyRole],
    );
    await fixture.work(deletion, "succeeded");
    assert.equal(deleteAttempts, 2);
    assert.equal(
      await fixture.state.read((view) => view.namespaces.findNamespace(namespace.id)),
      undefined,
    );
    const { rows: leftover } = await fixture.observerPool.query(
      `SELECT (SELECT count(*) FROM occ.iam_roles WHERE namespace_id = $1)::int AS roles,
              (SELECT count(*) FROM occ.iam_access_bindings WHERE namespace_id = $1)::int AS bindings`,
      [namespace.id],
    );
    assert.deepEqual(leftover, [{ roles: 0, bindings: 0 }]);
    const { rows: teardownAudit } = await fixture.observerPool.query(
      `SELECT details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.lifecycle.delete'
         AND outcome = 'success'`,
      [namespace.id],
    );
    assert.equal(teardownAudit.length, 1);
    assert.ok(teardownAudit[0].details.removedRoleIds.includes(policyRole));
    assert.ok(
      teardownAudit[0].details.removedAccessBindings.some(
        (binding) => binding.id === policyBinding && binding.subjectId === otherActor,
      ),
    );
    const { rows: retryAudit } = await fixture.observerPool.query(
      `SELECT actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.delete.retry'`,
      [namespace.id],
    );
    assert.deepEqual(
      retryAudit.map(({ actorId, outcome, details }) => ({
        actorId,
        outcome,
        takeover: details.takeover,
        previousActorId: details.previousActorId,
      })),
      [
        {
          actorId: otherActor,
          outcome: "success",
          takeover: true,
          previousActorId: fixture.actor.id,
        },
      ],
    );
  },
);

test(
  "Agent deletion fails closed when a credential-provisioning Driver cannot delete credentials",
  requiresPostgres,
  async (context) => {
    let snapshot;
    const metrics = createOccMetrics("worker", () => snapshot.collect());
    const fixture = await setup(context, { metrics });
    snapshot = new PostgresMetricsSnapshot(fixture.observerPool);
    const owner = await fixture.agent("delete-credentials-unsupported");
    const before = await snapshot.collect();
    const deletion = await fixture.requestDeletion(owner);
    // Even a draft enters teardown while deletion is queued. Failed cleanup
    // retains the Agent and must remain visible as a failed lifecycle.
    const pending = await snapshot.collect();
    assert.equal(pending.agents.draft, before.agents.draft - 1);
    assert.equal(pending.agents.stopping, before.agents.stopping + 1);
    await fixture.start({
      ...fixture.compute,
      async provisionAgentRuntimeCredentials() {},
    });

    const failed = await fixture.work(deletion, "failed_permanent");
    assert.equal(failed.attempt_count, 1);
    await fixture.stop();
    const after = await snapshot.collect();
    assert.equal(after.agents.failed, before.agents.failed + 1);
    assert.equal(after.agents.draft, before.agents.draft - 1);
    assert.match(
      await metrics.exposition(),
      /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_delete"[^}]*outcome="permanent"[^}]*\} 1/,
    );
    const retained = await fixture.currentAgent(owner);
    assert.equal(retained?.status, "deleting");
    assert.equal(retained?.desiredRuntimeState, "stopped");
    const audit = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.delete'
         AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(audit.rows, [
      { outcome: "failure", reason_code: "CREDENTIAL_DELETION_UNSUPPORTED" },
    ]);
  },
);

revisionTest(
  "Agent deletion finalization rejects an expired lease without removing state",
  async (fixture) => {
    const owner = await fixture.agent("delete-expired-lease");
    const deletion = await fixture.requestDeletion(owner);
    const claimToken = randomUUID();
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET state = 'claimed', claim_token = $1, lease_expires_at = now() - interval '1 second',
           attempt_count = 1, updated_at = now()
       WHERE idempotency_key = $2`,
      [claimToken, deletion.idempotencyKey],
    );
    const queue = new fixture.PostgresWorkQueue(fixture.workerPool);

    await assert.rejects(
      queue.completeAgentDeletion(
        { idempotencyKey: deletion.idempotencyKey, claimToken },
        fixture.namespace.id,
        owner.id,
      ),
      { name: "WorkClaimLostError" },
    );
    const [retained, revisions, identity, work] = await Promise.all([
      fixture.currentAgent(owner),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE agent_id = $1",
        [owner.id],
      ),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.iam_identities WHERE id = $1",
        [owner.servicePrincipalId],
      ),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.controller_work WHERE idempotency_key = $1",
        [deletion.idempotencyKey],
      ),
    ]);
    assert.equal(retained?.status, "deleting");
    assert.deepEqual(revisions.rows, [{ count: 0 }]);
    assert.deepEqual(identity.rows, [{ count: 1 }]);
    assert.deepEqual(work.rows, [{ count: 1 }]);
    // Keep this deliberately expired fixture from being recovered by a later
    // worker test; the assertions above already proved the live product path.
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET state = 'failed_permanent', claim_token = NULL, lease_expires_at = NULL,
           completed_at = now(), reason_code = 'EXPIRED_LEASE_TEST_CLEANUP',
           result_data = NULL, updated_at = now()
       WHERE idempotency_key = $1`,
      [deletion.idempotencyKey],
    );
  },
);

revisionTest(
  "deleting the last Agent releases its Namespace for ordinary offboarding",
  async (fixture) => {
    const owner = await fixture.agent("last-agent");
    await fixture.start(fixture.compute);

    await fixture.requestDeletion(owner);
    await waitFor(`last Agent ${owner.id} to be removed`, async () => {
      const deleted = await fixture.currentAgent(owner);
      return deleted === undefined ? true : undefined;
    });

    // Agent deletion preserves Namespace-owned inputs. Remove the surviving
    // harness Secret through the production controller before offboarding.
    assert.equal(owner.harnessAuth.method, "api_key");
    await fixture.controller.deleteSecret(
      fixture.actor.id,
      fixture.namespace.id,
      owner.harnessAuth.source.id,
    );
    await fixture.state.transactWithQueue(async (unit, queue) => {
      assert.equal(await unit.namespaces.hasAgents(fixture.namespace.id), false);
      assert.equal(
        await unit.configurations.deleteConfiguration(fixture.namespace.id, owner.configurationId),
        true,
      );
      const deleting = await unit.namespaces.transitionNamespaceStatus(
        fixture.namespace.id,
        "ready",
        "deleting",
      );
      assert.ok(deleting);
      await queue.enqueue({
        idempotencyKey: `namespace:${fixture.namespace.id}:reconcile:deleted`,
        namespaceId: fixture.namespace.id,
        namespaceTarget: "deleted",
        actorId: fixture.actor.id,
        availableAt: new Date(0),
      });
    });
    await waitFor(`Namespace ${fixture.namespace.id} to be tombstoned`, async () => {
      const namespace = await fixture.state.read((view) =>
        view.namespaces.findNamespace(fixture.namespace.id),
      );
      return namespace === undefined ? true : undefined;
    });
  },
);

revisionTest(
  "the application role can finalize Agent deletion without direct table deletion grants",
  async (fixture) => {
    const privileges = await fixture.observerPool.query(
      `SELECT
         has_table_privilege(current_user, 'occ.agents', 'DELETE') AS delete_agent,
         has_table_privilege(current_user, 'occ.agent_revisions', 'DELETE') AS delete_revision,
         has_table_privilege(current_user, 'occ.iam_identities', 'DELETE') AS delete_identity,
         has_function_privilege(
           current_user,
           'occ.finalize_agent_deletion(text,text,text,uuid)',
           'EXECUTE'
         ) AS execute_finalizer,
         EXISTS (
           SELECT 1
           FROM information_schema.routine_privileges
           WHERE routine_schema = 'occ'
             AND routine_name = 'finalize_agent_deletion'
             AND grantee = 'PUBLIC'
             AND privilege_type = 'EXECUTE'
         ) AS public_execute`,
    );
    assert.deepEqual(privileges.rows, [
      {
        delete_agent: false,
        delete_revision: false,
        delete_identity: false,
        execute_finalizer: true,
        public_execute: false,
      },
    ]);
  },
);

test(
  "a deployment admitted after stop supersedes stale stop work before Compute mutation",
  requiresPostgres,
  async (context) => {
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics });
    const { owner, candidate: first } = await fixture.admitInitialRevision("stop-then-deploy");
    const stoppedRevisions = [];
    let releaseStopAuthorization;
    const stopAuthorizationReleased = new Promise((resolve) => {
      releaseStopAuthorization = resolve;
    });
    let stopAuthorizationStarted;
    const stopAuthorizationObserved = new Promise((resolve) => {
      stopAuthorizationStarted = resolve;
    });
    const compute = {
      ...fixture.compute,
      async stopRevision(candidate) {
        stoppedRevisions.push(candidate.id);
      },
    };
    await fixture.start(compute, {
      pool: fixture.workerPool,
      transformDrivers: (drivers) => {
        const createIAMDriver = drivers.createIAMDriver;
        return {
          ...drivers,
          createIAMDriver(state) {
            const iam = createIAMDriver(state);
            return {
              id: iam.id,
              implementation: iam.implementation,
              capability: iam.capability,
              lookupIdentity: iam.lookupIdentity.bind(iam),
              async authorize(request) {
                if (
                  request.action === "operate" &&
                  request.resource.kind === "agent" &&
                  request.resource.id === owner.id
                ) {
                  stopAuthorizationStarted();
                  await stopAuthorizationReleased;
                }
                return iam.authorize(request);
              },
            };
          },
        };
      },
    });
    await fixture.work(first, "succeeded");

    const stop = await fixture.requestStop(owner);
    await stopAuthorizationObserved;
    // This later admission changes intent while stop is inside its required IAM check.
    const second = await fixture.revision(owner, 2);
    releaseStopAuthorization();

    await Promise.all([fixture.work(stop, "succeeded"), fixture.work(second, "succeeded")]);
    const running = await fixture.currentAgent(owner);
    assert.equal(running.desiredRuntimeState, "running");
    assert.equal(running.activeRevisionId, second.id);
    assert.deepEqual(stoppedRevisions, []);
    assert.match(
      await metrics.exposition(),
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="stop"[^\n]*\} 0(?:\n|$)/,
    );
    const audit = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.stop'
         AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(audit.rows, [{ reason_code: "STOP_SUPERSEDED" }]);
  },
);

revisionTest(
  "Agent stop cleans a terminal candidate without an active revision",
  async (fixture) => {
    const { owner, candidate } = await fixture.admitInitialRevision("stop-initial-failure");
    const stopped = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return { ...(await fixture.compute.prepareRevision(revision)), ready: false };
        },
        async stopRevision(revision) {
          // The shared queue can also dispatch another fixture's durable cleanup.
          if (revision.namespaceId === fixture.namespace.id) {
            stopped.push(revision.id);
          }
          return fixture.compute.stopRevision(revision);
        },
      },
      { convergenceTimeoutMs: 50 },
    );
    await fixture.work(candidate, "failed_permanent");
    // Historical records from another selected Compute are not cleanup inputs
    // for this worker, even when the Agent has no active pointer.
    await fixture.state.transact((unit) =>
      unit.revisions.createRevision({
        ...candidate,
        id: `rev_${randomUUID()}`,
        revision: 2,
        compute: { id: "retired-compute", implementation: "retired-compute" },
      }),
    );
    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    assert.deepEqual(stopped, [candidate.id]);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.desiredRuntimeState, "stopped");
    assert.equal(current.activeRevisionId, undefined);
  },
);

for (const admissionDuring of ["active", "candidate"]) {
  revisionTest(
    `a deployment during ${admissionDuring} cleanup supersedes the remaining Agent stop effects`,
    async (fixture) => {
      const { owner, candidate: active } = await fixture.admitInitialRevision(
        `stop-race-${admissionDuring}`,
      );
      const stopped = [];
      let candidate;
      let newer;
      let activeWhenNewerPrepared;
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision) {
            if (revision.revision === 3) {
              const current = await fixture.currentAgent(owner);
              activeWhenNewerPrepared = current.activeRevisionId;
            }
            return {
              ...(await fixture.compute.prepareRevision(revision)),
              ready: revision.revision !== 2,
            };
          },
          async stopRevision(revision) {
            // The shared queue can also dispatch another fixture's durable cleanup.
            if (revision.namespaceId !== fixture.namespace.id) {
              return fixture.compute.stopRevision(revision);
            }
            stopped.push(revision.id);
            if (revision.id === (admissionDuring === "active" ? active.id : candidate.id)) {
              // Admission changes desired state during an exact cleanup call. The
              // old pointer must survive both the next-effect and final-CAS fences.
              newer = await fixture.revision(owner, 3);
            }
          },
        },
        { convergenceTimeoutMs: 50 },
      );
      await fixture.work(active, "succeeded");
      candidate = await fixture.revision(owner, 2);
      await fixture.work(candidate, "failed_permanent");
      const stop = await fixture.requestStop(owner);
      await fixture.work(stop, "succeeded");
      assert.ok(newer);
      await fixture.work(newer, "succeeded");
      assert.deepEqual(
        stopped,
        admissionDuring === "active" ? [active.id] : [active.id, candidate.id],
      );
      assert.equal(
        activeWhenNewerPrepared,
        active.id,
        "stale stop must not clear the serving pointer after a later admission",
      );
      const current = await fixture.currentAgent(owner);
      assert.equal(current.desiredRuntimeState, "running");
      assert.equal(current.activeRevisionId, newer.id);
    },
  );
}

for (const { operation, action } of [
  { operation: "stop", action: "operate" },
  { operation: "delete", action: "delete" },
]) {
  test(
    `Agent ${operation} reauthorizes the recorded actor before Compute mutation`,
    requiresPostgres,
    async (context) => {
      const metrics = createOccMetrics("worker", () =>
        new PostgresMetricsSnapshot(fixture.observerPool).collect(),
      );
      const fixture = await setup(context, { metrics });
      const before = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
      const { owner, candidate: revision } = await fixture.admitInitialRevision(
        `${operation}-reauthorization`,
      );
      const effects = [];
      const compute = {
        ...fixture.compute,
        async stopRevision(candidate) {
          effects.push({ action: "stop", agentId: candidate.agentId });
        },
        async retireRevision(candidate) {
          effects.push({ action: "retire", agentId: candidate.agentId });
        },
        async deleteAgentRuntimeCredentials({ agent }) {
          effects.push({ action: "credentials", agentId: agent.id });
        },
      };
      await fixture.start(compute);
      await fixture.work(revision, "succeeded");

      await fixture.stop();
      const work = await (operation === "stop"
        ? fixture.requestStop(owner)
        : fixture.requestDeletion(owner));
      // Admission was authorized; revoke before restarting the worker to prove
      // dispatch independently rechecks the recorded actor's permission.
      await fixture.observerPool.query(
        `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, $3, 'agent', $4, 'deny')`,
        [`restriction-${randomUUID()}`, fixture.namespace.id, action, owner.id],
      );
      await fixture.start(compute, { pool: fixture.createWorkerPool() });
      assert.equal((await fixture.work(work, "failed_permanent")).attempt_count, 1);
      if (operation === "stop") {
        assert.equal(
          (await new PostgresMetricsSnapshot(fixture.observerPool).collect()).agents.failed,
          before.agents.failed + 1,
        );
        assert.match(
          await metrics.exposition(),
          /occ_agent_operation_duration_seconds_count\{[^\n]*operation="stop"[^\n]*\} 0(?:\n|$)/,
        );
      }

      // The shared queue can also dispatch another fixture's durable cleanup.
      assert.deepEqual(
        effects.filter(({ agentId }) => agentId === owner.id),
        [],
      );
      const current = await fixture.currentAgent(owner);
      assert.equal(current.activeRevisionId, revision.id);
      assert.equal(current.desiredRuntimeState, "stopped");
      assert.equal(current.status, operation === "delete" ? "deleting" : "active");
      const audit = await fixture.observerPool.query(
        `SELECT kind, action, outcome,
              details->'__occAuditMetadata'->'authorization' AS authorization,
              details->'__occAuditMetadata'->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2
         AND kind = 'authorization_denial'`,
        [fixture.namespace.id, owner.id],
      );
      assert.deepEqual(audit.rows, [
        {
          kind: "authorization_denial",
          action: `openclaw.agents.${operation}`,
          outcome: "denied",
          authorization: {
            principalId: fixture.actor.id,
            action,
            resource: { kind: "agent", id: owner.id, namespaceId: fixture.namespace.id },
          },
          reason_code: "AUTHORIZATION_DENIED",
        },
      ]);
    },
  );
}

revisionTest(
  "active revision maintenance defers shutdown to the separately authorized Agent stop work",
  async (fixture, context) => {
    const { owner, candidate: revision } = await fixture.admitInitialRevision(
      "stop-maintenance-authorization",
    );
    await fixture.start(fixture.compute);
    await fixture.work(revision, "succeeded");
    await fixture.stop();

    // The shared queue can also deliver an independently authorized stop from
    // another Namespace while this Namespace denies its own Agent's shutdown.
    const neighbor = await setup(context, { database: fixture.database });
    const neighborOwner = await neighbor.agent("authorized-neighbor-stop");
    const neighborRevision = await neighbor.revision(neighborOwner, 1);
    await neighbor.start(neighbor.compute);
    await neighbor.work(neighborRevision, "succeeded");
    await neighbor.stop();
    const neighborStop = await neighbor.requestStop(neighborOwner);

    const maintenance = {
      id: revision.id,
      idempotencyKey: `agent_revision:${revision.id}:maintenance:${randomUUID()}`,
    };
    await fixture.state.transactWithQueue((_unit, queue) =>
      queue.enqueue({
        idempotencyKey: maintenance.idempotencyKey,
        namespaceId: fixture.namespace.id,
        agentId: owner.id,
        revisionId: revision.id,
        actorId: fixture.actor.id,
        availableAt: new Date(0),
      }),
    );
    const stop = await fixture.requestStop(owner);

    // Maintenance may observe stopped intent first, but only the Agent-stop claim
    // may perform shutdown after reauthorizing its recorded actor.
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'operate', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
    );
    const stoppedRevisions = [];
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async stopRevision(candidate) {
          if (candidate.namespaceId === fixture.namespace.id) {
            stoppedRevisions.push(candidate.id);
          }
          return fixture.compute.stopRevision(candidate);
        },
      },
      { emit: (event) => events.push(event), pool: fixture.createWorkerPool() },
    );

    await fixture.work(maintenance, "succeeded");
    await fixture.work(stop, "failed_permanent");
    await neighbor.work(neighborStop, "succeeded");
    assert.deepEqual(stoppedRevisions, []);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.activeRevisionId, revision.id);
    assert.equal(current.desiredRuntimeState, "stopped");
    await completion(
      events,
      "the maintenance's REVISION_MAINTENANCE_SUPERSEDED completion",
      ({ event, code, revisionId }) =>
        event === "worker.completed" &&
        code === "REVISION_MAINTENANCE_SUPERSEDED" &&
        revisionId === revision.id,
    );
  },
);

revisionTest(
  "a stop accepted during revision preparation prevents the candidate from becoming active",
  async (fixture, context) => {
    const owner = await fixture.agent("stop-prepare-race");
    // Other Namespaces share this worker's queue. Their durable stop work must
    // drain without changing this candidate's preparation gate or observations.
    const foreign = await setup(context, { database: fixture.database });
    const foreignOwner = await foreign.agent("stop-prepare-foreign");
    const foreignRevision = await foreign.revision(foreignOwner, 1);
    const foreignStop = await foreign.requestStop(foreignOwner);
    const candidate = await fixture.revision(owner, 1);
    let releasePreparation;
    const preparationReleased = new Promise((resolve) => {
      releasePreparation = resolve;
    });
    let preparationStarted = false;
    const stoppedRevisions = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        if (revision.namespaceId === fixture.namespace.id) {
          preparationStarted = true;
          await preparationReleased;
        }
        return fixture.compute.prepareRevision(revision);
      },
      async stopRevision(revision) {
        if (revision.namespaceId === fixture.namespace.id) {
          stoppedRevisions.push(revision.id);
        }
        return fixture.compute.stopRevision(revision);
      },
    });
    await waitFor("revision preparation to start", async () =>
      preparationStarted ? true : undefined,
    );

    const stop = await fixture.requestStop(owner);
    releasePreparation();
    await fixture.work(candidate, "succeeded");
    await fixture.work(stop, "succeeded");
    await foreign.work(foreignRevision, "succeeded");
    await foreign.work(foreignStop, "succeeded");

    const stopped = await fixture.currentAgent(owner);
    assert.equal(stopped.activeRevisionId, undefined);
    assert.equal(stopped.desiredRuntimeState, "stopped");
    // Both the interrupted revision and Agent-stop owner perform exact,
    // idempotent cleanup; neither may activate the candidate.
    assert.deepEqual(stoppedRevisions, [candidate.id, candidate.id]);
    const activation = await fixture.observerPool.query(
      `SELECT id FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.activate'
         AND resource_id = $2`,
      [fixture.namespace.id, candidate.id],
    );
    assert.deepEqual(activation.rows, []);
    // The deployment did not activate, and its error says why instead of a generic failure.
    const status = await fixture.deploymentStatus(owner, candidate);
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "REVISION_STOPPED",
      message: "Deployment ended because the Agent was stopped.",
    });
  },
);

revisionTest(
  "a stop committed after the last running check never publishes the candidate",
  async (fixture) => {
    const { owner, candidate: predecessor } =
      await fixture.admitInitialRevision("stop-before-publication");
    await fixture.start(fixture.compute);
    await fixture.work(predecessor, "succeeded");
    await fixture.stop();

    // A before-commit Driver activates the candidate after the worker's last check
    // that the Agent runs. A stop admitted then is seen only when publication locks
    // the Agent: the candidate must stay unpublished, and the predecessor is left
    // to the stop instead of being retired by a candidate that never served.
    const candidate = await fixture.revision(owner, 2);
    let releaseActivation;
    const activationReleased = new Promise((resolve) => {
      releaseActivation = resolve;
    });
    let activationStarted = false;
    const stoppedRevisions = [];
    const retiredRevisions = [];
    await fixture.start({
      ...fixture.compute,
      activationOrder: "beforeCommit",
      async activateRevision(revision) {
        if (revision.id === candidate.id) {
          activationStarted = true;
          await activationReleased;
        }
      },
      async stopRevision(revision) {
        stoppedRevisions.push(revision.id);
        return fixture.compute.stopRevision(revision);
      },
      async retireRevision(revision) {
        retiredRevisions.push(revision.id);
        return fixture.compute.retireRevision(revision);
      },
    });
    await waitFor("candidate activation to start", async () =>
      activationStarted ? true : undefined,
    );

    let stop;
    try {
      stop = await fixture.requestStop(owner);
    } finally {
      releaseActivation();
    }
    await fixture.work(candidate, "succeeded");
    await fixture.work(stop, "succeeded");

    const stopped = await fixture.currentAgent(owner);
    assert.equal(stopped.desiredRuntimeState, "stopped");
    assert.equal(stopped.activeRevisionId, undefined);
    // The candidate stops itself. The stop work then stops the still-serving predecessor
    // first and cleans up the candidate after it.
    assert.deepEqual(stoppedRevisions, [candidate.id, predecessor.id, candidate.id]);
    assert.deepEqual(retiredRevisions, []);
    const status = await fixture.deploymentStatus(owner, candidate);
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "REVISION_STOPPED",
      message: "Deployment ended because the Agent was stopped.",
    });
  },
);

revisionTest(
  "a stop admitted immediately after publication retires the predecessor before completion",
  async (fixture, context) => {
    const { owner, candidate: predecessor } =
      await fixture.admitInitialRevision("stop-publication-race");
    await fixture.start(fixture.compute);
    await fixture.work(predecessor, "succeeded");
    await fixture.stop();

    // This worker must drain another Namespace's real stop work without adding
    // its effects to this Agent's observations or consuming its injected fault.
    const foreign = await setup(context, { database: fixture.database });
    const foreignOwner = await foreign.agent("stop-publication-foreign");
    const foreignRevision = await foreign.revision(foreignOwner, 1);
    const foreignStop = await foreign.requestStop(foreignOwner);

    const replacement = await fixture.revision(owner, 2);
    await fixture.compute.prepareRevision(replacement);
    // Recreate the committed publication boundary before route finalization. Stop
    // admission can observe this exact durable state while revision work remains.
    const published = await fixture.state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(
        fixture.namespace.id,
        owner.id,
        predecessor.id,
        replacement.id,
      ),
    );
    assert.equal(published.activeRevisionId, replacement.id);
    const stop = await fixture.requestStop(owner);

    const stoppedRevisions = [];
    const retiredRevisions = [];
    let failRetirement = true;
    await fixture.start(
      {
        ...fixture.compute,
        async stopRevision(candidate) {
          if (candidate.namespaceId !== fixture.namespace.id) {
            return fixture.compute.stopRevision(candidate);
          }
          stoppedRevisions.push(candidate.id);
          return fixture.compute.stopRevision(candidate);
        },
        async retireRevision(candidate) {
          if (candidate.namespaceId !== fixture.namespace.id) {
            return fixture.compute.retireRevision(candidate);
          }
          retiredRevisions.push(candidate.id);
          if (failRetirement) {
            failRetirement = false;
            throw new Error("transient predecessor retirement failure");
          }
          return fixture.compute.retireRevision(candidate);
        },
      },
      { pool: fixture.createWorkerPool() },
    );

    await fixture.work(replacement, "succeeded");
    await fixture.work(stop, "succeeded");
    await Promise.all([
      foreign.work(foreignRevision, "succeeded"),
      foreign.work(foreignStop, "succeeded"),
    ]);
    const [stopped, retainedPredecessor, retainedReplacement] = await fixture.state.read(
      async (view) =>
        Promise.all([
          view.agents.findAgent(fixture.namespace.id, owner.id),
          view.revisions.findRevision(fixture.namespace.id, owner.id, predecessor.id),
          view.revisions.findRevision(fixture.namespace.id, owner.id, replacement.id),
        ]),
    );
    assert.equal(stopped.desiredRuntimeState, "stopped");
    assert.equal(stopped.activeRevisionId, undefined);
    assert.equal(retainedPredecessor.id, predecessor.id);
    assert.equal(retainedReplacement.id, replacement.id);
    assert.deepEqual(retiredRevisions, [predecessor.id, predecessor.id]);
    // Agent stop also covers the older same-Compute predecessor whose
    // retirement failed after publication, with serving revision cleanup first.
    assert.deepEqual(stoppedRevisions, [
      replacement.id,
      replacement.id,
      predecessor.id,
      replacement.id,
    ]);
  },
);

test(
  "maintenance retains its real lease across consecutive short predecessor retirements",
  requiresPostgres,
  async (context) => {
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics, leaseDurationMs: 1_200 });
    const { owner, candidate: first } =
      await fixture.admitInitialRevision("short-retirement-lease");
    const events = [];
    let completedRetirements = 0;
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 200,
        async retireRevision(previous) {
          // Exercise the real worker and PostgreSQL lease with short external
          // effects: each finishes before the heartbeat timer, but the whole
          // cleanup sequence exceeds the lease. No claim timestamps are edited.
          await delay(120);
          const result = await fixture.compute.retireRevision(previous);
          completedRetirements += 1;
          return result;
        },
      },
      { emit: (event) => events.push(event) },
    );
    await fixture.work(first, "succeeded");
    // Admitted intermediate revisions can be superseded before execution. They
    // remain valid predecessors that active-revision maintenance must retire.
    await fixture.state.transact(async (unit) => {
      for (let number = 2; number <= 24; number += 1) {
        const skipped = { ...first, id: `rev_${randomUUID()}`, revision: number };
        delete skipped.idempotencyKey;
        await unit.revisions.createRevision(skipped);
      }
    });
    const current = await fixture.revision(owner, 25);
    await fixture.work(current, "succeeded");
    const maintenance = await waitFor("one successful short-effect maintenance claim", async () => {
      assert.equal(
        events.some(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
        false,
        "consecutive short effects must not starve lease renewal",
      );
      const result = await fixture.observerPool.query(
        `SELECT state, attempt_count FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE '%:maintenance:%'
           AND state = 'succeeded'`,
        [current.id],
      );
      return result.rows[0];
    });
    assert.equal(maintenance.attempt_count, 1);
    // Periodic reconciliation must not inflate successful deployment counts.
    assert.match(
      await metrics.exposition(),
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="deploy"[^\n]*\} 2(?:\n|$)/,
    );
    assert.ok(completedRetirements >= 25, "activation and all predecessors were retired");
    const active = await fixture.currentAgent(owner);
    assert.equal(active.activeRevisionId, current.id);
  },
);
