import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import type {
  AgentRevision,
  HarnessAuthSnapshot,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
  RevisionHarnessDescriptor,
  ComputeAgentBinding,
  ComputeDriver,
  ComputeReadiness,
  ComputeRevisionContext,
  Driver,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  WorkloadLaunchContext,
} from "@openclaw-enterprise/contracts";
import { admittedLoggingLevel } from "@openclaw-enterprise/contracts";
import {
  asRecord,
  immutableCopy,
  isNonEmptyString,
  isPositiveSafeInteger,
  sha256Hex,
} from "@openclaw-enterprise/utils";
import { ComputeLifecycleDispatcher } from "../lifecycle-hooks.ts";
import { currentComputeAbortSignal } from "../operation-context.ts";
import { WORKSPACE_SETUP_RUNTIME } from "../workspace-setup-runtime.ts";
import { unsupportedNativeGatewayAuthFields } from "../../../gateway/auth-fields.ts";
import { SystemSshCommandExecutor, type SshCommandExecutor } from "./executor.ts";

export interface SshComputeHost {
  readonly address: string;
  readonly port?: number;
  readonly user: string;
  readonly nodePath?: string;
  readonly openclawPath?: string;
}

export interface SshComputeDriverOptions {
  readonly ssh: {
    readonly identityFile: string;
    readonly knownHostsFile: string;
    readonly connectTimeoutSeconds?: number;
  };
  readonly hosts: Readonly<Record<string, SshComputeHost>>;
  readonly runtime: {
    readonly nodePath: string;
    readonly openclawPath: string;
    readonly user: string;
    readonly root: string;
    readonly systemdUnitDirectory?: string;
  };
  readonly network: { readonly gatewayPortRange: { readonly start: number; readonly end: number } };
}

interface SshComputeSelection {
  readonly id?: string;
  readonly implementation?: string;
  readonly lifecycleDrivers?: readonly Driver[];
  readonly executor?: SshCommandExecutor;
}

class OwnershipFailure extends Error {}
class ConfigurationFailure extends Error {}

const HELPER = readFileSync(new URL("./remote-helper.cjs", import.meta.url), "utf8");
const OPERATION_TIMEOUT_MS = 180_000;
// The helper enforces its own deadline below the transport timeout.
const HELPER_DEADLINE_MS = OPERATION_TIMEOUT_MS - 10_000;
// SSH joins remote argv through the login shell; systemd also expands specifiers.
const PATH_PATTERN = "^/[A-Za-z0-9_./:@+-]*$";
const PATH = new RegExp(PATH_PATTERN);
const PATH_SCHEMA = { type: "string", pattern: PATH_PATTERN };
const ADDRESS_PATTERN = "^[A-Za-z0-9:][A-Za-z0-9.:-]*$";
const ADDRESS = new RegExp(ADDRESS_PATTERN);
const ACCOUNT_PATTERN = "^(?!root$)[a-z_][a-z0-9_-]*$";
const ACCOUNT = new RegExp(ACCOUNT_PATTERN);
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
const OPENCLAW_GATEWAY_PASSWORD = "OPENCLAW_GATEWAY_PASSWORD";
const GATEWAY_PASSWORD_EXPRESSION = `\${${OPENCLAW_GATEWAY_PASSWORD}}`;
const GATEWAY_PASSWORD_REFERENCE = immutableCopy({
  source: "env",
  provider: "default",
  id: OPENCLAW_GATEWAY_PASSWORD,
});

function required(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new ConfigurationFailure(`${description} is required.`);
  }
  return value;
}

function identity(value: unknown, description: string): string {
  const result = required(value, description);
  if (!IDENTITY.test(result)) {
    throw new ConfigurationFailure(`${description} is invalid.`);
  }
  return result;
}

function closed(
  value: unknown,
  keys: readonly string[],
  description: string,
): Record<string, unknown> {
  const result = asRecord(value);
  if (result === undefined) {
    throw new ConfigurationFailure(`${description} must be an object.`);
  }
  if (Object.keys(result).some((key) => !keys.includes(key))) {
    throw new ConfigurationFailure(`${description} contains an unsupported option.`);
  }
  return result;
}

function path(value: unknown, description: string): void {
  if (!PATH.test(required(value, description))) {
    throw new ConfigurationFailure(
      `${description} must be an absolute path without whitespace, quotes, control characters, or shell/systemd expansions.`,
    );
  }
}

function port(value: unknown, minimum: number, description: string): number {
  if (!isPositiveSafeInteger(value) || value < minimum || value > 65_535) {
    throw new ConfigurationFailure(`${description} must be an integer from ${minimum} to 65535.`);
  }
  return value;
}

// Heartbeat lines precede the helper's single JSON result line.
function helperResult(stdout: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
  } catch {
    return undefined;
  }
}

function failure(error: unknown): "permanent" | "retryable" {
  return error instanceof OwnershipFailure || error instanceof ConfigurationFailure
    ? "permanent"
    : "retryable";
}

function hasPluginSelections(revision: AgentRevision): boolean {
  return revision.plugins !== undefined && Object.keys(revision.plugins.plugins).length > 0;
}

function usesGatewayPasswordReference(value: unknown): boolean {
  if (value === GATEWAY_PASSWORD_EXPRESSION) {
    return true;
  }
  const password = asRecord(value);
  return (
    password?.source === "env" &&
    password.provider === "default" &&
    password.id === OPENCLAW_GATEWAY_PASSWORD
  );
}

function sshGatewayConfigurationDocument(
  configuration: OpenClawConfigurationDocument,
): OpenClawConfigurationDocument {
  const gatewayRecord = asRecord(configuration.gateway);
  if (configuration.gateway !== undefined && gatewayRecord === undefined) {
    throw new ConfigurationFailure("SSH native gateway configuration must be an object.");
  }
  const gateway = (gatewayRecord ?? {}) as Record<string, OpenClawConfigurationValue>;
  const authRecord = asRecord(gateway.auth);
  if (gateway.auth !== undefined && authRecord === undefined) {
    throw new ConfigurationFailure("SSH native gateway auth must be an object.");
  }
  const auth = (authRecord ?? {}) as Record<string, OpenClawConfigurationValue>;
  const unsupported = unsupportedNativeGatewayAuthFields(auth);
  if (unsupported.length > 0) {
    throw new ConfigurationFailure(
      `SSH native gateway authentication contains unsupported field ${unsupported[0]}.`,
    );
  }
  if (auth.mode !== undefined && auth.mode !== "trusted-proxy" && auth.mode !== "password") {
    throw new ConfigurationFailure(
      "SSH Compute supports only native trusted-proxy or password gateway authentication.",
    );
  }
  if (auth.password !== undefined && !usesGatewayPasswordReference(auth.password)) {
    throw new ConfigurationFailure(
      "Gateway password authentication must use OPENCLAW_GATEWAY_PASSWORD.",
    );
  }
  if (auth.mode === "trusted-proxy") {
    return configuration;
  }
  return {
    ...configuration,
    gateway: {
      ...gateway,
      auth: {
        ...auth,
        mode: "password",
        password: GATEWAY_PASSWORD_REFERENCE,
      },
    },
  } as OpenClawConfigurationDocument;
}

export class SshComputeDriver implements ComputeDriver {
  static readonly configurationSchema = immutableCopy({
    type: "object",
    additionalProperties: false,
    required: ["ssh", "hosts", "runtime", "network"],
    properties: {
      ssh: {
        type: "object",
        additionalProperties: false,
        required: ["identityFile", "knownHostsFile"],
        properties: {
          identityFile: PATH_SCHEMA,
          knownHostsFile: PATH_SCHEMA,
          connectTimeoutSeconds: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        },
      },
      hosts: {
        type: "object",
        minProperties: 1,
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["address", "user"],
          properties: {
            address: { type: "string", pattern: ADDRESS_PATTERN },
            port: { type: "integer", minimum: 1, maximum: 65_535 },
            user: { const: "root" },
            nodePath: PATH_SCHEMA,
            openclawPath: PATH_SCHEMA,
          },
        },
      },
      runtime: {
        type: "object",
        additionalProperties: false,
        required: ["nodePath", "openclawPath", "user", "root"],
        properties: {
          nodePath: PATH_SCHEMA,
          openclawPath: PATH_SCHEMA,
          root: PATH_SCHEMA,
          systemdUnitDirectory: PATH_SCHEMA,
          user: { type: "string", pattern: ACCOUNT_PATTERN },
        },
      },
      network: {
        type: "object",
        additionalProperties: false,
        required: ["gatewayPortRange"],
        properties: {
          gatewayPortRange: {
            type: "object",
            additionalProperties: false,
            required: ["start", "end"],
            properties: {
              start: { type: "integer", minimum: 1024, maximum: 65_535 },
              end: { type: "integer", minimum: 1024, maximum: 65_535 },
            },
          },
        },
      },
    },
  });

  static validateConfiguration(configuration: unknown): void {
    const options = closed(configuration, ["ssh", "hosts", "runtime", "network"], "SSH options");
    const ssh = closed(
      options.ssh,
      ["identityFile", "knownHostsFile", "connectTimeoutSeconds"],
      "ssh",
    );
    path(ssh.identityFile, "ssh.identityFile");
    path(ssh.knownHostsFile, "ssh.knownHostsFile");
    if (
      ssh.connectTimeoutSeconds !== undefined &&
      !isPositiveSafeInteger(ssh.connectTimeoutSeconds)
    ) {
      throw new ConfigurationFailure("ssh.connectTimeoutSeconds must be a positive safe integer.");
    }
    const runtime = closed(
      options.runtime,
      ["nodePath", "openclawPath", "user", "root", "systemdUnitDirectory"],
      "runtime",
    );
    for (const key of ["nodePath", "openclawPath", "root"]) {
      path(runtime[key], `runtime.${key}`);
    }
    if (runtime.systemdUnitDirectory !== undefined) {
      path(runtime.systemdUnitDirectory, "runtime.systemdUnitDirectory");
    }
    if (!ACCOUNT.test(required(runtime.user, "runtime.user"))) {
      throw new ConfigurationFailure("runtime.user must be a non-root account-name prefix.");
    }
    const hosts = asRecord(options.hosts);
    if (hosts === undefined || Object.keys(hosts).length === 0) {
      throw new ConfigurationFailure("hosts must map exact Namespace names to SSH hosts.");
    }
    for (const [name, value] of Object.entries(hosts)) {
      required(name, "Namespace name");
      const host = closed(
        value,
        ["address", "port", "user", "nodePath", "openclawPath"],
        "SSH host",
      );
      if (!ADDRESS.test(required(host.address, "Host address"))) {
        throw new ConfigurationFailure("Host address must be a hostname or IP address.");
      }
      if (host.user !== "root") {
        throw new ConfigurationFailure(
          "SSH hosts require user root; non-root SSH and sudo are unsupported.",
        );
      }
      if (host.port !== undefined) {
        port(host.port, 1, "Host port");
      }
      for (const key of ["nodePath", "openclawPath"]) {
        if (host[key] !== undefined) {
          path(host[key], `Host ${key}`);
        }
      }
    }
    const network = closed(options.network, ["gatewayPortRange"], "network");
    const range = closed(network.gatewayPortRange, ["start", "end"], "gatewayPortRange");
    const start = port(range.start, 1024, "Gateway port range start");
    const end = port(range.end, 1024, "Gateway port range end");
    if (start > end) {
      throw new ConfigurationFailure("Gateway port range start must not exceed end.");
    }
  }

  readonly supportsWorkspaceSetup = true;
  readonly id: string;
  readonly capability = "compute" as const;
  readonly implementation: string;
  private readonly options: SshComputeDriverOptions;
  private readonly executor: SshCommandExecutor;
  private readonly namespaces = new Map<string, Readonly<Namespace>>();
  private readonly agents = new Map<string, Readonly<ComputeAgentBinding>>();
  private lifecycle: ComputeLifecycleDispatcher;
  private lifecycleStarted = false;

  constructor(options: SshComputeDriverOptions, selection: SshComputeSelection = {}) {
    SshComputeDriver.validateConfiguration(options);
    this.options = immutableCopy(options);
    this.id = identity(selection.id ?? "compute-ssh", "SSH Compute Driver ID");
    this.implementation = identity(
      selection.implementation ?? "occ/ssh",
      "SSH Compute implementation",
    );
    this.executor = selection.executor ?? new SystemSshCommandExecutor();
    this.lifecycle = new ComputeLifecycleDispatcher(selection.lifecycleDrivers ?? []);
  }

  setLifecycleDrivers(drivers: readonly Driver[]): void {
    if (this.lifecycleStarted) {
      throw new Error("Compute lifecycle Drivers cannot change after lifecycle operations begin.");
    }
    this.lifecycle = new ComputeLifecycleDispatcher(drivers);
  }

  async preflight(): Promise<void> {
    for (const key of ["identityFile", "knownHostsFile"] as const) {
      const info = await stat(this.options.ssh[key]).catch(() => undefined);
      if (info?.isFile() !== true) {
        throw new ConfigurationFailure(`SSH ${key} must identify an existing local file.`);
      }
    }
    for (const [name, host] of Object.entries(this.options.hosts)) {
      try {
        await this.execute(host, { operation: "probe" });
      } catch {
        throw new Error(`SSH preflight failed for host ${name} (${host.address}).`);
      }
    }
  }

  bindAgent(binding: ComputeAgentBinding): void {
    const { namespace, agent } = binding;
    this.host(namespace);
    identity(agent.id, "Agent ID");
    identity(agent.servicePrincipalId, "Agent ServicePrincipal ID");
    if (agent.namespaceId !== namespace.id) {
      throw new OwnershipFailure("Agent Namespace ownership differs.");
    }
    const previous = this.agents.get(agent.id);
    if (
      previous !== undefined &&
      (previous.namespace.id !== namespace.id ||
        previous.agent.servicePrincipalId !== agent.servicePrincipalId)
    ) {
      throw new OwnershipFailure("Agent binding ownership differs.");
    }
    this.bindNamespace(namespace);
    this.agents.set(agent.id, immutableCopy(binding));
  }

  async ensureNamespace(namespace: Namespace): Promise<NamespaceEnsureResult> {
    this.lifecycleStarted = true;
    const result = { namespaceId: namespace.id, namespaceReady: false };
    try {
      await this.execute(this.host(namespace), { operation: "ensure-namespace", namespace });
      this.bindNamespace(namespace);
      await this.lifecycle.afterNamespacePrepared(namespace);
      return { ...result, namespaceReady: true };
    } catch (error) {
      return { ...result, failure: failure(error) };
    }
  }

  async deleteNamespace(namespace: Namespace): Promise<NamespaceDeleteResult> {
    this.lifecycleStarted = true;
    const result = { namespaceId: namespace.id, namespaceDeleted: false };
    try {
      const host = this.host(namespace);
      await this.lifecycle.beforeNamespaceDelete(namespace);
      await this.execute(host, { operation: "delete-namespace", namespace });
      this.namespaces.delete(namespace.id);
      for (const [id, binding] of this.agents) {
        if (binding.namespace.id === namespace.id) {
          this.agents.delete(id);
        }
      }
      return { ...result, namespaceDeleted: true };
    } catch (error) {
      return { ...result, failure: failure(error) };
    }
  }

  validateHarnessAuth(harness: RevisionHarnessDescriptor, auth: HarnessAuthSnapshot): void {
    if (auth?.method !== "runtime" || Object.keys(auth).length !== 1) {
      throw new ConfigurationFailure("SSH Compute requires operator-managed runtime credentials.");
    }
    // TODO: Dedicated Codex requires authenticated transport and separate host credential delivery.
    if (harness.id !== "openclaw" || harness.mode !== "embedded") {
      throw new ConfigurationFailure(
        "SSH Compute supports only embedded OpenClaw; dedicated Codex is not implemented.",
      );
    }
  }

  async prepareRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness> {
    this.lifecycleStarted = true;
    this.validateWorkloadRevision(revision, context);
    const result = await this.revisionOperation("prepare-revision", revision, undefined, context);
    return {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: result.ready === true,
    };
  }

  async activateRevision(revision: AgentRevision, context?: ComputeRevisionContext): Promise<void> {
    this.lifecycleStarted = true;
    this.validateWorkloadRevision(revision, context);

    let launch: Readonly<WorkloadLaunchContext> | undefined;
    try {
      launch = await this.lifecycle.beforeWorkloadStart(revision);
      await this.revisionOperation("activate-revision", revision, launch, context);
    } catch (error) {
      if (launch === undefined) {
        throw error;
      }
      try {
        await this.lifecycle.beforeWorkloadStop(revision, { cleanup: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "SSH workload activation and lifecycle cleanup failed.",
        );
      }
      throw error;
    }
  }

  async deactivateRevision(revision: AgentRevision): Promise<void> {
    this.lifecycleStarted = true;
    await this.revisionOperation("verify-revision", revision);
  }

  async stopRevision(revision: AgentRevision): Promise<void> {
    this.lifecycleStarted = true;
    this.validateRevision(revision);
    await this.lifecycle.beforeWorkloadStop(revision);
    await this.revisionOperation("stop-revision", revision);
  }

  async retireRevision(revision: AgentRevision): Promise<void> {
    this.lifecycleStarted = true;
    this.validateRevision(revision);
    await this.lifecycle.beforeWorkloadStop(revision);
    await this.revisionOperation("retire-revision", revision);
  }

  // Agent deletion calls this after retiring every revision. Retirement keeps the Agent
  // directory, port, unit file and runtime account; only Agent deletion releases them.
  async deleteAgentRuntimeCredentials(binding: ComputeAgentBinding): Promise<void> {
    this.lifecycleStarted = true;
    const { namespace, agent } = binding;
    const host = this.host(namespace);
    identity(agent.id, "Agent ID");
    identity(agent.servicePrincipalId, "Agent ServicePrincipal ID");
    if (agent.namespaceId !== namespace.id) {
      throw new OwnershipFailure("Agent Namespace ownership differs.");
    }
    await this.execute(host, {
      operation: "delete-agent",
      namespace,
      revision: {
        namespaceId: namespace.id,
        agentId: agent.id,
        servicePrincipalId: agent.servicePrincipalId,
      },
    });
    this.agents.delete(agent.id);
  }

  // Keep workload restrictions separate from the ownership checks used during teardown.
  private validateWorkloadRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): void {
    this.validateRevision(revision);
    sshGatewayConfigurationDocument(revision.configuration);
    if (
      (context?.secretEnvironment.length ?? 0) > 0 ||
      Object.keys(revision.secretBindings ?? {}).length > 0
    ) {
      throw new ConfigurationFailure(
        "SSH OCC Secret delivery is not implemented; provision credentials in the operator-owned <agentDir>/env file.",
      );
    }
    if (revision.sandboxDriverId !== undefined) {
      throw new ConfigurationFailure("SSH Compute does not support SandboxDriver composition.");
    }
    if (revision.pluginApprovers !== undefined) {
      throw new ConfigurationFailure("SSH Compute does not support plugin approver policy.");
    }
    if (hasPluginSelections(revision)) {
      throw new ConfigurationFailure("SSH Compute does not support PluginDriver installation.");
    }
    admittedLoggingLevel(revision.configuration);
  }

  private host(namespace: Namespace): SshComputeHost {
    identity(namespace.id, "Namespace ID");
    if (namespace.existingNamespace !== undefined) {
      throw new ConfigurationFailure("SSH Compute does not support existingNamespace adoption.");
    }
    const host = Object.hasOwn(this.options.hosts, namespace.name)
      ? this.options.hosts[namespace.name]
      : undefined;
    if (host === undefined) {
      throw new ConfigurationFailure("SSH Namespace name is not mapped to a host.");
    }
    return host;
  }

  private bindNamespace(namespace: Namespace): void {
    const previous = this.namespaces.get(namespace.id);
    if (previous !== undefined && previous.name !== namespace.name) {
      throw new OwnershipFailure("Namespace host binding differs.");
    }
    this.namespaces.set(namespace.id, immutableCopy(namespace));
  }

  private validateRevision(revision: AgentRevision): Readonly<Namespace> {
    this.validateHarnessAuth(revision.harness, revision.harnessAuth);
    const namespace = this.namespaces.get(revision.namespaceId);
    const binding = this.agents.get(revision.agentId);
    if (namespace === undefined || binding === undefined) {
      throw new ConfigurationFailure("SSH revision requires a bound Namespace and Agent.");
    }
    if (
      binding.namespace.id !== revision.namespaceId ||
      binding.agent.servicePrincipalId !== revision.servicePrincipalId ||
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new OwnershipFailure("AgentRevision ownership or selected Compute Driver differs.");
    }
    identity(revision.id, "AgentRevision ID");
    if (
      revision.configurationKind !== "agent" ||
      !isPositiveSafeInteger(revision.revision) ||
      !isPositiveSafeInteger(revision.configurationGeneration)
    ) {
      throw new ConfigurationFailure("AgentRevision Configuration ownership is invalid.");
    }
    return namespace;
  }

  private async revisionOperation(
    operation: string,
    revision: AgentRevision,
    launch?: Readonly<WorkloadLaunchContext>,
    context?: ComputeRevisionContext,
  ): Promise<Record<string, unknown>> {
    const namespace = this.validateRevision(revision);
    const renderedConfiguration = sshGatewayConfigurationDocument(revision.configuration);
    const effectiveRevision = { ...revision, configuration: renderedConfiguration };
    return this.execute(this.host(namespace), {
      operation,
      namespace,
      revision: effectiveRevision,
      configurationHash: sha256Hex(JSON.stringify(renderedConfiguration)),
      ...(context?.workspaceSetup === undefined
        ? {}
        : {
            workspaceSetup: context.workspaceSetup,
            workspaceSetupRuntime: WORKSPACE_SETUP_RUNTIME,
          }),
      ...(launch === undefined ? {} : { launchEnvironment: launch.environment }),
    });
  }

  private async execute(
    host: SshComputeHost,
    operation: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const runtime = {
      ...this.options.runtime,
      systemdUnitDirectory: this.options.runtime.systemdUnitDirectory ?? "/etc/systemd/system",
      nodePath: host.nodePath ?? this.options.runtime.nodePath,
      openclawPath: host.openclawPath ?? this.options.runtime.openclawPath,
    };
    const owner = currentComputeAbortSignal();
    const result = await this.executor.execute({
      ...this.options.ssh,
      connectTimeoutSeconds: this.options.ssh.connectTimeoutSeconds ?? 10,
      address: host.address,
      port: host.port ?? 22,
      user: host.user,
      nodePath: runtime.nodePath,
      helper: HELPER,
      timeoutMs: OPERATION_TIMEOUT_MS,
      ...(owner === undefined ? {} : { signal: owner }),
      operation: Buffer.from(
        JSON.stringify({
          ...operation,
          driverId: this.id,
          implementation: this.implementation,
          runtime,
          network: this.options.network,
          deadlineMs: HELPER_DEADLINE_MS,
        }),
      ).toString("base64"),
    });
    owner?.throwIfAborted();
    const value = helperResult(result.stdout);
    if (result.code !== 0) {
      if (value?.failure === "ownership") {
        throw new OwnershipFailure(
          "SSH helper refused foreign ownership or an immutable snapshot mismatch.",
        );
      }
      if (value?.failure === "configuration") {
        throw new ConfigurationFailure("SSH helper rejected host or revision configuration.");
      }
      throw new Error("SSH host operation failed or timed out.");
    }
    if (value?.ok !== true) {
      throw new Error("SSH helper returned an invalid result.");
    }
    return value;
  }
}

export function createSshComputeDriver(
  options: SshComputeDriverOptions,
  selection?: SshComputeSelection,
): SshComputeDriver {
  return new SshComputeDriver(options, selection);
}
