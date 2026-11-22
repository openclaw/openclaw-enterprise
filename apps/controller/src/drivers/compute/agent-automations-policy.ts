import { createHash } from "node:crypto";
import type {
  AgentAutomationPolicyBinding,
  AgentAutomationPolicyQualification,
  AgentRevision,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { AUTOMATION_NO_MCP_PLUGIN_IDS } from "./agent-automation-guard.ts";
import {
  trustedAnonymousMcpEndpointDescriptor,
  type TrustedAnonymousMcpEndpoint,
} from "./agent-automation-endpoints.ts";
import { AGENT_AUTOMATIONS_OPENCLAW_SOURCE } from "../../gateway/agent-automations-runtime.ts";

export { AUTOMATION_NO_MCP_PLUGIN_IDS };

// A nonempty native allowlist excludes other plugin IDs. Native slot/channel
// exceptions and local load paths are refused below.
const noMcpPluginIds = new Set<string>(AUTOMATION_NO_MCP_PLUGIN_IDS);
const immutableImage = /^.+@sha256:[a-f0-9]{64}$/u;
const literal = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const permittedServerKeys = new Set([
  "enabled",
  "command",
  "args",
  "cwd",
  "url",
  "transport",
  "connectionTimeoutMs",
  "requestTimeoutMs",
  "supportsParallelToolCalls",
  "sslVerify",
  "toolFilter",
  "codex",
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const object = asRecord(value);
  if (object) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const publicToolKeys = new Set([
  "profile",
  "allow",
  "alsoAllow",
  "deny",
  "codeMode",
  "toolSearch",
  "gatewayPolicy",
]);
const publicGatewayPolicyKeys = new Set(["allow", "actions", "automations"]);
const nativeToolName = /^(?:\*|[A-Za-z][A-Za-z0-9_.:-]*(?:\*)?)$/u;

function publicNames(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && nativeToolName.test(entry))
    ? value
    : undefined;
}

function publicToolPolicy(
  tools: Record<string, unknown>,
  gatewayPolicy: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  if (
    Object.keys(tools).some((key) => !publicToolKeys.has(key)) ||
    Object.keys(gatewayPolicy).some((key) => !publicGatewayPolicyKeys.has(key)) ||
    (tools.profile !== undefined &&
      (typeof tools.profile !== "string" ||
        !["minimal", "coding", "messaging", "full"].includes(tools.profile)))
  ) {
    return undefined;
  }
  const allow = publicNames(tools.allow);
  const alsoAllow = publicNames(tools.alsoAllow);
  const deny = publicNames(tools.deny);
  if (!allow || !alsoAllow || !deny) {
    return undefined;
  }
  const actions = asRecord(gatewayPolicy.actions);
  if (gatewayPolicy.actions !== undefined && !actions) {
    return undefined;
  }
  const selectedActions = publicNames(actions?.[name]);
  if (!selectedActions) {
    return undefined;
  }
  const automations = asRecord(gatewayPolicy.automations);
  if (
    gatewayPolicy.automations !== undefined &&
    (!automations ||
      Object.keys(automations).some((key) => key !== "scope" && key !== "allowCommandJobs") ||
      (automations.scope !== undefined && automations.scope !== "caller") ||
      (automations.allowCommandJobs !== undefined &&
        typeof automations.allowCommandJobs !== "boolean"))
  ) {
    return undefined;
  }
  return {
    profile: tools.profile,
    allow,
    alsoAllow,
    deny,
    codeMode: tools.codeMode,
    toolSearch: tools.toolSearch,
    actions: selectedActions,
    automations:
      automations === undefined
        ? undefined
        : {
            scope: automations.scope,
            allowCommandJobs: automations.allowCommandJobs,
          },
  };
}

function publicPluginActivation(value: unknown): Record<string, unknown> | undefined {
  const plugins = asRecord(value);
  if (!plugins || (plugins.enabled !== undefined && typeof plugins.enabled !== "boolean")) {
    return undefined;
  }
  const allow = publicNames(plugins.allow);
  const deny = publicNames(plugins.deny);
  const entries = asRecord(plugins.entries);
  if (!allow || !deny || (plugins.entries !== undefined && !entries)) {
    return undefined;
  }
  const activation: Record<string, boolean | undefined> = {};
  for (const [id, value] of Object.entries(entries ?? {})) {
    const entry = asRecord(value);
    if (
      !noMcpPluginIds.has(id) ||
      !entry ||
      Object.keys(entry).some((key) => key !== "enabled") ||
      (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
    ) {
      return undefined;
    }
    activation[id] = entry.enabled;
  }
  const slots = asRecord(plugins.slots);
  if (
    plugins.slots !== undefined &&
    (!slots ||
      Object.keys(slots).some((key) => key !== "memory" && key !== "contextEngine") ||
      (slots.memory !== undefined && slots.memory !== "memory-core" && slots.memory !== "none") ||
      (slots.contextEngine !== undefined && slots.contextEngine !== "legacy"))
  ) {
    return undefined;
  }
  return {
    enabled: plugins.enabled,
    allow,
    deny,
    entries: activation,
    slots:
      slots === undefined
        ? undefined
        : { memory: slots.memory, contextEngine: slots.contextEngine },
  };
}

function defaultNamespaceIsStaticOnly(revision: Readonly<AgentRevision>): boolean {
  const configuration = revision.configuration;
  if (Object.keys(revision.plugins?.plugins ?? {}).length > 0) {
    return false;
  }
  const channels = asRecord(configuration.channels);
  if (configuration.channels !== undefined && (!channels || Object.keys(channels).length > 0)) {
    return false;
  }
  const plugins = asRecord(configuration.plugins);
  if (
    !plugins ||
    Object.keys(plugins).some(
      (key) => !["enabled", "allow", "deny", "entries", "slots"].includes(key),
    ) ||
    !Array.isArray(plugins.allow) ||
    plugins.allow.length === 0 ||
    plugins.allow.some((id) => typeof id !== "string" || !noMcpPluginIds.has(id)) ||
    new Set(plugins.allow).size !== plugins.allow.length
  ) {
    return false;
  }
  const entries = asRecord(plugins.entries);
  if (
    plugins.entries !== undefined &&
    (!entries || Object.keys(entries).some((id) => !noMcpPluginIds.has(id)))
  ) {
    return false;
  }
  const slots = asRecord(plugins.slots);
  if (
    plugins.slots !== undefined &&
    (!slots ||
      Object.keys(slots).some((key) => key !== "memory" && key !== "contextEngine") ||
      (slots.memory !== undefined && slots.memory !== "memory-core" && slots.memory !== "none") ||
      (slots.contextEngine !== undefined && slots.contextEngine !== "legacy"))
  ) {
    return false;
  }
  return true;
}

function codeModeOverridesAreOff(configuration: Readonly<AgentRevision["configuration"]>): boolean {
  const agents = asRecord(configuration.agents);
  if (!agents) {
    return configuration.agents === undefined;
  }
  const checkModels = (value: unknown): boolean => {
    if (value === undefined) {
      return true;
    }
    const models = asRecord(value);
    return (
      !!models &&
      Object.values(models).every((model) => {
        const settings = asRecord(model);
        return (
          !!settings &&
          (settings.codeMode === undefined || settings.codeMode === false) &&
          (settings.toolSearch === undefined || settings.toolSearch === false)
        );
      })
    );
  };
  const defaults = asRecord(agents.defaults);
  if ((agents.defaults !== undefined && !defaults) || !checkModels(defaults?.models)) {
    return false;
  }
  if (agents.list !== undefined && !Array.isArray(agents.list)) {
    return false;
  }
  return (agents.list ?? []).every((entry: unknown) => {
    const agent = asRecord(entry);
    const tools = asRecord(agent?.tools);
    return (
      !!agent &&
      (agent.tools === undefined || !!tools) &&
      (tools?.codeMode === undefined || tools.codeMode === false) &&
      (tools?.toolSearch === undefined || tools.toolSearch === false) &&
      checkModels(agent.models)
    );
  });
}

/**
 * This policy admits only static, Agent-shared MCP endpoints for which the
 * provisioned revision contains the full authority descriptor. Other native
 * credential forms have no source-backed workload identity and fail closed.
 */
export function nativeAutomationPolicy(
  revision: Readonly<AgentRevision>,
  trustedAnonymousMcpEndpoints: readonly TrustedAnonymousMcpEndpoint[],
  runtimeImages: Readonly<{ gateway: string; agent?: string }>,
): AgentAutomationPolicyQualification | undefined {
  if (
    (revision.harness.mode === "dedicated" && revision.harness.id !== "codex") ||
    (revision.harness.mode === "embedded" && revision.harness.id !== "openclaw")
  ) {
    return undefined;
  }
  const configuration = revision.configuration;
  const mcp = asRecord(configuration.mcp);
  const servers = asRecord(mcp?.servers);
  if (configuration.mcp !== undefined && !mcp) {
    return undefined;
  }
  if (mcp && (!servers || Object.keys(mcp).some((key) => key !== "servers"))) {
    return undefined;
  }
  if (
    !servers ||
    Object.keys(servers).length === 0 ||
    Object.values(servers).every((value) => asRecord(value)?.enabled === false)
  ) {
    return { grant: { tools: [] }, bindings: [] };
  }
  const tools = asRecord(configuration.tools);
  const gatewayPolicy = asRecord(tools?.gatewayPolicy);
  const allow = gatewayPolicy?.allow;
  if (!tools || !Array.isArray(allow) || allow.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  const gateway = asRecord(configuration.gateway);
  const nodeControls = asRecord(gateway?.nodes);
  const nodePluginTools = asRecord(nodeControls?.pluginTools);
  const names = new Set<string>();
  const aliases = new Set<string>();
  const bindings: AgentAutomationPolicyBinding[] = [];
  for (const [serverName, value] of Object.entries(servers)) {
    const server = asRecord(value);
    if (!server) {
      return undefined;
    }
    if (
      !literal.test(serverName) ||
      serverName.length > 30 ||
      names.has(serverName.toLowerCase())
    ) {
      return undefined;
    }
    names.add(serverName.toLowerCase());
    if (server.enabled === false) {
      continue;
    }
    if (Object.keys(server).some((key) => !permittedServerKeys.has(key))) {
      return undefined;
    }
    const filter = asRecord(server.toolFilter);
    const include = filter?.include;
    if (
      !filter ||
      Object.keys(filter).some((key) => key !== "include") ||
      !Array.isArray(include) ||
      include.length === 0 ||
      include.some((entry) => typeof entry !== "string" || !literal.test(entry))
    ) {
      return undefined;
    }
    const transport = server.transport;
    if (transport !== "streamable-http" && transport !== "sse") {
      // A local peer inherits process credentials and mounts that the revision
      // cannot qualify as an MCP workload identity.
      return undefined;
    }
    if (
      typeof server.url !== "string" ||
      server.command !== undefined ||
      server.args !== undefined ||
      server.cwd !== undefined ||
      server.sslVerify === false
    ) {
      return undefined;
    }
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      return undefined;
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== server.url ||
      !trustedAnonymousMcpEndpoints.some((endpoint) => endpoint.url === url.href)
    ) {
      return undefined;
    }
    const endpoint = trustedAnonymousMcpEndpoints.find((entry) => entry.url === url.href);
    if (!endpoint) {
      return undefined;
    }
    const endpointDescriptor = trustedAnonymousMcpEndpointDescriptor(endpoint);
    const codex = asRecord(server.codex);
    if (revision.harness.mode === "dedicated" && codex?.defaultToolsApprovalMode !== "approve") {
      return undefined;
    }
    if (
      (server.codex !== undefined && !codex) ||
      (codex &&
        (Object.keys(codex).some((key) => key !== "defaultToolsApprovalMode") ||
          (codex.defaultToolsApprovalMode !== undefined &&
            codex.defaultToolsApprovalMode !== "approve")))
    ) {
      return undefined;
    }
    const rawNames = new Set<string>();
    for (const raw of include as string[]) {
      const normalized = raw.toLowerCase();
      const name = `${serverName}__${raw}`;
      if (rawNames.has(normalized) || name.length > 64 || aliases.has(name.toLowerCase())) {
        return undefined;
      }
      rawNames.add(normalized);
      aliases.add(name.toLowerCase());
      if (!allow.includes(name)) {
        continue;
      }
      // TODO: Remove this refusal only after genuine dedicated scheduled MCP
      // qualification proves approved execution without permission escalation.
      if (revision.harness.mode === "dedicated") {
        return undefined;
      }
      const policy = publicToolPolicy(tools, gatewayPolicy!, name);
      const pluginActivation = publicPluginActivation(configuration.plugins);
      if (
        !policy ||
        !pluginActivation ||
        nodePluginTools?.enabled !== false ||
        nodeControls?.allowSkills !== false ||
        Object.values(runtimeImages).some((image) => !immutableImage.test(image)) ||
        (server.enabled !== undefined && server.enabled !== true) ||
        (server.sslVerify !== undefined && server.sslVerify !== true) ||
        (server.supportsParallelToolCalls !== undefined &&
          typeof server.supportsParallelToolCalls !== "boolean") ||
        [server.connectionTimeoutMs, server.requestTimeoutMs].some(
          (value) =>
            value !== undefined &&
            (typeof value !== "number" || !Number.isFinite(value) || value < 0),
        )
      ) {
        return undefined;
      }
      const binding = createHash("sha256")
        .update(
          canonical({
            serverName,
            raw,
            server: {
              enabled: server.enabled,
              transport,
              connectionTimeoutMs: server.connectionTimeoutMs,
              requestTimeoutMs: server.requestTimeoutMs,
              supportsParallelToolCalls: server.supportsParallelToolCalls,
              sslVerify: server.sslVerify,
              codexApproval: codex?.defaultToolsApprovalMode,
            },
            servicePrincipalId: revision.servicePrincipalId,
            harness: { id: revision.harness.id, mode: revision.harness.mode },
            runtimeImages,
            openclawSource: AGENT_AUTOMATIONS_OPENCLAW_SOURCE,
            standingApproval: {
              kind: "trusted-anonymous-endpoint-v1",
              endpoint: endpointDescriptor,
            },
            nodeControls: {
              pluginToolsEnabled: nodePluginTools?.enabled,
              allowSkills: nodeControls?.allowSkills,
            },
            // Other approved operations may be added without widening this grant.
            policy,
            // Plugin activation can change the non-MCP tool namespace before cron starts.
            pluginNamespace: pluginActivation,
          }),
        )
        .digest("hex");
      bindings.push({ name, server: serverName, tool: raw, binding });
    }
  }
  if (
    bindings.length > 64 ||
    new Set(bindings.map(({ name }) => name.toLowerCase())).size !== bindings.length
  ) {
    return undefined;
  }
  if (
    bindings.length > 0 &&
    (tools.codeMode !== false ||
      tools.toolSearch !== false ||
      !codeModeOverridesAreOff(configuration) ||
      !defaultNamespaceIsStaticOnly(revision) ||
      nodePluginTools?.enabled !== false ||
      nodeControls?.allowSkills !== false ||
      (configuration.env !== undefined &&
        Object.keys(asRecord(configuration.env) ?? { invalid: true }).length > 0) ||
      Object.keys(revision.secretBindings ?? {}).length > 0 ||
      revision.repositoryCredentials !== undefined ||
      Object.values(runtimeImages).some((image) => !immutableImage.test(image)))
  ) {
    return undefined;
  }
  bindings.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { grant: { tools: bindings.map(({ name, binding }) => ({ name, binding })) }, bindings };
}
