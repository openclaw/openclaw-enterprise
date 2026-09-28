import {
  asRecord,
  isNonEmptyString,
  numericErrorStatus,
  sha256Hex,
} from "@openclaw-enterprise/utils";
import { randomBytes, X509Certificate } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { isAbsolute } from "node:path";
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
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
  ComputeAgentProvisioningInput,
  ComputeDriver,
  ComputeAgentBinding,
  ComputeAgentRevisionBinding,
  ComputeReadiness,
  ComputePreflightResult,
  ComputeRevisionContext,
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
import { DependencyUnavailableError, ResourceConflictError } from "@openclaw-enterprise/occ";
import { createKubernetesClientConfiguration } from "../../kubernetes/client.ts";
import {
  WORKSPACE_SETUP_RUNTIME,
  workspaceSetupMainAgent,
  workspaceSetupVerifier,
} from "../workspace-setup-runtime.ts";
import { ComputeLifecycleDispatcher } from "../lifecycle-hooks.ts";
import { discoverHarnessModels } from "../model-discovery.ts";
import { currentComputeAbortSignal, withComputeAbortSignal } from "../operation-context.ts";
import { unsupportedNativeGatewayAuthFields } from "../../../gateway/auth-fields.ts";
import type { GatewayNodeEnrollment } from "../../../gateway/node-enrollment-client.ts";
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
  GATEWAY_RUNTIME_ENTRYPOINT,
  GATEWAY_READINESS_ENTRYPOINT,
  GATEWAY_STOP_TIMEOUT_MS,
} from "./runtime-entrypoints.ts";

import {
  REPOSITORY_MATERIAL_GENERATION,
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
}

export const MINIMUM_KUBERNETES_VERSION = "1.35.0";
const MINIMUM_KUBERNETES_VERSION_PARTS = [1, 35, 0] as const;

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
    readonly nodeSelector?: Readonly<Record<string, string>>;
    readonly gatewayNodeSelector?: Readonly<Record<string, string>>;
    readonly codexSeccompProfile?: string;
    readonly channels?: {
      readonly proxyUrl: string;
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
  readonly harnessNamespace?: KubernetesNamespaceAddress;
  readonly workspace: unknown;
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
    harness.id === "codex"
  ) {
    // The paired Sandbox supplies the credential environment; no Secret is projected here.
    environment.push({ name: "CODEX_LOGIN_MODE", value: resolvedAuth.loginMode });
    return {
      loginMode: resolvedAuth.loginMode,
      environment,
      credentialSource: resolvedAuth.source,
    };
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
  if (harness.mode === "dedicated") {
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
const WORKLOAD_TERMINATION_TIMEOUT_MS = 120_000;
const WORKLOAD_TERMINATION_POLL_MS = 100;
const AGENT_TRANSPORT_PORT = 18_790;
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
const NODE_STATE_PATH = "/home/node/.openclaw-node";
const GATEWAY_PRIVATE_STATE_CATEGORIES = Object.freeze([
  ["state", "/home/node/.openclaw/state"],
  ["agent", "/home/node/.openclaw/agents/main/agent"],
  ["media", "/home/node/.openclaw/media"],
] as const);
const HARNESS_WORKSPACE_VOLUME = "openclaw-workspace";
const HARNESS_WORKSPACE_SIZE = "40Gi";
type WorkspaceRole = "agent" | "gateway";
const HARNESS_WORKSPACE_CATEGORIES = Object.freeze([
  ["workspace", "/home/node/workspace"],
  ["generated-images", "/home/node/.codex/generated_images"],
] as const);
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
  return `oce-${sha256Hex(id, 15)}`;
}

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

/** Canonical configuration and credentials belong to the managed control-plane tenant. */
export async function resolveKubernetesControlNamespace(
  client: CoreV1Api,
  namespaceId: string,
): Promise<{ readonly name: string }> {
  const name = kubernetesGatewayNamespaceName(namespaceId);
  const observed = await client.readNamespace({ name });
  const metadata = observed?.metadata;
  if (
    metadata?.name !== name ||
    metadata.labels?.["openclaw.dev/gateway-namespace"] !== namespaceId ||
    metadata.labels?.["app.kubernetes.io/managed-by"] !== MANAGER ||
    metadata.annotations?.["openclaw.dev/namespace-id"] !== namespaceId ||
    metadata.labels?.["openclaw.dev/namespace"] !== undefined
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
  const providerId = harnessPrimaryModel(configuration).split("/", 1)[0]!;
  if (providerId === "openai" || providerId === "codex") {
    return { providerId, environmentName: MODEL_API_KEY };
  }
  if (providerId === "anthropic") {
    return { providerId, environmentName: "ANTHROPIC_API_KEY" };
  }
  throw new ConfigurationFailure("Harness authentication requires a compatible model provider.");
}

export class KubernetesComputeDriver implements ComputeDriver {
  readonly discoverHarnessModels = discoverHarnessModels;

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
          nodeSelector: { type: "object", additionalProperties: { type: "string" } },
          gatewayNodeSelector: { type: "object", additionalProperties: { type: "string" } },
          codexSeccompProfile: { type: "string", minLength: 1 },
          channels: {
            type: "object",
            required: ["proxyUrl"],
            additionalProperties: false,
            properties: {
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
      if (options.runtime.codexSeccompProfile !== undefined) {
        validateCodexSeccompProfile(options.runtime.codexSeccompProfile);
      }
      if (channels !== undefined) {
        if (asRecord(channels) === undefined) {
          throw new ConfigurationFailure("Channel runtime proxy must be explicitly configured.");
        }
        channelProxy(channels.proxyUrl);
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
      const observedVersion = kubernetesVersion(
        (await this.request(() => clients.version.getCode())).gitVersion,
      );
      const namespaces = await this.request(() =>
        clients.core.listNamespace({
          limit: 1,
          timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        }),
      );
      if (!Array.isArray(namespaces.items)) {
        throw new Error("The authenticated Kubernetes Namespace preflight returned invalid data.");
      }
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
    const embedded = harness.mode === "embedded" && harness.id === "openclaw";
    const dedicated = harness.mode === "dedicated" && harness.id === "codex";
    if (
      (!embedded && !dedicated) ||
      !auth ||
      (auth.method !== "api_key" &&
        auth.method !== "codex_pat" &&
        auth.method !== "chatgpt_service_account" &&
        auth.method !== "credential_source") ||
      (embedded && auth.method !== "api_key")
    ) {
      throw new ConfigurationFailure(
        "Harness authentication is incompatible with the selected topology.",
      );
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
    const native = harnessModelAuthentication(configuration);
    const prefixes = embedded ? [`${native.providerId}/`] : ["openai/", "codex/"];
    if (
      (embedded && native.providerId === "codex") ||
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
    if (embedded) {
      harnessProbeConfiguration(configuration);
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
    const selectedProviders = new Set(models.map((model) => (model as string).split("/", 1)[0]));
    for (const provider of selectedProviders) {
      const config = asRecord(providers[provider!]);
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
      if (!embedded) {
        throw conflictingAuth();
      }
      if (config.apiKey === `\${${native.environmentName}}`) {
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
        ref.id !== native.environmentName ||
        source?.source !== "env" ||
        (source.allowlist !== undefined &&
          (!Array.isArray(source.allowlist) || !source.allowlist.includes(native.environmentName)))
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
    return `wss://${this.gatewayRoutingHostname(routing)}${this.gatewayRoutePath(revision)}`;
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
      // Agent deletion checks both targets, with ownership and UID fences.
      const target = this.controlNamespace(namespaceId);
      const observed = await this.getNamespace(target);
      if (observed !== undefined) {
        this.verifyGatewayNamespace(observed, { namespaceId });
        await this.deleteGatewayPrivateStateClaim({ namespaceId, agentId }, target);
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
    const namespace = this.controlNamespace(namespaceId);
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

    const namespace = this.controlNamespace(namespaceId);
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
    return revision.harness.mode === "embedded"
      ? harnessNamespace
      : this.controlNamespace(revision.namespaceId);
  }

  private gatewayNamespaceManifest(ownership: Ownership): ManagedKubernetesObject<"Namespace"> {
    const desired = this.manifest(
      "v1",
      "Namespace",
      kubernetesGatewayNamespaceName(ownership.namespaceId),
      ownership,
    );
    // Tenant discovery must continue to resolve only the data-plane namespace.
    delete desired.metadata.labels!["openclaw.dev/namespace"];
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
    const name = this.controlNamespace(ownership.namespaceId);
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
    const desired = this.gatewayNamespaceManifest(ownership);
    const name = this.controlNamespace(ownership.namespaceId);
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
    if (revision.harness.mode === "embedded") {
      return namespace;
    }
    if (namespace.name === harnessNamespace.name && this.options.executionCluster === undefined) {
      throw new ConfigurationFailure("Gateway and Harness runtime targets must be separate.");
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
        const gateway = await this.getNamespace(this.controlNamespace(namespace.id));
        if (gateway !== undefined) {
          this.verifyGatewayNamespace(gateway, ownership);
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
      const gateway = await this.getNamespace(this.controlNamespace(namespace.id));
      if (gateway !== undefined) {
        this.verifyGatewayNamespace(gateway, ownership);
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
      (!embedded && (revision.harness.mode !== "dedicated" || revision.harness.id !== "codex"))
    ) {
      throw new ConfigurationFailure("AgentRevision Harness execution topology is unsupported.");
    }
    const sandboxDriver = this.sandboxDriverForRevision(revision);
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
    const secretEnvironment = this.secretEnvironmentForRevision(
      revision,
      context,
      this.controlNamespace(revision.namespaceId),
    );
    const harnessAuth = this.harnessAuthForRevision(
      admittedRevision,
      context,
      this.controlNamespace(revision.namespaceId),
    );
    const gatewayNamespace = await this.requireGatewayNamespace(revision, namespace);
    const tenantOwnership = { namespaceId: revision.namespaceId };
    const observed = await this.getNamespace(namespace);
    if (observed === undefined) {
      return result;
    }
    this.verifyNamespaceOwnership(observed, tenantOwnership, external);
    if (observed.status?.phase !== "Active") {
      return result;
    }
    for (const policy of this.networkPolicies(tenantOwnership, namespace)) {
      const existing = await this.getOwned(
        "NetworkPolicy",
        policy.metadata.name,
        namespace,
        tenantOwnership,
      );
      if (existing === undefined) {
        return result;
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
    const incomplete = async (): Promise<ComputeReadiness> => {
      const runtimeFailure = await this.safeRuntimeFailureObservation(
        revision,
        namespace,
        workspaceSetup !== undefined,
      );
      return runtimeFailure === undefined ? result : { ...result, runtimeFailure };
    };
    const ready = async (
      expectedWarnings?: readonly PluginDeploymentWarning[],
    ): Promise<ComputeReadiness> => {
      if (pluginStatusContainer === undefined) {
        await this.deliverWorkspaceSetup(revision, workspaceSetup, namespace, true);
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
        pluginStatusContainer,
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
    const document = JSON.stringify(admittedNativeConfiguration);
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
    if (embedded) {
      for (const { resource: policy, namespace: target } of this.agentNetworkPolicies(
        revision,
        namespace,
      )) {
        await this.reconcile(policy, gatewayOwnership, target);
      }
    } else if (this.options.runtime !== undefined) {
      for (const { resource: policy, namespace: target } of this.pluginStatusNetworkPolicies(
        revision,
        namespace,
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
      const embeddedEnvironment = embedded
        ? (await this.lifecycle.beforeWorkloadStart(revision)).environment
        : {};
      if (embedded) {
        launchPrepared = true;
      }
      const deferInitialDedicatedGatewayForPluginStatus =
        !embedded &&
        this.options.runtime !== undefined &&
        pluginStatusContainer !== undefined &&
        existingGateway === undefined &&
        workspaceSetup === undefined;
      const reconcileGatewayDeployment = async (environment: Record<string, string>) => {
        await this.reconcileChannelNetworkPolicy(revision, channels, gatewayNamespace);
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
          ),
          gatewayOwnership,
          gatewayNamespace,
        );
      };
      if (
        (existingGateway === undefined && !deferInitialDedicatedGatewayForPluginStatus) ||
        this.options.runtime === undefined ||
        existingGateway?.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] === revision.id
      ) {
        await reconcileGatewayDeployment(embeddedEnvironment);
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
        if (gateway === undefined || !this.deploymentReady(gateway)) {
          return incomplete();
        }
      } else if (
        embedded &&
        !(await this.gatewayReady(gatewayOwnership, gatewayName, gatewayNamespace))
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
      if (existingService === undefined) {
        await this.reconcile(
          this.service(agentName, agentOwnership, namespace, {
            "app.kubernetes.io/name": `${agentName}-inactive`,
          }),
          agentOwnership,
          namespace,
        );
      }
      if (this.options.runtime !== undefined) {
        for (const policy of this.agentNetworkPolicies(revision, namespace)) {
          await this.reconcile(policy.resource, gatewayOwnership, policy.namespace);
        }
        await this.reconcile(
          this.agentAuthenticationNetworkPolicy(revision, namespace),
          agentOwnership,
          namespace,
        );
      }
      await this.reconcileHarnessRoute(revision, namespace);
      const launch = await this.lifecycle.beforeWorkloadStart(revision);
      launchPrepared = true;
      const node = await this.prepareWorkspaceNode(revision, namespace);
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
        deliveredHarnessAuth,
        [],
        [],
        pluginRuntime,
        [],
        workspaceSetup,
        repositoryConsumer?.role === "agent" ? repositoryMaterial : undefined,
      );
      if (node !== undefined) {
        this.addWorkspaceNode(agentDeployment, node.name, node.ca, revision);
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
      )) {
        await this.reconcile(policy, gatewayOwnership, target);
      }
      const agentReadiness = await ready();
      if (!agentReadiness.ready) {
        return agentReadiness;
      }
      if (this.options.runtime === undefined) {
        return (await this.gatewayReady(gatewayOwnership, gatewayName, gatewayNamespace))
          ? agentReadiness
          : incomplete();
      }
      if (existingGatewayRevisionId !== undefined && existingGatewayRevisionId !== revision.id) {
        if (!(await this.gatewayReady(gatewayOwnership, gatewayName, gatewayNamespace))) {
          await reconcileGatewayDeployment({});
          return incomplete();
        }
        if (!(await this.workspaceNodeReady(revision, namespace))) {
          return incomplete();
        }
        return repositoryMaterial !== undefined &&
          !(await this.repositoryMaterialReady(revision, namespace, repositoryMaterial))
          ? incomplete()
          : agentReadiness;
      }
      const workspaceNodeIsReady = await this.workspaceNodeReady(revision, namespace);
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
        return incomplete();
      }
      // Gateway plugin and node observations may outlive the material readiness observation.
      if (
        repositoryMaterial !== undefined &&
        !(await this.repositoryMaterialReady(revision, namespace, repositoryMaterial))
      ) {
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
    const secretEnvironment = this.secretEnvironmentForRevision(
      revision,
      context,
      this.controlNamespace(revision.namespaceId),
    );
    const harnessAuth = this.harnessAuthForRevision(
      admittedRevision,
      context,
      this.controlNamespace(revision.namespaceId),
    );
    const gatewayNamespace = await this.requireGatewayNamespace(revision, namespace);
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
    const renderAgentDeployment = (environment: Readonly<Record<string, string>>) =>
      this.deployment(
        revisionName,
        { ...ownership, revisionId: revision.id },
        namespace,
        this.options.images.agent,
        agentName,
        "agent",
        environment,
        configuration.loggingLevel,
        undefined,
        false,
        undefined,
        harnessAuth,
        [],
        [],
        pluginRuntime,
        [],
        workspaceSetup,
        repositoryMaterial,
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
          const node = await this.prepareWorkspaceNode(revision, namespace);
          if (node !== undefined) {
            this.addWorkspaceNode(replacement, node.name, node.ca, revision);
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
  }

  async deactivateRevision(revision: AgentRevision): Promise<void> {
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
    await this.retireWorkspaceNode(revision, namespace);
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
  ): Promise<void> {
    const clients = await this.clients(namespace.plane);
    const signal = this.operationSignal();
    const labels = {
      "openclaw.dev/namespace": revision.namespaceId,
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/revision": revision.id,
      "openclaw.dev/workload-role": role,
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
        : this.controlNamespace(revision.namespaceId);
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

  private async gatewayRouteForRevision(
    name: string,
    ownership: Ownership,
    namespace: KubernetesNamespaceAddress,
    revisionId: string,
  ): Promise<ManagedKubernetesObject<"HTTPRoute"> | undefined> {
    if (this.options.gatewayRouting === undefined) {
      return undefined;
    }
    const existing = await this.getOwned("HTTPRoute", name, namespace, ownership);
    if (existing === undefined) {
      return undefined;
    }
    return existing.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] === revisionId
      ? existing
      : undefined;
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
    return ready >= Number(deployment.spec?.replicas);
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
    const namespace = dedicated
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
        keys: dedicated
          ? [AGENT_TRANSPORT_TOKEN_KEY]
          : [AGENT_TRANSPORT_TOKEN_KEY, GATEWAY_PASSWORD_KEY],
      },
      ...(dedicated
        ? {
            gatewayPassword: {
              name: `gateway-password-${context.suffix}`,
              keys: [GATEWAY_PASSWORD_KEY],
            },
          }
        : {}),
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
      const secret = await this.getOwned("Secret", spec.name, context.namespace, context.ownership);
      if (secret !== undefined) {
        this.requireCompleteRuntimeCredentialSecret(secret, spec);
      }
      return secret;
    };
    return {
      transport: await read(context.transport),
      gatewayPassword: await read(context.gatewayPassword),
    };
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
      const observed = await this.request(() =>
        clients.apps.listNamespacedDeployment({
          namespace: namespace.name,
          labelSelector: labelsToSelector({
            "openclaw.dev/namespace": context.namespaceId,
            "openclaw.dev/agent": context.agentId,
          }),
          timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        }),
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
    await this.request(
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
    );
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
    if (
      (existingLabel !== undefined && existingLabel !== ownership.namespaceId) ||
      (existingId !== undefined && existingId !== ownership.namespaceId)
    ) {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} belongs to another tenant.`,
      );
    }
    const requiredLabels = this.gatewayMembershipLabels(
      this.options.executionCluster?.harnessRouting,
    );
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

  private controlNamespace(namespaceId: string): KubernetesNamespaceAddress {
    return { name: kubernetesGatewayNamespaceName(namespaceId), plane: "control" };
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
    const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
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
        if (ownerSignal?.aborted) {
          throw ownerSignal.reason;
        }
        if (deadline.aborted) {
          throw new Error("Kubernetes API request timed out.");
        }
        const status = numericErrorStatus(error);
        const retryable =
          status === 429 ||
          (status !== undefined && status >= 500) ||
          (status === undefined &&
            !(error instanceof ConfigurationFailure) &&
            !(error instanceof OwnershipFailure));
        if (!retryable || options.mutating === true || attempt >= 3) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 25));
      }
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

  private samePluginWarnings(
    left: readonly PluginDeploymentWarning[],
    right: readonly PluginDeploymentWarning[],
  ): boolean {
    return isDeepStrictEqual(
      [...left].sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
      [...right].sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
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
    let parsed: unknown;
    try {
      const clients = await this.clients(namespace.plane);
      const raw = await this.request(() =>
        clients.core.connectGetNamespacedPodProxyWithPath({
          name: `${podName}:${PLUGIN_RUNTIME_STATUS_PORT}`,
          namespace: namespace.name,
          path: path.slice(1),
        }),
      );
      parsed = this.boundedRuntimeStatusResponse(raw);
    } catch (error) {
      if (numericErrorStatus(error) === 404 || numericErrorStatus(error) === 503) {
        return undefined;
      }
      throw error;
    }
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
    return Object.freeze({
      component: failed.component,
      check: failed.check,
      checkedAt: failed.checkedAt,
      code: failed.code,
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
      if (!this.samePluginWarnings(failures, expected)) {
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
      credentialAttachments: Object.freeze([...credentialAttachments]),
      loginMode,
      labels: harnessLabels,
    };
  }

  private workspaceNodeName(revision: AgentRevision): string {
    return `workspace-node-${sha256Hex(revision.agentId, 12)}-${sha256Hex(revision.id, 12)}`;
  }

  private async retireWorkspaceNode(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<void> {
    if (
      this.nodeEnrollment === undefined ||
      this.options.runtime === undefined ||
      this.options.gatewayRouting === undefined ||
      revision.harness.mode !== "dedicated"
    ) {
      return;
    }
    const ownership = this.pluginRuntimeOwnership(revision);
    const name = this.workspaceNodeName(revision);
    const secret = await this.getOwned("Secret", name, namespace, ownership);
    // The node's saved identity stays on the Harness claim until Agent deletion.
    // Each revision mounts only its own subdirectory.
    if (secret !== undefined) {
      const uid = required(secret.metadata.uid, "Workspace node Secret UID");
      const clients = await this.clients(namespace.plane);
      await this.request(
        () =>
          clients.core.deleteNamespacedSecret({
            name,
            namespace: namespace.name,
            body: { preconditions: { uid } },
          }),
        { mutating: true },
      );
    }
  }

  private async prepareWorkspaceNode(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): Promise<{ readonly name: string; readonly ca?: string } | undefined> {
    const enrollment = this.nodeEnrollment;
    const url = this.getGatewayEndpoint(revision);
    if (enrollment === undefined || this.options.runtime === undefined || url === undefined) {
      return undefined;
    }
    const name = this.workspaceNodeName(revision);
    const ownership = this.pluginRuntimeOwnership(revision);
    const namespaceOwnership = { namespaceId: revision.namespaceId };
    await this.reconcile(
      this.workspaceNodeNetworkPolicy(namespaceOwnership, namespace),
      namespaceOwnership,
      namespace,
    );
    const existing = await this.getOwned("Secret", name, namespace, ownership);
    if (existing === undefined) {
      const gatewayOwnership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
      const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
      // Plugin initialization can precede the first Gateway. Start the Harness
      // without a node, then enroll once its Gateway is available.
      if (
        !(await this.gatewayReady(
          gatewayOwnership,
          gatewayName,
          this.gatewayNamespace(revision, namespace),
        ))
      ) {
        return undefined;
      }
      const setup = await enrollment.createSetup(url, `${url}/node`, this.operationSignal());
      const clients = await this.clients(namespace.plane);
      // Persist before launching. An uncertain create is not replayed here; the
      // next reconciliation reads the exact revision-owned Secret first.
      await this.request(
        () =>
          clients.core.createNamespacedSecret({
            namespace: namespace.name,
            body: {
              ...this.manifest("v1", "Secret", name, ownership, namespace),
              type: "Opaque",
              stringData: {
                setupId: setup.setupId,
                setupCode: setup.setupCode,
                expiresAtMs: String(setup.expiresAtMs),
              },
            },
          }),
        { mutating: true },
      );
    }
    const ca = await this.readNodeCa?.();
    return { name, ...(ca === undefined ? {} : { ca }) };
  }

  private addWorkspaceNode(
    deployment: ManagedKubernetesObject,
    name: string,
    ca: string | undefined,
    revision: AgentRevision,
  ): void {
    const pod = asRecord(asRecord(deployment.spec?.template)?.spec)!;
    const container = (pod.containers as KubernetesRecord[])[0]!;
    const variables = container.env as V1EnvVar[];
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
        name: "OPENCLAW_NODE_SETUP_CODE",
        valueFrom: { secretKeyRef: { name, key: "setupCode" } },
      },
      { name: "OPENCLAW_NODE_STATE_DIR", value: NODE_STATE_PATH },
      ...(ca === undefined ? [] : [{ name: "OPENCLAW_NODE_CA_PEM", value: ca }]),
    );
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
    (initialization.args as string[])[0] +=
      `\nmkdirSync(${JSON.stringify(`/workspace-node-state/${name}`)}, { recursive: true, mode: 0o700 });`;
    // Reuse Harness storage outside the project directory. Revision-specific
    // subpaths preserve restart identity without sharing another node's token.
    (container.volumeMounts as V1VolumeMount[]).push({
      name: NODE_STATE_VOLUME,
      mountPath: NODE_STATE_PATH,
      subPath: name,
      readOnly: false,
    });
    // Independent restarts can orphan descendants of a failed wrapper. Tini
    // reaps them, including when a Sandbox provider runs this below PID 1.
    container.command = ["/usr/bin/tini", "-s", "--", "node", "-e"];
    container.args = [AGENT_WITH_NODE_ENTRYPOINT];
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
      this.pluginRuntimeOwnership(revision),
    );
    const deviceId = Buffer.from(secret?.data?.deviceId ?? "", "base64").toString("utf8");
    return deviceId || undefined;
  }

  private async workspaceNodeReady(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
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
      this.pluginRuntimeOwnership(revision),
    );
    if (secret === undefined) {
      return false;
    }
    const read = (key: string) => Buffer.from(secret.data?.[key] ?? "", "base64").toString("utf8");
    const deviceId = read("deviceId");
    if (deviceId) {
      return enrollment.isConnected(url, deviceId, this.operationSignal());
    }
    const setupId = required(read("setupId"), "Workspace node setup ID");
    const observation = await enrollment.observeSetup(url, setupId, this.operationSignal());
    if (observation === undefined) {
      // TODO(workspace-node-enrollment): renew an unredeemed expired setup and
      // reconcile a completion missed beyond native status retention before
      // enabling this path in published runtime images.
      if (Number(read("expiresAtMs")) <= Date.now()) {
        throw new Error("Workspace node setup expired before its identity was recorded.");
      }
      return false;
    }
    required(secret.metadata.resourceVersion, "Workspace node Secret resource version");
    const clients = await this.clients(namespace.plane);
    await this.request(
      () =>
        clients.core.replaceNamespacedSecret({
          name,
          namespace: namespace.name,
          body: {
            apiVersion: "v1",
            kind: "Secret",
            metadata: secret.metadata,
            type: "Opaque",
            data: {
              ...secret.data,
              deviceId: Buffer.from(observation.deviceId, "utf8").toString("base64"),
            },
          },
        }),
      { mutating: true },
    );
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
    const expected = this.harnessWorkspaceVolumeMounts();
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
          "Harness node state must preserve its revision directory on the Harness claim.",
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

  private async gatewayReady(
    ownership: Ownership,
    gatewayName: string,
    namespace: KubernetesNamespaceAddress,
  ): Promise<boolean> {
    const clients = await this.clients(namespace.plane);
    const deployment = await this.getOwned("Deployment", gatewayName, namespace, ownership);
    if (deployment === undefined) {
      return false;
    }
    if (deployment.spec?.replicas !== 1) {
      return false;
    }
    if (!this.deploymentReady(deployment)) {
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
  ): ManagedKubernetesObject[] {
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
        podSelector: { matchLabels: { "openclaw.dev/workload-role": "agent" } },
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

  private gatewayRouteHeaderFilter(access: "operator" | "node"): KubernetesRecord {
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
          "authorization",
          "cookie",
          "forwarded",
          "x-forwarded-for",
          "x-openclaw-scopes",
          ...(access === "node"
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
          {
            apiVersion: "networking.k8s.io/v1",
            kind: "NetworkPolicy",
            metadata: { ...publicRoute.metadata },
            spec: {
              podSelector: {
                matchLabels: {
                  "openclaw.dev/agent": revision.agentId,
                  "openclaw.dev/workload-role": "gateway",
                },
              },
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
          },
          ownership,
          namespace,
        );
      }
      await this.reconcile(policy, ownership, namespace);
      await this.reconcile(publicRoute, ownership, namespace);
    }
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
    // Keep existing Agent workspace data on its original RWX claim. Never patch
    // an immutable PVC access mode or broaden Gateway private-state acceptance.
    const agentId = desired.metadata.annotations?.["openclaw.dev/agent-id"];
    const existingWorkspace =
      agentId !== undefined &&
      desired.metadata.name === this.harnessWorkspaceClaimName(agentId) &&
      accessModes.length === 1 &&
      accessModes[0] === "ReadWriteMany";
    if (
      claim.metadata.deletionTimestamp !== undefined ||
      (!existingWorkspace &&
        (accessModes.length !== expectedModes.length ||
          accessModes.some((mode, index) => mode !== expectedModes[index]))) ||
      requests?.storage !== expectedRequests?.storage ||
      (claim.spec?.volumeMode ?? "Filesystem") !== (desired.spec?.volumeMode ?? "Filesystem") ||
      (desired.spec?.storageClassName !== undefined &&
        claim.spec?.storageClassName !== desired.spec.storageClassName)
    ) {
      throw new OwnershipFailure(`Refusing invalid PersistentVolumeClaim ${claim.metadata.name}.`);
    }
  }

  private harnessWorkspaceVolumeMounts(): V1VolumeMount[] {
    return HARNESS_WORKSPACE_CATEGORIES.map(([subPath, mountPath]) => ({
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
      ...new Set(paths.map((mountPath) => mountPath.slice(0, mountPath.lastIndexOf("/")))),
    ].filter((directory) => directory !== "/home/node");
  }

  private privateStateInitContainer(
    role: WorkspaceRole,
    image: string,
    embedded: boolean,
    writableConfiguration = false,
  ): KubernetesRecord {
    const directories = this.privateStateDirectories(role);
    const volumeMounts: V1VolumeMount[] = [
      { name: "runtime-state", mountPath: "/home/node" },
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
        "/home/node/gateway-codex-home",
      );
      directories.push(embedded ? "/gateway-state/workspace" : "/gateway-state/sessions");
    }
    const script = [
      writableConfiguration
        ? 'const { chmodSync, copyFileSync, mkdirSync } = require("node:fs");'
        : 'const { mkdirSync } = require("node:fs");',
      `for (const path of ${JSON.stringify(directories)}) {`,
      "  mkdirSync(path, { recursive: true });",
      "}",
      // The emptyDir root is group-writable under fsGroup, without /tmp's sticky
      // bit. Mount a private child so native safe-temp admission needs no privilege.
      'mkdirSync("/runtime-temporary/tmp", { recursive: true, mode: 0o700 });',
      ...(writableConfiguration
        ? [
            `copyFileSync(${JSON.stringify(
              `${MANAGED_CONFIGURATION_DIRECTORY}/${CONFIGURATION_DOCUMENT}`,
            )}, ${JSON.stringify(WRITABLE_CONFIGURATION_PATH)});`,
            `chmodSync(${JSON.stringify(WRITABLE_CONFIGURATION_PATH)}, 0o600);`,
          ]
        : []),
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

  private agentServiceSelector(
    revision: AgentRevision,
    workloadName?: string,
  ): Record<string, string> {
    return {
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

  private pluginStatusNetworkPolicies(
    revision: AgentRevision,
    namespace: KubernetesNamespaceAddress,
  ): TargetedKubernetesResource[] {
    const gatewayNamespace = this.gatewayNamespace(revision, namespace);
    const suffix = sha256Hex(revision.agentId, 12);
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const agent = {
      matchLabels: {
        "openclaw.dev/namespace": revision.namespaceId,
        "openclaw.dev/workload-role": "agent",
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
      },
    };
    const gateway = {
      matchLabels: {
        "openclaw.dev/namespace": revision.namespaceId,
        "openclaw.dev/workload-role": "gateway",
        "openclaw.dev/agent": revision.agentId,
      },
    };
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
              podSelector: {
                matchLabels: {
                  "openclaw.dev/agent": revision.agentId,
                  "openclaw.dev/revision": revision.id,
                },
              },
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
  ): TargetedKubernetesResource[] {
    const gatewayNamespace = this.gatewayNamespace(revision, namespace);
    const suffix = sha256Hex(revision.agentId, 12);
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const agent = {
      matchLabels: {
        "openclaw.dev/namespace": revision.namespaceId,
        "openclaw.dev/workload-role": "agent",
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
      },
    };
    const gateway = {
      matchLabels: {
        "openclaw.dev/namespace": revision.namespaceId,
        "openclaw.dev/workload-role": "gateway",
        "openclaw.dev/agent": revision.agentId,
      },
    };
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
    const statusPolicies = this.pluginStatusNetworkPolicies(revision, namespace);
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
              except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"],
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
        policyTypes: ["Ingress", "Egress"],
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
        egress: [...modelEgress, ...repositoryEgress],
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
    if (auth.method === "api_key" || auth.method === "codex_pat") {
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
        ...(revision.harness.mode === "embedded"
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

  private async deliverHarnessAuth(
    revision: AgentRevision,
    context: ComputeRevisionContext | undefined,
    prepared: PreparedHarnessAuth,
    namespace: KubernetesNamespaceAddress,
  ): Promise<PreparedHarnessAuth> {
    const sourceNamespace = this.controlNamespace(revision.namespaceId);
    const sources: SecretEnvironmentProjection[] = [];
    const auth = context?.harnessAuth;
    if (auth === undefined) {
      throw new ConfigurationFailure("Resolved Harness authentication is required.");
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
      this.requireCompleteRuntimeCredentialSecret(source, {
        name,
        keys: [AGENT_TRANSPORT_TOKEN_KEY],
      });
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
    // Dedicated Gateways consume the canonical control-plane sources directly.
    if (gatewayNamespace !== harnessNamespace) {
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
      const sourceNamespace = this.controlNamespace(revision.namespaceId);
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
      if (configuration.workspaceNodeId !== undefined) {
        variables.push({
          name: "OPENCLAW_WORKSPACE_NODE_ID",
          value: configuration.workspaceNodeId,
        });
      }
    }
    const needsPluginRuntime =
      pluginRuntime !== undefined &&
      ((pluginRuntime.runtime.kind === "openclaw" && role === "gateway" && embedded) ||
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
        { name: "runtime-temporary", mountPath: "/tmp", subPath: "tmp" },
      );
    }
    if (dedicated && role === "agent") {
      const agentId = required(ownership.agentId, "Harness workspace Agent ID");
      volumes.push({
        name: HARNESS_WORKSPACE_VOLUME,
        persistentVolumeClaim: { claimName: this.harnessWorkspaceClaimName(agentId) },
      });
      volumeMounts.push(...this.harnessWorkspaceVolumeMounts());
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
        subPath: "gateway-codex-home",
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
                : dedicated && key === GATEWAY_PASSWORD_KEY
                  ? `gateway-password-${suffix}`
                  : `${prefix}-${suffix}`,
            key,
          },
        },
      });
      if (!embedded) {
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
        } else {
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
          { name: "CODEX_HOME", value: "/home/node/.codex" },
          { name: "HOME", value: "/home/node" },
          {
            name: "PATH",
            value: `${repositoryMaterial === undefined ? "" : `${REPOSITORY_CLIENT_BIN}:`}/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
          },
          { name: "APP_SERVER_PORT", value: String(AGENT_TRANSPORT_PORT) },
        );
      }
    }
    if (role === "agent" || embedded) {
      if (harnessAuth === undefined) {
        throw new ConfigurationFailure("Harness authentication preparation is missing.");
      }
      variables.push(...harnessAuth.environment);
    }
    if (role === "agent" && repositoryMaterial !== undefined) {
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
        command: ["node", "-e"],
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
                            : AGENT_RUNTIME_ENTRYPOINT),
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
