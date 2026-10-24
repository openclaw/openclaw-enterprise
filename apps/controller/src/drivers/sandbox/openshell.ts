import {
  openShellRepositoryAccess,
  type OpenShellGitPolicyOverlap,
  type OpenShellGitRuntime,
} from "../egress-proxy/openshell-git-runtime.ts";
import { networkPolicySpecToJson } from "../kubernetes/network-policy.ts";
import {
  openShellEgressConfiguration,
  type OpenShellProxyOptions,
} from "../egress-proxy/openshell.ts";
import { deleteOpenShellPreparedGitProviders } from "../egress-proxy/openshell-prepared-git-provider.ts";
import { type ErrorDetail } from "@openclaw-enterprise/contracts";
import {
  requireConfiguration,
  SandboxNetworkPolicyConfiguration,
  ConfigurationValidationError,
} from "@openclaw-enterprise/contracts";
import { openShellLogDecision } from "./openshell-log-decisions.ts";
import {
  AGENT_POLICY_PREFIX,
  openShellAgentNetworkRules,
  openShellPolicyCandidate,
  sameOpenShellPolicy,
} from "./openshell-policy.ts";
import type {
  SandboxNetworkGrant,
  SandboxPolicySnapshot,
  SandboxPolicyObservation,
  SandboxPolicyRecommendations,
  SandboxPolicyRecommendation,
} from "@openclaw-enterprise/contracts";
import {
  asRecord,
  immutableCopy,
  isNonEmptyString,
  MAX_TIMER_DELAY_MS,
  sha256Hex,
} from "@openclaw-enterprise/utils";
import {
  KubernetesObjectApi,
  type KubernetesObject,
  type V1Deployment,
  type V1Pod,
  type V1NetworkPolicySpec,
  PatchStrategy,
} from "@kubernetes/client-node";
import {
  ConfigurationHarnessError,
  configurationSettingMessage,
  DependencyUnavailableError,
  RuntimeLogsForbiddenByClusterError,
  RuntimeLogsSandboxNotFoundError,
  SandboxNamespaceRefusedError,
  SandboxNetworkPolicyConflictError,
  SandboxRevisionUnsupportedError,
  SandboxRepositoryRecipientUnverifiedError,
  SandboxWorkspaceSetupRefusedError,
  TransientDependencyError,
} from "@openclaw-enterprise/occ";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentRevision,
  EgressInstallation,
  ProxyPlan,
  Backend,
  HarnessWorkloadRequirements,
  KubernetesNamespacedResource,
  Namespace,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  SandboxDriver,
  SandboxHarnessEndpoint,
  SandboxHarnessContext,
  SandboxHarnessObservation,
  SandboxHarnessStatus,
  SandboxHarnessStatusContext,
  SandboxHarnessWithdrawalContext,
  SandboxLogChunk,
  SandboxLogContext,
  SandboxLogRequest,
  SandboxNamespaceContext,
  SandboxResourceRef,
  SandboxHarnessLostCode,
} from "@openclaw-enterprise/contracts";
import {
  isOpenShellProviderName,
  openShellProviderName,
  openShellWorkspaceName,
  type OpenShellGateway,
} from "../../backends/openshell.ts";
import {
  confirmSandboxAbsent,
  gatewayIdentityRefusal,
  openShellSandboxLogReader,
  openShellSandboxObserver,
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
import { OpenShellServiceTransportError } from "./openshell-service-transport.ts";
import { RUNTIME_WRAPPER_COMMAND } from "../compute/kubernetes/runtime-entrypoints.ts";
import { harnessWorkspacePreparationScript } from "../compute/kubernetes/index.ts";
import { nodeProgramArguments } from "../compute/node-program.ts";
import {
  requireWorkspaceSetupConfiguration,
  WORKSPACE_SETUP_REFUSED_EXIT_STATUS,
  WORKSPACE_SETUP_RUNTIME,
} from "../compute/workspace-setup-runtime.ts";
import {
  COMPUTE_RELEASE_PROFILE,
  HARNESS_EGRESS_ENROLLMENT_PATH,
  harnessEgressEnrollment,
} from "../compute/egress-enrollment.ts";

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
  readonly egress?: OpenShellProxyOptions;
  /** Workspace and readiness policy; the `openshell` Backend owns the gateway connection. */
  readonly gateway: {
    readonly workspaceMode: "managed" | "operator";
    readonly operatorNamespaceLabels?: Readonly<Record<string, string>>;
    readonly readiness?: {
      readonly serviceName: string;
      readonly podSelector: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
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
  readonly openShellGit?: OpenShellGitRuntime;
  readonly operatorOwnedKubernetesResources?: boolean;
  readonly id?: string;
  readonly implementation?: string;
  readonly backend: Backend<OpenShellGateway>;
}

class OpenShellSandboxConfigurationFailure extends Error {}

const GRPC_NOT_FOUND = 5;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_UNAUTHENTICATED = 16;

/**
 * OpenShell's refusal of OCC's own gateway identity during a Namespace step, which the
 * gateway client passes through as the raw gRPC error: retrying cannot help until an
 * operator fixes the identity's token or permissions, so Compute fails the step at once
 * instead of spending attempts on it, and its reason names the gRPC code (finding 1390).
 * UNAVAILABLE and DEADLINE_EXCEEDED keep their retryable gateway failure.
 */
function namespaceRefusal(error: unknown): unknown {
  const record = asRecord(error);
  // grpc-js ServiceError: a numeric status code and a string details field.
  const code = typeof record?.details === "string" ? record.code : undefined;
  const name =
    code === GRPC_PERMISSION_DENIED
      ? "PERMISSION_DENIED"
      : code === GRPC_UNAUTHENTICATED
        ? "UNAUTHENTICATED"
        : undefined;
  return name === undefined
    ? error
    : new SandboxNamespaceRefusedError(
        `OpenShell refused the controller gateway identity with gRPC ${name}.`,
        { cause: error },
      );
}

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
/** OpenShell's supervisor Pod labels (pinned `sandbox_runtime.rs` `control_labels`). */
const OPENSHELL_SANDBOX_ID_LABEL = "openshell.ai/sandbox-id";
const OPENSHELL_BOUNDARY_ROLE_LABEL = "openshell.ai/boundary-role";
const KUBERNETES_LABEL_VALUE = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const OPENSHELL_RUNTIME_ROOT = "/sandbox/.openclaw-runtime";
const OPENSHELL_HOME = `${OPENSHELL_RUNTIME_ROOT}/home`;
const OPENSHELL_WORKSPACE_MOUNTS = "/sandbox/.openclaw-mounts";
const OPENSHELL_WORKSPACE_STATE_DIRECTORY = "state";
// OpenShell probes TMPDIR before the Harness entrypoint can create a nested directory.
const OPENSHELL_TEMPORARY = "/tmp";
/**
 * OpenShell owns the filesystem, network and credential boundary. The Codex bridge selects
 * the explicit full-access profile, subject to native account policy, to avoid nesting a
 * bubblewrap sandbox. Keep human approval through the explicit user reviewer.
 * Recheck against the pinned OpenClaw config-options.ts on upgrades.
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
const RUNTIME_PROFILE_IDS = {
  codex: "oce-codex-runtime",
  openclaw: "oce-openclaw-runtime",
} as const;
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
        `OpenShell v0.1.5 cannot receive secretKeyRef environment ${entry.name}; upstream Secret projection support is required.`,
      );
    }
    // Account claims are opaque data, not paths inside the Harness filesystem.
    result[nonempty(entry.name, "Environment variable name")] =
      entry.name === "OCE_CODEX_CHATGPT_ACCOUNT"
        ? entry.value
        : (workspaceMountPaths.get(entry.value) ??
          entry.value.replaceAll(/\/home\/node(\/|$)/g, `${OPENSHELL_HOME}$1`));
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

// OpenShell replaces the Sandbox runtime whenever the Harness main process exits while the
// Sandbox is active. A signalled Harness exits 0 through tini, so ON_FAILURE would leave it
// down. Stop and delete discard the exit, so the policy never fights a revision shutdown.
// A deleted or evicted Pod is an infrastructure error that OpenShell never restarts.
const SANDBOX_RESTART_POLICY = "SANDBOX_RESTART_POLICY_ALWAYS";
// Adoption compares specs exactly. Sandboxes created before OCC set the policy were stored as
// NEVER (OpenShell normalizes an unset policy), and they stay adoptable for their revision.
// GetSandbox never returns UNSPECIFIED; it and an absent field are accepted defensively.
const ADOPTABLE_RESTART_POLICIES: ReadonlySet<string | number | undefined> = new Set([
  undefined,
  "SANDBOX_RESTART_POLICY_UNSPECIFIED",
  0,
  "SANDBOX_RESTART_POLICY_NEVER",
  1,
  SANDBOX_RESTART_POLICY,
  3,
]);

// A Sandbox in one of these phases never serves the revision again.
const STOPPED_SANDBOX_PHASES: ReadonlySet<string | number> = new Set([
  "SANDBOX_PHASE_STOPPING",
  "SANDBOX_PHASE_STOPPED",
  "SANDBOX_PHASE_COMPLETED",
  6,
  7,
  9,
]);

// GetSandbox phases, by enum name and number, of a Sandbox that no longer serves its
// revision. ERROR covers a deleted or evicted Pod and a failed Harness main process;
// COMPLETED is a Harness main process that exited 0 while the supervisor stays up. Both
// Harness exits now restart (STARTING), except on Sandboxes an older controller stored as NEVER.
const LOST_SANDBOX_PHASES: ReadonlyMap<string | number, SandboxHarnessLostCode> = new Map<
  string | number,
  SandboxHarnessLostCode
>([
  ["SANDBOX_PHASE_ERROR", "SANDBOX_FAILED"],
  [3, "SANDBOX_FAILED"],
  ["SANDBOX_PHASE_DELETING", "SANDBOX_DELETING"],
  [4, "SANDBOX_DELETING"],
  ["SANDBOX_PHASE_STOPPING", "SANDBOX_STOPPED"],
  [6, "SANDBOX_STOPPED"],
  ["SANDBOX_PHASE_STOPPED", "SANDBOX_STOPPED"],
  [7, "SANDBOX_STOPPED"],
  ["SANDBOX_PHASE_COMPLETED", "HARNESS_EXITED"],
  [9, "HARNESS_EXITED"],
]);
const STARTING_SANDBOX_PHASES: ReadonlySet<string | number> = new Set([
  "SANDBOX_PHASE_PROVISIONING",
  1,
  "SANDBOX_PHASE_STARTING",
  8,
]);

/**
 * Maps the revision's own GetSandbox record (or its absence) to a Harness observation.
 * OpenShell also answers NOT_FOUND to conceal a Sandbox from an identity outside its
 * Workspace, so `SANDBOX_MISSING` covers a Workspace OCC can no longer read.
 */
export function harnessObservation(
  sandbox:
    | {
        readonly phase?: string | number;
        readonly exitCode?: number;
        readonly restartCount?: number;
      }
    | undefined,
): SandboxHarnessObservation {
  if (sandbox === undefined) {
    return Object.freeze({ state: "lost", code: "SANDBOX_MISSING" });
  }
  const phase = sandbox.phase ?? "";
  const lost = LOST_SANDBOX_PHASES.get(phase);
  if (lost !== undefined) {
    return Object.freeze({ state: "lost", code: lost });
  }
  if (phase === "SANDBOX_PHASE_READY" || phase === 2) {
    return Object.freeze({ state: "running" });
  }
  // The gateway's own test for a policy restart (`is_automatic_restart_transition`): STARTING
  // with the exited process's code kept and a restart number. A first start, and a Sandbox an
  // operator restarted, clear both, so they stay plain `starting`.
  const { exitCode, restartCount } = sandbox;
  if (
    (phase === "SANDBOX_PHASE_STARTING" || phase === 8) &&
    exitCode !== undefined &&
    Number.isSafeInteger(exitCode) &&
    restartCount !== undefined &&
    Number.isSafeInteger(restartCount) &&
    restartCount > 0
  ) {
    return Object.freeze({
      state: "starting",
      code: "HARNESS_RESTARTING",
      exitCode,
      restarts: restartCount,
    });
  }
  return STARTING_SANDBOX_PHASES.has(phase)
    ? Object.freeze({ state: "starting" })
    : Object.freeze({ state: "unknown" });
}

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

// An exposed Harness port (the Codex app-server, or the port a dedicated OpenClaw
// worker serves a held startup failure on) is authenticated by the transport
// token's verifier only; the raw token never enters the Sandbox.
function harnessTransportVerifier(requirements: HarnessWorkloadRequirements): void {
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
      "OpenShell dedicated Harness exposure requires one literal APP_TOKEN_SHA verifier.",
    );
  }
  if (requirements.environment.some((entry) => entry.name === "APP_SERVER_TOKEN")) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
      "OpenShell dedicated Harness exposure cannot receive APP_SERVER_TOKEN.",
    );
  }
}

// Native OpenClaw exposes its Harness port only when Compute asks for one: a worker
// provisioned before that request keeps its outbound-only Sandbox.
function exposesHarnessPort(requirements: HarnessWorkloadRequirements, codex: boolean): boolean {
  return (
    codex ||
    requirements.environment.some(
      (entry) => entry.name === APP_SERVER_PORT_ENVIRONMENT && !("valueFrom" in entry),
    )
  );
}

interface HarnessRuntimeFiles {
  readonly config: Readonly<Record<string, string>>;
  readonly profile: OpenShellProviderProfile;
}

function harnessRuntimeFiles(
  requirements: HarnessWorkloadRequirements,
  harnessId: keyof typeof RUNTIME_PROFILE_IDS,
  plan?: ProxyPlan,
): HarnessRuntimeFiles {
  const codex = harnessId === "codex";
  const expected = new Map(
    codex
      ? [
          ["runtime.json", PLUGIN_RUNTIME_MANIFEST_ENVIRONMENT],
          ["config.toml", PLUGIN_RUNTIME_CODEX_CONFIG_ENVIRONMENT],
        ]
      : [],
  );
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
      codex
        ? "OpenShell dedicated Codex requires its exact bounded plugin-runtime files."
        : "OpenShell dedicated OpenClaw cannot receive Codex plugin-runtime files.",
    );
  }
  if (codex) {
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
    if (
      !isDeepStrictEqual(
        manifest.egressEnrollment,
        plan === undefined ? undefined : harnessEgressEnrollment(plan),
      ) ||
      (plan !== undefined && manifest.providerTools !== "none")
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "Protected Harness startup must match the admitted egress plan.",
      );
    }
    const selections = configurationObject(manifest.selections, "Codex plugin-runtime selections");
    if (manifest.repositoryBrokerNetworkPolicy !== undefined) {
      throw new SandboxRepositoryRecipientUnverifiedError();
    }
    if (manifest.kind !== "codex" || Object.keys(selections).length !== 0) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "OpenShell dedicated Codex does not yet support selected plugins.",
      );
    }
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
      "OpenShell requires at most one bounded literal workspace-node CA bundle.",
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
    id: RUNTIME_PROFILE_IDS[harnessId],
    displayName: `${codex ? "Codex" : "OpenClaw"} runtime files (OpenClaw Enterprise)`,
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

interface HarnessRuntimeCredentialMaterial {
  readonly credentials: Readonly<Record<string, string>>;
  readonly credentialExpirationTimes: Readonly<Record<string, string>>;
  readonly config: Readonly<Record<string, string>>;
  readonly binding?: WorkspaceNodeBinding;
}

async function harnessRuntimeCredentials(
  context: SandboxHarnessContext,
): Promise<HarnessRuntimeCredentialMaterial> {
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
  const deadline = Date.now() + readiness.timeoutMs;
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
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new OpenShellSandboxConfigurationFailure(unavailable);
    }
    // Check once more at the deadline rather than a whole poll interval past it.
    await delay(Math.min(pollIntervalMs, remaining), undefined, { signal: context.signal });
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
  native: boolean,
  loginMode: HarnessWorkloadRequirements["loginMode"],
  workspaceSetup: HarnessWorkloadRequirements["workspaceSetup"],
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
    `${bootstrap}${native ? 'process.env.TMPDIR = require("node:path").join(process.env.HOME, "tmp");\n' : ""}${workspaceSetup === undefined ? "" : WORKSPACE_SETUP_WAIT}${loginMode === "chatgptAuthTokens" ? OPENSHELL_CHATGPT_AUTH_BOOTSTRAP : ""}${loader}`,
    ...command.slice(loaderIndex + 1),
  ];
}

// OpenShell can report its Sandbox ready before the Harness starts. The Driver
// then sends setup privately over ExecSandbox stdin; the normal Harness verifier
// checks the exact marker identity before any Agent code executes.
const WORKSPACE_SETUP_WAIT = String.raw`{
  const fs = require("node:fs");
  const path = require("node:path");
  const workspace = process.env.OPENCLAW_WORKSPACE_DIR;
  if (!workspace || !path.isAbsolute(workspace)) throw new Error("WORKSPACE_SETUP_FAILED");
  const deadline = Date.now() + 300000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(path.join(workspace, ".oce-workspace-setup.json"))) {
    if (Date.now() >= deadline) throw new Error("WORKSPACE_SETUP_FAILED");
    Atomics.wait(sleeper, 0, 0, 100);
  }
}
`;

// Remote execution can outlive a lost RPC response. Keep the lock across the
// initializer process so a retry cannot race its writes; kernel locks also release
// after a crash. Private document bytes travel only through stdin, never argv.
// The runner's refusal status passes through; any other failure exits 1 (finding 1708).
const WORKSPACE_SETUP_EXEC = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
let lock;
let refused = false;
try {
  const workspace = process.env.OPENCLAW_WORKSPACE_DIR;
  if (!workspace || !path.isAbsolute(workspace)) throw new Error();
  lock = fs.openSync(path.join(workspace, ".oce-workspace-setup.lock"),
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  const stat = fs.fstatSync(lock);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error();
  const acquired = spawnSync("/usr/bin/flock", ["--exclusive", "--timeout", "20", "3"],
    { stdio: ["ignore", "ignore", "ignore", lock], timeout: 25000 });
  if (acquired.error || acquired.status !== 0) throw new Error();
  const result = spawnSync(process.execPath, ["-e", ${JSON.stringify(WORKSPACE_SETUP_RUNTIME)}], {
    input: fs.readFileSync(0),
    env: { ...process.env, OPENCLAW_WORKSPACE_SETUP_PATH: undefined },
    stdio: ["pipe", "ignore", "ignore", lock], timeout: 250000,
  });
  refused = !result.error && result.status === ${WORKSPACE_SETUP_REFUSED_EXIT_STATUS};
  if (result.error || result.status !== 0) throw new Error();
} catch {
  process.exitCode = refused ? ${WORKSPACE_SETUP_REFUSED_EXIT_STATUS} : 1;
} finally {
  if (lock !== undefined) fs.closeSync(lock);
}
`;

// The supervisor supplies the identity-bound placeholder only when it launches the
// workload. Keep that identity in the JWT alias so rotation preserves the binding
// and withdrawal still revokes it. Account claims come from the trusted attachment.
// Use OpenShell's documented alias format; the supervisor replaces the entire JWT
// with the credential. Its claims provide local metadata, not injection authority.
// Withdrawal omits the credential on restart. Let the Harness hold that failure
// through its authenticated status endpoint instead of exiting before its loader.
const OPENSHELL_CHATGPT_AUTH_BOOTSTRAP = String.raw`{
  const placeholder = process.env.CODEX_ACCESS_TOKEN;
  const binding = typeof placeholder === "string"
    ? /^openshell:resolve:env:(s[0-9a-f]{64}_CODEX_ACCESS_TOKEN)$/.exec(placeholder)
    : null;
  if (placeholder !== undefined && binding === null) {
    throw new Error("Codex OAuth requires an OpenShell refresh-managed credential binding.");
  }
  const account = JSON.parse(process.env.OCE_CODEX_CHATGPT_ACCOUNT ?? "null");
  if (!account || typeof account.accountId !== "string" || !account.accountId ||
      typeof account.planType !== "string" || !account.planType) {
    throw new Error("Codex OAuth account metadata is unavailable.");
  }
  if (binding !== null) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = {
      email: account.email,
      "https://api.openai.com/auth": {
        chatgpt_account_id: account.accountId,
        chatgpt_plan_type: account.planType,
        chatgpt_user_id: account.userId,
        chatgpt_account_user_id: account.accountUserId,
        chatgpt_account_is_fedramp: account.isFedramp ?? false,
      },
    };
    process.env.CODEX_ACCESS_TOKEN = encode({ alg: "none", typ: "JWT" }) + "." +
      encode(claims) + ".OPENSHELL-RESOLVE-ENV-" + binding[1];
  }
}
`;

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

function workspacePreparationLabels(revision: Readonly<AgentRevision>): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/namespace": revision.namespaceId,
    "openclaw.dev/agent": revision.agentId,
    "openclaw.dev/revision": revision.id,
    "openclaw.dev/workload-role": "workspace-preparation",
  };
}

async function cleanupNativeWorkspace(
  context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  sandbox: SandboxResourceRef,
  expectedUid?: string,
): Promise<void> {
  const api = kubernetes(context);
  const labels = workspacePreparationLabels(context.revision);
  const resource = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: `${sandbox.resourceName}-workspace`, namespace: sandbox.namespaceName },
  };
  const readOwned = async () => {
    context.signal.throwIfAborted();
    let existing: V1Deployment;
    try {
      existing = await api.read<V1Deployment>(resource);
    } catch (error) {
      if (missingResource(error)) {
        return undefined;
      }
      throw error;
    }
    context.signal.throwIfAborted();
    if (
      existing.metadata?.name !== resource.metadata.name ||
      existing.metadata.namespace !== resource.metadata.namespace ||
      Object.entries(labels).some(([key, value]) => existing.metadata?.labels?.[key] !== value)
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "Refusing to delete a foreign workspace preparation Deployment.",
      );
    }
    const uid = nonempty(existing.metadata.uid, "Workspace preparation Deployment UID");
    if (expectedUid !== undefined && uid !== expectedUid) {
      throw new OpenShellSandboxConfigurationFailure("Workspace preparation Deployment changed.");
    }
    return uid;
  };
  const deadline = Date.now() + 120_000;
  const owned = await readOwned();
  if (owned !== undefined) {
    expectedUid = owned;
    context.signal.throwIfAborted();
    try {
      await api.delete(resource, undefined, undefined, undefined, undefined, "Foreground", {
        preconditions: { uid: owned },
      });
    } catch (error) {
      // Another cleanup may already have removed this exact Deployment.
      if (!missingResource(error)) {
        throw error;
      }
    }
  }
  for (;;) {
    const remaining = await readOwned();
    const pods = await api.list(
      "v1",
      "Pod",
      sandbox.namespaceName,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector(labels),
    );
    context.signal.throwIfAborted();
    // A missing Deployment is not enough: orphaned or terminating Pods can still
    // write the PVC. Never delete Pods directly or accept a same-name replacement.
    if (remaining === undefined && pods.items.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new OpenShellSandboxConfigurationFailure("Workspace preparation did not stop.");
    }
    await delay(1_000, undefined, { signal: context.signal });
  }
}

// TODO(openshell-private-subpath-preparation): Remove if OpenShell adds support for preparing private subpaths
// and OCE adopts that support.
// Use existing Deployment permissions; never grant OCC direct Pod creation for this.
async function prepareNativeWorkspace(
  context: SandboxHarnessContext,
  options: OpenShellSandboxDriverOptions,
  sandbox: SandboxResourceRef,
): Promise<void> {
  if (options.kubernetes.userNamespaces !== false) {
    throw new OpenShellSandboxConfigurationFailure(
      "Temporary native workspace preparation requires userNamespaces: false.",
    );
  }
  const api = kubernetes(context);
  const namespace = await api.read({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: sandbox.namespaceName },
  });
  // Match the pinned OpenShell driver's namespace-derived runtime identity.
  const annotations = namespace.metadata?.annotations ?? {};
  const rangeStart = (value: string | undefined) => {
    if (value === undefined) {
      return undefined;
    }
    const first = value.split(",")[0]!.split("/")[0]!;
    if (!/^\d+$/u.test(first) || !Number.isSafeInteger(Number(first))) {
      throw new OpenShellSandboxConfigurationFailure("Invalid namespace runtime identity range.");
    }
    return Number(first);
  };
  const uid = rangeStart(annotations["openshift.io/sa.scc.uid-range"]) ?? 10001;
  const gid = uid;
  if (uid < 1 || gid < 1) {
    throw new OpenShellSandboxConfigurationFailure("Workspace preparation requires non-root IDs.");
  }
  const accounts = (options.gateway.operatorWorkspaceResources ?? []).filter(
    (resource) => resource.kind === "ServiceAccount",
  );
  if (accounts.length > 1) {
    throw new OpenShellSandboxConfigurationFailure(
      "OpenShell workspace requires one Sandbox ServiceAccount.",
    );
  }
  const data = sandboxDataMount(options, context.requirements);
  const workspace = workspaceVolumeMounts(context.requirements, data, context.revision.id);
  const claims = [
    ...new Set(workspace.mounts.filter((mount) => !mount.read_only).map((mount) => mount.name)),
  ];
  const paths = workspace.mounts
    .filter((mount) => !mount.read_only)
    .map((mount) => `/workspace-preparation/${mount.name}/${mount.sub_path}`);
  const name = `${sandbox.resourceName}-workspace`;
  const labels = workspacePreparationLabels(context.revision);
  const program = `{
    const fs = require("node:fs");
    for (const path of ${JSON.stringify(paths)}) {
      let current = "";
      for (const component of path.split("/").filter(Boolean)) {
        current += "/" + component;
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) throw new Error("Preparation refuses non-directory ancestors.");
      }
    }
  }
  ${harnessWorkspacePreparationScript(paths)}
  {
    const fs = require("node:fs");
    for (const path of ${JSON.stringify(paths)}) {
      const stat = fs.lstatSync(path);
      const saved = require("node:path").join(require("node:path").dirname(path),
        "." + require("node:path").basename(path) + ".kubelet-created");
      if (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700 ||
          fs.lstatSync(saved, { throwIfNoEntry: false })) {
        throw new Error("Private workspace preparation did not complete.");
      }
    }
    fs.writeFileSync("/preparation-status/ready", "ready");
    setInterval(() => {}, 1000);
  }`;
  const podSpec = {
    restartPolicy: "Always",
    automountServiceAccountToken: false,
    serviceAccountName: nonempty(
      context.requirements.workloadIdentity?.serviceAccountName ??
        asRecord(accounts[0]?.metadata)?.name ??
        "openshell-sandbox",
      "OpenShell Sandbox ServiceAccount",
    ),
    runtimeClassName: options.kubernetes.runtimeClassName,
    securityContext: {
      runAsUser: uid,
      runAsGroup: gid,
      runAsNonRoot: true,
      fsGroup: gid,
      fsGroupChangePolicy: "OnRootMismatch",
      seccompProfile: { type: "RuntimeDefault" },
    },
    containers: [
      {
        name: "prepare",
        image: context.requirements.image,
        command: ["node", "-e", program],
        readinessProbe: {
          exec: {
            command: ["node", "-e", 'require("node:fs").accessSync("/preparation-status/ready")'],
          },
          initialDelaySeconds: 1,
          periodSeconds: 1,
        },
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        },
        resources: {
          requests: { cpu: "10m", memory: "64Mi" },
          limits: { cpu: "500m", memory: "256Mi" },
        },
        volumeMounts: [
          ...claims.map((claim) => ({ name: claim, mountPath: `/workspace-preparation/${claim}` })),
          { name: "preparation-status", mountPath: "/preparation-status" },
        ],
      },
    ],
    volumes: [
      ...workspace.volumes
        .filter((volume) => claims.includes(volume.name))
        .map((volume) => ({
          name: volume.name,
          persistentVolumeClaim: { claimName: volume.persistent_volume_claim.claim_name },
        })),
      { name: "preparation-status", emptyDir: { sizeLimit: "1Mi" } },
    ],
  };
  const resource = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: sandbox.namespaceName, labels },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: labels },
      template: { metadata: { labels }, spec: podSpec },
    },
  };
  let existing: V1Deployment | undefined;
  try {
    existing = await api.read<V1Deployment>(resource);
  } catch (error) {
    if (!missingResource(error)) {
      throw error;
    }
  }
  if (existing === undefined) {
    existing = await api.create<V1Deployment>(resource);
  } else {
    // Kubernetes reads contain SDK model instances and unset optional fields.
    // Compare their JSON content without weakening the ownership or spec checks.
    const observed = asRecord(JSON.parse(JSON.stringify(existing.spec?.template?.spec ?? {})));
    const expected = asRecord(podSpec)!;
    const observedContainer = asRecord((observed?.containers as unknown[])?.[0]);
    const expectedContainer = asRecord((expected.containers as unknown[])[0]);
    const observedSecurity = asRecord(observed?.securityContext);
    if (
      Object.entries(labels).some(([key, value]) => existing!.metadata?.labels?.[key] !== value) ||
      existing.spec?.replicas !== 1 ||
      existing.spec.strategy?.type !== "Recreate" ||
      !isDeepStrictEqual(existing.spec.selector.matchLabels, labels) ||
      !isDeepStrictEqual(existing.spec.template.metadata?.labels, labels) ||
      observed?.initContainers !== undefined ||
      (observed?.containers as unknown[])?.length !== 1 ||
      observedContainer?.image !== expectedContainer?.image ||
      observedContainer?.env !== undefined ||
      observedContainer?.envFrom !== undefined ||
      !isDeepStrictEqual(
        asRecord(observedContainer?.readinessProbe)?.exec,
        asRecord(expectedContainer?.readinessProbe)?.exec,
      ) ||
      !isDeepStrictEqual(observedContainer?.securityContext, expectedContainer?.securityContext) ||
      observed?.runtimeClassName !== expected.runtimeClassName ||
      !isDeepStrictEqual(observedContainer?.volumeMounts, expectedContainer?.volumeMounts) ||
      observed?.serviceAccountName !== expected.serviceAccountName ||
      observed?.automountServiceAccountToken !== false ||
      !isDeepStrictEqual(observedSecurity, expected.securityContext) ||
      !isDeepStrictEqual(
        asRecord((observed?.containers as unknown[])?.[0])?.command,
        asRecord((expected.containers as unknown[])[0])?.command,
      ) ||
      !isDeepStrictEqual(observed?.volumes, expected.volumes)
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "Refusing a foreign workspace preparation Deployment.",
      );
    }
  }
  const preparationUid = nonempty(existing.metadata?.uid, "Workspace preparation Deployment UID");
  const deadline = Date.now() + 120_000;
  let preparationFailure: unknown;
  try {
    for (;;) {
      if (
        existing.status?.availableReplicas === 1 &&
        existing.status.observedGeneration === existing.metadata?.generation
      ) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new OpenShellSandboxConfigurationFailure(
          `Native workspace preparation ${name} did not complete.`,
        );
      }
      await delay(1_000, undefined, { signal: context.signal });
      existing = await api.read<V1Deployment>(resource);
    }
  } catch (error) {
    preparationFailure = error;
  }
  await cleanupNativeWorkspace(context, sandbox, preparationUid);
  if (preparationFailure !== undefined) {
    throw preparationFailure;
  }
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

function gitRouteOverlapMessage({ name, host, ipAddress }: OpenShellGitPolicyOverlap): string {
  const rule = host === "" ? name : `${name} (${host})`;
  return ipAddress
    ? `OpenShell Git reaches GitHub only through its middleware route, and an IP address may lead there, so an Agent with a repository binding cannot allow one: remove ${rule}.`
    : `OpenShell Git reaches github.com and its subdomains only through its middleware route, so an Agent with a repository binding cannot also allow them: remove ${rule}.`;
}

function assertNoRepositoryEnrollment(
  context: SandboxHarnessContext,
  runtime?: OpenShellGitRuntime,
): void {
  const { requirements, revision } = context;
  if (
    (revision.repositoryCredentials !== undefined && runtime === undefined) ||
    "repositorySession" in requirements ||
    requirements.environment.some(({ name }) => name === "OPENCLAW_REPOSITORY_ENROLLMENT")
  ) {
    throw new SandboxRepositoryRecipientUnverifiedError();
  }
}

function sandboxSpec(
  options: OpenShellSandboxDriverOptions,
  revision: Readonly<AgentRevision>,
  requirements: HarnessWorkloadRequirements,
  runtimeProvider?: string,
  providerEnvironment: ReadonlySet<string> = new Set(),
  workspaceNodeBinding?: WorkspaceNodeBinding,
  egressPolicy?: Readonly<Record<string, unknown>>,
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
      ...(egressPolicy && { network_middlewares: egressPolicy.network_middlewares }),
      network_policies: {
        // A protected execution keeps the exact policy and model attachment verified before provisioning.
        ...(egressPolicy
          ? asRecord(egressPolicy.network_policies)
          : (revision.sandboxPolicy?.defaults ?? networkPolicies(options))),
        ...(egressPolicy
          ? {}
          : openShellAgentNetworkRules(revision.sandboxPolicy?.additions ?? [])),
        ...(runtimeProvider === undefined || workspaceNodeBinding === undefined
          ? {}
          : workspaceNodeNetworkPolicy(workspaceNodeBinding)),
      },
    },
    providers: sandboxProviders(options, requirements, runtimeProvider),
    command: sandboxCommand(
      requirements.command,
      workspace.links,
      revision.harness.id === "openclaw",
      requirements.loginMode,
      requirements.workspaceSetup,
    ),
    restart_policy: SANDBOX_RESTART_POLICY,
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
    if (
      !Number.isSafeInteger(options.gateway.readiness.timeoutMs) ||
      options.gateway.readiness.timeoutMs < 1
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell gateway readiness timeout must be a positive safe integer.",
      );
    }
    const pollIntervalMs = options.gateway.readiness.pollIntervalMs;
    if (
      pollIntervalMs !== undefined &&
      (!Number.isSafeInteger(pollIntervalMs) ||
        pollIntervalMs < 1 ||
        pollIntervalMs > MAX_TIMER_DELAY_MS)
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell gateway readiness poll interval must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}.`,
      );
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
  const networkPolicyNames = new Set<string>();
  for (const [index, policy] of options.policy.networkPolicies.entries()) {
    const name = nonempty(policy.name, "OpenShell network policy name");
    if (name === "workspace-node-enrollment") {
      throw new ConfigurationValidationError([
        {
          path: `/policy/networkPolicies/${index}/name`,
          code: "INVALID_VALUE",
          message: "This policy name is reserved for platform networking.",
        },
      ]);
    }
    if (networkPolicyNames.has(name)) {
      throw new ConfigurationValidationError([
        {
          path: `/policy/networkPolicies/${index}/name`,
          code: "INVALID_VALUE",
          message: "Network policy names must be unique.",
        },
      ]);
    }
    networkPolicyNames.add(name);
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
    gateway: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceMode: { type: "string", enum: ["managed", "operator"] },
        operatorNamespaceLabels: { type: "object" },
        operatorWorkspaceResources: { type: "array" },
        networkPolicyResources: { type: "array" },
        readiness: {
          type: "object",
          required: ["serviceName", "podSelector", "timeoutMs"],
          properties: {
            serviceName: { type: "string" },
            podSelector: { type: "object" },
            timeoutMs: { type: "integer", minimum: 1 },
            // A Node.js timer fires a longer delay after 1 ms.
            pollIntervalMs: { type: "integer", minimum: 1, maximum: MAX_TIMER_DELAY_MS },
          },
        },
      },
    },
    kubernetes: {
      type: "object",
      properties: {
        serviceAccount: { type: "object", properties: { mode: { const: "gatewayConfigured" } } },
      },
    },
    policy: {
      type: "object",
      properties: {
        landlockCompatibility: { const: "hard_requirement" },
        networkPolicies: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "binaries", "endpoints"],
            properties: {
              name: { type: "string" },
              binaries: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["path"],
                  properties: { path: { type: "string" } },
                },
              },
              endpoints: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["host", "ports"],
                  properties: {
                    host: { type: "string" },
                    ports: { type: "array", items: { type: "integer" } },
                    protocol: { type: "string" },
                    tls: { type: "string", enum: Object.keys(NETWORK_TLS_MODES) },
                    enforcement: { type: "string", enum: Object.keys(NETWORK_ENFORCEMENT_MODES) },
                    access: { type: "string", enum: Object.keys(NETWORK_ACCESS_PRESETS) },
                  },
                },
              },
            },
          },
        },
      },
    },
    sandboxNamePrefix: { type: "string" },
    startupDelayMs: { type: "integer", minimum: 1, maximum: MAX_SANDBOX_STARTUP_DELAY_MS },
    logLevel: { type: "string" },
    providers: { type: "array", items: { type: "string" } },
    egress: { type: "object" },
  },
});

/**
 * Static operator providers plus every Credential Gateway attachment. An attachment this
 * Backend did not issue, or one that shadows a static provider, fails provisioning.
 */
function protectedEgressPolicy(
  options: OpenShellSandboxDriverOptions,
  requirements: HarnessWorkloadRequirements,
): Readonly<Record<string, unknown>> {
  const attachment = requirements.proxyWiring;
  const auth = attachment?.plan.harnessCredentialSource;
  const [model] = requirements.credentialAttachments;
  if (
    !attachment ||
    !options.egress ||
    (auth
      ? !attachment.plan.repositoryGit ||
        requirements.credentialAttachments.length !== 1 ||
        requirements.loginMode !== auth.loginMode ||
        model?.sourceId !== auth.sourceId ||
        model.ref !== openShellProviderName(auth.sourceId)
      : requirements.credentialAttachments.length !== 0) ||
    (options.providers?.length ?? 0) !== 0
  ) {
    throw new OpenShellSandboxConfigurationFailure(
      "Protected egress requires its exact paired policy and only the admitted Harness credential attachment.",
    );
  }
  const expected = openShellEgressConfiguration(attachment.plan, options.egress);
  if (!isDeepStrictEqual(attachment.configuration, expected)) {
    throw new OpenShellSandboxConfigurationFailure("Protected egress attachment was altered.");
  }
  return expected;
}

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
        "The Harness runtime provider conflicts with another requested provider.",
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
  // The Gateway assigns this epoch. Git continuity verifies it against the supervisor receipt.
  const { provider_attachment_epoch: _epoch, restart_policy: restartPolicy, ...rest } = spec;
  return {
    ...withoutSyntheticOneofs(rest),
    ...(spec.policy === undefined ? {} : { policy: canonicalProtobufValues(spec.policy) }),
    ...(ADOPTABLE_RESTART_POLICIES.has(restartPolicy as string | number | undefined)
      ? {}
      : { restart_policy: restartPolicy }),
    template: {
      ...withoutSyntheticOneofs(template),
      driver_config: canonicalProtobufValues(template.driver_config),
    },
  };
}

function verifyRuntimeProvider(
  provider: OpenShellProviderResponse,
  name: string,
  profileId: string,
  expectedLabels: Readonly<Record<string, string>>,
  expectedConfig?: Readonly<Record<string, string>>,
): void {
  if (
    provider.name !== name ||
    provider.type !== profileId ||
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
  profileId: string,
  expectedLabels: Readonly<Record<string, string>>,
  expectedConfig: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  verifyRuntimeProvider(provider, name, profileId, expectedLabels);
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

function checkStartupConfiguration(configuration: unknown): void {
  const options = asRecord(configuration);
  if (options === undefined) {
    throw new OpenShellSandboxConfigurationFailure("OpenShell configuration is required.");
  }
  validateOptions(options as unknown as OpenShellSandboxDriverOptions);
}

export function validateConfiguration(
  configuration: Readonly<OpenShellSandboxDriverOptions>,
): readonly ErrorDetail[] {
  try {
    checkStartupConfiguration(configuration);
    return [];
  } catch (error) {
    return error instanceof ConfigurationValidationError
      ? error.error.details
      : [
          {
            path: "",
            code: "INVALID_VALUE",
            message: "Configuration violates the Driver's constraints.",
          },
        ];
  }
}

export const configurationContributions = Object.freeze([SandboxNetworkPolicyConfiguration]);

export class OpenShellSandboxDriver implements SandboxDriver {
  static readonly configurationSchema = configurationSchema;

  readonly id: string;
  readonly capability = "sandbox" as const;
  readonly implementation: string;
  readonly facets = Object.freeze(["networking", "filesystem", "process"] as const);
  // environment() sets HOME to this for every Sandbox it creates.
  readonly harnessHome = OPENSHELL_HOME;
  static readonly configurationContributions = configurationContributions;
  readonly networkPolicy = Object.freeze({ wildcards: true, portRanges: true, live: true });
  private readonly options: OpenShellSandboxDriverOptions;
  private readonly backend: Backend<OpenShellGateway>;
  private readonly operatorOwnedKubernetesResources: boolean;
  private readonly openShellGit: OpenShellGitRuntime | undefined;
  readonly repositoryAccess?: NonNullable<SandboxDriver["repositoryAccess"]>;

  static validateConfiguration(
    configuration: Readonly<OpenShellSandboxDriverOptions>,
  ): readonly ErrorDetail[] {
    return validateConfiguration(configuration);
  }

  constructor(options: OpenShellSandboxDriverOptions, selection: OpenShellSandboxDriverSelection) {
    requireConfiguration(OpenShellSandboxDriver, options);
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
    const git = selection.openShellGit;
    this.openShellGit = git;
    if (git) {
      this.repositoryAccess = openShellRepositoryAccess(git, (context) =>
        this.standingGitExecution(context),
      );
    }
    // Fail at startup, not at the first Agent deploy (finding 2131).
    const overlapping = this.openShellGit?.overlappingPolicy(options.policy.networkPolicies);
    if (overlapping?.ipAddress === true) {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell Git reaches GitHub only through its middleware route, and an IP address may lead there; use a DNS name instead of ${overlapping.host} in sandbox network policy ${overlapping.name}.`,
      );
    }
    if (overlapping !== undefined) {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell Git reaches github.com and its subdomains only through its middleware route; remove those hosts from sandbox network policy ${overlapping.name}.`,
      );
    }
    this.backend = selection.backend;
    this.operatorOwnedKubernetesResources = selection.operatorOwnedKubernetesResources === true;
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
    if (harness.id !== "openclaw" && harness.id !== "codex") {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell SandboxDriver does not support the selected Harness runtime.",
      );
    }
    const agents = optionalAgentConfiguration(
      configuration.agents,
      "OpenShell Agent configuration",
    );
    const defaults = optionalAgentConfiguration(agents.defaults, "OpenShell Agent defaults");
    const workspace = this.options.kubernetes.sandboxDataMount.mountPath;
    // Both Harnesses and private initialization use this mount. The main entry wins over
    // defaults in OpenClaw and the Gateway, so pin both before admission freezes the config.
    const configured = {
      ...configuration,
      agents: {
        ...agents,
        defaults: { ...defaults, workspace },
        ...(agents.entries === undefined
          ? {}
          : { entries: pinMainAgentWorkspace(agents.entries, workspace) }),
      },
    };
    if (harness.id === "openclaw") {
      return configured;
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
    // OpenShell's egress policy is the network boundary. An enabled Codex network proxy wins
    // over the full-access profile in the bridge and selects a restricted native profile, which
    // needs the nested namespaces OpenShell blocks, so shell turns fail. Drop it rather than
    // refuse it, like the sandbox pin: status reads rerun this hook on stored work.
    const { networkProxy: _networkProxy, ...openShellAppServer } = appServer;

    return {
      ...configured,
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
                ...openShellAppServer,
                ...OPENSHELL_CODEX_APP_SERVER_POLICY,
              },
            },
          },
        },
      },
    };
  }

  validateWorkspaceSetup(
    harness: Readonly<AgentRevision["harness"]>,
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): void {
    if (harness.mode !== "dedicated" || (harness.id !== "codex" && harness.id !== "openclaw")) {
      throw new ConfigurationHarnessError(
        "OpenShell initial workspace files require a dedicated Codex or OpenClaw Harness.",
      );
    }
    requireWorkspaceSetupConfiguration(
      configuration,
      [this.options.kubernetes.sandboxDataMount.mountPath],
      (setting, requirement) =>
        new ConfigurationHarnessError(configurationSettingMessage(setting, requirement)),
    );
  }

  async ensureNamespace(context: SandboxNamespaceContext): Promise<void> {
    try {
      await this.ensureNamespaceWorkspace(context);
    } catch (error) {
      throw namespaceRefusal(error);
    }
  }

  private async ensureNamespaceWorkspace(context: SandboxNamespaceContext): Promise<void> {
    this.requireOperatorWorkspaceMode("ensure a Namespace");
    const namespace = namespaceName(context.namespace);
    if (this.operatorOwnedKubernetesResources) {
      const api = kubernetes(context);
      const observed = await api.read({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespace },
      });
      for (const [key, value] of Object.entries(
        this.options.gateway.operatorNamespaceLabels ?? {},
      )) {
        if (observed.metadata?.labels?.[key] !== value) {
          throw new OpenShellSandboxConfigurationFailure(
            "Operator Namespace labels do not match the OpenShell configuration.",
          );
        }
      }
      for (const resource of [
        ...(this.options.gateway.operatorWorkspaceResources ?? []),
        ...(this.options.gateway.networkPolicyResources ?? []),
      ]) {
        const expected = withNamespace(resource, context);
        const actual = await api.read(resourceReference(resource, namespace));
        const authorityFields = (value: KubernetesObject) =>
          Object.fromEntries(
            Object.entries(value).filter(
              ([key, field]) => key !== "metadata" && key !== "status" && field !== undefined,
            ),
          );
        const observedFields = authorityFields(actual);
        if (actual.kind === "NetworkPolicy" && Object.hasOwn(observedFields, "spec")) {
          observedFields.spec = networkPolicySpecToJson(observedFields.spec as V1NetworkPolicySpec);
        }
        if (
          // SDK models carry prototypes; compare their full JSON content with the wire manifest.
          !isDeepStrictEqual(
            JSON.parse(JSON.stringify(observedFields)),
            authorityFields(expected),
          ) ||
          actual.metadata?.name !== expected.metadata?.name ||
          actual.metadata?.namespace !== namespace
        ) {
          throw new OpenShellSandboxConfigurationFailure(
            "Operator workspace resource does not match the OpenShell configuration.",
          );
        }
        for (const key of ["labels", "annotations"] as const) {
          for (const [name, value] of Object.entries(expected.metadata?.[key] ?? {})) {
            if (actual.metadata?.[key]?.[name] !== value) {
              throw new OpenShellSandboxConfigurationFailure(
                "Operator workspace resource ownership does not match.",
              );
            }
          }
        }
        if (
          actual.metadata?.deletionTimestamp ||
          (actual.kind === "ServiceAccount" &&
            Object.keys(actual.metadata?.annotations ?? {}).some(
              (key) =>
                !Object.hasOwn(expected.metadata?.annotations ?? {}, key) &&
                key !== "meta.helm.sh/release-name" &&
                key !== "meta.helm.sh/release-namespace",
            ))
        ) {
          throw new OpenShellSandboxConfigurationFailure(
            "Operator workspace resource is terminating or has unexpected credential configuration.",
          );
        }
      }
    } else {
      await applyOperatorNamespaceLabels(context, this.options.gateway.operatorNamespaceLabels);
      await applyResources(context, this.options.gateway.operatorWorkspaceResources);
      await applyResources(context, this.options.gateway.networkPolicyResources);
    }
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
    assertNoRepositoryEnrollment(context, this.openShellGit);
    this.requireOperatorWorkspaceMode("provision a Harness");
    if (!isDeepStrictEqual(context.requirements.proxyWiring?.plan, context.revision.egressPlan)) {
      throw new OpenShellSandboxConfigurationFailure(
        "Protected egress attachment must match the admitted revision.",
      );
    }
    // Finding 2053: a protected Sandbox keeps only its protected egress policy. OCC admission
    // refuses Agent network policy additions for it; refuse any that reach here, never drop them.
    if (
      context.requirements.proxyWiring !== undefined &&
      (context.revision.sandboxPolicy?.additions.length ?? 0) > 0
    ) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "Protected execution keeps only its protected egress policy; this revision carries Agent network policy additions.",
      );
    }
    const plan = context.revision.egressPlan;
    if (
      plan?.harnessCredentialSource &&
      !isDeepStrictEqual(plan.harnessCredentialSource, context.revision.harnessAuth)
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "The protected repository execution must retain its admitted Harness credential source.",
      );
    }
    const egressPolicy = plan && protectedEgressPolicy(this.options, context.requirements);
    if (plan !== undefined && context.revision.harness.id !== "codex") {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "Protected inference startup enrollment requires the dedicated Codex Harness.",
      );
    }
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
        "OpenShell v0.1.5 cannot preserve an Agent ServiceAccount and projected identity token; disable ServicePrincipal credentials or select another Sandbox Driver.",
      );
    }
    labels(context.requirements.labels, "Harness workload labels");
    const sandbox = this.sandboxRef(context);
    const codex = context.revision.harness.id === "codex";
    const client = this.gatewayClientForNamespace(sandbox.namespaceName);
    const workspace = workspaceName(context.namespace);
    // Backstop for the admission check (finding 2144): the revision's own policy is immutable,
    // so a retry cannot clear an overlap.
    const gitOverlap =
      context.revision.repositoryCredentials === undefined ||
      context.requirements.proxyWiring !== undefined
        ? undefined
        : this.gitRouteOverlap(
            context.revision.sandboxPolicy?.defaults ?? networkPolicies(this.options),
            context.revision.sandboxPolicy?.additions ?? [],
          );
    if (gitOverlap !== undefined) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        gitRouteOverlapMessage(gitOverlap),
      );
    }
    const git =
      context.revision.repositoryCredentials === undefined
        ? undefined
        : await this.openShellGit!.prepare(
            context.revision,
            client,
            workspace,
            sandbox.resourceName,
            context.signal,
            sandboxProviders(this.options, context.requirements),
            this.options.policy.networkPolicies.flatMap((policy) =>
              policy.endpoints.map((endpoint) => endpoint.host),
            ),
          );
    if (git && context.requirements.proxyWiring && !context.revision.egressPlan?.repositoryGit) {
      throw new OpenShellSandboxConfigurationFailure(
        "OpenShell Git cannot share the protected execution proxy profile.",
      );
    }
    const exposed = exposesHarnessPort(context.requirements, codex);
    if (exposed) {
      harnessTransportVerifier(context.requirements);
    }
    const runtimeFiles = harnessRuntimeFiles(
      context.requirements,
      codex ? "codex" : "openclaw",
      context.revision.egressPlan,
    );
    const runtimeCredentialMaterial = await harnessRuntimeCredentials(context);
    await this.ensureRuntimeProfile(client, workspace, runtimeFiles.profile, context.signal);
    const { name: runtimeProvider } = await this.ensureRuntimeProvider(
      client,
      workspace,
      context,
      runtimeFiles.profile.id,
      { ...runtimeFiles.config, ...runtimeCredentialMaterial.config },
      runtimeCredentialMaterial.credentials,
      runtimeCredentialMaterial.credentialExpirationTimes,
    );
    const serviceExposures = exposed
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
          // Only the attached provider supplies its identity-bound credential alias.
          // A static placeholder would survive withdrawal and shadow its absence.
          ...(context.requirements.loginMode === "chatgptAuthTokens" ? ["CODEX_ACCESS_TOKEN"] : []),
          ...Object.keys(runtimeCredentialMaterial.credentials),
          ...(git ? ["GITHUB_TOKEN"] : []),
        ]),
        runtimeCredentialMaterial.binding,
        egressPolicy,
      ),
      serviceExposures,
    };
    if (git) {
      create.spec.providers.push(git.provider);
      Object.assign(
        create.spec.environment,
        Object.fromEntries(git.environment.map(({ name, value }) => [name, value])),
      );
      if (context.revision.egressPlan?.repositoryGit) {
        const policy = asRecord(create.spec.policy.network_middlewares);
        if (!isDeepStrictEqual(policy?.["oce-prepared-git"], git.middlewares["oce-prepared-git"])) {
          throw new OpenShellSandboxConfigurationFailure(
            "Git middleware differs from its protected admission.",
          );
        }
      } else {
        Object.assign(create.spec.policy, { network_middlewares: git.middlewares });
      }
      const readOnly = create.spec.policy.filesystem.read_only;
      readOnly.push(...git.readOnlyPaths.filter((path) => !readOnly.includes(path)));
      create.spec.restart_policy = "SANDBOX_RESTART_POLICY_NEVER";
      const continuity = this.gitContinuity(context);
      // Only the independent model attachment selected by this revision can survive Git expiry.
      const auth = context.revision.harnessAuth;
      const originalModel =
        auth?.method === "credential_source" &&
        context.requirements.credentialAttachments.some(
          (a) => a.sourceId === auth.sourceId && a.ref === continuity?.model,
        );
      await this.openShellGit!.bind(
        context.revision.id,
        (observed) => verifyExistingSandbox(observed, { ...create, requestId: requestIds[0]! }),
        originalModel ? continuity : undefined,
      );
    }
    const prepared = context.requirements.proxyWiring;
    const result = immutableCopy({
      ...sandbox,
      ...(prepared === undefined
        ? {}
        : {
            proxyWiring: {
              plan: prepared.plan,
              configuration: create.spec.policy,
            },
          }),
    });
    // Every reconcile pass reaches here. Re-sending CreateSandbox for a Sandbox that
    // exists would hit the gateway's request_id replay, which refuses a changed spec
    // (REQUEST_ID_PAYLOAD_MISMATCH) and forgets the create after 24 h (ALREADY_EXISTS).
    // GetSandbox also answers NOT_FOUND for a Sandbox this identity may not see (finding
    // 1676). That is safe here without a Workspace read: nothing is recorded as gone, and
    // CreateSandbox keeps PERMISSION_DENIED for a non-member, so a hidden Sandbox is neither
    // adopted nor created over; the create fails with SANDBOX_GATEWAY_UNAUTHORIZED below.
    const refused = gatewayIdentityRefusal(
      workspace,
      `Sandbox ${sandbox.resourceName} cannot be created or adopted`,
    );
    let existing = await refused(() => client.getSandbox(selector, context.signal));
    if (git?.existingSandboxId && existing?.id !== git.existingSandboxId) {
      throw new OpenShellSandboxConfigurationFailure(
        "The standing Git execution is no longer present.",
      );
    }
    if (!codex && existing === undefined) {
      await prepareNativeWorkspace(context, this.options, sandbox);
    }
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
        created = await refused(() =>
          client.createSandbox({ ...create, requestId: requestIds[attempt]! }, context.signal),
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
        if (exposed) {
          validateHarnessServiceUrl(created.serviceUrls[""]);
          if (!codex && context.workspaceNodeEnrolled === true) {
            // A Sandbox created again after the node enrolled (the stale one was removed)
            // gets the exposure its immutable request carries and loses it at once: nothing
            // of Compute's listens there any more (finding 1657).
            await this.withdrawNativeExposure(
              client,
              workspace,
              sandbox.resourceName,
              context.signal,
            );
          }
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
        await this.initializeWorkspace(context, sandbox, client);
        return result;
      }
      existing = await refused(() => client.getSandbox(selector, context.signal));
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
    if (exposed && !codex && context.workspaceNodeEnrolled === true) {
      // The worker's node has enrolled: Compute reads nothing more through the exposure,
      // so a Sandbox adopted after enrollment is without it (finding 1657). A withdrawal
      // the enrolling pass could not finish is completed here.
      await this.withdrawNativeExposure(client, workspace, sandbox.resourceName, context.signal);
    } else if (exposed) {
      // The spec match above already proves the live Sandbox was created with this
      // exposure, so a missing service is an anomaly, not an older Sandbox.
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
    await this.initializeWorkspace(context, sandbox, client);
    return result;
  }

  /** OpenShell labels the supervisor and workload Pods as one boundary pair. Keep both
   * exact Pod UIDs, container IDs and restart counts, not just the aggregate Ready status. */
  private gitContinuity(context: SandboxNamespaceContext & { revision: Readonly<AgentRevision> }) {
    const { revision } = context;
    const auth = revision.harnessAuth;
    // Never substitute the runtime-files provider: it confers no independent inference authority.
    const plan = revision.egressPlan;
    const retained =
      auth?.method === "credential_source" &&
      (!plan || (plan.repositoryGit && isDeepStrictEqual(plan.harnessCredentialSource, auth))) &&
      openShellProviderName(auth.sourceId);
    if (
      !retained ||
      revision.namespaceId !== context.namespace.id ||
      revision.sandboxDriverId !== this.id
    ) {
      return;
    }
    const namespace = namespaceName(context.namespace);
    return {
      model: retained,
      workload: async (sandboxId: string, signal: AbortSignal) => {
        if (!sandboxId || !KUBERNETES_LABEL_VALUE.test(sandboxId)) {
          return;
        }
        const key = "openshell.ai/boundary-pair";
        const pair = sandboxId.toLowerCase();
        const { items, metadata } = await kubernetes(context).list<V1Pod>(
          "v1",
          "Pod",
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          labelSelector({ [key]: pair }),
        );
        signal.throwIfAborted();
        if (items.length !== 2 || metadata?._continue || metadata?.remainingItemCount) {
          return;
        }
        const identities = [];
        for (const role of ["supervisor", "workload"]) {
          const pod = items.find(
            (p) => p.metadata?.labels?.[OPENSHELL_BOUNDARY_ROLE_LABEL] === role,
          );
          const m = pod?.metadata;
          const labels = m?.labels;
          const cs = pod?.status?.containerStatuses;
          if (
            !pod ||
            !m?.uid ||
            !m.name ||
            m.namespace !== namespace ||
            m.deletionTimestamp ||
            labels?.[key] !== pair ||
            pod.status?.phase !== "Running" ||
            !pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True") ||
            !(role === "supervisor"
              ? labels[OPENSHELL_SANDBOX_ID_LABEL] === sandboxId
              : labels["openclaw.dev/revision"] === revision.id &&
                labels["openclaw.dev/agent"] === revision.agentId) ||
            !cs?.length ||
            cs.some(
              (c) =>
                !c.name || !c.ready || c.restartCount !== 0 || !c.state?.running || !c.containerID,
            )
          ) {
            return;
          }
          identities.push([
            role,
            m.name,
            m.uid,
            cs.map((c) => [c.name, c.containerID, c.restartCount]),
          ]);
        }
        return JSON.stringify([namespace, revision.id, identities]);
      },
    };
  }

  /** The existing launch and Pod identities for a read-only standing execution check. */
  standingGitExecution(context: SandboxNamespaceContext & { revision: Readonly<AgentRevision> }) {
    this.requireOperatorWorkspaceMode("observe standing repository execution");
    const continuity = this.gitContinuity(context);
    if (continuity) {
      const sandbox = this.sandboxRef(context);
      return {
        continuity,
        client: this.gatewayClientForNamespace(sandbox.namespaceName),
        workspace: workspaceName(context.namespace),
        sandbox: sandbox.resourceName,
      };
    }
  }

  async observeHeldRepositoryGitPreview(
    context: SandboxHarnessStatusContext,
  ): Promise<"held" | "installed" | undefined> {
    const revision = context.revision;
    const plan = revision.egressPlan;
    const git = this.openShellGit;
    if (
      !git ||
      revision.executionAdmission.version !== 6 ||
      plan?.repositoryGitAuthorization !== "request-hook-observed" ||
      workspaceName(context.namespace) !== git.configuration.observedHookPreviewWorkspace
    ) {
      return;
    }
    const { client, service } = await this.exactHarnessService(
      context,
      "observe the held Git preview",
    );
    const path = HARNESS_EGRESS_ENROLLMENT_PATH;
    const token = context.transportToken;
    const signal = context.signal;
    const doc = await client.getServiceDocument(service.url, path, token, signal);
    if (doc.status !== 200) {
      // The startup endpoint is gone once the launcher accepts its release. Neither an
      // unanswered request nor a service refusal can stand in for its authenticated ACK.
      return doc.status === 404 && git.previewReleased(revision.id) ? "installed" : undefined;
    }
    const { profile, startupId, ...identity } = asRecord(doc.json) ?? {};
    if (
      profile !== COMPUTE_RELEASE_PROFILE ||
      typeof startupId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(startupId) ||
      !isDeepStrictEqual(identity, harnessEgressEnrollment(plan))
    ) {
      return;
    }
    return git.observeHeldPreview(revision.id, startupId, signal, async (probePath) => {
      const result = await client.postServiceDocument(
        service.url,
        path,
        token,
        { startupId, probePath },
        signal,
      );
      if (result.status === 200) {
        return result.json;
      }
    });
  }

  async enrollHarness(
    context: SandboxHarnessStatusContext,
    installation: EgressInstallation,
    release: (startupId: string) => Promise<Readonly<Record<string, unknown>>>,
  ): Promise<void> {
    assertNoRepositoryEnrollment(context, this.openShellGit);
    if (
      !context.revision.egressPlan ||
      !isDeepStrictEqual(installation.plan, context.revision.egressPlan)
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "Harness enrollment must match the admitted egress plan.",
      );
    }
    const { client, service } = await this.exactHarnessService(
      context,
      "enroll a protected Harness",
    );
    const ref = this.sandboxRef(context);
    const sandbox = await client.getSandbox(
      { name: ref.resourceName, workspace: workspaceName(context.namespace) },
      context.signal,
    );
    if (sandbox?.id !== installation.sandboxId) {
      throw new OpenShellSandboxConfigurationFailure(
        "Harness enrollment must match the installed Sandbox.",
      );
    }
    const document = await client.getServiceDocument(
      service.url,
      HARNESS_EGRESS_ENROLLMENT_PATH,
      context.transportToken,
      context.signal,
    );
    // A service may still be starting, or may already serve Codex/a held failure.
    // Normal Harness observation decides readiness; none of these answers releases startup.
    const preview = installation.plan.repositoryGitAuthorization === "request-hook-observed";
    if (document.status !== 200) {
      if (
        preview &&
        !(document.status === 404 && this.openShellGit?.previewReleased(context.revision.id))
      ) {
        throw new OpenShellSandboxConfigurationFailure(
          "Cannot verify the observed-hook launcher's release.",
        );
      }
      return;
    }
    const challenge = asRecord(document.json);
    const { profile, startupId, ...binding } = challenge ?? {};
    if (
      !challenge ||
      profile !== COMPUTE_RELEASE_PROFILE ||
      typeof startupId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(startupId) ||
      !isDeepStrictEqual(binding, harnessEgressEnrollment(installation.plan))
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "Harness enrollment challenge does not match the admitted execution.",
      );
    }
    const deliver = async (): Promise<boolean> => {
      const released = await client.postServiceDocument(
        service.url,
        HARNESS_EGRESS_ENROLLMENT_PATH,
        context.transportToken,
        await release(startupId),
        context.signal,
      );
      // A restarted Harness refuses the old challenge. The next reconcile observes
      // fresh evidence; the observed preview instead ends this route and does not replay.
      if (released.status === 409 || released.status === 410) {
        return false;
      }
      if (
        released.status !== 200 ||
        !isDeepStrictEqual(released.json, { enrolled: true, startupId })
      ) {
        throw new OpenShellSandboxConfigurationFailure("Harness enrollment was not acknowledged.");
      }
      return true;
    };
    if (preview) {
      await this.openShellGit!.releasePreview(context.revision.id, startupId, deliver);
    } else {
      await deliver();
    }
  }

  /**
   * Drops the dedicated OpenClaw worker's bearer-passthrough exposure once its node has
   * enrolled. OpenShell routes the exposure to the Sandbox without authenticating the caller,
   * and nothing of Compute's listens on the worker's transport port after enrollment, so the
   * exposure would otherwise hand agent-run code an inbound channel for the Sandbox's lifetime
   * (finding 1657). Fails closed: resolves only once OpenShell confirms the service gone.
   */
  async withdrawHarnessExposure(context: SandboxHarnessWithdrawalContext): Promise<void> {
    this.requireOperatorWorkspaceMode("withdraw a Harness exposure");
    if (
      context.revision.harness.mode !== "dedicated" ||
      context.revision.harness.id !== "openclaw"
    ) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "OpenShell withdraws a Harness exposure only for dedicated OpenClaw revisions; a Codex Harness keeps its exposure as the Gateway transport.",
      );
    }
    if (context.revision.sandboxDriverId !== this.id) {
      throw new OpenShellSandboxConfigurationFailure(
        "Refusing to withdraw a Harness exposure for another Sandbox Driver.",
      );
    }
    const sandbox = this.sandboxRef(context);
    await this.withdrawNativeExposure(
      this.gatewayClientForNamespace(sandbox.namespaceName),
      workspaceName(context.namespace),
      sandbox.resourceName,
      context.signal,
    );
  }

  private async withdrawNativeExposure(
    client: OpenShellGatewayClient,
    workspace: string,
    sandbox: string,
    signal: AbortSignal,
  ): Promise<void> {
    // A refusal from any of the three calls is the same lost or expired identity: the
    // deployment fails with that code instead of spending its attempts on a generic failure.
    const unconfirmed = `the Harness exposure of Sandbox ${sandbox} cannot be confirmed withdrawn`;
    const refused = gatewayIdentityRefusal(workspace, unconfirmed);
    // Read first: after the first withdrawal every reconcile pass passes here, and a
    // DeleteService per pass would be a gateway mutation per pass for nothing.
    const read = () => client.getService(workspace, sandbox, "", signal);
    // An absent service is withdrawn only once GetWorkspace proves the identity still sees the
    // Workspace and a second read still finds none (findings 1670, 1692); a service the second
    // read finds is deleted. The next worker start's sweep reads the service again.
    const exposed =
      (await refused(read)) ??
      (await confirmSandboxAbsent(
        client,
        workspace,
        signal,
        refused,
        () =>
          new OpenShellSandboxConfigurationFailure(
            `OpenShell reports no Workspace ${workspace}, so ${unconfirmed}.`,
          ),
        read,
      ));
    if (exposed !== undefined) {
      await refused(() => client.deleteService(workspace, sandbox, "", signal));
    }
  }

  private async initializeWorkspace(
    context: SandboxHarnessContext,
    sandbox: SandboxResourceRef,
    client: OpenShellGatewayClient,
  ): Promise<void> {
    const setup = context.requirements.workspaceSetup;
    if (setup === undefined) {
      return;
    }
    const workspace = workspaceName(context.namespace);
    const current = await client.getSandbox(
      { workspace, name: sandbox.resourceName },
      context.signal,
    );
    // Supervisor readiness permits private exec; the Harness is still waiting for
    // the completion marker. A later reconciliation handles a still-starting Pod.
    // NOT_FOUND here (also a Sandbox hidden from this identity, finding 1676) only defers the
    // setup: this pass read or created the Sandbox a moment ago, so it is a flap within one
    // pass, nothing is recorded as gone, and the next pass's create fails closed.
    if (current?.phase !== "SANDBOX_PHASE_READY" && current?.phase !== 2) {
      return;
    }
    let exit: number;
    try {
      const secret = await kubernetes(context).read({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { namespace: sandbox.namespaceName, name: setup.secretKeyRef.name },
      });
      const metadata = asRecord(secret?.metadata);
      const labels = asRecord(metadata?.labels);
      const encoded = asRecord(asRecord(secret)?.data)?.[setup.secretKeyRef.key];
      if (
        metadata?.namespace !== sandbox.namespaceName ||
        labels?.[OPENSHELL_NAMESPACE_LABEL] !== context.revision.namespaceId ||
        labels?.["openclaw.dev/agent"] !== context.revision.agentId ||
        typeof encoded !== "string" ||
        encoded.length > 540_000
      ) {
        throw new Error();
      }
      const value = Buffer.from(encoded, "base64").toString("utf8");
      const payload = asRecord(JSON.parse(value));
      if (
        Buffer.byteLength(value, "utf8") > 400_000 ||
        payload?.id !== setup.id ||
        payload.namespaceId !== context.revision.namespaceId ||
        payload.agentId !== context.revision.agentId ||
        payload.defaultsId !== setup.defaultsId
      ) {
        throw new Error();
      }
      exit = await client.execSandbox(
        {
          workspace,
          sandbox: sandbox.resourceName,
          command: ["/usr/local/bin/node", "-e", WORKSPACE_SETUP_EXEC],
          environment: {
            HOME: OPENSHELL_HOME,
            OPENCLAW_STATE_DIR: `${OPENSHELL_HOME}/.openclaw`,
            OPENCLAW_WORKSPACE_DIR: sandboxDataMount(this.options, context.requirements).mount_path,
            OPENCLAW_EXECUTABLE: "/app/openclaw.mjs",
          },
          stdin: value,
          timeoutSeconds: 300,
        },
        context.signal,
      );
    } catch {
      context.signal.throwIfAborted();
      // Neither API/parser diagnostics nor remote output may disclose initial files.
      throw new OpenShellSandboxConfigurationFailure("OpenShell workspace initialization failed.");
    }
    if (exit === WORKSPACE_SETUP_REFUSED_EXIT_STATUS) {
      // Every retry would refuse the same way: fail the deployment now, as Kubernetes Compute
      // does for its init container (finding 1708).
      throw new SandboxWorkspaceSetupRefusedError("OpenShell workspace initialization refused.");
    }
    if (exit !== 0) {
      throw new OpenShellSandboxConfigurationFailure("OpenShell workspace initialization failed.");
    }
  }

  async harnessEndpoint(context: SandboxHarnessContext): Promise<SandboxHarnessEndpoint> {
    if (context.revision.harness.id !== "codex") {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "OpenShell exposes a provider-owned Harness endpoint only for dedicated Codex revisions.",
      );
    }
    const { service } = await this.exactHarnessService(context, "resolve a Harness endpoint");
    const caBundle = this.backend.client.publicRootCertificate();
    return Object.freeze({
      url: harnessWebSocketUrl(service.advertisedUrl),
      workspaceRoot: this.options.kubernetes.sandboxDataMount.mountPath,
      codexPermissionProfile: ":danger-full-access",
      ...(caBundle === undefined ? {} : { tls: Object.freeze({ caBundle }) }),
    });
  }

  /**
   * Observes the Harness through its bearer-passthrough exposure, as the Agent Gateway reaches a
   * Codex Harness. A Harness holding a startup failure (for example a failed model probe) serves
   * that failure on the exposed port in place of Codex, or in place of the dedicated OpenClaw
   * worker's node; a serving Codex app-server completes the authenticated WebSocket handshake.
   * Anything else, including OpenShell's own `502` while nothing listens, is still starting.
   */
  async harnessStatus(context: SandboxHarnessStatusContext): Promise<SandboxHarnessStatus> {
    if (context.revision.harness.id === "openclaw" && context.workspaceNodeEnrolled === true) {
      // The exposure is withdrawn with enrollment, and nothing of Compute's listens there.
      throw new OpenShellSandboxConfigurationFailure(
        "Refusing to observe a dedicated OpenClaw worker whose node has enrolled; its Harness exposure is withdrawn.",
      );
    }
    try {
      const { client, service } = await this.exactHarnessService(context, "observe a Harness");
      // Handshake first, so a serving app-server never receives a plain request. A
      // Harness wrapper holding a startup failure answers the upgrade 503 with the held
      // code and serves the failure itself on the status path.
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
    } catch (error) {
      // A gateway that does not answer, over gRPC or its service listener, is no evidence
      // about the Harness: the read waits for convergence without spending the revision's
      // attempt budget (finding 1658). Refusals and invalid answers keep their classes, and
      // so does the client's own transient class (OpenShellAdmissionLimitError), which is
      // not a DependencyUnavailableError.
      if (error instanceof DependencyUnavailableError) {
        throw new TransientDependencyError(
          "sandbox_gateway",
          error instanceof OpenShellServiceTransportError ? error.reason : "unavailable",
          "OpenShell did not answer the Harness status read.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * The exact bearer-passthrough exposure of the revision's Harness: Codex always has one, a
   * dedicated OpenClaw worker has one because Compute asked for it. Anything else fails closed.
   */
  private async exactHarnessService(
    context: SandboxHarnessContext,
    operation: string,
  ): Promise<{
    readonly client: OpenShellGatewayClient;
    readonly service: NonNullable<Awaited<ReturnType<OpenShellGatewayClient["getService"]>>>;
  }> {
    this.requireOperatorWorkspaceMode(operation);
    const codex = context.revision.harness.id === "codex";
    if (
      context.revision.harness.mode !== "dedicated" ||
      (!codex && context.revision.harness.id !== "openclaw")
    ) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "OpenShell exposes a provider-owned Harness only for dedicated Codex or OpenClaw revisions.",
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
        codex
          ? "OpenShell did not expose the exact Codex bearer-passthrough service."
          : "OpenShell did not expose the exact OpenClaw worker bearer-passthrough service.",
      );
    }
    return { client, service };
  }

  async cleanup(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
  ): Promise<void> {
    if (context.revision) {
      this.openShellGit?.withdraw(context.revision.id);
    } else {
      this.openShellGit?.withdrawNamespace(context.namespace.id);
    }
    try {
      await this.cleanupResources(context);
    } catch (error) {
      // Revision cleanup keeps its errors: only the Namespace steps classify a refusal.
      throw context.revision === undefined ? namespaceRefusal(error) : error;
    }
  }

  private async cleanupResources(
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
      if (
        context.revision.harness.mode === "dedicated" &&
        context.revision.harness.id === "openclaw"
      ) {
        // Creation can reach Kubernetes without returning a receipt or creating a Sandbox.
        await cleanupNativeWorkspace({ ...context, revision: context.revision }, sandbox);
      }
      const client = this.gatewayClientForNamespace(sandbox.namespaceName);
      const workspace = workspaceName(context.namespace);
      const selector = { name: sandbox.resourceName, workspace };
      // A stop, retire or delete records the Sandbox removed only once OpenShell confirms it.
      // GetSandbox and DeleteSandbox answer NOT_FOUND alike for a Sandbox that is gone and for
      // one this identity may not see (finding 1676), so an absent Sandbox counts as removed
      // only after GetWorkspace proves the identity still sees the Workspace and a second read
      // still finds none (finding 1692); a Sandbox the second read finds is deleted. A refusal
      // on any call fails with SANDBOX_GATEWAY_UNAUTHORIZED, so the worker fails the stop or
      // deletion with that code (a replay tries again) instead of recording a live Sandbox,
      // with its exposure and credentials, as gone. The read also spares a DeleteSandbox per
      // pass once the Sandbox is gone.
      const unconfirmed = `Sandbox ${sandbox.resourceName} cannot be confirmed removed`;
      const refused = gatewayIdentityRefusal(workspace, unconfirmed);
      const read = () => client.getSandbox(selector, context.signal);
      const present =
        (await refused(read)) ??
        (await confirmSandboxAbsent(
          client,
          workspace,
          context.signal,
          refused,
          () =>
            new OpenShellSandboxConfigurationFailure(
              `OpenShell reports no Workspace ${workspace}, so ${unconfirmed}.`,
            ),
          read,
        ));
      if (present !== undefined) {
        await refused(() => client.deleteSandbox(selector, context.signal));
      }
      const harnessId = context.revision.harness.id;
      if (
        context.revision.harness.mode === "dedicated" &&
        (harnessId === "codex" || harnessId === "openclaw")
      ) {
        const provider = runtimeProviderName(context.revision.id);
        const existing = await refused(() =>
          client.getProvider(workspace, provider, context.signal),
        );
        if (existing !== undefined) {
          verifyRuntimeProvider(
            existing,
            provider,
            RUNTIME_PROFILE_IDS[harnessId],
            runtimeProviderLabels(context.namespace, context.revision),
          );
          await client.deleteProvider(workspace, provider, context.signal);
        }
      }
      const git = this.openShellGit;
      const revision = context.revision;
      if (git !== undefined && revision.repositoryCredentials !== undefined) {
        // cleanup() withdrew the route and the Sandbox is gone: nothing uses the revision's
        // Git provider, which would otherwise keep DeleteWorkspace refused (finding 2206).
        const attached = present?.spec?.providers;
        await refused(() =>
          git.removeProvider(
            revision,
            client,
            workspace,
            sandbox.resourceName,
            Array.isArray(attached) ? attached.filter((name) => typeof name === "string") : [],
            context.signal,
          ),
        );
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
      const providers = await client.listProviders(workspace.name, context.signal);
      for (const provider of providers) {
        if (
          Object.values(RUNTIME_PROFILE_IDS).some((id) => provider.type === id) &&
          provider.labels[OPENSHELL_MANAGED_BY_LABEL] === OPENSHELL_MANAGED_BY &&
          provider.labels[OPENSHELL_NAMESPACE_ID_LABEL] === context.namespace.id
        ) {
          await client.deleteProvider(workspace.name, provider.name, context.signal);
        }
      }
      // Revisions cleaned up before finding 2206's fix left their Git providers behind.
      await deleteOpenShellPreparedGitProviders(client, workspace.name, providers, context.signal);
      for (const profileId of Object.values(RUNTIME_PROFILE_IDS)) {
        await this.deleteRuntimeProfileIfUnused(client, workspace.name, profileId, context.signal);
      }
      await client.deleteWorkspace(workspace.name, context.signal);
    }
    if (this.operatorOwnedKubernetesResources) {
      return;
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
  admitNetworkPolicy(
    additions: readonly SandboxNetworkGrant[],
    version: number,
    defaults?: SandboxPolicySnapshot["defaults"],
    scope?: { readonly repositoryCredentials?: boolean },
  ): SandboxPolicySnapshot {
    const rules = defaults ?? networkPolicies(this.options);
    // First, so the named refusal answers even when another check below would also fail.
    if (scope?.repositoryCredentials === true) {
      const overlap = this.gitRouteOverlap(rules, additions);
      if (overlap !== undefined) {
        throw new SandboxNetworkPolicyConflictError(gitRouteOverlapMessage(overlap));
      }
    }
    requireConfiguration(SandboxNetworkPolicyConfiguration, { additions });
    try {
      openShellAgentNetworkRules(additions);
    } catch {
      throw new ConfigurationValidationError([
        {
          path: "/additions",
          code: "INVALID_VALUE",
          message: "OpenShell cannot represent these network grants.",
        },
      ]);
    }
    if (Object.keys(rules).some((name) => name.startsWith(AGENT_POLICY_PREFIX))) {
      throw new Error("Default policy uses a reserved Agent policy name.");
    }
    return immutableCopy({
      driverId: this.id,
      implementation: this.implementation,
      version,
      defaults: rules as OpenClawConfigurationDocument,
      additions,
    });
  }

  /**
   * With the OpenShell Git route, github.com and its subdomains are reachable only through its
   * middleware, which authorizes, audits and denies each request. A rule beside it would skip
   * all three, on any port (findings 2144, 2148), and so could an IP-address host (2145). Names the first
   * such rule: an Agent network grant, then a default policy. The Driver's own policies are
   * checked at construction (2131).
   */
  private gitRouteOverlap(
    defaults: Readonly<Record<string, unknown>>,
    additions: readonly SandboxNetworkGrant[],
  ): OpenShellGitPolicyOverlap | undefined {
    return this.openShellGit?.overlappingPolicy([
      ...additions.map((grant) => ({
        name: `network grant ${grant.id}`,
        endpoints: [{ host: grant.host }],
      })),
      ...Object.entries(defaults).map(([name, rule]) => {
        const endpoints = asRecord(rule)?.endpoints;
        return {
          name: `sandbox network policy ${name}`,
          endpoints: (Array.isArray(endpoints) ? endpoints : []).map((endpoint) => ({
            host: String(asRecord(endpoint)?.host ?? ""),
          })),
        };
      }),
    ]);
  }

  private async policyTarget(context: SandboxLogContext) {
    this.requireOperatorWorkspaceMode("read or apply an Agent network policy");
    if (
      context.revision.namespaceId !== context.namespace.id ||
      context.revision.sandboxDriverId !== this.id
    ) {
      throw new Error("Invalid policy revision scope.");
    }
    const ref = this.sandboxRef(context);
    const client = this.gatewayClientForNamespace(ref.namespaceName);
    const request = { sandbox: ref.resourceName, workspace: workspaceName(context.namespace) };
    const sandbox = await client.getSandbox(
      { name: request.sandbox, workspace: request.workspace },
      context.signal,
    );
    if (
      sandbox === undefined ||
      sandbox.name !== request.sandbox ||
      sandbox.workspace !== request.workspace ||
      sandbox.annotations["openclaw.dev/namespace-id"] !== context.namespace.id ||
      sandbox.annotations["openclaw.dev/agent-id"] !== context.revision.agentId ||
      sandbox.annotations["openclaw.dev/revision-id"] !== context.revision.id ||
      sandbox.resourceVersion === undefined
    ) {
      throw new Error("The Sandbox is unavailable or has different ownership.");
    }
    return { client, request, sandbox };
  }

  async observeNetworkPolicy(
    context: SandboxLogContext,
    snapshot: SandboxPolicySnapshot,
  ): Promise<SandboxPolicyObservation> {
    if (snapshot.driverId !== this.id || snapshot.implementation !== this.implementation) {
      throw new Error("Unsupported policy snapshot.");
    }
    const { client, request, sandbox } = await this.policyTarget(context);
    if (client.getPolicyStatus === undefined) {
      throw new Error("Policy status is unavailable.");
    }
    const baseline = asRecord(sandbox.spec?.policy);
    if (baseline === undefined) {
      throw new Error("Missing policy baseline.");
    }
    const candidate = openShellPolicyCandidate(baseline, snapshot);
    const status = await client.getPolicyStatus(request, context.signal);
    const matches = sameOpenShellPolicy(status.policy, candidate);
    const state =
      status.state === "POLICY_STATUS_LOADED" && status.activeVersion === status.version
        ? "applied"
        : status.state === "POLICY_STATUS_FAILED" || status.state === "POLICY_STATUS_SUPERSEDED"
          ? "failed"
          : "pending";
    return {
      resourceVersion: sandbox.resourceVersion!,
      policyVersion: String(status.version),
      state,
      matches,
    };
  }

  async applyNetworkPolicy(
    context: SandboxLogContext,
    input: {
      readonly snapshot: SandboxPolicySnapshot;
      readonly expectedProviderVersion: string;
      readonly operationId: string;
    },
  ): Promise<void> {
    const { client, request, sandbox } = await this.policyTarget(context);
    if (
      input.snapshot.driverId !== this.id ||
      input.snapshot.implementation !== this.implementation ||
      client.updatePolicy === undefined
    ) {
      throw new Error("Live policy application is unsupported.");
    }
    // Backstop for the admission check (finding 2144): never add a Git route bypass live.
    const overlap =
      context.revision.repositoryCredentials === undefined
        ? undefined
        : this.gitRouteOverlap(input.snapshot.defaults, input.snapshot.additions);
    if (overlap !== undefined) {
      throw new SandboxNetworkPolicyConflictError(gitRouteOverlapMessage(overlap));
    }
    const baseline = asRecord(sandbox.spec?.policy);
    if (baseline === undefined) {
      throw new Error("Missing policy baseline.");
    }
    await client.updatePolicy(
      {
        ...request,
        policy: openShellPolicyCandidate(baseline, input.snapshot),
        expectedResourceVersion: input.expectedProviderVersion,
        requestId: input.operationId,
      },
      context.signal,
    );
  }

  async readPolicyRecommendations(
    context: SandboxLogContext,
    limit: number,
  ): Promise<SandboxPolicyRecommendations> {
    const { client, request } = await this.policyTarget(context);
    if (
      client.getPolicyDrafts === undefined ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 32
    ) {
      throw new Error("Policy recommendations are unavailable.");
    }
    const drafts = await client.getPolicyDrafts(request, context.signal);
    const chunks = drafts.chunks;
    const recommendations: SandboxPolicyRecommendation[] = [];
    let omitted = false;
    for (const chunk of chunks) {
      const rule = asRecord(chunk.proposed_rule);
      const binaries = rule?.binaries;
      const endpoints = rule?.endpoints;
      // Only lossless, binary-scoped L4 suggestions fit this contract. Never broaden a richer rule.
      if (
        !Array.isArray(binaries) ||
        binaries.length !== 1 ||
        !Array.isArray(endpoints) ||
        endpoints.length !== 1 ||
        typeof chunk.id !== "string" ||
        !["pending", "approved", "rejected"].includes(String(chunk.status))
      ) {
        omitted = true;
        continue;
      }
      const endpoint = asRecord(endpoints[0]);
      const binary = asRecord(binaries[0])?.path;
      const ports = endpoint?.ports ?? (endpoint?.port ? [endpoint.port] : []);
      if (
        typeof binary !== "string" ||
        typeof endpoint?.host !== "string" ||
        !Array.isArray(ports) ||
        ports.length === 0 ||
        ports.length > 16 ||
        ![undefined, "", "tcp"].includes(endpoint.protocol as string | undefined) ||
        (endpoint.path !== undefined && endpoint.path !== "")
      ) {
        omitted = true;
        continue;
      }
      const representable = new Set([
        "host",
        "port",
        "ports",
        "protocol",
        "tls",
        "enforcement",
        "advisor_proposed",
      ]);
      const hasRestrictions = Object.entries(endpoint).some(([key, value]) => {
        if (representable.has(key) || key.startsWith("_")) {
          return false;
        }
        if (Array.isArray(value)) {
          return value.length > 0;
        }
        return (
          value !== undefined &&
          value !== null &&
          value !== "" &&
          value !== false &&
          value !== 0 &&
          (typeof value !== "object" || Object.keys(value).length > 0)
        );
      });
      if (
        hasRestrictions ||
        ![undefined, "", "NETWORK_TLS_MODE_SKIP"].includes(endpoint.tls as string | undefined) ||
        ![
          undefined,
          "",
          "NETWORK_ENFORCEMENT_MODE_UNSPECIFIED",
          "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        ].includes(endpoint.enforcement as string | undefined)
      ) {
        omitted = true;
        continue;
      }
      const grant = {
        id: `suggestion-${chunk.id}`,
        binary,
        host: endpoint.host,
        ports: ports.map((port) => ({ from: Number(port), to: Number(port) })),
      };
      try {
        openShellAgentNetworkRules([grant]);
      } catch {
        omitted = true;
        continue;
      }
      if (recommendations.length === limit) {
        omitted = true;
        break;
      }
      recommendations.push({
        id: chunk.id,
        status: chunk.status as SandboxPolicyRecommendation["status"],
        grant,
        ...(Number.isSafeInteger(chunk.hit_count) && Number(chunk.hit_count) >= 0
          ? { observations: Number(chunk.hit_count) }
          : {}),
      });
    }
    return { recommendations, truncated: omitted, providerVersion: drafts.version };
  }

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
      lines: response.lines.map(openShellLogDecision),
      bufferTotal: response.bufferTotal,
    });
  }

  /**
   * Reads the dedicated revision's own Sandbox record without touching it. Only the
   * gateway's lifecycle phase and restart state are used; the Harness transport is not
   * contacted. A Sandbox hidden from this identity reads `lost` (`SANDBOX_MISSING`, finding
   * 1676): an observation, not a removal, and no controller path acts on it today.
   */
  async observeHarness(context: SandboxLogContext): Promise<SandboxHarnessObservation> {
    this.requireOperatorWorkspaceMode("observe a Harness");
    if (
      context.revision.namespaceId !== context.namespace.id ||
      context.revision.sandboxDriverId !== this.id ||
      context.revision.harness.mode !== "dedicated"
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "Refusing to observe a Sandbox outside its selected dedicated AgentRevision and Namespace.",
      );
    }
    const sandbox = this.sandboxRef(context);
    // Only the phase, the restart state and the ownership annotation of the record are used.
    const existing = await openShellSandboxObserver(
      this.gatewayClientForNamespace(sandbox.namespaceName),
    ).getSandbox(
      { name: sandbox.resourceName, workspace: workspaceName(context.namespace) },
      context.signal,
    );
    if (
      existing !== undefined &&
      existing.annotations["openclaw.dev/revision-id"] !== context.revision.id
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        `Refusing OpenShell Sandbox ${sandbox.resourceName} without exact AgentRevision ownership.`,
      );
    }
    return harnessObservation(existing);
  }

  /**
   * The revision's supervisor Pod opens its workspace-node connection. OpenShell labels that
   * Pod with the Sandbox's gateway-minted ID (`sandbox_runtime.rs` `control_labels`), a UUID
   * distinct from the Sandbox name, so the ID is read from the gateway's own record. A Sandbox
   * hidden from this identity (finding 1676) contributes no peer: the Gateway then admits its
   * node connection from nowhere, which is restrictive, not a removal.
   */
  async workspaceNodePeerLabels(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  ): Promise<Readonly<Record<string, string>> | undefined> {
    this.requireOperatorWorkspaceMode("resolve a workspace-node peer");
    if (
      context.revision.namespaceId !== context.namespace.id ||
      context.revision.sandboxDriverId !== this.id ||
      context.revision.harness.mode !== "dedicated"
    ) {
      throw new OpenShellSandboxConfigurationFailure(
        "Refusing to resolve a workspace-node peer outside its selected dedicated AgentRevision and Namespace.",
      );
    }
    const sandbox = this.sandboxRef(context);
    const existing = await openShellSandboxObserver(
      this.gatewayClientForNamespace(sandbox.namespaceName),
    ).getSandbox(
      { name: sandbox.resourceName, workspace: workspaceName(context.namespace) },
      context.signal,
    );
    if (existing === undefined) {
      return undefined;
    }
    if (existing.annotations["openclaw.dev/revision-id"] !== context.revision.id) {
      throw new OpenShellSandboxConfigurationFailure(
        `Refusing OpenShell Sandbox ${sandbox.resourceName} without exact AgentRevision ownership.`,
      );
    }
    if (existing.id === undefined || !KUBERNETES_LABEL_VALUE.test(existing.id)) {
      throw new OpenShellSandboxConfigurationFailure(
        `OpenShell Sandbox ${sandbox.resourceName} has no ID usable as a supervisor Pod label.`,
      );
    }
    return Object.freeze({
      [OPENSHELL_SANDBOX_ID_LABEL]: existing.id,
      [OPENSHELL_BOUNDARY_ROLE_LABEL]: "supervisor",
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
    profileId: string,
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
            type: profileId,
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
    const setupUpdate = runtimeProviderSetupUpdate(
      provider,
      name,
      profileId,
      expectedLabels,
      config,
    );
    if (setupUpdate !== undefined) {
      provider = await client.updateProviderConfig(
        workspace,
        name,
        setupUpdate,
        provider.resourceVersion,
        context.signal,
      );
    }
    verifyRuntimeProvider(provider, name, profileId, expectedLabels, config);
    return Object.freeze({ name, created });
  }

  private async deleteRuntimeProfileIfUnused(
    client: OpenShellGatewayClient,
    workspace: string,
    profileId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const providers = await client.listProviders(workspace, signal);
    if (providers.some((provider) => provider.type === profileId)) {
      return;
    }
    const profile = await client.getProviderProfile(workspace, profileId, signal);
    if (profile === undefined) {
      return;
    }
    if (!isManagedRuntimeProfile(profile)) {
      throw new OpenShellSandboxConfigurationFailure(
        `Refusing to delete unmanaged OpenShell provider profile ${profileId}.`,
      );
    }
    await client.deleteProviderProfile(workspace, profileId, signal);
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
