import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  advanceCleanupRetries,
  completedPasses,
  completion,
  expireWorkLease,
  removeAccessBindings,
  repositoryAttempts,
  repositoryBoundary,
  withUnavailableIAM,
} from "../helpers/postgres-worker-revision-support.mjs";

// Repository sessions through admission, maintenance and cleanup. Agent stop, its Gateway drain,
// Agent deletion and Namespace teardown are in the -stop sibling; deployment and dispatch cases,
// and the persisted deploy, stop and delete lifecycle, are in postgres-worker-agent-revision.test.mjs;
// credential-source withdrawals are in its -credential-sources sibling.

const { setup, cleanup } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

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
          return { ...result, status: await repository.dispose(result.status.sessionId) };
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
    const events = [];
    const startWorker = () =>
      fixture.start(compute, {
        emit: (event) => events.push(event),
        pool: fixture.createWorkerPool(),
        transformDrivers: withUnavailableIAM(() => iamUnavailable),
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
    // The log says why the exhausted pass failed (finding 1743).
    const ended = (await completedPasses(events, outage, "retry")).at(-1);
    assert.equal(ended.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(ended.cause, "Error");
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
    const events = [];
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
        emit: (event) => events.push(event),
        transformDrivers: withUnavailableIAM(() => iamUnavailable),
      },
    );
    await fixture.work(candidate, "failed_permanent");
    await fixture.stop();
    assert.equal(activations, 1, "only the check after activation met the outage");
    // The retry says why the check failed (finding 2272).
    const ended = (await completedPasses(events, candidate, "retry")).at(-1);
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
    await expireWorkLease(fixture.observerPool, {
      key: crashedKey,
      claimToken: crashed.claimToken,
    });
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
      await fixture.start(compute, { transformDrivers: withUnavailableIAM(() => iamUnavailable) });
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
      const stopped = [];
      let iamUnavailable = false;
      const compute = {
        ...fixture.compute,
        ...(maintained ? { maintenanceIntervalMs: 3_600_000 } : {}),
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
      };
      const events = [];
      const options = {
        emit: (event) => events.push(event),
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
      const ended = (await completedPasses(events, second, "retry")).at(-1);
      assert.equal(ended.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(ended.cause, "Error", "the log names the failure that exhausted the deployment");
      const maintenance = await fixture.observerPool.query(
        `SELECT idempotency_key FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [second.id, `agent_revision:${second.id}:maintenance:%`],
      );
      assert.equal(maintenance.rowCount, 0, "finding 1743: the chain question is still open");
      assert.deepEqual(stopped, []);
      const agent = await fixture.currentAgent(owner);
      assert.equal(agent.activeRevisionId, second.id);
      assert.equal(agent.desiredRuntimeState, "running");
    },
  );
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
      // The runtime stopped even though the session's disposal is still unconfirmed.
      // Report no active revision; keep the requested run state and deployment history.
      const agent = await fixture.currentAgent(owner);
      assert.equal(agent.activeRevisionId, undefined);
      assert.equal(agent.desiredRuntimeState, "running");
      assert.equal((await fixture.workResult(candidate)).rows[0].reason_code, "REVISION_ACTIVATED");
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
    const { owner, candidate } = await fixture.admitInitialRevision(
      "repository-maintenance-restart",
      {
        revision: { repositoryCredentials: repository.snapshot },
      },
    );
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
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
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
    // A provider outage leaves cleanup pending without making fleet inventory
    // unavailable, marking the stopped Agent as deploying, or settling the cleanup.
    // This does not guard the inventory's repository-cleanup filter (#2572): while
    // the Agent lives, its cleanup work resolves to the revision's settled
    // :reconcile work, so the read passes with or without the filter. Cleanup that
    // Agent deletion detached from its owners needs the filter; the -stop sibling's
    // inventory reads after Agent deletion cover it.
    const pendingCleanup = async () =>
      (
        await fixture.observerPool.query(
          `SELECT idempotency_key, agent_id, revision_id, state, attempt_count, available_at
           FROM occ.controller_work WHERE idempotency_key LIKE $1 ORDER BY idempotency_key`,
          [`agent_revision:${candidate.id}:repository_cleanup:%`],
        )
      ).rows;
    const cleanupBeforeInventory = await pendingCleanup();
    const inventory = await fixture.controller.getInstallationDeploymentInventory(fixture.actor.id);
    const agents = inventory.namespaces.find(({ id }) => id === fixture.namespace.id).agents;
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
    assert.equal((await repositoryAttempts(fixture, candidate))[0].phase, "closing");
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
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);

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

for (const scenario of [
  "withdrawn",
  "pending then stop",
  "pending then superseded",
  "unconfirmed then withdrawn",
  "lost maintenance claim",
  "retire-runtime",
  "unsupported",
]) {
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
      const stopped = [];
      const events = [];
      let preparations = 0;
      let observations = 0;
      let result = scenario;
      const compute = {
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
                if (result.startsWith("unconfirmed")) {
                  throw new Error("withdrawal reply lost");
                }
                return result.startsWith("pending") ? "pending" : result;
              },
            }),
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
      };
      const start = () => fixture.start(compute, { emit: (event) => events.push(event) });
      const completed = (label) =>
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
      if (scenario === "lost maintenance claim") {
        const queue = new fixture.PostgresWorkQueue(fixture.observerPool, { maxAttempts: 1 });
        const abandoned = await queue.claim();
        assert.equal(abandoned.idempotencyKey, maintenance.idempotency_key);
        await fixture.expireClaim(abandoned, abandoned.claimToken);
        assert.equal((await queue.recoverStale()).failedPermanent, 1);
        result = "withdrawn";
      }
      await start();
      const first = await completed("durable Git expiry outcome");
      const observed = await fixture.workResult({
        id: candidate.id,
        idempotencyKey: maintenance.idempotency_key,
      });
      assert.equal(
        observed.rows[0].reason_code,
        scenario === "lost maintenance claim"
          ? "LEASE_EXPIRED"
          : "REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED",
      );
      assert.equal((await fixture.workResult(candidate)).rows[0].reason_code, "REVISION_ACTIVATED");
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
          (await fixture.currentAgent(owner)).activeRevisionId === undefined ? true : undefined,
        );
        assert.deepEqual(stopped, [candidate.id]);
        assert.equal(observations, scenario === "unsupported" ? 0 : 1);
        return;
      }
      assert.deepEqual(stopped, [], "the Git deadline alone must not stop the serving revision");
      if (scenario.startsWith("pending") || scenario.startsWith("unconfirmed")) {
        assert.equal(first.code, "REPOSITORY_CLEANUP_PENDING");
        assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
        await fixture.stop();
        events.length = 0;
        await start();
        await advanceCleanupRetries(fixture, candidate);
        assert.equal((await completed("cold worker still owes withdrawal")).code, first.code);
        assert.deepEqual(stopped, []);
        if (scenario === "pending then stop") {
          const stop = await fixture.requestStop(owner);
          await fixture.work(stop, "succeeded");
          const agent = await fixture.currentAgent(owner);
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
          assert.equal((await fixture.currentAgent(owner)).activeRevisionId, newer.id);
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
      assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
      await fixture.stop();
      const previous = observations;
      const {
        rowCount: count,
        rows: [next],
      } = await fixture.advanceMaintenance(candidate);
      assert.equal(count, 1, "continue normal maintenance after confirmed Git withdrawal");
      await start();
      const work = { id: candidate.id, idempotencyKey: next.idempotency_key };
      await fixture.work(work, "succeeded");
      assert.equal(
        (await fixture.workResult(work)).rows[0].reason_code,
        "REPOSITORY_ACCESS_WITHDRAWN",
      );
      assert.ok(observations > previous, "cold maintenance verifies the reduced runtime");
      await checkNoNewGit();
      assert.deepEqual(stopped, []);
      const agent = await fixture.currentAgent(owner);
      assert.equal(agent.activeRevisionId, candidate.id);
      assert.equal(agent.desiredRuntimeState, "running");

      // Offboard the requester after Git withdrawal. IAM now denies this exact revision.
      const removed = await removeAccessBindings(fixture, fixture.actor.id);
      assert.ok(removed.rowCount > 0, "remove the requester's actual access bindings");
      await fixture.advanceMaintenance(candidate);
      await waitFor("runtime authority loss retires exact revision", async () =>
        (await fixture.currentAgent(owner)).activeRevisionId === undefined ? true : undefined,
      );
      assert.deepEqual(stopped, [candidate.id]);
      await checkNoNewGit();
    },
  );
}
