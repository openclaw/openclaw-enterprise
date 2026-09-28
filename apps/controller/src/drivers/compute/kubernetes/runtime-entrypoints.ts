import { PLUGIN_RUNTIME_TRANSLATOR_SOURCE } from "../../plugin/runtime-translator.ts";

// Match the pinned OpenClaw service stop budget: 315s drain, 10s cleanup,
// and 5s supervisor margin. Idle Gateways exit as soon as their work settles.
export const GATEWAY_STOP_TIMEOUT_MS = 330_000;

export const PLUGIN_APP_SERVER_TOKEN_HMAC_DOMAIN = "openclaw-plugin-runtime/app-server-token/v1";

const PLUGIN_APP_SERVER_TOKEN_DERIVATION_HELPER = String.raw`
function derivePluginAppServerTokenFromBase(baseToken, revisionId, startupId) {
  if (
    typeof baseToken !== "string" ||
    baseToken.length === 0 ||
    typeof revisionId !== "string" ||
    revisionId.length === 0 ||
    typeof startupId !== "string" ||
    startupId.length === 0
  ) {
    throw new Error("Codex app-server token derivation inputs are invalid.");
  }
  return createHmac("sha256", baseToken)
    .update(${JSON.stringify(PLUGIN_APP_SERVER_TOKEN_HMAC_DOMAIN)})
    .update("\0")
    .update(revisionId)
    .update("\0")
    .update(startupId)
    .digest("hex");
}
`;

export const PLUGIN_RUNTIME_HELPERS = String.raw`
const pluginRuntimeTranslator = (${PLUGIN_RUNTIME_TRANSLATOR_SOURCE})();
const {
  dirname: pluginDirname,
  resolve: pluginResolve,
} = require("node:path");
const {
  mkdirSync: pluginMkdirSync,
  readFileSync: pluginReadFileSync,
  writeFileSync: pluginWriteFileSync,
} = require("node:fs");
const {
  createHmac,
  timingSafeEqual: pluginTimingSafeEqual,
  randomUUID: pluginRandomUUID,
} = require("node:crypto");
const { spawn: pluginSpawn, spawnSync: pluginSpawnSync } = require("node:child_process");
const { createServer: pluginCreateServer } = require("node:http");
const { isDeepStrictEqual: pluginDeepEqual } = require("node:util");

const CODEX_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS = Number(process.env.OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS ?? "10000");
const CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS = Number(process.env.OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS ?? "60000");
const PLUGIN_STATUS_PATH = "/openclaw/plugin-runtime/status";
const REMOTE_PLUGIN_STATUS_PATH = "/openclaw/plugin-runtime/remote-status";
const RUNTIME_STATUS_PATH = "/openclaw/runtime/status";
const RUNTIME_DIAGNOSTICS_PATH = "/openclaw/runtime/diagnostics";
const RUNTIME_IMAGE_PATH = "/openclaw/runtime/image";
const PLUGIN_DIAGNOSTIC_CODES = new Set(["PLUGIN_INSTALL_FAILED", "PLUGIN_AUTH_REQUIRED"]);
const RUNTIME_DIAGNOSTIC_CODES = new Set([
  "LOGIN_FAILED",
  "MODEL_PROBE_FAILED",
  "MODEL_PROBE_TIMEOUT",
  "UNAVAILABLE",
  "NOT_CONFIGURED",
  "AUTHENTICATION_FAILED",
  "DISCONNECTED",
  "INCOMPATIBLE_RESPONSE",
  "PROBE_FAILED",
]);
const pluginBaseAppServerToken = process.env.APP_SERVER_TOKEN;

${PLUGIN_APP_SERVER_TOKEN_DERIVATION_HELPER}

class PluginTerminalDiagnosticError extends Error {
  constructor(diagnostic, message) {
    super(message);
    this.diagnostic = diagnostic;
  }
}

class CodexAppServerRequestError extends Error {
  constructor(method, message) {
    super(message);
    this.method = method;
  }
}

function readRuntimePayload() {
  const encoded = process.env.OPENCLAW_PLUGIN_RUNTIME_JSON;
  const manifestPath = process.env.OPENCLAW_PLUGIN_RUNTIME_MANIFEST;
  if (encoded === undefined && manifestPath === undefined) return undefined;
  if (encoded !== undefined) return JSON.parse(encoded);
  return {
    manifest: JSON.parse(pluginReadFileSync(manifestPath, "utf8")),
    codexConfigurationToml:
      process.env.OPENCLAW_PLUGIN_CODEX_CONFIG_TOML === undefined
        ? undefined
        : pluginReadFileSync(process.env.OPENCLAW_PLUGIN_CODEX_CONFIG_TOML, "utf8"),
  };
}

function readPluginRuntime(kind) {
  const runtime = readRuntimePayload();
  if (runtime === undefined) return undefined;
  if (runtime.manifest?.kind !== kind) throw new Error("Plugin runtime artifact kind mismatch.");
  return runtime;
}

function readGatewayPluginRuntime() {
  const runtime = readRuntimePayload();
  if (runtime === undefined) return undefined;
  if (runtime.manifest?.kind === "openclaw") return runtime;
  if (
    runtime.manifest?.kind === "codex" &&
    (Object.keys(runtime.manifest.selections ?? {}).length > 0 ||
      runtime.manifest.repositoryBrokerNetworkPolicy !== undefined ||
      runtime.manifest.pluginApprovers !== undefined)
  ) {
    return runtime;
  }
  if (runtime.manifest?.kind === "codex") return undefined;
  throw new Error("Plugin runtime artifact kind mismatch.");
}

function safeRuntimePath(root, relative) {
  if (typeof relative !== "string" || relative.length === 0 || relative.startsWith("/")) {
    throw new Error("Plugin runtime path must be relative.");
  }
  const resolved = pluginResolve(root, relative);
  const normalizedRoot = pluginResolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + "/")) {
    throw new Error("Plugin runtime path escapes its target directory.");
  }
  return resolved;
}

function writeCodexConfigToml(runtime) {
  if (runtime.manifest?.kind !== "codex") {
    throw new Error("Codex plugin runtime artifact kind mismatch.");
  }
  if (runtime.codexConfigurationToml === undefined) {
    throw new Error("Codex plugin config.toml is missing.");
  }
  const target = safeRuntimePath(process.env.CODEX_HOME, "config.toml");
  pluginMkdirSync(pluginDirname(target), { recursive: true });
  pluginWriteFileSync(target, runtime.codexConfigurationToml, { mode: 0o600 });
}

function pluginRuntimeReady() {
  const marker = process.env.OPENCLAW_PLUGIN_READY_MARKER;
  if (marker !== undefined) pluginWriteFileSync(marker, "ready\n", { mode: 0o600 });
}

function pluginRuntimeStatusContainer() {
  return requireNonEmptyString(process.env.OPENCLAW_PLUGIN_STATUS_CONTAINER, "Plugin status container");
}

function pluginRuntimeRevisionId() {
  return requireNonEmptyString(process.env.OPENCLAW_AGENT_REVISION_ID, "Plugin status revision ID");
}

function pluginRuntimeStatusPort() {
  if (process.env.OPENCLAW_PLUGIN_STATUS_PORT === undefined) return undefined;
  const port = Number(process.env.OPENCLAW_PLUGIN_STATUS_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Plugin status port is invalid.");
  }
  return port;
}

function runtimeStatusPort() {
  if (process.env.OPENCLAW_RUNTIME_STATUS_PORT === undefined) return undefined;
  const port = Number(process.env.OPENCLAW_RUNTIME_STATUS_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Runtime status port is invalid.");
  }
  return port;
}

function runtimeStatusContainer() {
  return requireNonEmptyString(process.env.OPENCLAW_RUNTIME_STATUS_CONTAINER, "Runtime status container");
}

let pluginStatusReport = {
  revisionId: process.env.OPENCLAW_AGENT_REVISION_ID ?? "",
  container: process.env.OPENCLAW_PLUGIN_STATUS_CONTAINER ?? "",
  startupId: pluginRandomUUID(),
  podUid: process.env.OPENCLAW_POD_UID ?? "",
  phase: "starting",
  successfulPluginIds: [],
  failures: [],
};

let runtimeStartupFailure;

function publishPluginRuntimeStatus(report) {
  if (pluginRuntimeStatusPort() === undefined) return;
  const successfulPluginIds = [...new Set(report.successfulPluginIds ?? [])];
  const failures = [
    ...new Map((report.failures ?? []).map((failure) => [failure.pluginId, pluginDiagnostic(failure.pluginId, failure.code)])).values(),
  ];
  if (successfulPluginIds.some((pluginId) => failures.some((failure) => failure.pluginId === pluginId))) {
    throw new Error("Plugin status report cannot mark a plugin successful and failed.");
  }
  pluginStatusReport = {
    ...pluginStatusReport,
    revisionId: pluginRuntimeRevisionId(),
    container: pluginRuntimeStatusContainer(),
    podUid: requireNonEmptyString(process.env.OPENCLAW_POD_UID, "Plugin status Pod UID"),
    phase: report.phase,
    successfulPluginIds,
    failures,
  };
}

function publishRuntimeFailure(check, code) {
  if (runtimeStatusPort() === undefined) return;
  requireNonEmptyString(check, "Runtime failure check");
  if (!RUNTIME_DIAGNOSTIC_CODES.has(code)) {
    throw new Error("Runtime failure code is invalid.");
  }
  runtimeStartupFailure = {
    component: runtimeStatusContainer(),
    check,
    checkedAt: new Date().toISOString(),
    code,
  };
}

function publishRuntimeReady() {
  if (runtimeStatusPort() === undefined) return;
  runtimeStartupFailure = undefined;
}

function runtimeDiagnosticCheck(check, state, checkedAt, code) {
  requireNonEmptyString(check, "Runtime diagnostic check");
  if (code !== undefined && !RUNTIME_DIAGNOSTIC_CODES.has(code)) {
    throw new Error("Runtime diagnostic code is invalid.");
  }
  return {
    component: runtimeStatusContainer(),
    check,
    state,
    checkedAt,
    ...(code === undefined ? {} : { code }),
  };
}

function runtimeStatusReport() {
  return {
    revisionId: requireNonEmptyString(process.env.OPENCLAW_AGENT_REVISION_ID, "Runtime status revision ID"),
    container: runtimeStatusContainer(),
    podUid: requireNonEmptyString(process.env.OPENCLAW_POD_UID, "Runtime status Pod UID"),
    ...(runtimeStartupFailure === undefined ? {} : { runtimeFailure: runtimeStartupFailure }),
  };
}

function remotePluginStatusAuthorization() {
  const token = requireNonEmptyString(pluginBaseAppServerToken, "Plugin status base token");
  return "Bearer " + createHmac("sha256", token)
    .update("openclaw-plugin-status/v1\\0" + pluginRuntimeRevisionId()).digest("hex");
}

function statusCheckFromBoolean(check, value, checkedAt, failureCode) {
  if (value === true) return runtimeDiagnosticCheck(check, "succeeded", checkedAt);
  if (value === false) return runtimeDiagnosticCheck(check, "failed", checkedAt, failureCode);
  return runtimeDiagnosticCheck(check, "unknown", checkedAt, "INCOMPATIBLE_RESPONSE");
}

function clearTimer(timer) {
  clearTimeout(timer);
}

function armTimer(callback, timeoutMs) {
  const timer = setTimeout(callback, timeoutMs);
  if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  return timer;
}

function runNativeRuntimeJson(args, timeoutMs, abortSignal) {
  return new Promise((resolve) => {
    const child = pluginSpawn("node", ["/app/openclaw.mjs", ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let oversized = false;
    let failed = false;
    let aborted = false;
    let killTimer;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      if (killTimer !== undefined) clearTimer(killTimer);
      abortSignal?.removeEventListener?.("abort", abortChild);
      resolve(result);
    };
    const abortChild = () => {
      if (settled || aborted) return;
      aborted = true;
      child.kill("SIGTERM");
      killTimer = armTimer(() => child.kill("SIGKILL"), 1000);
    };
    const timer = armTimer(abortChild, timeoutMs);
    if (abortSignal?.aborted) abortChild();
    else abortSignal?.addEventListener?.("abort", abortChild, { once: true });
    child.stdout.on("data", (chunk) => {
      if (oversized) return;
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > 65536) {
        oversized = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code, signal) => {
      if (oversized) {
        finish({ ok: false, code: "INCOMPATIBLE_RESPONSE" });
        return;
      }
      if (aborted || signal === "SIGTERM" || signal === "SIGKILL") {
        finish({ ok: false, code: "UNAVAILABLE" });
        return;
      }
      if (failed || code !== 0) {
        finish({ ok: false, code: "PROBE_FAILED" });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(stdout) });
      } catch {
        finish({ ok: false, code: "INCOMPATIBLE_RESPONSE" });
      }
    });
  });
}

function unknownSlackChecks(checkedAt, code) {
  return [
    runtimeDiagnosticCheck("configuration", "unknown", checkedAt, code),
    runtimeDiagnosticCheck("authentication", "unknown", checkedAt, code),
    runtimeDiagnosticCheck("connectivity", "unknown", checkedAt, code),
  ];
}

const SAFE_AUTHENTICATION_REJECTION_CODES = new Set([
  "auth_failed",
  "authentication_failed",
  "invalid_auth",
  "account_inactive",
  "not_authed",
  "token_revoked",
  "missing_token",
  "missing_user_token",
]);

function normalizedAuthenticationRejectionCode(value) {
  const normalizedCode = value?.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  return SAFE_AUTHENTICATION_REJECTION_CODES.has(normalizedCode) ? normalizedCode : undefined;
}

function probeErrorAuthenticationCode(error) {
  const direct = normalizedAuthenticationRejectionCode(error);
  if (direct !== undefined) return direct;
  const wrapped = error.match(/^An API error occurred:\s*([a-z_][a-z0-9_]*)(?:$|;)/i)?.[1];
  return normalizedAuthenticationRejectionCode(wrapped);
}

function credentialRejectionCode(probe) {
  if (!isPlainObject(probe) || probe.ok !== false) return undefined;
  const rawCode = typeof probe.error === "string" ? probe.error : undefined;
  if (rawCode !== undefined && probeErrorAuthenticationCode(rawCode) !== undefined) {
    return "AUTHENTICATION_FAILED";
  }
  return "PROBE_FAILED";
}

function authenticationCheckFromProbe(probe, checkedAt) {
  if (!isPlainObject(probe) || typeof probe.ok !== "boolean") {
    return runtimeDiagnosticCheck("authentication", "unknown", checkedAt, "INCOMPATIBLE_RESPONSE");
  }
  if (probe.ok === true) return runtimeDiagnosticCheck("authentication", "succeeded", checkedAt);
  const code = credentialRejectionCode(probe);
  return runtimeDiagnosticCheck(
    "authentication",
    code === "AUTHENTICATION_FAILED" ? "failed" : "unknown",
    checkedAt,
    code,
  );
}

function connectivityCheckFromConnected(connected, checkedAt) {
  if (connected === true) return runtimeDiagnosticCheck("connectivity", "succeeded", checkedAt);
  if (connected === false) {
    return runtimeDiagnosticCheck("connectivity", "failed", checkedAt, "DISCONNECTED");
  }
  return runtimeDiagnosticCheck("connectivity", "unknown", checkedAt, "INCOMPATIBLE_RESPONSE");
}

function slackChecksFromStatusPayload(payload, checkedAt) {
  if (payload?.configOnly === true) {
    if (!Array.isArray(payload.configuredChannels)) {
      return unknownSlackChecks(checkedAt, "INCOMPATIBLE_RESPONSE");
    }
    const configured = payload.configuredChannels.includes("slack");
    if (configured !== true) {
      return [
        runtimeDiagnosticCheck("configuration", "failed", checkedAt, "NOT_CONFIGURED"),
        runtimeDiagnosticCheck("authentication", "unknown", checkedAt),
        runtimeDiagnosticCheck("connectivity", "unknown", checkedAt),
      ];
    }
    return [
      runtimeDiagnosticCheck("configuration", "succeeded", checkedAt),
      runtimeDiagnosticCheck("authentication", "unknown", checkedAt, "UNAVAILABLE"),
      runtimeDiagnosticCheck("connectivity", "unknown", checkedAt, "UNAVAILABLE"),
    ];
  }
  const channelSummary = isPlainObject(payload?.channels) ? payload.channels.slack : undefined;
  const accountsByChannel = isPlainObject(payload?.channelAccounts) ? payload.channelAccounts : undefined;
  const defaultAccounts = isPlainObject(payload?.channelDefaultAccountId)
    ? payload.channelDefaultAccountId
    : undefined;
  const defaultAccountId =
    typeof defaultAccounts?.slack === "string" && defaultAccounts.slack.length > 0
      ? defaultAccounts.slack
      : undefined;
  if (!isPlainObject(channelSummary) || !Array.isArray(accountsByChannel?.slack) || defaultAccountId === undefined) {
    return unknownSlackChecks(checkedAt, "INCOMPATIBLE_RESPONSE");
  }
  const accounts = accountsByChannel.slack.filter(isPlainObject);
  const account = accounts.find((candidate) => candidate.accountId === defaultAccountId);
  if (!isPlainObject(account)) return unknownSlackChecks(checkedAt, "INCOMPATIBLE_RESPONSE");
  const configured =
    typeof channelSummary.configured === "boolean"
      ? channelSummary.configured
      : typeof account.configured === "boolean"
        ? account.configured
        : undefined;
  if (configured === false) {
    return [
      runtimeDiagnosticCheck("configuration", "failed", checkedAt, "NOT_CONFIGURED"),
      runtimeDiagnosticCheck("authentication", "unknown", checkedAt),
      runtimeDiagnosticCheck("connectivity", "unknown", checkedAt),
    ];
  }
  const probe = isPlainObject(account.probe) ? account.probe : undefined;
  const connected =
    typeof channelSummary.connected === "boolean"
      ? channelSummary.connected
      : typeof account.connected === "boolean"
        ? account.connected
        : undefined;
  return [
    statusCheckFromBoolean("configuration", configured, checkedAt, "NOT_CONFIGURED"),
    authenticationCheckFromProbe(probe, checkedAt),
    connectivityCheckFromConnected(connected, checkedAt),
  ];
}

async function slackChannelDiagnosticChecks(checkedAt, abortSignal) {
  if (runtimeStatusContainer() !== "gateway") return [];
  const result = await runNativeRuntimeJson(
    ["channels", "status", "--channel", "slack", "--json", "--probe", "--timeout", "5000"],
    6000,
    abortSignal,
  );
  if (!result.ok) return unknownSlackChecks(checkedAt, result.code);
  return slackChecksFromStatusPayload(result.value, checkedAt);
}

async function runtimeDiagnosticsReport(abortSignal) {
  const observedAt = new Date().toISOString();
  return {
    revisionId: requireNonEmptyString(process.env.OPENCLAW_AGENT_REVISION_ID, "Runtime status revision ID"),
    container: runtimeStatusContainer(),
    podUid: requireNonEmptyString(process.env.OPENCLAW_POD_UID, "Runtime status Pod UID"),
    observedAt,
    checks: (await slackChannelDiagnosticChecks(observedAt, abortSignal)).slice(0, 32),
  };
}

function startPluginRuntimeStatusServer() {
  const port = runtimeStatusPort() ?? pluginRuntimeStatusPort();
  if (port === undefined) return;
  const server = pluginCreateServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const remote = pathname === REMOTE_PLUGIN_STATUS_PATH && process.env.OPENCLAW_REMOTE_PLUGIN_STATUS === "true";
    if (remote) {
      const expected = Buffer.from(remotePluginStatusAuthorization());
      const supplied = Buffer.from(typeof request.headers.authorization === "string" ? request.headers.authorization : "");
      if (expected.length !== supplied.length || !pluginTimingSafeEqual(expected, supplied)) {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    if (
      request.method !== "GET" ||
      !remote && ![
        RUNTIME_STATUS_PATH,
        RUNTIME_DIAGNOSTICS_PATH,
        PLUGIN_STATUS_PATH,
        RUNTIME_IMAGE_PATH,
      ].includes(pathname)
    ) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (pathname === RUNTIME_IMAGE_PATH) {
      let commit = null;
      try {
        const metadata = JSON.parse(pluginReadFileSync("/opt/oce/runtime/build.json", "utf8"));
        if (typeof metadata.commit === "string" && /^[a-f0-9]{40}$/.test(metadata.commit)) commit = metadata.commit;
      } catch {}
      response.writeHead(200, { "content-type": "application/json" });
      let openclawCommit = null;
      try {
        const provenance = JSON.parse(pluginReadFileSync("/opt/oce/runtime/provenance.json", "utf8"));
        if (provenance.source === "https://github.com/openclaw/openclaw" &&
            typeof provenance.commit === "string" && /^[a-f0-9]{40}$/.test(provenance.commit)) {
          openclawCommit = provenance.commit;
        }
      } catch {}
      response.end(JSON.stringify({ commit, openclawCommit }));
      return;
    }
    if (pathname === RUNTIME_STATUS_PATH) {
      if (runtimeStatusPort() === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(runtimeStatusReport()));
      return;
    }
    if (pathname === RUNTIME_DIAGNOSTICS_PATH) {
      if (runtimeStatusPort() === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      request.on?.("aborted", abort);
      response.on?.("close", abort);
      try {
        const report = await runtimeDiagnosticsReport(abortController.signal);
        if (abortController.signal.aborted) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(report));
      } catch {
        if (!abortController.signal.aborted) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unavailable" }));
        }
      } finally {
        request.off?.("aborted", abort);
        response.off?.("close", abort);
      }
      return;
    }
    if (pluginRuntimeStatusPort() === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(pluginStatusReport));
  });
  server.listen(port, "0.0.0.0");
}

function pluginBestEffortEnabled() {
  return pluginRuntimeStatusPort() !== undefined;
}

function derivePluginAppServerToken(startupId) {
  return derivePluginAppServerTokenFromBase(
    requireNonEmptyString(pluginBaseAppServerToken, "Codex app-server base token"),
    pluginRuntimeRevisionId(),
    requireNonEmptyString(startupId, "Plugin runtime startup ID"),
  );
}

function pluginDiagnostic(pluginId, code) {
  requireNonEmptyString(pluginId, "Plugin diagnostic plugin ID");
  if (!PLUGIN_DIAGNOSTIC_CODES.has(code)) {
    throw new Error("Plugin diagnostic code is invalid.");
  }
  return { pluginId, code };
}

function isPluginDiagnostic(value) {
  return (
    isPlainObject(value) &&
    typeof value.pluginId === "string" &&
    value.pluginId.length > 0 &&
    PLUGIN_DIAGNOSTIC_CODES.has(value.code)
  );
}

function isPluginTerminalDiagnosticError(error) {
  return error instanceof PluginTerminalDiagnosticError && isPluginDiagnostic(error.diagnostic);
}

function readOpenClawConfig() {
  return JSON.parse(pluginReadFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
}

function writableOpenClawConfigPath() {
  if (typeof process.env.OPENCLAW_STATE_DIR === "string" && process.env.OPENCLAW_STATE_DIR.length > 0) {
    return safeRuntimePath(process.env.OPENCLAW_STATE_DIR, "openclaw.json");
  }
  return safeRuntimePath(requireNonEmptyString(process.env.HOME, "OpenClaw runtime home"), ".openclaw/openclaw.json");
}

function writeOpenClawConfig(config) {
  const target = writableOpenClawConfigPath();
  pluginMkdirSync(pluginDirname(target), { recursive: true });
  pluginWriteFileSync(target, JSON.stringify(config), { mode: 0o600 });
  process.env.OPENCLAW_CONFIG_PATH = target;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }
  return value;
}

function mergeConfig(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return cloneJson(overlay);
  const next = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    next[key] = key in next ? mergeConfig(next[key], value) : cloneJson(value);
  }
  return next;
}

function objectAtPath(root, path) {
  let current = root;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return isPlainObject(current) ? current : undefined;
}

function isManagedOpenClawPluginEntry(value) {
  return (
    isPlainObject(value) &&
    typeof value.enabled === "boolean" &&
    Object.keys(value).length === 1
  );
}

function conflictingApproverList(configured, managedList) {
  return isPlainObject(configured) && Object.hasOwn(configured, "approvers") &&
    managedList !== undefined &&
    (!Array.isArray(configured.approvers) ||
      !pluginDeepEqual(
        configured.approvers.map((id) => typeof id === "string" ? id.toLowerCase() : id).sort(),
        managedList.map((id) => id.toLowerCase()).sort(),
      ));
}

function assertNoOpenClawPluginConfigConflict(base, overlay, options = {}) {
  const managedApprovers = objectAtPath(overlay, ["approvals", "plugin", "slack"]);
  const configuredApprovers = objectAtPath(base, ["approvals", "plugin", "slack"]);
  if (managedApprovers !== undefined && configuredApprovers !== undefined) {
    // A native child list must not bypass an inherited Agent or plugin approver list.
    const managedDefault = managedApprovers.approvers;
    const configuredPlugins = isPlainObject(configuredApprovers.plugins)
      ? Object.entries(configuredApprovers.plugins)
      : [];
    const conflictingPlugin = configuredPlugins.some(([pluginId, configuredPlugin]) => {
      const managedPlugin = isPlainObject(managedApprovers.plugins)
        ? managedApprovers.plugins[pluginId]
        : undefined;
      const pluginList = managedPlugin?.approvers ?? managedDefault;
      if (conflictingApproverList(configuredPlugin, pluginList)) return true;
      const configuredTools = isPlainObject(configuredPlugin?.tools)
        ? Object.entries(configuredPlugin.tools)
        : [];
      return configuredTools.some(([toolId, configuredTool]) => {
        const managedTool = isPlainObject(managedPlugin?.tools)
          ? managedPlugin.tools[toolId]
          : undefined;
        return conflictingApproverList(configuredTool, managedTool?.approvers ?? pluginList);
      });
    });
    if (conflictingApproverList(configuredApprovers, managedDefault) || conflictingPlugin) {
      throw new Error("OpenClaw plugin approval configuration conflicts with managed Agent approvers.");
    }
  }
  const baseEntries = objectAtPath(base, ["plugins", "entries"]);
  const overlayEntries = objectAtPath(overlay, ["plugins", "entries"]);
  if (overlayEntries === undefined) return;
  const policyIds = (value) => Array.isArray(value)
    ? value.map((id) => id.trim().toLowerCase()).filter(Boolean)
    : [];
  const allow = policyIds(base?.plugins?.allow);
  const deny = policyIds(base?.plugins?.deny);
  for (const pluginId of Object.keys(overlayEntries)) {
    if (overlayEntries[pluginId].enabled === true) {
      let conflict;
      if (base?.plugins?.enabled === false) conflict = "plugins.enabled is false";
      else if (deny.includes(pluginId)) conflict = "plugins.deny includes the plugin";
      else if (allow.length > 0 && !allow.includes(pluginId)) conflict = "plugins.allow excludes the plugin";
      if (conflict !== undefined) {
        throw new Error("OpenClaw plugin configuration conflicts with managed plugin selection " + pluginId + ": " + conflict + ". Update Configuration or the Agent plugin selection.");
      }
    }
    if (pluginId === "codex") continue;
    if (
      baseEntries?.[pluginId] !== undefined &&
      JSON.stringify(baseEntries[pluginId]) !== JSON.stringify(overlayEntries[pluginId])
    ) {
      if (
        options.allowManagedOpenClawPluginReplacement === true &&
        isManagedOpenClawPluginEntry(baseEntries[pluginId]) &&
        isManagedOpenClawPluginEntry(overlayEntries[pluginId])
      ) {
        continue;
      }
      throw new Error("OpenClaw plugin configuration conflicts with managed plugin selections.");
    }
  }
  const overlayBridge = objectAtPath(overlay, ["plugins", "entries", "codex", "config", "codexPlugins"]);
  if (overlayBridge === undefined) return;
  const baseBridge = objectAtPath(base, ["plugins", "entries", "codex", "config", "codexPlugins"]);
  if (baseBridge === undefined) return;
  if (JSON.stringify(baseBridge) !== JSON.stringify(overlayBridge)) {
    throw new Error("OpenClaw Codex bridge configuration conflicts with managed Codex plugin selections.");
  }
}

function mergeOpenClawPluginConfiguration(base, overlay, options = {}) {
  assertNoOpenClawPluginConfigConflict(base, overlay, options);
  const next = mergeConfig(base, overlay);
  for (const key of ["allow", "alsoAllow", "deny"]) {
    const baseAllow = Array.isArray(base?.tools?.[key]) ? base.tools[key] : [];
    const overlayAllow = Array.isArray(overlay?.tools?.[key]) ? overlay.tools[key] : [];
    if (overlayAllow.length === 0) continue;
    next.tools[key] = [
      ...baseAllow,
      ...overlayAllow.filter((tool) => !baseAllow.includes(tool)),
    ];
  }
  const overlayEntries = objectAtPath(overlay, ["plugins", "entries"]);
  if (overlayEntries !== undefined) {
    const disabledManagedTools = Object.entries(overlayEntries)
      .filter(([pluginId, entry]) => pluginId !== "codex" && isManagedOpenClawPluginEntry(entry) && entry.enabled === false)
      .map(([pluginId]) => pluginId);
    if (disabledManagedTools.length > 0 && Array.isArray(next.tools?.alsoAllow)) {
      next.tools.alsoAllow = next.tools.alsoAllow.filter((tool) => !disabledManagedTools.includes(tool));
    }
  }
  return next;
}

function pluginFailureIds(failures) {
  return new Set((failures ?? []).map((failure) => failure.pluginId));
}

function hasEnabledPluginSelections(runtime) {
  return Object.values(runtime?.manifest?.selections ?? {}).some((selection) => selection?.enabled === true);
}

function readPluginFailuresFromEnvironment() {
  const encoded = process.env.OPENCLAW_PLUGIN_FAILURES_JSON;
  if (encoded === undefined || encoded.length === 0) return [];
  const parsed = JSON.parse(encoded);
  if (!Array.isArray(parsed)) throw new Error("Plugin failure set is invalid.");
  return parsed.map((failure) => pluginDiagnostic(failure.pluginId, failure.code));
}

async function readPeerPluginRuntimeStatus() {
  let url;
  const remote = process.env.OPENCLAW_PEER_PLUGIN_STATUS_URL;
  if (remote !== undefined) {
    url = new URL(remote);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Peer plugin status requires a verified HTTPS endpoint.");
    }
  } else {
    if (typeof process.env.APP_SERVER_URL !== "string" || !process.env.APP_SERVER_URL.startsWith("ws://")) return undefined;
    url = new URL(process.env.APP_SERVER_URL.replace(/^ws:/, "http:"));
    url.port = String(pluginRuntimeStatusPort() ?? "");
    url.pathname = PLUGIN_STATUS_PATH;
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(CODEX_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS),
    redirect: "error",
    ...(remote === undefined ? {} : { headers: { authorization: remotePluginStatusAuthorization() } }),
  });
  if (response.status !== 200) throw new Error("Peer plugin runtime status is unavailable.");
  const status = await response.json();
  if (
    !isPlainObject(status) ||
    status.revisionId !== pluginRuntimeRevisionId() ||
    status.container !== "agent" ||
    typeof status.startupId !== "string" ||
    status.startupId.length === 0 ||
    typeof status.podUid !== "string" ||
    status.podUid.length === 0 ||
    status.phase !== "ready" ||
    !Array.isArray(status.successfulPluginIds) ||
    status.successfulPluginIds.some((pluginId) => typeof pluginId !== "string" || pluginId.length === 0) ||
    !Array.isArray(status.failures)
  ) {
    throw new Error("Peer plugin runtime status is not ready.");
  }
  if (!status.failures.every(isPluginDiagnostic)) {
    throw new Error("Peer plugin runtime status returned invalid diagnostics.");
  }
  const failures = status.failures.map((failure) => pluginDiagnostic(failure.pluginId, failure.code));
  const successfulPluginIds = [...new Set(status.successfulPluginIds)];
  if (successfulPluginIds.some((pluginId) => failures.some((failure) => failure.pluginId === pluginId))) {
    throw new Error("Peer plugin runtime status is inconsistent.");
  }
  return {
    revisionId: status.revisionId,
    container: status.container,
    startupId: status.startupId,
    podUid: status.podUid,
    phase: status.phase,
    successfulPluginIds,
    failures,
  };
}

async function waitForPeerPluginRuntimeStatus() {
  const deadline = Date.now() + CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const status = await readPeerPluginRuntimeStatus();
      if (status !== undefined) return status;
    } catch (error) {
      lastError = error;
      await pluginRuntimeDelay(250);
    }
  }
  throw new Error("Peer plugin runtime status did not reach readiness: " + pluginRuntimeErrorMessage(lastError));
}

function samePluginFailures(left, right) {
  return JSON.stringify([...(left ?? [])].sort((a, b) => a.pluginId.localeCompare(b.pluginId))) ===
    JSON.stringify([...(right ?? [])].sort((a, b) => a.pluginId.localeCompare(b.pluginId)));
}

function openClawPluginConfiguration(runtime, failures = []) {
  if (runtime.manifest?.kind === "openclaw") {
    return pluginRuntimeTranslator.openClawRuntimeArtifact(runtime.manifest.selections ?? {}, failures, runtime.manifest.pluginApprovers).configuration;
  }
  if (runtime.manifest?.kind === "codex") {
    return pluginRuntimeTranslator.codexOpenClawConfiguration(
      runtime.manifest.selections ?? {},
      failures,
      runtime.manifest.repositoryBrokerNetworkPolicy,
      runtime.manifest.pluginApprovers,
    );
  }
  return undefined;
}

function applyOpenClawPluginConfiguration(runtime, failures = [], options = {}) {
  const overlay = openClawPluginConfiguration(runtime, failures);
  if (overlay === undefined) return;
  const base = readOpenClawConfig();
  // Native allow and alsoAllow are mutually exclusive. Keep grants in the
  // configured policy form so both application and verification use that form.
  if (base?.tools?.allow?.length > 0 && Array.isArray(overlay?.tools?.alsoAllow)) {
    overlay.tools.allow = overlay.tools.alsoAllow;
    delete overlay.tools.alsoAllow;
  }
  writeOpenClawConfig(mergeOpenClawPluginConfiguration(base, overlay, options));
  return overlay;
}

function assertConfigContainsOverlay(base, overlay, path) {
  if (isPlainObject(overlay)) {
    if (!isPlainObject(base)) throw new Error("OpenClaw plugin effective config is missing an object.");
    for (const [key, value] of Object.entries(overlay)) {
      assertConfigContainsOverlay(base[key], value, path === undefined ? key : path + "." + key);
    }
    return;
  }
  if (["tools.allow", "tools.alsoAllow", "tools.deny"].includes(path) && Array.isArray(base) && Array.isArray(overlay)) {
    for (const tool of overlay) {
      if (!base.includes(tool)) {
        throw new Error("OpenClaw plugin effective config does not match admitted configuration.");
      }
    }
    return;
  }
  if (JSON.stringify(base) !== JSON.stringify(overlay)) {
    throw new Error("OpenClaw plugin effective config does not match admitted configuration.");
  }
}

function assertCodexPluginRuntime(runtime) {
  if (runtime.manifest?.kind !== "codex") {
    throw new Error("Codex plugin runtime artifact kind mismatch.");
  }
  if (!isPlainObject(runtime.manifest.selections ?? {})) {
    throw new Error("Codex plugin selections are invalid.");
  }
}

function requireNonEmptyString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(description + " is missing.");
  }
  return value;
}

function openClawPluginPackageSpec(plugin) {
  const packageName = requireNonEmptyString(plugin.packageName, "OpenClaw plugin package name");
  const version = requireNonEmptyString(plugin.version, "OpenClaw plugin version");
  return packageName + "@" + version;
}

function runOpenClaw(args, description, diagnostic) {
  const result = pluginSpawnSync("node", ["/app/openclaw.mjs", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || typeof result.status !== "number") {
    throw new Error(description + " failed.");
  }
  if (result.status !== 0 && diagnostic !== undefined) {
    throw new PluginTerminalDiagnosticError(diagnostic, description + " failed.");
  }
  if (result.status !== 0) {
    throw new Error(description + " failed.");
  }
  return result.stdout;
}

function runOpenClawJson(args, description) {
  const stdout = runOpenClaw(args, description);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(description + " returned invalid JSON.");
  }
}

function installRecordIntegrity(record) {
  return record?.integrity ?? record?.npmIntegrity ?? record?.acceptedSurfaceIntegrity;
}

function assertPathInside(parent, child, description) {
  const root = pluginResolve(parent);
  const candidate = pluginResolve(child);
  if (candidate !== root && !candidate.startsWith(root + "/")) {
    throw new Error(description + " does not resolve inside the admitted install path.");
  }
}

function verifyOpenClawPluginInstall(plugin) {
  const nativeId = requireNonEmptyString(plugin.nativeId, "OpenClaw plugin native ID");
  const packageName = requireNonEmptyString(plugin.packageName, "OpenClaw plugin package name");
  const version = requireNonEmptyString(plugin.version, "OpenClaw plugin version");
  const report = runOpenClawJson(["plugins", "inspect", nativeId, "--json"], "OpenClaw plugin inspect");
  if (report?.plugin?.id !== nativeId) {
    throw new Error("OpenClaw plugin installed identity does not match the admitted release.");
  }
  if (report.plugin.version !== version) {
    throw new Error("OpenClaw plugin runtime version does not match the admitted release.");
  }
  const record = report.install;
  if (record?.source !== "npm") {
    throw new Error("OpenClaw plugin install record source does not match the admitted release.");
  }
  if (record.resolvedName !== packageName) {
    throw new Error("OpenClaw plugin installed package does not match the admitted release.");
  }
  if ((record.resolvedVersion ?? record.version) !== version) {
    throw new Error("OpenClaw plugin installed version does not match the admitted release.");
  }
  if (plugin.integrity !== undefined && installRecordIntegrity(record) !== plugin.integrity) {
    throw new Error("OpenClaw plugin installed integrity does not match the admitted release.");
  }
  const installPath = requireNonEmptyString(record.installPath, "OpenClaw plugin install path");
  const rootDir = requireNonEmptyString(report.plugin.rootDir, "OpenClaw plugin runtime root directory");
  assertPathInside(installPath, rootDir, "OpenClaw plugin runtime root directory");
  if (typeof report.plugin.source === "string" && report.plugin.source.startsWith("/")) {
    assertPathInside(installPath, report.plugin.source, "OpenClaw plugin runtime source");
  }
}

function installOpenClawPlugins(runtime, failures = []) {
  const artifact =
    runtime.manifest?.kind === "openclaw"
      ? pluginRuntimeTranslator.openClawRuntimeArtifact(runtime.manifest.selections ?? {}, failures, runtime.manifest.pluginApprovers)
      : { installs: [] };
  const installs = artifact.installs ?? [];
  const failed = [...failures];
  const successfulPluginIds = [];
  const failedIds = pluginFailureIds(failed);
  const originalTools = readOpenClawConfig().tools;
  applyOpenClawPluginConfiguration(runtime, failed);
  for (const plugin of installs) {
    if (failedIds.has(plugin.pluginId)) continue;
    const spec = openClawPluginPackageSpec(plugin);
    try {
      runOpenClaw(
        ["plugins", "install", spec, "--pin", "--force", "--no-enable"],
        "OpenClaw plugin install",
        pluginDiagnostic(plugin.pluginId, "PLUGIN_INSTALL_FAILED"),
      );
      successfulPluginIds.push(plugin.pluginId);
    } catch (error) {
      if (isPluginTerminalDiagnosticError(error)) {
        if (!pluginBestEffortEnabled()) throw error;
        failed.push(error.diagnostic);
        failedIds.add(error.diagnostic.pluginId);
        continue;
      }
      throw error;
    }
  }
  if (successfulPluginIds.length > 0) {
    runOpenClawJson(["plugins", "registry", "--refresh", "--json"], "OpenClaw plugin registry refresh");
  }
  // Rebuild grants from the operator's policy so failed installs cannot leave
  // generated allow entries behind or erase an original restrictive allowlist.
  const installedConfig = readOpenClawConfig();
  installedConfig.tools = originalTools;
  writeOpenClawConfig(installedConfig);
  const overlay = applyOpenClawPluginConfiguration(runtime, failed, { allowManagedOpenClawPluginReplacement: true });
  if (overlay !== undefined) {
    assertConfigContainsOverlay(readOpenClawConfig(), overlay);
  }
  for (const plugin of installs) {
    if (failedIds.has(plugin.pluginId)) continue;
    verifyOpenClawPluginInstall(plugin);
  }
  return { successfulPluginIds, failures: failed };
}

function pluginRuntimeDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pluginRuntimeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function codexAppServerUrl() {
  return "ws://127.0.0.1:" + requireNonEmptyString(process.env.APP_SERVER_PORT, "Codex app-server port");
}

function codexAppServerHeaders() {
  return { Authorization: "Bearer " + requireNonEmptyString(process.env.APP_SERVER_TOKEN, "Codex app-server token") };
}

function createPluginWebSocket(url, options) {
  try {
    const WebSocketConstructor = require("ws");
    return new WebSocketConstructor(url, options);
  } catch {
    throw new Error("Codex app-server plugin runtime WebSocket client is unavailable.");
  }
}

function isJsonRpcError(value) {
  return (
    isPlainObject(value) &&
    Number.isInteger(value.code) &&
    typeof value.message === "string"
  );
}

function isAppSummary(value) {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    (value.needsAuth === undefined || typeof value.needsAuth === "boolean") &&
    (value.category === undefined || value.category === null || typeof value.category === "string") &&
    (value.description === undefined ||
      value.description === null ||
      typeof value.description === "string") &&
    (value.installUrl === undefined ||
      value.installUrl === null ||
      typeof value.installUrl === "string")
  );
}

function codexAppServerRequestSequence(requests, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createPluginWebSocket(codexAppServerUrl(), { headers: codexAppServerHeaders() });
    const results = [];
    let requestIndex = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      const method = requests[requestIndex]?.method ?? "unknown";
      finish(new Error("Codex app-server plugin runtime request timed out during " + method + "."));
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    }

    function sendNext() {
      const request = requests[requestIndex];
      socket.send(JSON.stringify({ id: requestIndex + 1, method: request.method, params: request.params }));
    }

    function sendInitialized() {
      socket.send(JSON.stringify({ method: "initialized", params: {} }));
    }

    socket.on("open", sendNext);
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        finish(new Error("Codex app-server plugin runtime response was invalid JSON."));
        return;
      }
      if (!isPlainObject(message)) {
        finish(new Error("Codex app-server plugin runtime response was malformed."));
        return;
      }
      if (message.id !== requestIndex + 1) return;
      // Codex 0.156.0's app-server protocol uses id plus exactly one of
      // result or error; its pinned schema omits a jsonrpc response field.
      const hasResult = hasOwn(message, "result");
      const hasError = hasOwn(message, "error");
      if (hasResult === hasError) {
        finish(new Error("Codex app-server plugin runtime response was malformed."));
        return;
      }
      if (hasError) {
        const method = requests[requestIndex]?.method ?? "unknown";
        if (!isJsonRpcError(message.error)) {
          finish(new Error("Codex app-server plugin runtime response was malformed."));
          return;
        }
        finish(new CodexAppServerRequestError(method, "Codex app-server plugin runtime request failed during " + method + ": " + (message.error.message ?? "unknown error")));
        return;
      }
      results.push(message.result);
      if (requests[requestIndex]?.method === "initialize") sendInitialized();
      requestIndex += 1;
      if (requestIndex >= requests.length) {
        finish(undefined, results);
      } else {
        sendNext();
      }
    });
    socket.on("error", () => {
      finish(new Error("Codex app-server plugin runtime transport failed."));
    });
    socket.on("close", () => {
      if (!settled) finish(new Error("Codex app-server plugin runtime transport closed."));
    });
  });
}

async function codexAppServerRequest(method, params) {
  const responses = await codexAppServerRequestSequence(
    [
      {
        method: "initialize",
        params: {
          clientInfo: {
            name: "openclaw-enterprise-plugin-runtime",
            title: "OpenClaw Enterprise Plugin Runtime",
            version: "1.0.0",
          },
          capabilities: { experimentalApi: true },
        },
      },
      { method, params },
    ],
    CODEX_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS,
  );
  return responses[1];
}

function codexConfigPathSegment(segment) {
  requireNonEmptyString(segment, "Codex config path segment");
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

function codexAppConfigEdits(configuration) {
  const features = isPlainObject(configuration.features) ? configuration.features : {};
  const apps = isPlainObject(configuration.apps) ? configuration.apps : {};
  const edits = [
    { keyPath: "features.apps", mergeStrategy: "replace", value: features.apps === true },
    { keyPath: "features.plugins", mergeStrategy: "replace", value: features.plugins === true },
    {
      keyPath: "features.remote_plugin",
      mergeStrategy: "replace",
      value: features.remote_plugin === true,
    },
    {
      keyPath: 'apps."_default"',
      mergeStrategy: "replace",
      value: isPlainObject(apps._default) ? apps._default : { enabled: false },
    },
  ];
  for (const [appId, config] of Object.entries(apps)) {
    if (appId === "_default") continue;
    edits.push({
      keyPath: "apps." + codexConfigPathSegment(appId),
      mergeStrategy: "replace",
      value: config,
    });
  }
  return edits;
}

async function writeCodexAppConfiguration(configuration) {
  await codexAppServerRequest("config/batchWrite", {
    edits: codexAppConfigEdits(configuration),
    reloadUserConfig: true,
  });
}

async function readCodexAppConfiguration() {
  // Match the dedicated Harness workspace; a thread-agnostic read omits its
  // trusted .codex layers and can validate a different policy than the Agent uses.
  const response = await codexAppServerRequest("config/read", { cwd: "/home/node/workspace" });
  return response?.config;
}

function verifyCodexAppConfiguration(configuration, effective) {
  assertConfigContainsOverlay(effective, configuration);
  for (const [appId, actual] of Object.entries(effective.apps ?? {})) {
    const app = configuration.apps?.[appId];
    if (app === undefined) {
      // An explicit app entry overrides _default.enabled. Unselected disabled
      // entries are harmless; never admit an enabled app outside the selection.
      if (actual.enabled !== false) {
        throw new Error("Codex effective app policy conflicts with the selected apps; remove the unselected enabled app.");
      }
      continue;
    }
    // Failed-only bindings are disabled by the required-field check above.
    // Their inherited defaults and tool exceptions cannot enable a disabled app.
    if (appId !== "_default" && app.enabled === false) continue;
    for (const [field, value] of Object.entries(actual)) {
      if (field === "tools" || field === "links" || value == null) continue;
      if (field === "approvals_reviewer" && app.approvals_reviewer === undefined) continue;
      // Codex serializes global category defaults as true, optional fields as
      // null, and an empty exposure list imposes no additional restriction.
      if (field === "omit_tools_from" && Array.isArray(value) && value.length === 0 && app[field] === undefined) continue;
      // Category values inherit; resolve OCE's intended defaults, not the native
      // values being checked. Explicit tool enablement still requires an exact match.
      const expected = ["destructive_enabled", "open_world_enabled"].includes(field)
        ? app[field] ?? configuration.apps?._default?.[field] ?? true
        : app[field];
      if (JSON.stringify(value) !== JSON.stringify(expected)) {
        throw new Error("Codex effective app policy conflicts at apps." + appId + "." + field + "; remove the native override or update the Agent policy.");
      }
    }
    if (appId === "_default") continue;
    // Native tables merge across layers; replacing the user app table does not
    // remove inherited tool exceptions. Null fields mean inheritance, not overrides.
    for (const [toolName, tool] of Object.entries(actual?.tools ?? {})) {
      for (const [field, defaultField] of [
        ["enabled", "default_tools_enabled"],
        ["approval_mode", "default_tools_approval_mode"],
      ]) {
        const expected = app.tools?.[toolName]?.[field] ?? app[defaultField];
        if (tool[field] != null && tool[field] !== expected) {
          throw new Error("Codex effective tool policy conflicts with the admitted " + field + "; remove the native tool override or update the Agent policy.");
        }
      }
    }
    for (const link of Object.values(actual?.links ?? {})) {
      if (link.default_tools_approval_mode != null &&
          link.default_tools_approval_mode !== app.default_tools_approval_mode) {
        throw new Error("Codex effective account policy conflicts with the admitted approval default; remove the native account override or update the Agent policy.");
      }
    }
  }
}

async function verifyCodexReviewerConfiguration(configuration, effective) {
  const requestedApps = Object.entries(configuration.apps ?? {})
    .filter(([, app]) => app.approvals_reviewer !== undefined);
  if (requestedApps.length === 0) return;
  const response = await codexAppServerRequest("configRequirements/read", {});
  if (!isPlainObject(response) ||
      (response.requirements !== null && !isPlainObject(response.requirements))) {
    throw new Error("Codex reviewer requirements are unavailable; use a runtime supporting configRequirements/read.");
  }
  const requirements = response.requirements ?? {};
  const allowed = requirements.allowedApprovalsReviewers;
  const requiredModels = requirements.autoReview?.requiredOnModels ?? [];
  if ((allowed != null && (!Array.isArray(allowed) || allowed.some((value) => !["user", "auto_review"].includes(value)))) ||
      !Array.isArray(requiredModels) || requiredModels.some((value) => typeof value !== "string")) {
    throw new Error("Codex reviewer requirements are invalid; verify the runtime's managed requirements.");
  }
  for (const [appId, app] of requestedApps) {
    const reviewer = app.approvals_reviewer;
    const actual = effective?.apps?.[appId];
    if (actual?.approvals_reviewer !== reviewer ||
        Object.values(actual?.links ?? {}).some((link) => link?.approvals_reviewer != null && link.approvals_reviewer !== reviewer)) {
      throw new Error("Codex effective app or account reviewer conflicts with toolDefaults.reviewer; remove the conflicting override.");
    }
    if (allowed != null && !allowed.includes(reviewer)) {
      throw new Error("Codex managed requirements forbid the requested reviewer; choose an allowed reviewer or omit the override.");
    }
    if (reviewer === "auto_review") {
      const approval = effective?.approval_policy;
      if (approval !== "on-request" && !(isPlainObject(approval) && isPlainObject(approval.granular))) {
        throw new Error("Codex automatic reviewer requires session approval on-request or granular; verify a compatible effective policy before enabling it.");
      }
    } else if (requiredModels.length > 0) {
      const model = effective?.model;
      // Native required-model matching strips one valid provider prefix.
      const slug = typeof model === "string" ? model.replace(/^[A-Za-z0-9_-]+\/([^/]*)$/, "$1") : undefined;
      if (slug === undefined || requiredModels.includes(slug)) {
        throw new Error("Codex managed model requirements prevent verifying the human reviewer; choose auto or a permitted model.");
      }
    }
  }
  // TODO: establish compatible start/resume and turn routing before claiming
  // enforcement; these checks verify startup configuration, not future turns.
}

function codexPluginSlug(plugin) {
  const registry = requireNonEmptyString(plugin.registry, "Codex plugin registry");
  const nativeId = requireNonEmptyString(plugin.nativeId, "Codex plugin native ID");
  const suffix = "@" + registry;
  return nativeId.endsWith(suffix) ? nativeId.slice(0, -suffix.length) : nativeId;
}

function codexSummaryMatchesInstall(summary, plugin) {
  const slug = codexPluginSlug(plugin);
  return summary?.id === plugin.nativeId || summary?.id === slug || summary?.name === slug;
}

function verifyCodexPluginDetail(plugin, readParams, detail) {
  const summary = detail?.plugin?.summary;
  if (summary?.installed !== true || summary?.enabled !== true) {
    throw new Error("Codex plugin was not installed and enabled before runtime readiness.");
  }
  if (detail.plugin.marketplaceName !== undefined && detail.plugin.marketplaceName !== plugin.registry) {
    throw new Error("Codex plugin installed marketplace does not match the admitted release.");
  }
  if (!codexSummaryMatchesInstall(summary, plugin) && summary.remotePluginId !== readParams.pluginName) {
    throw new Error("Codex plugin installed identity does not match the admitted release.");
  }
}

function enabledCodexSelectionIds(selections) {
  return new Set(
    Object.entries(selections ?? {})
      .filter(([, selection]) => isPlainObject(selection) && selection.enabled === true)
      .map(([pluginId]) => pluginId),
  );
}

async function readCodexToolStatuses() {
  const statuses = [];
  const cursors = new Set();
  let cursor;
  // Bound startup discovery even if a server keeps returning fresh cursors.
  for (let page = 0; page < 100; page += 1) {
    const response = await codexAppServerRequest("mcpServerStatus/list", {
      detail: "toolsAndAuthOnly",
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (
      !isPlainObject(response) || !Array.isArray(response.data) ||
      (response.nextCursor !== null &&
        (typeof response.nextCursor !== "string" || response.nextCursor.trim().length === 0))
    ) {
      throw new Error("Codex tool discovery returned invalid pagination data.");
    }
    statuses.push(...response.data);
    if (response.nextCursor === null) return statuses;
    if (cursors.has(response.nextCursor)) {
      throw new Error("Codex tool discovery returned a repeated cursor.");
    }
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error("Codex tool discovery exceeded its page limit.");
}

async function installCodexSelectionSet(selections, failures = []) {
  if (Object.keys(selections).length === 0) return { successfulPluginIds: [], failures: [] };
  const enabledPluginIds = enabledCodexSelectionIds(selections);
  const listed = await codexAppServerRequest("plugin/list", {});
  const readParamsList = pluginRuntimeTranslator.codexReadParamsForSelections(selections, listed);
  if (readParamsList.length === 0) return { successfulPluginIds: [], failures: [] };
  const resolvedDetails = [];
  for (const readParams of readParamsList) {
    resolvedDetails.push(await codexAppServerRequest("plugin/read", readParams));
  }
  const failed = [...failures];
  const failedIds = pluginFailureIds(failed);
  const successfulPluginIds = [];
  const installs = pluginRuntimeTranslator.codexInstallPlan(selections, resolvedDetails);
  for (const readParams of readParamsList) {
    const selectedPlugin = installs.find(
      (candidate) => candidate.remotePluginId === readParams.pluginName,
    );
    if (selectedPlugin !== undefined && !enabledPluginIds.has(selectedPlugin.pluginId)) continue;
    if (selectedPlugin !== undefined && failedIds.has(selectedPlugin.pluginId)) continue;
    let install;
    try {
      install = await codexAppServerRequest("plugin/install", readParams);
    } catch (error) {
      if (
        error instanceof CodexAppServerRequestError &&
        error.method === "plugin/install" &&
        selectedPlugin !== undefined
      ) {
        if (!pluginBestEffortEnabled()) {
          throw new PluginTerminalDiagnosticError(
            pluginDiagnostic(selectedPlugin.pluginId, "PLUGIN_INSTALL_FAILED"),
            "Codex plugin installation failed.",
          );
        }
        const diagnostic = pluginDiagnostic(selectedPlugin.pluginId, "PLUGIN_INSTALL_FAILED");
        failed.push(diagnostic);
        failedIds.add(diagnostic.pluginId);
        continue;
      }
      throw error;
    }
    if (!isPlainObject(install)) {
      throw new Error("Codex plugin installation returned invalid data.");
    }
    if (install.authPolicy !== "ON_INSTALL" && install.authPolicy !== "ON_USE") {
      throw new Error("Codex plugin installation returned invalid authentication data.");
    }
    const appsNeedingAuth = install.appsNeedingAuth;
    if (appsNeedingAuth !== undefined && !Array.isArray(appsNeedingAuth)) {
      throw new Error("Codex plugin installation returned invalid authentication data.");
    }
    if ((appsNeedingAuth ?? []).some((app) => !isAppSummary(app))) {
      throw new Error("Codex plugin installation returned invalid authentication data.");
    }
    if ((appsNeedingAuth ?? []).length > 0) {
      if (selectedPlugin !== undefined) {
        if (!pluginBestEffortEnabled()) {
          throw new PluginTerminalDiagnosticError(
            pluginDiagnostic(selectedPlugin.pluginId, "PLUGIN_AUTH_REQUIRED"),
            "Codex plugin installation requires connector authentication.",
          );
        }
        const diagnostic = pluginDiagnostic(selectedPlugin.pluginId, "PLUGIN_AUTH_REQUIRED");
        failed.push(diagnostic);
        failedIds.add(diagnostic.pluginId);
        continue;
      }
      throw new Error("Codex plugin installation requires connector authentication.");
    }
    if (selectedPlugin !== undefined) successfulPluginIds.push(selectedPlugin.pluginId);
  }
  const enabledSelections = Object.fromEntries(
    Object.entries(selections).filter(([pluginId]) => enabledPluginIds.has(pluginId) && !failedIds.has(pluginId)),
  );
  const toolStatuses = pluginRuntimeTranslator.codexNeedsToolInventory(enabledSelections)
    ? await readCodexToolStatuses()
    : [];
  const effectiveResolvedArtifact = pluginRuntimeTranslator.codexRuntimeArtifact(selections, resolvedDetails, failed, toolStatuses);
  await writeCodexAppConfiguration(effectiveResolvedArtifact.configuration);
  const installedDetails = [];
  for (const readParams of readParamsList) {
    const selectedPlugin = installs.find(
      (candidate) => candidate.remotePluginId === readParams.pluginName,
    );
    if (
      selectedPlugin !== undefined &&
      (failedIds.has(selectedPlugin.pluginId) || !enabledPluginIds.has(selectedPlugin.pluginId))
    ) {
      installedDetails.push(resolvedDetails[readParamsList.indexOf(readParams)]);
    } else {
      installedDetails.push(await codexAppServerRequest("plugin/read", readParams));
    }
  }
  const installedArtifact = pluginRuntimeTranslator.codexRuntimeArtifact(selections, installedDetails, failed, toolStatuses);
  if (JSON.stringify(installedArtifact.installs) !== JSON.stringify(effectiveResolvedArtifact.installs)) {
    throw new Error("Codex plugin installed release metadata does not match startup resolution.");
  }
  if (JSON.stringify(installedArtifact.configuration) !== JSON.stringify(effectiveResolvedArtifact.configuration)) {
    throw new Error("Codex plugin installed app mapping does not match startup resolution.");
  }
  for (const plugin of effectiveResolvedArtifact.installs) {
    if (failedIds.has(plugin.pluginId) || !enabledPluginIds.has(plugin.pluginId)) continue;
    const readParams = readParamsList.find((candidate) => candidate.pluginName === plugin.remotePluginId);
    if (readParams === undefined) {
      throw new Error("Codex plugin installed identity does not match the selected catalog entry.");
    }
    const detail = installedDetails[readParamsList.indexOf(readParams)];
    verifyCodexPluginDetail(plugin, readParams, detail);
  }
  // TODO: use native effective app/tool policy introspection when available.
  // Codex 0.156 config/read omits managed app requirements applied at execution;
  // this readback verifies loaded configuration, not future thread policy.
  const effectiveConfiguration = await readCodexAppConfiguration();
  await verifyCodexReviewerConfiguration(effectiveResolvedArtifact.configuration, effectiveConfiguration);
  verifyCodexAppConfiguration(effectiveResolvedArtifact.configuration, effectiveConfiguration);
  return { successfulPluginIds, failures: failed };
}

async function installCodexPlugins(runtime, failures = []) {
  assertCodexPluginRuntime(runtime);
  const selections = runtime.manifest.selections ?? {};
  const deadline = Date.now() + CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS;
  let lastError = new Error("Codex plugin installation deadline expired before the first attempt.");
  let result = { successfulPluginIds: [], failures };
  while (Date.now() < deadline) {
    try {
      result = await installCodexSelectionSet(selections, failures);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      await pluginRuntimeDelay(250);
    }
  }
  if (lastError !== undefined) {
    throw new Error("Codex plugin installation did not reach readiness: " + pluginRuntimeErrorMessage(lastError));
  }
  return result;
}
`;

const AUTH_PROBE_FAILURE_HELPER = String.raw`
function holdFailedAuthentication(check = "model-probe", code = "UNAVAILABLE") {
  publishRuntimeFailure(check, code);
  console.error("Harness model authentication probe failed.");
  // Hold unready until an explicit restart; readiness polls never submit model calls.
  setInterval(() => {}, 3600000);
}
`;

// The native probe disables tools and fallback and performs a bounded model turn.
// Its JSON status, not its process exit status alone, establishes provider acceptance.
const OPENCLAW_AUTH_PROBE_HELPERS = String.raw`
${AUTH_PROBE_FAILURE_HELPER}
function probeOpenClawAuthenticationFailureCode() {
  const fs = require("node:fs");
  const { spawnSync } = require("node:child_process");
  const directory = fs.mkdtempSync("/tmp/openclaw-auth-probe-");
  try {
    const model = process.env.OPENCLAW_HARNESS_MODEL;
    const provider = process.env.OPENCLAW_HARNESS_PROVIDER;
    const credentialEnvironment = process.env.OPENCLAW_HARNESS_CREDENTIAL_ENV;
    if (typeof provider !== "string" || typeof credentialEnvironment !== "string" ||
      typeof model !== "string" || !model.startsWith(provider + "/") ||
      !process.env[credentialEnvironment]?.trim()) return "UNAVAILABLE";
    const configuration = JSON.parse(process.env.OPENCLAW_HARNESS_PROBE_CONFIG);
    if (configuration.agents?.defaults?.model !== model) return "UNAVAILABLE";
    configuration.agents.defaults.workspace = directory + "/workspace";
    fs.mkdirSync(directory + "/workspace", { mode: 0o700 });
    const configPath = directory + "/openclaw.json";
    fs.writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
    const result = spawnSync("node", [
      "/app/openclaw.mjs", "models", "status", "--json", "--probe",
      "--probe-provider", provider, "--probe-concurrency", "1",
      "--probe-timeout", "15000", "--probe-max-tokens", "16",
    ], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        OPENCLAW_STATE_DIR: directory + "/state",
        OPENCLAW_CONFIG_PATH: configPath,
        [credentialEnvironment]: process.env[credentialEnvironment],
      },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000, killSignal: "SIGKILL", maxBuffer: 262144,
    });
    if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL") return "MODEL_PROBE_TIMEOUT";
    if (result.status !== 0 || result.error) return "MODEL_PROBE_FAILED";
    const results = JSON.parse(result.stdout).auth?.probes?.results;
    return Array.isArray(results) && results.length === 1 &&
      results[0].provider === provider && results[0].model === model &&
      results[0].source === "env" && results[0].status === "ok"
        ? undefined
        : "MODEL_PROBE_FAILED";
  } catch {
    return "MODEL_PROBE_FAILED";
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
`;

const WORKSPACE_ASSET_HELPERS = String.raw`
const { cpSync, existsSync, lstatSync, readdirSync, symlinkSync } = require("node:fs");
const runtimeAssetsDirectory = "/home/node/openclaw-runtime-assets";

function clearDirectoryContents(directory) {
  mkdirSync(directory, { recursive: true });
  for (const entry of readdirSync(directory)) {
    rmSync(join(directory, entry), { recursive: true, force: true });
  }
}

function publishImageTree(source, destination, required) {
  if (!existsSync(source)) {
    if (required) {
      throw new Error("Required runtime asset tree is missing: " + source);
    }
    clearDirectoryContents(destination);
    return;
  }
  if (!lstatSync(source).isDirectory()) {
    throw new Error("Runtime asset tree is not a directory: " + source);
  }
  if (required && readdirSync(source).length === 0) {
    throw new Error("Required runtime asset tree is empty: " + source);
  }
  mkdirSync(runtimeAssetsDirectory, { recursive: true });
  clearDirectoryContents(destination);
  cpSync(source, destination, { recursive: true });
}

function initializeRuntimeAssets() {
  publishImageTree("/app/skills", runtimeAssetsDirectory + "/bundled-skills", true);
  publishImageTree("/app/plugin-skills", runtimeAssetsDirectory + "/plugin-skills", false);
}

function publishAgentPluginSkillPath() {
  mkdirSync("/home/node/.openclaw", { recursive: true });
  rmSync("/home/node/.openclaw/plugin-skills", { recursive: true, force: true });
  symlinkSync(runtimeAssetsDirectory + "/plugin-skills", "/home/node/.openclaw/plugin-skills", "dir");
}

`;

export const GATEWAY_RUNTIME_ENTRYPOINT = String.raw`
const { mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");

// OCE upgrades this runtime by rolling out a selected image.
process.env.OPENCLAW_NO_AUTO_UPDATE = "1";

${PLUGIN_RUNTIME_HELPERS}
${WORKSPACE_ASSET_HELPERS}
${OPENCLAW_AUTH_PROBE_HELPERS}

startPluginRuntimeStatusServer();

function forwardTermination(child) {
  let terminating = false;
  const forward = (signal) => {
    if (terminating) return;
    terminating = true;
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), ${GATEWAY_STOP_TIMEOUT_MS}).unref();
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
}

const openClawAuthenticationFailureCode =
  process.env.OPENCLAW_HARNESS_PROBE_CONFIG === undefined
    ? undefined
    : probeOpenClawAuthenticationFailureCode();
if (openClawAuthenticationFailureCode !== undefined) {
  holdFailedAuthentication("model-probe", openClawAuthenticationFailureCode);
} else {
mkdirSync("/home/node/.openclaw", { recursive: true });
mkdirSync("/home/node/workspace", { recursive: true });
if (process.env.OPENCLAW_WORKSPACE_DIR !== undefined) {
  mkdirSync(process.env.OPENCLAW_WORKSPACE_DIR, { recursive: true });
  initializeRuntimeAssets();
}
delete process.env.OPENCLAW_LOG_LEVEL;
const pluginRuntime = readGatewayPluginRuntime();
(async () => {
const peerStatus =
  pluginRuntime?.manifest?.kind === "codex" && hasEnabledPluginSelections(pluginRuntime)
    ? await waitForPeerPluginRuntimeStatus()
    : undefined;
const peerFailures = peerStatus?.failures ?? readPluginFailuresFromEnvironment();
if (peerStatus !== undefined) {
  process.env.APP_SERVER_TOKEN = derivePluginAppServerToken(peerStatus.startupId);
}
const pluginResult =
  pluginRuntime === undefined
    ? { successfulPluginIds: [], failures: peerFailures }
    : installOpenClawPlugins(pluginRuntime, peerFailures);
if (peerStatus !== undefined) {
  pluginResult.successfulPluginIds = peerStatus.successfulPluginIds;
}
publishPluginRuntimeStatus({ phase: "ready", ...pluginResult });
const workspaceNodeId = process.env.OPENCLAW_WORKSPACE_NODE_ID;
if (workspaceNodeId !== undefined || process.env.APP_SERVER_URL !== undefined) {
  const config = readOpenClawConfig();
  // The first pairing records its command grant before a node ID is available.
  const commands = ((config.gateway ??= {}).nodes ??= {}).commands ??= {};
  commands.allow = [...new Set([...(commands.allow ?? []), "file.fetch", "file.stat", "file.write", "file.create", "dir.list", "workspace.memory", "workspace.skills"])];
  if (workspaceNodeId !== undefined) {
    const plugins = config.plugins ??= {};
    if (plugins.deny?.includes("file-transfer")) {
      throw new Error("The workspace node requires the file-transfer plugin.");
    }
    if (Array.isArray(plugins.allow)) {
      plugins.allow = [...new Set([...plugins.allow, "file-transfer"])];
    }
    const entries = plugins.entries ??= {};
    const transfer = entries["file-transfer"] ??= {};
    if (transfer.enabled === false) {
      throw new Error("The workspace node requires the file-transfer plugin.");
    }
    transfer.enabled = true;
    const fileConfig = transfer.config ??= {};
    // Current Kubernetes Codex layout; this is not a cross-Harness workspace root.
    const remoteRoot = "/home/node/workspace";
    // Codex stages reply artifacts while its client is live, even when both
    // hosts use the same workspace path. A shared path no longer means shared files.
    if (entries.codex) {
      const appServer = (entries.codex.config ??= {}).appServer ??= {};
      appServer.remoteWorkspaceRoot ??= remoteRoot;
    }
    // OCC edits four owner documents; native previews read the Agent workspace.
    const editable = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
    const memoryPaths = ["MEMORY.md", "memory.md", "DREAMS.md", "dreams.md", "memory", "memory/**"]
      .map((name) => remoteRoot + "/" + name);
    const skillRoots = [
      "/home/node/.openclaw/skills", "/home/node/.openclaw/plugin-skills",
      "/home/node/.agents/skills", "/home/node/openclaw-runtime-assets/bundled-skills",
      "/home/node/openclaw-runtime-assets/plugin-skills",
    ];
    const nodes = fileConfig.nodes ??= {};
    if (nodes[workspaceNodeId] === undefined && nodes["*"] === undefined) {
      nodes[workspaceNodeId] = {
        ask: "off",
        allowReadPaths: [
          remoteRoot,
          remoteRoot + "/**",
          "/home/node/.openclaw",
          ...skillRoots.flatMap((root) => [root, root + "/**"]),
        ],
        allowWritePaths: [
          ...editable.map((name) => remoteRoot + "/" + name),
          ...memoryPaths,
          remoteRoot + "/skills",
          remoteRoot + "/media/inbound/openclaw-staged-*/**",
        ],
        followSymlinks: false,
      };
    }
    fileConfig.policyVersion ??= 2;
    (fileConfig.workspaces ??= {}).main = { nodeId: workspaceNodeId, remoteRoot };
  }
  writeOpenClawConfig(config);
}
publishRuntimeReady();
const child = spawn(
  "node",
  ["/app/openclaw.mjs", "gateway", "--port", process.env.OPENCLAW_GATEWAY_PORT],
  { stdio: "inherit" },
);
forwardTermination(child);
if (pluginRuntime?.manifest?.kind === "codex" && hasEnabledPluginSelections(pluginRuntime)) {
  let pollInFlight = false;
  let stoppingForChangedPeerStatus = false;
  const stopForChangedPeerStatus = () => {
    if (stoppingForChangedPeerStatus) return;
    stoppingForChangedPeerStatus = true;
    publishPluginRuntimeStatus({ phase: "starting", ...pluginResult });
    child.kill("SIGTERM");
    setTimeout(() => process.exit(1), ${GATEWAY_STOP_TIMEOUT_MS}).unref();
  };
  setInterval(async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const current = await readPeerPluginRuntimeStatus();
      if (current === undefined || peerStatus === undefined) {
        stopForChangedPeerStatus();
      } else if (
        current.startupId !== peerStatus.startupId ||
        current.podUid !== peerStatus.podUid ||
        !samePluginFailures(current.failures, pluginResult.failures)
      ) {
        stopForChangedPeerStatus();
      }
    } catch {
      stopForChangedPeerStatus();
    } finally {
      pollInFlight = false;
    }
  }, 2_000).unref();
}
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)));
})();
}
`;

export const AGENT_RUNTIME_ENTRYPOINT = String.raw`
const { createHash } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

${PLUGIN_RUNTIME_HELPERS}
${AUTH_PROBE_FAILURE_HELPER}

startPluginRuntimeStatusServer();
const loginMode = process.env.CODEX_LOGIN_MODE;
const apiKey = process.env.OPENAI_API_KEY;
const accessToken = process.env.CODEX_ACCESS_TOKEN;
const workspaceId = process.env.CODEX_CHATGPT_WORKSPACE_ID;
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
if (loginMode === "api_key") {
  if (!nonempty(apiKey) || accessToken !== undefined || workspaceId !== undefined) {
    throw new Error("Codex API-key authentication configuration is invalid.");
  }
} else if (loginMode === "codex_pat") {
  if (!nonempty(accessToken) || !accessToken.startsWith("at-") || workspaceId !== undefined || apiKey !== undefined) {
    throw new Error("Codex service account token authentication configuration is invalid.");
  }
} else if (loginMode === "chatgpt_service_account") {
  if (!nonempty(accessToken) || !nonempty(workspaceId) || apiKey !== undefined) {
    throw new Error("Codex service-account authentication configuration is invalid.");
  }
} else {
  throw new Error("Codex authentication mode is missing or unsupported.");
}

mkdirSync(process.env.CODEX_HOME, { recursive: true });
mkdirSync("/home/node/workspace", { recursive: true });
if (process.env.OPENCLAW_PLUGIN_READY_MARKER !== undefined) {
  rmSync(process.env.OPENCLAW_PLUGIN_READY_MARKER, { force: true });
}
const pluginRuntime = readPluginRuntime("codex");
if (pluginRuntime !== undefined) {
  assertCodexPluginRuntime(pluginRuntime);
  writeCodexConfigToml(pluginRuntime);
}
const loginArguments = loginMode === "api_key"
  ? ["-c", "cli_auth_credentials_store=file", "login", "--with-api-key"]
  : [
      "-c",
      "cli_auth_credentials_store=file",
      ...(loginMode === "chatgpt_service_account" ? [
        "-c", "forced_chatgpt_workspace_id=" + JSON.stringify(workspaceId),
      ] : []),
      "login",
      "--with-access-token",
    ];
let login;
for (let attempt = 0; attempt < 3; attempt++) {
  login = spawnSync("codex", loginArguments, {
    input: loginMode === "api_key" ? apiKey : accessToken,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "pipe"],
    timeout: 30000, killSignal: "SIGKILL", maxBuffer: 262144,
  });
  // Access-token login validates the same credential remotely before saving it.
  // A cold-node network timeout may recover; refusals and model calls are not retried.
  if (loginMode === "api_key" || login.error?.code !== "ETIMEDOUT") break;
}
if (login.status !== 0 || login.error) {
  holdFailedAuthentication("login", "LOGIN_FAILED");
} else {
delete process.env.CODEX_ACCESS_TOKEN;
delete process.env.OPENAI_API_KEY;
delete process.env.CODEX_CHATGPT_WORKSPACE_ID;

function probeCodexAuthenticationFailureCode() {
  const directory = mkdtempSync("/tmp/codex-auth-probe-");
  try {
    const selectedModel = process.env.OPENCLAW_HARNESS_MODEL;
    if (typeof selectedModel !== "string" || !/^(openai|codex)\/.+/.test(selectedModel)) return "UNAVAILABLE";
    // Pinned native features suppress executable and external tools. Metadata may
    // still advertise apply_patch: read-only + never denies its writes. Any tool
    // event makes this probe unsuccessful, including harmless request_user_input.
    const disabled = [
      "shell_tool", "unified_exec", "code_mode", "code_mode_host", "hooks",
      "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external",
      "browser_use_full_cdp_access", "computer_use", "in_app_browser",
      "image_generation", "view_image", "multi_agent", "multi_agent_v2",
      "sleep_tool", "goals", "workspace_dependencies", "skill_search",
      "skill_mcp_dependency_install", "tool_suggest", "recommended_plugins", "request_permissions_tool",
    ];
    const result = spawnSync("codex", [
      ...disabled.flatMap((feature) => ["--disable", feature]),
      "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--skip-git-repo-check", "--json", "--sandbox", "read-only", "--cd", directory,
      "--model", selectedModel.slice(selectedModel.indexOf("/") + 1),
      "-c", "cli_auth_credentials_store=file",
      "-c", 'web_search="disabled"',
      "-c", "project_doc_max_bytes=0",
      "-c", "check_for_update_on_startup=false",
      ...(loginMode === "chatgpt_service_account" ? [
        "-c", "forced_chatgpt_workspace_id=" + JSON.stringify(workspaceId),
      ] : []),
      "Reply only READY. Do not use tools.",
    ], {
      cwd: directory,
      // Keep the runtime's TLS trust anchors so a TLS-inspecting egress proxy can serve the probe.
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        CODEX_HOME: process.env.CODEX_HOME,
        RUST_LOG: "error",
        ...Object.fromEntries(
          ["SSL_CERT_FILE", "SSL_CERT_DIR"]
            .filter((name) => typeof process.env[name] === "string" && process.env[name].length > 0)
            .map((name) => [name, process.env[name]]),
        ),
      },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000, killSignal: "SIGKILL", maxBuffer: 262144,
    });
    if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL") return "MODEL_PROBE_TIMEOUT";
    if (result.status !== 0 || result.error) return "MODEL_PROBE_FAILED";
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const allowed = new Set(["thread.started", "turn.started", "turn.completed", "item.started", "item.updated", "item.completed"]);
    // Native item.error is an advisory (for example missing catalog metadata),
    // distinct from fatal top-level error/turn.failed. A completed model turn is
    // still required; no tool item can satisfy this authentication check.
    if (events.some((event) => !allowed.has(event.type) ||
      (event.type.startsWith("item.") && !["agent_message", "reasoning", "error"].includes(event.item?.type)))) return "MODEL_PROBE_FAILED";
    return events.filter((event) => event.type === "turn.completed").length === 1 &&
      events.filter((event) => event.type === "turn.started").length === 1 &&
      events.at(-1)?.type === "turn.completed" &&
      events.some((event) => event.type === "item.completed" && event.item?.type === "agent_message" &&
        typeof event.item.text === "string" && event.item.text.trim().length > 0)
        ? undefined
        : "MODEL_PROBE_FAILED";
  } catch {
    return "MODEL_PROBE_FAILED";
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const codexAuthenticationFailureCode = probeCodexAuthenticationFailureCode();
if (codexAuthenticationFailureCode !== undefined) {
  holdFailedAuthentication("model-probe", codexAuthenticationFailureCode);
} else {

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

if (pluginRuntimeStatusPort() !== undefined) {
  process.env.APP_SERVER_TOKEN = derivePluginAppServerToken(pluginStatusReport.startupId);
}
publishRuntimeReady();
const digest = createHash("sha256").update(process.env.APP_SERVER_TOKEN).digest("hex");
const child = spawn(
  "codex",
  [
    "-c",
    "otel.exporter=\"none\"",
    "-c",
    "otel.log_user_prompt=false",
    // Managed container tools must retain the runtime PATH, including Skill dependencies.
    // Login profiles otherwise replace it with the image's system-only PATH.
    "-c",
    "allow_login_shell=false",
    "-c",
    "shell_environment_policy.experimental_use_profile=false",
    "-c",
    "shell_environment_policy.set.PATH=" + JSON.stringify(process.env.PATH ?? ""),
    "app-server",
    "--listen",
    "ws://0.0.0.0:" + process.env.APP_SERVER_PORT,
    "--ws-auth",
    "capability-token",
    "--ws-token-sha256",
    digest,
  ],
  { stdio: "inherit", cwd: "/home/node/workspace" },
);
forwardTermination(child);
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)));
(async () => {
  try {
    if (pluginRuntime !== undefined) {
      const result = await installCodexPlugins(pluginRuntime);
      publishPluginRuntimeStatus({ phase: "ready", ...result });
    } else {
      publishPluginRuntimeStatus({ phase: "ready", successfulPluginIds: [], failures: [] });
    }
    pluginRuntimeReady();
  } catch (error) {
    console.error("Codex plugin runtime initialization failed: " + pluginRuntimeErrorMessage(error));
    child.kill("SIGTERM");
    process.exit(1);
  }
})();
}
}
`;

// Kubernetes Codex implementation: this file-only node is not an OpenClaw
// execution worker; its explicit command allowlist disables worker hosting.
// It serves files while Codex restarts. Reuse Codex login/plugin initialization
// for each Codex start; other Harnesses need their own execution composition.
export const AGENT_WITH_NODE_ENTRYPOINT = String.raw`
const { mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
${WORKSPACE_ASSET_HELPERS}
const state = process.env.OPENCLAW_NODE_STATE_DIR;
const setupCode = process.env.OPENCLAW_NODE_SETUP_CODE;
if (!state || !setupCode) throw new Error("The workspace node is not provisioned.");
mkdirSync(state, { recursive: true });
initializeRuntimeAssets();
publishAgentPluginSkillPath();
const configPath = join(state, "openclaw.json");
writeFileSync(configPath, JSON.stringify({
  agents: { defaults: JSON.parse(process.env.OPENCLAW_WORKSPACE_BOOTSTRAP || "{}") },
  plugins: {
    allow: ["file-transfer"],
    slots: { memory: "none" },
    entries: { "file-transfer": { enabled: true } },
  },
}), { mode: 0o600 });
// Both the node file worker and Codex execute installed Skill dependencies.
const harnessPath = [process.env.PATH, "/home/node/.local/bin", "/home/node/.openclaw/tools/node/npm/bin"].filter(Boolean).join(":");
const nodeEnv = {
  HOME: process.env.HOME,
  PATH: harnessPath,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_NO_AUTO_UPDATE: "1",
};
if (process.env.OPENCLAW_NODE_CA_PEM) {
  const caPath = join(state, "gateway-ca.pem");
  writeFileSync(caPath, process.env.OPENCLAW_NODE_CA_PEM, { mode: 0o600 });
  nodeEnv.NODE_EXTRA_CA_CERTS = caPath;
}
// The workspace belongs to the Harness. Native setup creates missing defaults
// without replacing owner edits; neither child may serve an uninitialized workspace.
const baseline = spawnSync(process.execPath, [
  "/app/openclaw.mjs", "setup", "--baseline", "--workspace", "/home/node/workspace", "--json",
], { env: nodeEnv, stdio: "inherit" });
if (baseline.error) throw baseline.error;
if (baseline.status !== 0) throw new Error("Workspace initialization failed.");
const codexEnv = { ...process.env, PATH: harnessPath };
delete codexEnv.OPENCLAW_NODE_SETUP_CODE;
delete codexEnv.OPENCLAW_NODE_CA_PEM;
delete codexEnv.OPENCLAW_NODE_STATE_DIR;
delete codexEnv.OPENCLAW_WORKSPACE_BOOTSTRAP;
const processes = [
  {
    name: "workspace node",
    args: ["/app/openclaw.mjs", "node", "run", "--pair-if-needed", setupCode,
      "--commands", "file.fetch,file.stat,file.write,file.create,dir.list,workspace.memory,workspace.skills"],
    env: nodeEnv,
  },
  { name: "Codex", args: ["-e", ${JSON.stringify(AGENT_RUNTIME_ENTRYPOINT)}], env: codexEnv },
];
let stopping = false;
function killGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
function start(slot) {
  if (stopping) return;
  const child = spawn(process.execPath, slot.args, {
    env: slot.env, stdio: "inherit", detached: true,
  });
  slot.child = child;
  child.on("error", () => console.error(slot.name + " failed to start."));
  child.on("exit", () => {
    // The Codex wrapper may exit after plugin failure while its app-server is
    // still shutting down. Retire that group before starting another wrapper.
    killGroup(child, "SIGKILL");
  });
  child.on("close", () => {
    slot.child = undefined;
    if (stopping) {
      if (processes.every((entry) => !entry.child)) process.exit(0);
    } else {
      slot.timer = setTimeout(() => start(slot), 1_000);
    }
  });
}
function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const slot of processes) {
    clearTimeout(slot.timer);
    killGroup(slot.child, signal);
  }
  if (processes.every((slot) => !slot.child)) process.exit(0);
  setTimeout(() => {
    for (const slot of processes) killGroup(slot.child, "SIGKILL");
    process.exit(1);
  }, 9_000).unref();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
for (const slot of processes) start(slot);
`;

// Check native readiness over Pod loopback: kubelet's node source can also be
// the trusted apiserver proxy source, but its probes have no forwarded headers.
export const GATEWAY_READINESS_ENTRYPOINT = String.raw`
const timeout = setTimeout(() => process.exit(1), 2_000);
const http = require("node:http");
function nativeReady() {
  const request = http.get(
    "http://127.0.0.1:" + process.env.OPENCLAW_GATEWAY_PORT + "/readyz",
    (response) => {
      response.resume();
      clearTimeout(timeout);
      process.exit(response.statusCode === 200 ? 0 : 1);
    },
  );
  request.on("error", () => process.exit(1));
}
if (process.env.OPENCLAW_PLUGIN_STATUS_PORT === undefined) {
  nativeReady();
} else {
  const request = http.get(
    "http://127.0.0.1:" + process.env.OPENCLAW_PLUGIN_STATUS_PORT + "/openclaw/plugin-runtime/status",
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) process.exit(1);
      });
      response.on("end", () => {
        try {
          const status = JSON.parse(body);
          if (response.statusCode !== 200 || status.phase !== "ready") process.exit(1);
          nativeReady();
        } catch {
          process.exit(1);
        }
      });
    },
  );
  request.on("error", () => process.exit(1));
}
`;

export const AGENT_READINESS_ENTRYPOINT = String.raw`
const timeout = setTimeout(() => process.exit(1), 2_000);
const { existsSync } = require("node:fs");
const { createHmac } = require("node:crypto");
const http = require("node:http");
${PLUGIN_APP_SERVER_TOKEN_DERIVATION_HELPER}
if (
  process.env.OPENCLAW_PLUGIN_READY_MARKER !== undefined &&
  !existsSync(process.env.OPENCLAW_PLUGIN_READY_MARKER)
) {
  process.exit(1);
}
let ReadinessWebSocket;
try {
  ReadinessWebSocket = require("ws");
} catch {}
if (ReadinessWebSocket === undefined) process.exit(1);
function derivedToken(startupId) {
  try {
    return derivePluginAppServerTokenFromBase(
      process.env.APP_SERVER_TOKEN,
      process.env.OPENCLAW_AGENT_REVISION_ID,
      startupId,
    );
  } catch {
    process.exit(1);
  }
}
function checkWebSocket(token) {
  const socket = new ReadinessWebSocket("ws://127.0.0.1:" + process.env.APP_SERVER_PORT, {
    headers: { Authorization: "Bearer " + token },
  });
  const onSocket = (event, listener) => {
    if (typeof socket.addEventListener === "function") socket.addEventListener(event, listener);
    else socket.on(event, listener);
  };
  onSocket("open", () => {
    clearTimeout(timeout);
    socket.close();
    process.exit(0);
  });
  onSocket("error", () => process.exit(1));
}
if (process.env.OPENCLAW_PLUGIN_STATUS_PORT === undefined) {
  checkWebSocket(process.env.APP_SERVER_TOKEN);
} else {
  const request = http.get(
    "http://127.0.0.1:" + process.env.OPENCLAW_PLUGIN_STATUS_PORT + "/openclaw/plugin-runtime/status",
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) process.exit(1);
      });
      response.on("end", () => {
        try {
          const status = JSON.parse(body);
          if (response.statusCode !== 200 || status.phase !== "ready") process.exit(1);
          checkWebSocket(derivedToken(status.startupId));
        } catch {
          process.exit(1);
        }
      });
    },
  );
  request.on("error", () => process.exit(1));
}
`;
