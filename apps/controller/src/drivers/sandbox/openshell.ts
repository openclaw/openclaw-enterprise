import { asRecord, isNonEmptyString, sha256Hex } from "@openclaw-enterprise/utils";
import { KubernetesObjectApi, type KubernetesObject, PatchStrategy } from "@kubernetes/client-node";
import {
  RuntimeLogsForbiddenByClusterError,
  RuntimeLogsSandboxNotFoundError,
  SandboxRevisionUnsupportedError,
} from "@openclaw-enterprise/occ";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentRevision,
  Backend,
  HarnessWorkloadRequirements,
  KubernetesNamespacedResource,
  Namespace,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  SandboxDriver,
  SandboxHarnessEndpoint,
  SandboxHarnessContext,
  SandboxHarnessStatus,
  SandboxHarnessStatusContext,
  SandboxLogChunk,
  SandboxLogContext,
  SandboxLogRequest,
  SandboxNamespaceContext,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import {
  isOpenShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
} from "../../backends/openshell.ts";
import {
  openShellSandboxLogReader,
  type OpenShellGatewayClient,
  type OpenShellProviderProfile,
  type OpenShellProviderResponse,
  type OpenShellStoredProviderProfile,
  type OpenShellSandboxCreateRequest,
  type OpenShellSandboxResponse,
  type OpenShellWorkspaceResponse,
  OpenShellRequestReplayRefusedError,
  OpenShellProviderAlreadyExistsError,
  OpenShellSandboxAlreadyExistsError,
  OpenShellWorkspaceAlreadyExistsError,
  toProtobufStruct,
} from "./openshell-gateway-client.ts";
import { RUNTIME_WRAPPER_COMMAND } from "../compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../compute/node-program.ts";

type ConfigurationRecord = Readonly<Record<string, unknown>>;

export interface OpenShellKubernetesNetworkPeer {
  readonly namespaceName: string;
  readonly podLabels: Readonly<Record<string, string>>;
}

export interface OpenShellNetworkEndpoint {
  readonly host: string;
  readonly ports: readonly number[];
  readonly protocol?: string;
  readonly tls?: "skip" | "terminate";
  readonly enforcement?: "enforce" | "audit";
  readonly access?: "read_only" | "read_write" | "full";
}

export interface OpenShellNetworkPolicyRule {
  readonly name: string;
  readonly endpoints: readonly OpenShellNetworkEndpoint[];
  readonly binaries: readonly OpenShellNetworkBinary[];
}

export interface OpenShellNetworkBinary {
  readonly path: string;
}

export interface OpenShellSandboxDriverOptions {
  /** Workspace and readiness policy; the `openshell` Backend owns the gateway connection. */
  readonly gateway: {
    readonly workspaceMode: "managed" | "operator";
    readonly operatorNamespaceLabels?: Readonly<Record<string, string>>;
    readonly readiness?: {
      readonly serviceName: string;
      readonly podSelector: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
      readonly pollIntervalMs?: number;
    };
    readonly operatorWorkspaceResources?: readonly KubernetesNamespacedResource[];
    readonly networkPolicyResources?: readonly KubernetesNamespacedResource[];
  };
  readonly kubernetes: {
    readonly runtimeClassName: string;
    readonly serviceAccount: { readonly mode: "gatewayConfigured" };
    readonly sandboxDataMount: {
      readonly claimName?: string;
      readonly subPath: string;
      readonly mountPath: string;
      readonly readOnly: boolean;
    };
    readonly agentResources?: ConfigurationRecord;
    readonly userNamespaces?: boolean;
  };
  readonly policy: {
    readonly filesystem?: {
      readonly includeWorkdir?: boolean;
      readonly readOnly?: readonly string[];
      readonly readWrite?: readonly string[];
    };
    readonly landlockCompatibility?: "hard_requirement";
    readonly process: {
      readonly runAsUser: string;
      readonly runAsGroup: string;
    };
    readonly networkPolicies: readonly OpenShellNetworkPolicyRule[];
  };
  readonly sandboxNamePrefix?: string;
  readonly startupDelayMs?: number;
  readonly logLevel?: string;
  readonly providers?: readonly string[];
}

export interface OpenShellSandboxDriverSelection {
  readonly id?: string;
  readonly implementation?: string;
  readonly backend: Backend<OpenShellGateway>;
}

class OpenShellSandboxConfigurationFailure extends Error {}

const GRPC_NOT_FOUND = 5;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_UNAUTHENTICATED = 16;

const NETWORK_TLS_MODES = Object.freeze({
  skip: "NETWORK_TLS_MODE_SKIP",
  terminate: "NETWORK_TLS_MODE_TERMINATE",
});
const NETWORK_ENFORCEMENT_MODES = Object.freeze({
  enforce: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
  audit: "NETWORK_ENFORCEMENT_MODE_AUDIT",
});
const NETWORK_ACCESS_PRESETS = Object.freeze({
  read_only: "NETWORK_ACCESS_PRESET_READ_ONLY",
  read_write: "NETWORK_ACCESS_PRESET_READ_WRITE",
  full: "NETWORK_ACCESS_PRESET_FULL",
});

function optionalEnumValue(
  value: unknown,
  values: Readonly<Record<string, string>>,
  description: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const key = nonempty(value, description);
  if (!Object.hasOwn(values, key)) {
    throw new OpenShellSandboxConfigurationFailure(
      `${description} must be one of: ${Object.keys(values).join(", ")}.`,
    );
  }
  return values[key];
}

const DEFAULT_SANDBOX_NAME_PREFIX = "sb";
const OPENSHELL_MAX_SANDBOX_NAME_LENGTH = 19;
const OPENSHELL_MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const OPENSHELL_NAMESPACE_LABEL = "openclaw.dev/namespace";
const OPENSHELL_NAMESPACE_ID_LABEL = "openclaw.dev/namespace-id";
const OPENSHELL_MANAGED_BY = "openclaw-enterprise";
const OPENSHELL_RUNTIME_ROOT = "/sandbox/.openclaw-runtime";
const OPENSHELL_HOME = `${OPENSHELL_RUNTIME_ROOT}/home`;
const OPENSHELL_WORKSPACE_MOUNTS = "/sandbox/.openclaw-mounts";
const OPENSHELL_WORKSPACE_STATE_DIRECTORY = "state";
// OpenShell probes TMPDIR before the Harness entrypoint can create a nested directory.
const OPENSHELL_TEMPORARY = "/tmp";
/**
 * The Codex app-server policy every OpenShell dedicated Codex revision freezes. OpenShell is
 * the outer containment boundary, and Codex's own sandbox (bwrap) cannot create a user
 * namespace inside it, so every command would fail. The pinned OpenClaw Gateway sends each
 * turn `workspace-write`, whatever `sandbox` says, when it forces a user reviewer: guardian
 * mode without an explicit `user` reviewer, or an explicit model-backed reviewer, on a model
 * it cannot verify for model-backed review (the documented `codex/<model>` Configuration is
 * one). An explicit `user` reviewer keeps the configured sandbox, and approvals still go to a
 * person. OpenClaw `tools.exec` settings other than the default or `mode: full` still make
 * every command fail (Codex's own sandbox, or a refusal).
 * Source: `extensions/codex/src/app-server/config-options.ts` at the `OPENCLAW_COMMIT` in
 * `deploy/runtime/Dockerfile`; recheck when that pin changes.
 */
export const OPENSHELL_CODEX_APP_SERVER_POLICY = Object.freeze({
  sandbox: "danger-full-access",
  approvalsReviewer: "user",
} as const);
const OPENSHELL_DEFAULT_READ_ONLY_PATHS = Object.freeze([
  "/bin",
  "/usr",
  "/lib",
  "/proc",
  "/dev/urandom",
  "/etc",
  "/var/log",
  "/app",
]);
const OPENSHELL_DEFAULT_READ_WRITE_PATHS = Object.freeze(["/tmp", "/dev/null"]);
const APP_SERVER_PORT_ENVIRONMENT = "APP_SERVER_PORT";
const APP_TOKEN_SHA_ENVIRONMENT = "APP_TOKEN_SHA";
const PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT = "OPENCLAW_PLUGIN_RUNTIME_MANIFEST";
const PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT = "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML";
const WORKSPACE_NODE_SETUP_ENVIRONMENT = "OPENCLAW_NODE_SETUP_CODE";
const WORKSPACE_NODE_ENVELOPE_ENVIRONMENT = "OPENCLAW_NODE_SETUP_ENVELOPE";
const WORKSPACE_NODE_ENVELOPE_FILE = "node-setup.json";
const WORKSPACE_NODE_SETUP_CONFIG = "node_setup_json";
const WORKSPACE_NODE_CA_ENVIRONMENT = "OPENCLAW_NODE_CA_PEM";
const WORKSPACE_NODE_CA_PATH_ENVIRONMENT = "OPENCLAW_NODE_CA_PATH";
const WORKSPACE_NODE_CA_FILE = "node-ca.pem";
const WORKSPACE_NODE_BINARY = "/usr/local/bin/node";
const RUNTIME_PROFILE_ID = "oce-codex-runtime";
const RUNTIME_PROFILE_MANAGED_ANNOTATION = "openclaw.dev/managed-by";
const RUNTIME_PROFILE_MANAGED_VALUE_PREFIX = `${OPENSHELL_MANAGED_BY}:`;
const RUNTIME_PROVIDER_AGENT_LABEL = "openclaw.dev/agent-id";
const RUNTIME_PROVIDER_REVISION_LABEL = "openclaw.dev/revision-id";
const MAX_PROVIDER_FILE_BYTES = 65_536;
const MAX_PROVIDER_FILES_BYTES = 262_144;
const MAX_SANDBOX_STARTUP_DELAY_MS = 120_000;
const OPERATOR_WORKSPACE_RESOURCE_VERSIONS = Object.freeze({
  ServiceAccount: "v1",
  Role: "rbac.authorization.k8s.io/v1",
  RoleBinding: "rbac.authorization.k8s.io/v1",
  NetworkPolicy: "networking.k8s.io/v1",
});

function nonempty(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new OpenShellSandboxConfigurationFailure(`${description} must be a nonempty string.`);
  }
  return value;
}

function configurationObject(value: unknown, description: string): ConfigurationRecord {
  const object = asRecord(value);
  if (object === undefined) {
    throw new OpenShellSandboxConfigurationFailure(`${description} must be an object.`);
  }
  return object;
}

function optionalAgentConfiguration(
  value: OpenClawConfigurationValue | undefined,
  description: string,
): Readonly<Record<string, OpenClawConfigurationValue>> {
  return value === undefined
    ? {}
    : (configurationObject(value, description) as Readonly<
        Record<string, OpenClawConfigurationValue>
      >);
}

/** OpenClaw resolves entry keys case-insensitively, so `Main` also names the main Agent. */
function pinMainAgentWorkspace(
  value: OpenClawConfigurationValue,
  workspace: string,
): Readonly<Record<string, OpenClawConfigurationValue>> {
  const entries = optionalAgentConfiguration(value, "OpenShell Agent entries");
  return Object.fromEntries(
    Object.entries(entries).map(([id, entry]) =>
      id.toLowerCase() === "main"
        ? [
            id,
            {
              ...optionalAgentConfiguration(entry, "OpenShell main Agent entry"),
              workspace,
            },
          ]
        : [id, entry],
    ),
  );
}

function labels(value: Readonly<Record<string, string>>, description: string): void {
  if (asRecord(value) === undefined || Object.keys(value).length === 0) {
    throw new OpenShellSandboxConfigurationFailure(
      `${description} must contain at least one label.`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    nonempty(key, `${description} key`);
    nonempty(entry, `${description}.${key}`);
  }
}

function port(value: unknown, description: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new OpenShellSandboxConfigurationFailure(`${description} must be a valid TCP port.`);
  }
  return Number(value);
}

function validateKubernetesResource(value: unknown, path: string): void {
  const resource = asRecord(value);
  const metadata = asRecord(resource?.metadata);
  if (
    resource === undefined ||
    typeof resource.apiVersion !== "string" ||
    typeof resource.kind !== "string" ||
    metadata === undefined ||
    typeof metadata.name !== "string" ||
    metadata.name.trim().length === 0
  ) {
    throw new OpenShellSandboxConfigurationFailure(`${path} must be a Kubernetes resource object.`);
  }
  if (resource.kind === "Secret") {
    throw new OpenShellSandboxConfigurationFailure(
      `${path} must not contain OpenShell credential-bearing Secrets.`,
    );
  }
}

function validateOperatorWorkspaceResource(value: unknown, path: string): void {
  validateKubernetesResource(value, path);
  const resource = value as KubernetesNamespacedResource;
  const expected =
    OPERATOR_WORKSPACE_RESOURCE_VERSIONS[
      resource.kind as keyof typeof OPERATOR_WORKSPACE_RESOURCE_VERSIONS
    ];
  if (expected === undefined || resource.apiVersion !== expected) {
    throw new OpenShellSandboxConfigurationFailure(
      `${path} must be a workspace-chart ServiceAccount, Role, RoleBinding, or NetworkPolicy.`,
    );
  }
}

function validateWorkspaceMount(mount: {
  readonly claimName: string;
  readonly subPath: string;
  readonly mountPath: string;
  readonly readOnly: boolean;
}): void {
  nonempty(mount.claimName, "Workspace mount claimName");
  const subPath = nonempty(mount.subPath, "Workspace mount subPath");
  if (subPath === "/" || subPath.startsWith("/") || subPath.includes("..")) {
    throw new OpenShellSandboxConfigurationFailure("Workspace mounts must use exact PVC subpaths.");
  }
  const mountPath = nonempty(mount.mountPath, "Workspace mount path");
  if (!mountPath.startsWith("/")) {
    throw new OpenShellSandboxConfigurationFailure("Workspace mount path must be absolute.");
  }
  if (typeof mount.readOnly !== "boolean") {
    throw new OpenShellSandboxConfigurationFailure("Workspace mount readOnly must be explicit.");
  }
}

function validateSandboxDataMount(mount: {
  readonly claimName?: string;
  readonly subPath: string;
  readonly mountPath: string;
  readonly readOnly: boolean;
}): void {
  if (mount.claimName !== undefined) {
    nonempty(mount.claimName, "OpenShell sandboxDataMount claimName");
  }
  const subPath = nonempty(mount.subPath, "OpenShell sandboxDataMount subPath");
  if (subPath === "." || subPath === "/" || subPath.startsWith("/") || subPath.includes("..")) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must use an exact PVC subpath.",
    );
  }
  const mountPath = nonempty(mount.mountPath, "OpenShell sandboxDataMount mountPath");
  if (!mountPath.startsWith("/sandbox/")) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must mount an approved PVC subpath under /sandbox.",
    );
  }
  if (typeof mount.readOnly !== "boolean") {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount readOnly must be explicit.",
    );
  }
}

function environment(
  requirements: HarnessWorkloadRequirements,
  providerEnvironment: ReadonlySet<string> = new Set(),
  workspacePath = "/sandbox/enterprise",
  workspaceMountPaths: ReadonlyMap<string, string> = new Map(),
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of requirements.environment) {
    if (providerEnvironment.has(entry.name)) {
      continue;
    }
    if ("valueFrom" in entry) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
        `OpenShell v0.1.3-pre.2 cannot receive secretKeyRef environment ${entry.name}; upstream Secret projection support is required.`,
      );
    }
    result[nonempty(entry.name, "Environment variable name")] =
      workspaceMountPaths.get(entry.value) ?? entry.value.replaceAll("/home/node", OPENSHELL_HOME);
  }
  result.HOME = OPENSHELL_HOME;
  result.TMPDIR = OPENSHELL_TEMPORARY;
  result.OPENCLAW_WORKSPACE_DIR = workspacePath;
  return result;
}

// Served by a Codex Harness wrapper that holds a startup failure (runtime-entrypoints.ts).
const HARNESS_RUNTIME_STATUS_PATH = "/openclaw/runtime/status";

function harnessPort(requirements: HarnessWorkloadRequirements): number {
  const entry = requirements.environment.find(
    (candidate) => candidate.name === APP_SERVER_PORT_ENVIRONMENT,
  );
  if (entry === undefined || "valueFrom" in entry) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell requires a literal APP_SERVER_PORT for create-time service exposure.",
    );
  }
  return port(Number(entry.value), "OpenShell APP_SERVER_PORT");
}

// A Sandbox in one of these phases never serves the revision again.
const STOPPED_SANDBOX_PHASES: ReadonlySet<string | number> = new Set([
  "SANDBOX_PHASE_STOPPING",
  "SANDBOX_PHASE_STOPPED",
  "SANDBOX_PHASE_COMPLETED",
  6,
  7,
  9,
]);

// OpenShell keeps a request_id whose create errored server-side unresolved forever, so a
// revision's create moves to its next request_id once the gateway refuses the current one
// and no Sandbox exists. The gateway's own admission records are the attempt counter, and
// the bound caps the records one revision can leave unresolved.
const MAX_CREATE_REQUEST_IDS = 16;

function revisionUuid(revisionId: string): string {
  const match = /^rev_([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/.exec(revisionId);
  if (match === null) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell requires an Agent revision ID containing a stable UUID.",
    );
  }
  return match[1]!;
}

function codexTransportVerifier(requirements: HarnessWorkloadRequirements): void {
  const verifier = requirements.environment.filter(
    (entry) => entry.name === APP_TOKEN_SHA_ENVIRONMENT,
  );
  if (
    verifier.length !== 1 ||
    "valueFrom" in verifier[0]! ||
    !/^[a-f0-9]{64}$/.test(verifier[0]!.value)
  ) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
      "OpenShell dedicated Codex requires one literal APP_TOKEN_SHA verifier.",
    );
  }
  if (requirements.environment.some((entry) => entry.name === "APP_SERVER_TOKEN")) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
      "OpenShell dedicated Codex cannot receive APP_SERVER_TOKEN.",
    );
  }
}

interface CodexRuntimeFiles {
  readonly config: Readonly<Record<string, string>>;
  readonly profile: OpenShellProviderProfile;
}

function codexRuntimeFiles(requirements: HarnessWorkloadRequirements): CodexRuntimeFiles {
  const expected = new Map([
    ["runtime.json", PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT],
    ["config.toml", PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT],
  ]);
  const files = requirements.files ?? [];
  if (
    files.length !== expected.size ||
    files.some(
      (file) =>
        expected.get(file.name) !== file.environmentVariable ||
        !isNonEmptyString(file.content) ||
        Buffer.byteLength(file.content, "utf8") > MAX_PROVIDER_FILE_BYTES,
    ) ||
    files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0) >
      MAX_PROVIDER_FILES_BYTES
  ) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "OpenShell dedicated Codex requires its exact bounded plugin-runtime files.",
    );
  }
  const runtime = files.find((file) => file.name === "runtime.json")!;
  let manifest: ConfigurationRecord;
  try {
    manifest = configurationObject(JSON.parse(runtime.content), "Codex plugin-runtime manifest");
  } catch {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "OpenShell dedicated Codex requires a valid plugin-runtime manifest.",
    );
  }
  const selections = configurationObject(manifest.selections, "Codex plugin-runtime selections");
  if (
    manifest.kind !== "codex" ||
    Object.keys(selections).length !== 0 ||
    manifest.repositoryBrokerNetworkPolicy !== undefined
  ) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "OpenShell dedicated Codex does not yet support selected plugins or repository credentials.",
    );
  }
  const nodeCaEntries = requirements.environment.filter(
    (entry) => entry.name === WORKSPACE_NODE_CA_ENVIRONMENT,
  );
  if (
    nodeCaEntries.length > 1 ||
    nodeCaEntries.some(
      (entry) =>
        "valueFrom" in entry || Buffer.byteLength(entry.value, "utf8") > MAX_PROVIDER_FILE_BYTES,
    )
  ) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "OpenShell dedicated Codex requires at most one bounded literal workspace-node CA bundle.",
    );
  }
  const nodeCa = nodeCaEntries[0];
  const config = Object.freeze({
    ...Object.fromEntries(
      files.map((file) => [
        file.name === "runtime.json" ? "runtime_json" : "config_toml",
        file.content,
      ]),
    ),
    [WORKSPACE_NODE_SETUP_CONFIG]: "{}",
    node_ca_pem: nodeCa === undefined || "valueFrom" in nodeCa ? "" : nodeCa.value,
  });
  const profileBase: Omit<OpenShellProviderProfile, "annotations"> = {
    id: RUNTIME_PROFILE_ID,
    displayName: "Codex runtime files (OpenClaw Enterprise)",
    category: "PROVIDER_PROFILE_CATEGORY_OTHER",
    credentials: [],
    files: [
      ...files.map((file) => ({
        path: file.name,
        content: `{{config.${file.name === "runtime.json" ? "runtime_json" : "config_toml"}}}`,
        environmentVariable: file.environmentVariable,
      })),
      {
        path: WORKSPACE_NODE_ENVELOPE_FILE,
        content: "{{config.node_setup_json}}",
        environmentVariable: WORKSPACE_NODE_ENVELOPE_ENVIRONMENT,
      },
      {
        path: WORKSPACE_NODE_CA_FILE,
        content: "{{config.node_ca_pem}}",
        environmentVariable: WORKSPACE_NODE_CA_PATH_ENVIRONMENT,
      },
    ],
    endpoints: [],
    binaries: [],
    inferenceCapable: false,
  };
  return {
    config,
    profile: {
      ...profileBase,
      annotations: {
        // TODO(openshell-stable-profile-hash): Separate ownership and digest after the
        // pinned OpenShell release canonicalizes protobuf map fields before hashing them.
        [RUNTIME_PROFILE_MANAGED_ANNOTATION]:
          RUNTIME_PROFILE_MANAGED_VALUE_PREFIX + sha256Hex(JSON.stringify(profileBase)),
      },
    },
  };
}

function isManagedRuntimeProfile(profile: OpenShellStoredProviderProfile): boolean {
  return (
    profile.annotations[RUNTIME_PROFILE_MANAGED_ANNOTATION]?.startsWith(
      RUNTIME_PROFILE_MANAGED_VALUE_PREFIX,
    ) ?? false
  );
}

interface WorkspaceNodeBinding {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly tls: boolean;
}

interface CodexRuntimeCredentialMaterial {
  readonly credentials: Readonly<Record<string, string>>;
  readonly credentialExpirationTimes: Readonly<Record<string, string>>;
  readonly config: Readonly<Record<string, string>>;
  readonly binding?: WorkspaceNodeBinding;
}

async function codexRuntimeCredentials(
  context: SandboxHarnessContext,
): Promise<CodexRuntimeCredentialMaterial> {
  const projected = context.requirements.environment.filter((entry) => "valueFrom" in entry);
  if (projected.length === 0) {
    return { credentials: {}, credentialExpirationTimes: {}, config: {} };
  }
  if (projected.length !== 1 || projected[0]!.name !== WORKSPACE_NODE_SETUP_ENVIRONMENT) {
    const unsupported = projected.find((entry) => entry.name !== WORKSPACE_NODE_SETUP_ENVIRONMENT);
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
      `OpenShell cannot receive secretKeyRef environment ${unsupported?.name ?? "unknown"}.`,
    );
  }
  const reference = projected[0]!.valueFrom.secretKeyRef;
  const secret = await kubernetes(context).read({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      namespace: namespaceName(context.namespace),
      name: nonempty(reference.name, "Workspace node setup Secret name"),
    },
  });
  const metadata = asRecord(secret?.metadata);
  const secretLabels = asRecord(metadata?.labels);
  if (
    secret === undefined ||
    metadata?.namespace !== namespaceName(context.namespace) ||
    secretLabels?.[OPENSHELL_NAMESPACE_LABEL] !== context.revision.namespaceId ||
    secretLabels?.["openclaw.dev/agent"] !== context.revision.agentId
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "Refusing a workspace node setup Secret without exact Agent ownership.",
    );
  }
  const encoded = asRecord(asRecord(secret)?.data)?.[
    nonempty(reference.key, "Workspace node setup Secret key")
  ];
  if (typeof encoded !== "string") {
    throw new OpenShellSandboxConfigurationFailure(
      "The workspace node setup Secret has no projected value.",
    );
  }
  const value = Buffer.from(encoded, "base64").toString("utf8").trim();
  if (
    !isNonEmptyString(value) ||
    value.length > 65_536 ||
    Buffer.from(value, "utf8").toString("base64").replace(/=+$/u, "") !==
      encoded.replace(/=+$/u, "")
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "The workspace node setup Secret contains invalid material.",
    );
  }
  const setupCode = value.toLowerCase().startsWith("oc-pair://")
    ? value.slice("oc-pair://".length)
    : value;
  if (!/^[A-Za-z0-9_-]+$/u.test(setupCode)) {
    throw new OpenShellSandboxConfigurationFailure(
      "The workspace node setup Secret does not contain a base64url setup code.",
    );
  }
  let payload: ConfigurationRecord;
  try {
    payload = configurationObject(
      JSON.parse(Buffer.from(setupCode, "base64url").toString("utf8")),
      "Workspace node setup envelope",
    );
  } catch {
    throw new OpenShellSandboxConfigurationFailure(
      "The workspace node setup Secret contains a malformed setup envelope.",
    );
  }
  const allowed = new Set(["url", "bootstrapToken", "expiresAtMs", "tlsFingerprint"]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) {
    throw new OpenShellSandboxConfigurationFailure(
      "The workspace node setup envelope contains unsupported fields.",
    );
  }
  const bootstrapToken = nonempty(payload.bootstrapToken, "Workspace node setup bootstrap token");
  const expiresAtMs = payload.expiresAtMs;
  if (
    typeof expiresAtMs !== "number" ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= Date.now()
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "The workspace node setup envelope is expired or has no bounded expiry.",
    );
  }
  if (
    payload.tlsFingerprint !== undefined &&
    (typeof payload.tlsFingerprint !== "string" || payload.tlsFingerprint.length === 0)
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "The workspace node setup TLS fingerprint is invalid.",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(nonempty(payload.url, "Workspace node setup URL"));
  } catch {
    throw new OpenShellSandboxConfigurationFailure("The workspace node setup URL is invalid.");
  }
  if (
    (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    endpoint.search !== ""
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "The workspace node setup URL must be an exact ws or wss endpoint without credentials, query, or fragment.",
    );
  }
  // TODO(openshell-workspace-node-proof-binding): Return the bootstrap token to
  // OpenShell credential storage after OpenClaw can sign a stable public binding
  // instead of the token value that OpenShell rewrites on the WebSocket.
  const setupEnvelope = {
    url: endpoint.href,
    bootstrapToken,
    expiresAtMs,
    ...(payload.tlsFingerprint === undefined ? {} : { tlsFingerprint: payload.tlsFingerprint }),
  };
  return Object.freeze({
    credentials: Object.freeze({}),
    credentialExpirationTimes: Object.freeze({}),
    config: Object.freeze({ [WORKSPACE_NODE_SETUP_CONFIG]: JSON.stringify(setupEnvelope) }),
    binding: Object.freeze({
      host: endpoint.hostname,
      port:
        endpoint.port === "" ? (endpoint.protocol === "wss:" ? 443 : 80) : Number(endpoint.port),
      path: endpoint.pathname === "" ? "/" : endpoint.pathname,
      tls: endpoint.protocol === "wss:",
    }),
  });
}

/** Attempt 0 is the revision UUID; later attempts are stable RFC 9562 version-8 UUIDs. */
function createRequestIds(revisionId: string): readonly string[] {
  const uuid = revisionUuid(revisionId);
  return Array.from({ length: MAX_CREATE_REQUEST_IDS }, (_, attempt) => {
    if (attempt === 0) {
      return uuid;
    }
    const hex = sha256Hex(`openclaw.dev/openshell-create-sandbox/v1\0${uuid}\0${attempt}`, 32);
    const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
  });
}

function validateHarnessServiceUrl(value: unknown): void {
  const endpoint = nonempty(value, "OpenShell Harness service URL");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell returned an invalid Harness service URL.",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell Harness service URL must be an HTTP origin without credentials, query, or fragment.",
    );
  }
}

function harnessWebSocketUrl(value: unknown): string {
  validateHarnessServiceUrl(value);
  const endpoint = new URL(value as string);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return endpoint.toString();
}

function namespaceName(namespace: Readonly<Namespace>): string {
  return nonempty(namespace.name, "Kubernetes namespace name");
}

function workspaceName(namespace: Readonly<Namespace>): string {
  return openShellWorkspaceName(namespace);
}

function workspaceLabels(namespace: Readonly<Namespace>): Readonly<Record<string, string>> {
  return Object.freeze({
    [OPENSHELL_MANAGED_BY_LABEL]: OPENSHELL_MANAGED_BY,
    [OPENSHELL_NAMESPACE_ID_LABEL]: nonempty(namespace.id, "OCC Namespace ID"),
  });
}

function verifyWorkspaceOwnership(
  workspace: OpenShellWorkspaceResponse,
  namespace: Readonly<Namespace>,
): void {
  const expectedName = workspaceName(namespace);
  const expectedLabels = workspaceLabels(namespace);
  if (
    workspace.name !== expectedName ||
    Object.entries(expectedLabels).some(([key, value]) => workspace.labels[key] !== value)
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      `Refusing OpenShell Workspace ${workspace.name} without exact OCC Namespace ownership.`,
    );
  }
}

function verifyActiveWorkspace(
  workspace: OpenShellWorkspaceResponse,
  namespace: Readonly<Namespace>,
): void {
  verifyWorkspaceOwnership(workspace, namespace);
  if (workspace.phase !== "WORKSPACE_PHASE_ACTIVE" && workspace.phase !== 1) {
    throw new OpenShellSandboxConfigurationFailure(
      `OpenShell Workspace ${workspace.name} is not active.`,
    );
  }
}

function resourceNamespace(resource: KubernetesNamespacedResource): string | undefined {
  const namespace = asRecord(resource.metadata)?.namespace;
  return typeof namespace === "string" && namespace.trim().length > 0 ? namespace : undefined;
}

function resourceReference(resource: KubernetesNamespacedResource, namespace: string) {
  return {
    apiVersion: nonempty(resource.apiVersion, "Kubernetes resource apiVersion"),
    kind: nonempty(resource.kind, "Kubernetes resource kind"),
    metadata: {
      namespace,
      name: nonempty(asRecord(resource.metadata)?.name, "Kubernetes resource name"),
    },
  };
}

function withNamespace(
  resource: KubernetesNamespacedResource,
  context: SandboxNamespaceContext,
): KubernetesObject {
  const namespace = namespaceName(context.namespace);
  const current = resourceNamespace(resource);
  if (current !== undefined && current !== namespace) {
    throw new OpenShellSandboxConfigurationFailure(
      `OpenShell resource ${resource.kind}/${asRecord(resource.metadata)?.name} targets namespace ${current}, not ${namespace}.`,
    );
  }
  const metadata = asRecord(resource.metadata);
  const resourceLabels = asRecord(metadata?.labels);
  const resourceAnnotations = asRecord(metadata?.annotations);
  const namespaceId = context.namespace.id;
  if (
    (resourceLabels?.["openclaw.dev/namespace"] !== undefined &&
      resourceLabels["openclaw.dev/namespace"] !== namespaceId) ||
    (resourceAnnotations?.["openclaw.dev/namespace-id"] !== undefined &&
      resourceAnnotations["openclaw.dev/namespace-id"] !== namespaceId)
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell bootstrap resource belongs to another Namespace.",
    );
  }
  return {
    ...resource,
    apiVersion: nonempty(resource.apiVersion, "Kubernetes resource apiVersion"),
    kind: nonempty(resource.kind, "Kubernetes resource kind"),
    metadata: {
      ...metadata,
      name: nonempty(metadata?.name, "Kubernetes resource name"),
      namespace,
      labels: {
        ...resourceLabels,
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": namespaceId,
      },
      annotations: {
        ...resourceAnnotations,
        "openclaw.dev/namespace-id": namespaceId,
      },
    },
  };
}

function kubernetes(context: SandboxNamespaceContext): KubernetesObjectApi {
  if (!(context.kubernetes instanceof KubernetesObjectApi)) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell requires the Compute Driver's native Kubernetes object client.",
    );
  }
  return context.kubernetes;
}

function missingResource(error: unknown): boolean {
  const observed = asRecord(error);
  const response = asRecord(observed?.response);
  return [observed?.code, observed?.statusCode, response?.statusCode, response?.status].includes(
    404,
  );
}

async function applyResources(
  context: SandboxNamespaceContext,
  resources: readonly KubernetesNamespacedResource[] | undefined,
): Promise<void> {
  for (const resource of resources ?? []) {
    await kubernetes(context).patch(
      withNamespace(resource, context),
      undefined,
      undefined,
      "openclaw-enterprise-sandbox",
      false,
      PatchStrategy.ServerSideApply,
    );
  }
}

async function applyOperatorNamespaceLabels(
  context: SandboxNamespaceContext,
  desired: Readonly<Record<string, string>> | undefined,
): Promise<void> {
  if (desired === undefined) {
    return;
  }
  const name = namespaceName(context.namespace);
  const existing = await kubernetes(context).read({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name },
  });
  if (existing === undefined) {
    throw new OpenShellSandboxConfigurationFailure(
      `OpenShell operator Namespace ${name} is unavailable.`,
    );
  }
  const current = asRecord(existing.metadata?.labels) ?? {};
  for (const [key, value] of Object.entries(desired)) {
    if (current[key] !== undefined && current[key] !== value) {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell operator Namespace label ${key} is owned with another value.`,
      );
    }
  }
  await kubernetes(context).patch(
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name, labels: { ...desired } },
    },
    undefined,
    undefined,
    "openclaw-enterprise-sandbox",
    false,
    PatchStrategy.ServerSideApply,
  );
}

function labelSelector(selector: Readonly<Record<string, string>>): string {
  return Object.entries(selector)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function podReady(pod: ConfigurationRecord): boolean {
  const status = asRecord(pod.status);
  const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
  return conditions.some((condition) => {
    const value = asRecord(condition);
    return value?.type === "Ready" && value.status === "True";
  });
}

async function waitForGatewayReadiness(
  context: SandboxNamespaceContext,
  readiness: NonNullable<OpenShellSandboxDriverOptions["gateway"]["readiness"]>,
): Promise<void> {
  const namespace = namespaceName(context.namespace);
  const deadline = Date.now() + (readiness.timeoutMs ?? 0);
  const pollIntervalMs = readiness.pollIntervalMs ?? 1_000;
  let unavailable = "OpenShell gateway Service is unavailable.";
  for (;;) {
    let service: KubernetesObject | undefined;
    try {
      service = await kubernetes(context).read({
        apiVersion: "v1",
        kind: "Service",
        metadata: { namespace, name: readiness.serviceName },
      });
    } catch (error) {
      if (!missingResource(error)) {
        throw error;
      }
    }
    if (service !== undefined) {
      const pods = await kubernetes(context).list(
        "v1",
        "Pod",
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector(readiness.podSelector),
      );
      if (pods.items.some((pod) => podReady(pod as ConfigurationRecord))) {
        return;
      }
      unavailable = "OpenShell gateway Pod is not ready.";
    }
    if (Date.now() >= deadline) {
      throw new OpenShellSandboxConfigurationFailure(unavailable);
    }
    await delay(pollIntervalMs, undefined, { signal: context.signal });
  }
}

function workspaceVolumeName(claimName: string): string {
  return `workspace-${sha256Hex(claimName, 12)}`;
}

interface OpenShellWorkspaceLink {
  readonly path: string;
  readonly target: string;
}

function relocatedWorkspaceMountPath(mount: {
  readonly claimName: string;
  readonly subPath: string;
  readonly mountPath: string;
}): string {
  return `${OPENSHELL_WORKSPACE_MOUNTS}/${sha256Hex(
    JSON.stringify([mount.claimName, mount.subPath, mount.mountPath]),
    16,
  )}`;
}

function sandboxCommand(
  command: readonly string[],
  links: readonly OpenShellWorkspaceLink[],
): readonly string[] {
  const loaderIndex = RUNTIME_WRAPPER_COMMAND.length;
  const loader = nodeProgramArguments("")[0]!;
  if (
    command.length <= loaderIndex + 1 ||
    !RUNTIME_WRAPPER_COMMAND.every((part, index) => command[index] === part) ||
    command[loaderIndex] !== loader
  ) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "OpenShell requires the bounded Node Harness runtime command.",
    );
  }
  const bootstrap = `{\nconst fs = require("node:fs");\nconst path = require("node:path");\nfor (const [link, target] of ${JSON.stringify(
    links.map(({ path, target }) => [path, target]),
  )}) {\n  fs.mkdirSync(path.dirname(link), { recursive: true });\n  try {\n    const existing = fs.lstatSync(link);\n    if (!existing.isSymbolicLink() || fs.readlinkSync(link) !== target) {\n      throw new Error("OpenShell workspace link conflicts with existing runtime state: " + link);\n    }\n  } catch (error) {\n    if (error?.code !== "ENOENT") {\n      throw error;\n    }\n    fs.symlinkSync(target, link);\n  }\n}\n}\n`;
  return [
    ...command.slice(0, loaderIndex),
    `${bootstrap}${loader}`,
    ...command.slice(loaderIndex + 1),
  ];
}

function workspaceVolumeMounts(
  requirements: HarnessWorkloadRequirements,
  dataMount: { readonly name: string; readonly mount_path: string; readonly sub_path: string },
  revisionId: string,
) {
  const volumes = new Map<string, { readonly claimName: string; readOnly: boolean }>();
  const links: OpenShellWorkspaceLink[] = [];
  const environmentPaths = new Set(
    requirements.environment.flatMap((entry) => ("value" in entry ? [entry.value] : [])),
  );
  const workspaceMountPaths = new Map<string, string>();
  const runtimePaths: string[] = [];
  const mounts = requirements.workspaceMounts.map((mount) => {
    validateWorkspaceMount(mount);
    const name = workspaceVolumeName(mount.claimName);
    const existing = volumes.get(name);
    if (existing === undefined) {
      volumes.set(name, { claimName: mount.claimName, readOnly: mount.readOnly });
    } else if (!mount.readOnly) {
      volumes.set(name, { ...existing, readOnly: false });
    }
    const homeMount = mount.mountPath.match(/^\/home\/node\/(.+)$/u);
    const isDataMount = name === dataMount.name && mount.subPath === dataMount.sub_path;
    const mountPath = isDataMount
      ? dataMount.mount_path
      : homeMount === null
        ? mount.mountPath
        : relocatedWorkspaceMountPath(mount);
    if (homeMount !== null) {
      const runtimePath = `${OPENSHELL_HOME}/${homeMount[1]}`;
      runtimePaths.push(runtimePath);
      if (environmentPaths.has(mount.mountPath)) {
        // OpenShell's user namespace presents the volume root as root-owned.
        // Point chmod-sensitive application state at a process-created child,
        // while retaining the admitted PVC subpath as its durable parent.
        workspaceMountPaths.set(
          mount.mountPath,
          `${mountPath}/${OPENSHELL_WORKSPACE_STATE_DIRECTORY}`,
        );
      } else {
        links.push({ path: runtimePath, target: mountPath });
      }
    }
    return {
      name,
      mount_path: mountPath,
      sub_path: mount.subPath,
      read_only: mount.readOnly,
    };
  });
  mounts.unshift({
    name: dataMount.name,
    mount_path: OPENSHELL_RUNTIME_ROOT,
    sub_path: `openshell-runtime-${sha256Hex(revisionId, 16)}`,
    read_only: false,
  });
  const distinctRuntimePaths = new Set(runtimePaths);
  if (
    distinctRuntimePaths.size !== runtimePaths.length ||
    runtimePaths.some((path) =>
      runtimePaths.some((candidate) => candidate !== path && candidate.startsWith(`${path}/`)),
    )
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell workspace mounts must not overlap beneath the runtime home.",
    );
  }
  return {
    volumes: Array.from(volumes.values(), (volume) => ({
      name: workspaceVolumeName(volume.claimName),
      persistent_volume_claim: {
        claim_name: volume.claimName,
        read_only: volume.readOnly,
      },
    })),
    mounts,
    links,
    workspaceMountPaths,
  };
}

function sandboxDataMount(
  options: OpenShellSandboxDriverOptions,
  requirements: HarnessWorkloadRequirements,
) {
  const mount = options.kubernetes.sandboxDataMount;
  validateSandboxDataMount(mount);
  const candidates = requirements.workspaceMounts.filter(
    (candidate) =>
      candidate.subPath === mount.subPath &&
      (mount.claimName === undefined || candidate.claimName === mount.claimName),
  );
  const approvedClaimNames = Array.from(
    new Set(candidates.map((candidate) => candidate.claimName)),
  );
  if (approvedClaimNames.length !== 1) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must exactly match one approved Harness workspace mount.",
    );
  }
  const claimName = approvedClaimNames[0]!;
  const approvedMount = candidates.find((candidate) => candidate.claimName === claimName)!;
  if (approvedMount.readOnly && !mount.readOnly) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must not weaken an approved read-only workspace mount.",
    );
  }
  if (!mount.mountPath.startsWith("/sandbox/")) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must mount an approved PVC subpath under /sandbox.",
    );
  }
  if (!requirements.workspaceMounts.some((candidate) => candidate.claimName === claimName)) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell sandboxDataMount must reuse an approved workspace PVC.",
    );
  }
  return {
    name: workspaceVolumeName(claimName),
    mount_path: mount.mountPath,
    sub_path: mount.subPath,
    read_only: mount.readOnly,
  };
}

function validateFilesystemPolicyPath(path: string, description: string): string {
  const value = nonempty(path, description);
  if (value === "/" || !value.startsWith("/") || value.includes("\0")) {
    throw new OpenShellSandboxConfigurationFailure(
      `${description} must be an exact non-root absolute path.`,
    );
  }
  return value;
}

function filesystemPolicy(
  options: OpenShellSandboxDriverOptions,
  dataMount: { readonly mount_path: string; readonly read_only: boolean },
  workspaceMounts: readonly {
    readonly mount_path: string;
    readonly read_only: boolean;
  }[],
) {
  const configured = options.policy.filesystem;
  const readOnly = new Set(
    (
      configured?.readOnly ?? (configured === undefined ? OPENSHELL_DEFAULT_READ_ONLY_PATHS : [])
    ).map((path) =>
      validateFilesystemPolicyPath(path, "OpenShell configured read-only filesystem path"),
    ),
  );
  const readWrite = new Set(
    (
      configured?.readWrite ?? (configured === undefined ? OPENSHELL_DEFAULT_READ_WRITE_PATHS : [])
    ).map((path) =>
      validateFilesystemPolicyPath(path, "OpenShell configured read-write filesystem path"),
    ),
  );

  const addMountPolicy = (path: string, readOnlyMount: boolean) => {
    const normalized = validateFilesystemPolicyPath(path, "Harness workspace mount path");
    if (readOnlyMount) {
      if (readWrite.has(normalized)) {
        throw new OpenShellSandboxConfigurationFailure(
          `OpenShell filesystem policy must not grant read-write access to read-only mount ${normalized}.`,
        );
      }
      readOnly.add(normalized);
      return;
    }
    readOnly.delete(normalized);
    readWrite.add(normalized);
  };

  for (const mount of workspaceMounts) {
    addMountPolicy(mount.mount_path, mount.read_only);
  }
  addMountPolicy(dataMount.mount_path, dataMount.read_only);
  addMountPolicy(OPENSHELL_RUNTIME_ROOT, false);
  addMountPolicy(OPENSHELL_TEMPORARY, false);

  return {
    include_workdir: configured?.includeWorkdir ?? true,
    read_only: [...readOnly],
    read_write: [...readWrite],
  };
}

function networkPolicies(options: OpenShellSandboxDriverOptions) {
  return Object.fromEntries(
    options.policy.networkPolicies.map((policy) => [
      nonempty(policy.name, "OpenShell network policy name"),
      {
        name: policy.name,
        binaries: networkPolicyBinaries(policy),
        endpoints: policy.endpoints.map((endpoint) => {
          const description = `OpenShell network policy ${policy.name}`;
          const tls = optionalEnumValue(endpoint.tls, NETWORK_TLS_MODES, `${description} TLS mode`);
          const enforcement = optionalEnumValue(
            endpoint.enforcement,
            NETWORK_ENFORCEMENT_MODES,
            `${description} enforcement mode`,
          );
          const access = optionalEnumValue(
            endpoint.access,
            NETWORK_ACCESS_PRESETS,
            `${description} access preset`,
          );
          return {
            host: nonempty(endpoint.host, `${description} host`),
            ports: endpoint.ports.map((value) => port(value, `${description} port`)),
            ...(endpoint.protocol === undefined ? {} : { protocol: endpoint.protocol }),
            ...(tls === undefined ? {} : { tls }),
            ...(enforcement === undefined ? {} : { enforcement }),
            ...(access === undefined ? {} : { access }),
          };
        }),
      },
    ]),
  );
}

function workspaceNodeNetworkPolicy(binding: WorkspaceNodeBinding): Record<string, unknown> {
  // A wss endpoint stays end to end between the node and the Gateway route, which
  // pins its own CA. OpenShell then enforces the binary, host, and port; the route
  // enforces the path.
  const endpoint = binding.tls
    ? {
        host: binding.host,
        ports: [binding.port],
        tls: "NETWORK_TLS_MODE_SKIP",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      }
    : {
        host: binding.host,
        ports: [binding.port],
        protocol: "rest",
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        access: "NETWORK_ACCESS_PRESET_FULL",
        path: binding.path,
      };
  return {
    "workspace-node-enrollment": {
      name: "workspace-node-enrollment",
      binaries: [{ path: WORKSPACE_NODE_BINARY }],
      endpoints: [endpoint],
    },
  };
}

function networkPolicyBinaries(policy: OpenShellNetworkPolicyRule) {
  if (!Array.isArray(policy.binaries) || policy.binaries.length === 0) {
    throw new OpenShellSandboxConfigurationFailure(
      `OpenShell network policy ${policy.name} requires at least one binary path.`,
    );
  }
  return policy.binaries.map((binary) => ({
    path: nonempty(binary.path, `OpenShell network policy ${policy.name} binary path`),
  }));
}

function sandboxSpec(
  options: OpenShellSandboxDriverOptions,
  revision: Readonly<AgentRevision>,
  requirements: HarnessWorkloadRequirements,
  runtimeProvider?: string,
  providerEnvironment: ReadonlySet<string> = new Set(),
  workspaceNodeBinding?: WorkspaceNodeBinding,
) {
  const dataMount = sandboxDataMount(options, requirements);
  const workspace = workspaceVolumeMounts(requirements, dataMount, revision.id);
  const volumeMounts = workspace.mounts;
  const podConfig: Record<string, unknown> = {
    runtime_class_name: options.kubernetes.runtimeClassName,
  };
  const driverConfig = {
    pod: podConfig,
    containers: {
      agent: {
        resources: {
          ...(options.kubernetes.agentResources ?? {}),
          requests: {
            ...configurationObject(
              options.kubernetes.agentResources?.requests ?? {},
              "OpenShell Agent resource requests",
            ),
            "ephemeral-storage": "256Mi",
          },
          limits: {
            ...configurationObject(
              options.kubernetes.agentResources?.limits ?? {},
              "OpenShell Agent resource limits",
            ),
            "ephemeral-storage": "1Gi",
          },
        },
        volume_mounts: volumeMounts,
      },
    },
    volumes: workspace.volumes,
  };
  return {
    log_level: options.logLevel ?? "info",
    environment: environment(
      requirements,
      providerEnvironment,
      dataMount.mount_path,
      workspace.workspaceMountPaths,
    ),
    template: {
      image: requirements.image,
      runtime_class_name: options.kubernetes.runtimeClassName,
      labels: { ...requirements.labels },
      driver_config: { fields: toProtobufStruct({ kubernetes: driverConfig }) },
      ...(options.kubernetes.userNamespaces === undefined
        ? {}
        : { user_namespaces: options.kubernetes.userNamespaces }),
    },
    policy: {
      version: 1,
      filesystem: filesystemPolicy(options, dataMount, volumeMounts),
      landlock: { compatibility: "hard_requirement" },
      process: {
        run_as_user: options.policy.process.runAsUser,
        run_as_group: options.policy.process.runAsGroup,
      },
      network_policies: {
        ...networkPolicies(options),
        ...(runtimeProvider === undefined || workspaceNodeBinding === undefined
          ? {}
          : workspaceNodeNetworkPolicy(workspaceNodeBinding)),
      },
    },
    providers: sandboxProviders(options, requirements, runtimeProvider),
    command: sandboxCommand(requirements.command, workspace.links),
  };
}

function validateOptions(options: OpenShellSandboxDriverOptions): void {
  configurationObject(options, "OpenShell configuration");
  configurationObject(options.gateway, "OpenShell gateway configuration");
  configurationObject(options.kubernetes, "OpenShell Kubernetes configuration");
  configurationObject(options.kubernetes.serviceAccount, "OpenShell ServiceAccount configuration");
  configurationObject(options.policy, "OpenShell policy configuration");
  configurationObject(options.policy.process, "OpenShell process policy");
  if (
    options.startupDelayMs !== undefined &&
    (!Number.isSafeInteger(options.startupDelayMs) ||
      options.startupDelayMs < 1 ||
      options.startupDelayMs > MAX_SANDBOX_STARTUP_DELAY_MS)
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      `OpenShell startupDelayMs must be a positive safe integer no greater than ${MAX_SANDBOX_STARTUP_DELAY_MS}.`,
    );
  }
  if (options.gateway.workspaceMode !== "managed" && options.gateway.workspaceMode !== "operator") {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell gateway workspaceMode must be managed or operator.",
    );
  }
  for (const key of Object.keys(options.gateway)) {
    if (
      ![
        "workspaceMode",
        "operatorNamespaceLabels",
        "readiness",
        "operatorWorkspaceResources",
        "networkPolicyResources",
      ].includes(key)
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell gateway option ${key} belongs to the openshell Backend or is unsupported.`,
      );
    }
  }
  if (options.gateway.operatorNamespaceLabels !== undefined) {
    labels(options.gateway.operatorNamespaceLabels, "OpenShell operator Namespace labels");
    if (Object.keys(options.gateway.operatorNamespaceLabels).length === 0) {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell operator Namespace labels must not be empty.",
      );
    }
  }
  if (options.gateway.readiness !== undefined) {
    nonempty(options.gateway.readiness.serviceName, "OpenShell gateway Service name");
    labels(options.gateway.readiness.podSelector, "OpenShell gateway Pod selector");
    for (const [value, description] of [
      [options.gateway.readiness.timeoutMs, "OpenShell gateway readiness timeout"],
      [options.gateway.readiness.pollIntervalMs, "OpenShell gateway readiness poll interval"],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new OpenShellSandboxConfigurationFailure(
          `${description} must be a positive safe integer.`,
        );
      }
    }
  }
  options.gateway.networkPolicyResources?.forEach((resource, index) =>
    validateKubernetesResource(resource, `gateway.networkPolicyResources[${index}]`),
  );
  options.gateway.operatorWorkspaceResources?.forEach((resource, index) =>
    validateOperatorWorkspaceResource(resource, `gateway.operatorWorkspaceResources[${index}]`),
  );
  nonempty(options.kubernetes.runtimeClassName, "OpenShell RuntimeClass name");
  if (options.kubernetes.serviceAccount.mode !== "gatewayConfigured") {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell serviceAccount mode must be gatewayConfigured.",
    );
  }
  configurationObject(options.kubernetes.sandboxDataMount, "OpenShell sandbox data mount");
  validateSandboxDataMount(options.kubernetes.sandboxDataMount);
  if (
    options.policy.landlockCompatibility !== undefined &&
    options.policy.landlockCompatibility !== "hard_requirement"
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell policy.landlockCompatibility must be hard_requirement or omitted; best_effort is not supported.",
    );
  }
  nonempty(options.policy.process.runAsUser, "OpenShell process runAsUser");
  nonempty(options.policy.process.runAsGroup, "OpenShell process runAsGroup");
  if (
    !Array.isArray(options.policy.networkPolicies) ||
    options.policy.networkPolicies.length === 0
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell requires at least one sandbox network policy.",
    );
  }
  networkPolicies(options);
  if (
    options.providers !== undefined &&
    (!Array.isArray(options.providers) ||
      options.providers.some(
        (provider) => !isNonEmptyString(provider) || isOpenShellProviderName(provider),
      ))
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell static providers must be nonempty names outside the OCC credential-source namespace.",
    );
  }
  const prefix = nonempty(
    options.sandboxNamePrefix ?? DEFAULT_SANDBOX_NAME_PREFIX,
    "Sandbox name prefix",
  );
  if (prefix.length > OPENSHELL_MAX_SANDBOX_NAME_LENGTH - 17) {
    throw new OpenShellSandboxConfigurationFailure(
      "Sandbox name prefix is too long for OpenShell's 19-character limit.",
    );
  }
}

export const configurationSchema = Object.freeze({
  type: "object",
  required: ["gateway", "kubernetes", "policy"],
  additionalProperties: false,
  properties: {
    gateway: { type: "object" },
    kubernetes: { type: "object" },
    policy: { type: "object" },
    sandboxNamePrefix: { type: "string" },
    startupDelayMs: { type: "integer", minimum: 1, maximum: MAX_SANDBOX_STARTUP_DELAY_MS },
    logLevel: { type: "string" },
    providers: { type: "array", items: { type: "string" } },
  },
});

/**
 * Static operator providers plus every Credential Gateway attachment. An attachment this
 * Backend did not issue, or one that shadows a static provider, fails provisioning.
 */
function sandboxProviders(
  options: OpenShellSandboxDriverOptions,
  requirements: HarnessWorkloadRequirements,
  runtimeProvider?: string,
): string[] {
  const providers = [...(options.providers ?? [])];
  for (const attachment of requirements.credentialAttachments) {
    if (!isOpenShellProviderName(attachment.ref) || providers.includes(attachment.ref)) {
      throw new OpenShellSandboxConfigurationFailure(
        "The Harness requires a credential attachment that this OpenShell Backend did not issue.",
      );
    }
    providers.push(attachment.ref);
  }
  if (runtimeProvider !== undefined) {
    if (providers.includes(runtimeProvider)) {
      throw new OpenShellSandboxConfigurationFailure(
        "The Codex runtime provider conflicts with another requested provider.",
      );
    }
    providers.push(runtimeProvider);
  }
  return providers;
}

function runtimeProviderName(revisionId: string): string {
  return `oce-runtime-${sha256Hex(revisionId, 16)}`;
}

function runtimeProviderLabels(
  namespace: Readonly<Namespace>,
  revision: Readonly<AgentRevision>,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [OPENSHELL_MANAGED_BY_LABEL]: OPENSHELL_MANAGED_BY,
    [OPENSHELL_NAMESPACE_ID_LABEL]: namespace.id,
    [RUNTIME_PROVIDER_AGENT_LABEL]: revision.agentId,
    [RUNTIME_PROVIDER_REVISION_LABEL]: revision.id,
  });
}

function exactStringMap(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const actualEntries = Object.entries(actual);
  return (
    actualEntries.length === Object.keys(expected).length &&
    actualEntries.every(([key, value]) => expected[key] === value)
  );
}

function exactStringMapWithReservedPrefix(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
  reservedPrefix: string,
): boolean {
  return (
    Object.entries(expected).every(([key, value]) => actual[key] === value) &&
    Object.keys(actual).every(
      (key) => Object.hasOwn(expected, key) || key.startsWith(reservedPrefix),
    )
  );
}

const PROTOBUF_VALUE_KINDS = new Set([
  "nullValue",
  "numberValue",
  "stringValue",
  "boolValue",
  "structValue",
  "listValue",
]);

function canonicalProtobufValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalProtobufValues);
  }
  const record = asRecord(value);
  if (record === undefined) {
    return value;
  }
  const discriminator = record.kind;
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key]) =>
          key !== "kind" ||
          typeof discriminator !== "string" ||
          !PROTOBUF_VALUE_KINDS.has(discriminator) ||
          !Object.hasOwn(record, discriminator),
      )
      .map(([key, entry]) => [key, canonicalProtobufValues(entry)]),
  );
}

/**
 * Decoding with `oneofs: true` adds a virtual `_field` property naming each set proto3
 * `optional` field, for example `_user_namespaces: "user_namespaces"`. A request never
 * carries those markers, so they are not Sandbox content.
 */
function withoutSyntheticOneofs(
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) => !(key.startsWith("_") && value === key.slice(1)),
    ),
  );
}

function canonicalSandboxSpec(spec: Readonly<Record<string, unknown>> | undefined): unknown {
  const template = asRecord(spec?.template);
  if (spec === undefined || template === undefined) {
    return spec;
  }
  return {
    ...withoutSyntheticOneofs(spec),
    template: {
      ...withoutSyntheticOneofs(template),
      driver_config: canonicalProtobufValues(template.driver_config),
    },
  };
}

function verifyRuntimeProvider(
  provider: OpenShellProviderResponse,
  name: string,
  expectedLabels: Readonly<Record<string, string>>,
  expectedConfig?: Readonly<Record<string, string>>,
): void {
  if (
    provider.name !== name ||
    provider.type !== RUNTIME_PROFILE_ID ||
    !exactStringMap(provider.labels, expectedLabels) ||
    (expectedConfig !== undefined && !exactStringMap(provider.config, expectedConfig))
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      `Refusing OpenShell provider ${name} without exact AgentRevision ownership and content.`,
    );
  }
}

interface RuntimeProviderSetupEnvelope {
  readonly url: string;
  readonly bootstrapToken: string;
  readonly expiresAtMs: number;
  readonly tlsFingerprint?: string;
}

function runtimeProviderSetupEnvelope(
  value: string | undefined,
): RuntimeProviderSetupEnvelope | undefined {
  if (value === undefined) {
    return undefined;
  }
  let payload: ConfigurationRecord;
  try {
    payload = asRecord(JSON.parse(value)) ?? {};
  } catch {
    return undefined;
  }
  const allowed = new Set(["url", "bootstrapToken", "expiresAtMs", "tlsFingerprint"]);
  if (
    Object.keys(payload).some((key) => !allowed.has(key)) ||
    !isNonEmptyString(payload.url) ||
    !isNonEmptyString(payload.bootstrapToken) ||
    typeof payload.expiresAtMs !== "number" ||
    !Number.isSafeInteger(payload.expiresAtMs) ||
    (payload.tlsFingerprint !== undefined && !isNonEmptyString(payload.tlsFingerprint))
  ) {
    return undefined;
  }
  return {
    url: payload.url,
    bootstrapToken: payload.bootstrapToken,
    expiresAtMs: payload.expiresAtMs,
    ...(payload.tlsFingerprint === undefined ? {} : { tlsFingerprint: payload.tlsFingerprint }),
  };
}

function runtimeProviderSetupUpdate(
  provider: OpenShellProviderResponse,
  name: string,
  expectedLabels: Readonly<Record<string, string>>,
  expectedConfig: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  verifyRuntimeProvider(provider, name, expectedLabels);
  if (exactStringMap(provider.config, expectedConfig)) {
    return undefined;
  }
  const actualStaticConfig = { ...provider.config };
  const expectedStaticConfig = { ...expectedConfig };
  delete actualStaticConfig[WORKSPACE_NODE_SETUP_CONFIG];
  delete expectedStaticConfig[WORKSPACE_NODE_SETUP_CONFIG];
  const actualSetup = runtimeProviderSetupEnvelope(provider.config[WORKSPACE_NODE_SETUP_CONFIG]);
  const expectedSetup = runtimeProviderSetupEnvelope(expectedConfig[WORKSPACE_NODE_SETUP_CONFIG]);
  const now = Date.now();
  if (
    !exactStringMap(actualStaticConfig, expectedStaticConfig) ||
    actualSetup === undefined ||
    expectedSetup === undefined ||
    actualSetup.url !== expectedSetup.url ||
    actualSetup.tlsFingerprint !== expectedSetup.tlsFingerprint ||
    actualSetup.expiresAtMs > now ||
    expectedSetup.expiresAtMs <= now ||
    expectedSetup.expiresAtMs <= actualSetup.expiresAtMs
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      `Refusing OpenShell provider ${name} without exact AgentRevision ownership and content.`,
    );
  }
  return Object.freeze({
    [WORKSPACE_NODE_SETUP_CONFIG]: expectedConfig[WORKSPACE_NODE_SETUP_CONFIG]!,
  });
}

function verifyExistingSandbox(
  existing: OpenShellSandboxResponse,
  request: OpenShellSandboxCreateRequest,
): void {
  if (
    existing.name !== request.name ||
    existing.workspace !== request.workspace ||
    !exactStringMap(existing.labels, request.labels) ||
    !exactStringMapWithReservedPrefix(
      existing.annotations,
      request.annotations,
      "internal.openshell.ai/",
    ) ||
    !isDeepStrictEqual(canonicalSandboxSpec(existing.spec), canonicalSandboxSpec(request.spec))
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      `Refusing OpenShell Sandbox ${request.name} without exact AgentRevision ownership and content.`,
    );
  }
}

export function validateConfiguration(configuration: unknown): void {
  const options = asRecord(configuration);
  if (options === undefined) {
    throw new OpenShellSandboxConfigurationFailure("OpenShell configuration is required.");
  }
  validateOptions(options as unknown as OpenShellSandboxDriverOptions);
}

export class OpenShellSandboxDriver implements SandboxDriver {
  static readonly configurationSchema = configurationSchema;

  readonly id: string;
  readonly capability = "sandbox" as const;
  readonly implementation: string;
  readonly facets = Object.freeze(["networking", "filesystem", "process"] as const);
  // environment() sets HOME to this for every Sandbox it creates.
  readonly harnessHome = OPENSHELL_HOME;
  private readonly options: OpenShellSandboxDriverOptions;
  private readonly backend: Backend<OpenShellGateway>;

  static validateConfiguration(configuration: unknown): void {
    validateConfiguration(configuration);
  }

  constructor(options: OpenShellSandboxDriverOptions, selection: OpenShellSandboxDriverSelection) {
    validateOptions(options);
    this.id = nonempty(selection.id ?? "sandbox-openshell-local", "OpenShell Sandbox Driver ID");
    this.implementation = nonempty(
      selection.implementation ?? "openshell",
      "OpenShell Sandbox Driver implementation",
    );
    if (this.implementation !== "openshell") {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell Sandbox Driver implementation must be exactly openshell.",
      );
    }
    if (selection.backend.drivers.sandbox !== this.id) {
      throw new OpenShellSandboxConfigurationFailure(
        "The OpenShell Backend does not declare this Sandbox Driver as a member.",
      );
    }
    this.options = options;
    this.backend = selection.backend;
  }

  configureAgent(
    configuration: Readonly<OpenClawConfigurationDocument>,
    harness: Readonly<AgentRevision["harness"]>,
  ): OpenClawConfigurationDocument {
    if (harness.mode !== "dedicated") {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell SandboxDriver supports only dedicated Harness revisions.",
      );
    }
    if (harness.id === "openclaw") {
      const agents = optionalAgentConfiguration(
        configuration.agents,
        "OpenShell Agent configuration",
      );
      const defaults = optionalAgentConfiguration(agents.defaults, "OpenShell Agent defaults");
      const workspace = this.options.kubernetes.sandboxDataMount.mountPath;
      // Like the Codex sandbox below, the workspace is forced, not refused: this hook also
      // runs on provisioning status reads, where a refusal would fail stored work. The main
      // entry is pinned too, because its workspace wins over the default in OpenClaw and in
      // the Gateway, while file transfer and the Harness use the mount.
      return {
        ...configuration,
        agents: {
          ...agents,
          defaults: { ...defaults, workspace },
          ...(agents.entries === undefined
            ? {}
            : { entries: pinMainAgentWorkspace(agents.entries, workspace) }),
        },
      };
    }
    if (harness.id !== "codex") {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell SandboxDriver does not support the selected Harness runtime.",
      );
    }
    const plugins = optionalAgentConfiguration(
      configuration.plugins,
      "OpenShell Sandbox plugin configuration",
    );
    const entries = optionalAgentConfiguration(plugins.entries, "OpenShell Sandbox plugin entries");
    const codex = optionalAgentConfiguration(entries.codex, "OpenShell Sandbox Codex plugin entry");
    const codexConfig = optionalAgentConfiguration(
      codex.config,
      "OpenShell Sandbox Codex plugin config",
    );
    const appServer = optionalAgentConfiguration(
      codexConfig.appServer,
      "OpenShell Sandbox Codex app-server config",
    );

    return {
      ...configuration,
      plugins: {
        ...plugins,
        entries: {
          ...entries,
          codex: {
            ...codex,
            enabled: true,
            config: {
              ...codexConfig,
              appServer: {
                ...appServer,
                ...OPENSHELL_CODEX_APP_SERVER_POLICY,
              },
            },
          },
        },
      },
    };
  }

  async ensureNamespace(context: SandboxNamespaceContext): Promise<void> {
    this.requireOperatorWorkspaceMode("ensure a Namespace");
    const namespace = namespaceName(context.namespace);
    await applyOperatorNamespaceLabels(context, this.options.gateway.operatorNamespaceLabels);
    await applyResources(context, this.options.gateway.operatorWorkspaceResources);
    await applyResources(context, this.options.gateway.networkPolicyResources);
    if (this.options.gateway.readiness !== undefined) {
      await waitForGatewayReadiness(context, this.options.gateway.readiness);
    }
    const client = this.gatewayClientForNamespace(namespace);
    await client.health(context.signal);
    const name = workspaceName(context.namespace);
    let workspace = await client.getWorkspace(name, context.signal);
    if (workspace === undefined) {
      try {
        workspace = await client.createWorkspace(
          name,
          workspaceLabels(context.namespace),
          context.signal,
        );
      } catch (error) {
        if (!(error instanceof OpenShellWorkspaceAlreadyExistsError)) {
          throw error;
        }
        workspace = await client.getWorkspace(name, context.signal);
        if (workspace === undefined) {
          throw new OpenShellSandboxConfigurationFailure(
            `OpenShell Workspace ${name} disappeared during creation.`,
          );
        }
      }
    }
    verifyActiveWorkspace(workspace, context.namespace);
  }

  async provisionHarness(context: SandboxHarnessContext): Promise<SandboxResourceRef> {
    this.requireOperatorWorkspaceMode("provision a Harness");
    if (
      context.revision.harness.mode !== "dedicated" ||
      (context.revision.harness.id !== "codex" && context.revision.harness.id !== "openclaw")
    ) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "OpenShell SandboxDriver supports only dedicated Codex or OpenClaw Harness revisions.",
      );
    }
    if (
      context.revision.sandboxDriverId !== undefined &&
      context.revision.sandboxDriverId !== this.id
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "Refusing an AgentRevision pinned to another Sandbox Driver.",
      );
    }
    if (context.requirements.workloadIdentity !== undefined) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "OpenShell v0.1.3-pre.2 cannot preserve an Agent ServiceAccount and projected identity token; disable ServicePrincipal credentials or select another Sandbox Driver.",
      );
    }
    labels(context.requirements.labels, "Harness workload labels");
    const sandbox = this.sandboxRef(context);
    const codex = context.revision.harness.id === "codex";
    const client = this.gatewayClientForNamespace(sandbox.namespaceName);
    const workspace = workspaceName(context.namespace);
    let runtimeProvider: string | undefined;
    let runtimeCredentialMaterial: CodexRuntimeCredentialMaterial = {
      credentials: {},
      credentialExpirationTimes: {},
      config: {},
    };
    if (codex) {
      codexTransportVerifier(context.requirements);
      const runtimeFiles = codexRuntimeFiles(context.requirements);
      runtimeCredentialMaterial = await codexRuntimeCredentials(context);
      await this.ensureRuntimeProfile(client, workspace, runtimeFiles.profile, context.signal);
      const ensured = await this.ensureRuntimeProvider(
        client,
        workspace,
        context,
        { ...runtimeFiles.config, ...runtimeCredentialMaterial.config },
        runtimeCredentialMaterial.credentials,
        runtimeCredentialMaterial.credentialExpirationTimes,
      );
      runtimeProvider = ensured.name;
    }
    const serviceExposures = codex
      ? [
          {
            service: "",
            targetPort: harnessPort(context.requirements),
            authorizationMode: "bearer_passthrough" as const,
          },
        ]
      : [];
    const annotations = {
      "openclaw.dev/namespace-id": context.revision.namespaceId,
      "openclaw.dev/agent-id": context.revision.agentId,
      "openclaw.dev/revision-id": context.revision.id,
    };
    const selector = { name: sandbox.resourceName, workspace };
    const requestIds = createRequestIds(context.revision.id);
    const create = {
      ...selector,
      labels: context.requirements.labels,
      annotations,
      spec: sandboxSpec(
        this.options,
        context.revision,
        context.requirements,
        runtimeProvider,
        new Set([
          WORKSPACE_NODE_SETUP_ENVIRONMENT,
          WORKSPACE_NODE_CA_ENVIRONMENT,
          ...Object.keys(runtimeCredentialMaterial.credentials),
        ]),
        runtimeCredentialMaterial.binding,
      ),
      serviceExposures,
    };
    // Every reconcile pass reaches here. Re-sending CreateSandbox for a Sandbox that
    // exists would hit the gateway's request_id replay, which refuses a changed spec
    // (REQUEST_ID_PAYLOAD_MISMATCH) and forgets the create after 24 h (ALREADY_EXISTS).
    let existing = await client.getSandbox(selector, context.signal);
    // A refused request_id ran nothing, but its earlier call may still create the Sandbox,
    // so the next ID is tried only after GetSandbox finds none. The Sandbox name is unique
    // per Workspace, so concurrent attempts yield one Sandbox and ALREADY_EXISTS adopts it.
    let refusal: OpenShellRequestReplayRefusedError | undefined;
    for (let attempt = 0; existing === undefined; attempt++) {
      if (attempt === requestIds.length) {
        // A last refusal of REQUEST_REPLAY_UNAVAILABLE can also mean unreadable gateway key
        // material, which a new revision would not fix.
        const remedy =
          refusal?.reason === "REQUEST_REPLAY_UNAVAILABLE"
            ? "check that the gateway's JWT or TLS key material is readable, or deploy a new revision"
            : "deploy a new revision";
        throw new OpenShellSandboxConfigurationFailure(
          `OpenShell refused all ${requestIds.length} create request IDs for Sandbox ${sandbox.resourceName} (last: ${refusal?.message}); ${remedy}.`,
        );
      }
      let created;
      let alreadyExists = false;
      try {
        created = await client.createSandbox(
          { ...create, requestId: requestIds[attempt]! },
          context.signal,
        );
      } catch (error) {
        if (error instanceof OpenShellRequestReplayRefusedError) {
          refusal = error;
        } else if (error instanceof OpenShellSandboxAlreadyExistsError) {
          alreadyExists = true;
        } else {
          throw error;
        }
      }
      if (created !== undefined) {
        if (created.name !== sandbox.resourceName) {
          throw new OpenShellSandboxConfigurationFailure(
            "OpenShell returned a different Sandbox name than requested.",
          );
        }
        if (codex) {
          validateHarnessServiceUrl(created.serviceUrls[""]);
        } else if (Object.keys(created.serviceUrls).length !== 0) {
          throw new OpenShellSandboxConfigurationFailure(
            "OpenShell exposed an unexpected service for the native OpenClaw Harness.",
          );
        }
        if (this.options.startupDelayMs !== undefined) {
          // TODO(openshell-service-readiness): Replace this bounded compatibility
          // delay when OpenShell reports that an exposed Sandbox service is ready.
          await delay(this.options.startupDelayMs, undefined, { signal: context.signal });
        }
        return Object.freeze(sandbox);
      }
      existing = await client.getSandbox(selector, context.signal);
      if (existing === undefined && alreadyExists) {
        throw new OpenShellSandboxConfigurationFailure(
          `OpenShell Sandbox ${sandbox.resourceName} disappeared during creation.`,
        );
      }
    }
    // Adopt only this revision's own live Sandbox, with its Harness service in place.
    verifyExistingSandbox(existing, { ...create, requestId: requestIds[0]! });
    if (existing.phase === "SANDBOX_PHASE_DELETING" || existing.phase === 4) {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell Sandbox ${sandbox.resourceName} is being deleted; it can be created again once deletion finishes.`,
      );
    }
    if (STOPPED_SANDBOX_PHASES.has(existing.phase ?? "")) {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell Sandbox ${sandbox.resourceName} has stopped; remove the stale Sandbox before retrying.`,
      );
    }
    if (codex) {
      const service = await client.getService(workspace, sandbox.resourceName, "", context.signal);
      if (
        service === undefined ||
        service.targetPort !== harnessPort(context.requirements) ||
        !["SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH", 2].includes(service.authorizationMode)
      ) {
        throw new OpenShellSandboxConfigurationFailure(
          `OpenShell Sandbox ${sandbox.resourceName} exists without its exact bearer-passthrough Harness service; remove the stale Sandbox before retrying.`,
        );
      }
      validateHarnessServiceUrl(service.url);
    }
    return Object.freeze(sandbox);
  }

  async harnessEndpoint(context: SandboxHarnessContext): Promise<SandboxHarnessEndpoint> {
    const { service } = await this.exactHarnessService(context, "resolve a Harness endpoint");
    return Object.freeze({
      url: harnessWebSocketUrl(service.advertisedUrl),
      workspaceRoot: "/sandbox/enterprise",
    });
  }

  /**
   * Observes the Codex Harness through its bearer-passthrough exposure, as the Agent Gateway
   * reaches it. A Harness holding a startup failure (for example a failed model probe) serves
   * that failure on the app-server port in place of Codex; a serving Codex app-server completes
   * the authenticated WebSocket handshake. Anything else, including OpenShell's own `502` while
   * nothing listens, is still starting.
   */
  async harnessStatus(context: SandboxHarnessStatusContext): Promise<SandboxHarnessStatus> {
    const { client, service } = await this.exactHarnessService(context, "observe a Harness");
    // Handshake first, so a serving app-server never receives a plain request. A
    // Harness wrapper holding a startup failure refuses the upgrade and serves the
    // failure instead.
    if (
      await client.serviceWebSocketHandshake(service.url, context.transportToken, context.signal)
    ) {
      return Object.freeze({ state: "serving" });
    }
    const document = await client.getServiceDocument(
      service.url,
      HARNESS_RUNTIME_STATUS_PATH,
      context.transportToken,
      context.signal,
    );
    const runtimeFailure = asRecord(document.json)?.runtimeFailure;
    return document.status === 200 && runtimeFailure !== undefined
      ? Object.freeze({ state: "failed", runtimeFailure })
      : Object.freeze({ state: "starting" });
  }

  private async exactHarnessService(
    context: SandboxHarnessContext,
    operation: string,
  ): Promise<{
    readonly client: OpenShellGatewayClient;
    readonly service: NonNullable<Awaited<ReturnType<OpenShellGatewayClient["getService"]>>>;
  }> {
    this.requireOperatorWorkspaceMode(operation);
    if (context.revision.harness.mode !== "dedicated" || context.revision.harness.id !== "codex") {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "OpenShell exposes a provider-owned Harness endpoint only for dedicated Codex revisions.",
      );
    }
    if (context.revision.sandboxDriverId !== this.id) {
      throw new OpenShellSandboxConfigurationFailure(
        "Refusing to resolve a Harness endpoint for another Sandbox Driver.",
      );
    }
    const sandbox = this.sandboxRef(context);
    const client = this.gatewayClientForNamespace(sandbox.namespaceName);
    const service = await client.getService(
      workspaceName(context.namespace),
      sandbox.resourceName,
      "",
      context.signal,
    );
    if (
      service === undefined ||
      service.targetPort !== harnessPort(context.requirements) ||
      !["SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH", 2].includes(service.authorizationMode)
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell did not expose the exact Codex bearer-passthrough service.",
      );
    }
    return { client, service };
  }

  async cleanup(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
  ): Promise<void> {
    if (context.revision !== undefined) {
      this.requireOperatorWorkspaceMode("clean up a revision");
      if (
        context.revision.namespaceId !== context.namespace.id ||
        context.revision.sandboxDriverId !== this.id
      ) {
        throw new OpenShellSandboxConfigurationFailure(
          "Refusing to delete a Sandbox outside its selected AgentRevision and Namespace.",
        );
      }
      const sandbox = this.sandboxRef({ namespace: context.namespace, revision: context.revision });
      const client = this.gatewayClientForNamespace(sandbox.namespaceName);
      const workspace = workspaceName(context.namespace);
      await client.deleteSandbox(
        {
          name: sandbox.resourceName,
          workspace,
        },
        context.signal,
      );
      if (
        context.revision.harness.mode === "dedicated" &&
        context.revision.harness.id === "codex"
      ) {
        const provider = runtimeProviderName(context.revision.id);
        const existing = await client.getProvider(workspace, provider, context.signal);
        if (existing !== undefined) {
          verifyRuntimeProvider(
            existing,
            provider,
            runtimeProviderLabels(context.namespace, context.revision),
          );
          await client.deleteProvider(workspace, provider, context.signal);
        }
      }
      return;
    }
    this.requireOperatorWorkspaceMode("clean up a Namespace");
    const namespace = namespaceName(context.namespace);
    const client = this.gatewayClientForNamespace(namespace);
    const workspace = await client.getWorkspace(workspaceName(context.namespace), context.signal);
    if (workspace !== undefined) {
      // A prior delete can have reached TERMINATING before its response was lost.
      // Ownership remains the cleanup boundary, and DeleteWorkspace is idempotent.
      verifyWorkspaceOwnership(workspace, context.namespace);
      for (const provider of await client.listProviders(workspace.name, context.signal)) {
        if (
          provider.type === RUNTIME_PROFILE_ID &&
          provider.labels[OPENSHELL_MANAGED_BY_LABEL] === OPENSHELL_MANAGED_BY &&
          provider.labels[OPENSHELL_NAMESPACE_ID_LABEL] === context.namespace.id
        ) {
          await client.deleteProvider(workspace.name, provider.name, context.signal);
        }
      }
      await this.deleteRuntimeProfileIfUnused(client, workspace.name, context.signal);
      await client.deleteWorkspace(workspace.name, context.signal);
    }
    const resources = [
      ...(this.options.gateway.operatorWorkspaceResources ?? []),
      ...(this.options.gateway.networkPolicyResources ?? []),
    ];
    for (const resource of resources.reverse()) {
      try {
        await kubernetes(context).delete(resourceReference(resource, namespace));
      } catch (error) {
        if (!missingResource(error)) {
          throw error;
        }
      }
    }
  }

  /**
   * The revision's Sandbox log through a reader narrowed to `GetSandboxLogs`, so this
   * path cannot create, delete or exec into a Sandbox. The Sandbox name is derived from
   * the revision exactly as at provisioning.
   */
  async readSandboxLogs(
    context: SandboxLogContext,
    request: SandboxLogRequest,
  ): Promise<SandboxLogChunk> {
    this.requireOperatorWorkspaceMode("read Sandbox logs");
    if (
      context.revision.namespaceId !== context.namespace.id ||
      context.revision.sandboxDriverId !== this.id
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "Refusing to read a Sandbox outside its selected AgentRevision and Namespace.",
      );
    }
    const sandbox = this.sandboxRef(context);
    const reader = openShellSandboxLogReader(this.gatewayClientForNamespace(sandbox.namespaceName));
    let response;
    try {
      response = await reader.getSandboxLogs(
        {
          workspace: workspaceName(context.namespace),
          sandbox: sandbox.resourceName,
          lines: request.lines,
          ...(request.sinceTime === undefined ? {} : { sinceTime: request.sinceTime }),
        },
        context.signal,
      );
    } catch (error) {
      const code = asRecord(error)?.code;
      // NOT_FOUND: the Sandbox is not provisioned (yet) or was removed, or OCC's identity
      // is not a member of its Workspace (OpenShell conceals the Sandbox then). Neither
      // means "no lines", and the two cannot be told apart.
      if (code === GRPC_NOT_FOUND) {
        throw new RuntimeLogsSandboxNotFoundError();
      }
      // The OCC identity lacks `sandbox:read` or the Workspace role `user`.
      if (code === GRPC_PERMISSION_DENIED || code === GRPC_UNAUTHENTICATED) {
        throw new RuntimeLogsForbiddenByClusterError();
      }
      throw error;
    }
    return Object.freeze({
      sandbox: sandbox.resourceName,
      observedAt: new Date().toISOString(),
      lines: response.lines,
      bufferTotal: response.bufferTotal,
    });
  }

  close(): void {
    this.backend.client.close();
  }

  private gatewayClientForNamespace(namespace: string): OpenShellGatewayClient {
    return this.backend.client.clientForNamespace(namespace);
  }

  private async ensureRuntimeProfile(
    client: OpenShellGatewayClient,
    workspace: string,
    profile: OpenShellProviderProfile,
    signal: AbortSignal,
  ): Promise<void> {
    let existing = await client.getProviderProfile(workspace, profile.id, signal);
    if (existing === undefined) {
      try {
        await client.importProviderProfile(workspace, profile, signal);
        return;
      } catch (error) {
        // Concurrent revisions share the Namespace profile. Adopt the winner only if it
        // materialized; otherwise preserve the original import failure.
        existing = await client.getProviderProfile(workspace, profile.id, signal);
        if (existing === undefined) {
          throw error;
        }
      }
    }
    if (!isManagedRuntimeProfile(existing)) {
      throw new OpenShellSandboxConfigurationFailure(
        `Refusing unmanaged OpenShell provider profile ${profile.id}.`,
      );
    }
    if (
      existing.annotations[RUNTIME_PROFILE_MANAGED_ANNOTATION] !==
      profile.annotations[RUNTIME_PROFILE_MANAGED_ANNOTATION]
    ) {
      try {
        await client.updateProviderProfile(workspace, profile, existing.resourceVersion, signal);
      } catch (error) {
        const refreshed = await client.getProviderProfile(workspace, profile.id, signal);
        if (
          refreshed?.annotations[RUNTIME_PROFILE_MANAGED_ANNOTATION] !==
          profile.annotations[RUNTIME_PROFILE_MANAGED_ANNOTATION]
        ) {
          throw error;
        }
      }
    }
  }

  private async ensureRuntimeProvider(
    client: OpenShellGatewayClient,
    workspace: string,
    context: SandboxHarnessContext,
    config: Readonly<Record<string, string>>,
    credentials: Readonly<Record<string, string>>,
    credentialExpirationTimes: Readonly<Record<string, string>>,
  ): Promise<{ readonly name: string; readonly created: boolean }> {
    const name = runtimeProviderName(context.revision.id);
    const expectedLabels = runtimeProviderLabels(context.namespace, context.revision);
    let provider = await client.getProvider(workspace, name, context.signal);
    let created = false;
    if (provider === undefined) {
      try {
        provider = await client.createProvider(
          {
            workspace,
            name,
            type: RUNTIME_PROFILE_ID,
            labels: expectedLabels,
            credentials,
            credentialExpirationTimes,
            config,
          },
          context.signal,
        );
        created = true;
      } catch (error) {
        if (!(error instanceof OpenShellProviderAlreadyExistsError)) {
          throw error;
        }
        provider = await client.getProvider(workspace, name, context.signal);
        if (provider === undefined) {
          throw new OpenShellSandboxConfigurationFailure(
            `OpenShell provider ${name} disappeared during creation.`,
          );
        }
      }
    }
    const setupUpdate = runtimeProviderSetupUpdate(provider, name, expectedLabels, config);
    if (setupUpdate !== undefined) {
      provider = await client.updateProviderConfig(
        workspace,
        name,
        setupUpdate,
        provider.resourceVersion,
        context.signal,
      );
    }
    verifyRuntimeProvider(provider, name, expectedLabels, config);
    return Object.freeze({ name, created });
  }

  private async deleteRuntimeProfileIfUnused(
    client: OpenShellGatewayClient,
    workspace: string,
    signal: AbortSignal,
  ): Promise<void> {
    const providers = await client.listProviders(workspace, signal);
    if (providers.some((provider) => provider.type === RUNTIME_PROFILE_ID)) {
      return;
    }
    const profile = await client.getProviderProfile(workspace, RUNTIME_PROFILE_ID, signal);
    if (profile === undefined) {
      return;
    }
    if (!isManagedRuntimeProfile(profile)) {
      throw new OpenShellSandboxConfigurationFailure(
        `Refusing to delete unmanaged OpenShell provider profile ${RUNTIME_PROFILE_ID}.`,
      );
    }
    await client.deleteProviderProfile(workspace, RUNTIME_PROFILE_ID, signal);
  }

  private requireOperatorWorkspaceMode(operation: string): void {
    if (this.options.gateway.workspaceMode === "managed") {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell managed workspace mode is not implemented; cannot ${operation}.`,
      );
    }
  }

  harnessResource(
    context: Pick<SandboxHarnessContext, "namespace" | "revision">,
  ): SandboxResourceRef {
    return this.sandboxRef(context);
  }

  private sandboxRef(
    context: Pick<SandboxHarnessContext, "namespace" | "revision">,
  ): SandboxResourceRef {
    const prefix = this.options.sandboxNamePrefix ?? DEFAULT_SANDBOX_NAME_PREFIX;
    const hashLength = OPENSHELL_MAX_SANDBOX_NAME_LENGTH - prefix.length - 1;
    return Object.freeze({
      namespaceName: namespaceName(context.namespace),
      resourceName: `${prefix}-${sha256Hex(context.revision.id, hashLength)}`,
      agentId: context.revision.agentId,
      revisionId: context.revision.id,
    });
  }
}
