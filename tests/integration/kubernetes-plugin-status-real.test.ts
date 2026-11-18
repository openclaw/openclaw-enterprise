import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Check } from "typebox/value";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  admitLoggingConfiguration,
  ConfigurationValues,
  JsonValue,
  type AgentRevision,
  type ComputeReadiness,
  type ComputeRevisionContext,
  type HarnessAuthSnapshot,
  type Namespace,
  type OpenClawConfigurationDocument,
  type PluginRevisionState,
  type RevisionHarnessDescriptor,
  type SecretIdentity,
} from "../../packages/contracts/src/index.ts";
import { asRecord, sha256Hex } from "../../packages/utils/src/index.ts";
import { withStubbedProviderEndpoint } from "../helpers/harness-configuration.mjs";
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

type DriverPlacement = {
  nodeSelector?: NonNullable<KubernetesComputeDriverOptions["runtime"]>["nodeSelector"];
};

type HarnessAuthFixture = {
  snapshot: HarnessAuthSnapshot;
  context: ComputeRevisionContext;
};

type StatusCandidate = Awaited<ReturnType<typeof createStatusCandidate>>;

function parsePluginStatusProxyCidrs(value: string | undefined) {
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

// The Driver does not retry a failed write. A runtime Secret write the API server answers
// with 429 or 5xx surfaces as TransientDependencyError, and other failures of it as
// DependencyUnavailableError. The worker retries both on a later pass, so this direct
// caller retries them too. CI saw one while another file shared the k3d cluster. A failure
// that persists still ends the wait, and the timeout names the last transient error.
function isTransientPrepareFailure(error: unknown): error is Record<string, unknown> {
  const failure = asRecord(error);
  return (
    failure !== undefined &&
    (failure.code === 409 ||
      /the object has been modified|Operation cannot be fulfilled/i.test(
        `${failure.body ?? ""}\n${failure.message ?? ""}`,
      ) ||
      failure.name === "TransientDependencyError" ||
      failure.name === "DependencyUnavailableError")
  );
}

async function prepareRevisionEventually({
  driver,
  candidate,
  auth,
}: StatusCandidate): Promise<ComputeReadiness> {
  let lastTransient: Record<string, unknown> | undefined;
  try {
    return await waitFor(
      "real Compute prepareRevision to avoid transient Kubernetes failures",
      async () => {
        try {
          return await driver.prepareRevision(candidate, auth.context);
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
    if (
      lastTransient !== undefined &&
      error instanceof Error &&
      /^Timed out waiting for /.test(error.message)
    ) {
      error.message = `${error.message} Last transient failure: ${lastTransient.message}`;
    }
    throw error;
  }
}

function requiredKubernetesSelection() {
  assert.ok(kubeconfigPath, "OCC_TEST_KUBERNETES_KUBECONFIG is required.");
  assert.ok(kubernetesContext, "OCC_TEST_KUBERNETES_CONTEXT is required.");
  assert.ok(fixtureImage, "OCC_TEST_KUBERNETES_IMAGE must select the imported fixture server.");
  return { kubeconfigPath, kubernetesContext, fixtureImage };
}

async function assertPrerequisites() {
  const selection = requiredKubernetesSelection();
  assert.notEqual(
    pluginStatusProxyCidrs.length,
    0,
    "OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS must explicitly select the apiserver Pod proxy source CIDR for cross-node plugin status tests.",
  );
  await validateExplicitK3dLoopbackContext(selection);
}

function computeConfiguration({ nodeSelector }: DriverPlacement): KubernetesComputeDriverOptions {
  const { kubeconfigPath, kubernetesContext, fixtureImage } = requiredKubernetesSelection();
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

function createDriver(options: DriverPlacement = {}) {
  return new KubernetesComputeDriver(computeConfiguration(options), {
    id: "compute-kubernetes-plugin-status-real",
    implementation: "kubernetes-plugin-status-real",
  });
}

function namespace(label: string): Namespace {
  return {
    id: `ns_${randomUUID()}`,
    name: `${label}-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
}

function pluginRevisionState(): PluginRevisionState {
  return {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: { [pluginId]: { enabled: true, toolDefaults: { approval: "none" } } },
  };
}

function assertConfigurationDocument(
  value: unknown,
): asserts value is OpenClawConfigurationDocument {
  assert.ok(
    Check({ SafeJsonValue: JsonValue }, ConfigurationValues, value),
    "stubbed fixture configuration must be a JSON object",
  );
}

function revision(
  driver: KubernetesComputeDriver,
  owner: Namespace,
  agentId: string,
  number: number,
  harnessAuth: HarnessAuthSnapshot,
): AgentRevision {
  const stubbedConfiguration: unknown = withStubbedProviderEndpoint({
    gateway: { controlUi: { enabled: false } },
    agents: { defaults: { model: "openai/gpt-5" } },
    logging: { level: "info" },
  });
  assertConfigurationDocument(stubbedConfiguration);
  const configuration = admitLoggingConfiguration(stubbedConfiguration, "info");
  const harness = {
    id: "openclaw",
    version: "1.0.0",
    mode: "embedded",
    overrides: {},
  } satisfies RevisionHarnessDescriptor;
  const candidate: AgentRevision = {
    id: `rev_${randomUUID()}`,
    namespaceId: owner.id,
    agentId,
    revision: number,
    backendId: null,
    configurationId: `cfg_${randomUUID()}`,
    configurationKind: "agent",
    configurationGeneration: number,
    gatewayManagedMode: true,
    configuration,
    harness: {
      ...harness,
      configuration: driver.resolveHarnessConfiguration(harness, harnessAuth, configuration),
    },
    harnessAuth,
    compute: { id: driver.id, implementation: driver.implementation },
    executionAdmission: { version: 2, mode: "unprotected" },
    plugins: pluginRevisionState(),
    servicePrincipalId: `service-agent-${agentId}`,
    createdAt: new Date().toISOString(),
  };
  const admission = driver.admitRevision(candidate);
  return admission === undefined
    ? candidate
    : { ...candidate, compute: { ...candidate.compute, admission } };
}

async function prepareNamespace(driver: KubernetesComputeDriver, owner: Namespace) {
  await waitFor(`Namespace ${owner.id} to become ready`, async () => {
    const observation = await driver.ensureNamespace(owner);
    assert.notEqual(observation.failure, "permanent");
    return observation.namespaceReady ? observation : undefined;
  });
}

async function provisionHarnessAuth(owner: Namespace): Promise<HarnessAuthFixture> {
  const { kubeconfigPath, kubernetesContext } = requiredKubernetesSelection();
  const { KubernetesSecretDriver } =
    await import("../../apps/controller/src/drivers/secret/kubernetes/index.ts");
  const driver = new KubernetesSecretDriver({
    authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
  });
  const identity: SecretIdentity = {
    id: `sec_${randomUUID()}`,
    namespaceId: owner.id,
    name: `Plugin status model key ${randomUUID()}`,
  };
  const backendRef = await driver.create(identity, `fixture-only-${randomUUID()}`);
  const snapshot = {
    method: "api_key",
    source: { kind: "secret", namespaceId: owner.id, id: identity.id },
    secretDriverId: driver.id,
  } satisfies HarnessAuthSnapshot;
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

async function provisionAgentTransportSecret(namespaceName: string, agentId: string) {
  const suffix = sha256Hex(agentId, 12);
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
    const owner = asRecord(
      await retryKubectlRead(() => kubernetes.resource("namespace", namespaceName)),
    );
    const labels = asRecord(asRecord(owner?.metadata)?.labels);
    const namespaceId = labels?.["openclaw.dev/namespace"];
    assert.ok(
      typeof namespaceId === "string" && namespaceId.length > 0,
      "transport source must belong to the tenant Namespace",
    );
    for (const [name, key] of [
      [`${transportSecretPrefix}-${suffix}`, "app-server-token"],
      [`gateway-password-${suffix}`, "gateway-password"],
    ] as const) {
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

async function createStatusCandidate(label: string, context: TestContext) {
  const driver = createDriver();
  const owner = namespace(label);
  const namespaceName = kubernetesNamespaceName(owner.id);
  let candidate: AgentRevision | null = null;
  // Register cleanup before the first cluster write, including a create that
  // succeeds on the server but fails locally.
  context.after(async () => {
    try {
      if (candidate) {
        await createDriver()
          .retireRevision(candidate)
          .catch(() => {});
      }
    } finally {
      // Finding 682: 'Unable to connect to the server: EOF' here failed a passing test.
      await retryKubectlWrite(
        () =>
          kubectl("delete", "namespace", namespaceName, "--ignore-not-found=true", "--wait=false"),
        { applied: namespaceAlreadyTerminating },
      );
    }
  });
  await prepareNamespace(driver, owner);
  const agentId = `agt_${randomUUID()}`;
  // The product runtime projects a per-Agent transport Secret by this derived name
  // before the gateway Pod can start.
  await provisionAgentTransportSecret(namespaceName, agentId);
  const auth = await provisionHarnessAuth(owner);
  candidate = revision(driver, owner, agentId, 1, auth.snapshot);
  return {
    driver,
    namespaceName,
    agentId,
    auth: { context: auth.context },
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
