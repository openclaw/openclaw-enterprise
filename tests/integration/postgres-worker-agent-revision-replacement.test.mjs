import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import {
  SandboxGatewayUnavailableError,
  SandboxRevisionUnsupportedError,
} from "../../packages/occ/src/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { ComputeStopYieldedError } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import { createPostgresControllerAuth } from "../helpers/password-hasher.mjs";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  completedPasses,
  repositoryBoundary,
  waitForWorkPass,
  waitForWorkStateDue,
} from "../helpers/postgres-worker-revision-support.mjs";
import {
  assertWorkEnds,
  countingExclusiveCompute,
  denyDeploy,
  failingStop,
  proxiedIAM,
  refusals,
  refusedStopWaits,
  startRefusedCandidate,
} from "../helpers/postgres-worker-refused-candidate.mjs";

// Exclusive replacement and refused candidates: predecessor stops across pending passes and
// maintenance, refused and self-failed exclusive candidates, refused deployments on shared
// Compute, predecessors that come back after the sweep, a refused wait's failed reads, a
// refusal lifted past the deadline, older shared or exclusive versions overtaken by a newer
// shared one that fails or activates, and older exclusive versions overtaken by a newer exclusive
// one that is refused before its sweep or sweeps them. Worker health is in the -health sibling, a refused
// candidate's stop and its wait in the -refused-stop and -refused-wait siblings, and redeploys
// whose predecessor stop yields in the -yielded-redeploy sibling; the lane runs the revision files
// at once. These files name the -replacement, -refused-stop, -refused-wait and -yielded-redeploy
// siblings only by suffix: CI Impact sends a test-only change to full CI when another file names
// that test.

const { setup, cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

revisionTest(
  "exclusive replacement blocks overlap, supersedes old maintenance and recovers through a new revision",
  async (fixture) => {
    const owner = await fixture.agent("exclusive-workspace", { executionMode: "dedicated" });
    const running = new Set();
    const prepared = [];
    let rejectStop = true;
    let stopFailures = 0;
    const compute = {
      ...fixture.compute,
      requiresStoppedPredecessors: () => true,
      async prepareRevision(revision) {
        // This Driver boundary represents a resource which cannot be held by
        // two revisions. PostgreSQL and the real worker own ordering and retries.
        assert.deepEqual(
          [...running].filter((id) => id !== revision.id),
          [],
        );
        running.add(revision.id);
        prepared.push(revision.id);
        return {
          ...(await fixture.compute.prepareRevision(revision)),
          ready: revision.revision !== 2,
        };
      },
      async stopRevision(revision) {
        const active = await fixture.currentAgent(owner);
        if (active.activeRevisionId === revision.id) {
          const replacement = await fixture.state.read((view) =>
            view.agents.findPredecessorReplacement(revision.namespaceId, revision.agentId),
          );
          assert.equal(replacement?.predecessorRevisionId, revision.id);
          assert.equal(
            replacement?.phase,
            "stopping",
            "stop intent must survive a worker restart before any external stop effect",
          );
        }
        if (rejectStop && running.has(revision.id)) {
          rejectStop = false;
          stopFailures += 1;
          throw new Error("resource release temporarily unavailable");
        }
        running.delete(revision.id);
      },
      async retireRevision(revision) {
        running.delete(revision.id);
      },
    };
    await fixture.start(compute, { convergenceTimeoutMs: 3_000 });
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    const replacement = await fixture.revision(owner, 2);
    await waitFor("replacement preparation after predecessor release", async () =>
      running.has(replacement.id) ? true : undefined,
    );
    assert.equal(stopFailures, 1);
    const firstPreparations = prepared.filter((id) => id === first.id).length;
    const maintenance = {
      id: first.id,
      idempotencyKey: `agent_revision:${first.id}:maintenance:${randomUUID()}`,
    };
    await fixture.state.transactWithQueue((_unit, queue) =>
      queue.enqueue({
        idempotencyKey: maintenance.idempotencyKey,
        namespaceId: fixture.namespace.id,
        agentId: owner.id,
        revisionId: first.id,
        actorId: fixture.actor.id,
        availableAt: new Date(0),
      }),
    );
    await fixture.work(maintenance, "succeeded");
    assert.equal(prepared.filter((id) => id === first.id).length, firstPreparations);
    await fixture.work(replacement, "failed_permanent");
    assert.deepEqual([...running], [replacement.id]);
    const recovery = await fixture.revision(owner, 3);
    await fixture.work(recovery, "succeeded");
    assert.deepEqual([...running], [recovery.id]);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.activeRevisionId, recovery.id);
  },
  // The file's first test, so its time includes waiting for the CI state lock behind the
  // other files' preparation (see the fixture).
  { timeout: 60_000 },
);

async function enqueueMaintenance(fixture, owner, revision) {
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
  return maintenance;
}

revisionTest(
  "a pre-stop record does not reprepare the predecessor with changed Driver configuration",
  async (fixture) => {
    const owner = await fixture.agent("pre-stop-maintenance", { executionMode: "dedicated" });
    const driver = countingExclusiveCompute(fixture);
    await fixture.start(driver.compute);
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    await fixture.stop();
    const candidate = await fixture.revision(owner, 2);
    // Keep the successor's Work out of the maintenance pass. Admission itself is
    // exercised by native-admin-access; this test isolates the real worker boundary.
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE idempotency_key = $1",
      [candidate.idempotencyKey],
    );
    const record = (phase) =>
      fixture.state.transact(async (unit) => {
        await unit.namespaces.lockNamespace(fixture.namespace.id);
        await unit.agents.lockAgent(fixture.namespace.id, owner.id);
        return unit.agents.recordPredecessorReplacement(fixture.namespace.id, owner.id, {
          predecessorRevisionId: first.id,
          candidateRevisionId: candidate.id,
          phase,
        });
      });
    const pending = await record("pre-stop");
    const before = driver.preparations(first);
    const maintenance = await enqueueMaintenance(fixture, owner, first);
    await fixture.start(driver.compute);
    await fixture.work(maintenance, "succeeded");
    assert.equal(
      driver.preparations(first),
      before,
      "maintenance must not roll the old runtime forward before stop",
    );
    assert.equal(driver.count(first), 0);

    await fixture.stop();
    const stopping = await record("stopping");
    assert.equal(stopping.startedAt, pending.startedAt);
    assert.ok(stopping.stoppingAt);
    assert.deepEqual(await record("pre-stop"), stopping, "a retry must not reopen committed stop");
    const laterMaintenance = await enqueueMaintenance(fixture, owner, first);
    await fixture.start(driver.compute);
    await fixture.work(laterMaintenance, "succeeded");
    assert.equal(driver.preparations(first), before, "maintenance must not recreate stopped work");
  },
);

revisionTest(
  "new admission cannot revive a legacy predecessor after its replacement stopped it",
  async (fixture) => {
    const owner = await fixture.agent("legacy-stop-adoption", { executionMode: "dedicated" });
    const driver = countingExclusiveCompute(fixture, {
      ready: (revision) => revision.revision !== 2,
    });
    const compute = { ...driver.compute, id: "compute-legacy-stop-adoption" };
    fixture.controller.registerDriver(compute);
    fixture.controller.selectDriver("compute", compute.id);
    const admittedCompute = { id: compute.id, implementation: compute.implementation };
    await fixture.start(compute, { convergenceTimeoutMs: 1_000 });
    const first = await fixture.revision(owner, 1, { compute: admittedCompute });
    await fixture.work(first, "succeeded");
    const second = await fixture.revision(owner, 2, { compute: admittedCompute });
    await fixture.work(second, "failed_permanent");
    await fixture.stop();
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, first.id);
    assert.deepEqual([...driver.running], [second.id]);
    // Migration adds NULL to the legacy state: R1 remains selected, but R2
    // already stopped it and retained its own runtime for diagnosis.
    await fixture.observerPool.query(
      "UPDATE occ.agents SET predecessor_replacement = NULL WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, owner.id],
    );
    const configuration = await fixture.controller.createConfiguration(fixture.actor.id, {
      namespaceId: fixture.namespace.id,
      kind: "agent",
      values: createHarnessConfiguration("codex", "gpt-4.1"),
    });
    await fixture.controller.updateAgent(fixture.actor.id, {
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      configurationId: configuration.id,
      gatewayManagedMode: false,
    });
    const third = await fixture.controller.deployAgent(
      fixture.actor.id,
      { namespaceId: fixture.namespace.id, agentId: owner.id },
      resolveApprovedHarness,
    );
    const adopted = await fixture.state.read((view) =>
      view.agents.findPredecessorReplacement(fixture.namespace.id, owner.id),
    );
    assert.notEqual(
      adopted?.phase,
      "pre-stop",
      "unknown legacy stop history must not reopen the serving boundary",
    );
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() + interval '1 hour' WHERE revision_id = $1",
      [third.id],
    );
    const before = driver.preparations(first);
    const maintenance = await enqueueMaintenance(fixture, owner, first);
    await fixture.start(compute);
    await fixture.work(maintenance, "succeeded");
    assert.equal(
      driver.preparations(first),
      before,
      "the absent legacy record is not proof that R1 still serves",
    );
    assert.deepEqual([...driver.running], [second.id]);
  },
);

revisionTest(
  "exclusive replacement stops each predecessor once across pending passes and maintenance",
  async (fixture) => {
    const owner = await fixture.agent("exclusive-sweep-once", { executionMode: "dedicated" });
    let pendingPasses = 4;
    const driver = countingExclusiveCompute(fixture, {
      ready: (revision) => revision.revision !== 2 || pendingPasses-- <= 0,
    });
    await fixture.start(driver.compute);
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    const replacement = await fixture.revision(owner, 2);
    await fixture.work(replacement, "succeeded", 30_000);
    assert.ok(driver.preparations(replacement) >= 5, "the replacement must repeat pending passes");
    // Exactly one stop holds because the fixture lease (30 s) outlasts this pending
    // window; with a shorter lease the scheduled re-stop would add more.
    assert.equal(driver.count(first), 1, "pending passes must not repeat the predecessor stop");

    for (let index = 0; index < 2; index += 1) {
      await fixture.work(await enqueueMaintenance(fixture, owner, replacement), "succeeded");
    }
    assert.equal(driver.count(first), 1, "maintenance must not repeat the predecessor stop");

    const recovery = await fixture.revision(owner, 3);
    await fixture.work(recovery, "succeeded");
    assert.equal(driver.count(replacement), 1);
    assert.equal(driver.count(first), 1, "a recorded predecessor is skipped by later sweeps");
    assert.deepEqual([...driver.running], [recovery.id]);
  },
  { timeout: 60_000 },
);

// Finding 2040 (D28): an exclusive predecessor's stop goes through the Sandbox gateway (its
// Sandbox deletion detaches its credentials). While the gateway is down, the stop answers gRPC
// UNAVAILABLE, so the redeploy waits within the deadline instead of spending its attempt budget,
// with the candidate untouched and the predecessor still recorded active; the next pass repeats
// the stop. The outage holds until the test has seen more stops than the attempt budget (5).
revisionTest(
  "a Sandbox gateway outage during an exclusive predecessor's stop waits, then the redeploy activates",
  async (fixture) => {
    const owner = await fixture.agent("exclusive-gateway-outage", { executionMode: "dedicated" });
    const driver = countingExclusiveCompute(fixture);
    let held = false;
    let failedStops = 0;
    const events = [];
    await fixture.start(
      {
        ...driver.compute,
        async stopRevision(revision) {
          if (held) {
            failedStops += 1;
            throw new SandboxGatewayUnavailableError(
              "OpenShell GetSandbox failed with gRPC status 14.",
            );
          }
          return driver.compute.stopRevision(revision);
        },
      },
      { emit: (event) => events.push(event) },
    );
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    held = true;
    const replacement = await fixture.revision(owner, 2);
    const waited = await waitFor(
      "more predecessor stops against the stopped gateway than the attempt budget",
      async () => {
        const work = await fixture.observerPool.query(
          "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
          [replacement.idempotencyKey],
        );
        assert.notEqual(work.rows[0]?.state, "failed_permanent", "the outage spent the budget");
        return failedStops > 7 && work.rows[0]?.state === "queued" ? work.rows[0] : undefined;
      },
      30_000,
    );
    assert.equal(waited.attempt_count, 0);
    assert.equal(driver.preparations(replacement), 0, "the candidate waits for the stop");
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, first.id);
    held = false;

    const succeeded = await fixture.work(replacement, "succeeded", 30_000);
    assert.equal(succeeded.attempt_count, 1);
    assert.equal(driver.count(first), 1);
    assert.deepEqual([...driver.running], [replacement.id]);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, replacement.id);
    const outagePasses = events.filter(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === replacement.id &&
        event.outcome !== "success",
    );
    assert.ok(outagePasses.length > 7, `saw ${outagePasses.length} outage passes`);
    assert.deepEqual(
      new Set(
        outagePasses.map(({ outcome, code, dependency, cause }) =>
          JSON.stringify({ outcome, code, dependency, cause }),
        ),
      ),
      new Set([
        JSON.stringify({
          outcome: "pending",
          code: "SANDBOX_GATEWAY_UNAVAILABLE",
          dependency: "sandbox_gateway",
          cause: "unavailable",
        }),
      ]),
    );
  },
  { timeout: 60_000 },
);

// Finding 990: exclusive replacement stops the active revision before its candidate's first
// pass. On Kubernetes the candidate then took over the Agent's Gateway, so when a later pass
// refused it because its actor lost `deploy`, its Pods kept answering chat with a deployment
// OCC had rejected while the recorded active revision had no workload. A refused candidate is
// stopped before its failure is published. A runtime that failed by itself (here a held model
// probe) keeps its Pods for diagnosis on its version's Logs tab. Either way the pointer still
// names the stopped predecessor: OCC never rolls back, and recovery is a new revision.
// "unsupported" is a refusal thrown by the pass itself rather than decided by its observation.
// A candidate that missed the convergence deadline or exhausted its retries failed by itself too.
const selfFailures = {
  held: "RUNTIME_MODEL_PROBE_FAILED",
  late: "CONVERGENCE_DEADLINE_EXCEEDED",
  retried: "DEPENDENCY_UNAVAILABLE",
};
for (const { failure, stopFailures = 0, convergenceTimeoutMs, maxAttempts } of [
  { failure: "revoked" },
  // A failed stop must not publish the refusal with the candidate still running: the work
  // waits, repeats the refusal and the stop, and the refusal keeps its code.
  { failure: "revoked", stopFailures: 1 },
  { failure: "unsupported", stopFailures: 1 },
  // A stop outage outlasts the attempt budget (here 2) and the convergence deadline: ending the
  // work then would leave the refused candidate serving with nothing left to stop it.
  { failure: "revoked", stopFailures: 3, convergenceTimeoutMs: 2_000, maxAttempts: 2 },
  { failure: "held" },
  { failure: "late", convergenceTimeoutMs: 2_000 },
  { failure: "retried", maxAttempts: 2 },
]) {
  const refused = failure in refusals;
  test(
    `a ${failure} exclusive candidate ${refused ? "is stopped" : "stays for diagnosis"} when its deployment fails${stopFailures === 0 ? "" : ` after ${stopFailures} failed stops`}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await setup(context, maxAttempts === undefined ? {} : { maxAttempts });
      const events = [];
      const stop = failingStop({ limit: stopFailures });
      // The candidate's first pass starts its runtime but is not ready yet.
      const { owner, first, replacement, driver, admittedAt } = await startRefusedCandidate(
        fixture,
        `exclusive-failed-${failure}`,
        {
          refuse: failure,
          emit: (event) => events.push(event),
          stopRevision: stop.stopRevision,
          startOptions: convergenceTimeoutMs === undefined ? {} : { convergenceTimeoutMs },
        },
      );
      await fixture.work(replacement, "failed_permanent", 30_000);
      assert.equal(stop.failed.length, stopFailures);
      if (convergenceTimeoutMs !== undefined) {
        assert.ok(
          Date.now() - admittedAt > convergenceTimeoutMs,
          "the work outlasted the deadline",
        );
      }
      const result = await fixture.workResult(replacement);
      assert.equal(result.rows[0].reason_code, refusals[failure] ?? selfFailures[failure]);
      // A thrown pass forgets the sweep record, so the retry repeats the idempotent stop. A
      // refusal whose stop failed retries only that stop, without sweeping again (finding 1034).
      const predecessorStops =
        failure === "retried" || (failure === "unsupported" && stopFailures === 0) ? 2 : 1;
      assert.equal(driver.count(first), predecessorStops, "replacement stopped the predecessor");
      if (refused) {
        assert.equal(driver.count(replacement), 1, "the refused candidate is stopped once");
        assert.deepEqual([...driver.running], [], "nothing serves the Agent");
        const waited = events.filter(
          ({ event, workId, refusal }) =>
            event === "worker.completed" &&
            workId === replacement.idempotencyKey &&
            refusal === refusals[failure],
        );
        assert.deepEqual(
          waited.map(({ outcome, code }) => [outcome, code]),
          Array.from({ length: stopFailures }, () => ["pending", "REFUSED_CANDIDATE_STOP_PENDING"]),
        );
      } else {
        assert.equal(driver.count(replacement), 0, "the failed runtime stays for diagnosis");
        assert.deepEqual([...driver.running], [replacement.id]);
      }
      const active = await fixture.activePointer(owner);
      assert.equal(active.rows[0].active_revision_id, first.id);
      if (failure === "unsupported") {
        // The refused stop counts as a sweep: the next deployment does not repeat it within the
        // lease (30 s here). Only this refusal leaves the Agent deployable; revoked keeps its deny.
        const recovery = await fixture.revision(owner, 3);
        await fixture.work(recovery, "succeeded");
        assert.equal(driver.count(replacement), 1, "the next sweep skips the stopped candidate");
      }
    },
  );
}

// Finding 1016: without exclusive replacement (Kubernetes declares it only for dedicated
// Harnesses; Docker and SSH not at all) a refused candidate was never stopped. On a first
// deployment it is the Agent's only runtime: on Kubernetes its embedded Gateway Pod kept its model
// key, secret environment and private state until a later deployment, stop or delete. It is now
// stopped before the refusal is published, waiting on a failed stop like an exclusive candidate.
// Beside an active revision a refused candidate is left alone: on Kubernetes the active revision
// keeps serving, and an embedded candidate may own the Agent's shared Gateway route, which its stop
// would delete. The next deployment retires it. (On Docker the candidate's preparation already
// replaced the Agent's gateway container; that redeploy shape is tracked separately.) A refusal
// decided before the work's first preparation leaves Compute untouched; see the Secret Driver and
// ServiceAccount issuance refusals in postgres-worker-agent-revision.test.mjs. "revoked" refuses on
// the second pass, before Compute, so only the first pass's recorded evidence shows the candidate
// was prepared; "unsupported" is refused by Compute itself on the first pass, before any evidence.
const sharedRefusals = {
  revoked: "AUTHORIZATION_DENIED",
  unsupported: "SANDBOX_HARNESS_UNSUPPORTED",
};
for (const { declares, shape, stopFailures = 0, refusal = "revoked" } of [
  { declares: true, shape: "first" },
  { declares: true, shape: "first", stopFailures: 1 },
  { declares: true, shape: "redeploy" },
  { declares: false, shape: "first" },
  { declares: false, shape: "first", refusal: "unsupported" },
  { declares: false, shape: "redeploy" },
]) {
  const compute = declares ? "embedded Kubernetes-style" : "undeclared (Docker or SSH)";
  const code = sharedRefusals[refusal];
  test(
    `${refusal === "unsupported" ? "an" : "a"} ${refusal} ${shape === "first" ? "first deployment" : "redeploy"} on ${compute} Compute ${shape === "first" ? "is stopped" : "is not stopped"}${stopFailures === 0 ? "" : ` after ${stopFailures} failed stop`}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await setup(context);
      const owner = await fixture.agent(`shared-${refusal}-${shape}-${declares}-${stopFailures}`);
      let candidateId;
      let candidatePasses = 0;
      let failedStops = 0;
      const running = new Set();
      const stops = new Map();
      const retires = new Map();
      const counted = (counts, revision) => counts.get(revision.id) ?? 0;
      const events = [];
      const effects = [];
      await fixture.start(
        {
          ...fixture.compute,
          async bindAgent(binding) {
            effects.push("bind");
            await fixture.compute.bindAgent?.(binding);
          },
          // Kubernetes declares exclusive replacement only for dedicated Harnesses.
          ...(declares
            ? { requiresStoppedPredecessors: (revision) => revision.harness.mode === "dedicated" }
            : {}),
          async prepareRevision(revision) {
            effects.push("prepare");
            running.add(revision.id);
            const observed = await fixture.compute.prepareRevision(revision);
            if (revision.id !== candidateId) {
              return observed;
            }
            candidatePasses += 1;
            if (refusal === "unsupported") {
              // Compute started the runtime, then refused the revision in the same pass.
              throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", "test");
            }
            if (candidatePasses === 1) {
              // The actor loses deploy authority after the candidate's runtime started; the
              // worker's recheck on the next pass refuses the deployment.
              await denyDeploy(fixture, owner);
            }
            return { ...observed, ready: false };
          },
          async stopRevision(revision) {
            effects.push("stop");
            if (revision.id === candidateId && failedStops < stopFailures) {
              failedStops += 1;
              throw new Error("Kubernetes API temporarily unavailable");
            }
            stops.set(revision.id, counted(stops, revision) + 1);
            running.delete(revision.id);
          },
          async retireRevision(revision) {
            retires.set(revision.id, counted(retires, revision) + 1);
            running.delete(revision.id);
          },
        },
        { emit: (event) => events.push(event) },
      );
      let first;
      if (shape === "redeploy") {
        first = await fixture.revision(owner, 1);
        await fixture.work(first, "succeeded");
      }
      const candidate = await fixture.revision(owner, shape === "first" ? 1 : 2);
      candidateId = candidate.id;
      await assertWorkEnds(fixture, candidate, "failed_permanent", code);
      assert.equal(failedStops, stopFailures);
      const active = await fixture.activePointer(owner);
      if (shape === "first") {
        assert.equal(active.rows[0].active_revision_id, null);
        assert.equal(counted(stops, candidate), 1, "the refused first deployment is stopped once");
        assert.deepEqual([...running], [], "nothing runs for the Agent");
        // Like Agent stop and retirement, each try binds the Agent first, even when this pass
        // refused before Compute and never bound it.
        assert.ok(
          effects.every((effect, index) => effect !== "stop" || effects[index - 1] === "bind"),
          effects.join(","),
        );
        // A failed stop publishes nothing: the work waits and keeps the refusal's code.
        const waited = events.filter(
          ({ event, workId, refusal }) =>
            event === "worker.completed" && workId === candidate.idempotencyKey && refusal === code,
        );
        assert.deepEqual(
          waited.map(({ outcome, code }) => [outcome, code]),
          Array.from({ length: stopFailures }, () => ["pending", "REFUSED_CANDIDATE_STOP_PENDING"]),
        );
      } else {
        assert.equal(active.rows[0].active_revision_id, first.id);
        assert.equal(counted(stops, candidate), 0, "the refused redeploy is not stopped");
        assert.equal(counted(stops, first) + counted(retires, first), 0, "the predecessor serves");
        assert.ok(running.has(first.id), "the predecessor still runs");
      }
    },
  );
}

test(
  "a predecessor that comes back after the sweep is stopped again",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    for (const { leaseDurationMs, label, returns } of [
      // A late Compute effect makes the next pass fail, which forgets the record.
      { leaseDurationMs: 30_000, label: "failed-pass", returns: 1 },
      // A late effect keeps the candidate pending until one lease has elapsed.
      { leaseDurationMs: 1_000, label: "lease-restop", returns: 1 },
      // It comes back again after that re-stop; the next one follows two leases later.
      { leaseDurationMs: 1_000, label: "repeated-restop", returns: 2 },
    ]) {
      const fixture = await setup(context, { leaseDurationMs });
      const owner = await fixture.agent(`exclusive-resurrection-${label}`, {
        executionMode: "dedicated",
      });
      let first;
      let resurrections = 0;
      const driver = countingExclusiveCompute(fixture, {
        async onPrepare(revision, overlap) {
          if (revision.revision !== 2) {
            return;
          }
          if (resurrections < returns && driver.count(first) > resurrections) {
            // Model a lost claim's late Compute write landing after each stop.
            resurrections += 1;
            driver.running.add(first.id);
          } else if (overlap.length > 0 && label === "failed-pass") {
            driver.running.delete(revision.id);
            throw new Error("predecessor still holds the exclusive resource");
          }
        },
      });
      await fixture.start(driver.compute);
      first = await fixture.revision(owner, 1);
      await fixture.work(first, "succeeded");
      const replacement = await fixture.revision(owner, 2);
      await fixture.work(replacement, "succeeded", 30_000);
      assert.equal(resurrections, returns);
      assert.equal(
        driver.count(first),
        returns + 1,
        `${label}: the returned predecessor is stopped again`,
      );
      assert.deepEqual([...driver.running], [replacement.id]);
      const current = await fixture.currentAgent(owner);
      assert.equal(current.activeRevisionId, replacement.id);
      await fixture.stop();
    }
  },
);

// Finding 1041: an error in a waiting pass's first reads (its resources, or the stored refusal
// itself) was recorded as an ordinary retry. It spent an attempt, and its evidence hid the stored
// refusal, so the next pass prepared the candidate again; at the attempt limit the work failed
// DEPENDENCY_UNAVAILABLE with the candidate running and the refusal lost. The pass now reads the
// stored refusal again and retries its stop. If that read fails too, the claim is left to lease
// recovery, which keeps the refusal.
test(
  "a refused candidate's wait survives failures reading its stored refusal",
  { ...requiresPostgres, timeout: 120_000 },
  async (context) => {
    // Two attempts: on main the second failed read ended the work.
    const fixture = await setup(context, { maxAttempts: 2 });
    const events = [];
    let failedStops = 0;
    let stopping = false;
    let readFailures = 0;
    let injected = 0;
    const queue = fixture.PostgresWorkQueue.prototype;
    const findWorkAttempt = queue.findWorkAttempt;
    queue.findWorkAttempt = function (...args) {
      if (readFailures > 0 && new Error().stack.includes("readRefusalWait")) {
        readFailures -= 1;
        injected += 1;
        return Promise.reject(new Error("canceling statement due to statement timeout"));
      }
      return findWorkAttempt.apply(this, args);
    };
    try {
      const { replacement, driver } = await startRefusedCandidate(fixture, "refused-wait-read", {
        refuse: "unsupported",
        emit: (event) => events.push(event),
        stopRevision: () => {
          if (stopping) {
            return undefined;
          }
          failedStops += 1;
          return Promise.reject(new Error("Pods did not terminate before the deadline"));
        },
      });
      await waitFor("two failed refused stops", async () => (failedStops >= 2 ? true : undefined));
      // The waits below make the candidate's queued stop retry due instead of waiting out its
      // doubling backoff; the worker still claims and runs every pass.
      // One failed read: the same pass reads the refusal again and retries the stop.
      let before = failedStops;
      readFailures = 1;
      await waitForWorkPass(
        "a failed read, then the stop retried",
        fixture,
        replacement,
        async () => (injected >= 1 && failedStops >= before + 1 ? true : undefined),
        30_000,
      );
      // Both reads fail: the pass leaves its claim, and lease recovery keeps the refusal.
      readFailures = 2;
      await waitForWorkPass(
        "two failed reads in one pass",
        fixture,
        replacement,
        async () => {
          const ended = await fixture.workResult(replacement);
          assert.equal(ended.rows[0].reason_code, null, "the wait ended");
          const left = events.some(
            ({ event, code, workId }) =>
              event === "worker.error" &&
              code === "WORKER_UNAVAILABLE" &&
              workId === replacement.idempotencyKey,
          );
          return injected >= 3 && left ? true : undefined;
        },
        30_000,
      );
      const claimed = await fixture.observerPool.query(
        "SELECT claim_token FROM occ.controller_work WHERE idempotency_key = $1 AND state = 'claimed'",
        [replacement.idempotencyKey],
      );
      assert.equal(claimed.rowCount, 1, "the failed pass left its claim");
      before = failedStops;
      await fixture.expireClaim(replacement, claimed.rows[0].claim_token);
      await waitForWorkPass(
        "the recovered wait retries the stop",
        fixture,
        replacement,
        async () => (failedStops >= before + 1 ? true : undefined),
        30_000,
      );
      stopping = true;
      await waitForWorkStateDue(fixture, replacement, "failed_permanent");
      const result = await fixture.workResult(replacement);
      assert.equal(result.rows[0].reason_code, "SANDBOX_HARNESS_UNSUPPORTED");
      assert.equal(driver.count(replacement), 1, "the refused candidate was stopped");
      assert.deepEqual([...driver.running], []);
      assert.equal(driver.preparations(replacement), 2, "no wait prepared the candidate again");
      const evidence = await fixture.observerPool.query(
        `SELECT details->>'reasonCode' AS code, details->>'refusal' AS refusal
           FROM occ.audit_events WHERE details->>'workId' = $1 ORDER BY occurred_at, id`,
        [replacement.idempotencyKey],
      );
      const codes = evidence.rows.map(({ code, refusal }) => `${code}:${refusal ?? ""}`);
      assert.ok(codes.includes("LEASE_EXPIRED:SANDBOX_HARNESS_UNSUPPORTED"), codes.join(" "));
      assert.ok(!codes.some((code) => code.startsWith("DEPENDENCY_UNAVAILABLE")), codes.join(" "));
    } finally {
      queue.findWorkAttempt = findWorkAttempt;
    }
  },
);

// Finding 1042: an authorization or backend refusal that lifted after the convergence deadline
// prepared its waiting candidate again, and the deadline then ended the work with that candidate
// running beside the stopped predecessor the active pointer still named. Past the deadline the
// lift now stops the candidate and publishes the deadline, waiting like a refusal if the stop
// fails.
test(
  "an authorization refusal lifted past the deadline stops its candidate",
  { ...requiresPostgres, timeout: 120_000 },
  async (context) => {
    const fixture = await setup(context);
    const events = [];
    let failedStops = 0;
    let lifted = false;
    let liftedAt = 0;
    let failedAfterLift = 0;
    let admitted = Infinity;
    let preparations;
    let scenario;
    scenario = await startRefusedCandidate(fixture, "refused-lifts-late", {
      refuse: "iam",
      emit: (event) => events.push(event),
      // On main the pass after the grant prepared it again, and it became ready too late.
      candidateReady: () => lifted && Date.now() - liftedAt > 1_500,
      stopRevision: () => {
        if (lifted && failedAfterLift >= 2) {
          return undefined;
        }
        failedStops += 1;
        if (lifted) {
          failedAfterLift += 1;
        } else if (failedStops >= 2 && Date.now() - admitted > 3_000) {
          // Granted during this pass's stop, after its denial: the next pass sees the grant.
          lifted = true;
          liftedAt = Date.now();
          preparations = scenario.driver.preparations(scenario.replacement);
        }
        return Promise.reject(new Error("Kubernetes API temporarily unavailable"));
      },
      startOptions: {
        convergenceTimeoutMs: 2_000,
        transformDrivers: proxiedIAM(async (iam, request) => {
          const decision = await iam.authorize(request);
          const denied =
            !lifted &&
            request.action === "deploy" &&
            scenario !== undefined &&
            scenario.driver.preparations(scenario.replacement) > 0;
          return denied ? { ...decision, allowed: false } : decision;
        }),
      },
    });
    const { owner, first, replacement, driver } = scenario;
    admitted = Date.now();
    await waitFor("the grant past the deadline", async () => (lifted ? true : undefined), 30_000);
    // The passes after the grant retry the failed stop on its doubling backoff (about 4, 8 and
    // 16 s here). Make each queued retry due instead of waiting it out: the worker still claims
    // and runs every pass, and the deadline had already passed at the grant.
    await waitForWorkPass(
      "a wait on the deadline",
      fixture,
      replacement,
      async () =>
        refusedStopWaits(events, replacement).some(
          ({ refusal }) => refusal === "CONVERGENCE_DEADLINE_EXCEEDED",
        )
          ? true
          : undefined,
      30_000,
    );
    const waiting = await fixture.deploymentStatus(owner, replacement);
    assert.equal(waiting.progress.lastAttempt.code, "REFUSED_CANDIDATE_STOP_PENDING");
    assert.equal(
      waiting.progress.lastAttempt.message,
      "Deployment missed its convergence deadline; stopping the candidate before recording the failure. The controller will retry.",
    );
    await waitForWorkStateDue(fixture, replacement, "failed_permanent");
    const result = await fixture.workResult(replacement);
    assert.equal(result.rows[0].reason_code, "CONVERGENCE_DEADLINE_EXCEEDED");
    assert.deepEqual(result.rows[0].result_data, { timeoutMs: 2_000 });
    assert.equal(driver.preparations(replacement), preparations, "not prepared after the grant");
    assert.equal(failedAfterLift, 2);
    assert.equal(driver.count(replacement), 1, "the candidate was stopped");
    assert.ok(!driver.running.has(replacement.id));
    assert.ok(!driver.running.has(first.id), "the sweep had stopped the predecessor");
    const active = await fixture.activePointer(owner);
    assert.equal(active.rows[0].active_revision_id, first.id);
    // The waits after the grant name the deadline they will publish.
    const waits = refusedStopWaits(events, replacement).map(({ refusal }) => refusal);
    const lateWaits = waits.slice(waits.indexOf("CONVERGENCE_DEADLINE_EXCEEDED"));
    assert.deepEqual(lateWaits, ["CONVERGENCE_DEADLINE_EXCEEDED", "CONVERGENCE_DEADLINE_EXCEEDED"]);
  },
);

// Finding 3066: shared Compute keeps one runtime per Agent (the embedded Kubernetes Gateway
// Deployment). A newer candidate takes it over, and the Kubernetes Driver then reports the older
// version not ready: it never rolls the Deployment back. The older version was superseded only
// once the newer one activated. When the newer one failed (a double Deploy whose second version
// fails its startup model check), the older one polled for the whole convergence deadline and
// failed CONVERGENCE_DEADLINE_EXCEEDED, though its runtime was gone.
// This Compute models that Gateway: a version writes it unless it carries a later version, and,
// as on Kubernetes, stopping a version deletes it only while that version holds it. `outcomes`
// sets a version's readiness once it holds the Gateway: "pending" (the default), "ready",
// "probe-failed" (a held model-probe failure), or "refused" (Compute refuses every pass after
// the first, which wrote the Gateway). A dedicated version also starts its own Harness
// (`harnesses`), which only its stop or retirement removes; `stops` counts stops per version.
// A promise in `gates` holds the next pass of the version with that number until it settles.
// `failingStops` maps a version ID to the number of its next stops that throw before acting.
function sharedGatewayCompute(fixture) {
  const gateway = new Map();
  const passes = new Map();
  const outcomes = new Map();
  const removedBy = [];
  const harnesses = new Set();
  const stops = new Map();
  const gates = new Map();
  const failingStops = new Map();
  const compute = {
    ...fixture.compute,
    // Kubernetes declares exclusive replacement only for dedicated Harnesses.
    requiresStoppedPredecessors: (revision) => revision.harness.mode === "dedicated",
    async prepareRevision(revision) {
      const gate = gates.get(revision.revision);
      if (gate !== undefined) {
        gates.delete(revision.revision);
        await gate;
      }
      const pass = (passes.get(revision.id) ?? 0) + 1;
      passes.set(revision.id, pass);
      const observed = await fixture.compute.prepareRevision(revision);
      const outcome = outcomes.get(revision.id) ?? "pending";
      if (outcome === "refused" && pass > 1) {
        throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", "test");
      }
      if (revision.revision < (gateway.get(revision.agentId) ?? 0)) {
        return { ...observed, ready: false };
      }
      gateway.set(revision.agentId, revision.revision);
      if (revision.harness.mode === "dedicated") {
        harnesses.add(revision.id);
      }
      if (outcome === "ready") {
        return observed;
      }
      return {
        ...observed,
        ready: false,
        ...(outcome === "probe-failed"
          ? {
              runtimeFailure: {
                component: "gateway",
                check: "model-probe",
                checkedAt: "2026-10-31T20:09:54.000Z",
                code: "MODEL_PROBE_FAILED",
                cause: { kind: "PROBE_STATUS", detail: "rate_limit" },
              },
            }
          : {}),
      };
    },
    async stopRevision(revision) {
      const failing = failingStops.get(revision.id) ?? 0;
      if (failing > 0) {
        failingStops.set(revision.id, failing - 1);
        throw new Error("Kubernetes API temporarily unavailable");
      }
      await fixture.compute.stopRevision(revision);
      stops.set(revision.id, (stops.get(revision.id) ?? 0) + 1);
      harnesses.delete(revision.id);
      if (gateway.get(revision.agentId) === revision.revision) {
        gateway.delete(revision.agentId);
        removedBy.push(revision.id);
      }
    },
    async retireRevision(revision) {
      await fixture.compute.retireRevision(revision);
      harnesses.delete(revision.id);
    },
  };
  return {
    compute,
    gateway,
    outcomes,
    removedBy,
    harnesses,
    gates,
    failingStops,
    passes: (revision) => passes.get(revision.id) ?? 0,
    stops: (revision) => stops.get(revision.id) ?? 0,
  };
}

async function workState(fixture, work) {
  const rows = await fixture.observerPool.query(
    "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
    [work.idempotencyKey],
  );
  return rows.rows[0].state;
}

// An older version that holds the Agent's shared Gateway and is not ready yet.
async function pendingOlderVersion(fixture, label, driver, options = {}) {
  const owner = await fixture.agent(label);
  const older = await fixture.revision(owner, 1, options);
  await waitFor("the older version's first preparation", async () =>
    driver.passes(older) > 0 ? true : undefined,
  );
  return { owner, older };
}

// Each case below runs with an older shared (embedded) version and with an older exclusive
// (dedicated) one, as when the Agent switched from dedicated to embedded execution between two
// deploys. The newer versions are always embedded. Kubernetes declares exclusive replacement only
// for dedicated Harnesses, so an exclusive older version is decided by the successor check: it
// first finishes its predecessor stops, then stops its own Harness, which the newer embedded
// version never stops (finding 3068).
const olderShapes = {
  shared: {},
  exclusive: { harness: { id: "openclaw", version: "1.0.0", mode: "dedicated" } },
};

for (const [shape, options] of Object.entries(olderShapes)) {
  revisionTest(
    `an older ${shape} version overtaken by a newer version that fails is superseded at once`,
    async (fixture) => {
      const driver = sharedGatewayCompute(fixture);
      // The default 15-minute deadline: on main the older version stayed pending past this test.
      await fixture.start(driver.compute);
      const { owner, older } = await pendingOlderVersion(
        fixture,
        `${shape}-overtaken`,
        driver,
        options,
      );
      assert.equal(driver.harnesses.has(older.id), shape === "exclusive");
      const newer = await fixture.revision(owner, 2);
      driver.outcomes.set(newer.id, "probe-failed");
      await assertWorkEnds(fixture, newer, "failed_permanent", "RUNTIME_MODEL_PROBE_FAILED");
      const olderPasses = driver.passes(older);
      // Versions of one Agent serialize, so the older version's next pass follows the newer
      // version's failure. It ends superseded before Compute prepares it again.
      await assertWorkEnds(fixture, older, "succeeded", "REVISION_SUPERSEDED");
      assert.equal(driver.passes(older), olderPasses, "no preparation after the newer one failed");
      assert.equal(driver.gateway.get(owner.id), newer.revision, "the newer version keeps it");
      assert.deepEqual(driver.removedBy, [], "the newer version's Gateway stays for diagnosis");
      // Nothing routes to the exclusive version's Harness any more, and the embedded version
      // never stops it, so the superseded version stops it itself.
      assert.equal(driver.stops(older), shape === "exclusive" ? 1 : 0);
      assert.deepEqual([...driver.harnesses], []);
      const active = await fixture.activePointer(owner);
      assert.equal(active.rows[0].active_revision_id, null);
      const superseded = await fixture.observerPool.query(
        `SELECT details->>'activeRevisionId' AS successor FROM occ.audit_events
         WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.supersede'`,
        [older.id],
      );
      assert.deepEqual(superseded.rows, [{ successor: newer.id }]);
      // The Versions list shows the older version superseded (neutral in the console), not a
      // deadline failure that points at logs it never had.
      const listed = await fixture.controller.listRevisions(
        fixture.actor.id,
        fixture.namespace.id,
        owner.id,
      );
      assert.deepEqual(
        listed.revisions.map(({ id, deploymentErrorCode }) => [id, deploymentErrorCode]),
        [
          [newer.id, "RUNTIME_MODEL_PROBE_FAILED"],
          [older.id, "REVISION_SUPERSEDED"],
        ],
      );
    },
  );

  revisionTest(
    `an older ${shape} version waits while the newer version is pending and ends superseded once it activates`,
    async (fixture) => {
      const driver = sharedGatewayCompute(fixture);
      await fixture.start(driver.compute);
      const { owner, older } = await pendingOlderVersion(
        fixture,
        `${shape}-newer-pending`,
        driver,
        options,
      );
      const newer = await fixture.revision(owner, 2);
      await waitFor("the newer version's preparation", async () =>
        driver.passes(newer) > 0 ? true : undefined,
      );
      // A pending newer version may still fail or activate: the older one keeps waiting.
      const waited = driver.passes(older);
      await waitFor("three older passes while the newer version is pending", async () =>
        driver.passes(older) >= waited + 3 ? true : undefined,
      );
      assert.notEqual(await workState(fixture, older), "succeeded");
      assert.notEqual(await workState(fixture, older), "failed_permanent");
      assert.equal(driver.stops(older), 0);
      // Once it activates, the active pointer supersedes the older version, as before, and the
      // activation retires it.
      driver.outcomes.set(newer.id, "ready");
      await fixture.work(newer, "succeeded");
      await assertWorkEnds(fixture, older, "succeeded", "REVISION_SUPERSEDED");
      const active = await fixture.activePointer(owner);
      assert.equal(active.rows[0].active_revision_id, newer.id);
      assert.deepEqual([...driver.harnesses], []);
    },
  );

  // Only the newest version counts: a still newer one may have replaced or removed the runtime.
  // Here it is refused before Compute, so the held Gateway stays, yet the older version keeps
  // its main behavior and ends at its deadline.
  revisionTest(
    `an older ${shape} version is not superseded through a held version that is not the newest`,
    async (fixture) => {
      const driver = sharedGatewayCompute(fixture);
      const events = [];
      await fixture.start(driver.compute, {
        convergenceTimeoutMs: 6_000,
        emit: (event) => events.push(event),
      });
      const { owner, older } = await pendingOlderVersion(
        fixture,
        `${shape}-not-newest`,
        driver,
        options,
      );
      // Hold the second version's first pass until a third version is admitted.
      let release;
      driver.gates.set(
        2,
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const newer = await fixture.revision(owner, 2);
      await waitFor("the second version's held pass", async () =>
        driver.gates.has(2) ? undefined : true,
      );
      const requester = `not-newest-requester-${randomUUID()}`;
      await fixture.copyActorGrants(requester, { withoutActions: ["deploy"] });
      const newest = await fixture.revision(owner, 3, { actorId: requester });
      driver.outcomes.set(newer.id, "probe-failed");
      release();
      await assertWorkEnds(fixture, newer, "failed_permanent", "RUNTIME_MODEL_PROBE_FAILED");
      await assertWorkEnds(fixture, newest, "failed_permanent", "AUTHORIZATION_DENIED");
      assert.equal(driver.gateway.get(owner.id), newer.revision);
      // The older version was checked after the held failure, before its deadline...
      const failedAt = events.findIndex(
        ({ event, workId }) => event === "worker.completed" && workId === newer.idempotencyKey,
      );
      await waitFor("an older pass after the held failure", async () =>
        events
          .slice(failedAt)
          .some(
            ({ event, workId, outcome }) =>
              event === "worker.completed" &&
              workId === older.idempotencyKey &&
              outcome === "pending",
          )
          ? true
          : undefined,
      );
      // ...and still ends at it, with its Harness left as on main.
      await assertWorkEnds(fixture, older, "failed_permanent", "CONVERGENCE_DEADLINE_EXCEEDED");
      assert.equal(driver.stops(older), 0);
      assert.equal(driver.harnesses.has(older.id), shape === "exclusive");
    },
  );

  // The three controls below keep the older version's main behavior when the newer version
  // ended without leaving its runtime in place. Superseding the older version there would leave
  // its running Gateway with no active version (findings 990 and 1016), or the Agent with
  // nothing.
  revisionTest(
    `an older ${shape} version still activates after a newer version is refused before Compute`,
    async (fixture) => {
      const driver = sharedGatewayCompute(fixture);
      await fixture.start(driver.compute);
      const { owner, older } = await pendingOlderVersion(
        fixture,
        `${shape}-refused-early`,
        driver,
        options,
      );
      // The newer version's deployer lacks `deploy`, so the worker refuses it before Compute.
      // It never writes the Gateway, and with no preparation there is nothing to stop.
      const requester = `refused-early-requester-${randomUUID()}`;
      await fixture.copyActorGrants(requester, { withoutActions: ["deploy"] });
      const newer = await fixture.revision(owner, 2, { actorId: requester });
      await assertWorkEnds(fixture, newer, "failed_permanent", "AUTHORIZATION_DENIED");
      assert.equal(driver.passes(newer), 0, "the refused version never reached Compute");
      assert.equal(driver.gateway.get(owner.id), older.revision);
      // The older version still holds the Gateway and activates once it is ready.
      driver.outcomes.set(older.id, "ready");
      await fixture.work(older, "succeeded");
      const active = await fixture.activePointer(owner);
      assert.equal(active.rows[0].active_revision_id, older.id);
      assert.equal(driver.stops(older), 0);
    },
  );

  revisionTest(
    `an older ${shape} version still activates after a newer first deployment is refused and stopped`,
    async (fixture) => {
      const driver = sharedGatewayCompute(fixture);
      await fixture.start(driver.compute);
      const { owner, older } = await pendingOlderVersion(
        fixture,
        `${shape}-refused-stopped`,
        driver,
        options,
      );
      // The newer version writes the Gateway on its first pass, then Compute refuses it. No
      // version is active, so the worker stops the refused candidate, which deletes the Gateway.
      const newer = await fixture.revision(owner, 2);
      driver.outcomes.set(newer.id, "refused");
      await assertWorkEnds(fixture, newer, "failed_permanent", "SANDBOX_HARNESS_UNSUPPORTED");
      assert.deepEqual(
        driver.removedBy,
        [newer.id],
        "the refused version's stop removed the Gateway",
      );
      // The older version writes the Gateway again and activates once it is ready.
      driver.outcomes.set(older.id, "ready");
      await fixture.work(older, "succeeded");
      const active = await fixture.activePointer(owner);
      assert.equal(active.rows[0].active_revision_id, older.id);
      assert.equal(driver.gateway.get(owner.id), older.revision);
      assert.equal(driver.stops(older), 0);
    },
  );

  test(
    `an older ${shape} version still activates after a newer version with Git fails with a held code and is retired`,
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const driver = sharedGatewayCompute(fixture);
      await fixture.start(driver.compute);
      const { owner, older } = await pendingOlderVersion(
        fixture,
        `${shape}-git-retired`,
        driver,
        options,
      );
      // The newer version has repository credentials. It writes the Gateway and fails its
      // startup model check, a held failure that the deployment itself keeps for diagnosis.
      // Because it has repository credentials, the same failure also queues its runtime
      // retirement, which stops it and, as on Kubernetes, deletes the Gateway it holds.
      const newer = await fixture.revision(owner, 2, {
        repositoryCredentials: repository.snapshot,
      });
      driver.outcomes.set(newer.id, "probe-failed");
      await assertWorkEnds(fixture, newer, "failed_permanent", "RUNTIME_MODEL_PROBE_FAILED");
      await waitFor("the newer version's retirement to remove the Gateway", async () =>
        driver.removedBy.includes(newer.id) ? true : undefined,
      );
      assert.deepEqual(driver.removedBy, [newer.id]);
      const retirement = await fixture.observerPool.query(
        "SELECT state FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE $2",
        [newer.id, `agent_revision:${newer.id}:repository_cleanup:retire:%`],
      );
      assert.equal(retirement.rowCount, 1, "the held failure queued the runtime retirement");
      // Superseding the older version here would leave the Agent with nothing running. Instead
      // it writes the Gateway again and activates once it is ready, as on main.
      driver.outcomes.set(older.id, "ready");
      await fixture.work(older, "succeeded");
      const active = await fixture.activePointer(owner);
      assert.equal(active.rows[0].active_revision_id, older.id);
      assert.equal(driver.gateway.get(owner.id), older.revision);
      assert.equal(driver.stops(older), 0);
    },
  );
}

// The active version is left to its maintenance: superseding or stopping it would take down the
// recorded selection, and its own pass keeps failing and retrying as before.
revisionTest(
  "an active exclusive version keeps its maintenance when a newer embedded version fails with a held code",
  async (fixture) => {
    const driver = sharedGatewayCompute(fixture);
    await fixture.start(driver.compute, { convergenceTimeoutMs: 3_000 });
    const owner = await fixture.agent("exclusive-active-held");
    const active = await fixture.revision(owner, 1, olderShapes.exclusive);
    driver.outcomes.set(active.id, "ready");
    await fixture.work(active, "succeeded");
    const newer = await fixture.revision(owner, 2);
    driver.outcomes.set(newer.id, "probe-failed");
    await assertWorkEnds(fixture, newer, "failed_permanent", "RUNTIME_MODEL_PROBE_FAILED");
    const before = driver.passes(active);
    // The maintenance pass reaches Compute, which reports it not ready while the newer version
    // holds the Gateway, so it ends at its deadline without a stop.
    const maintenance = await enqueueMaintenance(fixture, owner, active);
    await assertWorkEnds(fixture, maintenance, "failed_permanent", "CONVERGENCE_DEADLINE_EXCEEDED");
    assert.ok(driver.passes(active) > before, "the maintenance pass prepared the active version");
    assert.equal(driver.stops(active), 0);
    assert.ok(driver.harnesses.has(active.id));
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, active.id);
  },
);

/** A newer exclusive version whose deployer lacks `deploy`: the worker refuses it before Compute. */
async function refusedExclusiveVersion(
  fixture,
  driver,
  owner,
  number,
  shape = olderShapes.exclusive,
) {
  const requester = `refused-exclusive-requester-${randomUUID()}`;
  await fixture.copyActorGrants(requester, { withoutActions: ["deploy"] });
  const refused = await fixture.revision(owner, number, {
    ...shape,
    actorId: requester,
  });
  await assertWorkEnds(fixture, refused, "failed_permanent", "AUTHORIZATION_DENIED");
  assert.equal(driver.passes(refused), 0, "the refused version never reached its sweep");
  return refused;
}

// Finding 3075: a newer exclusive version stops an older one only if its own pass reaches its
// predecessor sweep. One refused before then still supersedes the older version, which on main
// kept its Harness and the Gateway it held, serving a version OCC never selected, until a later
// activation, Agent stop or delete. The superseded version now stops itself, once: a failed stop
// fails that pass and the next pass repeats it, and the next deployment's sweep within the lease
// does not stop it again. The selected version (the redeploy's first) is not stopped again.
for (const { shape, stopFailures = 0 } of [
  { shape: "first" },
  { shape: "redeploy" },
  { shape: "first", stopFailures: 1 },
]) {
  revisionTest(
    `an older exclusive ${shape === "first" ? "first deployment" : "redeploy"} superseded by a newer exclusive version refused before Compute stops its own runtime${stopFailures === 0 ? "" : " after a failed stop"}`,
    async (fixture) => {
      const driver = sharedGatewayCompute(fixture);
      const events = [];
      await fixture.start(driver.compute, { emit: (event) => events.push(event) });
      const owner = await fixture.agent(`exclusive-refused-successor-${shape}-${stopFailures}`);
      let serving;
      if (shape === "redeploy") {
        serving = await fixture.revision(owner, 1, olderShapes.exclusive);
        driver.outcomes.set(serving.id, "ready");
        await fixture.work(serving, "succeeded");
      }
      // The older version swept the serving one, then wrote the Gateway and started its Harness;
      // it is not ready yet.
      const older = await fixture.revision(
        owner,
        serving === undefined ? 1 : 2,
        olderShapes.exclusive,
      );
      driver.failingStops.set(older.id, stopFailures);
      await waitFor("the older version's first preparation", async () =>
        driver.passes(older) > 0 ? true : undefined,
      );
      const newer = await refusedExclusiveVersion(fixture, driver, owner, older.revision + 1);
      const olderPasses = driver.passes(older);
      await assertWorkEnds(fixture, older, "succeeded", "REVISION_SUPERSEDED");
      assert.equal(driver.passes(older), olderPasses, "no preparation after the newer refusal");
      // Nothing else stops the superseded version: it stopped its Harness and the Gateway it held.
      assert.equal(driver.stops(older), 1);
      assert.deepEqual([...driver.harnesses], []);
      assert.equal(driver.gateway.has(owner.id), false);
      assert.deepEqual(
        driver.removedBy,
        serving === undefined ? [older.id] : [serving.id, older.id],
      );
      const codes = (await completedPasses(events, older)).map(({ code }) => code);
      assert.equal(codes.includes("DEPENDENCY_UNAVAILABLE"), stopFailures > 0, codes.join(", "));
      // The pointer still names the selected version, whose runtime the older version's sweep
      // stopped once: OCC never rolls back, and recovery is a new version.
      assert.equal(
        (await fixture.activePointer(owner)).rows[0].active_revision_id,
        serving?.id ?? null,
      );
      if (serving !== undefined) {
        assert.equal(driver.stops(serving), 1);
      }
      const recovery = await fixture.revision(owner, newer.revision + 1, olderShapes.exclusive);
      driver.outcomes.set(recovery.id, "ready");
      await fixture.work(recovery, "succeeded");
      assert.equal(driver.stops(older), 1, "the recovery's sweep skipped the stopped version");
      assert.deepEqual([...driver.harnesses], [recovery.id]);
      assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, recovery.id);
    },
  );
}

// Finding 3080 (review nit): the superseded version closes its repository credential sessions
// before it stops its runtime, as a newer version's sweep does, so the stopped Harness is not
// left the only holder of a live session. Superseding a version with repository credentials also
// queues its runtime retirement (`repository_cleanup:retire:`), which runs its session cleanup
// again (nothing is left to close) and repeats the stop once the version has ended superseded. Whether that second stop ran before
// the superseded work was observed depended on timing (finding 3089), so the case waits for the
// retirement and tells the stops apart by the state of the version's own work at each stop.
test(
  "an older exclusive version with repository credentials superseded by a refused newer exclusive version closes its sessions before its own stop",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const driver = sharedGatewayCompute(fixture);
    // Kubernetes admits repository credentials for a dedicated Codex Harness, which declares
    // exclusive replacement, as well as for embedded OpenClaw.
    driver.compute.validateRepositoryCredentials = (harness, sandboxDriverId) => {
      assert.deepEqual([harness.id, harness.mode], ["codex", "dedicated"]);
      assert.equal(sandboxDriverId, undefined);
    };
    const closes = () => repository.calls.filter(({ operation }) => operation === "close").length;
    // Each stop records the closes made before it and the state of the version's own deployment
    // work: "claimed" while its own pass runs, "succeeded" once it ended superseded.
    const stopsAt = new Map();
    const stop = driver.compute.stopRevision;
    driver.compute.stopRevision = async (revision) => {
      const closed = closes();
      const own = await workState(fixture, {
        idempotencyKey: `agent_revision:${revision.id}:reconcile`,
      });
      stopsAt.set(revision.id, [...(stopsAt.get(revision.id) ?? []), { closed, own }]);
      return stop(revision);
    };
    await fixture.start(driver.compute);
    const owner = await fixture.agent("exclusive-refused-successor-git", {
      executionMode: "dedicated",
    });
    const codex = { harness: { ...fixture.productionHarness, mode: "dedicated" } };
    const older = await fixture.revision(owner, 1, {
      ...codex,
      repositoryCredentials: repository.snapshot,
    });
    await waitFor("the older version's first preparation", async () =>
      driver.passes(older) > 0 ? true : undefined,
    );
    assert.ok(repository.calls.some(({ operation }) => operation === "open"));
    assert.equal(closes(), 0);
    await refusedExclusiveVersion(fixture, driver, owner, 2, codex);
    await assertWorkEnds(fixture, older, "succeeded", "REVISION_SUPERSEDED");
    await waitFor("the superseded version's runtime retirement", async () => {
      const retirement = await fixture.observerPool.query(
        "SELECT state FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE $2",
        [older.id, `agent_revision:${older.id}:repository_cleanup:retire:%`],
      );
      return retirement.rows[0]?.state === "succeeded" ? true : undefined;
    });
    // Its own pass stopped it after closing its one session; the retirement stopped it again
    // after the version ended superseded, with nothing left to close.
    assert.deepEqual(stopsAt.get(older.id), [
      { closed: 1, own: "claimed" },
      { closed: 1, own: "succeeded" },
    ]);
    assert.deepEqual([...driver.harnesses], []);
  },
);

// The selected version is never stopped by its own superseded pass. A newer exclusive admission
// supersedes its maintenance before Compute effects, even when that version is refused before its
// sweep, and the selected version keeps serving.
revisionTest(
  "an active exclusive version's maintenance superseded by a refused newer exclusive version keeps its runtime",
  async (fixture) => {
    const driver = sharedGatewayCompute(fixture);
    await fixture.start(driver.compute);
    const owner = await fixture.agent("exclusive-active-refused-successor");
    const active = await fixture.revision(owner, 1, olderShapes.exclusive);
    driver.outcomes.set(active.id, "ready");
    await fixture.work(active, "succeeded");
    await refusedExclusiveVersion(fixture, driver, owner, 2);
    const passes = driver.passes(active);
    const maintenance = await enqueueMaintenance(fixture, owner, active);
    await assertWorkEnds(fixture, maintenance, "succeeded", "REVISION_SUPERSEDED");
    assert.equal(driver.passes(active), passes, "maintenance did not prepare it");
    assert.equal(driver.stops(active), 0);
    assert.deepEqual([...driver.harnesses], [active.id]);
    assert.equal(driver.gateway.get(owner.id), active.revision);
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, active.id);
  },
);

// An older shared (embedded) version superseded the same way is left alone beside an active
// version, as a refused shared candidate is: on Kubernetes it may hold the Agent's shared Gateway,
// which its stop would delete. The next deployment that activates retires it.
revisionTest(
  "an older shared version superseded by a refused newer exclusive version is not stopped beside an active version",
  async (fixture) => {
    const driver = sharedGatewayCompute(fixture);
    await fixture.start(driver.compute);
    const owner = await fixture.agent("shared-refused-successor");
    const active = await fixture.revision(owner, 1);
    driver.outcomes.set(active.id, "ready");
    await fixture.work(active, "succeeded");
    const older = await fixture.revision(owner, 2);
    await waitFor("the older version's first preparation", async () =>
      driver.passes(older) > 0 ? true : undefined,
    );
    await refusedExclusiveVersion(fixture, driver, owner, 3);
    await assertWorkEnds(fixture, older, "succeeded", "REVISION_SUPERSEDED");
    assert.equal(driver.stops(older), 0);
    assert.equal(driver.stops(active), 0);
    assert.equal(driver.gateway.get(owner.id), older.revision);
    assert.deepEqual(driver.removedBy, []);
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, active.id);
  },
);

// Finding 3075 control: a newer exclusive version that reaches its sweep stops the older version
// itself. The older version's own pass then skips its stop, or stops first and spares the sweep,
// so the older version stops once. Its stop never touches the newer version's Gateway or Harness,
// while the newer version is pending or after it activates.
revisionTest(
  "an older exclusive version swept by a pending newer exclusive version stops once and leaves the newer runtime",
  async (fixture) => {
    const driver = sharedGatewayCompute(fixture);
    await fixture.start(driver.compute);
    const { owner, older } = await pendingOlderVersion(
      fixture,
      "exclusive-swept",
      driver,
      olderShapes.exclusive,
    );
    // Hold the older version's next pass until the newer version is admitted: the newer version's
    // first pass, due at once, then usually sweeps it before the older version's next pass.
    let release;
    driver.gates.set(
      older.revision,
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await waitFor("the older version's held pass", async () =>
      driver.gates.has(older.revision) ? undefined : true,
    );
    const newer = await fixture.revision(owner, 2, olderShapes.exclusive);
    release();
    await assertWorkEnds(fixture, older, "succeeded", "REVISION_SUPERSEDED");
    await waitFor("the newer version's preparation", async () =>
      driver.passes(newer) > 0 ? true : undefined,
    );
    assert.equal(driver.stops(older), 1);
    assert.deepEqual(driver.removedBy, [older.id]);
    assert.equal(driver.gateway.get(owner.id), newer.revision);
    assert.deepEqual([...driver.harnesses], [newer.id]);
    assert.notEqual(await workState(fixture, newer), "succeeded", "the newer version is pending");
    driver.outcomes.set(newer.id, "ready");
    await fixture.work(newer, "succeeded");
    assert.equal(driver.stops(older), 1);
    assert.deepEqual(driver.removedBy, [older.id]);
    assert.deepEqual([...driver.harnesses], [newer.id]);
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, newer.id);
  },
);

async function recordPlannedReplacement(fixture, owner, previous, candidate) {
  return fixture.state.transact(async (unit) => {
    await unit.namespaces.lockNamespace(fixture.namespace.id);
    await unit.agents.lockAgent(fixture.namespace.id, owner.id);
    return unit.agents.recordPredecessorReplacement(fixture.namespace.id, owner.id, {
      predecessorRevisionId: previous.id,
      candidateRevisionId: candidate.id,
      phase: "pre-stop",
    });
  });
}

revisionTest(
  "planned completion preserves work and maintenance while idle Agents advance, across retry and candidate replacement",
  async (fixture, t) => {
    const credentials = {
      email: "completion-progress@openclaw.local",
      name: "Deployment operator",
      password: randomUUID(),
    };
    const auth = await createPostgresControllerAuth({
      mode: "development",
      installationId: fixture.installation.id,
      baseURL: "https://console.oce.localhost",
      agentDomain: "agents.oce.localhost",
      secret: `${randomUUID()}${randomUUID()}`,
      pool: fixture.observerPool,
    });
    const account = await auth.createAccount(credentials);
    const { roles } = await fixture.state.loadNativeIAMState();
    const adminRole = roles.find(({ name }) => name === "Installation administrator");
    assert.ok(adminRole);
    await fixture.state.appendNativeIAMPrincipal(
      auth.principalSeed(account, { roleId: adminRole.id, scope: "all" }),
    );
    const app = createFastifyApp({
      controller: fixture.controller,
      iamDriver: fixture.controller.selectedDriver("iam"),
      resolveHarness: resolveApprovedHarness,
      auditSink: fixture.state.auditSink,
      auth,
      development: { enabled: false },
    });
    t.after(() => app.close());
    const request = await createAuthenticatedControllerRequest(app, credentials);
    const readDeployment = async (agent, revision) => {
      const { status, data } = await request(
        "GET",
        `/namespaces/${fixture.namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
      );
      assert.equal(status, 200);
      return data;
    };

    const owner = await fixture.agent("completion-busy", { executionMode: "dedicated" });
    const idle = await fixture.agent("completion-idle", { executionMode: "dedicated" });
    let completed = false;
    let candidateReady = false;
    let candidateId;
    const driver = countingExclusiveCompute(fixture, {
      ready: (revision) => revision.id !== candidateId || candidateReady,
    });
    const deadlines = [];
    const events = [];
    driver.compute.canWaitForPredecessorCompletion = () => true;
    driver.compute.waitForPredecessorCompletion = async (_previous, context) => {
      deadlines.push(context.deadlineAtMs);
      assert.ok(await context.recordExecutionIdentity("executor-original"));
      assert.equal(await context.recordExecutionIdentity("different-execution"), false);
      if (!completed) {
        return "waiting";
      }
      await context.commitStopping("executor-original");
      return "ready";
    };
    await fixture.start(driver.compute, { emit: (event) => events.push(event) });
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    await fixture.stop();
    const second = await fixture.revision(owner, 2);
    await recordPlannedReplacement(fixture, owner, first, second);
    const queued = await readDeployment(owner, second);
    assert.equal(queued.status, "queued");
    assert.equal(queued.progress.lastAttempt, null);
    await fixture.start(driver.compute, { emit: (event) => events.push(event) });
    await waitFor(
      "completion waiting",
      () => events.some((event) => event.code === "PREDECESSOR_COMPLETION_WAITING") || undefined,
    );
    // A committed Worker deferral must explain the wait to a signed-in operator.
    const waiting = await readDeployment(owner, second);
    assert.equal(waiting.status, "running");
    assert.equal(waiting.error, null);
    const expectedWait = {
      code: "PREDECESSOR_COMPLETION_WAITING",
      message:
        "Waiting for the previous version to finish its active work and deliver its results before this version starts.",
    };
    const { code, message } = waiting.progress.lastAttempt;
    assert.deepEqual({ code, message }, expectedWait);
    const originalDeadline = deadlines[0];
    const idleRevision = await fixture.revision(idle, 1);
    await fixture.work(idleRevision, "succeeded");
    const beforeMaintenance = driver.preparations(first);
    await fixture.work(await enqueueMaintenance(fixture, owner, first), "succeeded");
    assert.ok(driver.preparations(first) > beforeMaintenance);
    assert.equal(driver.count(first), 0);
    assert.equal(driver.preparations(second), 0);
    await fixture.stop();
    const third = await fixture.revision(owner, 3);
    candidateId = third.id;
    const kept = await recordPlannedReplacement(fixture, owner, first, third);
    assert.equal(Date.parse(kept.completionStartedAt) + 30 * 60_000, originalDeadline);
    const observationsBeforeRestart = deadlines.length;
    await fixture.start(driver.compute, {
      convergenceTimeoutMs: 1000,
      emit: (event) => events.push(event),
    });
    await waitFor(
      "resumed completion observation",
      () => deadlines.length > observationsBeforeRestart || undefined,
    );
    const preparationsBeforeChurnMaintenance = driver.preparations(first);
    await fixture.work(await enqueueMaintenance(fixture, owner, first), "succeeded");
    assert.ok(
      driver.preparations(first) > preparationsBeforeChurnMaintenance,
      "candidate churn must preserve predecessor maintenance",
    );
    const replacementWait = await readDeployment(owner, third);
    const { code: replacementCode, message: replacementMessage } =
      replacementWait.progress.lastAttempt;
    assert.deepEqual({ code: replacementCode, message: replacementMessage }, expectedWait);
    // Spend longer in completion than the ordinary convergence budget.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(driver.count(first), 0);
    completed = true;
    await waitForWorkPass(
      "candidate preparation after completion",
      fixture,
      third,
      () => driver.preparations(third) > 0 || undefined,
    );
    assert.equal(
      new Set(deadlines).size,
      1,
      "retry, restart and candidate churn cannot extend the cutoff",
    );
    assert.ok(driver.count(first) > 0);
    assert.equal(driver.preparations(second), 0);
    assert.notEqual((await fixture.currentAgent(owner)).activeRevisionId, third.id);
    candidateReady = true;
    await waitForWorkStateDue(fixture, third, "succeeded");
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, third.id);
    const deployed = await readDeployment(owner, third);
    assert.equal(deployed.status, "succeeded");
    assert.equal(deployed.progress, null);
  },
);

for (const recovery of [
  "retry",
  "reassigned",
  "explicit Stop",
  "legacy sweep",
  "Stop during sweep",
]) {
  test(
    `planned replacement recovers a committed predecessor stop after its only claim expires (${recovery})`,
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 1 });
      const owner = await fixture.agent("completion-handoff-recovery", {
        executionMode: "dedicated",
      });
      const driver = countingExclusiveCompute(fixture);
      const events = [];
      let committed = false;
      let releaseHandoff;
      const handoff = new Promise((resolve) => {
        releaseHandoff = resolve;
      });
      driver.compute.canWaitForPredecessorCompletion = () => true;
      driver.compute.waitForPredecessorCompletion = async (_previous, handoffContext) => {
        assert.equal(await handoffContext.recordExecutionIdentity("executor-committed"), true);
        await handoffContext.commitStopping("executor-committed");
        committed = true;
        await handoff;
        return "ready";
      };
      await fixture.start(driver.compute);
      const earlier = await fixture.revision(owner, 1);
      await fixture.work(earlier, "succeeded");
      const first = await fixture.revision(owner, 2);
      await fixture.work(first, "succeeded");
      await fixture.stop();
      const earlierStops = driver.count(earlier);
      assert.equal(earlierStops, 1);
      const candidate = await fixture.revision(owner, 3);
      await recordPlannedReplacement(fixture, owner, first, candidate);
      await fixture.start(driver.compute, { emit: (event) => events.push(event) });
      let claim;
      try {
        await waitFor("committed handoff before predecessor stop", () => committed || undefined);
        const boundary = await fixture.state.read((view) =>
          view.agents.findPredecessorReplacement(fixture.namespace.id, owner.id),
        );
        assert.equal(boundary?.phase, "stopping");
        assert.equal(boundary.predecessorRevisionId, first.id);
        assert.equal(boundary.candidateRevisionId, candidate.id);
        assert.equal(boundary.executionIdentity, "executor-committed");
        claim = await fixture.work(candidate, "claimed");
        assert.equal(claim.attempt_count, 1);
        assert.equal(driver.count(first), 0);
        assert.equal(driver.preparations(candidate), 0);
      } finally {
        const stopping = fixture.stop();
        releaseHandoff();
        await stopping;
      }
      assert.ok(events.some((event) => event.event === "worker.pass-interrupted"));
      assert.equal((await fixture.expireClaim(candidate, claim.claim_token)).rowCount, 1);
      if (recovery === "retry" || recovery === "reassigned") {
        await denyDeploy(fixture, owner);
      }
      const stop = driver.compute.stopRevision.bind(driver.compute);
      let stopAttempts = 0;
      let sweepAttempts = 0;
      let newer;
      let stopWork;
      let releaseRetry;
      const retryInFlight = new Promise((resolve) => {
        releaseRetry = resolve;
      });
      driver.compute.stopRevision = async (revision) => {
        if (
          revision.id === earlier.id &&
          recovery === "Stop during sweep" &&
          stopWork === undefined
        ) {
          stopWork = await fixture.requestStop(owner);
        }
        if (revision.id === earlier.id && recovery === "legacy sweep") {
          sweepAttempts += 1;
          if (sweepAttempts === 1) {
            throw new ComputeStopYieldedError("older predecessor drain yielded");
          }
          if (sweepAttempts === 2) {
            await retryInFlight;
            return;
          }
        }
        if (
          revision.id === first.id &&
          recovery !== "legacy sweep" &&
          recovery !== "Stop during sweep"
        ) {
          stopAttempts += 1;
          if (stopAttempts === 1 && recovery === "reassigned") {
            newer = await fixture.revision(owner, 4);
            await recordPlannedReplacement(fixture, owner, first, newer);
          } else if (stopAttempts === 1 && recovery === "explicit Stop") {
            stopWork = await fixture.requestStop(owner);
          } else if (stopAttempts === 1) {
            throw new Error("temporary predecessor stop outage");
          } else if (stopAttempts === 2 && recovery === "retry") {
            throw new ComputeStopYieldedError("predecessor drain yielded");
          } else if (stopAttempts === 3 && recovery === "retry") {
            await retryInFlight;
            return;
          }
        }
        await stop(revision);
      };
      await fixture.start(driver.compute, { emit: (event) => events.push(event) });
      if (recovery === "retry") {
        let retryClaim;
        try {
          await waitFor("a renewed stop attempt after error and yield", () =>
            stopAttempts === 3 ? true : undefined,
          );
          retryClaim = await fixture.work(candidate, "claimed");
          assert.equal(retryClaim.attempt_count, 1);
          assert.equal(driver.running.has(first.id), true);
        } finally {
          const stopping = fixture.stop();
          releaseRetry();
          await stopping;
        }
        assert.equal((await fixture.expireClaim(candidate, retryClaim.claim_token)).rowCount, 1);
        await fixture.start(driver.compute, { emit: (event) => events.push(event) });
      }
      if (recovery === "legacy sweep") {
        let sweepClaim;
        try {
          await waitFor("legacy sweep reclaimed after yield", () =>
            sweepAttempts === 2 ? true : undefined,
          );
          sweepClaim = await fixture.work(candidate, "claimed");
          assert.equal(sweepClaim.attempt_count, 1);
          assert.equal(driver.preparations(candidate), 0);
          assert.ok(events.some((event) => event.code === "PREDECESSOR_STOP_YIELDED"));
        } finally {
          const stopping = fixture.stop();
          releaseRetry();
          await stopping;
        }
        assert.equal((await fixture.expireClaim(candidate, sweepClaim.claim_token)).rowCount, 1);
        await fixture.start(driver.compute, { emit: (event) => events.push(event) });
        const terminal = await waitFor("legacy sweep deployment terminal state", async () => {
          const { rows } = await fixture.workResult(candidate);
          return rows[0].reason_code || undefined;
        });
        assert.equal(
          terminal,
          "REVISION_ACTIVATED",
          "exact recovery must preserve the legacy grant",
        );
        assert.equal(sweepAttempts, 3);
        assert.ok(driver.preparations(candidate) > 0);
        return;
      }
      if (recovery === "explicit Stop" || recovery === "Stop during sweep") {
        await fixture.work(candidate, "succeeded");
        assert.ok(stopWork);
        await fixture.work(stopWork, "succeeded");
        assert.equal(driver.preparations(candidate), 0, "Stop must prevent candidate preparation");
        assert.equal((await fixture.currentAgent(owner)).desiredRuntimeState, "stopped");
        assert.equal(driver.running.has(first.id), false);
        assert.equal(driver.running.has(candidate.id), false);
        return;
      }
      await fixture.work(candidate, "failed_permanent");
      if (newer !== undefined) {
        await fixture.work(newer, "failed_permanent");
        assert.equal(driver.preparations(newer), 0);
      }
      const completedBoundary = await fixture.state.read((view) =>
        view.agents.findPredecessorReplacement(fixture.namespace.id, owner.id),
      );
      assert.equal(completedBoundary.candidateRevisionId, newer?.id ?? candidate.id);
      assert.equal(completedBoundary.predecessorRevisionId, first.id);
      assert.equal(completedBoundary.stopCompleted, true);
      assert.equal(stopAttempts, recovery === "retry" ? 4 : 1);
      const pending = events.filter((event) => event.code === "PLANNED_PREDECESSOR_STOP_PENDING");
      assert.equal(pending.length, recovery === "retry" ? 1 : 0);
      const yields = events.filter((event) => event.code === "PLANNED_PREDECESSOR_STOP_YIELDED");
      assert.equal(yields.length, recovery === "retry" ? 1 : 0);
      if (recovery === "retry") {
        assert.equal(yields[0].stopYields, 1);
      }
      assert.equal(driver.preparations(candidate), 0);
      assert.equal(driver.count(first), 1, "recovery must stop the exact committed predecessor");
      assert.equal(driver.running.has(first.id), false);
      assert.equal(
        driver.count(earlier),
        earlierStops,
        "recovery must leave other predecessors alone",
      );
      assert.equal(
        (await fixture.workResult(candidate)).rows[0].reason_code,
        "AUTHORIZATION_DENIED",
      );
      assert.equal((await fixture.deploymentStatus(owner, candidate)).status, "failed");
    },
  );
}

revisionTest(
  "a published replacement keeps a deploy denial discovered during its recovery sweep",
  async (fixture) => {
    const owner = await fixture.agent("published-sweep-denial", { executionMode: "dedicated" });
    const driver = countingExclusiveCompute(fixture);
    await fixture.start(driver.compute);
    const predecessor = await fixture.revision(owner, 1);
    await fixture.work(predecessor, "succeeded");
    await fixture.stop();
    const candidate = await fixture.revision(owner, 2);
    await fixture.state.transact(async (unit) => {
      await unit.namespaces.lockNamespace(fixture.namespace.id);
      await unit.agents.lockAgent(fixture.namespace.id, owner.id);
      const published = await unit.agents.compareAndSetActiveRevision(
        fixture.namespace.id,
        owner.id,
        predecessor.id,
        candidate.id,
      );
      assert.equal(published?.activeRevisionId, candidate.id);
    });

    const stop = driver.compute.stopRevision.bind(driver.compute);
    driver.compute.stopRevision = async (revision) => {
      if (revision.id === predecessor.id) {
        await denyDeploy(fixture, owner);
      }
      await stop(revision);
    };
    const events = [];
    await fixture.start(driver.compute, { emit: (event) => events.push(event) });
    const first = await waitFor("first published recovery outcome", () =>
      events.find(
        (event) => event.event === "worker.completed" && event.workId === candidate.idempotencyKey,
      ),
    );
    assert.equal(first.code, "AUTHORIZATION_DENIED");
    await assertWorkEnds(fixture, candidate, "failed_permanent", "AUTHORIZATION_DENIED");
    assert.equal(driver.preparations(candidate), 0);
    const { rows } = await fixture.observerPool.query(
      `SELECT actor_id, details->'__occAuditMetadata'->>'reasonCode' AS reason_code,
              details->'__occAuditMetadata'->'authorization' AS authorization
       FROM occ.audit_events
       WHERE namespace_id = $1 AND kind = 'authorization_denial' AND outcome = 'denied'
         AND action = 'openclaw.agents.deploy' AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(rows, [
      {
        actor_id: fixture.actor.id,
        reason_code: "AUTHORIZATION_DENIED",
        authorization: {
          action: "deploy",
          principalId: fixture.actor.id,
          resource: { kind: "agent", id: owner.id, namespaceId: fixture.namespace.id },
        },
      },
    ]);
  },
);

revisionTest(
  "an expired planned-completion cutoff forces the shared stop before preparing the successor",
  async (fixture) => {
    const owner = await fixture.agent("completion-expired", { executionMode: "dedicated" });
    const driver = countingExclusiveCompute(fixture);
    const events = [];
    let observations = 0;
    driver.compute.canWaitForPredecessorCompletion = () => true;
    driver.compute.waitForPredecessorCompletion = async (_previous, context) => {
      observations += 1;
      assert.ok(await context.recordExecutionIdentity("executor-busy"));
      return "waiting";
    };
    await fixture.start(driver.compute);
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    await fixture.stop();
    const candidate = await fixture.revision(owner, 2);
    await recordPlannedReplacement(fixture, owner, first, candidate);
    await fixture.start(driver.compute, { emit: (event) => events.push(event) });
    await waitFor(
      "busy predecessor lease",
      () => events.some((event) => event.code === "PREDECESSOR_COMPLETION_WAITING") || undefined,
    );
    await fixture.stop();
    await fixture.observerPool.query(
      `UPDATE occ.agents SET predecessor_replacement = predecessor_replacement ||
       jsonb_build_object('completionStartedAt', clock_timestamp() - interval '31 minutes',
                         'startedAt', clock_timestamp() - interval '31 minutes')
     WHERE namespace_id = $1 AND id = $2`,
      [fixture.namespace.id, owner.id],
    );
    const before = observations;
    await fixture.start(driver.compute, { emit: (event) => events.push(event) });
    await waitForWorkStateDue(fixture, candidate, "succeeded");
    assert.equal(observations, before, "expiry must not renew or restart the wait");
    assert.ok(driver.count(first) > 0);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, candidate.id);
    assert.ok(
      events.some(
        (event) =>
          event.event === "worker.predecessor_completion" && event.outcome === "deadline-exhausted",
      ),
    );
    assert.equal(
      events.some(
        (event) => event.event === "worker.predecessor_completion" && event.outcome === "ready",
      ),
      false,
    );
  },
);

revisionTest(
  "explicit Stop preempts planned completion without preparing the candidate",
  async (fixture) => {
    const owner = await fixture.agent("completion-stop", { executionMode: "dedicated" });
    const driver = countingExclusiveCompute(fixture);
    const events = [];
    driver.compute.canWaitForPredecessorCompletion = () => true;
    driver.compute.waitForPredecessorCompletion = async () => "waiting";
    await fixture.start(driver.compute);
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    await fixture.stop();
    const candidate = await fixture.revision(owner, 2);
    await recordPlannedReplacement(fixture, owner, first, candidate);
    await fixture.start(driver.compute, { emit: (event) => events.push(event) });
    await waitFor(
      "completion waiting before Stop",
      () => events.some((event) => event.code === "PREDECESSOR_COMPLETION_WAITING") || undefined,
    );
    const stop = await fixture.requestStop(owner);
    await waitForWorkStateDue(fixture, stop, "succeeded");
    assert.ok(driver.count(first) > 0);
    assert.equal(driver.preparations(candidate), 0);
  },
);
