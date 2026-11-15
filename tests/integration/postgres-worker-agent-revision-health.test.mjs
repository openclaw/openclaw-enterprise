import { GitHubNativeRepositorySender } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { closeWorkerComposition } from "../../apps/controller/src/worker/shutdown.ts";
import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { repositoryAttempts } from "../helpers/postgres-worker-revision-support.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import {
  preserveOtherDatabaseClaim,
  dropDatabaseWithStuckPool,
  ignoreEndedPoolError,
} from "./postgres-worker-revision-database-teardown-cases.ts";
import {
  exitAfterAbandonedStep,
  exitAfterLateAbandonedStep,
  exitAfterLaterHookFails,
  exitAfterAbandoningHookFails,
} from "./postgres-worker-revision-fixture-exit-cases.ts";
import { yieldSerialWorkToOtherAgent } from "./postgres-worker-revision-serial-work-case.ts";
import {
  reportReadinessWithoutRepositoryCredentials,
  resumeWorkAfterSilentConnection,
  reportProgressThroughOutage,
} from "./postgres-worker-revision-connectivity-cases.ts";
import {
  reportHealthDuringCompute,
  renewLeaseDuringSlowHealth,
  preserveRetryBudgetAfterHealthFailure,
} from "./postgres-worker-revision-lease-health-cases.ts";

// Worker health, readiness, leases and outages. Deployment and dispatch cases are in
// postgres-worker-agent-revision.test.mjs, credential-source withdrawals in its
// -credential-sources sibling; repository sessions are in its -teardown sibling, and Agent stop
// and deletion and Namespace teardown in its -stop sibling; exclusive replacement and refused
// candidates are in the -replacement sibling, a refused candidate's stop and its wait in the
// -refused-stop and -refused-wait siblings, and redeploys whose predecessor stop yields in the
// -yielded-redeploy sibling. The lane runs the revision files at once.

const { setup, cleanup } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

test(
  "worker fixture disposal preserves another database's live claim and activation",
  requiresPostgres,
  (context) => preserveOtherDatabaseClaim(context, setup),
);

test(
  "worker fixture teardown names a pool that never ends and still drops the database",
  { ...requiresPostgres, timeout: 60_000 },
  (context) => dropDatabaseWithStuckPool(context, setup),
);

test(
  "worker fixture teardown ignores the error of an ended pool's session the drop ends",
  { ...requiresPostgres, timeout: 60_000 },
  (context) => ignoreEndedPoolError(context, setup),
);

test(
  "an abandoned teardown step that holds its process open does not keep the file alive",
  exitAfterAbandonedStep,
);

test(
  "a teardown step abandoned by a later root after hook does not keep the file alive",
  exitAfterLateAbandonedStep,
);

test(
  "a later root after hook that fails after an abandoned step does not keep the file alive",
  exitAfterLaterHookFails,
);

test(
  "a later root after hook that abandons a step and fails does not keep the file alive",
  exitAfterAbandoningHookFails,
);

test(
  "a revision pass learns when another Agent's Work is waiting for the serial worker",
  { ...requiresPostgres, timeout: 30_000 },
  (context) => yieldSerialWorkToOtherAgent(context, setup),
);

test(
  "worker readiness remains available when repository credentials are disabled",
  requiresPostgres,
  (context) => reportReadinessWithoutRepositoryCredentials(context, setup),
);

test(
  "a worker abandons a query on a silent database connection and resumes work",
  { ...requiresPostgres, timeout: 60_000 },
  (context) => resumeWorkAfterSilentConnection(context, setup),
);

test(
  "worker progress continues through a database outage and stops when the loop is stuck",
  { ...requiresPostgres, timeout: 60_000 },
  (context) => reportProgressThroughOutage(context, setup),
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
      { GitHubRepositoryPolicy },
      { UnixRepositoryCredentialControlClient },
      { startRegistryCredentialServiceFixture },
      { startRepositoryReceiptServer },
      { startControlResponseRelay },
      { createResourceScope },
      { dirname },
    ] = await Promise.all([
      import("../../apps/controller/src/drivers/repo/github/policy.ts"),
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
    const repositoryBackend = {
      id: credentials.backendId,
      client: new UnixRepositoryCredentialControlClient({ controlSocket: relay.socketPath }),
      drivers: { repo: "repository-credentials" },
    };
    const sender = new GitHubNativeRepositorySender(repositoryBackend, {
      publicCa: credentials.tls.ca,
    });
    const driver = new GitHubRepositoryPolicy(
      { driverId: repositoryBackend.drivers.repo, backendId: repositoryBackend.id },
      credentials.registry,
      {
        sessionDurationSeconds: 60,
      },
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
      bindings: [{ repositoryRef: "repo-a", profile: "git-write" }],
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
        transformDrivers: (drivers) => ({
          ...drivers,
          repositoryPolicy: driver,
          nativeRepositorySender: sender,
        }),
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
    const open = sender.open.bind(sender);
    let lostSessionId;
    sender.open = async (input, signal) => {
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
  (context) => reportHealthDuringCompute(context, setup),
);

for (const slowCall of [1, 2]) {
  test(
    `slow health update ${slowCall} does not block Compute or PostgreSQL lease renewal`,
    requiresPostgres,
    (context) => renewLeaseDuringSlowHealth(context, setup, slowCall),
  );
}

test(
  "failed readiness updates do not abort Compute or spend its retry budget",
  requiresPostgres,
  (context) => preserveRetryBudgetAfterHealthFailure(context, setup),
);

// Finding 2997: worker.mjs removed its readiness marker and closed the worker's parts while the
// worker loop still ran. A health check in flight then rewrote the marker, which outlived the
// process, and the loop could claim work after the Git owner had closed. Shutdown now stops the
// loop and waits for its health checks before it removes the marker and closes the parts, and
// it closes the worker's database pool last.

// The revision fixture with worker.mjs's readiness writer. `holdNextHealth()` holds the next
// health check before its write until the returned tick is released.
async function readinessFixture(context, options = {}) {
  const directory = await temporaryDirectory(context, "occ-worker-readiness-");
  const readinessPath = join(directory, "ready");
  let held;
  const fixture = await setup(context, {
    ...options,
    async onHealthy() {
      const tick = held;
      held = undefined;
      if (tick !== undefined) {
        tick.entered.resolve();
        await tick.release.promise;
      }
      await writeFile(readinessPath, `${Date.now()}\n`, { encoding: "utf8", mode: 0o600 });
    },
  });
  return {
    fixture,
    readinessPath,
    holdNextHealth() {
      held = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      return held;
    },
  };
}

// worker.mjs's shutdown, with parts that record their close in `events`. `onFirstPart` runs
// when the first part closes.
function shutdownWithParts(worker, readinessPath, events, onFirstPart = () => {}) {
  const step = (name) => async () => {
    onFirstPart();
    events.push(name);
  };
  return closeWorkerComposition({
    readinessPath,
    repositoryGitTransport: { close: step("transport") },
    preparedRepositoryGit: { close: step("prepared") },
    receiptServer: { close: step("receipt") },
    closeMetrics: step("metrics"),
    preparedGitHub: { close: step("github") },
    worker,
  });
}

async function assertHeldHealthEndedBeforeParts(events, readinessPath) {
  // The held check finished before any part closed, and the worker closed after them all.
  assert.deepEqual(events, [
    "worker.health",
    "transport",
    "prepared",
    "receipt",
    "metrics",
    "github",
    "worker.stopped",
  ]);
  // The marker that check wrote is gone, so a stopped worker never reports ready.
  await assert.rejects(stat(readinessPath), { code: "ENOENT" });
}

// Records the worker's health and stop events; `onEvent` sees every event.
function recordEvents(events, onEvent = () => {}) {
  return (event) => {
    if (event.event === "worker.health" || event.event === "worker.stopped") {
      events.push(event.event);
    }
    onEvent(event);
  };
}

test(
  "worker shutdown waits for the health check in flight before it removes readiness and closes parts",
  requiresPostgres,
  async (context) => {
    const { fixture, readinessPath, holdNextHealth } = await readinessFixture(context);
    const events = [];
    await fixture.start(fixture.compute, { emit: recordEvents(events) });
    const worker = [...fixture.database.workers].at(-1);
    await waitFor("the first readiness marker", async () =>
      (await stat(readinessPath).catch(() => undefined)) === undefined ? undefined : true,
    );

    // The next idle health check (at most a second away) is now held before its write.
    const tick = holdNextHealth();
    try {
      await tick.entered.promise;
      events.length = 0;
      const closing = shutdownWithParts(worker, readinessPath, events);
      tick.release.resolve();
      await closing;
    } finally {
      tick.release.resolve();
    }
    await assertHeldHealthEndedBeforeParts(events, readinessPath);
  },
);

// A claim's lease heartbeat starts health checks that the worker loop does not await, so one can
// still be in flight when the aborted loop ends.
test(
  "worker shutdown waits for a claim's background health check before it removes readiness",
  requiresPostgres,
  async (context) => {
    // Renewals every 1.5 s, each able to start a health check once a second has passed.
    const { fixture, readinessPath, holdNextHealth } = await readinessFixture(context, {
      leaseDurationMs: 4_500,
    });
    const { candidate } = await fixture.admitInitialRevision("background-health");
    const preparing = Promise.withResolvers();
    const releaseCompute = Promise.withResolvers();
    const passEnded = Promise.withResolvers();
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          preparing.resolve();
          await releaseCompute.promise;
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      {
        emit: recordEvents(events, ({ event }) => {
          if (["worker.pass-interrupted", "worker.completed", "worker.error"].includes(event)) {
            passEnded.resolve();
          }
        }),
      },
    );
    const worker = [...fixture.database.workers].at(-1);
    await preparing.promise;
    await fixture.work(candidate, "claimed");

    // Compute holds the pass, so only the claim's heartbeat starts health checks: hold the next.
    const tick = holdNextHealth();
    try {
      await tick.entered.promise;
      events.length = 0;
      // A shutdown that does not wait for that check closes the first part as soon as the
      // pass ends, which releases the check after the marker's removal. A shutdown that waits
      // gets it released 250 ms after the pass ends.
      const closing = shutdownWithParts(worker, readinessPath, events, () =>
        tick.release.resolve(),
      );
      releaseCompute.resolve();
      await passEnded.promise;
      await delay(250);
      tick.release.resolve();
      await closing;
    } finally {
      tick.release.resolve();
      releaseCompute.resolve();
    }
    await assertHeldHealthEndedBeforeParts(events, readinessPath);
  },
);
