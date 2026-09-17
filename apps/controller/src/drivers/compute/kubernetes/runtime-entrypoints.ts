import { PLUGIN_RUNTIME_TRANSLATOR_SOURCE } from "../../plugin/runtime-translator.ts";

export const PLUGIN_RUNTIME_HELPERS = String.raw`
const pluginRuntimeTranslator = (${PLUGIN_RUNTIME_TRANSLATOR_SOURCE})();
const {
  dirname: pluginDirname,
  resolve: pluginResolve,
} = require("node:path");
const {
  mkdirSync: pluginMkdirSync,
  existsSync: pluginExistsSync,
  readFileSync: pluginReadFileSync,
  writeFileSync: pluginWriteFileSync,
} = require("node:fs");
const { spawnSync: pluginSpawnSync } = require("node:child_process");

const CODEX_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS = Number(process.env.OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS ?? "10000");
const CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS = Number(process.env.OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS ?? "60000");
const PLUGIN_RECEIPT_DIRECTORY_ENV = "OCC_PLUGIN_RECEIPT_DIRECTORY";
const PLUGIN_RECEIPT_GATE_ENV = "OCC_PLUGIN_RECEIPT_GATE";
const PLUGIN_RECEIPT_POD_UID_ENV = "OCC_PLUGIN_RECEIPT_POD_UID";
const PLUGIN_RECEIPT_FILE = "diagnosis.json";
const PLUGIN_TERMINATION_LOG = "/dev/termination-log";
const PLUGIN_RECEIPT_BIND_DEADLINE_MS = Number(process.env.OCC_PLUGIN_RECEIPT_BIND_DEADLINE_MS ?? "180000");
const PLUGIN_DIAGNOSTIC_CODES = new Set(["PLUGIN_INSTALL_FAILED", "PLUGIN_AUTH_REQUIRED"]);

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
  if (runtime.manifest?.kind === "codex" && Object.keys(runtime.manifest.selections ?? {}).length > 0) {
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

function pluginReceiptContext(container) {
  const directory = process.env[PLUGIN_RECEIPT_DIRECTORY_ENV];
  const gate = process.env[PLUGIN_RECEIPT_GATE_ENV];
  const podUid = process.env[PLUGIN_RECEIPT_POD_UID_ENV];
  if (directory === undefined && gate === undefined && podUid === undefined) return undefined;
  requireNonEmptyString(directory, "Plugin receipt directory");
  requireNonEmptyString(gate, "Plugin receipt gate");
  requireNonEmptyString(podUid, "Plugin receipt Pod UID");
  requireNonEmptyString(container, "Plugin receipt container");
  return {
    container,
    podUid,
    latch: safeRuntimePath(directory, PLUGIN_RECEIPT_FILE),
    gate,
  };
}

function readJsonFile(path, description) {
  try {
    return JSON.parse(pluginReadFileSync(path, "utf8"));
  } catch {
    throw new Error(description + " is unavailable.");
  }
}

function pluginRuntimeSyncDelay(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writePluginTerminationDiagnostic(diagnostic) {
  const encoded = JSON.stringify(diagnostic);
  if (Buffer.byteLength(encoded, "utf8") >= 4096) {
    throw new Error("Plugin diagnostic exceeds the termination-message limit.");
  }
  pluginWriteFileSync(PLUGIN_TERMINATION_LOG, encoded, { mode: 0o600 });
}

function persistPluginDiagnostic(receipt, diagnostic) {
  if (receipt === undefined) return;
  const valid = pluginDiagnostic(diagnostic.pluginId, diagnostic.code);
  pluginMkdirSync(pluginDirname(receipt.latch), { recursive: true });
  pluginWriteFileSync(receipt.latch, JSON.stringify(valid), { mode: 0o600 });
  writePluginTerminationDiagnostic(valid);
}

function failWithPluginDiagnostic(receipt, diagnostic, message) {
  persistPluginDiagnostic(receipt, diagnostic);
  throw new PluginTerminalDiagnosticError(pluginDiagnostic(diagnostic.pluginId, diagnostic.code), message);
}

function checkPluginReceiptBeforeInstall(container) {
  const receipt = pluginReceiptContext(container);
  if (receipt === undefined) return undefined;
  const deadline = Date.now() + PLUGIN_RECEIPT_BIND_DEADLINE_MS;
  for (;;) {
    if (pluginExistsSync(receipt.latch)) {
      const diagnostic = readJsonFile(receipt.latch, "Plugin receipt latch");
      if (!isPluginDiagnostic(diagnostic)) {
        throw new Error("Plugin receipt latch is invalid.");
      }
      persistPluginDiagnostic(receipt, diagnostic);
      throw new PluginTerminalDiagnosticError(diagnostic, "Plugin installation already failed.");
    }
    const gate = readJsonFile(receipt.gate, "Plugin receipt gate");
    if (!isPlainObject(gate) || typeof gate.container !== "string" || gate.container !== container) {
      throw new Error("Plugin receipt gate does not match the runtime container.");
    }
    if (gate.phase === "pending") {
      if (gate.podUid === receipt.podUid) return receipt;
      if (typeof gate.podUid === "string" && gate.podUid.length > 0) {
        throw new Error("Plugin receipt gate does not match the runtime Pod.");
      }
      if (Date.now() >= deadline) {
        throw new Error("Plugin receipt gate was not bound to the runtime Pod.");
      }
      pluginRuntimeSyncDelay(250);
      continue;
    }
    if (gate.phase === "failed") {
      if (isPluginDiagnostic(gate.diagnostic)) {
        failWithPluginDiagnostic(receipt, gate.diagnostic, "Plugin installation already failed.");
      }
      throw new Error("Plugin receipt gate is failed.");
    }
    if (gate.phase === "succeeded") return undefined;
    throw new Error("Plugin receipt gate phase is invalid.");
  }
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

function assertNoOpenClawPluginConfigConflict(base, overlay) {
  const baseEntries = objectAtPath(base, ["plugins", "entries"]);
  const overlayEntries = objectAtPath(overlay, ["plugins", "entries"]);
  if (overlayEntries === undefined) return;
  for (const pluginId of Object.keys(overlayEntries)) {
    if (pluginId === "codex") continue;
    if (
      baseEntries?.[pluginId] !== undefined &&
      JSON.stringify(baseEntries[pluginId]) !== JSON.stringify(overlayEntries[pluginId])
    ) {
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

function mergeOpenClawPluginConfiguration(base, overlay) {
  assertNoOpenClawPluginConfigConflict(base, overlay);
  const next = mergeConfig(base, overlay);
  const baseAllow = Array.isArray(base?.tools?.alsoAllow) ? base.tools.alsoAllow : [];
  const overlayAllow = Array.isArray(overlay?.tools?.alsoAllow) ? overlay.tools.alsoAllow : [];
  if (overlayAllow.length > 0) {
    next.tools = isPlainObject(next.tools) ? next.tools : {};
    next.tools.alsoAllow = [
      ...baseAllow,
      ...overlayAllow.filter((tool) => !baseAllow.includes(tool)),
    ];
  }
  return next;
}

function openClawPluginConfiguration(runtime) {
  if (runtime.manifest?.kind === "openclaw") {
    return pluginRuntimeTranslator.openClawRuntimeArtifact(runtime.manifest.selections ?? {}).configuration;
  }
  if (runtime.manifest?.kind === "codex") {
    return pluginRuntimeTranslator.codexOpenClawConfiguration(runtime.manifest.selections ?? {});
  }
  return undefined;
}

function applyOpenClawPluginConfiguration(runtime) {
  const overlay = openClawPluginConfiguration(runtime);
  if (overlay === undefined) return;
  writeOpenClawConfig(mergeOpenClawPluginConfiguration(readOpenClawConfig(), overlay));
}

function assertConfigContainsOverlay(base, overlay, path) {
  if (isPlainObject(overlay)) {
    if (!isPlainObject(base)) throw new Error("OpenClaw plugin effective config is missing an object.");
    for (const [key, value] of Object.entries(overlay)) {
      assertConfigContainsOverlay(base[key], value, path === undefined ? key : path + "." + key);
    }
    return;
  }
  if (path === "tools.alsoAllow" && Array.isArray(base) && Array.isArray(overlay)) {
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

function installOpenClawPlugins(runtime, receipt) {
  const artifact =
    runtime.manifest?.kind === "openclaw"
      ? pluginRuntimeTranslator.openClawRuntimeArtifact(runtime.manifest.selections ?? {})
      : { installs: [] };
  const installs = artifact.installs ?? [];
  applyOpenClawPluginConfiguration(runtime);
  for (const plugin of installs) {
    const spec = openClawPluginPackageSpec(plugin);
    try {
      runOpenClaw(
        ["plugins", "install", spec, "--pin", "--force"],
        "OpenClaw plugin install",
        pluginDiagnostic(plugin.pluginId, "PLUGIN_INSTALL_FAILED"),
      );
    } catch (error) {
      if (isPluginTerminalDiagnosticError(error)) {
        persistPluginDiagnostic(receipt, error.diagnostic);
      }
      throw error;
    }
  }
  if (installs.length > 0) {
    runOpenClawJson(["plugins", "registry", "--refresh", "--json"], "OpenClaw plugin registry refresh");
  }
  applyOpenClawPluginConfiguration(runtime);
  const overlay = openClawPluginConfiguration(runtime);
  if (overlay !== undefined) {
    assertConfigContainsOverlay(readOpenClawConfig(), overlay);
  }
  for (const plugin of installs) {
    verifyOpenClawPluginInstall(plugin);
  }
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
      // Codex 0.152.1's app-server protocol uses id plus exactly one of
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
  const response = await codexAppServerRequest("config/read", {});
  return response?.config;
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

async function installCodexSelectionSet(selections) {
  if (Object.keys(selections).length === 0) return;
  const listed = await codexAppServerRequest("plugin/list", {});
  const readParamsList = pluginRuntimeTranslator.codexReadParamsForSelections(selections, listed);
  if (readParamsList.length === 0) return;
  const resolvedDetails = [];
  for (const readParams of readParamsList) {
    resolvedDetails.push(await codexAppServerRequest("plugin/read", readParams));
  }
  const resolvedArtifact = pluginRuntimeTranslator.codexRuntimeArtifact(selections, resolvedDetails);
  await writeCodexAppConfiguration(resolvedArtifact.configuration);
  for (const readParams of readParamsList) {
    const selectedPlugin = resolvedArtifact.installs.find(
      (candidate) => candidate.remotePluginId === readParams.pluginName,
    );
    let install;
    try {
      install = await codexAppServerRequest("plugin/install", readParams);
    } catch (error) {
      if (
        error instanceof CodexAppServerRequestError &&
        error.method === "plugin/install" &&
        selectedPlugin !== undefined
      ) {
        throw new PluginTerminalDiagnosticError(
          pluginDiagnostic(selectedPlugin.pluginId, "PLUGIN_INSTALL_FAILED"),
          "Codex plugin installation failed.",
        );
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
        throw new PluginTerminalDiagnosticError(
          pluginDiagnostic(selectedPlugin.pluginId, "PLUGIN_AUTH_REQUIRED"),
          "Codex plugin installation requires connector authentication.",
        );
      }
      throw new Error("Codex plugin installation requires connector authentication.");
    }
  }
  const installedDetails = [];
  for (const readParams of readParamsList) {
    installedDetails.push(await codexAppServerRequest("plugin/read", readParams));
  }
  const installedArtifact = pluginRuntimeTranslator.codexRuntimeArtifact(selections, installedDetails);
  if (JSON.stringify(installedArtifact.installs) !== JSON.stringify(resolvedArtifact.installs)) {
    throw new Error("Codex plugin installed release metadata does not match startup resolution.");
  }
  if (JSON.stringify(installedArtifact.configuration) !== JSON.stringify(resolvedArtifact.configuration)) {
    throw new Error("Codex plugin installed app mapping does not match startup resolution.");
  }
  for (const plugin of resolvedArtifact.installs) {
    const readParams = readParamsList.find((candidate) => candidate.pluginName === plugin.remotePluginId);
    if (readParams === undefined) {
      throw new Error("Codex plugin installed identity does not match the selected catalog entry.");
    }
    const detail = installedDetails[readParamsList.indexOf(readParams)];
    verifyCodexPluginDetail(plugin, readParams, detail);
  }
  assertConfigContainsOverlay(await readCodexAppConfiguration(), resolvedArtifact.configuration);
}

async function installCodexPlugins(runtime, receipt) {
  assertCodexPluginRuntime(runtime);
  const selections = runtime.manifest.selections ?? {};
  const deadline = Date.now() + CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await installCodexSelectionSet(selections);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (isPluginTerminalDiagnosticError(error)) {
        persistPluginDiagnostic(receipt, error.diagnostic);
        throw error;
      }
      await pluginRuntimeDelay(250);
    }
  }
  if (lastError !== undefined) {
    throw new Error("Codex plugin installation did not reach readiness: " + pluginRuntimeErrorMessage(lastError));
  }
}
`;

const AUTH_PROBE_FAILURE_HELPER = String.raw`
function holdFailedAuthentication() {
  console.error("Harness model authentication probe failed.");
  // Hold unready until an explicit restart; readiness polls never submit model calls.
  setInterval(() => {}, 3600000);
}
`;

// The native probe disables tools and fallback and performs a bounded model turn.
// Its JSON status, not its process exit status alone, establishes provider acceptance.
const OPENCLAW_AUTH_PROBE_HELPERS = String.raw`
${AUTH_PROBE_FAILURE_HELPER}
function probeOpenClawAuthentication() {
  const fs = require("node:fs");
  const { spawnSync } = require("node:child_process");
  const directory = fs.mkdtempSync("/tmp/openclaw-auth-probe-");
  try {
    const model = process.env.OPENCLAW_HARNESS_MODEL;
    if (typeof model !== "string" || !model.startsWith("openai/") || !process.env.OPENAI_API_KEY?.trim()) return false;
    const configuration = JSON.parse(process.env.OPENCLAW_HARNESS_PROBE_CONFIG);
    if (configuration.agents?.defaults?.model !== model) return false;
    configuration.agents.defaults.workspace = directory + "/workspace";
    fs.mkdirSync(directory + "/workspace", { mode: 0o700 });
    const configPath = directory + "/openclaw.json";
    fs.writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
    const result = spawnSync("node", [
      "/app/openclaw.mjs", "models", "status", "--json", "--probe",
      "--probe-provider", "openai", "--probe-concurrency", "1",
      "--probe-timeout", "15000", "--probe-max-tokens", "16",
    ], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        OPENCLAW_STATE_DIR: directory + "/state",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000, killSignal: "SIGKILL", maxBuffer: 262144,
    });
    if (result.status !== 0 || result.error) return false;
    const results = JSON.parse(result.stdout).auth?.probes?.results;
    return Array.isArray(results) && results.length === 1 &&
      results[0].provider === "openai" && results[0].model === model &&
      results[0].source === "env" && results[0].status === "ok";
  } catch {
    return false;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
`;

export const GATEWAY_RUNTIME_ENTRYPOINT = String.raw`
const { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");

${PLUGIN_RUNTIME_HELPERS}
${OPENCLAW_AUTH_PROBE_HELPERS}

const gatewayPluginReceipt = checkPluginReceiptBeforeInstall("gateway");
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

function publishDedicatedGatewayRuntimeAssets() {
  publishImageTree("/app/skills", runtimeAssetsDirectory + "/bundled-skills", true);
  publishImageTree("/app/plugin-skills", runtimeAssetsDirectory + "/plugin-skills", false);
}

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

if (process.env.OPENCLAW_HARNESS_PROBE_CONFIG !== undefined && !probeOpenClawAuthentication()) {
  holdFailedAuthentication();
} else {
mkdirSync("/home/node/.openclaw", { recursive: true });
mkdirSync("/home/node/workspace", { recursive: true });
if (process.env.OPENCLAW_WORKSPACE_DIR !== undefined) {
  mkdirSync(process.env.OPENCLAW_WORKSPACE_DIR, { recursive: true });
  publishDedicatedGatewayRuntimeAssets();
}
delete process.env.OPENCLAW_LOG_LEVEL;
const pluginRuntime = readGatewayPluginRuntime();
if (pluginRuntime !== undefined) {
  installOpenClawPlugins(pluginRuntime, gatewayPluginReceipt);
}
const child = spawn(
  "node",
  ["/app/openclaw.mjs", "gateway", "--port", process.env.OPENCLAW_GATEWAY_PORT],
  { stdio: "inherit" },
);
forwardTermination(child);
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)));
}
`;

export const AGENT_RUNTIME_ENTRYPOINT = String.raw`
const { createHash } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

${PLUGIN_RUNTIME_HELPERS}
${AUTH_PROBE_FAILURE_HELPER}

const agentPluginReceipt = checkPluginReceiptBeforeInstall("agent");
const loginMode = process.env.CODEX_LOGIN_MODE;
const apiKey = process.env.OPENAI_API_KEY;
const accessToken = process.env.CODEX_ACCESS_TOKEN;
const workspaceId = process.env.CODEX_CHATGPT_WORKSPACE_ID;
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
if (loginMode === "api_key") {
  if (!nonempty(apiKey) || accessToken !== undefined || workspaceId !== undefined) {
    throw new Error("Codex API-key authentication configuration is invalid.");
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
      "-c",
      "forced_chatgpt_workspace_id=" + JSON.stringify(workspaceId),
      "login",
      "--with-access-token",
    ];
const login = spawnSync("codex", loginArguments, {
  input: loginMode === "api_key" ? apiKey : accessToken,
  encoding: "utf8",
  stdio: ["pipe", "ignore", "pipe"],
  timeout: 30000, killSignal: "SIGKILL", maxBuffer: 262144,
});
if (login.status !== 0 || login.error) {
  holdFailedAuthentication();
} else {
delete process.env.CODEX_ACCESS_TOKEN;
delete process.env.OPENAI_API_KEY;
delete process.env.CODEX_CHATGPT_WORKSPACE_ID;

function probeCodexAuthentication() {
  const directory = mkdtempSync("/tmp/codex-auth-probe-");
  try {
    const selectedModel = process.env.OPENCLAW_HARNESS_MODEL;
    if (typeof selectedModel !== "string" || !/^(openai|codex)\/.+/.test(selectedModel)) return false;
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
      env: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: process.env.CODEX_HOME, RUST_LOG: "error" },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000, killSignal: "SIGKILL", maxBuffer: 262144,
    });
    if (result.status !== 0 || result.error) return false;
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const allowed = new Set(["thread.started", "turn.started", "turn.completed", "item.started", "item.updated", "item.completed"]);
    // Native item.error is an advisory (for example missing catalog metadata),
    // distinct from fatal top-level error/turn.failed. A completed model turn is
    // still required; no tool item can satisfy this authentication check.
    if (events.some((event) => !allowed.has(event.type) ||
      (event.type.startsWith("item.") && !["agent_message", "reasoning", "error"].includes(event.item?.type)))) return false;
    return events.filter((event) => event.type === "turn.completed").length === 1 &&
      events.filter((event) => event.type === "turn.started").length === 1 &&
      events.at(-1)?.type === "turn.completed" &&
      events.some((event) => event.type === "item.completed" && event.item?.type === "agent_message" &&
        typeof event.item.text === "string" && event.item.text.trim().length > 0);
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (!probeCodexAuthentication()) {
  holdFailedAuthentication();
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

const digest = createHash("sha256").update(process.env.APP_SERVER_TOKEN).digest("hex");
const child = spawn(
  "codex",
  [
    "-c",
    "otel.exporter=\"none\"",
    "-c",
    "otel.log_user_prompt=false",
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
      await installCodexPlugins(pluginRuntime, agentPluginReceipt);
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

// Check native readiness over Pod loopback: kubelet's node source can also be
// the trusted apiserver proxy source, but its probes have no forwarded headers.
export const GATEWAY_READINESS_ENTRYPOINT = String.raw`
const timeout = setTimeout(() => process.exit(1), 2_000);
const request = require("node:http").get(
  "http://127.0.0.1:" + process.env.OPENCLAW_GATEWAY_PORT + "/readyz",
  (response) => {
    response.resume();
    clearTimeout(timeout);
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);
request.on("error", () => process.exit(1));
`;

export const AGENT_READINESS_ENTRYPOINT = String.raw`
const timeout = setTimeout(() => process.exit(1), 2_000);
const { existsSync } = require("node:fs");
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
const socket = new ReadinessWebSocket("ws://127.0.0.1:" + process.env.APP_SERVER_PORT, {
  headers: { Authorization: "Bearer " + process.env.APP_SERVER_TOKEN },
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
`;
