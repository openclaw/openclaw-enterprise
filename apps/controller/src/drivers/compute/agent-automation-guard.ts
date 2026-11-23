import { createRequire } from "node:module";
import { AGENT_AUTOMATIONS_OPENCLAW_SOURCE } from "../../gateway/agent-automations-runtime.ts";

// Checkout CI and the in-image supervisor proof load this renderer before workspace
// packages are installed. Compiled callers use the contracts build output.
const require = createRequire(import.meta.url);
const nameVocabulary: unknown = new URL(import.meta.url).pathname.endsWith(".ts")
  ? require("../../../../../packages/contracts/src/api/plain-text.ts")
  : require("../../../../../packages/contracts/dist/api/plain-text.js");
if (
  typeof nameVocabulary !== "object" ||
  nameVocabulary === null ||
  !("PLAIN_TEXT_PATTERN" in nameVocabulary) ||
  typeof nameVocabulary.PLAIN_TEXT_PATTERN !== "string" ||
  !("NAME_MAX_CHARACTERS" in nameVocabulary) ||
  typeof nameVocabulary.NAME_MAX_CHARACTERS !== "number" ||
  !Number.isSafeInteger(nameVocabulary.NAME_MAX_CHARACTERS) ||
  nameVocabulary.NAME_MAX_CHARACTERS <= 0
) {
  throw new Error("Invalid automation identity vocabulary.");
}
const { NAME_MAX_CHARACTERS, PLAIN_TEXT_PATTERN } = nameVocabulary;

// These bundled plugins contain no MCP declarations at the qualified OpenClaw source.
export const AUTOMATION_NO_MCP_PLUGIN_IDS = Object.freeze([
  "openai",
  "codex",
  "file-transfer",
  "memory-core",
] as const);

export const AGENT_AUTOMATION_GUARD_VERSION = "oce-automation-origin-v1";
export const AGENT_AUTOMATION_OPENCLAW_VERSION = "2026.11.5";

/** Read-only checks used before Doctor and before each native spawn. */
export const AGENT_AUTOMATION_PRE_DOCTOR_GUARD = String.raw`
const AUTOMATION_OPENCLAW_SOURCE = ${JSON.stringify(AGENT_AUTOMATIONS_OPENCLAW_SOURCE)};
const AUTOMATION_OPENCLAW_VERSION = ${JSON.stringify(AGENT_AUTOMATION_OPENCLAW_VERSION)};
function assertReviewedEmbeddedAutomationImage(meta) {
  const fs = require("node:fs");
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const fail = () => { throw new Error("Automation reviewed image check refused Gateway startup."); };
  if (!record(meta) || Object.keys(meta).length !== 1 || meta.lastTouchedVersion !== AUTOMATION_OPENCLAW_VERSION) fail();
  let provenance;
  let packaged;
  try {
    provenance = JSON.parse(fs.readFileSync("/opt/oce/runtime/provenance.json", "utf8"));
    packaged = JSON.parse(fs.readFileSync("/app/node_modules/openclaw/package.json", "utf8"));
  } catch { fail(); }
  if (!record(provenance) || provenance.source !== "https://github.com/openclaw/openclaw" || provenance.commit !== AUTOMATION_OPENCLAW_SOURCE || !record(packaged) || packaged.version !== AUTOMATION_OPENCLAW_VERSION) fail();
}
function assertAutomationPersistedDiscovery(env) {
  const fs = require("node:fs");
  const path = require("node:path");
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const fail = () => { throw new Error("Automation persisted discovery check refused Gateway startup."); };
  const stateDir = env.OPENCLAW_STATE_DIR;
  if (stateDir !== "/home/node/.openclaw" || env.HOME !== "/home/node") fail();
  const statPath = (target) => {
    if (!path.isAbsolute(target) || path.normalize(target) !== target) fail();
    let current = path.parse(target).root;
    for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        fail();
      }
      if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) fail();
    }
    try { return fs.lstatSync(target); } catch { fail(); }
  };
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const databaseStat = statPath(databasePath);
  const sidecars = ["-wal", "-shm"].map((suffix) => statPath(databasePath + suffix));
  if (sidecars.some((sidecar) => sidecar !== undefined && (!sidecar.isFile() || databaseStat === undefined)) || (sidecars[0] === undefined) !== (sidecars[1] === undefined)) fail();
  if (databaseStat === undefined) return;
  if (!databaseStat.isFile()) fail();
  let database;
  try {
    const { DatabaseSync } = require("node:sqlite");
    database = new DatabaseSync(databasePath, { readOnly: true });
    const discovery = database.prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?").get("plugins.bundledDiscovery");
    if (discovery !== undefined && (typeof discovery.value_json !== "string" || JSON.parse(discovery.value_json) !== "allowlist")) fail();
    const row = database.prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?").get("plugins.installedIndex");
    if (row !== undefined) {
      if (typeof row.value_json !== "string" || row.value_json.length > 1024 * 1024) fail();
      const value = JSON.parse(row.value_json);
      const index = value?.index;
      if (!record(value) || !record(index) || index.version !== 1 || index.migrationVersion !== 1 || !record(index.installRecords) || Object.keys(index.installRecords).length !== 0 || !Array.isArray(index.plugins) || index.plugins.some((plugin) => !record(plugin) || plugin.origin !== "bundled")) fail();
    }
  } catch { fail(); } finally { try { database?.close(); } catch { fail(); } }
}
`;

/** Runs in the Gateway wrapper before every native spawn, including respawns. */
export const AGENT_AUTOMATION_ORIGIN_GUARD = String.raw`
const AUTOMATION_GUARD_VERSION = ${JSON.stringify(AGENT_AUTOMATION_GUARD_VERSION)};
const AUTOMATION_NAME_MAX_CHARACTERS = ${NAME_MAX_CHARACTERS};
const AUTOMATION_NAME_PATTERN = new RegExp(${JSON.stringify(PLAIN_TEXT_PATTERN)}, "u");
const AUTOMATION_BUNDLED_PLUGIN_ROOT = "/app/node_modules/openclaw/dist/extensions";
const AUTOMATION_BUNDLED_PLUGIN_IDS = ${JSON.stringify(AUTOMATION_NO_MCP_PLUGIN_IDS)};
function assertCleanAutomationOrigins(env, gatewayToolPolicyInput, initialConfigPath) {
  const fs = require("node:fs");
  const path = require("node:path");
  const fail = () => { throw new Error("Automation plugin origin guard refused Gateway startup."); };
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const statPath = (target) => {
    if (!path.isAbsolute(target) || path.normalize(target) !== target) fail();
    let current = path.parse(target).root;
    for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        fail();
      }
      if (stat.isSymbolicLink()) fail();
      if (current !== target && !stat.isDirectory()) fail();
    }
    try { return fs.lstatSync(target); } catch { fail(); }
  };
  const emptyRoot = (target) => {
    const stat = statPath(target);
    if (stat === undefined) return;
    if (!stat.isDirectory()) fail();
    try { if (fs.readdirSync(target).length !== 0) fail(); } catch { fail(); }
  };
  const absent = (target) => { if (statPath(target) !== undefined) fail(); };
  const stateDir = env.OPENCLAW_STATE_DIR;
  if (typeof stateDir !== "string" || stateDir !== "/home/node/.openclaw" || env.HOME !== "/home/node") fail();
  for (const key of ["OPENCLAW_HOME", "OPENCLAW_PROFILE", "OPENCLAW_DISABLE_BUNDLED_PLUGINS", "OPENCLAW_BUNDLED_PLUGINS_DIR", "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "OPENCLAW_PLUGIN_INSTALL_OVERRIDES", "OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES"]) {
    if (env[key] !== undefined && env[key] !== "") fail();
  }
  if (env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS !== "1" || env.NODE_OPTIONS !== "--max-semi-space-size=8" || (env.NODE_PATH !== undefined && env.NODE_PATH !== "")) fail();
  const configPath = env.OPENCLAW_CONFIG_PATH;
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)) fail();
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { fail(); }
  if (!AUTOMATION_MCP_PROXY) fail();
  assertAutomationMcpProxyProjection(AUTOMATION_MCP_PROXY, config);
  if (!record(config) || !record(config.plugins) || config.plugins.load !== undefined || config.plugins.installs !== undefined || config.plugins.bundledDiscovery !== undefined) fail();
  if (config.tools?.codeMode !== false || config.tools?.toolSearch !== false || config.gateway?.nodes?.pluginTools?.enabled !== false || config.gateway?.nodes?.allowSkills !== false) fail();
  const overridesOff = (models) => models === undefined || (record(models) && Object.values(models).every((model) => record(model) && (model.codeMode === undefined || model.codeMode === false) && (model.toolSearch === undefined || model.toolSearch === false)));
  const agents = config.agents;
  if ((agents !== undefined && !record(agents)) || agents?.list !== undefined || (agents?.defaults !== undefined && !record(agents.defaults)) || !overridesOff(agents?.defaults?.models)) fail();
  const dedicated = gatewayToolPolicyInput !== undefined;
  if (!dedicated) assertReviewedEmbeddedAutomationImage(config.meta);
  if (dedicated && (!env.APP_SERVER_URL || env.OPENCLAW_NATIVE_WORKER_PROFILE !== undefined || (env.OPENCLAW_REMOTE_WORKSPACE_ROOT !== undefined && env.OPENCLAW_REMOTE_WORKSPACE_ROOT !== "/home/node/workspace"))) fail();
  const mcp = config.mcp;
  if (!record(mcp) || !record(mcp.servers) || Object.keys(mcp).some((key) => key !== "servers" && !(dedicated && key === "apps"))) fail();
  const entries = agents?.entries;
  const main = record(entries) ? entries.main : undefined;
  const identity = record(main) ? main.identity : undefined;
  if (!record(entries) || Object.keys(entries).length !== 1 || !record(main) || Object.keys(main).some((key) => key !== "identity" && key !== "tools" && !(dedicated && key === "workspace")) || !record(identity) || Object.keys(identity).length !== 1 || typeof identity.name !== "string" || !AUTOMATION_NAME_PATTERN.test(identity.name) || /\p{Cs}/u.test(identity.name) || Array.from(identity.name).length > AUTOMATION_NAME_MAX_CHARACTERS || (dedicated ? main.workspace !== "/home/node/workspace" : main.workspace !== undefined)) fail();
  const tools = main.tools;
  if (tools !== undefined) {
    const allow = record(tools) ? tools.allow : undefined;
    if (!record(tools) || Object.keys(tools).some((key) => key !== "allow") || !Array.isArray(allow) || allow.length === 0 || allow.some((name) => typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*__[A-Za-z][A-Za-z0-9_-]*$/u.test(name)) || new Set(allow.map((name) => name.toLowerCase())).size !== allow.length) fail();
    const gatewayAllow = config.tools.gatewayPolicy?.allow;
    if (!Array.isArray(gatewayAllow) || allow.some((name) => !(gatewayAllow.includes(name) || (dedicated && gatewayAllow.includes(name.toLowerCase()))) || !Object.entries(mcp.servers).some(([serverName, server]) => record(server) && Array.isArray(server.toolFilter?.include) && server.toolFilter.include.some((tool) => serverName + "__" + tool === name)))) fail();
  } else if (dedicated) fail();
  const deepEqual = require("node:util").isDeepStrictEqual;
  let admitted = gatewayToolPolicyInput;
  if (!dedicated) {
    const admittedPath = initialConfigPath === writableOpenClawConfigPath() ? "/etc/openclaw-managed/openclaw.json" : initialConfigPath;
    if (admittedPath !== "/etc/openclaw/openclaw.json" && admittedPath !== "/etc/openclaw-managed/openclaw.json") fail();
    try { admitted = JSON.parse(fs.readFileSync(admittedPath, "utf8")); } catch { fail(); }
  }
  if (!record(admitted) || !deepEqual(entries, admitted.agents?.entries) || !deepEqual(mcp, admitted.mcp) || (!dedicated && !deepEqual(config.meta, admitted.meta))) fail();
  if (dedicated) {
    const expected = structuredClone(admitted);
    if (env.OPENCLAW_WORKSPACE_NODE_ID === undefined && workspaceNodeBindingPath === undefined) fail();
    const workspaceNodeId = env.OPENCLAW_WORKSPACE_NODE_ID ?? readWorkspaceNodeBinding();
    configureWorkspaceNodePlugins(expected, workspaceNodeId);
    const codex = expected.plugins?.entries?.codex;
    if (!record(codex) || !record(codex.config) || !Array.isArray(codex.config.codexDynamicToolsExclude ?? [])) fail();
    codex.config.codexDynamicToolsExclude = [...new Set([...(codex.config.codexDynamicToolsExclude ?? []), ...GATEWAY_LOCAL_CODEX_DYNAMIC_TOOLS])];
    if (!deepEqual(config.plugins, expected.plugins)) fail();
  }
  const configDir = stateDir; // Native resolveConfigDir gives OPENCLAW_STATE_DIR first priority.
  for (const name of ["extensions", "npm", "git"]) emptyRoot(path.join(configDir, name));
  absent(path.join(stateDir, "plugins", "installs.json"));
  const workspaces = new Set([path.join(stateDir, "workspace")]);
  if (agents?.defaults?.workspace !== undefined) workspaces.add(agents.defaults.workspace);
  if (entries?.main?.workspace !== undefined) workspaces.add(entries.main.workspace);
  for (const workspace of workspaces) {
    if (typeof workspace !== "string" || !path.isAbsolute(workspace) || path.normalize(workspace) !== workspace) fail();
    emptyRoot(path.join(workspace, ".openclaw", "extensions"));
  }
  assertAutomationPersistedDiscovery(env);
  const allow = config.plugins.allow;
  if (!Array.isArray(allow) || allow.some((id) => !AUTOMATION_BUNDLED_PLUGIN_IDS.includes(id))) fail();
  const bundledIds = new Set(allow);
  if (config.plugins.slots?.memory !== "none") bundledIds.add("memory-core");
  for (const id of bundledIds) {
    const root = path.join(AUTOMATION_BUNDLED_PLUGIN_ROOT, id);
    let real;
    try {
      if (fs.realpathSync(AUTOMATION_BUNDLED_PLUGIN_ROOT) !== AUTOMATION_BUNDLED_PLUGIN_ROOT) fail();
      real = fs.realpathSync(root);
    } catch { fail(); }
    if (!real.startsWith("/app/") || real === "/app/") fail();
    let manifest;
    try {
      const manifestPath = fs.realpathSync(path.join(real, "openclaw.plugin.json"));
      if (!manifestPath.startsWith("/app/")) fail();
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch { fail(); }
    if (!record(manifest) || manifest.id !== id || (manifest.mcpServers !== undefined && (!record(manifest.mcpServers) || Object.keys(manifest.mcpServers).length !== 0))) fail();
  }
}
`;
