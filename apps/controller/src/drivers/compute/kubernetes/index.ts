import {
  asRecord,
  isNonEmptyString,
  numericErrorStatus,
  sha256Hex,
} from "@openclaw-enterprise/utils";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import type {
  AppsV1Api,
  CoreV1Api,
  DiscoveryV1Api,
  KubernetesObject,
  KubernetesObjectApi,
  NetworkingV1Api,
  V1ConfigMap,
  V1EnvVar,
  V1NetworkPolicyPeer,
  V1ObjectMeta,
  V1DeleteOptions,
  V1ResourceRequirements,
  V1ServiceAccount,
  V1Volume,
  V1VolumeMount,
} from "@kubernetes/client-node";
import type {
  AgentRevision,
  ComputeDriver,
  ComputeReadiness,
  ComputeRevisionContext,
  Driver,
  HarnessWorkloadRequirements,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  SandboxDriver,
  SandboxEnvironmentVariable,
  SandboxNamespaceContext,
  SandboxResourceRef,
  SandboxWorkspaceMount,
  SecretEnvironmentProjection,
  LoggingLevel,
} from "@openclaw-enterprise/contracts";
import { admittedLoggingLevel, normalizeSecretBindings } from "@openclaw-enterprise/contracts";
import { createKubernetesClientConfiguration } from "../../kubernetes/client.ts";
import { ComputeLifecycleDispatcher } from "../lifecycle-hooks.ts";
import { currentComputeAbortSignal, withComputeAbortSignal } from "../operation-context.ts";
import {
  AGENT_READINESS_ENTRYPOINT,
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  GATEWAY_READINESS_ENTRYPOINT,
} from "./runtime-entrypoints.ts";

type KubernetesRecord = Record<string, unknown>;
type ManagedResourceKind =
  | "Namespace"
  | "ConfigMap"
  | "ServiceAccount"
  | "Service"
  | "ResourceQuota"
  | "LimitRange"
  | "PersistentVolumeClaim"
  | "Deployment"
  | "NetworkPolicy"
  | "HTTPRoute";
type ReadableResourceKind = ManagedResourceKind | "Pod" | "Secret";

const CHANNEL_REQUIREMENTS = {
  slack: {
    secrets: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    egress: "https-proxy",
  },
  msteams: {
    secrets: ["MSTEAMS_APP_PASSWORD"],
    egress: "https-proxy",
  },
} as const;

type ChannelRequirements = (typeof CHANNEL_REQUIREMENTS)[keyof typeof CHANNEL_REQUIREMENTS];

export interface KubernetesWorkloadPeer {
  readonly namespace: string;
  readonly podLabels: Readonly<Record<string, string>>;
}

export interface KubernetesGatewayRoutingOptions {
  readonly hostname?: string;
  readonly gatewayName: string;
  readonly gatewayNamespace: string;
  readonly envoyNamespace: string;
}

interface KubernetesApiClients {
  readonly core: CoreV1Api;
  readonly apps: AppsV1Api;
  readonly discovery: DiscoveryV1Api;
  readonly networking: NetworkingV1Api;
  readonly objects: KubernetesObjectApi;
}

export interface KubernetesComputeDriverOptions {
  readonly authentication:
    | { readonly mode: "inCluster" }
    | { readonly mode: "kubeconfig"; readonly kubeconfigPath: string; readonly context: string };
  readonly images: {
    readonly gateway: string;
    readonly agent: string;
    readonly requireImmutableDigest: boolean;
  };
  readonly resources: {
    readonly gateway: V1ResourceRequirements;
    readonly agent: V1ResourceRequirements;
    readonly namespace: {
      readonly quota: Readonly<Record<string, string>>;
      readonly containerDefaults: V1ResourceRequirements;
    };
  };
  readonly network: {
    readonly dns: KubernetesWorkloadPeer;
    readonly gatewayPort: number;
    readonly gatewayClients?: readonly KubernetesWorkloadPeer[];
  };
  readonly servicePrincipalCredentials:
    | { readonly mode: "disabled" }
    | {
        readonly mode: "projectedServiceAccountToken";
        readonly audience: string;
        readonly expirationSeconds: number;
      };
  readonly runtime?: {
    readonly transportSecretPrefix: string;
    readonly modelSecretPrefix: string;
    readonly gatewayStorageClassName: string;
    readonly codexSeccompProfile?: string;
    readonly channels?: {
      readonly secretPrefix: string;
      readonly proxyUrl: string;
    };
  };
  readonly gatewayRouting?: KubernetesGatewayRoutingOptions;
}

interface ManagedKubernetesObject<Kind extends ReadableResourceKind = ManagedResourceKind>
  extends
    KubernetesObject,
    Pick<V1ConfigMap, "binaryData" | "data" | "immutable">,
    Pick<V1ServiceAccount, "automountServiceAccountToken"> {
  readonly apiVersion: string;
  readonly kind: Kind;
  readonly metadata: V1ObjectMeta & { readonly name: string };
  readonly spec?: KubernetesRecord;
  readonly status?: KubernetesRecord;
}

interface ReconcilePrecondition {
  readonly serviceSelector?: Readonly<Record<string, string>>;
}

interface Ownership {
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly serviceAccountId?: string;
  readonly servicePrincipalId?: string;
  readonly revisionId?: string;
}

interface GatewayConfigurationSnapshot {
  readonly name: string;
  readonly revision: number;
  readonly revisionId: string;
  readonly usesTrustedProxyAuth: boolean;
  readonly annotations: Readonly<Record<string, string>>;
  readonly loggingLevel: LoggingLevel;
}

class OwnershipFailure extends Error {}
class ConfigurationFailure extends Error {}

const MANAGER = "openclaw-enterprise";
const FIELD_MANAGER = "openclaw-enterprise-compute";
const TOKEN_PATH = "/var/run/secrets/openclaw/service-principal";
const CONFIGURATION_DIRECTORY = "/etc/openclaw";
const CONFIGURATION_DOCUMENT = "openclaw.json";
const CONFIGURATION_VOLUME = "openclaw-configuration";
const AGENT_REVISION_ANNOTATION = "openclaw.dev/agent-revision";
const AGENT_REVISION_ID_ANNOTATION = "openclaw.dev/agent-revision-id";
const APPLY_CONTENT_TYPE = "application/apply-patch+yaml";
const GATEWAY_API_VERSION = "gateway.networking.k8s.io/v1";
const GATEWAY_LISTENER_SECTION = "https";
const GATEWAY_MEMBERSHIP_LABEL = "openclaw-enterprise.io/gateway";
const REQUEST_TIMEOUT_MS = 10_000;
const AGENT_TRANSPORT_PORT = 18_790;
const AGENT_TRANSPORT_TOKEN_KEY = "app-server-token";
const GATEWAY_TOKEN_KEY = "gateway-token";
const MODEL_API_KEY = "OPENAI_API_KEY";
const SERVICE_ACCOUNT_TOKEN_KEY = "token";
const SERVICE_ACCOUNT_WORKSPACE_KEY = "workspace-id";
const CODEX_ACCESS_TOKEN = "CODEX_ACCESS_TOKEN";
const CODEX_CHATGPT_WORKSPACE_ID = "CODEX_CHATGPT_WORKSPACE_ID";
const RUNTIME_STATE_VOLUME_SIZE = "1Gi";
const GATEWAY_PRIVATE_STATE_VOLUME = "openclaw-gateway-state";
const GATEWAY_PRIVATE_STATE_SIZE = "10Gi";
const GATEWAY_PRIVATE_STATE_CATEGORIES = Object.freeze([
  ["state", "/home/node/.openclaw/state"],
  ["agent", "/home/node/.openclaw/agents/main/agent"],
  ["media", "/home/node/.openclaw/media"],
] as const);
const SHARED_WORKSPACE_VOLUME = "openclaw-workspace";
const SHARED_WORKSPACE_SIZE = "40Gi";
type SharedWorkspaceRole = "agent" | "gateway";
const SHARED_WORKSPACE_CATEGORIES = Object.freeze([
  ["workspace", "/home/node/workspace", false, "/home/node/workspace", false],
  [
    "sessions",
    "/home/node/.openclaw/agents/main/sessions",
    false,
    "/home/node/.openclaw/agents/main/sessions",
    true,
  ],
  [
    "generated-images",
    "/home/node/.openclaw/codex-artifacts/generated_images",
    true,
    "/home/node/.codex/generated_images",
    false,
  ],
  [
    "bundled-skills",
    "/home/node/openclaw-runtime-assets/bundled-skills",
    false,
    "/home/node/openclaw-runtime-assets/bundled-skills",
    true,
  ],
  [
    "plugin-skills",
    "/home/node/openclaw-runtime-assets/plugin-skills",
    false,
    "/home/node/openclaw-runtime-assets/plugin-skills",
    true,
  ],
] as const);
const RESOURCE_REQUIREMENTS_SCHEMA = Object.freeze({
  type: "object",
  required: ["requests", "limits"],
  additionalProperties: false,
  properties: {
    requests: {
      type: "object",
      required: ["cpu", "memory"],
      additionalProperties: false,
      properties: { cpu: { type: "string" }, memory: { type: "string" } },
    },
    limits: {
      type: "object",
      required: ["cpu", "memory"],
      additionalProperties: false,
      properties: { cpu: { type: "string" }, memory: { type: "string" } },
    },
  },
});
const WORKLOAD_PEER_SCHEMA = Object.freeze({
  type: "object",
  required: ["namespace", "podLabels"],
  additionalProperties: false,
  properties: {
    namespace: { type: "string" },
    podLabels: { type: "object", additionalProperties: { type: "string" } },
  },
});

function required(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new ConfigurationFailure(`${description} must be explicitly configured.`);
  }
  return value;
}

function failure(error: unknown): "retryable" | "permanent" {
  return error instanceof OwnershipFailure ||
    error instanceof ConfigurationFailure ||
    [400, 401, 403, 422].includes(numericErrorStatus(error) ?? 0)
    ? "permanent"
    : "retryable";
}

function validatePort(value: number, description: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new ConfigurationFailure(`${description} must be a valid port.`);
  }
}

function validateResources(value: V1ResourceRequirements, description: string): void {
  const resources = asRecord(value);
  const requests = asRecord(resources?.requests);
  const limits = asRecord(resources?.limits);
  if (requests === undefined || limits === undefined) {
    throw new ConfigurationFailure(`${description} requests and limits must be configured.`);
  }
  required(requests.cpu, `${description} CPU request`);
  required(requests.memory, `${description} memory request`);
  required(limits.cpu, `${description} CPU limit`);
  required(limits.memory, `${description} memory limit`);
}

function validatePeer(value: KubernetesWorkloadPeer, description: string): void {
  if (asRecord(value) === undefined) throw new ConfigurationFailure(`${description} is required.`);
  required(value.namespace, `${description} namespace`);
  const labels = asRecord(value.podLabels);
  if (labels === undefined || Object.keys(labels).length === 0) {
    throw new ConfigurationFailure(`${description} Pod labels cannot be empty.`);
  }
  for (const [key, label] of Object.entries(labels)) {
    required(key, `${description} label key`);
    if (typeof label !== "string")
      throw new ConfigurationFailure(`${description} labels must be strings.`);
  }
}

function validateDnsHostname(value: string, description: string): void {
  if (
    value.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value)
  ) {
    throw new ConfigurationFailure(`${description} must be a DNS hostname without a port or path.`);
  }
}

function validateKubernetesResourceName(value: string, description: string): void {
  if (
    value.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(value)
  ) {
    throw new ConfigurationFailure(`${description} must be a DNS-safe Kubernetes resource name.`);
  }
}

function validateCodexSeccompProfile(value: unknown): string {
  const profile = required(value, "Codex seccomp localhost profile");
  const segments = profile.split("/");
  if (
    isAbsolute(profile) ||
    profile.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    segments.some((segment) => segment.toLowerCase() === "unconfined")
  ) {
    throw new ConfigurationFailure(
      "Codex seccomp localhost profile must be a relative profile path without traversal or unconfined mode.",
    );
  }
  return profile;
}

function labelsToSelector(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function channelProxy(value: unknown): { address: string; port: number } {
  const raw = required(value, "Channel proxy URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationFailure(
      "Channel proxy URL must identify one exact HTTP(S) IP endpoint.",
    );
  }
  const address = parsed.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    isIP(address) === 0 ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ConfigurationFailure(
      "Channel proxy URL must identify one credential-free HTTP(S) IP endpoint.",
    );
  }
  return { address, port: Number(parsed.port) };
}

export function kubernetesNamespaceName(namespaceId: string): string {
  const id = required(namespaceId, "Platform Namespace ID");
  const slug =
    id
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 46)
      .replace(/-+$/g, "") || "ns";
  return `oce-${slug}-${sha256Hex(id, 12)}`;
}

function verifiedKubernetesNamespace(
  metadata: V1ObjectMeta | undefined,
  namespaceId: string,
): { readonly name: string; readonly external: boolean } {
  const name = metadata?.name;
  const labels = metadata?.labels;
  const annotations = metadata?.annotations;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    labels?.["openclaw.dev/namespace"] !== namespaceId ||
    annotations?.["openclaw.dev/namespace-id"] !== namespaceId
  ) {
    throw new OwnershipFailure(
      `Refusing an unowned Kubernetes namespace for tenant ${namespaceId}.`,
    );
  }
  const external = annotations["openclaw.dev/namespace-lifecycle"] === "external";
  if (!external) {
    if (
      name !== kubernetesNamespaceName(namespaceId) ||
      labels["app.kubernetes.io/managed-by"] !== MANAGER
    ) {
      throw new OwnershipFailure(
        `Refusing Kubernetes namespace ${name} without external ownership.`,
      );
    }
  } else {
    for (const mode of ["enforce", "audit", "warn"]) {
      if (labels[`pod-security.kubernetes.io/${mode}`] !== "restricted") {
        throw new OwnershipFailure(
          `Existing Kubernetes namespace ${name} requires restricted Pod Security.`,
        );
      }
    }
  }
  return { name, external };
}

export async function resolveKubernetesNamespace(
  client: CoreV1Api,
  namespaceId: string,
): Promise<{ readonly name: string; readonly external: boolean }> {
  const observed = await client.listNamespace({
    labelSelector: `openclaw.dev/namespace=${namespaceId}`,
    timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
  });
  if (!Array.isArray(observed?.items)) {
    throw new OwnershipFailure("Kubernetes namespace discovery returned invalid resources.");
  }
  if (observed.items.length > 1) {
    throw new OwnershipFailure(`Multiple Kubernetes namespaces claim tenant ${namespaceId}.`);
  }
  if (observed.items.length === 0) {
    return { name: kubernetesNamespaceName(namespaceId), external: false };
  }
  const namespace = observed.items[0];
  const placement = verifiedKubernetesNamespace(namespace?.metadata, namespaceId);
  if (
    placement.external &&
    (namespace?.status?.phase !== "Active" || namespace.metadata?.deletionTimestamp !== undefined)
  ) {
    throw new OwnershipFailure(`Existing Kubernetes namespace ${placement.name} must be active.`);
  }
  return placement;
}

export class KubernetesComputeDriver implements ComputeDriver {
  static readonly configurationSchema = Object.freeze({
    type: "object",
    required: ["authentication", "images", "resources", "network", "servicePrincipalCredentials"],
    additionalProperties: false,
    properties: {
      authentication: {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: {
          mode: { enum: ["inCluster", "kubeconfig"] },
          kubeconfigPath: { type: "string" },
          context: { type: "string" },
        },
      },
      images: {
        type: "object",
        required: ["gateway", "agent", "requireImmutableDigest"],
        additionalProperties: false,
        properties: {
          gateway: { type: "string" },
          agent: { type: "string" },
          requireImmutableDigest: { type: "boolean" },
        },
      },
      resources: {
        type: "object",
        required: ["gateway", "agent", "namespace"],
        additionalProperties: false,
        properties: {
          gateway: RESOURCE_REQUIREMENTS_SCHEMA,
          agent: RESOURCE_REQUIREMENTS_SCHEMA,
          namespace: {
            type: "object",
            required: ["quota", "containerDefaults"],
            additionalProperties: false,
            properties: {
              quota: { type: "object", additionalProperties: { type: "string" } },
              containerDefaults: RESOURCE_REQUIREMENTS_SCHEMA,
            },
          },
        },
      },
      network: {
        type: "object",
        required: ["dns", "gatewayPort"],
        additionalProperties: false,
        properties: {
          dns: WORKLOAD_PEER_SCHEMA,
          gatewayPort: { type: "integer" },
          gatewayClients: { type: "array", items: WORKLOAD_PEER_SCHEMA },
        },
      },
      servicePrincipalCredentials: {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: {
          mode: { enum: ["disabled", "projectedServiceAccountToken"] },
          audience: { type: "string" },
          expirationSeconds: { type: "integer" },
        },
      },
      runtime: {
        type: "object",
        required: ["transportSecretPrefix", "modelSecretPrefix", "gatewayStorageClassName"],
        additionalProperties: false,
        properties: {
          transportSecretPrefix: { type: "string" },
          modelSecretPrefix: { type: "string" },
          gatewayStorageClassName: { type: "string", minLength: 1 },
          codexSeccompProfile: { type: "string", minLength: 1 },
          channels: {
            type: "object",
            required: ["secretPrefix", "proxyUrl"],
            additionalProperties: false,
            properties: {
              secretPrefix: { type: "string" },
              proxyUrl: { type: "string" },
            },
          },
        },
      },
      gatewayRouting: {
        type: "object",
        required: ["gatewayName", "gatewayNamespace", "envoyNamespace"],
        additionalProperties: false,
        properties: {
          hostname: { type: "string" },
          gatewayName: { type: "string" },
          gatewayNamespace: { type: "string" },
          envoyNamespace: { type: "string" },
        },
      },
    },
  });

  readonly id: string;
  readonly capability = "compute" as const;
  readonly implementation: string;
  private readonly options: KubernetesComputeDriverOptions;
  private readonly sandboxDriver: SandboxDriver | undefined;
  private lifecycle: ComputeLifecycleDispatcher;
  private lifecycleStarted = false;
  private apiClients: Promise<KubernetesApiClients> | undefined;
  private patchOptions:
    ReturnType<typeof import("@kubernetes/client-node").setHeaderOptions> | undefined;

  static validateConfiguration(configuration: unknown): void {
    const candidate = asRecord(configuration);
    if (candidate === undefined) throw new ConfigurationFailure("Kubernetes options are required.");
    if ("clients" in candidate) {
      throw new ConfigurationFailure("Injected Kubernetes API clients are not supported.");
    }
    for (const key of Object.keys(candidate)) {
      if (!(key in KubernetesComputeDriver.configurationSchema.properties)) {
        throw new ConfigurationFailure(
          `The Kubernetes driver configuration contains unsupported option ${key}.`,
        );
      }
    }
    const options = candidate as unknown as KubernetesComputeDriverOptions;
    const authentication = options.authentication;
    if (asRecord(authentication) === undefined) {
      throw new ConfigurationFailure(
        "Exactly one explicit Kubernetes authentication mode is required.",
      );
    }
    if (authentication.mode === "inCluster") {
      if ("kubeconfigPath" in authentication || "context" in authentication) {
        throw new ConfigurationFailure(
          "In-cluster and kubeconfig authentication cannot be combined.",
        );
      }
    } else if (authentication.mode === "kubeconfig") {
      const path = required(authentication.kubeconfigPath, "Dedicated kubeconfig path");
      if (!isAbsolute(path))
        throw new ConfigurationFailure("Dedicated kubeconfig path must be absolute.");
      required(authentication.context, "Explicit Kubernetes context");
    } else {
      throw new ConfigurationFailure(
        "Exactly one explicit Kubernetes authentication mode is required.",
      );
    }
    if (
      asRecord(options.images) === undefined ||
      typeof options.images.requireImmutableDigest !== "boolean"
    ) {
      throw new ConfigurationFailure(
        "Image references and immutable-image policy must be configured.",
      );
    }
    for (const [description, image] of [
      ["Gateway", options.images.gateway],
      ["Agent", options.images.agent],
    ] as const) {
      required(image, `${description} image`);
      if (options.images.requireImmutableDigest && !/@sha256:[a-f0-9]{64}$/i.test(image)) {
        throw new ConfigurationFailure(
          `${description} image must use an immutable SHA-256 digest.`,
        );
      }
    }
    if (
      asRecord(options.resources) === undefined ||
      asRecord(options.resources.namespace) === undefined
    ) {
      throw new ConfigurationFailure("Workload and namespace resource policies are required.");
    }
    validateResources(options.resources.gateway, "Gateway");
    validateResources(options.resources.agent, "Agent");
    validateResources(options.resources.namespace.containerDefaults, "Namespace default");
    const quota = asRecord(options.resources.namespace.quota);
    if (quota === undefined || Object.keys(quota).length === 0) {
      throw new ConfigurationFailure("Namespace resource quota must be configured.");
    }
    for (const [key, quantity] of Object.entries(quota)) {
      required(key, "Quota resource");
      required(quantity, `Quota ${key}`);
    }
    if (asRecord(options.network) === undefined)
      throw new ConfigurationFailure("Network policy is required.");
    validatePeer(options.network.dns, "DNS peer");
    validatePort(options.network.gatewayPort, "Gateway port");
    const hasDirectGatewayClients = Object.hasOwn(options.network, "gatewayClients");
    if (options.gatewayRouting === undefined) {
      if (
        !Array.isArray(options.network.gatewayClients) ||
        options.network.gatewayClients.length === 0
      ) {
        throw new ConfigurationFailure("At least one exact gateway client peer is required.");
      }
      options.network.gatewayClients.forEach((peer, index) =>
        validatePeer(peer, `Gateway client ${index}`),
      );
    } else if (hasDirectGatewayClients) {
      throw new ConfigurationFailure(
        "Gateway routing derives the Envoy gateway client peer; do not configure network.gatewayClients.",
      );
    }
    const credentials = options.servicePrincipalCredentials;
    if (asRecord(credentials) === undefined) {
      throw new ConfigurationFailure(
        "ServicePrincipal credential projection must be explicitly configured.",
      );
    }
    if (credentials.mode === "projectedServiceAccountToken") {
      required(credentials.audience, "ServicePrincipal token audience");
      const expiration = credentials.expirationSeconds;
      if (!Number.isSafeInteger(expiration) || expiration < 600 || expiration > 86_400) {
        throw new ConfigurationFailure(
          "ServicePrincipal token expiration must be between 600 and 86400 seconds.",
        );
      }
    } else if (credentials.mode !== "disabled") {
      throw new ConfigurationFailure(
        "ServicePrincipal credential projection must be explicitly configured.",
      );
    }
    if (options.runtime !== undefined) {
      const { transportSecretPrefix, modelSecretPrefix, channels } = options.runtime;
      const runtimeProperties = asRecord(
        KubernetesComputeDriver.configurationSchema.properties.runtime.properties,
      );
      if (runtimeProperties === undefined) {
        throw new ConfigurationFailure("Kubernetes runtime configuration schema is invalid.");
      }
      const runtimeKeys = new Set(Object.keys(runtimeProperties));
      for (const key of Object.keys(options.runtime)) {
        if (!runtimeKeys.has(key)) {
          throw new ConfigurationFailure(
            `The Kubernetes runtime configuration contains unsupported option ${key}.`,
          );
        }
      }
      required(transportSecretPrefix, "Agent transport Secret name prefix");
      required(modelSecretPrefix, "Agent model Secret name prefix");
      required(options.runtime.gatewayStorageClassName, "SQLite-compatible gateway storage class");
      if (options.runtime.codexSeccompProfile !== undefined) {
        validateCodexSeccompProfile(options.runtime.codexSeccompProfile);
      }
      if (transportSecretPrefix === modelSecretPrefix) {
        throw new ConfigurationFailure(
          "Gateway, Agent transport, and model credentials must remain separate.",
        );
      }
      if (channels !== undefined) {
        if (asRecord(channels) === undefined) {
          throw new ConfigurationFailure(
            "Channel runtime credentials must be explicitly configured.",
          );
        }
        const prefix = required(channels.secretPrefix, "Agent channel Secret name prefix");
        if ([transportSecretPrefix, modelSecretPrefix].includes(prefix)) {
          throw new ConfigurationFailure("Agent channel credentials must remain separate.");
        }
        channelProxy(channels.proxyUrl);
      }
    }
    if (options.gatewayRouting !== undefined) {
      const routing = options.gatewayRouting;
      if (asRecord(routing) === undefined) {
        throw new ConfigurationFailure("Gateway routing must be explicitly configured.");
      }
      if (routing.hostname !== undefined) {
        if (typeof routing.hostname !== "string") {
          throw new ConfigurationFailure(
            "Gateway routing hostname must be a DNS hostname without a port or path.",
          );
        }
        if (routing.hostname.length > 0) {
          validateDnsHostname(routing.hostname, "Gateway routing hostname");
        }
      }
      validateKubernetesResourceName(
        required(routing.gatewayName, "Gateway routing Gateway name"),
        "Gateway routing Gateway name",
      );
      validateKubernetesResourceName(
        required(routing.gatewayNamespace, "Gateway routing Gateway namespace"),
        "Gateway routing Gateway namespace",
      );
      validateKubernetesResourceName(
        required(routing.envoyNamespace, "Gateway routing Envoy namespace"),
        "Gateway routing Envoy namespace",
      );
    }
  }

  constructor(
    options: KubernetesComputeDriverOptions,
    selection: {
      readonly id?: string;
      readonly implementation?: string;
      readonly lifecycleDrivers?: readonly Driver[];
      readonly sandboxDriver?: SandboxDriver;
    } = {},
  ) {
    KubernetesComputeDriver.validateConfiguration(options);
    this.id = required(selection.id ?? "compute-kubernetes-local", "Kubernetes Compute Driver ID");
    this.implementation = required(
      selection.implementation ?? "kubernetes-local",
      "Kubernetes Compute Driver implementation",
    );
    this.options = options;
    this.sandboxDriver = selection.sandboxDriver;
    this.lifecycle = new ComputeLifecycleDispatcher(selection.lifecycleDrivers ?? []);
  }

  setLifecycleDrivers(drivers: readonly Driver[]): void {
    if (this.lifecycleStarted) {
      throw new Error("Compute lifecycle owners cannot change after lifecycle operations begin.");
    }
    this.lifecycle = new ComputeLifecycleDispatcher(drivers);
  }

  async preflight(): Promise<void> {
    const clients = await this.clients();
    const namespaces = await this.request(() =>
      clients.core.listNamespace({
        limit: 1,
        timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
      }),
    );
    if (!Array.isArray(namespaces.items)) {
      throw new Error("The authenticated Kubernetes Namespace preflight returned invalid data.");
    }
  }

  getGatewayEndpoint(revision: AgentRevision): string | undefined {
    const routing = this.options.gatewayRouting;
    if (routing === undefined) return undefined;
    return `wss://${this.gatewayRoutingHostname(routing)}${this.gatewayRoutePath(revision)}`;
  }

  async storeServiceAccountCredential(input: {
    readonly namespaceId: string;
    readonly serviceAccountId: string;
    readonly accessToken: string;
    readonly workspaceId: string;
  }): Promise<{ readonly name: string; readonly key: string }> {
    const namespaceId = required(input.namespaceId, "ServiceAccount Namespace ID");
    const serviceAccountId = required(input.serviceAccountId, "ServiceAccount ID");
    const accessToken = required(input.accessToken, "ServiceAccount access token");
    const workspaceId = required(input.workspaceId, "ServiceAccount workspace ID");
    const { name: namespace, external } = await this.resolveNamespace(namespaceId);
    const observed = await this.get("Namespace", namespace);
    if (observed === undefined || observed.status?.phase !== "Active") {
      throw new OwnershipFailure("The ServiceAccount Kubernetes namespace is unavailable.");
    }
    this.verifyNamespaceOwnership(observed, { namespaceId }, external);

    const name = `service-account-${sha256Hex(serviceAccountId, 32)}`;
    const ownership = { namespaceId, serviceAccountId };
    const existing = await this.getOwned("Secret", name, namespace, ownership);
    if (existing !== undefined) {
      throw new ConfigurationFailure("The ServiceAccount credential Secret already exists.");
    }

    const clients = await this.clients();
    await this.request(
      () =>
        clients.core.createNamespacedSecret({
          namespace,
          body: {
            ...this.manifest("v1", "Secret", name, ownership, namespace),
            type: "Opaque",
            stringData: {
              [SERVICE_ACCOUNT_TOKEN_KEY]: accessToken,
              [SERVICE_ACCOUNT_WORKSPACE_KEY]: workspaceId,
            },
          },
        }),
      { mutating: true },
    );
    return { name, key: SERVICE_ACCOUNT_TOKEN_KEY };
  }

  async deleteServiceAccountCredential(input: {
    readonly namespaceId: string;
    readonly serviceAccountId: string;
    readonly secretRef: { readonly name: string; readonly key: string };
  }): Promise<void> {
    const namespaceId = required(input.namespaceId, "ServiceAccount Namespace ID");
    const serviceAccountId = required(input.serviceAccountId, "ServiceAccount ID");
    const name = `service-account-${sha256Hex(serviceAccountId, 32)}`;
    if (input.secretRef.name !== name || input.secretRef.key !== SERVICE_ACCOUNT_TOKEN_KEY) {
      throw new OwnershipFailure("Refusing another ServiceAccount's credential Secret.");
    }

    const { name: namespace, external } = await this.resolveNamespace(namespaceId);
    const tenant = await this.get("Namespace", namespace);
    if (tenant === undefined) return;
    this.verifyNamespaceOwnership(tenant, { namespaceId }, external);
    const existing = await this.getOwned("Secret", name, namespace, {
      namespaceId,
      serviceAccountId,
    });
    if (existing === undefined) return;
    const clients = await this.clients();
    await this.request(
      () =>
        clients.core.deleteNamespacedSecret({
          name,
          namespace,
          ...(existing.metadata.uid === undefined
            ? {}
            : { body: { preconditions: { uid: existing.metadata.uid } } }),
        }),
      { mutating: true },
    );
  }

  async ensureNamespace(namespace: Namespace): Promise<NamespaceEnsureResult> {
    this.lifecycleStarted = true;
    const result = { namespaceId: namespace.id, namespaceReady: false };
    let tenantAccessRequired = false;
    try {
      const ownership = { namespaceId: namespace.id };
      const selection = namespace.existingNamespace;
      const placement =
        selection === undefined
          ? await this.resolveNamespace(namespace.id)
          : { name: selection, external: true };
      const { name, external: externallyManaged } = placement;
      if (externallyManaged && selection === undefined) {
        throw new OwnershipFailure(
          `Existing Kubernetes namespace ${name} was not explicitly selected.`,
        );
      }
      if (!externallyManaged) {
        const desired = this.manifest("v1", "Namespace", name, ownership);
        desired.metadata.labels = {
          ...desired.metadata.labels,
          ...this.gatewayMembershipLabels(),
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/audit": "restricted",
          "pod-security.kubernetes.io/warn": "restricted",
        };
        await this.reconcile(desired, ownership);
      }
      const observed = await this.get("Namespace", name);
      if (observed === undefined) {
        if (externallyManaged) {
          throw new OwnershipFailure(`Existing Kubernetes namespace ${name} does not exist.`);
        }
        return result;
      }
      if (externallyManaged) {
        this.verifyAdoptableNamespace(observed, ownership);
        await this.verifyUniqueExistingNamespace(name, ownership);
      } else {
        this.verifyNamespaceOwnership(observed, ownership, false);
      }
      if (
        observed.status?.phase !== "Active" ||
        (externallyManaged && observed.metadata.deletionTimestamp !== undefined)
      ) {
        if (externallyManaged) {
          throw new OwnershipFailure(`Existing Kubernetes namespace ${name} must be active.`);
        }
        return result;
      }
      tenantAccessRequired = true;
      if (externallyManaged) {
        await this.verifyExistingNetworkPolicies(name, ownership);
        await this.claimExistingNamespace(observed, ownership);
      }
      await this.reconcile(
        {
          ...this.manifest("v1", "ResourceQuota", "openclaw-quota", ownership, name),
          spec: { hard: { ...this.options.resources.namespace.quota } },
        },
        ownership,
        name,
      );
      await this.reconcile(
        {
          ...this.manifest("v1", "LimitRange", "openclaw-limits", ownership, name),
          spec: {
            limits: [
              {
                type: "Container",
                default: { ...this.options.resources.namespace.containerDefaults.limits },
                defaultRequest: { ...this.options.resources.namespace.containerDefaults.requests },
              },
            ],
          },
        },
        ownership,
        name,
      );
      for (const policy of this.networkPolicies(ownership, name)) {
        await this.reconcile(policy, ownership, name);
      }
      await this.lifecycle.afterNamespacePrepared(namespace);
      await this.sandboxDriver?.ensureNamespace?.(
        await this.sandboxNamespaceContext(namespace, name),
      );
      return { ...result, namespaceReady: true };
    } catch (error) {
      if (tenantAccessRequired && numericErrorStatus(error) === 403) return result;
      return { ...result, failure: failure(error) };
    }
  }

  async deleteNamespace(namespace: Namespace): Promise<NamespaceDeleteResult> {
    this.lifecycleStarted = true;
    const result = { namespaceId: namespace.id, namespaceDeleted: false };
    try {
      const clients = await this.clients();
      const { name, external } =
        namespace.existingNamespace === undefined
          ? await this.resolveNamespace(namespace.id)
          : { name: namespace.existingNamespace, external: true };
      const ownership = { namespaceId: namespace.id };
      const existing = await this.get("Namespace", name);
      if (existing === undefined) return { ...result, namespaceDeleted: true };
      if (
        external &&
        existing.metadata.labels?.["openclaw.dev/namespace"] === undefined &&
        existing.metadata.annotations?.["openclaw.dev/namespace-id"] === undefined
      ) {
        return { ...result, namespaceDeleted: true };
      }
      this.verifyNamespaceOwnership(existing, ownership, external);
      if (
        existing.metadata.deletionTimestamp !== undefined ||
        existing.status?.phase === "Terminating"
      ) {
        return result;
      }
      await this.lifecycle.beforeNamespaceDelete(namespace);
      if (this.sandboxDriver !== undefined) {
        await this.sandboxDriver.cleanup(await this.sandboxNamespaceContext(namespace, name));
      }
      if (external) {
        const deleted = await this.deleteOwnedNamespaceResources(name, ownership);
        if (!deleted) return result;
        const remaining = await this.get("Namespace", name);
        if (remaining !== undefined) this.verifyNamespaceOwnership(remaining, ownership, true);
        return { ...result, namespaceDeleted: true };
      }
      await this.request(
        () =>
          clients.core.deleteNamespace({
            name,
            ...(existing.metadata.uid === undefined
              ? {}
              : { body: { preconditions: { uid: existing.metadata.uid } } }),
          }),
        { mutating: true },
      );
      const remaining = await this.get("Namespace", name);
      if (remaining === undefined) return { ...result, namespaceDeleted: true };
      this.verifyNamespaceOwnership(remaining, ownership, false);
      return result;
    } catch (error) {
      return { ...result, failure: failure(error) };
    }
  }

  async prepareRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness> {
    this.lifecycleStarted = true;
    const result = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: false,
    };
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation ||
      typeof revision.servicePrincipalId !== "string" ||
      revision.servicePrincipalId.trim().length === 0
    )
      return result;
    required(revision.agentId, "Agent ID");
    required(revision.id, "AgentRevision ID");
    required(revision.configurationId, "Agent Configuration ID");
    if (
      revision.configurationKind !== "agent" ||
      !Number.isSafeInteger(revision.revision) ||
      revision.revision < 1 ||
      !Number.isSafeInteger(revision.configurationGeneration) ||
      revision.configurationGeneration < 1
    ) {
      throw new ConfigurationFailure("AgentRevision Configuration ownership is invalid.");
    }
    this.verifyGatewayRoutingConfiguration(revision);
    const embedded = revision.harness.mode === "embedded";
    if (
      (embedded && revision.harness.id !== "openclaw") ||
      (!embedded && (revision.harness.mode !== "dedicated" || revision.harness.id !== "codex"))
    ) {
      throw new ConfigurationFailure("AgentRevision Harness execution topology is unsupported.");
    }
    const sandboxDriver = this.sandboxDriverForRevision(revision);
    if (sandboxDriver !== undefined && embedded) {
      throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
    }
    if (revision.serviceAccount?.credential.kind === "access_token") {
      if (embedded || this.options.runtime === undefined) {
        throw new ConfigurationFailure(
          "ServiceAccount access tokens require a dedicated Codex runtime.",
        );
      }
      const { id, credential } = revision.serviceAccount;
      const expectedName = `service-account-${sha256Hex(required(id, "ServiceAccount ID"), 32)}`;
      if (
        credential.secretRef.name !== expectedName ||
        credential.secretRef.key !== SERVICE_ACCOUNT_TOKEN_KEY
      ) {
        throw new OwnershipFailure("Refusing another ServiceAccount's credential Secret.");
      }
    }
    const channels = this.enabledChannels(revision);
    const { name: namespace, external } = await this.resolveNamespace(revision.namespaceId);
    const secretEnvironment = this.secretEnvironmentForRevision(revision, context, namespace);
    const tenantOwnership = { namespaceId: revision.namespaceId };
    const observed = await this.get("Namespace", namespace);
    if (observed === undefined) return result;
    this.verifyNamespaceOwnership(observed, tenantOwnership, external);
    if (observed.status?.phase !== "Active") return result;
    for (const policy of this.networkPolicies(tenantOwnership, namespace)) {
      const existing = await this.getOwned(
        "NetworkPolicy",
        policy.metadata.name,
        namespace,
        tenantOwnership,
      );
      if (existing === undefined) return result;
    }
    const agentName = `agent-${sha256Hex(revision.agentId, 12)}`;
    const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
    const gatewayOwnership = { ...tenantOwnership, agentId: revision.agentId };
    const agentOwnership = {
      ...tenantOwnership,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
    };
    const document = JSON.stringify(revision.configuration);
    const configuration = this.gatewayConfiguration(revision);
    const existingGateway = await this.getOwned(
      "Deployment",
      gatewayName,
      namespace,
      gatewayOwnership,
    );
    let existingGatewayRevision: number | undefined;
    if (existingGateway !== undefined) {
      if (existingGateway.spec?.replicas !== 1) return result;
      const annotations = existingGateway.metadata.annotations ?? {};
      const currentRevision = Number(annotations[AGENT_REVISION_ANNOTATION]);
      const currentRevisionId = annotations[AGENT_REVISION_ID_ANNOTATION];
      if (
        !Number.isSafeInteger(currentRevision) ||
        currentRevision < 1 ||
        typeof currentRevisionId !== "string" ||
        currentRevisionId.trim().length === 0
      ) {
        throw new OwnershipFailure(`Refusing invalid Agent gateway revision ${gatewayName}.`);
      }
      const template = asRecord(existingGateway.spec?.template);
      const pod = asRecord(template?.spec);
      const volumes = Array.isArray(pod?.volumes) ? pod.volumes : [];
      const volume = volumes.find(
        (candidate) => asRecord(candidate)?.name === CONFIGURATION_VOLUME,
      );
      const currentConfiguration = asRecord(asRecord(volume)?.configMap)?.name;
      if (typeof currentConfiguration !== "string") {
        throw new OwnershipFailure(`Refusing unconfigured Agent gateway ${gatewayName}.`);
      }
      if (revision.revision < currentRevision) return result;
      if (revision.revision === currentRevision) {
        if (revision.id !== currentRevisionId || currentConfiguration !== configuration.name) {
          throw new ConfigurationFailure(
            "Immutable AgentRevision gateway configuration cannot change.",
          );
        }
      }
      existingGatewayRevision = currentRevision;
    }
    const snapshot = this.manifest(
      "v1",
      "ConfigMap",
      configuration.name,
      gatewayOwnership,
      namespace,
    );
    await this.reconcile(
      {
        ...snapshot,
        metadata: {
          ...snapshot.metadata,
          annotations: { ...snapshot.metadata.annotations, ...configuration.annotations },
        },
        immutable: true,
        data: { [CONFIGURATION_DOCUMENT]: document },
      },
      gatewayOwnership,
      namespace,
    );
    const gatewayAccountName = embedded ? agentName : gatewayName;
    const gatewayAccountOwnership = embedded ? agentOwnership : gatewayOwnership;
    await this.reconcile(
      {
        ...this.manifest(
          "v1",
          "ServiceAccount",
          gatewayAccountName,
          gatewayAccountOwnership,
          namespace,
        ),
        automountServiceAccountToken: false,
      },
      gatewayAccountOwnership,
      namespace,
    );
    if (!embedded) {
      await this.reconcile(
        this.sharedWorkspaceClaim(revision.agentId, gatewayOwnership, namespace),
        gatewayOwnership,
        namespace,
      );
    }
    if (this.options.runtime !== undefined) {
      await this.reconcile(
        this.gatewayPrivateStateClaim(revision.agentId, gatewayOwnership, namespace),
        gatewayOwnership,
        namespace,
      );
    }
    let launchPrepared = false;
    try {
      const prepareEmbeddedGateway =
        embedded &&
        (existingGateway === undefined ||
          this.options.runtime === undefined ||
          existingGateway.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] === revision.id);
      const embeddedEnvironment = prepareEmbeddedGateway
        ? (await this.lifecycle.beforeWorkloadStart(revision)).environment
        : {};
      if (prepareEmbeddedGateway) launchPrepared = true;
      if (
        existingGateway === undefined ||
        this.options.runtime === undefined ||
        existingGateway.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] === revision.id
      ) {
        await this.reconcileChannelNetworkPolicy(revision, channels, namespace);
        await this.reconcile(
          this.deployment(
            gatewayName,
            gatewayOwnership,
            namespace,
            this.options.images.gateway,
            gatewayAccountName,
            "gateway",
            embeddedEnvironment,
            configuration.loggingLevel,
            configuration,
            embedded,
            embedded ? revision.servicePrincipalId : undefined,
            undefined,
            channels,
            secretEnvironment,
          ),
          gatewayOwnership,
          namespace,
        );
      }
      const existingGatewayService = await this.getOwned(
        "Service",
        gatewayName,
        namespace,
        gatewayOwnership,
      );
      const inactiveEmbeddedGateway =
        embedded &&
        this.options.runtime !== undefined &&
        (existingGatewayService === undefined ||
          asRecord(existingGatewayService.spec?.selector)?.["app.kubernetes.io/name"] ===
            `${gatewayName}-inactive`);
      await this.reconcile(
        this.service(gatewayName, gatewayOwnership, namespace, {
          "app.kubernetes.io/name": inactiveEmbeddedGateway
            ? `${gatewayName}-inactive`
            : gatewayName,
        }),
        gatewayOwnership,
        namespace,
      );
      await this.reconcileGatewayRoute(revision, gatewayOwnership, namespace);
      if (
        embedded &&
        this.options.runtime !== undefined &&
        existingGatewayRevision !== undefined &&
        existingGatewayRevision < revision.revision
      ) {
        // A broken old gateway must not block recovery. This only stages the replacement;
        // post-commit activation replaces the Deployment and verifies its readiness.
        return { ...result, ready: true };
      }
      if (inactiveEmbeddedGateway) {
        const gateway = await this.getOwned("Deployment", gatewayName, namespace, gatewayOwnership);
        if (gateway === undefined || !this.deploymentReady(gateway)) return result;
      } else if (!(await this.gatewayReady(gatewayOwnership, gatewayName, namespace))) {
        return result;
      }
      if (embedded) return { ...result, ready: true };
      await this.reconcile(
        {
          ...this.manifest("v1", "ServiceAccount", agentName, agentOwnership, namespace),
          automountServiceAccountToken: false,
        },
        agentOwnership,
        namespace,
      );
      const existingService = await this.getOwned("Service", agentName, namespace, agentOwnership);
      if (existingService === undefined) {
        await this.reconcile(
          this.service(agentName, agentOwnership, namespace, {
            "app.kubernetes.io/name": `${agentName}-inactive`,
          }),
          agentOwnership,
          namespace,
        );
      }
      const revisionName = `${agentName}-rev-${sha256Hex(revision.id, 12)}`;
      const revisionOwnership = { ...agentOwnership, revisionId: revision.id };
      if (revision.serviceAccount?.credential.kind === "access_token") {
        await this.reconcile(
          this.agentAuthenticationNetworkPolicy(revision, namespace),
          agentOwnership,
          namespace,
        );
      }
      const launch = await this.lifecycle.beforeWorkloadStart(revision);
      launchPrepared = true;
      const agentDeployment = this.deployment(
        revisionName,
        revisionOwnership,
        namespace,
        this.options.images.agent,
        agentName,
        "agent",
        launch.environment,
        configuration.loggingLevel,
        undefined,
        false,
        undefined,
        revision.serviceAccount,
      );
      if (sandboxDriver?.provisionHarness !== undefined) {
        const requirements = this.harnessRequirementsFromDeployment(agentDeployment);
        const sandbox = await sandboxDriver.provisionHarness({
          ...(await this.sandboxNamespaceContext(
            this.sandboxNamespaceForRevision(revision, namespace),
            namespace,
          )),
          revision,
          requirements,
        });
        this.verifySandboxResourceRef(sandbox, revision, namespace);
        return {
          ...result,
          ready: await this.providerHarnessReady(revision, namespace, requirements.labels),
        };
      }
      await this.reconcile(agentDeployment, revisionOwnership, namespace);
      const deployment = await this.getOwned(
        "Deployment",
        revisionName,
        namespace,
        revisionOwnership,
      );
      if (deployment === undefined) {
        await this.lifecycle.beforeWorkloadStop(revision, { cleanup: true });
        return result;
      }
      return { ...result, ready: this.deploymentReady(deployment) };
    } catch (error) {
      const failures = [error];
      if (launchPrepared) {
        try {
          await this.lifecycle.beforeWorkloadStop(revision, { cleanup: true });
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Agent workload preparation and cleanup failed.");
      }
      throw error;
    }
  }

  async activateRevision(revision: AgentRevision, context?: ComputeRevisionContext): Promise<void> {
    if (this.options.runtime === undefined) return;
    this.verifyGatewayRoutingConfiguration(revision);
    const channels = this.enabledChannels(revision);
    const { name: namespace } = await this.resolveNamespace(revision.namespaceId);
    const secretEnvironment = this.secretEnvironmentForRevision(revision, context, namespace);
    const agentName = `agent-${sha256Hex(revision.agentId, 12)}`;
    const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
    const gatewayOwnership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const ownership = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
    };
    if (revision.harness.mode === "embedded") {
      if (this.sandboxDriverForRevision(revision) !== undefined) {
        throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
      }
      const gateway = await this.getOwned("Deployment", gatewayName, namespace, gatewayOwnership);
      if (gateway === undefined) throw new Error("The Agent gateway workload is unavailable.");
      const annotations = gateway.metadata.annotations ?? {};
      const currentRevision = Number(annotations[AGENT_REVISION_ANNOTATION]);
      const currentRevisionId = annotations[AGENT_REVISION_ID_ANNOTATION];
      if (
        !Number.isSafeInteger(currentRevision) ||
        currentRevision < 1 ||
        typeof currentRevisionId !== "string" ||
        currentRevisionId.trim().length === 0
      ) {
        throw new OwnershipFailure(`Refusing invalid Agent gateway revision ${gatewayName}.`);
      }
      if (
        currentRevision > revision.revision ||
        (currentRevision === revision.revision && currentRevisionId !== revision.id)
      ) {
        throw new ConfigurationFailure("Refusing stale AgentRevision gateway activation.");
      }
      if (currentRevisionId !== revision.id) {
        const launch = await this.lifecycle.beforeWorkloadStart(revision);
        try {
          await this.reconcile(
            this.gatewayPrivateStateClaim(revision.agentId, gatewayOwnership, namespace),
            gatewayOwnership,
            namespace,
          );
          await this.reconcileChannelNetworkPolicy(revision, channels, namespace);
          await this.reconcile(
            this.deployment(
              gatewayName,
              gatewayOwnership,
              namespace,
              this.options.images.gateway,
              agentName,
              "gateway",
              launch.environment,
              this.gatewayConfiguration(revision).loggingLevel,
              this.gatewayConfiguration(revision),
              true,
              revision.servicePrincipalId,
              undefined,
              channels,
              secretEnvironment,
            ),
            gatewayOwnership,
            namespace,
          );
        } catch (error) {
          await this.lifecycle.beforeWorkloadStop(revision, { cleanup: true });
          throw error;
        }
      }
      for (const policy of this.agentNetworkPolicies(revision, namespace)) {
        await this.reconcile(policy, gatewayOwnership, namespace);
      }
      await this.reconcile(
        this.service(gatewayName, gatewayOwnership, namespace, {
          "app.kubernetes.io/name": gatewayName,
        }),
        gatewayOwnership,
        namespace,
      );
      await this.reconcileGatewayRoute(revision, gatewayOwnership, namespace);
      if (!(await this.gatewayReady(gatewayOwnership, gatewayName, namespace))) {
        throw new Error("The exact AgentRevision gateway is not ready.");
      }
      return;
    }
    const revisionName = `${agentName}-rev-${sha256Hex(revision.id, 12)}`;
    const sandboxDriver = this.sandboxDriverForRevision(revision);
    const configuration = this.gatewayConfiguration(revision);
    const agentDeployment = this.deployment(
      revisionName,
      { ...ownership, revisionId: revision.id },
      namespace,
      this.options.images.agent,
      agentName,
      "agent",
      {},
      configuration.loggingLevel,
      undefined,
      false,
      undefined,
      revision.serviceAccount,
    );
    if (sandboxDriver?.provisionHarness === undefined) {
      const deployment = await this.getOwned("Deployment", revisionName, namespace, {
        ...ownership,
        revisionId: revision.id,
      });
      if (deployment === undefined || !this.deploymentReady(deployment)) {
        throw new Error("The exact AgentRevision workload is not ready.");
      }
    } else {
      const requirements = this.harnessRequirementsFromDeployment(agentDeployment);
      if (!(await this.providerHarnessReady(revision, namespace, requirements.labels))) {
        throw new Error("The exact AgentRevision workload is not ready.");
      }
    }
    await this.reconcileChannelNetworkPolicy(revision, channels, namespace);
    await this.reconcile(
      this.sharedWorkspaceClaim(revision.agentId, gatewayOwnership, namespace),
      gatewayOwnership,
      namespace,
    );
    await this.reconcile(
      this.gatewayPrivateStateClaim(revision.agentId, gatewayOwnership, namespace),
      gatewayOwnership,
      namespace,
    );
    await this.reconcile(
      this.deployment(
        gatewayName,
        gatewayOwnership,
        namespace,
        this.options.images.gateway,
        gatewayName,
        "gateway",
        {},
        configuration.loggingLevel,
        configuration,
        false,
        undefined,
        undefined,
        channels,
      ),
      gatewayOwnership,
      namespace,
    );
    await this.reconcile(
      this.service(gatewayName, gatewayOwnership, namespace, {
        "app.kubernetes.io/name": gatewayName,
      }),
      gatewayOwnership,
      namespace,
    );
    await this.reconcileGatewayRoute(revision, gatewayOwnership, namespace);
    if (!(await this.gatewayReady(gatewayOwnership, gatewayName, namespace))) {
      throw new Error("The exact AgentRevision gateway is not ready.");
    }
    for (const policy of this.agentNetworkPolicies(revision, namespace)) {
      await this.reconcile(policy, gatewayOwnership, namespace);
    }
    await this.reconcile(
      this.service(agentName, ownership, namespace, {
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": "agent",
        ...(sandboxDriver?.provisionHarness === undefined
          ? { "app.kubernetes.io/name": revisionName }
          : {}),
      }),
      ownership,
      namespace,
    );
  }

  async deactivateRevision(revision: AgentRevision): Promise<void> {
    if (this.options.runtime === undefined) return;
    const { name: namespace } = await this.resolveNamespace(revision.namespaceId);
    if (revision.harness.mode === "embedded") {
      if (this.sandboxDriverForRevision(revision) !== undefined) {
        throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
      }
      const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
      const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
      const service = await this.getOwned("Service", gatewayName, namespace, ownership);
      if (service === undefined) return;
      const gateway = await this.getOwned("Deployment", gatewayName, namespace, ownership);
      if (gateway === undefined) return;
      if (gateway.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] !== revision.id) return;
      if (asRecord(service.spec?.selector)?.["app.kubernetes.io/name"] !== gatewayName) return;
      await this.reconcile(
        this.service(gatewayName, ownership, namespace, {
          "app.kubernetes.io/name": `${gatewayName}-inactive`,
        }),
        ownership,
        namespace,
      );
      return;
    }
    const agentName = `agent-${sha256Hex(revision.agentId, 12)}`;
    const ownership = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
    };
    await this.reconcile(
      this.service(agentName, ownership, namespace, {
        "app.kubernetes.io/name": `${agentName}-inactive`,
      }),
      ownership,
      namespace,
      { serviceSelector: { "openclaw.dev/revision": revision.id } },
    );
  }

  async retireRevision(revision: AgentRevision): Promise<void> {
    this.lifecycleStarted = true;
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new Error("Refusing to retire an AgentRevision pinned to another Compute Driver.");
    }
    required(revision.agentId, "Agent ID");
    required(revision.id, "AgentRevision ID");
    required(revision.servicePrincipalId, "Agent ServicePrincipal ID");
    const clients = await this.clients();
    const { name: namespace, external } = await this.resolveNamespace(revision.namespaceId);
    const existingNamespace = await this.get("Namespace", namespace);
    if (existingNamespace === undefined) {
      await this.lifecycle.beforeWorkloadStop(revision);
      return;
    }
    this.verifyNamespaceOwnership(
      existingNamespace,
      { namespaceId: revision.namespaceId },
      external,
    );
    if (revision.harness.mode === "embedded") {
      if (this.sandboxDriverForRevision(revision) !== undefined) {
        throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
      }
      await this.lifecycle.beforeWorkloadStop(revision);
      await this.removeRetiredGateway(revision, namespace);
      return;
    }
    const sandboxDriver = this.sandboxDriverForRevision(revision);
    if (sandboxDriver?.provisionHarness !== undefined) {
      await this.lifecycle.beforeWorkloadStop(revision);
      await sandboxDriver.cleanup({
        ...(await this.sandboxNamespaceContext(
          this.sandboxNamespaceForRevision(revision, namespace),
          namespace,
        )),
        revision,
      });
      await this.removeRetiredGateway(revision, namespace);
      return;
    }
    const name = `agent-${sha256Hex(revision.agentId, 12)}-rev-${sha256Hex(revision.id, 12)}`;
    const deployment = await this.getOwned("Deployment", name, namespace, {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    });
    if (deployment === undefined) {
      await this.lifecycle.beforeWorkloadStop(revision);
      await this.removeRetiredGateway(revision, namespace);
      return;
    }
    await this.lifecycle.beforeWorkloadStop(revision);
    await this.request(
      () =>
        clients.apps.deleteNamespacedDeployment({
          name,
          namespace,
          ...(deployment.metadata.uid === undefined
            ? {}
            : { body: { preconditions: { uid: deployment.metadata.uid } } }),
        }),
      { mutating: true },
    );
    await this.removeRetiredGateway(revision, namespace);
  }

  private async removeRetiredGateway(revision: AgentRevision, namespace: string): Promise<void> {
    const name = `gateway-${sha256Hex(revision.agentId, 12)}`;
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const gateway = await this.getOwned("Deployment", name, namespace, ownership);
    if (gateway === undefined) {
      const route = await this.gatewayRouteForRevision(name, ownership, namespace, revision.id);
      if (route === undefined) return;
      if (this.options.runtime !== undefined) {
        await this.deleteGatewayPrivateStateClaim(ownership, namespace);
      }
      if (revision.harness.mode === "dedicated") {
        await this.deleteSharedWorkspaceClaim(ownership, namespace);
      }
      await this.deleteGatewayRoute(name, ownership, namespace, revision.id);
      await this.deleteGateway(name, ownership, namespace);
      return;
    }
    const annotations = gateway.metadata.annotations ?? {};
    if (annotations[AGENT_REVISION_ID_ANNOTATION] === revision.id) {
      if (this.options.runtime !== undefined) {
        await this.deleteGatewayPrivateStateClaim(ownership, namespace);
      }
      if (revision.harness.mode === "dedicated") {
        await this.deleteSharedWorkspaceClaim(ownership, namespace);
      }
      await this.deleteGatewayRoute(name, ownership, namespace, revision.id);
      await this.deleteGateway(name, ownership, namespace);
    }
  }

  private async deleteGatewayRoute(
    name: string,
    ownership: Ownership,
    namespace: string,
    revisionId: string,
  ): Promise<void> {
    const existing = await this.gatewayRouteForRevision(name, ownership, namespace, revisionId);
    if (existing === undefined) return;
    if (existing.metadata.uid === undefined) {
      throw new OwnershipFailure(
        `HTTPRoute ${name} UID must be explicitly observed before delete.`,
      );
    }
    const clients = await this.clients();
    await this.request(
      () =>
        clients.objects.delete(
          {
            apiVersion: GATEWAY_API_VERSION,
            kind: "HTTPRoute",
            metadata: { name, namespace },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { preconditions: { uid: existing.metadata.uid } } as V1DeleteOptions,
        ),
      { mutating: true },
    );
  }

  private async gatewayRouteForRevision(
    name: string,
    ownership: Ownership,
    namespace: string,
    revisionId: string,
  ): Promise<ManagedKubernetesObject<"HTTPRoute"> | undefined> {
    if (this.options.gatewayRouting === undefined) return undefined;
    const existing = await this.getOwned("HTTPRoute", name, namespace, ownership);
    if (existing === undefined) return undefined;
    return existing.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] === revisionId
      ? existing
      : undefined;
  }

  private async deleteGateway(
    name: string,
    ownership: Ownership,
    namespace: string,
  ): Promise<void> {
    const clients = await this.clients();
    for (const kind of ["Service", "ServiceAccount", "Deployment"] as const) {
      const existing = await this.getOwned(kind, name, namespace, ownership);
      if (existing === undefined) continue;
      const request = {
        name,
        namespace,
        ...(existing.metadata.uid === undefined
          ? {}
          : { body: { preconditions: { uid: existing.metadata.uid } } }),
      };
      await this.request(
        async () => {
          if (kind === "Deployment") {
            await clients.apps.deleteNamespacedDeployment(request);
          } else if (kind === "Service") {
            await clients.core.deleteNamespacedService(request);
          } else {
            await clients.core.deleteNamespacedServiceAccount(request);
          }
        },
        { mutating: true },
      );
    }
  }

  private async resolveNamespace(
    namespaceId: string,
  ): Promise<{ readonly name: string; readonly external: boolean }> {
    const clients = await this.clients();
    return this.request(() => resolveKubernetesNamespace(clients.core, namespaceId));
  }

  private verifyAdoptableNamespace(
    namespace: ManagedKubernetesObject<"Namespace">,
    ownership: Ownership,
  ): boolean {
    const labels = namespace.metadata.labels ?? {};
    const annotations = namespace.metadata.annotations ?? {};
    if (annotations["openclaw.dev/namespace-lifecycle"] !== "external") {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} requires external ownership.`,
      );
    }
    for (const mode of ["enforce", "audit", "warn"]) {
      if (labels[`pod-security.kubernetes.io/${mode}`] !== "restricted") {
        throw new OwnershipFailure(
          `Existing Kubernetes namespace ${namespace.metadata.name} requires restricted Pod Security.`,
        );
      }
    }
    const existingLabel = labels["openclaw.dev/namespace"];
    const existingId = annotations["openclaw.dev/namespace-id"];
    if (
      (existingLabel !== undefined && existingLabel !== ownership.namespaceId) ||
      (existingId !== undefined && existingId !== ownership.namespaceId)
    ) {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} belongs to another tenant.`,
      );
    }
    const requiredLabels = this.gatewayMembershipLabels();
    const hasGatewayMembership = Object.entries(requiredLabels).every(
      ([key, value]) => labels[key] === value,
    );
    return (
      existingLabel === ownership.namespaceId &&
      existingId === ownership.namespaceId &&
      hasGatewayMembership
    );
  }

  private async verifyUniqueExistingNamespace(name: string, ownership: Ownership): Promise<void> {
    const clients = await this.clients();
    const observed = await this.request(() =>
      clients.core.listNamespace({
        labelSelector: `openclaw.dev/namespace=${ownership.namespaceId}`,
        timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
      }),
    );
    if (
      !Array.isArray(observed?.items) ||
      observed.items.length > 1 ||
      (observed.items.length === 1 && observed.items[0]?.metadata?.name !== name)
    ) {
      throw new OwnershipFailure(
        `Another Kubernetes namespace already claims tenant ${ownership.namespaceId}.`,
      );
    }
  }

  private async claimExistingNamespace(
    namespace: ManagedKubernetesObject<"Namespace">,
    ownership: Ownership,
  ): Promise<void> {
    if (this.verifyAdoptableNamespace(namespace, ownership)) return;
    const resourceVersion = namespace.metadata.resourceVersion;
    if (typeof resourceVersion !== "string" || resourceVersion.length === 0) {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} requires a resource version.`,
      );
    }
    const clients = await this.clients();
    try {
      await this.request(
        () =>
          clients.core.patchNamespace(
            {
              name: namespace.metadata.name,
              body: {
                apiVersion: "v1",
                kind: "Namespace",
                metadata: {
                  name: namespace.metadata.name,
                  resourceVersion,
                  labels: {
                    "openclaw.dev/namespace": ownership.namespaceId,
                    ...this.gatewayMembershipLabels(),
                  },
                  annotations: { "openclaw.dev/namespace-id": ownership.namespaceId },
                },
              },
              fieldManager: FIELD_MANAGER,
              force: false,
            },
            this.patchOptions,
          ),
        { mutating: true },
      );
    } catch (error) {
      if (numericErrorStatus(error) !== 409) throw error;
      const current = await this.get("Namespace", namespace.metadata.name);
      if (current === undefined) {
        throw new OwnershipFailure(
          `Existing Kubernetes namespace ${namespace.metadata.name} does not exist.`,
        );
      }
      if (!this.verifyAdoptableNamespace(current, ownership)) throw error;
    }
    const current = await this.get("Namespace", namespace.metadata.name);
    if (current === undefined) {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} does not exist.`,
      );
    }
    this.verifyNamespaceOwnership(current, ownership, true);
  }

  private async verifyExistingNetworkPolicies(
    namespace: string,
    ownership: Ownership,
  ): Promise<void> {
    const clients = await this.clients();
    const observed = asRecord(
      await this.request(() =>
        clients.networking.listNamespacedNetworkPolicy({
          namespace,
          timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        }),
      ),
    );
    if (!Array.isArray(observed?.items)) {
      throw new OwnershipFailure(
        `The existing Kubernetes namespace ${namespace} returned invalid NetworkPolicies.`,
      );
    }
    for (const item of observed.items) {
      const policy = asRecord(item);
      const metadata = asRecord(policy?.metadata);
      if (
        policy === undefined ||
        metadata === undefined ||
        typeof metadata.name !== "string" ||
        metadata.name.length === 0 ||
        metadata.namespace !== namespace ||
        (policy.kind !== undefined && policy.kind !== "NetworkPolicy")
      ) {
        throw new OwnershipFailure(
          `The existing Kubernetes namespace ${namespace} returned an invalid NetworkPolicy.`,
        );
      }
      this.verifyOwnership(
        {
          ...policy,
          apiVersion: typeof policy.apiVersion === "string" ? policy.apiVersion : "v1",
          kind: "NetworkPolicy",
          metadata: { ...metadata, name: metadata.name },
        } as ManagedKubernetesObject<"NetworkPolicy">,
        ownership,
      );
    }
  }

  private async deleteOwnedNamespaceResources(
    namespace: string,
    ownership: Ownership,
  ): Promise<boolean> {
    const clients = await this.clients();
    const infrastructure = [
      ["ResourceQuota", "openclaw-quota"],
      ["LimitRange", "openclaw-limits"],
      ["NetworkPolicy", "allow-dns"],
      ["NetworkPolicy", "allow-gateway-ingress"],
      ["NetworkPolicy", "default-deny"],
    ] as const;
    const resources: ManagedKubernetesObject<"ResourceQuota" | "LimitRange" | "NetworkPolicy">[] =
      [];
    for (const [kind, name] of infrastructure) {
      const existing = await this.getOwned(kind, name, namespace, ownership);
      if (existing !== undefined) resources.push(existing);
    }

    for (const resource of resources) {
      const request = {
        name: resource.metadata.name,
        namespace,
        ...(resource.metadata.uid === undefined
          ? {}
          : { body: { preconditions: { uid: resource.metadata.uid } } }),
      };
      try {
        await this.request(
          async () => {
            if (resource.kind === "ResourceQuota") {
              await clients.core.deleteNamespacedResourceQuota(request);
            } else if (resource.kind === "LimitRange") {
              await clients.core.deleteNamespacedLimitRange(request);
            } else {
              await clients.networking.deleteNamespacedNetworkPolicy(request);
            }
          },
          { mutating: true },
        );
      } catch (error) {
        if (numericErrorStatus(error) !== 404) throw error;
      }
      const remaining = await this.getOwned(
        resource.kind,
        resource.metadata.name,
        namespace,
        ownership,
      );
      if (remaining !== undefined) return false;
    }
    return true;
  }

  private async clients(): Promise<KubernetesApiClients> {
    if (this.apiClients === undefined) this.apiClients = this.createClients();
    return this.apiClients;
  }

  private async createClients(): Promise<KubernetesApiClients> {
    const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
      this.options.authentication,
      (message) => new ConfigurationFailure(message),
    );
    this.patchOptions = sdk.setHeaderOptions("Content-Type", APPLY_CONTENT_TYPE);
    return {
      core: new sdk.CoreV1Api(clientConfiguration),
      apps: new sdk.AppsV1Api(clientConfiguration),
      discovery: new sdk.DiscoveryV1Api(clientConfiguration),
      networking: new sdk.NetworkingV1Api(clientConfiguration),
      objects: new sdk.KubernetesObjectApi(clientConfiguration),
    };
  }

  private async request<T>(
    operation: () => Promise<T>,
    options: { readonly mutating?: boolean } = {},
  ): Promise<T> {
    const ownerSignal = currentComputeAbortSignal();
    for (let attempt = 1; ; attempt += 1) {
      ownerSignal?.throwIfAborted();
      const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal =
        ownerSignal === undefined ? deadline : AbortSignal.any([ownerSignal, deadline]);
      try {
        return await withComputeAbortSignal(signal, operation);
      } catch (error) {
        if (ownerSignal?.aborted) throw ownerSignal.reason;
        if (deadline.aborted) throw new Error("Kubernetes API request timed out.");
        const status = numericErrorStatus(error);
        const retryable =
          status === 429 ||
          (status !== undefined && status >= 500) ||
          (status === undefined &&
            !(error instanceof ConfigurationFailure) &&
            !(error instanceof OwnershipFailure));
        if (!retryable || options.mutating === true || attempt >= 3) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 25));
      }
    }
  }

  private operationSignal(): AbortSignal {
    return currentComputeAbortSignal() ?? new AbortController().signal;
  }

  private sandboxNamespaceContext(
    namespace: Readonly<Namespace>,
    namespaceName: string,
  ): Promise<SandboxNamespaceContext> {
    return this.clients().then(({ objects: kubernetes }) => ({
      namespace: { ...namespace, name: namespaceName },
      kubernetes,
      signal: this.operationSignal(),
    }));
  }

  private sandboxNamespaceForRevision(revision: AgentRevision, namespaceName: string): Namespace {
    return {
      id: revision.namespaceId,
      name: namespaceName,
      status: "ready",
      createdAt: revision.createdAt,
    };
  }

  private sandboxDriverForRevision(revision: AgentRevision): SandboxDriver | undefined {
    if (revision.sandboxDriverId === undefined) return undefined;
    const driver = this.sandboxDriver;
    if (driver === undefined) {
      throw new ConfigurationFailure("AgentRevision requires an unavailable SandboxDriver.");
    }
    if (revision.sandboxDriverId !== driver.id) {
      throw new ConfigurationFailure("AgentRevision is pinned to another SandboxDriver.");
    }
    return driver;
  }

  private verifySandboxResourceRef(
    sandbox: SandboxResourceRef,
    revision: AgentRevision,
    namespace: string,
  ): void {
    if (
      sandbox.namespaceName !== namespace ||
      sandbox.agentId !== revision.agentId ||
      sandbox.revisionId !== revision.id ||
      typeof sandbox.resourceName !== "string" ||
      sandbox.resourceName.trim().length === 0
    ) {
      throw new OwnershipFailure("SandboxDriver returned an ambiguous Sandbox identity.");
    }
  }

  private async providerHarnessReady(
    revision: AgentRevision,
    namespace: string,
    labels: Readonly<Record<string, string>>,
  ): Promise<boolean> {
    const clients = await this.clients();
    const pods = asRecord(
      await this.request(() =>
        clients.core.listNamespacedPod({
          namespace,
          // Observe every Pod the active Agent Service could route to, even if an
          // additional provider requirement label is missing or contradictory.
          labelSelector: labelsToSelector({
            "openclaw.dev/agent": revision.agentId,
            "openclaw.dev/revision": revision.id,
            "openclaw.dev/workload-role": "agent",
          }),
          timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        }),
      ),
    );
    currentComputeAbortSignal()?.throwIfAborted();
    const invalidObservation = () =>
      new Error(
        "The Kubernetes client returned an invalid or incomplete provider Harness Pod list.",
      );
    const listMetadata = asRecord(pods?.metadata);
    if (
      !Array.isArray(pods?.items) ||
      (pods.apiVersion !== undefined && pods.apiVersion !== "v1") ||
      (pods.kind !== undefined && pods.kind !== "PodList") ||
      (pods.metadata !== undefined && listMetadata === undefined) ||
      (listMetadata?.continue !== undefined && listMetadata.continue !== "") ||
      (listMetadata?._continue !== undefined && listMetadata._continue !== "") ||
      (listMetadata?.remainingItemCount !== undefined && listMetadata.remainingItemCount !== 0)
    ) {
      throw invalidObservation();
    }
    let candidates = 0;
    let candidateReady = false;
    // Validate the whole observation before trusting uniqueness, including entries after a Ready Pod.
    for (const item of pods.items) {
      const pod = asRecord(item);
      const metadata = asRecord(pod?.metadata);
      const podLabels = asRecord(metadata?.labels);
      const status = asRecord(pod?.status);
      if (
        pod === undefined ||
        (pod.apiVersion !== undefined && pod.apiVersion !== "v1") ||
        (pod.kind !== undefined && pod.kind !== "Pod") ||
        metadata === undefined ||
        !isNonEmptyString(metadata.name) ||
        !isNonEmptyString(metadata.namespace) ||
        (metadata.labels !== undefined && podLabels === undefined) ||
        Object.values(podLabels ?? {}).some((value) => typeof value !== "string") ||
        (pod.status !== undefined && status === undefined) ||
        (status?.conditions !== undefined && !Array.isArray(status.conditions))
      ) {
        throw invalidObservation();
      }
      const deletedAt = metadata.deletionTimestamp;
      if (
        deletedAt !== undefined &&
        !(
          (deletedAt instanceof Date && Number.isFinite(deletedAt.getTime())) ||
          (typeof deletedAt === "string" &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
              deletedAt,
            ) &&
            Number.isFinite(Date.parse(deletedAt)))
        )
      ) {
        throw invalidObservation();
      }
      const conditionTypes = new Set<string>();
      let ready = false;
      for (const condition of (status?.conditions ?? []) as unknown[]) {
        const observed = asRecord(condition);
        if (
          observed === undefined ||
          !isNonEmptyString(observed.type) ||
          typeof observed.status !== "string" ||
          !["True", "False", "Unknown"].includes(observed.status) ||
          conditionTypes.has(observed.type)
        ) {
          throw invalidObservation();
        }
        conditionTypes.add(observed.type);
        if (observed.type === "Ready") ready = observed.status === "True";
      }
      if (
        metadata.namespace !== namespace ||
        deletedAt !== undefined ||
        podLabels?.["openclaw.dev/agent"] !== revision.agentId ||
        podLabels?.["openclaw.dev/revision"] !== revision.id ||
        podLabels?.["openclaw.dev/workload-role"] !== "agent"
      ) {
        continue;
      }
      if (Object.entries(labels).some(([key, value]) => podLabels?.[key] !== value)) {
        throw invalidObservation();
      }
      candidates += 1;
      candidateReady = ready;
    }
    return candidates === 1 && candidateReady;
  }

  private harnessRequirementsFromDeployment(
    deployment: ManagedKubernetesObject,
  ): HarnessWorkloadRequirements {
    const template = asRecord(deployment.spec?.template);
    const metadata = asRecord(template?.metadata);
    const labels = asRecord(metadata?.labels);
    const spec = asRecord(template?.spec);
    const serviceAccountName = required(spec?.serviceAccountName, "Harness ServiceAccount");
    const containers = Array.isArray(spec?.containers) ? spec.containers : [];
    if (containers.length !== 1) {
      throw new ConfigurationFailure("Dedicated Harness requires one workload container.");
    }
    const container = asRecord(containers[0]);
    const image = required(container?.image, "Harness image");
    const command = [
      ...(Array.isArray(container?.command) ? container.command : []),
      ...(Array.isArray(container?.args) ? container.args : []),
    ];
    if (command.some((entry) => typeof entry !== "string") || command.length === 0) {
      throw new ConfigurationFailure("Dedicated Harness command must be explicit.");
    }
    const environment = this.sandboxEnvironmentVariables(container?.env);
    const workspaceMounts = this.sandboxWorkspaceMounts(spec?.volumes, container?.volumeMounts);
    const serviceAccountToken = this.sandboxServiceAccountToken(
      spec?.volumes,
      container?.volumeMounts,
    );
    const harnessLabels = Object.fromEntries(
      Object.entries(labels ?? {}).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
    if (
      harnessLabels["openclaw.dev/workload-role"] !== "agent" ||
      typeof harnessLabels["openclaw.dev/agent"] !== "string" ||
      typeof harnessLabels["openclaw.dev/revision"] !== "string"
    ) {
      throw new ConfigurationFailure("Dedicated Harness labels must include exact revision scope.");
    }
    return {
      image,
      command: command as readonly string[],
      serviceAccountName,
      serviceAccountToken,
      workspaceMounts,
      environment,
      labels: harnessLabels,
    };
  }

  private sandboxEnvironmentVariables(value: unknown): readonly SandboxEnvironmentVariable[] {
    const variables = Array.isArray(value) ? value : [];
    return variables.map((item) => {
      const variable = asRecord(item);
      const name = required(variable?.name, "Harness environment variable name");
      if (typeof variable?.value === "string") return { name, value: variable.value };
      const secretKeyRef = asRecord(asRecord(variable?.valueFrom)?.secretKeyRef);
      if (
        typeof secretKeyRef?.name === "string" &&
        secretKeyRef.name.trim().length > 0 &&
        typeof secretKeyRef.key === "string" &&
        secretKeyRef.key.trim().length > 0
      ) {
        return {
          name,
          valueFrom: { secretKeyRef: { name: secretKeyRef.name, key: secretKeyRef.key } },
        };
      }
      throw new ConfigurationFailure(
        `Harness environment variable ${name} must be a literal or SecretKeyRef.`,
      );
    });
  }

  private sandboxServiceAccountToken(
    volumes: unknown,
    volumeMounts: unknown,
  ): HarnessWorkloadRequirements["serviceAccountToken"] {
    const configured = this.options.servicePrincipalCredentials;
    if (configured.mode !== "projectedServiceAccountToken") {
      throw new ConfigurationFailure(
        "Provider-owned Harness requires a projected ServicePrincipal token.",
      );
    }
    const observedVolumes = Array.isArray(volumes) ? volumes : [];
    const tokenVolumes = observedVolumes.filter(
      (item) => asRecord(item)?.name === "openclaw-service-principal",
    );
    if (tokenVolumes.length !== 1) {
      throw new ConfigurationFailure(
        "Provider-owned Harness requires exactly one projected ServicePrincipal token volume.",
      );
    }
    const sources = asRecord(asRecord(tokenVolumes[0])?.projected)?.sources;
    if (!Array.isArray(sources) || sources.length !== 1) {
      throw new ConfigurationFailure(
        "Provider-owned Harness requires exactly one projected ServicePrincipal token source.",
      );
    }
    const token = asRecord(asRecord(sources[0])?.serviceAccountToken);
    const audience = required(token?.audience, "Harness ServicePrincipal token audience");
    const expirationSeconds = token?.expirationSeconds;
    const path = required(token?.path, "Harness ServicePrincipal token path");
    if (
      audience !== configured.audience ||
      expirationSeconds !== configured.expirationSeconds ||
      typeof expirationSeconds !== "number" ||
      !Number.isSafeInteger(expirationSeconds) ||
      expirationSeconds < 600 ||
      expirationSeconds > 86_400 ||
      path !== "token"
    ) {
      throw new ConfigurationFailure(
        "Provider-owned Harness must preserve the approved ServicePrincipal token projection.",
      );
    }
    const observedMounts = Array.isArray(volumeMounts) ? volumeMounts : [];
    const tokenMounts = observedMounts.filter(
      (item) => asRecord(item)?.name === "openclaw-service-principal",
    );
    const mount = tokenMounts.length === 1 ? asRecord(tokenMounts[0]) : undefined;
    if (mount?.mountPath !== TOKEN_PATH || mount.readOnly !== true) {
      throw new ConfigurationFailure(
        "Provider-owned Harness must mount its ServicePrincipal token read-only at the approved path.",
      );
    }
    return { audience, expirationSeconds, mountPath: mount.mountPath, path, readOnly: true };
  }

  private sandboxWorkspaceMounts(
    volumes: unknown,
    volumeMounts: unknown,
  ): readonly SandboxWorkspaceMount[] {
    const observedVolumes = Array.isArray(volumes) ? volumes : [];
    const workspaceVolume = observedVolumes.find(
      (item) => asRecord(item)?.name === SHARED_WORKSPACE_VOLUME,
    );
    const claimName = required(
      asRecord(asRecord(workspaceVolume)?.persistentVolumeClaim)?.claimName,
      "Harness shared workspace claim",
    );
    const observedMounts = Array.isArray(volumeMounts) ? volumeMounts : [];
    const workspaceMounts = observedMounts
      .filter((item) => asRecord(item)?.name === SHARED_WORKSPACE_VOLUME)
      .map((item) => {
        const mount = asRecord(item);
        return {
          claimName,
          subPath: required(mount?.subPath, "Harness workspace subPath"),
          mountPath: required(mount?.mountPath, "Harness workspace mount path"),
          readOnly: mount?.readOnly === true,
        };
      });
    const expected = this.sharedWorkspaceVolumeMounts("agent");
    if (workspaceMounts.length !== expected.length) {
      throw new ConfigurationFailure("Dedicated Harness must mount every approved workspace path.");
    }
    for (const mount of expected) {
      if (
        !workspaceMounts.some(
          (observed) =>
            observed.subPath === mount.subPath &&
            observed.mountPath === mount.mountPath &&
            observed.readOnly === (mount.readOnly === true),
        )
      ) {
        throw new ConfigurationFailure(
          "Dedicated Harness workspace mounts must match the approved shared PVC paths.",
        );
      }
    }
    return workspaceMounts;
  }

  private async gatewayReady(
    ownership: Ownership,
    gatewayName: string,
    namespace: string,
  ): Promise<boolean> {
    const clients = await this.clients();
    const deployment = await this.getOwned("Deployment", gatewayName, namespace, ownership);
    if (deployment === undefined) return false;
    if (deployment.spec?.replicas !== 1) return false;
    if (!this.deploymentReady(deployment)) return false;
    const service = await this.getOwned("Service", gatewayName, namespace, ownership);
    if (service === undefined) return false;
    const slices = asRecord(
      await this.request(() =>
        clients.discovery.listNamespacedEndpointSlice({
          namespace,
          labelSelector: `kubernetes.io/service-name=${gatewayName}`,
          timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        }),
      ),
    );
    const items = Array.isArray(slices?.items) ? slices.items : [];
    return items.some((item) => {
      const slice = asRecord(item);
      const metadata = asRecord(slice?.metadata);
      if (asRecord(metadata?.labels)?.["kubernetes.io/service-name"] !== gatewayName) return false;
      if (service.metadata.uid !== undefined) {
        const references = Array.isArray(metadata?.ownerReferences) ? metadata.ownerReferences : [];
        if (
          !references.some((reference) => {
            const owner = asRecord(reference);
            return (
              owner?.kind === "Service" &&
              owner.name === gatewayName &&
              owner.uid === service.metadata.uid
            );
          })
        )
          return false;
      }
      return (
        Array.isArray(slice?.endpoints) &&
        slice.endpoints.some(
          (endpoint: unknown) => asRecord(asRecord(endpoint)?.conditions)?.ready === true,
        )
      );
    });
  }

  private deploymentReady(deployment: ManagedKubernetesObject): boolean {
    const replicas = deployment.spec?.replicas;
    const generation = deployment.metadata.generation;
    const observed = deployment.status?.observedGeneration;
    const ready = deployment.status?.readyReplicas;
    return (
      typeof replicas === "number" &&
      replicas > 0 &&
      typeof generation === "number" &&
      typeof observed === "number" &&
      observed >= generation &&
      typeof ready === "number" &&
      ready >= replicas
    );
  }

  private ownershipMetadata(ownership: Ownership): {
    labels: Record<string, string>;
    annotations: Record<string, string>;
  } {
    const labels: Record<string, string> = {
      "app.kubernetes.io/managed-by": MANAGER,
      "openclaw.dev/namespace": ownership.namespaceId,
    };
    const annotations: Record<string, string> = {
      "openclaw.dev/namespace-id": ownership.namespaceId,
    };
    if (ownership.agentId !== undefined) {
      labels["openclaw.dev/agent"] = ownership.agentId;
      annotations["openclaw.dev/agent-id"] = ownership.agentId;
    }
    if (ownership.serviceAccountId !== undefined) {
      labels["openclaw.dev/service-account"] = ownership.serviceAccountId;
      annotations["openclaw.dev/service-account-id"] = ownership.serviceAccountId;
    }
    if (ownership.servicePrincipalId !== undefined) {
      labels["openclaw.dev/service-principal"] = ownership.servicePrincipalId;
      annotations["openclaw.dev/service-principal-id"] = ownership.servicePrincipalId;
    }
    if (ownership.revisionId !== undefined) {
      labels["openclaw.dev/revision"] = ownership.revisionId;
      annotations["openclaw.dev/revision-id"] = ownership.revisionId;
    }
    return { labels, annotations };
  }

  private verifyOwnership(
    object: ManagedKubernetesObject<ReadableResourceKind>,
    ownership: Ownership,
  ): void {
    const expected = this.ownershipMetadata(ownership);
    for (const [key, value] of Object.entries(expected.labels)) {
      if (object.metadata.labels?.[key] !== value) {
        throw new OwnershipFailure(
          `Refusing unowned Kubernetes ${object.kind} ${object.metadata.name}.`,
        );
      }
    }
    for (const [key, value] of Object.entries(expected.annotations)) {
      if (object.metadata.annotations?.[key] !== value) {
        throw new OwnershipFailure(
          `Refusing unowned Kubernetes ${object.kind} ${object.metadata.name}.`,
        );
      }
    }
  }

  private verifyNamespaceOwnership(
    namespace: ManagedKubernetesObject<"Namespace">,
    ownership: Ownership,
    external: boolean,
  ): void {
    const observed = verifiedKubernetesNamespace(namespace.metadata, ownership.namespaceId);
    if (observed.external !== external) {
      throw new OwnershipFailure(
        `Refusing changed Kubernetes Namespace ownership for ${namespace.metadata.name}.`,
      );
    }
    if (!external) this.verifyOwnership(namespace, ownership);
  }

  private manifest<Kind extends ReadableResourceKind>(
    apiVersion: string,
    kind: Kind,
    name: string,
    ownership: Ownership,
    namespace?: string,
  ): ManagedKubernetesObject<Kind> {
    return {
      apiVersion,
      kind,
      metadata: {
        name,
        ...(namespace === undefined ? {} : { namespace }),
        ...this.ownershipMetadata(ownership),
      },
    };
  }

  private peer(peer: KubernetesWorkloadPeer): V1NetworkPolicyPeer {
    return {
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": peer.namespace } },
      podSelector: { matchLabels: { ...peer.podLabels } },
    };
  }

  private networkPolicies(ownership: Ownership, namespace: string): ManagedKubernetesObject[] {
    const network = this.options.network;
    const routing = this.options.gatewayRouting;
    const gatewayIngressPeers =
      routing === undefined
        ? (network.gatewayClients ?? [])
        : [
            {
              namespace: routing.envoyNamespace,
              podLabels: {
                "gateway.envoyproxy.io/owning-gateway-namespace": routing.gatewayNamespace,
                "gateway.envoyproxy.io/owning-gateway-name": routing.gatewayName,
              },
            },
          ];
    const policy = (name: string, spec: KubernetesRecord): ManagedKubernetesObject => ({
      ...this.manifest("networking.k8s.io/v1", "NetworkPolicy", name, ownership, namespace),
      spec,
    });
    return [
      policy("default-deny", { podSelector: {}, policyTypes: ["Ingress", "Egress"] }),
      policy("allow-dns", {
        podSelector: {},
        policyTypes: ["Egress"],
        egress: [
          {
            to: [this.peer(network.dns)],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ],
      }),
      policy("allow-gateway-ingress", {
        podSelector: { matchLabels: { "openclaw.dev/workload-role": "gateway" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: gatewayIngressPeers.map((peer) => this.peer(peer)),
            ports: [{ protocol: "TCP", port: network.gatewayPort }],
          },
        ],
      }),
    ];
  }

  private gatewayConfiguration(revision: AgentRevision): GatewayConfigurationSnapshot {
    return {
      name: `gateway-${sha256Hex(revision.agentId, 12)}-rev-${sha256Hex(revision.id, 12)}`,
      revision: revision.revision,
      revisionId: revision.id,
      usesTrustedProxyAuth:
        asRecord(asRecord(revision.configuration.gateway)?.auth)?.mode === "trusted-proxy",
      annotations: {
        "openclaw.dev/configuration-id": revision.configurationId,
        "openclaw.dev/configuration-kind": revision.configurationKind,
        "openclaw.dev/configuration-generation": String(revision.configurationGeneration),
      },
      loggingLevel: admittedLoggingLevel(revision.configuration),
    };
  }

  private gatewayMembershipLabels(): Record<string, string> {
    const routing = this.options.gatewayRouting;
    if (routing === undefined) return {};
    return {
      [GATEWAY_MEMBERSHIP_LABEL]: sha256Hex(
        `${routing.gatewayNamespace}/${routing.gatewayName}`,
        12,
      ),
    };
  }

  private gatewayRouteName(agentId: string): string {
    return `gateway-${sha256Hex(agentId, 12)}`;
  }

  private gatewayRoutePath(revision: AgentRevision): string {
    return `/namespaces/${required(revision.namespaceId, "AgentRevision Namespace ID")}/agents/${required(
      revision.agentId,
      "Agent ID",
    )}`;
  }

  private gatewayRoutingHostname(routing: KubernetesGatewayRoutingOptions): string {
    if (routing.hostname !== undefined && routing.hostname.length > 0) return routing.hostname;
    return `occ-gateway-${sha256Hex(
      `${routing.gatewayNamespace}/${routing.gatewayName}`,
      12,
    )}.${routing.envoyNamespace}.svc`;
  }

  private verifyGatewayRoutingConfiguration(revision: AgentRevision): void {
    if (this.options.gatewayRouting === undefined) return;
    const gateway = asRecord(revision.configuration.gateway);
    const auth = asRecord(gateway?.auth);
    const trustedProxy = asRecord(auth?.trustedProxy);
    const trustedProxies = gateway?.trustedProxies;
    if (auth?.mode !== "trusted-proxy") {
      throw new ConfigurationFailure(
        "Gateway routing requires native trusted-proxy authentication.",
      );
    }
    if ("token" in (auth ?? {})) {
      throw new ConfigurationFailure("Gateway routing native configuration must omit auth.token.");
    }
    if (trustedProxy?.userHeader !== "x-occ-identity") {
      throw new ConfigurationFailure(
        "Gateway routing requires native trustedProxy.userHeader x-occ-identity.",
      );
    }
    if (
      !Array.isArray(trustedProxy.allowUsers) ||
      !trustedProxy.allowUsers.includes("occ-workspace-files")
    ) {
      throw new ConfigurationFailure(
        "Gateway routing requires native trustedProxy.allowUsers to include occ-workspace-files.",
      );
    }
    const identityScopes = asRecord(auth?.identityScopes);
    const workspaceFileScopes = identityScopes?.["occ-workspace-files"];
    if (!Array.isArray(workspaceFileScopes) || !workspaceFileScopes.includes("operator.admin")) {
      throw new ConfigurationFailure(
        "Gateway routing requires native identityScopes to grant operator.admin.",
      );
    }
    if (gateway?.allowRealIpFallback !== true) {
      throw new ConfigurationFailure(
        "Gateway routing requires native allowRealIpFallback to be enabled.",
      );
    }
    if (
      !Array.isArray(trustedProxies) ||
      !trustedProxies.some((proxy) => typeof proxy === "string" && proxy.trim().length > 0)
    ) {
      throw new ConfigurationFailure(
        "Gateway routing requires explicitly configured native trustedProxies.",
      );
    }
  }

  private gatewayRoute(
    revision: AgentRevision,
    ownership: Ownership,
    namespace: string,
    service: ManagedKubernetesObject<"Service">,
  ): ManagedKubernetesObject<"HTTPRoute"> | undefined {
    const routing = this.options.gatewayRouting;
    if (routing === undefined) return undefined;
    const name = this.gatewayRouteName(revision.agentId);
    const route = this.manifest(GATEWAY_API_VERSION, "HTTPRoute", name, ownership, namespace);
    return {
      ...route,
      metadata: {
        ...route.metadata,
        annotations: {
          ...route.metadata.annotations,
          [AGENT_REVISION_ANNOTATION]: String(revision.revision),
          [AGENT_REVISION_ID_ANNOTATION]: revision.id,
        },
        ...(service.metadata.uid === undefined
          ? {}
          : {
              ownerReferences: [
                {
                  apiVersion: "v1",
                  kind: "Service",
                  name: service.metadata.name,
                  uid: service.metadata.uid,
                  controller: false,
                  blockOwnerDeletion: false,
                },
              ],
            }),
      },
      spec: {
        hostnames: [this.gatewayRoutingHostname(routing)],
        parentRefs: [
          {
            group: "gateway.networking.k8s.io",
            kind: "Gateway",
            namespace: routing.gatewayNamespace,
            name: routing.gatewayName,
            sectionName: GATEWAY_LISTENER_SECTION,
          },
        ],
        rules: [
          {
            matches: [{ path: { type: "Exact", value: this.gatewayRoutePath(revision) } }],
            filters: [
              {
                type: "URLRewrite",
                urlRewrite: { path: { type: "ReplaceFullPath", replaceFullPath: "/" } },
              },
              {
                type: "RequestHeaderModifier",
                requestHeaderModifier: {
                  set: [
                    { name: "x-occ-identity", value: "occ-workspace-files" },
                    {
                      name: "x-real-ip",
                      value: "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS_WITHOUT_PORT%",
                    },
                  ],
                  remove: ["x-forwarded-for", "forwarded", "x-openclaw-scopes"],
                },
              },
            ],
            backendRefs: [
              {
                group: "",
                kind: "Service",
                name: service.metadata.name,
                port: this.options.network.gatewayPort,
              },
            ],
          },
        ],
      },
    };
  }

  private async reconcileGatewayRoute(
    revision: AgentRevision,
    ownership: Ownership,
    namespace: string,
  ): Promise<void> {
    if (this.options.gatewayRouting === undefined) return;
    const name = this.gatewayRouteName(revision.agentId);
    const service = await this.getOwned("Service", name, namespace, ownership);
    if (service === undefined) return;
    const route = this.gatewayRoute(revision, ownership, namespace, service);
    if (route !== undefined) await this.reconcile(route, ownership, namespace);
  }

  private sharedWorkspaceClaimName(agentId: string): string {
    return `workspace-${sha256Hex(agentId, 12)}`;
  }

  private gatewayPrivateStateClaimName(agentId: string): string {
    return `gateway-state-${sha256Hex(agentId, 12)}`;
  }

  private sharedWorkspaceClaim(
    agentId: string,
    ownership: Ownership,
    namespace: string,
  ): ManagedKubernetesObject<"PersistentVolumeClaim"> {
    return {
      ...this.manifest(
        "v1",
        "PersistentVolumeClaim",
        this.sharedWorkspaceClaimName(agentId),
        ownership,
        namespace,
      ),
      spec: {
        accessModes: ["ReadWriteMany"],
        resources: { requests: { storage: SHARED_WORKSPACE_SIZE } },
      },
    };
  }

  private gatewayPrivateStateClaim(
    agentId: string,
    ownership: Ownership,
    namespace: string,
  ): ManagedKubernetesObject<"PersistentVolumeClaim"> {
    return {
      ...this.manifest(
        "v1",
        "PersistentVolumeClaim",
        this.gatewayPrivateStateClaimName(agentId),
        ownership,
        namespace,
      ),
      spec: {
        accessModes: ["ReadWriteOnce"],
        volumeMode: "Filesystem",
        storageClassName: required(
          this.options.runtime?.gatewayStorageClassName,
          "SQLite-compatible gateway storage class",
        ),
        resources: { requests: { storage: GATEWAY_PRIVATE_STATE_SIZE } },
      },
    };
  }

  private verifyPersistentVolumeClaim(
    claim: ManagedKubernetesObject,
    desired: ManagedKubernetesObject,
  ): void {
    const accessModes = Array.isArray(claim.spec?.accessModes) ? claim.spec.accessModes : [];
    const expectedModes = Array.isArray(desired.spec?.accessModes) ? desired.spec.accessModes : [];
    const requests = asRecord(asRecord(claim.spec?.resources)?.requests);
    const expectedRequests = asRecord(asRecord(desired.spec?.resources)?.requests);
    if (
      claim.metadata.deletionTimestamp !== undefined ||
      accessModes.length !== expectedModes.length ||
      accessModes.some((mode, index) => mode !== expectedModes[index]) ||
      requests?.storage !== expectedRequests?.storage ||
      (claim.spec?.volumeMode ?? "Filesystem") !== (desired.spec?.volumeMode ?? "Filesystem") ||
      (desired.spec?.storageClassName !== undefined &&
        claim.spec?.storageClassName !== desired.spec.storageClassName)
    ) {
      throw new OwnershipFailure(`Refusing invalid PersistentVolumeClaim ${claim.metadata.name}.`);
    }
  }

  private sharedWorkspaceVolumeMounts(role: SharedWorkspaceRole): V1VolumeMount[] {
    const isGateway = role === "gateway";
    return SHARED_WORKSPACE_CATEGORIES.map(
      ([subPath, gatewayMountPath, gatewayReadOnly, agentMountPath, agentReadOnly]) => ({
        name: SHARED_WORKSPACE_VOLUME,
        mountPath: isGateway ? gatewayMountPath : agentMountPath,
        subPath,
        readOnly: isGateway ? gatewayReadOnly : agentReadOnly,
      }),
    );
  }

  private gatewayPrivateStateVolumeMounts(embedded: boolean): V1VolumeMount[] {
    const mounts: V1VolumeMount[] = GATEWAY_PRIVATE_STATE_CATEGORIES.map(
      ([subPath, mountPath]) => ({
        name: GATEWAY_PRIVATE_STATE_VOLUME,
        mountPath,
        subPath,
        readOnly: false,
      }),
    );
    if (embedded) {
      // Retain the workspace attested by gateway SQLite so continued turns do not fail as vanished.
      mounts.push({
        name: GATEWAY_PRIVATE_STATE_VOLUME,
        mountPath: "/home/node/.openclaw/workspace",
        subPath: "workspace",
        readOnly: false,
      });
    }
    return mounts;
  }

  private privateStateDirectories(role: SharedWorkspaceRole): string[] {
    const isGateway = role === "gateway";
    const directories = new Set(isGateway ? ["/home/node/.openclaw"] : []);
    for (const [, gatewayMountPath, , agentMountPath] of SHARED_WORKSPACE_CATEGORIES) {
      const path = isGateway ? gatewayMountPath : agentMountPath;
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent !== "/home/node") directories.add(parent);
    }
    return [...directories];
  }

  private privateStateInitContainer(
    role: SharedWorkspaceRole,
    image: string,
    embedded: boolean,
  ): KubernetesRecord {
    const directories = this.privateStateDirectories(role);
    const volumeMounts: V1VolumeMount[] = [{ name: "runtime-state", mountPath: "/home/node" }];
    if (role === "gateway" && this.options.runtime !== undefined) {
      // Initialize whole directories as uid 1000 before mounting SQLite and its WAL files.
      volumeMounts.push({ name: GATEWAY_PRIVATE_STATE_VOLUME, mountPath: "/gateway-state" });
      directories.push(
        ...GATEWAY_PRIVATE_STATE_CATEGORIES.map(([subPath]) => `/gateway-state/${subPath}`),
        "/home/node/gateway-codex-home",
      );
      if (embedded) directories.push("/gateway-state/workspace");
    }
    const script = [
      'const { mkdirSync } = require("node:fs");',
      `for (const path of ${JSON.stringify(directories)}) {`,
      "  mkdirSync(path, { recursive: true });",
      "}",
    ].join("\n");
    return {
      name: "prepare-private-state",
      image,
      imagePullPolicy: "IfNotPresent",
      command: ["node", "-e"],
      args: [script],
      volumeMounts,
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      },
    };
  }

  private async deleteSharedWorkspaceClaim(ownership: Ownership, namespace: string): Promise<void> {
    const agentId = required(ownership.agentId, "Shared workspace Agent ID");
    await this.deletePersistentVolumeClaim(
      this.sharedWorkspaceClaim(agentId, ownership, namespace),
      ownership,
      namespace,
    );
  }

  private async deleteGatewayPrivateStateClaim(
    ownership: Ownership,
    namespace: string,
  ): Promise<void> {
    const agentId = required(ownership.agentId, "Gateway private state Agent ID");
    await this.deletePersistentVolumeClaim(
      this.gatewayPrivateStateClaim(agentId, ownership, namespace),
      ownership,
      namespace,
    );
  }

  private async deletePersistentVolumeClaim(
    desired: ManagedKubernetesObject<"PersistentVolumeClaim">,
    ownership: Ownership,
    namespace: string,
  ): Promise<void> {
    const name = desired.metadata.name;
    const existing = await this.getOwned("PersistentVolumeClaim", name, namespace, ownership);
    if (existing === undefined || existing.metadata.deletionTimestamp !== undefined) return;
    this.verifyPersistentVolumeClaim(existing, desired);
    const uid = required(existing.metadata.uid, "PersistentVolumeClaim UID");
    const clients = await this.clients();
    await this.request(
      () =>
        clients.core.deleteNamespacedPersistentVolumeClaim({
          name,
          namespace,
          body: { preconditions: { uid } },
        }),
      { mutating: true },
    );
  }

  private agentAuthenticationNetworkPolicy(
    revision: AgentRevision,
    namespace: string,
  ): ManagedKubernetesObject {
    const runtime = this.agentNetworkPolicies(revision, namespace).find(
      ({ metadata }) => metadata.name === `allow-agent-runtime-${sha256Hex(revision.agentId, 12)}`,
    );
    const egress = runtime?.spec?.egress;
    if (!Array.isArray(egress) || egress.length === 0) {
      throw new ConfigurationFailure(
        "Agent authentication requires an approved model egress policy.",
      );
    }
    const ownership = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
    };
    return {
      ...this.manifest(
        "networking.k8s.io/v1",
        "NetworkPolicy",
        `allow-agent-auth-${sha256Hex(revision.agentId, 12)}`,
        ownership,
        namespace,
      ),
      spec: {
        podSelector: {
          matchLabels: {
            "openclaw.dev/workload-role": "agent",
            "openclaw.dev/agent": revision.agentId,
            "openclaw.dev/revision": revision.id,
          },
        },
        policyTypes: ["Egress"],
        egress,
      },
    };
  }

  private enabledChannels(revision: AgentRevision): readonly ChannelRequirements[] {
    const configured = asRecord(asRecord(revision.configuration)?.channels);
    if (configured === undefined) return [];
    const enabled: ChannelRequirements[] = [];
    for (const [provider, configuration] of Object.entries(configured)) {
      if (["defaults", "modelByChannel"].includes(provider)) continue;
      if (asRecord(configuration)?.enabled === false) continue;
      if (!Object.hasOwn(CHANNEL_REQUIREMENTS, provider)) {
        throw new ConfigurationFailure(`Unsupported OpenClaw channel provider "${provider}".`);
      }
      enabled.push(CHANNEL_REQUIREMENTS[provider as keyof typeof CHANNEL_REQUIREMENTS]);
    }
    if (enabled.length === 0) return enabled;
    if (revision.harness.mode === "embedded") {
      throw new ConfigurationFailure("Configured channels require a dedicated Agent workload.");
    }
    if (this.options.runtime?.channels === undefined) {
      throw new ConfigurationFailure(
        "Enabled channel configuration requires isolated credentials and a reviewed proxy.",
      );
    }
    return enabled;
  }

  private channelNetworkPolicy(
    revision: AgentRevision,
    enabled: readonly ChannelRequirements[],
    namespace: string,
  ): ManagedKubernetesObject {
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const proxy = enabled.some(({ egress }) => egress === "https-proxy")
      ? channelProxy(this.options.runtime?.channels?.proxyUrl)
      : undefined;
    return {
      ...this.manifest(
        "networking.k8s.io/v1",
        "NetworkPolicy",
        `allow-gateway-channels-${sha256Hex(revision.agentId, 12)}`,
        ownership,
        namespace,
      ),
      spec: {
        podSelector: {
          matchLabels: {
            "openclaw.dev/workload-role": "gateway",
            "openclaw.dev/agent": revision.agentId,
          },
        },
        policyTypes: ["Egress"],
        egress:
          proxy !== undefined
            ? [
                {
                  to: [
                    {
                      ipBlock: { cidr: `${proxy.address}/${isIP(proxy.address) === 4 ? 32 : 128}` },
                    },
                  ],
                  ports: [{ protocol: "TCP", port: proxy.port }],
                },
              ]
            : [],
      },
    };
  }

  private async reconcileChannelNetworkPolicy(
    revision: AgentRevision,
    enabled: readonly ChannelRequirements[],
    namespace: string,
  ): Promise<void> {
    const policy = this.channelNetworkPolicy(revision, enabled, namespace);
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    if (this.options.runtime?.channels === undefined) {
      const existing = await this.getOwned(
        "NetworkPolicy",
        policy.metadata.name,
        namespace,
        ownership,
      );
      if (existing === undefined) return;
    }
    await this.reconcile(policy, ownership, namespace);
  }

  private agentNetworkPolicies(
    revision: AgentRevision,
    namespace: string,
  ): ManagedKubernetesObject[] {
    const runtime = this.options.runtime;
    if (runtime === undefined) return [];
    const suffix = sha256Hex(revision.agentId, 12);
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const agent = {
      matchLabels: {
        "openclaw.dev/workload-role": "agent",
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
      },
    };
    const gateway = {
      matchLabels: {
        "openclaw.dev/workload-role": "gateway",
        "openclaw.dev/agent": revision.agentId,
      },
    };
    const policy = (name: string, spec: KubernetesRecord): ManagedKubernetesObject => ({
      ...this.manifest(
        "networking.k8s.io/v1",
        "NetworkPolicy",
        `${name}-${suffix}`,
        ownership,
        namespace,
      ),
      spec,
    });
    // TODO(model-egress-proxy): Replace public TCP/443 with the approved per-Agent model proxy.
    const modelEgress = [
      {
        to: [
          {
            ipBlock: {
              cidr: "0.0.0.0/0",
              except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"],
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 443 }],
      },
    ];
    if (revision.harness.mode === "embedded") {
      return [
        policy("allow-agent-runtime", {
          podSelector: gateway,
          policyTypes: ["Egress"],
          egress: modelEgress,
        }),
      ];
    }
    const transport = [{ protocol: "TCP", port: AGENT_TRANSPORT_PORT }];
    return [
      policy("allow-gateway-agent", {
        podSelector: gateway,
        policyTypes: ["Egress"],
        egress: [{ to: [{ podSelector: agent }], ports: transport }],
      }),
      policy("allow-agent-runtime", {
        podSelector: agent,
        policyTypes: ["Ingress", "Egress"],
        ingress: [{ from: [{ podSelector: gateway }], ports: transport }],
        egress: modelEgress,
      }),
    ];
  }

  private secretEnvironmentForRevision(
    revision: AgentRevision,
    context: ComputeRevisionContext | undefined,
    namespace: string,
  ): readonly SecretEnvironmentProjection[] {
    let bindings: ReturnType<typeof normalizeSecretBindings>;
    try {
      bindings = normalizeSecretBindings(revision.secretBindings);
    } catch {
      throw new ConfigurationFailure("AgentRevision Secret bindings are invalid.");
    }
    const destinations = new Set(Object.keys(bindings));
    const projected = context?.secretEnvironment ?? [];
    if (destinations.size === 0) {
      if (projected.length > 0) {
        throw new ConfigurationFailure(
          "Secret delivery context has no matching AgentRevision binding.",
        );
      }
      return [];
    }
    if (
      typeof revision.secretDriverId !== "string" ||
      revision.secretDriverId.trim().length === 0
    ) {
      throw new ConfigurationFailure("AgentRevision Secret Driver selection is missing.");
    }
    if (revision.harness.mode !== "embedded" && destinations.has(MODEL_API_KEY)) {
      throw new ConfigurationFailure(
        "Dedicated Codex runtimes cannot bind gateway model credentials.",
      );
    }
    if (projected.length !== destinations.size) {
      throw new ConfigurationFailure(
        "Secret delivery context does not match AgentRevision bindings.",
      );
    }
    const seen = new Set<string>();
    for (const projection of projected) {
      const binding = bindings[projection.name];
      if (
        binding === undefined ||
        seen.has(projection.name) ||
        projection.secretId !== binding.source.id ||
        projection.namespaceId !== binding.source.namespaceId ||
        projection.namespaceId !== revision.namespaceId ||
        projection.agentId !== revision.agentId ||
        projection.backendRef.namespaceName !== namespace ||
        projection.backendRef.name.trim().length === 0 ||
        projection.backendRef.key.trim().length === 0 ||
        projection.backendRef.uid.trim().length === 0
      ) {
        throw new ConfigurationFailure(
          "Secret delivery context does not match AgentRevision bindings.",
        );
      }
      seen.add(projection.name);
    }
    return Object.freeze([...projected]);
  }

  private deployment(
    name: string,
    ownership: Ownership,
    namespace: string,
    image: string,
    serviceAccountName: string,
    role: "gateway" | "agent",
    environment: Readonly<Record<string, string>>,
    loggingLevel: LoggingLevel,
    configuration?: GatewayConfigurationSnapshot,
    embedded = false,
    workloadServicePrincipalId?: string,
    serviceAccount?: AgentRevision["serviceAccount"],
    enabledChannels: readonly ChannelRequirements[] = [],
    secretEnvironment: readonly SecretEnvironmentProjection[] = [],
  ): ManagedKubernetesObject {
    const metadata = this.ownershipMetadata(ownership);
    const workloadMetadata =
      workloadServicePrincipalId === undefined
        ? metadata
        : this.ownershipMetadata({ ...ownership, servicePrincipalId: workloadServicePrincipalId });
    const configurationAnnotations =
      role === "gateway" && configuration !== undefined
        ? {
            ...configuration.annotations,
            [AGENT_REVISION_ANNOTATION]: String(configuration.revision),
            [AGENT_REVISION_ID_ANNOTATION]: configuration.revisionId,
          }
        : {};
    const revisionLabels =
      role === "gateway" && configuration !== undefined
        ? { "openclaw.dev/revision": configuration.revisionId }
        : {};
    const deployment = this.manifest("apps/v1", "Deployment", name, ownership, namespace);
    const selector = { "app.kubernetes.io/name": name };
    const projected =
      (role === "agent" || embedded) &&
      this.options.servicePrincipalCredentials.mode === "projectedServiceAccountToken"
        ? this.options.servicePrincipalCredentials
        : undefined;
    const runtime = this.options.runtime;
    const dedicated = !embedded;
    const privateHome = runtime !== undefined || dedicated;
    const volumes: V1Volume[] = [];
    const volumeMounts: V1VolumeMount[] = [];
    const variables: V1EnvVar[] = [];
    const initContainers = privateHome
      ? [this.privateStateInitContainer(role, image, embedded)]
      : [];
    if (configuration !== undefined) {
      volumes.push({
        name: CONFIGURATION_VOLUME,
        configMap: {
          name: configuration.name,
          items: [{ key: CONFIGURATION_DOCUMENT, path: CONFIGURATION_DOCUMENT }],
          optional: false,
        },
      });
      volumeMounts.push({
        name: CONFIGURATION_VOLUME,
        mountPath: CONFIGURATION_DIRECTORY,
        readOnly: true,
      });
      variables.push({
        name: "OPENCLAW_CONFIG_PATH",
        value: `${CONFIGURATION_DIRECTORY}/${CONFIGURATION_DOCUMENT}`,
      });
    }
    if (projected !== undefined) {
      volumes.push({
        name: "openclaw-service-principal",
        projected: {
          sources: [
            {
              serviceAccountToken: {
                audience: projected.audience,
                expirationSeconds: projected.expirationSeconds,
                path: "token",
              },
            },
          ],
        },
      });
      volumeMounts.push({
        name: "openclaw-service-principal",
        mountPath: TOKEN_PATH,
        readOnly: true,
      });
    }
    if (role === "agent" || embedded) {
      variables.push(...Object.entries(environment).map(([name, value]) => ({ name, value })));
    }
    if (role === "agent") {
      variables.push(
        { name: "LOG_FORMAT", value: "json" },
        { name: "RUST_LOG", value: `${loggingLevel},codex_otel=off` },
      );
    }
    if (secretEnvironment.length > 0) {
      if (role !== "gateway") {
        throw new ConfigurationFailure("Secret bindings can only be delivered to Agent gateways.");
      }
      variables.push(
        ...secretEnvironment.map(({ name, backendRef }) => ({
          name,
          valueFrom: {
            secretKeyRef: { name: backendRef.name, key: backendRef.key, optional: false },
          },
        })),
      );
    }
    if (privateHome) {
      volumes.push(
        { name: "runtime-state", emptyDir: { sizeLimit: RUNTIME_STATE_VOLUME_SIZE } },
        { name: "runtime-temporary", emptyDir: { sizeLimit: "64Mi" } },
      );
      volumeMounts.push(
        { name: "runtime-state", mountPath: "/home/node" },
        { name: "runtime-temporary", mountPath: "/tmp" },
      );
    }
    if (dedicated) {
      const agentId = required(ownership.agentId, "Shared workspace Agent ID");
      volumes.push({
        name: SHARED_WORKSPACE_VOLUME,
        persistentVolumeClaim: { claimName: this.sharedWorkspaceClaimName(agentId) },
      });
      volumeMounts.push(...this.sharedWorkspaceVolumeMounts(role));
      if (role === "gateway") {
        variables.push({ name: "OPENCLAW_WORKSPACE_DIR", value: "/home/node/workspace" });
      }
    }
    if (role === "gateway" && runtime !== undefined) {
      const agentId = required(ownership.agentId, "Gateway private state Agent ID");
      volumes.push({
        name: GATEWAY_PRIVATE_STATE_VOLUME,
        persistentVolumeClaim: { claimName: this.gatewayPrivateStateClaimName(agentId) },
      });
      volumeMounts.push(...this.gatewayPrivateStateVolumeMounts(embedded), {
        name: "runtime-state",
        mountPath: "/home/node/.openclaw/agents/main/agent/codex-home",
        subPath: "gateway-codex-home",
      });
    }
    if (runtime !== undefined) {
      const agentId = required(ownership.agentId, "Runtime Agent ID");
      const suffix = sha256Hex(agentId, 12);
      const secret = (variable: string, prefix: string, key: string): V1EnvVar => ({
        name: variable,
        valueFrom: { secretKeyRef: { name: `${prefix}-${suffix}`, key } },
      });
      if (!embedded) {
        variables.push(
          secret("APP_SERVER_TOKEN", runtime.transportSecretPrefix, AGENT_TRANSPORT_TOKEN_KEY),
        );
      }
      if (role === "gateway") {
        if (embedded) {
          // TODO(model-credential-broker): Replace direct per-Agent API keys with brokered credentials.
          if (!secretEnvironment.some(({ name }) => name === MODEL_API_KEY)) {
            variables.push(secret(MODEL_API_KEY, runtime.modelSecretPrefix, MODEL_API_KEY));
          }
          variables.push({
            name: "HOME",
            value: "/home/node",
          });
        } else {
          // TODO(workload-transport-mtls): Replace per-Agent capability-token ws:// with mTLS.
          variables.push({
            name: "APP_SERVER_URL",
            value: `ws://agent-${suffix}:${AGENT_TRANSPORT_PORT}`,
          });
        }
        // Native trusted-proxy authentication rejects a simultaneously configured shared token.
        if (configuration?.usesTrustedProxyAuth !== true) {
          variables.push(
            secret("OPENCLAW_GATEWAY_TOKEN", runtime.transportSecretPrefix, GATEWAY_TOKEN_KEY),
          );
        }
        variables.push(
          { name: "OPENCLAW_STATE_DIR", value: "/home/node/.openclaw" },
          { name: "OPENCLAW_GATEWAY_PORT", value: String(this.options.network.gatewayPort) },
        );
        if (enabledChannels.length > 0) {
          const channels = runtime.channels;
          if (channels === undefined) {
            throw new ConfigurationFailure("Gateway channel credentials are not configured.");
          }
          variables.push(
            ...Array.from(
              new Set(enabledChannels.flatMap(({ secrets }): readonly string[] => secrets)),
              (key) => secret(key, channels.secretPrefix, key),
            ),
            { name: "HTTPS_PROXY", value: channels.proxyUrl },
          );
        }
      } else {
        if (serviceAccount?.credential.kind === "access_token") {
          const reference = serviceAccount.credential.secretRef;
          variables.push(
            {
              name: CODEX_ACCESS_TOKEN,
              valueFrom: { secretKeyRef: { name: reference.name, key: reference.key } },
            },
            {
              name: CODEX_CHATGPT_WORKSPACE_ID,
              valueFrom: {
                secretKeyRef: { name: reference.name, key: SERVICE_ACCOUNT_WORKSPACE_KEY },
              },
            },
          );
        } else {
          // TODO(model-credential-broker): Replace direct per-Agent API keys with brokered credentials.
          variables.push(secret(MODEL_API_KEY, runtime.modelSecretPrefix, MODEL_API_KEY));
        }
        variables.push(
          { name: "CODEX_HOME", value: "/home/node/.codex" },
          { name: "HOME", value: "/home/node" },
          {
            name: "PATH",
            value:
              "/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          },
          { name: "APP_SERVER_PORT", value: String(AGENT_TRANSPORT_PORT) },
        );
      }
    }
    const names = new Set<string>();
    for (const variable of variables) {
      if (names.has(variable.name)) {
        throw new ConfigurationFailure(
          `Workload environment variable ${variable.name} is duplicated.`,
        );
      }
      names.add(variable.name);
    }
    const port =
      role === "agent" && runtime !== undefined
        ? AGENT_TRANSPORT_PORT
        : this.options.network.gatewayPort;
    const codexSeccompProfile =
      role === "agent" && runtime?.codexSeccompProfile !== undefined
        ? {
            seccompProfile: {
              type: "Localhost",
              localhostProfile: runtime.codexSeccompProfile,
            },
          }
        : {};
    return {
      ...deployment,
      metadata: {
        ...deployment.metadata,
        annotations: {
          ...metadata.annotations,
          ...configurationAnnotations,
        },
      },
      spec: {
        replicas: 1,
        ...(role === "gateway" ? { strategy: { type: "Recreate" } } : {}),
        selector: { matchLabels: selector },
        template: {
          metadata: {
            ...workloadMetadata,
            annotations: { ...workloadMetadata.annotations, ...configurationAnnotations },
            labels: {
              ...workloadMetadata.labels,
              ...revisionLabels,
              ...selector,
              "openclaw.dev/workload-role": role,
            },
          },
          spec: {
            serviceAccountName,
            automountServiceAccountToken: false,
            ...(volumes.length === 0 ? {} : { volumes }),
            ...(initContainers.length === 0 ? {} : { initContainers }),
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              ...(privateHome ? { fsGroup: 1000 } : {}),
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: role,
                image,
                imagePullPolicy: "IfNotPresent",
                ...(variables.length === 0 ? {} : { env: variables }),
                ports: [
                  { containerPort: port, name: role === "agent" && runtime ? "websocket" : "http" },
                ],
                readinessProbe: {
                  ...(runtime !== undefined
                    ? {
                        exec: {
                          command: [
                            "node",
                            "-e",
                            role === "gateway"
                              ? GATEWAY_READINESS_ENTRYPOINT
                              : AGENT_READINESS_ENTRYPOINT,
                          ],
                        },
                      }
                    : { httpGet: { path: "/readyz", port } }),
                  periodSeconds: 2,
                },
                resources:
                  role === "gateway"
                    ? this.options.resources.gateway
                    : this.options.resources.agent,
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                  ...codexSeccompProfile,
                },
                ...(volumeMounts.length === 0 ? {} : { volumeMounts }),
                ...(runtime === undefined
                  ? {}
                  : {
                      command: ["node", "-e"],
                      args: [
                        role === "gateway" ? GATEWAY_RUNTIME_ENTRYPOINT : AGENT_RUNTIME_ENTRYPOINT,
                      ],
                    }),
              },
            ],
          },
        },
      },
    };
  }

  private service(
    name: string,
    ownership: Ownership,
    namespace: string,
    selector: Record<string, string>,
  ): ManagedKubernetesObject {
    return {
      ...this.manifest("v1", "Service", name, ownership, namespace),
      spec: {
        type: "ClusterIP",
        selector,
        ports: [
          {
            name:
              ownership.servicePrincipalId !== undefined && this.options.runtime !== undefined
                ? "websocket"
                : "http",
            port:
              ownership.servicePrincipalId !== undefined && this.options.runtime !== undefined
                ? AGENT_TRANSPORT_PORT
                : this.options.network.gatewayPort,
            targetPort:
              ownership.servicePrincipalId !== undefined && this.options.runtime !== undefined
                ? AGENT_TRANSPORT_PORT
                : this.options.network.gatewayPort,
          },
        ],
      },
    };
  }

  private async reconcile(
    desired: ManagedKubernetesObject,
    ownership: Ownership,
    namespace?: string,
    precondition?: ReconcilePrecondition,
  ): Promise<void> {
    const clients = await this.clients();
    const existing = await this.getOwned(desired.kind, desired.metadata.name, namespace, ownership);
    if (precondition !== undefined && desired.kind !== "Service") {
      throw new ConfigurationFailure(
        `Unsupported Kubernetes reconcile precondition for ${desired.kind}.`,
      );
    }
    if (existing === undefined && precondition !== undefined) return;
    if (existing !== undefined) {
      if (precondition?.serviceSelector !== undefined) {
        const selector = asRecord(existing.spec?.selector);
        if (
          Object.entries(precondition.serviceSelector).some(
            ([name, value]) => selector?.[name] !== value,
          )
        ) {
          return;
        }
      }
      if (desired.kind === "ConfigMap") {
        const annotations = desired.metadata.annotations ?? {};
        if (
          existing.immutable !== true ||
          Object.entries(annotations).some(
            ([name, value]) => existing.metadata.annotations?.[name] !== value,
          ) ||
          existing.data?.[CONFIGURATION_DOCUMENT] !== desired.data?.[CONFIGURATION_DOCUMENT] ||
          Object.keys(existing.data ?? {}).length !== 1 ||
          Object.keys(existing.binaryData ?? {}).length !== 0
        ) {
          throw new OwnershipFailure(
            `Refusing invalid immutable Kubernetes ConfigMap ${desired.metadata.name}.`,
          );
        }
        return;
      }
      if (desired.kind === "PersistentVolumeClaim") {
        this.verifyPersistentVolumeClaim(existing, desired);
        return;
      }
    }
    const request = {
      name: desired.metadata.name,
      body: desired,
      fieldManager: FIELD_MANAGER,
      force: false,
    };
    await this.request(
      async () => {
        switch (desired.kind) {
          case "Namespace":
            await clients.core.patchNamespace(request, this.patchOptions);
            return;
          case "ConfigMap":
            await clients.core.patchNamespacedConfigMap(
              { ...request, namespace: required(namespace, "ConfigMap namespace") },
              this.patchOptions,
            );
            return;
          case "ServiceAccount":
            await clients.core.patchNamespacedServiceAccount(
              { ...request, namespace: required(namespace, "ServiceAccount namespace") },
              this.patchOptions,
            );
            return;
          case "Service":
            await clients.core.patchNamespacedService(
              { ...request, namespace: required(namespace, "Service namespace") },
              this.patchOptions,
            );
            return;
          case "ResourceQuota":
            await clients.core.patchNamespacedResourceQuota(
              { ...request, namespace: required(namespace, "ResourceQuota namespace") },
              this.patchOptions,
            );
            return;
          case "LimitRange":
            await clients.core.patchNamespacedLimitRange(
              { ...request, namespace: required(namespace, "LimitRange namespace") },
              this.patchOptions,
            );
            return;
          case "PersistentVolumeClaim":
            await clients.core.patchNamespacedPersistentVolumeClaim(
              { ...request, namespace: required(namespace, "PersistentVolumeClaim namespace") },
              this.patchOptions,
            );
            return;
          case "Deployment":
            await clients.apps.patchNamespacedDeployment(
              { ...request, namespace: required(namespace, "Deployment namespace") },
              this.patchOptions,
            );
            return;
          case "NetworkPolicy":
            await clients.networking.patchNamespacedNetworkPolicy(
              { ...request, namespace: required(namespace, "NetworkPolicy namespace") },
              this.patchOptions,
            );
            return;
          case "HTTPRoute":
            await clients.objects.patch(
              desired,
              undefined,
              undefined,
              FIELD_MANAGER,
              false,
              APPLY_CONTENT_TYPE,
            );
            return;
          default: {
            const unsupported: never = desired.kind;
            throw new ConfigurationFailure(
              `Unsupported managed Kubernetes resource ${unsupported}.`,
            );
          }
        }
      },
      { mutating: true },
    );
  }

  private async getOwned<Kind extends ReadableResourceKind>(
    kind: Kind,
    name: string,
    namespace: string | undefined,
    ownership: Ownership,
  ): Promise<ManagedKubernetesObject<Kind> | undefined> {
    const object = await this.get(kind, name, namespace);
    if (object !== undefined) this.verifyOwnership(object, ownership);
    return object;
  }

  private async get<Kind extends ReadableResourceKind>(
    kind: Kind,
    name: string,
    namespace?: string,
  ): Promise<ManagedKubernetesObject<Kind> | undefined> {
    const clients = await this.clients();
    try {
      const value = asRecord(
        await this.request(async () => {
          switch (kind) {
            case "Namespace":
              return clients.core.readNamespace({ name });
            case "Pod":
              return clients.core.readNamespacedPod({
                name,
                namespace: required(namespace, "Pod namespace"),
              });
            case "ConfigMap":
              return clients.core.readNamespacedConfigMap({
                name,
                namespace: required(namespace, "ConfigMap namespace"),
              });
            case "Secret":
              return clients.core.readNamespacedSecret({
                name,
                namespace: required(namespace, "Secret namespace"),
              });
            case "ServiceAccount":
              return clients.core.readNamespacedServiceAccount({
                name,
                namespace: required(namespace, "ServiceAccount namespace"),
              });
            case "Service":
              return clients.core.readNamespacedService({
                name,
                namespace: required(namespace, "Service namespace"),
              });
            case "ResourceQuota":
              return clients.core.readNamespacedResourceQuota({
                name,
                namespace: required(namespace, "ResourceQuota namespace"),
              });
            case "LimitRange":
              return clients.core.readNamespacedLimitRange({
                name,
                namespace: required(namespace, "LimitRange namespace"),
              });
            case "PersistentVolumeClaim":
              return clients.core.readNamespacedPersistentVolumeClaim({
                name,
                namespace: required(namespace, "PersistentVolumeClaim namespace"),
              });
            case "Deployment":
              return clients.apps.readNamespacedDeployment({
                name,
                namespace: required(namespace, "Deployment namespace"),
              });
            case "NetworkPolicy":
              return clients.networking.readNamespacedNetworkPolicy({
                name,
                namespace: required(namespace, "NetworkPolicy namespace"),
              });
            case "HTTPRoute":
              return clients.objects.read({
                apiVersion: GATEWAY_API_VERSION,
                kind,
                metadata: { name, namespace: required(namespace, "HTTPRoute namespace") },
              });
            default: {
              const unsupported: never = kind;
              throw new ConfigurationFailure(
                `Unsupported managed Kubernetes resource ${unsupported}.`,
              );
            }
          }
        }),
      );
      const metadata = asRecord(value?.metadata);
      if (
        value === undefined ||
        typeof value.apiVersion !== "string" ||
        value.kind !== kind ||
        metadata === undefined ||
        metadata.name !== name ||
        (namespace !== undefined && metadata.namespace !== namespace)
      ) {
        throw new Error(`The Kubernetes client returned an invalid or ambiguous ${kind} ${name}.`);
      }
      return value as unknown as ManagedKubernetesObject<Kind>;
    } catch (error) {
      if (numericErrorStatus(error) === 404) return undefined;
      throw error;
    }
  }
}

export function createKubernetesComputeDriver(
  options: KubernetesComputeDriverOptions,
): KubernetesComputeDriver {
  return new KubernetesComputeDriver(options);
}
