import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  ComputePreparationFailedError,
  SandboxGatewayUnauthorizedError,
} from "../../packages/occ/src/index.ts";
import {
  backendDefinition,
  backendId,
  requiresPostgres,
} from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { repositoryAttempts } from "../helpers/postgres-worker-revision-support.mjs";

// Worker health, readiness, leases and outages. Deployment and dispatch cases are in
// postgres-worker-agent-revision.test.mjs, credential-source withdrawals in its
// -credential-sources sibling; repository sessions are in its -teardown sibling, and Agent stop
// and deletion and Namespace teardown in its -stop sibling; exclusive replacement and refused
// candidates are in the -replacement sibling, a refused candidate's stop and its wait in the
// -refused-stop and -refused-wait siblings, and redeploys whose predecessor stop yields in the
// -yielded-redeploy sibling. The lane runs the revision files at once.

const { setup, cleanup } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

const outboundAdmission = {
  selection: { mode: "publicHttps" },
  requirements: [],
  denyCidrs: ["10.42.0.0/16"],
};
const withdrawalPending = "REVISION_ACCESS_WITHDRAWAL_PENDING";

function withReplacementSecretDriver(drivers) {
  return {
    ...drivers,
    installation: {
      ...drivers.installation,
      drivers: {
        ...drivers.installation.drivers,
        secret: { ...drivers.installation.drivers.secret, id: "secret-replacement" },
      },
    },
    secretDriver: { ...drivers.secretDriver, id: "secret-replacement" },
  };
}

for (const [cause, access] of [
  ["authorization", "Gateway outbound"],
  ["backend", "Gateway outbound"],
  ["deadline", "Gateway outbound"],
  ["authorization", "Compute-admitted"],
  ["configuration", "Compute-admitted"],
  ["secret-driver", "Gateway outbound"],
  ["sandbox-permission", "Gateway outbound"],
]) {
  test(
    `active ${access} withdrawal survives ${cause} refusal, restored authority and worker restart`,
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 1 });
      const owner = await fixture.agent(`outbound-${cause}`, {
        executionMode: "dedicated",
        ...(cause === "backend" ? { backendId } : {}),
      });
      // A Driver-owned admission can require withdrawal without a Gateway snapshot.
      // The worker must persist and replay that obligation through the same contract.
      const candidate = await fixture.revision(
        owner,
        1,
        access === "Gateway outbound"
          ? { gatewayOutbound: outboundAdmission }
          : { computeAdmission: "revision-access:v1" },
      );
      let prepared = 0;
      let withdrawn = 0;
      let removalAvailable = false;
      let accessCurrent = true;
      let activationUnavailable = cause === "deadline";
      let sandboxPermissionRefused = false;
      const decisionsAtRemoval = [];
      // This boundary Driver fails removal while the real worker, IAM and PostgreSQL
      // decide its durable phase. The concrete Pod/tunnel failure is covered by k3d.
      const compute = {
        ...fixture.compute,
        maintenanceIntervalMs: 60_000,
        revisionAccessStatus: (revision) => {
          if (revision.gatewayOutbound === undefined && revision.compute.admission === undefined) {
            return "none";
          }
          return accessCurrent ? "current" : "withdrawn";
        },
        async prepareRevision(revision) {
          prepared += 1;
          if (sandboxPermissionRefused) {
            throw new SandboxGatewayUnauthorizedError("The Sandbox gateway refused its identity.");
          }
          return fixture.compute.prepareRevision(revision);
        },
        async activateRevision() {
          if (activationUnavailable) {
            throw new Error("Runtime activation temporarily unavailable");
          }
        },
        async withdrawRevisionAccess(revision) {
          const evidence = await fixture.observerPool.query(
            `SELECT details->>'refusal' AS refusal FROM occ.audit_events
             WHERE resource_kind = 'agent_revision' AND resource_id = $1
               AND kind = 'mutation' AND action = 'reconcile'
               AND details->>'reasonCode' = $2`,
            [revision.id, withdrawalPending],
          );
          decisionsAtRemoval.push(evidence.rows.length);
          withdrawn += 1;
          if (!removalAvailable) {
            throw new Error("Runtime deletion temporarily unavailable");
          }
        },
      };
      const providers = cause === "backend" ? [backendDefinition()] : [];
      await fixture.start(compute, { providers, convergenceTimeoutMs: 1_000 });
      let workId;
      if (cause === "deadline") {
        // The regular workflow publishes before activation. Failure to finish that
        // activation reaches the real convergence deadline with structured evidence.
        await waitFor("published revision waiting on activation", async () =>
          (await fixture.currentAgent(owner)).activeRevisionId === candidate.id ? true : undefined,
        );
        workId = candidate.idempotencyKey;
      } else {
        await fixture.work(candidate, "succeeded");
        await fixture.stop();
        const [maintenance] = (await fixture.advanceMaintenance(candidate)).rows;
        assert.ok(maintenance);
        workId = maintenance.idempotency_key;
      }
      const refusal = {
        authorization: "AUTHORIZATION_DENIED",
        backend: "BACKEND_UNAVAILABLE",
        deadline: "CONVERGENCE_DEADLINE_EXCEEDED",
        configuration: "REVISION_ACCESS_WITHDRAWN",
        "secret-driver": "SECRET_DRIVER_MISMATCH",
        "sandbox-permission": "SANDBOX_GATEWAY_UNAUTHORIZED",
      }[cause];
      const expectedData = cause === "deadline" ? { timeoutMs: 1_000 } : undefined;
      const queue = new fixture.PostgresWorkQueue(fixture.observerPool, { maxAttempts: 1 });
      const recoveryActorId = `${fixture.actor.id}-recovery`;
      if (cause === "authorization") {
        await fixture.copyActorGrants(recoveryActorId);
        await fixture.observerPool.query(
          "DELETE FROM occ.iam_access_bindings WHERE identity_subject_id = $1",
          [fixture.actor.id],
        );
      }
      const preparationsBeforeRefusal = prepared;
      if (cause === "configuration") {
        accessCurrent = false;
      }
      // A permanent Sandbox permission refusal must reach the same durable
      // removal phase when the active revision still owns admitted access.
      sandboxPermissionRefused = cause === "sandbox-permission";
      if (cause !== "deadline") {
        await fixture.start(compute, {
          providers: [],
          convergenceTimeoutMs: 1_000,
          // A selected Driver change invalidates the admitted Secret binding without
          // altering its PostgreSQL metadata or bypassing its reference safeguards.
          ...(cause === "secret-driver" ? { transformDrivers: withReplacementSecretDriver } : {}),
        });
      }
      await waitFor("failed removal after a committed refusal", async () => {
        const current = await queue.findWork(workId);
        if (cause === "configuration") {
          assert.equal(
            prepared,
            preparationsBeforeRefusal,
            "withdrawn access cannot enter preparation",
          );
        }
        assert.notEqual(current.state, "failed_permanent", "removal must precede terminal refusal");
        return withdrawn >= 1 ? true : undefined;
      });
      assert.ok(
        decisionsAtRemoval.every((count) => count > 0),
        "decision precedes deletion",
      );
      const decision = await queue.findWorkAttempt(workId, withdrawalPending);
      assert.equal(decision.refusal, refusal);
      assert.deepEqual(decision.refusalData, expectedData);
      const originalPreparationCount = prepared;
      await fixture.stop();

      // Restoring the original authority must not re-enter preparation, even after a
      // new worker reads the decision and the deployment convergence deadline has passed.
      if (cause === "authorization") {
        await fixture.observerPool.query(
          `INSERT INTO occ.iam_access_bindings
             (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
           SELECT 'binding-' || gen_random_uuid(), namespace_id, $1, role_id,
                  resource_kind, resource_id
           FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
          [fixture.actor.id, recoveryActorId],
        );
      }
      activationUnavailable = false;
      accessCurrent = true;
      sandboxPermissionRefused = false;
      const beforeRestart = withdrawn;
      await fixture.start(compute, { providers, convergenceTimeoutMs: 1_000 });
      await waitFor("removal-only retries after restart", async () =>
        withdrawn >= beforeRestart + 2 ? true : undefined,
      );
      const waiting = await queue.findWork(workId);
      assert.ok(["queued", "claimed"].includes(waiting.state));
      assert.equal(waiting.reasonCode, undefined);
      assert.equal(
        prepared,
        originalPreparationCount,
        "restored authority cannot repair the route",
      );
      assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
      removalAvailable = true;
      await fixture.work({ idempotencyKey: workId }, "failed_permanent");
      const terminal = await queue.findWork(workId);
      assert.equal(terminal.reasonCode, refusal);
      assert.deepEqual(terminal.resultData, expectedData);
      assert.equal(prepared, originalPreparationCount);
      assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
      const successors = await fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.controller_work WHERE revision_id = $1 AND state IN ('queued', 'claimed')",
        [candidate.id],
      );
      assert.equal(successors.rows[0].count, 0, "terminal removal cannot spawn repair maintenance");
    },
  );
}

test(
  "active revision without access admission recovers after restoring its selected Secret Driver",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 1 });
    const { owner, candidate } = await fixture.admitInitialRevision("secret-driver-recovery", {
      agent: { executionMode: "dedicated" },
    });
    let prepared = 0;
    const compute = {
      ...fixture.compute,
      maintenanceIntervalMs: 60_000,
      async prepareRevision(revision) {
        prepared += 1;
        return fixture.compute.prepareRevision(revision);
      },
    };
    await fixture.start(compute);
    await fixture.work(candidate, "succeeded");
    await fixture.stop();
    const [maintenance] = (await fixture.advanceMaintenance(candidate)).rows;
    assert.ok(maintenance);
    const originalPreparationCount = prepared;

    // An ordinary active runtime has no admitted access to withdraw. Refusing its
    // current Secret context must keep the maintenance chain available for recovery.
    await fixture.start(compute, { transformDrivers: withReplacementSecretDriver });
    await fixture.work({ idempotencyKey: maintenance.idempotency_key }, "failed_permanent");
    await fixture.stop();
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, { maxAttempts: 1 });
    assert.equal(
      (await queue.findWork(maintenance.idempotency_key)).reasonCode,
      "SECRET_DRIVER_MISMATCH",
    );
    assert.equal(
      await queue.findWorkAttempt(maintenance.idempotency_key, withdrawalPending),
      undefined,
    );
    assert.equal(prepared, originalPreparationCount);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
    const [recovery] = (await fixture.advanceMaintenance(candidate)).rows;
    assert.ok(recovery, "an ordinary active runtime retains its next maintenance pass");

    await fixture.start(compute);
    await fixture.work({ idempotencyKey: recovery.idempotency_key }, "succeeded");
    assert.ok(prepared > originalPreparationCount);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
  },
);

test(
  "active revision without access admission recovers after a Sandbox gateway permission refusal",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 1 });
    const { owner, candidate } = await fixture.admitInitialRevision("sandbox-permission-recovery", {
      agent: { executionMode: "dedicated" },
    });
    let sandboxPermissionRefused = false;
    const compute = {
      ...fixture.compute,
      maintenanceIntervalMs: 60_000,
      async prepareRevision(revision) {
        if (sandboxPermissionRefused) {
          throw new SandboxGatewayUnauthorizedError("The Sandbox gateway refused its identity.");
        }
        return fixture.compute.prepareRevision(revision);
      },
    };
    await fixture.start(compute);
    await fixture.work(candidate, "succeeded");
    await fixture.stop();
    const [maintenance] = (await fixture.advanceMaintenance(candidate)).rows;
    assert.ok(maintenance);

    // Without admitted access, the existing active-runtime recovery policy
    // retains maintenance through a provider refusal and never starts withdrawal.
    sandboxPermissionRefused = true;
    await fixture.start(compute);
    await fixture.work({ idempotencyKey: maintenance.idempotency_key }, "failed_permanent");
    await fixture.stop();
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, { maxAttempts: 1 });
    assert.equal(
      (await queue.findWork(maintenance.idempotency_key)).reasonCode,
      "REVISION_FINALIZATION_INCOMPLETE",
    );
    assert.equal(
      await queue.findWorkAttempt(maintenance.idempotency_key, withdrawalPending),
      undefined,
    );
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
    const [recovery] = (await fixture.advanceMaintenance(candidate)).rows;
    assert.ok(recovery, "an ordinary active runtime retains its next maintenance pass");

    sandboxPermissionRefused = false;
    await fixture.start(compute);
    await fixture.work({ idempotencyKey: recovery.idempotency_key }, "succeeded");
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
  },
);

test(
  "terminal active preparation retains retirement until outbound withdrawal survives restart and lease recovery",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 1 });
    const { candidate } = await fixture.admitInitialRevision("outbound-preparation-retirement", {
      agent: { executionMode: "dedicated" },
      revision: { gatewayOutbound: outboundAdmission },
    });
    const preparation = {
      workload: {
        kind: "Job",
        name: "terminal-preparation-proof",
        uid: "terminal-preparation-proof",
        namespace: "tenant-proof",
      },
      reason: "retry_limit",
      observedAt: "2026-10-14T12:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      pods: [],
    };
    let preparationFails = false;
    let removalAvailable = false;
    let removed = false;
    let withdrawals = 0;
    let preparations = 0;
    let retired = 0;
    const retirementRows = async () =>
      (
        await fixture.observerPool.query(
          "SELECT state, created_at FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE '%:repository_cleanup:retire:%'",
          [candidate.id],
        )
      ).rows;
    // The real error class carries the existing terminal preparation contract.
    // PostgreSQL and the worker own the withdrawal and retirement handoff below.
    const compute = {
      ...fixture.compute,
      maintenanceIntervalMs: 60_000,
      revisionAccessStatus: (revision) =>
        revision.gatewayOutbound === undefined ? "none" : "current",
      async prepareRevision(revision) {
        preparations += 1;
        if (preparationFails) {
          throw new ComputePreparationFailedError(
            "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED",
            preparation,
          );
        }
        return fixture.compute.prepareRevision(revision);
      },
      async withdrawRevisionAccess() {
        withdrawals += 1;
        assert.deepEqual(await retirementRows(), [], "retirement must wait for outbound removal");
        if (!removalAvailable) {
          throw new Error("Runtime deletion temporarily unavailable");
        }
        removed = true;
      },
      async stopRevision(revision) {
        assert.equal(removed, true, "terminal cleanup cannot stop the runtime before withdrawal");
        assert.equal(revision.id, candidate.id);
        retired += 1;
        return fixture.compute.stopRevision(revision);
      },
    };
    await fixture.start(compute);
    await fixture.work(candidate, "succeeded");
    await fixture.stop();
    const [maintenance] = (await fixture.advanceMaintenance(candidate)).rows;
    preparationFails = true;
    await fixture.start(compute);
    await waitFor("terminal preparation's pending outbound removal", async () =>
      withdrawals >= 1 ? true : undefined,
    );
    // Shutdown may leave an interrupted pass claimed. Finish its deferral before
    // the next phase deliberately expires a separately acquired claim.
    await fixture.work({ idempotencyKey: maintenance.idempotency_key }, "queued");
    await fixture.stop();
    const preparationCount = preparations;
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, { maxAttempts: 1 });
    const assertObligation = async () => {
      const evidence = await queue.findWorkAttempt(maintenance.idempotency_key, withdrawalPending);
      assert.equal(evidence.refusal, "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED");
      assert.equal(evidence.cleanupFailedPreparation, true);
      assert.deepEqual(evidence.refusalData, { preparation });
      assert.deepEqual(await retirementRows(), []);
    };
    await assertObligation();

    // A real expired claim recovers the committed obligation before a new worker
    // retries removal. This revision has no repository credentials to imply cleanup.
    await fixture.advanceMaintenance(candidate);
    const lost = await queue.claim();
    assert.equal(lost.idempotencyKey, maintenance.idempotency_key);
    await fixture.expireClaim({ idempotencyKey: maintenance.idempotency_key }, lost.claimToken);
    assert.equal((await queue.recoverStale()).failedPermanent, 0);
    await assertObligation();
    const beforeRestart = withdrawals;
    preparationFails = false;
    await fixture.advanceMaintenance(candidate);
    await fixture.start(compute);
    await waitFor("removal-only retries retaining terminal retirement", async () =>
      withdrawals >= beforeRestart + 2 ? true : undefined,
    );
    assert.equal(preparations, preparationCount, "recovery must not prepare the terminal runtime");
    await assertObligation();
    removalAvailable = true;
    await fixture.work({ idempotencyKey: maintenance.idempotency_key }, "failed_permanent");
    await waitFor("durable terminal preparation retirement to finish", async () =>
      (await retirementRows())[0]?.state === "succeeded" ? true : undefined,
    );
    assert.equal(retired, 1);
    assert.equal(preparations, preparationCount);
    const terminal = await queue.findWork(maintenance.idempotency_key);
    assert.equal(terminal.reasonCode, "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED");
    assert.deepEqual(terminal.resultData, { preparation });
  },
);

test(
  "PostgreSQL preserves outbound removal across reduced retry limits and repeated expired leases",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 3 });
    const { candidate } = await fixture.admitInitialRevision("outbound-lease", {
      agent: { executionMode: "dedicated" },
      revision: { gatewayOutbound: outboundAdmission },
    });
    await fixture.start({
      ...fixture.compute,
      maintenanceIntervalMs: 60_000,
      revisionAccessStatus: (revision) =>
        revision.gatewayOutbound === undefined ? "none" : "current",
      async withdrawRevisionAccess() {},
    });
    await fixture.work(candidate, "succeeded");
    await fixture.stop();
    const [maintenance] = (await fixture.advanceMaintenance(candidate)).rows;
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, { maxAttempts: 3 });
    // Two genuine queue retries precede the removal decision. A configuration change
    // then lowers the budget below its persisted count without inventing invalid Work.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const claim = await queue.claim();
      assert.equal(claim.idempotencyKey, maintenance.idempotency_key);
      await queue.retry(claim, { code: "DEPENDENCY_UNAVAILABLE" });
      await fixture.advanceMaintenance(candidate);
    }
    const last = await queue.claim();
    assert.equal(last.attemptCount, 3);
    const refusalData = { timeoutMs: 1_000 };
    await queue.defer(
      last,
      {
        code: withdrawalPending,
        refusal: "CONVERGENCE_DEADLINE_EXCEEDED",
        refusalData,
      },
      { delayMs: 1, repeatEvidence: true },
    );
    const restarted = new fixture.PostgresWorkQueue(fixture.observerPool, { maxAttempts: 1 });
    const reduced = await restarted.recoverStale();
    assert.equal(reduced.failedPermanent, 0);
    assert.equal(reduced.requeued, 1);
    assert.equal((await restarted.findWork(maintenance.idempotency_key)).attemptCount, 0);

    for (let restart = 0; restart < 3; restart += 1) {
      await fixture.advanceMaintenance(candidate);
      const claim = await restarted.claim();
      assert.equal(claim.idempotencyKey, maintenance.idempotency_key);
      assert.equal(claim.attemptCount, 1);
      // Expire the actual database lease while the removal pass owns the claim.
      await fixture.expireClaim({ idempotencyKey: maintenance.idempotency_key }, claim.claimToken);
      const recovery = await restarted.recoverStale();
      assert.equal(recovery.failedPermanent, 0);
      assert.equal(recovery.requeued, 1);
      const recovered = await restarted.findWork(maintenance.idempotency_key);
      assert.equal(recovered.state, "queued");
      assert.equal(recovered.attemptCount, 0);
      const evidence = await restarted.findWorkAttempt(maintenance.idempotency_key);
      assert.equal(evidence.code, withdrawalPending);
      assert.equal(evidence.refusal, "CONVERGENCE_DEADLINE_EXCEEDED");
      assert.deepEqual(evidence.refusalData, refusalData);
    }
    const pending = await fixture.observerPool.query(
      "SELECT count(*)::integer AS count FROM occ.controller_work WHERE revision_id = $1 AND state IN ('queued', 'claimed')",
      [candidate.id],
    );
    assert.equal(pending.rows[0].count, 1, "recovery cannot create a competing repair successor");
  },
);

test(
  "worker fixture disposal preserves another database's live claim and activation",
  requiresPostgres,
  async (context) => {
    const first = await setup(context);
    const firstOwner = await first.agent("isolated-first");
    await first.revision(firstOwner, 1);
    const second = await setup(context);
    const queue = new second.PostgresWorkQueue(second.observerPool);
    assert.equal(await queue.claim(), undefined, "workers cannot claim another fixture's work");

    const owner = await second.agent("isolated-second");
    const candidate = await second.revision(owner, 1);
    const release = Promise.withResolvers();
    let preparing = false;
    try {
      await second.start({
        ...second.compute,
        async prepareRevision(revision) {
          preparing = true;
          await release.promise;
          return second.compute.prepareRevision(revision);
        },
      });
      await waitFor("second fixture to hold its claim during preparation", async () =>
        preparing ? true : undefined,
      );
      const before = await second.work(candidate, "claimed");
      assert.equal(typeof before.claim_token, "string");

      await first.database.dispose();
      const renewed = await queue.heartbeat({
        idempotencyKey: candidate.idempotencyKey,
        claimToken: before.claim_token,
      });
      assert.equal(renewed?.claimToken, before.claim_token);
      release.resolve();
      await second.work(candidate, "succeeded");
      const activated = await second.currentAgent(owner);
      assert.equal(activated.activeRevisionId, candidate.id);
    } finally {
      // Release Compute before the registered owner teardown joins its worker.
      release.resolve();
    }
  },
);

// Finding 1209: a file hung 22 minutes in teardown, past its job's timeout, naming nothing.
// Node's test timeout does not cover after hooks, and pg's pool.end() waits for every
// checked-out client, so one client a failed test never released hung the file. Each teardown
// step now has a limit: the stuck step is named, and the database drop still runs, ending the
// leaked session.
test(
  "worker fixture teardown names a pool that never ends and still drops the database",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    // This test runs the teardown itself and expects it to fail, so the fixture registers its
    // after hooks with this stand-in; the fallback runs them only if the test fails first.
    const hooks = [];
    let leaked;
    let disposed = false;
    context.after(async () => {
      leaked?.release(true);
      if (!disposed) {
        for (const hook of hooks) {
          await Promise.resolve()
            .then(hook)
            .catch(() => {});
        }
      }
    });
    const fixture = await setup(
      { after: (hook) => hooks.push(hook) },
      { disposeLimitsMs: { "pool end": 1_000 } },
    );
    leaked = await fixture.observerPool.connect();
    // A terminated session errors twice (the server's notice, then the closed socket).
    const terminated = new Promise((resolve) => leaked.on("error", resolve));

    disposed = true;
    await assert.rejects(fixture.database.dispose(), {
      message: "revision fixture teardown: pool end did not finish within 1000 ms",
    });
    // The drop (WITH (FORCE)) ended the leaked client's session, which nothing else would.
    const ended = await Promise.race([terminated, delay(10_000, undefined, { ref: false })]);
    assert.ok(ended instanceof Error, "the database drop ended the leaked connection");
    leaked.release(true);
    leaked = undefined;
  },
);

// Runs `body` as a test file of its own under the revision fixture (created with `fixtureOptions`),
// needing no PostgreSQL, and returns its output once its process exits with `status`, or fails
// after 30 s naming the file as still running.
async function runFixtureFile(t, body, { fixtureOptions, status: expectedStatus = 0 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "revision-fixture-exit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "abandoned.test.mjs");
  const helper = new URL("../helpers/postgres-worker-revision-fixture.mjs", import.meta.url);
  await writeFile(
    file,
    `import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createWorkerRevisionFixtures, disposeStep } from ${JSON.stringify(helper.href)};
const { cleanup } = createWorkerRevisionFixtures(import.meta.url${
      fixtureOptions === undefined ? "" : `, ${JSON.stringify(fixtureOptions)}`
    });
// A pool.end() that never settles while its socket keeps the event loop alive.
const abandonStep = () =>
  assert.rejects(
    disposeStep("pool end", 100, () => {
      setInterval(() => {}, 1_000);
      return new Promise(() => {});
    }),
    { message: "revision fixture teardown: pool end did not finish within 100 ms" },
  );
after(cleanup);
${body}`,
  );
  // A test runner of its own (this file's context would make it skip the file), in its own
  // process group, so a file that never exits can be killed with its test process.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--test", file], {
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const killGroup = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group has exited.
    }
  };
  t.after(killGroup);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const limit = setTimeout(killGroup, 30_000);
  const [status, signal] = await once(child, "close");
  clearTimeout(limit);
  assert.equal(signal, null, `the file was still running after 30 s:\n${output}`);
  assert.equal(status, expectedStatus, output);
  assert.match(output, /revision fixture teardown: pool end did not finish within 100 ms/);
  return output;
}

// Finding 1223: a teardown step left running past its limit can hold its process open (a pool's
// socket, a child), so the file sat idle after its last test until the runner's file timeout
// killed it. A file that abandoned a step now exits once its own teardown is done. Runs the
// fixture's real teardown step in its own test process.
test("an abandoned teardown step that holds its process open does not keep the file alive", async (t) => {
  const output = await runFixtureFile(
    t,
    `// A root after hook registered after cleanup, slower than the exit grace, still finishes.
after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  console.log("later after hook finished");
});
test("a stuck step is abandoned at its limit", async () => {
  assert.equal(await disposeStep("worker stop", 5_000, () => "stopped"), "stopped");
  await abandonStep();
});
`,
  );
  // Finding 1246: the exit grace starts once every root after hook has run, not at cleanup.
  assert.match(output, /later after hook finished/);
});

// Finding 1246: a step a root after hook after cleanup abandons also ends the file.
test("a teardown step abandoned by a later root after hook does not keep the file alive", async (t) => {
  await runFixtureFile(
    t,
    `after(abandonStep);
test("nothing is abandoned during the tests", () => {});
`,
  );
});

// Finding 1258: node:test skips the remaining after hooks after a failing one, so a root after
// hook after cleanup that throws also skips the hook that starts the exit grace. The backstop
// cleanup arms once a step was abandoned still ends the file, and its failure is still reported.
test("a later root after hook that fails after an abandoned step does not keep the file alive", async (t) => {
  const output = await runFixtureFile(
    t,
    `after(() => {
  throw new Error("later after hook failed");
});
test("a stuck step is abandoned at its limit", abandonStep);
`,
    { fixtureOptions: { exitBackstopMs: 4_000 }, status: 1 },
  );
  assert.match(output, /later after hook failed/);
});

// Finding 1258: the same when the failing later hook is the one that abandoned the step.
test("a later root after hook that abandons a step and fails does not keep the file alive", async (t) => {
  const output = await runFixtureFile(
    t,
    `after(async () => {
  await abandonStep();
  throw new Error("later after hook failed");
});
test("nothing is abandoned during the tests", () => {});
`,
    { fixtureOptions: { exitBackstopMs: 4_000 }, status: 1 },
  );
  assert.match(output, /later after hook failed/);
});

// The worker is serial. A Compute wait that only saves a later pass asks whether
// other Work is waiting and ends early when it is, so another Agent's deploy
// runs next instead of queuing behind the wait (D221).
test(
  "a revision pass learns when another Agent's Work is waiting for the serial worker",
  { ...requiresPostgres, timeout: 30_000 },
  async (context) => {
    const { computeWorkWaiting } =
      await import("../../apps/controller/src/drivers/compute/operation-context.ts");
    const fixture = await setup(context);
    const first = await fixture.agent("waiting-first", { executionMode: "dedicated" });
    const second = await fixture.agent("waiting-second", { executionMode: "dedicated" });
    const prepared = [];
    let secondRevision;
    let wait;
    const compute = {
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        prepared.push(revision.agentId);
        if (revision.agentId !== first.id || wait !== undefined) {
          return fixture.compute.prepareRevision(revision, deploymentContext);
        }
        // The first Agent's pass waits, as for its node to pair; nothing else is
        // queued yet, so nothing is waiting for the worker.
        const before = await computeWorkWaiting();
        secondRevision = await fixture.revision(second, 1);
        const started = Date.now();
        let endedEarly = false;
        while (Date.now() - started < 10_000) {
          if (await computeWorkWaiting()) {
            endedEarly = true;
            break;
          }
          await delay(25);
        }
        wait = { before, endedEarly, ms: Date.now() - started };
        return {
          ...(await fixture.compute.prepareRevision(revision, deploymentContext)),
          ready: false,
        };
      },
    };
    await fixture.start(compute);
    const firstRevision = await fixture.revision(first, 1);
    await waitFor("the second Agent to deploy during the first pass", async () => secondRevision);
    await fixture.work(secondRevision, "succeeded");
    await fixture.work(firstRevision, "succeeded");
    assert.equal(wait.before, false, "the pass's own Agent is not other Work");
    assert.equal(wait.endedEarly, true);
    assert.ok(wait.ms < 5_000, `the wait ended early (${wait.ms} ms)`);
    // The pending first pass ended and the second Agent's pass ran next.
    assert.deepEqual(prepared.slice(0, 2), [first.id, second.id]);
  },
);

test(
  "worker readiness remains available when repository credentials are disabled",
  requiresPostgres,
  async (context) => {
    let healthy = false;
    const fixture = await setup(context, {
      onHealthy: async () => {
        healthy = true;
      },
    });
    const { candidate } = await fixture.admitInitialRevision("no-repository-capability");
    await fixture.start(fixture.compute);
    await fixture.work(candidate, "succeeded");
    await waitFor("repository-disabled worker readiness", async () => (healthy ? true : undefined));
  },
);

/**
 * Relay PostgreSQL connections through a local proxy that can go silent: it stops relaying on
 * every open connection without closing it, as a client sees after a failover or partition
 * that sent no RST. New connections still reach the server.
 */
async function startSilenceableProxy(context, databaseUrl) {
  const { createServer, connect } = await import("node:net");
  const target = new URL(databaseUrl);
  const pairs = new Set();
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    const pair = { client, upstream };
    pairs.add(pair);
    client.pipe(upstream);
    upstream.pipe(client);
    const close = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on("error", close);
      socket.on("close", close);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => {
    for (const { client, upstream } of pairs) {
      client.destroy();
      upstream.destroy();
    }
    return new Promise((resolve) => server.close(resolve));
  };
  context.after(close);
  const url = new URL(databaseUrl);
  url.hostname = "127.0.0.1";
  url.port = String(server.address().port);
  return {
    url: url.toString(),
    silence() {
      for (const { client, upstream } of pairs) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
      }
    },
    close,
  };
}

test(
  "a worker abandons a query on a silent database connection and resumes work",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const [{ Pool }, { workerDatabasePoolOptions }] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
    ]);
    const fixture = await setup(context);
    const proxy = await startSilenceableProxy(context, fixture.database.url);
    const pool = new Pool({
      connectionString: proxy.url,
      ...workerDatabasePoolOptions(3_000),
      max: 2,
    });
    fixture.database.pools.add(pool);
    const { candidate: before } = await fixture.admitInitialRevision("before-silence");
    await fixture.start(fixture.compute, { pool });
    await fixture.work(before, "succeeded");

    // Every pooled connection now swallows queries without an answer or an error.
    proxy.silence();
    const { candidate: after } = await fixture.admitInitialRevision("after-silence");
    await fixture.work(after, "succeeded", 30_000);
    await fixture.stop();
    await proxy.close();
  },
);

test(
  "worker progress continues through a database outage and stops when the loop is stuck",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const { Pool } = await import("pg");
    let progressed = 0;
    const fixture = await setup(context, {
      onProgress: async () => {
        progressed += 1;
      },
    });
    const proxy = await startSilenceableProxy(context, fixture.database.url);
    // No query timeout: this isolates the liveness signal from the timeout that would unstick it.
    const pool = new Pool({ connectionString: proxy.url, max: 1 });
    fixture.database.pools.add(pool);
    pool.on("error", () => {});
    await fixture.start(fixture.compute, { pool });
    await waitFor("idle worker progress", async () => (progressed >= 2 ? true : undefined));

    proxy.silence();
    // A negative check needs a fixed window. Progress is reported at most once per second
    // here (pollIntervalMs 15), so 1.5 s lets an in-flight pass settle and 3 s spans three
    // reports a moving loop would have made.
    await delay(1_500);
    const stuck = progressed;
    await delay(3_000);
    assert.equal(
      progressed,
      stuck,
      "a worker stuck on a silent query must stop reporting progress",
    );

    // Refused connections fail each pass fast; the loop still moves, so liveness holds.
    await proxy.close();
    await waitFor("progress through a database outage", async () =>
      progressed >= stuck + 2 ? true : undefined,
    );
    await fixture.stop();
  },
);

test(
  "worker readiness and fresh Agent admission require the broker capability",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    let healthy = 0;
    const fixture = await setup(context, {
      onHealthy: async () => {
        healthy += 1;
      },
    });
    const [
      { GitHubRepoDriver },
      { UnixRepositoryCredentialControlClient },
      { startRegistryCredentialServiceFixture },
      { startRepositoryReceiptServer },
      { startControlResponseRelay },
      { createResourceScope },
      { dirname },
    ] = await Promise.all([
      import("../../apps/controller/src/drivers/repo/github/driver.ts"),
      import("../../apps/controller/src/backends/repository-credentials/control-client.ts"),
      import("../fixtures/repository-credentials/registry.mjs"),
      import("../../apps/controller/src/backends/repository-credentials/receipt-server.ts"),
      import("../fixtures/repository-credentials/control-relay.mjs"),
      import("../fixtures/repository-credentials/resources.mjs"),
      import("node:path"),
    ]);
    const credentials = await startRegistryCredentialServiceFixture(context, {
      namespaceId: fixture.namespace.id,
      autoOpen: false,
      clock: { ...createControlledClock(), wallNow: Date.now },
      gateway: { listen: "127.0.0.1:0" },
    });
    const scope = createResourceScope();
    context.after(() => scope.close());
    const relay = await startControlResponseRelay(scope, {
      directory: dirname(credentials.config.gateway.controlSocket),
      target: credentials.config.gateway.controlSocket,
    });
    // Simulate the old broker's 404 while all other traffic still reaches the real service.
    relay.setCapabilitiesHidden(true);
    const driver = new GitHubRepoDriver(
      {
        id: credentials.backendId,
        client: new UnixRepositoryCredentialControlClient({ controlSocket: relay.socketPath }),
        drivers: { repo: "repository-credentials" },
      },
      credentials.registry,
      { sessionDurationSeconds: 60, publicCa: credentials.tls.ca },
    );
    const receiptServer = await startRepositoryReceiptServer({
      state: fixture.state,
      controlSocket: credentials.config.gateway.controlSocket,
      driverId: driver.id,
      implementation: driver.implementation,
      backendId: credentials.backendId,
    });
    context.after(() => receiptServer.close());
    const resolution = driver.resolve({
      namespaceId: fixture.namespace.id,
      bindings: [{ repositoryRef: "repo-a", profile: "git-read" }],
    });
    const owner = await fixture.agent("repository-capability");
    const selection = {
      driver: { id: driver.id, implementation: driver.implementation },
      deadlineWallMs: Date.now() + 120_000,
      bindings: resolution.bindings,
    };
    const incompatible = await fixture.revision(owner, 1, { repositoryCredentials: selection });
    await fixture.start(
      {
        ...fixture.compute,
        validateRepositoryCredentials() {},
      },
      {
        pool: fixture.workerPool,
        transformDrivers: (drivers) => ({ ...drivers, repoDriver: driver }),
      },
    );
    // Four jittered retry delays can total nearly 15 seconds before the fifth claim.
    await fixture.work(incompatible, "failed_permanent", 20_000);
    assert.equal(healthy, 0);
    assert.deepEqual(await repositoryAttempts(fixture, incompatible), []);
    assert.ok(credentials.repositories.every(({ github }) => github.issuesOfTokens.length === 0));
    // Restoring the real capability permits an explicit new revision.
    relay.setCapabilitiesHidden(false);
    await waitFor("worker readiness after compatible broker selection", async () =>
      healthy > 0 ? true : undefined,
    );
    const open = driver.open.bind(driver);
    let lostSessionId;
    driver.open = async (input, signal) => {
      const result = await open(input, signal);
      if (lostSessionId === undefined && result.kind === "created") {
        lostSessionId = result.session.sessionId;
        // The response is lost after the broker creates a session, then the
        // capability disappears before recovery gets another worker claim.
        relay.setCapabilitiesHidden(true);
        throw new Error("repository admission response lost after creation");
      }
      return result;
    };
    const uncertain = await fixture.revision(owner, 2, { repositoryCredentials: selection });
    await fixture.work(uncertain, "failed_permanent", 20_000);
    assert.ok(lostSessionId);
    await waitFor("lost session disposal after work failure", async () =>
      (await repositoryAttempts(fixture, uncertain)).find(
        ({ sessionId }) => sessionId === lostSessionId,
      )?.phase === "disposed"
        ? true
        : undefined,
    );
    assert.equal((await repositoryAttempts(fixture, uncertain)).length, 1);
    // Recovery and disposal ran while capability was absent; fresh material
    // requires restoring it and explicitly admitting another revision.
    relay.setCapabilitiesHidden(false);
    const compatible = await fixture.revision(owner, 3, { repositoryCredentials: selection });
    await fixture.work(compatible, "succeeded");
    assert.equal(
      (await repositoryAttempts(fixture, compatible)).filter(({ phase }) => phase === "open")
        .length,
      1,
    );
    // Losing the capability again must not gate the real stop and cleanup paths.
    relay.setCapabilitiesHidden(true);
    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    await waitFor("repository cleanup despite the missing capability", async () =>
      (await repositoryAttempts(fixture, compatible)).every(({ phase }) => phase === "disposed")
        ? true
        : undefined,
    );
  },
);

test(
  "worker health remains current while a Compute operation holds a renewed PostgreSQL lease",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { leaseDurationMs: 1_200 });
    const { candidate } = await fixture.admitInitialRevision("long-compute-health");
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          entered.resolve();
          await release.promise;
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      { emit: (event) => events.push(event) },
    );
    try {
      await entered.promise;
      const healthCount = () => events.filter(({ event }) => event === "worker.health").length;
      const before = healthCount();
      // A busy worker must report fresh database health before Compute returns,
      // not only after completion. The real queue continues renewing its lease.
      await waitFor("health observations during the unfinished Compute operation", async () =>
        healthCount() >= before + 2 ? true : undefined,
      );
      const claimed = await fixture.work(candidate, "claimed");
      assert.equal(claimed.attempt_count, 1);
    } finally {
      release.resolve();
    }
    await fixture.work(candidate, "succeeded");
  },
);

for (const slowCall of [1, 2]) {
  test(
    `slow health update ${slowCall} does not block Compute or PostgreSQL lease renewal`,
    requiresPostgres,
    async (context) => {
      const healthEntered = Promise.withResolvers();
      const releaseHealth = Promise.withResolvers();
      const releaseCompute = Promise.withResolvers();
      let healthCalls = 0;
      // Renewals run every third of the lease. A 4.5 s lease survives a busy CI host's late
      // renewal; a 1.2 s one expired under load (finding 870).
      const fixture = await setup(context, {
        leaseDurationMs: 4_500,
        async onHealthy() {
          if (++healthCalls !== slowCall) {
            return;
          }
          healthEntered.resolve();
          await releaseHealth.promise;
        },
      });
      const { owner, candidate } = await fixture.admitInitialRevision("slow-health");
      const events = [];
      let preparing = false;
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision, deploymentContext) {
            preparing = true;
            await releaseCompute.promise;
            return fixture.compute.prepareRevision(revision, deploymentContext);
          },
        },
        { emit: (event) => events.push(event) },
      );
      try {
        await healthEntered.promise;
        // Cover both the health update before the first effect and one started
        // during Compute. Neither may hold the claim's renewal chain hostage.
        await waitFor("Compute to start despite the pending health update", async () =>
          preparing ? true : undefined,
        );
        const original = await fixture.work(candidate, "claimed");
        // Count renewals instead of sampling the lease once: the same claim must be renewed
        // three times while the health update is still pending, however late each renewal
        // runs. Preparation nests two renewal chains, and each renews once before a chain that
        // waited on the health update would stop.
        const lease = async () => {
          const { rows } = await fixture.observerPool.query(
            `SELECT claim_token, attempt_count, lease_expires_at,
                    lease_expires_at > clock_timestamp() AS live
             FROM occ.controller_work WHERE idempotency_key = $1`,
            [candidate.idempotencyKey],
          );
          return rows[0];
        };
        let renewals = 0;
        let expiresAt = (await lease()).lease_expires_at.getTime();
        const renewed = await waitFor(
          "three lease renewals during the pending health update",
          async () => {
            const current = await lease();
            assert.ok(current.live, "the lease must not lapse while the health update is pending");
            if (current.lease_expires_at.getTime() > expiresAt) {
              renewals += 1;
              expiresAt = current.lease_expires_at.getTime();
            }
            return renewals >= 3 ? current : undefined;
          },
          30_000,
        );
        assert.deepEqual(
          { claim_token: renewed.claim_token, attempt_count: renewed.attempt_count },
          { claim_token: original.claim_token, attempt_count: 1 },
        );
        assert.equal(healthCalls, slowCall, "health updates must not overlap");
      } finally {
        releaseHealth.resolve();
        releaseCompute.resolve();
      }
      // A worker that gave up the claim reports it only once Compute returns.
      const done = await fixture.work(candidate, "succeeded");
      assert.equal(done.attempt_count, 1);
      assert.equal(
        events.some(({ code }) => code === "CLAIM_LOST"),
        false,
      );
      const active = await fixture.currentAgent(owner);
      assert.equal(active.activeRevisionId, candidate.id);
    },
  );
}

test(
  "failed readiness updates do not abort Compute or spend its retry budget",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, {
      leaseDurationMs: 1_200,
      async onHealthy() {
        throw new Error("readiness sink unavailable");
      },
    });
    const { candidate } = await fixture.admitInitialRevision("failed-health");
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          await delay(2_600);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      { emit: (event) => events.push(event) },
    );
    const completed = await fixture.work(candidate, "succeeded");
    assert.equal(completed.attempt_count, 1);
    assert.ok(events.some(({ code }) => code === "HEALTH_UNAVAILABLE"));
    assert.equal(
      events.some(({ code }) => code === "CLAIM_LOST"),
      false,
    );
    assert.equal(
      events.some(({ event }) => event === "worker.health"),
      false,
    );
  },
);
