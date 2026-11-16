import assert from "node:assert/strict";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { withComputeWorkWaiting } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { AgentRevision, ComputeRevisionContext } from "../../packages/contracts/src/index.ts";
import { ActivationFailedError, ActivationPendingError } from "../../packages/occ/src/index.ts";
import { authContext, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
import {
  containerEnv,
  prepareAndMarkWorkloadsReady,
  renderedRecord,
  templateContainer,
  type DedicatedDeployFixtureFactory,
} from "./kubernetes-workspace-node-delivery-cases.ts";

function activationContext(revision: AgentRevision): ComputeRevisionContext {
  return { ...authContext(revision), secretEnvironment: [] };
}

function activationFixture(createFixture: DedicatedDeployFixtureFactory) {
  // Activation polls and enrollment observations share one clock.
  const clock = { now: 0 };
  const fixture = createFixture({
    clock,
    delay: async (ms) => {
      clock.now += ms;
    },
  });
  return { ...fixture, clock };
}

async function workspaceNodeAwaitingAckFixture(createFixture: DedicatedDeployFixtureFactory) {
  const fixture = activationFixture(createFixture);
  const { state, prepare } = fixture;
  await prepareAndMarkWorkloadsReady(fixture);
  state.connected = true;
  state.gatewayAppliesBinding = false;
  assert.equal((await prepare()).ready, true);
  return fixture;
}

// Ratchet for deploy time: every workload start of a first dedicated deploy
// repeats login, the model probe and plugin install, and every pending pass is a
// wait on a start. Lower these counts when a change removes a start or a pass;
// never raise them silently.
export async function checkFirstDeployWorkloadStarts(createFixture: DedicatedDeployFixtureFactory) {
  const {
    state,
    driver,
    revision,
    gatewayName,
    agentName,
    templates,
    podPatches,
    clients,
    read,
    prepare,
    markWorkloadsReady,
  } = activationFixture(createFixture);
  // Workloads become ready as soon as the controller waits on them, so every
  // pending pass below is a wait on a workload start, not on test timing.
  let pendingPasses = 0;
  const pass = async () => {
    const { ready } = await prepare();
    pendingPasses += Number(!ready);
    return ready;
  };
  assert.equal(
    await pass(),
    false,
    "the Harness starts with its node wiring, and the Gateway alongside it",
  );
  // Both start in the first pass (the Gateway Deployment is reconciled first).
  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness"],
  );
  markWorkloadsReady();
  // The setup reaches the running Harness through its volume and the node pairs
  // a moment later, without a workload start. The pass that delivered the setup
  // sees the pairing and completes: no pending pass once the workloads are ready.
  state.pairAfterSetupMs = 10;
  assert.equal(await pass(), true);
  assert.equal(pendingPasses, 1);
  // That pass also handed the node to the Gateway (binding plus one Pod nudge),
  // so the hot-apply overlaps the worker's commit and activation's own work.
  assert.equal(state.gatewayWorkspaceNodeId, "node-1");
  let statusReads = 0;
  const proxy = clients.core.connectGetNamespacedPodProxyWithPath;
  assert.ok(proxy);
  clients.core.connectGetNamespacedPodProxyWithPath = async (request) => {
    if (request.path === "openclaw/runtime/status" && request.name.startsWith("gateway-")) {
      statusReads++;
    }
    return proxy(request);
  };
  await driver.activateRevision(revision, activationContext(revision));
  assert.equal(statusReads, 1, "activation finds the Gateway's ack on its first read");
  assert.equal(state.setupCalls, 1);
  assert.equal(
    podPatches.filter(({ name }) => name === "gateway-pod").length,
    1,
    "the running Gateway Pod is nudged once, by preparation",
  );

  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness"],
  );
  const [gateway, harness] = templates;
  assert.ok(gateway && harness);
  const gatewayPod = templateContainer(gateway.template);
  const harnessEnvironment = containerEnv(templateContainer(harness.template).container);
  const gatewayEnvironment = containerEnv(gatewayPod.container);
  // Harness start 1 already runs the node supervisor; no setup code in its pod spec.
  assert.equal(
    harnessEnvironment.some(({ name }) => name === "OPENCLAW_NODE_SETUP_CODE"),
    false,
  );
  assert.equal(
    harnessEnvironment.some(({ name }) => name === "OPENCLAW_NODE_SETUP_PATH"),
    true,
  );
  // Gateway start 1 carries the optional binding volume from its first render;
  // the node id never enters its pod spec.
  assert.equal(
    gatewayEnvironment.some(({ name }) => name === "OPENCLAW_WORKSPACE_NODE_ID"),
    false,
  );
  assert.equal(
    gatewayEnvironment.some(({ name }) => name === "OPENCLAW_WORKSPACE_NODE_PATH"),
    true,
  );
  assert.ok(Array.isArray(gatewayPod.pod.volumes));
  assert.deepEqual(
    gatewayPod.pod.volumes.find(
      (volume: unknown) => asRecord(volume)?.name === "openclaw-workspace-node",
    ),
    {
      name: "openclaw-workspace-node",
      configMap: {
        name: `${gatewayName}-workspace-node`,
        items: [{ key: "workspace-node.json", path: "workspace-node.json" }],
        optional: true,
      },
    },
  );
  assert.deepEqual(
    renderedRecord(
      read("Deployment", gatewayName, kubernetesNamespaceName(tenant.id)).spec,
      "Gateway Deployment spec",
    ).template,
    gateway.template,
  );
}

// The pass that sees the node pair hands it to the Gateway. Activation still
// waits for the Gateway's own report of that node, and does not nudge again.
export async function checkActivationAwaitsPreparedNode(
  createFixture: DedicatedDeployFixtureFactory,
) {
  const { state, driver, revision, podPatches, clients, prepare, markWorkloadsReady } =
    createFixture();
  assert.equal((await prepare()).ready, false);
  markWorkloadsReady();
  state.connected = true;
  // The kubelet has not refreshed the binding volume yet.
  state.gatewayAppliesBinding = false;
  assert.equal((await prepare()).ready, true);
  assert.equal(state.gatewayWorkspaceNodeId, undefined);
  let statusReads = 0;
  const proxy = clients.core.connectGetNamespacedPodProxyWithPath;
  assert.ok(proxy);
  clients.core.connectGetNamespacedPodProxyWithPath = async (request) => {
    if (request.path === "openclaw/runtime/status" && request.name.startsWith("gateway-")) {
      statusReads++;
      if (statusReads === 2) {
        state.gatewayWorkspaceNodeId = "node-1";
      }
    }
    return proxy(request);
  };
  await driver.activateRevision(revision, activationContext(revision));
  assert.equal(statusReads, 2);
  assert.equal(podPatches.filter(({ name }) => name === "gateway-pod").length, 1);
}

// Activation that fails for want of the Gateway's ack is retried, and the worker
// is serial: a Gateway that never acks gets one bounded wait per binding across
// attempts, then a single read per attempt, like the pairing budget (D221).
export async function checkBoundedAcknowledgementAcrossActivations(
  createFixture: DedicatedDeployFixtureFactory,
) {
  const { clock, state, driver, revision } = await workspaceNodeAwaitingAckFixture(createFixture);
  const attemptTimes: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const started = clock.now;
    await assert.rejects(
      driver.activateRevision(revision, activationContext(revision)),
      (error) => {
        // D330: the worker records this wait under its own code.
        assert.ok(error instanceof ActivationPendingError);
        assert.equal(error.code, "WORKSPACE_NODE_BINDING_PENDING");
        assert.match(error.message, /has not applied its workspace node/);
        return true;
      },
    );
    attemptTimes.push(clock.now - started);
  }
  assert.deepEqual(attemptTimes, [20_000, 0, 0, 0]);
  // A late ack is still seen by the next single read.
  state.gatewayWorkspaceNodeId = "node-1";
  await driver.activateRevision(revision, activationContext(revision));
  assert.equal(clock.now, 20_000);
}

// Activation's ack wait yields the same way: activation fails and is retried,
// and the yielded time is not taken from the binding's ack budget. Waiting
// never relaxes the ack check: a present ack is accepted on the first read and
// an invalid status is still refused (D221).
export async function checkAcknowledgementYieldsToDueWork(
  createFixture: DedicatedDeployFixtureFactory,
) {
  const { clock, state, driver, revision, clients } =
    await workspaceNodeAwaitingAckFixture(createFixture);
  const proxy = clients.core.connectGetNamespacedPodProxyWithPath;
  assert.ok(proxy);
  const acknowledgement: { atMs?: number; foreignRevision: boolean } = { foreignRevision: false };
  clients.core.connectGetNamespacedPodProxyWithPath = async (request) => {
    if (acknowledgement.atMs !== undefined && clock.now >= acknowledgement.atMs) {
      state.gatewayWorkspaceNodeId = "node-1";
    }
    const status = await proxy(request);
    if (acknowledgement.foreignRevision && request.path === "openclaw/runtime/status") {
      return {
        ...renderedRecord(status, "Gateway status"),
        revisionId: "another-revision",
        workspaceNodeId: "node-1",
      };
    }
    return status;
  };
  const otherDueAt = clock.now + 500;
  const waiting = async () => clock.now >= otherDueAt;
  await assert.rejects(
    withComputeWorkWaiting(waiting, () =>
      driver.activateRevision(revision, activationContext(revision)),
    ),
    /has not applied its workspace node/,
  );
  assert.equal(clock.now, otherDueAt);
  // Even the exact device ID is insufficient when a different revision reports it.
  acknowledgement.foreignRevision = true;
  await assert.rejects(
    withComputeWorkWaiting(waiting, () =>
      driver.activateRevision(revision, activationContext(revision)),
    ),
    /Runtime status returned invalid data/,
  );
  acknowledgement.foreignRevision = false;
  assert.equal(clock.now, otherDueAt);
  // With nothing waiting, the retry still has the rest of the 20 s budget and
  // sees an ack that arrives 3 s later.
  acknowledgement.atMs = clock.now + 3_000;
  await withComputeWorkWaiting(
    async () => false,
    () => driver.activateRevision(revision, activationContext(revision)),
  );
  assert.equal(clock.now, otherDueAt + 3_000);
  // A present ack is accepted on the first read even with Work waiting.
  const before = clock.now;
  await withComputeWorkWaiting(
    async () => true,
    () => driver.activateRevision(revision, activationContext(revision)),
  );
  assert.equal(clock.now, before);
}

export async function checkActivationReportsGatewayRejection(
  createFixture: DedicatedDeployFixtureFactory,
) {
  const { state, driver, revision, gatewayName, agentName, templates, prepare, markReady } =
    createFixture();
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  state.connected = true;
  // The wrapper writes the node it is handed in this pass, but OpenClaw never
  // reports file-transfer loaded.
  state.gatewayAppliesBinding = false;
  assert.equal((await prepare()).ready, true);
  state.gatewayWorkspaceNodeFailure = {
    code: "RELOAD_NOT_CONFIRMED",
    checkedAt: "2026-09-29T12:00:00.000Z",
  };
  await assert.rejects(
    driver.activateRevision(revision, activationContext(revision)),
    /gateway could not apply its workspace node \(RELOAD_NOT_CONFIRMED\)/,
  );
  // A Gateway that refuses its own CLI as unauthorized never applies the node
  // for this revision (D381): activation fails with a named code, not a retry.
  state.gatewayWorkspaceNodeFailure = {
    code: "GATEWAY_UNAUTHORIZED",
    checkedAt: "2026-09-29T12:00:00.000Z",
  };
  await assert.rejects(driver.activateRevision(revision, activationContext(revision)), (error) => {
    assert.ok(error instanceof ActivationFailedError, String(error));
    assert.equal(error.code, "AGENT_GATEWAY_UNAUTHORIZED");
    return true;
  });
  // A malformed cause is refused, not trusted.
  state.gatewayWorkspaceNodeFailure = { code: "not a code" };
  await assert.rejects(
    driver.activateRevision(revision, activationContext(revision)),
    /Runtime status returned invalid data/,
  );
  // Neither failure replaced the serving Gateway.
  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness"],
  );
}

// The start-count ratchet for installs without network.pluginStatusProxySourceCidrs.
// The second Gateway start is the price of omitting them: the development
// launcher sets them (internal/occdev status_proxy_k3d.go), so its first deploys
// take the single-start path pinned above.
export async function checkActivationWithoutStatusProxy(
  createFixture: DedicatedDeployFixtureFactory,
) {
  const {
    state,
    driver,
    revision,
    gatewayName,
    agentName,
    objects,
    templates,
    prepare,
    markReady,
  } = createFixture({ statusProxy: false });
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  markReady(gatewayName);
  state.connected = true;
  assert.equal((await prepare()).ready, true);
  // The controller cannot read an ack, so the node is applied at Gateway start.
  await assert.rejects(
    driver.activateRevision(revision, activationContext(revision)),
    /gateway is not ready/,
  );
  markReady(gatewayName);
  await driver.activateRevision(revision, activationContext(revision));
  const gateways = templates.filter(({ name }) => name === gatewayName);
  assert.equal(gateways.length, 2, "activation replaces the Gateway once");
  assert.deepEqual(
    templates.map(({ name }) => (name === agentName ? "harness" : name)),
    [gatewayName, "harness", gatewayName],
    "Harness 1 + Gateway 2",
  );
  const activeGateway = gateways.at(-1);
  assert.ok(activeGateway);
  const { pod, container } = templateContainer(activeGateway.template);
  const environment = containerEnv(container);
  assert.equal(
    environment.find(({ name }) => name === "OPENCLAW_WORKSPACE_NODE_ID")?.value,
    "node-1",
  );
  assert.equal(
    environment.find(({ name }) => name === "OPENCLAW_WORKSPACE_NODE_PATH")?.value,
    undefined,
  );
  assert.ok(Array.isArray(pod.volumes));
  assert.equal(
    pod.volumes.some((volume: unknown) => asRecord(volume)?.name === "openclaw-workspace-node"),
    false,
  );
  assert.equal(
    [...objects.values()].some(
      (object) => object.kind === "ConfigMap" && object.metadata.name.endsWith("-workspace-node"),
    ),
    false,
  );
}
