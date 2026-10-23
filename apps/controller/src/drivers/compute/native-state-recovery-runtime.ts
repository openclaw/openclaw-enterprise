import {
  GATEWAY_STATE_DATABASE_PATH,
  GATEWAY_STATE_TERMINATION_PATH,
  GATEWAY_RECOVERY_SOURCE_PROTECTION,
  GATEWAY_PRIVATE_STATE_ORIGIN,
  NATIVE_STATE_OWNER_VALIDATORS,
  TRUSTED_GATEWAY_TOOL_BOUNDARY,
  nativeStateRecord,
  nativeStateText,
} from "./native-state-owner.ts";
import { NATIVE_GATEWAY_COMMAND_TIMEOUT_MS } from "./runtime-startup.ts";

// Bundled inventory includes capability metadata and exceeds a recovery snapshot's
// budget. Keep its finite allowance separate from commands that inspect custody.
const NATIVE_PLUGIN_INVENTORY_MAX_BYTES = 256 * 1024;

// Recovery eligibility for OCE's emitted configuration, not plugin permissions.
export function nativeStatePluginConfigurationEligible(id: string, value: unknown): boolean {
  const config = nativeStateRecord(value);
  if (id === "codex") {
    const appServer = nativeStateRecord(config?.appServer);
    const token = appServer?.authToken;
    const reference = nativeStateRecord(token);
    if (
      token !== undefined &&
      typeof token !== "string" &&
      (reference?.source !== "env" ||
        Object.keys(reference).some((key) => !["source", "provider", "id"].includes(key)))
    ) {
      return false;
    }
    const proxy = nativeStateRecord(appServer?.networkProxy);
    if (
      appServer?.networkProxy !== undefined &&
      (proxy === undefined ||
        Object.keys(proxy).some(
          (key) =>
            ![
              "enabled",
              "baseProfile",
              "mode",
              "domains",
              "unixSockets",
              "readOnlyPaths",
              "enableSocks5",
              "enableSocks5Udp",
              "allowUpstreamProxy",
              "allowLocalBinding",
              "dangerouslyAllowNonLoopbackProxy",
              "dangerouslyAllowAllUnixSockets",
            ].includes(key),
        ))
    ) {
      return false;
    }
    if (appServer?.nativeHookRelay !== undefined) {
      const relay = nativeStateRecord(appServer.nativeHookRelay);
      if (
        relay === undefined ||
        Object.keys(relay).some((key) => !["url", "credentialDirectory"].includes(key)) ||
        !nativeStateText(relay.url, 4096) ||
        !nativeStateText(relay.credentialDirectory, 4096) ||
        !relay.credentialDirectory.startsWith("/") ||
        !relay.credentialDirectory.endsWith("/.oce-native-hooks") ||
        relay.credentialDirectory.split("/").some((part) => part === "." || part === "..")
      ) {
        return false;
      }
      // OCE supplies a remote callback and a Harness credential directory;
      // this relay does not load custom hook code into the Gateway.
      try {
        const url = new URL(relay.url);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !url.pathname.endsWith("/node/__openclaw__/native-hook")
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return (
      config !== undefined &&
      Object.keys(config).every((key) =>
        [
          "appServer",
          "codexPlugins",
          "codexDynamicToolsInclude",
          "codexDynamicToolsExclude",
        ].includes(key),
      ) &&
      appServer?.transport === "websocket" &&
      nativeStateText(appServer.url, 4096) &&
      Object.keys(appServer).every((key) =>
        [
          "mode",
          "approvalPolicy",
          "approvalsReviewer",
          "sandbox",
          "transport",
          "url",
          "authToken",
          "remoteWorkspaceRoot",
          "networkProxy",
          "nativeHookRelay",
        ].includes(key),
      )
    );
  }
  if (value === undefined || (config !== undefined && Object.keys(config).length === 0)) {
    return true;
  }
  if (
    id !== "file-transfer" ||
    config === undefined ||
    config.policyVersion !== 2 ||
    Object.keys(config).some((key) => !["policyVersion", "nodes", "workspaces"].includes(key))
  ) {
    return false;
  }
  const nodes = nativeStateRecord(config.nodes);
  const workspaces = nativeStateRecord(config.workspaces);
  return (
    nodes !== undefined &&
    workspaces !== undefined &&
    Object.values(nodes).every((value) => {
      const node = nativeStateRecord(value);
      return (
        node !== undefined &&
        node.ask === "off" &&
        node.followSymlinks === false &&
        Object.keys(node).every((key) =>
          ["ask", "allowReadPaths", "allowWritePaths", "followSymlinks"].includes(key),
        ) &&
        [node.allowReadPaths, node.allowWritePaths].every(
          (paths) => Array.isArray(paths) && paths.every((path) => nativeStateText(path, 4096)),
        )
      );
    }) &&
    Object.values(workspaces).every((value) => {
      const workspace = nativeStateRecord(value);
      return (
        workspace !== undefined &&
        Object.keys(workspace).every((key) => ["nodeId", "remoteRoot"].includes(key)) &&
        nativeStateText(workspace.nodeId) &&
        nativeStateText(workspace.remoteRoot)
      );
    })
  );
}

export function nativeGatewayRecoveryConfigurationEligible(value: unknown): boolean {
  const config = nativeStateRecord(value);
  if (config === undefined) {
    return false;
  }
  const includes = (item: unknown): boolean =>
    item !== null &&
    typeof item === "object" &&
    (Object.hasOwn(item, "$include") || Object.values(item).some(includes));
  if (includes(config)) {
    return false;
  }
  // This is the small configuration contract OCE emits, not Native's schema.
  // Unknown settings remain usable, but may select Gateway-local helpers.
  const fields = (item: unknown, names: readonly string[]): boolean =>
    item === undefined ||
    (nativeStateRecord(item) !== undefined &&
      Object.keys(item as object).every((key) => names.includes(key)));
  const values = (item: unknown): unknown[] => Object.values(nativeStateRecord(item) ?? {});
  const environmentInput = (item: unknown): boolean =>
    item === undefined ||
    typeof item === "string" ||
    (fields(item, ["source", "provider", "id"]) && nativeStateRecord(item)?.source === "env");
  if (
    !fields(config, [
      "gateway",
      "agents",
      "models",
      "browser",
      "tools",
      "plugins",
      "cron",
      "approvals",
      "cloudWorkers",
      "mcp",
      "logging",
      "diagnostics",
      "env",
      "secrets",
      "hooks",
      "channels",
    ])
  ) {
    return false;
  }
  const gateway = nativeStateRecord(config.gateway);
  const auth = nativeStateRecord(gateway?.auth);
  const proxy = nativeStateRecord(auth?.trustedProxy);
  const http = nativeStateRecord(gateway?.http);
  const endpoints = nativeStateRecord(http?.endpoints);
  const nodes = nativeStateRecord(gateway?.nodes);
  if (
    !fields(config.gateway, [
      "mode",
      "bind",
      "port",
      "customBindHost",
      "controlUi",
      "auth",
      "trustedProxies",
      "allowRealIpFallback",
      "http",
      "nodes",
    ]) ||
    !fields(gateway?.controlUi, ["enabled", "allowedOrigins"]) ||
    !fields(gateway?.auth, ["mode", "password", "token", "trustedProxy", "identityScopes"]) ||
    !environmentInput(auth?.password) ||
    !environmentInput(auth?.token) ||
    !fields(auth?.trustedProxy, [
      "userHeader",
      "requiredHeaders",
      "allowUsers",
      "deviceAutoApprove",
    ]) ||
    !fields(proxy?.deviceAutoApprove, ["enabled", "scopes"]) ||
    !fields(gateway?.http, ["endpoints"]) ||
    !fields(http?.endpoints, ["chatCompletions"]) ||
    !fields(endpoints?.chatCompletions, ["enabled"]) ||
    !fields(gateway?.nodes, ["commands"]) ||
    !fields(nodes?.commands, ["allow"])
  ) {
    return false;
  }
  const agents = nativeStateRecord(config.agents);
  const defaults = nativeStateRecord(agents?.defaults);
  const compaction = nativeStateRecord(defaults?.compaction);
  const runtime = (item: unknown): boolean => fields(item, ["id"]);
  const modelChoice = (item: unknown): boolean =>
    item === undefined || typeof item === "string" || fields(item, ["primary", "fallbacks"]);
  if (
    !fields(config.agents, ["defaults", "entries"]) ||
    !fields(agents?.defaults, [
      "model",
      "models",
      "workspace",
      "modelSelectionScope",
      "compaction",
    ]) ||
    !modelChoice(defaults?.model) ||
    !fields(defaults?.compaction, ["memoryFlush"]) ||
    !fields(compaction?.memoryFlush, ["enabled"]) ||
    (compaction?.memoryFlush !== undefined &&
      nativeStateRecord(compaction.memoryFlush)?.enabled !== false) ||
    values(defaults?.models).some(
      (item) =>
        !fields(item, ["alias", "agentRuntime"]) || !runtime(nativeStateRecord(item)?.agentRuntime),
    ) ||
    values(agents?.entries).some(
      (item) =>
        !fields(item, ["workspace", "model"]) || !modelChoice(nativeStateRecord(item)?.model),
    )
  ) {
    return false;
  }
  const models = nativeStateRecord(config.models);
  if (
    !fields(config.models, ["mode", "providers"]) ||
    values(models?.providers).some((item) => {
      const provider = nativeStateRecord(item);
      return (
        !fields(item, [
          "baseUrl",
          "api",
          "apiKey",
          "auth",
          "headers",
          "models",
          "maxTokens",
          "agentRuntime",
        ]) ||
        !environmentInput(provider?.apiKey) ||
        values(provider?.headers).some((value) => !environmentInput(value)) ||
        !runtime(provider?.agentRuntime) ||
        (Array.isArray(provider?.models) &&
          provider.models.some((item) => {
            const model = nativeStateRecord(item);
            return (
              !fields(item, [
                "id",
                "name",
                "reasoning",
                "input",
                "cost",
                "contextWindow",
                "contextTokens",
                "maxTokens",
                "thinkingLevelMap",
                "agentRuntime",
                "mediaInput",
                "metadataSource",
              ]) ||
              !fields(model?.cost, ["input", "output", "cacheRead", "cacheWrite"]) ||
              !runtime(model?.agentRuntime)
            );
          }))
      );
    })
  ) {
    return false;
  }
  if (
    config.browser !== undefined &&
    (!fields(config.browser, ["enabled"]) || nativeStateRecord(config.browser)?.enabled !== false)
  ) {
    return false;
  }
  const tools = nativeStateRecord(config.tools);
  const web = nativeStateRecord(tools?.web);
  const search = nativeStateRecord(web?.search);
  const policy = nativeStateRecord(tools?.gatewayPolicy);
  const cron = nativeStateRecord(config.cron);
  if (
    !fields(config.tools, [
      "allow",
      "deny",
      "alsoAllow",
      "profile",
      "gatewayPolicy",
      "elevated",
      "web",
    ]) ||
    !fields(tools?.elevated, ["enabled"]) ||
    !fields(tools?.web, ["search", "fetch"]) ||
    !fields(web?.search, ["enabled", "openaiCodex"]) ||
    !fields(search?.openaiCodex, ["enabled", "mode"]) ||
    !fields(web?.fetch, ["enabled"]) ||
    !fields(tools?.gatewayPolicy, ["allow", "actions", "automations"]) ||
    !fields(policy?.automations, ["scope", "allowCommandJobs"]) ||
    !fields(config.cron, ["triggers"]) ||
    !fields(cron?.triggers, ["enabled"]) ||
    (cron?.triggers !== undefined && nativeStateRecord(cron.triggers)?.enabled !== false)
  ) {
    return false;
  }
  const workers = nativeStateRecord(config.cloudWorkers);
  if (
    !fields(config.cloudWorkers, ["requiredProfile", "profiles"]) ||
    values(workers?.profiles).some((item) => {
      const profile = nativeStateRecord(item);
      const settings = nativeStateRecord(profile?.settings);
      return (
        !fields(item, ["provider", "settings"]) ||
        profile?.provider !== "device" ||
        !fields(profile.settings, ["device", "inference"]) ||
        !nativeStateText(settings?.device) ||
        !/^[a-f0-9]{64}$/.test(settings.device) ||
        settings.inference !== "worker"
      );
    })
  ) {
    return false;
  }
  const diagnostics = nativeStateRecord(config.diagnostics);
  if (
    !fields(config.logging, ["level", "consoleLevel", "consoleStyle"]) ||
    !fields(config.diagnostics, ["otel"]) ||
    !fields(diagnostics?.otel, ["logs"])
  ) {
    return false;
  }
  const approvals = nativeStateRecord(config.approvals);
  const pluginApproval = nativeStateRecord(approvals?.plugin);
  const slackApproval = nativeStateRecord(pluginApproval?.slack);
  if (
    !fields(config.approvals, ["plugin"]) ||
    !fields(approvals?.plugin, ["slack"]) ||
    !fields(pluginApproval?.slack, ["approvers", "plugins"]) ||
    values(slackApproval?.plugins).some(
      (item) =>
        !fields(item, ["approvers", "tools"]) ||
        values(nativeStateRecord(item)?.tools).some((tool) => !fields(tool, ["approvers"])),
    )
  ) {
    return false;
  }
  const mcp = nativeStateRecord(config.mcp);
  if (
    !fields(config.mcp, ["apps", "servers"]) ||
    !fields(mcp?.apps, ["enabled", "sandboxOrigin", "sandboxPort"])
  ) {
    return false;
  }
  if (mcp?.servers !== undefined) {
    const servers = nativeStateRecord(mcp.servers);
    // Native MCP servers can start processes in the Gateway. Codex's
    // Harness-local MCP selections are a separate configuration input.
    if (servers === undefined || Object.keys(servers).length > 0) {
      return false;
    }
  }
  // Custom environment and Secret providers add inputs to trusted helpers.
  // v1 leaves those sources to operator recovery rather than interpreting them.
  for (const key of ["env", "secrets", "channels"]) {
    if (config[key] !== undefined) {
      const settings = nativeStateRecord(config[key]);
      if (settings === undefined || Object.keys(settings).length > 0) {
        return false;
      }
    }
  }
  const hooks = nativeStateRecord(config.hooks);
  if (config.hooks !== undefined && (hooks === undefined || Object.keys(hooks).length > 0)) {
    return false;
  }
  const plugins = nativeStateRecord(config.plugins);
  if (
    !fields(config.plugins, ["allow", "deny", "entries", "load", "slots"]) ||
    !fields(plugins?.load, ["paths"])
  ) {
    return false;
  }
  const paths = nativeStateRecord(plugins?.load)?.paths;
  if (
    paths !== undefined &&
    (!Array.isArray(paths) ||
      paths.some(
        (path) =>
          !nativeStateText(path, 4096) ||
          !path.startsWith("/app/") ||
          path.split("/").includes("..") ||
          path.includes("\0"),
      ))
  ) {
    return false;
  }
  const entries = nativeStateRecord(plugins?.entries);
  return (
    entries === undefined ||
    Object.entries(entries).every(([id, value]) => {
      const entry = nativeStateRecord(value);
      return (
        entry !== undefined &&
        fields(entry, ["enabled", "config"]) &&
        (entry.enabled === false || nativeStatePluginConfigurationEligible(id, entry.config))
      );
    })
  );
}

/** Runs in the trusted Gateway wrapper, never in the Harness. */
export const NATIVE_GATEWAY_STATE_RECOVERY_RUNTIME = String.raw`
${NATIVE_STATE_OWNER_VALIDATORS}
${nativeStatePluginConfigurationEligible.toString()}
${nativeGatewayRecoveryConfigurationEligible.toString()}
const nativeStateDatabasePath = ${JSON.stringify(GATEWAY_STATE_DATABASE_PATH)};
const nativeStateObservationIdentity = {
  toolBoundary: ${JSON.stringify(TRUSTED_GATEWAY_TOOL_BOUNDARY)},
  instanceId: pluginStatusReport.startupId,
  stateOrigin: ${JSON.stringify(GATEWAY_PRIVATE_STATE_ORIGIN)},
  storageId: process.env.OPENCLAW_STATE_RECOVERY_STORAGE_ID,
};
const nativeStateRecoveryEnabled = process.env.OPENCLAW_STATE_OWNER_RECOVERY_PATH !== undefined &&
  process.env.OPENCLAW_TRUSTED_GATEWAY_TOOL_BOUNDARY === nativeStateObservationIdentity.toolBoundary &&
  process.env.OPENCLAW_STATE_RECOVERY_ORIGIN === nativeStateObservationIdentity.stateOrigin &&
  nativeStateText(nativeStateObservationIdentity.storageId);
let nativeStateSourcesEligible = false;
let nativeStateSourcesRefused = false;
let nativeStateSourceConfiguration;
if (nativeStateRecoveryEnabled) {
  runtimeGatewayState = { ...nativeStateObservationIdentity };
  runtimeStatusObservation = observeNativeGatewayStateOwner;
}

function nativeStateCommand(args, maximumBytes = 65536) {
  return new Promise((resolve) => {
    const command = spawn("node", ["/app/openclaw.mjs", ...args], { env: gatewayEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stdoutBytes = 0;
    let oversized = false;
    // The public CLI may respawn its launcher. Bound that owned process group,
    // including descendants that would otherwise keep the output pipe open.
    const kill = () => {
      try { process.kill(-command.pid, "SIGKILL"); }
      catch { command.kill("SIGKILL"); }
    };
    const timer = setTimeout(kill, ${NATIVE_GATEWAY_COMMAND_TIMEOUT_MS});
    command.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumBytes) {
        oversized = true;
        kill();
      } else chunks.push(chunk);
    });
    // Native errors may contain paths or configuration. The status exposes only a fixed state.
    command.stderr.resume();
    command.once("error", () => { clearTimeout(timer); resolve(undefined); });
    command.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || oversized) { resolve(undefined); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(undefined); }
    });
  });
}

function nativeStateImageSource(path) {
  if (!nativeStateText(path, 4096)) return false;
  try {
    const fs = require("node:fs");
    const resolved = fs.realpathSync(path);
    if (!resolved.startsWith("/app/")) return false;
    try { fs.accessSync(resolved, fs.constants.W_OK); return false; }
    catch (error) { return ["EROFS", "EACCES", "EPERM"].includes(error?.code); }
  } catch { return false; }
}

function nativeStateRawInputsEligible(config) {
  try {
    if (!nativeGatewayRecoveryConfigurationEligible(config)) return false;
    const fs = require("node:fs");
    try {
      fs.lstatSync((process.env.OPENCLAW_STATE_DIR || "/home/node/.openclaw") + "/.env");
      return false;
    } catch (error) { if (error?.code !== "ENOENT") return false; }
    const paths = nativeStateRecord(nativeStateRecord(config.plugins)?.load)?.paths;
    return paths === undefined || Array.isArray(paths) && paths.every(nativeStateImageSource);
  } catch { return false; }
}

function refuseNativeStateSources() {
  // Do not upgrade this process after an unprotected input may have affected it.
  nativeStateSourcesRefused = true;
  nativeStateSourcesEligible = false;
  runtimeGatewayState = { ...nativeStateObservationIdentity, recovery: { state: "manual" } };
  return false;
}


async function qualifyNativeGatewayStateSources() {
  if (!nativeStateRecoveryEnabled || nativeStateSourcesRefused) return false;
  let config;
  try { config = readOpenClawConfig(); } catch { return refuseNativeStateSources(); }
  if (!nativeStateRawInputsEligible(config)) return refuseNativeStateSources();
  const serialized = JSON.stringify(config);
  if (serialized === nativeStateSourceConfiguration) return nativeStateSourcesEligible;
  nativeStateSourcesEligible = false;
  // This supported native command reads manifest/index metadata; it never
  // imports plugin runtimes. Unknown inventories are not evidence of absence.
  const report = nativeStateRecord(await nativeStateCommand(["plugins", "list", "--enabled", "--json"], ${NATIVE_PLUGIN_INVENTORY_MAX_BYTES}));
  const registry = nativeStateRecord(report?.registry);
  const registryDiagnostic = nativeStateRecord(registry?.diagnostics?.[0]);
  // Fresh private state has no saved index. Native derives the complete inventory
  // and reports this one informational condition; all its source checks still apply.
  const freshDerivedRegistry = registry?.source === "derived" && registry.diagnostics?.length === 1 &&
    registryDiagnostic?.level === "info" &&
    registryDiagnostic.code === "persisted-registry-missing";
  if (report?.workspaceScope !== "selected" || !nativeStateText(report.workspaceDir, 4096) ||
      !["provided", "persisted", "derived"].includes(registry?.source) ||
      !Array.isArray(registry?.diagnostics) || (registry.diagnostics.length !== 0 && !freshDerivedRegistry) ||
      !Array.isArray(report.diagnostics) || report.diagnostics.length !== 0 ||
      !Array.isArray(report.plugins)) return refuseNativeStateSources();
  const ids = new Set();
  for (const value of report.plugins) {
    const plugin = nativeStateRecord(value);
    if (!nativeStateText(plugin?.id) || ids.has(plugin.id) || plugin.enabled !== true || plugin.status !== "loaded" ||
        !["bundled", "config"].includes(plugin.origin) ||
        !nativeStatePluginConfigurationEligible(plugin.id,
          nativeStateRecord(nativeStateRecord(config.plugins)?.entries)?.[plugin.id]?.config) ||
        !nativeStateImageSource(plugin.source) || !nativeStateImageSource(plugin.rootDir)) {
      return refuseNativeStateSources();
    }
    ids.add(plugin.id);
  }
  const plugins = nativeStateRecord(config.plugins);
  const entries = nativeStateRecord(plugins?.entries) ?? {};
  const references = [...(Array.isArray(plugins?.allow) ? plugins.allow : []),
    ...Object.entries(entries).filter(([, entry]) => nativeStateRecord(entry)?.enabled === true).map(([id]) => id),
    ...Object.values(nativeStateRecord(plugins?.slots) ?? {})];
  if (references.some((id) => !nativeStateText(id) ||
      nativeStateRecord(entries[id])?.enabled !== false && !ids.has(id))) {
    return refuseNativeStateSources();
  }
  nativeStateSourceConfiguration = serialized;
  nativeStateSourcesEligible = true;
  return true;
}

function nativeStateInspection(value) {
  const result = nativeStateRecord(value);
  const records = parseNativeGatewayOwnerRecords(result?.ownerRecords);
  if (records === undefined || typeof result?.present !== "boolean" ||
      result.present !== (records.length > 0) ||
      !nativeStateText(result.confirmation, 1024)) return undefined;
  return { records, confirmation: result.confirmation };
}

function nativeStateRequest() {
  try {
    const text = pluginReadFileSync(process.env.OPENCLAW_STATE_OWNER_RECOVERY_PATH, "utf8");
    if (Buffer.byteLength(text) > 16384) return undefined;
    const request = nativeStateRecord(JSON.parse(text));
    const owner = parseNativeGatewayStateOwner(request?.owner);
    if (request?.version !== 1 || owner?.databasePath !== nativeStateDatabasePath ||
        request.revisionId !== process.env.OPENCLAW_AGENT_REVISION_ID ||
        request.podUid !== process.env.OPENCLAW_POD_UID ||
        request.storageId !== nativeStateObservationIdentity.storageId ||
        request.instanceId !== pluginStatusReport.startupId) return undefined;
    return owner;
  } catch { return undefined; }
}

async function prepareNativeGatewayStateRecovery() {
  if (!nativeStateRecoveryEnabled) return true;
  let config;
  try { config = readOpenClawConfig(); } catch { refuseNativeStateSources(); return true; }
  if (!nativeStateRawInputsEligible(config)) { refuseNativeStateSources(); return true; }
  const first = nativeStateInspection(await nativeStateCommand(["gateway", "recover-lock", "--json"]));
  // Older runtimes and incomplete inspections cannot authorize recovery. Native startup
  // retains its own existing refusal behavior; this wrapper never guesses an owner.
  if (first === undefined || first.records.length === 0) return true;
  runtimeGatewayState = { ...nativeStateObservationIdentity,
    recovery: { state: "waiting", ownerRecords: first.records } };
  for (;;) {
    const expected = nativeStateRequest();
    if (expected !== undefined) {
      const current = nativeStateInspection(await nativeStateCommand(["gateway", "recover-lock", "--json"]));
      if (current !== undefined && nativeGatewayOwnersMatch(current.records, expected)) {
        const confirmed = await nativeStateCommand(["gateway", "recover-lock", "--json", "--confirm", current.confirmation]);
        const after = nativeStateInspection(await nativeStateCommand(["gateway", "recover-lock", "--json"]));
        if (confirmed !== undefined && after?.records.length === 0) {
          runtimeGatewayState = { ...nativeStateObservationIdentity };
          return true;
        }
        // A changed native snapshot or live-holder refusal requires a new administrative
        // decision. Reusing the same intent must not retry a rejected confirmation.
        runtimeGatewayState = { ...nativeStateObservationIdentity,
          recovery: { state: "refused", ownerRecords: current.records } };
        return false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function observeNativeGatewayStateOwner() {
  if (!nativeStateRecoveryEnabled) return;
  const source = child;
  const port = process.env.OPENCLAW_GATEWAY_PORT;
  if (!childRunning || source === undefined || port === undefined) return;
  if (!(await qualifyNativeGatewayStateSources())) return;
  if (child !== source || !childRunning) return;
  // The normal SDK can select a configured remote Gateway. Custody must come
  // from the exact local child, with normal local auth and a checked destination.
  const result = await callNativeGateway("system.info", {}, 2000, undefined, 65536, port);
  if (!result.ok || child !== source || !childRunning) return;
  const owner = parseNativeGatewayStateOwner(nativeStateRecord(result.value)?.stateOwner);
  runtimeGatewayState = { ...nativeStateObservationIdentity,
    sourceProtection: ${JSON.stringify(GATEWAY_RECOVERY_SOURCE_PROTECTION)} };
  if (owner === undefined || owner.pid !== source.pid || owner.databasePath !== nativeStateDatabasePath) return;
  if (process.env.OPENCLAW_POD_UID !== undefined) {
    const message = gatewayOwnerTerminationMessage({ owner,
      ...nativeStateObservationIdentity,
      sourceProtection: ${JSON.stringify(GATEWAY_RECOVERY_SOURCE_PROTECTION)},
      pvcUid: nativeStateObservationIdentity.storageId,
      podUid: process.env.OPENCLAW_POD_UID,
      revisionId: process.env.OPENCLAW_AGENT_REVISION_ID });
    if (Buffer.byteLength(message) >= 4096) return;
    try { pluginWriteFileSync(${JSON.stringify(GATEWAY_STATE_TERMINATION_PATH)}, message); }
    catch { return; }
  }
  runtimeGatewayState.liveOwner = owner;
}
`;
