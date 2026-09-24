import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  configureExistingK3dLocalPathSharedFileSystem,
  createKubernetesClient,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

const execute = promisify(execFile);
const kubeconfigPath = process.env.OCC_TEST_KUBERNETES_KUBECONFIG;
const kubernetesContext = process.env.OCC_TEST_KUBERNETES_CONTEXT;
const fixtureImage = process.env.OCC_TEST_KUBERNETES_IMAGE;
const selected = [kubeconfigPath, kubernetesContext, fixtureImage].some(Boolean);
const requiresKubernetes = {
  skip: selected
    ? false
    : "Set OCC_TEST_KUBERNETES_KUBECONFIG, OCC_TEST_KUBERNETES_CONTEXT, and OCC_TEST_KUBERNETES_IMAGE to run real Kubernetes plugin status tests.",
};

const pluginId = "occ-plugin:diffs";
const pluginStatusPort = 18791;
const pluginStatusPath = "/openclaw/plugin-runtime/status";
const transportSecretPrefix = "transport";
const pluginStatusProxyCidrs = parsePluginStatusProxyCidrs(
  process.env.OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS,
);

function hash(value, length = 12) {
  return sha256Hex(value, length);
}

function parsePluginStatusProxyCidrs(value) {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  return value.split(",").map((entry) => {
    const cidr = entry.trim();
    assert.match(
      cidr,
      /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/,
      "OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS must contain comma-separated IPv4 CIDRs.",
    );
    return cidr;
  });
}

const { kubectl, kubectlArguments, resources, waitFor } = createKubernetesClient({
  selection: { kubeconfigPath, kubernetesContext },
  waitTimeoutMs: 180_000,
  waitIntervalMs: 500,
});

function isKubernetesObjectConflict(error) {
  return (
    error?.code === 409 ||
    /the object has been modified|Operation cannot be fulfilled/i.test(
      `${error?.body ?? ""}\n${error?.message ?? ""}`,
    )
  );
}

async function prepareRevisionEventually(fixture, driver = fixture.driver) {
  return waitFor(
    "real Compute prepareRevision to avoid transient Kubernetes conflicts",
    async () => {
      try {
        return await driver.prepareRevision(fixture.candidate, fixture.auth.context);
      } catch (error) {
        if (isKubernetesObjectConflict(error)) {
          return undefined;
        }
        throw error;
      }
    },
  );
}

async function assertPrerequisites() {
  assert.ok(kubeconfigPath, "OCC_TEST_KUBERNETES_KUBECONFIG is required.");
  assert.ok(kubernetesContext, "OCC_TEST_KUBERNETES_CONTEXT is required.");
  assert.ok(fixtureImage, "OCC_TEST_KUBERNETES_IMAGE must select the imported fixture server.");
  assert.notEqual(
    pluginStatusProxyCidrs.length,
    0,
    "OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS must explicitly select the apiserver Pod proxy source CIDR for cross-node plugin status tests.",
  );
  await validateExplicitK3dLoopbackContext({ kubeconfigPath, kubernetesContext });
}

function computeConfiguration({ nodeSelector } = {}) {
  const resources = {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "1", memory: "512Mi" },
  };
  return {
    authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
    images: { gateway: fixtureImage, agent: fixtureImage, requireImmutableDigest: false },
    resources: {
      gateway: resources,
      agent: resources,
      namespace: {
        quota: {
          pods: "20",
          services: "20",
          secrets: "20",
          configmaps: "30",
          persistentvolumeclaims: "10",
          "requests.cpu": "4",
          "requests.memory": "4Gi",
          "limits.cpu": "8",
          "limits.memory": "8Gi",
        },
        containerDefaults: resources,
      },
    },
    network: {
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayPort: 8080,
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      gatewayClients: [
        { namespace: "default", podLabels: { "app.kubernetes.io/name": "platform-probe" } },
      ],
      pluginStatusProxySourceCidrs: pluginStatusProxyCidrs,
    },
    servicePrincipalCredentials: { mode: "disabled" },
    runtime: {
      transportSecretPrefix,
      gatewayStorageClassName: "local-path",
      ...(nodeSelector === undefined ? {} : { nodeSelector }),
    },
  };
}

function createDriver(options) {
  return new KubernetesComputeDriver(computeConfiguration(options), {
    id: "compute-kubernetes-plugin-status-real",
    implementation: "kubernetes-plugin-status-real",
  });
}

function namespace(label) {
  return {
    id: `ns_${randomUUID()}`,
    name: `${label}-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
}

function gatewayName(agentId) {
  return `gateway-${hash(agentId)}`;
}

function pluginRevisionState() {
  return {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: { [pluginId]: { enabled: true, toolDefaults: { approval: "approve" } } },
  };
}

function revision(driver, owner, agentId, number, harnessAuth) {
  return {
    id: `rev_${randomUUID()}`,
    namespaceId: owner.id,
    agentId,
    revision: number,
    backendId: null,
    configurationId: `cfg_${randomUUID()}`,
    configurationKind: "agent",
    configurationGeneration: number,
    configuration: admitLoggingConfiguration(
      {
        gateway: { controlUi: { enabled: false } },
        agents: { defaults: { model: "openai/gpt-5" } },
        logging: { level: "info" },
      },
      "info",
    ),
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: harnessAuth.snapshot,
    compute: { id: driver.id, implementation: driver.implementation },
    plugins: pluginRevisionState(),
    servicePrincipalId: `service-agent-${agentId}`,
    createdAt: new Date().toISOString(),
  };
}

async function prepareNamespace(driver, owner) {
  await waitFor(`Namespace ${owner.id} to become ready`, async () => {
    const observation = await driver.ensureNamespace(owner);
    assert.notEqual(observation.failure, "permanent");
    return observation.namespaceReady ? observation : undefined;
  });
  return kubernetesNamespaceName(owner.id);
}

async function provisionHarnessAuth(owner) {
  const { KubernetesSecretDriver } =
    await import("../../apps/controller/src/drivers/secret/kubernetes/index.ts");
  const driver = new KubernetesSecretDriver({
    authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
  });
  const identity = {
    id: `sec_${randomUUID()}`,
    namespaceId: owner.id,
    name: `Plugin status model key ${randomUUID()}`,
  };
  const backendRef = await driver.create(identity, `fixture-only-${randomUUID()}`);
  const snapshot = {
    method: "api_key",
    source: { kind: "secret", namespaceId: owner.id, id: identity.id },
    secretDriverId: driver.id,
  };
  return {
    snapshot,
    context: {
      secretEnvironment: [],
      harnessAuth: {
        ...snapshot,
        backendRef: await driver.resolve({
          ...identity,
          driverId: driver.id,
          createdAt: new Date().toISOString(),
          backendRef,
        }),
      },
    },
  };
}

async function provisionAgentTransportSecret(namespaceName, agentId) {
  const suffix = hash(agentId);
  const directory = await mkdtemp(join(tmpdir(), `oce-plugin-transport-${suffix}-`));
  const secrets = {
    "app-server-token": randomBytes(32).toString("hex"),
    "gateway-password": randomBytes(32).toString("hex"),
  };

  try {
    await Promise.all(
      Object.entries(secrets).map(([key, value]) =>
        writeFile(join(directory, key), value, { mode: 0o600 }),
      ),
    );
    await kubectl(
      "create",
      "secret",
      "generic",
      `${transportSecretPrefix}-${suffix}`,
      "--namespace",
      namespaceName,
      ...Object.keys(secrets).map((key) => `--from-file=${key}=${join(directory, key)}`),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createStatusCandidate(label, context) {
  const driver = createDriver();
  const owner = namespace(label);
  const namespaceName = await prepareNamespace(driver, owner);
  const agentId = `agt_${randomUUID()}`;
  // The product runtime projects a per-Agent transport Secret by this derived name
  // before the gateway Pod can start.
  await provisionAgentTransportSecret(namespaceName, agentId);
  const auth = await provisionHarnessAuth(owner);
  const candidate = revision(driver, owner, agentId, 1, auth);
  context.after(async () => {
    await createDriver()
      .retireRevision(candidate)
      .catch(() => {});
    const { kubernetesGatewayNamespaceName } =
      await import("../../apps/controller/src/drivers/compute/kubernetes/index.ts");
    await kubectl(
      "delete",
      "namespace",
      kubernetesGatewayNamespaceName(owner.id),
      "--ignore-not-found=true",
      "--wait=true",
    );
    await kubectl("delete", "namespace", namespaceName, "--ignore-not-found=true", "--wait=false");
    await kubectl("wait", "--for=delete", `namespace/${namespaceName}`, "--timeout=30s").catch(
      () => {},
    );
  });
  return {
    driver,
    owner,
    namespaceName,
    agentId,
    auth,
    candidate,
  };
}

async function nonServerNodeName() {
  const nodes = JSON.parse(await kubectl("get", "nodes", "-o", "json")).items ?? [];
  const worker = nodes.find((node) => {
    const labels = node.metadata?.labels ?? {};
    const controlPlane =
      Object.hasOwn(labels, "node-role.kubernetes.io/control-plane") ||
      Object.hasOwn(labels, "node-role.kubernetes.io/master");
    const unschedulable = node.spec?.unschedulable === true;
    const ready = node.status?.conditions?.some(
      ({ type, status }) => type === "Ready" && status === "True",
    );
    return !controlPlane && !unschedulable && ready;
  });
  assert.ok(
    worker,
    "real plugin status proxy tests require a schedulable non-server k3d worker node.",
  );
  return worker.metadata.name;
}

async function scheduleGatewayOnNonServerNode(fixture) {
  const nodeName = await nonServerNodeName();
  fixture.driver = createDriver({ nodeSelector: { "kubernetes.io/hostname": nodeName } });
  fixture.targetNodeName = nodeName;
  await prepareRevisionEventually(fixture);
  await waitForGatewayRollout(fixture, "initial-rollout");
}

async function waitForGatewayRollout(fixture, stage) {
  try {
    await kubectl(
      "rollout",
      "status",
      `deployment/${gatewayName(fixture.agentId)}`,
      "--namespace",
      fixture.namespaceName,
      "--timeout=180s",
    );
  } catch (error) {
    error.openclawCiDiagnostic = { kind: "kubernetes-plugin-status", stage };
    try {
      // Retain only bounded Pod lifecycle fields. The CI reporter independently
      // allowlists these values; raw Pod data and exception text stay private.
      error.openclawCiDiagnostic.pods = await gatewayPodDiagnostics(fixture);
    } catch {
      // Failed diagnostics must preserve the original rollout failure.
    }
    throw error;
  }
}

async function gatewayPodDiagnostics(fixture) {
  const { stdout } = await execute(
    "kubectl",
    kubectlArguments([
      "get",
      "pods",
      "--namespace",
      fixture.namespaceName,
      "--selector",
      `openclaw.dev/agent=${fixture.agentId},openclaw.dev/revision=${fixture.candidate.id},openclaw.dev/workload-role=gateway`,
      "--request-timeout=10s",
      "-o",
      "json",
    ]),
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout)
    .items.slice(0, 3)
    .map((pod) => ({
      phase: pod.status?.phase,
      ready: isReadyPod(pod),
      scheduled: pod.status?.conditions?.some(
        ({ type, status }) => type === "PodScheduled" && status === "True",
      ),
      containers: [
        ...(pod.status?.initContainerStatuses ?? []),
        ...(pod.status?.containerStatuses ?? []),
      ]
        .filter(({ name }) => ["gateway", "prepare-private-state"].includes(name))
        .slice(0, 2)
        .map((container) => ({
          name: container.name,
          restartCount: container.restartCount,
          exitCode:
            container.state?.terminated?.exitCode ?? container.lastState?.terminated?.exitCode,
          waitingReason: container.state?.waiting?.reason,
          terminatedReason:
            container.state?.terminated?.reason ?? container.lastState?.terminated?.reason,
        })),
    }));
}

function isReadyPod(pod) {
  return pod.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True");
}

async function exactGatewayPods(namespaceName, candidate) {
  return resources(
    "pods",
    namespaceName,
    "--selector",
    `openclaw.dev/agent=${candidate.agentId},openclaw.dev/revision=${candidate.id},openclaw.dev/workload-role=gateway`,
  );
}

async function pluginRuntimeStatus(namespaceName, podName) {
  const rawPath = `/api/v1/namespaces/${namespaceName}/pods/${podName}:${pluginStatusPort}/proxy${pluginStatusPath}`;
  const { stdout } = await execute(
    "kubectl",
    [
      "--kubeconfig",
      kubeconfigPath,
      "--context",
      kubernetesContext,
      "get",
      "--request-timeout=10s",
      "--raw",
      rawPath,
    ],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function waitForReadyPluginStatus(fixture) {
  return waitFor("ready plugin runtime status from the exact gateway Pod", async () => {
    const observation = await prepareRevisionEventually(fixture);
    // Pod status can become ready after this earlier Driver observation.
    if (!observation.ready) {
      return undefined;
    }
    const pods = (await exactGatewayPods(fixture.namespaceName, fixture.candidate)).filter(
      (pod) => pod.metadata.deletionTimestamp === undefined && isReadyPod(pod),
    );
    if (pods.length !== 1) {
      return undefined;
    }
    const pod = pods[0];
    if (fixture.targetNodeName !== undefined && pod.spec?.nodeName !== fixture.targetNodeName) {
      return undefined;
    }
    const status = await pluginRuntimeStatus(fixture.namespaceName, pod.metadata.name).catch(
      () => undefined,
    );
    if (status?.phase !== "ready") {
      return undefined;
    }
    return { observation, pod, status };
  }).catch(async (error) => {
    error.openclawCiDiagnostic = { kind: "kubernetes-plugin-status", stage: "ready-status" };
    error.openclawCiDiagnostic.pods = await gatewayPodDiagnostics(fixture).catch(() => undefined);
    throw error;
  });
}

async function waitForReadyPluginWarning(fixture, warning) {
  return waitFor("ready plugin runtime warning from the exact gateway Pod", async () => {
    const observation = await prepareRevisionEventually(fixture);
    // Require Driver readiness as well as the subsequent Pod and plugin checks.
    if (!observation.ready) {
      return undefined;
    }
    const pods = (await exactGatewayPods(fixture.namespaceName, fixture.candidate)).filter(
      (pod) => pod.metadata.deletionTimestamp === undefined && isReadyPod(pod),
    );
    if (pods.length !== 1) {
      return undefined;
    }
    const pod = pods[0];
    if (fixture.targetNodeName !== undefined && pod.spec?.nodeName !== fixture.targetNodeName) {
      return undefined;
    }
    const status = await pluginRuntimeStatus(fixture.namespaceName, pod.metadata.name).catch(
      () => undefined,
    );
    if (status?.phase !== "ready") {
      return undefined;
    }
    if (JSON.stringify(status.failures) !== JSON.stringify([warning])) {
      return undefined;
    }
    return { observation, pod, status };
  }).catch(async (error) => {
    error.openclawCiDiagnostic = { kind: "kubernetes-plugin-status", stage: "warning-status" };
    error.openclawCiDiagnostic.pods = await gatewayPodDiagnostics(fixture).catch(() => undefined);
    throw error;
  });
}

async function patchGatewayEnvironment(namespaceName, agentId, env) {
  await kubectl(
    "patch",
    "deployment",
    gatewayName(agentId),
    "--namespace",
    namespaceName,
    "--type",
    "strategic",
    "--patch",
    JSON.stringify({
      spec: {
        template: {
          spec: {
            containers: [{ name: "gateway", env }],
          },
        },
      },
    }),
  );
}

async function readGatewayOpenClawConfig(namespaceName, podName) {
  return JSON.parse(
    await kubectl(
      "exec",
      podName,
      "--namespace",
      namespaceName,
      "--",
      "cat",
      "/home/node/.openclaw/openclaw.json",
    ),
  );
}

test(
  "real Kubernetes Compute reads plugin runtime status from the exact gateway Pod",
  { ...requiresKubernetes, timeout: 360_000 },
  async (context) => {
    await assertPrerequisites();
    await configureExistingK3dLocalPathSharedFileSystem({ kubeconfigPath, kubernetesContext });
    const fixture = await createStatusCandidate("plugin-status", context);
    await scheduleGatewayOnNonServerNode(fixture);

    const first = await waitForReadyPluginStatus(fixture);
    assert.equal(first.pod.spec.nodeName, fixture.targetNodeName);
    assert.equal(first.observation.ready, true);
    assert.equal(first.observation.warnings, undefined);
    assert.equal(first.status.revisionId, fixture.candidate.id);
    assert.equal(first.status.container, "gateway");
    assert.equal(first.status.podUid, first.pod.metadata.uid);
    assert.match(first.status.startupId, /\S/);
    assert.equal(first.status.phase, "ready");
    assert.deepEqual(first.status.successfulPluginIds, [pluginId]);
    assert.deepEqual(first.status.failures, []);

    await kubectl(
      "delete",
      "pod",
      first.pod.metadata.name,
      "--namespace",
      fixture.namespaceName,
      "--wait=false",
    );
    const restarted = await waitForReadyPluginStatus(fixture);
    assert.notEqual(restarted.pod.metadata.uid, first.pod.metadata.uid);
    assert.equal(restarted.pod.spec.nodeName, fixture.targetNodeName);
    assert.equal(restarted.status.revisionId, fixture.candidate.id);
    assert.equal(restarted.status.container, "gateway");
    assert.equal(restarted.status.podUid, restarted.pod.metadata.uid);
    assert.notEqual(restarted.status.podUid, first.status.podUid);
    assert.match(restarted.status.startupId, /\S/);
    assert.equal(restarted.status.phase, "ready");
    assert.deepEqual(restarted.status.successfulPluginIds, [pluginId]);
    assert.deepEqual(restarted.status.failures, []);
    assert.equal(restarted.observation.ready, true);
  },
);

test(
  "real Kubernetes Compute reports plugin install warnings and disables failed plugin config",
  { ...requiresKubernetes, timeout: 360_000 },
  async (context) => {
    await assertPrerequisites();
    await configureExistingK3dLocalPathSharedFileSystem({ kubeconfigPath, kubernetesContext });
    const fixture = await createStatusCandidate("plugin-status-warning", context);
    await scheduleGatewayOnNonServerNode(fixture);
    const ready = await waitForReadyPluginStatus(fixture);
    assert.equal(ready.pod.spec.nodeName, fixture.targetNodeName);
    const warning = { pluginId, code: "PLUGIN_INSTALL_FAILED" };

    await patchGatewayEnvironment(fixture.namespaceName, fixture.agentId, [
      { name: "OPENCLAW_FIXTURE_DIFFS_INSTALL_RESULT", value: "fail" },
    ]);
    // The environment patch already replaces the Pod. Let that rollout finish
    // before reconciliation observes the new startup's injected install failure.
    await waitForGatewayRollout(fixture, "warning-rollout");

    const failedInstall = await waitForReadyPluginWarning(fixture, warning);
    assert.notEqual(failedInstall.pod.metadata.uid, ready.pod.metadata.uid);
    assert.equal(failedInstall.pod.spec.nodeName, fixture.targetNodeName);
    assert.equal(failedInstall.observation.ready, true);
    assert.deepEqual(failedInstall.observation.warnings, [warning]);
    assert.equal(failedInstall.status.revisionId, fixture.candidate.id);
    assert.deepEqual(failedInstall.status.successfulPluginIds, []);
    assert.deepEqual(failedInstall.status.failures, [warning]);

    const effective = await readGatewayOpenClawConfig(
      fixture.namespaceName,
      failedInstall.pod.metadata.name,
    );
    assert.deepEqual(effective.plugins.entries.diffs, { enabled: false });
    assert.equal(effective.tools?.alsoAllow?.includes("diffs") ?? false, false);
  },
);
