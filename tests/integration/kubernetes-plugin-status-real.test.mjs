import { sha256Hex } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { withStubbedProviderEndpoint } from "../helpers/harness-configuration.mjs";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  createKubernetesClient,
  namespaceAlreadyTerminating,
  retryKubectlRead,
  retryKubectlWrite,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.ts";
import { registerPluginStatusObservationCases } from "./kubernetes-plugin-status-observation-cases.ts";

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

const kubernetes = createKubernetesClient({
  selection: { kubeconfigPath, kubernetesContext },
  waitTimeoutMs: 180_000,
  waitIntervalMs: 500,
});
const { kubectl, waitFor } = kubernetes;

function isKubernetesObjectConflict(error) {
  return (
    error?.code === 409 ||
    /the object has been modified|Operation cannot be fulfilled/i.test(
      `${error?.body ?? ""}\n${error?.message ?? ""}`,
    )
  );
}

// The Driver does not retry a failed write. A runtime Secret write the API server answers
// with 429 or 5xx surfaces as TransientDependencyError, and other failures of it as
// DependencyUnavailableError. The worker retries both on a later pass, so this direct
// caller retries them too. CI saw one while another file shared the k3d cluster. A failure
// that persists still ends the wait, and the timeout names the last transient error.
function isTransientPrepareFailure(error) {
  return (
    isKubernetesObjectConflict(error) ||
    error?.name === "TransientDependencyError" ||
    error?.name === "DependencyUnavailableError"
  );
}

async function prepareRevisionEventually(fixture, driver = fixture.driver) {
  let lastTransient;
  try {
    return await waitFor(
      "real Compute prepareRevision to avoid transient Kubernetes failures",
      async () => {
        try {
          return await driver.prepareRevision(fixture.candidate, fixture.auth.context);
        } catch (error) {
          if (isTransientPrepareFailure(error)) {
            lastTransient = error;
            process.stderr.write(
              `Transient prepareRevision failure (${error.message}); retrying\n`,
            );
            return undefined;
          }
          throw error;
        }
      },
    );
  } catch (error) {
    if (lastTransient !== undefined && /^Timed out waiting for /.test(error.message)) {
      error.message = `${error.message} Last transient failure: ${lastTransient.message}`;
    }
    throw error;
  }
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
      modelProvider: { protocol: "openai-responses", baseUrl: "https://model.stub.invalid/v1" },
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

function pluginRevisionState() {
  return {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: { [pluginId]: { enabled: true, toolDefaults: { approval: "none" } } },
  };
}

function revision(driver, owner, agentId, number, harnessAuth) {
  const candidate = {
    id: `rev_${randomUUID()}`,
    namespaceId: owner.id,
    agentId,
    revision: number,
    backendId: null,
    configurationId: `cfg_${randomUUID()}`,
    configurationKind: "agent",
    configurationGeneration: number,
    gatewayManagedMode: true,
    configuration: admitLoggingConfiguration(
      withStubbedProviderEndpoint({
        gateway: { controlUi: { enabled: false } },
        agents: { defaults: { model: "openai/gpt-5" } },
        logging: { level: "info" },
      }),
      "info",
    ),
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    harnessAuth: harnessAuth.snapshot,
    compute: { id: driver.id, implementation: driver.implementation },
    executionAdmission: { version: 2, mode: "unprotected" },
    plugins: pluginRevisionState(),
    servicePrincipalId: `service-agent-${agentId}`,
    createdAt: new Date().toISOString(),
  };
  candidate.harness.overrides = {};
  candidate.harness.configuration = driver.resolveHarnessConfiguration(
    candidate.harness,
    candidate.harnessAuth,
    candidate.configuration,
  );
  candidate.compute.admission = driver.admitRevision(candidate);
  return candidate;
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
    // k3d's API server can drop a request's connection (finding 682: 'Post ...: EOF'
    // on this create); each call here is retried and converges when repeated.
    const owner = JSON.parse(
      await retryKubectlRead(() => kubectl("get", "namespace", namespaceName, "-o", "json")),
    );
    const namespaceId = owner.metadata.labels["openclaw.dev/namespace"];
    assert.ok(namespaceId, "transport source must belong to the tenant Namespace");
    for (const [name, key] of [
      [`${transportSecretPrefix}-${suffix}`, "app-server-token"],
      [`gateway-password-${suffix}`, "gateway-password"],
    ]) {
      await retryKubectlWrite(() =>
        kubectl(
          "create",
          "secret",
          "generic",
          name,
          "--namespace",
          namespaceName,
          `--from-file=${key}=${join(directory, key)}`,
        ),
      );
      await retryKubectlWrite(() =>
        kubectl(
          "label",
          "secret",
          name,
          "--namespace",
          namespaceName,
          "--overwrite",
          "app.kubernetes.io/managed-by=openclaw-enterprise",
          `openclaw.dev/namespace=${namespaceId}`,
          `openclaw.dev/agent=${agentId}`,
        ),
      );
      await retryKubectlWrite(() =>
        kubectl(
          "annotate",
          "secret",
          name,
          "--namespace",
          namespaceName,
          "--overwrite",
          `openclaw.dev/namespace-id=${namespaceId}`,
          `openclaw.dev/agent-id=${agentId}`,
        ),
      );
    }
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
    // Finding 682: 'Unable to connect to the server: EOF' here failed a passing test.
    await retryKubectlWrite(
      () =>
        kubectl("delete", "namespace", namespaceName, "--ignore-not-found=true", "--wait=false"),
      { applied: namespaceAlreadyTerminating },
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

registerPluginStatusObservationCases({
  kubernetes,
  requiresKubernetes,
  pluginId,
  assertPrerequisites,
  createStatusCandidate,
  createDriver,
  prepareRevisionEventually,
});
