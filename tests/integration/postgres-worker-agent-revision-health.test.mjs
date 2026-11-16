import { GitHubNativeRepositorySender } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.ts";
import test, { after } from "node:test";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
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
import { verifyBrokerCapability } from "./postgres-worker-revision-broker-capability-case.ts";
import {
  reportHealthDuringCompute,
  renewLeaseDuringSlowHealth,
  preserveRetryBudgetAfterHealthFailure,
} from "./postgres-worker-revision-lease-health-cases.ts";
import {
  shutdownDuringIdleHealth,
  shutdownDuringClaimHealth,
} from "./postgres-worker-revision-readiness-shutdown-cases.ts";

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
      import("../fixtures/repository-credentials/registry.ts"),
      import("../../apps/controller/src/backends/repository-credentials/receipt-server.ts"),
      import("../fixtures/repository-credentials/control-relay.ts"),
      import("../fixtures/repository-credentials/resources.ts"),
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
    await verifyBrokerCapability({
      fixture,
      owner,
      selection,
      incompatible,
      relay,
      brokerSocket: credentials.config.gateway.controlSocket,
      isReady: () => healthy > 0,
      hasIssuedProviderToken: () =>
        credentials.repositories.some(({ github }) => github.issuesOfTokens.length > 0),
    });
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

test(
  "worker shutdown waits for the health check in flight before it removes readiness and closes parts",
  requiresPostgres,
  (context) => shutdownDuringIdleHealth(context, setup),
);

test(
  "worker shutdown waits for a claim's background health check before it removes readiness",
  requiresPostgres,
  (context) => shutdownDuringClaimHealth(context, setup),
);
