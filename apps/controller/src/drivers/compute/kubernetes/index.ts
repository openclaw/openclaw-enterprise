import {
  asRecord,
  isNonEmptyString,
  numericErrorStatus,
  sha256Hex,
  splitModelRef,
} from "@openclaw-enterprise/utils";
import { randomBytes, X509Certificate } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type {
  AppsV1Api,
  CoreV1Api,
  DiscoveryV1Api,
  KubernetesObject,
  KubernetesObjectApi,
  NetworkingV1Api,
  VersionApi,
  V1ConfigMap,
  V1EnvVar,
  V1NetworkPolicyPeer,
  V1ObjectMeta,
  V1DeleteOptions,
  V1ResourceRequirements,
  V1Secret,
  V1ServiceAccount,
  V1Volume,
  V1VolumeMount,
} from "@kubernetes/client-node";
import type {
  AgentDeploymentDiagnostics,
  AgentRevision,
  AgentRuntimeContainerStatus,
  AgentRuntimeDescribeOptions,
  AgentRuntimeDescription,
  AgentRuntimeEvent,
  AgentRuntimeLogChunk,
  AgentRuntimeLogRequest,
  AgentRuntimeLogSource,
  AgentRuntimePodStatus,
  RuntimeLogContainerSourceId,
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
  ComputeAgentProvisioningInput,
  ComputeDriver,
  ComputeAgentBinding,
  ComputeAgentRevisionBinding,
  ComputePendingReason,
  ComputeReadiness,
  ComputePreflightResult,
  ComputeRevisionContext,
  CredentialAttachmentStatus,
  CredentialGatewayDriver,
  CredentialSource,
  CredentialSourceAttachment,
  CredentialSourceType,
  WorkspaceSetup,
  Driver,
  HarnessWorkloadRequirements,
  HarnessAuthSnapshot,
  PluginDeploymentWarning,
  ResolvedHarnessAuth,
  RevisionHarnessDescriptor,
  OpenClawConfigurationDocument,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  SandboxDriver,
  SandboxEnvironmentVariable,
  SandboxNamespaceContext,
  SandboxResourceRef,
  SandboxWorkspaceMount,
  SecretBindings,
  SecretEnvironmentProjection,
  LoggingLevel,
  RuntimeDiagnosticCheck,
  RuntimeDiagnosticState,
  RuntimeFailureEvidence,
  RuntimeImage,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";
import { admittedLoggingLevel, normalizeSecretBindings } from "@openclaw-enterprise/contracts";
import {
  ActivationFailedError,
  ActivationPendingError,
  ConfigurationHarnessError,
  DependencyUnavailableError,
  ResourceConflictError,
  RuntimeCredentialsForbiddenByClusterError,
  RuntimeLogsForbiddenByClusterError,
  runtimeFailureCause,
  TransientDependencyError,
} from "@openclaw-enterprise/occ";
import {
  createKubernetesClientConfiguration,
  KubernetesApiUnavailableError,
} from "../../kubernetes/client.ts";
import {
  WORKSPACE_SETUP_RUNTIME,
  workspaceSetupMainAgent,
  workspaceSetupVerifier,
} from "../workspace-setup-runtime.ts";
import { ComputeLifecycleDispatcher } from "../lifecycle-hooks.ts";
import { nodeProgramArguments } from "../node-program.ts";
import { discoverHarnessModels } from "../model-discovery.ts";
import { pollHarnessDeviceAuthorization, startHarnessDeviceAuthorization } from "../device-auth.ts";
import {
  OAUTH_AGENT_ANNOTATION,
  OAUTH_PHASE_ANNOTATION,
  OAUTH_VOLUME_ANNOTATION,
} from "../../kubernetes/oauth-seal.ts";
import {
  computeWorkWaiting,
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../operation-context.ts";
import { unsupportedNativeGatewayAuthFields } from "../../../gateway/auth-fields.ts";
import type {
  GatewayNodeEnrollment,
  NodeSetupObservation,
} from "../../../gateway/node-enrollment-client.ts";
import {
  PLUGIN_RUNTIME_DIRECTORY,
  PLUGIN_RUNTIME_CODEX_CONFIG,
  PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT,
  PLUGIN_RUNTIME_MANIFEST,
  PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT,
  PLUGIN_RUNTIME_READY_MARKER,
  PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT,
  type CodexRepositoryBrokerNetworkPolicy,
  type PluginRuntimeSpec,
  pluginRuntimeConfigMapData,
  pluginRuntimeSpecForRevision,
} from "../plugin-runtime.ts";
import {
  AGENT_READINESS_ENTRYPOINT,
  AGENT_RUNTIME_ENTRYPOINT,
  AGENT_WITH_NODE_ENTRYPOINT,
  CODEX_OAUTH_BOOTSTRAP_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  GATEWAY_READINESS_ENTRYPOINT,
  GATEWAY_STOP_TIMEOUT_MS,
  NATIVE_WORKER_ENTRYPOINT,
  NATIVE_WORKER_READINESS_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
  SETUP_WRAPPER_COMMAND,
} from "./runtime-entrypoints.ts";

import {
  REPOSITORY_MATERIAL_GENERATION,
  repositoryMaterialCurrent,
  repositoryMaterialSpec,
  repositoryMaterialDeployment,
  type RepositoryMaterialSpec,
  type ResolvedRepositoryMaterialSpec,
} from "./repository-material.ts";
import {
  RepositoryMaterialStore,
  completeKubernetesList,
  type RepositoryMaterialOwner,
} from "./repository-material-store.ts";
import {
  NETWORK_PROFILE_LABEL,
  ORDINARY_NETWORK_PROFILE,
  PROVIDER_FENCED_NETWORK_PROFILE,
  type NetworkProfile,
  ordinaryNetworkPolicySelector,
  profileNetworkPolicySelector,
  withoutNetworkProfile,
} from "./resources/network.ts";
import {
  REPOSITORY_CLIENT_BIN,
  repositoryNativeConfiguration,
} from "./repository-native-configuration.ts";

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
  | "HTTPRoute"
  | "SecurityPolicy";
type ReadableResourceKind = ManagedResourceKind | "Pod" | "Secret";

const CHANNEL_REQUIREMENTS = {
  slack: {
    egress: "https-proxy",
  },
  msteams: {
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
  readonly endpointPort?: number;
  readonly gatewayName: string;
  readonly gatewayNamespace: string;
  readonly envoyNamespace: string;
  readonly envoyHttpsTargetPort?: number;
  readonly sandbox?: {
    readonly domain: string;
    readonly publicPort?: number;
  };
}

export type {
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
} from "@openclaw-enterprise/contracts";

interface KubernetesApiClients {
  readonly version: VersionApi;
  readonly core: CoreV1Api;
  readonly apps: AppsV1Api;
  readonly discovery: DiscoveryV1Api;
  readonly networking: NetworkingV1Api;
  readonly objects: KubernetesObjectApi;
  /** The selected API server URL, named when the server is unreachable. */
  readonly server?: string;
}

export const MINIMUM_KUBERNETES_VERSION = "1.35.0";
const MINIMUM_KUBERNETES_VERSION_PARTS = [1, 35, 0] as const;
/** The profile-free workspace-node selector written before explicit network
 * profiles. Namespaces provisioned before the upgrade keep it. */
const LEGACY_WORKSPACE_NODE_POLICY_SELECTOR: {
  readonly matchLabels: Readonly<Record<string, string>>;
} = { matchLabels: { "openclaw.dev/workload-role": "agent" } };

interface LifecycleOwnerSelection {
  readonly driver: Driver;
  readonly capability: Driver["capability"];
  readonly id: string;
  readonly implementation: string;
}

function lifecycleOwnerSelection(drivers: readonly Driver[]): readonly LifecycleOwnerSelection[] {
  return Object.freeze(
    drivers.map((driver) =>
      Object.freeze({
        driver,
        capability: driver.capability,
        id: driver.id,
        implementation: driver.implementation,
      }),
    ),
  );
}

function sameLifecycleOwners(
  current: readonly LifecycleOwnerSelection[],
  drivers: readonly Driver[],
): boolean {
  return (
    current.length === drivers.length &&
    current.every((selected, index) => {
      const driver = drivers[index];
      return (
        selected.driver === driver &&
        selected.capability === driver.capability &&
        selected.id === driver.id &&
        selected.implementation === driver.implementation
      );
    })
  );
}

function kubernetesVersion(value: unknown): {
  readonly normalized: string;
  readonly parts: readonly [number, number, number];
} {
  if (typeof value !== "string") {
    throw new Error("The Kubernetes version preflight returned invalid data.");
  }
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (match === null) {
    throw new Error("The Kubernetes version preflight returned invalid data.");
  }
  const parts = match.slice(1, 4).map(Number) as [number, number, number];
  if (!parts.every(Number.isSafeInteger)) {
    throw new Error("The Kubernetes version preflight returned invalid data.");
  }
  return { normalized: parts.join("."), parts };
}

function versionIsOlder(
  candidate: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (const [index, value] of candidate.entries()) {
    if (value !== minimum[index]) {
      return value < minimum[index]!;
    }
  }
  return false;
}

export interface KubernetesComputeDriverOptions {
  readonly authentication:
    | { readonly mode: "inCluster" }
    | { readonly mode: "kubeconfig"; readonly kubeconfigPath: string; readonly context: string };
  readonly executionCluster?: {
    readonly authentication: KubernetesComputeDriverOptions["authentication"];
    readonly harnessRouting: KubernetesGatewayRoutingOptions & { readonly hostname: string };
    readonly network: {
      readonly dns: KubernetesWorkloadPeer;
      readonly harnessEndpointCidrs: readonly string[];
      readonly gatewayEndpointCidrs: readonly string[];
      readonly pluginStatusProxySourceCidrs: readonly string[];
    };
    readonly caBundle?: string;
  };
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
    readonly gatewayTrustedProxyCidrs: readonly string[];
    readonly gatewayClients?: readonly KubernetesWorkloadPeer[];
    readonly pluginStatusProxySourceCidrs?: readonly string[];
    readonly repositoryCredentials?: KubernetesWorkloadPeer & { readonly port: number };
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
    readonly gatewayStorageClassName: string;
    readonly nativeOpenClawSessionCapacity?: number;
    readonly nodeSelector?: Readonly<Record<string, string>>;
    readonly gatewayNodeSelector?: Readonly<Record<string, string>>;
    readonly codexSeccompProfile?: string;
    readonly channels?: {
      readonly proxyUrl: string;
      readonly managedProxy?: KubernetesWorkloadPeer & {
        readonly hostname: string;
        readonly port: number;
      };
    };
  };
  readonly gatewayRouting?: KubernetesGatewayRoutingOptions;
}

interface ManagedKubernetesObject<Kind extends ReadableResourceKind = ManagedResourceKind>
  extends
    KubernetesObject,
    Pick<V1ConfigMap, "binaryData" | "data" | "immutable">,
    Pick<V1Secret, "type">,
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
  readonly usesGatewayPasswordEnv: boolean;
  readonly usesWritableNativeAdminConfig: boolean;
  readonly annotations: Readonly<Record<string, string>>;
  readonly loggingLevel: LoggingLevel;
  readonly workspaceNodeId?: string;
  /** Agent-scoped ConfigMap that delivers workspaceNodeId to a dedicated Codex Gateway. */
  readonly workspaceNodeBinding?: string;
  readonly harnessNamespace?: KubernetesNamespaceAddress;
  readonly workspace: unknown;
  readonly nativeWorkerProfile?: string;
  readonly nativeWorkerNodeId?: string;
}

interface PluginRuntimeSnapshot {
  readonly name: string;
  readonly runtime: PluginRuntimeSpec;
}

interface PluginRuntimeStatus {
  readonly revisionId: string;
  readonly container: "agent" | "gateway";
  readonly startupId: string;
  readonly podUid: string;
  readonly phase: "starting" | "ready";
  readonly successfulPluginIds: readonly string[];
  readonly failures: readonly PluginDeploymentWarning[];
}

interface PrivateStatusReadback {
  readonly status: unknown;
  readonly podUid: string;
  readonly containerId: string | undefined;
}

class OwnershipFailure extends Error {}
class ConfigurationFailure extends Error {}

class KubernetesRequestTimeout extends Error {}

// Socket-level failures: the request never reached a Kubernetes API server.
// TLS trust and HTTP status failures keep their original error.
const UNREACHABLE_SOCKET_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function unreachableSocketFailure(error: unknown, depth = 0): boolean {
  if (error instanceof KubernetesRequestTimeout) {
    return true;
  }
  const record = asRecord(error);
  if (record === undefined || depth > 4) {
    return false;
  }
  if (typeof record.code === "string" && UNREACHABLE_SOCKET_CODES.has(record.code)) {
    return true;
  }
  const nested = Array.isArray(record.errors) ? record.errors : [];
  return [record.cause, ...nested].some((entry) => unreachableSocketFailure(entry, depth + 1));
}

/**
 * Names a Kubernetes API failure that clears by itself, so the worker retries
 * it within the deployment deadline instead of spending its attempt budget: a
 * request that timed out or never reached the API server, or an answer of 429
 * or 5xx. Other errors, including a lost claim, pass through unchanged.
 */
function transientKubernetesFailure(error: unknown): unknown {
  if (error instanceof TransientDependencyError) {
    return error;
  }
  if (unreachableSocketFailure(error)) {
    const timedOut = error instanceof KubernetesRequestTimeout;
    return new TransientDependencyError(
      "kubernetes_api",
      timedOut ? "timeout" : "unreachable",
      timedOut ? "A Kubernetes API request timed out." : "The Kubernetes API was unreachable.",
      { cause: error },
    );
  }
  const status = numericErrorStatus(error);
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    return new TransientDependencyError(
      "kubernetes_api",
      "unavailable",
      `The Kubernetes API answered HTTP ${status}.`,
      { cause: error },
    );
  }
  return error;
}

function unreachableKubernetesApi(server: string | undefined, error: unknown): unknown {
  if (server === undefined || !unreachableSocketFailure(error)) {
    return error;
  }
  return new KubernetesApiUnavailableError(server, { cause: error });
}

const REPOSITORY_BROKER_CA_ENVIRONMENT = [
  "SSL_CERT_FILE",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
] as const;
const REPOSITORY_BROKER_CA_BUNDLE = "ca-bundle.pem";

function repositoryBrokerPublicCaPath(
  material: ResolvedRepositoryMaterialSpec,
): string | undefined {
  const withCa = material.bindings.filter((binding) => Object.hasOwn(binding.files, "ca.pem"));
  if (withCa.length === 0) {
    return undefined;
  }
  if (
    withCa.length !== material.bindings.length ||
    withCa.some((binding) => binding.files["ca.pem"] !== withCa[0]?.files["ca.pem"])
  ) {
    throw new ConfigurationFailure(
      "Repository credential broker CA material must be present and identical for every binding.",
    );
  }
  return `${withCa[0]?.directory}/${REPOSITORY_BROKER_CA_BUNDLE}`;
}

interface RuntimeCredentialSecretSpec {
  readonly name: string;
  readonly keys: readonly string[];
}

interface KubernetesNamespaceAddress {
  readonly name: string;
  readonly plane: "control" | "execution";
}

interface TargetedKubernetesResource {
  readonly namespace: KubernetesNamespaceAddress;
  readonly resource: ManagedKubernetesObject;
}

/** How preparation widens Agent-scoped policies while another revision serves. */
interface AgentPolicyPreparation {
  readonly anyRevision?: boolean;
  readonly unprofiledGateway?: boolean;
}

interface RuntimeCredentialContext {
  readonly namespaceId: string;
  readonly namespace: KubernetesNamespaceAddress;
  readonly agentId: string;
  readonly suffix: string;
  readonly ownership: Ownership;
  readonly transport: RuntimeCredentialSecretSpec;
  readonly gatewayPassword?: RuntimeCredentialSecretSpec;
}

interface PreparedHarnessAuth {
  readonly loginMode: HarnessAuthSnapshot["method"];
  readonly environment: readonly V1EnvVar[];
  /** Present when the Credential Gateway, not a Secret projection, supplies the credential. */
  readonly credentialSource?: Readonly<CredentialSource>;
}

interface NativeRuntimeSnapshot {
  readonly configuration: string;
}

/** One rendering step; neither credential values nor backend lookups belong here. */
function prepareHarnessAuth(
  harness: RevisionHarnessDescriptor,
  resolvedAuth: ResolvedHarnessAuth,
  configuration: OpenClawConfigurationDocument,
): PreparedHarnessAuth {
  const secret = (
    name: string,
    reference: { readonly name: string; readonly key: string },
  ): V1EnvVar => ({
    name,
    valueFrom: { secretKeyRef: { name: reference.name, key: reference.key } },
  });
  const environment: V1EnvVar[] = [];
  if (resolvedAuth.method === "api_key") {
    environment.push(
      secret(harnessModelAuthentication(configuration).environmentName, resolvedAuth.backendRef),
    );
  } else if (
    resolvedAuth.method === "credential_source" &&
    harness.mode === "dedicated" &&
    (harness.id === "codex" || harness.id === "openclaw")
  ) {
    // The paired Sandbox supplies the credential environment; no Secret is projected here.
    if (harness.id === "codex") {
      environment.push({ name: "CODEX_LOGIN_MODE", value: resolvedAuth.loginMode });
    }
    return {
      loginMode: resolvedAuth.loginMode,
      environment,
      credentialSource: resolvedAuth.source,
    };
  } else if (
    resolvedAuth.method === "oauth" &&
    harness.mode === "dedicated" &&
    harness.id === "codex"
  ) {
    environment.push({ name: "OCE_CODEX_OAUTH_SOURCE_UID", value: resolvedAuth.backendRef.uid });
  } else if (
    resolvedAuth.method === "codex_pat" &&
    harness.mode === "dedicated" &&
    harness.id === "codex"
  ) {
    environment.push(secret(CODEX_ACCESS_TOKEN, resolvedAuth.backendRef));
  } else if (
    resolvedAuth.method === "chatgpt_service_account" &&
    harness.mode === "dedicated" &&
    harness.id === "codex"
  ) {
    environment.push(
      secret(CODEX_ACCESS_TOKEN, resolvedAuth.credential.secretRef),
      secret(CODEX_CHATGPT_WORKSPACE_ID, {
        name: resolvedAuth.credential.secretRef.name,
        key: SERVICE_ACCOUNT_WORKSPACE_KEY,
      }),
    );
  } else {
    throw new ConfigurationFailure("Harness authentication method is unsupported.");
  }
  if (harness.mode === "dedicated" && harness.id === "codex") {
    environment.push({ name: "CODEX_LOGIN_MODE", value: resolvedAuth.method });
  }
  return { loginMode: resolvedAuth.method, environment };
}

const MANAGER = "openclaw-enterprise";
const FIELD_MANAGER = "openclaw-enterprise-compute";
const TOKEN_PATH = "/var/run/secrets/openclaw/service-principal";
const CONFIGURATION_DIRECTORY = "/etc/openclaw";
const MANAGED_CONFIGURATION_DIRECTORY = "/etc/openclaw-managed";
const WRITABLE_CONFIGURATION_PATH = "/home/node/.openclaw/openclaw.json";
const CONFIGURATION_DOCUMENT = "openclaw.json";
const CONFIGURATION_VOLUME = "openclaw-configuration";
const PLUGIN_RUNTIME_VOLUME = "openclaw-plugin-runtime";
const PLUGIN_RUNTIME_STATUS_PORT = 18_791;
const PLUGIN_RUNTIME_STATUS_PATH = "/openclaw/plugin-runtime/status";
const RUNTIME_STATUS_PATH = "/openclaw/runtime/status";
const RUNTIME_DIAGNOSTICS_PATH = "/openclaw/runtime/diagnostics";
const COMPUTE_PRIVATE_STATUS_ENVIRONMENT = new Set([
  "OPENCLAW_AGENT_REVISION_ID",
  "OPENCLAW_RUNTIME_STATUS_CONTAINER",
  "OPENCLAW_RUNTIME_STATUS_PORT",
  "OPENCLAW_POD_UID",
]);
const AGENT_REVISION_ANNOTATION = "openclaw.dev/agent-revision";
const AGENT_REVISION_ID_ANNOTATION = "openclaw.dev/agent-revision-id";
const APPLY_CONTENT_TYPE = "application/apply-patch+yaml";
const MERGE_PATCH_CONTENT_TYPE = "application/merge-patch+json";
const GATEWAY_API_VERSION = "gateway.networking.k8s.io/v1";
const GATEWAY_SECURITY_POLICY_API_VERSION = "gateway.envoyproxy.io/v1alpha1";
const GATEWAY_LISTENER_SECTION = "https";
const GATEWAY_MEMBERSHIP_LABEL = "openclaw-enterprise.io/gateway";
const REQUEST_TIMEOUT_MS = 10_000;
// A retry-safe call (not marked mutating) rides out a short API outage — a 429 from
// API priority and fairness, a 5xx while an API server restarts, a dropped connection —
// instead of surfacing it as DEPENDENCY_UNAVAILABLE. Waits grow exponentially with
// jitter, honor Retry-After on 429/503, and stay within a bounded total.
const REQUEST_RETRY_ATTEMPTS = 6;
const REQUEST_RETRY_BASE_DELAY_MS = 50;
const REQUEST_RETRY_MAX_DELAY_MS = 2_000;
const REQUEST_RETRY_BUDGET_MS = 2_000;
/** Each Kubernetes call on the runtime log path; the service bounds the whole request. */
const RUNTIME_LOG_CALL_TIMEOUT_MS = 5_000;
const RUNTIME_LOG_MAX_PODS = 8;
const RUNTIME_LOG_MAX_EVENTS = 100;
const RUNTIME_LOG_RETENTION =
  "Kubernetes keeps only the current and the previous instance of each container; older output and output from deleted Pods is gone.";
// Kubelet Events name their container as `spec.containers{name}` (or init/ephemeral).
const RUNTIME_EVENT_CONTAINER_FIELD_PATH =
  /^spec\.(?:containers|initContainers|ephemeralContainers)\{([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)\}$/;

function runtimeEventContainer(fieldPath: unknown): string | null {
  return typeof fieldPath === "string"
    ? (RUNTIME_EVENT_CONTAINER_FIELD_PATH.exec(fieldPath)?.[1] ?? null)
    : null;
}

// The scheduler's PVC bind lost an optimistic-concurrency race (usually with the PV
// controller) and retried: a fresh Agent's workspace claim often shows this once. Only
// this exact message, and only once the Pod has a node, is dropped from runtime status;
// every other FailedScheduling Event is kept.
const SETTLED_VOLUME_BINDING_CONFLICT =
  /^running PreBind plugin "VolumeBinding": Operation cannot be fulfilled on persistentvolumeclaims "[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?": the object has been modified; please apply your changes to the latest version and try again$/;

function settledSchedulingConflict(
  event: Record<string, unknown> | undefined,
  scheduled: boolean,
): boolean {
  return (
    scheduled &&
    event?.type === "Warning" &&
    event.reason === "FailedScheduling" &&
    typeof event.message === "string" &&
    SETTLED_VOLUME_BINDING_CONFLICT.test(event.message)
  );
}

const WORKLOAD_TERMINATION_TIMEOUT_MS = 120_000;
const WORKLOAD_TERMINATION_POLL_MS = 100;
const AGENT_TRANSPORT_PORT = 18_790;
const NATIVE_WORKER_INFERENCE_CONFIG_PATH = "/tmp/openclaw-native-inference.json";
const NATIVE_WORKER_WORKSPACE_ROOT = "/home/node/.openclaw-node/node-host";
const NATIVE_WORKER_PROFILE = "dedicated-native";
const DEFAULT_NATIVE_OPENCLAW_SESSION_CAPACITY = 8;
const NATIVE_WORKER_COMPILE_CACHE = "/home/node/.openclaw-node/.cache/node-compile";
const AGENT_TRANSPORT_TOKEN_KEY = "app-server-token";
const GATEWAY_PASSWORD_KEY = "gateway-password";
const OPENCLAW_GATEWAY_PASSWORD = "OPENCLAW_GATEWAY_PASSWORD";
const TRUSTED_PROXY_IDENTITY = "occ-workspace-files";
const TRUSTED_PROXY_HEADER = "x-occ-identity";
const MODEL_API_KEY = "OPENAI_API_KEY";
const SERVICE_ACCOUNT_TOKEN_KEY = "token";
const SERVICE_ACCOUNT_WORKSPACE_KEY = "workspace-id";
const CODEX_ACCESS_TOKEN = "CODEX_ACCESS_TOKEN";
const CODEX_CHATGPT_WORKSPACE_ID = "CODEX_CHATGPT_WORKSPACE_ID";
const MAX_RUNTIME_CREDENTIAL_BYTES = 65_536;
const MAX_RUNTIME_STATUS_RESPONSE_BYTES = 65_536;
const RUNTIME_STATUS_IDENTIFIER = /^[A-Za-z0-9._~:@-]{1,64}$/u;
const RUNTIME_STATE_VOLUME_SIZE = "1Gi";
const GATEWAY_PRIVATE_STATE_VOLUME = "openclaw-gateway-state";
const GATEWAY_PRIVATE_STATE_SIZE = "10Gi";
const NODE_STATE_VOLUME = "openclaw-node-state";
// Harness kinds that can own a workspace node. Naming refuses any other kind,
// so Agent deletion removes every node Secret preparation can create.
const WORKSPACE_NODE_HARNESS_IDS: readonly string[] = ["codex", "openclaw"];
const NODE_STATE_PATH = "/home/node/.openclaw-node";
// A Deployment-backed Codex Harness reads its one-shot node setup code from an
// optional Secret volume, so the Harness can start before the Secret exists.
const NODE_SETUP_VOLUME = "openclaw-node-setup";
const NODE_SETUP_DIRECTORY = "/run/openclaw-node-setup";
const NODE_SETUP_FILE = "setup-code";
// Changing this Pod annotation is a Pod update event: the kubelet syncs the Pod
// and refreshes its Secret volumes at once instead of on its ~1 min resync.
const NODE_SETUP_ANNOTATION = "openclaw.dev/workspace-node-setup";
// A dedicated Codex Gateway learns its enrolled workspace node from an optional,
// Agent-scoped ConfigMap instead of its pod spec, so enrollment and activation
// do not replace the Gateway. The wrapper polls the file and hot-applies it.
const WORKSPACE_NODE_BINDING_VOLUME = "openclaw-workspace-node";
const WORKSPACE_NODE_BINDING_DIRECTORY = "/run/openclaw-workspace-node";
const WORKSPACE_NODE_BINDING_FILE = "workspace-node.json";
const WORKSPACE_NODE_BINDING_ANNOTATION = "openclaw.dev/workspace-node-binding";
// Kubelet refresh after the Pod nudge (1.3-1.7 s on k3d, #612), then the
// wrapper's 1 s poll, its config write and OpenClaw's plugin reload, confirmed
// through OpenClaw's plugin list (about 2.5 s from the file in the runtime
// image test), with margin. A slower Gateway retries on the next pass. Like the
// pairing wait below, this is a budget per binding, not per pass: activation
// that fails for want of the ack is retried, and the serial worker must not
// spend another full wait on every retry while other Agents' deploys queue (D221).
const WORKSPACE_NODE_BINDING_ACK_TIMEOUT_MS = 20_000;
const WORKSPACE_NODE_BINDING_ACK_POLL_MS = 250;
// After the setup reaches the Harness of a first dedicated deploy, its node host
// boots and pairs (7-12 s on a loaded dogfood k3d host, D25). The
// preparation pass that delivered it watches for the pairing on one Gateway
// connection for this long instead of ending pending and paying a full pass
// (about 1-3 s of reconciliation) per check. The worker is serial, so this is
// a budget per setup, not per pass: once a setup has spent it, later passes read
// the setup once and end pending, so a node that never pairs cannot hold the
// worker on every pass and delay other Agents' deploys (D88). Both this wait
// and the ack wait above also end at once when other Work could be claimed, so
// they only use a worker nobody else is waiting for (D221).
const WORKSPACE_NODE_PAIRING_WAIT_MS = 8_000;
// Remembered setups whose pairing budget is partly or fully spent. Forgetting
// one (a full map, or a controller restart) only grants that setup one more wait.
const MAX_WORKSPACE_NODE_PAIRING_BUDGETS = 1_024;
const WORKSPACE_NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const GATEWAY_PRIVATE_STATE_CATEGORIES = Object.freeze([
  ["state", "/home/node/.openclaw/state"],
  ["agent", "/home/node/.openclaw/agents/main/agent"],
  ["media", "/home/node/.openclaw/media"],
] as const);
const HARNESS_WORKSPACE_VOLUME = "openclaw-workspace";
const HARNESS_AUTH_VOLUME = "openclaw-harness-auth";
const HARNESS_WORKSPACE_SIZE = "40Gi";
type WorkspaceRole = "agent" | "gateway";
const HARNESS_WORKSPACE_CATEGORIES = Object.freeze([
  ["workspace", "/home/node/workspace"],
  ["generated-images", "/home/node/.codex/generated_images"],
] as const);
// Codex thread rollouts. The Gateway resumes its bound thread by ID after a
// restart; without its rollout the Harness starts a new thread. The rest of
// CODEX_HOME (login, config) stays Pod-local. OAuth keeps all of CODEX_HOME,
// sessions included, in `codex-home`, which a new OAuth source empties.
const HARNESS_CODEX_SESSIONS_CATEGORY = Object.freeze([
  "codex-sessions",
  "/home/node/.codex/sessions",
] as const);

function harnessWorkspaceCategories(oauth: boolean) {
  return oauth
    ? HARNESS_WORKSPACE_CATEGORIES
    : [...HARNESS_WORKSPACE_CATEGORIES, HARNESS_CODEX_SESSIONS_CATEGORY];
}
const GATEWAY_SESSION_DIRECTORY = "/home/node/.openclaw/agents/main/sessions";
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

/** The wait before retry `attempt + 1`: exponential with jitter, or the server's
 * Retry-After on 429/503 when that is longer, never above the per-wait cap. */
function requestRetryDelay(attempt: number, status: number | undefined, error: unknown): number {
  const exponential = REQUEST_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const backoff = exponential / 2 + Math.random() * (exponential / 2);
  const retryAfter = status === 429 || status === 503 ? retryAfterMilliseconds(error) : 0;
  return Math.round(Math.min(Math.max(backoff, retryAfter), REQUEST_RETRY_MAX_DELAY_MS));
}

/** Retry-After (delay-seconds or an HTTP date) from a Kubernetes client ApiException. */
function retryAfterMilliseconds(error: unknown): number {
  const headers = asRecord(asRecord(error)?.headers) ?? {};
  const name = Object.keys(headers).find((key) => key.toLowerCase() === "retry-after");
  const value = name === undefined ? undefined : headers[name];
  if (typeof value !== "string") {
    return 0;
  }
  const seconds = /^\s*(\d+)\s*$/u.exec(value)?.[1];
  const ms = seconds === undefined ? Date.parse(value) - Date.now() : Number(seconds) * 1000;
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

function failure(error: unknown): "retryable" | "permanent" {
  return error instanceof OwnershipFailure ||
    error instanceof ConfigurationFailure ||
    error instanceof ConfigurationHarnessError ||
    [400, 401, 403, 422].includes(numericErrorStatus(error) ?? 0)
    ? "permanent"
    : "retryable";
}

function validatePort(value: number, description: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new ConfigurationFailure(`${description} must be a valid port.`);
  }
}

function repositoryCredentialBrokerOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(required(origin, "Repository credential gateway origin"));
  } catch {
    throw new ConfigurationFailure("Repository credential gateway origin must be an HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname !== url.hostname.toLowerCase() ||
    !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(url.hostname) ||
    (url.port !== "" && url.port !== "443")
  ) {
    throw new ConfigurationFailure("Repository credential gateway origin must be an HTTPS origin.");
  }
  return url;
}

function repositoryCredentialBrokerOriginFromMaterial(
  material: ResolvedRepositoryMaterialSpec,
): URL {
  let origin: URL | undefined;
  for (const binding of material.bindings) {
    const next = repositoryCredentialBrokerOrigin(binding.client.gatewayOrigin);
    if (origin !== undefined && origin.origin !== next.origin) {
      throw new ConfigurationFailure(
        "Repository credential broker origin must match across admitted runtime material.",
      );
    }
    origin = next;
  }
  if (origin === undefined) {
    throw new ConfigurationFailure("Repository credentials require resolved runtime material.");
  }
  return origin;
}

function normalizedNetworkHost(value: string, description: string): string {
  const host = required(value, description).trim().toLowerCase();
  if (host.length === 0) {
    throw new ConfigurationFailure(`${description} must be nonempty.`);
  }
  return host;
}

function mergeDomainDecision(
  domains: Record<string, "allow" | "deny">,
  host: string,
  decision: "allow" | "deny",
): void {
  if (domains[host] === "deny" || decision === "deny") {
    domains[host] = "deny";
    return;
  }
  domains[host] = "allow";
}

function validateResources(value: V1ResourceRequirements, description: string, path: string): void {
  const resources = asRecord(value);
  const requests = asRecord(resources?.requests);
  const limits = asRecord(resources?.limits);
  if (requests === undefined || limits === undefined) {
    throw new ConfigurationFailure(`${description} requests and limits must be configured.`);
  }
  resourceQuantity(requests.cpu, `${description} CPU request`, `${path}.requests.cpu`);
  resourceQuantity(requests.memory, `${description} memory request`, `${path}.requests.memory`);
  resourceQuantity(limits.cpu, `${description} CPU limit`, `${path}.limits.cpu`);
  resourceQuantity(limits.memory, `${description} memory limit`, `${path}.limits.memory`);
}

// Quantities stay strings, as Kubernetes returns them: an unquoted YAML `4` is a
// number, so name the fix instead of reporting the value as missing.
function resourceQuantity(value: unknown, description: string, path: string): string {
  if (typeof value === "number") {
    throw new ConfigurationFailure(
      `${description} (${path}) must be a quoted Kubernetes quantity string: write "${value}", not ${value}.`,
    );
  }
  return required(value, description);
}

function validatePeer(value: KubernetesWorkloadPeer, description: string): void {
  if (asRecord(value) === undefined) {
    throw new ConfigurationFailure(`${description} is required.`);
  }
  required(value.namespace, `${description} namespace`);
  const labels = asRecord(value.podLabels);
  if (labels === undefined || Object.keys(labels).length === 0) {
    throw new ConfigurationFailure(`${description} Pod labels cannot be empty.`);
  }
  for (const [key, label] of Object.entries(labels)) {
    required(key, `${description} label key`);
    if (typeof label !== "string") {
      throw new ConfigurationFailure(`${description} labels must be strings.`);
    }
  }
}

interface ParsedCidr {
  readonly value: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly prefix: number;
}

function parseCidr(value: unknown, description: string): ParsedCidr {
  if (typeof value !== "string") {
    throw new ConfigurationFailure(`${description} must be a CIDR string.`);
  }
  const [address = "", prefix, extra] = value.split("/");
  const family = isIP(address);
  const prefixValue =
    typeof prefix === "string" && /^(0|[1-9]\d*)$/u.test(prefix) ? Number(prefix) : NaN;
  if (
    extra !== undefined ||
    family === 0 ||
    !Number.isInteger(prefixValue) ||
    prefixValue < 0 ||
    prefixValue > (family === 4 ? 32 : 128)
  ) {
    throw new ConfigurationFailure(`${description} must be a valid IPv4 or IPv6 CIDR.`);
  }
  return { value, address, family: family === 4 ? 4 : 6, prefix: prefixValue };
}

function validateCidr(value: unknown, description: string): void {
  parseCidr(value, description);
}

function trustedProxyCidrTrustsEverySource(cidr: ParsedCidr): boolean {
  if (cidr.prefix === 0) {
    return true;
  }
  if (cidr.family !== 6) {
    return false;
  }
  const blockList = new BlockList();
  blockList.addSubnet(cidr.address, cidr.prefix, "ipv6");
  return blockList.check("0.0.0.0", "ipv4") && blockList.check("255.255.255.255", "ipv4");
}

function trustedProxyCidrSet(value: unknown, description: string): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigurationFailure(`${description} must contain at least one CIDR.`);
  }
  const cidrs = new Set<string>();
  value.forEach((entry, index) => {
    const parsed = parseCidr(entry, `${description} ${index}`);
    if (trustedProxyCidrTrustsEverySource(parsed)) {
      throw new ConfigurationFailure(`${description}s cannot trust every source.`);
    }
    cidrs.add(parsed.value.toLowerCase());
  });
  return cidrs;
}

function cidrSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((cidr) => right.has(cidr));
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

type ChannelProxy =
  | { readonly kind: "ip"; readonly address: string; readonly port: number }
  | { readonly kind: "managed"; readonly peer: KubernetesWorkloadPeer; readonly port: number };

function channelProxy(
  value: unknown,
  managedProxy?: KubernetesWorkloadPeer & { readonly hostname: string; readonly port: number },
): ChannelProxy {
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
  const port = Number(parsed.port);
  if (managedProxy !== undefined) {
    validatePeer(managedProxy, "Managed channel proxy");
    required(managedProxy.hostname, "Managed channel proxy hostname");
    if (
      !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?\.[a-z0-9]([-a-z0-9]*[a-z0-9])?\.svc$/.test(
        managedProxy.hostname,
      )
    ) {
      throw new ConfigurationFailure(
        "Managed channel proxy hostname must be the exact namespace-qualified Service DNS name.",
      );
    }
    if (
      !Number.isInteger(managedProxy.port) ||
      managedProxy.port < 1 ||
      managedProxy.port > 65535
    ) {
      throw new ConfigurationFailure("Managed channel proxy port must be a valid TCP port.");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.hostname !== managedProxy.hostname ||
      port !== managedProxy.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new ConfigurationFailure(
        "Managed channel proxy URL must match the exact configured Service host and port.",
      );
    }
    return { kind: "managed", peer: managedProxy, port };
  }
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
  return { kind: "ip", address, port };
}

export function kubernetesNamespaceName(namespaceId: string): string {
  const id = required(namespaceId, "Platform Namespace ID");
  return `oce-${sha256Hex(id, 15)}`;
}

const KUBELET_LOG_UNAVAILABLE =
  /^unable to retrieve container logs for [a-z][a-z0-9+.-]{0,31}:\/\/[0-9a-f]{1,128}\r?\n?$/;

function previousKubernetesNamespaceName(namespaceId: string): string {
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

function isManagedKubernetesNamespaceName(name: string, namespaceId: string): boolean {
  return (
    name === kubernetesNamespaceName(namespaceId) ||
    name === previousKubernetesNamespaceName(namespaceId)
  );
}

export function kubernetesGatewayNamespaceName(namespaceId: string): string {
  return `oce-gateways-${sha256Hex(required(namespaceId, "Platform Namespace ID"), 24)}`;
}

/** Resolve the exact-owned storage target: shared tenant or two-cluster control namespace. */
export async function resolveKubernetesControlNamespace(
  client: CoreV1Api,
  namespaceId: string,
): Promise<{ readonly name: string }> {
  const discovered = await client.listNamespace({
    labelSelector: `openclaw.dev/gateway-namespace=${namespaceId}`,
    timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
  });
  if (!Array.isArray(discovered?.items) || discovered.items.length !== 1) {
    throw new OwnershipFailure("Canonical tenant storage requires exactly one namespace.");
  }
  const observed = discovered.items[0]!;
  const metadata = observed.metadata;
  const name = required(metadata?.name, "Canonical tenant storage namespace");
  if (
    metadata?.labels?.["openclaw.dev/gateway-namespace"] !== namespaceId ||
    metadata.annotations?.["openclaw.dev/namespace-id"] !== namespaceId
  ) {
    throw new OwnershipFailure("Refusing an unowned control-plane storage namespace.");
  }
  if (metadata.labels?.["openclaw.dev/namespace"] !== undefined) {
    verifiedKubernetesNamespace(metadata, namespaceId);
  } else if (
    name !== kubernetesGatewayNamespaceName(namespaceId) ||
    metadata.labels?.["app.kubernetes.io/managed-by"] !== MANAGER
  ) {
    throw new OwnershipFailure("Refusing an unowned control-plane storage namespace.");
  }
  if (observed.status?.phase !== "Active" || metadata.deletionTimestamp !== undefined) {
    throw new DependencyUnavailableError("Control-plane storage namespace is unavailable.");
  }
  return { name };
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
      !isManagedKubernetesNamespaceName(name, namespaceId) ||
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

// OCC admission requires every configured Agent entry to share this primary model.
// The isolated probe sets it explicitly instead of invoking native roster selection.
function harnessPrimaryModel(configuration: OpenClawConfigurationDocument): string {
  const agents = asRecord(configuration.agents);
  const defaults = asRecord(agents?.defaults);
  const selection =
    defaults?.model ??
    Object.values(asRecord(agents?.entries) ?? {})
      .map((entry) => asRecord(entry)?.model)
      .find((model) => model !== undefined);
  const model = typeof selection === "string" ? selection : asRecord(selection)?.primary;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new ConfigurationFailure("Harness authentication requires an explicit primary model.");
  }
  return model;
}

function harnessProbeConfiguration(configuration: OpenClawConfigurationDocument): object {
  const model = harnessPrimaryModel(configuration);
  const { providerId } = harnessModelAuthentication(configuration);
  const provider = asRecord(asRecord(asRecord(configuration.models)?.providers)?.[providerId]);
  const fragment = provider === undefined ? undefined : { ...provider };
  if (fragment !== undefined) {
    delete fragment.apiKey;
  }
  const containsReference = (value: unknown): boolean => {
    if (typeof value === "string") {
      return value.includes("${");
    }
    if (Array.isArray(value)) {
      return value.some(containsReference);
    }
    const record = asRecord(value);
    return (
      record !== undefined &&
      ((typeof record.source === "string" && typeof record.id === "string") ||
        Object.values(record).some(containsReference))
    );
  };
  const defaults = asRecord(asRecord(configuration.agents)?.defaults);
  const modelEntry = asRecord(asRecord(defaults?.models)?.[model]);
  if (containsReference(fragment) || containsReference(modelEntry)) {
    throw new ConfigurationFailure(
      "Selected model provider transport configuration cannot require additional Secret or environment references.",
    );
  }
  return {
    agents: {
      defaults: {
        model,
        models: { [model]: { ...modelEntry, agentRuntime: { id: "openclaw" } } },
      },
    },
    ...(fragment === undefined ? {} : { models: { providers: { [providerId]: fragment } } }),
  };
}

// The immutable model selection owns both native credential projection and probing.
function harnessModelAuthentication(configuration: OpenClawConfigurationDocument) {
  const providerId = splitModelRef(harnessPrimaryModel(configuration)).provider;
  if (providerId === "openai" || providerId === "codex") {
    return { providerId, environmentName: MODEL_API_KEY };
  }
  if (providerId === "anthropic") {
    return { providerId, environmentName: "ANTHROPIC_API_KEY" };
  }
  throw new ConfigurationFailure("Harness authentication requires a compatible model provider.");
}

function harnessModels(configuration: OpenClawConfigurationDocument): readonly string[] {
  const agents = asRecord(configuration.agents);
  const defaults = asRecord(agents?.defaults);
  const entries = Object.values(asRecord(agents?.entries) ?? {});
  const selections = [defaults?.model, ...entries.map((entry) => asRecord(entry)?.model)].filter(
    (value) => value !== undefined,
  );
  const models = selections.flatMap((selection) => {
    const value = asRecord(selection);
    return typeof selection === "string"
      ? [selection]
      : [value?.primary, ...(Array.isArray(value?.fallbacks) ? value.fallbacks : [])];
  });
  if (models.some((model) => typeof model !== "string" || model.trim().length === 0)) {
    throw new ConfigurationFailure("Harness authentication requires explicit model references.");
  }
  return [...new Set(models as string[])];
}

// A dedicated Codex Gateway entrypoint rewrites these settings at every start
// (excludeGatewayLocalCodexTools, pinCodexProviderTransport) and refuses to start
// on a shape it cannot rewrite. Reject those shapes here, before a deployment
// replaces a working Gateway with one that crash-loops. null and absent values
// are replaced at start, so they are accepted. The caller owns this Configuration,
// so the error names the setting path and admission returns it as invalid content.
function requireCodexGatewayConfigurationShape(configuration: OpenClawConfigurationDocument): void {
  const unsupported = (path: string, shape: string) =>
    new ConfigurationHarnessError(
      `Configuration setting ${path} must be ${shape}: a dedicated Codex Gateway cannot apply it otherwise.`,
    );
  const object = (value: unknown, path: string): Record<string, unknown> | undefined => {
    if (value === undefined || value === null) {
      return undefined;
    }
    const record = asRecord(value);
    if (record === undefined) {
      throw unsupported(path, "an object");
    }
    return record;
  };
  const codex = asRecord(asRecord(asRecord(configuration.plugins)?.entries)?.codex);
  if (codex !== undefined) {
    const excluded = object(codex.config, "plugins.entries.codex.config")?.codexDynamicToolsExclude;
    if (excluded !== undefined && excluded !== null && !Array.isArray(excluded)) {
      throw unsupported("plugins.entries.codex.config.codexDynamicToolsExclude", "a list");
    }
    object(object(configuration.cron, "cron")?.triggers, "cron.triggers");
  }
  const providers = object(object(configuration.models, "models")?.providers, "models.providers");
  for (const [key, provider] of Object.entries(providers ?? {})) {
    // The entrypoint matches provider keys as OpenClaw does: trimmed, lowercased.
    const id = key.trim().toLowerCase();
    if (id !== "codex" && id !== "openai") {
      continue;
    }
    const row = asRecord(provider);
    if (row === undefined) {
      throw unsupported(`models.providers.${key}`, "an object");
    }
    if (
      row.models !== undefined &&
      (!Array.isArray(row.models) || !row.models.every((model) => asRecord(model) !== undefined))
    ) {
      throw unsupported(`models.providers.${key}.models`, "a list of objects");
    }
  }
}

function nativeRuntimeConfiguration(configuration: OpenClawConfigurationDocument): object {
  const models = harnessModels(configuration);
  const configuredAgentIds = Object.keys(asRecord(asRecord(configuration.agents)?.entries) ?? {});
  const agentIds = configuredAgentIds.length === 0 ? ["main"] : configuredAgentIds;
  const providers = asRecord(asRecord(configuration.models)?.providers);
  const openai = asRecord(providers?.openai);
  if (openai === undefined || !Array.isArray(openai.models)) {
    throw new ConfigurationFailure(
      "Dedicated OpenClaw requires an explicit native OpenAI model catalog.",
    );
  }
  if (openai.headers !== undefined) {
    throw new ConfigurationFailure(
      "Dedicated OpenClaw does not support provider headers from Agent Configuration.",
    );
  }
  const entries = openai.models.map((value) => asRecord(value));
  const runtimeModels = models.map((reference) => {
    const { provider, id } = splitModelRef(reference);
    if (provider !== "openai" || !id) {
      throw new ConfigurationFailure(
        "Dedicated OpenClaw currently requires explicit openai model references.",
      );
    }
    const matches = entries.filter((entry) => entry?.id === id || entry?.id === reference);
    if (matches.length !== 1) {
      throw new ConfigurationFailure(
        `Dedicated OpenClaw model metadata is missing or ambiguous for ${reference}.`,
      );
    }
    const entry = matches[0]!;
    if (entry.headers !== undefined) {
      throw new ConfigurationFailure(
        "Dedicated OpenClaw does not support model headers from Agent Configuration.",
      );
    }
    const api = entry.api ?? openai.api;
    const baseUrl = entry.baseUrl ?? openai.baseUrl;
    const contextWindow = entry.contextWindow ?? openai.contextWindow;
    const maxTokens = entry.maxTokens ?? openai.maxTokens;
    const cost = asRecord(entry.cost ?? openai.cost);
    if (
      !isNonEmptyString(api) ||
      !isNonEmptyString(baseUrl) ||
      !Number.isSafeInteger(contextWindow) ||
      (contextWindow as number) <= 0 ||
      !Number.isSafeInteger(maxTokens) ||
      (maxTokens as number) <= 0 ||
      cost === undefined ||
      ["input", "output", "cacheRead", "cacheWrite"].some(
        (key) => typeof cost[key] !== "number" || !Number.isFinite(cost[key]) || cost[key] < 0,
      )
    ) {
      throw new ConfigurationFailure(
        `Dedicated OpenClaw requires API, endpoint, token limits, and cost metadata for ${reference}.`,
      );
    }
    let endpoint: URL;
    try {
      endpoint = new URL(baseUrl as string);
    } catch {
      throw new ConfigurationFailure(
        `Dedicated OpenClaw endpoint metadata is invalid for ${reference}.`,
      );
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.hostname !== "api.openai.com" ||
      endpoint.port !== "" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.search !== "" ||
      endpoint.hash !== "" ||
      endpoint.pathname.replace(/\/$/u, "") !== "/v1"
    ) {
      throw new ConfigurationFailure(
        `Dedicated OpenClaw requires the approved OpenAI API endpoint for ${reference}.`,
      );
    }
    if (entry.reasoning !== undefined && typeof entry.reasoning !== "boolean") {
      throw new ConfigurationFailure(
        `Dedicated OpenClaw reasoning metadata is invalid for ${reference}.`,
      );
    }
    const input = entry.input;
    if (
      input !== undefined &&
      (!Array.isArray(input) ||
        input.length === 0 ||
        input.some((kind) => kind !== "text" && kind !== "image"))
    ) {
      throw new ConfigurationFailure(
        `Dedicated OpenClaw input metadata is invalid for ${reference}.`,
      );
    }
    const thinkingLevelMap = asRecord(entry.thinkingLevelMap);
    if (
      entry.thinkingLevelMap !== undefined &&
      (thinkingLevelMap === undefined ||
        Object.values(thinkingLevelMap).some(
          (value) => value !== null && typeof value !== "string",
        ))
    ) {
      throw new ConfigurationFailure(
        `Dedicated OpenClaw thinking metadata is invalid for ${reference}.`,
      );
    }
    return {
      provider,
      id,
      api,
      baseUrl,
      ...(isNonEmptyString(entry.name) ? { name: entry.name } : {}),
      contextWindow,
      maxTokens,
      ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
      ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
      cost: {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead,
        cacheWrite: cost.cacheWrite,
      },
      ...(input === undefined ? {} : { input }),
      apiKeyEnv: MODEL_API_KEY,
    };
  });
  return {
    models: runtimeModels,
    workspaces: agentIds.map((id) => ({
      id,
      path: NATIVE_WORKER_WORKSPACE_ROOT,
      scope: "subdirectories",
      models,
    })),
  };
}

function nativeRuntimeSnapshot(revision: AgentRevision): NativeRuntimeSnapshot | undefined {
  if (revision.harness.id !== "openclaw" || revision.harness.mode !== "dedicated") {
    return undefined;
  }
  const defaults = asRecord(asRecord(revision.configuration.agents)?.defaults);
  const embeddedAgent = asRecord(defaults?.embeddedAgent);
  if (embeddedAgent?.runtimeServer !== undefined) {
    throw new ConfigurationFailure(
      "Dedicated OpenClaw runtime transport is owned by the selected Compute Driver.",
    );
  }
  return {
    configuration: JSON.stringify(nativeRuntimeConfiguration(revision.configuration)),
  };
}

function requireNativeWorkerSandbox(
  harness: RevisionHarnessDescriptor,
  sandboxDriver: SandboxDriver | undefined,
): void {
  if (harness.id !== "openclaw" || harness.mode !== "dedicated") {
    return;
  }
  const requiredFacets = ["networking", "filesystem", "process"] as const;
  if (
    sandboxDriver?.provisionHarness === undefined ||
    requiredFacets.some((facet) => !sandboxDriver.facets.includes(facet))
  ) {
    throw new ConfigurationFailure(
      "Dedicated OpenClaw requires a provisioning SandboxDriver with networking, filesystem, and process containment.",
    );
  }
}

function gatewayConfigurationDocument(
  revision: AgentRevision,
  nativeRuntime: NativeRuntimeSnapshot | undefined,
): OpenClawConfigurationDocument {
  if (nativeRuntime === undefined) {
    return revision.configuration;
  }
  const cloudWorkers = asRecord(revision.configuration.cloudWorkers) ?? {};
  const profiles = asRecord(cloudWorkers.profiles) ?? {};
  if (profiles[NATIVE_WORKER_PROFILE] !== undefined) {
    throw new ConfigurationFailure(
      `Dedicated OpenClaw profile ${NATIVE_WORKER_PROFILE} is owned by the selected Compute Driver.`,
    );
  }
  const document = structuredClone(revision.configuration);
  const openai = asRecord(asRecord(asRecord(document.models)?.providers)?.openai);
  if (openai !== undefined) {
    delete openai.apiKey;
  }
  return document;
}

export class KubernetesComputeDriver implements ComputeDriver {
  readonly discoverHarnessModels = discoverHarnessModels;
  readonly startHarnessDeviceAuthorization = startHarnessDeviceAuthorization;
  readonly pollHarnessDeviceAuthorization = pollHarnessDeviceAuthorization;

  requiresStoppedPredecessors(revision: AgentRevision): boolean {
    return revision.harness.mode === "dedicated";
  }

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
      executionCluster: {
        type: "object",
        required: ["authentication", "harnessRouting", "network"],
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
          harnessRouting: {
            type: "object",
            required: ["hostname", "gatewayName", "gatewayNamespace", "envoyNamespace"],
            additionalProperties: false,
            properties: {
              hostname: { type: "string" },
              gatewayName: { type: "string" },
              gatewayNamespace: { type: "string" },
              envoyNamespace: { type: "string" },
              envoyHttpsTargetPort: { type: "integer", minimum: 1, maximum: 65535 },
            },
          },
          caBundle: { type: "string", minLength: 1 },
          network: {
            type: "object",
            additionalProperties: false,
            required: [
              "dns",
              "harnessEndpointCidrs",
              "gatewayEndpointCidrs",
              "pluginStatusProxySourceCidrs",
            ],
            properties: {
              dns: WORKLOAD_PEER_SCHEMA,
              harnessEndpointCidrs: { type: "array", minItems: 1, items: { type: "string" } },
              gatewayEndpointCidrs: { type: "array", minItems: 1, items: { type: "string" } },
              pluginStatusProxySourceCidrs: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
              },
            },
          },
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
        required: ["dns", "gatewayPort", "gatewayTrustedProxyCidrs"],
        additionalProperties: false,
        properties: {
          dns: WORKLOAD_PEER_SCHEMA,
          gatewayPort: { type: "integer" },
          gatewayTrustedProxyCidrs: { type: "array", items: { type: "string" } },
          gatewayClients: { type: "array", items: WORKLOAD_PEER_SCHEMA },
          pluginStatusProxySourceCidrs: { type: "array", items: { type: "string" } },
          repositoryCredentials: {
            type: "object",
            required: ["namespace", "podLabels", "port"],
            additionalProperties: false,
            properties: {
              ...WORKLOAD_PEER_SCHEMA.properties,
              port: { type: "integer", minimum: 1, maximum: 65535 },
            },
          },
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
        required: ["transportSecretPrefix", "gatewayStorageClassName"],
        additionalProperties: false,
        properties: {
          transportSecretPrefix: { type: "string" },
          gatewayStorageClassName: { type: "string", minLength: 1 },
          nativeOpenClawSessionCapacity: { type: "integer", minimum: 1, maximum: 1024 },
          nodeSelector: { type: "object", additionalProperties: { type: "string" } },
          gatewayNodeSelector: { type: "object", additionalProperties: { type: "string" } },
          codexSeccompProfile: { type: "string", minLength: 1 },
          channels: {
            type: "object",
            required: ["proxyUrl"],
            additionalProperties: false,
            properties: {
              proxyUrl: { type: "string" },
              managedProxy: {
                type: "object",
                required: ["hostname", "namespace", "podLabels", "port"],
                additionalProperties: false,
                properties: {
                  hostname: { type: "string" },
                  namespace: { type: "string" },
                  podLabels: { type: "object", additionalProperties: { type: "string" } },
                  port: { type: "integer" },
                },
              },
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
          endpointPort: { type: "integer", minimum: 1, maximum: 65535 },
          gatewayName: { type: "string" },
          gatewayNamespace: { type: "string" },
          envoyNamespace: { type: "string" },
          envoyHttpsTargetPort: { type: "integer", minimum: 1, maximum: 65535 },
          sandbox: {
            type: "object",
            required: ["domain"],
            additionalProperties: false,
            properties: {
              domain: { type: "string" },
              publicPort: { type: "integer", minimum: 1, maximum: 65535 },
            },
          },
        },
      },
    },
  });

  readonly id: string;
  readonly capability = "compute" as const;
  readonly implementation: string;
  readonly supportsWorkspaceSetup = true as const;
  readonly requiresAgentRuntimeCredentials?: true;
  readonly agentProvisioning = Object.freeze({
    executionModes: Object.freeze(["dedicated"] as const),
  });
  private readonly options: KubernetesComputeDriverOptions;
  private readonly sandboxDriver: SandboxDriver | undefined;
  private readonly credentialGatewayDriver: CredentialGatewayDriver | undefined;
  private readonly nodeEnrollment: GatewayNodeEnrollment | undefined;
  // How long, in total across passes, preparation may wait for one setup's node to pair.
  private workspaceNodePairingWaitMs = WORKSPACE_NODE_PAIRING_WAIT_MS;
  // Pairing wait already spent per workspace node setup ID.
  private readonly workspaceNodePairingSpentMs = new Map<string, number>();
  // How long, in total across activation attempts, one binding's ack may be awaited.
  private workspaceNodeBindingAckWaitMs = WORKSPACE_NODE_BINDING_ACK_TIMEOUT_MS;
  // Ack wait already spent per revision and workspace node.
  private readonly workspaceNodeBindingAckSpentMs = new Map<string, number>();
  private delay: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  private now: () => number = () => Date.now();
  private readonly readNodeCa: (() => Promise<string | undefined>) | undefined;
  private lifecycle: ComputeLifecycleDispatcher;
  private lifecycleOwners: readonly LifecycleOwnerSelection[];
  private lifecycleStarted = false;
  private apiClients: Promise<KubernetesApiClients> | undefined;
  private executionApiClients: Promise<KubernetesApiClients> | undefined;
  private patchOptions:
    ReturnType<typeof import("@kubernetes/client-node").setHeaderOptions> | undefined;
  private mergePatchOptions:
    ReturnType<typeof import("@kubernetes/client-node").setHeaderOptions> | undefined;

  static validateConfiguration(configuration: unknown): void {
    const candidate = asRecord(configuration);
    if (candidate === undefined) {
      throw new ConfigurationFailure("Kubernetes options are required.");
    }
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
      if (!isAbsolute(path)) {
        throw new ConfigurationFailure("Dedicated kubeconfig path must be absolute.");
      }
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
    validateResources(options.resources.gateway, "Gateway", "resources.gateway");
    validateResources(options.resources.agent, "Agent", "resources.agent");
    validateResources(
      options.resources.namespace.containerDefaults,
      "Namespace default",
      "resources.namespace.containerDefaults",
    );
    const quota = asRecord(options.resources.namespace.quota);
    if (quota === undefined || Object.keys(quota).length === 0) {
      throw new ConfigurationFailure("Namespace resource quota must be configured.");
    }
    for (const [key, quantity] of Object.entries(quota)) {
      required(key, "Quota resource");
      resourceQuantity(quantity, `Quota ${key}`, `resources.namespace.quota.${key}`);
    }
    if (asRecord(options.network) === undefined) {
      throw new ConfigurationFailure("Network policy is required.");
    }
    validatePeer(options.network.dns, "DNS peer");
    validatePort(options.network.gatewayPort, "Gateway port");
    trustedProxyCidrSet(options.network.gatewayTrustedProxyCidrs, "Trusted proxy CIDR");
    if (options.network.pluginStatusProxySourceCidrs !== undefined) {
      if (!Array.isArray(options.network.pluginStatusProxySourceCidrs)) {
        throw new ConfigurationFailure("Plugin status proxy source CIDRs must be an array.");
      }
      options.network.pluginStatusProxySourceCidrs.forEach((cidr, index) =>
        validateCidr(cidr, `Plugin status proxy CIDR ${index}`),
      );
    }
    if (options.network.repositoryCredentials !== undefined) {
      validatePeer(options.network.repositoryCredentials, "Repository credential gateway");
      validatePort(
        options.network.repositoryCredentials.port,
        "Repository credential gateway port",
      );
    }
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
      const { transportSecretPrefix, channels } = options.runtime;
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
      required(options.runtime.gatewayStorageClassName, "SQLite-compatible gateway storage class");
      const nativeOpenClawSessionCapacity = options.runtime.nativeOpenClawSessionCapacity;
      if (
        nativeOpenClawSessionCapacity !== undefined &&
        (!Number.isSafeInteger(nativeOpenClawSessionCapacity) ||
          nativeOpenClawSessionCapacity < 1 ||
          nativeOpenClawSessionCapacity > 1024)
      ) {
        throw new ConfigurationFailure(
          "Native OpenClaw session capacity must be an integer between 1 and 1024.",
        );
      }
      if (options.runtime.codexSeccompProfile !== undefined) {
        validateCodexSeccompProfile(options.runtime.codexSeccompProfile);
      }
      if (channels !== undefined) {
        if (asRecord(channels) === undefined) {
          throw new ConfigurationFailure("Channel runtime proxy must be explicitly configured.");
        }
        channelProxy(channels.proxyUrl, channels.managedProxy);
      }
    }
    if (options.executionCluster !== undefined) {
      const execution = options.executionCluster;
      if (asRecord(execution) === undefined || execution.authentication?.mode !== "kubeconfig") {
        throw new ConfigurationFailure(
          "The execution cluster requires its own explicit kubeconfig.",
        );
      }
      if (options.runtime === undefined || !options.gatewayRouting?.hostname) {
        throw new ConfigurationFailure(
          "Two-cluster execution requires runtime storage and an explicit CP routing hostname.",
        );
      }
      const { executionCluster: _executionCluster, ...control } = options;
      const { gatewayClients: _gatewayClients, ...network } = options.network;
      KubernetesComputeDriver.validateConfiguration({
        ...control,
        authentication: execution.authentication,
        gatewayRouting: execution.harnessRouting,
        network: { ...network, dns: execution.network?.dns },
      });
      validateDnsHostname(
        required(execution.harnessRouting?.hostname, "Harness routing hostname"),
        "Harness routing hostname",
      );
      for (const [description, cidrs] of [
        ["Harness endpoint", execution.network?.harnessEndpointCidrs],
        ["Gateway endpoint", execution.network?.gatewayEndpointCidrs],
        ["Execution status proxy", execution.network?.pluginStatusProxySourceCidrs],
      ] as const) {
        if (!Array.isArray(cidrs) || cidrs.length === 0) {
          throw new ConfigurationFailure(`${description} CIDRs must be explicit and nonempty.`);
        }
        for (const cidr of cidrs) {
          validateCidr(cidr, description);
          if (cidr.endsWith("/0")) {
            throw new ConfigurationFailure(`${description} must not allow all addresses.`);
          }
        }
      }
      if (execution.caBundle !== undefined) {
        const certificates = execution.caBundle.match(
          /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
        );
        if (
          !certificates?.length ||
          execution.caBundle
            .replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "")
            .trim()
        ) {
          throw new ConfigurationFailure("Execution trust must contain only PEM certificates.");
        }
        try {
          for (const certificate of certificates) {
            new X509Certificate(certificate);
          }
        } catch {
          throw new ConfigurationFailure("Execution trust contains an invalid certificate.");
        }
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
      validatePort(routing.endpointPort ?? 443, "Gateway routing endpoint port");
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
      validatePort(routing.envoyHttpsTargetPort ?? 10443, "Envoy HTTPS target port");
      if (routing.sandbox !== undefined) {
        validateDnsHostname(required(routing.sandbox.domain, "Sandbox domain"), "Sandbox domain");
        validatePort(routing.sandbox.publicPort ?? 443, "Public sandbox port");
        validatePort(options.network.gatewayPort + 1, "Gateway sandbox port");
        if (options.runtime === undefined) {
          throw new ConfigurationFailure("Sandbox routing requires a native Gateway runtime.");
        }
      }
    }
  }

  constructor(
    options: KubernetesComputeDriverOptions,
    selection: {
      readonly id?: string;
      readonly implementation?: string;
      readonly lifecycleDrivers?: readonly Driver[];
      readonly sandboxDriver?: SandboxDriver;
      readonly credentialGatewayDriver?: CredentialGatewayDriver;
      readonly nodeEnrollment?: GatewayNodeEnrollment;
      readonly readNodeCa?: () => Promise<string | undefined>;
    } = {},
  ) {
    KubernetesComputeDriver.validateConfiguration(options);
    this.id = required(selection.id ?? "compute-kubernetes-local", "Kubernetes Compute Driver ID");
    this.implementation = required(
      selection.implementation ?? "kubernetes-local",
      "Kubernetes Compute Driver implementation",
    );
    this.options = options;
    if (options.runtime !== undefined) {
      this.requiresAgentRuntimeCredentials = true;
    }
    this.sandboxDriver = selection.sandboxDriver;
    if (selection.credentialGatewayDriver !== undefined && selection.sandboxDriver === undefined) {
      throw new ConfigurationFailure(
        "The Credential Gateway Driver requires a paired Sandbox Driver.",
      );
    }
    this.credentialGatewayDriver = selection.credentialGatewayDriver;
    this.nodeEnrollment = selection.nodeEnrollment;
    this.readNodeCa = selection.readNodeCa;
    const lifecycleDrivers = selection.lifecycleDrivers ?? [];
    this.lifecycle = new ComputeLifecycleDispatcher(lifecycleDrivers);
    this.lifecycleOwners = lifecycleOwnerSelection(lifecycleDrivers);
  }

  setLifecycleDrivers(drivers: readonly Driver[]): void {
    if (this.lifecycleStarted) {
      if (sameLifecycleOwners(this.lifecycleOwners, drivers)) {
        return;
      }
      throw new Error("Compute lifecycle owners cannot change after lifecycle operations begin.");
    }
    this.lifecycleOwners = lifecycleOwnerSelection(drivers);
    this.lifecycle = new ComputeLifecycleDispatcher(drivers);
  }

  async preflight(): Promise<ComputePreflightResult> {
    const warnings: { code: "KUBERNETES_VERSION_BELOW_MINIMUM"; message: string }[] = [];
    let controlIdentity: string | undefined;
    const planes =
      this.options.executionCluster === undefined
        ? (["control"] as const)
        : (["control", "execution"] as const);
    for (const plane of planes) {
      const clients = await this.clients(plane);
      const reachable = <T>(operation: () => Promise<T>) =>
        this.request(operation).catch((error: unknown) => {
          throw unreachableKubernetesApi(clients.server, error);
        });
      const observedVersion = kubernetesVersion(
        (await reachable(() => clients.version.getCode())).gitVersion,
      );
      let continuation: string | undefined;
      do {
        const namespaces = await reachable(() =>
          clients.core.listNamespace({
            limit: this.options.executionCluster === undefined ? 100 : 1,
            ...(continuation === undefined ? {} : { _continue: continuation }),
            ...(this.options.executionCluster === undefined
              ? { labelSelector: "openclaw.dev/gateway-namespace" }
              : {}),
            timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
          }),
        );
        if (!Array.isArray(namespaces.items)) {
          throw new Error(
            "The authenticated Kubernetes Namespace preflight returned invalid data.",
          );
        }
        if (this.options.executionCluster === undefined) {
          for (const namespace of namespaces.items) {
            const metadata = namespace.metadata;
            const namespaceId = metadata?.labels?.["openclaw.dev/gateway-namespace"];
            if (
              isNonEmptyString(namespaceId) &&
              metadata?.name === kubernetesGatewayNamespaceName(namespaceId) &&
              metadata.labels?.["openclaw.dev/namespace"] === undefined
            ) {
              throw new ConfigurationFailure(
                "Existing split-layout Gateway storage prevents this single-cluster upgrade. " +
                  "Keep the previous controller version and preserve both namespaces, their " +
                  "Secrets and PVCs. See the Kubernetes Compute upgrade requirements.",
              );
            }
          }
        }
        continuation =
          this.options.executionCluster === undefined
            ? namespaces.metadata?._continue || undefined
            : undefined;
      } while (continuation !== undefined);
      if (versionIsOlder(observedVersion.parts, MINIMUM_KUBERNETES_VERSION_PARTS)) {
        warnings.push({
          code: "KUBERNETES_VERSION_BELOW_MINIMUM",
          message: `Kubernetes ${observedVersion.normalized} is below the supported minimum ${MINIMUM_KUBERNETES_VERSION}.`,
        });
      }
      if (this.options.executionCluster !== undefined) {
        const system = await this.request(() =>
          clients.core.readNamespace({ name: "kube-system" }),
        );
        const identity = required(system.metadata?.uid, "Kubernetes cluster identity");
        if (plane === "control") {
          controlIdentity = identity;
        } else if (identity === controlIdentity) {
          throw new ConfigurationFailure(
            "The execution target must be a distinct Kubernetes cluster.",
          );
        }
      }
    }
    return { warnings };
  }

  validateRepositoryCredentialSupport(sandboxDriverId?: string): void {
    // TODO(two-cluster acceptance): qualify a routable, authenticated repository
    // credential endpoint before allowing this currently cluster-local service.
    if (this.options.executionCluster !== undefined) {
      throw new ConfigurationFailure(
        "Repository credential delivery is not supported by the experimental two-cluster profile.",
      );
    }
    if (
      this.options.runtime === undefined ||
      this.options.network.repositoryCredentials === undefined ||
      sandboxDriverId !== undefined ||
      this.sandboxDriver !== undefined
    ) {
      throw new ConfigurationFailure(
        "Repository credentials require a configured Kubernetes runtime and credential endpoint without a SandboxDriver.",
      );
    }
  }

  validateRepositoryCredentials(
    harness: RevisionHarnessDescriptor,
    sandboxDriverId?: string,
  ): void {
    this.validateRepositoryCredentialSupport(sandboxDriverId);
    if (!(
      (harness.id === "openclaw" && harness.mode === "embedded") ||
      (harness.id === "codex" && harness.mode === "dedicated")
    )) {
      throw new ConfigurationFailure(
        "Repository credentials require an embedded OpenClaw or dedicated Codex Kubernetes runtime.",
      );
    }
  }

  validateAgentProvisioning(input: ComputeAgentProvisioningInput): void {
    if (input.executionMode !== "dedicated") {
      throw new ConfigurationFailure(
        "Kubernetes Agent provisioning supports only dedicated execution mode.",
      );
    }
    const configuration = this.kubernetesGatewayConfigurationDocument(input.configuration);
    this.verifyGatewayRoutingConfiguration({
      configuration,
      harness: { id: "codex", version: "provisioning", mode: "dedicated" },
    });
  }

  validateHarnessAuth(
    harness: RevisionHarnessDescriptor,
    auth: HarnessAuthSnapshot,
    configuration: OpenClawConfigurationDocument,
    secretBindings?: SecretBindings,
    credentialSourceType?: CredentialSourceType,
  ): void {
    requireNativeWorkerSandbox(harness, this.sandboxDriver);
    const openclaw = harness.id === "openclaw";
    const embedded = harness.mode === "embedded" && openclaw;
    const dedicated = harness.mode === "dedicated";
    const codex = dedicated && harness.id === "codex";
    const native = dedicated && openclaw;
    if (native && asRecord(configuration.cloudWorkers)?.requiredProfile !== undefined) {
      throw new ConfigurationFailure(
        `Dedicated OpenClaw required profile ${NATIVE_WORKER_PROFILE} is owned by the selected Compute Driver.`,
      );
    }
    if (
      (!embedded && !codex && !native) ||
      !auth ||
      (auth.method !== "api_key" &&
        auth.method !== "codex_pat" &&
        auth.method !== "oauth" &&
        auth.method !== "chatgpt_service_account" &&
        auth.method !== "credential_source") ||
      (embedded && auth.method !== "api_key")
    ) {
      throw new ConfigurationFailure(
        "Harness authentication is incompatible with the selected topology.",
      );
    }
    // Reject here, before a deployment stops predecessors, not only during preparation.
    if (auth.method === "oauth" && (!codex || this.sandboxDriver !== undefined)) {
      throw new ConfigurationFailure("OAuth requires the Compute-owned dedicated Codex Harness.");
    }
    if (
      auth.method === "chatgpt_service_account" &&
      (auth.credential.kind !== "access_token" ||
        auth.credential.secretRef.name !==
          `service-account-${sha256Hex(required(auth.serviceAccountId, "ServiceAccount ID"), 32)}` ||
        auth.credential.secretRef.key !== SERVICE_ACCOUNT_TOKEN_KEY)
    ) {
      throw new OwnershipFailure(
        "Harness authentication credential does not match the admitted account.",
      );
    }
    if (auth.method === "credential_source") {
      // The paired Sandbox injects the credential, so this path never projects a model Secret.
      if (
        this.sandboxDriver === undefined ||
        this.credentialGatewayDriver === undefined ||
        auth.credentialGatewayId !== this.credentialGatewayDriver.id ||
        credentialSourceType?.type !== auth.sourceType ||
        credentialSourceType.harnessAuth?.loginMode !== "api_key" ||
        credentialSourceType.harnessAuth.modelProvider !== "openai"
      ) {
        throw new ConfigurationFailure(
          "Credential-source Harness authentication requires the paired Sandbox and an OpenAI API key source.",
        );
      }
    }
    const agents = asRecord(configuration.agents);
    const defaults = asRecord(agents?.defaults);
    const entries = Object.values(asRecord(agents?.entries) ?? {});
    const selections = [defaults?.model, ...entries.map((entry) => asRecord(entry)?.model)].filter(
      (value) => value !== undefined,
    );
    const models = selections.flatMap((selection) => {
      const value = asRecord(selection);
      return typeof selection === "string"
        ? [selection]
        : [value?.primary, ...(Array.isArray(value?.fallbacks) ? value.fallbacks : [])];
    });
    const authentication = harnessModelAuthentication(configuration);
    const prefixes = embedded
      ? [`${authentication.providerId}/`]
      : native
        ? ["openai/"]
        : ["openai/", "codex/"];
    if (
      (embedded && authentication.providerId === "codex") ||
      models.length === 0 ||
      models.some(
        (model) =>
          typeof model !== "string" ||
          !prefixes.some((prefix) => model.startsWith(prefix) && model.length > prefix.length),
      )
    ) {
      throw new ConfigurationFailure(
        "Harness authentication requires a compatible model provider.",
      );
    }
    if (openclaw) {
      harnessProbeConfiguration(configuration);
    }
    if (native) {
      nativeRuntimeConfiguration(configuration);
    }
    if (codex) {
      requireCodexGatewayConfigurationShape(configuration);
    }
    const conflictingAuth = () =>
      new ConfigurationFailure("Model credentials must use the Harness authentication binding.");
    if (Object.keys(asRecord(configuration.auth) ?? {}).length > 0) {
      throw conflictingAuth();
    }
    const env = asRecord(configuration.env);
    for (const values of [env, asRecord(env?.vars)]) {
      if (
        Object.keys(values ?? {}).some((name) =>
          /^(?:OPENAI_|ANTHROPIC_|CODEX_(?:ACCESS_TOKEN|CHATGPT_WORKSPACE_ID|LOGIN_MODE)$)/i.test(
            name,
          ),
        )
      ) {
        throw conflictingAuth();
      }
    }
    const providers = asRecord(asRecord(configuration.models)?.providers) ?? {};
    const selectedProviders = new Set(
      models.map((model) => splitModelRef(model as string).provider),
    );
    for (const provider of selectedProviders) {
      const config = asRecord(providers[provider]);
      if (
        [config, ...(Array.isArray(config?.models) ? config.models : [])].some((model) =>
          Object.keys(asRecord(asRecord(model)?.headers) ?? {}).some((name) =>
            /^(?:authorization|api-key|x-api-key)$/i.test(name),
          ),
        )
      ) {
        throw conflictingAuth();
      }
      if (config?.apiKey === undefined) {
        continue;
      }
      if (!openclaw) {
        throw conflictingAuth();
      }
      if (config.apiKey === `\${${authentication.environmentName}}`) {
        continue;
      }
      const ref = asRecord(config.apiKey);
      const source =
        typeof ref?.provider === "string"
          ? asRecord(asRecord(asRecord(configuration.secrets)?.providers)?.[ref.provider])
          : undefined;
      if (
        !ref ||
        Object.keys(ref).length !== 3 ||
        ref.source !== "env" ||
        ref.id !== authentication.environmentName ||
        source?.source !== "env" ||
        (source.allowlist !== undefined &&
          (!Array.isArray(source.allowlist) ||
            !source.allowlist.includes(authentication.environmentName)))
      ) {
        throw conflictingAuth();
      }
    }
    this.validateChannelSecretBindings(configuration, secretBindings);
  }

  getGatewayEndpoint(revision: AgentRevision): string | undefined {
    const routing = this.options.gatewayRouting;
    if (routing === undefined) {
      return undefined;
    }
    const hostname = this.gatewayRoutingHostname(routing);
    const authority =
      routing.endpointPort === undefined || routing.endpointPort === 443
        ? hostname
        : `${hostname}:${routing.endpointPort}`;
    return `wss://${authority}${this.gatewayRoutePath(revision)}`;
  }

  async getAgentRuntimeCredentialStatus(
    binding: ComputeAgentBinding,
  ): Promise<AgentRuntimeCredentialStatus> {
    return this.withRuntimeCredentialErrors(async () => {
      const context = await this.runtimeCredentialContext(binding);
      const observed = await this.readRuntimeCredentialSecret(context);
      return {
        transportConfigured:
          observed.transport !== undefined &&
          (context.gatewayPassword === undefined || observed.gatewayPassword !== undefined),
      };
    });
  }

  async provisionAgentRuntimeCredentials(
    binding: ComputeAgentBinding,
    input: AgentRuntimeCredentialsInput,
  ): Promise<AgentRuntimeCredentialStatus> {
    return this.withRuntimeCredentialErrors(async () => {
      this.validRuntimeCredentialInput(input);
      const context = await this.runtimeCredentialContext(binding);
      const observed = await this.readRuntimeCredentialSecret(context);
      await this.assertNoAgentRuntimeDeployments(
        context,
        binding.agent.executionMode === "dedicated",
      );

      if (observed.transport === undefined) {
        await this.createRuntimeCredentialSecret(
          context,
          context.transport,
          Object.fromEntries(
            context.transport.keys.map((key) => [key, this.generateRuntimeCredentialToken()]),
          ),
        );
      }
      if (context.gatewayPassword !== undefined && observed.gatewayPassword === undefined) {
        await this.createRuntimeCredentialSecret(context, context.gatewayPassword, {
          [GATEWAY_PASSWORD_KEY]: this.generateRuntimeCredentialToken(),
        });
      }

      return { transportConfigured: true };
    });
  }

  async diagnoseAgentDeployment(
    binding: ComputeAgentRevisionBinding,
  ): Promise<AgentDeploymentDiagnostics> {
    const revision = binding.revision;
    if (
      revision.namespaceId !== binding.namespace.id ||
      revision.agentId !== binding.agent.id ||
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new ResourceConflictError("The Agent deployment diagnostic binding is invalid.");
    }
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const ownerSignal = currentComputeAbortSignal();
    const signal = ownerSignal === undefined ? deadline : AbortSignal.any([ownerSignal, deadline]);
    try {
      return await withComputeAbortSignal(signal, async () => {
        const { name: namespace, external } = await this.resolveNamespace(revision.namespaceId);
        const observedNamespace = await this.getNamespace(namespace);
        if (observedNamespace === undefined || observedNamespace.status?.phase !== "Active") {
          throw new DependencyUnavailableError(
            "The Agent deployment Kubernetes namespace is unavailable.",
          );
        }
        this.verifyNamespaceOwnership(
          observedNamespace,
          { namespaceId: revision.namespaceId },
          external,
        );
        const reports = await Promise.all(
          this.runtimeStatusContainers(revision).map(async (container) => {
            const checks = await this.runtimeDiagnosticChecks(revision, namespace, container);
            if (checks === undefined) {
              return [
                {
                  component: container,
                  check: "runtime-status",
                  state: "unknown",
                  checkedAt: null,
                  code: "UNAVAILABLE",
                } satisfies RuntimeDiagnosticCheck,
              ];
            }
            return checks;
          }),
        );
        return {
          revisionId: revision.id,
          observedAt: new Date().toISOString(),
          checks: reports.flat().slice(0, 32),
        };
      });
    } catch (error) {
      if (ownerSignal?.aborted) {
        throw ownerSignal.reason;
      }
      if (deadline.aborted) {
        throw new DependencyUnavailableError("Runtime diagnostics timed out.");
      }
      throw error;
    }
  }

  async describeAgentRuntime(
    binding: ComputeAgentRevisionBinding,
    signal: AbortSignal,
    options: AgentRuntimeDescribeOptions = {},
  ): Promise<AgentRuntimeDescription> {
    const revision = this.runtimeLogRevision(binding);
    const namespace = await this.runtimeLogNamespace(revision, signal);
    const pods: AgentRuntimePodStatus[] = [];
    const sources: AgentRuntimeLogSource[] = [];
    // A log read (every follow poll) asks for one source and no Events, which keeps
    // it to the Namespace read and one Pod list.
    const roles = this.runtimeStatusContainers(revision).filter(
      (role) => options.source === undefined || role === options.source,
    );
    for (const role of roles) {
      const target = role === "gateway" ? this.gatewayNamespace(revision, namespace) : namespace;
      // Terminating Pods are being replaced; their output is not offered as a source.
      const observed = (
        await this.runtimeLogStep(signal, () => this.revisionPods(revision, target, role))
      )
        .filter((pod) => asRecord(pod.metadata)?.deletionTimestamp === undefined)
        .slice(0, RUNTIME_LOG_MAX_PODS);
      const described = await Promise.all(
        observed.map(async (pod) => {
          const status = this.runtimePodStatus(pod, role, target);
          const events =
            options.events === false
              ? []
              : await this.runtimeLogStep(signal, () =>
                  this.runtimePodEvents(
                    target,
                    status.uid,
                    isNonEmptyString(asRecord(pod.spec)?.nodeName),
                  ),
                );
          return { ...status, events };
        }),
      );
      pods.push(...described);
      sources.push({
        id: role,
        kind: "container",
        pods: described.map((pod) => ({
          name: pod.name,
          uid: pod.uid,
          container: role,
          restartCount: pod.containers.find(({ name }) => name === role)?.restartCount ?? 0,
        })),
        available: described.length > 0,
        ...(described.length > 0 ? {} : { unavailableCode: "NO_POD" as const }),
        retention: RUNTIME_LOG_RETENTION,
      });
    }
    return {
      revisionId: revision.id,
      observedAt: new Date().toISOString(),
      pods,
      sources,
    };
  }

  async readAgentRuntimeLogs(
    binding: ComputeAgentRevisionBinding,
    request: AgentRuntimeLogRequest,
  ): Promise<AgentRuntimeLogChunk> {
    const revision = this.runtimeLogRevision(binding);
    const role = request.source;
    if (!this.runtimeStatusContainers(revision).includes(role) || request.container !== role) {
      throw new ResourceConflictError("The runtime log request does not match the revision.");
    }
    const signal = request.signal;
    const namespace = await this.runtimeLogNamespace(revision, signal);
    const target = role === "gateway" ? this.gatewayNamespace(revision, namespace) : namespace;
    // Ownership re-check: the named Pod must still carry this revision's labels and UID.
    const owned = (
      await this.runtimeLogStep(signal, () => this.revisionPods(revision, target, role))
    ).find(
      (pod) =>
        asRecord(pod.metadata)?.name === request.pod &&
        asRecord(pod.metadata)?.uid === request.podUid,
    );
    if (owned === undefined) {
      throw new DependencyUnavailableError("The runtime log Pod is no longer available.");
    }
    const clients = await this.clients(target.plane);
    let raw: string;
    try {
      raw = await this.runtimeLogStep(signal, () =>
        this.request(() =>
          clients.core.readNamespacedPodLog({
            name: request.pod,
            namespace: target.name,
            container: request.container,
            follow: false,
            limitBytes: request.limitBytes,
            previous: request.previous,
            ...(request.sinceSeconds === undefined ? {} : { sinceSeconds: request.sinceSeconds }),
            tailLines: request.tailLines,
            timestamps: true,
          }),
        ),
      );
    } catch (error) {
      // A container that never restarted has no previous instance.
      if (request.previous && numericErrorStatus(error) === 400) {
        raw = "";
      } else {
        throw error;
      }
    }
    if (typeof raw !== "string") {
      throw new DependencyUnavailableError("The Kubernetes client returned invalid log output.");
    }
    // While a crash-looping container is being replaced, kubelet answers 200 with its own
    // error text instead of container output. Every container line carries a timestamp,
    // so this untimestamped line is not output: the instance has no readable log yet.
    if (KUBELET_LOG_UNAVAILABLE.test(raw)) {
      raw = "";
    }
    // Re-read after the log read so the caller can detect a replaced instance.
    const latest = (
      await this.runtimeLogStep(signal, () => this.revisionPods(revision, target, role))
    ).find((pod) => asRecord(pod.metadata)?.name === request.pod);
    const latestStatus =
      latest === undefined ? undefined : this.runtimePodStatus(latest, role, target);
    const truncated = Buffer.byteLength(raw, "utf8") >= request.limitBytes;
    const lines = raw.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    return {
      stream: {
        source: role,
        pod: request.pod,
        podUid: latestStatus?.uid ?? request.podUid,
        container: request.container,
        restartCount:
          latestStatus?.containers.find(({ name }) => name === role)?.restartCount ??
          this.runtimePodStatus(owned, role, target).containers.find(({ name }) => name === role)
            ?.restartCount ??
          0,
      },
      observedAt: new Date().toISOString(),
      lines: lines.map((line) => {
        const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z) (.*)$/s.exec(line);
        return match === null ? { time: null, raw: line } : { time: match[1]!, raw: match[2]! };
      }),
      truncated,
    };
  }

  private runtimeLogRevision(binding: ComputeAgentRevisionBinding): AgentRevision {
    const revision = binding.revision;
    if (
      revision.namespaceId !== binding.namespace.id ||
      revision.agentId !== binding.agent.id ||
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new ResourceConflictError("The Agent runtime log binding is invalid.");
    }
    return revision;
  }

  private async runtimeLogNamespace(
    revision: AgentRevision,
    signal: AbortSignal,
  ): Promise<KubernetesNamespaceAddress> {
    const { name: namespace, external } = await this.runtimeLogStep(signal, () =>
      this.resolveNamespace(revision.namespaceId),
    );
    const observed = await this.runtimeLogStep(signal, () => this.getNamespace(namespace));
    if (observed === undefined || observed.status?.phase !== "Active") {
      throw new DependencyUnavailableError("The Agent Kubernetes namespace is unavailable.");
    }
    this.verifyNamespaceOwnership(observed, { namespaceId: revision.namespaceId }, external);
    return namespace;
  }

  /** One bounded Kubernetes step; a cluster 403 becomes a typed operator-facing error. */
  private async runtimeLogStep<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const step = AbortSignal.any([signal, AbortSignal.timeout(RUNTIME_LOG_CALL_TIMEOUT_MS)]);
    try {
      return await withComputeAbortSignal(step, operation);
    } catch (error) {
      if (numericErrorStatus(error) === 403) {
        throw new RuntimeLogsForbiddenByClusterError();
      }
      throw error;
    }
  }

  private runtimePodStatus(
    pod: KubernetesRecord,
    role: RuntimeLogContainerSourceId,
    namespace: KubernetesNamespaceAddress,
  ): Omit<AgentRuntimePodStatus, "events"> {
    const metadata = asRecord(pod.metadata) ?? {};
    const status = asRecord(pod.status) ?? {};
    const conditions = Array.isArray(status.conditions) ? status.conditions : [];
    const ready = conditions.some((condition) => {
      const value = asRecord(condition);
      return value?.type === "Ready" && value.status === "True";
    });
    const statuses = [
      ...(Array.isArray(status.initContainerStatuses) ? status.initContainerStatuses : []),
      ...(Array.isArray(status.containerStatuses) ? status.containerStatuses : []),
    ]
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => isNonEmptyString(entry?.name))
      .slice(0, 16);
    return {
      role,
      cluster:
        namespace.plane === "execution" && this.options.executionCluster !== undefined
          ? "execution"
          : "control",
      name: String(metadata.name),
      uid: String(metadata.uid),
      phase: isNonEmptyString(status.phase) ? status.phase : "Unknown",
      ready,
      createdAt: isNonEmptyString(metadata.creationTimestamp)
        ? String(metadata.creationTimestamp)
        : metadata.creationTimestamp instanceof Date
          ? metadata.creationTimestamp.toISOString()
          : null,
      containers: statuses.map((entry) => this.runtimeContainerStatus(entry)),
    };
  }

  private runtimeContainerStatus(entry: Record<string, unknown>): AgentRuntimeContainerStatus {
    const state = asRecord(entry.state) ?? {};
    const [kind, detail] = (["waiting", "running", "terminated"] as const)
      .map((name) => [name, asRecord(state[name])] as const)
      .find(([, value]) => value !== undefined) ?? ["unknown" as const, undefined];
    const last = asRecord(asRecord(entry.lastState)?.terminated);
    return {
      name: String(entry.name),
      state: kind,
      reason: isNonEmptyString(detail?.reason) ? detail.reason : null,
      ready: entry.ready === true,
      restartCount: Number.isSafeInteger(entry.restartCount) ? (entry.restartCount as number) : 0,
      startedAt: kubernetesTime(detail?.startedAt),
      lastTermination:
        last === undefined
          ? null
          : {
              reason: isNonEmptyString(last.reason) ? last.reason : null,
              exitCode: Number.isSafeInteger(last.exitCode) ? (last.exitCode as number) : null,
              finishedAt: kubernetesTime(last.finishedAt),
            },
    };
  }

  private async runtimePodEvents(
    namespace: KubernetesNamespaceAddress,
    podUid: string,
    scheduled: boolean,
  ): Promise<readonly AgentRuntimeEvent[]> {
    const clients = await this.clients(namespace.plane);
    const list = asRecord(
      await this.request(() =>
        clients.core.listNamespacedEvent({
          namespace: namespace.name,
          fieldSelector: `involvedObject.uid=${podUid}`,
          limit: RUNTIME_LOG_MAX_EVENTS,
          timeoutSeconds: Math.ceil(RUNTIME_LOG_CALL_TIMEOUT_MS / 1000),
        }),
      ),
    );
    if (!Array.isArray(list?.items)) {
      throw new DependencyUnavailableError("The Kubernetes client returned an invalid Event list.");
    }
    return list.items
      .map((item) => asRecord(item))
      .filter((event): event is Record<string, unknown> => {
        // The field selector is advisory to this code: keep only this Pod's Events.
        const involved = asRecord(event?.involvedObject);
        return (
          involved?.uid === podUid &&
          involved.kind === "Pod" &&
          (involved.namespace === undefined || involved.namespace === namespace.name) &&
          (event?.type === "Normal" || event?.type === "Warning") &&
          !settledSchedulingConflict(event, scheduled)
        );
      })
      .map((event) => {
        const series = asRecord(event.series);
        return {
          type: event.type as "Normal" | "Warning",
          container: runtimeEventContainer(asRecord(event.involvedObject)?.fieldPath),
          reason: isNonEmptyString(event.reason) ? event.reason : "Unknown",
          message: typeof event.message === "string" ? event.message : "",
          count: Math.max(
            1,
            Number.isSafeInteger(series?.count)
              ? (series!.count as number)
              : Number.isSafeInteger(event.count)
                ? (event.count as number)
                : 1,
          ),
          lastObservedAt:
            kubernetesTime(series?.lastObservedTime) ??
            kubernetesTime(event.lastTimestamp) ??
            kubernetesTime(event.eventTime) ??
            kubernetesTime(event.firstTimestamp),
        };
      })
      .sort((left, right) => (right.lastObservedAt ?? "").localeCompare(left.lastObservedAt ?? ""))
      .slice(0, RUNTIME_LOG_MAX_EVENTS);
  }

  async deleteAgentRuntimeCredentials(binding: ComputeAgentBinding): Promise<void> {
    await this.withRuntimeCredentialErrors(async () => {
      if (this.options.runtime === undefined) {
        const context = await this.agentResourceContext(binding);
        if (context !== undefined) {
          await this.deleteHarnessWorkspaceClaim(context.ownership, context.namespace);
        }
        return;
      }
      const namespaceId = required(binding.namespace?.id, "Runtime credential Namespace ID");
      const agentId = required(binding.agent?.id, "Runtime credential Agent ID");
      if (binding.agent.namespaceId !== namespaceId) {
        throw new ResourceConflictError("The Agent runtime credential binding is invalid.");
      }
      // A draft mode edit does not describe historical runtime placement. Final
      // Agent deletion checks selected targets, with ownership and UID fences.
      const target = await this.controlNamespace(namespaceId);
      const observed = await this.getNamespace(target);
      if (observed !== undefined) {
        if (this.options.executionCluster === undefined) {
          this.verifyNamespaceOwnership(
            observed,
            { namespaceId },
            observed.metadata.annotations?.["openclaw.dev/namespace-lifecycle"] === "external",
          );
        } else {
          this.verifyGatewayNamespace(observed, { namespaceId });
        }
        await this.deleteGatewayPrivateStateClaim({ namespaceId, agentId }, target);
        await this.deleteOwnedNamespacedResource(
          "ConfigMap",
          this.workspaceNodeBindingName(agentId),
          { namespaceId, agentId },
          target,
        );
        for (const name of [
          `${this.options.runtime.transportSecretPrefix}-${sha256Hex(agentId, 12)}`,
          `gateway-password-${sha256Hex(agentId, 12)}`,
        ]) {
          await this.deleteOwnedNamespacedResource(
            "Secret",
            name,
            { namespaceId, agentId },
            target,
          );
        }
      }
      const context = await this.agentResourceContext(binding);
      if (context === undefined) {
        return;
      }
      const transportName = `${this.options.runtime.transportSecretPrefix}-${context.suffix}`;
      validateKubernetesResourceName(transportName, "Agent runtime credential Secret name");
      // Only Agent deletion owns durable state. Revision retirement also runs after
      // stop, when no gateway remains to distinguish it from final teardown.
      await this.deleteGatewayPrivateStateClaim(context.ownership, context.namespace);
      await this.deleteHarnessWorkspaceClaim(context.ownership, context.namespace);
      await this.deleteWorkspaceNodes(agentId, context.ownership, context.namespace);
      const setupName = this.workspaceSetupSecretName(binding.agent.id);
      const setup = await this.getOwned("Secret", setupName, context.namespace, context.ownership);
      if (setup !== undefined) {
        const clients = await this.clients(context.namespace.plane);
        await this.request(
          () =>
            clients.core.deleteNamespacedSecret({
              name: setupName,
              namespace: context.namespace.name,
              body: {
                preconditions: { uid: required(setup.metadata.uid, "Workspace setup Secret UID") },
              },
            }),
          { mutating: true },
        );
      }
      await this.deleteOwnedNamespacedResource(
        "Secret",
        transportName,
        context.ownership,
        context.namespace,
      );
    });
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
    const namespace = await this.controlNamespace(namespaceId);
    const observed = await this.getNamespace(namespace);
    if (observed === undefined || observed.status?.phase !== "Active") {
      throw new OwnershipFailure("The ServiceAccount Kubernetes namespace is unavailable.");
    }
    this.verifyGatewayNamespace(observed, { namespaceId });

    const name = `service-account-${sha256Hex(serviceAccountId, 32)}`;
    const ownership = { namespaceId, serviceAccountId };
    const existing = await this.getOwned("Secret", name, namespace, ownership);
    if (existing !== undefined) {
      throw new ConfigurationFailure("The ServiceAccount credential Secret already exists.");
    }

    const clients = await this.clients(namespace.plane);
    await this.request(
      () =>
        clients.core.createNamespacedSecret({
          namespace: namespace.name,
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

    const namespace = await this.controlNamespace(namespaceId);
    const tenant = await this.getNamespace(namespace);
    if (tenant === undefined) {
      return;
    }
    this.verifyGatewayNamespace(tenant, { namespaceId });
    const existing = await this.getOwned("Secret", name, namespace, {
      namespaceId,
      serviceAccountId,
    });
    if (existing === undefined) {
      return;
    }
    const clients = await this.clients(namespace.plane);
    await this.request(
      () =>
        clients.core.deleteNamespacedSecret({
          name,
          namespace: namespace.name,
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
          : { name: { name: selection, plane: "execution" as const }, external: true };
      const { name, external: externallyManaged } = placement;
      if (externallyManaged && selection === undefined) {
        throw new OwnershipFailure(
          `Existing Kubernetes namespace ${name.name} was not explicitly selected.`,
        );
      }
      if (!externallyManaged) {
        const desired = this.manifest("v1", "Namespace", name.name, ownership);
        desired.metadata.labels = {
          ...desired.metadata.labels,
          ...this.gatewayMembershipLabels(this.options.executionCluster?.harnessRouting),
          ...(this.options.executionCluster === undefined
            ? { "openclaw.dev/gateway-namespace": ownership.namespaceId }
            : {}),
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/audit": "restricted",
          "pod-security.kubernetes.io/warn": "restricted",
        };
        await this.reconcile(desired, ownership, name);
      }
      const observed = await this.getNamespace(name);
      if (observed === undefined) {
        if (externallyManaged) {
          throw new OwnershipFailure(`Existing Kubernetes namespace ${name.name} does not exist.`);
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
          throw new OwnershipFailure(`Existing Kubernetes namespace ${name.name} must be active.`);
        }
        return result;
      }
      tenantAccessRequired = true;
      if (externallyManaged) {
        await this.verifyExistingNetworkPolicies(name, ownership);
        await this.claimExistingNamespace(observed, ownership);
      }
      await this.prepareNamespaceInfrastructure(ownership, name);
      if (!(await this.ensureGatewayNamespace(ownership))) {
        return result;
      }
      await this.lifecycle.afterNamespacePrepared(namespace);
      await this.sandboxDriver?.ensureNamespace?.(
        await this.sandboxNamespaceContext(namespace, name),
      );
      return { ...result, namespaceReady: true };
    } catch (error) {
      if (tenantAccessRequired && numericErrorStatus(error) === 403) {
        return result;
      }
      return { ...result, failure: failure(error) };
    }
  }

  private gatewayNamespace(
    revision: AgentRevision,
    harnessNamespace: KubernetesNamespaceAddress,
  ): KubernetesNamespaceAddress {
    return revision.harness.mode === "embedded" || this.options.executionCluster === undefined
      ? harnessNamespace
      : { name: kubernetesGatewayNamespaceName(revision.namespaceId), plane: "control" };
  }

  private gatewayNamespaceManifest(ownership: Ownership): ManagedKubernetesObject<"Namespace"> {
    const desired = this.manifest(
      "v1",
      "Namespace",
      this.options.executionCluster === undefined
        ? kubernetesNamespaceName(ownership.namespaceId)
        : kubernetesGatewayNamespaceName(ownership.namespaceId),
      ownership,
    );
    // Two-cluster tenant discovery must resolve only the execution target.
    if (this.options.executionCluster !== undefined) {
      delete desired.metadata.labels!["openclaw.dev/namespace"];
    }
    desired.metadata.labels = {
      ...desired.metadata.labels,
      "openclaw.dev/gateway-namespace": ownership.namespaceId,
      ...this.gatewayMembershipLabels(),
      "pod-security.kubernetes.io/enforce": "restricted",
      "pod-security.kubernetes.io/audit": "restricted",
      "pod-security.kubernetes.io/warn": "restricted",
    };
    return desired;
  }

  private verifyGatewayNamespace(
    namespace: ManagedKubernetesObject<"Namespace">,
    ownership: Ownership,
  ): void {
    if (this.options.executionCluster === undefined) {
      const external =
        namespace.metadata.annotations?.["openclaw.dev/namespace-lifecycle"] === "external";
      this.verifyNamespaceOwnership(namespace, ownership, external);
      if (namespace.metadata.labels?.["openclaw.dev/gateway-namespace"] !== ownership.namespaceId) {
        throw new OwnershipFailure("Refusing an unowned canonical storage namespace.");
      }
      return;
    }
    const desired = this.gatewayNamespaceManifest(ownership);
    if (
      namespace.metadata.name !== desired.metadata.name ||
      namespace.metadata.labels?.["openclaw.dev/namespace"] !== undefined ||
      namespace.metadata.annotations?.["openclaw.dev/namespace-id"] !== ownership.namespaceId ||
      Object.entries(desired.metadata.labels!).some(
        ([key, value]) => namespace.metadata.labels?.[key] !== value,
      )
    ) {
      throw new OwnershipFailure("Refusing an unowned control-plane Gateway namespace.");
    }
  }

  private async deleteGatewayNamespace(ownership: Ownership): Promise<boolean> {
    if (this.options.executionCluster === undefined) {
      return true;
    }
    const name = await this.controlNamespace(ownership.namespaceId);
    const existing = await this.getNamespace(name);
    if (existing === undefined) {
      return true;
    }
    this.verifyGatewayNamespace(existing, ownership);
    if (existing.metadata.deletionTimestamp !== undefined) {
      return false;
    }
    const clients = await this.clients(name.plane);
    await this.request(
      () =>
        clients.core.deleteNamespace({
          name: name.name,
          body: {
            preconditions: { uid: required(existing.metadata.uid, "Gateway namespace UID") },
          },
        }),
      { mutating: true },
    );
    return (await this.getNamespace(name)) === undefined;
  }

  private async ensureGatewayNamespace(ownership: Ownership): Promise<boolean> {
    if (this.options.executionCluster === undefined) {
      return true;
    }
    const desired = this.gatewayNamespaceManifest(ownership);
    const name = await this.controlNamespace(ownership.namespaceId);
    const existing = await this.getNamespace(name);
    if (existing !== undefined) {
      this.verifyGatewayNamespace(existing, ownership);
    }
    // Namespace resources have a separate discovery label, so use their own exact metadata owner.
    if (existing === undefined) {
      const clients = await this.clients(name.plane);
      await this.request(() => clients.core.createNamespace({ body: desired }), { mutating: true });
    }
    const observed = await this.getNamespace(name);
    if (observed === undefined) {
      return false;
    }
    this.verifyGatewayNamespace(observed, ownership);
    if (observed.status?.phase !== "Active" || observed.metadata.deletionTimestamp !== undefined) {
      return false;
    }
    await this.prepareNamespaceInfrastructure(ownership, name);
    return true;
  }

  private async requireGatewayNamespace(
    revision: AgentRevision,
    harnessNamespace: KubernetesNamespaceAddress,
  ): Promise<KubernetesNamespaceAddress> {
    const namespace = this.gatewayNamespace(revision, harnessNamespace);
    if (revision.harness.mode === "embedded" || this.options.executionCluster === undefined) {
      return namespace;
    }
    if (
      this.options.runtime !== undefined &&
      Object.keys(this.options.runtime.gatewayNodeSelector ?? {}).length === 0
    ) {
      throw new ConfigurationFailure(
        "Dedicated Gateways require runtime.gatewayNodeSelector for control-plane scheduling.",
      );
    }
    const observed = await this.getNamespace(namespace);
    if (observed === undefined) {
      throw new DependencyUnavailableError("The control-plane Gateway namespace is unavailable.");
    }
    this.verifyGatewayNamespace(observed, { namespaceId: revision.namespaceId });
    if (observed.status?.phase !== "Active" || observed.metadata.deletionTimestamp !== undefined) {
      throw new DependencyUnavailableError("The control-plane Gateway namespace is unavailable.");
    }
    return namespace;
  }

  private async prepareNamespaceInfrastructure(
    ownership: Ownership,
    name: KubernetesNamespaceAddress,
  ): Promise<void> {
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
  }

  async deleteNamespace(namespace: Namespace): Promise<NamespaceDeleteResult> {
    this.lifecycleStarted = true;
    const result = { namespaceId: namespace.id, namespaceDeleted: false };
    try {
      const clients = await this.clients("execution");
      const { name, external } =
        namespace.existingNamespace === undefined
          ? await this.resolveNamespace(namespace.id)
          : {
              name: { name: namespace.existingNamespace, plane: "execution" as const },
              external: true,
            };
      const ownership = { namespaceId: namespace.id };
      const existing = await this.getNamespace(name);
      if (
        existing === undefined ||
        (external &&
          existing.metadata.labels?.["openclaw.dev/namespace"] === undefined &&
          existing.metadata.annotations?.["openclaw.dev/namespace-id"] === undefined)
      ) {
        if (this.options.executionCluster !== undefined) {
          const gateway = await this.getNamespace(await this.controlNamespace(namespace.id));
          if (gateway !== undefined) {
            this.verifyGatewayNamespace(gateway, ownership);
          }
        }
        await this.lifecycle.beforeNamespaceDelete(namespace);
        return { ...result, namespaceDeleted: await this.deleteGatewayNamespace(ownership) };
      }
      this.verifyNamespaceOwnership(existing, ownership, external);
      if (
        existing.metadata.deletionTimestamp !== undefined ||
        existing.status?.phase === "Terminating"
      ) {
        return result;
      }
      if (this.options.executionCluster !== undefined) {
        const gateway = await this.getNamespace(await this.controlNamespace(namespace.id));
        if (gateway !== undefined) {
          this.verifyGatewayNamespace(gateway, ownership);
        }
      }
      await this.lifecycle.beforeNamespaceDelete(namespace);
      if (this.sandboxDriver !== undefined) {
        await this.sandboxDriver.cleanup(await this.sandboxNamespaceContext(namespace, name));
      }
      if (!(await this.deleteGatewayNamespace(ownership))) {
        return result;
      }
      if (external) {
        if (this.options.network.repositoryCredentials !== undefined) {
          const references = await this.repositoryMaterialReferences(ownership, name);
          if (!(await (await this.repositoryMaterialStore(name)).cleanup(ownership, references))) {
            return result;
          }
        }
        const deleted = await this.deleteOwnedNamespaceResources(name, ownership);
        if (!deleted) {
          return result;
        }
        const remaining = await this.getNamespace(name);
        if (remaining !== undefined) {
          this.verifyNamespaceOwnership(remaining, ownership, true);
        }
        return { ...result, namespaceDeleted: true };
      }
      await this.request(
        () =>
          clients.core.deleteNamespace({
            name: name.name,
            ...(existing.metadata.uid === undefined
              ? {}
              : { body: { preconditions: { uid: existing.metadata.uid } } }),
          }),
        { mutating: true },
      );
      const remaining = await this.getNamespace(name);
      if (remaining === undefined) {
        return { ...result, namespaceDeleted: true };
      }
      this.verifyNamespaceOwnership(remaining, ownership, false);
      return result;
    } catch (error) {
      return { ...result, failure: failure(error) };
    }
  }

  async getRuntimeImages(revision: AgentRevision): Promise<readonly RuntimeImage[]> {
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new OwnershipFailure("The revision belongs to another Compute Driver.");
    }
    const { name: namespace } = await this.resolveNamespace(revision.namespaceId);
    const images: RuntimeImage[] = [];
    for (const role of ["gateway", "agent"] as const) {
      const targetNamespace =
        role === "gateway" ? this.gatewayNamespace(revision, namespace) : namespace;
      const pods = await this.revisionPods(revision, targetNamespace, role);
      // Old or external images can lack the metadata endpoint. Image identity
      // still comes from Kubernetes; never infer a commit from a configured tag.
      // Optional provenance must leave room within the console's request deadline.
      const ownerSignal = currentComputeAbortSignal();
      const metadataDeadline = AbortSignal.timeout(2_000);
      const metadataSignal = ownerSignal
        ? AbortSignal.any([ownerSignal, metadataDeadline])
        : metadataDeadline;
      const provenance =
        pods.length === 0
          ? undefined
          : await withComputeAbortSignal(metadataSignal, () =>
              this.privateStatusReadback(revision, namespace, role, "/openclaw/runtime/image"),
            ).catch(() => undefined);
      for (const pod of pods) {
        const metadata = asRecord(pod.metadata)!;
        if (metadata.deletionTimestamp !== undefined) {
          continue;
        }
        const spec = asRecord(pod.spec);
        const status = asRecord(pod.status);
        const commit = asRecord(provenance?.status)?.commit;
        const openclawCommit = asRecord(provenance?.status)?.openclawCommit;
        const sameContainer =
          provenance?.podUid === metadata.uid &&
          provenance?.containerId !== undefined &&
          provenance.containerId === this.podContainerId(pod, role);
        const runtimeImageId = (
          Array.isArray(status?.containerStatuses) ? status.containerStatuses : []
        )
          .map(asRecord)
          .find((item) => item?.name === role)?.imageID;
        for (const [containers, states] of [
          [spec?.containers, status?.containerStatuses],
          [spec?.initContainers, status?.initContainerStatuses],
          [spec?.ephemeralContainers, status?.ephemeralContainerStatuses],
        ]) {
          if (!Array.isArray(containers)) {
            continue;
          }
          for (const value of containers) {
            const container = asRecord(value);
            if (!isNonEmptyString(container?.name) || !isNonEmptyString(container?.image)) {
              throw new DependencyUnavailableError(
                "Kubernetes returned incomplete image identity.",
              );
            }
            const observed = (Array.isArray(states) ? states : [])
              .map(asRecord)
              .find((item) => item?.name === container.name);
            const imageId = isNonEmptyString(observed?.imageID) ? observed.imageID : null;
            images.push({
              workload: `${targetNamespace.name}/${metadata.name}`,
              container: container.name,
              image: container.image,
              imageId,
              commit:
                sameContainer &&
                imageId !== null &&
                imageId === runtimeImageId &&
                typeof commit === "string" &&
                /^[a-f0-9]{40}$/.test(commit)
                  ? commit
                  : null,
              openclawCommit:
                sameContainer &&
                imageId !== null &&
                imageId === runtimeImageId &&
                typeof openclawCommit === "string" &&
                /^[a-f0-9]{40}$/.test(openclawCommit)
                  ? openclawCommit
                  : null,
            });
          }
        }
      }
    }
    return images;
  }

  async prepareRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness> {
    try {
      return await this.prepareRevisionWorkloads(revision, context);
    } catch (error) {
      throw transientKubernetesFailure(error);
    }
  }

  private async prepareRevisionWorkloads(
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
    ) {
      return result;
    }
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
    const materialInput = this.repositoryMaterialInput(revision, context);
    const repositoryConsumer =
      materialInput === undefined ? undefined : this.repositoryConsumer(revision);
    const nativeConfiguration =
      repositoryConsumer?.role !== "gateway"
        ? revision.configuration
        : repositoryNativeConfiguration(revision.configuration);
    const admittedNativeConfiguration = this.gatewaySandboxConfiguration(
      revision,
      this.kubernetesGatewayConfigurationDocument(nativeConfiguration),
    );
    const admittedRevision = { ...revision, configuration: admittedNativeConfiguration };
    const embedded = revision.harness.mode === "embedded";
    if (
      (embedded && revision.harness.id !== "openclaw") ||
      (!embedded &&
        (revision.harness.mode !== "dedicated" ||
          (revision.harness.id !== "codex" && revision.harness.id !== "openclaw")))
    ) {
      throw new ConfigurationFailure("AgentRevision Harness execution topology is unsupported.");
    }
    const sandboxDriver = this.sandboxDriverForRevision(revision);
    // Admission rejects this topology; keep the guard for revisions pinned to a Sandbox.
    if (revision.harnessAuth.method === "oauth" && sandboxDriver !== undefined) {
      throw new ConfigurationFailure("OAuth requires the Compute-owned dedicated Codex Harness.");
    }
    requireNativeWorkerSandbox(revision.harness, sandboxDriver);
    if (sandboxDriver !== undefined && embedded) {
      throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
    }
    const workspaceSetup = this.workspaceSetupForRevision(admittedRevision, context);
    this.validateHarnessAuth(
      revision.harness,
      revision.harnessAuth,
      admittedRevision.configuration,
      revision.secretBindings,
      await this.admittedCredentialSourceType(revision),
    );
    const channels = this.enabledChannels(admittedRevision);
    this.verifyGatewayRoutingConfiguration(admittedRevision);
    const { name: namespace, external } = await this.resolveNamespace(revision.namespaceId);
    const sourceNamespace =
      this.options.executionCluster === undefined
        ? namespace
        : await this.controlNamespace(revision.namespaceId);
    const secretEnvironment = this.secretEnvironmentForRevision(revision, context, sourceNamespace);
    const harnessAuth = this.harnessAuthForRevision(admittedRevision, context, sourceNamespace);
    const gatewayNamespace = await this.requireGatewayNamespace(revision, namespace);
    const nativeRuntime = nativeRuntimeSnapshot(admittedRevision);
    const tenantOwnership = { namespaceId: revision.namespaceId };
    const observed = await this.getNamespace(namespace);
    if (observed === undefined) {
      return result;
    }
    this.verifyNamespaceOwnership(observed, tenantOwnership, external);
    if (observed.status?.phase !== "Active") {
      return result;
    }
    const policyNamespaces =
      gatewayNamespace === namespace ? [namespace] : [namespace, gatewayNamespace];
    for (const policyNamespace of policyNamespaces) {
      const policies = this.networkPolicies(tenantOwnership, policyNamespace).filter(
        (policy) => policyNamespace === namespace || policy.metadata.name === "allow-dns",
      );
      for (const policy of policies) {
        const existing = await this.getOwned(
          "NetworkPolicy",
          policy.metadata.name,
          policyNamespace,
          tenantOwnership,
        );
        if (existing === undefined) {
          return result;
        }
        if (policy.metadata.name === "allow-dns") {
          await this.reconcileDnsPorts(existing, policy, policyNamespace);
        }
      }
    }
    const agentName = `agent-${sha256Hex(revision.agentId, 12)}`;
    const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
    const gatewayOwnership = { ...tenantOwnership, agentId: revision.agentId };
    const agentOwnership = {
      ...tenantOwnership,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
    };
    const revisionName = `${agentName}-rev-${sha256Hex(revision.id, 12)}`;
    const revisionOwnership = { ...agentOwnership, revisionId: revision.id };
    const pluginOwnership = this.pluginRuntimeOwnership(revision);
    // A known pending reason is reported with the observation; otherwise a Pod
    // the scheduler cannot place explains the wait (D224).
    const incomplete = async (pendingReason?: ComputePendingReason): Promise<ComputeReadiness> => {
      const runtimeFailure = await this.safeRuntimeFailureObservation(
        revision,
        namespace,
        workspaceSetup !== undefined,
      );
      const reason =
        pendingReason ??
        (runtimeFailure === undefined &&
        (await this.safeUnschedulableObservation(revision, namespace))
          ? "WORKLOAD_UNSCHEDULABLE"
          : undefined);
      return {
        ...result,
        ...(runtimeFailure === undefined ? {} : { runtimeFailure }),
        ...(reason === undefined ? {} : { pendingReason: reason }),
      };
    };
    const ready = async (
      expectedWarnings?: readonly PluginDeploymentWarning[],
      statusContainer: "agent" | "gateway" | undefined = pluginStatusContainer,
    ): Promise<ComputeReadiness> => {
      if (statusContainer === undefined) {
        await this.deliverWorkspaceSetup(revision, workspaceSetup, namespace, true);
        if (material?.kind === "ready" && !repositoryMaterialCurrent(material.spec)) {
          return incomplete();
        }
        return {
          ...result,
          ready: true,
          ...(expectedWarnings === undefined || expectedWarnings.length === 0
            ? {}
            : { warnings: expectedWarnings }),
        };
      }
      const status = await this.pluginRuntimeStatus(
        revision,
        namespace,
        statusContainer,
        expectedWarnings,
      );
      if (
        status !== undefined &&
        material?.kind === "ready" &&
        !(await this.repositoryMaterialReady(revision, namespace, material.spec))
      ) {
        return incomplete();
      }
      if (status !== undefined) {
        await this.deliverWorkspaceSetup(revision, workspaceSetup, namespace, true);
        if (material?.kind === "ready" && !repositoryMaterialCurrent(material.spec)) {
          return incomplete();
        }
      }
      return status === undefined
        ? result
        : {
            ...result,
            ready: true,
            ...(status.failures.length === 0 ? {} : { warnings: status.failures }),
          };
    };
    await this.deliverWorkspaceSetup(revision, workspaceSetup, namespace);
    const document = JSON.stringify(gatewayConfigurationDocument(admittedRevision, nativeRuntime));
    const configuration = this.gatewayConfiguration(
      admittedRevision,
      await this.workspaceNodeDeviceId(admittedRevision, namespace),
      namespace,
    );
    let existingGatewayRevisionId: string | undefined;
    const existingGateway = await this.getOwned(
      "Deployment",
      gatewayName,
      gatewayNamespace,
      gatewayOwnership,
    );
    if (existingGateway !== undefined) {
      const annotations = existingGateway.metadata.annotations ?? {};
      const currentRevision = Number(annotations[AGENT_REVISION_ANNOTATION]);
      const currentRevisionId = annotations[AGENT_REVISION_ID_ANNOTATION];
      existingGatewayRevisionId = currentRevisionId;
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
      if (
        existingGateway.spec?.replicas !== 1 &&
        !(
          embedded &&
          this.options.runtime !== undefined &&
          existingGateway.spec?.replicas === 0 &&
          revision.revision > currentRevision
        )
      ) {
        return incomplete();
      }
      if (revision.revision < currentRevision) {
        return incomplete();
      }
      if (revision.revision === currentRevision) {
        if (revision.id !== currentRevisionId || currentConfiguration !== configuration.name) {
          throw new ConfigurationFailure(
            "Immutable AgentRevision gateway configuration cannot change.",
          );
        }
        const containers = Array.isArray(pod?.containers) ? pod.containers : [];
        const environment = asRecord(containers[0])?.env;
        const binding = Array.isArray(environment)
          ? environment.find((entry) => asRecord(entry)?.name === "OPENCLAW_WORKSPACE_NODE_ID")
          : undefined;
        const currentNodeId = asRecord(binding)?.value;
        if (currentNodeId !== undefined && currentNodeId !== configuration.workspaceNodeId) {
          throw new ConfigurationFailure(
            "The active revision's workspace node binding cannot change.",
          );
        }
        const delivered = await this.deliveredWorkspaceNodeBinding(
          configuration,
          gatewayNamespace,
          gatewayOwnership,
        );
        if (
          delivered?.revisionId === revision.id &&
          delivered.deviceId !== configuration.workspaceNodeId
        ) {
          throw new ConfigurationFailure(
            "The active revision's workspace node binding cannot change.",
          );
        }
      }
    }
    const material =
      materialInput === undefined
        ? undefined
        : await (await this.repositoryMaterialStore(namespace)).prepare(revision, materialInput);
    if (material?.kind === "missing") {
      return { ...result, repositoryCredentialMaterialMissing: material.missing };
    }
    const repositoryMaterial = material?.spec;
    const pluginRuntime = this.pluginRuntimeSnapshot(
      admittedRevision,
      this.codexRepositoryBrokerNetworkPolicy(
        admittedRevision,
        repositoryConsumer,
        repositoryMaterial,
      ),
    );
    const hasEnabledPluginSelections =
      pluginRuntime !== undefined &&
      Object.values(pluginRuntime.runtime.selections).some((selection) => selection.enabled);
    const pluginStatusContainer =
      sandboxDriver?.provisionHarness === undefined &&
      pluginRuntime !== undefined &&
      hasEnabledPluginSelections
        ? embedded
          ? "gateway"
          : "agent"
        : undefined;
    const snapshot = this.manifest(
      "v1",
      "ConfigMap",
      configuration.name,
      gatewayOwnership,
      gatewayNamespace,
    );
    await this.reconcile(
      {
        ...snapshot,
        metadata: {
          ...snapshot.metadata,
          annotations: { ...snapshot.metadata.annotations, ...configuration.annotations },
        },
        immutable: true,
        data: {
          [CONFIGURATION_DOCUMENT]: document,
          ...(this.options.executionCluster?.caBundle === undefined
            ? {}
            : { "execution-ca.pem": this.options.executionCluster.caBundle }),
        },
      },
      gatewayOwnership,
      gatewayNamespace,
    );
    if (pluginRuntime !== undefined) {
      await this.reconcile(
        this.pluginRuntimeConfigMap(pluginRuntime, pluginOwnership, namespace),
        pluginOwnership,
        namespace,
      );
    }
    const gatewayAccountName = embedded ? agentName : gatewayName;
    const gatewayAccountOwnership = embedded ? agentOwnership : gatewayOwnership;
    await this.reconcile(
      {
        ...this.manifest(
          "v1",
          "ServiceAccount",
          gatewayAccountName,
          gatewayAccountOwnership,
          gatewayNamespace,
        ),
        automountServiceAccountToken: false,
      },
      gatewayAccountOwnership,
      gatewayNamespace,
    );
    // Preparation observes the serving Gateway of another revision and never
    // re-renders it; activation replaces it and re-applies these policies
    // strictly. Until then a Gateway from a pre-profile template keeps its
    // Gateway-side grants (model and repository egress when embedded; Harness
    // transport and plugin status when dedicated).
    // The Agent-scoped policies are shared by name across revisions, so while
    // another revision serves they select every revision of this Agent.
    const predecessorServes =
      existingGateway !== undefined && existingGatewayRevisionId !== revision.id;
    const preparation: AgentPolicyPreparation = {
      anyRevision: predecessorServes,
      unprofiledGateway:
        predecessorServes &&
        asRecord(asRecord(asRecord(existingGateway.spec?.template)?.metadata)?.labels)?.[
          NETWORK_PROFILE_LABEL
        ] !== ORDINARY_NETWORK_PROFILE,
    };
    if (embedded) {
      for (const { resource: policy, namespace: target } of this.agentNetworkPolicies(
        revision,
        namespace,
        preparation,
      )) {
        await this.reconcile(policy, gatewayOwnership, target);
      }
    } else if (this.options.runtime !== undefined) {
      for (const { resource: policy, namespace: target } of this.pluginStatusNetworkPolicies(
        revision,
        namespace,
        preparation,
      )) {
        await this.reconcile(policy, gatewayOwnership, target);
      }
    }
    if (
      embedded &&
      this.options.runtime !== undefined &&
      existingGateway !== undefined &&
      existingGateway.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] !== revision.id &&
      (workspaceSetup === undefined || workspaceSetup.completed)
    ) {
      // The shared Recreate gateway validates auth in the replacement's startup.
      // An unready predecessor must not prevent repair through a new deployment.
      if (repositoryMaterial !== undefined && !repositoryMaterialCurrent(repositoryMaterial)) {
        return incomplete();
      }
      return { ...result, ready: true };
    }
    if (!embedded) {
      await this.reconcile(
        this.harnessWorkspaceClaim(revision.agentId, gatewayOwnership, namespace),
        gatewayOwnership,
        namespace,
      );
    }
    if (this.options.runtime !== undefined) {
      await this.reconcile(
        this.gatewayPrivateStateClaim(revision.agentId, gatewayOwnership, gatewayNamespace),
        gatewayOwnership,
        gatewayNamespace,
      );
    }
    if (revision.harnessAuth.method === "oauth") {
      if (!(await this.prepareOAuthCredentials(revision, context, namespace))) {
        return result;
      }
    }
    const deliveredHarnessAuth = await this.deliverHarnessAuth(
      admittedRevision,
      context,
      harnessAuth,
      namespace,
    );
    const gatewaySecretEnvironment = await this.deliverGatewaySecrets(
      admittedRevision,
      namespace,
      gatewayNamespace,
      secretEnvironment,
    );
    if (!embedded && pluginRuntime !== undefined) {
      await this.reconcile(
        this.pluginRuntimeConfigMap(pluginRuntime, pluginOwnership, gatewayNamespace),
        pluginOwnership,
        gatewayNamespace,
      );
    }
    let launchPrepared = false;
    try {
      const gatewayEnvironment = embedded
        ? (await this.lifecycle.beforeWorkloadStart(revision)).environment
        : {};
      if (embedded) {
        launchPrepared = true;
      }
      // A first dedicated deploy of a Deployment-backed Codex Harness creates its
      // Gateway alongside the Harness. The Gateway reads Harness plugin status
      // through the agent Service, which selects this revision from the first
      // pass; its endpoints list only ready pods, so the Gateway waits (without
      // a deadline) until the Harness reports. A redeploy keeps the Service on
      // the serving revision until activation.
      const initialDedicatedCodexGateway =
        !embedded &&
        this.options.runtime !== undefined &&
        existingGateway === undefined &&
        nativeRuntime === undefined &&
        sandboxDriver?.provisionHarness === undefined;
      const deferInitialDedicatedGatewayForPluginStatus =
        !embedded &&
        this.options.runtime !== undefined &&
        pluginStatusContainer === "agent" &&
        existingGateway === undefined &&
        workspaceSetup === undefined &&
        !initialDedicatedCodexGateway;
      const reconcileGatewayDeployment = async (environment: Record<string, string>) => {
        await this.reconcileChannelNetworkPolicy(revision, channels, gatewayNamespace);
        await this.deliverWorkspaceNodeBinding(
          revision,
          configuration,
          gatewayNamespace,
          gatewayOwnership,
        );
        await this.reconcile(
          this.deployment(
            gatewayName,
            gatewayOwnership,
            gatewayNamespace,
            this.options.images.gateway,
            gatewayAccountName,
            "gateway",
            environment,
            configuration.loggingLevel,
            configuration,
            embedded,
            embedded ? revision.servicePrincipalId : undefined,
            embedded ? deliveredHarnessAuth : undefined,
            channels,
            gatewaySecretEnvironment,
            pluginRuntime,
            [],
            workspaceSetup,
            repositoryConsumer?.role === "gateway" ? repositoryMaterial : undefined,
            undefined,
          ),
          gatewayOwnership,
          gatewayNamespace,
        );
      };
      if (
        (existingGateway === undefined &&
          !deferInitialDedicatedGatewayForPluginStatus &&
          !initialDedicatedCodexGateway) ||
        this.options.runtime === undefined ||
        existingGateway?.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] === revision.id
      ) {
        await reconcileGatewayDeployment(gatewayEnvironment);
      }
      const existingGatewayService = await this.getOwned(
        "Service",
        gatewayName,
        gatewayNamespace,
        gatewayOwnership,
      );
      const inactiveEmbeddedGateway =
        embedded &&
        this.options.runtime !== undefined &&
        (existingGatewayService === undefined ||
          asRecord(existingGatewayService.spec?.selector)?.["app.kubernetes.io/name"] ===
            `${gatewayName}-inactive`);
      await this.reconcile(
        this.service(
          gatewayName,
          gatewayOwnership,
          gatewayNamespace,
          inactiveEmbeddedGateway
            ? { "app.kubernetes.io/name": `${gatewayName}-inactive` }
            : this.gatewayServiceSelector(revision, gatewayName),
        ),
        gatewayOwnership,
        gatewayNamespace,
      );
      await this.reconcileGatewayRoute(revision, gatewayOwnership, gatewayNamespace);
      if (inactiveEmbeddedGateway) {
        const gateway = await this.getOwned(
          "Deployment",
          gatewayName,
          gatewayNamespace,
          gatewayOwnership,
        );
        const current =
          gateway?.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] === revision.id;
        if (gateway !== undefined && !current && !this.deploymentReady(gateway, false)) {
          // The predecessor never served (for example, it failed model auth) and is
          // unready: repair it with this revision's template, as the dedicated path does.
          await reconcileGatewayDeployment(gatewayEnvironment);
          await this.deleteReplacedPredecessorArtifacts(revision, gateway, namespace);
          return incomplete();
        }
        if (gateway === undefined || !this.deploymentReady(gateway, current)) {
          return incomplete();
        }
      } else if (
        embedded &&
        !(await this.gatewayReady(gatewayOwnership, gatewayName, gatewayNamespace, revision.id))
      ) {
        return incomplete();
      }
      if (embedded) {
        if (repositoryMaterial !== undefined) {
          if (!(await this.repositoryMaterialReady(revision, namespace, repositoryMaterial))) {
            return incomplete();
          }
          await this.cleanupRepositoryMaterial(revision, namespace, repositoryMaterial);
        }
        return ready();
      }
      await this.reconcile(
        {
          ...this.manifest("v1", "ServiceAccount", agentName, agentOwnership, namespace),
          automountServiceAccountToken: false,
        },
        agentOwnership,
        namespace,
      );
      const existingService = await this.getOwned("Service", agentName, namespace, agentOwnership);
      if (initialDedicatedCodexGateway) {
        // No Gateway serves another revision yet, so the Service can select this
        // revision's Harness before it is ready.
        await this.reconcile(
          this.service(
            agentName,
            agentOwnership,
            namespace,
            this.agentServiceSelector(revision, revisionName),
          ),
          agentOwnership,
          namespace,
        );
      } else if (existingService === undefined) {
        await this.reconcile(
          this.service(agentName, agentOwnership, namespace, {
            "app.kubernetes.io/name": `${agentName}-inactive`,
          }),
          agentOwnership,
          namespace,
        );
      }
      if (this.options.runtime !== undefined) {
        for (const policy of this.agentNetworkPolicies(revision, namespace, preparation)) {
          await this.reconcile(policy.resource, gatewayOwnership, policy.namespace);
        }
        if (this.harnessNetworkProfile(revision) === ORDINARY_NETWORK_PROFILE) {
          await this.reconcile(
            this.agentAuthenticationNetworkPolicy(revision, namespace),
            agentOwnership,
            namespace,
          );
        }
      }
      await this.reconcileHarnessRoute(revision, namespace);
      if (initialDedicatedCodexGateway) {
        // The Service, the Harness route and the Agent policies the Gateway's
        // peer read needs exist before the Gateway does.
        await reconcileGatewayDeployment(gatewayEnvironment);
      }
      const launch = await this.lifecycle.beforeWorkloadStart(revision);
      launchPrepared = true;
      // A Deployment-backed Codex Harness renders its node wiring from its first
      // start and receives the setup code through a file, so enrollment does not
      // replace the Harness or restart its Gateway. Native workers and
      // SandboxDriver Harnesses still add the node once the setup exists.
      const nodeSetupFile =
        nativeRuntime === undefined && sandboxDriver?.provisionHarness === undefined;
      const node = nodeSetupFile
        ? await this.workspaceNodeWiring(revision, namespace)
        : await this.prepareWorkspaceNode(revision, namespace);
      const agentDeployment = this.deployment(
        revisionName,
        revisionOwnership,
        namespace,
        nativeRuntime === undefined ? this.options.images.agent : this.options.images.gateway,
        agentName,
        "agent",
        launch.environment,
        configuration.loggingLevel,
        undefined,
        false,
        undefined,
        deliveredHarnessAuth,
        [],
        [],
        pluginRuntime,
        [],
        workspaceSetup,
        repositoryConsumer?.role === "agent" ? repositoryMaterial : undefined,
        nativeRuntime,
      );
      if (node !== undefined) {
        if (nativeRuntime === undefined) {
          this.addWorkspaceNode(
            agentDeployment,
            node.name,
            node.ca,
            revision,
            nodeSetupFile,
            workspaceSetup,
          );
        } else {
          this.addNativeWorker(agentDeployment, node.name, node.ca, revision);
        }
      }
      if (nodeSetupFile) {
        await this.prepareWorkspaceNode(revision, namespace, true);
      }
      if (sandboxDriver?.provisionHarness !== undefined) {
        const sandboxContext = await this.sandboxNamespaceContext(
          this.sandboxNamespaceForRevision(revision, namespace),
          namespace,
        );
        const credentialContext =
          harnessAuth.credentialSource === undefined
            ? undefined
            : {
                namespace: sandboxContext.namespace,
                revision,
                sources: [harnessAuth.credentialSource],
                signal: sandboxContext.signal,
              };
        const attachments =
          credentialContext === undefined
            ? []
            : await this.requireCredentialGateway().attachForRevision(credentialContext);
        const requirements = this.harnessRequirementsFromDeployment(
          agentDeployment,
          harnessAuth.loginMode,
          attachments,
        );
        const sandbox = await sandboxDriver.provisionHarness({
          ...sandboxContext,
          revision,
          requirements,
        });
        this.verifySandboxResourceRef(sandbox, revision, namespace);
        if (
          !(await this.providerHarnessReady(revision, namespace, requirements.labels)) ||
          !(await this.workspaceNodeReady(revision, namespace))
        ) {
          return incomplete();
        }
        if (credentialContext !== undefined) {
          const statuses = await this.requireCredentialGateway().attachmentStatus({
            ...credentialContext,
            sandbox,
          });
          if (
            statuses.some((status) =>
              ["failed", "withheld", "revoked", "absent"].includes(status.state),
            )
          ) {
            throw new DependencyUnavailableError(
              "The Sandbox did not apply a required credential attachment.",
            );
          }
          if (
            statuses.length !== attachments.length ||
            statuses.some((status) => status.state !== "ready")
          ) {
            return incomplete();
          }
        }
        return ready();
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
        return incomplete();
      }
      if (!this.deploymentReady(deployment)) {
        return incomplete();
      }
      if (repositoryMaterial !== undefined) {
        if (!(await this.repositoryMaterialReady(revision, namespace, repositoryMaterial))) {
          return incomplete();
        }
        await this.cleanupRepositoryMaterial(revision, namespace, repositoryMaterial);
      }
      for (const { resource: policy, namespace: target } of this.pluginStatusNetworkPolicies(
        revision,
        namespace,
        preparation,
      )) {
        await this.reconcile(policy, gatewayOwnership, target);
      }
      const agentReadiness = await ready(
        undefined,
        pluginStatusContainer === "agent" ? "agent" : undefined,
      );
      if (!agentReadiness.ready) {
        return agentReadiness;
      }
      if (this.options.runtime === undefined) {
        return (await this.gatewayReady(gatewayOwnership, gatewayName, gatewayNamespace)) &&
          (repositoryMaterial === undefined || repositoryMaterialCurrent(repositoryMaterial))
          ? agentReadiness
          : incomplete();
      }
      if (existingGatewayRevisionId !== undefined && existingGatewayRevisionId !== revision.id) {
        // The serving predecessor is observed like the embedded one: only a
        // genuinely unready Gateway is repaired with the successor's template.
        if (
          !(await this.gatewayReady(gatewayOwnership, gatewayName, gatewayNamespace, revision.id))
        ) {
          await reconcileGatewayDeployment({});
          return incomplete();
        }
        if (!(await this.workspaceNodeReady(revision, namespace))) {
          return incomplete("WORKSPACE_NODE_PENDING");
        }
        return repositoryMaterial !== undefined &&
          !(await this.repositoryMaterialReady(revision, namespace, repositoryMaterial))
          ? incomplete()
          : agentReadiness;
      }
      const pluginWarnings = agentReadiness.warnings ?? [];
      await this.reconcile(
        this.service(
          agentName,
          agentOwnership,
          namespace,
          this.agentServiceSelector(
            revision,
            sandboxDriver?.provisionHarness === undefined ? revisionName : undefined,
          ),
        ),
        agentOwnership,
        namespace,
      );
      if (deferInitialDedicatedGatewayForPluginStatus) {
        await reconcileGatewayDeployment({});
      }
      if (!(await this.gatewayReady(gatewayOwnership, gatewayName, gatewayNamespace))) {
        return incomplete();
      }
      // Enrolling the workspace node replaces the Harness and restarts its
      // Gateway. Wait for that Gateway before making enrollment RPCs.
      const workspaceNodeIsReady = await this.workspaceNodeReady(
        revision,
        namespace,
        this.workspaceNodePairingWaitMs,
      );
      if (
        workspaceNodeIsReady &&
        configuration.workspaceNodeBinding !== undefined &&
        configuration.workspaceNodeId === undefined
      ) {
        // The node paired during this pass. The Gateway here is this revision's
        // own, so hand it the node now, as the next pass would: its kubelet
        // refresh and hot-apply then overlap the rest of this pass and the
        // start of activation, which still waits for the Gateway's ack.
        const deviceId = await this.workspaceNodeDeviceId(admittedRevision, namespace);
        if (deviceId !== undefined) {
          await this.deliverWorkspaceNodeBinding(
            revision,
            this.gatewayConfiguration(admittedRevision, deviceId, namespace),
            gatewayNamespace,
            gatewayOwnership,
          );
        }
      }
      if (pluginStatusContainer === "gateway") {
        return ready(pluginWarnings, "gateway");
      }
      if (pluginRuntime?.runtime.kind === "codex" && hasEnabledPluginSelections) {
        const gatewayStatus = await this.pluginRuntimeStatus(
          revision,
          namespace,
          "gateway",
          pluginWarnings,
        );
        if (gatewayStatus === undefined) {
          return incomplete();
        }
      }
      if (!workspaceNodeIsReady) {
        // Both workloads are ready: only the node's connection is outstanding (D222).
        return incomplete("WORKSPACE_NODE_PENDING");
      }
      // Gateway plugin and node observations may outlive the material readiness observation.
      if (
        repositoryMaterial !== undefined &&
        !(await this.repositoryMaterialReady(revision, namespace, repositoryMaterial))
      ) {
        return incomplete();
      }
      if (nativeRuntime !== undefined && configuration.nativeWorkerNodeId === undefined) {
        return incomplete();
      }
      return agentReadiness;
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
    try {
      await this.activateRevisionWorkloads(revision, context);
    } catch (error) {
      throw transientKubernetesFailure(error);
    }
  }

  private async activateRevisionWorkloads(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<void> {
    const materialInput = this.repositoryMaterialInput(revision, context);
    const repositoryConsumer =
      materialInput === undefined ? undefined : this.repositoryConsumer(revision);
    const nativeConfiguration =
      repositoryConsumer?.role !== "gateway"
        ? revision.configuration
        : repositoryNativeConfiguration(revision.configuration);
    const admittedNativeConfiguration = this.gatewaySandboxConfiguration(
      revision,
      this.kubernetesGatewayConfigurationDocument(nativeConfiguration),
    );
    const admittedRevision = { ...revision, configuration: admittedNativeConfiguration };
    if (this.options.runtime === undefined) {
      return;
    }
    this.verifyGatewayRoutingConfiguration(admittedRevision);
    const workspaceSetup = this.workspaceSetupForRevision(admittedRevision, context);
    this.validateHarnessAuth(
      revision.harness,
      revision.harnessAuth,
      admittedRevision.configuration,
      revision.secretBindings,
      await this.admittedCredentialSourceType(revision),
    );
    const channels = this.enabledChannels(admittedRevision);
    const { name: namespace } = await this.resolveNamespace(revision.namespaceId);
    await this.deliverWorkspaceSetup(revision, workspaceSetup, namespace);
    const sourceNamespace =
      this.options.executionCluster === undefined
        ? namespace
        : await this.controlNamespace(revision.namespaceId);
    const secretEnvironment = this.secretEnvironmentForRevision(revision, context, sourceNamespace);
    const harnessAuth = this.harnessAuthForRevision(admittedRevision, context, sourceNamespace);
    const gatewayNamespace = await this.requireGatewayNamespace(revision, namespace);
    const nativeRuntime = nativeRuntimeSnapshot(admittedRevision);
    const agentName = `agent-${sha256Hex(revision.agentId, 12)}`;
    const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
    const gatewayOwnership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const ownership = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
    };
    const sandboxDriver = this.sandboxDriverForRevision(revision);
    if (revision.harness.mode === "embedded") {
      if (sandboxDriver !== undefined) {
        throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
      }
      const gateway = await this.getOwned("Deployment", gatewayName, namespace, gatewayOwnership);
      if (gateway === undefined) {
        throw new Error("The Agent gateway workload is unavailable.");
      }
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
      const repositoryMaterial = await this.prepareRepositoryMaterialForActivation(
        revision,
        namespace,
        materialInput,
      );
      const pluginRuntime = this.pluginRuntimeSnapshot(
        admittedRevision,
        this.codexRepositoryBrokerNetworkPolicy(
          admittedRevision,
          repositoryConsumer,
          repositoryMaterial,
        ),
      );
      if (
        currentRevisionId !== revision.id ||
        annotations[REPOSITORY_MATERIAL_GENERATION] !== repositoryMaterial?.generation
      ) {
        const deliveredHarnessAuth = await this.deliverHarnessAuth(
          admittedRevision,
          context,
          harnessAuth,
          namespace,
        );
        const gatewaySecretEnvironment = await this.deliverGatewaySecrets(
          admittedRevision,
          namespace,
          gatewayNamespace,
          secretEnvironment,
        );
        await this.reconcileHarnessRoute(revision, namespace);
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
              this.gatewayConfiguration(admittedRevision).loggingLevel,
              this.gatewayConfiguration(admittedRevision),
              true,
              revision.servicePrincipalId,
              deliveredHarnessAuth,
              channels,
              gatewaySecretEnvironment,
              pluginRuntime,
              [],
              workspaceSetup,
              repositoryMaterial,
            ),
            gatewayOwnership,
            namespace,
          );
        } catch (error) {
          await this.lifecycle.beforeWorkloadStop(revision, { cleanup: true });
          throw error;
        }
        // The Recreate Gateway no longer runs the older revision it served, and the
        // active pointer already names this one. Its copies go now: if this
        // activation never becomes ready, retirement would not run before stop.
        await this.deleteReplacedPredecessorArtifacts(revision, gateway, namespace);
      }
      for (const { resource: policy, namespace: target } of this.agentNetworkPolicies(
        revision,
        namespace,
      )) {
        await this.reconcile(policy, gatewayOwnership, target);
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
      if (repositoryMaterial !== undefined) {
        if (!(await this.repositoryMaterialReady(revision, namespace, repositoryMaterial))) {
          throw new DependencyUnavailableError(
            "The exact repository credential runtime generation is not ready.",
          );
        }
        await this.cleanupRepositoryMaterial(revision, namespace, repositoryMaterial);
        if (!repositoryMaterialCurrent(repositoryMaterial)) {
          throw new DependencyUnavailableError(
            "The exact repository credential runtime generation is not ready.",
          );
        }
      }
      return;
    }
    const repositoryMaterial = await this.prepareRepositoryMaterialForActivation(
      revision,
      namespace,
      materialInput,
    );
    const pluginRuntime = this.pluginRuntimeSnapshot(
      admittedRevision,
      this.codexRepositoryBrokerNetworkPolicy(
        admittedRevision,
        repositoryConsumer,
        repositoryMaterial,
      ),
    );
    const revisionName = `${agentName}-rev-${sha256Hex(revision.id, 12)}`;
    const configuration = this.gatewayConfiguration(
      admittedRevision,
      await this.workspaceNodeDeviceId(admittedRevision, namespace),
      namespace,
    );
    if (
      this.nodeEnrollment !== undefined &&
      this.getGatewayEndpoint(revision) !== undefined &&
      configuration.workspaceNodeId === undefined
    ) {
      throw new Error("The exact AgentRevision workspace node is not enrolled.");
    }
    const activatedHarnessAuth =
      revision.harnessAuth.method === "oauth"
        ? await this.deliverHarnessAuth(admittedRevision, context, harnessAuth, namespace)
        : harnessAuth;
    const renderAgentDeployment = (environment: Readonly<Record<string, string>>) =>
      this.deployment(
        revisionName,
        { ...ownership, revisionId: revision.id },
        namespace,
        nativeRuntime === undefined ? this.options.images.agent : this.options.images.gateway,
        agentName,
        "agent",
        environment,
        configuration.loggingLevel,
        undefined,
        false,
        undefined,
        activatedHarnessAuth,
        [],
        [],
        pluginRuntime,
        [],
        workspaceSetup,
        repositoryMaterial,
        nativeRuntime,
      );
    if (sandboxDriver?.provisionHarness === undefined) {
      let deployment = await this.getOwned("Deployment", revisionName, namespace, {
        ...ownership,
        revisionId: revision.id,
      });
      if (
        deployment !== undefined &&
        repositoryMaterial !== undefined &&
        deployment.metadata.annotations?.[REPOSITORY_MATERIAL_GENERATION] !==
          repositoryMaterial.generation
      ) {
        const launch = await this.lifecycle.beforeWorkloadStart(revision);
        try {
          const replacement = renderAgentDeployment(launch.environment);
          const nodeSetupFile = nativeRuntime === undefined;
          const node = nodeSetupFile
            ? await this.workspaceNodeWiring(revision, namespace)
            : await this.prepareWorkspaceNode(revision, namespace);
          if (node !== undefined) {
            if (nativeRuntime === undefined) {
              this.addWorkspaceNode(
                replacement,
                node.name,
                node.ca,
                revision,
                nodeSetupFile,
                workspaceSetup,
              );
            } else {
              this.addNativeWorker(replacement, node.name, node.ca, revision);
            }
          }
          if (nodeSetupFile) {
            await this.prepareWorkspaceNode(revision, namespace, true);
          }
          await this.reconcile(replacement, { ...ownership, revisionId: revision.id }, namespace);
        } catch (error) {
          await this.lifecycle.beforeWorkloadStop(revision, { cleanup: true });
          throw error;
        }
        deployment = await this.getOwned("Deployment", revisionName, namespace, {
          ...ownership,
          revisionId: revision.id,
        });
      }
      if (deployment === undefined || !this.deploymentReady(deployment)) {
        throw new Error("The exact AgentRevision workload is not ready.");
      }
      if (repositoryMaterial !== undefined) {
        if (!(await this.repositoryMaterialReady(revision, namespace, repositoryMaterial))) {
          throw new DependencyUnavailableError(
            "The exact repository credential runtime generation is not ready.",
          );
        }
        await this.cleanupRepositoryMaterial(revision, namespace, repositoryMaterial);
      }
    } else {
      const requirements = this.harnessRequirementsFromDeployment(
        renderAgentDeployment({}),
        harnessAuth.loginMode,
      );
      if (!(await this.providerHarnessReady(revision, namespace, requirements.labels))) {
        throw new Error("The exact AgentRevision workload is not ready.");
      }
    }
    const gatewaySecretEnvironment = await this.deliverGatewaySecrets(
      admittedRevision,
      namespace,
      gatewayNamespace,
      secretEnvironment,
    );
    await this.reconcileChannelNetworkPolicy(revision, channels, gatewayNamespace);
    await this.reconcile(
      this.harnessWorkspaceClaim(revision.agentId, gatewayOwnership, namespace),
      gatewayOwnership,
      namespace,
    );
    await this.reconcile(
      this.gatewayPrivateStateClaim(revision.agentId, gatewayOwnership, gatewayNamespace),
      gatewayOwnership,
      gatewayNamespace,
    );
    // Written before the Deployment so a replacement Gateway starts with its node,
    // and a running one of this revision applies it without a restart.
    await this.deliverWorkspaceNodeBinding(
      revision,
      configuration,
      gatewayNamespace,
      gatewayOwnership,
    );
    await this.reconcile(
      this.deployment(
        gatewayName,
        gatewayOwnership,
        gatewayNamespace,
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
        gatewaySecretEnvironment,
        pluginRuntime,
        [],
        workspaceSetup,
      ),
      gatewayOwnership,
      gatewayNamespace,
    );
    await this.reconcile(
      this.service(
        gatewayName,
        gatewayOwnership,
        gatewayNamespace,
        this.gatewayServiceSelector(revision, gatewayName),
      ),
      gatewayOwnership,
      gatewayNamespace,
    );
    await this.reconcileGatewayRoute(revision, gatewayOwnership, gatewayNamespace);
    await this.reconcile(
      this.service(
        agentName,
        ownership,
        namespace,
        this.agentServiceSelector(
          revision,
          sandboxDriver?.provisionHarness === undefined ? revisionName : undefined,
        ),
      ),
      ownership,
      namespace,
    );
    await this.reconcileHarnessRoute(revision, namespace);
    for (const { resource: policy, namespace: target } of this.agentNetworkPolicies(
      revision,
      namespace,
    )) {
      await this.reconcile(policy, gatewayOwnership, target);
    }
    if (!(await this.gatewayReady(gatewayOwnership, gatewayName, gatewayNamespace))) {
      throw new Error("The exact AgentRevision gateway is not ready.");
    }
    if (!(await this.workspaceNodeBindingApplied(revision, namespace, configuration))) {
      throw new ActivationPendingError(
        "WORKSPACE_NODE_BINDING_PENDING",
        "The exact AgentRevision gateway has not applied its workspace node.",
      );
    }
    if (!(await this.workspaceNodeReady(revision, namespace))) {
      throw new ActivationPendingError(
        "WORKSPACE_NODE_PENDING",
        "The exact AgentRevision Harness node is not ready.",
      );
    }
    if (repositoryMaterial !== undefined && !repositoryMaterialCurrent(repositoryMaterial)) {
      throw new DependencyUnavailableError(
        "The exact repository credential runtime generation is not ready.",
      );
    }
  }

  async deactivateRevision(revision: AgentRevision): Promise<void> {
    try {
      await this.deactivateRevisionWorkloads(revision);
    } catch (error) {
      throw transientKubernetesFailure(error);
    }
  }

  private async deactivateRevisionWorkloads(revision: AgentRevision): Promise<void> {
    if (this.options.runtime === undefined) {
      return;
    }
    const { name: namespace } = await this.resolveNamespace(revision.namespaceId);
    if (revision.harness.mode === "embedded") {
      if (this.sandboxDriverForRevision(revision) !== undefined) {
        throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
      }
      const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
      const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
      const service = await this.getOwned("Service", gatewayName, namespace, ownership);
      if (service === undefined) {
        return;
      }
      const gateway = await this.getOwned("Deployment", gatewayName, namespace, ownership);
      if (gateway === undefined) {
        return;
      }
      if (gateway.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] !== revision.id) {
        return;
      }
      if (asRecord(service.spec?.selector)?.["app.kubernetes.io/name"] !== gatewayName) {
        return;
      }
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
      {
        serviceSelector: {
          "openclaw.dev/agent": revision.agentId,
          "openclaw.dev/revision": revision.id,
          "openclaw.dev/workload-role": "agent",
        },
      },
    );
  }

  private async deleteRevisionAgentDeployment(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const sandboxDriver = this.sandboxDriverForRevision(revision);
    if (sandboxDriver?.provisionHarness !== undefined) {
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
      return;
    }
    const clients = await this.clients(namespace.plane);
    await this.request(
      () =>
        clients.apps.deleteNamespacedDeployment({
          name,
          namespace: namespace.name,
          ...(deployment.metadata.uid === undefined
            ? {}
            : { body: { preconditions: { uid: deployment.metadata.uid } } }),
        }),
      { mutating: true },
    );
  }

  /**
   * Revokes one credential source from the revision's paired Sandbox. The Sandbox identity is
   * derived exactly as provisioning created it; a missing Namespace or Sandbox has nothing left
   * to revoke.
   */
  async withdrawCredentialSource(
    revision: Readonly<AgentRevision>,
    source: Readonly<CredentialSource>,
    signal: AbortSignal,
  ): Promise<CredentialAttachmentStatus> {
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new Error(
        "Refusing to withdraw from an AgentRevision pinned to another Compute Driver.",
      );
    }
    const sandboxDriver = this.sandboxDriverForRevision(revision);
    if (sandboxDriver?.harnessResource === undefined) {
      throw new ConfigurationFailure(
        "Credential withdrawal requires a SandboxDriver that identifies the revision's Harness.",
      );
    }
    const { name: namespace, external } = await this.resolveNamespace(revision.namespaceId);
    const existingNamespace = await this.getNamespace(namespace);
    if (existingNamespace === undefined) {
      return Object.freeze({ sourceId: source.id, state: "absent" });
    }
    this.verifyNamespaceOwnership(
      existingNamespace,
      { namespaceId: revision.namespaceId },
      external,
    );
    const sandboxNamespace = this.sandboxNamespaceForRevision(revision, namespace);
    const sandbox = sandboxDriver.harnessResource({ namespace: sandboxNamespace, revision });
    this.verifySandboxResourceRef(sandbox, revision, namespace);
    const status = await this.requireCredentialGateway().withdraw({
      namespace: sandboxNamespace,
      revision,
      sandbox,
      sourceId: source.id,
      signal,
    });
    if (status.sourceId !== source.id) {
      throw new OwnershipFailure("The Credential Gateway withdrew another credential source.");
    }
    return status;
  }

  async stopRevision(revision: AgentRevision): Promise<void> {
    this.lifecycleStarted = true;
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new Error("Refusing to stop an AgentRevision pinned to another Compute Driver.");
    }
    required(revision.agentId, "Agent ID");
    required(revision.id, "AgentRevision ID");
    required(revision.servicePrincipalId, "Agent ServicePrincipal ID");
    const { name: namespace, external } = await this.resolveNamespace(revision.namespaceId);
    const gatewayNamespace = this.gatewayNamespace(revision, namespace);
    if (gatewayNamespace !== namespace) {
      const gatewayTarget = await this.getNamespace(gatewayNamespace);
      if (gatewayTarget !== undefined) {
        this.verifyGatewayNamespace(gatewayTarget, { namespaceId: revision.namespaceId });
      }
    }
    const existingNamespace = await this.getNamespace(namespace);
    if (existingNamespace === undefined) {
      await this.lifecycle.beforeWorkloadStop(revision);
      await this.removeStoppedGateway(revision, namespace);
      return;
    }
    this.verifyNamespaceOwnership(
      existingNamespace,
      { namespaceId: revision.namespaceId },
      external,
    );
    if (
      revision.harness.mode !== "dedicated" &&
      this.sandboxDriverForRevision(revision) !== undefined
    ) {
      throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
    }
    await this.lifecycle.beforeWorkloadStop(revision);
    // Stop removes the serving path first so no new traffic reaches a runtime while
    // its exact Harness is being shut down.
    await this.removeStoppedGateway(revision, namespace);
    await this.shutdownRevisionRuntime(revision, namespace);
    // Its Pods are gone, so drop the revision's credential copies and snapshots.
    // Preparing the revision again re-projects them from the canonical sources.
    await this.deleteRetiredRevisionArtifacts(revision, namespace);
    if (revision.repositoryCredentials !== undefined) {
      await this.removeRepositoryMaterial(revision, namespace);
    }
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
    const { name: namespace, external } = await this.resolveNamespace(revision.namespaceId);
    const gatewayNamespace = this.gatewayNamespace(revision, namespace);
    if (gatewayNamespace !== namespace) {
      const gatewayTarget = await this.getNamespace(gatewayNamespace);
      if (gatewayTarget !== undefined) {
        this.verifyGatewayNamespace(gatewayTarget, { namespaceId: revision.namespaceId });
      }
    }
    const existingNamespace = await this.getNamespace(namespace);
    if (existingNamespace === undefined) {
      await this.lifecycle.beforeWorkloadStop(revision);
      await this.removeRetiredGateway(revision, namespace);
      return;
    }
    this.verifyNamespaceOwnership(
      existingNamespace,
      { namespaceId: revision.namespaceId },
      external,
    );
    if (
      revision.harness.mode !== "dedicated" &&
      this.sandboxDriverForRevision(revision) !== undefined
    ) {
      throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
    }
    await this.lifecycle.beforeWorkloadStop(revision);
    await this.shutdownRevisionRuntime(revision, namespace);
    await this.retireLegacyWorkspaceNode(revision, namespace);
    await this.removeRetiredGateway(revision, namespace);
    if (revision.repositoryCredentials !== undefined) {
      await this.waitForRevisionPodsToTerminate(
        revision,
        namespace,
        this.repositoryConsumer(revision).role,
      );
      await this.removeRepositoryMaterial(revision, namespace);
    }
  }

  private async shutdownRevisionRuntime(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    if (revision.harness.mode === "embedded") {
      return;
    }
    if (revision.harnessAuth.method === "oauth") {
      await this.removeOAuthBootstrap(revision, namespace);
    }
    const sandboxDriver = this.sandboxDriverForRevision(revision);
    const computeOwnsWorkload = sandboxDriver?.provisionHarness === undefined;
    if (computeOwnsWorkload) {
      await this.deleteRevisionAgentDeployment(revision, namespace);
      await this.waitForRevisionPodsToTerminate(revision, namespace, "agent");
    }
    if (sandboxDriver !== undefined) {
      await sandboxDriver.cleanup({
        ...(await this.sandboxNamespaceContext(
          this.sandboxNamespaceForRevision(revision, namespace),
          namespace,
        )),
        revision,
      });
    }
    if (!computeOwnsWorkload) {
      await this.waitForRevisionPodsToTerminate(revision, namespace, "agent");
    }
  }

  private async removeStoppedGateway(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    namespace = this.gatewayNamespace(revision, namespace);
    const name = `gateway-${sha256Hex(revision.agentId, 12)}`;
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    await this.deleteGatewayUnauthenticatedRoutes(name, ownership, namespace, revision.id);
    await this.deleteGatewayRoute(name, ownership, namespace, revision.id);
    await this.deleteNamedRuntimeResources(name, ownership, namespace, revision.id);
    await this.waitForRevisionPodsToTerminate(revision, namespace, "gateway");
  }

  private async waitForRevisionPodsToTerminate(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    role: "agent" | "gateway",
    workloadName?: string,
  ): Promise<void> {
    const clients = await this.clients(namespace.plane);
    const signal = this.operationSignal();
    const labels = {
      "openclaw.dev/namespace": revision.namespaceId,
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/revision": revision.id,
      "openclaw.dev/workload-role": role,
      ...(workloadName === undefined ? {} : { "app.kubernetes.io/name": workloadName }),
    };
    const timeoutMs =
      role === "gateway"
        ? GATEWAY_STOP_TIMEOUT_MS + REQUEST_TIMEOUT_MS
        : WORKLOAD_TERMINATION_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal.throwIfAborted();
      const observed = asRecord(
        await this.request(() =>
          clients.core.listNamespacedPod({
            namespace: namespace.name,
            labelSelector: labelsToSelector(labels),
            timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
          }),
        ),
      );
      signal.throwIfAborted();
      const metadata = asRecord(observed?.metadata);
      if (
        !Array.isArray(observed?.items) ||
        (observed.apiVersion !== undefined && observed.apiVersion !== "v1") ||
        (observed.kind !== undefined && observed.kind !== "PodList") ||
        (observed.metadata !== undefined && metadata === undefined) ||
        (metadata?.continue !== undefined && metadata.continue !== "") ||
        (metadata?._continue !== undefined && metadata._continue !== "") ||
        (metadata?.remainingItemCount !== undefined && metadata.remainingItemCount !== 0)
      ) {
        throw new DependencyUnavailableError(
          "The Kubernetes client returned an invalid workload Pod list.",
        );
      }
      for (const item of observed.items) {
        const pod = asRecord(item);
        const podMetadata = asRecord(pod?.metadata);
        const podLabels = asRecord(podMetadata?.labels);
        if (
          pod === undefined ||
          (pod.apiVersion !== undefined && pod.apiVersion !== "v1") ||
          (pod.kind !== undefined && pod.kind !== "Pod") ||
          podMetadata === undefined ||
          !isNonEmptyString(podMetadata.name) ||
          podMetadata.namespace !== namespace.name ||
          podLabels === undefined ||
          Object.entries(labels).some(([key, value]) => podLabels[key] !== value)
        ) {
          throw new OwnershipFailure("Refusing an ambiguous AgentRevision workload Pod.");
        }
      }
      if (observed.items.length === 0) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new DependencyUnavailableError(
          "The AgentRevision workload Pods did not terminate before the deadline.",
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, WORKLOAD_TERMINATION_POLL_MS));
    }
  }

  private async removeRetiredGateway(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const harnessNamespace = namespace;
    namespace = this.gatewayNamespace(revision, harnessNamespace);
    const name = `gateway-${sha256Hex(revision.agentId, 12)}`;
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const gateway = await this.getOwned("Deployment", name, namespace, ownership);
    await this.deleteGatewayUnauthenticatedRoutes(name, ownership, namespace, revision.id);
    if (gateway === undefined) {
      // A missing Deployment can mean stop or external loss. Preserve shared Agent resources
      // whenever surviving route or Service evidence belongs to a newer revision.
      const route =
        this.options.gatewayRouting === undefined
          ? undefined
          : await this.getOwned("HTTPRoute", name, namespace, ownership);
      if (
        route !== undefined &&
        route.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] !== revision.id
      ) {
        await this.waitForRevisionPodsToTerminate(revision, namespace, "gateway");
        await this.deleteRetiredRevisionArtifacts(revision, harnessNamespace);
        return;
      }
      if (revision.harness.mode === "dedicated") {
        const agentService = await this.getOwned(
          "Service",
          `agent-${sha256Hex(revision.agentId, 12)}`,
          harnessNamespace,
          ownership,
        );
        const selectedRevision = asRecord(agentService?.spec?.selector)?.["openclaw.dev/revision"];
        if (isNonEmptyString(selectedRevision) && selectedRevision !== revision.id) {
          await this.waitForRevisionPodsToTerminate(revision, namespace, "gateway");
          await this.deleteRetiredRevisionArtifacts(revision, harnessNamespace);
          return;
        }
      }
      await this.deleteRetiredAgentResources(revision, ownership, harnessNamespace);
      return;
    }
    const annotations = gateway.metadata.annotations ?? {};
    if (annotations[AGENT_REVISION_ID_ANNOTATION] === revision.id) {
      await this.deleteRetiredAgentResources(revision, ownership, harnessNamespace);
      return;
    }
    await this.waitForRevisionPodsToTerminate(revision, namespace, "gateway");
    await this.deleteRetiredRevisionArtifacts(revision, harnessNamespace);
  }

  private async deleteRetiredAgentResources(
    revision: AgentRevision,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const gatewayNamespace = this.gatewayNamespace(revision, namespace);
    const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
    await this.deleteGatewayRoute(gatewayName, ownership, gatewayNamespace, revision.id);
    await this.deleteNamedRuntimeResources(gatewayName, ownership, gatewayNamespace);
    await this.waitForRevisionPodsToTerminate(revision, gatewayNamespace, "gateway");
    // Another mode can have a live Gateway in the other physical namespace.
    // Those revisions still share the data-plane Agent Service, identity and policies.
    const preserveHarness = await this.hasOtherGatewayRevision(revision, namespace);
    if (!preserveHarness) {
      await this.deleteNamedRuntimeResources(
        `agent-${sha256Hex(revision.agentId, 12)}`,
        { ...ownership, servicePrincipalId: revision.servicePrincipalId },
        namespace,
      );
    }
    await this.deleteRetiredRevisionArtifacts(revision, namespace);
    await this.deleteRetiredAgentPolicies(revision, namespace, preserveHarness);
  }

  private async hasOtherGatewayRevision(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<boolean> {
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const otherTarget =
      revision.harness.mode === "dedicated"
        ? namespace
        : await this.controlNamespace(revision.namespaceId);
    const name = `gateway-${sha256Hex(revision.agentId, 12)}`;
    for (const kind of this.options.gatewayRouting === undefined
      ? (["Deployment"] as const)
      : (["Deployment", "HTTPRoute"] as const)) {
      const resource = await this.getOwned(kind, name, otherTarget, ownership);
      if (
        resource !== undefined &&
        resource.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] !== revision.id
      ) {
        return true;
      }
    }
    return false;
  }

  // An embedded repair or activation replaces the predecessor's Gateway with the
  // successor's template. Once no dedicated Harness remains, its
  // credential and configuration copies go now; without a ready successor
  // activation, nothing else would retire them before stop or delete. A newer
  // revision's copies are left alone: its own pass may still be converging.
  private async deleteReplacedPredecessorArtifacts(
    revision: AgentRevision,
    predecessorGateway: ManagedKubernetesObject<"Deployment">,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const annotations = predecessorGateway.metadata.annotations ?? {};
    const predecessorId = annotations[AGENT_REVISION_ID_ANNOTATION];
    const predecessorNumber = Number(annotations[AGENT_REVISION_ANNOTATION]);
    if (
      !isNonEmptyString(predecessorId) ||
      predecessorId === revision.id ||
      !Number.isSafeInteger(predecessorNumber) ||
      predecessorNumber >= revision.revision
    ) {
      return;
    }
    const predecessor = { ...revision, id: predecessorId, revision: predecessorNumber };
    // In a shared namespace the replaced Gateway may belong to a dedicated
    // predecessor. Retirement owns its copies until its Harness is gone.
    const predecessorHarness = await this.getOwned(
      "Deployment",
      `agent-${sha256Hex(revision.agentId, 12)}-rev-${sha256Hex(predecessorId, 12)}`,
      namespace,
      this.pluginRuntimeOwnership(predecessor),
    );
    if (
      predecessorHarness !== undefined ||
      (await this.revisionPods(predecessor, namespace, "agent")).length > 0
    ) {
      return;
    }
    await this.deleteRetiredRevisionArtifacts(predecessor, namespace);
  }

  private async deleteRetiredRevisionArtifacts(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const gatewayNamespace = this.gatewayNamespace(revision, namespace);
    await this.deleteOwnedNamespacedResource(
      "ConfigMap",
      `gateway-${sha256Hex(revision.agentId, 12)}-rev-${sha256Hex(revision.id, 12)}`,
      { namespaceId: revision.namespaceId, agentId: revision.agentId },
      gatewayNamespace,
    );
    await this.deleteOwnedNamespacedResource(
      "ConfigMap",
      `plugin-runtime-${sha256Hex(revision.agentId, 12)}-rev-${sha256Hex(revision.id, 12)}`,
      this.pluginRuntimeOwnership(revision),
      namespace,
    );
    if (gatewayNamespace !== namespace) {
      await this.deleteOwnedNamespacedResource(
        "ConfigMap",
        `plugin-runtime-${sha256Hex(revision.agentId, 12)}-rev-${sha256Hex(revision.id, 12)}`,
        this.pluginRuntimeOwnership(revision),
        gatewayNamespace,
      );
    }
    for (const name of [
      this.harnessSecretsName(revision.agentId, revision.id),
      this.gatewaySecretsName(revision.agentId, revision.id),
    ]) {
      await this.deleteOwnedNamespacedResource(
        "Secret",
        name,
        this.pluginRuntimeOwnership(revision),
        namespace,
      );
    }
  }

  private async deleteRetiredAgentPolicies(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    preserveHarness: boolean,
  ): Promise<void> {
    const suffix = sha256Hex(revision.agentId, 12);
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const gatewayNamespace = this.gatewayNamespace(revision, namespace);
    for (const name of [
      "allow-gateway-agent",
      "allow-gateway-channels",
      "allow-plugin-status-gateway",
    ]) {
      await this.deleteOwnedNamespacedResource(
        "NetworkPolicy",
        `${name}-${suffix}`,
        ownership,
        gatewayNamespace,
      );
    }
    if (gatewayNamespace !== namespace) {
      await this.deleteOwnedNamespacedResource(
        "NetworkPolicy",
        `allow-plugin-status-proxy-${suffix}`,
        ownership,
        gatewayNamespace,
      );
    }
    if (preserveHarness) {
      return;
    }
    for (const name of [
      "allow-agent-runtime",
      "allow-plugin-status-proxy",
      "allow-plugin-status-agent",
    ]) {
      await this.deleteOwnedNamespacedResource(
        "NetworkPolicy",
        `${name}-${suffix}`,
        ownership,
        namespace,
      );
    }
    await this.deleteOwnedNamespacedResource(
      "NetworkPolicy",
      `allow-agent-auth-${suffix}`,
      { ...ownership, servicePrincipalId: revision.servicePrincipalId },
      namespace,
    );
  }

  private async deleteGatewayRoute(
    name: string,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
    revisionId: string,
  ): Promise<void> {
    await this.deleteGatewayRoutingResource("HTTPRoute", name, ownership, namespace, revisionId);
  }

  private async deleteGatewayUnauthenticatedRoutes(
    gatewayName: string,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
    revisionId: string,
  ): Promise<void> {
    // Remove the endpoint before deleting its route-specific authentication policy.
    for (const suffix of ["node", "sandbox"]) {
      const name = `${gatewayName}-${suffix}`;
      await this.deleteGatewayRoutingResource("HTTPRoute", name, ownership, namespace, revisionId);
      await this.deleteGatewayRoutingResource(
        "SecurityPolicy",
        name,
        ownership,
        namespace,
        revisionId,
      );
    }
    await this.deleteGatewayRoutingResource(
      "NetworkPolicy",
      `${gatewayName}-sandbox`,
      ownership,
      namespace,
      revisionId,
    );
  }

  private async deleteGatewayRoutingResource(
    kind: "HTTPRoute" | "SecurityPolicy" | "NetworkPolicy",
    name: string,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
    revisionId: string,
  ): Promise<void> {
    if (this.options.gatewayRouting === undefined) {
      return;
    }
    const existing = await this.getOwned(kind, name, namespace, ownership);
    if (existing === undefined) {
      return;
    }
    if (existing.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] !== revisionId) {
      return;
    }
    if (
      !isNonEmptyString(existing.metadata.uid) ||
      !isNonEmptyString(existing.metadata.resourceVersion)
    ) {
      throw new OwnershipFailure(
        `${kind} ${name} UID and resourceVersion must be explicitly observed before delete.`,
      );
    }
    const clients = await this.clients(namespace.plane);
    await this.request(
      () =>
        clients.objects.delete(
          {
            apiVersion: {
              HTTPRoute: GATEWAY_API_VERSION,
              SecurityPolicy: GATEWAY_SECURITY_POLICY_API_VERSION,
              NetworkPolicy: "networking.k8s.io/v1",
            }[kind],
            kind,
            metadata: { name, namespace: namespace.name },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            preconditions: {
              uid: existing.metadata.uid,
              resourceVersion: existing.metadata.resourceVersion,
            },
          } as V1DeleteOptions,
        ),
      { mutating: true },
    );
  }

  private async deleteNamedRuntimeResources(
    name: string,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
    stoppedRevisionId?: string,
  ): Promise<void> {
    const clients = await this.clients(namespace.plane);
    if (stoppedRevisionId !== undefined) {
      const gateway = await this.getOwned("Deployment", name, namespace, ownership);
      if (gateway !== undefined) {
        if (gateway.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] !== stoppedRevisionId) {
          return;
        }
        const { uid, resourceVersion } = gateway.metadata;
        if (!isNonEmptyString(uid) || !isNonEmptyString(resourceVersion)) {
          throw new OwnershipFailure(
            `Deployment ${name} UID and resourceVersion must be explicitly observed before delete.`,
          );
        }
        // A cutover can update the same UID. Fence it before deleting shared resources.
        await this.request(
          () =>
            clients.apps.deleteNamespacedDeployment({
              name,
              namespace: namespace.name,
              body: {
                preconditions: {
                  uid,
                  resourceVersion,
                },
              },
            }),
          { mutating: true },
        );
      }
      // With the single owning worker, absence also permits retrying partial shared cleanup.
    }
    const kinds =
      stoppedRevisionId === undefined
        ? (["Service", "ServiceAccount", "Deployment"] as const)
        : (["Service", "ServiceAccount"] as const);
    for (const kind of kinds) {
      const existing = await this.getOwned(kind, name, namespace, ownership);
      if (existing === undefined) {
        continue;
      }
      const uid = required(existing.metadata.uid, `${kind} UID`);
      const request = {
        name,
        namespace: namespace.name,
        body: { preconditions: { uid } },
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

  private async deleteOwnedNamespacedResource(
    kind: "ConfigMap" | "ServiceAccount" | "NetworkPolicy" | "Secret",
    name: string,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const existing = await this.getOwned(kind, name, namespace, ownership);
    if (existing === undefined) {
      return;
    }
    const request = {
      name,
      namespace: namespace.name,
      body: { preconditions: { uid: required(existing.metadata.uid, `${kind} UID`) } },
    };
    const clients = await this.clients(namespace.plane);
    await this.request(
      async () => {
        if (kind === "ConfigMap") {
          await clients.core.deleteNamespacedConfigMap(request);
        } else if (kind === "Secret") {
          await clients.core.deleteNamespacedSecret(request);
        } else if (kind === "ServiceAccount") {
          await clients.core.deleteNamespacedServiceAccount(request);
        } else {
          await clients.networking.deleteNamespacedNetworkPolicy(request);
        }
      },
      { mutating: true },
    );
  }

  private repositoryMaterialInput(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): RepositoryMaterialSpec | undefined {
    const spec = repositoryMaterialSpec(revision, context?.repositoryCredentials);
    if (spec !== undefined) {
      this.validateRepositoryCredentials(revision.harness, revision.sandboxDriverId);
    }
    return spec;
  }

  private repositoryConsumer(revision: AgentRevision) {
    const owner = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const suffix = sha256Hex(revision.agentId, 12);
    if (revision.harness.mode === "embedded") {
      return { role: "gateway" as const, name: `gateway-${suffix}`, owner };
    }
    return {
      role: "agent" as const,
      name: `agent-${suffix}-rev-${sha256Hex(revision.id, 12)}`,
      owner: { ...owner, servicePrincipalId: revision.servicePrincipalId, revisionId: revision.id },
    };
  }

  private async repositoryMaterialStore(
    namespace: KubernetesNamespaceAddress,
  ): Promise<RepositoryMaterialStore> {
    const clients = await this.clients(namespace.plane);
    return new RepositoryMaterialStore(namespace.name, clients.core, (operation, options) =>
      this.request(operation, options),
    );
  }

  private async prepareRepositoryMaterialForActivation(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    input: RepositoryMaterialSpec | undefined,
  ): Promise<ResolvedRepositoryMaterialSpec | undefined> {
    if (input === undefined) {
      return undefined;
    }
    const material = await (await this.repositoryMaterialStore(namespace)).prepare(revision, input);
    if (material.kind === "missing") {
      throw new DependencyUnavailableError(
        "Repository credential material is unavailable for activation.",
      );
    }
    return material.spec;
  }

  private async repositoryMaterialReferences(
    owner: RepositoryMaterialOwner,
    namespace: KubernetesNamespaceAddress,
  ): Promise<Set<string>> {
    const clients = await this.clients(namespace.plane);
    const labels = this.ownershipMetadata(owner).labels;
    const labelSelector = labelsToSelector(labels);
    const pods = completeKubernetesList(
      await this.request(() =>
        clients.core.listNamespacedPod({ namespace: namespace.name, labelSelector }),
      ),
    );
    // Read current templates too: a replacement can reference material before its Pod exists.
    const deployments = completeKubernetesList(
      await this.request(() =>
        clients.apps.listNamespacedDeployment({ namespace: namespace.name, labelSelector }),
      ),
    );
    const names = new Set<string>();
    const collect = (spec: unknown) => {
      const pod = asRecord(spec);
      if (pod === undefined || (pod.volumes !== undefined && !Array.isArray(pod.volumes))) {
        throw new OwnershipFailure("The Kubernetes material workload specification is invalid.");
      }
      for (const value of (pod.volumes ?? []) as unknown[]) {
        const volume = asRecord(value);
        if (volume === undefined) {
          throw new OwnershipFailure("The Kubernetes material workload volume is invalid.");
        }
        const secret = asRecord(volume.secret);
        if (typeof secret?.secretName === "string") {
          names.add(secret.secretName);
        }
        const projected = asRecord(volume.projected);
        if (projected !== undefined) {
          if (!Array.isArray(projected.sources)) {
            throw new OwnershipFailure("The Kubernetes material projection is invalid.");
          }
          for (const source of projected.sources) {
            const secret = asRecord(asRecord(source)?.secret);
            if (typeof secret?.name === "string") {
              names.add(secret.name);
            }
          }
        }
      }
    };
    for (const pod of pods) {
      if (
        pod.metadata?.namespace !== namespace.name ||
        !isNonEmptyString(pod.metadata.name) ||
        Object.entries(labels).some(([key, value]) => pod.metadata?.labels?.[key] !== value)
      ) {
        throw new OwnershipFailure("Refusing an ambiguous repository-material Pod.");
      }
      collect(pod.spec);
    }
    for (const deployment of deployments) {
      if (
        deployment.metadata?.namespace !== namespace.name ||
        !isNonEmptyString(deployment.metadata.name) ||
        Object.entries(labels).some(([key, value]) => deployment.metadata?.labels?.[key] !== value)
      ) {
        throw new OwnershipFailure("Refusing an ambiguous repository-material Deployment.");
      }
      collect(deployment.spec?.template.spec);
    }
    return names;
  }

  private async repositoryMaterialReady(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    material: ResolvedRepositoryMaterialSpec,
  ): Promise<boolean> {
    const consumer = this.repositoryConsumer(revision);
    const deployment = await this.getOwned("Deployment", consumer.name, namespace, consumer.owner);
    const template = asRecord(deployment?.spec?.template);
    const templateMetadata = asRecord(template?.metadata);
    if (
      deployment === undefined ||
      !this.deploymentReady(deployment) ||
      asRecord(templateMetadata?.labels)?.["openclaw.dev/revision"] !== revision.id ||
      asRecord(templateMetadata?.labels)?.["openclaw.dev/workload-role"] !== consumer.role ||
      deployment.metadata.annotations?.[REPOSITORY_MATERIAL_GENERATION] !== material.generation ||
      asRecord(templateMetadata?.annotations)?.[REPOSITORY_MATERIAL_GENERATION] !==
        material.generation
    ) {
      return false;
    }
    const labels = {
      ...this.ownershipMetadata({ ...consumer.owner, revisionId: revision.id }).labels,
      "openclaw.dev/workload-role": consumer.role,
    };
    const clients = await this.clients(namespace.plane);
    const pods = completeKubernetesList(
      await this.request(() =>
        clients.core.listNamespacedPod({
          namespace: namespace.name,
          labelSelector: labelsToSelector(labels),
        }),
      ),
    );
    let ready = 0;
    for (const pod of pods) {
      if (
        pod.metadata?.namespace !== namespace.name ||
        !isNonEmptyString(pod.metadata.name) ||
        Object.entries(labels).some(([key, value]) => pod.metadata?.labels?.[key] !== value)
      ) {
        throw new OwnershipFailure("Refusing an ambiguous repository-material readiness Pod.");
      }
      if (
        pod.metadata.deletionTimestamp === undefined &&
        pod.metadata.annotations?.[REPOSITORY_MATERIAL_GENERATION] === material.generation &&
        pod.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        )
      ) {
        ready += 1;
      }
    }
    return repositoryMaterialCurrent(material) && ready >= Number(deployment.spec?.replicas);
  }

  private async cleanupRepositoryMaterial(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    material: ResolvedRepositoryMaterialSpec,
  ): Promise<void> {
    const owner = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
    };
    const keep = await this.repositoryMaterialReferences(
      { namespaceId: revision.namespaceId, agentId: revision.agentId },
      namespace,
    );
    for (const binding of material.bindings) {
      keep.add(binding.secretName);
    }
    await (await this.repositoryMaterialStore(namespace)).cleanup(owner, keep);
  }

  private async removeRepositoryMaterial(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const owner = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
    };
    const references = await this.repositoryMaterialReferences(
      { namespaceId: revision.namespaceId, agentId: revision.agentId },
      namespace,
    );
    if (!(await (await this.repositoryMaterialStore(namespace)).cleanup(owner, references))) {
      throw new DependencyUnavailableError(
        "The repository credential material is still in use or awaiting deletion.",
      );
    }
  }

  private async resolveNamespace(
    namespaceId: string,
  ): Promise<{ readonly name: KubernetesNamespaceAddress; readonly external: boolean }> {
    const clients = await this.clients("execution");
    const resolved = await this.request(() =>
      resolveKubernetesNamespace(clients.core, namespaceId),
    );
    return { ...resolved, name: { name: resolved.name, plane: "execution" } };
  }

  private validRuntimeCredentialInput(
    input: AgentRuntimeCredentialsInput,
  ): AgentRuntimeCredentialsInput {
    const value = asRecord(input) ?? {};
    if (Object.keys(value).length !== 0) {
      throw new DependencyUnavailableError(
        "Runtime credentials support only a server-generated transport bundle.",
      );
    }
    return {};
  }

  private async runtimeCredentialContext(
    binding: ComputeAgentBinding,
  ): Promise<RuntimeCredentialContext> {
    const runtime = this.options.runtime;
    if (runtime === undefined) {
      throw new DependencyUnavailableError("The Agent runtime credentials are not configured.");
    }
    const context = await this.agentResourceContext(binding);
    if (context === undefined) {
      throw new DependencyUnavailableError(
        "The Agent runtime credential Kubernetes namespace is unavailable.",
      );
    }
    const transportName = `${runtime.transportSecretPrefix}-${context.suffix}`;
    validateKubernetesResourceName(transportName, "Agent runtime credential Secret name");
    const dedicated = binding.agent.executionMode === "dedicated";
    const namespace =
      dedicated && this.options.executionCluster !== undefined
        ? {
            name: (
              await resolveKubernetesControlNamespace(
                (await this.clients("control")).core,
                context.namespaceId,
              )
            ).name,
            plane: "control" as const,
          }
        : context.namespace;
    return {
      ...context,
      namespace,
      transport: {
        name: transportName,
        keys: [AGENT_TRANSPORT_TOKEN_KEY],
      },
      gatewayPassword: {
        name: `gateway-password-${context.suffix}`,
        keys: [GATEWAY_PASSWORD_KEY],
      },
    };
  }

  private async agentResourceContext(
    binding: ComputeAgentBinding,
  ): Promise<Omit<RuntimeCredentialContext, "transport" | "gatewayPassword"> | undefined> {
    const namespaceId = required(binding.namespace?.id, "Runtime credential Namespace ID");
    const agentId = required(binding.agent?.id, "Runtime credential Agent ID");
    if (binding.agent.namespaceId !== namespaceId) {
      throw new ResourceConflictError("The Agent runtime credential binding is invalid.");
    }
    const { name: namespace, external } = await this.resolveNamespace(namespaceId);
    const observed = await this.getNamespace(namespace);
    if (observed === undefined) {
      return undefined;
    }
    if (observed.status?.phase !== "Active") {
      throw new DependencyUnavailableError(
        "The Agent runtime credential Kubernetes namespace is unavailable.",
      );
    }
    this.verifyNamespaceOwnership(observed, { namespaceId }, external);
    const suffix = sha256Hex(agentId, 12);
    const ownership = { namespaceId, agentId };
    return {
      namespaceId,
      namespace,
      agentId,
      suffix,
      ownership,
    };
  }

  private async readRuntimeCredentialSecret(context: RuntimeCredentialContext): Promise<{
    transport: ManagedKubernetesObject<"Secret"> | undefined;
    gatewayPassword: ManagedKubernetesObject<"Secret"> | undefined;
  }> {
    const read = async (spec: RuntimeCredentialSecretSpec | undefined) => {
      if (spec === undefined) {
        return undefined;
      }
      const secret = await this.runtimeCredentialClusterAccess(
        "get",
        "secrets",
        context.namespace,
        () => this.getOwned("Secret", spec.name, context.namespace, context.ownership),
      );
      if (secret !== undefined) {
        this.requireCompleteRuntimeCredentialSecret(
          secret,
          spec === context.transport ? this.runtimeTransportSecretSpec(spec.name, secret) : spec,
        );
      }
      return secret;
    };
    const transport = await read(context.transport);
    const password = await read(context.gatewayPassword);
    const legacyPassword = transport?.data?.[GATEWAY_PASSWORD_KEY];
    if (
      password !== undefined &&
      legacyPassword !== undefined &&
      password.data?.[GATEWAY_PASSWORD_KEY] !== legacyPassword
    ) {
      throw new ResourceConflictError("The Agent runtime credential sources conflict.");
    }
    return {
      transport,
      gatewayPassword: password ?? (legacyPassword === undefined ? undefined : transport),
    };
  }

  private runtimeTransportSecretSpec(
    name: string,
    secret: ManagedKubernetesObject<"Secret">,
  ): RuntimeCredentialSecretSpec {
    return {
      name,
      keys: Object.hasOwn(asRecord(secret.data) ?? {}, GATEWAY_PASSWORD_KEY)
        ? [AGENT_TRANSPORT_TOKEN_KEY, GATEWAY_PASSWORD_KEY]
        : [AGENT_TRANSPORT_TOKEN_KEY],
    };
  }

  private async ensureLegacyGatewayPassword(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    if (this.options.runtime === undefined) {
      return;
    }
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const suffix = sha256Hex(revision.agentId, 12);
    const transportName = `${this.options.runtime.transportSecretPrefix}-${suffix}`;
    const transport = await this.getOwned("Secret", transportName, namespace, ownership);
    if (
      transport === undefined ||
      !Object.hasOwn(asRecord(transport.data) ?? {}, GATEWAY_PASSWORD_KEY)
    ) {
      return;
    }
    this.requireCompleteRuntimeCredentialSecret(
      transport,
      this.runtimeTransportSecretSpec(transportName, transport),
    );
    const name = `gateway-password-${suffix}`;
    const existing = await this.getOwned("Secret", name, namespace, ownership);
    if (existing !== undefined) {
      this.requireCompleteRuntimeCredentialSecret(existing, { name, keys: [GATEWAY_PASSWORD_KEY] });
      if (existing.data?.[GATEWAY_PASSWORD_KEY] !== transport.data?.[GATEWAY_PASSWORD_KEY]) {
        throw new ResourceConflictError("The Agent runtime credential sources conflict.");
      }
      return;
    }
    // Preserve the legacy source for an older Gateway that still references it.
    // New templates use the separate password source in either execution mode.
    const clients = await this.clients(namespace.plane);
    try {
      await this.request(
        () =>
          clients.core.createNamespacedSecret({
            namespace: namespace.name,
            body: {
              ...this.manifest("v1", "Secret", name, ownership, namespace),
              type: "Opaque",
              data: { [GATEWAY_PASSWORD_KEY]: transport.data![GATEWAY_PASSWORD_KEY]! },
            },
          }),
        { mutating: true },
      );
    } catch (error) {
      if (numericErrorStatus(error) !== 409) {
        throw error;
      }
      // Another delivery may have created the same source after our read.
      // Accept only the exact-owned password with the same legacy bytes.
      const concurrent = await this.getOwned("Secret", name, namespace, ownership);
      if (concurrent === undefined) {
        throw error;
      }
      this.requireCompleteRuntimeCredentialSecret(concurrent, {
        name,
        keys: [GATEWAY_PASSWORD_KEY],
      });
      if (concurrent.data?.[GATEWAY_PASSWORD_KEY] !== transport.data?.[GATEWAY_PASSWORD_KEY]) {
        throw new ResourceConflictError("The Agent runtime credential sources conflict.");
      }
    }
  }

  private requireCompleteRuntimeCredentialSecret(
    secret: ManagedKubernetesObject<"Secret">,
    spec: RuntimeCredentialSecretSpec,
  ): void {
    if (secret.type !== "Opaque" || secret.immutable === true) {
      throw new ResourceConflictError("The Agent runtime credential Secret is invalid.");
    }
    const data = asRecord(secret.data);
    if (data === undefined) {
      throw new ResourceConflictError("The Agent runtime credential Secret is incomplete.");
    }
    const expected = [...spec.keys].sort();
    const actual = Object.keys(data).sort();
    if (!isDeepStrictEqual(expected, actual)) {
      throw new ResourceConflictError("The Agent runtime credential Secret is incomplete.");
    }
    for (const key of expected) {
      const encoded = data[key];
      if (typeof encoded !== "string") {
        throw new ResourceConflictError("The Agent runtime credential Secret is incomplete.");
      }
      this.decodedRuntimeCredentialBytes(encoded);
    }
  }

  private decodedRuntimeCredentialBytes(encoded: string): Buffer {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new ResourceConflictError("The Agent runtime credential Secret is invalid.");
    }
    const decoded = Buffer.from(encoded, "base64");
    if (
      decoded.length === 0 ||
      decoded.length > MAX_RUNTIME_CREDENTIAL_BYTES ||
      decoded.toString("base64") !== encoded
    ) {
      throw new ResourceConflictError("The Agent runtime credential Secret is invalid.");
    }
    return decoded;
  }

  private async assertNoAgentRuntimeDeployments(
    context: RuntimeCredentialContext,
    dedicated: boolean,
  ): Promise<void> {
    const targets = dedicated
      ? [(await this.resolveNamespace(context.namespaceId)).name, context.namespace]
      : [context.namespace];
    for (const namespace of targets) {
      const clients = await this.clients(namespace.plane);
      const observed = await this.runtimeCredentialClusterAccess(
        "list",
        "deployments",
        namespace,
        () =>
          this.request(() =>
            clients.apps.listNamespacedDeployment({
              namespace: namespace.name,
              labelSelector: labelsToSelector({
                "openclaw.dev/namespace": context.namespaceId,
                "openclaw.dev/agent": context.agentId,
              }),
              timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
            }),
          ),
      );
      if (!Array.isArray(observed?.items)) {
        throw new DependencyUnavailableError("The Agent runtime workload preflight failed.");
      }
      for (const item of observed.items) {
        const deployment = this.listedRuntimeCredentialDeployment(item, namespace);
        this.verifyOwnership(deployment, context.ownership);
      }
      if (observed.items.length > 0) {
        throw new ResourceConflictError("The Agent runtime has already been deployed.");
      }
    }
  }

  private listedRuntimeCredentialDeployment(
    item: unknown,
    namespace: KubernetesNamespaceAddress,
  ): ManagedKubernetesObject<"Deployment"> {
    const record = asRecord(item);
    const metadata = asRecord(record?.metadata);
    const name = metadata?.name;
    if (
      record === undefined ||
      metadata === undefined ||
      record.apiVersion !== "apps/v1" ||
      record.kind !== "Deployment" ||
      typeof name !== "string" ||
      name.length === 0 ||
      metadata.namespace !== namespace.name
    ) {
      throw new ResourceConflictError("The Agent runtime workload preflight conflicted.");
    }
    const spec = asRecord(record.spec);
    const status = asRecord(record.status);
    const labels = this.runtimeCredentialStringMetadata(metadata.labels);
    const annotations = this.runtimeCredentialStringMetadata(metadata.annotations);
    return {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name,
        namespace: namespace.name,
        ...(typeof metadata.uid === "string" ? { uid: metadata.uid } : {}),
        ...(labels === undefined ? {} : { labels }),
        ...(annotations === undefined ? {} : { annotations }),
      },
      ...(spec === undefined ? {} : { spec }),
      ...(status === undefined ? {} : { status }),
    };
  }

  private runtimeCredentialStringMetadata(value: unknown): Record<string, string> | undefined {
    const record = asRecord(value);
    if (record === undefined) {
      return undefined;
    }
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(record)) {
      if (typeof item !== "string") {
        throw new ResourceConflictError("The Agent runtime workload preflight conflicted.");
      }
      result[key] = item;
    }
    return result;
  }

  private async createRuntimeCredentialSecret(
    context: RuntimeCredentialContext,
    spec: RuntimeCredentialSecretSpec,
    values: Readonly<Record<string, string>>,
  ): Promise<void> {
    const clients = await this.clients(context.namespace.plane);
    await this.runtimeCredentialClusterAccess("create", "secrets", context.namespace, () =>
      this.request(
        () =>
          clients.core.createNamespacedSecret({
            namespace: context.namespace.name,
            body: {
              ...this.manifest("v1", "Secret", spec.name, context.ownership, context.namespace),
              type: "Opaque",
              stringData: values,
            },
          }),
        { mutating: true },
      ),
    );
  }

  /**
   * One runtime credential Kubernetes call whose denial an operator fixes with the tenant-api
   * RoleBinding. The typed error names only the fixed operation and the namespace; the
   * cluster's response text never travels with it.
   */
  private async runtimeCredentialClusterAccess<T>(
    verb: RuntimeCredentialsForbiddenByClusterError["verb"],
    resource: RuntimeCredentialsForbiddenByClusterError["resource"],
    namespace: KubernetesNamespaceAddress,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // A 401 is a rejected API credential, which no RoleBinding fixes; it stays generic.
      if (numericErrorStatus(error) === 403) {
        throw new RuntimeCredentialsForbiddenByClusterError({
          verb,
          resource,
          kubernetesNamespace: namespace.name,
          plane: namespace.plane,
          status: 403,
        });
      }
      throw error;
    }
  }

  private generateRuntimeCredentialToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private async withRuntimeCredentialErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ResourceConflictError || error instanceof DependencyUnavailableError) {
        throw error;
      }
      const status = numericErrorStatus(error);
      if (status === 409 || error instanceof OwnershipFailure) {
        throw new ResourceConflictError(
          "The Agent runtime credentials conflict with existing Kubernetes resources.",
        );
      }
      if (status === 401 || status === 403) {
        throw new DependencyUnavailableError(
          "The Kubernetes runtime credential backend is not authorized.",
        );
      }
      throw new DependencyUnavailableError(
        "The Kubernetes runtime credential backend operation failed or its outcome is unknown.",
      );
    }
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
    const storageOwner = labels["openclaw.dev/gateway-namespace"];
    if (
      (existingLabel !== undefined && existingLabel !== ownership.namespaceId) ||
      (existingId !== undefined && existingId !== ownership.namespaceId) ||
      (storageOwner !== undefined && storageOwner !== ownership.namespaceId)
    ) {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} belongs to another tenant.`,
      );
    }
    const requiredLabels = {
      ...this.gatewayMembershipLabels(this.options.executionCluster?.harnessRouting),
      ...(this.options.executionCluster === undefined
        ? { "openclaw.dev/gateway-namespace": ownership.namespaceId }
        : {}),
    };
    const hasGatewayMembership = Object.entries(requiredLabels).every(
      ([key, value]) => labels[key] === value,
    );
    return (
      existingLabel === ownership.namespaceId &&
      existingId === ownership.namespaceId &&
      hasGatewayMembership
    );
  }

  private async verifyUniqueExistingNamespace(
    name: KubernetesNamespaceAddress,
    ownership: Ownership,
  ): Promise<void> {
    const clients = await this.clients(name.plane);
    const observed = await this.request(() =>
      clients.core.listNamespace({
        labelSelector: `openclaw.dev/namespace=${ownership.namespaceId}`,
        timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
      }),
    );
    if (
      !Array.isArray(observed?.items) ||
      observed.items.length > 1 ||
      (observed.items.length === 1 && observed.items[0]?.metadata?.name !== name.name)
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
    if (this.verifyAdoptableNamespace(namespace, ownership)) {
      return;
    }
    const resourceVersion = namespace.metadata.resourceVersion;
    if (typeof resourceVersion !== "string" || resourceVersion.length === 0) {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} requires a resource version.`,
      );
    }
    const clients = await this.clients("execution");
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
                    ...this.gatewayMembershipLabels(this.options.executionCluster?.harnessRouting),
                    ...(this.options.executionCluster === undefined
                      ? { "openclaw.dev/gateway-namespace": ownership.namespaceId }
                      : {}),
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
      if (numericErrorStatus(error) !== 409) {
        throw error;
      }
      const current = await this.getNamespace({
        name: namespace.metadata.name,
        plane: "execution",
      });
      if (current === undefined) {
        throw new OwnershipFailure(
          `Existing Kubernetes namespace ${namespace.metadata.name} does not exist.`,
        );
      }
      if (!this.verifyAdoptableNamespace(current, ownership)) {
        throw error;
      }
    }
    const current = await this.getNamespace({ name: namespace.metadata.name, plane: "execution" });
    if (current === undefined) {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} does not exist.`,
      );
    }
    this.verifyNamespaceOwnership(current, ownership, true);
  }

  private async verifyExistingNetworkPolicies(
    namespace: KubernetesNamespaceAddress,
    ownership: Ownership,
  ): Promise<void> {
    const clients = await this.clients(namespace.plane);
    const observed = asRecord(
      await this.request(() =>
        clients.networking.listNamespacedNetworkPolicy({
          namespace: namespace.name,
          timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        }),
      ),
    );
    if (!Array.isArray(observed?.items)) {
      throw new OwnershipFailure(
        `The existing Kubernetes namespace ${namespace.name} returned invalid NetworkPolicies.`,
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
        metadata.namespace !== namespace.name ||
        (policy.kind !== undefined && policy.kind !== "NetworkPolicy")
      ) {
        throw new OwnershipFailure(
          `The existing Kubernetes namespace ${namespace.name} returned an invalid NetworkPolicy.`,
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
    namespace: KubernetesNamespaceAddress,
    ownership: Ownership,
  ): Promise<boolean> {
    const clients = await this.clients(namespace.plane);
    const infrastructure = [
      ["ResourceQuota", "openclaw-quota"],
      ["LimitRange", "openclaw-limits"],
      ["NetworkPolicy", "allow-dns"],
      ["NetworkPolicy", "allow-gateway-ingress"],
      ["NetworkPolicy", "allow-node-gateway"],
      ["NetworkPolicy", "default-deny"],
    ] as const;
    const resources: ManagedKubernetesObject<"ResourceQuota" | "LimitRange" | "NetworkPolicy">[] =
      [];
    for (const [kind, name] of infrastructure) {
      const existing = await this.getOwned(kind, name, namespace, ownership);
      if (existing !== undefined) {
        resources.push(existing);
      }
    }

    for (const resource of resources) {
      const request = {
        name: resource.metadata.name,
        namespace: namespace.name,
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
        if (numericErrorStatus(error) !== 404) {
          throw error;
        }
      }
      const remaining = await this.getOwned(
        resource.kind,
        resource.metadata.name,
        namespace,
        ownership,
      );
      if (remaining !== undefined) {
        return false;
      }
    }
    return true;
  }

  private async controlNamespace(namespaceId: string): Promise<KubernetesNamespaceAddress> {
    return this.options.executionCluster === undefined
      ? (await this.resolveNamespace(namespaceId)).name
      : { name: kubernetesGatewayNamespaceName(namespaceId), plane: "control" };
  }

  private async clients(plane: KubernetesNamespaceAddress["plane"]): Promise<KubernetesApiClients> {
    if (plane === "execution" && this.options.executionCluster !== undefined) {
      this.executionApiClients ??= this.createClients(this.options.executionCluster.authentication);
      return this.executionApiClients;
    }
    this.apiClients ??= this.createClients(this.options.authentication);
    return this.apiClients;
  }

  private async createClients(
    authentication: KubernetesComputeDriverOptions["authentication"],
  ): Promise<KubernetesApiClients> {
    const { sdk, clientConfiguration, server } = await createKubernetesClientConfiguration(
      authentication,
      (message) => new ConfigurationFailure(message),
    );
    this.patchOptions = sdk.setHeaderOptions("Content-Type", APPLY_CONTENT_TYPE);
    this.mergePatchOptions = sdk.setHeaderOptions("Content-Type", MERGE_PATCH_CONTENT_TYPE);
    return {
      version: new sdk.VersionApi(clientConfiguration),
      core: new sdk.CoreV1Api(clientConfiguration),
      apps: new sdk.AppsV1Api(clientConfiguration),
      discovery: new sdk.DiscoveryV1Api(clientConfiguration),
      networking: new sdk.NetworkingV1Api(clientConfiguration),
      objects: new sdk.KubernetesObjectApi(clientConfiguration),
      server,
    };
  }

  private async request<T>(
    operation: () => Promise<T>,
    options: { readonly mutating?: boolean } = {},
  ): Promise<T> {
    const ownerSignal = currentComputeAbortSignal();
    let waited = 0;
    for (let attempt = 1; ; attempt += 1) {
      ownerSignal?.throwIfAborted();
      const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal =
        ownerSignal === undefined ? deadline : AbortSignal.any([ownerSignal, deadline]);
      try {
        return await withComputeAbortSignal(signal, operation);
      } catch (error) {
        if (ownerSignal?.aborted) {
          throw ownerSignal.reason;
        }
        if (deadline.aborted) {
          throw new KubernetesRequestTimeout("Kubernetes API request timed out.", {
            cause: error,
          });
        }
        const status = numericErrorStatus(error);
        const retryable =
          status === 429 ||
          (status !== undefined && status >= 500) ||
          (status === undefined &&
            !(error instanceof ConfigurationFailure) &&
            !(error instanceof OwnershipFailure));
        if (
          !retryable ||
          options.mutating === true ||
          attempt >= REQUEST_RETRY_ATTEMPTS ||
          waited >= REQUEST_RETRY_BUDGET_MS
        ) {
          throw error;
        }
        const wait = Math.min(
          requestRetryDelay(attempt, status, error),
          REQUEST_RETRY_BUDGET_MS - waited,
        );
        waited += wait;
        await this.waitBeforeRetry(wait, ownerSignal);
      }
    }
  }

  /** Waits before a retry; an owner cancellation ends the wait with its reason. */
  private async waitBeforeRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await delay(delayMs, undefined, { signal });
    } catch (error) {
      throw signal?.aborted === true ? signal.reason : error;
    }
  }

  private operationSignal(): AbortSignal {
    return currentComputeAbortSignal() ?? new AbortController().signal;
  }

  async resolveSandboxNamespace(namespace: Readonly<Namespace>): Promise<Readonly<Namespace>> {
    const placement =
      namespace.existingNamespace === undefined
        ? await this.resolveNamespace(namespace.id)
        : {
            name: { name: namespace.existingNamespace, plane: "execution" as const },
            external: true,
          };
    if (placement.external && namespace.existingNamespace === undefined) {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${placement.name.name} was not explicitly selected.`,
      );
    }
    return Object.freeze({ ...namespace, name: placement.name.name });
  }

  private sandboxNamespaceContext(
    namespace: Readonly<Namespace>,
    namespaceName: KubernetesNamespaceAddress,
  ): Promise<SandboxNamespaceContext> {
    return this.clients(namespaceName.plane).then(({ objects: kubernetes }) => ({
      namespace: { ...namespace, name: namespaceName.name },
      kubernetes,
      signal: this.operationSignal(),
    }));
  }

  private sandboxNamespaceForRevision(
    revision: AgentRevision,
    namespaceName: KubernetesNamespaceAddress,
  ): Namespace {
    return {
      id: revision.namespaceId,
      name: namespaceName.name,
      status: "ready",
      createdAt: revision.createdAt,
    };
  }

  /** The profile of the revision's Harness Pod. A SandboxDriver that provisions
   * the Harness fences its egress, so Compute grants that Pod ingress only. */
  private harnessNetworkProfile(revision: AgentRevision): NetworkProfile {
    return revision.harness.mode === "dedicated" &&
      this.sandboxDriverForRevision(revision)?.provisionHarness !== undefined
      ? PROVIDER_FENCED_NETWORK_PROFILE
      : ORDINARY_NETWORK_PROFILE;
  }

  private sandboxDriverForRevision(revision: AgentRevision): SandboxDriver | undefined {
    if (revision.sandboxDriverId === undefined) {
      return undefined;
    }
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
    namespace: KubernetesNamespaceAddress,
  ): void {
    if (
      sandbox.namespaceName !== namespace.name ||
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
    namespace: KubernetesNamespaceAddress,
    labels: Readonly<Record<string, string>>,
  ): Promise<boolean> {
    const clients = await this.clients(namespace.plane);
    const pods = asRecord(
      await this.request(() =>
        clients.core.listNamespacedPod({
          namespace: namespace.name,
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
        if (observed.type === "Ready") {
          ready = observed.status === "True";
        }
      }
      if (
        metadata.namespace !== namespace.name ||
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

  private async revisionPods(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    role: "agent" | "gateway",
  ): Promise<readonly KubernetesRecord[]> {
    const clients = await this.clients(namespace.plane);
    const labels = {
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/revision": revision.id,
      "openclaw.dev/workload-role": role,
    };
    const pods = asRecord(
      await this.request(() =>
        clients.core.listNamespacedPod({
          namespace: namespace.name,
          labelSelector: labelsToSelector(labels),
          timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        }),
      ),
    );
    const metadata = asRecord(pods?.metadata);
    if (
      !Array.isArray(pods?.items) ||
      (pods.apiVersion !== undefined && pods.apiVersion !== "v1") ||
      (pods.kind !== undefined && pods.kind !== "PodList") ||
      (pods.metadata !== undefined && metadata === undefined) ||
      (metadata?.continue !== undefined && metadata.continue !== "") ||
      (metadata?._continue !== undefined && metadata._continue !== "") ||
      (metadata?.remainingItemCount !== undefined && metadata.remainingItemCount !== 0)
    ) {
      throw new DependencyUnavailableError("The Kubernetes client returned an invalid Pod list.");
    }
    return Object.freeze(
      pods.items.map((item) => {
        const pod = asRecord(item);
        const podMetadata = asRecord(pod?.metadata);
        const podLabels = asRecord(podMetadata?.labels);
        if (
          pod === undefined ||
          (pod.apiVersion !== undefined && pod.apiVersion !== "v1") ||
          (pod.kind !== undefined && pod.kind !== "Pod") ||
          podMetadata === undefined ||
          !isNonEmptyString(podMetadata.name) ||
          podMetadata.namespace !== namespace.name ||
          podLabels === undefined ||
          Object.entries(labels).some(([key, value]) => podLabels[key] !== value)
        ) {
          throw new DependencyUnavailableError("The Kubernetes client returned an invalid Pod.");
        }
        return pod;
      }),
    );
  }

  private normalizePluginWarnings(
    revision: AgentRevision,
    warnings: readonly unknown[],
  ): readonly PluginDeploymentWarning[] {
    const admitted = revision.plugins?.plugins ?? {};
    const byPlugin = new Map<string, PluginDeploymentWarning>();
    for (const warning of warnings) {
      const diagnostic = asRecord(warning);
      if (
        diagnostic === undefined ||
        (diagnostic.code !== "PLUGIN_INSTALL_FAILED" &&
          diagnostic.code !== "PLUGIN_AUTH_REQUIRED") ||
        !isNonEmptyString(diagnostic.pluginId) ||
        !Object.hasOwn(admitted, diagnostic.pluginId)
      ) {
        throw new DependencyUnavailableError("Plugin runtime status returned invalid warnings.");
      }
      if (byPlugin.has(diagnostic.pluginId)) {
        throw new DependencyUnavailableError("Plugin runtime status returned invalid warnings.");
      }
      byPlugin.set(diagnostic.pluginId, {
        code: diagnostic.code,
        pluginId: diagnostic.pluginId,
      });
    }
    return Object.freeze(
      [...byPlugin.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
    );
  }

  private podContainerId(pod: unknown, container: "agent" | "gateway"): string | undefined {
    const status = asRecord(asRecord(pod)?.status);
    const containerStatuses = Array.isArray(status?.containerStatuses)
      ? status.containerStatuses
      : [];
    const containerStatus = containerStatuses
      .map((candidate) => asRecord(candidate))
      .find((candidate) => candidate?.name === container);
    return isNonEmptyString(containerStatus?.containerID) ? containerStatus.containerID : undefined;
  }

  private runtimeStatusContainers(revision: AgentRevision): readonly ("agent" | "gateway")[] {
    return revision.harness.mode === "embedded" ? ["gateway"] : ["agent", "gateway"];
  }

  private async runtimeDiagnosticChecks(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    container: "agent" | "gateway",
  ): Promise<readonly RuntimeDiagnosticCheck[] | undefined> {
    const readback = await this.privateStatusReadback(
      revision,
      namespace,
      container,
      RUNTIME_DIAGNOSTICS_PATH,
    );
    if (readback === undefined) {
      return undefined;
    }
    return this.validRuntimeDiagnosticChecks(readback.status, revision, container, readback.podUid);
  }

  private async privateStatusReadback(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    container: "agent" | "gateway",
    path: string,
  ): Promise<PrivateStatusReadback | undefined> {
    namespace = container === "gateway" ? this.gatewayNamespace(revision, namespace) : namespace;
    const pods = (await this.revisionPods(revision, namespace, container)).filter(
      (pod) => asRecord(pod.metadata)?.deletionTimestamp === undefined,
    );
    if (pods.length !== 1) {
      return undefined;
    }
    const pod = pods[0]!;
    const metadata = asRecord(pod.metadata);
    const podName = metadata?.name;
    const podUid = metadata?.uid;
    if (!isNonEmptyString(podName) || !isNonEmptyString(podUid)) {
      return undefined;
    }
    const containerId = this.podContainerId(pod, container);
    const clients = await this.clients(namespace.plane);
    // 404/503 mean the status port is not serving yet: an answer, not an outage to retry.
    const notServing = Symbol("not serving");
    const raw = await this.request(async () => {
      try {
        return await clients.core.connectGetNamespacedPodProxyWithPath({
          name: `${podName}:${PLUGIN_RUNTIME_STATUS_PORT}`,
          namespace: namespace.name,
          path: path.slice(1),
        });
      } catch (error) {
        if (numericErrorStatus(error) === 404 || numericErrorStatus(error) === 503) {
          return notServing;
        }
        throw error;
      }
    });
    if (raw === notServing) {
      return undefined;
    }
    const parsed = this.boundedRuntimeStatusResponse(raw);
    const latestPods = (await this.revisionPods(revision, namespace, container)).filter(
      (candidate) => asRecord(candidate.metadata)?.deletionTimestamp === undefined,
    );
    if (latestPods.length !== 1) {
      return undefined;
    }
    const latestMetadata = asRecord(latestPods[0]!.metadata);
    const latestContainerId = this.podContainerId(latestPods[0], container);
    if (
      latestMetadata?.name !== podName ||
      latestMetadata.uid !== podUid ||
      latestMetadata.deletionTimestamp !== undefined ||
      ((containerId !== undefined || latestContainerId !== undefined) &&
        latestContainerId !== containerId)
    ) {
      return undefined;
    }
    return { status: parsed, podUid, containerId };
  }

  private boundedRuntimeStatusResponse(value: unknown): unknown {
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > MAX_RUNTIME_STATUS_RESPONSE_BYTES) {
        throw new DependencyUnavailableError("Runtime status returned oversized data.");
      }
      try {
        return JSON.parse(value);
      } catch {
        throw new DependencyUnavailableError("Runtime status returned invalid data.");
      }
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new DependencyUnavailableError("Runtime status returned invalid data.");
    }
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > MAX_RUNTIME_STATUS_RESPONSE_BYTES
    ) {
      throw new DependencyUnavailableError("Runtime status returned oversized data.");
    }
    return value;
  }

  private validRuntimeDiagnosticChecks(
    value: unknown,
    revision: AgentRevision,
    container: "agent" | "gateway",
    podUid: string,
  ): readonly RuntimeDiagnosticCheck[] {
    const status = asRecord(value);
    if (
      status === undefined ||
      status.revisionId !== revision.id ||
      status.container !== container ||
      status.podUid !== podUid ||
      !this.validIsoTimestamp(status.observedAt) ||
      !Array.isArray(status.checks) ||
      status.checks.length > 32
    ) {
      throw new DependencyUnavailableError("Runtime status returned invalid data.");
    }
    return Object.freeze(status.checks.map((check) => this.validRuntimeDiagnosticCheck(check)));
  }

  private validRuntimeDiagnosticCheck(value: unknown): RuntimeDiagnosticCheck {
    const check = asRecord(value);
    const state = check?.state;
    const checkedAt = check?.checkedAt;
    if (
      check === undefined ||
      !this.validRuntimeStatusIdentifier(check.component) ||
      !this.validRuntimeStatusIdentifier(check.check) ||
      !this.validRuntimeDiagnosticState(state) ||
      (checkedAt !== null &&
        (typeof checkedAt !== "string" || !this.validIsoTimestamp(checkedAt))) ||
      (check.code !== undefined && !this.validRuntimeStatusIdentifier(check.code))
    ) {
      throw new DependencyUnavailableError("Runtime status returned invalid diagnostic data.");
    }
    return {
      component: check.component,
      check: check.check,
      state,
      checkedAt,
      ...(check.code === undefined ? {} : { code: check.code }),
    };
  }

  private validRuntimeDiagnosticState(value: unknown): value is RuntimeDiagnosticState {
    return value === "succeeded" || value === "failed" || value === "unknown";
  }

  private runtimeFailureEvidence(value: unknown): RuntimeFailureEvidence | undefined {
    if (value === undefined) {
      return undefined;
    }
    const failed = asRecord(value);
    if (
      failed === undefined ||
      !this.validRuntimeStatusIdentifier(failed.component) ||
      !this.validRuntimeStatusIdentifier(failed.check) ||
      !this.validRuntimeStatusIdentifier(failed.code) ||
      !this.validIsoTimestamp(failed.checkedAt)
    ) {
      throw new DependencyUnavailableError("Runtime failure status returned invalid data.");
    }
    // The runtime classifies a failed model probe from a closed vocabulary. A
    // cause outside it is dropped rather than trusted; the failure code stays.
    const cause =
      failed.code === "MODEL_PROBE_FAILED" ? runtimeFailureCause(failed.cause) : undefined;
    return Object.freeze({
      component: failed.component,
      check: failed.check,
      checkedAt: failed.checkedAt,
      code: failed.code,
      ...(cause === undefined ? {} : { cause }),
    });
  }

  private validRuntimeStatusIdentifier(value: unknown): value is string {
    return typeof value === "string" && RUNTIME_STATUS_IDENTIFIER.test(value);
  }

  private validIsoTimestamp(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
  }

  private cachedRuntimeFailureEvidence(
    value: unknown,
    revision: AgentRevision,
    container: "agent" | "gateway",
    podUid: string,
  ): RuntimeFailureEvidence | undefined {
    const status = asRecord(value);
    if (
      status === undefined ||
      status.revisionId !== revision.id ||
      status.container !== container ||
      status.podUid !== podUid
    ) {
      throw new DependencyUnavailableError("Runtime failure status returned invalid data.");
    }
    return this.runtimeFailureEvidence(status.runtimeFailure);
  }

  private async safeRuntimeFailureObservation(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    workspaceSetup = false,
  ): Promise<RuntimeFailureEvidence | undefined> {
    if (this.options.runtime === undefined) {
      return undefined;
    }
    const ownerSignal = currentComputeAbortSignal();
    try {
      if (workspaceSetup) {
        const component = revision.harness.mode === "embedded" ? "gateway" : "agent";
        const pods = await this.revisionPods(revision, namespace, component);
        for (const pod of pods) {
          if (asRecord(pod.metadata)?.deletionTimestamp !== undefined) {
            continue;
          }
          const status = asRecord(pod.status);
          const initialized = Array.isArray(status?.initContainerStatuses)
            ? status.initContainerStatuses
                .map(asRecord)
                .find((item) => item?.name === "initialize-workspace")
            : undefined;
          const state = asRecord(initialized?.state);
          const terminated =
            asRecord(state?.terminated) ??
            (state?.waiting === undefined
              ? undefined
              : asRecord(asRecord(initialized?.lastState)?.terminated));
          if (typeof terminated?.exitCode === "number" && terminated.exitCode !== 0) {
            return {
              component,
              check: "workspace-setup",
              code: "WORKSPACE_SETUP_FAILED",
              checkedAt:
                typeof terminated.finishedAt === "string" &&
                this.validIsoTimestamp(terminated.finishedAt)
                  ? terminated.finishedAt
                  : new Date().toISOString(),
            };
          }
        }
      }
      for (const container of this.runtimeStatusContainers(revision)) {
        const readback = await this.privateStatusReadback(
          revision,
          namespace,
          container,
          RUNTIME_STATUS_PATH,
        );
        if (readback === undefined) {
          continue;
        }
        const failure = this.cachedRuntimeFailureEvidence(
          readback.status,
          revision,
          container,
          readback.podUid,
        );
        if (failure !== undefined) {
          return failure;
        }
      }
      return undefined;
    } catch {
      if (ownerSignal?.aborted) {
        throw ownerSignal.reason;
      }
      return undefined;
    }
  }

  // True when a live Pod of this revision is unschedulable (PodScheduled False,
  // reason Unschedulable), for example for want of node memory. Like failure
  // evidence, an unavailable observation reports nothing.
  private async safeUnschedulableObservation(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<boolean> {
    const ownerSignal = currentComputeAbortSignal();
    try {
      for (const role of this.runtimeStatusContainers(revision)) {
        const target = role === "gateway" ? this.gatewayNamespace(revision, namespace) : namespace;
        for (const pod of await this.revisionPods(revision, target, role)) {
          if (asRecord(pod.metadata)?.deletionTimestamp !== undefined) {
            continue;
          }
          const conditions = asRecord(pod.status)?.conditions;
          if (
            Array.isArray(conditions) &&
            conditions.some((item) => {
              const condition = asRecord(item);
              return (
                condition?.type === "PodScheduled" &&
                condition.status === "False" &&
                condition.reason === "Unschedulable"
              );
            })
          ) {
            return true;
          }
        }
      }
      return false;
    } catch {
      if (ownerSignal?.aborted) {
        throw ownerSignal.reason;
      }
      return false;
    }
  }

  private async pluginRuntimeStatus(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    container: "agent" | "gateway",
    expectedWarnings?: readonly PluginDeploymentWarning[],
  ): Promise<PluginRuntimeStatus | undefined> {
    const readback = await this.privateStatusReadback(
      revision,
      namespace,
      container,
      PLUGIN_RUNTIME_STATUS_PATH,
    );
    if (readback === undefined) {
      return undefined;
    }
    const status = asRecord(readback.status);
    const podUid = readback.podUid;
    if (
      status === undefined ||
      status.revisionId !== revision.id ||
      status.container !== container ||
      status.podUid !== podUid ||
      !isNonEmptyString(status.startupId) ||
      (status.phase !== "starting" && status.phase !== "ready") ||
      !Array.isArray(status.successfulPluginIds) ||
      status.successfulPluginIds.some((pluginId) => !isNonEmptyString(pluginId)) ||
      !Array.isArray(status.failures)
    ) {
      throw new DependencyUnavailableError("Plugin runtime status returned invalid data.");
    }
    if (status.phase !== "ready") {
      return undefined;
    }
    const failures = this.normalizePluginWarnings(revision, status.failures);
    const failurePluginIds = new Set(failures.map((failure) => failure.pluginId));
    const admitted = revision.plugins?.plugins ?? {};
    const reportedSuccessfulPluginIds = status.successfulPluginIds as readonly string[];
    const successfulPluginIds = [...new Set(reportedSuccessfulPluginIds)];
    const enabledPluginIds = new Set(
      Object.entries(admitted)
        .filter(([, selection]) => selection.enabled)
        .map(([pluginId]) => pluginId),
    );
    if (
      successfulPluginIds.length !== reportedSuccessfulPluginIds.length ||
      successfulPluginIds.some(
        (pluginId) => !Object.hasOwn(admitted, pluginId) || failurePluginIds.has(pluginId),
      ) ||
      failures.some((failure) => !enabledPluginIds.has(failure.pluginId)) ||
      successfulPluginIds.some((pluginId) => !enabledPluginIds.has(pluginId)) ||
      successfulPluginIds.length + failures.length !== enabledPluginIds.size
    ) {
      throw new DependencyUnavailableError("Plugin runtime status returned invalid data.");
    }
    if (expectedWarnings !== undefined) {
      const expected = this.normalizePluginWarnings(revision, expectedWarnings);
      if (!isDeepStrictEqual(failures, expected)) {
        return undefined;
      }
    }
    return {
      revisionId: revision.id,
      container,
      startupId: status.startupId as string,
      podUid,
      phase: "ready",
      successfulPluginIds,
      failures,
    };
  }

  /** Dispatch revalidates against the paired gateway's current catalog, not admission's copy. */
  private async admittedCredentialSourceType(
    revision: AgentRevision,
  ): Promise<CredentialSourceType | undefined> {
    if (revision.harnessAuth.method !== "credential_source") {
      return undefined;
    }
    const sourceType = revision.harnessAuth.sourceType;
    const catalog = await this.requireCredentialGateway().listSourceTypes({
      signal: this.operationSignal(),
    });
    return catalog.find((entry) => entry.type === sourceType);
  }

  private requireCredentialGateway(): CredentialGatewayDriver {
    if (this.credentialGatewayDriver === undefined) {
      throw new ConfigurationFailure(
        "The admitted revision requires the Credential Gateway Driver.",
      );
    }
    return this.credentialGatewayDriver;
  }

  private harnessRequirementsFromDeployment(
    deployment: ManagedKubernetesObject,
    loginMode: HarnessWorkloadRequirements["loginMode"],
    credentialAttachments: readonly CredentialSourceAttachment[] = [],
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
    if (
      Array.isArray(spec?.initContainers) &&
      spec.initContainers.some((item) => asRecord(item)?.name === "initialize-workspace")
    ) {
      throw new ConfigurationFailure(
        "Sandbox Harness requirements cannot deliver workspace initialization.",
      );
    }
    const environment = this.sandboxEnvironmentVariables(container?.env);
    const workspaceMounts = this.sandboxWorkspaceMounts(
      spec?.volumes,
      container?.volumeMounts,
      loginMode === "oauth",
    );
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
    if (harnessLabels[NETWORK_PROFILE_LABEL] !== ORDINARY_NETWORK_PROFILE) {
      throw new ConfigurationFailure("Dedicated Harness requires the ordinary network profile.");
    }
    // The provider fences the Harness egress itself. The provider-fenced profile
    // keeps Compute's DNS, model and authentication egress grants off the Pod.
    harnessLabels[NETWORK_PROFILE_LABEL] = PROVIDER_FENCED_NETWORK_PROFILE;
    return {
      image,
      command: command as readonly string[],
      serviceAccountName,
      serviceAccountToken,
      workspaceMounts,
      environment,
      credentialAttachments: Object.freeze([...credentialAttachments]),
      loginMode,
      labels: harnessLabels,
    };
  }

  // Node identity belongs to the Agent and its Harness kind, not the revision.
  // OpenClaw never rewrites a session's recorded device, so a replacement must
  // reconnect as the same device. Dedicated predecessors are stopped, and their
  // Pods gone, before a successor is prepared, so one Harness holds it at a time.
  private workspaceNodeName(revision: {
    readonly agentId: string;
    readonly harness: { readonly id: string };
  }): string {
    if (!WORKSPACE_NODE_HARNESS_IDS.includes(revision.harness.id)) {
      throw new ConfigurationFailure(
        "Workspace nodes are limited to Codex and OpenClaw Harnesses.",
      );
    }
    return `workspace-node-${sha256Hex(revision.agentId, 12)}-${sha256Hex(`harness:${revision.harness.id}`, 12)}`;
  }

  // Before Agent scoping, each revision enrolled its own node Secret. Remove
  // one left by an upgraded installation when that revision retires.
  private async retireLegacyWorkspaceNode(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    // Revision-scoped Secrets existed only for routed dedicated Harnesses.
    if (
      this.nodeEnrollment === undefined ||
      this.options.runtime === undefined ||
      this.options.gatewayRouting === undefined ||
      revision.harness.mode !== "dedicated"
    ) {
      return;
    }
    await this.deleteOwnedNamespacedResource(
      "Secret",
      `workspace-node-${sha256Hex(revision.agentId, 12)}-${sha256Hex(revision.id, 12)}`,
      this.pluginRuntimeOwnership(revision),
      namespace,
    );
  }

  private workspaceNodeOwnership(revision: AgentRevision): Ownership {
    return { namespaceId: revision.namespaceId, agentId: revision.agentId };
  }

  private async deleteWorkspaceNodes(
    agentId: string,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    for (const id of WORKSPACE_NODE_HARNESS_IDS) {
      await this.deleteOwnedNamespacedResource(
        "Secret",
        this.workspaceNodeName({ agentId, harness: { id } }),
        ownership,
        namespace,
      );
    }
  }

  // The node wiring a Harness template carries. It depends only on the Agent
  // and the controller trust bundle, never on the setup Secret, so a
  // file-delivered Harness renders the same template before and after enrollment.
  private async workspaceNodeWiring(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<{ readonly name: string; readonly ca?: string } | undefined> {
    if (
      this.nodeEnrollment === undefined ||
      this.options.runtime === undefined ||
      this.getGatewayEndpoint(revision) === undefined
    ) {
      return undefined;
    }
    // The namespace policy lets the Harness reach its Gateway once the setup lands.
    await this.reconcileWorkspaceNodeNetworkPolicy(revision, namespace);
    const ca = await this.readNodeCa?.();
    return { name: this.workspaceNodeName(revision), ...(ca === undefined ? {} : { ca }) };
  }

  // Only a Deployment-backed Codex Harness reads its setup code from a file.
  // Native workers and SandboxDriver Harnesses keep the environment reference,
  // which needs the key for as long as the Harness may restart.
  private workspaceNodeSetupFile(revision: AgentRevision): boolean {
    return (
      revision.harness.id !== "openclaw" &&
      this.sandboxDriverForRevision(revision)?.provisionHarness === undefined
    );
  }

  private async reconcileWorkspaceNodeNetworkPolicy(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const namespaceOwnership = { namespaceId: revision.namespaceId };
    const nodePolicy = this.workspaceNodeNetworkPolicy(namespaceOwnership, namespace);
    const existingNodePolicy = await this.getOwned(
      "NetworkPolicy",
      nodePolicy.metadata.name,
      namespace,
      namespaceOwnership,
    );
    // allow-node-gateway is namespace-wide but written while preparing one
    // Agent. Narrowing a pre-profile policy here would strip workspace-node
    // egress from every other Agent's unprofiled Pods, so it keeps its exact
    // legacy selector until the namespace is recreated.
    const legacy =
      existingNodePolicy !== undefined &&
      isDeepStrictEqual(
        existingNodePolicy.spec?.podSelector,
        LEGACY_WORKSPACE_NODE_POLICY_SELECTOR,
      );
    await this.reconcile(
      legacy
        ? {
            ...nodePolicy,
            spec: {
              ...nodePolicy.spec,
              podSelector: structuredClone(LEGACY_WORKSPACE_NODE_POLICY_SELECTOR),
            },
          }
        : nodePolicy,
      namespaceOwnership,
      namespace,
    );
  }

  // Sync the running Harness Pods now so their optional setup volume shows the
  // new code within seconds. Without this update event the kubelet refreshes
  // the volume only on its periodic resync (measured 58-84 s on k3d, #612).
  private async refreshWorkspaceNodeSetup(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    setupId: string,
  ): Promise<void> {
    const clients = await this.clients(namespace.plane);
    for (const pod of await this.revisionPods(revision, namespace, "agent")) {
      const name = required(asRecord(pod.metadata)?.name, "Harness Pod name");
      try {
        await this.request(
          () =>
            clients.core.patchNamespacedPod(
              {
                name,
                namespace: namespace.name,
                // The value only has to change per setup; it names no secret.
                body: {
                  metadata: { annotations: { [NODE_SETUP_ANNOTATION]: sha256Hex(setupId, 12) } },
                },
              },
              this.mergePatchOptions,
            ),
          { mutating: true },
        );
      } catch (error) {
        // A Pod that is already gone mounts the current Secret when it is replaced.
        if (numericErrorStatus(error) !== 404) {
          throw error;
        }
      }
    }
  }

  // Activation must read OpenClaw's ack from the Gateway's private status. An
  // install whose controller cannot read it keeps the node in the pod spec,
  // which OpenClaw applies before the Gateway ever becomes ready.
  private usesWorkspaceNodeBinding(revision: AgentRevision): boolean {
    return (
      revision.harness.mode === "dedicated" &&
      revision.harness.id !== "openclaw" &&
      this.nodeEnrollment !== undefined &&
      this.options.runtime !== undefined &&
      this.getGatewayEndpoint(revision) !== undefined &&
      this.gatewayPrivateStatusReachable()
    );
  }

  private workspaceNodeBindingName(agentId: string): string {
    return `gateway-${sha256Hex(agentId, 12)}-workspace-node`;
  }

  private async deliveredWorkspaceNodeBinding(
    configuration: GatewayConfigurationSnapshot,
    namespace: KubernetesNamespaceAddress,
    ownership: Ownership,
  ): Promise<{ readonly revisionId?: unknown; readonly deviceId?: unknown } | undefined> {
    if (configuration.workspaceNodeBinding === undefined) {
      return undefined;
    }
    const existing = await this.getOwned(
      "ConfigMap",
      configuration.workspaceNodeBinding,
      namespace,
      ownership,
    );
    const document = existing?.data?.[WORKSPACE_NODE_BINDING_FILE];
    if (document === undefined) {
      return undefined;
    }
    try {
      return asRecord(JSON.parse(document)) ?? {};
    } catch {
      return {};
    }
  }

  // The binding holds identifiers only: the revision it belongs to and the
  // enrolled device. Only the controller writes it, under Agent ownership.
  private async deliverWorkspaceNodeBinding(
    revision: AgentRevision,
    configuration: GatewayConfigurationSnapshot,
    namespace: KubernetesNamespaceAddress,
    ownership: Ownership,
  ): Promise<void> {
    const name = configuration.workspaceNodeBinding;
    const deviceId = configuration.workspaceNodeId;
    if (name === undefined || deviceId === undefined) {
      return;
    }
    if (!WORKSPACE_NODE_ID_PATTERN.test(deviceId)) {
      throw new DependencyUnavailableError("The workspace node device ID is invalid.");
    }
    const document = JSON.stringify({ revisionId: revision.id, deviceId });
    const existing = await this.getOwned("ConfigMap", name, namespace, ownership);
    if (existing?.data?.[WORKSPACE_NODE_BINDING_FILE] === document) {
      return;
    }
    if (existing !== undefined && existing.immutable === true) {
      throw new OwnershipFailure(`Refusing immutable workspace node binding ${name}.`);
    }
    const clients = await this.clients(namespace.plane);
    await this.request(
      () =>
        clients.core.patchNamespacedConfigMap(
          {
            name,
            namespace: required(namespace.name, "ConfigMap namespace"),
            body: {
              ...this.manifest("v1", "ConfigMap", name, ownership, namespace),
              data: { [WORKSPACE_NODE_BINDING_FILE]: document },
            },
            fieldManager: FIELD_MANAGER,
            force: false,
          },
          this.patchOptions,
        ),
      { mutating: true },
    );
    await this.refreshWorkspaceNodeBinding(revision, namespace, document);
  }

  // Like the Harness setup nudge: a Pod update event makes the kubelet refresh
  // the optional ConfigMap volume now instead of on its periodic resync.
  private async refreshWorkspaceNodeBinding(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    document: string,
  ): Promise<void> {
    const clients = await this.clients(namespace.plane);
    for (const pod of await this.revisionPods(revision, namespace, "gateway")) {
      const name = required(asRecord(pod.metadata)?.name, "Gateway Pod name");
      try {
        await this.request(
          () =>
            clients.core.patchNamespacedPod(
              {
                name,
                namespace: namespace.name,
                body: {
                  metadata: {
                    annotations: { [WORKSPACE_NODE_BINDING_ANNOTATION]: sha256Hex(document, 12) },
                  },
                },
              },
              this.mergePatchOptions,
            ),
          { mutating: true },
        );
      } catch (error) {
        // A Pod that is already gone mounts the current binding when it is replaced.
        if (numericErrorStatus(error) !== 404) {
          throw error;
        }
      }
    }
  }

  // The Gateway's private status reports the node OpenClaw applied. It is
  // readable only through the control plane's API server proxy, which needs the
  // control source CIDRs: a dedicated Gateway always runs in the control
  // namespace. (An execution cluster's own status CIDRs are required nonempty.)
  private gatewayPrivateStatusReachable(): boolean {
    return (this.options.network.pluginStatusProxySourceCidrs ?? []).length > 0;
  }

  private async workspaceNodeBindingApplied(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    configuration: GatewayConfigurationSnapshot,
  ): Promise<boolean> {
    if (
      configuration.workspaceNodeBinding === undefined ||
      configuration.workspaceNodeId === undefined
    ) {
      return true;
    }
    const signal = this.operationSignal();
    const budgetKey = `${revision.id}:${configuration.workspaceNodeId}`;
    const spentMs = this.workspaceNodeBindingAckSpentMs.get(budgetKey) ?? 0;
    const started = this.now();
    const deadline = started + Math.max(0, this.workspaceNodeBindingAckWaitMs - spentMs);
    let applied = false;
    try {
      applied = await this.pollWorkspaceNodeBindingAck(
        revision,
        namespace,
        configuration,
        deadline,
        signal,
      );
    } finally {
      if (applied) {
        this.workspaceNodeBindingAckSpentMs.delete(budgetKey);
      } else {
        this.recordBudgetSpent(
          this.workspaceNodeBindingAckSpentMs,
          budgetKey,
          spentMs + Math.max(0, this.now() - started),
        );
      }
    }
    return applied;
  }

  // Reads the Gateway's applied node until it matches or the deadline passes;
  // a spent budget still gets one read, so a late ack is seen on the next attempt.
  private async pollWorkspaceNodeBindingAck(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    configuration: GatewayConfigurationSnapshot,
    deadline: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    for (;;) {
      signal.throwIfAborted();
      const readback = await this.privateStatusReadback(
        revision,
        namespace,
        "gateway",
        RUNTIME_STATUS_PATH,
      );
      if (readback !== undefined) {
        const status = asRecord(readback.status);
        if (
          status === undefined ||
          status.revisionId !== revision.id ||
          status.container !== "gateway" ||
          status.podUid !== readback.podUid ||
          (status.workspaceNodeId !== undefined && typeof status.workspaceNodeId !== "string")
        ) {
          throw new DependencyUnavailableError("Runtime status returned invalid data.");
        }
        if (status.workspaceNodeId === configuration.workspaceNodeId) {
          return true;
        }
        if (status.workspaceNodeFailure !== undefined) {
          const failure = asRecord(status.workspaceNodeFailure);
          if (failure === undefined || !this.validRuntimeStatusIdentifier(failure.code)) {
            throw new DependencyUnavailableError("Runtime status returned invalid data.");
          }
          // The Gateway refuses its own CLI as unauthorized (no gateway.auth.password):
          // it can never confirm the node for this revision, so fail activation now.
          if (failure.code === "GATEWAY_UNAUTHORIZED") {
            throw new ActivationFailedError(
              "AGENT_GATEWAY_UNAUTHORIZED",
              "The exact AgentRevision gateway refused its own CLI as unauthorized.",
            );
          }
          // OpenClaw did not load the node: say why instead of timing out.
          throw new DependencyUnavailableError(
            `The exact AgentRevision gateway could not apply its workspace node (${failure.code}).`,
          );
        }
      }
      // Other Work waiting for the serial worker ends the wait early, like the
      // pairing wait: activation fails, is retried, and reads again (D221).
      if (this.now() >= deadline || (await computeWorkWaiting())) {
        return false;
      }
      await this.delay(WORKSPACE_NODE_BINDING_ACK_POLL_MS);
    }
  }

  private async prepareWorkspaceNode(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    setupFile = false,
  ): Promise<{ readonly name: string; readonly ca?: string } | undefined> {
    const enrollment = this.nodeEnrollment;
    const url = this.getGatewayEndpoint(revision);
    if (enrollment === undefined || this.options.runtime === undefined || url === undefined) {
      return undefined;
    }
    const name = this.workspaceNodeName(revision);
    const ownership = this.workspaceNodeOwnership(revision);
    if (!setupFile) {
      await this.reconcileWorkspaceNodeNetworkPolicy(revision, namespace);
    }
    const existing = await this.getOwned("Secret", name, namespace, ownership);
    const expired =
      existing !== undefined &&
      Number(Buffer.from(existing.data?.expiresAtMs ?? "", "base64").toString("utf8")) <=
        Date.now();
    // A file-delivered node that has paired reconnects with its saved device
    // token and no setup code (readiness removed the code), so it needs no new setup.
    const paired =
      setupFile && Buffer.from(existing?.data?.deviceId ?? "", "base64").toString("utf8") !== "";
    if (existing === undefined || (expired && !paired)) {
      const gatewayOwnership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
      const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
      // Plugin initialization can precede the first Gateway. Start the Harness
      // without a node, then enroll once its Gateway is available.
      if (
        !(await this.gatewayReady(
          gatewayOwnership,
          gatewayName,
          this.gatewayNamespace(revision, namespace),
          revision.id,
        ))
      ) {
        return undefined;
      }
      // An expired setup may already have been redeemed before readiness
      // recorded its device. Re-minting would drop that completion, so record
      // the device from the old setup first.
      const decode = (value: string | undefined) =>
        Buffer.from(value ?? "", "base64").toString("utf8");
      const observed =
        existing !== undefined && !decode(existing.data?.deviceId)
          ? await enrollment.observeSetup(
              url,
              required(decode(existing.data?.setupId), "Workspace node setup ID"),
              this.operationSignal(),
            )
          : undefined;
      const setup = await enrollment.createSetup(url, `${url}/node`, this.operationSignal());
      const setupData = {
        setupId: setup.setupId,
        setupCode: setup.setupCode,
        expiresAtMs: String(setup.expiresAtMs),
        ...(observed === undefined ? {} : { deviceId: observed.deviceId }),
      };
      const clients = await this.clients(namespace.plane);
      if (existing === undefined) {
        // Persist before launching. An uncertain create is not replayed here; the
        // next reconciliation reads the exact Agent-owned Secret first.
        await this.request(
          () =>
            clients.core.createNamespacedSecret({
              namespace: namespace.name,
              body: {
                ...this.manifest("v1", "Secret", name, ownership, namespace),
                type: "Opaque",
                stringData: setupData,
              },
            }),
          { mutating: true },
        );
      } else {
        // The identity outlives revisions, but the native connect entrypoint
        // refuses an expired setup code. Replace only the setup: a recorded
        // deviceId stays, and the node reconnects with its persisted device
        // token, so the new bootstrap token only lets the code decode. A device
        // observed on the expired setup above is recorded in the same write.
        required(existing.metadata.resourceVersion, "Workspace node Secret resource version");
        await this.request(
          () =>
            clients.core.replaceNamespacedSecret({
              name,
              namespace: namespace.name,
              body: {
                apiVersion: "v1",
                kind: "Secret",
                metadata: existing.metadata,
                type: "Opaque",
                data: {
                  ...existing.data,
                  ...Object.fromEntries(
                    Object.entries(setupData).map(([key, value]) => [
                      key,
                      Buffer.from(value, "utf8").toString("base64"),
                    ]),
                  ),
                },
              },
            }),
          { mutating: true },
        );
      }
      if (setupFile) {
        await this.refreshWorkspaceNodeSetup(revision, namespace, setup.setupId);
      }
    }
    const ca = await this.readNodeCa?.();
    return { name, ...(ca === undefined ? {} : { ca }) };
  }

  private addWorkspaceNode(
    deployment: ManagedKubernetesObject,
    name: string,
    ca: string | undefined,
    revision: AgentRevision,
    setupFile: boolean,
    workspaceSetup: WorkspaceSetup | undefined,
  ): void {
    const { container, variables } = this.addNodeEnrollmentState(
      deployment,
      name,
      ca,
      revision,
      setupFile,
    );
    const defaults = asRecord(asRecord(revision.configuration.agents)?.defaults);
    variables.push(
      {
        name: "OPENCLAW_WORKSPACE_BOOTSTRAP",
        // Copy only initialization options; Gateway configuration can contain secrets.
        value: JSON.stringify({
          skipBootstrap: defaults?.skipBootstrap,
          skipOptionalBootstrapFiles: defaults?.skipOptionalBootstrapFiles,
        }),
      },
      {
        // The node keeps its identity across revisions; without a name it would
        // keep the first Harness Pod's host name. Name it after the Agent instead.
        name: "OPENCLAW_NODE_DISPLAY_NAME",
        value: `agent-${sha256Hex(revision.agentId, 12)}-workspace`,
      },
    );
    // Independent restarts can orphan descendants of a failed wrapper. Tini
    // reaps them, including when a Sandbox provider runs this below PID 1.
    container.command = [...RUNTIME_WRAPPER_COMMAND];
    // Keep the workspace setup completion guard the plain Harness program runs:
    // container restarts do not rerun the initializing initContainer.
    container.args = nodeProgramArguments(
      (workspaceSetup === undefined
        ? ""
        : workspaceSetupVerifier(workspaceSetup, "/home/node/workspace")) +
        AGENT_WITH_NODE_ENTRYPOINT,
    );
  }

  private addNativeWorker(
    deployment: ManagedKubernetesObject,
    name: string,
    ca: string | undefined,
    revision: AgentRevision,
  ): void {
    const { container, variables } = this.addNodeEnrollmentState(
      deployment,
      name,
      ca,
      revision,
      false,
    );
    variables.push(
      { name: "TMPDIR", value: "/tmp/openclaw-native-worker" },
      { name: "NODE_COMPILE_CACHE", value: NATIVE_WORKER_COMPILE_CACHE },
      // TODO(native-worker-idle-retirement): Configure upstream idle worker
      // retirement once node hosts expose a supported policy.
      {
        name: "OPENCLAW_NATIVE_WORKER_CAPACITY",
        value: String(
          this.options.runtime?.nativeOpenClawSessionCapacity ??
            DEFAULT_NATIVE_OPENCLAW_SESSION_CAPACITY,
        ),
      },
    );
    container.command = [...RUNTIME_WRAPPER_COMMAND];
    container.args = nodeProgramArguments(NATIVE_WORKER_ENTRYPOINT);
  }

  private addNodeEnrollmentState(
    deployment: ManagedKubernetesObject,
    name: string,
    ca: string | undefined,
    revision: AgentRevision,
    setupFile: boolean,
  ): { readonly container: KubernetesRecord; readonly variables: V1EnvVar[] } {
    const pod = asRecord(asRecord(deployment.spec?.template)?.spec)!;
    const container = (pod.containers as KubernetesRecord[])[0]!;
    const variables = container.env as V1EnvVar[];
    variables.push(
      setupFile
        ? { name: "OPENCLAW_NODE_SETUP_PATH", value: `${NODE_SETUP_DIRECTORY}/${NODE_SETUP_FILE}` }
        : {
            name: "OPENCLAW_NODE_SETUP_CODE",
            valueFrom: { secretKeyRef: { name, key: "setupCode" } },
          },
      { name: "OPENCLAW_NODE_STATE_DIR", value: NODE_STATE_PATH },
      ...(ca === undefined ? [] : [{ name: "OPENCLAW_NODE_CA_PEM", value: ca }]),
    );
    if (setupFile) {
      // The Secret may not exist yet: optional lets the Harness start without it,
      // and the kubelet adds or removes the file as the key comes and goes.
      // Only setupCode is projected; the setup and device ids stay in the API.
      // Secret files are root-owned and the kubelet grants the Pod fsGroup read
      // access, so 0400 would still behave as 0440; say 0440 plainly. Codex runs
      // as the same uid and gid and can read the code. It is one-shot, expires,
      // and readiness removes it from the Secret once the device is recorded.
      (pod.volumes as V1Volume[]).push({
        name: NODE_SETUP_VOLUME,
        secret: {
          secretName: name,
          optional: true,
          defaultMode: 0o440,
          items: [{ key: "setupCode", path: NODE_SETUP_FILE }],
        },
      });
      (container.volumeMounts as V1VolumeMount[]).push({
        name: NODE_SETUP_VOLUME,
        mountPath: NODE_SETUP_DIRECTORY,
        readOnly: true,
      });
    }
    (pod.volumes as V1Volume[]).push({
      name: NODE_STATE_VOLUME,
      persistentVolumeClaim: { claimName: this.harnessWorkspaceClaimName(revision.agentId) },
    });
    // Create the private subdirectory as the runtime user before kubelet mounts it.
    // A kubelet-created subPath is root-owned; native setup cannot tighten its mode.
    const initialization = (pod.initContainers as KubernetesRecord[])[0]!;
    (initialization.volumeMounts as V1VolumeMount[]).push({
      name: NODE_STATE_VOLUME,
      mountPath: "/workspace-node-state",
    });
    const nodeStatePath = `/workspace-node-state/${name}`;
    (initialization.args as string[])[0] += `
mkdirSync(${JSON.stringify(nodeStatePath)}, { recursive: true, mode: 0o700 });
chmodSync(${JSON.stringify(nodeStatePath)}, 0o700);`;
    // Reuse Harness storage outside the project directory. The Agent-scoped
    // subpath preserves node identity across Pod and AgentRevision replacement.
    (container.volumeMounts as V1VolumeMount[]).push({
      name: NODE_STATE_VOLUME,
      mountPath: NODE_STATE_PATH,
      subPath: name,
      readOnly: false,
    });
    return { container, variables };
  }

  private async workspaceNodeDeviceId(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<string | undefined> {
    if (
      revision.harness.mode === "embedded" ||
      this.nodeEnrollment === undefined ||
      this.options.runtime === undefined ||
      this.getGatewayEndpoint(revision) === undefined
    ) {
      return undefined;
    }
    const secret = await this.getOwned(
      "Secret",
      this.workspaceNodeName(revision),
      namespace,
      this.workspaceNodeOwnership(revision),
    );
    const deviceId = Buffer.from(secret?.data?.deviceId ?? "", "base64").toString("utf8");
    return deviceId || undefined;
  }

  private recordBudgetSpent(budgets: Map<string, number>, key: string, spentMs: number): void {
    // Re-insert so the map stays in least-recently-waited order.
    budgets.delete(key);
    budgets.set(key, spentMs);
    if (budgets.size > MAX_WORKSPACE_NODE_PAIRING_BUDGETS) {
      const oldest = budgets.keys().next().value;
      if (oldest !== undefined) {
        budgets.delete(oldest);
      }
    }
  }

  private async workspaceNodeReady(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    pairingWaitMs = 0,
  ): Promise<boolean> {
    const enrollment = this.nodeEnrollment;
    const url = this.getGatewayEndpoint(revision);
    if (enrollment === undefined || this.options.runtime === undefined || url === undefined) {
      return true;
    }
    const name = this.workspaceNodeName(revision);
    const secret = await this.getOwned(
      "Secret",
      name,
      namespace,
      this.workspaceNodeOwnership(revision),
    );
    if (secret === undefined) {
      return false;
    }
    const read = (key: string) => Buffer.from(secret.data?.[key] ?? "", "base64").toString("utf8");
    const deviceId = read("deviceId");
    // A file-delivered setup code is readable by every process in the Harness,
    // Codex included. Once the device is recorded the node reconnects with its
    // saved device token, so drop the code; the kubelet then removes the file.
    const dropSetupCode = this.workspaceNodeSetupFile(revision);
    const withoutSetupCode = (data: Record<string, string>) =>
      dropSetupCode
        ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "setupCode"))
        : data;
    const clients = await this.clients(namespace.plane);
    const replaceSecret = (data: Record<string, string>) => {
      required(secret.metadata.resourceVersion, "Workspace node Secret resource version");
      return this.request(
        () =>
          clients.core.replaceNamespacedSecret({
            name,
            namespace: namespace.name,
            body: {
              apiVersion: "v1",
              kind: "Secret",
              metadata: secret.metadata,
              type: "Opaque",
              data,
            },
          }),
        { mutating: true },
      );
    };
    // Nudge the running Harness Pods as on setup, so the kubelet removes the
    // file now rather than on its ~1 min resync (#612).
    const setupCodeRemoved = async () => {
      if (dropSetupCode && secret.data?.setupCode !== undefined) {
        await this.refreshWorkspaceNodeSetup(revision, namespace, `${read("setupId")}:removed`);
      }
    };
    if (deviceId) {
      if (dropSetupCode && secret.data?.setupCode !== undefined) {
        await replaceSecret(withoutSetupCode(secret.data));
        await setupCodeRemoved();
      }
      return enrollment.isConnected(url, deviceId, this.operationSignal());
    }
    const setupId = required(read("setupId"), "Workspace node setup ID");
    const spentMs = this.workspaceNodePairingSpentMs.get(setupId) ?? 0;
    const waitMs = Math.max(0, Math.min(pairingWaitMs, this.workspaceNodePairingWaitMs - spentMs));
    const started = this.now();
    let observation: NodeSetupObservation | undefined;
    try {
      observation = await enrollment.observeSetup(
        url,
        setupId,
        this.operationSignal(),
        // Another Agent's Work waiting for the serial worker ends the wait:
        // the pass ends pending and the next one reads the setup again (D221).
        waitMs > 0 ? { waitMs, stopWaiting: computeWorkWaiting } : undefined,
      );
    } finally {
      if (waitMs > 0) {
        this.recordBudgetSpent(
          this.workspaceNodePairingSpentMs,
          setupId,
          spentMs + Math.max(0, this.now() - started),
        );
      }
    }
    if (observation === undefined) {
      // No completion is visible: the setup was never redeemed, or its
      // completion aged out of native status retention. Preparation renews an
      // expired setup; readiness does not.
      // TODO(workspace-node-enrollment): reconcile a completion missed beyond
      // native status retention before enabling this path in published images.
      if (Number(read("expiresAtMs")) <= Date.now()) {
        throw new Error("Workspace node setup expired without an observed enrollment.");
      }
      return false;
    }
    await replaceSecret(
      withoutSetupCode({
        ...secret.data,
        deviceId: Buffer.from(observation.deviceId, "utf8").toString("base64"),
      }),
    );
    // With the device recorded, later passes check its presence, not the setup.
    this.workspaceNodePairingSpentMs.delete(setupId);
    await setupCodeRemoved();
    return observation.connected;
  }

  private sandboxEnvironmentVariables(value: unknown): readonly SandboxEnvironmentVariable[] {
    const variables = Array.isArray(value) ? value : [];
    return variables.flatMap((item): readonly SandboxEnvironmentVariable[] => {
      const variable = asRecord(item);
      const name = required(variable?.name, "Harness environment variable name");
      if (COMPUTE_PRIVATE_STATUS_ENVIRONMENT.has(name)) {
        return [];
      }
      if (typeof variable?.value === "string") {
        return [{ name, value: variable.value }];
      }
      const secretKeyRef = asRecord(asRecord(variable?.valueFrom)?.secretKeyRef);
      if (
        typeof secretKeyRef?.name === "string" &&
        secretKeyRef.name.trim().length > 0 &&
        typeof secretKeyRef.key === "string" &&
        secretKeyRef.key.trim().length > 0
      ) {
        return [
          {
            name,
            valueFrom: { secretKeyRef: { name: secretKeyRef.name, key: secretKeyRef.key } },
          },
        ];
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
    oauth: boolean,
  ): readonly SandboxWorkspaceMount[] {
    const observedVolumes = Array.isArray(volumes) ? volumes : [];
    const workspaceVolume = observedVolumes.find(
      (item) => asRecord(item)?.name === HARNESS_WORKSPACE_VOLUME,
    );
    const claimName = required(
      asRecord(asRecord(workspaceVolume)?.persistentVolumeClaim)?.claimName,
      "Harness workspace claim",
    );
    const observedMounts = Array.isArray(volumeMounts) ? volumeMounts : [];
    const workspaceMounts = observedMounts
      .filter((item) => asRecord(item)?.name === HARNESS_WORKSPACE_VOLUME)
      .map((item) => {
        const mount = asRecord(item);
        return {
          claimName,
          subPath: required(mount?.subPath, "Harness workspace subPath"),
          mountPath: required(mount?.mountPath, "Harness workspace mount path"),
          readOnly: mount?.readOnly === true,
        };
      });
    const expected = this.harnessWorkspaceVolumeMounts(oauth);
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
          "Dedicated Harness workspace mounts must match the approved Harness PVC paths.",
        );
      }
    }
    const nodeVolume = observedVolumes.find((item) => asRecord(item)?.name === NODE_STATE_VOLUME);
    if (nodeVolume !== undefined) {
      const nodeClaim = required(
        asRecord(asRecord(nodeVolume)?.persistentVolumeClaim)?.claimName,
        "Harness node state claim",
      );
      const nodeMounts = observedMounts.filter(
        (item) => asRecord(item)?.name === NODE_STATE_VOLUME,
      );
      const mount = asRecord(nodeMounts[0]);
      if (
        nodeClaim !== claimName ||
        nodeMounts.length !== 1 ||
        mount?.mountPath !== NODE_STATE_PATH ||
        typeof mount.subPath !== "string" ||
        !/^workspace-node-[a-f0-9]{12}-[a-f0-9]{12}$/.test(mount.subPath) ||
        mount.readOnly !== false
      ) {
        throw new ConfigurationFailure(
          "Harness node state must preserve its Agent node directory on the Harness claim.",
        );
      }
      workspaceMounts.push({
        claimName: nodeClaim,
        mountPath: NODE_STATE_PATH,
        subPath: mount.subPath,
        readOnly: false,
      });
    }
    return workspaceMounts;
  }

  /**
   * With `preparingRevisionId`, a Gateway Deployment annotated for another
   * revision is the serving predecessor: preparation (embedded or dedicated)
   * observes it but does not re-render it, and activation replaces it. It may predate the
   * explicit network profile, so it is judged without the profile requirement.
   * Every template rendered for the revision itself still needs the profile.
   */
  private async gatewayReady(
    ownership: Ownership,
    gatewayName: string,
    namespace: KubernetesNamespaceAddress,
    preparingRevisionId?: string,
  ): Promise<boolean> {
    const clients = await this.clients(namespace.plane);
    const deployment = await this.getOwned("Deployment", gatewayName, namespace, ownership);
    if (deployment === undefined) {
      return false;
    }
    if (deployment.spec?.replicas !== 1) {
      return false;
    }
    const predecessor =
      preparingRevisionId !== undefined &&
      deployment.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] !== preparingRevisionId;
    if (!this.deploymentReady(deployment, !predecessor)) {
      return false;
    }
    if (!this.deploymentRolledOut(deployment)) {
      return false;
    }
    const service = await this.getOwned("Service", gatewayName, namespace, ownership);
    if (service === undefined) {
      return false;
    }
    const slices = asRecord(
      await this.request(() =>
        clients.discovery.listNamespacedEndpointSlice({
          namespace: namespace.name,
          labelSelector: `kubernetes.io/service-name=${gatewayName}`,
          timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        }),
      ),
    );
    const items = Array.isArray(slices?.items) ? slices.items : [];
    return items.some((item) => {
      const slice = asRecord(item);
      const metadata = asRecord(slice?.metadata);
      if (asRecord(metadata?.labels)?.["kubernetes.io/service-name"] !== gatewayName) {
        return false;
      }
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
        ) {
          return false;
        }
      }
      return (
        Array.isArray(slice?.endpoints) &&
        slice.endpoints.some(
          (endpoint: unknown) => asRecord(asRecord(endpoint)?.conditions)?.ready === true,
        )
      );
    });
  }

  private deploymentReady(deployment: ManagedKubernetesObject, requireProfile = true): boolean {
    const template = asRecord(deployment.spec?.template);
    const labels = asRecord(asRecord(template?.metadata)?.labels);
    const replicas = deployment.spec?.replicas;
    const generation = deployment.metadata.generation;
    const observed = deployment.status?.observedGeneration;
    const ready = deployment.status?.readyReplicas;
    return (
      (!requireProfile || labels?.[NETWORK_PROFILE_LABEL] === ORDINARY_NETWORK_PROFILE) &&
      typeof replicas === "number" &&
      replicas > 0 &&
      typeof generation === "number" &&
      typeof observed === "number" &&
      observed >= generation &&
      typeof ready === "number" &&
      ready >= replicas
    );
  }

  private deploymentRolledOut(deployment: ManagedKubernetesObject): boolean {
    const replicas = deployment.spec?.replicas;
    return (
      typeof replicas === "number" &&
      replicas > 0 &&
      deployment.status?.replicas === replicas &&
      deployment.status.updatedReplicas === replicas &&
      deployment.status.readyReplicas === replicas
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
    if (!external) {
      this.verifyOwnership(namespace, ownership);
    }
  }

  private manifest<Kind extends ReadableResourceKind>(
    apiVersion: string,
    kind: Kind,
    name: string,
    ownership: Ownership,
    namespace?: KubernetesNamespaceAddress,
  ): ManagedKubernetesObject<Kind> {
    return {
      apiVersion,
      kind,
      metadata: {
        name,
        ...(namespace === undefined ? {} : { namespace: namespace.name }),
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

  private networkPolicies(
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
  ): ManagedKubernetesObject<"NetworkPolicy">[] {
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
    const policy = (
      name: string,
      spec: KubernetesRecord,
    ): ManagedKubernetesObject<"NetworkPolicy"> => ({
      ...this.manifest("networking.k8s.io/v1", "NetworkPolicy", name, ownership, namespace),
      spec,
    });
    return [
      policy("default-deny", { podSelector: {}, policyTypes: ["Ingress", "Egress"] }),
      policy("allow-dns", {
        podSelector: ordinaryNetworkPolicySelector(),
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              this.peer(
                namespace.plane === "execution"
                  ? (this.options.executionCluster?.network.dns ?? network.dns)
                  : network.dns,
              ),
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
              // Allow port 5353 for compatibility with OpenShift DNS.
              { protocol: "UDP", port: 5353 },
              { protocol: "TCP", port: 5353 },
            ],
          },
        ],
      }),
      policy("allow-gateway-ingress", {
        podSelector: ordinaryNetworkPolicySelector({ "openclaw.dev/workload-role": "gateway" }),
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

  private async reconcileDnsPorts(
    existing: ManagedKubernetesObject<"NetworkPolicy">,
    desired: ManagedKubernetesObject<"NetworkPolicy">,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const desiredRule = asRecord((desired.spec?.egress as readonly KubernetesRecord[])[0])!;
    // The SDK returns model instances; compare the policy's serialized values.
    const spec = asRecord(JSON.parse(JSON.stringify(existing.spec ?? {})))!;
    const egress: unknown[] = Array.isArray(spec.egress) ? spec.egress : [];
    const index = egress.findIndex((rule) => isDeepStrictEqual(asRecord(rule)?.to, desiredRule.to));
    const rule = asRecord(egress[index]);
    if (rule === undefined || !Array.isArray(rule.ports)) {
      throw new OwnershipFailure(
        "Refusing an allow-dns policy without the configured DNS peer and explicit ports.",
      );
    }
    const ports: unknown[] = rule.ports;
    const desiredPorts: unknown[] = desiredRule.ports as unknown[];
    const additions = desiredPorts.filter(
      (port) => !ports.some((current) => isDeepStrictEqual(current, port)),
    );
    if (additions.length === 0) {
      return;
    }
    const updatedEgress = egress.map((current, position) =>
      position === index ? { ...rule, ports: [...ports, ...additions] } : current,
    );
    const clients = await this.clients(namespace.plane);
    // Only extend the installed DNS rule. Narrowing its selector would remove
    // DNS access from other Agents whose running Pods predate network profiles.
    await this.request(
      () =>
        clients.networking.patchNamespacedNetworkPolicy(
          {
            name: existing.metadata.name,
            namespace: namespace.name,
            body: {
              apiVersion: existing.apiVersion,
              kind: "NetworkPolicy",
              metadata: {
                ...existing.metadata,
                uid: required(existing.metadata.uid, "DNS policy UID"),
                resourceVersion: required(
                  existing.metadata.resourceVersion,
                  "DNS policy resource version",
                ),
              },
              spec: { ...spec, egress: updatedEgress },
            },
          },
          this.mergePatchOptions,
        ),
      { mutating: true },
    );
  }

  private workspaceNodeNetworkPolicy(
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
  ): ManagedKubernetesObject<"NetworkPolicy"> {
    const routing = this.options.gatewayRouting!;
    return {
      ...this.manifest(
        "networking.k8s.io/v1",
        "NetworkPolicy",
        "allow-node-gateway",
        ownership,
        namespace,
      ),
      spec: {
        podSelector: ordinaryNetworkPolicySelector({ "openclaw.dev/workload-role": "agent" }),
        policyTypes: ["Egress"],
        egress: [
          {
            to:
              this.options.executionCluster !== undefined
                ? this.options.executionCluster.network.gatewayEndpointCidrs.map((cidr) => ({
                    ipBlock: { cidr },
                  }))
                : [
                    this.peer({
                      namespace: routing.envoyNamespace,
                      podLabels: {
                        "app.kubernetes.io/component": "proxy",
                        "app.kubernetes.io/managed-by": "envoy-gateway",
                        "app.kubernetes.io/name": "envoy",
                        "gateway.envoyproxy.io/owning-gateway-namespace": routing.gatewayNamespace,
                        "gateway.envoyproxy.io/owning-gateway-name": routing.gatewayName,
                      },
                    }),
                  ],
            ports: [
              {
                protocol: "TCP",
                port:
                  this.options.executionCluster === undefined
                    ? (routing.envoyHttpsTargetPort ?? 10443)
                    : 443,
              },
            ],
          },
        ],
      },
    };
  }

  private workspaceSetupForRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): WorkspaceSetup | undefined {
    const setup = context?.workspaceSetup;
    if (setup === undefined) {
      return undefined;
    }
    if (setup.namespaceId !== revision.namespaceId || setup.agentId !== revision.agentId) {
      throw new ConfigurationFailure("Workspace setup identity does not match the Agent.");
    }
    if (this.options.runtime === undefined) {
      throw new ConfigurationFailure("Workspace setup requires durable native runtime storage.");
    }
    if (workspaceSetupMainAgent(revision.configuration) === undefined) {
      throw new ConfigurationFailure("Workspace setup requires only the native main Agent.");
    }
    const workspace = this.gatewayConfiguration(revision).workspace;
    if (
      workspace !== "/home/node/.openclaw/workspace" &&
      !(revision.harness.mode === "dedicated" && workspace === "/home/node/workspace")
    ) {
      throw new ConfigurationFailure(
        "Workspace setup requires the Agent's managed durable workspace.",
      );
    }
    return setup;
  }

  private workspaceSetupSecretName(agentId: string): string {
    return `workspace-setup-${sha256Hex(agentId, 12)}`;
  }

  private async deliverWorkspaceSetup(
    revision: AgentRevision,
    setup: WorkspaceSetup | undefined,
    namespace: KubernetesNamespaceAddress,
    completed = false,
  ): Promise<void> {
    if (setup === undefined) {
      return;
    }
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const name = this.workspaceSetupSecretName(revision.agentId);
    // API failure objects can echo request bodies; never let private content escape this boundary.
    try {
      const existing = await this.getOwned("Secret", name, namespace, ownership);
      const identity = {
        id: setup.id,
        namespaceId: setup.namespaceId,
        agentId: setup.agentId,
        ...(setup.defaultsId === undefined ? {} : { defaultsId: setup.defaultsId }),
      };
      if (existing !== undefined) {
        const data = asRecord(existing.data);
        const raw = required(data?.["setup.json"], "Workspace setup payload");
        const prior = asRecord(JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
        if (
          prior === undefined ||
          Object.entries(identity).some(([key, value]) => prior[key] !== value) ||
          prior.defaultsId !== setup.defaultsId ||
          typeof prior.completed !== "boolean"
        ) {
          throw new OwnershipFailure("Workspace setup delivery identity conflicted.");
        }
        // A lost ready acknowledgement must never restore document bytes after cleanup.
        if (prior.completed === true || (!completed && !setup.completed)) {
          return;
        }
      }
      const payload = {
        ...identity,
        completed: completed || setup.completed,
        ...(completed || setup.completed ? {} : { files: setup.files }),
      };
      const manifest = this.manifest("v1", "Secret", name, ownership, namespace);
      const body = {
        ...manifest,
        metadata: {
          ...manifest.metadata,
          ...(existing === undefined
            ? {}
            : {
                resourceVersion: required(
                  existing.metadata.resourceVersion,
                  "Workspace setup Secret version",
                ),
                uid: required(existing.metadata.uid, "Workspace setup Secret UID"),
              }),
        },
        type: "Opaque",
        data: { "setup.json": Buffer.from(JSON.stringify(payload)).toString("base64") },
      };
      const clients = await this.clients(namespace.plane);
      await this.request(
        () =>
          existing === undefined
            ? clients.core.createNamespacedSecret({ namespace: namespace.name, body })
            : clients.core.replaceNamespacedSecret({ name, namespace: namespace.name, body }),
        { mutating: true },
      );
    } catch {
      throw new DependencyUnavailableError("Workspace setup private delivery is unavailable.");
    }
  }

  private gatewayConfiguration(
    revision: AgentRevision,
    workspaceNodeId?: string,
    harnessNamespace?: KubernetesNamespaceAddress,
  ): GatewayConfigurationSnapshot {
    const nativeConfiguration = this.kubernetesGatewayConfigurationDocument(revision.configuration);
    const gateway = asRecord(nativeConfiguration.gateway);
    const auth = asRecord(gateway?.auth);
    const password = auth === undefined ? undefined : auth.password;
    const passwordReference = password === undefined ? undefined : asRecord(password);
    const usesGatewayPasswordEnv =
      passwordReference?.source === "env" && passwordReference.id === OPENCLAW_GATEWAY_PASSWORD;
    if (password !== undefined && !usesGatewayPasswordEnv) {
      throw new ConfigurationFailure(
        "Gateway password authentication must use OPENCLAW_GATEWAY_PASSWORD.",
      );
    }
    return {
      name: `gateway-${sha256Hex(revision.agentId, 12)}-rev-${sha256Hex(revision.id, 12)}`,
      revision: revision.revision,
      revisionId: revision.id,
      ...(harnessNamespace === undefined ? {} : { harnessNamespace }),
      usesGatewayPasswordEnv,
      usesWritableNativeAdminConfig: this.usesWritableNativeAdminConfig(nativeConfiguration),
      annotations: {
        "openclaw.dev/configuration-id": revision.configurationId,
        "openclaw.dev/configuration-kind": revision.configurationKind,
        "openclaw.dev/configuration-generation": String(revision.configurationGeneration),
      },
      loggingLevel: admittedLoggingLevel(nativeConfiguration),
      ...(workspaceNodeId === undefined ? {} : { workspaceNodeId }),
      ...(this.usesWorkspaceNodeBinding(revision)
        ? { workspaceNodeBinding: this.workspaceNodeBindingName(revision.agentId) }
        : {}),
      ...(revision.harness.id === "openclaw" && revision.harness.mode === "dedicated"
        ? { nativeWorkerProfile: NATIVE_WORKER_PROFILE }
        : {}),
      ...(revision.harness.id === "openclaw" &&
      revision.harness.mode === "dedicated" &&
      workspaceNodeId !== undefined
        ? { nativeWorkerNodeId: workspaceNodeId }
        : {}),
      workspace:
        asRecord(asRecord(asRecord(nativeConfiguration.agents)?.entries)?.main)?.workspace ??
        asRecord(asRecord(nativeConfiguration.agents)?.defaults)?.workspace ??
        "/home/node/.openclaw/workspace",
    };
  }

  private gatewaySandboxOrigin(revision: AgentRevision): string | undefined {
    const sandbox = this.options.gatewayRouting?.sandbox;
    if (sandbox === undefined || revision.harness.mode !== "dedicated") {
      return undefined;
    }
    const host = `agent-${sha256Hex(`${revision.namespaceId}/${revision.agentId}`, 32)}.${sandbox.domain}`;
    const port = sandbox.publicPort ?? 443;
    return `https://${host}${port === 443 ? "" : `:${port}`}`;
  }

  private gatewaySandboxConfiguration(
    revision: AgentRevision,
    configuration: OpenClawConfigurationDocument,
  ): OpenClawConfigurationDocument {
    const origin = this.gatewaySandboxOrigin(revision);
    if (origin === undefined) {
      return configuration;
    }
    const mcp = asRecord(configuration.mcp);
    const apps = asRecord(mcp?.apps);
    if (
      (configuration.mcp !== undefined && mcp === undefined) ||
      (mcp?.apps !== undefined && apps === undefined)
    ) {
      throw new ConfigurationFailure("Native MCP Apps configuration must be an object.");
    }
    const port = this.options.network.gatewayPort + 1;
    if (
      (apps?.sandboxOrigin !== undefined && apps.sandboxOrigin !== origin) ||
      (apps?.sandboxPort !== undefined && apps.sandboxPort !== port)
    ) {
      throw new ConfigurationFailure(
        "Native sandbox origin and port must match the Compute-owned sandbox route.",
      );
    }
    return {
      ...configuration,
      mcp: {
        ...(mcp as Record<string, OpenClawConfigurationValue> | undefined),
        apps: {
          ...(apps as Record<string, OpenClawConfigurationValue> | undefined),
          sandboxOrigin: origin,
          sandboxPort: port,
        },
      },
    };
  }

  private kubernetesGatewayConfigurationDocument(
    configuration: OpenClawConfigurationDocument,
  ): OpenClawConfigurationDocument {
    const gatewayRecord = asRecord(configuration.gateway);
    if (configuration.gateway !== undefined && gatewayRecord === undefined) {
      throw new ConfigurationFailure("Kubernetes native gateway configuration must be an object.");
    }
    const gateway = (gatewayRecord ?? {}) as Record<string, OpenClawConfigurationValue>;
    const authRecord = asRecord(gateway.auth);
    if (gateway.auth !== undefined && authRecord === undefined) {
      throw new ConfigurationFailure("Kubernetes native gateway auth must be an object.");
    }
    const auth = (authRecord ?? {}) as Record<string, OpenClawConfigurationValue>;
    const trustedProxyRecord = asRecord(auth.trustedProxy);
    if (auth.trustedProxy !== undefined && trustedProxyRecord === undefined) {
      throw new ConfigurationFailure("Kubernetes native trustedProxy auth must be an object.");
    }
    const trustedProxy = (trustedProxyRecord ?? {}) as Record<string, OpenClawConfigurationValue>;
    const identityScopesRecord = asRecord(auth.identityScopes);
    if (auth.identityScopes !== undefined && identityScopesRecord === undefined) {
      throw new ConfigurationFailure("Kubernetes native identityScopes must be an object.");
    }
    const identityScopes = identityScopesRecord as
      Record<string, OpenClawConfigurationValue> | undefined;
    const unsupported = unsupportedNativeGatewayAuthFields(auth);
    if (unsupported.length > 0) {
      throw new ConfigurationFailure(
        `Kubernetes native gateway authentication contains unsupported field ${unsupported[0]}.`,
      );
    }
    if (auth.mode !== undefined && auth.mode !== "trusted-proxy") {
      throw new ConfigurationFailure(
        "Kubernetes Compute supports only native trusted-proxy gateway authentication.",
      );
    }
    if (
      gateway.trustedProxies !== undefined &&
      !cidrSetsEqual(
        trustedProxyCidrSet(gateway.trustedProxies, "Kubernetes native trustedProxies"),
        trustedProxyCidrSet(this.options.network.gatewayTrustedProxyCidrs, "Trusted proxy CIDR"),
      )
    ) {
      throw new ConfigurationFailure(
        "Kubernetes native trustedProxies must match network.gatewayTrustedProxyCidrs.",
      );
    }
    if (gateway.allowRealIpFallback !== undefined && gateway.allowRealIpFallback !== true) {
      throw new ConfigurationFailure(
        "Kubernetes native trusted-proxy authentication requires allowRealIpFallback.",
      );
    }
    if (trustedProxy.userHeader !== undefined && trustedProxy.userHeader !== TRUSTED_PROXY_HEADER) {
      throw new ConfigurationFailure(
        `Kubernetes native trustedProxy.userHeader must be ${TRUSTED_PROXY_HEADER}.`,
      );
    }
    if (
      trustedProxy.allowUsers !== undefined &&
      !isDeepStrictEqual(trustedProxy.allowUsers, [TRUSTED_PROXY_IDENTITY])
    ) {
      throw new ConfigurationFailure(
        `Kubernetes native trustedProxy.allowUsers must contain only ${TRUSTED_PROXY_IDENTITY}.`,
      );
    }
    if (trustedProxy.allowLoopback !== undefined && trustedProxy.allowLoopback !== false) {
      throw new ConfigurationFailure(
        "Kubernetes native trustedProxy.allowLoopback must be false when configured.",
      );
    }
    if (
      identityScopes !== undefined &&
      (!isDeepStrictEqual(Object.keys(identityScopes).sort(), [TRUSTED_PROXY_IDENTITY]) ||
        !isDeepStrictEqual(identityScopes[TRUSTED_PROXY_IDENTITY], ["operator.admin"]))
    ) {
      throw new ConfigurationFailure(
        `Kubernetes native identityScopes must grant only ${TRUSTED_PROXY_IDENTITY} operator.admin.`,
      );
    }
    return {
      ...configuration,
      gateway: {
        ...gateway,
        trustedProxies: [...this.options.network.gatewayTrustedProxyCidrs],
        allowRealIpFallback: true,
        auth: {
          ...auth,
          mode: "trusted-proxy",
          trustedProxy: {
            ...trustedProxy,
            userHeader: TRUSTED_PROXY_HEADER,
            allowUsers: [TRUSTED_PROXY_IDENTITY],
          },
          identityScopes: { [TRUSTED_PROXY_IDENTITY]: ["operator.admin"] },
        },
      },
    };
  }

  private usesWritableNativeAdminConfig(configuration: OpenClawConfigurationDocument): boolean {
    const gateway = asRecord(configuration.gateway);
    const auth = asRecord(gateway?.auth);
    const trustedProxy = asRecord(auth?.trustedProxy);
    const identityScopes = asRecord(auth?.identityScopes)?.["occ-workspace-files"];
    const deviceAutoApprove = asRecord(trustedProxy?.deviceAutoApprove);
    const controlUi = asRecord(gateway?.controlUi);
    return (
      auth?.mode === "trusted-proxy" &&
      trustedProxy?.userHeader === "x-occ-identity" &&
      Array.isArray(trustedProxy.allowUsers) &&
      trustedProxy.allowUsers.includes("occ-workspace-files") &&
      Array.isArray(identityScopes) &&
      identityScopes.includes("operator.admin") &&
      deviceAutoApprove?.enabled === true &&
      Array.isArray(deviceAutoApprove.scopes) &&
      deviceAutoApprove.scopes.includes("operator.admin") &&
      controlUi?.enabled === true &&
      Array.isArray(controlUi.allowedOrigins) &&
      controlUi.allowedOrigins.some(
        (origin) => typeof origin === "string" && origin.trim().length > 0,
      ) &&
      controlUi.dangerouslyDisableDeviceAuth !== true &&
      controlUi.dangerouslyAllowHostHeaderOriginFallback !== true
    );
  }

  private gatewayMembershipLabels(routing = this.options.gatewayRouting): Record<string, string> {
    if (routing === undefined) {
      return {};
    }
    return {
      [GATEWAY_MEMBERSHIP_LABEL]: sha256Hex(
        `${routing.gatewayNamespace}/${routing.gatewayName}`,
        12,
      ),
    };
  }

  private harnessRoutePath(ownership: Ownership): string {
    return `/namespaces/${ownership.namespaceId}/agents/${required(ownership.agentId, "Harness Agent ID")}`;
  }

  private executionProxyPeer(): KubernetesWorkloadPeer {
    const routing = this.options.executionCluster!.harnessRouting;
    return {
      namespace: routing.envoyNamespace,
      podLabels: {
        "app.kubernetes.io/component": "proxy",
        "app.kubernetes.io/managed-by": "envoy-gateway",
        "app.kubernetes.io/name": "envoy",
        "gateway.envoyproxy.io/owning-gateway-namespace": routing.gatewayNamespace,
        "gateway.envoyproxy.io/owning-gateway-name": routing.gatewayName,
      },
    };
  }

  private async reconcileHarnessRoute(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const execution = this.options.executionCluster;
    if (execution === undefined) {
      return;
    }
    const ownership = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
    };
    const name = `agent-${sha256Hex(revision.agentId, 12)}`;
    const service = await this.getOwned("Service", name, namespace, ownership);
    if (service === undefined) {
      throw new DependencyUnavailableError("Harness Service is unavailable.");
    }
    const route = this.manifest(GATEWAY_API_VERSION, "HTTPRoute", name, ownership, namespace);
    await this.reconcile(
      {
        ...route,
        metadata: {
          ...route.metadata,
          ownerReferences: [
            {
              apiVersion: "v1",
              kind: "Service",
              name,
              uid: required(service.metadata.uid, "Harness Service UID"),
              controller: false,
              blockOwnerDeletion: false,
            },
          ],
        },
        spec: {
          hostnames: [execution.harnessRouting.hostname],
          parentRefs: [
            {
              group: "gateway.networking.k8s.io",
              kind: "Gateway",
              namespace: execution.harnessRouting.gatewayNamespace,
              name: execution.harnessRouting.gatewayName,
              sectionName: GATEWAY_LISTENER_SECTION,
            },
          ],
          rules: [
            { path: this.harnessRoutePath(ownership), upstream: "/", port: AGENT_TRANSPORT_PORT },
            {
              path: `${this.harnessRoutePath(ownership)}/plugin-status`,
              upstream: "/openclaw/plugin-runtime/remote-status",
              port: PLUGIN_RUNTIME_STATUS_PORT,
            },
          ].map(({ path, upstream, port }) => ({
            matches: [{ path: { type: "Exact", value: path } }],
            filters: [
              {
                type: "URLRewrite",
                urlRewrite: { path: { type: "ReplaceFullPath", replaceFullPath: upstream } },
              },
            ],
            backendRefs: [{ group: "", kind: "Service", name, port }],
          })),
        },
      },
      ownership,
      namespace,
    );
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

  private gatewayRouteHeaderFilter(
    access: "operator" | "node" | "node-transfer",
  ): KubernetesRecord {
    return {
      type: "RequestHeaderModifier",
      requestHeaderModifier: {
        set: [
          ...(access === "operator"
            ? [{ name: "x-occ-identity", value: "occ-workspace-files" }]
            : []),
          {
            name: "x-real-ip",
            value: "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS_WITHOUT_PORT%",
          },
        ],
        remove: [
          ...(access === "node-transfer" ? [] : ["authorization"]),
          "cookie",
          "forwarded",
          "x-forwarded-for",
          "x-openclaw-scopes",
          ...(access === "node" || access === "node-transfer"
            ? [
                "x-occ-identity",
                "x-api-key",
                "tailscale-user-login",
                "tailscale-user-name",
                "tailscale-user-profile-pic",
                "tailscale-funnel-request",
              ]
            : []),
        ],
      },
    };
  }

  private gatewayRouteBackendRef(service: ManagedKubernetesObject<"Service">): KubernetesRecord {
    return {
      group: "",
      kind: "Service",
      name: service.metadata.name,
      port: this.options.network.gatewayPort,
    };
  }

  private gatewayRoutingHostname(routing: KubernetesGatewayRoutingOptions): string {
    if (routing.hostname !== undefined && routing.hostname.length > 0) {
      return routing.hostname;
    }
    return `occ-gateway-${sha256Hex(
      `${routing.gatewayNamespace}/${routing.gatewayName}`,
      12,
    )}.${routing.envoyNamespace}.svc`;
  }

  private verifyGatewayRoutingConfiguration(
    revision: Pick<AgentRevision, "configuration" | "harness">,
  ): void {
    if (this.options.executionCluster !== undefined && revision.harness.mode !== "dedicated") {
      throw new ConfigurationFailure("Two-cluster execution supports only dedicated Harnesses.");
    }
    if (
      this.options.runtime !== undefined &&
      revision.harness.mode === "dedicated" &&
      (this.options.gatewayRouting === undefined || this.nodeEnrollment === undefined)
    ) {
      throw new ConfigurationFailure(
        "Dedicated Harness storage requires gateway routing and node enrollment.",
      );
    }
    if (this.options.gatewayRouting === undefined) {
      return;
    }
    const gateway = asRecord(revision.configuration.gateway);
    const auth = asRecord(gateway?.auth);
    const trustedProxy = asRecord(auth?.trustedProxy);
    const trustedProxies = gateway?.trustedProxies;
    if (auth?.mode !== "trusted-proxy") {
      throw new ConfigurationFailure(
        "Gateway routing requires native trusted-proxy authentication.",
      );
    }
    const unsupported = unsupportedNativeGatewayAuthFields(auth);
    if (unsupported.length > 0) {
      throw new ConfigurationFailure(
        `Gateway routing native configuration contains unsupported auth field ${unsupported[0]}.`,
      );
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
    namespace: KubernetesNamespaceAddress,
    service: ManagedKubernetesObject<"Service">,
    access: "operator" | "node" | "sandbox" = "operator",
  ): ManagedKubernetesObject<"HTTPRoute"> | undefined {
    const routing = this.options.gatewayRouting;
    if (routing === undefined) {
      return undefined;
    }
    const sandboxOrigin = this.gatewaySandboxOrigin(revision);
    if (access === "sandbox" && sandboxOrigin === undefined) {
      return undefined;
    }
    const name = `${this.gatewayRouteName(revision.agentId)}${access === "operator" ? "" : `-${access}`}`;
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
        hostnames: [
          access === "sandbox"
            ? new URL(sandboxOrigin!).hostname
            : this.gatewayRoutingHostname(routing),
        ],
        parentRefs: [
          {
            group: "gateway.networking.k8s.io",
            kind: "Gateway",
            namespace: routing.gatewayNamespace,
            name: routing.gatewayName,
            sectionName: access === "sandbox" ? "sandbox" : GATEWAY_LISTENER_SECTION,
          },
        ],
        rules:
          access === "sandbox"
            ? [
                {
                  // This origin serves only upstream's public shell/renderer listener.
                  // It must never fall through to the administrative Gateway backend.
                  matches: ["GET", "HEAD"].map((method) => ({
                    method,
                    path: { type: "PathPrefix", value: "/" },
                  })),
                  filters: [this.gatewayRouteHeaderFilter("node")],
                  backendRefs: [
                    {
                      group: "",
                      kind: "Service",
                      name: service.metadata.name,
                      port: this.options.network.gatewayPort + 1,
                    },
                  ],
                },
              ]
            : [
                {
                  matches: [
                    {
                      path: {
                        type: "Exact",
                        value: `${this.gatewayRoutePath(revision)}${access === "node" ? "/node" : ""}`,
                      },
                    },
                  ],
                  filters: [
                    {
                      type: "URLRewrite",
                      urlRewrite: { path: { type: "ReplaceFullPath", replaceFullPath: "/" } },
                    },
                    this.gatewayRouteHeaderFilter(access),
                  ],
                  backendRefs: [this.gatewayRouteBackendRef(service)],
                },
                ...(access === "node"
                  ? [
                      {
                        matches: [
                          {
                            path: {
                              type: "Exact",
                              value: `${this.gatewayRoutePath(revision)}/node/__openclaw__/worker`,
                            },
                          },
                        ],
                        filters: [
                          {
                            type: "URLRewrite",
                            urlRewrite: {
                              path: {
                                type: "ReplaceFullPath",
                                replaceFullPath: "/__openclaw__/worker",
                              },
                            },
                          },
                          this.gatewayRouteHeaderFilter("node"),
                        ],
                        backendRefs: [this.gatewayRouteBackendRef(service)],
                      },
                      ...["worker-bundle/v1", "worker-transfer/v1"].map((transferPath) => ({
                        matches: [
                          {
                            path: {
                              type: "PathPrefix",
                              value: `${this.gatewayRoutePath(revision)}/node/__openclaw__/${transferPath}/`,
                            },
                          },
                        ],
                        filters: [
                          {
                            type: "URLRewrite",
                            urlRewrite: {
                              path: {
                                type: "ReplacePrefixMatch",
                                replacePrefixMatch: `/__openclaw__/${transferPath}/`,
                              },
                            },
                          },
                          this.gatewayRouteHeaderFilter("node-transfer"),
                        ],
                        backendRefs: [this.gatewayRouteBackendRef(service)],
                      })),
                    ]
                  : []),
                ...(access === "operator"
                  ? [
                      {
                        matches: [
                          {
                            path: {
                              type: "PathPrefix",
                              value: `${this.gatewayRoutePath(revision)}/`,
                            },
                          },
                        ],
                        filters: [
                          {
                            type: "URLRewrite",
                            urlRewrite: {
                              path: { type: "ReplacePrefixMatch", replacePrefixMatch: "/" },
                            },
                          },
                          this.gatewayRouteHeaderFilter(access),
                        ],
                        backendRefs: [this.gatewayRouteBackendRef(service)],
                      },
                    ]
                  : []),
              ],
      },
    };
  }

  private async reconcileGatewayRoute(
    revision: AgentRevision,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    if (this.options.gatewayRouting === undefined) {
      return;
    }
    const name = this.gatewayRouteName(revision.agentId);
    const service = await this.getOwned("Service", name, namespace, ownership);
    if (service === undefined) {
      return;
    }
    const route = this.gatewayRoute(revision, ownership, namespace, service);
    if (route !== undefined) {
      await this.reconcile(route, ownership, namespace);
    }
    if (this.options.runtime === undefined || revision.harness.mode !== "dedicated") {
      return;
    }
    const gateway = await this.getOwned("Deployment", name, namespace, ownership);
    if (gateway === undefined) {
      return;
    }
    // Candidates need this endpoint before activation, including when the
    // serving Gateway predates node enrollment. Keep ownership with that
    // serving revision so retiring a failed candidate cannot remove the route.
    const gatewayRevisionId = required(
      gateway.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION],
      "Serving Gateway revision ID",
    );
    const gatewayRevision = Number(gateway.metadata.annotations?.[AGENT_REVISION_ANNOTATION]);
    if (!Number.isSafeInteger(gatewayRevision) || gatewayRevision < 1) {
      throw new OwnershipFailure("The serving Gateway has an invalid revision.");
    }
    for (const access of ["node", "sandbox"] as const) {
      const publicRoute = this.gatewayRoute(revision, ownership, namespace, service, access);
      if (publicRoute === undefined) {
        continue;
      }
      publicRoute.metadata.annotations = {
        ...publicRoute.metadata.annotations,
        [AGENT_REVISION_ID_ANNOTATION]: gatewayRevisionId,
        [AGENT_REVISION_ANNOTATION]: String(gatewayRevision),
      };
      // Envoy Gateway v1.6.7 replaces the entire inherited SecurityPolicy at a
      // more specific route scope. Nodes authenticate with native device credentials;
      // sandbox routes serve only public shell assets on a separate listener.
      const policy: ManagedKubernetesObject<"SecurityPolicy"> = {
        apiVersion: GATEWAY_SECURITY_POLICY_API_VERSION,
        kind: "SecurityPolicy",
        metadata: { ...publicRoute.metadata },
        spec: {
          targetRefs: [
            {
              group: "gateway.networking.k8s.io",
              kind: "HTTPRoute",
              name: publicRoute.metadata.name,
            },
          ],
        },
      };
      if (access === "sandbox") {
        const routing = this.options.gatewayRouting;
        // Preview access belongs to the Agent lifecycle, including enabling it
        // after the tenant namespace has already been provisioned.
        await this.reconcile(
          this.gatewaySandboxNetworkPolicy(revision, publicRoute.metadata, routing, gateway),
          ownership,
          namespace,
        );
      }
      await this.reconcile(policy, ownership, namespace);
      await this.reconcile(publicRoute, ownership, namespace);
    }
  }

  /** Admits public preview traffic to the serving Gateway's sandbox listener.
   * A serving Gateway from a pre-profile template keeps the profile-free grant
   * until activation replaces it and this route is reconciled again. */
  private gatewaySandboxNetworkPolicy(
    revision: AgentRevision,
    metadata: ManagedKubernetesObject["metadata"],
    routing: KubernetesGatewayRoutingOptions,
    servingGateway: ManagedKubernetesObject,
  ): ManagedKubernetesObject {
    const selector = ordinaryNetworkPolicySelector({
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/workload-role": "gateway",
    });
    const unprofiled =
      asRecord(asRecord(asRecord(servingGateway.spec?.template)?.metadata)?.labels)?.[
        NETWORK_PROFILE_LABEL
      ] !== ORDINARY_NETWORK_PROFILE;
    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { ...metadata },
      spec: {
        podSelector: unprofiled ? withoutNetworkProfile(selector) : selector,
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              this.peer({
                namespace: routing.envoyNamespace,
                podLabels: {
                  "gateway.envoyproxy.io/owning-gateway-namespace": routing.gatewayNamespace,
                  "gateway.envoyproxy.io/owning-gateway-name": routing.gatewayName,
                },
              }),
            ],
            ports: [{ protocol: "TCP", port: this.options.network.gatewayPort + 1 }],
          },
        ],
      },
    };
  }

  private codexRepositoryBrokerNetworkPolicy(
    revision: AgentRevision,
    repositoryConsumer: { readonly role: "gateway" | "agent" } | undefined,
    repositoryMaterial: ResolvedRepositoryMaterialSpec | undefined,
  ): CodexRepositoryBrokerNetworkPolicy | undefined {
    const dedicatedCodex =
      revision.harness.id === "codex" &&
      revision.harness.mode === "dedicated" &&
      repositoryConsumer?.role === "agent";
    const embeddedCodex =
      revision.harness.id === "openclaw" &&
      revision.harness.mode === "embedded" &&
      repositoryConsumer?.role === "gateway" &&
      revision.plugins?.driver.implementation === "occ/codex-plugin";
    if (!dedicatedCodex && !embeddedCodex) {
      return undefined;
    }
    if (this.options.network.repositoryCredentials === undefined) {
      throw new ConfigurationFailure(
        "Repository credentials require a configured credential endpoint.",
      );
    }
    if (repositoryMaterial === undefined) {
      throw new ConfigurationFailure(
        "Dedicated Codex repository credentials require resolved repository material.",
      );
    }
    const origin = repositoryCredentialBrokerOriginFromMaterial(repositoryMaterial);
    const brokerHost = normalizedNetworkHost(origin.hostname, "Repository credential broker host");
    const networkProxy = asRecord(
      asRecord(asRecord(asRecord(revision.configuration.plugins)?.entries)?.codex)?.config,
    )?.appServer;
    const policy = asRecord(asRecord(networkProxy)?.networkProxy);
    if (policy?.enabled === false) {
      throw new ConfigurationFailure(
        "Repository credential broker host is blocked by an explicitly disabled Codex network proxy.",
      );
    }
    if (policy?.mode !== undefined && policy.mode !== "limited" && policy.mode !== "full") {
      throw new ConfigurationFailure(
        "Repository credential broker network policy has an unsupported Codex network mode.",
      );
    }
    if (policy?.allowLocalBinding !== undefined && typeof policy.allowLocalBinding !== "boolean") {
      throw new ConfigurationFailure(
        "Repository credential broker network policy has an unsupported local binding policy.",
      );
    }
    const domainsInput = policy?.domains === undefined ? undefined : asRecord(policy.domains);
    if (policy?.domains !== undefined && domainsInput === undefined) {
      throw new ConfigurationFailure(
        "Repository credential broker network policy domains must be an object.",
      );
    }
    const domains: Record<string, "allow" | "deny"> = {};
    for (const [host, decision] of Object.entries(domainsInput ?? {})) {
      if (decision !== "allow" && decision !== "deny") {
        throw new ConfigurationFailure(
          "Repository credential broker network policy has an unsupported domain decision.",
        );
      }
      mergeDomainDecision(
        domains,
        normalizedNetworkHost(host, "Repository credential broker network domain"),
        decision,
      );
    }
    if (domains[brokerHost] === "deny") {
      throw new ConfigurationFailure(
        "Repository credential broker host is explicitly denied by Codex network proxy policy.",
      );
    }
    return {
      host: brokerHost,
      domains,
    };
  }
  private pluginRuntimeSnapshot(
    revision: AgentRevision,
    repositoryBrokerNetworkPolicy?: CodexRepositoryBrokerNetworkPolicy,
  ): PluginRuntimeSnapshot | undefined {
    let runtime: PluginRuntimeSpec | undefined;
    try {
      runtime = pluginRuntimeSpecForRevision(revision, repositoryBrokerNetworkPolicy);
    } catch (error) {
      throw new ConfigurationFailure(
        error instanceof Error
          ? error.message
          : "AgentRevision plugin runtime artifacts are invalid.",
      );
    }
    if (runtime === undefined) {
      return undefined;
    }
    return {
      name: `plugin-runtime-${sha256Hex(revision.agentId, 12)}-rev-${sha256Hex(revision.id, 12)}`,
      runtime,
    };
  }

  private pluginRuntimeOwnership(revision: AgentRevision): Ownership {
    return {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    };
  }

  private pluginRuntimeConfigMap(
    snapshot: PluginRuntimeSnapshot,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
  ): ManagedKubernetesObject<"ConfigMap"> {
    return {
      ...this.manifest("v1", "ConfigMap", snapshot.name, ownership, namespace),
      immutable: true,
      data: pluginRuntimeConfigMapData(snapshot.runtime),
    };
  }

  private harnessWorkspaceClaimName(agentId: string): string {
    return `workspace-${sha256Hex(agentId, 12)}`;
  }

  private gatewayPrivateStateClaimName(agentId: string): string {
    return `gateway-state-${sha256Hex(agentId, 12)}`;
  }

  private harnessWorkspaceClaim(
    agentId: string,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
  ): ManagedKubernetesObject<"PersistentVolumeClaim"> {
    return {
      ...this.manifest(
        "v1",
        "PersistentVolumeClaim",
        this.harnessWorkspaceClaimName(agentId),
        ownership,
        namespace,
      ),
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: HARNESS_WORKSPACE_SIZE } },
      },
    };
  }

  private gatewayPrivateStateClaim(
    agentId: string,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
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

  private harnessWorkspaceVolumeMounts(oauth: boolean): V1VolumeMount[] {
    return harnessWorkspaceCategories(oauth).map(([subPath, mountPath]) => ({
      name: HARNESS_WORKSPACE_VOLUME,
      mountPath,
      subPath,
      readOnly: false,
    }));
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
    if (!embedded) {
      mounts.push({
        name: GATEWAY_PRIVATE_STATE_VOLUME,
        mountPath: GATEWAY_SESSION_DIRECTORY,
        subPath: "sessions",
        readOnly: false,
      });
    }
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

  private privateStateDirectories(role: WorkspaceRole): string[] {
    const paths =
      role === "gateway"
        ? [
            ...GATEWAY_PRIVATE_STATE_CATEGORIES.map(([, mountPath]) => mountPath),
            GATEWAY_SESSION_DIRECTORY,
          ]
        : HARNESS_WORKSPACE_CATEGORIES.map(([, mountPath]) => mountPath);
    return [
      "/runtime-state/home",
      "/runtime-temporary/tmp",
      ...[...new Set(paths.map((mountPath) => mountPath.slice(0, mountPath.lastIndexOf("/"))))]
        .filter((directory) => directory !== "/home/node")
        .map((directory) => directory.replace(/^\/home\/node/u, "/runtime-state/home")),
    ];
  }

  private privateStateInitContainer(
    role: WorkspaceRole,
    image: string,
    embedded: boolean,
    writableConfiguration = false,
  ): KubernetesRecord {
    const directories = this.privateStateDirectories(role);
    const volumeMounts: V1VolumeMount[] = [
      { name: "runtime-state", mountPath: "/runtime-state" },
      { name: "runtime-temporary", mountPath: "/runtime-temporary" },
    ];
    if (writableConfiguration) {
      volumeMounts.push({
        name: CONFIGURATION_VOLUME,
        mountPath: MANAGED_CONFIGURATION_DIRECTORY,
        readOnly: true,
      });
    }
    if (role === "gateway" && this.options.runtime !== undefined) {
      // Initialize whole directories as uid 1000 before mounting SQLite and its WAL files.
      volumeMounts.push({ name: GATEWAY_PRIVATE_STATE_VOLUME, mountPath: "/gateway-state" });
      directories.push(
        ...GATEWAY_PRIVATE_STATE_CATEGORIES.map(([subPath]) => `/gateway-state/${subPath}`),
        "/runtime-state/home/gateway-codex-home",
      );
      directories.push(embedded ? "/gateway-state/workspace" : "/gateway-state/sessions");
    }
    // Init mounts the volume root; the gateway later mounts its home subdirectory.
    const writableConfigurationInitPath = WRITABLE_CONFIGURATION_PATH.replace(
      /^\/home\/node/u,
      "/runtime-state/home",
    );
    const script = [
      writableConfiguration
        ? 'const { chmodSync, copyFileSync, mkdirSync } = require("node:fs");'
        : 'const { chmodSync, mkdirSync } = require("node:fs");',
      `for (const path of ${JSON.stringify(directories)}) {`,
      "  mkdirSync(path, { recursive: true });",
      "  chmodSync(path, 0o700);",
      "}",
      // The emptyDir root is group-writable under fsGroup, without /tmp's sticky
      // bit. Mount a private child so native safe-temp admission needs no privilege.
      'mkdirSync("/runtime-temporary/tmp", { recursive: true, mode: 0o700 });',
      ...(writableConfiguration
        ? [
            `copyFileSync(${JSON.stringify(
              `${MANAGED_CONFIGURATION_DIRECTORY}/${CONFIGURATION_DOCUMENT}`,
            )}, ${JSON.stringify(writableConfigurationInitPath)});`,
            `chmodSync(${JSON.stringify(writableConfigurationInitPath)}, 0o600);`,
          ]
        : []),
    ].join("\n");
    return {
      name: "prepare-private-state",
      image,
      imagePullPolicy: "IfNotPresent",
      // Plain images (no runtime) keep their Node entry, as their main container does.
      command: this.options.runtime === undefined ? ["node", "-e"] : [...SETUP_WRAPPER_COMMAND],
      args: [script],
      volumeMounts,
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      },
    };
  }

  private async deleteHarnessWorkspaceClaim(
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const agentId = required(ownership.agentId, "Harness workspace Agent ID");
    await this.deletePersistentVolumeClaim(
      this.harnessWorkspaceClaim(agentId, ownership, namespace),
      ownership,
      namespace,
    );
  }

  private async deleteGatewayPrivateStateClaim(
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
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
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const name = desired.metadata.name;
    const existing = await this.getOwned("PersistentVolumeClaim", name, namespace, ownership);
    if (existing === undefined || existing.metadata.deletionTimestamp !== undefined) {
      return;
    }
    this.verifyPersistentVolumeClaim(existing, desired);
    const uid = required(existing.metadata.uid, "PersistentVolumeClaim UID");
    const clients = await this.clients(namespace.plane);
    await this.request(
      () =>
        clients.core.deleteNamespacedPersistentVolumeClaim({
          name,
          namespace: namespace.name,
          body: { preconditions: { uid } },
        }),
      { mutating: true },
    );
  }

  private agentAuthenticationNetworkPolicy(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): ManagedKubernetesObject {
    const runtime = this.agentNetworkPolicies(revision, namespace).find(
      ({ resource }) =>
        resource.metadata.name === `allow-agent-runtime-${sha256Hex(revision.agentId, 12)}`,
    );
    const egress = runtime?.resource.spec?.egress;
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
        podSelector: ordinaryNetworkPolicySelector({
          "openclaw.dev/workload-role": "agent",
          "openclaw.dev/agent": revision.agentId,
          "openclaw.dev/revision": revision.id,
        }),
        policyTypes: ["Egress"],
        egress,
      },
    };
  }

  private agentServiceSelector(
    revision: AgentRevision,
    workloadName?: string,
  ): Record<string, string> {
    return {
      [NETWORK_PROFILE_LABEL]: this.harnessNetworkProfile(revision),
      "openclaw.dev/namespace": revision.namespaceId,
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/revision": revision.id,
      "openclaw.dev/workload-role": "agent",
      ...(workloadName === undefined ? {} : { "app.kubernetes.io/name": workloadName }),
    };
  }

  private gatewayServiceSelector(
    revision: AgentRevision,
    workloadName: string,
  ): Record<string, string> {
    return {
      "openclaw.dev/namespace": revision.namespaceId,
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/workload-role": "gateway",
      "app.kubernetes.io/name": workloadName,
    };
  }

  private enabledChannels(revision: AgentRevision): readonly ChannelRequirements[] {
    const configured = asRecord(asRecord(revision.configuration)?.channels);
    if (configured === undefined) {
      return [];
    }
    const enabled: ChannelRequirements[] = [];
    for (const [provider, configuration] of Object.entries(configured)) {
      if (["defaults", "modelByChannel"].includes(provider)) {
        continue;
      }
      if (asRecord(configuration)?.enabled === false) {
        continue;
      }
      if (!Object.hasOwn(CHANNEL_REQUIREMENTS, provider)) {
        throw new ConfigurationFailure(`Unsupported OpenClaw channel provider "${provider}".`);
      }
      enabled.push(CHANNEL_REQUIREMENTS[provider as keyof typeof CHANNEL_REQUIREMENTS]);
    }
    if (enabled.length === 0) {
      return enabled;
    }
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

  private validateChannelSecretBindings(
    configuration: OpenClawConfigurationDocument,
    secretBindings: SecretBindings | undefined,
  ): void {
    const required = this.channelSecretBindingIds(configuration);
    if (required.size === 0) {
      return;
    }
    let bindings: ReturnType<typeof normalizeSecretBindings>;
    try {
      bindings = normalizeSecretBindings(secretBindings);
    } catch {
      throw new ConfigurationFailure("AgentRevision Secret bindings are invalid.");
    }
    for (const id of required) {
      if (bindings[id] === undefined) {
        throw new ConfigurationFailure(
          "Configured channel credentials require matching AgentRevision Secret bindings.",
        );
      }
    }
  }

  private channelSecretBindingIds(configuration: OpenClawConfigurationDocument): Set<string> {
    const configured = asRecord(configuration.channels);
    const ids = new Set<string>();
    if (configured === undefined) {
      return ids;
    }
    for (const [provider, value] of Object.entries(configured)) {
      if (["defaults", "modelByChannel"].includes(provider)) {
        continue;
      }
      const channel = asRecord(value);
      if (channel?.enabled === false) {
        continue;
      }
      if (!Object.hasOwn(CHANNEL_REQUIREMENTS, provider)) {
        throw new ConfigurationFailure(`Unsupported OpenClaw channel provider "${provider}".`);
      }
      this.collectChannelSecretBindingIds(value, ids);
    }
    return ids;
  }

  private collectChannelSecretBindingIds(value: unknown, ids: Set<string>): void {
    if (typeof value === "string") {
      const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      if (match !== null) {
        ids.add(match[1]!);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectChannelSecretBindingIds(item, ids);
      }
      return;
    }
    const record = asRecord(value);
    if (record === undefined) {
      return;
    }
    if (record.source === "env" && typeof record.id === "string" && record.id.length > 0) {
      ids.add(record.id);
    }
    for (const item of Object.values(record)) {
      this.collectChannelSecretBindingIds(item, ids);
    }
  }

  private channelNetworkPolicy(
    revision: AgentRevision,
    enabled: readonly ChannelRequirements[],
    namespace: KubernetesNamespaceAddress,
  ): ManagedKubernetesObject {
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const proxy = enabled.some(({ egress }) => egress === "https-proxy")
      ? channelProxy(
          this.options.runtime?.channels?.proxyUrl,
          this.options.runtime?.channels?.managedProxy,
        )
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
        podSelector: ordinaryNetworkPolicySelector({
          "openclaw.dev/workload-role": "gateway",
          "openclaw.dev/agent": revision.agentId,
        }),
        policyTypes: ["Egress"],
        egress:
          proxy !== undefined
            ? [
                {
                  to: [
                    proxy.kind === "managed"
                      ? this.peer(proxy.peer)
                      : {
                          ipBlock: {
                            cidr: `${proxy.address}/${isIP(proxy.address) === 4 ? 32 : 128}`,
                          },
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
    namespace: KubernetesNamespaceAddress,
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
      if (existing === undefined) {
        return;
      }
    }
    await this.reconcile(policy, ownership, namespace);
  }

  /** Only preparation passes `preparation`, while a Gateway of another revision
   * serves. `unprofiledGateway` widens every Gateway-side selector to the
   * Agent's Gateway Pods with or without the profile (a pre-profile Gateway).
   * `anyRevision` drops the revision from every Agent-scoped selector: these
   * policies have one name per Agent, so pinning them to the candidate would
   * cut the serving predecessor off until activation pins them again. */
  private pluginStatusNetworkPolicies(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    preparation: AgentPolicyPreparation = {},
  ): TargetedKubernetesResource[] {
    const { unprofiledGateway = false } = preparation;
    const gatewayNamespace = this.gatewayNamespace(revision, namespace);
    const suffix = sha256Hex(revision.agentId, 12);
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const revisionScope =
      preparation.anyRevision === true ? {} : { "openclaw.dev/revision": revision.id };
    const agent = profileNetworkPolicySelector(this.harnessNetworkProfile(revision), {
      "openclaw.dev/namespace": revision.namespaceId,
      "openclaw.dev/workload-role": "agent",
      "openclaw.dev/agent": revision.agentId,
      ...revisionScope,
    });
    const profiledGateway = ordinaryNetworkPolicySelector({
      "openclaw.dev/namespace": revision.namespaceId,
      "openclaw.dev/workload-role": "gateway",
      "openclaw.dev/agent": revision.agentId,
    });
    const gateway = unprofiledGateway ? withoutNetworkProfile(profiledGateway) : profiledGateway;
    const policy = (name: string, spec: KubernetesRecord): TargetedKubernetesResource => {
      const target =
        name === "allow-gateway-agent" || name === "allow-plugin-status-gateway"
          ? gatewayNamespace
          : namespace;
      return {
        namespace: target,
        resource: {
          ...this.manifest(
            "networking.k8s.io/v1",
            "NetworkPolicy",
            `${name}-${suffix}`,
            ownership,
            target,
          ),
          spec,
        },
      };
    };
    const statusProxySourceCidrs =
      this.options.executionCluster?.network.pluginStatusProxySourceCidrs ??
      this.options.network.pluginStatusProxySourceCidrs ??
      [];
    const enabledPluginIds = Object.entries(revision.plugins?.plugins ?? {})
      .filter(([, selection]) => selection.enabled)
      .map(([pluginId]) => pluginId);
    const policies =
      statusProxySourceCidrs.length > 0
        ? [
            policy("allow-plugin-status-proxy", {
              podSelector: ordinaryNetworkPolicySelector({
                "openclaw.dev/agent": revision.agentId,
                ...revisionScope,
              }),
              policyTypes: ["Ingress"],
              ingress: [
                {
                  from: statusProxySourceCidrs.map((cidr) => ({ ipBlock: { cidr } })),
                  ports: [{ protocol: "TCP", port: PLUGIN_RUNTIME_STATUS_PORT }],
                },
              ],
            }),
          ]
        : [];
    const controlProxyCidrs = this.options.network.pluginStatusProxySourceCidrs ?? [];
    const gatewayProxyPolicies =
      gatewayNamespace === namespace || controlProxyCidrs.length === 0
        ? []
        : policies.map((item) => ({
            namespace: gatewayNamespace,
            resource: {
              ...item.resource,
              metadata: { ...item.resource.metadata, namespace: gatewayNamespace.name },
              spec: {
                ...item.resource.spec,
                ingress: [
                  {
                    from: controlProxyCidrs.map((cidr) => ({ ipBlock: { cidr } })),
                    ports: [{ protocol: "TCP", port: PLUGIN_RUNTIME_STATUS_PORT }],
                  },
                ],
              },
            },
          }));
    if (revision.harness.id === "openclaw") {
      return [...policies, ...gatewayProxyPolicies];
    }
    // The private runtime diagnostics endpoint uses the same proxy even when
    // no plugins are enabled; its ingress must follow workload placement.
    if (
      enabledPluginIds.length === 0 ||
      revision.harness.mode === "embedded" ||
      this.options.runtime === undefined
    ) {
      return [...policies, ...gatewayProxyPolicies];
    }
    return [
      ...policies,
      ...gatewayProxyPolicies,
      policy("allow-plugin-status-gateway", {
        podSelector: gateway,
        policyTypes: ["Egress"],
        egress: [
          {
            to:
              this.options.executionCluster === undefined
                ? [this.peer({ namespace: namespace.name, podLabels: agent.matchLabels })]
                : this.options.executionCluster.network.harnessEndpointCidrs.map((cidr) => ({
                    ipBlock: { cidr },
                  })),
            ports: [
              {
                protocol: "TCP",
                port:
                  this.options.executionCluster === undefined ? PLUGIN_RUNTIME_STATUS_PORT : 443,
              },
            ],
          },
        ],
      }),
      policy("allow-plugin-status-agent", {
        podSelector: agent,
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              this.peer(
                this.options.executionCluster === undefined
                  ? { namespace: gatewayNamespace.name, podLabels: gateway.matchLabels }
                  : this.executionProxyPeer(),
              ),
            ],
            ports: [{ protocol: "TCP", port: PLUGIN_RUNTIME_STATUS_PORT }],
          },
        ],
      }),
    ];
  }

  private agentNetworkPolicies(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    preparation: AgentPolicyPreparation = {},
  ): TargetedKubernetesResource[] {
    const { unprofiledGateway = false } = preparation;
    const gatewayNamespace = this.gatewayNamespace(revision, namespace);
    const suffix = sha256Hex(revision.agentId, 12);
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const harnessProfile = this.harnessNetworkProfile(revision);
    const agent = profileNetworkPolicySelector(harnessProfile, {
      "openclaw.dev/namespace": revision.namespaceId,
      "openclaw.dev/workload-role": "agent",
      "openclaw.dev/agent": revision.agentId,
      ...(preparation.anyRevision === true ? {} : { "openclaw.dev/revision": revision.id }),
    });
    const profiledGateway = ordinaryNetworkPolicySelector({
      "openclaw.dev/namespace": revision.namespaceId,
      "openclaw.dev/workload-role": "gateway",
      "openclaw.dev/agent": revision.agentId,
    });
    const gateway = unprofiledGateway ? withoutNetworkProfile(profiledGateway) : profiledGateway;
    const policy = (name: string, spec: KubernetesRecord): TargetedKubernetesResource => {
      const target =
        name === "allow-gateway-agent" || name === "allow-plugin-status-gateway"
          ? gatewayNamespace
          : namespace;
      return {
        namespace: target,
        resource: {
          ...this.manifest(
            "networking.k8s.io/v1",
            "NetworkPolicy",
            `${name}-${suffix}`,
            ownership,
            target,
          ),
          spec,
        },
      };
    };
    const statusPolicies = this.pluginStatusNetworkPolicies(revision, namespace, preparation);
    const runtime = this.options.runtime;
    if (runtime === undefined) {
      return statusPolicies;
    }
    // TODO(model-egress-proxy): Replace public TCP/443 with the approved per-Agent model proxy.
    const modelEgress = [
      {
        to: [
          {
            ipBlock: {
              cidr: "0.0.0.0/0",
              except: [
                "10.0.0.0/8",
                // Carrier-grade NAT: some VPC Pod/Service ranges and cloud metadata use it.
                "100.64.0.0/10",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "169.254.0.0/16",
              ],
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 443 }],
      },
    ];
    const repositoryEgress =
      revision.repositoryCredentials === undefined
        ? []
        : [
            {
              to: [this.peer(this.options.network.repositoryCredentials!)],
              ports: [{ protocol: "TCP", port: this.options.network.repositoryCredentials!.port }],
            },
          ];
    if (revision.harness.mode === "embedded") {
      return [
        policy("allow-agent-runtime", {
          podSelector: gateway,
          policyTypes: ["Egress"],
          egress: [...modelEgress, ...repositoryEgress],
        }),
        ...statusPolicies,
      ];
    }
    const transport = [
      { protocol: "TCP", port: AGENT_TRANSPORT_PORT },
      { protocol: "TCP", port: PLUGIN_RUNTIME_STATUS_PORT },
    ];
    return [
      policy("allow-gateway-agent", {
        podSelector: gateway,
        policyTypes: ["Egress"],
        egress: [
          {
            to:
              this.options.executionCluster === undefined
                ? [this.peer({ namespace: namespace.name, podLabels: agent.matchLabels })]
                : this.options.executionCluster.network.harnessEndpointCidrs.map((cidr) => ({
                    ipBlock: { cidr },
                  })),
            ports:
              this.options.executionCluster === undefined
                ? transport
                : [{ protocol: "TCP", port: 443 }],
          },
        ],
      }),
      policy("allow-agent-runtime", {
        podSelector: agent,
        // A provider-fenced Harness keeps only the Gateway transport ingress; its
        // provider's egress fence must not be unioned with model egress.
        policyTypes:
          harnessProfile === ORDINARY_NETWORK_PROFILE ? ["Ingress", "Egress"] : ["Ingress"],
        ingress: [
          {
            from: [
              this.peer(
                this.options.executionCluster === undefined
                  ? { namespace: gatewayNamespace.name, podLabels: gateway.matchLabels }
                  : this.executionProxyPeer(),
              ),
            ],
            ports: transport,
          },
        ],
        ...(harnessProfile === ORDINARY_NETWORK_PROFILE
          ? { egress: [...modelEgress, ...repositoryEgress] }
          : {}),
      }),
      ...statusPolicies,
    ];
  }

  private harnessAuthForRevision(
    revision: AgentRevision,
    context: ComputeRevisionContext | undefined,
    namespace: KubernetesNamespaceAddress,
  ): PreparedHarnessAuth {
    const auth = context?.harnessAuth;
    if (auth === undefined || auth.method !== revision.harnessAuth.method) {
      throw new ConfigurationFailure(
        "Harness authentication delivery context is missing or invalid.",
      );
    }
    if (auth.method === "api_key" || auth.method === "codex_pat" || auth.method === "oauth") {
      const { backendRef, ...snapshot } = auth;
      if (
        !isDeepStrictEqual(snapshot, revision.harnessAuth) ||
        auth.source.namespaceId !== revision.namespaceId ||
        backendRef.namespaceName !== namespace.name ||
        !backendRef.name?.trim() ||
        !backendRef.key?.trim() ||
        !backendRef.uid?.trim()
      ) {
        throw new OwnershipFailure(
          "Harness authentication Secret does not match the admitted source.",
        );
      }
    } else if (auth.method === "credential_source") {
      const { source, ...snapshot } = auth;
      if (
        !isDeepStrictEqual(snapshot, revision.harnessAuth) ||
        source.id !== snapshot.sourceId ||
        source.namespaceId !== revision.namespaceId ||
        source.driverId !== snapshot.credentialGatewayId ||
        source.type !== snapshot.sourceType ||
        source.state !== "ready"
      ) {
        throw new OwnershipFailure("Harness credential source does not match the admitted source.");
      }
    } else {
      if (!isDeepStrictEqual(auth, revision.harnessAuth)) {
        throw new OwnershipFailure(
          "Harness authentication credential does not match the admitted account.",
        );
      }
    }
    const prepared = prepareHarnessAuth(revision.harness, auth, revision.configuration);
    const native = harnessModelAuthentication(revision.configuration);
    return {
      ...prepared,
      environment: [
        ...prepared.environment,
        { name: "OPENCLAW_HARNESS_MODEL", value: harnessPrimaryModel(revision.configuration) },
        ...(revision.harness.id === "openclaw"
          ? [
              { name: "OPENCLAW_HARNESS_PROVIDER", value: native.providerId },
              { name: "OPENCLAW_HARNESS_CREDENTIAL_ENV", value: native.environmentName },
              {
                name: "OPENCLAW_HARNESS_PROBE_CONFIG",
                value: JSON.stringify(harnessProbeConfiguration(revision.configuration)),
              },
            ]
          : []),
      ],
    };
  }

  private secretEnvironmentForRevision(
    revision: AgentRevision,
    context: ComputeRevisionContext | undefined,
    namespace: KubernetesNamespaceAddress,
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
        projection.backendRef.namespaceName !== namespace.name ||
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

  private gatewaySecretsName(agentId: string, revisionId: string): string {
    return `gateway-secrets-${sha256Hex(agentId, 12)}-${sha256Hex(revisionId, 12)}`;
  }

  private harnessSecretsName(agentId: string, revisionId: string): string {
    return `harness-secrets-${sha256Hex(agentId, 12)}-${sha256Hex(revisionId, 12)}`;
  }

  private oauthBootstrapName(revision: AgentRevision): string {
    return `oauth-bootstrap-${sha256Hex(revision.agentId, 12)}-${sha256Hex(revision.id, 12)}`;
  }

  private async oauthSource(
    revision: AgentRevision,
    context: ComputeRevisionContext | undefined,
  ): Promise<ManagedKubernetesObject<"Secret">> {
    const auth = context?.harnessAuth;
    if (auth?.method !== "oauth") {
      throw new ConfigurationFailure("OAuth delivery context is missing.");
    }
    const source = await this.get("Secret", auth.backendRef.name, {
      name: auth.backendRef.namespaceName,
      plane: "control",
    });
    if (
      source === undefined ||
      source.metadata.deletionTimestamp !== undefined ||
      source.metadata.uid !== auth.backendRef.uid ||
      source.metadata.annotations?.["openclaw.dev/namespace-id"] !== revision.namespaceId ||
      source.metadata.annotations?.["openclaw.dev/secret-id"] !== auth.source.id ||
      source.metadata.annotations?.["openclaw.dev/secret-driver-id"] !== auth.secretDriverId
    ) {
      throw new OwnershipFailure("OAuth credential source is unavailable or changed ownership.");
    }
    return source;
  }

  private async prepareOAuthCredentials(
    revision: AgentRevision,
    context: ComputeRevisionContext | undefined,
    namespace: KubernetesNamespaceAddress,
  ): Promise<boolean> {
    const auth = context?.harnessAuth;
    if (auth?.method !== "oauth" || this.options.runtime === undefined) {
      throw new ConfigurationFailure("OAuth requires a managed Codex runtime.");
    }
    const ownership = this.pluginRuntimeOwnership(revision);
    const volume = await this.getOwned(
      "PersistentVolumeClaim",
      this.harnessWorkspaceClaimName(revision.agentId),
      namespace,
      { namespaceId: revision.namespaceId, agentId: revision.agentId },
    );
    const volumeUid = required(volume?.metadata.uid, "OAuth durable volume UID");
    let source = await this.oauthSource(revision, context);
    const annotations = source.metadata.annotations ?? {};
    const phase = annotations[OAUTH_PHASE_ANNOTATION];
    if (
      phase !== undefined &&
      (!["claimed", "consumed"].includes(phase) ||
        annotations[OAUTH_AGENT_ANNOTATION] !== revision.agentId ||
        annotations[OAUTH_VOLUME_ANNOTATION] !== volumeUid)
    ) {
      throw new OwnershipFailure(
        "OAuth credentials belong to another Agent or require reconnect after storage loss.",
      );
    }
    let envelope: Record<string, unknown>;
    try {
      envelope =
        asRecord(
          JSON.parse(
            Buffer.from(
              required(source.data?.[auth.backendRef.key], "OAuth value"),
              "base64",
            ).toString("utf8"),
          ),
        ) ?? {};
    } catch {
      throw new ConfigurationFailure("OAuth credential source is invalid.");
    }
    if (
      envelope.kind !== "harness_device_authorization" ||
      envelope.version !== 1 ||
      envelope.namespaceId !== revision.namespaceId ||
      envelope.harnessId !== "codex" ||
      (envelope.agentId !== undefined && envelope.agentId !== revision.agentId)
    ) {
      throw new OwnershipFailure("OAuth authorization does not match this Agent.");
    }
    if (phase === "consumed") {
      if (
        envelope.phase !== "consumed" ||
        envelope.agentId !== revision.agentId ||
        envelope.volumeUid !== volumeUid
      ) {
        throw new OwnershipFailure("Consumed OAuth credentials cannot be replaced; sign in again.");
      }
      await this.removeOAuthBootstrap(revision, namespace);
      return true;
    }
    let nativeAuth: Record<string, unknown>;
    try {
      const credential = asRecord(JSON.parse(String(envelope.credential)));
      nativeAuth = asRecord(credential?.auth) ?? {};
      const tokens = asRecord(nativeAuth.tokens);
      if (
        envelope.phase !== "ready" ||
        typeof envelope.expiresAt !== "string" ||
        !(Date.parse(envelope.expiresAt) > Date.now()) ||
        credential?.version !== 1 ||
        credential.provider !== "codex" ||
        credential.state !== "ready" ||
        nativeAuth.auth_mode !== "chatgpt" ||
        ![tokens?.id_token, tokens?.access_token, tokens?.refresh_token].every(isNonEmptyString)
      ) {
        throw new Error();
      }
    } catch {
      throw new ConfigurationFailure("OAuth authorization is unavailable; sign in again.");
    }
    const sourceClients = await this.clients("control");
    const replaceSource = async (nextPhase: "claimed" | "consumed", value?: unknown) => {
      try {
        await this.request(
          () =>
            sourceClients.core.replaceNamespacedSecret({
              name: source.metadata.name,
              namespace: auth.backendRef.namespaceName,
              body: {
                ...source,
                metadata: {
                  ...source.metadata,
                  resourceVersion: required(
                    source.metadata.resourceVersion,
                    "OAuth source version",
                  ),
                  annotations: {
                    ...source.metadata.annotations,
                    [OAUTH_AGENT_ANNOTATION]: revision.agentId,
                    [OAUTH_VOLUME_ANNOTATION]: volumeUid,
                    [OAUTH_PHASE_ANNOTATION]: nextPhase,
                  },
                },
                ...(value === undefined
                  ? {}
                  : {
                      data: {
                        [auth.backendRef.key]: Buffer.from(JSON.stringify(value)).toString(
                          "base64",
                        ),
                      },
                    }),
              },
            }),
          { mutating: true },
        );
      } catch {
        this.operationSignal()?.throwIfAborted();
        throw new DependencyUnavailableError("OAuth credential handoff could not be confirmed.");
      }
      source = await this.oauthSource(revision, context);
    };
    if (phase === undefined) {
      await replaceSource("claimed");
    }
    const name = this.oauthBootstrapName(revision);
    const seed = await this.getOwned("Secret", name, namespace, ownership);
    const data = { "auth.json": Buffer.from(JSON.stringify(nativeAuth)).toString("base64") };
    if (seed !== undefined && !isDeepStrictEqual(seed.data, data)) {
      throw new OwnershipFailure("OAuth bootstrap source changed during handoff.");
    }
    if (seed === undefined) {
      const clients = await this.clients(namespace.plane);
      try {
        await this.request(
          () =>
            clients.core.createNamespacedSecret({
              namespace: namespace.name,
              body: {
                ...this.manifest("v1", "Secret", name, ownership, namespace),
                immutable: true,
                type: "Opaque",
                data,
              },
            }),
          { mutating: true },
        );
      } catch {
        this.operationSignal()?.throwIfAborted();
        throw new DependencyUnavailableError("OAuth bootstrap delivery could not be confirmed.");
      }
    }
    await this.reconcile(
      this.oauthBootstrapDeployment(revision, namespace, volumeUid, auth.backendRef.uid),
      ownership,
      namespace,
    );
    const deployment = await this.getOwned("Deployment", name, namespace, ownership);
    // The seed writer needs no network grants, so its template carries no network profile.
    if (deployment === undefined || !this.deploymentReady(deployment, false)) {
      return false;
    }
    // Native code cannot refresh until the original bundle has been irreversibly consumed.
    await replaceSource("consumed", {
      kind: "harness_device_authorization",
      version: 1,
      harnessId: "codex",
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      phase: "consumed",
      volumeUid,
    });
    await this.removeOAuthBootstrap(revision, namespace);
    return true;
  }

  private oauthBootstrapDeployment(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    volumeUid: string,
    sourceUid: string,
  ): ManagedKubernetesObject<"Deployment"> {
    const name = this.oauthBootstrapName(revision);
    const ownership = this.pluginRuntimeOwnership(revision);
    const manifest = this.manifest("apps/v1", "Deployment", name, ownership, namespace);
    const labels = {
      ...manifest.metadata.labels,
      "app.kubernetes.io/name": name,
      "openclaw.dev/workload-role": "agent",
    };
    return {
      ...manifest,
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { "app.kubernetes.io/name": name } },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              seccompProfile: { type: "RuntimeDefault" },
            },
            volumes: [
              {
                name: "auth",
                persistentVolumeClaim: {
                  claimName: this.harnessWorkspaceClaimName(revision.agentId),
                },
              },
              { name: "seed", secret: { secretName: name, defaultMode: 0o440 } },
            ],
            // The writer holding the seed sees only codex-home, as the runtime does.
            // Create that directory as uid 1000 first: a kubelet-created subPath is
            // root-owned and group- and world-writable, and uid 1000 cannot tighten it.
            initContainers: [
              {
                name: "prepare-oauth-home",
                image: this.options.images.agent,
                imagePullPolicy: "IfNotPresent",
                // OAuth requires the managed runtime image, which provides tini.
                command: [...SETUP_WRAPPER_COMMAND],
                args: [
                  [
                    'const { chmodSync, lstatSync, mkdirSync, rmSync } = require("node:fs");',
                    'const path = "/harness-workspace-state/codex-home";',
                    // Never let kubelet follow a planted link or mount a file as the home.
                    "if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === false) {",
                    "  rmSync(path, { force: true });",
                    "}",
                    "mkdirSync(path, { recursive: true, mode: 0o700 });",
                    "chmodSync(path, 0o700);",
                  ].join("\n"),
                ],
                volumeMounts: [{ name: "auth", mountPath: "/harness-workspace-state" }],
                resources: this.options.resources.agent,
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
            containers: [
              {
                name: "oauth-bootstrap",
                image: this.options.images.agent,
                imagePullPolicy: "IfNotPresent",
                // Under tini the idle seed writer is not PID 1, so its Pod's delete ends it
                // on SIGTERM instead of waiting out the grace period for SIGKILL.
                command: [...SETUP_WRAPPER_COMMAND],
                args: [CODEX_OAUTH_BOOTSTRAP_ENTRYPOINT + "\nsetInterval(() => {}, 60000);"],
                env: [
                  { name: "CODEX_HOME", value: "/auth" },
                  { name: "OCE_CODEX_OAUTH_SOURCE_UID", value: sourceUid },
                  { name: "OCE_CODEX_OAUTH_VOLUME_UID", value: volumeUid },
                  { name: "OCE_CODEX_OAUTH_SEED_PATH", value: "/seed/auth.json" },
                ],
                volumeMounts: [
                  { name: "auth", mountPath: "/auth", subPath: "codex-home" },
                  { name: "seed", mountPath: "/seed", readOnly: true },
                ],
                readinessProbe: {
                  exec: {
                    command: [
                      "node",
                      "-e",
                      'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync("/auth/.oce-oauth.json","utf8")); process.exit(r.sourceUid===process.env.OCE_CODEX_OAUTH_SOURCE_UID && r.volumeUid===process.env.OCE_CODEX_OAUTH_VOLUME_UID ? 0 : 1);',
                    ],
                  },
                  periodSeconds: 2,
                },
                resources: this.options.resources.agent,
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
          },
        },
      },
    };
  }

  private async removeOAuthBootstrap(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    const name = this.oauthBootstrapName(revision);
    const ownership = this.pluginRuntimeOwnership(revision);
    const deployment = await this.getOwned("Deployment", name, namespace, ownership);
    if (deployment !== undefined) {
      const clients = await this.clients(namespace.plane);
      await this.request(
        () =>
          clients.apps.deleteNamespacedDeployment({
            name,
            namespace: namespace.name,
            body: {
              preconditions: {
                uid: required(deployment.metadata.uid, "OAuth bootstrap UID"),
                resourceVersion: required(
                  deployment.metadata.resourceVersion,
                  "OAuth bootstrap version",
                ),
              },
            },
          }),
        { mutating: true },
      );
    }
    await this.waitForRevisionPodsToTerminate(revision, namespace, "agent", name);
    await this.deleteOwnedNamespacedResource("Secret", name, ownership, namespace);
  }

  private async deliverHarnessAuth(
    revision: AgentRevision,
    context: ComputeRevisionContext | undefined,
    prepared: PreparedHarnessAuth,
    namespace: KubernetesNamespaceAddress,
  ): Promise<PreparedHarnessAuth> {
    const sourceNamespace = await this.controlNamespace(revision.namespaceId);
    const sources: SecretEnvironmentProjection[] = [];
    const auth = context?.harnessAuth;
    if (auth === undefined) {
      throw new ConfigurationFailure("Resolved Harness authentication is required.");
    }
    await this.ensureLegacyGatewayPassword(revision, sourceNamespace);
    if (auth.method === "oauth") {
      const source = await this.oauthSource(revision, context);
      if (
        source.metadata.annotations?.[OAUTH_PHASE_ANNOTATION] !== "consumed" ||
        source.metadata.annotations?.[OAUTH_AGENT_ANNOTATION] !== revision.agentId
      ) {
        throw new OwnershipFailure("OAuth credential handoff is incomplete.");
      }
      prepared = {
        ...prepared,
        environment: [
          ...prepared.environment,
          {
            name: "OCE_CODEX_OAUTH_VOLUME_UID",
            value: required(
              source.metadata.annotations[OAUTH_VOLUME_ANNOTATION],
              "OAuth volume UID",
            ),
          },
        ],
      };
    }
    for (const environment of prepared.environment) {
      const ref = environment.valueFrom?.secretKeyRef;
      if (ref === undefined) {
        continue;
      }
      const name = required(ref.name, "Harness credential Secret name");
      const source = await this.get("Secret", name, sourceNamespace);
      if (source === undefined || source.metadata.deletionTimestamp !== undefined) {
        throw new DependencyUnavailableError("Harness credential source is unavailable.");
      }
      if (auth.method === "api_key" || auth.method === "codex_pat") {
        if (source.metadata.uid !== auth.backendRef.uid) {
          throw new OwnershipFailure("Harness credential source identity changed.");
        }
      } else if (auth.method === "chatgpt_service_account") {
        this.verifyOwnership(source, {
          namespaceId: revision.namespaceId,
          serviceAccountId: auth.serviceAccountId,
        });
      }
      sources.push({
        name: environment.name,
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        secretId: auth.method === "api_key" || auth.method === "codex_pat" ? auth.source.id : name,
        backendRef: {
          namespaceName: sourceNamespace.name,
          name,
          key: ref.key,
          uid: required(source.metadata.uid, "Harness credential UID"),
        },
      });
    }
    if (revision.harness.mode === "dedicated" && this.options.runtime !== undefined) {
      const name = `${this.options.runtime.transportSecretPrefix}-${sha256Hex(revision.agentId, 12)}`;
      const source = await this.getOwned("Secret", name, sourceNamespace, {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
      });
      if (source === undefined) {
        throw new DependencyUnavailableError("Harness transport credential is unavailable.");
      }
      this.requireCompleteRuntimeCredentialSecret(
        source,
        this.runtimeTransportSecretSpec(name, source),
      );
      sources.push({
        name: AGENT_TRANSPORT_TOKEN_KEY,
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        secretId: name,
        backendRef: {
          namespaceName: sourceNamespace.name,
          name,
          key: AGENT_TRANSPORT_TOKEN_KEY,
          uid: required(source.metadata.uid, "Transport credential UID"),
        },
      });
    }
    const delivered = await this.projectRuntimeSecrets(
      revision,
      namespace,
      this.harnessSecretsName(revision.agentId, revision.id),
      sources,
    );
    return {
      ...prepared,
      environment: prepared.environment.map((environment) => {
        const projection = delivered.find((source) => source.name === environment.name);
        return projection === undefined
          ? environment
          : {
              name: environment.name,
              valueFrom: {
                secretKeyRef: { name: projection.backendRef.name, key: projection.backendRef.key },
              },
            };
      }),
    };
  }

  private async deliverGatewaySecrets(
    revision: AgentRevision,
    harnessNamespace: KubernetesNamespaceAddress,
    gatewayNamespace: KubernetesNamespaceAddress,
    projections: readonly SecretEnvironmentProjection[],
  ): Promise<readonly SecretEnvironmentProjection[]> {
    // Dedicated Gateways consume canonical sources directly, even in a shared namespace.
    if (revision.harness.mode === "dedicated") {
      for (const projection of projections) {
        const ref = projection.backendRef;
        if (
          ref.namespaceName !== gatewayNamespace.name ||
          projection.namespaceId !== revision.namespaceId ||
          projection.agentId !== revision.agentId
        ) {
          throw new OwnershipFailure("Gateway credential source is outside the admitted scope.");
        }
        const source = await this.get("Secret", ref.name, gatewayNamespace);
        if (
          source === undefined ||
          source.metadata.uid !== ref.uid ||
          source.metadata.deletionTimestamp !== undefined ||
          !source.data?.[ref.key]
        ) {
          throw new DependencyUnavailableError("Gateway credential source is unavailable.");
        }
      }
      return projections;
    }
    // Embedded execution retains its existing delivery semantics, outside the dedicated trust boundary.
    return this.projectRuntimeSecrets(
      revision,
      harnessNamespace,
      this.gatewaySecretsName(revision.agentId, revision.id),
      projections,
    );
  }

  private async projectRuntimeSecrets(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
    name: string,
    projections: readonly SecretEnvironmentProjection[],
  ): Promise<readonly SecretEnvironmentProjection[]> {
    if (projections.length === 0) {
      return [];
    }
    try {
      const ownership = this.pluginRuntimeOwnership(revision);
      const sourceNamespace = await this.controlNamespace(revision.namespaceId);
      const data: Record<string, string> = {};
      for (const projection of projections) {
        const ref = projection.backendRef;
        if (
          ref.namespaceName !== sourceNamespace.name ||
          projection.namespaceId !== revision.namespaceId ||
          projection.agentId !== revision.agentId
        ) {
          throw new OwnershipFailure("Runtime credential source is outside the admitted scope.");
        }
        const source = await this.get("Secret", ref.name, sourceNamespace);
        if (
          source === undefined ||
          source.metadata.uid !== ref.uid ||
          source.metadata.namespace !== sourceNamespace.name ||
          source.metadata.deletionTimestamp !== undefined
        ) {
          throw new OwnershipFailure("The admitted Secret is unavailable.");
        }
        data[projection.name] = required(source.data?.[ref.key], "Admitted Secret value");
      }
      const existing = await this.getOwned("Secret", name, namespace, ownership);
      const manifest = this.manifest("v1", "Secret", name, ownership, namespace);
      const body = {
        ...manifest,
        metadata: {
          ...manifest.metadata,
          ...(existing === undefined
            ? {}
            : {
                uid: required(existing.metadata.uid, "Runtime Secret UID"),
                resourceVersion: required(
                  existing.metadata.resourceVersion,
                  "Runtime Secret version",
                ),
              }),
        },
        type: "Opaque",
        data,
      };
      const clients = await this.clients(namespace.plane);
      if (existing === undefined || !isDeepStrictEqual(existing.data, data)) {
        await this.request(
          () =>
            existing === undefined
              ? clients.core.createNamespacedSecret({ namespace: namespace.name, body })
              : clients.core.replaceNamespacedSecret({ namespace: namespace.name, name, body }),
          { mutating: true },
        );
      }
      const observed = await this.getOwned("Secret", name, namespace, ownership);
      if (observed === undefined) {
        throw new Error("Runtime Secret readback unavailable.");
      }
      return projections.map((projection) => ({
        ...projection,
        backendRef: {
          namespaceName: namespace.name,
          name,
          key: projection.name,
          uid: required(observed.metadata.uid, "Runtime Secret UID"),
        },
      }));
    } catch {
      this.operationSignal()?.throwIfAborted();
      // API failures can echo private request bodies; never expose them through status or logs.
      throw new DependencyUnavailableError("Runtime credential delivery is unavailable.");
    }
  }

  private deployment(
    name: string,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
    image: string,
    serviceAccountName: string,
    role: "gateway" | "agent",
    environment: Readonly<Record<string, string>>,
    loggingLevel: LoggingLevel,
    configuration?: GatewayConfigurationSnapshot,
    embedded = false,
    workloadServicePrincipalId?: string,
    harnessAuth?: PreparedHarnessAuth,
    enabledChannels: readonly ChannelRequirements[] = [],
    secretEnvironment: readonly SecretEnvironmentProjection[] = [],
    pluginRuntime?: PluginRuntimeSnapshot,
    pluginWarnings: readonly PluginDeploymentWarning[] = [],
    workspaceSetup?: WorkspaceSetup,
    repositoryMaterial?: ResolvedRepositoryMaterialSpec,
    nativeRuntime?: NativeRuntimeSnapshot,
  ): ManagedKubernetesObject {
    if (nativeRuntime !== undefined && (embedded || role !== "agent")) {
      throw new ConfigurationFailure(
        "Dedicated OpenClaw runtime requires a dedicated Harness workload.",
      );
    }
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
    const writableConfiguration =
      role === "gateway" &&
      configuration !== undefined &&
      runtime !== undefined &&
      this.options.gatewayRouting !== undefined &&
      configuration.usesWritableNativeAdminConfig;
    const volumes: V1Volume[] = [];
    const volumeMounts: V1VolumeMount[] = [];
    const variables: V1EnvVar[] = [];
    const initContainers = privateHome
      ? [this.privateStateInitContainer(role, image, embedded, writableConfiguration)]
      : [];
    if (configuration !== undefined) {
      volumes.push({
        name: CONFIGURATION_VOLUME,
        configMap: {
          name: configuration.name,
          items: [
            { key: CONFIGURATION_DOCUMENT, path: CONFIGURATION_DOCUMENT },
            ...(this.options.executionCluster?.caBundle === undefined
              ? []
              : [{ key: "execution-ca.pem", path: "execution-ca.pem" }]),
          ],
          optional: false,
        },
      });
      volumeMounts.push({
        name: CONFIGURATION_VOLUME,
        mountPath: writableConfiguration
          ? MANAGED_CONFIGURATION_DIRECTORY
          : CONFIGURATION_DIRECTORY,
        readOnly: true,
      });
      variables.push({
        name: "OPENCLAW_CONFIG_PATH",
        value: writableConfiguration
          ? WRITABLE_CONFIGURATION_PATH
          : `${CONFIGURATION_DIRECTORY}/${CONFIGURATION_DOCUMENT}`,
      });
      // A native worker profile is a placement control that must hold before the
      // Gateway serves, so it stays in the pod spec, as does the node of a Gateway
      // whose runtime status the controller cannot read. Otherwise a Codex Gateway
      // reads its node from the optional binding volume and applies it while running.
      if (
        configuration.workspaceNodeId !== undefined &&
        configuration.workspaceNodeBinding === undefined
      ) {
        variables.push({
          name: "OPENCLAW_WORKSPACE_NODE_ID",
          value: configuration.workspaceNodeId,
        });
      }
      if (configuration.workspaceNodeBinding !== undefined) {
        volumes.push({
          name: WORKSPACE_NODE_BINDING_VOLUME,
          configMap: {
            name: configuration.workspaceNodeBinding,
            items: [{ key: WORKSPACE_NODE_BINDING_FILE, path: WORKSPACE_NODE_BINDING_FILE }],
            optional: true,
          },
        });
        volumeMounts.push({
          name: WORKSPACE_NODE_BINDING_VOLUME,
          mountPath: WORKSPACE_NODE_BINDING_DIRECTORY,
          readOnly: true,
        });
        variables.push({
          name: "OPENCLAW_WORKSPACE_NODE_PATH",
          value: `${WORKSPACE_NODE_BINDING_DIRECTORY}/${WORKSPACE_NODE_BINDING_FILE}`,
        });
      }
      if (configuration.nativeWorkerProfile !== undefined) {
        variables.push({
          name: "OPENCLAW_NATIVE_WORKER_PROFILE",
          value: configuration.nativeWorkerProfile,
        });
      }
    }
    const needsPluginRuntime =
      pluginRuntime !== undefined &&
      ((pluginRuntime.runtime.kind === "openclaw" && role === "gateway") ||
        (pluginRuntime.runtime.kind === "codex" &&
          role === "gateway" &&
          embedded &&
          (Object.keys(pluginRuntime.runtime.selections).length > 0 ||
            pluginRuntime.runtime.repositoryBrokerNetworkPolicy !== undefined)) ||
        (pluginRuntime.runtime.kind === "codex" && role === "agent" && runtime !== undefined) ||
        (pluginRuntime.runtime.kind === "codex" && role === "gateway" && !embedded));
    const hasEnabledPlugins =
      pluginRuntime !== undefined &&
      Object.values(pluginRuntime.runtime.selections).some((selection) => selection.enabled);
    const needsPluginStatus = needsPluginRuntime && hasEnabledPlugins;
    const statusRevisionId = configuration?.revisionId ?? ownership.revisionId;
    const needsRuntimeStatus =
      runtime !== undefined &&
      (role === "agent" || role === "gateway") &&
      statusRevisionId !== undefined;
    const needsPrivateStatus = needsPluginStatus || needsRuntimeStatus;
    if (needsPluginRuntime) {
      volumes.push({
        name: PLUGIN_RUNTIME_VOLUME,
        configMap: {
          name: pluginRuntime.name,
          items: [
            { key: PLUGIN_RUNTIME_MANIFEST, path: PLUGIN_RUNTIME_MANIFEST },
            ...(pluginRuntime.runtime.kind === "codex" && role === "agent"
              ? [{ key: PLUGIN_RUNTIME_CODEX_CONFIG, path: PLUGIN_RUNTIME_CODEX_CONFIG }]
              : []),
          ],
          optional: false,
        },
      });
      volumeMounts.push({
        name: PLUGIN_RUNTIME_VOLUME,
        mountPath: PLUGIN_RUNTIME_DIRECTORY,
        readOnly: true,
      });
      variables.push({
        name: PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT,
        value: `${PLUGIN_RUNTIME_DIRECTORY}/${PLUGIN_RUNTIME_MANIFEST}`,
      });
      if (pluginRuntime.runtime.kind === "codex" && role === "agent") {
        variables.push(
          {
            name: PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT,
            value: `${PLUGIN_RUNTIME_DIRECTORY}/${PLUGIN_RUNTIME_CODEX_CONFIG}`,
          },
          {
            name: PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT,
            value: PLUGIN_RUNTIME_READY_MARKER,
          },
        );
      }
    }
    if (needsPrivateStatus) {
      variables.push(
        {
          name: "OPENCLAW_AGENT_REVISION_ID",
          value: required(statusRevisionId, "Runtime status revision ID"),
        },
        {
          name: "OPENCLAW_RUNTIME_STATUS_CONTAINER",
          value: role,
        },
        {
          name: "OPENCLAW_RUNTIME_STATUS_PORT",
          value: String(PLUGIN_RUNTIME_STATUS_PORT),
        },
        {
          name: "OPENCLAW_POD_UID",
          valueFrom: { fieldRef: { fieldPath: "metadata.uid" } },
        },
      );
    }
    if (needsPluginStatus) {
      variables.push(
        {
          name: "OPENCLAW_PLUGIN_STATUS_CONTAINER",
          value: role,
        },
        {
          name: "OPENCLAW_PLUGIN_STATUS_PORT",
          value: String(PLUGIN_RUNTIME_STATUS_PORT),
        },
      );
      if (pluginWarnings.length > 0) {
        variables.push({
          name: "OPENCLAW_PLUGIN_FAILURES_JSON",
          value: JSON.stringify(pluginWarnings),
        });
      }
    }
    if (repositoryMaterial !== undefined) {
      if ((role === "gateway" && !embedded) || runtime === undefined) {
        throw new ConfigurationFailure(
          "Repository credential material requires the Agent's Harness workload.",
        );
      }
      const delivery = repositoryMaterialDeployment(repositoryMaterial, image);
      volumes.push(...delivery.volumes);
      volumeMounts.push(...delivery.volumeMounts);
      initContainers.push(...delivery.initContainers);
      if (embedded) {
        variables.push({
          name: "PATH",
          value: `${REPOSITORY_CLIENT_BIN}:/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        });
      }
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
      variables.push({ name: "LOG_FORMAT", value: "json" });
      if (nativeRuntime === undefined) {
        variables.push({ name: "RUST_LOG", value: `${loggingLevel},codex_otel=off` });
      }
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
        { name: "runtime-state", mountPath: "/home/node", subPath: "home" },
        { name: "runtime-temporary", mountPath: "/tmp", subPath: "tmp" },
      );
    }
    if (dedicated && role === "agent") {
      const agentId = required(ownership.agentId, "Harness workspace Agent ID");
      volumes.push({
        name: HARNESS_WORKSPACE_VOLUME,
        persistentVolumeClaim: { claimName: this.harnessWorkspaceClaimName(agentId) },
      });
      const oauth = harnessAuth?.loginMode === "oauth";
      volumeMounts.push(...this.harnessWorkspaceVolumeMounts(oauth));
      if (oauth) {
        // Deliberate P0 scope: native Codex owns refresh on this private disk;
        // OCE cannot refresh, recover a lost bundle, or share it after handoff.
        // TODO(token-broker): Replace this handoff with broker-managed custody.
        // Token brokerage is separate work in progress, not part of this launch.
        volumes.push({
          name: HARNESS_AUTH_VOLUME,
          persistentVolumeClaim: { claimName: this.harnessWorkspaceClaimName(agentId) },
        });
        volumeMounts.push({
          name: HARNESS_AUTH_VOLUME,
          mountPath: "/home/node/.codex",
          subPath: "codex-home",
        });
      }
      const initialization = initContainers[0]!;
      (initialization.volumeMounts as V1VolumeMount[]).push({
        name: HARNESS_WORKSPACE_VOLUME,
        mountPath: "/harness-workspace-state",
      });
      (initialization.args as string[])[0] += `
for (const path of ${JSON.stringify(
        harnessWorkspaceCategories(oauth).map(([subPath]) => `/harness-workspace-state/${subPath}`),
      )}) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}`;
      if (oauth) {
        // An OAuth home starts without earlier history, as a new OAuth source does.
        (initialization.args as string[])[0] += `
require("node:fs").rmSync("/harness-workspace-state/codex-sessions", { recursive: true, force: true });`;
      } else {
        // A revision without OAuth must not leave a personal login refreshing on the volume.
        (initialization.args as string[])[0] += `
require("node:fs").rmSync("/harness-workspace-state/codex-home", { recursive: true, force: true });`;
      }
    }
    if (dedicated && role === "gateway") {
      // This is the logical workspace key; file access goes through the paired node.
      variables.push({ name: "OPENCLAW_WORKSPACE_DIR", value: "/home/node/workspace" });
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
        subPath: "home/gateway-codex-home",
      });
    }
    if (runtime !== undefined) {
      const agentId = required(ownership.agentId, "Runtime Agent ID");
      const suffix = sha256Hex(agentId, 12);
      const secret = (variable: string, prefix: string, key: string): V1EnvVar => ({
        name: variable,
        valueFrom: {
          secretKeyRef: {
            name:
              role === "agent"
                ? this.harnessSecretsName(
                    agentId,
                    required(ownership.revisionId, "Harness revision ID"),
                  )
                : key === GATEWAY_PASSWORD_KEY
                  ? `gateway-password-${suffix}`
                  : `${prefix}-${suffix}`,
            key,
          },
        },
      });
      if (!embedded && nativeRuntime === undefined) {
        variables.push(
          secret("APP_SERVER_TOKEN", runtime.transportSecretPrefix, AGENT_TRANSPORT_TOKEN_KEY),
        );
      }
      if (role === "gateway") {
        if (embedded) {
          variables.push({
            name: "HOME",
            value: "/home/node",
          });
        } else if (nativeRuntime === undefined) {
          // TODO(workload-transport-mtls): Replace per-Agent capability-token ws:// with mTLS.
          variables.push({
            name: "APP_SERVER_URL",
            value:
              this.options.executionCluster === undefined
                ? `ws://agent-${suffix}.${required(configuration?.harnessNamespace?.name, "Harness namespace")}.svc:${AGENT_TRANSPORT_PORT}`
                : `wss://${this.options.executionCluster.harnessRouting.hostname}${this.harnessRoutePath(ownership)}`,
          });
        }
        if (configuration?.usesGatewayPasswordEnv === true) {
          variables.push(
            secret(OPENCLAW_GATEWAY_PASSWORD, runtime.transportSecretPrefix, GATEWAY_PASSWORD_KEY),
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
          variables.push({ name: "HTTPS_PROXY", value: channels.proxyUrl });
        }
      } else {
        variables.push(
          { name: "HOME", value: "/home/node" },
          {
            name: "PATH",
            value: `${repositoryMaterial === undefined ? "" : `${REPOSITORY_CLIENT_BIN}:`}/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
          },
        );
        if (nativeRuntime === undefined) {
          variables.push(
            { name: "APP_SERVER_PORT", value: String(AGENT_TRANSPORT_PORT) },
            { name: "CODEX_HOME", value: "/home/node/.codex" },
          );
        } else {
          variables.push(
            { name: "OPENCLAW_NATIVE_INFERENCE_CONFIG", value: nativeRuntime.configuration },
            {
              name: "OPENCLAW_NATIVE_INFERENCE_CONFIG_PATH",
              value: NATIVE_WORKER_INFERENCE_CONFIG_PATH,
            },
          );
        }
      }
    }
    if (role === "agent" || embedded) {
      if (harnessAuth === undefined) {
        throw new ConfigurationFailure("Harness authentication preparation is missing.");
      }
      variables.push(...harnessAuth.environment);
    }
    if ((role === "agent" || embedded) && repositoryMaterial !== undefined) {
      const brokerCa = repositoryBrokerPublicCaPath(repositoryMaterial);
      if (brokerCa !== undefined) {
        const existingCaPolicy = variables.find((variable) =>
          REPOSITORY_BROKER_CA_ENVIRONMENT.includes(
            variable.name as (typeof REPOSITORY_BROKER_CA_ENVIRONMENT)[number],
          ),
        );
        if (existingCaPolicy !== undefined) {
          throw new ConfigurationFailure(
            `Repository credential broker CA delivery cannot replace explicit ${existingCaPolicy.name} environment configuration.`,
          );
        }
        variables.push(
          ...REPOSITORY_BROKER_CA_ENVIRONMENT.map((name) => ({ name, value: brokerCa })),
        );
      }
    }
    if (workspaceSetup !== undefined && (embedded || role === "agent")) {
      const workspace = embedded
        ? required(configuration?.workspace, "Initial workspace directory")
        : "/home/node/workspace";
      volumes.push({
        name: "workspace-setup",
        secret: {
          secretName: this.workspaceSetupSecretName(workspaceSetup.agentId),
          defaultMode: 0o440,
        },
      });
      initContainers.push({
        name: "initialize-workspace",
        image: this.options.images.gateway,
        imagePullPolicy: "IfNotPresent",
        // Native setup loads the Gateway CLI and needs its configured resource budget.
        resources: this.options.resources.gateway,
        command: [...SETUP_WRAPPER_COMMAND],
        args: [WORKSPACE_SETUP_RUNTIME],
        env: [
          { name: "HOME", value: "/home/node" },
          { name: "OPENCLAW_STATE_DIR", value: "/home/node/.openclaw" },
          { name: "OPENCLAW_WORKSPACE_SETUP_PATH", value: "/run/workspace-setup/setup.json" },
          { name: "OPENCLAW_WORKSPACE_DIR", value: workspace },
          { name: "OPENCLAW_EXECUTABLE", value: "/app/openclaw.mjs" },
          ...variables.filter(({ name }) => name === "OPENCLAW_CONFIG_PATH"),
        ],
        volumeMounts: [
          ...volumeMounts.filter(({ name }) =>
            [
              "runtime-state",
              "runtime-temporary",
              GATEWAY_PRIVATE_STATE_VOLUME,
              HARNESS_WORKSPACE_VOLUME,
              CONFIGURATION_VOLUME,
            ].includes(name),
          ),
          { name: "workspace-setup", mountPath: "/run/workspace-setup", readOnly: true },
        ],
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        },
      });
    }
    if (dedicated && this.options.executionCluster !== undefined) {
      if (role === "gateway") {
        variables.push({
          name: "OPENCLAW_PEER_PLUGIN_STATUS_URL",
          value: `https://${this.options.executionCluster.harnessRouting.hostname}${this.harnessRoutePath(ownership)}/plugin-status`,
        });
        if (this.options.executionCluster.caBundle !== undefined) {
          variables.push({
            name: "NODE_EXTRA_CA_CERTS",
            value: `${configuration?.usesWritableNativeAdminConfig ? MANAGED_CONFIGURATION_DIRECTORY : CONFIGURATION_DIRECTORY}/execution-ca.pem`,
          });
        }
      } else {
        variables.push({ name: "OPENCLAW_REMOTE_PLUGIN_STATUS", value: "true" });
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
    const selectedNodes =
      dedicated && role === "gateway" ? runtime?.gatewayNodeSelector : runtime?.nodeSelector;
    if (
      dedicated &&
      role === "gateway" &&
      runtime !== undefined &&
      (selectedNodes === undefined || Object.keys(selectedNodes).length === 0)
    ) {
      throw new ConfigurationFailure(
        "Dedicated Gateways require runtime.gatewayNodeSelector for control-plane scheduling.",
      );
    }
    const runtimeNodeSelector = selectedNodes === undefined ? {} : { nodeSelector: selectedNodes };
    const codexSeccompProfile =
      role === "agent" && nativeRuntime === undefined && runtime?.codexSeccompProfile !== undefined
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
          ...(repositoryMaterial === undefined
            ? {}
            : { [REPOSITORY_MATERIAL_GENERATION]: repositoryMaterial.generation }),
        },
      },
      spec: {
        replicas: 1,
        // Node enrollment updates the initial Harness after its Gateway starts.
        // Keep one strategy: Kubernetes rejects Recreate while default RollingUpdate fields remain.
        ...(role === "gateway" || (runtime !== undefined && this.nodeEnrollment !== undefined)
          ? { strategy: { type: "Recreate" } }
          : {}),
        selector: { matchLabels: selector },
        template: {
          metadata: {
            ...workloadMetadata,
            annotations: {
              ...workloadMetadata.annotations,
              ...configurationAnnotations,
              ...(repositoryMaterial === undefined
                ? {}
                : { [REPOSITORY_MATERIAL_GENERATION]: repositoryMaterial.generation }),
            },
            labels: {
              ...workloadMetadata.labels,
              ...revisionLabels,
              ...selector,
              "openclaw.dev/workload-role": role,
              [NETWORK_PROFILE_LABEL]: ORDINARY_NETWORK_PROFILE,
            },
          },
          spec: {
            serviceAccountName,
            automountServiceAccountToken: false,
            ...(role === "gateway"
              ? { terminationGracePeriodSeconds: GATEWAY_STOP_TIMEOUT_MS / 1000 }
              : {}),
            ...runtimeNodeSelector,
            ...(volumes.length === 0 ? {} : { volumes }),
            ...(initContainers.length === 0 ? {} : { initContainers }),
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              // OnRootMismatch skips the recursive ownership walk of 10-40Gi claims on
              // every start once the volume root already carries fsGroup ownership.
              ...(privateHome ? { fsGroup: 1000, fsGroupChangePolicy: "OnRootMismatch" } : {}),
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
                  ...(role === "gateway" && this.options.gatewayRouting?.sandbox !== undefined
                    ? [{ containerPort: this.options.network.gatewayPort + 1, name: "sandbox" }]
                    : []),
                  ...(needsPrivateStatus
                    ? [{ containerPort: PLUGIN_RUNTIME_STATUS_PORT, name: "plugin-status" }]
                    : []),
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
                              : nativeRuntime === undefined
                                ? AGENT_READINESS_ENTRYPOINT
                                : NATIVE_WORKER_READINESS_ENTRYPOINT,
                          ],
                        },
                      }
                    : { httpGet: { path: "/readyz", port } }),
                  periodSeconds: 2,
                  ...(nativeRuntime === undefined ? {} : { timeoutSeconds: 3 }),
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
                      // Under tini, SIGTERM stops the wrapper in every startup phase.
                      command: [...RUNTIME_WRAPPER_COMMAND],
                      args: nodeProgramArguments(
                        (workspaceSetup === undefined || (!embedded && role === "gateway")
                          ? ""
                          : workspaceSetupVerifier(
                              workspaceSetup,
                              role === "gateway"
                                ? required(configuration?.workspace, "Initial workspace directory")
                                : "/home/node/workspace",
                            )) +
                          (role === "gateway"
                            ? GATEWAY_RUNTIME_ENTRYPOINT
                            : nativeRuntime === undefined
                              ? AGENT_RUNTIME_ENTRYPOINT
                              : NATIVE_WORKER_ENTRYPOINT),
                      ),
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
    namespace: KubernetesNamespaceAddress,
    selector: Record<string, string>,
  ): ManagedKubernetesObject {
    const runtimeAgentService =
      ownership.servicePrincipalId !== undefined && this.options.runtime !== undefined;
    return {
      ...this.manifest("v1", "Service", name, ownership, namespace),
      spec: {
        type: "ClusterIP",
        selector,
        ports: [
          {
            name: runtimeAgentService ? "websocket" : "http",
            port: runtimeAgentService ? AGENT_TRANSPORT_PORT : this.options.network.gatewayPort,
            targetPort: runtimeAgentService
              ? AGENT_TRANSPORT_PORT
              : this.options.network.gatewayPort,
          },
          ...(runtimeAgentService
            ? [
                {
                  name: "plugin-status",
                  port: PLUGIN_RUNTIME_STATUS_PORT,
                  targetPort: PLUGIN_RUNTIME_STATUS_PORT,
                },
              ]
            : []),
          ...(!runtimeAgentService && this.options.gatewayRouting?.sandbox !== undefined
            ? [
                {
                  name: "sandbox",
                  port: this.options.network.gatewayPort + 1,
                  targetPort: this.options.network.gatewayPort + 1,
                },
              ]
            : []),
        ],
      },
    };
  }

  private async reconcile(
    desired: ManagedKubernetesObject,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
    precondition?: ReconcilePrecondition,
  ): Promise<void> {
    const clients = await this.clients(namespace.plane);
    const existing = await this.getOwned(desired.kind, desired.metadata.name, namespace, ownership);
    if (precondition !== undefined && desired.kind !== "Service") {
      throw new ConfigurationFailure(
        `Unsupported Kubernetes reconcile precondition for ${desired.kind}.`,
      );
    }
    if (existing === undefined && precondition !== undefined) {
      return;
    }
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
        const data = desired.data ?? {};
        const existingData = existing.data ?? {};
        if (
          existing.immutable !== true ||
          Object.entries(annotations).some(
            ([name, value]) => existing.metadata.annotations?.[name] !== value,
          ) ||
          Object.keys(existingData).length !== Object.keys(data).length ||
          Object.entries(data).some(([name, value]) => existingData[name] !== value) ||
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
              { ...request, namespace: required(namespace.name, "ConfigMap namespace") },
              this.patchOptions,
            );
            return;
          case "ServiceAccount":
            await clients.core.patchNamespacedServiceAccount(
              { ...request, namespace: required(namespace.name, "ServiceAccount namespace") },
              this.patchOptions,
            );
            return;
          case "Service":
            await clients.core.patchNamespacedService(
              { ...request, namespace: required(namespace.name, "Service namespace") },
              this.patchOptions,
            );
            return;
          case "ResourceQuota":
            await clients.core.patchNamespacedResourceQuota(
              { ...request, namespace: required(namespace.name, "ResourceQuota namespace") },
              this.patchOptions,
            );
            return;
          case "LimitRange":
            await clients.core.patchNamespacedLimitRange(
              { ...request, namespace: required(namespace.name, "LimitRange namespace") },
              this.patchOptions,
            );
            return;
          case "PersistentVolumeClaim":
            await clients.core.patchNamespacedPersistentVolumeClaim(
              {
                ...request,
                namespace: required(namespace.name, "PersistentVolumeClaim namespace"),
              },
              this.patchOptions,
            );
            return;
          case "Deployment":
            await clients.apps.patchNamespacedDeployment(
              { ...request, namespace: required(namespace.name, "Deployment namespace") },
              this.patchOptions,
            );
            return;
          case "NetworkPolicy":
            await clients.networking.patchNamespacedNetworkPolicy(
              { ...request, namespace: required(namespace.name, "NetworkPolicy namespace") },
              this.patchOptions,
            );
            return;
          case "HTTPRoute":
          case "SecurityPolicy":
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

  private getNamespace(namespace: KubernetesNamespaceAddress) {
    return this.get("Namespace", namespace.name, namespace);
  }

  private async getOwned<Kind extends ReadableResourceKind>(
    kind: Kind,
    name: string,
    namespace: KubernetesNamespaceAddress,
    ownership: Ownership,
  ): Promise<ManagedKubernetesObject<Kind> | undefined> {
    const object = await this.get(kind, name, namespace);
    if (object !== undefined) {
      this.verifyOwnership(object, ownership);
    }
    return object;
  }

  private async get<Kind extends ReadableResourceKind>(
    kind: Kind,
    name: string,
    namespace: KubernetesNamespaceAddress,
  ): Promise<ManagedKubernetesObject<Kind> | undefined> {
    const clients = await this.clients(namespace.plane);
    try {
      const value = asRecord(
        await this.request(async () => {
          switch (kind) {
            case "Namespace":
              return clients.core.readNamespace({ name });
            case "Pod":
              return clients.core.readNamespacedPod({
                name,
                namespace: required(namespace.name, "Pod namespace"),
              });
            case "ConfigMap":
              return clients.core.readNamespacedConfigMap({
                name,
                namespace: required(namespace.name, "ConfigMap namespace"),
              });
            case "Secret":
              return clients.core.readNamespacedSecret({
                name,
                namespace: required(namespace.name, "Secret namespace"),
              });
            case "ServiceAccount":
              return clients.core.readNamespacedServiceAccount({
                name,
                namespace: required(namespace.name, "ServiceAccount namespace"),
              });
            case "Service":
              return clients.core.readNamespacedService({
                name,
                namespace: required(namespace.name, "Service namespace"),
              });
            case "ResourceQuota":
              return clients.core.readNamespacedResourceQuota({
                name,
                namespace: required(namespace.name, "ResourceQuota namespace"),
              });
            case "LimitRange":
              return clients.core.readNamespacedLimitRange({
                name,
                namespace: required(namespace.name, "LimitRange namespace"),
              });
            case "PersistentVolumeClaim":
              return clients.core.readNamespacedPersistentVolumeClaim({
                name,
                namespace: required(namespace.name, "PersistentVolumeClaim namespace"),
              });
            case "Deployment":
              return clients.apps.readNamespacedDeployment({
                name,
                namespace: required(namespace.name, "Deployment namespace"),
              });
            case "NetworkPolicy":
              return clients.networking.readNamespacedNetworkPolicy({
                name,
                namespace: required(namespace.name, "NetworkPolicy namespace"),
              });
            case "HTTPRoute":
            case "SecurityPolicy":
              return clients.objects.read({
                apiVersion:
                  kind === "HTTPRoute" ? GATEWAY_API_VERSION : GATEWAY_SECURITY_POLICY_API_VERSION,
                kind,
                metadata: { name, namespace: required(namespace.name, `${kind} namespace`) },
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
        (kind !== "Namespace" && metadata.namespace !== namespace.name)
      ) {
        throw new Error(`The Kubernetes client returned an invalid or ambiguous ${kind} ${name}.`);
      }
      return value as unknown as ManagedKubernetesObject<Kind>;
    } catch (error) {
      if (numericErrorStatus(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }
}

export function createKubernetesComputeDriver(
  options: KubernetesComputeDriverOptions,
): KubernetesComputeDriver {
  return new KubernetesComputeDriver(options);
}

/** Kubernetes clients return `Date` objects or RFC 3339 strings for timestamps. */
function kubernetesTime(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}
