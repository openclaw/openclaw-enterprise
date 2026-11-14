import assert from "node:assert/strict";
import type {
  V1EnvVar,
  V1ObjectMeta,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { PluginRuntimeSpec } from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import type {
  AgentRevision,
  ComputeRevisionContext,
  CredentialSource,
  LoggingLevel,
  PluginDeploymentWarning,
  RuntimeFailureEvidence,
  SecretEnvironmentProjection,
} from "../../packages/contracts/src/index.ts";
import { admitRevisionHarness as admitHarnessFixture } from "../helpers/kubernetes-routed-scenarios.mjs";
import { items, kubernetesOptions, record } from "./plugin-compute-fixtures.ts";

type Address = { name: string; plane: "control" | "execution" };
type Ownership = Pick<AgentRevision, "namespaceId"> &
  Partial<Pick<AgentRevision, "agentId" | "servicePrincipalId">> & { revisionId?: string };
type Kind = "Namespace" | "Secret" | "ConfigMap" | "NetworkPolicy" | "Deployment" | "Service";
export type KubernetesObject<KindName extends Kind = Kind> = {
  apiVersion: string;
  kind: KindName;
  metadata: V1ObjectMeta & { name: string };
  data?: Record<string, string>;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  type?: string;
};

type GatewayConfiguration = {
  name: string;
  revision: number;
  revisionId: string;
  gatewayManagedMode: boolean;
  usesGatewayPasswordEnv: boolean;
  usesWritableNativeAdminConfig: boolean;
  annotations: Readonly<Record<string, string>>;
  loggingLevel: LoggingLevel;
  workspace: unknown;
  harnessNamespace?: Address;
};
type PreparedAuth = {
  loginMode: "api_key" | "codex_pat" | "credential_source" | "runtime";
  environment: readonly V1EnvVar[];
  credentialSource?: Readonly<CredentialSource>;
};
type PluginStatus = {
  revisionId: string;
  container: "agent" | "gateway";
  startupId: string;
  podUid: string;
  phase: "starting" | "ready";
  successfulPluginIds: readonly string[];
  failures: readonly PluginDeploymentWarning[];
};
export type PodProxyRequest = { name: string; namespace: string; path: string };
type PodListRequest = { namespace: string; labelSelector?: string };
type FixtureClients = {
  apps?: { listNamespacedDeployment(): Promise<{ items: readonly unknown[] }> };
  core: {
    listNamespace?(): Promise<{
      apiVersion: string;
      kind: string;
      items: KubernetesObject<"Namespace">[];
    }>;
    readNamespace?(): Promise<KubernetesObject<"Namespace">>;
    listNamespacedPod(
      request: PodListRequest,
    ): Promise<{ apiVersion: string; kind: string; items: readonly object[] }>;
    connectGetNamespacedPodProxyWithPath?(request: PodProxyRequest): Promise<unknown>;
    createNamespacedSecret?(request: {
      body: KubernetesObject<"Secret">;
    }): Promise<KubernetesObject<"Secret">>;
    replaceNamespacedSecret?(request: {
      body: KubernetesObject<"Secret">;
    }): Promise<KubernetesObject<"Secret">>;
    createNamespacedConfigMap?(request: { body: KubernetesObject<"ConfigMap"> }): Promise<object>;
    patchNamespacedConfigMap?(request: {
      name: string;
      body: KubernetesObject<"ConfigMap">;
    }): Promise<object>;
  };
};

// The published declarations erase TypeScript private members. State the subset used by these
// fixtures and retain the production instance and method receivers at runtime.
interface KubernetesFixtureMethods {
  clients(): Promise<FixtureClients>;
  apiClients: Promise<FixtureClients>;
  resolveNamespace(): Promise<{ name: Address; external: boolean }>;
  get(kind: Kind, name: string, target: Address): Promise<KubernetesObject | undefined>;
  getOwned(kind: Kind, name: string, target: Address): Promise<KubernetesObject | undefined>;
  reconcile(object: KubernetesObject): Promise<void>;
  gatewayReady(): Promise<boolean>;
  manifest<K extends Kind>(
    apiVersion: string,
    kind: K,
    name: string,
    owner: Ownership,
    target?: Address,
  ): KubernetesObject<K>;
  gatewayNamespaceManifest(owner: Ownership): KubernetesObject<"Namespace">;
  networkPolicies(owner: Ownership, target: Address): KubernetesObject<"NetworkPolicy">[];
  workspaceNodeName(revision: AgentRevision): string;
  pluginRuntimeOwnership(revision: AgentRevision): Ownership;
  service(
    name: string,
    owner: Ownership,
    target: Address,
    selector: Record<string, string>,
  ): KubernetesObject<"Service">;
  pluginRuntimeStatus(
    revision: AgentRevision,
    target: Address,
    role: "gateway" | "agent",
    warnings?: readonly PluginDeploymentWarning[],
  ): Promise<PluginStatus | undefined>;
  safeRuntimeFailureObservation(
    revision: AgentRevision,
    target: Address,
  ): Promise<RuntimeFailureEvidence | undefined>;
  gatewayConfiguration(
    revision: AgentRevision,
    workspaceNodeId?: string,
    namespace?: Address,
  ): GatewayConfiguration;
  harnessAuthForRevision(
    revision: AgentRevision,
    context: ComputeRevisionContext,
    target: Address,
  ): PreparedAuth;
  deployment(
    name: string,
    owner: Ownership,
    target: Address,
    image: string,
    serviceAccount: string,
    role: "gateway" | "agent",
    environment: Readonly<Record<string, string>>,
    loggingLevel: LoggingLevel,
    configuration?: GatewayConfiguration,
    embedded?: boolean,
    workloadServicePrincipalId?: string,
    harnessAuth?: PreparedAuth,
    enabledChannels?: readonly { egress: "https-proxy" }[],
    secretEnvironment?: readonly SecretEnvironmentProjection[],
    pluginRuntime?: { name: string; runtime: PluginRuntimeSpec },
    pluginWarnings?: readonly PluginDeploymentWarning[],
  ): KubernetesObject;
}

type KubernetesFixture = Pick<KubernetesComputeDriver, keyof KubernetesComputeDriver> &
  KubernetesFixtureMethods;

function fixtureDriver(driver: KubernetesComputeDriver): KubernetesFixture {
  const surface: unknown = driver;
  assert.ok(
    typeof surface === "object" &&
      surface !== null &&
      "deployment" in surface &&
      typeof surface.deployment === "function" &&
      "pluginRuntimeStatus" in surface &&
      typeof surface.pluginRuntimeStatus === "function" &&
      "safeRuntimeFailureObservation" in surface &&
      typeof surface.safeRuntimeFailureObservation === "function",
    "expected the Kubernetes Compute Driver's render and status methods",
  );
  return surface as KubernetesFixture;
}

export function pluginComputeDriver(options = kubernetesOptions()): KubernetesFixture {
  return fixtureDriver(createKubernetesComputeDriver(options));
}

export function renderedPod(deployment: KubernetesObject) {
  const spec = record(record(record(deployment.spec).template).spec);
  const container = record(items(spec.containers)[0]);
  return {
    volumes: items(spec.volumes).map((value) => {
      const volume = record(value);
      return { configMap: volume.configMap === undefined ? undefined : record(volume.configMap) };
    }),
    container: {
      env: items(container.env).map(record),
      ports: items(container.ports).map(record),
      readinessProbe: container.readinessProbe,
    },
  };
}

export function dedicatedPluginDriver() {
  const configured = kubernetesOptions();
  const { gatewayClients, ...network } = configured.network;
  return fixtureDriver(
    new KubernetesComputeDriver(
      {
        ...configured,
        network: { ...network, gatewayTrustedProxyCidrs: ["10.42.0.0/16"] },
        gatewayRouting: {
          hostname: "agents.example.test",
          gatewayName: "gateway",
          gatewayNamespace: "system",
          envoyNamespace: "envoy",
        },
      },
      {
        nodeEnrollment: {
          async createSetup() {
            throw new Error("This fixture supplies an already enrolled node.");
          },
          async observeSetup() {
            throw new Error("This fixture supplies an already enrolled node.");
          },
          async isConnected() {
            return true;
          },
        },
      },
    ),
  );
}

export function useRoutedGateway(
  candidate: AgentRevision & {
    configuration: Record<
      string,
      import("../../packages/contracts/src/index.ts").OpenClawConfigurationValue
    >;
  },
) {
  candidate.configuration = structuredClone(candidate.configuration);
  const gateway = candidate.configuration.gateway;
  assert.ok(gateway && typeof gateway === "object" && !Array.isArray(gateway));
  candidate.configuration.gateway = {
    ...gateway,
    trustedProxies: ["10.42.0.0/16"],
    allowRealIpFallback: true,
    auth: {
      mode: "trusted-proxy",
      trustedProxy: { userHeader: "x-occ-identity", allowUsers: ["occ-workspace-files"] },
      identityScopes: { "occ-workspace-files": ["operator.admin"] },
    },
  };
}

export function enrolledNodeSecret(
  driver: KubernetesFixture,
  candidate: AgentRevision,
  namespace: string,
) {
  const manifest = driver.manifest(
    "v1",
    "Secret",
    driver.workspaceNodeName(candidate),
    driver.pluginRuntimeOwnership(candidate),
    { name: namespace, plane: "execution" },
  );
  return {
    ...manifest,
    // Like the API server, the stored object carries a resource version.
    metadata: { ...manifest.metadata, uid: "workspace-node-secret-uid", resourceVersion: "1" },
    data: {
      deviceId: Buffer.from("fixture-node").toString("base64"),
      // A current setup code, as preparation keeps renewing it.
      expiresAtMs: Buffer.from(String(Date.now() + 600_000)).toString("base64"),
    },
  };
}

export const admitRevisionHarness: (driver: KubernetesFixture, revision: AgentRevision) => void =
  admitHarnessFixture;
