import assert from "node:assert/strict";
import {
  kubernetesNamespaceName,
  type KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { withComputeWorkWaiting } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { digest, tenant } from "../helpers/kubernetes-routed-scenarios.mjs";
import type { createDedicatedDeployKubernetesFixture } from "./kubernetes-dedicated-deploy-fixture.ts";
import {
  assertExecStringsWithinBudget,
  containerProgram,
  EXEC_STRING_BUDGET,
} from "./kubernetes-workload-program-cases.ts";

type DeployTransport = ReturnType<typeof createDedicatedDeployKubernetesFixture>;
type DedicatedDeployFixture = DeployTransport & {
  driver: KubernetesComputeDriver;
  revision: AgentRevision;
  namespace: string;
  gatewayName: string;
  agentName: string;
  state: {
    setupCalls: number;
    connected: boolean;
    gatewayAppliesBinding: boolean;
    gatewayWorkspaceNodeId: unknown;
    gatewayWorkspaceNodeFailure: unknown;
    pairAfterSetupMs: number | undefined;
    observeWaits: number[];
    pairAtMs: number | undefined;
    failAtMs: number | undefined;
    stepObservations: boolean;
  };
  prepare: () => ReturnType<KubernetesComputeDriver["prepareRevision"]>;
  markWorkloadsReady: () => void;
};

export type DedicatedDeployFixtureFactory = (options?: {
  statusProxy?: boolean;
  clock?: { now: number };
  delay?: (ms: number) => Promise<void>;
  revision?: Pick<AgentRevision, "id" | "agentId" | "configurationId" | "servicePrincipalId">;
}) => DedicatedDeployFixture;

const secondAgent = {
  id: "revision-a-1",
  agentId: "agent-a",
  configurationId: "cfg_00000000-0000-4000-8000-000000000001",
  servicePrincipalId: "service-principal-agent-a",
};

export function renderedRecord(value: unknown, description: string) {
  const record = asRecord(value);
  assert.ok(record, `expected ${description}`);
  return record;
}

function renderedRecords(value: unknown, description: string) {
  assert.ok(Array.isArray(value), `expected ${description} array`);
  return value.map((item: unknown) => renderedRecord(item, description));
}

function renderedString(value: unknown, description: string) {
  assert.ok(typeof value === "string", `expected a string for ${description}`);
  return value;
}

function commandStrings(value: unknown) {
  assert.ok(Array.isArray(value), "expected command arguments");
  return value.map((item: unknown) => renderedString(item, "command argument"));
}

export function templateContainer(template: unknown) {
  const pod = renderedRecord(renderedRecord(template, "Pod template").spec, "Pod spec");
  assert.ok(Array.isArray(pod.containers), "expected Pod containers");
  const container = renderedRecord(pod.containers[0], "first container");
  return { pod, container };
}

export function containerEnv(container: Record<string, unknown>) {
  return renderedRecords(container.env, "container environment entry");
}

function workspaceSetupSecret(objects: DeployTransport["objects"]) {
  const secret = [...objects.values()].find(
    (object) => object.kind === "Secret" && typeof asRecord(object.data)?.setupCode === "string",
  );
  assert.ok(secret, "expected the workspace node setup Secret");
  return secret;
}

function patchAnnotations(body: unknown) {
  return renderedRecord(
    renderedRecord(renderedRecord(body, "Pod patch").metadata, "Pod patch metadata").annotations,
    "Pod patch annotations",
  );
}

// The node wiring a Deployment-backed Codex Harness renders from its first start.
function harnessNodeSetup(template: unknown) {
  const { pod, container } = templateContainer(template);
  return {
    environment: containerEnv(container)
      .filter(({ name }) => typeof name === "string" && name.startsWith("OPENCLAW_NODE_SETUP"))
      .map(({ name, value, valueFrom }) => ({ name, value, valueFrom })),
    volume: renderedRecords(pod.volumes, "Pod volume").find(
      ({ name }) => name === "openclaw-node-setup",
    ),
    mount: renderedRecords(container.volumeMounts, "container volume mount").find(
      ({ name }) => name === "openclaw-node-setup",
    ),
    command: container.command,
  };
}

export async function prepareAndMarkWorkloadsReady({
  prepare,
  markWorkloadsReady,
}: Pick<DedicatedDeployFixture, "prepare" | "markWorkloadsReady">) {
  assert.equal((await prepare()).ready, false);
  markWorkloadsReady();
}

export async function checkStartupPluginInitialization(
  createFixture: DedicatedDeployFixtureFactory,
) {
  const {
    state,
    revision,
    namespace,
    gatewayName,
    agentName,
    objects,
    podPatches,
    key,
    read,
    save,
    prepare,
    markReady,
  } = createFixture();
  assert.equal((await prepare()).ready, false);
  const initialNodeSetup = harnessNodeSetup(
    renderedRecord(read("Deployment", agentName).spec, "Harness Deployment spec").template,
  );
  // The node is named after the Agent, not after the revision's Pod (D85).
  assert.equal(
    containerEnv(
      templateContainer(
        renderedRecord(read("Deployment", agentName).spec, "Harness Deployment spec").template,
      ).container,
    ).find(({ name }) => name === "OPENCLAW_NODE_DISPLAY_NAME")?.value,
    `agent-${digest(revision.agentId)}-workspace`,
  );
  const configMap = read(
    "ConfigMap",
    `gateway-${digest(revision.agentId)}-rev-${digest(revision.id)}`,
    kubernetesNamespaceName(tenant.id),
  );
  const configuration: unknown = JSON.parse(
    renderedString(
      renderedRecord(configMap.data, "Gateway ConfigMap data")["openclaw.json"],
      "openclaw.json",
    ),
  );
  const gateway = renderedRecord(
    renderedRecord(configuration, "Gateway configuration").gateway,
    "Gateway settings",
  );
  assert.equal(gateway.bind, "lan");
  assert.deepEqual(gateway.trustedProxies, ["10.42.0.0/16"]);
  assert.equal(gateway.allowRealIpFallback, true);
  assert.deepEqual(gateway.auth, {
    mode: "trusted-proxy",
    trustedProxy: {
      requiredHeaders: ["x-real-ip", "x-openclaw-scopes"],
      allowLoopback: false,
      userHeader: "x-occ-identity",
      allowUsers: ["occ-workspace-files"],
    },
    identityScopes: { "occ-workspace-files": ["operator.admin"] },
  });
  assert.deepEqual(revision.configuration.gateway, {
    bind: "lan",
    auth: { trustedProxy: { requiredHeaders: ["x-real-ip"], allowLoopback: false } },
  });
  assert.equal(state.setupCalls, 0);
  // A first deploy creates the Gateway alongside the Harness. Its peer status read
  // goes through the agent Service, which already selects this revision's Harness;
  // endpoints list only ready pods, so the Gateway waits until the Harness reports.
  assert.ok(
    objects.has(key("Deployment", gatewayName, kubernetesNamespaceName(tenant.id))),
    "the first Gateway starts alongside the Harness",
  );
  assert.deepEqual(
    renderedRecord(
      read("Service", `agent-${digest(revision.agentId)}`).spec,
      "Harness Service spec",
    ).selector,
    {
      "openclaw.dev/network-profile": "broad-egress-v1",
      "openclaw.dev/namespace": revision.namespaceId,
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/revision": revision.id,
      "openclaw.dev/workload-role": "agent",
      "app.kubernetes.io/name": agentName,
    },
  );
  assert.ok(
    objects.has(key("Deployment", agentName)),
    "Harness can initialize plugins without the node",
  );
  const initialStrategy = renderedRecord(
    renderedRecord(read("Deployment", agentName).spec, "Harness Deployment spec").strategy,
    "Harness Deployment strategy",
  );
  assert.equal(
    initialStrategy.type,
    "Recreate",
    "the Deployment starts with Recreate before enrollment",
  );
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  assert.equal(state.setupCalls, 0, "enrollment waits for Gateway readiness");
  markReady(gatewayName);
  const harnessBeforeSetup = read("Deployment", agentName);
  assert.equal((await prepare()).ready, false, "running workloads alone are not node readiness");
  assert.equal(state.setupCalls, 1);
  const agent = read("Deployment", agentName);
  const harnessSpec = renderedRecord(agent.spec, "Harness Deployment spec");
  assert.deepEqual(harnessSpec.strategy, initialStrategy);
  // The setup reaches the running Harness through its optional volume: creating
  // the Secret changes no pod template, so neither the Harness nor its Gateway restarts.
  assert.deepEqual(
    harnessSpec.template,
    renderedRecord(harnessBeforeSetup.spec, "previous Harness Deployment spec").template,
  );
  assert.equal(agent.metadata.generation, harnessBeforeSetup.metadata.generation);
  assert.deepEqual(
    podPatches.map(({ name, namespace: target, body }) => ({
      name,
      target,
      annotations: Object.keys(patchAnnotations(body)),
    })),
    [{ name: "agent-pod", target: namespace, annotations: ["openclaw.dev/workspace-node-setup"] }],
  );
  const nodeSecretName = workspaceSetupSecret(objects).metadata.name;
  // The first Harness template already carries the node wiring. The setup code
  // is not in its environment: one optional Secret item is mounted read-only,
  // so the Harness starts before the Secret exists.
  assert.deepEqual(initialNodeSetup, {
    environment: [
      {
        name: "OPENCLAW_NODE_SETUP_PATH",
        value: "/run/openclaw-node-setup/setup-code",
        valueFrom: undefined,
      },
    ],
    volume: {
      name: "openclaw-node-setup",
      secret: {
        secretName: nodeSecretName,
        optional: true,
        // Kubelet grants fsGroup read on Secret files, so 0400 would act as 0440.
        defaultMode: 0o440,
        items: [{ key: "setupCode", path: "setup-code" }],
      },
    },
    mount: {
      name: "openclaw-node-setup",
      mountPath: "/run/openclaw-node-setup",
      readOnly: true,
    },
    command: [...RUNTIME_WRAPPER_COMMAND],
  });
  assert.deepEqual(
    Object.keys(
      renderedRecord(read("Secret", nodeSecretName).data, "workspace node Secret data"),
    ).sort(),
    ["expiresAtMs", "setupCode", "setupId"],
  );
  // The recorded node id reaches the candidate Gateway through its Agent-scoped
  // binding and a Pod nudge in the same pass; its pod template does not change.
  const gatewayNamespace = kubernetesNamespaceName(tenant.id);
  const gatewayBeforeBinding = read("Deployment", gatewayName, gatewayNamespace);
  state.connected = true;
  assert.equal((await prepare()).ready, true);
  assert.equal(state.setupCalls, 1);
  // Once the device is recorded the node reconnects with its saved device
  // token. The setup code, readable by Codex in the same container, is removed.
  // The Secret names this revision as the one whose node enrolled (finding 1671).
  const enrolledData = renderedRecord(
    read("Secret", nodeSecretName).data,
    "enrolled workspace node Secret data",
  );
  assert.deepEqual(Object.keys(enrolledData).sort(), [
    "deviceId",
    "enrolledRevisionId",
    "expiresAtMs",
    "setupId",
  ]);
  assert.equal(
    Buffer.from(
      renderedString(enrolledData.enrolledRevisionId, "enrolled revision ID"),
      "base64",
    ).toString("utf8"),
    revision.id,
  );
  // The removal nudges the running Harness Pod again, with a new value, so the
  // kubelet removes the file now instead of on its periodic resync.
  assert.equal(podPatches.length, 3);
  const [minted, removed] = podPatches
    .slice(0, 2)
    .map(({ body }) => patchAnnotations(body)["openclaw.dev/workspace-node-setup"]);
  assert.notEqual(minted, removed);
  assert.equal(podPatches[1]?.name, "agent-pod");
  const gatewayAfterBinding = read("Deployment", gatewayName, gatewayNamespace);
  assert.deepEqual(
    renderedRecord(gatewayAfterBinding.spec, "Gateway Deployment spec").template,
    renderedRecord(gatewayBeforeBinding.spec, "previous Gateway Deployment spec").template,
  );
  assert.equal(gatewayAfterBinding.metadata.generation, gatewayBeforeBinding.metadata.generation);
  const binding = read("ConfigMap", `${gatewayName}-workspace-node`, gatewayNamespace);
  assert.deepEqual(
    JSON.parse(
      renderedString(
        renderedRecord(binding.data, "workspace binding ConfigMap data")["workspace-node.json"],
        "workspace-node.json",
      ),
    ),
    {
      revisionId: revision.id,
      deviceId: "node-1",
    },
  );
  assert.equal(binding.immutable, undefined);
  assert.equal(
    renderedRecord(binding.metadata.labels, "workspace binding ConfigMap labels")[
      "openclaw.dev/agent"
    ],
    revision.agentId,
  );
  assert.deepEqual(
    podPatches.slice(2).map(({ name, namespace: target, body }) => ({
      name,
      target,
      annotations: Object.keys(patchAnnotations(body)),
    })),
    [
      {
        name: "gateway-pod",
        target: gatewayNamespace,
        annotations: ["openclaw.dev/workspace-node-binding"],
      },
    ],
  );
  // A paired file-delivered node reconnects with its saved device token, so an
  // expired setup is not re-minted and the code does not come back.
  const paired = read("Secret", nodeSecretName);
  const pairedData = renderedRecord(paired.data, "paired workspace node Secret data");
  pairedData.expiresAtMs = Buffer.from(String(Date.now() - 1)).toString("base64");
  save(paired);
  // An unchanged binding is neither rewritten nor nudged again.
  assert.equal((await prepare()).ready, true);
  assert.equal(
    renderedRecord(read("Secret", nodeSecretName).data, "workspace node Secret data").setupCode,
    undefined,
  );
  assert.equal(state.setupCalls, 1, "a paired node needs no new setup");
  assert.equal(podPatches.length, 3);
  // The node supervisor embeds Codex; neither it nor an OpenShell Sandbox, which
  // carries the whole command in one environment variable, nears the exec limit.
  assertExecStringsWithinBudget(objects.values());
  const finalHarness = read("Deployment", agentName);
  const { container: harness } = templateContainer(
    renderedRecord(finalHarness.spec, "Harness Deployment spec").template,
  );
  const command = [...commandStrings(harness.command), ...commandStrings(harness.args)];
  assert.equal(command[0], "/usr/bin/tini");
  const commandBytes = Buffer.byteLength(JSON.stringify(command));
  assert.ok(
    commandBytes <= EXEC_STRING_BUDGET,
    `the serialized Harness command is ${commandBytes} bytes; the budget is ${EXEC_STRING_BUDGET}`,
  );
  assert.doesNotMatch(containerProgram(harness), /^[ \t]*\/\//m);
}

// Every Agent enrolled before file delivery has a recorded deviceId and an
// env-era setupCode in its Secret. The upgrade removes the leftover code without
// a new setup, and a Harness Pod that is gone (404) does not fail the pass.
export async function checkUpgradeRemovesSetupCode(createFixture: DedicatedDeployFixtureFactory) {
  const { state, clients, read, save, prepare, markReady, agentName, gatewayName } =
    createFixture();
  // Start the upgrade with an existing Agent-owned Secret carrying the old setup code.
  const previous = createFixture({ clock: { now: 0 } });
  await prepareAndMarkWorkloadsReady(previous);
  assert.equal((await previous.prepare()).ready, false);
  const secret = workspaceSetupSecret(previous.objects);
  const nodeName = secret.metadata.name;
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
  save({
    apiVersion: secret.apiVersion,
    kind: secret.kind,
    type: secret.type,
    metadata: secret.metadata,
    data: {
      deviceId: encode("node-1"),
      setupCode: encode("env-era-code"),
      setupId: encode("setup-0"),
      expiresAtMs: encode(String(Date.now() - 1)),
    },
  });
  const nodeSecretReplaces: string[][] = [];
  const replaceSecret = clients.core.replaceNamespacedSecret;
  assert.ok(replaceSecret);
  clients.core.replaceNamespacedSecret = async (request) => {
    if ("name" in request && request.name === nodeName) {
      nodeSecretReplaces.push(
        Object.keys(renderedRecord(request.body.data, "replacement Secret data")).sort(),
      );
    }
    return replaceSecret(request);
  };
  const missingPods: string[] = [];
  clients.core.patchNamespacedPod = async ({ name }) => {
    missingPods.push(name);
    throw Object.assign(new Error("pods not found"), { code: 404 });
  };
  state.connected = true;
  let ready = false;
  for (let pass = 0; pass < 6 && !ready; pass++) {
    ready = (await prepare()).ready;
    for (const name of [agentName, gatewayName]) {
      // A workload that this pass has not started yet has nothing to mark.
      try {
        markReady(name);
      } catch (error) {
        assert.equal(asRecord(error)?.statusCode, 404);
      }
    }
  }
  assert.equal(ready, true);
  assert.equal(state.setupCalls, 0, "a recorded device needs no new setup");
  // One write drops the code and records the connected node's revision as enrolled.
  assert.deepEqual(nodeSecretReplaces, [
    ["deviceId", "enrolledRevisionId", "expiresAtMs", "setupId"],
  ]);
  assert.equal(
    renderedRecord(read("Secret", nodeName).data, "upgraded Secret data").setupCode,
    undefined,
  );
  assert.deepEqual(
    missingPods.filter((name) => name === "agent-pod"),
    ["agent-pod"],
    "the removal nudge ran once and its 404 was ignored",
  );
  // The Gateway binding nudge tolerates a missing Pod the same way.
  assert.deepEqual(
    missingPods.filter((name) => name === "gateway-pod"),
    ["gateway-pod"],
  );
}

// A node that has not paired within the pass's wait leaves the pass pending; the
// wait starts only once the setup exists and the Gateway is ready.
export async function checkInitialPairingWait(createFixture: DedicatedDeployFixtureFactory) {
  const { state, gatewayName, agentName, objects, prepare, markReady } = createFixture();
  assert.equal((await prepare()).ready, false);
  markReady(agentName);
  assert.equal((await prepare()).ready, false);
  assert.deepEqual(state.observeWaits, [], "no enrollment call before the Gateway is ready");
  markReady(gatewayName);
  const started = Date.now();
  assert.equal((await prepare()).ready, false);
  assert.deepEqual(state.observeWaits, [60]);
  assert.ok(Date.now() - started >= 60);
  assert.equal(
    [...objects.values()].some(
      (object) => object.kind === "ConfigMap" && object.metadata.name.endsWith("-workspace-node"),
    ),
    false,
    "no node is handed to the Gateway before it pairs",
  );
  state.connected = true;
  assert.equal((await prepare()).ready, true);
}

// The worker is serial: every pass one Agent spends waiting for its node holds
// up every other Agent's deploy. A node that never pairs gets one bounded wait
// per setup, across all passes, then a single read per pass, as before #816 (D88).
export async function checkBoundedPairingAcrossPasses(
  createFixture: DedicatedDeployFixtureFactory,
) {
  const clock: { now: number } = { now: 0 };
  const fixture = createFixture({ clock });
  const { state, prepare } = fixture;
  await prepareAndMarkWorkloadsReady(fixture);
  const passTimes: number[] = [];
  for (let pass = 0; pass < 6; pass++) {
    const started = clock.now;
    assert.equal((await prepare()).ready, false);
    passTimes.push(clock.now - started);
  }
  assert.deepEqual(state.observeWaits, [8_000, 0, 0, 0, 0, 0]);
  assert.deepEqual(passTimes, [8_000, 0, 0, 0, 0, 0]);
  // A late pairing is still seen by the next single read.
  state.connected = true;
  assert.equal((await prepare()).ready, true);
  assert.equal(clock.now, 8_000);
}

// The normal first deploy keeps #816's fast path: the node pairs within the
// first ready pass's wait, which ends at the pairing, so no pass ends pending.
export async function checkPairingCompletesInFirstReadyPass(
  createFixture: DedicatedDeployFixtureFactory,
) {
  const clock: { now: number } = { now: 0 };
  const fixture = createFixture({ clock });
  const { state, prepare } = fixture;
  await prepareAndMarkWorkloadsReady(fixture);
  state.pairAtMs = 3_000;
  assert.equal((await prepare()).ready, true);
  assert.deepEqual(state.observeWaits, [8_000]);
  assert.equal(clock.now, 3_000, "the pass ends as soon as the node pairs");
  assert.equal(state.gatewayWorkspaceNodeId, "node-1", "and hands the node to the Gateway");
}

// A partly spent budget carries over: a wait cut short (the Gateway restarted
// mid-wait) leaves the next pass only the rest of it.
export async function checkPairingBudgetCarryover(createFixture: DedicatedDeployFixtureFactory) {
  const clock: { now: number } = { now: 0 };
  const fixture = createFixture({ clock });
  const { state, prepare } = fixture;
  await prepareAndMarkWorkloadsReady(fixture);
  state.failAtMs = 5_000;
  await assert.rejects(prepare(), /Gateway connection closed/);
  state.failAtMs = undefined;
  assert.equal((await prepare()).ready, false);
  assert.equal((await prepare()).ready, false);
  assert.deepEqual(state.observeWaits, [8_000, 3_000, 0]);
  assert.equal(clock.now, 8_000);
}

export async function checkIndependentAgentPairing(createFixture: DedicatedDeployFixtureFactory) {
  const clock: { now: number } = { now: 0 };
  const stuck = createFixture({ clock });
  const fresh = createFixture({ clock, revision: secondAgent });
  for (const agent of [stuck, fresh]) {
    await prepareAndMarkWorkloadsReady(agent);
  }
  // The stuck Agent's first ready pass spends its one wait.
  assert.equal((await stuck.prepare()).ready, false);
  assert.equal(clock.now, 8_000);
  // From here the single serial worker alternates between the two Agents. The
  // fresh Agent's node pairs 2 s after its first ready pass starts.
  fresh.state.pairAtMs = clock.now + 2_000;
  const freshStarts: number[] = [];
  let freshReady = false;
  for (let round = 0; round < 4; round++) {
    const before: number = clock.now;
    assert.equal((await stuck.prepare()).ready, false);
    assert.equal(clock.now, before, "the stuck Agent's pass does not wait again");
    if (!freshReady) {
      freshStarts.push(clock.now);
      freshReady = (await fresh.prepare()).ready;
    }
  }
  assert.equal(freshReady, true);
  assert.deepEqual(freshStarts, [8_000], "the fresh Agent pairs within its first ready pass");
  assert.equal(clock.now, 10_000);
  assert.deepEqual(stuck.state.observeWaits, [8_000, 0, 0, 0, 0]);
  assert.deepEqual(fresh.state.observeWaits, [8_000]);
}

// The worker is serial. A first deploy's pairing wait only saves a later pass,
// so it ends as soon as another Agent's Work is due: the pass ends pending, the
// other Agent's pass runs at once, and the first Agent's next pass spends the
// rest of its budget and still completes on the pairing (D221).
export async function checkPairingYieldsToDueWork(createFixture: DedicatedDeployFixtureFactory) {
  const clock: { now: number } = { now: 0 };
  const first = createFixture({ clock });
  const second = createFixture({ clock, revision: secondAgent });
  for (const agent of [first, second]) {
    agent.state.stepObservations = true;
    await prepareAndMarkWorkloadsReady(agent);
  }
  first.state.pairAtMs = 6_000;
  second.state.pairAtMs = 1_500;
  // The second Agent's Work comes due 1 s into the first Agent's pass.
  const secondDueAt = 1_000;
  const waiting = async () => clock.now >= secondDueAt;
  const firstPass = await withComputeWorkWaiting(waiting, () => first.prepare());
  assert.equal(firstPass.ready, false);
  assert.equal(firstPass.pendingReason, "WORKSPACE_NODE_PENDING");
  assert.equal(clock.now, secondDueAt, "the second Agent's pass starts when its Work is due");
  // Nothing else is waiting while the second Agent's pass runs: it keeps #816's
  // fast path and completes on its own pairing.
  const secondPass = await withComputeWorkWaiting(
    async () => false,
    () => second.prepare(),
  );
  assert.equal(secondPass.ready, true);
  assert.equal(clock.now, 1_500);
  assert.equal(second.state.gatewayWorkspaceNodeId, "node-1");
  // The first Agent's next pass waits out the rest of its 8 s budget and sees
  // its node pair at 6 s; the yielded second only cost what it actually waited.
  const firstRetry = await withComputeWorkWaiting(
    async () => false,
    () => first.prepare(),
  );
  assert.equal(firstRetry.ready, true);
  assert.equal(clock.now, 6_000);
  assert.deepEqual(first.state.observeWaits, [8_000, 7_000]);
  assert.equal(first.state.gatewayWorkspaceNodeId, "node-1");
}
