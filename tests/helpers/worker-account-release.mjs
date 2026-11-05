import assert from "node:assert/strict";

import { DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { createProviderSandboxDriver } from "./runtime-logs.mjs";
import { createBackendWorkerDrivers } from "./postgres-backend-state.mjs";
import { waitFor } from "./wait-for.mjs";
import pg from "pg";
import { managedPluginGuardVersion } from "../../apps/controller/src/drivers/plugin/managed-request-policies.ts";

/** Real queued Worker, controller release and Kubernetes Compute; external transports are controlled.
 * The Sandbox emits its supported policy-pending error here. Native policy validation and live
 * supervisor propagation are separate proofs; this check verifies the production caller ordering.
 */
export async function assertWorkerAccountRelease(t, input) {
  const { controller, state, pool, namespaceId, agentId, sourceId } = input;
  const tenant = await state.read((view) => view.namespaces.findNamespace(namespaceId));
  assert.ok(tenant);
  const sandboxDriver = createProviderSandboxDriver({ id: "openshell-sandbox" }).driver;
  const pendingPolicy = Promise.withResolvers();
  const events = [];
  let policyLoaded = false;
  const fixture = providerEndpointFixture({
    tenant,
    sandboxDriver,
    credentialGatewayDriver: input.gateway,
    revisionOverrides: { namespaceId, agentId },
    async provisionHarness(context) {
      if (!policyLoaded) {
        events.push("policy-pending");
        await pendingPolicy.promise;
        throw new DependencyUnavailableError("The saved account request policy is not loaded yet.");
      }
      events.push("policy-loaded");
      const pod = fixture.pod("account-harness");
      pod.metadata.labels = { ...context.requirements.labels };
      fixture.observePods([pod]);
    },
  });
  controller.registerDriver(input.plugin);
  controller.selectDriver("plugin", input.plugin.id);
  controller.registerDriver(fixture.driver);
  controller.selectDriver("compute", fixture.driver.id);
  // Admit through the real Kubernetes Driver, preserving the same transport state for dispatch.
  const revision = await controller.deployAgent(
    input.principal.id,
    { namespaceId, agentId },
    resolveApprovedHarness,
  );
  Object.assign(fixture.revision, revision);
  const delivery = revision.credentialSources?.find(
    (source) => source.sourceId === sourceId,
  )?.accountDelivery;
  assert.ok(delivery);
  const senderName = openShellProviderName(delivery.profileId);
  const sender = () =>
    [...input.providers.values()].find((provider) => provider.name === senderName);
  Object.assign(fixture.clients, {
    version: {
      async getCode() {
        return { gitVersion: "v1.35.0" };
      },
    },
  });
  fixture.setSetupAvailable(true);
  const update = input.transport.updateProviderCredentialsConditionally.bind(input.transport);
  const publication = t.mock.method(
    input.transport,
    "updateProviderCredentialsConditionally",
    async (...args) => {
      if (
        args[0].name === senderName &&
        Object.values(args[0].credentials).includes(input.expectedToken)
      ) {
        events.push("publish");
      }
      return update(...args);
    },
  );
  // This is the external native provider-status RPC, called by the real Gateway Driver.
  // It records ordering and observes the real provider map; it does not perform publication.
  Object.assign(input.transport, {
    async getGatewayInfo() {
      return {
        extensions: [
          {
            configured_name: "oce-plugin-requests",
            kind: 4,
            protocol_major: 1,
            protocol_minor: 0,
            implementation_name: "oce/managed-plugin-requests",
            implementation_version: managedPluginGuardVersion,
            supported_capabilities: ["openshell.supervisor-middleware.contract"],
            required_capabilities: ["openshell.supervisor-middleware.contract"],
          },
        ],
      };
    },
    async getSandboxProviderStatus(_workspace, _sandbox, provider) {
      if (provider === senderName) {
        events.push("attachment-status");
        assert.ok(Object.values(sender().credentials).includes(input.expectedToken));
      }
      return { state: "PROVIDER_READINESS_STATE_READY" };
    },
  });
  const drivers = createBackendWorkerDrivers(fixture.driver, [], {
    secretDriver: input.secretDriver,
  });
  Object.assign(drivers.installation.drivers, {
    sandbox: { id: sandboxDriver.id, configuration: {} },
    credential_gateway: { id: input.gateway.id, configuration: {} },
    credential_refresh: { id: input.refresh.id, configuration: {} },
    plugin: { id: input.plugin.id, configuration: {} },
  });
  const workerEvents = [];
  const workerPool = new pg.Pool({ connectionString: process.env.OCC_TEST_DATABASE_URL, max: 6 });
  const worker = createControllerWorker({
    pool: workerPool,
    drivers: {
      ...drivers,
      installation: {
        ...drivers.installation,
        backend: [],
        logging: { level: "info" },
        runtime: { nativeWorkerSupport: "custom-image" },
      },
      sandboxDriver: fixture.sandbox,
      credentialGatewayDriver: input.gateway,
      credentialRefreshDriver: input.refresh,
      tokenService: input.preparedTokens,
      pluginDriver: input.plugin,
    },
    pollIntervalMs: 15,
    emit(event) {
      workerEvents.push(event);
    },
  });
  t.after(async () => {
    pendingPolicy.resolve();
    await worker.stop();
    publication.mock.restore();
  });
  // The API fixture disables its background queue. Enqueue its real admitted revision through
  // the production queue store, as the recorded Agent lifecycle operation normally does.
  const workKey = `agent_revision:${revision.id}:reconcile`;
  await state.transactWithQueue(async (_unit, queue) => {
    await queue.enqueue({
      idempotencyKey: workKey,
      namespaceId,
      agentId,
      revisionId: revision.id,
      actorId: input.principal.id,
      availableAt: new Date(0),
    });
  });
  await worker.start();
  await waitFor(
    () =>
      "the Sandbox policy gate: " +
      JSON.stringify(workerEvents.filter((event) => event.event !== "worker.health").slice(-5)),
    async () => {
      const failure = workerEvents.find((event) => event.event === "worker.compute-prepare-failed");
      assert.equal(failure, undefined, JSON.stringify(failure));
      return events.includes("policy-pending") ? true : undefined;
    },
  );
  assert.deepEqual(
    Object.keys(sender().credentials),
    [],
    "policy-pending keeps the prepared provider empty",
  );
  assert.equal(events.includes("publish"), false);
  pendingPolicy.resolve();
  await waitFor("policy-pending work returns to the queue", async () => {
    const work = await pool.query(
      "SELECT state FROM occ.controller_work WHERE idempotency_key=$1",
      [workKey],
    );
    return work.rows.some((row) => row.state === "queued") ? true : undefined;
  });
  policyLoaded = true;
  await pool.query(
    "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE idempotency_key=$1 AND state='queued'",
    [workKey],
  );
  await waitFor(
    () =>
      "attachment status after release: " +
      JSON.stringify(workerEvents.filter((event) => event.event !== "worker.health").slice(-5)),
    async () => (events.includes("attachment-status") ? true : undefined),
  );
  const loaded = events.indexOf("policy-loaded");
  const published = events.indexOf("publish");
  const observed = events.indexOf("attachment-status");
  assert.ok(loaded >= 0 && published > loaded && observed > published, JSON.stringify(events));
  await worker.stop();
}
