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
} from "@openclaw-enterprise/contracts";
import { admittedLoggingLevel } from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, isNonEmptyString, sha256Hex } from "@openclaw-enterprise/utils";
import {
  WORKSPACE_SETUP_RUNTIME,
  workspaceSetupMainAgent,
  workspaceSetupVerifier,
} from "../workspace-setup-runtime.ts";
import { ComputeLifecycleDispatcher } from "../lifecycle-hooks.ts";
import { nodeProgramArguments } from "../node-program.ts";
import { discoverHarnessModels } from "../model-discovery.ts";
import { currentComputeAbortSignal, withComputeAbortSignal } from "../operation-context.ts";
import {
  AGENT_READINESS_ENTRYPOINT,
  AGENT_RUNTIME_ENTRYPOINT,
  PLUGIN_RUNTIME_HELPERS,
} from "../kubernetes/runtime-entrypoints.ts";
import {
  PLUGIN_RUNTIME_READY_MARKER,
  PLUGIN_RUNTIME_READY_MARKER_ENVIRONMENT,
  type PluginRuntimeSpec,
  pluginRuntimeEnvironment,
  pluginRuntimeSpecForRevision,
} from "../plugin-runtime.ts";
import { unsupportedNativeGatewayAuthFields } from "../../../gateway/auth-fields.ts";

export interface DockerComputeDriverOptions {
  readonly images: {
    readonly gateway: string;
    readonly agent: string;
  };
  readonly loggingAddress?: string;
}

interface DockerContainerInspect {
  readonly Image?: string;
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Readonly<Record<string, string>>;
    readonly Env?: readonly string[];
  };
  readonly State?: {
    readonly Running?: boolean;
    readonly ExitCode?: number;
    readonly Health?: {
      readonly Status?: string;
    };
  };
}

interface DockerNetworkInspect {
  readonly Labels?: Readonly<Record<string, string>>;
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
const STARTUP_TIMEOUT_MS = 120_000;
const GATEWAY_PORT = 8080;
const AGENT_TRANSPORT_PORT = 18_790;
const MODEL_API_KEY = "OPENAI_API_KEY";
const CONFIGURATION_DOCUMENT = "/home/node/.openclaw/openclaw.json";
const GATEWAY_PASSWORD_ENV = "OPENCLAW_GATEWAY_PASSWORD";
const GATEWAY_PASSWORD_REFERENCE = `\${${GATEWAY_PASSWORD_ENV}}`;

function dockerGatewayConfigurationDocument(configuration: OpenClawConfigurationDocument): {
  readonly configuration: OpenClawConfigurationDocument;
  readonly requiresManagedPassword: boolean;
} {
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
const { chmodSync, mkdirSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");

${PLUGIN_RUNTIME_HELPERS}

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

mkdirSync("/home/node/.openclaw", { recursive: true, mode: 0o700 });
mkdirSync("/home/node/workspace", { recursive: true, mode: 0o700 });
chmodSync("/home/node/.openclaw", 0o700);
chmodSync("/home/node/workspace", 0o700);
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, process.env.OPENCLAW_CONFIG_JSON, { mode: 0o600 });
delete process.env.OPENCLAW_CONFIG_JSON;
delete process.env.OPENCLAW_LOG_LEVEL;
const pluginRuntime = readGatewayPluginRuntime();
try {
if (pluginRuntime !== undefined) installOpenClawPlugins(pluginRuntime);
const child = spawn(
  "node",
  ["/app/openclaw.mjs", "gateway", "--port", process.env.OPENCLAW_GATEWAY_PORT],
  { stdio: "inherit" },
);
forwardTermination(child);
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)));
} catch (error) {
  if (!holdPluginApproverConfigurationFailure(error)) throw error;
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

function optionalEnvironment(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function healthcheckCommand(script: string): string {
  const encoded = Buffer.from(script).toString("base64");
  return `eval(Buffer.from("${encoded}","base64").toString())`;
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

  constructor(options: DockerComputeDriverOptions) {
    required(options.images.gateway, "Docker gateway image");
    required(options.images.agent, "Docker Codex Agent image");
    const loggingAddress = dockerLoggingAddress(options.loggingAddress);
    this.options = immutableCopy({
      ...options,
      ...(loggingAddress === undefined ? {} : { loggingAddress }),
    });
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
      if (existing === undefined) {
        await this.removeWorkspaceVolumes({ namespaceId: namespace.id });
        return { ...result, namespaceDeleted: true };
      }
      this.verifyOwnership(existing.Labels, { namespaceId: namespace.id }, `network ${name}`);
      await this.lifecycle.beforeNamespaceDelete(namespace);
      for (const containerId of await this.containerIdsForNamespace(namespace.id)) {
        await this.removeContainer(containerId);
      }
      await this.removeWorkspaceVolumes({ namespaceId: namespace.id });
      await this.removeNetwork(name);
      return { ...result, namespaceDeleted: true };
    } catch (error) {
      return { ...result, failure: failure(error) };
    }
  }

  validateHarnessAuth(): never {
    throw new ConfigurationFailure(
      "DOCKER Compute does not support Harness authentication bindings.",
    );
  }

  async prepareRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness> {
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
      const failures = [error];
      for (const name of [gatewayCreated, agentCreated]) {
        if (name === undefined) {
          continue;
        }
        try {
          await this.removeContainer(name);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (launchPrepared) {
        try {
          await this.lifecycle.beforeWorkloadStop(prepared, { cleanup: true });
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Docker workload preparation and cleanup failed.");
      }
      throw error;
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
      await this.removeContainer(agentName);
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
        await this.removeContainer(gatewayName);
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
      await this.removeContainer(initializerName);
    }
    await this.removeWorkspaceVolumes(ownership);
  }

  private workspaceMounts(ownership: Ownership): readonly {
    readonly Type: "volume";
    readonly Source: string;
    readonly Target: string;
  }[] {
    if (ownership.agentId === undefined) {
      throw new OwnershipFailure("Workspace storage requires an exact Agent.");
    }
    const prefix = `oce-${sha256Hex(ownership.namespaceId, 12)}-${sha256Hex(ownership.agentId, 12)}`;
    return [
      { Type: "volume", Source: `${prefix}-state`, Target: "/home/node/.openclaw" },
      { Type: "volume", Source: `${prefix}-workspace`, Target: "/home/node/workspace" },
      { Type: "volume", Source: `${prefix}-workspace`, Target: "/home/node/.openclaw/workspace" },
    ];
  }

  private workspaceDirectory(revision: Readonly<AgentRevision>): string {
    const agents = asRecord(revision.configuration.agents);
    const defaults = asRecord(agents?.defaults);
    const main = workspaceSetupMainAgent(revision.configuration);
    if (main === undefined) {
      throw new ConfigurationFailure("Workspace setup requires only the native main Agent.");
    }
    const workspace = main?.workspace ?? defaults?.workspace ?? "/home/node/.openclaw/workspace";
    if (
      (workspace !== "/home/node/.openclaw/workspace" && workspace !== "/home/node/workspace") ||
      defaults?.skipBootstrap === true ||
      defaults?.skipOptionalBootstrapFiles === true ||
      main?.skipBootstrap === true ||
      main?.skipOptionalBootstrapFiles === true
    ) {
      throw new ConfigurationFailure(
        "Workspace setup requires native bootstrap in exact-Agent managed storage.",
      );
    }
    return workspace;
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
    const mounts = this.workspaceMounts(ownership);
    for (const mount of new Map(mounts.map((mount) => [mount.Source, mount])).values()) {
      let volume = await this.inspect<{ Labels?: Readonly<Record<string, string>> }>(
        `/volumes/${encodeURIComponent(mount.Source)}`,
      );
      if (volume === undefined) {
        if (setup.completed) {
          throw new ConfigurationFailure("Initialized workspace storage is missing.");
        }
        volume = (await this.request(
          "POST",
          "/volumes/create",
          {
            Name: mount.Source,
            Labels: { ...this.ownershipMetadata(ownership), [ROLE_LABEL]: "workspace" },
          },
          [201],
        )) as typeof volume;
      }
      this.verifyOwnership(volume?.Labels, ownership, `volume ${mount.Source}`);
      if (volume?.Labels?.[ROLE_LABEL] !== "workspace") {
        throw new OwnershipFailure("Refusing unrelated Docker workspace storage.");
      }
    }
    const name = `${this.gatewayContainerName(revision.namespaceId, revision.agentId)}-setup`;
    const existing = await this.container(name);
    if (existing !== undefined) {
      this.verifyOwnership(existing.Config?.Labels, ownership, `container ${name}`);
      if (existing.State?.Running) {
        throw new Error("Workspace initialization is already running.");
      }
      await this.removeContainer(name);
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
for (const path of ["/home/node/.openclaw", "/home/node/workspace"]) {
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
      const header = Buffer.alloc(512);
      header.write("oce-workspace-setup.json", 0);
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
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
      const archive = Buffer.concat([
        header,
        payload,
        Buffer.alloc(((512 - (payload.length % 512)) % 512) + 1024),
      ]);
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
      let current: { Labels?: Readonly<Record<string, string>> };
      try {
        current = (await this.request(
          "GET",
          `/volumes/${encodeURIComponent(volume.Name)}`,
          undefined,
          [200],
        )) as typeof current;
      } catch (error) {
        if (statusCode(error) === 404) {
          continue;
        }
        throw error;
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
    const gatewayConfiguration = dockerGatewayConfigurationDocument(revision.configuration);
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
        if (healthy(existing) && transportMatches) {
          return { containerName, created: false, ready: true };
        }
        await this.removeContainer(containerName);
      }
      if (currentRevision !== revision.revision || currentRevisionId !== revision.id) {
        await this.removeContainer(containerName);
      }
    }

    const inspect = await this.createRuntimeContainer({
      name: containerName,
      image: this.options.images.gateway,
      network,
      ownership,
      role: "gateway",
      workspaceSetup: workspaceSetup !== undefined,
      environment: {
        ...environment,
        ...(gatewayConfiguration.requiresManagedPassword
          ? { [GATEWAY_PASSWORD_ENV]: randomBytes(32).toString("hex") }
          : {}),
        OPENCLAW_CONFIG_JSON: configuration,
        OPENCLAW_CONFIG_PATH: CONFIGURATION_DOCUMENT,
        OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
        OPENCLAW_STATE_DIR: "/home/node/.openclaw",
        HOME: "/home/node",
      },
      command:
        (workspaceSetup === undefined
          ? ""
          : workspaceSetupVerifier(workspaceSetup, this.workspaceDirectory(revision))) +
        GATEWAY_RUNTIME_ENTRYPOINT,
      healthcheckScript: `fetch("http://127.0.0.1:${GATEWAY_PORT}/readyz").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));`,
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
      if (healthy(existing)) {
        return {
          containerName,
          created: false,
          appServerToken: required(containerTransportToken(existing), "Codex transport token"),
        };
      }
      await this.removeContainer(containerName);
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
    const labels = {
      ...this.ownershipMetadata(input.ownership),
      [ROLE_LABEL]: input.role,
      ...input.labels,
      [VERSION_LABEL]: input.image,
    };
    await this.request(
      "POST",
      `/containers/create?name=${encodeURIComponent(input.name)}`,
      {
        Image: input.image,
        User: "1000:1000",
        Env: Object.entries(input.environment).map(([name, value]) => `${name}=${value}`),
        Entrypoint: ["node"],
        Cmd: ["-e", ...nodeProgramArguments(input.command)],
        Labels: labels,
        ExposedPorts: { [`${input.exposedPort}/tcp`]: {} },
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
          ...(input.workspaceSetup ? { Mounts: this.workspaceMounts(input.ownership) } : {}),
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
    try {
      await this.request(
        "POST",
        `/containers/${encodeURIComponent(input.name)}/start`,
        undefined,
        [204, 304],
      );
      return await this.waitForHealthyContainer(input.name);
    } catch (error) {
      await this.removeContainer(input.name).catch(() => {});
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

  private async network(name: string): Promise<DockerNetworkInspect | undefined> {
    return this.inspect<DockerNetworkInspect>(`/networks/${encodeURIComponent(name)}`);
  }

  private async removeNetwork(name: string): Promise<void> {
    await this.request("DELETE", `/networks/${encodeURIComponent(name)}`, undefined, [204]);
  }

  private async container(name: string): Promise<DockerContainerInspect | undefined> {
    return this.inspect<DockerContainerInspect>(`/containers/${encodeURIComponent(name)}/json`);
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

  private async removeContainer(name: string): Promise<void> {
    await this.request(
      "DELETE",
      `/containers/${encodeURIComponent(name)}?force=true&v=true`,
      undefined,
      [204, 404],
    );
  }

  private async waitForHealthyContainer(name: string): Promise<DockerContainerInspect> {
    const started = Date.now();
    while (Date.now() - started < STARTUP_TIMEOUT_MS) {
      const inspected = await this.container(name);
      if (inspected === undefined) {
        throw new Error(`Docker container ${name} disappeared.`);
      }
      if (healthy(inspected)) {
        return inspected;
      }
      if (inspected.State?.Running === false) {
        throw new Error(`Docker container ${name} exited before readiness.`);
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
              response.once("error", reject);
              response.on("data", (chunk: Buffer | string) =>
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
              );
              response.on("end", () => {
                const status = response.statusCode ?? 0;
                const text = Buffer.concat(chunks).toString("utf8");
                if (!expected.includes(status)) {
                  reject(new DockerApiError(status, text || `Docker API returned HTTP ${status}.`));
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
