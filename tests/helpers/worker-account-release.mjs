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
  const { controller, state, pool, namespaceId, sourceId } = input;
  const tenant = await state.read((view) => view.namespaces.findNamespace(namespaceId));
  assert.ok(tenant);
  const sandboxDriver = createProviderSandboxDriver({ id: "openshell-sandbox" }).driver;
  const pendingPolicy = Promise.withResolvers();
  const confirmWithdrawal = Promise.withResolvers();
  let accountAvailable = true;
  let expectedSiblingToken = input.sibling.accessToken;
  let providerMembership;
  const events = [];
  let policyLoaded = false;
  const fixture = providerEndpointFixture({
    tenant,
    sandboxDriver,
    credentialGatewayDriver: input.gateway,
    revisionOverrides: { namespaceId },
    async provisionHarness(context) {
      const membership = context.requirements.credentialAttachments.map(({ ref }) => ref);
      if (providerMembership) {
        assert.deepEqual(
          membership,
          providerMembership,
          "running provider membership is immutable",
        );
      } else {
        providerMembership = membership;
      }
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
  controller.installPluginDrivers(input.pluginDrivers);
  controller.registerDriver(fixture.driver);
  controller.selectDriver("compute", fixture.driver.id);
  const agentId = await input.createAgent();
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
  const siblingDelivery = revision.credentialSources.find(
    ({ sourceId: id }) => id === input.sibling.sourceId,
  ).accountDelivery;
  assert.ok(siblingDelivery);
  assert.deepEqual(
    revision.credentialSources
      .filter(({ accountDelivery }) => accountDelivery)
      .map(({ sourceId }) => sourceId),
    [sourceId, input.sibling.sourceId],
  );
  const siblingName = openShellProviderName(siblingDelivery.profileId);
  const siblingSender = () =>
    [...input.providers.values()].find(({ name }) => name === siblingName);
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
      if (
        args[0].name === siblingName &&
        Object.values(args[0].credentials).includes(expectedSiblingToken)
      ) {
        events.push("sibling-publish");
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
        if (accountAvailable) {
          assert.ok(Object.values(sender().credentials).includes(input.expectedToken));
        } else {
          assert.deepEqual(Object.keys(sender().credentials), []);
        }
      }
      if (provider === siblingName) {
        assert.ok(Object.values(siblingSender().credentials).includes(expectedSiblingToken));
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
    plugin: input.pluginDrivers.map(({ id }) => ({ id, configuration: {} })),
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
      pluginDrivers: input.pluginDrivers,
    },
    pollIntervalMs: 15,
    emit(event) {
      workerEvents.push(event);
    },
  });
  t.after(async () => {
    pendingPolicy.resolve();
    confirmWithdrawal.resolve();
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
  // Complete the supported deployment before changing its template: only an already active
  // revision may preserve a withdrawn account's immutable, now-empty provider attachment.
  fixture.setGatewayServing();
  const completed = async (key) => {
    await waitFor("successful revision work " + key, async () => {
      const result = await pool.query(
        "SELECT state,reason_code FROM occ.controller_work WHERE idempotency_key=$1",
        [key],
      );
      assert.notEqual(result.rows[0]?.state, "failed", result.rows[0]?.reason_code);
      return result.rows[0]?.state === "succeeded" ? true : undefined;
    });
  };
  await completed(workKey);
  assert.equal(
    (await state.read((view) => view.agents.findAgent(namespaceId, agentId))).activeRevisionId,
    revision.id,
  );
  // Editing the draft does not reinterpret an already admitted OpenClaw revision as Codex.
  // Every subsequent account refresh must still use the frozen Plugin Driver and Harness.
  await input.changeDraftHarness(agentId);
  assert.equal(revision.harness.id, "openclaw");
  const advanceMaintenance = async () => {
    const next = await pool.query(
      "UPDATE occ.controller_work SET available_at=clock_timestamp() WHERE revision_id=$1 AND state='queued' AND idempotency_key LIKE $2 RETURNING idempotency_key",
      [revision.id, `agent_revision:${revision.id}:maintenance:%`],
    );
    assert.equal(next.rowCount, 1);
    return next.rows[0].idempotency_key;
  };
  const withdraw = input.gateway.withdrawConnectionToken.bind(input.gateway);
  let rejectWithdrawal = false;
  let holdWithdrawal = true;
  t.mock.method(input.gateway, "withdrawConnectionToken", async (context) => {
    if (context.source.id === delivery.profileId && rejectWithdrawal) {
      events.push("withdrawal-failed");
      throw new DependencyUnavailableError("The account withdrawal service is unavailable.");
    }
    await withdraw(context);
    if (context.source.id === delivery.profileId && holdWithdrawal) {
      events.push("withdrawal-waiting");
      await confirmWithdrawal.promise;
    }
  });
  await input.makeIncompatible();
  accountAvailable = false;
  expectedSiblingToken = await input.sibling.renew();
  const incompatiblePass = await advanceMaintenance();
  await waitFor("the confirmed-withdrawal boundary", async () =>
    events.includes("withdrawal-waiting") ? true : undefined,
  );
  assert.deepEqual(Object.keys(sender().credentials), []);
  assert.ok(
    Object.values(siblingSender().credentials).includes(input.sibling.accessToken),
    "the sibling is not released before withdrawal is confirmed",
  );
  const incompatibleEvents = events.length;
  holdWithdrawal = false;
  confirmWithdrawal.resolve();
  await completed(incompatiblePass);
  assert.deepEqual(Object.keys(sender().credentials), []);
  assert.ok(
    Object.values(siblingSender().credentials).includes(expectedSiblingToken),
    "the first unavailable account does not block its authorized sibling",
  );
  assert.equal(events.slice(incompatibleEvents).includes("publish"), false);

  // Google remains an issuer/receiver match, but its Gmail-only grant cannot run a
  // Calendar operation. The real slot's no-delivery result must isolate this case too.
  await input.removeEligibleRoutes();
  expectedSiblingToken = await input.sibling.renew();
  const noRoutePass = await advanceMaintenance();
  await completed(noRoutePass);
  assert.deepEqual(Object.keys(sender().credentials), []);
  assert.ok(
    Object.values(siblingSender().credentials).includes(expectedSiblingToken),
    "zero eligible operations do not block the authorized sibling",
  );

  // Restoring the template re-enables the original saved grant on this same active revision.
  await input.restoreTemplate();
  accountAvailable = true;
  expectedSiblingToken = await input.sibling.renew();
  await completed(await advanceMaintenance());
  assert.ok(
    Object.values(sender().credentials).includes(input.expectedToken),
    "restoring the original template re-enables its existing grant",
  );
  assert.ok(Object.values(siblingSender().credentials).includes(expectedSiblingToken));
  assert.equal(
    (await state.read((view) => view.agents.findAgent(namespaceId, agentId))).activeRevisionId,
    revision.id,
  );
  assert.equal(
    await state.read((view) =>
      view.credentialSources.findCredentialWithdrawal(namespaceId, revision.id, sourceId),
    ),
    undefined,
  );
  // An operational withdrawal failure must still block publication. Observe a real finished
  // Worker attempt, rather than depending on the queue's transient retry state/reason code.
  await input.makeIncompatible();
  rejectWithdrawal = true;
  const beforeFailure = expectedSiblingToken;
  expectedSiblingToken = await input.sibling.renew();
  const failureEvents = workerEvents.length;
  const failedPass = await advanceMaintenance();
  await waitFor("the failed withdrawal attempt to finish", async () =>
    events.includes("withdrawal-failed") &&
    workerEvents
      .slice(failureEvents)
      .some((event) => event.event === "worker.completed" && event.workId === failedPass)
      ? true
      : undefined,
  );
  assert.ok(
    Object.values(siblingSender().credentials).includes(beforeFailure),
    "an unconfirmed withdrawal remains fail closed",
  );
  await worker.stop();
}
