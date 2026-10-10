import { PLUGIN_RUNTIME_TRANSLATOR_SOURCE } from "../../plugin/runtime-translator.ts";
import { nodeProgramArguments } from "../node-program.ts";
import { gatewayStateMigrationHelper, startupPhaseHelper } from "../runtime-startup.ts";

// Match the pinned OpenClaw service stop budget: 315s drain, 10s cleanup,
// and 5s supervisor margin. Idle Gateways exit as soon as their work settles.
export const GATEWAY_STOP_TIMEOUT_MS = 330_000;

// Every runtime wrapper runs under tini. As PID 1, Node ignores SIGTERM until
// a wrapper installs its handler, and cannot run one inside a blocking model
// probe, so a Pod stop waited for SIGKILL. Under tini the wrapper exits on
// SIGTERM in every phase, and container exit ends its children. -e 143 reports
// that termination as exit 0, as a running wrapper does. -s keeps reaping
// orphans when a Sandbox provider runs this below PID 1.
export const RUNTIME_WRAPPER_COMMAND: readonly string[] = Object.freeze([
  "/usr/bin/tini",
  "-s",
  "-e",
  "143",
  "--",
  "node",
  "-e",
]);

// Setup initContainers (workspace, private state, repository material) also run
// Node, which as PID 1 ignored SIGTERM, so a Pod deleted mid-setup waited for
// SIGKILL. Under tini Node takes the default SIGTERM action; a stopped setup
// keeps its failing exit status.
export const SETUP_WRAPPER_COMMAND: readonly string[] = Object.freeze([
  "/usr/bin/tini",
  "-s",
  "--",
  "node",
  "-e",
]);
export const MANAGED_CONFIGURATION_DIRECTORY = "/etc/openclaw-managed";
// Under the Harness HOME; Compute renders the same path into the Gateway's relay config.
export const NATIVE_HOOK_CREDENTIAL_DIRECTORY = ".oce-native-hooks";

export const PLUGIN_APP_SERVER_TOKEN_HMAC_DOMAIN = "openclaw-plugin-runtime/app-server-token/v1";
export const RUNTIME_READINESS_PATH = "/readyz";

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

const RUNTIME_READINESS_RESPONSE_HELPER = String.raw`
async function answerRuntimeReadiness(response, readiness) {
  let ready = false;
  try {
    ready = await readiness() === true;
  } catch {}
  if (response.destroyed) return;
  response.writeHead(ready ? 200 : 503, { "cache-control": "no-store" });
  response.end();
}
`;

const RUNTIME_READINESS_SERVER_HELPER = String.raw`
${RUNTIME_READINESS_RESPONSE_HELPER}
function startRuntimeReadinessServer(readiness) {
  const port = Number(process.env.OPENCLAW_RUNTIME_STATUS_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Runtime status port is invalid.");
  }
  const server = readinessCreateServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" || pathname !== ${JSON.stringify(RUNTIME_READINESS_PATH)}) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    void answerRuntimeReadiness(response, readiness);
  });
  server.listen(port, "0.0.0.0");
}
`;

export const PLUGIN_RUNTIME_HELPERS = String.raw`
const pluginRuntimeTranslator = (${PLUGIN_RUNTIME_TRANSLATOR_SOURCE})();
const {
  dirname: pluginDirname,
  resolve: pluginResolve,
} = require("node:path");
const {
  existsSync: pluginExistsSync,
  mkdirSync: pluginMkdirSync,
  mkdtempSync: pluginMkdtempSync,
  readFileSync: pluginReadFileSync,
  rmSync: pluginRmSync,
  writeFileSync: pluginWriteFileSync,
} = require("node:fs");
const { tmpdir: pluginTmpdir } = require("node:os");
const {
  createHmac,
  timingSafeEqual: pluginTimingSafeEqual,
  randomUUID: pluginRandomUUID,
} = require("node:crypto");
const { spawnSync: pluginSpawnSync } = require("node:child_process");
const { createServer: pluginCreateServer, get: pluginHttpGet } = require("node:http");
const { isDeepStrictEqual: pluginDeepEqual } = require("node:util");

const CODEX_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS = Number(process.env.OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS ?? "10000");
const CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS = Number(process.env.OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS ?? "60000");
const PLUGIN_STATUS_PATH = "/openclaw/plugin-runtime/status";
const REMOTE_PLUGIN_STATUS_PATH = "/openclaw/plugin-runtime/remote-status";
const RUNTIME_STATUS_PATH = "/openclaw/runtime/status";
const RUNTIME_DIAGNOSTICS_PATH = "/openclaw/runtime/diagnostics";
const RUNTIME_IMAGE_PATH = "/openclaw/runtime/image";
const RUNTIME_READINESS_PATH = ${JSON.stringify(RUNTIME_READINESS_PATH)};
const PLUGIN_DIAGNOSTIC_CODES = new Set(["PLUGIN_INSTALL_FAILED", "PLUGIN_AUTH_REQUIRED"]);
const RUNTIME_DIAGNOSTIC_CODES = new Set([
  "LOGIN_FAILED",
  "MODEL_PROBE_FAILED",
  "MODEL_PROBE_TIMEOUT",
  "MODEL_PROBE_CPU_STARVED",
  "UNAVAILABLE",
  "NOT_CONFIGURED",
  "AUTHENTICATION_FAILED",
  "DISCONNECTED",
  "INCOMPATIBLE_RESPONSE",
  "PROBE_FAILED",
]);
const pluginBaseAppServerToken = process.env.APP_SERVER_TOKEN;

${PLUGIN_APP_SERVER_TOKEN_DERIVATION_HELPER}
${RUNTIME_READINESS_RESPONSE_HELPER}

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
  if (runtime.manifest?.kind === "openclaw" || runtime.manifest?.kind === "codex") {
    return runtime;
  }
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
// The workspace node OpenClaw itself reports applied (its file-transfer plugin
// loaded from a config with the node), and the current reason it is not.
let runtimeWorkspaceNodeId;
let runtimeWorkspaceNodeFailure;

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

function publishRuntimeFailure(check, code, cause) {
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
    ...(cause === undefined ? {} : { cause }),
  };
}

// A provider-owned Codex Harness gets only the transport token's verifier and
// no Compute status port, and Compute cannot reach it through a Pod proxy. While
// a startup failure is held nothing else listens on the app-server port, so the
// failure is served there, through the provider's bearer-passthrough exposure,
// to a caller presenting the token the verifier names. Compute reads it and
// fails the revision with the code the status port would have reported.
function serveHeldRuntimeFailureToTransportPeer(check, code, cause) {
  const verifier = process.env.APP_TOKEN_SHA;
  const port = Number(process.env.APP_SERVER_PORT);
  if (
    runtimeStatusPort() !== undefined ||
    typeof verifier !== "string" ||
    !/^[a-f0-9]{64}$/.test(verifier) ||
    !Number.isSafeInteger(port) || port < 1 || port > 65535
  ) {
    return;
  }
  requireNonEmptyString(check, "Runtime failure check");
  if (!RUNTIME_DIAGNOSTIC_CODES.has(code)) {
    throw new Error("Runtime failure code is invalid.");
  }
  const { createHash: heldFailureHash } = require("node:crypto");
  const expected = Buffer.from(verifier, "hex");
  const body = JSON.stringify({
    runtimeFailure: {
      component: "agent",
      check,
      checkedAt: new Date().toISOString(),
      code,
      ...(cause === undefined ? {} : { cause }),
    },
  });
  const server = pluginCreateServer((request, response) => {
    const authorization = typeof request.headers.authorization === "string"
      ? /^Bearer ([!-~]+)$/i.exec(request.headers.authorization)
      : null;
    const supplied = authorization === null
      ? undefined
      : heldFailureHash("sha256").update(authorization[1]).digest();
    if (supplied === undefined || !pluginTimingSafeEqual(supplied, expected)) {
      response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" || pathname !== RUNTIME_STATUS_PATH) {
      response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(body);
  });
  // Keep holding the failure even if it cannot be served; Compute then times out.
  server.on("error", (error) => {
    console.error("Held runtime failure server failed: " + (error?.code ?? "unknown"));
  });
  server.listen(port, "0.0.0.0");
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
    ...(runtimeWorkspaceNodeId === undefined ? {} : { workspaceNodeId: runtimeWorkspaceNodeId }),
    ...(runtimeWorkspaceNodeFailure === undefined ? {} : { workspaceNodeFailure: runtimeWorkspaceNodeFailure }),
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

// Connect-error codes with which the Gateway refuses this CLI's own credentials.
// They follow from the admitted configuration (D381: no gateway.auth.password,
// so the in-Pod CLI connects with none), so every later call is refused too.
// Refusals that can clear by themselves are excluded: rate limiting, pairing,
// device identity, and a token mismatch, which OpenClaw retries with a device token.
// AUTH_UNAUTHORIZED is OpenClaw's catch-all; the one transient reason behind it
// (a failed local interface check) applies only to a non-loopback client, and
// this CLI always connects over 127.0.0.1. Re-check the set if that changes.
const GATEWAY_AUTH_REFUSAL_CODES = new Set([
  "AUTH_UNAUTHORIZED",
  "AUTH_TOKEN_MISSING",
  "AUTH_TOKEN_NOT_CONFIGURED",
  "AUTH_PASSWORD_MISSING",
  "AUTH_PASSWORD_MISMATCH",
  "AUTH_PASSWORD_NOT_CONFIGURED",
]);

// OpenClaw's internal reason for a refusal, such as trusted_proxy_untrusted_source,
// kept only when it is a plain token so it is safe to log.
function gatewayAuthRefusalReason(error) {
  const reason = error.details.authReason;
  return typeof reason === "string" && /^[a-z0-9_]{1,64}$/u.test(reason) ? reason : undefined;
}

function gatewayRefusedAuthentication(gatewayRuntime, error) {
  return (
    typeof gatewayRuntime?.isGatewayClientRequestError === "function" &&
    gatewayRuntime.isGatewayClientRequestError(error) === true &&
    error.retryable !== true &&
    isPlainObject(error.details) &&
    GATEWAY_AUTH_REFUSAL_CODES.has(error.details.code)
  );
}

// The Gateway resolves its loaded channel plugins plus manifest plugins for the channels the
// Configuration sets up, so channels.status for a channel the Agent does not use is refused
// as INVALID_REQUEST "unknown channel: <id>" (src/gateway/server-methods/channels.ts in the
// pinned OpenClaw). A configured channel whose plugin failed to load still resolves and takes
// the status path.
function gatewayRefusedUnknownChannel(gatewayRuntime, error, channel) {
  return (
    typeof channel === "string" &&
    typeof gatewayRuntime?.isGatewayClientRequestError === "function" &&
    gatewayRuntime.isGatewayClientRequestError(error) === true &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message === "unknown channel: " + channel
  );
}

// Query the running Gateway through OpenClaw's public SDK. Starting a CLI here
// also starts its launcher/respawn lifecycle; killing that launcher cannot bound
// a probe whose descendant still owns stdout.
function callNativeGateway(method, params, timeoutMs, abortSignal, maxBytes = 65536) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timer;
    let gatewayRuntime;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      abortSignal?.removeEventListener?.("abort", cancel);
      resolve(result);
    };
    const cancel = () => {
      controller.abort();
      finish({ ok: false, code: "UNAVAILABLE" });
    };
    if (abortSignal?.aborted) {
      cancel();
      return;
    }
    timer = armTimer(cancel, timeoutMs);
    abortSignal?.addEventListener?.("abort", cancel, { once: true });
    Promise.resolve().then(async () => {
      if (settled) return;
      gatewayRuntime = require("openclaw/plugin-sdk/gateway-runtime");
      const value = await gatewayRuntime.callGatewayFromCli(method, { json: true, timeout: String(timeoutMs) }, params, {
        progress: false,
        // Status probes must not initialize shared state alongside Gateway startup.
        sharedStateMode: "read-only",
        signal: controller.signal,
      });
      if (settled) return;
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
        finish({ ok: false, code: "INCOMPATIBLE_RESPONSE" });
        return;
      }
      finish({ ok: true, value });
    }).catch((error) => {
      if (gatewayRuntime?.isGatewayTransportError(error)) {
        finish({ ok: false, code: "UNAVAILABLE" });
        return;
      }
      finish({
        ok: false,
        code: "PROBE_FAILED",
        ...(gatewayRefusedUnknownChannel(gatewayRuntime, error, params?.channel) ? { unknownChannel: true } : {}),
        ...(gatewayRefusedAuthentication(gatewayRuntime, error)
          ? { authenticationRefused: true, authenticationRefusalReason: gatewayAuthRefusalReason(error) }
          : {}),
      });
    });
  });
}

// No Slack channel: the expected answer for an Agent that does not use Slack, so nothing
// past configuration was checked.
function notConfiguredSlackChecks(checkedAt) {
  return [
    runtimeDiagnosticCheck("configuration", "failed", checkedAt, "NOT_CONFIGURED"),
    runtimeDiagnosticCheck("authentication", "unknown", checkedAt),
    runtimeDiagnosticCheck("connectivity", "unknown", checkedAt),
  ];
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
  if (configured === false) return notConfiguredSlackChecks(checkedAt);
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
  const result = await callNativeGateway(
    "channels.status",
    { channel: "slack", probe: true, timeoutMs: 5000 },
    6000,
    abortSignal,
  );
  if (!result.ok) {
    return result.unknownChannel === true
      ? notConfiguredSlackChecks(checkedAt)
      : unknownSlackChecks(checkedAt, result.code);
  }
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

function startPluginRuntimeStatusServer(readiness) {
  const port = runtimeStatusPort() ?? pluginRuntimeStatusPort();
  if (port === undefined) return;
  const server = pluginCreateServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === RUNTIME_READINESS_PATH) {
      await answerRuntimeReadiness(response, readiness);
      return;
    }
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

let atomicOpenClawConfigWrites = false;
function writeOpenClawConfig(config) {
  const target = writableOpenClawConfigPath();
  pluginMkdirSync(pluginDirname(target), { recursive: true });
  if (atomicOpenClawConfigWrites) {
    const temporary = target + ".oce-write.pending";
    try {
      pluginWriteFileSync(temporary, JSON.stringify(config), { mode: 0o600 });
      require("node:fs").renameSync(temporary, target);
    } finally { pluginRmSync(temporary, { force: true }); }
  } else {
    pluginWriteFileSync(target, JSON.stringify(config), { mode: 0o600 });
  }
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

function isManagedOpenClawPluginEntry(value, pluginId) {
  if (!isPlainObject(value) || typeof value.enabled !== "boolean") return false;
  const keys = Object.keys(value);
  if (keys.length === 1) return true;
  const managedConfig = pluginRuntimeTranslator.openClawManagedEntryConfig(pluginId);
  return (
    keys.length === 2 &&
    hasOwn(value, "config") &&
    managedConfig !== undefined &&
    pluginDeepEqual(value.config, managedConfig)
  );
}

// The Gateway serves browsers through an OCC-authenticated public origin only
// when native admin routes that exact origin to it with trusted-proxy auth.
function gatewayServesPublicOrigin(config) {
  const gateway = config?.gateway;
  const raw = gateway?.publicOrigin;
  return (
    typeof raw === "string" &&
    /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(raw) &&
    gateway.auth?.mode === "trusted-proxy" &&
    Array.isArray(gateway.controlUi?.allowedOrigins) &&
    gateway.controlUi.allowedOrigins.includes(raw)
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
        isManagedOpenClawPluginEntry(baseEntries[pluginId], pluginId) &&
        isManagedOpenClawPluginEntry(overlayEntries[pluginId], pluginId)
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
      .filter(([pluginId, entry]) => pluginId !== "codex" && isManagedOpenClawPluginEntry(entry, pluginId) && entry.enabled === false)
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

// The Gateway may start before its Harness is ready: on a first dedicated
// deploy both are created together, and the agent Service lists the Harness
// only once it is ready. This wait has no deadline and never rejects, so a slow
// Harness cannot crash-loop the Gateway; the controller's convergence deadline
// governs a Harness that never reports. The Gateway stays unready meanwhile.
async function waitForPeerPluginRuntimeStatus() {
  let lastReportedAt;
  for (;;) {
    let reason;
    try {
      const status = await readPeerPluginRuntimeStatus();
      if (status !== undefined) return status;
      reason = "Peer plugin runtime status endpoint is not configured.";
    } catch (error) {
      reason = pluginRuntimeErrorMessage(error);
    }
    if (lastReportedAt === undefined || Date.now() - lastReportedAt >= 30_000) {
      lastReportedAt = Date.now();
      console.error("Waiting for Harness plugin runtime status: " + reason);
    }
    await pluginRuntimeDelay(250);
  }
}

function samePluginIds(left, right) {
  const leftIds = new Set(left ?? []);
  const rightIds = new Set(right ?? []);
  return leftIds.size === rightIds.size && [...leftIds].every((id) => rightIds.has(id));
}

function samePluginFailures(left, right) {
  return JSON.stringify([...(left ?? [])].sort((a, b) => a.pluginId.localeCompare(b.pluginId))) ===
    JSON.stringify([...(right ?? [])].sort((a, b) => a.pluginId.localeCompare(b.pluginId)));
}

function openClawPluginConfiguration(runtime, failures = [], base) {
  if (runtime.manifest?.kind === "openclaw") {
    return pluginRuntimeTranslator.openClawRuntimeArtifact(
      runtime.manifest.selections ?? {},
      failures,
      runtime.manifest.pluginApprovers,
      gatewayServesPublicOrigin(base),
    ).configuration;
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

class PluginApproverConfigurationError extends Error {
  constructor() {
    super("The selected OpenClaw gateway image cannot validate approvals.plugin.slack. Use a gateway image with Slack plugin approver support, or omit the Agent, plugin, and tool approver overrides.");
  }
}

let validatedPluginApproverConfiguration;

function validateOpenClawPluginApprovers(overlay) {
  const candidate = JSON.stringify({ approvals: overlay.approvals });
  if (candidate === validatedPluginApproverConfiguration) return;
  let directory;
  try {
    directory = pluginMkdtempSync(pluginResolve(pluginTmpdir(), "oce-plugin-approvers-"));
    const configPath = pluginResolve(directory, "openclaw.json");
    pluginWriteFileSync(configPath, candidate, { mode: 0o600 });
    // Probe only the exact generated approval policy: selected external plugins
    // may not be installed yet, so a full-config check would reject them early.
    const result = pluginSpawnSync("node", ["/app/openclaw.mjs", "config", "validate", "--json"], {
      cwd: directory,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error !== undefined || result.status !== 0 || JSON.parse(result.stdout)?.valid !== true) {
      throw new PluginApproverConfigurationError();
    }
    validatedPluginApproverConfiguration = candidate;
  } catch {
    throw new PluginApproverConfigurationError();
  } finally {
    if (directory !== undefined) {
      pluginRmSync(directory, { recursive: true, force: true });
    }
  }
}

function holdPluginApproverConfigurationFailure(error) {
  if (!(error instanceof PluginApproverConfigurationError)) return false;
  publishRuntimeFailure("plugin-approvers", "INCOMPATIBLE_RESPONSE");
  console.error(error.message);
  // Keep startup evidence available without launching an invalid gateway or
  // discarding the admitted policy through a restart loop.
  setInterval(() => {}, 3600000);
  return true;
}

function applyOpenClawPluginConfiguration(runtime, failures = [], options = {}) {
  const base = readOpenClawConfig();
  const overlay = openClawPluginConfiguration(runtime, failures, base);
  if (overlay === undefined) return;
  if (objectAtPath(overlay, ["approvals", "plugin", "slack"]) !== undefined) {
    const slack = objectAtPath(base, ["channels", "slack"]);
    if (slack === undefined || slack.enabled === false) {
      // Stored approver policy applies when Slack is configured. Omitting this
      // generated overlay preserves explicit deny lists in the admitted manifest.
      delete overlay.approvals.plugin.slack;
      if (Object.keys(overlay.approvals.plugin).length === 0) delete overlay.approvals.plugin;
      if (Object.keys(overlay.approvals).length === 0) delete overlay.approvals;
    } else {
      validateOpenClawPluginApprovers(overlay);
    }
  }
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

function codexPluginConfigEdits(configuration) {
  return [
    ...["apps", "plugins", "remote_plugin"].map((feature) => ({
      keyPath: "features." + feature,
      mergeStrategy: "replace",
      value: configuration.features?.[feature] === true,
    })),
    // Project the complete OCE-owned policy without retaining native table entries.
    ...["apps", "plugins"].map((keyPath) => ({
      keyPath,
      mergeStrategy: "replace",
      value: configuration[keyPath],
    })),
  ];
}

async function writeCodexPluginConfiguration(configuration) {
  const effective = await readCodexPluginConfiguration();
  const edits = codexPluginConfigEdits(configuration);
  // Replacing a user table does not erase descendants inherited from other
  // config layers. Materialize the selection and approval policy at those keys.
  // Native requirements still apply independently; readback below remains mandatory.
  for (const [appId, actual] of Object.entries(effective?.apps ?? {})) {
    if (appId === "_default") continue;
    const app = configuration.apps?.[appId];
    const path = "apps." + codexConfigPathSegment(appId);
    if (app === undefined) {
      edits.push({ keyPath: path + ".enabled", mergeStrategy: "replace", value: false });
      continue;
    }
    if (app.enabled === false) continue;
    for (const [toolName, tool] of Object.entries(actual?.tools ?? {})) {
      for (const [field, defaultField] of [
        ["enabled", "default_tools_enabled"],
        ["approval_mode", "default_tools_approval_mode"],
      ]) {
        const expected = app.tools?.[toolName]?.[field] ?? app[defaultField];
        if (tool[field] == null || expected === undefined) continue;
        edits.push({
          keyPath: path + ".tools." + codexConfigPathSegment(toolName) + "." + field,
          mergeStrategy: "replace",
          value: expected,
        });
      }
    }
    for (const [linkId, link] of Object.entries(actual?.links ?? {})) {
      for (const field of ["default_tools_approval_mode", "approvals_reviewer"]) {
        if (link[field] == null || app[field] === undefined) continue;
        edits.push({
          keyPath: path + ".links." + codexConfigPathSegment(linkId) + "." + field,
          mergeStrategy: "replace",
          value: app[field],
        });
      }
    }
  }
  await codexAppServerRequest("config/batchWrite", {
    edits,
    reloadUserConfig: true,
  });
}

async function readCodexPluginConfiguration() {
  // Match the dedicated Harness workspace; a thread-agnostic read omits its
  // trusted .codex layers and can validate a different policy than the Agent uses.
  const response = await codexAppServerRequest("config/read", {
    cwd: process.env.OPENCLAW_WORKSPACE_DIR || "/home/node/workspace",
  });
  return response?.config;
}

function verifyCodexPluginConfiguration(configuration, effective) {
  assertConfigContainsOverlay(effective, configuration);
  for (const [id, policy] of Object.entries(effective.plugins ?? {})) {
    // Only explicit enablement overrides the verified default-off policy.
    if (id !== "_default" && !hasOwn(configuration.plugins, id) && policy?.enabled === true) {
      throw new Error("Codex effective plugins configuration enables an unselected entry; remove the native override or update the Agent selection.");
    }
  }
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

async function readCodexPluginDetails(readParamsList, read = (params) => codexAppServerRequest("plugin/read", params)) {
  const details = [];
  // Bound concurrent authenticated requests and drain each batch before a
  // retry or any installation/configuration write can start.
  for (let offset = 0; offset < readParamsList.length; offset += 4) {
    const results = await Promise.allSettled(readParamsList.slice(offset, offset + 4).map(
      async (params, index) => read(params, offset + index),
    ));
    const failure = results.find((result) => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
    details.push(...results.map((result) => result.value));
  }
  return details;
}

async function installCodexSelectionSet(selections, failures = []) {
  if (Object.keys(selections).length === 0) return { successfulPluginIds: [], failures: [] };
  const enabledPluginIds = enabledCodexSelectionIds(selections);
  const listed = await codexAppServerRequest("plugin/list", {});
  const readParamsList = pluginRuntimeTranslator.codexReadParamsForSelections(selections, listed);
  const resolvedDetails = await readCodexPluginDetails(readParamsList);
  const failed = [...failures];
  const failedIds = pluginFailureIds(failed);
  const successfulPluginIds = [];
  const installs = pluginRuntimeTranslator.codexInstallPlan(selections, resolvedDetails);
  // Native installation reports connector auth only for enabled plugins.
  // Grant validated selections before installation; app grants still wait for revalidation.
  await codexAppServerRequest("config/batchWrite", {
    edits: [{ keyPath: "plugins", mergeStrategy: "replace", value: {
      _default: { enabled: false },
      ...Object.fromEntries(installs.map((plugin) => [plugin.nativeId, {
        enabled: enabledPluginIds.has(plugin.pluginId) && !failedIds.has(plugin.pluginId),
      }])),
    } }],
    reloadUserConfig: true,
  });
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
  const installedDetails = await readCodexPluginDetails(readParamsList, (readParams, index) => {
    const selectedPlugin = installs.find(
      (candidate) => candidate.remotePluginId === readParams.pluginName,
    );
    if (
      selectedPlugin !== undefined &&
      (failedIds.has(selectedPlugin.pluginId) || !enabledPluginIds.has(selectedPlugin.pluginId))
    ) {
      return resolvedDetails[index];
    }
    return codexAppServerRequest("plugin/read", readParams);
  });
  const installedArtifact = pluginRuntimeTranslator.codexRuntimeArtifact(selections, installedDetails, failed, toolStatuses);
  if (JSON.stringify(installedArtifact.installs) !== JSON.stringify(effectiveResolvedArtifact.installs)) {
    throw new Error("Codex plugin installed release metadata does not match startup resolution.");
  }
  if (JSON.stringify(installedArtifact.configuration) !== JSON.stringify(effectiveResolvedArtifact.configuration)) {
    throw new Error("Codex plugin installed app mapping does not match startup resolution.");
  }
  // Remote plugin/read reports catalog metadata, not cached bundle contents.
  // Recheck the admitted release and app mapping before granting apps.
  await writeCodexPluginConfiguration(effectiveResolvedArtifact.configuration);
  const enabledReadParams = readParamsList.filter((readParams) => installs.some(
    (plugin) => plugin.remotePluginId === readParams.pluginName &&
      !failedIds.has(plugin.pluginId) && enabledPluginIds.has(plugin.pluginId),
  ));
  const enabledDetails = await readCodexPluginDetails(enabledReadParams);
  for (const plugin of effectiveResolvedArtifact.installs) {
    if (failedIds.has(plugin.pluginId) || !enabledPluginIds.has(plugin.pluginId)) continue;
    const readParams = enabledReadParams.find((candidate) => candidate.pluginName === plugin.remotePluginId);
    if (readParams === undefined) {
      throw new Error("Codex plugin installed identity does not match the selected catalog entry.");
    }
    const detail = enabledDetails[enabledReadParams.indexOf(readParams)];
    verifyCodexPluginDetail(plugin, readParams, detail);
  }
  // TODO: use native effective app/tool policy introspection when available.
  // Codex 0.156 config/read omits managed app requirements applied at execution;
  // this readback verifies loaded configuration, not future thread policy.
  const effectiveConfiguration = await readCodexPluginConfiguration();
  await verifyCodexReviewerConfiguration(effectiveResolvedArtifact.configuration, effectiveConfiguration);
  verifyCodexPluginConfiguration(effectiveResolvedArtifact.configuration, effectiveConfiguration);
  return { successfulPluginIds, failures: failed };
}

// Codex serves the curated remote catalog only to ChatGPT logins and rejects an
// API-key login ("api key auth is not supported"), so retrying cannot succeed.
// Disable every enabled selection as an authentication requirement and turn the
// plugin features off instead of holding the Harness unready.
async function disableCodexSelectionsWithoutChatGptLogin(selections, failures = []) {
  const failed = [...failures];
  const failedIds = pluginFailureIds(failed);
  for (const pluginId of enabledCodexSelectionIds(selections)) {
    if (failedIds.has(pluginId)) continue;
    const diagnostic = pluginDiagnostic(pluginId, "PLUGIN_AUTH_REQUIRED");
    if (!pluginBestEffortEnabled()) {
      throw new PluginTerminalDiagnosticError(
        diagnostic,
        "Codex plugins require a ChatGPT login; API-key authentication cannot install them.",
      );
    }
    failed.push(diagnostic);
    failedIds.add(pluginId);
  }
  if (Object.keys(selections).length > 0) {
    const configuration = {
      features: { apps: false, plugins: false, remote_plugin: false },
      apps: { _default: { enabled: false } },
      plugins: { _default: { enabled: false } },
    };
    // The app-server may still be starting: retry like the ChatGPT install path.
    const deadline = Date.now() + CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS;
    let lastError = new Error("Codex plugin disable deadline expired before the first attempt.");
    while (Date.now() < deadline) {
      try {
        await writeCodexPluginConfiguration(configuration);
        verifyCodexPluginConfiguration(configuration, await readCodexPluginConfiguration());
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await pluginRuntimeDelay(250);
      }
    }
    if (lastError !== undefined) {
      const failure = new Error("Codex plugin disable did not reach readiness: " + pluginRuntimeErrorMessage(lastError));
      failure.startupCode = codexPluginStartupFailureCode(lastError);
      throw failure;
    }
  }
  return { successfulPluginIds: [], failures: failed };
}

async function installCodexPlugins(runtime, failures = []) {
  assertCodexPluginRuntime(runtime);
  const selections = runtime.manifest.selections ?? {};
  if (process.env.CODEX_LOGIN_MODE === "api_key") {
    return disableCodexSelectionsWithoutChatGptLogin(selections, failures);
  }
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
    const failure = new Error("Codex plugin installation did not reach readiness: " + pluginRuntimeErrorMessage(lastError));
    failure.startupCode = codexPluginStartupFailureCode(lastError);
    throw failure;
  }
  return result;
}

// A fixed cause code for remote logs; the message, which can carry native
// Codex error text, stays in local container output.
function codexPluginStartupFailureCode(error) {
  switch (pluginRuntimeErrorMessage(error)) {
    case "Codex plugin catalog did not contain the selected plugin.":
      return "PLUGIN_NOT_IN_CATALOG";
    case "Codex plugin detail did not contain the selected plugin.":
      return "PLUGIN_DETAIL_MISSING";
    default:
      return "PLUGIN_NOT_READY";
  }
}
`;

// Holds unready until an explicit restart; readiness polls never submit model calls.
// A failed probe's cause is a closed kind and a fixed token, never native output,
// provider text or a credential; the controller drops a cause outside that vocabulary.
const AUTH_PROBE_FAILURE_HELPER = String.raw`
function holdFailedAuthentication(check = "model-probe", code = "UNAVAILABLE", cause) {
  publishRuntimeFailure(check, code, cause);
  serveHeldRuntimeFailureToTransportPeer(check, code, cause);
  console.error("Harness model authentication probe failed.");
  setInterval(() => {}, 3600000);
}
function probeFailure(kind, detail) {
  return { code: "MODEL_PROBE_FAILED", cause: detail === undefined ? { kind } : { kind, detail } };
}
function probeExitFailure({ error, status, signal }) {
  return probeFailure("PROCESS_EXIT", /^E[A-Z0-9]{1,15}$/.test(error?.code) ? "error-" + error.code
    : Number.isInteger(status) && status > 0 && status < 1000 ? "exit-" + status
    : /^SIG[A-Z0-9]{1,10}$/.test(signal) ? "signal-" + signal : undefined);
}
`;

// The native probe disables tools and fallback and performs a bounded model turn.
// Its JSON status, not its process exit status alone, establishes provider acceptance.
//
// The probe is a whole embedded agent run. Its local work (Node and OpenClaw
// boot, SQLite session state, cleanup) took about 16 CPU-seconds on the runtime
// image, on one core however many it may use; --probe-timeout bounds the model
// turn itself. A fixed 30-second cap let the example 500m CPU limit starve that
// local work into MODEL_PROBE_TIMEOUT before the turn finished. The cap is now
// the 15-second turn, 5 seconds of slack, and 45 CPU-seconds of local work at
// the container's CPU limit (cgroup cpu.max, at most one core), at most 600 s.
// A probe that still reaches it after waiting for CPU for over a quarter of the
// time reports MODEL_PROBE_CPU_STARVED: a restart would get the same CPU. The
// wait is cgroup cpu.pressure (throttling and node contention) or, on kernels
// without pressure accounting, cpu.stat throttled_usec (throttling only).
// OpenClaw buckets provider 401/403 and invalid-key responses as "auth". Only
// that deterministic rejection fails the deployment before its deadline.
// The turn allows 256 output tokens. A reasoning model spends output tokens on
// thinking before any text; at 16 it returned none and the probe failed.
// The Gateway times its model-probe phase from wrapper start: it is the first step.
// Generated code stays compact: the Gateway program is near the exec limit.
const OPENCLAW_AUTH_PROBE_HELPERS = String.raw`
${AUTH_PROBE_FAILURE_HELPER}
function probeOpenClawAuthenticationFailure() {
  const fs = require("node:fs");
  const cgroup = (name) => { try { return fs.readFileSync("/sys/fs/cgroup/" + name, "utf8"); } catch { return ""; } };
  const [quota, period] = cgroup("cpu.max").split(" ");
  const capMs = Math.min(600000, 20000 + Math.ceil(45000 / Math.min(1, quota / period || 1)));
  const read = (name) => (name === "cpu.pressure" ? /^some .*total=(\d+)/m : /throttled_usec (\d+)/).exec(cgroup(name))?.[1] / 1000;
  const startedAt = Date.now(), pressure = read("cpu.pressure"), metric = Number.isFinite(pressure) ? "cpu.pressure" : "cpu.stat", before = metric === "cpu.pressure" ? pressure : read(metric);
  let code = runOpenClawAuthenticationProbe(fs, capMs), cause;
  if (typeof code === "object") ({ code, cause } = code);
  const elapsedMs = Date.now() - startedAt, after = read(metric), cpuWaitMs = Math.round(Number.isFinite(after) && after >= before ? after - before : NaN);
  if (code === "CAP") code = cpuWaitMs > elapsedMs / 4 ? "MODEL_PROBE_CPU_STARVED" : "MODEL_PROBE_TIMEOUT";
  console.error(JSON.stringify({ event: "openclaw.model_probe", elapsedMs, capMs, cpuWaitMs, code: code ?? "READY", cause }));
  return code === undefined ? undefined : { code, cause };
}

// The full probe needs 10-20 s of local work before its model request. A
// rejected credential is found first with one empty request to the default
// endpoint, sent with the credential exactly as OpenClaw sends it: the provider
// authenticates before validating, so only 401 means rejection. Anything else
// (400, an error, the 10 s limit) proves nothing and the full probe decides,
// so acceptance still needs a real model turn. A configured endpoint, API,
// headers or request option other than allowPrivateNetwork, a model whose API or
// endpoint differs from the provider's, or an Anthropic setup token, skips this
// request. The request goes to the
// path of the configured API: a key may be scoped to one endpoint, and OpenAI
// answers 401 for a missing scope.
const UPFRONT_ENDPOINTS = {
  openai: ["https://api.openai.com/v1", { "openai-responses": "/responses", "openai-completions": "/chat/completions" }, (key) => ({ authorization: "Bearer " + key })],
  anthropic: ["https://api.anthropic.com", { "anthropic-messages": "/v1/messages" }, (key) => !key.startsWith("sk-ant-oat") && { "x-api-key": key, "anthropic-version": "2023-06-01" }],
};
function credentialRejectedUpfront(provider, fragment, key, stage) {
  fragment ??= {};
  const [base, paths, authorize] = UPFRONT_ENDPOINTS[provider] ?? [];
  const headers = authorize?.(key.trim());
  const api = fragment.api ?? Object.keys(paths ?? {})[0];
  if (!headers || Object.keys(fragment).some((name) => !["baseUrl", "api", "models", "request"].includes(name)) ||
    Object.keys(fragment.request ?? {}).some((name) => name !== "allowPrivateNetwork") ||
    String(fragment.baseUrl ?? base).replace(/\/+$/, "") !== base || !Object.hasOwn(paths, api) ||
    JSON.stringify(fragment.models ?? []).includes('"headers"') ||
    (Array.isArray(fragment.models) && fragment.models.some((model) => (model?.api !== undefined && model.api !== api) || model?.baseUrl !== undefined))) return false;
  const path = paths[api];
  stage("preflight");
  return require("node:child_process").spawnSync(process.execPath, ["-e",
    'fetch(process.env.U,{method:"POST",headers:JSON.parse(process.env.H),body:"{}",signal:AbortSignal.timeout(8000)}).then((r)=>process.exit(r.status===401?3:0),()=>process.exit(0))',
  ], {
    env: { U: base + path, H: JSON.stringify({ ...headers, "content-type": "application/json" }), NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS, SSL_CERT_FILE: process.env.SSL_CERT_FILE },
    stdio: "ignore", timeout: 10000, killSignal: "SIGKILL",
  }).status === 3;
}

function runOpenClawAuthenticationProbe(fs, capMs) {
  const stageStartedAt = Date.now();
  const stage = (stage) => console.error(JSON.stringify({ event: "openclaw.model_probe_stage", stage, elapsedMs: Date.now() - stageStartedAt, capMs }));
  stage("prepare");
  const { spawnSync } = require("node:child_process");
  const temporary = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const directory = fs.mkdtempSync(temporary + "/openclaw-auth-probe-");
  try {
    const model = process.env.OPENCLAW_HARNESS_MODEL;
    const provider = process.env.OPENCLAW_HARNESS_PROVIDER;
    const credentialEnvironment = process.env.OPENCLAW_HARNESS_CREDENTIAL_ENV;
    if (typeof provider !== "string" || typeof credentialEnvironment !== "string" ||
      typeof model !== "string" || !model.startsWith(provider + "/") ||
      !process.env[credentialEnvironment]?.trim()) return "UNAVAILABLE";
    const configuration = JSON.parse(process.env.OPENCLAW_HARNESS_PROBE_CONFIG);
    if (configuration.agents?.defaults?.model !== model) return "UNAVAILABLE";
    if (credentialRejectedUpfront(provider, configuration.models?.providers?.[provider], process.env[credentialEnvironment], stage)) return "AUTHENTICATION_FAILED";
    configuration.agents.defaults.workspace = directory + "/workspace";
    fs.mkdirSync(directory + "/workspace", { mode: 0o700 });
    const configPath = directory + "/openclaw.json";
    fs.writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
    stage("spawn");
    const result = spawnSync("node", [
      "/app/openclaw.mjs", "models", "status", "--json", "--probe",
      "--probe-provider", provider, "--probe-concurrency", "1",
      "--probe-timeout", "15000", "--probe-max-tokens", "256",
    ], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: directory,
        OPENCLAW_STATE_DIR: directory + "/state",
        OPENCLAW_CONFIG_PATH: configPath,
        NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        [credentialEnvironment]: process.env[credentialEnvironment],
      },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: capMs, killSignal: "SIGKILL", maxBuffer: 262144,
    });
    stage("returned");
    if (result.error?.code === "ETIMEDOUT") return "CAP";
    if (result.status !== 0 || result.error) return probeExitFailure(result);
    let output;
    try { output = JSON.parse(result.stdout); } catch { return probeFailure("INVALID_OUTPUT", "json"); }
    const results = output?.auth?.probes?.results;
    if (!Array.isArray(results) || results.length !== 1 ||
      results[0]?.provider !== provider || results[0].model !== model ||
      results[0].source !== "env") return probeFailure("INVALID_OUTPUT", "shape");
    const status = results[0].status;
    if (status === "ok") return undefined;
    if (status === "auth") return "AUTHENTICATION_FAILED";
    if (status === "timeout") return "MODEL_PROBE_TIMEOUT";
    return probeFailure("PROBE_STATUS", ["format", "rate_limit", "billing", "unknown", "no_model"].includes(status) ? status : "other");
  } catch {
    return probeFailure("WRAPPER_ERROR");
  } finally {
    stage("cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
    stage("complete");
  }
}
`;

const WORKSPACE_ASSET_HELPERS = String.raw`
const { cpSync, existsSync, lstatSync, readdirSync, symlinkSync } = require("node:fs");
const runtimeHomeDirectory = process.env.HOME || "/home/node";
if (!runtimeHomeDirectory.startsWith("/")) {
  throw new Error("The runtime HOME must be an absolute path.");
}
const runtimeAssetsDirectory = runtimeHomeDirectory + "/openclaw-runtime-assets";
const runtimeOpenClawDirectory = runtimeHomeDirectory + "/.openclaw";

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
  publishImageTree("/app/custodian-skills", runtimeAssetsDirectory + "/custodian-skills", false);
  publishImageTree("/app/plugin-skills", runtimeAssetsDirectory + "/plugin-skills", false);
  process.env.OPENCLAW_BUNDLED_SKILLS_DIR = runtimeAssetsDirectory + "/bundled-skills";
}

function publishAgentPluginSkillPath() {
  mkdirSync(runtimeOpenClawDirectory, { recursive: true });
  rmSync(runtimeOpenClawDirectory + "/plugin-skills", { recursive: true, force: true });
  symlinkSync(runtimeAssetsDirectory + "/plugin-skills", runtimeOpenClawDirectory + "/plugin-skills", "dir");
}

`;

export const GATEWAY_RUNTIME_ENTRYPOINT = String.raw`
const { accessSync, constants: fsConstants, mkdirSync, rmSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawn } = require("node:child_process");

// OCE upgrades this runtime by rolling out a selected image.
process.env.OPENCLAW_NO_AUTO_UPDATE = "1";

${PLUGIN_RUNTIME_HELPERS}
${WORKSPACE_ASSET_HELPERS}
${OPENCLAW_AUTH_PROBE_HELPERS}
${startupPhaseHelper("gateway")}
${gatewayStateMigrationHelper("restart the Pod")}

function gatewayRuntimeReady() {
  if (pluginRuntimeStatusPort() !== undefined && pluginStatusReport.phase !== "ready") {
    return false;
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ready) => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };
    const request = pluginHttpGet(
      {
        host: "127.0.0.1",
        port: requireNonEmptyString(process.env.OPENCLAW_GATEWAY_PORT, "Gateway port"),
        path: "/readyz",
        timeout: 2_000,
      },
      (response) => {
        response.resume();
        settle(response.statusCode === 200);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => settle(false));
  });
}

startPluginRuntimeStatusServer(gatewayRuntimeReady);

// A respawn for a changed Harness peer bounds its retries and falls back to a
// container restart when the peer keeps changing.
const GATEWAY_RESPAWN_ATTEMPTS = 3;
const GATEWAY_RESPAWN_LIMIT = 5;
const GATEWAY_RESPAWN_WINDOW_MS = 10 * 60_000;
const GATEWAY_RESPAWN_READY_TIMEOUT_MS = 180_000;
const GATEWAY_RESPAWN_READY_POLL_MS = 500;
const GATEWAY_RESPAWN_KILL_GRACE_MS = 10_000;
let gatewayTerminating = false;

// Forward to the current native process; between a respawn's stop and spawn
// there is none, and the wrapper exits itself.
function forwardTermination(currentChild) {
  const forward = (signal) => {
    if (gatewayTerminating) return;
    gatewayTerminating = true;
    const target = currentChild();
    if (target === undefined) {
      process.exit(0);
      return;
    }
    target.kill(signal);
    setTimeout(() => currentChild()?.kill("SIGKILL"), ${GATEWAY_STOP_TIMEOUT_MS}).unref();
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
}

function configureNativeWorkerProfile() {
  const deviceId = process.env.OPENCLAW_WORKSPACE_NODE_ID;
  const profileId = process.env.OPENCLAW_NATIVE_WORKER_PROFILE;
  if (profileId === undefined || deviceId === undefined) return;
  if (!/^[a-f0-9]{64}$/u.test(deviceId) || !profileId) {
    throw new Error("Dedicated OpenClaw worker placement configuration is invalid.");
  }
  const config = readOpenClawConfig();
  const cloudWorkers = isPlainObject(config.cloudWorkers) ? config.cloudWorkers : {};
  const profiles = isPlainObject(cloudWorkers.profiles) ? cloudWorkers.profiles : {};
  if (profiles[profileId] !== undefined) {
    throw new Error("Dedicated OpenClaw worker profile conflicts with admitted configuration.");
  }
  writeOpenClawConfig({
    ...config,
    cloudWorkers: {
      ...cloudWorkers,
      requiredProfile: profileId,
      profiles: {
        ...profiles,
        [profileId]: {
          provider: "device",
          settings: { device: deviceId, inference: "worker" },
        },
      },
    },
  });
}

function requireWorkspaceNodePlugins(config) {
  const plugins = isPlainObject(config.plugins) ? config.plugins : {};
  if (
    plugins.deny?.includes("file-transfer") ||
    plugins.entries?.["file-transfer"]?.enabled === false
  ) {
    throw new Error("The workspace node requires the file-transfer plugin.");
  }
}

// Every change this makes is under plugins.*, which OpenClaw hot-applies.
function configureWorkspaceNodePlugins(config, workspaceNodeId) {
  requireWorkspaceNodePlugins(config);
  const plugins = config.plugins ??= {};
  if (Array.isArray(plugins.allow)) {
    plugins.allow = [...new Set([...plugins.allow, "file-transfer"])];
  }
  const entries = plugins.entries ??= {};
  const transfer = entries["file-transfer"] ??= {};
  transfer.enabled = true;
  const fileConfig = transfer.config ??= {};
  // Provider-owned Harnesses can relocate the workspace. Deployment-backed
  // Kubernetes Harnesses retain the canonical path when no override is present.
  const nativeWorkspace = process.env.OPENCLAW_NATIVE_WORKER_PROFILE === undefined
    ? undefined : config.agents?.defaults?.workspace;
  const remoteRoot = process.env.OPENCLAW_REMOTE_WORKSPACE_ROOT || nativeWorkspace || "/home/node/workspace";
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
    "/home/node/.openclaw/agents/*/agent/workshop-skills",
    "/home/node/.openclaw/worktree-sources/empty/*/workspace",
    "/home/node/.agents/skills", "/home/node/openclaw-runtime-assets/bundled-skills",
    "/home/node/openclaw-runtime-assets/custodian-skills",
    "/home/node/openclaw-runtime-assets/plugin-skills", "/app/extensions/*/skills",
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
        remoteRoot + "/skills/**",
        remoteRoot + "/.clawhub/lock.json",
        remoteRoot + "/.clawdhub/lock.json",
        remoteRoot + "/.openclaw/skill-installs/**",
        remoteRoot + "/media/inbound/openclaw-staged-*/**",
      ],
      followSymlinks: false,
    };
  }
  fileConfig.policyVersion ??= 2;
  (fileConfig.workspaces ??= {}).main = { nodeId: workspaceNodeId, remoteRoot };
}

// A Gateway with a workspace node serves no workspace: its /home/node/workspace
// is an empty local directory, while Codex runs in the Harness Pod. OpenClaw executes
// its dynamic tools in the Gateway process, so these would list, read, write or
// run commands in the Gateway Pod instead. Codex's native tools cover them in
// the Harness, and the file-transfer tools reach its workspace through the node.
// "terminal" types into shells running in the Gateway Pod, and "openclaw"
// delegates Gateway configuration changes, which could drop this list.
const GATEWAY_LOCAL_CODEX_DYNAMIC_TOOLS = [
  "ls", "read", "write", "edit", "apply_patch",
  "exec", "process", "gateway_exec", "gateway_process",
  "terminal", "openclaw",
];

function excludeGatewayLocalCodexTools(config) {
  const codex = config.plugins?.entries?.codex;
  if (!isPlainObject(codex)) {
    // APP_SERVER_URL names a remote Codex Harness: pin its providers even when
    // the Gateway config lacks the plugin entry. A dedicated OpenClaw Gateway
    // (no APP_SERVER_URL) runs its turns with these rows, so it keeps them.
    if (process.env.APP_SERVER_URL !== undefined) logOverriddenSettings(pinCodexProviderTransport(config));
    return;
  }
  const codexConfig = codex.config ??= {};
  const configured = codexConfig.codexDynamicToolsExclude ?? [];
  if (!Array.isArray(configured)) {
    throw new Error("The Codex plugin codexDynamicToolsExclude setting must be a list.");
  }
  codexConfig.codexDynamicToolsExclude = [...new Set([...configured, ...GATEWAY_LOCAL_CODEX_DYNAMIC_TOOLS])];
  // Automation triggers run model-written commands and scripts in the Gateway
  // process: stream schedules, script payloads and condition scripts. Timed
  // automations still run Codex turns in the Harness.
  const cron = config.cron ??= {};
  if (!isPlainObject(cron)) {
    throw new Error("The cron setting must be an object.");
  }
  const triggers = cron.triggers ??= {};
  if (!isPlainObject(triggers)) {
    throw new Error("The cron.triggers setting must be an object.");
  }
  const overridden = triggers.enabled === undefined || triggers.enabled === false ? [] : ["cron.triggers.enabled"];
  triggers.enabled = false;
  logOverriddenSettings([...overridden, ...pinCodexProviderTransport(config)]);
}

// Say which owner settings this Gateway replaced: setting names only, never values.
function logOverriddenSettings(settings) {
  if (settings.length > 0) console.error(JSON.stringify({ event: "runtime.gateway_settings_overridden", container: "gateway", settings }));
}

// OpenClaw's built-in runtime runs in the Gateway process with Gateway-local
// tools. An operator's "/model codex/<model> --runtime openclaw" selects it for
// a session, and Codex hands a turn to it when the row of one of its providers
// (codex, openai) carries request transport overrides. The Harness reaches the
// model itself, so here those rows only name models: fields that override the
// transport, start a local service, or make Codex declare that fallback are
// dropped, and an authored transport becomes the unreachable stub. A built-in
// run then has no model to call.
const CODEX_PROVIDER_STUB_URL = "http://127.0.0.1:9";
const CODEX_PROVIDER_KEPT_KEYS = new Set(["models", "maxTokens", "agentRuntime"]);
const CODEX_MODEL_KEPT_KEYS = new Set([
  "id", "name", "reasoning", "input", "cost", "contextWindow", "contextTokens",
  "maxTokens", "thinkingLevelMap", "agentRuntime", "mediaInput", "metadataSource",
]);

function keepKeys(value, kept) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => kept.has(key)));
}

// Returns the owner settings it dropped or replaced.
function pinCodexProviderTransport(config) {
  const overridden = new Set();
  const models = config.models ??= {};
  if (!isPlainObject(models)) {
    throw new Error("The models setting must be an object.");
  }
  const providers = models.providers ??= {};
  if (!isPlainObject(providers)) {
    throw new Error("The models.providers setting must be an object.");
  }
  // OpenClaw matches provider keys after trimming and lowercasing.
  const providerId = (key) => key.trim().toLowerCase();
  const keys = Object.keys(providers).filter((key) => ["codex", "openai"].includes(providerId(key)));
  if (!keys.some((key) => providerId(key) === "codex")) {
    // "codex" is a bundled provider: without a row it would keep its own transport.
    providers.codex = {};
    keys.push("codex");
  }
  for (const key of keys) {
    const id = providerId(key);
    const provider = providers[key];
    if (!isPlainObject(provider)) {
      throw new Error("The " + id + " model provider setting must be an object.");
    }
    const pinned = keepKeys(provider, CODEX_PROVIDER_KEPT_KEYS);
    const stub = { baseUrl: CODEX_PROVIDER_STUB_URL, api: "openai-responses" };
    const row = "models.providers." + id + ".";
    for (const name of Object.keys(provider)) {
      if (!CODEX_PROVIDER_KEPT_KEYS.has(name) && provider[name] !== stub[name]) overridden.add(row + name);
    }
    if (provider.models !== undefined) {
      if (!Array.isArray(provider.models) || !provider.models.every(isPlainObject)) {
        throw new Error("The " + id + " model provider models setting must be a list of objects.");
      }
      for (const model of provider.models) {
        for (const name of Object.keys(model)) {
          if (!CODEX_MODEL_KEPT_KEYS.has(name)) overridden.add(row + "models[]." + name);
        }
      }
      pinned.models = provider.models.map((model) => keepKeys(model, CODEX_MODEL_KEPT_KEYS));
    }
    // An openai row that names no transport keeps OpenClaw's default, which has
    // no credential in the Gateway, and Codex keeps owning its account's models.
    const authoredTransport =
      id === "codex" || provider.baseUrl !== undefined || provider.api !== undefined;
    providers[key] = authoredTransport ? { ...pinned, ...stub } : pinned;
  }
  return [...overridden];
}

const WORKSPACE_NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const workspaceNodeBindingPath = process.env.OPENCLAW_WORKSPACE_NODE_PATH;

// The controller writes {revisionId, deviceId} to an optional ConfigMap volume.
// A missing, partial or foreign file (another revision of this Agent) is absent.
function readWorkspaceNodeBinding() {
  if (workspaceNodeBindingPath === undefined) return undefined;
  let binding;
  try {
    binding = JSON.parse(pluginReadFileSync(workspaceNodeBindingPath, "utf8"));
  } catch {
    return undefined;
  }
  if (
    !isPlainObject(binding) ||
    binding.revisionId !== process.env.OPENCLAW_AGENT_REVISION_ID ||
    typeof binding.deviceId !== "string" ||
    !WORKSPACE_NODE_ID_PATTERN.test(binding.deviceId)
  ) {
    return undefined;
  }
  return binding.deviceId;
}

// OpenClaw hot-applies plugins.* and cloudWorkers.* (gateway/config-reload-plan.ts);
// any other change, gateway.* in particular, would restart the Gateway.
const HOT_APPLIED_CONFIG_KEYS = new Set(["plugins", "cloudWorkers"]);

function assertHotApplicableChange(previous, next) {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (!HOT_APPLIED_CONFIG_KEYS.has(key) && !pluginDeepEqual(previous[key], next[key])) {
      throw new Error("A workspace node update would change configuration OpenClaw cannot hot-apply.");
    }
  }
}

// OpenClaw watches the config file: replace it whole so it never reads a partial write.
function replaceOpenClawConfig(config) {
  const { renameSync } = require("node:fs");
  const target = writableOpenClawConfigPath();
  const staged = target + ".workspace-node-" + process.pid;
  pluginWriteFileSync(staged, JSON.stringify(config), { mode: 0o600 });
  renameSync(staged, target);
  process.env.OPENCLAW_CONFIG_PATH = target;
}

// The running Gateway's own view of file-transfer: its runtime state in the
// live plugin registry ("active", "service-failed", "disabled", "unloaded")
// and that registry's generation, which every plugin reload replaces. A Gateway
// that refused this CLI's credentials answers { refused: true, reason }.
async function openClawFileTransferState() {
  const result = await callNativeGateway(
    "plugins.list",
    {},
    8000,
    undefined,
    4 * 1024 * 1024,
  );
  if (result.authenticationRefused === true) {
    return { refused: true, reason: result.authenticationRefusalReason };
  }
  if (!result.ok || !isPlainObject(result.value) || !Array.isArray(result.value.plugins)) {
    return undefined;
  }
  const plugin = result.value.plugins.find((entry) => isPlainObject(entry) && entry.id === "file-transfer");
  const state = isPlainObject(plugin?.runtime) && typeof plugin.runtime.state === "string"
    ? plugin.runtime.state
    : "unloaded";
  return { state, generation: result.value.generation };
}

class WorkspaceNodeFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function withWorkspaceNodeFailure(code, run) {
  try {
    return run();
  } catch (error) {
    throw new WorkspaceNodeFailure(code, error instanceof Error ? error.message : String(error));
  }
}

const openClawAuthenticationFailure =
  process.env.OPENCLAW_HARNESS_PROBE_CONFIG === undefined
    ? undefined
    : probeOpenClawAuthenticationFailure();
if (process.env.OPENCLAW_HARNESS_PROBE_CONFIG !== undefined) {
  logStartupPhase("model-probe", startupPhaseOrigin, openClawAuthenticationFailure === undefined ? "ok" : "failed");
}
if (openClawAuthenticationFailure !== undefined) {
  holdFailedAuthentication("model-probe", openClawAuthenticationFailure.code, openClawAuthenticationFailure.cause);
} else {
mkdirSync("/home/node/.openclaw", { recursive: true });
mkdirSync("/home/node/workspace", { recursive: true });
if (process.env.OPENCLAW_WORKSPACE_DIR !== undefined) {
  const assetsStartedAt = Date.now();
  mkdirSync(process.env.OPENCLAW_WORKSPACE_DIR, { recursive: true });
  initializeRuntimeAssets();
  logStartupPhase("runtime-assets", assetsStartedAt);
}
delete process.env.OPENCLAW_LOG_LEVEL;
const pluginRuntime = readGatewayPluginRuntime();
const followsPeerStatus =
  pluginRuntime?.manifest?.kind === "codex" && hasEnabledPluginSelections(pluginRuntime);
// A respawn configures from the file a container restart would start from.
const initialConfigPath = process.env.OPENCLAW_CONFIG_PATH;
const writableInitialConfig = followsPeerStatus && initialConfigPath === writableOpenClawConfigPath();
atomicOpenClawConfigWrites = writableInitialConfig;
const codexBridgePath = ["plugins", "entries", "codex", "config", "codexPlugins"];
const admittedConfigText = writableInitialConfig
  ? pluginReadFileSync(${JSON.stringify(`${MANAGED_CONFIGURATION_DIRECTORY}/openclaw.json`)}, "utf8") : undefined;
const originalCodexBridge = admittedConfigText === undefined
  ? undefined : objectAtPath(JSON.parse(admittedConfigText), codexBridgePath);
const codexBridgeStatePath = initialConfigPath + ".oce-peer-bridge.json";
const codexBridgeOwner = writableInitialConfig ? {
  version: 1,
  revisionId: process.env.OPENCLAW_AGENT_REVISION_ID,
  sourceHash: require("node:crypto").createHash("sha256").update(admittedConfigText).digest("hex"),
} : undefined;
let generatedCodexBridges = [];
// Why the Pod-local record cannot be used, if it cannot. Every container
// restart in this Pod reads the same file, so startup holds instead of exiting.
let codexBridgeRecordProblem;
if (writableInitialConfig && pluginExistsSync(codexBridgeStatePath)) {
  let saved;
  try {
    saved = JSON.parse(pluginReadFileSync(codexBridgeStatePath, "utf8"));
  } catch {
    codexBridgeRecordProblem = "is unreadable";
  }
  if (codexBridgeRecordProblem === undefined && (!isPlainObject(saved) ||
      Object.entries(codexBridgeOwner).some(([key, value]) => saved[key] !== value) ||
      !Array.isArray(saved.bridges) || saved.bridges.length > 2 ||
      !saved.bridges.every(isPlainObject))) {
    codexBridgeRecordProblem = "does not match the admitted revision";
  }
  if (codexBridgeRecordProblem === undefined) generatedCodexBridges = saved.bridges;
}

// Rebuilding generated bridges without the record could overwrite native
// edits, so the record is kept and only Pod replacement clears it.
function holdCodexBridgeRecordFailure() {
  console.error(
    "Gateway peer configuration record " + codexBridgeStatePath + " " + codexBridgeRecordProblem +
      ". OpenClaw was not started. Delete the Pod to restore the managed configuration snapshot;" +
      " native configuration edits in this Pod are lost.",
  );
  logStartupPhase("peer-bridge-record", startupPhaseOrigin, "failed", "PEER_BRIDGE_RECORD_UNUSABLE");
  publishRuntimeFailure("peer-bridge-record", "UNAVAILABLE");
  forwardTermination(() => undefined);
  setInterval(() => {}, 3600000);
}

function recordWritableCodexBridges(bridges) {
  // Pending writes record both sides for crash replay; success keeps only the
  // current bridge so a later edit back to an older result remains an edit.
  const temporary = codexBridgeStatePath + ".pending";
  try {
    pluginWriteFileSync(temporary, JSON.stringify({ ...codexBridgeOwner, bridges }), { mode: 0o600 });
    require("node:fs").renameSync(temporary, codexBridgeStatePath);
  } finally { pluginRmSync(temporary, { force: true }); }
  generatedCodexBridges = bridges;
}

function prepareWritableCodexBridge(failures) {
  if (!writableInitialConfig) return;
  const config = readOpenClawConfig();
  const codexConfig = objectAtPath(config, codexBridgePath.slice(0, -1));
  const previousBridge = codexConfig?.codexPlugins;
  const generated = generatedCodexBridges.some((bridge) => pluginDeepEqual(bridge, previousBridge));
  if (generated) {
    if (originalCodexBridge === undefined) delete codexConfig.codexPlugins;
    else codexConfig.codexPlugins = JSON.parse(JSON.stringify(originalCodexBridge));
  }
  const overlay = openClawPluginConfiguration(pluginRuntime, failures, config);
  const nextBridge = overlay === undefined ? undefined
    : objectAtPath(JSON.parse(JSON.stringify(overlay)), codexBridgePath);
  const bridges = [generated ? previousBridge : undefined, nextBridge]
    .filter((bridge, index, values) => isPlainObject(bridge) &&
      values.findIndex((candidate) => pluginDeepEqual(candidate, bridge)) === index);
  recordWritableCodexBridges(bridges);
  if (generated) writeOpenClawConfig(config);
}

// Write the configuration the native Gateway starts with. It depends only on the
// admitted configuration, the Harness peer status and the workspace node binding,
// so an in-place respawn repeats it for a changed peer. For a Codex peer this
// installs nothing: the Harness installs the plugins; the Gateway applies its result.
function configureGateway(peerStatus) {
  process.env.OPENCLAW_CONFIG_PATH = initialConfigPath;
  configureNativeWorkerProfile();
  const peerFailures = peerStatus?.failures ?? readPluginFailuresFromEnvironment();
  prepareWritableCodexBridge(peerFailures);
  if (peerStatus !== undefined) {
    process.env.APP_SERVER_TOKEN = derivePluginAppServerToken(peerStatus.startupId);
  }
  const pluginInstallStartedAt = Date.now();
  const pluginResult =
    pluginRuntime === undefined
      ? { successfulPluginIds: [], failures: peerFailures }
      : installOpenClawPlugins(pluginRuntime, peerFailures);
  if (pluginRuntime !== undefined) {
    logStartupPhase("plugin-install", pluginInstallStartedAt);
  }
  if (peerStatus !== undefined) {
    pluginResult.successfulPluginIds = peerStatus.successfulPluginIds;
  }
  if (writableInitialConfig) {
    // Once application succeeds, an edit back to an older bridge is also an edit.
    recordWritableCodexBridges([objectAtPath(readOpenClawConfig(), codexBridgePath)].filter(isPlainObject));
  }
  // A native worker profile, or a Gateway whose controller cannot read its runtime
  // status, receives its node in the environment; the others read the binding file.
  const environmentWorkspaceNodeId = process.env.OPENCLAW_WORKSPACE_NODE_ID;
  let workspaceNodeId;
  if (
    environmentWorkspaceNodeId !== undefined ||
    workspaceNodeBindingPath !== undefined ||
    process.env.APP_SERVER_URL !== undefined ||
    process.env.OPENCLAW_NATIVE_WORKER_PROFILE !== undefined
  ) {
    const config = readOpenClawConfig();
    // The first pairing records its command grant before a node ID is available.
    // gateway.* changes restart OpenClaw, so this is written only before a spawn.
    const commands = ((config.gateway ??= {}).nodes ??= {}).commands ??= {};
    commands.allow = [...new Set([...(commands.allow ?? []), "file.fetch", "file.stat", "file.write", "file.create", "dir.list", "workspace.memory", "workspace.skills"])];
    if (environmentWorkspaceNodeId !== undefined || workspaceNodeBindingPath !== undefined) {
      // Refuse a revision that cannot host its node now, not when the node arrives.
      requireWorkspaceNodePlugins(config);
      excludeGatewayLocalCodexTools(config);
    }
    workspaceNodeId = environmentWorkspaceNodeId ?? readWorkspaceNodeBinding();
    if (workspaceNodeId !== undefined) {
      configureWorkspaceNodePlugins(config, workspaceNodeId);
    }
    writeOpenClawConfig(config);
  }
  return { pluginResult, workspaceNodeId };
}

// The native Gateway process. A respawn for a changed Harness peer replaces it;
// any other exit ends the wrapper, and so restarts the container.
let child;
let childRunning = false;
let childExited;
let respawning = false;
let waitingForPeerDuringOutage = false;
let verifyingServingReplacement = false;
let stoppingContainer = false;
let gatewayGeneration = 0;

// OpenClaw backs up a config file it can write. One OCC mounted read-only is
// externally managed: say so, so OpenClaw skips that backup instead of logging
// EROFS on every start.
function gatewayEnvironment() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (configPath === undefined) return process.env;
  try {
    accessSync(dirname(configPath), fsConstants.W_OK);
    return process.env;
  } catch {
    return { ...process.env, OPENCLAW_CONFIG_READONLY: "1" };
  }
}

function startGatewayProcess() {
  const spawned = spawn(
    "node",
    ["/app/openclaw.mjs", "gateway", "--port", process.env.OPENCLAW_GATEWAY_PORT],
    { stdio: "inherit", env: gatewayEnvironment() },
  );
  child = spawned;
  childRunning = true;
  gatewayGeneration++;
  childExited = new Promise((resolve) => {
    spawned.on("exit", (code, signal) => {
      if (spawned === child) childRunning = false;
      resolve();
      if (stoppingContainer) {
        process.exit(1);
        return;
      }
      if (gatewayTerminating || ((!respawning || waitingForPeerDuringOutage || verifyingServingReplacement) && spawned === child)) {
        process.exit(code ?? (signal === "SIGTERM" ? 0 : 1));
      }
    });
  });
  return Date.now();
}

// Fall back to a container restart, which the kubelet backs off.
function stopContainer() {
  if (stoppingContainer) return;
  stoppingContainer = true;
  if (!childRunning) {
    process.exit(1);
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => process.exit(1), ${GATEWAY_STOP_TIMEOUT_MS}).unref();
}

let pluginResult;
let peerStatus;
let resetWorkspaceNodeTracking = () => {};
(async () => {
if (codexBridgeRecordProblem !== undefined) {
  holdCodexBridgeRecordFailure();
  return;
}
peerStatus = followsPeerStatus
  ? await timeStartupPhase("peer-plugin-status", waitForPeerPluginRuntimeStatus)
  : undefined;
const started = configureGateway(peerStatus);
// Doctor reads the configuration the Gateway starts with. Current state adds
// no await before the spawn.
// A failure holds the Gateway unready with the step named, rather than
// restarting into the same refusal and another Doctor backup.
const outdatedDatabases = outdatedAgentDatabases();
if (outdatedDatabases.length > 0 && !(await migrateGatewayState(outdatedDatabases))) {
  setInterval(() => {}, 3600000);
  return;
}
pluginResult = started.pluginResult;
publishPluginRuntimeStatus({ phase: "ready", ...pluginResult });
const startWorkspaceNodeId = started.workspaceNodeId;
publishRuntimeReady();
// Everything before this line delays the native Gateway process.
logStartupPhase("native-spawn", startupPhaseOrigin);
// Apply budgets start when OpenClaw does, not at wrapper start: login, the model
// probe and plugin install must not count against them.
const childSpawnedAt = startGatewayProcess();
forwardTermination(() => (childRunning ? child : undefined));
if (workspaceNodeBindingPath !== undefined) {
  // The wrapper writing the config is not the ack: OpenClaw must report the
  // file-transfer plugin active in a plugin registry loaded after the write.
  const WORKSPACE_NODE_APPLY_TIMEOUT_MS = 30_000;
  let written;
  let firstSeenAt;
  let stoppingForChangedWorkspaceNode = false;
  let pollInFlight = false;
  // A new Gateway process loads its configuration, node included, from scratch:
  // its ack is required again.
  resetWorkspaceNodeTracking = (deviceId, spawnedAt) => {
    written = deviceId === undefined
      ? undefined
      : { deviceId, at: spawnedAt, activeBefore: false };
    firstSeenAt = undefined;
    runtimeWorkspaceNodeId = undefined;
    runtimeWorkspaceNodeFailure = undefined;
  };
  resetWorkspaceNodeTracking(startWorkspaceNodeId, childSpawnedAt);
  const reportFailure = (code, reason) => {
    if (runtimeWorkspaceNodeFailure?.code === code) return;
    runtimeWorkspaceNodeFailure = { code, checkedAt: new Date().toISOString() };
    // Fixed codes, and OpenClaw's token-shaped refusal reason, only; a changed
    // cause is logged again.
    console.error(JSON.stringify({
      event: "runtime.workspace_node",
      container: "gateway",
      outcome: "failed",
      code,
      ...(reason === undefined ? {} : { reason }),
    }));
  };
  const pollWorkspaceNode = async () => {
    const deviceId = readWorkspaceNodeBinding();
    if (deviceId === undefined || deviceId === runtimeWorkspaceNodeId) return;
    if (written !== undefined && written.deviceId !== deviceId) {
      // Another node for this revision: replace the config from a clean start.
      if (stoppingForChangedWorkspaceNode) return;
      stoppingForChangedWorkspaceNode = true;
      clearInterval(workspaceNodePoll);
      logStartupPhase("workspace-node-changed", startupPhaseOrigin);
      stopContainer();
      return;
    }
    firstSeenAt ??= Date.now();
    const generation = gatewayGeneration;
    // A respawn replaced the process this poll was talking to: start over.
    const superseded = () => respawning || generation !== gatewayGeneration;
    if (written === undefined) {
      const before = await openClawFileTransferState();
      if (superseded()) return;
      if (before?.refused) {
        reportFailure("GATEWAY_UNAUTHORIZED", before.reason);
        return;
      }
      if (before === undefined) {
        if (Date.now() - firstSeenAt > WORKSPACE_NODE_APPLY_TIMEOUT_MS) reportFailure("GATEWAY_UNAVAILABLE");
        return;
      }
      const previous = withWorkspaceNodeFailure("CONFIG_UNREADABLE", readOpenClawConfig);
      const next = JSON.parse(JSON.stringify(previous));
      withWorkspaceNodeFailure("FILE_TRANSFER_DENIED", () => configureWorkspaceNodePlugins(next, deviceId));
      withWorkspaceNodeFailure("NOT_HOT_APPLICABLE", () => assertHotApplicableChange(previous, next));
      withWorkspaceNodeFailure("CONFIG_UNWRITABLE", () => replaceOpenClawConfig(next));
      written = {
        deviceId,
        at: Date.now(),
        activeBefore: before.state === "active",
        generationBefore: before.generation,
      };
      return;
    }
    const after = await openClawFileTransferState();
    if (superseded()) return;
    if (after?.refused) {
      // The Gateway refuses its own CLI: it cannot confirm this node, now or later.
      reportFailure("GATEWAY_UNAUTHORIZED", after.reason);
      return;
    }
    if (
      after?.state === "active" &&
      (!written.activeBefore || after.generation !== written.generationBefore)
    ) {
      runtimeWorkspaceNodeId = deviceId;
      runtimeWorkspaceNodeFailure = undefined;
      logStartupPhase("workspace-node", written.at);
      return;
    }
    if (after?.state === "service-failed") {
      reportFailure("FILE_TRANSFER_FAILED");
    } else if (Date.now() - written.at > WORKSPACE_NODE_APPLY_TIMEOUT_MS) {
      reportFailure(after === undefined ? "GATEWAY_UNAVAILABLE" : "RELOAD_NOT_CONFIRMED");
    }
  };
  const workspaceNodePoll = setInterval(async () => {
    if (pollInFlight || respawning) return;
    pollInFlight = true;
    try {
      await pollWorkspaceNode();
    } catch (error) {
      // The next poll retries; the status carries the current cause.
      reportFailure(error instanceof WorkspaceNodeFailure ? error.code : "UNAVAILABLE");
    } finally {
      pollInFlight = false;
    }
  }, 1_000);
  workspaceNodePoll.unref?.();
}
if (followsPeerStatus) {
  let pollInFlight = false;
  const recentRespawns = [];
  const peerChanged = (current) =>
    current.startupId !== peerStatus.startupId ||
    current.podUid !== peerStatus.podUid ||
    !samePluginIds(current.successfulPluginIds, peerStatus.successfulPluginIds) ||
    !samePluginFailures(current.failures, pluginResult.failures);
  // Stop the native Gateway within its drain budget; one that outlives SIGKILL
  // leaves only the container restart.
  const stopGatewayProcess = async () => {
    if (!childRunning) return;
    child.kill("SIGTERM");
    const exited = childExited;
    const escalate = setTimeout(() => child.kill("SIGKILL"), ${GATEWAY_STOP_TIMEOUT_MS});
    escalate.unref?.();
    let giveUp;
    const stuck = new Promise((resolve) => {
      giveUp = setTimeout(() => resolve(true), ${GATEWAY_STOP_TIMEOUT_MS} + GATEWAY_RESPAWN_KILL_GRACE_MS);
      giveUp.unref?.();
    });
    const timedOut = await Promise.race([exited.then(() => false), stuck]);
    clearTimeout(escalate);
    clearTimeout(giveUp);
    if (timedOut) throw new Error("The native Gateway did not stop.");
  };
  // Serving means the new process answers its own readiness endpoint; the
  // plugin status stays "starting" until the peer is rechecked.
  const waitForGatewayServing = async () => {
    const deadline = Date.now() + GATEWAY_RESPAWN_READY_TIMEOUT_MS;
    while (childRunning && Date.now() < deadline) {
      try {
        const response = await fetch(
          "http://127.0.0.1:" + process.env.OPENCLAW_GATEWAY_PORT + "/readyz",
          { signal: AbortSignal.timeout(2_000), redirect: "error" },
        );
        if (response.status === 200 && childRunning) {
          verifyingServingReplacement = true;
          return true;
        }
      } catch {}
      await pluginRuntimeDelay(GATEWAY_RESPAWN_READY_POLL_MS);
    }
    return false;
  };
  // A changed Harness peer requires a new credential for the replacement and
  // may change the configured plugin result. Respawn only the native process:
  // the container, its volumes and runtime assets stay, and there is no kubelet
  // crash-loop backoff.
  const respawnForPeerStatus = async (current) => {
    respawning = true;
    // Mark plugin status unready before replacing the native Gateway.
    publishPluginRuntimeStatus({ phase: "starting", ...pluginResult });
    const respawnStartedAt = Date.now();
    logStartupPhase("peer-status-changed", startupPhaseOrigin);
    try {
      if (current === undefined) {
        // Unreadable status need not mean a new Harness: the same Harness
        // process coming back leaves this Gateway's credential valid.
        waitingForPeerDuringOutage = true;
        const returned = await waitForPeerPluginRuntimeStatus();
        waitingForPeerDuringOutage = false;
        if (gatewayTerminating || !childRunning) return;
        if (!peerChanged(returned)) {
          publishPluginRuntimeStatus({ phase: "ready", ...pluginResult });
          logStartupPhase("peer-status-restored", respawnStartedAt);
          return;
        }
      }
      while (recentRespawns.length > 0 && respawnStartedAt - recentRespawns[0] > GATEWAY_RESPAWN_WINDOW_MS) {
        recentRespawns.shift();
      }
      if (recentRespawns.length >= GATEWAY_RESPAWN_LIMIT) {
        throw new Error("The Harness peer changed too often to respawn the Gateway in place.");
      }
      recentRespawns.push(respawnStartedAt);
      await stopGatewayProcess();
      for (let attempt = 1; ; attempt++) {
        // Configure from the latest ready status, which may be newer than the change.
        peerStatus = await waitForPeerPluginRuntimeStatus();
        const configured = configureGateway(peerStatus);
        pluginResult = configured.pluginResult;
        if (gatewayTerminating) return;
        const spawnedAt = startGatewayProcess();
        resetWorkspaceNodeTracking(configured.workspaceNodeId, spawnedAt);
        const serving = await waitForGatewayServing();
        if (gatewayTerminating) return;
        if (serving) break;
        if (attempt >= GATEWAY_RESPAWN_ATTEMPTS) {
          throw new Error("The respawned native Gateway did not become ready.");
        }
        await stopGatewayProcess();
        await pluginRuntimeDelay(1_000 * 2 ** (attempt - 1));
      }
      // Recheck the Harness before marking the replacement ready.
      let verifiedPeer;
      try {
        verifiedPeer = await readPeerPluginRuntimeStatus();
      } catch {
        verifiedPeer = undefined;
      } finally {
        verifyingServingReplacement = false;
      }
      if (gatewayTerminating || !childRunning) return;
      if (verifiedPeer === undefined) {
        throw new Error("The Harness peer became unavailable during Gateway startup.");
      }
      if (peerChanged(verifiedPeer)) {
        logStartupPhase("peer-verification-changed", respawnStartedAt, "failed");
        throw new Error("The Harness peer changed during Gateway startup.");
      }
      publishPluginRuntimeStatus({ phase: "ready", ...pluginResult });
      logStartupPhase("gateway-respawn", respawnStartedAt);
    } catch {
      logStartupPhase("gateway-respawn", respawnStartedAt, "failed");
      stopContainer();
    } finally {
      waitingForPeerDuringOutage = false;
      verifyingServingReplacement = false;
      respawning = false;
    }
  };
  setInterval(async () => {
    if (pollInFlight || respawning || stoppingContainer) return;
    pollInFlight = true;
    try {
      let current;
      try {
        current = await readPeerPluginRuntimeStatus();
      } catch {
        current = undefined;
      }
      if (current === undefined || peerChanged(current)) {
        await respawnForPeerStatus(current);
      }
    } finally {
      pollInFlight = false;
    }
  }, 2_000).unref();
}
})().catch((error) => {
  if (!holdPluginApproverConfigurationFailure(error)) throw error;
});
}
`;

export const CODEX_OAUTH_BOOTSTRAP_ENTRYPOINT = String.raw`
try {
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.CODEX_HOME;
const expected = {
  sourceUid: process.env.OCE_CODEX_OAUTH_SOURCE_UID,
  volumeUid: process.env.OCE_CODEX_OAUTH_VOLUME_UID,
};
if (!directory || !expected.sourceUid || !expected.volumeUid) {
  throw new Error("OAuth bootstrap identity is missing.");
}
const authPath = path.join(directory, "auth.json");
const receiptPath = path.join(directory, ".oce-oauth.json");
const validAuth = (auth) => auth?.auth_mode === "chatgpt" &&
  [auth.tokens?.id_token, auth.tokens?.access_token, auth.tokens?.refresh_token]
    .every((value) => typeof value === "string" && value.trim().length > 0);
const readRegularJson = (target) =>
  fs.lstatSync(target, { throwIfNoEntry: false })?.isFile()
    ? JSON.parse(fs.readFileSync(target, "utf8"))
    : undefined;
if (fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() === false) {
  fs.rmSync(directory, { force: true });
}
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
let receipt;
try {
  receipt = readRegularJson(receiptPath);
} catch {
  // An unreadable receipt proves nothing; seeding below replaces the directory contents.
}
if (receipt?.sourceUid === expected.sourceUid) {
  if (receipt.volumeUid !== expected.volumeUid || !validAuth(readRegularJson(authPath))) {
    throw new Error("OAuth runtime credentials require reconnect.");
  }
} else {
  const auth = JSON.parse(fs.readFileSync(process.env.OCE_CODEX_OAUTH_SEED_PATH, "utf8"));
  if (!validAuth(auth)) {
    throw new Error("OAuth bootstrap credentials are invalid.");
  }
  // A new source starts from an empty Codex home: no previous login, sessions, or links.
  // rmSync removes symbolic links themselves and never follows them.
  for (const entry of fs.readdirSync(directory)) {
    fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  }
  const writeJson = (target, value) => {
    const temporary = target + ".bootstrap";
    // Exclusive creation fails on any existing path, including a planted symbolic link.
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
  };
  writeJson(authPath, auth);
  writeJson(receiptPath, expected);
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  // Readiness reports only a verified final state.
  const written = readRegularJson(receiptPath);
  if (
    !validAuth(readRegularJson(authPath)) ||
    written?.sourceUid !== expected.sourceUid ||
    written.volumeUid !== expected.volumeUid
  ) {
    throw new Error("OAuth bootstrap could not verify private credentials.");
  }
}
} catch {
  throw new Error("OAuth bootstrap could not initialize private credentials.");
}
`;

// Codex 0.158 app-server hard-codes FmtSpan::FULL on its stderr layer, so each
// instrumented call prints span "new" and "close" records, and each poll of an
// instrumented future a span "enter" and "exit" record, at the span's level:
// hundreds per turn at info (fs.read_file, fs.sandbox_*, plugins...). Unless
// RUST_LOG starts at debug or trace, the wrapper drops every span lifecycle
// record except the "new" and "close" of the codex_core::tasks "turn" span (a
// turn's start and end). Every event still passes. Two idle lines are dropped too:
// the readiness probe's loopback WebSocket connection (every 2 s), and the
// remote-control preference retry (every 1 s while Codex has no ChatGPT login),
// which is kept once per 10 minutes. On Linux, Codex warns at every session's
// network-proxy start that Unix-socket proxying is macOS-only, whatever the
// policy says; only the first such warning per app-server is kept. Codex's
// startup ERROR that no bubblewrap is on PATH is dropped: the image runs the
// bubblewrap Codex ships on purpose, because a bwrap on PATH makes Codex run a
// namespace probe that the reviewed seccomp profile denies. Codex's startup
// ERROR that project-local config is disabled until the project is trusted is
// dropped when the only folder it names is the workspace's own .codex: an empty
// one appears once any session has run, the workspace is deliberately not
// trusted, and the line is not a fault. Everything else is forwarded unchanged.
export const CODEX_STDERR_FILTER_HELPER = String.raw`
const codexVerboseLog = /^(?:debug|trace)(?:,|$)/i.test(process.env.RUST_LOG ?? "");
const CODEX_REMOTE_CONTROL_WAIT = "waiting to resolve remote control preference until authentication is available";
const CODEX_MISSING_BWRAP_WARNING = "Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.";
const CODEX_UNIX_SOCKETS_PLATFORM_WARNING = "allowUnixSockets and dangerouslyAllowAllUnixSockets are macOS-only; requests will be rejected on this platform";
const CODEX_UNTRUSTED_PROJECT_WARNING = "until the project is trusted";
const CODEX_UNTRUSTED_WORKSPACE_MESSAGE = /^Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load\.\n {4}1\. \/home\/node\/workspace\/\.codex\n {7}To load project-local config, hooks, and exec policies, add \/home\/node\/workspace as a trusted project in \S+\/config\.toml\.\n?$/;
const CODEX_STDERR_LINE_LIMIT = 65536;
let codexRemoteControlWaitAt = -Infinity;
let codexUnixSocketsPlatformWarned = false;
function codexStderrLineKept(line, now = Date.now()) {
  if (codexVerboseLog || !line.startsWith("{")) return true;
  if (
    !line.includes('"message":"new"') &&
    !line.includes('"message":"close"') &&
    !line.includes('"message":"enter"') &&
    !line.includes('"message":"exit"') &&
    !line.includes('"message":"websocket client connected"') &&
    !line.includes(CODEX_REMOTE_CONTROL_WAIT) &&
    !line.includes(CODEX_UNIX_SOCKETS_PLATFORM_WARNING) &&
    !line.includes(CODEX_MISSING_BWRAP_WARNING) &&
    !line.includes(CODEX_UNTRUSTED_PROJECT_WARNING)
  ) return true;
  let record;
  try { record = JSON.parse(line); } catch { return true; }
  if (record === null || typeof record !== "object" || record.fields === null || typeof record.fields !== "object") return true;
  const message = record.fields.message;
  if (
    (message === "new" || message === "close" || message === "enter" || message === "exit") &&
    record.span !== null &&
    typeof record.span === "object" &&
    !Array.isArray(record.span)
  ) {
    return (
      (message === "new" || message === "close") &&
      record.target === "codex_core::tasks" &&
      record.span.name === "turn"
    );
  }
  if (
    record.target === "codex_app_server_transport::transport::websocket" &&
    message === "websocket client connected" &&
    /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|\[::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}\]):\d{1,5}$/.test(String(record.fields.peer_addr))
  ) {
    return false;
  }
  if (
    record.target === "codex_app_server_transport::transport::remote_control::websocket" &&
    message === CODEX_REMOTE_CONTROL_WAIT
  ) {
    if (now - codexRemoteControlWaitAt < 600000) return false;
    codexRemoteControlWaitAt = now;
  }
  if (record.target === "codex_app_server" && message === CODEX_MISSING_BWRAP_WARNING) return false;
  if (record.target === "codex_app_server" && typeof message === "string" && CODEX_UNTRUSTED_WORKSPACE_MESSAGE.test(message)) return false;
  if (record.target === "codex_network_proxy::proxy" && message === CODEX_UNIX_SOCKETS_PLATFORM_WARNING) {
    if (codexUnixSocketsPlatformWarned) return false;
    codexUnixSocketsPlatformWarned = true;
  }
  return true;
}
// Resolves when the stream ends. A line longer than the limit is forwarded
// unfiltered as it arrives, so the wrapper never buffers without bound.
function forwardCodexStderr(stream) {
  let pending = "";
  let passthrough = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (passthrough) {
        process.stderr.write(line + "\n");
        passthrough = false;
      } else if (codexStderrLineKept(line)) {
        process.stderr.write(line + "\n");
      }
    }
    if (pending.length > CODEX_STDERR_LINE_LIMIT) {
      process.stderr.write(pending);
      pending = "";
      passthrough = true;
    }
  });
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (pending !== "" && (passthrough || codexStderrLineKept(pending))) process.stderr.write(pending);
      pending = "";
      resolve();
    };
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}
`;

export const AGENT_RUNTIME_ENTRYPOINT = String.raw`
const { createHash } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

${PLUGIN_RUNTIME_HELPERS}
${AUTH_PROBE_FAILURE_HELPER}
${CODEX_STDERR_FILTER_HELPER}
${startupPhaseHelper("agent")}

function agentRuntimeReady() {
  if (
    process.env.OPENCLAW_PLUGIN_READY_MARKER !== undefined &&
    !pluginExistsSync(process.env.OPENCLAW_PLUGIN_READY_MARKER)
  ) {
    return false;
  }
  if (pluginRuntimeStatusPort() !== undefined && pluginStatusReport.phase !== "ready") {
    return false;
  }
  let ReadinessWebSocket;
  try {
    ReadinessWebSocket = require("ws");
  } catch {
    return false;
  }
  let token = pluginBaseAppServerToken;
  try {
    if (pluginRuntimeStatusPort() !== undefined) {
      token = derivePluginAppServerToken(pluginStatusReport.startupId);
    }
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    let settled = false;
    let timeout;
    const socket = new ReadinessWebSocket(codexAppServerUrl(), {
      headers: { Authorization: "Bearer " + token },
    });
    const settle = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        if (ready) socket.close();
        else socket.terminate?.();
      } catch {}
      resolve(ready);
    };
    const onSocket = (event, listener) => {
      if (typeof socket.addEventListener === "function") socket.addEventListener(event, listener);
      else socket.on(event, listener);
    };
    timeout = setTimeout(() => settle(false), 2_000);
    onSocket("open", () => settle(true));
    onSocket("error", () => settle(false));
  });
}

startPluginRuntimeStatusServer(agentRuntimeReady);
const loginMode = process.env.CODEX_LOGIN_MODE;
const apiKey = process.env.OPENAI_API_KEY;
const accessToken = process.env.CODEX_ACCESS_TOKEN;
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
if (loginMode === "api_key") {
  if (!nonempty(apiKey) || accessToken !== undefined) {
    throw new Error("Codex API-key authentication configuration is invalid.");
  }
} else if (loginMode === "codex_pat") {
  if (!nonempty(accessToken) || apiKey !== undefined) {
    throw new Error("Codex service account token authentication configuration is invalid.");
  }
} else if (loginMode === "oauth") {
  if (apiKey !== undefined || accessToken !== undefined) {
    throw new Error("Codex OAuth authentication configuration is invalid.");
  }
} else {
  throw new Error("Codex authentication mode is missing or unsupported.");
}

const workspaceDirectory = process.env.OPENCLAW_WORKSPACE_DIR ||
  (process.env.HOME || "/home/node") + "/workspace";
if (!workspaceDirectory.startsWith("/")) {
  throw new Error("The Codex workspace directory must be an absolute path.");
}
mkdirSync(process.env.CODEX_HOME, { recursive: true });
mkdirSync(workspaceDirectory, { recursive: true });
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
      "login",
      "--with-access-token",
    ];
function codexChildEnvironment() {
  const environment = { ...process.env };
  delete environment.APP_SERVER_TOKEN;
  delete environment.APP_TOKEN_SHA;
  return environment;
}
// Codex reports provider HTTP rejections as "status 401 Unauthorized" or
// "unexpected status 403 Forbidden"; transport failures carry no status.
function codexAuthenticationRejected(message) {
  return typeof message === "string" && /\bstatus 40[13] (Unauthorized|Forbidden)\b/.test(message);
}
const loginStartedAt = Date.now();
let login;
if (loginMode === "oauth") {
  try {
    const fs = require("node:fs");
    const receipt = JSON.parse(fs.readFileSync(process.env.CODEX_HOME + "/.oce-oauth.json", "utf8"));
    const auth = JSON.parse(fs.readFileSync(process.env.CODEX_HOME + "/auth.json", "utf8"));
    const valid = receipt.sourceUid === process.env.OCE_CODEX_OAUTH_SOURCE_UID &&
      receipt.volumeUid === process.env.OCE_CODEX_OAUTH_VOLUME_UID &&
      typeof receipt.sourceUid === "string" && typeof receipt.volumeUid === "string" &&
      auth.auth_mode === "chatgpt" &&
      [auth.tokens?.id_token, auth.tokens?.access_token, auth.tokens?.refresh_token]
        .every((value) => typeof value === "string" && value.trim().length > 0);
    login = { status: valid ? 0 : 1 };
  } catch {
    login = { status: 1 };
  }
} else {
  for (let attempt = 0; attempt < 3; attempt++) {
    login = spawnSync("codex", loginArguments, {
      input: loginMode === "api_key" ? apiKey : accessToken,
      env: codexChildEnvironment(),
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 30000, killSignal: "SIGKILL", maxBuffer: 262144,
    });
    // Access-token login validates the same credential remotely before saving it.
    // A cold-node login timeout may recover; model probing has its own bounded retry.
    if (loginMode === "api_key" || login.error?.code !== "ETIMEDOUT") {
      break;
    }
  }
}
logStartupPhase("codex-login", loginStartedAt, login.status !== 0 || login.error ? "failed" : "ok");
if (login.status !== 0 || login.error) {
  holdFailedAuthentication(
    "login",
    login.error === undefined && codexAuthenticationRejected(login.stderr) ? "AUTHENTICATION_FAILED" : "LOGIN_FAILED",
  );
} else {
delete process.env.CODEX_ACCESS_TOKEN;
delete process.env.OPENAI_API_KEY;

// Codex reports an in-turn stream retry as a top-level error before retrying the
// same sampling request. Only that exact transient shape, within Codex's small
// retry budget, is recoverable; the turn must still complete successfully.
const MAX_RECOVERED_STREAM_RETRIES = 10;
function isRecoveredNativeStreamError(event) {
  if (event.type !== "error" || typeof event.message !== "string" || event.message.length > 512) return false;
  const match = /^Reconnecting\.\.\. ([1-9][0-9]?)\/([1-9][0-9]?)(?::| -)? (?:\()?stream disconnected (?:before completion|- retrying sampling request)(?:[:.)]|$)/.exec(event.message);
  if (match === null) return false;
  const attempt = Number(match[1]);
  const limit = Number(match[2]);
  if (attempt > limit || limit > MAX_RECOVERED_STREAM_RETRIES) return false;
  return !/auth|unauthori[sz]ed|forbidden|credential|api.?key|\b40[13]\b/i.test(event.message);
}

function probeCodexAuthentication(timeout) {
  let result;
  const finish = (failure) => ({
    ...(typeof failure === "string" ? { code: failure } : failure),
    exitCode: Number.isInteger(result?.status) ? result.status : null,
    signal: ["SIGKILL", "SIGTERM", "SIGINT"].includes(result?.signal) ? result.signal : null,
  });
  const temporaryDirectory = process.env.TMPDIR || "/tmp";
  const directory = mkdtempSync(temporaryDirectory.replace(/\/+$/u, "") + "/codex-auth-probe-");
  try {
    const selectedModel = process.env.OPENCLAW_HARNESS_MODEL;
    if (typeof selectedModel !== "string" || !/^(openai|codex)\/.+/.test(selectedModel)) return finish("UNAVAILABLE");
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
    result = spawnSync("codex", [
      ...disabled.flatMap((feature) => ["--disable", feature]),
      "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--skip-git-repo-check", "--json", "--sandbox", "read-only", "--cd", directory,
      "--model", selectedModel.slice(selectedModel.indexOf("/") + 1),
      "-c", "cli_auth_credentials_store=file",
      "-c", 'web_search="disabled"',
      "-c", "project_doc_max_bytes=0",
      "-c", "check_for_update_on_startup=false",
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
      timeout, killSignal: "SIGKILL", maxBuffer: 262144,
    });
    const output = result.stdout?.trim() ?? "";
    let events;
    try {
      events = output === "" ? [] : output.split("\n").map((line) => JSON.parse(line));
    } catch {
      return finish(probeFailure("INVALID_OUTPUT", "json"));
    }
    if (events.some((event) => typeof event?.type !== "string")) return finish(probeFailure("INVALID_OUTPUT", "shape"));
    // A failed turn caused by provider 401/403 is a deterministic credential
    // rejection; timeouts, 5xx, and transport errors keep their existing codes.
    if (events.some((event) => event.type === "turn.failed" && codexAuthenticationRejected(event.error?.message))) {
      return finish("AUTHENTICATION_FAILED");
    }
    const allowed = new Set(["thread.started", "turn.started", "turn.completed", "item.started", "item.updated", "item.completed"]);
    // Native item.error is advisory (for example missing catalog metadata),
    // distinct from fatal top-level error/turn.failed. Only a bounded, known
    // stream reconnect inside the single model turn may precede its completion;
    // fatal errors and tool items never satisfy this authentication check.
    let turnStarted = false;
    let turnCompleted = false;
    let recoveredStreamErrors = 0;
    for (const event of events) {
      if (event.type === "turn.started") turnStarted = true;
      if (event.type === "error") {
        if (!turnStarted || turnCompleted || !isRecoveredNativeStreamError(event) ||
          ++recoveredStreamErrors > MAX_RECOVERED_STREAM_RETRIES) return finish(probeFailure("PROBE_STATUS", "error-event"));
        continue;
      }
      if (!allowed.has(event.type) ||
        (event.type.startsWith("item.") && !["agent_message", "reasoning", "error"].includes(event.item?.type))) {
        return finish(probeFailure("PROBE_STATUS", event.type === "turn.failed" ? "turn-failed"
          : event.type.startsWith("item.") ? "tool-event" : "unexpected-event"));
      }
      if (event.type === "turn.completed") turnCompleted = true;
    }
    // A timeout cannot make an observed tool call or protocol failure retryable.
    if (result.error?.code === "ETIMEDOUT") return finish("MODEL_PROBE_TIMEOUT");
    if (result.status !== 0 || result.error) return finish(probeExitFailure(result));
    return finish(events.filter((event) => event.type === "turn.completed").length === 1 &&
      events.filter((event) => event.type === "turn.started").length === 1 &&
      events.at(-1)?.type === "turn.completed" &&
      events.some((event) => event.type === "item.completed" && event.item?.type === "agent_message" &&
        typeof event.item.text === "string" && event.item.text.trim().length > 0)
        ? undefined
        : probeFailure("PROBE_STATUS", "no-reply"));
  } catch {
    return finish(probeFailure("WRAPPER_ERROR"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// A single startup budget includes both process attempts and the retry delay.
// No signal handler is installed before app-server starts, so under tini
// SIGTERM ends the probe, its backoff or a held failure at once.
function startAuthenticatedCodex(attempt = 1, deadline = performance.now() + 61000) {
  const startedAt = performance.now();
  const timeout = Math.min(30000, Math.floor(deadline - startedAt));
  if (timeout <= 0) {
    logStartupPhase("model-probe", modelProbeStartedAt, "failed");
    holdFailedAuthentication("model-probe", "MODEL_PROBE_TIMEOUT");
    return;
  }
  const result = probeCodexAuthentication(timeout);
  console.error(JSON.stringify({
    event: "codex.model_probe",
    attempt,
    elapsedMs: Math.round(performance.now() - startedAt),
    exitCode: result.exitCode,
    signal: result.signal,
    code: result.code ?? "READY",
    cause: result.cause,
  }));
  if (result.code === "MODEL_PROBE_TIMEOUT" && attempt === 1 && performance.now() + 1000 < deadline) {
    setTimeout(() => startAuthenticatedCodex(2, deadline), 1000);
    return;
  }
  if (result.code !== undefined) {
    logStartupPhase("model-probe", modelProbeStartedAt, "failed");
    holdFailedAuthentication("model-probe", result.code, result.cause);
    return;
  }
  logStartupPhase("model-probe", modelProbeStartedAt);

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

const configuredTokenSha = process.env.APP_TOKEN_SHA;
if (configuredTokenSha !== undefined && !/^[a-f0-9]{64}$/.test(configuredTokenSha)) {
  throw new Error("Codex app-server token verifier is invalid.");
}
if (configuredTokenSha !== undefined && process.env.APP_SERVER_TOKEN !== undefined) {
  throw new Error("Codex app-server token inputs are mutually exclusive.");
}
if (pluginRuntimeStatusPort() !== undefined) {
  if (configuredTokenSha !== undefined) {
    throw new Error("Codex plugins require the app-server base token.");
  }
  process.env.APP_SERVER_TOKEN = derivePluginAppServerToken(pluginStatusReport.startupId);
}
publishRuntimeReady();
// Everything before this line delays the Codex app-server.
logStartupPhase("native-spawn", startupPhaseOrigin);
let digest = configuredTokenSha;
if (digest === undefined) {
  if (typeof process.env.APP_SERVER_TOKEN !== "string" || process.env.APP_SERVER_TOKEN.length === 0) {
    throw new Error("Codex app-server token input is missing.");
  }
  digest = createHash("sha256").update(process.env.APP_SERVER_TOKEN).digest("hex");
}
const child = spawn(
  "codex",
  [
    // The successful probe validated this model; native policy readback must see it too.
    "-c",
    "model=" + JSON.stringify(process.env.OPENCLAW_HARNESS_MODEL.slice(process.env.OPENCLAW_HARNESS_MODEL.indexOf("/") + 1)),
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
    ...(loginMode === "oauth" ? ["-c", "cli_auth_credentials_store=file"] : []),
    "app-server",
    "--listen",
    "ws://0.0.0.0:" + process.env.APP_SERVER_PORT,
    "--ws-auth",
    "capability-token",
    "--ws-token-sha256",
    digest,
  ],
  // stdout is the protocol stream; stderr passes through the span-noise filter.
  { stdio: ["inherit", "inherit", "pipe"], cwd: workspaceDirectory, env: codexChildEnvironment() },
);
forwardTermination(child);
const codexStderrDone = child.stderr ? forwardCodexStderr(child.stderr) : Promise.resolve();
child.on("exit", (code, signal) => {
  const status = code ?? (signal === "SIGTERM" ? 0 : 1);
  // Forward Codex's last lines; a descendant holding the pipe cannot delay exit
  // by more than 2 s. The unref'd timer never keeps an otherwise idle wrapper alive.
  setTimeout(() => process.exit(status), 2000).unref();
  codexStderrDone.then(() => process.exit(status));
});
(async () => {
  const pluginInstallStartedAt = Date.now();
  let pluginInstallLogged = false;
  try {
    if (pluginRuntime !== undefined) {
      const result = await installCodexPlugins(pluginRuntime);
      logStartupPhase("plugin-install", pluginInstallStartedAt);
      pluginInstallLogged = true;
      publishPluginRuntimeStatus({ phase: "ready", ...result });
    } else {
      publishPluginRuntimeStatus({ phase: "ready", successfulPluginIds: [], failures: [] });
    }
    pluginRuntimeReady();
  } catch (error) {
    // The phase line (with a fixed code) reaches the log backend; the message stays local.
    // A failure after a logged install (publishing status) is not a plugin-install failure.
    if (pluginRuntime !== undefined && !pluginInstallLogged) {
      logStartupPhase("plugin-install", pluginInstallStartedAt, "failed", error?.startupCode ?? "PLUGIN_NOT_READY");
    }
    console.error("Codex plugin runtime initialization failed: " + pluginRuntimeErrorMessage(error));
    child.kill("SIGTERM");
    process.exit(1);
  }
})();
}
const modelProbeStartedAt = Date.now();
startAuthenticatedCodex();
}
`;

// Kubernetes Codex implementation: this file-only node is not an OpenClaw
// execution worker; its explicit command allowlist disables worker hosting.
// It serves files while Codex restarts. Reuse Codex login/plugin initialization
// for each Codex start; other Harnesses need their own execution composition.
// Codex starts from bounded program pieces, like the container that runs this.
//
// A Deployment-backed Harness starts before its node setup exists and reads the
// code from OPENCLAW_NODE_SETUP_PATH, an optional Secret volume. Codex starts at
// once; the node slot starts when the file holds a complete code. The controller
// removes the code after pairing, so a later start without it reconnects with
// the saved device identity. No deadline here: the controller's convergence
// deadline governs a setup that never arrives. SandboxDriver Harnesses still
// receive OPENCLAW_NODE_SETUP_CODE in the environment.
export const AGENT_WITH_NODE_ENTRYPOINT = String.raw`
const { chmodSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { execFile, spawn, spawnSync } = require("node:child_process");
${WORKSPACE_ASSET_HELPERS}
${startupPhaseHelper("agent")}
const state = process.env.OPENCLAW_NODE_STATE_DIR;
const setupEnvironment = process.env.OPENCLAW_NODE_SETUP_CODE;
const setupPath = process.env.OPENCLAW_NODE_SETUP_PATH;
const setupEnvelopePath = process.env.OPENCLAW_NODE_SETUP_ENVELOPE;
const workspaceDirectory = process.env.OPENCLAW_WORKSPACE_DIR ||
  (process.env.HOME || "/home/node") + "/workspace";
const providerSetup = Boolean(setupEnvelopePath);
if (
  !state ||
  !workspaceDirectory.startsWith("/") ||
  [Boolean(setupEnvironment), Boolean(setupPath), providerSetup].filter(Boolean).length !== 1
) {
  throw new Error("The workspace node is not provisioned.");
}
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
const harnessPath = [
  process.env.PATH,
  runtimeHomeDirectory + "/.local/bin",
  runtimeOpenClawDirectory + "/tools/node/npm/bin",
].filter(Boolean).join(":");
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
} else if (process.env.OPENCLAW_NODE_CA_PATH) {
  nodeEnv.NODE_EXTRA_CA_CERTS = process.env.OPENCLAW_NODE_CA_PATH;
}
// The workspace belongs to the Harness. Native setup creates missing defaults
// without replacing owner edits; neither child may serve an uninitialized workspace.
const baselineStartedAt = Date.now();
const baseline = spawnSync(process.execPath, [
  "/app/openclaw.mjs", "setup", "--baseline", "--workspace", workspaceDirectory, "--json",
], { env: nodeEnv, stdio: "inherit" });
logStartupPhase("workspace-baseline", baselineStartedAt, baseline.error || baseline.status !== 0 ? "failed" : "ok");
if (baseline.error) throw baseline.error;
if (baseline.status !== 0) throw new Error("Workspace initialization failed.");
const codexEnv = { ...process.env, PATH: harnessPath };
// Per-run hook capabilities are delivered by the authenticated app-server connection.
// Keep them outside the model workspace and the file-transfer plugin's roots.
const hookDirectory = join(process.env.HOME, ${JSON.stringify(NATIVE_HOOK_CREDENTIAL_DIRECTORY)});
// Hook commands call the Gateway route; they trust the CA the node uses. A SandboxDriver
// delivers that CA as a file (OPENCLAW_NODE_CA_PATH) instead of the PEM variable.
let gatewayCa = process.env.OPENCLAW_NODE_CA_PEM || "";
if (!gatewayCa && process.env.OPENCLAW_NODE_CA_PATH) {
  try {
    gatewayCa = readFileSync(process.env.OPENCLAW_NODE_CA_PATH, "utf8").trim();
  } catch (error) {
    console.error("Codex hook commands start without the Gateway CA: " + (error.code || "unreadable"));
  }
}
let hookCa = "";
if (gatewayCa) {
  const inheritedCa = process.env.NODE_EXTRA_CA_CERTS
    ? readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8")
    : "";
  hookCa = [inheritedCa, gatewayCa].filter(Boolean).join("\n");
  codexEnv.NODE_EXTRA_CA_CERTS = join(hookDirectory, "gateway-ca.pem");
}
// Harness code runs as this user and can replace the directory, for example with a
// symlink into the workspace, and on OpenShell HOME survives restarts. Each Codex start
// removes whatever is there (a link itself, never its target) and creates a fresh 0700
// directory; the CA copy is created exclusively, so it never follows a link. Credentials
// left there belong to the previous Codex process's relays; the Gateway writes a new one
// for each new or resumed run.
function prepareHookDirectory() {
  rmSync(hookDirectory, { recursive: true, force: true });
  mkdirSync(hookDirectory, { mode: 0o700 });
  chmodSync(hookDirectory, 0o700);
  if (hookCa) {
    writeFileSync(join(hookDirectory, "gateway-ca.pem"), hookCa, { mode: 0o600, flag: "wx" });
  }
}
delete codexEnv.OPENCLAW_NODE_SETUP_CODE;
delete codexEnv.OPENCLAW_NODE_SETUP_PATH;
delete codexEnv.OPENCLAW_NODE_SETUP_ENVELOPE;
delete codexEnv.OPENCLAW_NODE_CA_PEM;
delete codexEnv.OPENCLAW_NODE_CA_PATH;
delete codexEnv.OPENCLAW_NODE_STATE_DIR;
delete codexEnv.OPENCLAW_WORKSPACE_BOOTSTRAP;
delete codexEnv.OPENCLAW_NODE_DISPLAY_NAME;
// The node saves its first display name (the first Pod's host name) and reuses
// it across revisions unless told otherwise; the controller names it after the Agent.
const nodeDisplayName = process.env.OPENCLAW_NODE_DISPLAY_NAME;
const nodeCommands = [
  ...(nodeDisplayName ? ["--display-name", nodeDisplayName] : []),
  "--commands", "file.fetch,file.stat,file.write,file.create,dir.list,workspace.memory,workspace.skills",
];
// The kubelet swaps Secret volume contents atomically, but an empty, truncated
// or otherwise undecodable code is treated as absent and never started.
// Provider snapshots can change after setup renewal. Refresh the cached value
// whenever the projection is readable and retain the latest complete snapshot
// as a fallback while the projection is temporarily absent.
let cachedProviderSetupCode;
function readSetupCode() {
  if (setupEnvironment) return setupEnvironment;
  if (providerSetup) {
    try {
      const payload = JSON.parse(readFileSync(setupEnvelopePath, "utf8"));
      if (
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        typeof payload.bootstrapToken !== "string" ||
        payload.bootstrapToken.length === 0
      ) {
        return undefined;
      }
      cachedProviderSetupCode = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      return cachedProviderSetupCode;
    } catch {
      return cachedProviderSetupCode;
    }
  }
  let code;
  try {
    code = readFileSync(setupPath, "utf8").trim();
  } catch {
    return undefined;
  }
  const encoded = code.toLowerCase().startsWith("oc-pair://") ? code.slice("oc-pair://".length) : code;
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? code : undefined;
  } catch {
    return undefined;
  }
}
// "unknown" until checked; pairing can create the identity, so a start with a
// code resets it. Only a missing code triggers the check. A failed or timed-out
// probe (CPU contention while Codex starts) is not proof of absence, and a later
// start may need the identity after the controller removed the code, so any
// result other than "present" is re-checked with a bounded backoff.
let savedIdentity = "unknown";
let identityRetryAt = 0;
let identityBackoff = 2_000;
function checkSavedIdentity() {
  savedIdentity = "checking";
  execFile(process.execPath, ["/app/openclaw.mjs", "node", "identity", "--json"],
    { env: nodeEnv, timeout: 30_000 }, (error, stdout) => {
      let deviceId;
      try { deviceId = JSON.parse(stdout).deviceId; } catch {}
      if (!error && /^[a-f0-9]{64}$/u.test(deviceId ?? "")) {
        savedIdentity = "present";
        return;
      }
      savedIdentity = "unknown";
      identityRetryAt = Date.now() + identityBackoff;
      identityBackoff = Math.min(identityBackoff * 2, 30_000);
    });
}
let nodeSetupWait;
function nodeArguments() {
  const code = readSetupCode();
  if (code !== undefined) {
    savedIdentity = "unknown";
    identityRetryAt = 0;
    identityBackoff = 2_000;
    return ["/app/openclaw.mjs", "node", "run", "--pair-if-needed", code, ...nodeCommands];
  }
  if (savedIdentity === "present") return ["/app/openclaw.mjs", "node", "run", ...nodeCommands];
  if (savedIdentity === "unknown" && Date.now() >= identityRetryAt) checkSavedIdentity();
  return undefined;
}
const processes = [
  { name: "workspace node", args: nodeArguments, env: nodeEnv },
  {
    name: "Codex",
    args: ${JSON.stringify(["-e", ...nodeProgramArguments(AGENT_RUNTIME_ENTRYPOINT)])},
    env: codexEnv,
    prepare: prepareHookDirectory,
  },
];
let stopping = false;
// An OpenShell Sandbox reports EPERM for a group left with only zombies, as Darwin
// does. Signal the child itself then; a supervisor crash would end node retries.
function killGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if (error.code === "EPERM") child.kill(signal);
    else if (error.code !== "ESRCH") throw error;
  }
}
function start(slot) {
  if (stopping) return;
  const args = typeof slot.args === "function" ? slot.args() : slot.args;
  if (args === undefined) {
    slot.timer = setTimeout(() => start(slot), 250);
    return;
  }
  if (typeof slot.args === "function" && nodeSetupWait !== undefined) {
    logStartupPhase("node-setup", nodeSetupWait);
    nodeSetupWait = undefined;
  }
  try {
    slot.prepare?.();
    slot.prepareDelay = undefined;
  } catch (error) {
    slot.prepareDelay = Math.min((slot.prepareDelay ?? 500) * 2, 30_000);
    console.error(slot.name + " start preparation failed: " + (error.code || "error"));
    slot.timer = setTimeout(() => start(slot), slot.prepareDelay);
    return;
  }
  const child = spawn(process.execPath, args, {
    env: slot.env, stdio: "inherit", detached: true,
  });
  slot.child = child;
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    slot.child = undefined;
    if (stopping) {
      if (processes.every((entry) => !entry.child)) process.exit(0);
    } else {
      slot.timer = setTimeout(() => start(slot), 1_000);
    }
  }
  child.on("error", () => {
    console.error(slot.name + " failed to start.");
    finish();
  });
  child.on("exit", () => {
    // The Codex wrapper may exit after plugin failure while its app-server is
    // still shutting down. Retire that group before starting another wrapper.
    killGroup(child, "SIGKILL");
    finish();
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
logStartupPhase("supervisor-spawn", startupPhaseOrigin);
nodeSetupWait = Date.now();
// Codex first: it does not wait for the node setup.
for (const slot of [...processes].reverse()) start(slot);
`;

export const NATIVE_WORKER_ENTRYPOINT = String.raw`
const { join } = require("node:path");
const { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { execFile, spawn } = require("node:child_process");
const { createServer: readinessCreateServer } = require("node:http");
${WORKSPACE_ASSET_HELPERS}
${RUNTIME_READINESS_SERVER_HELPER}

function publishRuntimeFailure() {}
function serveHeldRuntimeFailureToTransportPeer() {}
${OPENCLAW_AUTH_PROBE_HELPERS}

const inferenceConfig = process.env.OPENCLAW_NATIVE_INFERENCE_CONFIG;
const state = process.env.OPENCLAW_NODE_STATE_DIR;
const setupCode = process.env.OPENCLAW_NODE_SETUP_CODE;
const workspace = process.env.OPENCLAW_WORKSPACE_DIR;
const temporary = process.env.TMPDIR;
const workerCapacity = Number(process.env.OPENCLAW_NATIVE_WORKER_CAPACITY);
if (
  !inferenceConfig ||
  !state ||
  !setupCode ||
  !workspace?.startsWith("/") ||
  !temporary ||
  !Number.isSafeInteger(workerCapacity) ||
  workerCapacity < 1 ||
  workerCapacity > 1024
) {
  throw new Error("Dedicated OpenClaw worker configuration is invalid.");
}

function nativeWorkerReady() {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["/app/openclaw.mjs", "node", "identity", "--json"],
      {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
        },
        encoding: "utf8",
        timeout: 2_000,
      },
      (error, stdout) => {
        if (error !== null) {
          resolve(false);
          return;
        }
        let deviceId;
        try {
          deviceId = JSON.parse(stdout).deviceId;
        } catch {
          resolve(false);
          return;
        }
        resolve(typeof deviceId === "string" && /^[a-f0-9]{64}$/u.test(deviceId));
      },
    );
  });
}

startRuntimeReadinessServer(nativeWorkerReady);
mkdirSync(temporary, { recursive: true, mode: 0o700 });
chmodSync(temporary, 0o700);
initializeRuntimeAssets();
const authenticationFailure = probeOpenClawAuthenticationFailure();
if (authenticationFailure !== undefined) {
  holdFailedAuthentication("model-probe", authenticationFailure.code, authenticationFailure.cause);
} else {
mkdirSync(state, { recursive: true });
const workerConfigPath = join(state, "openclaw.json");
writeFileSync(workerConfigPath, JSON.stringify({
  ...JSON.parse(inferenceConfig),
  agents: { defaults: { workspace } },
  plugins: {
    allow: ["file-transfer"],
    slots: { memory: "none" },
    entries: { "file-transfer": { enabled: true } },
  },
  nodeHost: {
    workerRuns: {
      enabled: true,
      capacity: workerCapacity,
      isolation: "none",
    },
    skills: { enabled: false },
  },
}), { mode: 0o600 });
delete process.env.OPENCLAW_NATIVE_INFERENCE_CONFIG;
delete process.env.OPENCLAW_HARNESS_PROBE_CONFIG;
const nodeEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: workerConfigPath,
};
if (process.env.OPENCLAW_NODE_CA_PEM) {
  const caPath = join(state, "gateway-ca.pem");
  const inheritedCa = process.env.NODE_EXTRA_CA_CERTS
    ? readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8")
    : "";
  writeFileSync(
    caPath,
    [inheritedCa, process.env.OPENCLAW_NODE_CA_PEM].filter(Boolean).join("\n"),
    { mode: 0o600 },
  );
  nodeEnv.NODE_EXTRA_CA_CERTS = caPath;
}
const connectTargetPath = join(state, "connect-target");
writeFileSync(connectTargetPath, setupCode, { mode: 0o600 });
const child = spawn(
  process.execPath,
  [
    "/app/openclaw.mjs",
    "connect",
    "--target-file",
    connectTargetPath,
    "--ephemeral",
    "--display-name",
    "OpenClaw Enterprise native worker",
  ],
  { stdio: "inherit", env: nodeEnv },
);
let terminating = false;
const stop = (signal) => {
  if (terminating) return;
  terminating = true;
  child.kill(signal);
  setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)));
}
`;

// Docker Compute runs the remaining Codex readiness program as a healthcheck.
// It emits only a fixed-vocabulary reason when the container is unready.
const READINESS_FAILURE_HELPER = String.raw`
const { writeSync: readinessWriteSync } = require("node:fs");
const readinessHttp = require("node:http");
let readinessFailing = false;
function readinessExit(reason) {
  try {
    readinessWriteSync(1, reason + "\n");
  } catch {}
  process.exit(1);
}
function readinessToken(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value)
    ? value
    : undefined;
}
function readinessErrorCode(error) {
  return readinessToken(error?.code) ?? readinessToken(error?.error?.code) ?? "request failed";
}
// A wrapper that holds a failed startup check (a rejected model credential, for
// example) publishes its fixed check name and code in runtime status: add them.
function readinessFail(reason) {
  if (readinessFailing) return;
  readinessFailing = true;
  const port = process.env.OPENCLAW_RUNTIME_STATUS_PORT;
  if (port === undefined) readinessExit(reason);
  const request = readinessHttp.get(
    { host: "127.0.0.1", port, path: "/openclaw/runtime/status", timeout: 500 },
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) readinessExit(reason);
      });
      response.on("end", () => {
        let failure;
        try {
          failure = JSON.parse(body).runtimeFailure;
        } catch {}
        const check = readinessToken(failure?.check);
        const code = readinessToken(failure?.code);
        readinessExit(
          check === undefined || code === undefined
            ? reason
            : reason + "; startup check " + check + " failed with " + code,
        );
      });
    },
  );
  request.on("timeout", () => request.destroy());
  request.on("error", () => readinessExit(reason));
}
`;

// Reads the plugin runtime status over Pod loopback, then calls ready(status).
const READINESS_PLUGIN_STATUS_HELPER = String.raw`
function checkPluginStatus(ready) {
  const request = readinessHttp.get(
    "http://127.0.0.1:" + process.env.OPENCLAW_PLUGIN_STATUS_PORT + "/openclaw/plugin-runtime/status",
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) readinessExit("plugin runtime status response is too large");
      });
      response.on("end", () => {
        let status;
        try {
          status = JSON.parse(body);
        } catch {
          readinessFail("plugin runtime status returned HTTP " + response.statusCode + " without JSON");
          return;
        }
        if (response.statusCode !== 200) {
          readinessFail("plugin runtime status returned HTTP " + response.statusCode);
          return;
        }
        if (status?.phase !== "ready") {
          readinessFail("plugin runtime phase is " + (readinessToken(status?.phase) ?? "unknown"));
          return;
        }
        ready(status);
      });
    },
  );
  request.on("error", (error) =>
    readinessFail("plugin runtime status unavailable: " + readinessErrorCode(error)),
  );
}
`;

export const AGENT_READINESS_ENTRYPOINT = String.raw`
${READINESS_FAILURE_HELPER}
${READINESS_PLUGIN_STATUS_HELPER}
let readinessWaitingFor = "plugin runtime status";
const timeout = setTimeout(
  () => readinessExit("no answer from " + readinessWaitingFor + " within 2s"),
  2_000,
);
const { existsSync } = require("node:fs");
const { createHmac } = require("node:crypto");
${PLUGIN_APP_SERVER_TOKEN_DERIVATION_HELPER}
let ReadinessWebSocket;
try {
  ReadinessWebSocket = require("ws");
} catch {}
function derivedToken(startupId) {
  try {
    return derivePluginAppServerTokenFromBase(
      process.env.APP_SERVER_TOKEN,
      process.env.OPENCLAW_AGENT_REVISION_ID,
      startupId,
    );
  } catch {
    readinessExit("Codex app-server token inputs are invalid");
  }
}
function checkWebSocket(token) {
  readinessWaitingFor = "the Codex app-server WebSocket";
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
  onSocket("error", (error) =>
    readinessFail("Codex app-server WebSocket unavailable: " + readinessErrorCode(error)),
  );
}
if (
  process.env.OPENCLAW_PLUGIN_READY_MARKER !== undefined &&
  !existsSync(process.env.OPENCLAW_PLUGIN_READY_MARKER)
) {
  readinessFail("plugin ready marker is missing");
} else if (ReadinessWebSocket === undefined) {
  readinessExit("WebSocket client module is unavailable");
} else if (process.env.OPENCLAW_PLUGIN_STATUS_PORT === undefined) {
  checkWebSocket(process.env.APP_SERVER_TOKEN);
} else {
  checkPluginStatus((status) => checkWebSocket(derivedToken(status.startupId)));
}
`;
