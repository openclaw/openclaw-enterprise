import { assertExecutionReleaseAllowed } from "@openclaw-enterprise/contracts";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type {
  AgentRevision,
  ComputeDriver,
  ComputeAgentBinding,
  ComputeRevisionContext,
  WorkspaceSetup,
  ComputeReadiness,
  RuntimeImage,
  Driver,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  LoggingLevel,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  RevisionHarnessDescriptor,
} from "@openclaw-enterprise/contracts";
import { admittedLoggingLevel } from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, isNonEmptyString, sha256Hex } from "@openclaw-enterprise/utils";
import { ConfigurationHarnessError, configurationSettingMessage } from "@openclaw-enterprise/occ";
import {
  HARNESS_WORKSPACE,
  MANAGED_WORKSPACE,
  requireWorkspaceSetupConfiguration,
  WORKSPACE_SETUP_RUNTIME,
  workspaceSetupMainEntry,
  workspaceSetupVerifier,
} from "../workspace-setup-runtime.ts";
import { ComputeLifecycleDispatcher } from "../lifecycle-hooks.ts";
import { nodeProgramArguments } from "../node-program.ts";
import { discoverHarnessModels } from "../model-discovery.ts";
import { failureAfterCleanup } from "../cleanup-failure.ts";
import { currentComputeAbortSignal, withComputeAbortSignal } from "../operation-context.ts";
import {
  AGENT_READINESS_ENTRYPOINT,
  AGENT_RUNTIME_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../kubernetes/runtime-entrypoints.ts";
import { gatewayStateMigrationHelper, startupPhaseHelper } from "../runtime-startup.ts";
import {
  PLUGIN_RUNTIME_READY_MARKER,
  PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT,
  type PluginRuntimeSpec,
  pluginRuntimeEnvironment,
  pluginRuntimeSpecForRevision,
} from "../plugin-runtime.ts";
import {
  validatePlaintextNativeGateway,
  validateRoutableNativeListener,
} from "../native-gateway-transport.ts";
import { validateCodexApprovalPolicySetting } from "../../../gateway/codex-approval-policy.ts";
import { unsupportedNativeGatewayAuthFields } from "../../../gateway/auth-fields.ts";
import {
  NATIVE_GATEWAY_STATE_RECOVERY_RUNTIME,
  nativeGatewayRecoveryConfigurationEligible,
} from "../native-state-recovery-runtime.ts";
import {
  TRUSTED_GATEWAY_TOOL_BOUNDARY,
  GATEWAY_PRIVATE_STATE_ORIGIN,
  GATEWAY_RECOVERY_SOURCE_PROTECTION,
  GATEWAY_STATE_DATABASE_PATH,
  parseNativeGatewayStateOwner,
  parseNativeGatewayOwnerRecords,
  nativeGatewayOwnersMatch,
  parseDockerGatewayStateOwnerBinding,
  dockerGatewayOwnerTermination,
  NATIVE_GATEWAY_STATE_OBSERVATION_VALIDATORS,
  parseNativeGatewayStateObservation,
  type DockerGatewayStateOwnerBinding,
} from "../native-state-owner.ts";

export interface DockerComputeDriverOptions {
  readonly images: {
    readonly gateway: string;
    readonly agent: string;
  };
  readonly loggingAddress?: string;
}

interface DockerComputeDriverSelection {
  readonly trustedGatewayToolBoundary?: typeof TRUSTED_GATEWAY_TOOL_BOUNDARY;
}

interface DockerContainerInspect {
  readonly Id?: string;
  readonly Image?: string;
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Readonly<Record<string, string>>;
    readonly Env?: readonly string[];
    readonly User?: string;
    readonly Healthcheck?: { readonly Test?: readonly string[] };
  };
  readonly HostConfig?: {
    readonly Mounts?: readonly {
      readonly Type?: string;
      readonly Source?: string;
      readonly Target?: string;
      readonly ReadOnly?: boolean;
    }[];
    readonly ReadonlyRootfs?: boolean;
    readonly PidMode?: string;
    readonly Privileged?: boolean;
    readonly NetworkMode?: string;
  };
  readonly State?: {
    readonly Running?: boolean;
    readonly Paused?: boolean;
    readonly Restarting?: boolean;
    readonly Dead?: boolean;
    readonly ExitCode?: number;
    readonly Status?: string;
    readonly Pid?: number;
    readonly StartedAt?: string;
    readonly FinishedAt?: string;
    readonly Health?: {
      readonly Status?: string;
      readonly FailingStreak?: number;
      readonly Log?: readonly {
        readonly Start?: string;
        readonly End?: string;
        readonly ExitCode?: number;
        readonly Output?: string;
      }[];
    };
  };
  readonly NetworkSettings?: {
    readonly Ports?: Readonly<
      Record<string, readonly { readonly HostIp: string; readonly HostPort: string }[] | null>
    >;
  };
}

interface DockerLabeledResourceInspect {
  readonly Name?: string;
  readonly Labels?: Readonly<Record<string, string>>;
}

interface DockerGatewayRecoveryStorage {
  readonly ownership: Ownership;
  readonly stateVolume: string;
  readonly metadataVolume: string;
  readonly nonce: string;
  readonly storageId: string;
  readonly holderId: string;
}

interface DockerGatewayRecoverySnapshot {
  readonly version: 1;
  readonly stateOrigin: typeof GATEWAY_PRIVATE_STATE_ORIGIN;
  readonly storageId: string;
  readonly stateInstance: string;
  readonly binding?: DockerGatewayStateOwnerBinding;
  readonly revisionId?: string;
  readonly instanceId?: string;
  readonly owner?: DockerGatewayStateOwnerBinding["owner"];
}

interface DockerVersion {
  readonly Platform?: { readonly Name?: string };
  readonly Components?: readonly { readonly Name?: string }[];
}

interface Ownership {
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly revisionId?: string;
}

interface RuntimeContainerInput {
  readonly name: string;
  readonly image: string;
  readonly network: string;
  readonly ownership: Ownership;
  readonly role: "agent" | "gateway";
  readonly environment: Readonly<Record<string, string>>;
  readonly command: string;
  readonly healthcheckScript: string;
  readonly exposedPort: number;
  readonly labels?: Readonly<Record<string, string>>;
  readonly workspaceSetup?: boolean;
  readonly stateRecovery?: DockerGatewayRecoveryStorage;
  readonly portBindings?: Readonly<
    Record<string, readonly { readonly HostIp: string; readonly HostPort: string }[]>
  >;
}

class DockerApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

class OwnershipFailure extends Error {}
class ConfigurationFailure extends Error {}

const MANAGED_VALUE = "true";
const DRIVER_ID = "compute-docker-development";
const DRIVER_IMPLEMENTATION = "docker-local";
const MANAGED_LABEL = "org.openclaw.enterprise.managed";
const COMPUTE_DRIVER_LABEL = "org.openclaw.enterprise.compute-driver";
const NAMESPACE_LABEL = "org.openclaw.enterprise.namespace-id";
const AGENT_LABEL = "org.openclaw.enterprise.agent-id";
const REVISION_LABEL = "org.openclaw.enterprise.revision-id";
const REVISION_NUMBER_LABEL = "org.openclaw.enterprise.revision-number";
const ROLE_LABEL = "org.openclaw.enterprise.role";
const CONFIGURATION_HASH_LABEL = "org.openclaw.enterprise.configuration-hash";
const HARNESS_VERSION_LABEL = "org.openclaw.enterprise.harness-version";
const VERSION_LABEL = "org.openclaw.enterprise.version";
const SOCKET_PATH = "/var/run/docker.sock";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_DOCKER_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 120_000;
const GATEWAY_PORT = 8080;
const AGENT_TRANSPORT_PORT = 18_790;
const MODEL_API_KEY = "OPENAI_API_KEY";
const CONFIGURATION_DOCUMENT = "/home/node/.openclaw/openclaw.json";
const GATEWAY_PASSWORD_ENV = "OPENCLAW_GATEWAY_PASSWORD";
const GATEWAY_PASSWORD_REFERENCE = `\${${GATEWAY_PASSWORD_ENV}}`;
const STATE_ORIGIN_LABEL = "org.openclaw.enterprise.state-origin";
const STATE_INSTANCE_LABEL = "org.openclaw.enterprise.state-instance";
const STATE_RECOVERY_PORT = 18_791;
const STATE_RECOVERY_DIRECTORY = "/etc/openclaw-state-recovery";
const STATE_RECOVERY_ROLE = "gateway-state-recovery";
const STATE_RECOVERY_FILE = "request.json";
const STATE_RECOVERY_MANUAL_FILE = "manual";
const MAX_STATE_RECOVERY_BYTES = 16_384;
const STATE_HEALTH_PREFIX = "OCE_GATEWAY_OWNER_V1 ";
const MAX_STATE_HEALTH_BYTES = 3072;
const STATE_RECOVERY_ENVIRONMENT = [
  "OPENCLAW_STATE_OWNER_RECOVERY_PATH",
  "OPENCLAW_TRUSTED_GATEWAY_TOOL_BOUNDARY",
  "OPENCLAW_STATE_RECOVERY_ORIGIN",
  "OPENCLAW_STATE_RECOVERY_STORAGE_ID",
  "OPENCLAW_RUNTIME_STATUS_PORT",
  "OPENCLAW_RUNTIME_STATUS_CONTAINER",
  "OPENCLAW_RUNTIME_STATUS_TOKEN",
  "OPENCLAW_POD_UID",
] as const;

function dockerGatewayConfigurationDocument(configuration: OpenClawConfigurationDocument): {
  readonly configuration: OpenClawConfigurationDocument;
  readonly requiresManagedPassword: boolean;
} {
  for (const validate of [
    validatePlaintextNativeGateway,
    validateRoutableNativeListener,
    validateCodexApprovalPolicySetting,
  ]) {
    validate(
      configuration,
      (setting, requirement) =>
        new ConfigurationFailure(`Configuration setting ${setting} ${requirement}.`),
    );
  }
  const gatewayRecord = asRecord(configuration.gateway);
  if (configuration.gateway !== undefined && gatewayRecord === undefined) {
    throw new ConfigurationFailure("Docker native gateway configuration must be an object.");
  }
  const gateway = (gatewayRecord ?? {}) as Record<string, OpenClawConfigurationValue>;
  const authRecord = asRecord(gateway.auth);
  if (gateway.auth !== undefined && authRecord === undefined) {
    throw new ConfigurationFailure("Docker native gateway auth must be an object.");
  }
  const auth = (authRecord ?? {}) as Record<string, OpenClawConfigurationValue>;

  const unsupported = unsupportedNativeGatewayAuthFields(auth);
  if (unsupported.length > 0) {
    throw new ConfigurationFailure(
      `Docker native gateway authentication contains unsupported field ${unsupported[0]}.`,
    );
  }
  const passwordReference =
    auth.password === undefined ? undefined : gatewayPasswordEnvironmentReference(auth.password);
  if (auth.mode === "trusted-proxy") {
    return {
      configuration,
      requiresManagedPassword: passwordReference === GATEWAY_PASSWORD_ENV,
    };
  }
  if (auth.mode !== undefined && auth.mode !== "password") {
    throw new ConfigurationFailure(
      "Docker Compute supports only native password or trusted-proxy gateway authentication.",
    );
  }

  const useDefaultPassword = auth.password === undefined;
  return {
    configuration: {
      ...configuration,
      gateway: {
        ...gateway,
        auth: {
          ...auth,
          mode: "password",
          ...(useDefaultPassword ? { password: GATEWAY_PASSWORD_REFERENCE } : {}),
        },
      },
    },
    requiresManagedPassword: useDefaultPassword || passwordReference === GATEWAY_PASSWORD_ENV,
  };
}

function gatewayPasswordEnvironmentReference(
  value: OpenClawConfigurationValue,
): string | undefined {
  if (value === GATEWAY_PASSWORD_REFERENCE) {
    return GATEWAY_PASSWORD_ENV;
  }
  const record = asRecord(value);
  if (record?.source === "env" && record.id === GATEWAY_PASSWORD_ENV) {
    return GATEWAY_PASSWORD_ENV;
  }
  return undefined;
}

export const GATEWAY_RUNTIME_ENTRYPOINT = String.raw`
const { chmodSync, mkdirSync, writeFileSync, renameSync, lstatSync, realpathSync } = require("node:fs");
const { spawn } = require("node:child_process");

${PLUGIN_RUNTIME_HELPERS}
${startupPhaseHelper("gateway")}
${gatewayStateMigrationHelper("deploy the Agent again")}
let child;
let childRunning = false;
function gatewayEnvironment() { return { ...process.env }; }
${NATIVE_GATEWAY_STATE_RECOVERY_RUNTIME}

function forwardTermination(child) {
  let terminating = false;
  const forward = (signal) => {
    if (terminating) return;
    terminating = true;
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
}

function startGateway() {
  child = spawn(
    "node",
    ["/app/openclaw.mjs", "gateway", "--port", process.env.OPENCLAW_GATEWAY_PORT],
    { stdio: "inherit" },
  );
  childRunning = true;
  forwardTermination(child);
  child.on("exit", (code, signal) => {
    childRunning = false;
    process.exit(code ?? (signal === "SIGTERM" ? 0 : 1));
  });
}

mkdirSync("/home/node/.openclaw", { recursive: true, mode: 0o700 });
mkdirSync("/home/node/workspace", { recursive: true, mode: 0o700 });
chmodSync("/home/node/.openclaw", 0o700);
chmodSync("/home/node/workspace", 0o700);
// The old shared state may contain a config symlink into the Harness workspace.
// Replace that directory entry; never funnel a trusted config write through it.
if (process.env.OPENCLAW_CONFIG_PATH !== "/home/node/.openclaw/openclaw.json" ||
    !lstatSync("/home/node/.openclaw").isDirectory() ||
    realpathSync("/home/node/.openclaw") !== "/home/node/.openclaw") {
  throw new Error("Gateway configuration directory is not the managed state directory.");
}
const stagedConfig = process.env.OPENCLAW_CONFIG_PATH + ".oce-" + pluginRandomUUID();
writeFileSync(stagedConfig, process.env.OPENCLAW_CONFIG_JSON, { mode: 0o600, flag: "wx" });
renameSync(stagedConfig, process.env.OPENCLAW_CONFIG_PATH);
delete process.env.OPENCLAW_CONFIG_JSON;
delete process.env.OPENCLAW_LOG_LEVEL;
const pluginRuntime = readGatewayPluginRuntime();
function launchGateway() {
// The state volume outlives image upgrades. A failed migration exits instead
// of restarting a Gateway against an incompatible database.
const outdatedDatabases = outdatedAgentDatabases();
if (outdatedDatabases.length === 0) {
  startGateway();
} else {
  migrateGatewayState(outdatedDatabases).then(
    (migrated) => {
      if (migrated) startGateway();
      else process.exit(1);
    },
    (error) => {
      console.error("Gateway state migration failed: " + (error?.message ?? error));
      process.exit(1);
    },
  );
}
}
// The private status transport is available while Native recovery is waiting;
// the normal port and startup timing remain unchanged when recovery is absent.
startPluginRuntimeStatusServer(() => childRunning);
if (nativeStateRecoveryEnabled) {
  (async () => {
    if (!(await prepareNativeGatewayStateRecovery())) return;
    // Inspect sources before any Native plugin/config work, then recheck the
    // configuration the installer emitted before starting the Gateway child.
    await qualifyNativeGatewayStateSources();
    if (pluginRuntime !== undefined) installOpenClawPlugins(pluginRuntime);
    await qualifyNativeGatewayStateSources();
    launchGateway();
  })().catch((error) => {
    if (!holdPluginApproverConfigurationFailure(error)) process.exit(1);
  });
} else {
  try {
    if (pluginRuntime !== undefined) installOpenClawPlugins(pluginRuntime);
    launchGateway();
  } catch (error) {
    if (!holdPluginApproverConfigurationFailure(error)) throw error;
  }
}
`;

function required(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new ConfigurationFailure(`${description} must be explicitly configured.`);
  }
  return value;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "namespace"
  );
}

function failure(error: unknown): "retryable" | "permanent" {
  return error instanceof OwnershipFailure ||
    error instanceof ConfigurationFailure ||
    [400, 401, 403, 404, 409, 422].includes(statusCode(error) ?? 0)
    ? "permanent"
    : "retryable";
}

function statusCode(error: unknown): number | undefined {
  return error instanceof DockerApiError ? error.statusCode : undefined;
}

function healthy(inspect: DockerContainerInspect): boolean {
  return inspect.State?.Running === true && inspect.State.Health?.Status === "healthy";
}

function containerTransportToken(inspect: DockerContainerInspect): string | undefined {
  const prefix = "APP_SERVER_TOKEN=";
  return inspect.Config?.Env?.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function validTopology(revision: AgentRevision): boolean {
  return (
    (revision.harness.id === "openclaw" && revision.harness.mode === "embedded") ||
    (revision.harness.id === "codex" && revision.harness.mode === "dedicated")
  );
}

type SettingError = (setting: string, requirement: string) => Error;

// Agent save and provisioning name the setting the caller must fix; preparation names it too,
// where the message reaches only diagnostics.
const callerSettingError: SettingError = (setting, requirement) =>
  new ConfigurationHarnessError(configurationSettingMessage(setting, requirement));
const preparationSettingError: SettingError = (setting, requirement) =>
  new ConfigurationFailure(configurationSettingMessage(setting, requirement));

// Docker mounts one workspace volume at both paths, for every Harness topology.
const DOCKER_SETUP_WORKSPACES = [MANAGED_WORKSPACE, HARNESS_WORKSPACE] as const;

/**
 * The workspace initial files are written to. The roster and workspace path follow the rule
 * every Compute Driver shares; Docker's initializer also needs native bootstrap, which seeds
 * the workspace the setup documents complete.
 */
function dockerSetupWorkspace(
  configuration: Readonly<OpenClawConfigurationDocument>,
  createError: SettingError,
): string {
  const workspace = requireWorkspaceSetupConfiguration(
    configuration,
    DOCKER_SETUP_WORKSPACES,
    createError,
  );
  const defaults = asRecord(asRecord(configuration.agents)?.defaults);
  const main = workspaceSetupMainEntry(configuration);
  for (const [parent, agent] of [
    ["agents.defaults", defaults],
    [main?.setting ?? "agents.entries.main", main?.agent],
  ] as const) {
    for (const option of ["skipBootstrap", "skipOptionalBootstrapFiles"]) {
      if (agent?.[option] === true) {
        throw createError(
          `${parent}.${option}`,
          "must not be true for initial workspace files: Docker Compute writes them after native bootstrap",
        );
      }
    }
  }
  return workspace;
}

function optionalEnvironment(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function healthcheckCommand(script: string): string {
  const encoded = Buffer.from(script).toString("base64");
  return `eval(Buffer.from("${encoded}","base64").toString())`;
}

function protectedGatewayHealthcheck(): string {
  return String.raw`
${NATIVE_GATEWAY_STATE_OBSERVATION_VALIDATORS}
(async () => {
  const ready = Promise.all(["startupz", "readyz"].map((path) =>
    fetch("http://127.0.0.1:${GATEWAY_PORT}/" + path).then((response) => response.ok).catch(() => false)));
  const observation = (async () => {
    try {
      const response = await fetch("http://127.0.0.1:${STATE_RECOVERY_PORT}/openclaw/runtime/status", {
        headers: { authorization: "Bearer " + process.env.OPENCLAW_RUNTIME_STATUS_TOKEN },
        signal: AbortSignal.timeout(1500), redirect: "error",
      });
      if (!response.ok || response.body === null) return;
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 65536) return;
        chunks.push(chunk);
      }
      const projected = parseNativeGatewayStateObservation(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (projected === undefined) return;
      const line = ${JSON.stringify(STATE_HEALTH_PREFIX)} + JSON.stringify(projected) + "\n";
      if (Buffer.byteLength(line) <= ${MAX_STATE_HEALTH_BYTES}) process.stdout.write(line);
    } catch {}
  })();
  const [checks] = await Promise.all([ready, observation]);
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch(() => process.exit(1));`;
}

function dockerOwnerHealthObservation(
  entry: { readonly ExitCode?: number; readonly Output?: string } | undefined,
): ReturnType<typeof parseNativeGatewayStateObservation> {
  const output = entry?.Output;
  if (
    ![0, 1].includes(entry?.ExitCode ?? -1) ||
    typeof output !== "string" ||
    Buffer.byteLength(output) > MAX_STATE_HEALTH_BYTES ||
    !output.startsWith(STATE_HEALTH_PREFIX) ||
    !output.endsWith("\n")
  ) {
    return undefined;
  }
  try {
    return parseNativeGatewayStateObservation(
      JSON.parse(output.slice(STATE_HEALTH_PREFIX.length, -1)),
    );
  } catch {
    return undefined;
  }
}

function dockerArchiveEntry(name: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  for (const [offset, value, width] of [
    [100, 0o600, 8],
    [108, 1000, 8],
    [116, 1000, 8],
    [124, payload.length, 12],
    [136, 0, 12],
  ] as const) {
    header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset);
  }
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(
    header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
  );
  return Buffer.concat([
    header,
    payload,
    Buffer.alloc(((512 - (payload.length % 512)) % 512) + 1024),
  ]);
}

function dockerArchiveFile(archive: Buffer, name: string): string {
  let file: string | undefined;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const sizeText = field(124, 12).trim();
    const size = /^[0-7]+$/.test(sizeText) ? Number.parseInt(sizeText, 8) : NaN;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_STATE_RECOVERY_BYTES ||
      offset + 512 + size > archive.length
    ) {
      throw new ConfigurationFailure("Docker recovery metadata archive is invalid.");
    }
    const type = field(156, 1);
    if (!["x", "g"].includes(type)) {
      if (
        file !== undefined ||
        field(0, 100) !== name ||
        !["", "0"].includes(type) ||
        field(345, 155) !== ""
      ) {
        throw new ConfigurationFailure("Docker recovery metadata must be one regular file.");
      }
      file = archive.subarray(offset + 512, offset + 512 + size).toString("utf8");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (file === undefined) {
    throw new ConfigurationFailure("Docker recovery metadata file is missing.");
  }
  return file;
}

function containerEnvironment(inspect: DockerContainerInspect): Record<string, string> {
  return Object.fromEntries(
    (inspect.Config?.Env ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

function loopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") {
    return true;
  }
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

function dockerLoggingAddress(value: string | undefined): string | undefined {
  const trimmed = optionalEnvironment(value);
  if (trimmed === undefined) {
    return undefined;
  }
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(trimmed);
  const plain = bracketed === null ? /^([^:]+):(\d+)$/.exec(trimmed) : null;
  const host = bracketed?.[1] ?? plain?.[1];
  const portText = bracketed?.[2] ?? plain?.[2];
  const port = Number(portText);
  if (
    host === undefined ||
    portText === undefined ||
    !loopbackHost(host) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new ConfigurationFailure("Docker logging address must be a loopback host:port.");
  }
  return host === "::1" ? `[::1]:${port}` : `${host}:${port}`;
}

export class DockerComputeDriver implements ComputeDriver {
  readonly discoverHarnessModels = discoverHarnessModels;

  readonly id = DRIVER_ID;
  readonly capability = "compute" as const;
  readonly supportsWorkspaceSetup = true as const;
  readonly implementation = DRIVER_IMPLEMENTATION;
  private readonly options: DockerComputeDriverOptions;
  private lifecycle = new ComputeLifecycleDispatcher([]);
  private lifecycleStarted = false;
  private podmanApi = false;
  private nativeStateRecoverySupported = false;
  private readonly trustedGatewayToolBoundary: typeof TRUSTED_GATEWAY_TOOL_BOUNDARY | undefined;

  /**
   * Every topology runs one gateway container per Agent, so a candidate replaces the active
   * revision's gateway. Exclusive replacement makes the worker stop predecessors first and stop
   * a refused candidate, instead of leaving it serving under the predecessor (finding 1800).
   */
  requiresStoppedPredecessors(): boolean {
    return true;
  }

  constructor(options: DockerComputeDriverOptions, selection: DockerComputeDriverSelection = {}) {
    required(options.images.gateway, "Docker gateway image");
    required(options.images.agent, "Docker Codex Agent image");
    const loggingAddress = dockerLoggingAddress(options.loggingAddress);
    this.options = immutableCopy({
      ...options,
      ...(loggingAddress === undefined ? {} : { loggingAddress }),
    });
    this.trustedGatewayToolBoundary = selection.trustedGatewayToolBoundary;
  }

  setLifecycleDrivers(drivers: readonly Driver[]): void {
    if (this.lifecycleStarted) {
      throw new Error("Compute lifecycle Drivers cannot change after lifecycle operations begin.");
    }
    this.lifecycle = new ComputeLifecycleDispatcher(drivers);
  }

  async preflight(): Promise<void> {
    const ping = await this.request("GET", "/_ping", undefined, [200]);
    if (String(ping ?? "").trim() !== "OK") {
      throw new Error("Docker Engine ping returned an invalid response.");
    }
    const version = (await this.request("GET", "/version", undefined, [200])) as DockerVersion;
    this.podmanApi =
      version.Components?.some((component) => component.Name === "Podman Engine") === true ||
      /podman/i.test(version.Platform?.Name ?? "");
    this.nativeStateRecoverySupported =
      !this.podmanApi &&
      version.Components?.some((component) => component.Name === "Engine") === true;
    await this.image(this.options.images.gateway);
    await this.image(this.options.images.agent);
  }

  async ensureNamespace(namespace: Namespace): Promise<NamespaceEnsureResult> {
    this.lifecycleStarted = true;
    const result = { namespaceId: namespace.id, namespaceReady: false };
    const name = this.networkName(namespace.id);
    let created = false;
    try {
      const ownership = { namespaceId: namespace.id };
      const existing = await this.network(name);
      if (existing === undefined) {
        await this.request(
          "POST",
          "/networks/create",
          {
            Name: name,
            Driver: "bridge",
            CheckDuplicate: true,
            Labels: this.ownershipMetadata(ownership),
          },
          [201],
        );
        created = true;
      } else {
        this.verifyOwnership(existing.Labels, ownership, `network ${name}`);
      }
      const observed = await this.network(name);
      if (observed === undefined) {
        return result;
      }
      this.verifyOwnership(observed.Labels, ownership, `network ${name}`);
      await this.lifecycle.afterNamespacePrepared(namespace);
      return { ...result, namespaceReady: true };
    } catch (error) {
      if (created) {
        await this.removeNetwork(name).catch(() => {});
      }
      return { ...result, failure: failure(error) };
    }
  }

  async deleteNamespace(namespace: Namespace): Promise<NamespaceDeleteResult> {
    this.lifecycleStarted = true;
    const result = { namespaceId: namespace.id, namespaceDeleted: false };
    const name = this.networkName(namespace.id);
    try {
      const existing = await this.network(name);
      if (existing !== undefined) {
        this.verifyOwnership(existing.Labels, { namespaceId: namespace.id }, `network ${name}`);
      }
      await this.lifecycle.beforeNamespaceDelete(namespace);
      for (const containerId of await this.containerIdsForNamespace(namespace.id)) {
        await this.removeContainer(containerId);
      }
      await this.removeWorkspaceVolumes({ namespaceId: namespace.id });
      if (existing !== undefined) {
        await this.removeNetwork(name);
      }
      return { ...result, namespaceDeleted: true };
    } catch (error) {
      return { ...result, failure: failure(error) };
    }
  }

  validateGatewaySettings(configuration: Readonly<OpenClawConfigurationDocument>): void {
    validatePlaintextNativeGateway(configuration);
    validateRoutableNativeListener(configuration);
    validateCodexApprovalPolicySetting(configuration);
  }

  // Agent create and update apply preparation's workspace rule, with its message. (OCC
  // provisioning and deployment refuse Docker's Harness authentication first.)
  validateWorkspaceSetup(
    _harness: RevisionHarnessDescriptor,
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): void {
    dockerSetupWorkspace(configuration, callerSettingError);
  }

  validateHarnessAuth(): never {
    throw new ConfigurationFailure(
      "DOCKER Compute does not support Harness authentication bindings.",
    );
  }

  validateExecutionAdmission(
    revision: Pick<AgentRevision, "executionAdmission" | "egressPlan">,
  ): void {
    assertExecutionReleaseAllowed(revision);
  }

  async prepareRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness> {
    assertExecutionReleaseAllowed(revision);
    if (revision.harnessAuth !== undefined) {
      this.validateHarnessAuth();
    }
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
      !validTopology(revision) ||
      revision.servicePrincipalId.trim().length === 0
    ) {
      return result;
    }
    if (
      revision.configurationKind !== "agent" ||
      !Number.isSafeInteger(revision.revision) ||
      revision.revision < 1 ||
      !Number.isSafeInteger(revision.configurationGeneration) ||
      revision.configurationGeneration < 1
    ) {
      throw new ConfigurationFailure("AgentRevision Configuration ownership is invalid.");
    }
    dockerGatewayConfigurationDocument(revision.configuration);

    const network = this.networkName(revision.namespaceId);
    const observed = await this.network(network);
    if (observed === undefined) {
      return result;
    }
    this.verifyOwnership(
      observed.Labels,
      { namespaceId: revision.namespaceId },
      `network ${network}`,
    );

    const loggingLevel = admittedLoggingLevel(revision.configuration);
    const prepared = immutableCopy(revision);
    const pluginRuntime = this.pluginRuntimeForRevision(revision);
    let launchPrepared = false;
    let agentCreated: string | undefined;
    let gatewayCreated: string | undefined;
    try {
      if (context?.workspaceSetup !== undefined) {
        await this.initializeWorkspace(prepared, context.workspaceSetup);
      }
      const launch = await this.lifecycle.beforeWorkloadStart(prepared);
      launchPrepared = true;
      const provider = this.providerEnvironment();
      if (prepared.harness.mode === "embedded") {
        const gateway = await this.reconcileGateway(
          prepared,
          network,
          {
            ...provider,
            ...launch.environment,
            ...this.pluginRuntimeEnvironmentForWorkload(pluginRuntime, "gateway", true),
          },
          context?.workspaceSetup,
        );
        gatewayCreated = gateway.created ? gateway.containerName : undefined;
        return { ...result, ready: gateway.ready };
      }

      const agent = await this.reconcileAgent(
        prepared,
        network,
        loggingLevel,
        {
          ...provider,
          ...launch.environment,
          ...this.pluginRuntimeEnvironmentForWorkload(pluginRuntime, "agent", false),
        },
        context?.workspaceSetup,
      );
      agentCreated = agent.created ? agent.containerName : undefined;
      const gateway = await this.reconcileGateway(
        prepared,
        network,
        {
          APP_SERVER_URL: `ws://${agent.containerName}:${AGENT_TRANSPORT_PORT}`,
          APP_SERVER_TOKEN: agent.appServerToken,
          ...this.pluginRuntimeEnvironmentForWorkload(pluginRuntime, "gateway", false),
        },
        context?.workspaceSetup,
      );
      gatewayCreated = gateway.created ? gateway.containerName : undefined;
      return { ...result, ready: gateway.ready };
    } catch (error) {
      throw await failureAfterCleanup(error, "Docker workload preparation and cleanup failed.", [
        ...[gatewayCreated, agentCreated]
          .filter((name): name is string => name !== undefined)
          .map((name) => () => this.removeContainer(name)),
        ...(launchPrepared
          ? [() => this.lifecycle.beforeWorkloadStop(prepared, { cleanup: true })]
          : []),
      ]);
    }
  }

  async getRuntimeImages(revision: AgentRevision): Promise<readonly RuntimeImage[]> {
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new OwnershipFailure("The revision belongs to another Compute Driver.");
    }
    const images: RuntimeImage[] = [];
    for (const [role, name] of [
      ["gateway", this.gatewayContainerName(revision.namespaceId, revision.agentId)],
      ["agent", this.agentContainerName(revision.namespaceId, revision.agentId, revision.id)],
    ] as const) {
      const container = await this.container(name);
      if (!container) {
        continue;
      }
      this.verifyOwnership(
        container.Config?.Labels,
        this.agentOwnership(revision),
        `container ${name}`,
      );
      if (!container.Config?.Image || !container.Image) {
        throw new Error("Docker returned incomplete image identity.");
      }
      // Inspect the immutable image actually attached to the container, not its mutable tag.
      const image = asRecord(
        await this.request(
          "GET",
          `/images/${encodeURIComponent(container.Image)}/json`,
          undefined,
          [200],
        ),
      );
      const labels = asRecord(asRecord(image?.Config)?.Labels);
      const commit = labels?.["org.opencontainers.image.revision"];
      const openclawCommit = labels?.["org.openclaw.image.revision"];
      images.push({
        workload: name,
        container: role,
        image: container.Config.Image,
        imageId: container.Image,
        commit: typeof commit === "string" && /^[a-f0-9]{40}$/.test(commit) ? commit : null,
        openclawCommit:
          typeof openclawCommit === "string" && /^[a-f0-9]{40}$/.test(openclawCommit)
            ? openclawCommit
            : null,
      });
    }
    return images;
  }

  async stopRevision(revision: AgentRevision): Promise<void> {
    await this.stopRevisionRuntime(revision);
  }

  async retireRevision(revision: AgentRevision): Promise<void> {
    await this.stopRevisionRuntime(revision);
  }

  private async stopRevisionRuntime(revision: AgentRevision): Promise<void> {
    this.lifecycleStarted = true;
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new Error("Refusing to stop an AgentRevision pinned to another Compute Driver.");
    }
    await this.lifecycle.beforeWorkloadStop(revision);
    const agentName = this.agentContainerName(revision.namespaceId, revision.agentId, revision.id);
    const agent = await this.container(agentName);
    if (agent !== undefined) {
      this.verifyOwnership(
        agent.Config?.Labels,
        this.agentOwnership(revision),
        `container ${agentName}`,
      );
      await this.removeContainer(agentName, agent);
    }
    const gatewayName = this.gatewayContainerName(revision.namespaceId, revision.agentId);
    const gateway = await this.container(gatewayName);
    if (gateway !== undefined) {
      this.verifyOwnership(
        gateway.Config?.Labels,
        this.gatewayOwnership(revision),
        `container ${gatewayName}`,
      );
      if (gateway.Config?.Labels?.[REVISION_LABEL] === revision.id) {
        await this.removeContainer(gatewayName, gateway);
      }
    }
  }

  async deleteAgentRuntimeCredentials(binding: ComputeAgentBinding): Promise<void> {
    if (binding.agent.namespaceId !== binding.namespace.id) {
      throw new OwnershipFailure("Workspace storage must belong to the exact Agent namespace.");
    }
    const ownership = { namespaceId: binding.namespace.id, agentId: binding.agent.id };
    const initializerName = `${this.gatewayContainerName(binding.namespace.id, binding.agent.id)}-setup`;
    const initializer = await this.container(initializerName);
    if (initializer !== undefined) {
      this.verifyOwnership(initializer.Config?.Labels, ownership, `container ${initializerName}`);
      await this.removeContainer(initializerName, initializer);
    }
    await this.removeWorkspaceVolumes(ownership);
  }

  private workspaceMounts(
    ownership: Ownership,
    role: "agent" | "gateway" = "gateway",
  ): readonly {
    readonly Type: "volume";
    readonly Source: string;
    readonly Target: string;
  }[] {
    if (ownership.agentId === undefined) {
      throw new OwnershipFailure("Workspace storage requires an exact Agent.");
    }
    const prefix = `oce-${sha256Hex(ownership.namespaceId, 12)}-${sha256Hex(ownership.agentId, 12)}`;
    return [
      {
        Type: "volume",
        Source: `${prefix}-${role === "agent" ? "harness-state" : "state"}`,
        Target: "/home/node/.openclaw",
      },
      { Type: "volume", Source: `${prefix}-workspace`, Target: "/home/node/workspace" },
      { Type: "volume", Source: `${prefix}-workspace`, Target: "/home/node/.openclaw/workspace" },
    ];
  }

  private workspaceDirectory(revision: Readonly<AgentRevision>): string {
    return dockerSetupWorkspace(revision.configuration, preparationSettingError);
  }

  private recoveryConfigurationEligible(revision: Readonly<AgentRevision>): boolean {
    // Dedicated Codex artifacts install executable plugin code in the Harness,
    // not the Gateway. Other artifact targets have no qualified recovery path.
    const runtime = this.pluginRuntimeForRevision(revision);
    return (
      this.trustedGatewayToolBoundary === TRUSTED_GATEWAY_TOOL_BOUNDARY &&
      this.nativeStateRecoverySupported &&
      revision.harness.mode === "dedicated" &&
      (runtime === undefined || runtime.kind === "codex") &&
      nativeGatewayRecoveryConfigurationEligible(revision.configuration)
    );
  }

  private recoveryVolumeName(ownership: Ownership): string {
    return `${this.workspaceMounts(ownership)[0]!.Source}-recovery`;
  }

  private verifyRecoveryVolume(
    volume: DockerLabeledResourceInspect | undefined,
    ownership: Ownership,
    name: string,
    nonce: string,
  ): void {
    this.verifyOwnership(volume?.Labels, ownership, `volume ${name}`);
    if (
      volume?.Name !== name ||
      volume.Labels?.[ROLE_LABEL] !== STATE_RECOVERY_ROLE ||
      volume.Labels[STATE_INSTANCE_LABEL] !== nonce ||
      volume.Labels[STATE_ORIGIN_LABEL] !== GATEWAY_PRIVATE_STATE_ORIGIN
    ) {
      throw new OwnershipFailure("Refusing unrelated Docker recovery metadata.");
    }
  }

  private async recoveryStorage(
    ownership: Ownership,
    creation?: { readonly freshNonce: string } | { readonly manual: true },
  ): Promise<DockerGatewayRecoveryStorage | undefined> {
    const stateVolume = this.workspaceMounts(ownership)[0]!.Source;
    const state = await this.volume(stateVolume);
    if (state === undefined) {
      return undefined;
    }
    this.verifyOwnership(state.Labels, ownership, `volume ${stateVolume}`);
    const nonce = state.Labels?.[STATE_INSTANCE_LABEL];
    if (
      state.Name !== stateVolume ||
      state.Labels?.[ROLE_LABEL] !== "workspace" ||
      state.Labels[STATE_ORIGIN_LABEL] !== GATEWAY_PRIVATE_STATE_ORIGIN ||
      !/^[a-f0-9]{32}$/.test(nonce ?? "")
    ) {
      return undefined;
    }
    const metadataVolume = this.recoveryVolumeName(ownership);
    let metadata = await this.volume(metadataVolume);
    if (metadata === undefined) {
      // A label on retained data is not a replacement for the missing custody
      // snapshot. Only the caller that just created this private state may seed it.
      if (creation === undefined || ("freshNonce" in creation && creation.freshNonce !== nonce)) {
        return undefined;
      }
      const created = (await this.request(
        "POST",
        "/volumes/create",
        {
          Name: metadataVolume,
          Labels: {
            ...this.ownershipMetadata(ownership),
            [ROLE_LABEL]: STATE_RECOVERY_ROLE,
            [STATE_ORIGIN_LABEL]: GATEWAY_PRIVATE_STATE_ORIGIN,
            [STATE_INSTANCE_LABEL]: nonce,
          },
        },
        [201],
      )) as DockerLabeledResourceInspect;
      this.verifyRecoveryVolume(created, ownership, metadataVolume, nonce!);
      metadata = await this.volume(metadataVolume);
    }
    this.verifyRecoveryVolume(metadata, ownership, metadataVolume, nonce!);
    const holderName = `${this.gatewayContainerName(ownership.namespaceId, ownership.agentId!)}-recovery`;
    let holder = await this.container(holderName);
    if (holder === undefined) {
      try {
        await this.request(
          "POST",
          `/containers/create?name=${encodeURIComponent(holderName)}`,
          {
            Image: this.options.images.gateway,
            User: "1000:1000",
            Entrypoint: ["node"],
            Cmd: ["-e", "process.exit(1)"],
            Env: [],
            Labels: {
              ...this.ownershipMetadata(ownership),
              [ROLE_LABEL]: STATE_RECOVERY_ROLE,
              [STATE_INSTANCE_LABEL]: nonce,
              [STATE_ORIGIN_LABEL]: GATEWAY_PRIVATE_STATE_ORIGIN,
            },
            HostConfig: {
              NetworkMode: "none",
              ReadonlyRootfs: true,
              CapDrop: ["ALL"],
              SecurityOpt: ["no-new-privileges"],
              Mounts: [
                { Type: "volume", Source: metadataVolume, Target: STATE_RECOVERY_DIRECTORY },
              ],
            },
          },
          [201],
        );
      } catch (error) {
        if (statusCode(error) !== 409) {
          throw error;
        }
      }
      holder = await this.container(holderName);
    }
    if (holder?.Id === undefined || !/^[a-f0-9]{64}$/.test(holder.Id)) {
      throw new OwnershipFailure("Docker recovery holder identity is incomplete.");
    }
    const storage = {
      ownership,
      stateVolume,
      metadataVolume,
      nonce: nonce!,
      storageId: `${stateVolume}:${nonce}`,
      holderId: holder.Id,
    };
    await this.verifyRecoveryStorage(storage);
    return storage;
  }

  private async verifyRecoveryStorage(storage: DockerGatewayRecoveryStorage): Promise<void> {
    const state = await this.volume(storage.stateVolume);
    this.verifyOwnership(state?.Labels, storage.ownership, `volume ${storage.stateVolume}`);
    if (
      state?.Name !== storage.stateVolume ||
      state.Labels?.[ROLE_LABEL] !== "workspace" ||
      state.Labels[STATE_INSTANCE_LABEL] !== storage.nonce ||
      state.Labels[STATE_ORIGIN_LABEL] !== GATEWAY_PRIVATE_STATE_ORIGIN
    ) {
      throw new OwnershipFailure("Docker Gateway storage identity changed.");
    }
    await this.verifyRecoveryHolder(storage);
  }

  private async verifyRecoveryHolder(storage: DockerGatewayRecoveryStorage): Promise<void> {
    this.verifyRecoveryVolume(
      await this.volume(storage.metadataVolume),
      storage.ownership,
      storage.metadataVolume,
      storage.nonce,
    );
    const holder = await this.container(storage.holderId);
    this.verifyOwnership(holder?.Config?.Labels, storage.ownership, "recovery holder");
    const mounts = holder?.HostConfig?.Mounts ?? [];
    if (
      holder?.Id !== storage.holderId ||
      holder.Config?.Labels?.[ROLE_LABEL] !== STATE_RECOVERY_ROLE ||
      holder.Config.Labels[STATE_INSTANCE_LABEL] !== storage.nonce ||
      holder.Config.Labels[STATE_ORIGIN_LABEL] !== GATEWAY_PRIVATE_STATE_ORIGIN ||
      holder.Config.User !== "1000:1000" ||
      holder.HostConfig?.NetworkMode !== "none" ||
      holder.HostConfig.ReadonlyRootfs !== true ||
      holder.HostConfig.Privileged === true ||
      ![undefined, ""].includes(holder.HostConfig.PidMode) ||
      holder.State?.Running !== false ||
      holder.State.Pid !== 0 ||
      holder.State.Status !== "created" ||
      !(Date.parse(holder.State.StartedAt ?? "") <= 0) ||
      mounts.length !== 1 ||
      mounts[0]?.Type !== "volume" ||
      mounts[0].Source !== storage.metadataVolume ||
      mounts[0].Target !== STATE_RECOVERY_DIRECTORY ||
      mounts[0].ReadOnly === true
    ) {
      throw new OwnershipFailure("Recovery metadata requires its never-started private holder.");
    }
  }

  private async readRecoveryFile(
    storage: DockerGatewayRecoveryStorage,
    name: string,
  ): Promise<string | undefined> {
    await this.verifyRecoveryStorage(storage);
    try {
      const archive = (await this.request(
        "GET",
        `/containers/${storage.holderId}/archive?path=${encodeURIComponent(`${STATE_RECOVERY_DIRECTORY}/${name}`)}`,
        undefined,
        [200],
        "archive",
      )) as Buffer;
      await this.verifyRecoveryStorage(storage);
      return dockerArchiveFile(archive, name);
    } catch (error) {
      if (statusCode(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private async writeRecoveryFile(
    storage: DockerGatewayRecoveryStorage,
    name: string,
    value: string,
  ): Promise<void> {
    if (Buffer.byteLength(value) >= MAX_STATE_RECOVERY_BYTES) {
      throw new ConfigurationFailure("Docker recovery metadata is too large.");
    }
    await this.verifyRecoveryStorage(storage);
    await this.request(
      "PUT",
      `/containers/${storage.holderId}/archive?path=${encodeURIComponent(STATE_RECOVERY_DIRECTORY)}`,
      dockerArchiveEntry(name, Buffer.from(value)),
      [200],
    );
    await this.verifyRecoveryStorage(storage);
  }

  private async readRecoverySnapshot(
    storage: DockerGatewayRecoveryStorage,
  ): Promise<DockerGatewayRecoverySnapshot | undefined> {
    if ((await this.readRecoveryFile(storage, STATE_RECOVERY_MANUAL_FILE)) !== undefined) {
      return undefined;
    }
    const text = await this.readRecoveryFile(storage, STATE_RECOVERY_FILE);
    if (text === undefined) {
      return undefined;
    }
    let snapshot;
    try {
      snapshot = asRecord(JSON.parse(text));
    } catch {
      return undefined;
    }
    const binding =
      snapshot?.binding === undefined
        ? undefined
        : parseDockerGatewayStateOwnerBinding(snapshot.binding);
    if (
      snapshot?.version !== 1 ||
      snapshot.stateOrigin !== GATEWAY_PRIVATE_STATE_ORIGIN ||
      snapshot.storageId !== storage.storageId ||
      snapshot.stateInstance !== storage.nonce ||
      (snapshot.binding !== undefined &&
        (binding === undefined ||
          binding.storageId !== storage.storageId ||
          binding.owner.databasePath !== GATEWAY_STATE_DATABASE_PATH))
    ) {
      return undefined;
    }
    const owner = parseNativeGatewayStateOwner(snapshot.owner);
    const requestPresent =
      snapshot.owner !== undefined ||
      snapshot.instanceId !== undefined ||
      snapshot.revisionId !== undefined;
    if (
      requestPresent &&
      (owner === undefined ||
        binding?.termination === undefined ||
        !nativeGatewayOwnersMatch([{ kind: "state-owner", owner }], binding.owner) ||
        !isNonEmptyString(snapshot.revisionId) ||
        !isNonEmptyString(snapshot.instanceId))
    ) {
      return undefined;
    }
    return {
      version: 1,
      stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
      storageId: storage.storageId,
      stateInstance: storage.nonce,
      ...(binding === undefined ? {} : { binding }),
      ...(requestPresent
        ? {
            owner: owner!,
            revisionId: snapshot.revisionId as string,
            instanceId: snapshot.instanceId as string,
          }
        : {}),
    };
  }

  private async writeRecoverySnapshot(
    storage: DockerGatewayRecoveryStorage,
    snapshot: DockerGatewayRecoverySnapshot,
  ): Promise<void> {
    if ((await this.readRecoveryFile(storage, STATE_RECOVERY_MANUAL_FILE)) !== undefined) {
      throw new ConfigurationFailure("Gateway state requires manual recovery.");
    }
    await this.writeRecoveryFile(storage, STATE_RECOVERY_FILE, JSON.stringify(snapshot));
  }

  private async invalidateRecoveryOrigin(ownership: Ownership): Promise<void> {
    const storage = await this.recoveryStorage(ownership, { manual: true });
    if (storage !== undefined) {
      // This separate monotonic entry survives a stale writer's complete snapshot.
      await this.writeRecoveryFile(storage, STATE_RECOVERY_MANUAL_FILE, "manual\n");
    }
  }

  private async gatewayRecoveryStorage(
    revision: Readonly<AgentRevision>,
    workspaceSetup: Readonly<WorkspaceSetup> | undefined,
  ): Promise<DockerGatewayRecoveryStorage | undefined> {
    if (workspaceSetup === undefined || !this.recoveryConfigurationEligible(revision)) {
      return undefined;
    }
    const ownership = this.gatewayOwnership(revision);
    const storage = await this.recoveryStorage(ownership);
    if (storage !== undefined && (await this.readRecoverySnapshot(storage)) !== undefined) {
      return storage;
    }
    // Missing custody is permanently manual. This also closes the creation race
    // in which another reconciliation sees the data volume before its origin.
    await this.invalidateRecoveryOrigin(ownership);
    return undefined;
  }

  private protectedGatewayLayout(
    inspect: DockerContainerInspect,
    storage: DockerGatewayRecoveryStorage,
  ): boolean {
    const env = containerEnvironment(inspect);
    const mounts = inspect.HostConfig?.Mounts ?? [];
    return (
      inspect.Config?.User === "1000:1000" &&
      inspect.HostConfig?.ReadonlyRootfs === true &&
      inspect.HostConfig.Privileged !== true &&
      [undefined, ""].includes(inspect.HostConfig.PidMode) &&
      env.OPENCLAW_TRUSTED_GATEWAY_TOOL_BOUNDARY === TRUSTED_GATEWAY_TOOL_BOUNDARY &&
      env.OPENCLAW_STATE_RECOVERY_ORIGIN === GATEWAY_PRIVATE_STATE_ORIGIN &&
      env.OPENCLAW_STATE_RECOVERY_STORAGE_ID === storage.storageId &&
      env.OPENCLAW_STATE_OWNER_RECOVERY_PATH ===
        `${STATE_RECOVERY_DIRECTORY}/${STATE_RECOVERY_FILE}` &&
      env.OPENCLAW_RUNTIME_STATUS_PORT === String(STATE_RECOVERY_PORT) &&
      env.OPENCLAW_RUNTIME_STATUS_CONTAINER === "gateway" &&
      /^[a-f0-9]{64}$/.test(env.OPENCLAW_RUNTIME_STATUS_TOKEN ?? "") &&
      JSON.stringify(inspect.Config.Healthcheck?.Test) ===
        JSON.stringify(["CMD", "node", "-e", healthcheckCommand(protectedGatewayHealthcheck())]) &&
      mounts.some(
        (mount) => mount.Source === storage.stateVolume && mount.Target === "/home/node/.openclaw",
      ) &&
      mounts.filter((mount) => mount.Source === storage.metadataVolume).length === 1 &&
      mounts.some(
        (mount) =>
          mount.Source === storage.metadataVolume &&
          mount.Type === "volume" &&
          mount.Target === STATE_RECOVERY_DIRECTORY &&
          mount.ReadOnly === true,
      )
    );
  }

  private gatewayRuntimeStatus(
    inspect: DockerContainerInspect,
  ): ReturnType<typeof parseNativeGatewayStateObservation> {
    // Moby resets status/streak on each start but retains old log entries.
    // Its monitor appends a result and updates status/streak under the inspect
    // lock. Starting+zero therefore cannot authorize a retained old report.
    const state = inspect.State;
    const health = state?.Health;
    const entry = health?.Log?.at(-1);
    const start = Date.parse(entry?.Start ?? "");
    const end = Date.parse(entry?.End ?? "");
    const currentMonitor =
      (health?.Status === "healthy" && entry?.ExitCode === 0) ||
      (Number.isSafeInteger(health?.FailingStreak) && (health?.FailingStreak ?? 0) > 0);
    if (
      state?.Running !== true ||
      state.Status !== "running" ||
      state.Paused === true ||
      state.Restarting === true ||
      state.Dead === true ||
      !currentMonitor ||
      !(Date.parse(state.StartedAt ?? "") > 0) ||
      !(start > 0) ||
      !(end >= start) ||
      ![0, 1].includes(entry?.ExitCode ?? -1)
    ) {
      return undefined;
    }
    return dockerOwnerHealthObservation(entry);
  }

  private async observeGatewayState(
    inspected: DockerContainerInspect,
    storage: DockerGatewayRecoveryStorage,
    prepareIntent = true,
  ): Promise<DockerContainerInspect> {
    if (
      inspected.State?.Running !== true ||
      inspected.State.Status !== "running" ||
      inspected.State.Paused === true ||
      inspected.State.Restarting === true ||
      inspected.State.Dead === true
    ) {
      return inspected;
    }
    this.verifyOwnership(inspected.Config?.Labels, storage.ownership, "Gateway container");
    if (
      !this.protectedGatewayLayout(inspected, storage) ||
      !/^[a-f0-9]{64}$/.test(inspected.Id ?? "") ||
      !(Date.parse(inspected.State?.StartedAt ?? "") > 0)
    ) {
      throw new OwnershipFailure("Docker Gateway recovery layout or identity changed.");
    }
    const snapshot = await this.readRecoverySnapshot(storage);
    const after = await this.container(inspected.Id!);
    if (
      after === undefined ||
      after.Id !== inspected.Id ||
      after.State?.StartedAt !== inspected.State?.StartedAt ||
      after.State?.Running !== true ||
      !this.protectedGatewayLayout(after, storage)
    ) {
      throw new OwnershipFailure("Docker Gateway changed during owner observation.");
    }
    if (snapshot === undefined) {
      await this.writeRecoveryFile(storage, STATE_RECOVERY_MANUAL_FILE, "manual\n");
      return after;
    }
    // A newer incomplete probe cannot be replaced by an older qualified one.
    const status = this.gatewayRuntimeStatus(after);
    if (status === undefined) {
      return after;
    }
    const state = asRecord(status.gatewayState);
    const revisionId = inspected.Config?.Labels?.[REVISION_LABEL];
    if (
      status.container !== "gateway" ||
      status.revisionId !== revisionId ||
      state?.storageId !== storage.storageId ||
      state.stateOrigin !== GATEWAY_PRIVATE_STATE_ORIGIN ||
      state.toolBoundary !== TRUSTED_GATEWAY_TOOL_BOUNDARY ||
      !isNonEmptyString(state.instanceId) ||
      state.instanceId.length > 128
    ) {
      throw new OwnershipFailure("Docker Gateway status does not match its observed instance.");
    }
    const recovery = asRecord(state.recovery);
    if (recovery?.state === "manual") {
      await this.writeRecoveryFile(storage, STATE_RECOVERY_MANUAL_FILE, "manual\n");
      return after;
    }
    if (recovery?.state === "refused") {
      return after;
    }
    const owner = parseNativeGatewayStateOwner(state.liveOwner);
    if (
      owner !== undefined &&
      owner.databasePath === GATEWAY_STATE_DATABASE_PATH &&
      state.sourceProtection === GATEWAY_RECOVERY_SOURCE_PROTECTION
    ) {
      const binding = parseDockerGatewayStateOwnerBinding({
        version: 1,
        toolBoundary: TRUSTED_GATEWAY_TOOL_BOUNDARY,
        sourceProtection: GATEWAY_RECOVERY_SOURCE_PROTECTION,
        stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
        storageId: storage.storageId,
        revisionId,
        instanceId: state.instanceId,
        containerId: inspected.Id,
        startedAt: inspected.State!.StartedAt,
        owner,
      });
      if (binding === undefined) {
        throw new OwnershipFailure("Docker Gateway owner identity is incomplete.");
      }
      if (
        snapshot.owner !== undefined ||
        JSON.stringify(snapshot.binding) !== JSON.stringify(binding)
      ) {
        await this.writeRecoverySnapshot(storage, {
          version: 1,
          stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
          storageId: storage.storageId,
          stateInstance: storage.nonce,
          binding,
        });
      }
      return after;
    }
    // A qualified runtime without Native owner support grants no authority;
    // its pristine origin can survive a later clean capability upgrade.
    if (
      prepareIntent &&
      recovery?.state === "waiting" &&
      snapshot.binding?.termination !== undefined
    ) {
      const records = parseNativeGatewayOwnerRecords(recovery.ownerRecords);
      if (records !== undefined && nativeGatewayOwnersMatch(records, snapshot.binding.owner)) {
        if (snapshot.instanceId !== state.instanceId || snapshot.revisionId !== revisionId) {
          await this.writeRecoverySnapshot(storage, {
            ...snapshot,
            revisionId,
            instanceId: state.instanceId,
            owner: snapshot.binding.owner,
          });
        }
      }
    }
    return after;
  }

  private async stopObservedGatewayOwner(
    inspected: DockerContainerInspect,
  ): Promise<DockerGatewayStateOwnerBinding | undefined> {
    if (
      this.trustedGatewayToolBoundary !== TRUSTED_GATEWAY_TOOL_BOUNDARY ||
      !this.nativeStateRecoverySupported ||
      inspected.Config?.Labels?.[ROLE_LABEL] !== "gateway"
    ) {
      return undefined;
    }
    const namespaceId = inspected.Config.Labels[NAMESPACE_LABEL];
    const agentId = inspected.Config.Labels[AGENT_LABEL];
    if (!isNonEmptyString(namespaceId) || !isNonEmptyString(agentId)) {
      return undefined;
    }
    const storage = await this.recoveryStorage({ namespaceId, agentId });
    if (storage === undefined || !this.protectedGatewayLayout(inspected, storage)) {
      return undefined;
    }
    if (inspected.State?.Running === true) {
      await this.observeGatewayState(inspected, storage, false);
    } else {
      // A scoped source denial remains a denial after stop; it never grants an
      // owner binding or borrows an earlier epoch's positive observation.
      const denial = dockerOwnerHealthObservation(inspected.State?.Health?.Log?.at(-1));
      if (
        denial !== undefined &&
        denial.revisionId === inspected.Config.Labels[REVISION_LABEL] &&
        denial.gatewayState.storageId === storage.storageId &&
        denial.gatewayState.recovery?.state === "manual"
      ) {
        await this.writeRecoveryFile(storage, STATE_RECOVERY_MANUAL_FILE, "manual\n");
      }
    }
    const snapshot = await this.readRecoverySnapshot(storage);
    const binding = snapshot?.binding;
    if (
      binding === undefined ||
      binding.containerId !== inspected.Id ||
      binding.startedAt !== inspected.State?.StartedAt ||
      binding.revisionId !== inspected.Config.Labels[REVISION_LABEL]
    ) {
      return undefined;
    }
    await this.request(
      "POST",
      `/containers/${binding.containerId}/stop?t=8`,
      undefined,
      [204, 304],
    );
    const actual = await this.container(binding.containerId);
    const termination = dockerGatewayOwnerTermination(actual, binding);
    if (
      termination === undefined ||
      actual === undefined ||
      !this.protectedGatewayLayout(actual, storage)
    ) {
      throw new OwnershipFailure(
        "Docker did not prove termination of the observed Gateway instance.",
      );
    }
    const stopped = { ...binding, termination };
    // Persist the Engine's actual termination before deleting its evidence.
    await this.writeRecoverySnapshot(storage, {
      version: 1,
      stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
      storageId: storage.storageId,
      stateInstance: storage.nonce,
      binding: stopped,
    });
    const retained = await this.readRecoverySnapshot(storage);
    if (JSON.stringify(retained?.binding) !== JSON.stringify(stopped)) {
      throw new OwnershipFailure("Docker Gateway termination custody was not retained.");
    }
    return stopped;
  }

  private async initializeWorkspace(
    revision: Readonly<AgentRevision>,
    setup: Readonly<WorkspaceSetup>,
  ): Promise<void> {
    if (setup.namespaceId !== revision.namespaceId || setup.agentId !== revision.agentId) {
      throw new OwnershipFailure("Workspace setup must belong to the exact Agent.");
    }
    const workspace = this.workspaceDirectory(revision);
    const ownership = this.gatewayOwnership(revision);
    const protectedState = this.recoveryConfigurationEligible(revision);
    if (!protectedState) {
      await this.invalidateRecoveryOrigin(ownership);
    }
    let freshStateNonce: string | undefined;
    const harnessState =
      revision.harness.mode === "dedicated"
        ? this.workspaceMounts(ownership, "agent")[0]
        : undefined;
    const mounts = [
      ...this.workspaceMounts(ownership),
      ...(harnessState === undefined ? [] : [{ ...harnessState, Target: "/harness-local-state" }]),
    ];
    for (const mount of new Map(mounts.map((mount) => [mount.Source, mount])).values()) {
      let volume = await this.volume(mount.Source);
      if (volume === undefined) {
        if (setup.completed && mount.Source !== harnessState?.Source) {
          throw new ConfigurationFailure("Initialized workspace storage is missing.");
        }
        const nonce =
          protectedState && mount.Source === this.workspaceMounts(ownership)[0]!.Source
            ? randomBytes(16).toString("hex")
            : undefined;
        volume = (await this.request(
          "POST",
          "/volumes/create",
          {
            Name: mount.Source,
            Labels: {
              ...this.ownershipMetadata(ownership),
              [ROLE_LABEL]: "workspace",
              ...(nonce === undefined
                ? {}
                : {
                    [STATE_ORIGIN_LABEL]: GATEWAY_PRIVATE_STATE_ORIGIN,
                    [STATE_INSTANCE_LABEL]: nonce,
                  }),
            },
          },
          [201],
        )) as DockerLabeledResourceInspect;
        if (
          nonce !== undefined &&
          volume?.Name === mount.Source &&
          volume.Labels?.[STATE_INSTANCE_LABEL] === nonce
        ) {
          const actual = await this.volume(mount.Source);
          if (actual?.Name === mount.Source && actual.Labels?.[STATE_INSTANCE_LABEL] === nonce) {
            freshStateNonce = nonce;
          }
          volume = actual;
        }
      }
      this.verifyOwnership(volume?.Labels, ownership, `volume ${mount.Source}`);
      if (volume?.Labels?.[ROLE_LABEL] !== "workspace") {
        throw new OwnershipFailure("Refusing unrelated Docker workspace storage.");
      }
    }
    if (freshStateNonce !== undefined) {
      const storage = await this.recoveryStorage(ownership, { freshNonce: freshStateNonce });
      if (storage !== undefined) {
        await this.writeRecoverySnapshot(storage, {
          version: 1,
          stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
          storageId: storage.storageId,
          stateInstance: storage.nonce,
        });
      }
    }
    const name = `${this.gatewayContainerName(revision.namespaceId, revision.agentId)}-setup`;
    const existing = await this.container(name);
    if (existing !== undefined) {
      this.verifyOwnership(existing.Config?.Labels, ownership, `container ${name}`);
      if (existing.State?.Running) {
        throw new Error("Workspace initialization is already running.");
      }
      await this.removeContainer(name, existing);
    }
    await this.request(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      {
        Image: this.options.images.gateway,
        User: "0:0",
        Entrypoint: ["node"],
        Cmd: [
          "-e",
          `
const setupFs = require("node:fs");
for (const path of ${JSON.stringify([
            "/home/node/.openclaw",
            "/home/node/workspace",
            ...(harnessState === undefined ? [] : ["/harness-local-state"]),
          ])}) {
  setupFs.chownSync(path, 1000, 1000);
  setupFs.chmodSync(path, 0o700);
}
process.setgid(1000);
process.setuid(1000);
${WORKSPACE_SETUP_RUNTIME}`,
        ],
        Env: [
          "HOME=/home/node",
          "OPENCLAW_STATE_DIR=/home/node/.openclaw",
          "OPENCLAW_EXECUTABLE=/app/openclaw.mjs",
          "OPENCLAW_WORKSPACE_SETUP_PATH=/run/oce-workspace-setup.json",
          `OPENCLAW_WORKSPACE_DIR=${workspace}`,
        ],
        Labels: { ...this.ownershipMetadata(ownership), [ROLE_LABEL]: "workspace-setup" },
        HostConfig: {
          NetworkMode: "none",
          CapDrop: ["ALL"],
          CapAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER"],
          SecurityOpt: ["no-new-privileges"],
          Mounts: mounts,
          LogConfig: { Type: "none" },
        },
      },
      [201],
    );
    try {
      // Docker's archive endpoint keeps the payload out of container arguments and metadata.
      // A single fixed-name, owner-only ustar entry is sufficient; no host files are staged.
      const payload = Buffer.from(JSON.stringify(setup));
      const archive = dockerArchiveEntry("oce-workspace-setup.json", payload);
      await this.request(
        "PUT",
        `/containers/${encodeURIComponent(name)}/archive?path=%2Frun`,
        archive,
        [200],
      );
      await this.request(
        "POST",
        `/containers/${encodeURIComponent(name)}/start`,
        undefined,
        [204, 304],
      );
      const started = Date.now();
      while (Date.now() - started < STARTUP_TIMEOUT_MS) {
        const inspected = await this.container(name);
        if (inspected === undefined) {
          throw new Error("Workspace initializer disappeared.");
        }
        if (inspected.State?.Running === false) {
          if (inspected.State.ExitCode !== 0) {
            throw new Error("Workspace initialization failed.");
          }
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Workspace initialization timed out.");
    } finally {
      await this.removeContainer(name);
    }
  }

  private async removeWorkspaceVolumes(ownership: Ownership): Promise<void> {
    const metadataFilters = encodeURIComponent(
      JSON.stringify({
        label: Object.entries({
          ...this.ownershipMetadata(ownership),
          [ROLE_LABEL]: STATE_RECOVERY_ROLE,
        }).map(([key, value]) => `${key}=${value}`),
      }),
    );
    const metadata = (await this.request(
      "GET",
      `/volumes?filters=${metadataFilters}`,
      undefined,
      [200],
    )) as {
      Volumes?: readonly DockerLabeledResourceInspect[];
    };
    for (const listed of metadata.Volumes ?? []) {
      if (listed.Name === undefined) {
        continue;
      }
      const volume = await this.volume(listed.Name);
      if (volume === undefined) {
        continue;
      }
      this.verifyOwnership(volume.Labels, ownership, `volume ${listed.Name}`);
      const agentId = volume.Labels?.[AGENT_LABEL];
      const nonce = volume.Labels?.[STATE_INSTANCE_LABEL];
      if (!isNonEmptyString(agentId) || !/^[a-f0-9]{32}$/.test(nonce ?? "")) {
        throw new OwnershipFailure("Docker recovery metadata ownership is incomplete.");
      }
      const exact = { namespaceId: ownership.namespaceId, agentId };
      if (listed.Name !== this.recoveryVolumeName(exact)) {
        throw new OwnershipFailure("Docker recovery volume name is unrelated.");
      }
      this.verifyRecoveryVolume(volume, exact, listed.Name, nonce!);
      const holderName = `${this.gatewayContainerName(exact.namespaceId, agentId)}-recovery`;
      const holder = await this.container(holderName);
      if (holder !== undefined) {
        const storage = {
          ownership: exact,
          stateVolume: this.workspaceMounts(exact)[0]!.Source,
          metadataVolume: listed.Name,
          nonce: nonce!,
          storageId: `${this.workspaceMounts(exact)[0]!.Source}:${nonce}`,
          holderId: holder.Id ?? "",
        };
        await this.verifyRecoveryHolder(storage);
        await this.request(
          "DELETE",
          `/containers/${storage.holderId}?force=true&v=true`,
          undefined,
          [204, 404],
        );
      }
      this.verifyRecoveryVolume(await this.volume(listed.Name), exact, listed.Name, nonce!);
      await this.request(
        "DELETE",
        `/volumes/${encodeURIComponent(listed.Name)}`,
        undefined,
        [204, 404],
      );
    }
    const labels = { ...this.ownershipMetadata(ownership), [ROLE_LABEL]: "workspace" };
    const filters = encodeURIComponent(
      JSON.stringify({ label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) }),
    );
    const listed = (await this.request("GET", `/volumes?filters=${filters}`, undefined, [200])) as {
      Volumes?: readonly { Name?: string; Labels?: Readonly<Record<string, string>> }[];
    };
    for (const volume of listed.Volumes ?? []) {
      if (volume.Name === undefined) {
        continue;
      }
      // Reinspect immediately before deletion rather than trusting the list response.
      const current = await this.volume(volume.Name);
      if (current === undefined) {
        continue;
      }
      this.verifyOwnership(current.Labels, ownership, `volume ${volume.Name}`);
      if (current.Labels?.[ROLE_LABEL] !== "workspace") {
        throw new OwnershipFailure("Refusing unrelated Docker volume.");
      }
      await this.request(
        "DELETE",
        `/volumes/${encodeURIComponent(volume.Name)}`,
        undefined,
        [204, 404],
      );
    }
  }

  private async reconcileGateway(
    revision: Readonly<AgentRevision>,
    network: string,
    environment: Readonly<Record<string, string>>,
    workspaceSetup?: Readonly<WorkspaceSetup>,
  ): Promise<{
    readonly containerName: string;
    readonly created: boolean;
    readonly ready: boolean;
  }> {
    const containerName = this.gatewayContainerName(revision.namespaceId, revision.agentId);
    const ownership = this.gatewayOwnership(revision);
    const existing = await this.container(containerName);
    const stateRecovery = await this.gatewayRecoveryStorage(revision, workspaceSetup);
    if (
      existing !== undefined &&
      stateRecovery === undefined &&
      containerEnvironment(existing).OPENCLAW_STATE_RECOVERY_ORIGIN === GATEWAY_PRIVATE_STATE_ORIGIN
    ) {
      await this.invalidateRecoveryOrigin(ownership);
    }
    const gatewayConfiguration = dockerGatewayConfigurationDocument(revision.configuration);
    const runtimeEnvironment = { ...environment };
    // These are trusted Compute facts, never an environment-based opt-in.
    for (const key of STATE_RECOVERY_ENVIRONMENT) {
      delete runtimeEnvironment[key];
    }
    const configuration = JSON.stringify(gatewayConfiguration.configuration);
    const configurationHash = sha256Hex(configuration, 32);
    if (existing !== undefined) {
      this.verifyOwnership(existing.Config?.Labels, ownership, `container ${containerName}`);
      const currentRevision = Number(existing.Config?.Labels?.[REVISION_NUMBER_LABEL]);
      const currentRevisionId = existing.Config?.Labels?.[REVISION_LABEL];
      if (!Number.isSafeInteger(currentRevision) || currentRevision < 1 || !currentRevisionId) {
        throw new OwnershipFailure(`Refusing invalid Agent gateway ${containerName}.`);
      }
      if (currentRevision > revision.revision) {
        return { containerName, created: false, ready: false };
      }
      if (currentRevision === revision.revision && currentRevisionId === revision.id) {
        if (existing.Config?.Labels?.[CONFIGURATION_HASH_LABEL] !== configurationHash) {
          throw new ConfigurationFailure(
            "Immutable AgentRevision gateway configuration cannot change.",
          );
        }
        const transportMatches =
          revision.harness.mode === "embedded" ||
          containerTransportToken(existing) === environment.APP_SERVER_TOKEN;
        if (
          healthy(existing) &&
          transportMatches &&
          (stateRecovery === undefined || this.protectedGatewayLayout(existing, stateRecovery))
        ) {
          if (stateRecovery !== undefined) {
            await this.waitForHealthyContainer(containerName, stateRecovery);
          }
          return { containerName, created: false, ready: true };
        }
        await this.removeContainer(containerName, existing);
      }
      if (currentRevision !== revision.revision || currentRevisionId !== revision.id) {
        await this.removeContainer(containerName, existing);
      }
    }

    const inspect = await this.createRuntimeContainer({
      name: containerName,
      image: this.options.images.gateway,
      network,
      ownership,
      role: "gateway",
      workspaceSetup: workspaceSetup !== undefined,
      ...(stateRecovery === undefined ? {} : { stateRecovery }),
      environment: {
        ...runtimeEnvironment,
        ...(gatewayConfiguration.requiresManagedPassword
          ? { [GATEWAY_PASSWORD_ENV]: randomBytes(32).toString("hex") }
          : {}),
        OPENCLAW_CONFIG_JSON: configuration,
        OPENCLAW_CONFIG_PATH: CONFIGURATION_DOCUMENT,
        OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
        OPENCLAW_STATE_DIR: "/home/node/.openclaw",
        HOME: "/home/node",
        ...(stateRecovery === undefined
          ? {}
          : {
              OPENCLAW_STATE_OWNER_RECOVERY_PATH: `${STATE_RECOVERY_DIRECTORY}/${STATE_RECOVERY_FILE}`,
              OPENCLAW_TRUSTED_GATEWAY_TOOL_BOUNDARY: TRUSTED_GATEWAY_TOOL_BOUNDARY,
              OPENCLAW_STATE_RECOVERY_ORIGIN: GATEWAY_PRIVATE_STATE_ORIGIN,
              OPENCLAW_STATE_RECOVERY_STORAGE_ID: stateRecovery.storageId,
              OPENCLAW_RUNTIME_STATUS_PORT: String(STATE_RECOVERY_PORT),
              OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
              OPENCLAW_RUNTIME_STATUS_TOKEN: randomBytes(32).toString("hex"),
              OPENCLAW_AGENT_REVISION_ID: revision.id,
            }),
      },
      command:
        (workspaceSetup === undefined
          ? ""
          : workspaceSetupVerifier(workspaceSetup, this.workspaceDirectory(revision))) +
        GATEWAY_RUNTIME_ENTRYPOINT,
      healthcheckScript:
        stateRecovery === undefined
          ? `fetch("http://127.0.0.1:${GATEWAY_PORT}/readyz").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));`
          : protectedGatewayHealthcheck(),
      exposedPort: GATEWAY_PORT,
      labels: {
        [REVISION_LABEL]: revision.id,
        [REVISION_NUMBER_LABEL]: String(revision.revision),
        [CONFIGURATION_HASH_LABEL]: configurationHash,
        [HARNESS_VERSION_LABEL]: revision.harness.version,
      },
      portBindings: {
        [`${GATEWAY_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }],
      },
    });
    this.verifyOwnership(inspect.Config?.Labels, ownership, `container ${containerName}`);
    return { containerName, created: true, ready: true };
  }

  private async reconcileAgent(
    revision: Readonly<AgentRevision>,
    network: string,
    loggingLevel: LoggingLevel,
    environment: Readonly<Record<string, string>>,
    workspaceSetup?: Readonly<WorkspaceSetup>,
  ): Promise<{
    readonly containerName: string;
    readonly created: boolean;
    readonly appServerToken: string;
  }> {
    const containerName = this.agentContainerName(
      revision.namespaceId,
      revision.agentId,
      revision.id,
    );
    const ownership = this.agentOwnership(revision);
    const existing = await this.container(containerName);
    if (existing !== undefined) {
      this.verifyOwnership(existing.Config?.Labels, ownership, `container ${containerName}`);
      const stateMounts = existing.HostConfig?.Mounts ?? [];
      const isolatedState =
        workspaceSetup === undefined ||
        stateMounts.some(
          (mount) =>
            mount.Target === "/home/node/.openclaw" &&
            mount.Source === this.workspaceMounts(ownership, "agent")[0]!.Source,
        );
      const noGatewayState = stateMounts.every(
        (mount) =>
          mount.Source !== this.workspaceMounts(ownership)[0]!.Source &&
          mount.Source !== this.recoveryVolumeName(ownership),
      );
      if (healthy(existing) && isolatedState && noGatewayState) {
        return {
          containerName,
          created: false,
          appServerToken: required(containerTransportToken(existing), "Codex transport token"),
        };
      }
      await this.removeContainer(containerName, existing);
    }
    // OCC admission requires all native entries to share the same primary model.
    const agents = asRecord(revision.configuration.agents);
    const selection =
      asRecord(agents?.defaults)?.model ??
      Object.values(asRecord(agents?.entries) ?? {})
        .map((entry) => asRecord(entry)?.model)
        .find((model) => model !== undefined);
    const model = typeof selection === "string" ? selection : asRecord(selection)?.primary;
    const appServerToken = randomBytes(32).toString("hex");
    await this.createRuntimeContainer({
      name: containerName,
      image: this.options.images.agent,
      network,
      ownership,
      role: "agent",
      workspaceSetup: workspaceSetup !== undefined,
      environment: {
        ...environment,
        APP_SERVER_PORT: String(AGENT_TRANSPORT_PORT),
        APP_SERVER_TOKEN: appServerToken,
        CODEX_HOME: "/home/node/.codex",
        CODEX_LOGIN_MODE: "api_key",
        ...(typeof model === "string" ? { OPENCLAW_HARNESS_MODEL: model } : {}),
        LOG_FORMAT: "json",
        RUST_LOG: `${loggingLevel},codex_otel=off`,
        HOME: "/home/node",
        PATH: "/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
      command:
        (workspaceSetup === undefined
          ? ""
          : workspaceSetupVerifier(workspaceSetup, this.workspaceDirectory(revision))) +
        AGENT_RUNTIME_ENTRYPOINT,
      healthcheckScript: AGENT_READINESS_ENTRYPOINT,
      exposedPort: AGENT_TRANSPORT_PORT,
      labels: {
        [REVISION_LABEL]: revision.id,
        [REVISION_NUMBER_LABEL]: String(revision.revision),
        [HARNESS_VERSION_LABEL]: revision.harness.version,
      },
    });
    return { containerName, created: true, appServerToken };
  }

  private async createRuntimeContainer(
    input: RuntimeContainerInput,
  ): Promise<DockerContainerInspect> {
    if (input.stateRecovery !== undefined && input.role !== "gateway") {
      throw new OwnershipFailure("Recovery metadata belongs only to the Gateway.");
    }
    const labels = {
      ...this.ownershipMetadata(input.ownership),
      [ROLE_LABEL]: input.role,
      ...input.labels,
      [VERSION_LABEL]: input.image,
    };
    const created = await this.request(
      "POST",
      `/containers/create?name=${encodeURIComponent(input.name)}`,
      {
        Image: input.image,
        User: "1000:1000",
        Env: Object.entries(input.environment).map(([name, value]) => `${name}=${value}`),
        Entrypoint: ["node"],
        Cmd: ["-e", ...nodeProgramArguments(input.command)],
        Labels: labels,
        ExposedPorts: {
          [`${input.exposedPort}/tcp`]: {},
          ...(input.stateRecovery === undefined ? {} : { [`${STATE_RECOVERY_PORT}/tcp`]: {} }),
        },
        Healthcheck: {
          // Podman's Docker-compatible API splits CMD healthcheck arguments on
          // whitespace, so keep the script argument opaque and whitespace-free.
          Test: ["CMD", "node", "-e", healthcheckCommand(input.healthcheckScript)],
          Interval: 2_000_000_000,
          Timeout: 2_000_000_000,
          Retries: 15,
        },
        HostConfig: {
          NetworkMode: input.network,
          ...(input.workspaceSetup || input.stateRecovery !== undefined
            ? {
                Mounts: [
                  ...(input.workspaceSetup
                    ? this.workspaceMounts(input.ownership, input.role)
                    : []),
                  ...(input.stateRecovery === undefined
                    ? []
                    : [
                        {
                          Type: "volume",
                          Source: input.stateRecovery.metadataVolume,
                          Target: STATE_RECOVERY_DIRECTORY,
                          ReadOnly: true,
                        },
                      ]),
                ],
              }
            : {}),
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          Tmpfs: this.podmanApi
            ? {
                "/home/node": "size=1024m,mode=1777",
                "/tmp": "size=64m,mode=1777",
              }
            : {
                "/home/node": "size=1024m,uid=1000,gid=1000,mode=700",
                "/tmp": "size=64m,uid=1000,gid=1000,mode=1777",
              },
          ...(input.portBindings === undefined ? {} : { PortBindings: input.portBindings }),
          ...(this.options.loggingAddress === undefined
            ? {}
            : { LogConfig: this.logConfig(labels) }),
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [input.network]: { Aliases: [input.name] },
          },
        },
      },
      [201],
    );
    const createdId = asRecord(created)?.Id;
    const actualId =
      typeof createdId === "string" && /^[a-f0-9]{64}$/.test(createdId) ? createdId : undefined;
    if (input.stateRecovery !== undefined && actualId === undefined) {
      throw new OwnershipFailure(
        "Docker did not return the protected Gateway's immutable identity.",
      );
    }
    const target = actualId ?? input.name;
    let startedInstance: DockerContainerInspect | undefined;
    try {
      if (actualId !== undefined) {
        const observed = await this.container(actualId);
        this.verifyOwnership(observed?.Config?.Labels, input.ownership, "created container");
        if (observed?.Id !== actualId || observed.Config?.Labels?.[ROLE_LABEL] !== input.role) {
          throw new OwnershipFailure("Docker created another runtime instance.");
        }
      }
      await this.request(
        "POST",
        `/containers/${encodeURIComponent(target)}/start`,
        undefined,
        [204, 304],
      );
      if (input.stateRecovery !== undefined) {
        startedInstance = await this.container(target);
      }
      return await this.waitForHealthyContainer(target, input.stateRecovery, startedInstance);
    } catch (error) {
      await this.removeContainer(target, startedInstance).catch(() => {});
      throw error;
    }
  }

  private logConfig(labels: Readonly<Record<string, string>>): {
    readonly Type: "fluentd";
    readonly Config: Readonly<Record<string, string>>;
  } {
    const exportedLabels = Object.keys(labels)
      .filter((name) => name.startsWith("org.openclaw.enterprise."))
      .sort()
      .join(",");
    return {
      Type: "fluentd",
      Config: {
        "fluentd-address": required(this.options.loggingAddress, "Docker logging address"),
        "fluentd-async": "true",
        "fluentd-buffer-limit": "1024",
        "fluentd-write-timeout": "1s",
        mode: "non-blocking",
        "max-buffer-size": "1m",
        "cache-disabled": "false",
        "cache-max-size": "10m",
        "cache-max-file": "2",
        "cache-compress": "true",
        labels: exportedLabels,
      },
    };
  }

  private providerEnvironment(): Readonly<Record<string, string>> {
    const credential = process.env.OPENAI_API_KEY;
    if (credential === undefined || credential.trim().length === 0) {
      throw new ConfigurationFailure(
        "OPENAI_API_KEY must be present for Docker runtime execution.",
      );
    }
    return { [MODEL_API_KEY]: credential };
  }

  private pluginRuntimeForRevision(
    revision: Readonly<AgentRevision>,
  ): PluginRuntimeSpec | undefined {
    try {
      return pluginRuntimeSpecForRevision(revision);
    } catch (error) {
      throw new ConfigurationFailure(
        error instanceof Error
          ? error.message
          : "AgentRevision plugin runtime artifacts are invalid.",
      );
    }
  }

  private pluginRuntimeEnvironmentForWorkload(
    runtime: PluginRuntimeSpec | undefined,
    role: "agent" | "gateway",
    embedded: boolean,
  ): Readonly<Record<string, string>> {
    if (runtime === undefined) {
      return {};
    }
    const applies =
      (runtime.kind === "openclaw" && role === "gateway" && embedded) ||
      (runtime.kind === "codex" && role === "agent" && !embedded) ||
      (runtime.kind === "codex" &&
        role === "gateway" &&
        !embedded &&
        (Object.keys(runtime.selections).length > 0 || runtime.pluginApprovers !== undefined));
    if (!applies) {
      return {};
    }
    try {
      return {
        ...pluginRuntimeEnvironment(runtime),
        ...(runtime.kind === "codex" && role === "agent"
          ? { [PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT]: PLUGIN_RUNTIME_READY_MARKER }
          : {}),
      };
    } catch (error) {
      throw new ConfigurationFailure(
        error instanceof Error
          ? error.message
          : "AgentRevision plugin runtime artifacts are invalid.",
      );
    }
  }

  private ownershipMetadata(ownership: Ownership): Record<string, string> {
    const labels: Record<string, string> = {
      [MANAGED_LABEL]: MANAGED_VALUE,
      [COMPUTE_DRIVER_LABEL]: "docker",
      [NAMESPACE_LABEL]: ownership.namespaceId,
    };
    if (ownership.agentId !== undefined) {
      labels[AGENT_LABEL] = ownership.agentId;
    }
    if (ownership.revisionId !== undefined) {
      labels[REVISION_LABEL] = ownership.revisionId;
    }
    return labels;
  }

  private gatewayOwnership(revision: Readonly<AgentRevision>): Ownership {
    return { namespaceId: revision.namespaceId, agentId: revision.agentId };
  }

  private agentOwnership(revision: Readonly<AgentRevision>): Ownership {
    return {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
    };
  }

  private verifyOwnership(
    labels: Readonly<Record<string, string>> | undefined,
    ownership: Ownership,
    description: string,
  ): void {
    const expected = this.ownershipMetadata(ownership);
    for (const [key, value] of Object.entries(expected)) {
      if (labels?.[key] !== value) {
        throw new OwnershipFailure(`Refusing unowned Docker ${description}.`);
      }
    }
  }

  private networkName(namespaceId: string): string {
    return `oce-${slug(namespaceId)}-${sha256Hex(namespaceId, 12)}`;
  }

  private gatewayContainerName(namespaceId: string, agentId: string): string {
    return `oce-${sha256Hex(namespaceId, 12)}-gateway-${sha256Hex(agentId, 12)}`;
  }

  private agentContainerName(namespaceId: string, agentId: string, revisionId: string): string {
    return `oce-${sha256Hex(namespaceId, 12)}-agent-${sha256Hex(agentId, 12)}-rev-${sha256Hex(revisionId, 12)}`;
  }

  private async image(ref: string): Promise<void> {
    await this.request("GET", `/images/${encodeURIComponent(ref)}/json`, undefined, [200]);
  }

  private async network(name: string): Promise<DockerLabeledResourceInspect | undefined> {
    return this.inspect<DockerLabeledResourceInspect>(`/networks/${encodeURIComponent(name)}`);
  }

  private async removeNetwork(name: string): Promise<void> {
    await this.request("DELETE", `/networks/${encodeURIComponent(name)}`, undefined, [204, 404]);
  }

  private async container(name: string): Promise<DockerContainerInspect | undefined> {
    return this.inspect<DockerContainerInspect>(`/containers/${encodeURIComponent(name)}/json`);
  }

  private async volume(name: string): Promise<DockerLabeledResourceInspect | undefined> {
    return this.inspect<DockerLabeledResourceInspect>(`/volumes/${encodeURIComponent(name)}`);
  }

  private async inspect<T>(path: string): Promise<T | undefined> {
    try {
      return (await this.request("GET", path, undefined, [200])) as T;
    } catch (error) {
      if (statusCode(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private async containerIdsForNamespace(namespaceId: string): Promise<readonly string[]> {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [
          `${MANAGED_LABEL}=${MANAGED_VALUE}`,
          `${COMPUTE_DRIVER_LABEL}=docker`,
          `${NAMESPACE_LABEL}=${namespaceId}`,
        ],
      }),
    );
    const listed = (await this.request(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
      undefined,
      [200],
    )) as readonly { readonly Id?: string }[];
    const containerIds: string[] = [];
    for (const container of listed) {
      if (container.Id === undefined) {
        continue;
      }
      const current = await this.container(container.Id);
      if (current === undefined) {
        continue;
      }
      this.verifyOwnership(current.Config?.Labels, { namespaceId }, `container ${container.Id}`);
      containerIds.push(container.Id);
    }
    return containerIds;
  }

  private async removeContainer(name: string, expected?: DockerContainerInspect): Promise<void> {
    const inspected = await this.container(expected?.Id ?? name);
    if (
      expected?.Id !== undefined &&
      (inspected?.Id !== expected.Id || inspected.State?.StartedAt !== expected.State?.StartedAt)
    ) {
      throw new OwnershipFailure("Docker instance changed before removal.");
    }
    if (inspected?.Config?.Labels?.[ROLE_LABEL] === STATE_RECOVERY_ROLE) {
      const labels = inspected.Config.Labels;
      const ownership = {
        namespaceId: required(labels[NAMESPACE_LABEL], "Recovery namespace"),
        agentId: required(labels[AGENT_LABEL], "Recovery Agent"),
      };
      const nonce = required(labels[STATE_INSTANCE_LABEL], "Recovery storage instance");
      const stateVolume = this.workspaceMounts(ownership)[0]!.Source;
      await this.verifyRecoveryHolder({
        ownership,
        stateVolume,
        metadataVolume: this.recoveryVolumeName(ownership),
        nonce,
        storageId: `${stateVolume}:${nonce}`,
        holderId: inspected.Id ?? "",
      });
    }
    const stopped =
      inspected === undefined ? undefined : await this.stopObservedGatewayOwner(inspected);
    const target = inspected?.Id ?? name;
    if (
      stopped !== undefined &&
      dockerGatewayOwnerTermination(await this.container(target), stopped) === undefined
    ) {
      throw new OwnershipFailure("Docker Gateway instance changed before removal.");
    }
    await this.request(
      "DELETE",
      `/containers/${encodeURIComponent(target)}?force=true&v=true`,
      undefined,
      [204, 404],
    );
  }

  private async waitForHealthyContainer(
    name: string,
    recovery?: DockerGatewayRecoveryStorage,
    expected?: DockerContainerInspect,
  ): Promise<DockerContainerInspect> {
    const started = Date.now();
    while (Date.now() - started < STARTUP_TIMEOUT_MS) {
      const inspected = await this.container(name);
      if (inspected === undefined) {
        throw new Error(`Docker container ${name} disappeared.`);
      }
      if (
        expected !== undefined &&
        (inspected.Id !== expected.Id || inspected.State?.StartedAt !== expected.State?.StartedAt)
      ) {
        throw new OwnershipFailure("Docker runtime instance changed during readiness.");
      }
      if (inspected.State?.Running === false) {
        throw new Error(`Docker container ${name} exited before readiness.`);
      }
      // Observation may withhold recovery authority, but it is not a second
      // readiness condition. Native health remains available without telemetry.
      const current =
        recovery === undefined ? inspected : await this.observeGatewayState(inspected, recovery);
      const lastExit = current.State?.Health?.Log?.at(-1)?.ExitCode;
      const currentProtectedHealth =
        current.State?.Status === "running" &&
        current.State.Paused !== true &&
        current.State.Restarting !== true &&
        current.State.Dead !== true &&
        (lastExit === undefined || lastExit === 0);
      if (healthy(current) && (recovery === undefined || currentProtectedHealth)) {
        return current;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Docker container ${name} readiness timed out.`);
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    expected: readonly number[],
    responseType: "json" | "archive" = "json",
  ): Promise<unknown> {
    const ownerSignal = currentComputeAbortSignal();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = ownerSignal === undefined ? timeout : AbortSignal.any([ownerSignal, timeout]);
    return withComputeAbortSignal(
      signal,
      () =>
        new Promise<unknown>((resolve, reject) => {
          const payload =
            body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
          const request = httpRequest(
            {
              socketPath: SOCKET_PATH,
              method,
              path,
              signal,
              headers:
                payload === undefined
                  ? undefined
                  : {
                      "content-type": Buffer.isBuffer(body)
                        ? "application/x-tar"
                        : "application/json",
                      "content-length": Buffer.byteLength(payload),
                    },
            },
            (response) => {
              const chunks: Buffer[] = [];
              let responseBytes = 0;
              response.once("error", reject);
              const contentLength = response.headers["content-length"];
              if (
                typeof contentLength === "string" &&
                Number(contentLength) > MAX_DOCKER_API_RESPONSE_BYTES
              ) {
                response.destroy(new Error("Docker API response is too large."));
                return;
              }
              response.on("data", (chunk: Buffer | string) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                responseBytes += buffer.length;
                if (responseBytes > MAX_DOCKER_API_RESPONSE_BYTES) {
                  response.destroy(new Error("Docker API response is too large."));
                  return;
                }
                chunks.push(buffer);
              });
              response.on("end", () => {
                const status = response.statusCode ?? 0;
                const bytes = Buffer.concat(chunks);
                const text =
                  responseType === "archive" && expected.includes(status)
                    ? ""
                    : bytes.toString("utf8");
                if (!expected.includes(status)) {
                  reject(new DockerApiError(status, text || `Docker API returned HTTP ${status}.`));
                  return;
                }
                if (responseType === "archive") {
                  resolve(bytes);
                  return;
                }
                const contentType = response.headers["content-type"];
                if (
                  typeof contentType === "string" &&
                  contentType.includes("application/json") &&
                  text.length > 0
                ) {
                  try {
                    resolve(JSON.parse(text));
                  } catch {
                    reject(new Error("Docker API returned invalid JSON."));
                  }
                  return;
                }
                resolve(text);
              });
            },
          );
          request.once("error", reject);
          if (payload !== undefined) {
            request.write(payload);
          }
          request.end();
        }),
    );
  }
}

export function createDockerDevelopmentComputeDriverFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DockerComputeDriver {
  const shared = optionalEnvironment(environment.OCC_DOCKER_RUNTIME_IMAGE);
  const loggingAddress = dockerLoggingAddress(environment.OCC_DOCKER_LOGGING_ADDRESS);
  return new DockerComputeDriver({
    images: {
      gateway: optionalEnvironment(environment.OCC_DOCKER_GATEWAY_IMAGE) ?? shared ?? "",
      agent: optionalEnvironment(environment.OCC_DOCKER_AGENT_IMAGE) ?? shared ?? "",
    },
    ...(loggingAddress === undefined ? {} : { loggingAddress }),
  });
}
