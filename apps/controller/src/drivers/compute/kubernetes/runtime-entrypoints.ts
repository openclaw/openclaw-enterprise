import { PLUGIN_RUNTIME_TRANSLATOR_SOURCE } from "../../plugin/runtime-translator.ts";

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
const { spawnSync: pluginSpawnSync } = require("node:child_process");

const CODEX_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS = Number(process.env.OPENCLAW_PLUGIN_RUNTIME_REQUEST_TIMEOUT_MS ?? "10000");
const CODEX_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS = Number(process.env.OPENCLAW_PLUGIN_RUNTIME_INSTALL_DEADLINE_MS ?? "60000");

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

function readOpenClawConfig() {
  return JSON.parse(pluginReadFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
}

function writeOpenClawConfig(config) {
  const target = safeRuntimePath(process.env.HOME, ".openclaw/openclaw.json");
  pluginMkdirSync(pluginDirname(target), { recursive: true });
  pluginWriteFileSync(target, JSON.stringify(config), { mode: 0o600 });
  process.env.OPENCLAW_CONFIG_PATH = target;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function runOpenClaw(args, description) {
  const result = pluginSpawnSync("node", ["/app/openclaw.mjs", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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

function installOpenClawPlugins(runtime) {
  const artifact =
    runtime.manifest?.kind === "openclaw"
      ? pluginRuntimeTranslator.openClawRuntimeArtifact(runtime.manifest.selections ?? {})
      : { installs: [] };
  const installs = artifact.installs ?? [];
  applyOpenClawPluginConfiguration(runtime);
  for (const plugin of installs) {
    const spec = openClawPluginPackageSpec(plugin);
    runOpenClaw(["plugins", "install", spec, "--pin", "--force"], "OpenClaw plugin install");
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
      if (message.id !== requestIndex + 1) return;
      if (message.error !== undefined) {
        const method = requests[requestIndex]?.method ?? "unknown";
        finish(new Error("Codex app-server plugin runtime request failed during " + method + ": " + (message.error.message ?? "unknown error")));
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
    const install = await codexAppServerRequest("plugin/install", readParams);
    if ((install?.appsNeedingAuth ?? []).length > 0) {
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

async function installCodexPlugins(runtime) {
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
      await pluginRuntimeDelay(250);
    }
  }
  if (lastError !== undefined) {
    throw new Error("Codex plugin installation did not reach readiness: " + pluginRuntimeErrorMessage(lastError));
  }
}
`;

export const GATEWAY_RUNTIME_ENTRYPOINT = String.raw`
const { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");

${PLUGIN_RUNTIME_HELPERS}

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

mkdirSync("/home/node/.openclaw", { recursive: true });
mkdirSync("/home/node/workspace", { recursive: true });
if (process.env.OPENCLAW_WORKSPACE_DIR !== undefined) {
  mkdirSync(process.env.OPENCLAW_WORKSPACE_DIR, { recursive: true });
  publishDedicatedGatewayRuntimeAssets();
}
delete process.env.OPENCLAW_LOG_LEVEL;
const pluginRuntime = readGatewayPluginRuntime();
if (pluginRuntime !== undefined) installOpenClawPlugins(pluginRuntime);
const child = spawn(
  "node",
  ["/app/openclaw.mjs", "gateway", "--port", process.env.OPENCLAW_GATEWAY_PORT],
  { stdio: "inherit" },
);
forwardTermination(child);
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)));
`;

export const AGENT_RUNTIME_ENTRYPOINT = String.raw`
const { createHash } = require("node:crypto");
const { mkdirSync, rmSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

${PLUGIN_RUNTIME_HELPERS}

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
const accessToken = process.env.CODEX_ACCESS_TOKEN;
const workspaceId = process.env.CODEX_CHATGPT_WORKSPACE_ID;
if (accessToken !== undefined && (!workspaceId || process.env.OPENAI_API_KEY !== undefined)) {
  throw new Error("Codex service-account authentication configuration is invalid.");
}
if (accessToken === undefined && workspaceId !== undefined) {
  throw new Error("Codex service-account authentication configuration is invalid.");
}
const loginArguments = accessToken === undefined
  ? ["login", "--with-api-key"]
  : [
      "-c",
      "cli_auth_credentials_store=file",
      "-c",
      "forced_chatgpt_workspace_id=" + JSON.stringify(workspaceId),
      "login",
      "--with-access-token",
    ];
const login = spawnSync("codex", loginArguments, {
  input: accessToken ?? process.env.OPENAI_API_KEY,
  encoding: "utf8",
  stdio: ["pipe", "ignore", "pipe"],
});
if (login.status !== 0) throw new Error("Codex model authentication initialization failed.");
delete process.env.CODEX_ACCESS_TOKEN;

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
    if (pluginRuntime !== undefined) await installCodexPlugins(pluginRuntime);
    pluginRuntimeReady();
  } catch (error) {
    console.error("Codex plugin runtime initialization failed: " + pluginRuntimeErrorMessage(error));
    child.kill("SIGTERM");
    process.exit(1);
  }
})();
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
