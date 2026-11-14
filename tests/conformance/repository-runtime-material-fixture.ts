import { admitRevisionHarness as admitRevisionHarnessJs } from "../helpers/kubernetes-routed-scenarios.mjs";
import assert from "node:assert/strict";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repo/github/access/client/config.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

import type {
  AgentRevision,
  ComputeAgentBinding,
  ComputeRevisionContext,
  CredentialProxyDriver,
  HarnessExecutionMode,
  OpenClawConfigurationValue,
  RepositoryCredentialRuntimeBinding,
  RepositoryCredentialSessionFiles,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import type { GatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import type { PluginRuntimeSpec } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import type { CodexLaunch } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  createKubernetesMaterialFixture,
  type KubernetesMaterialClients,
  type FixtureDeployment,
  type FixturePod,
  type FixtureSecret,
} from "./repository-runtime-material-kubernetes-fixture.ts";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type MutableBindings = Omit<
  Mutable<NonNullable<AgentRevision["repositoryCredentials"]>>,
  "bindings"
> & {
  bindings: Mutable<NonNullable<AgentRevision["repositoryCredentials"]>["bindings"][number]>[];
};
export type MaterialRevision = Omit<
  Mutable<AgentRevision>,
  "compute" | "configuration" | "repositoryCredentials" | "harnessAuth"
> & {
  compute: Mutable<AgentRevision["compute"]>;
  configuration: MaterialConfiguration;
  repositoryCredentials?: MutableBindings;
  harnessAuth: Extract<AgentRevision["harnessAuth"], { method: "api_key" }>;
};

export interface MaterialConfiguration {
  [section: string]: OpenClawConfigurationValue;
  logging: OpenClawConfigurationValue;
  diagnostics: OpenClawConfigurationValue;
  agents: {
    [key: string]: OpenClawConfigurationValue;
    defaults: Record<string, OpenClawConfigurationValue>;
  };
}
const admitRevisionHarness: (
  driver: KubernetesComputeDriver,
  revision: MaterialRevision,
) => unknown = admitRevisionHarnessJs;

export function codexAppServer(configuration: Readonly<Record<string, unknown>>) {
  const appServer = recordField(
    recordField(recordField(recordField(configuration, "plugins"), "entries"), "codex"),
    "config",
  );
  return recordField(appServer, "appServer");
}

export function recordField(value: Readonly<Record<string, unknown>>, name: string) {
  return jsonRecord(value[name]);
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

type DriverSelection = NonNullable<ConstructorParameters<typeof KubernetesComputeDriver>[1]>;
type MaterialFixtureOptions = Pick<
  DriverSelection,
  "preparedRepositoryIngress" | "sandboxDriver"
> & {
  repositoryBroker?: boolean;
  repositoryNamespace?: string;
  repositoryPodLabels?: Record<string, string>;
  publicGithubRead?: KubernetesComputeDriverOptions["network"]["publicGithubRead"];
};

// The production Compute Driver reconciles against the fixture's Kubernetes clients.
// The fixture also controls workspace-node enrollment observations.
interface ComputeFixturePorts {
  options: Omit<KubernetesComputeDriverOptions, "network"> & {
    network: Mutable<KubernetesComputeDriverOptions["network"]>;
  };
  apiClients: Promise<KubernetesMaterialClients>;
  readonly proxyDriver: CredentialProxyDriver | undefined;
  waitBeforeRetry: () => Promise<void>;
  sandboxDriver:
    | {
        id: string;
        provisionHarness?: (...args: never[]) => Promise<unknown>;
        cleanup?: (...args: never[]) => Promise<unknown>;
      }
    | undefined;
  workspaceNodeName(revision: Pick<AgentRevision, "agentId" | "harness">): string;
  pluginRuntimeOwnership(revision: AgentRevision): {
    namespaceId: string;
    agentId?: string;
    servicePrincipalId?: string;
    revisionId?: string;
  };
  manifest(
    apiVersion: string,
    kind: "Secret",
    name: string,
    ownership: ReturnType<ComputeFixturePorts["pluginRuntimeOwnership"]>,
    namespace: { name: string; plane: "execution" },
  ): Omit<FixtureSecret, "data">;
  validateRevisionExecution(
    revision: AgentRevision,
    context?: Pick<ComputeRevisionContext, "currentEgressInstallation">,
  ): void;
  codexLaunch(revision: AgentRevision, sandbox: SandboxDriver | undefined): CodexLaunch;
  pluginRuntimeSnapshot(
    revision: AgentRevision,
  ): { runtime: PluginRuntimeSpec; name: string } | undefined;
}

export function computeFixturePorts(driver: KubernetesComputeDriver): ComputeFixturePorts {
  const instance: object = driver;
  // The driver keeps these collaborators private. Check the existing JS
  // properties before adapting the fixture to that runtime boundary.
  assert.ok("options" in instance && "apiClients" in instance && "sandboxDriver" in instance);
  assert.ok("waitBeforeRetry" in instance && typeof instance.waitBeforeRetry === "function");
  assert.ok("workspaceNodeName" in instance && typeof instance.workspaceNodeName === "function");
  assert.ok(
    "pluginRuntimeOwnership" in instance && typeof instance.pluginRuntimeOwnership === "function",
  );
  assert.ok("manifest" in instance && typeof instance.manifest === "function");
  assert.ok(
    "validateRevisionExecution" in instance &&
      typeof instance.validateRevisionExecution === "function",
  );
  assert.ok("codexLaunch" in instance && typeof instance.codexLaunch === "function");
  assert.ok(
    "pluginRuntimeSnapshot" in instance && typeof instance.pluginRuntimeSnapshot === "function",
  );
  return instance as ComputeFixturePorts;
}

export function present<T>(
  value: T | undefined,
  description = "the expected fixture observation",
): T {
  assert.ok(value !== undefined, `Missing ${description}`);
  return value;
}

export type MaterialFixture = Awaited<ReturnType<typeof fixture>>;
export const deadlineWallMs = Date.now() + 86400000;
function repositoryClient(gatewayOrigin = "https://git.credentials.svc.cluster.local") {
  return {
    gatewayOrigin,
    gitRemote: `${gatewayOrigin}/example/project.git`,
    gitUsername: "gateway-session",
    canonicalApiHost: "github.com",
    apiHost: new URL(gatewayOrigin).hostname,
    repository: "example/project",
  };
}

const client = repositoryClient();
const grant = { providerInstanceId: "github-main", repositoryId: "project", grantId: "read" };

export function codexPluginState(): NonNullable<AgentRevision["plugins"]> {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: {},
  };
}

export function openClawPluginState(): NonNullable<AgentRevision["plugins"]> {
  return {
    driver: { id: "openclaw-plugin", implementation: "occ/openclaw-plugin" },
    plugins: {
      "openclaw-plugin:example": { enabled: true, toolDefaults: { approval: "provider_default" } },
    },
  };
}

export function runtimeBinding(
  sessionId = "session_material_original",
  publicCa?: Uint8Array,
  gatewayOrigin?: string,
): Extract<RepositoryCredentialRuntimeBinding, { kind: "new" }> & {
  files: Mutable<RepositoryCredentialSessionFiles>;
} {
  return {
    kind: "new",
    repositoryRef: "project",
    sessionId,
    deadlineWallMs,
    files: encodeRepositoryCredentialSessionFiles(
      {
        session: {
          sessionId,
          deadlineWallMs,
          state: "OPEN",
          binding: grant,
          activeUses: 0,
          cleanup: {
            active: 0,
            pending: 0,
            revoked: 0,
            expired: 0,
            uncertain: 0,
            auxiliaryPending: false,
          },
        },
        bearer: `controlled_gateway_bearer_${sessionId}_0000000000000000000000`,
        client: gatewayOrigin === undefined ? client : repositoryClient(gatewayOrigin),
      },
      publicCa,
    ),
  };
}

export function workloadPod(
  deployment: FixtureDeployment,
  namespace: string,
  name: string,
  ready = true,
): FixturePod & {
  metadata: { labels: Record<string, string> };
  status: NonNullable<FixturePod["status"]>;
} {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...structuredClone(deployment.spec.template.metadata),
      name,
      namespace,
      uid: `${name}-uid`,
    },
    spec: structuredClone(deployment.spec.template.spec),
    status: {
      phase: "Running",
      podIP: "10.42.0.30",
      conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
    },
  };
}

export async function fixture(
  mode: HarnessExecutionMode = "embedded",
  nodeEnrollment?: GatewayNodeEnrollment,
  options: MaterialFixtureOptions = {},
) {
  const alreadyEnrolled = mode === "dedicated" && nodeEnrollment === undefined;
  if (alreadyEnrolled) {
    nodeEnrollment = {
      async createSetup() {
        throw new Error("The material fixture already has an enrolled node.");
      },
      async observeSetup() {
        throw new Error("The material fixture already has an enrolled node.");
      },
      async isConnected() {
        return true;
      },
    };
  }
  const resources = {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "250m", memory: "128Mi" },
  };
  const driver = new KubernetesComputeDriver(
    {
      authentication: { mode: "inCluster" },
      images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
      resources: {
        gateway: resources,
        agent: resources,
        namespace: { quota: { pods: "10" }, containerDefaults: resources },
      },
      network: {
        dns: { namespace: "kube-system", podLabels: { app: "dns" } },
        gatewayPort: 8080,
        gatewayTrustedProxyCidrs:
          nodeEnrollment === undefined ? ["127.0.0.1/32"] : ["10.42.0.0/16"],
        ...(nodeEnrollment === undefined
          ? { gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }] }
          : {}),
        // An Installation whose Sandbox delivers repository Git material configures no
        // repository credential endpoint (chart repositoryCredentials.enabled=false).
        ...(options.repositoryBroker === false
          ? {}
          : {
              repositoryCredentials: {
                namespace: options.repositoryNamespace ?? "credentials",
                podLabels: options.repositoryPodLabels ?? { app: "credentials" },
                port: 8443,
              },
            }),
        ...(options.publicGithubRead === undefined
          ? {}
          : { publicGithubRead: options.publicGithubRead }),
      },
      ...(nodeEnrollment === undefined
        ? {}
        : {
            gatewayRouting: {
              hostname: "agents.example.test",
              gatewayName: "gateways",
              gatewayNamespace: "controller",
              envoyNamespace: "envoy",
            },
          }),
      servicePrincipalCredentials: { mode: "disabled" },
      runtime: {
        transportSecretPrefix: "transport",
        gatewayStorageClassName: "local-path",
        gatewayNodeSelector: { "oce-role": "control-plane" },
      },
    },
    {
      ...(nodeEnrollment === undefined ? {} : { nodeEnrollment }),
      ...(options.preparedRepositoryIngress === undefined
        ? {}
        : { preparedRepositoryIngress: options.preparedRepositoryIngress }),
      ...(options.sandboxDriver === undefined ? {} : { sandboxDriver: options.sandboxDriver }),
    },
  );
  // Fixture failures are final; skip the driver's API retry waits.
  const ports = computeFixturePorts(driver);
  ports.waitBeforeRetry = async () => {};
  const revision: MaterialRevision = {
    id: "revision-repository-material",
    namespaceId: "namespace-repository-material",
    agentId: "agent-repository-material",
    revision: 1,
    backendId: null,
    configurationId: "configuration-repository-material",
    configurationKind: "agent",
    configurationGeneration: 1,
    gatewayManagedMode: true,
    configuration: {
      gateway: {
        // Kubernetes renders lan for an omitted bind; this admitted document already is.
        bind: "lan",
        trustedProxies: ["127.0.0.1/32"],
        allowRealIpFallback: true,
        auth: {
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-occ-identity", allowUsers: ["occ-workspace-files"] },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
      },
      agents: { defaults: { model: "openai/gpt-5" } },
      logging: { level: "info", consoleLevel: "info", consoleStyle: "json" },
      diagnostics: { otel: { logs: false } },
    },
    harness: {
      id: "openclaw",
      version: "1.0.0",
      mode: "embedded",
      overrides: {},
      configuration: {},
    },
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId: "namespace-repository-material", id: "model-key" },
      secretDriverId: "kubernetes-secret",
    },
    compute: { id: driver.id, implementation: driver.implementation },
    executionAdmission: { version: 2, mode: "unprotected" },
    servicePrincipalId: "principal-repository-material",
    createdAt: "2026-09-18T00:00:00.000Z",
    repositoryCredentials: {
      driver: { id: "repository-credentials", implementation: "repository-credentials" },
      deadlineWallMs,
      bindings: [
        {
          repositoryRef: "project",
          profile: "read",
          backendId: "github",
          grant,
        },
      ],
    },
  };
  const namespace = kubernetesNamespaceName(revision.namespaceId);
  if (mode === "dedicated") {
    revision.harness = { id: "codex", version: "1.0.0", mode, overrides: {}, configuration: {} };
    revision.configuration = {
      ...createHarnessConfiguration("codex", "gpt-5"),
      logging: revision.configuration.logging,
      diagnostics: revision.configuration.diagnostics,
    };
  }
  if (nodeEnrollment !== undefined) {
    revision.configuration.gateway = {
      bind: "lan",
      trustedProxies: ["10.42.0.0/16"],
      allowRealIpFallback: true,
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-occ-identity",
          allowUsers: ["occ-workspace-files"],
        },
        identityScopes: { "occ-workspace-files": ["operator.admin"] },
      },
    };
  }
  admitRevisionHarness(driver, revision);
  const transport = createKubernetesMaterialFixture(namespace, options.repositoryBroker);
  const { objects, clients, calls, apiCalls, save, setPods, observePods } = transport;
  save({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespace,
      uid: "namespace-uid",
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": revision.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": revision.namespaceId },
    },
    status: { phase: "Active" },
  });
  save({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "model-key",
      namespace: kubernetesNamespaceName(revision.namespaceId),
      uid: "model-key-uid",
    },
    data: { value: Buffer.from("fixture-key").toString("base64") },
  });
  ports.apiClients = Promise.resolve(clients);
  const preparedNamespace = await driver.ensureNamespace({
    id: revision.namespaceId,
    name: "Repository material tenant",
    status: "ready",
    createdAt: revision.createdAt,
  });
  assert.equal(preparedNamespace.namespaceReady, true, JSON.stringify(preparedNamespace));
  const agentBinding: ComputeAgentBinding = {
    namespace: {
      id: revision.namespaceId,
      name: "Repository material tenant",
      status: "ready",
      createdAt: revision.createdAt,
    },
    agent: {
      desiredRuntimeState: "running",
      status: "active",
      harnessAuth: revision.harnessAuth,
      gatewayManagedMode: revision.gatewayManagedMode,
      id: revision.agentId,
      namespaceId: revision.namespaceId,
      name: "Repository material Agent",
      configurationId: revision.configurationId,
      backendId: revision.backendId,
      executionMode: mode,
      servicePrincipalId: revision.servicePrincipalId,
      createdAt: revision.createdAt,
    },
  };
  if (mode === "dedicated") {
    assert.deepEqual(await driver.provisionAgentRuntimeCredentials(agentBinding, {}), {
      transportConfigured: true,
    });
  }
  transport.startTracing();
  const context = (
    bindings: ComputeRevisionContext["repositoryCredentials"],
  ): ComputeRevisionContext => ({
    secretEnvironment: [],
    harnessAuth: {
      ...revision.harnessAuth,
      backendRef: {
        namespaceName: kubernetesNamespaceName(revision.namespaceId),
        name: "model-key",
        key: "value",
        uid: "model-key-uid",
      },
    },
    ...(bindings === undefined ? {} : { repositoryCredentials: bindings }),
  });
  const deployments = transport.deployments;
  const secrets = () =>
    [...objects.values()].filter(
      (object): object is FixtureSecret =>
        object.kind === "Secret" &&
        object.metadata.namespace === namespace &&
        object.metadata.labels?.["openclaw.dev/repository-material"] === "session",
    );
  const enroll = (selected: AgentRevision) => {
    const name = ports.workspaceNodeName(selected);
    const secret = ports.manifest("v1", "Secret", name, ports.pluginRuntimeOwnership(selected), {
      name: namespace,
      plane: "execution",
    });
    save({
      ...secret,
      metadata: {
        ...secret.metadata,
        uid: `${name}-uid`,
        resourceVersion: "1",
      },
      type: "Opaque",
      data: {
        deviceId: Buffer.from(`node-${selected.id}`).toString("base64"),
        setupCode: Buffer.from("completed-setup").toString("base64"),
        // A current setup code, as preparation keeps renewing it.
        expiresAtMs: Buffer.from(String(Date.now() + 600_000)).toString("base64"),
      },
    });
  };
  // Material-focused cases resume a revision with an existing enrolled node. The
  // explicit enrollment case below covers the first-start sequence separately.
  if (alreadyEnrolled) {
    enroll(revision);
  }
  const markReady = () => {
    for (const object of deployments()) {
      object.status = {
        observedGeneration: object.metadata.generation,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
      };
      save(object);
    }
    setPods(
      deployments().map((object) =>
        workloadPod(object, object.metadata.namespace, `${object.metadata.name}-ready`),
      ),
    );
  };
  const consumer = () =>
    deployments().find(
      (deployment) =>
        deployment.spec.template.metadata.labels["openclaw.dev/workload-role"] ===
        (mode === "embedded" ? "gateway" : "agent"),
    );
  return {
    driver,
    ports,
    agentBinding,
    enroll,
    clients,
    revision,
    namespace,
    objects,
    calls,
    apiCalls,
    save,
    context,
    deployments,
    consumer,
    requireConsumer() {
      return present(consumer(), "the repository consumer Deployment");
    },
    secrets,
    markReady,
    setPods,
    observePods,
  };
}

// These negative cases deliberately pass malformed data to the real driver.
export function malformedBindings(
  bindings: readonly (Omit<RepositoryCredentialRuntimeBinding, "admissionId"> & {
    admissionId: unknown;
  })[],
): ComputeRevisionContext["repositoryCredentials"] {
  return bindings as ComputeRevisionContext["repositoryCredentials"];
}
