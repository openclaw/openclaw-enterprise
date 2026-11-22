// These bundled plugins contain no MCP declarations at the qualified OpenClaw source.
export const AUTOMATION_NO_MCP_PLUGIN_IDS = Object.freeze([
  "openai",
  "codex",
  "file-transfer",
  "memory-core",
] as const);

export const AGENT_AUTOMATION_GUARD_VERSION = "oce-automation-origin-v1";

/** Runs in the Gateway wrapper before every native spawn, including respawns. */
export const AGENT_AUTOMATION_ORIGIN_GUARD = String.raw`
const AUTOMATION_GUARD_VERSION = ${JSON.stringify(AGENT_AUTOMATION_GUARD_VERSION)};
const AUTOMATION_BUNDLED_PLUGIN_ROOT = "/app/node_modules/openclaw/dist/extensions";
const AUTOMATION_BUNDLED_PLUGIN_IDS = ${JSON.stringify(AUTOMATION_NO_MCP_PLUGIN_IDS)};
function assertCleanAutomationOrigins(env) {
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
  if (!record(config) || !record(config.plugins) || config.plugins.load !== undefined || config.plugins.installs !== undefined || config.plugins.bundledDiscovery !== undefined) fail();
  if (config.tools?.codeMode !== false || config.tools?.toolSearch !== false || config.gateway?.nodes?.pluginTools?.enabled !== false || config.gateway?.nodes?.allowSkills !== false) fail();
  const overridesOff = (models) => models === undefined || (record(models) && Object.values(models).every((model) => record(model) && (model.codeMode === undefined || model.codeMode === false) && (model.toolSearch === undefined || model.toolSearch === false)));
  if (!overridesOff(config.agents?.defaults?.models) || (config.agents?.list !== undefined && !Array.isArray(config.agents.list))) fail();
  for (const agent of config.agents?.list ?? []) {
    if (!record(agent) || (agent.tools !== undefined && !record(agent.tools)) || (agent.tools?.codeMode !== undefined && agent.tools.codeMode !== false) || (agent.tools?.toolSearch !== undefined && agent.tools.toolSearch !== false) || !overridesOff(agent.models)) fail();
  }
  const configDir = stateDir; // Native resolveConfigDir gives OPENCLAW_STATE_DIR first priority.
  for (const name of ["extensions", "npm", "git"]) emptyRoot(path.join(configDir, name));
  absent(path.join(stateDir, "plugins", "installs.json"));
  const workspaces = new Set([path.join(stateDir, "workspace")]);
  const agents = config.agents;
  if (agents !== undefined && !record(agents)) fail();
  if (agents?.defaults?.workspace !== undefined) workspaces.add(agents.defaults.workspace);
  if (agents?.list !== undefined && !Array.isArray(agents.list)) fail();
  for (const agent of agents?.list ?? []) {
    if (!record(agent)) fail();
    if (agent.workspace !== undefined) workspaces.add(agent.workspace);
  }
  for (const workspace of workspaces) {
    if (typeof workspace !== "string" || !path.isAbsolute(workspace) || path.normalize(workspace) !== workspace) fail();
    emptyRoot(path.join(workspace, ".openclaw", "extensions"));
  }
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const databaseStat = statPath(databasePath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = statPath(databasePath + suffix);
    if (sidecar !== undefined && (!sidecar.isFile() || databaseStat === undefined)) fail();
  }
  if (databaseStat !== undefined) {
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
