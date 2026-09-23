import { asRecord } from "@openclaw-enterprise/utils";
import type { OpenClawConfigurationDocument, WorkspaceSetup } from "@openclaw-enterprise/contracts";

/** Only native main can consume the four setup documents. Undefined means unsupported. */
export function workspaceSetupMainAgent(
  configuration: OpenClawConfigurationDocument,
): Readonly<Record<string, unknown>> | undefined {
  if (configuration.agents === undefined) {
    return {};
  }
  const agents = asRecord(configuration.agents);
  if (agents === undefined || Object.hasOwn(agents, "list")) {
    return undefined;
  }
  if (!Object.hasOwn(agents, "entries")) {
    return {};
  }
  const entries = asRecord(agents.entries);
  if (
    entries === undefined ||
    Object.keys(entries).length !== 1 ||
    !Object.hasOwn(entries, "main")
  ) {
    return undefined;
  }
  return asRecord(entries.main);
}

/** Shared, non-executing setup entrypoint. Drivers own private delivery and exclusive startup. */
export const WORKSPACE_SETUP_RUNTIME = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const names = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
const markerName = ".oce-workspace-setup.json";
function fail() { throw new Error("WORKSPACE_SETUP_FAILED"); }
function inspect(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
function directoryChain(directory) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = inspect(current);
    if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink())) fail();
  }
}
function readRegular(file, limit = 32768) {
  const info = inspect(file);
  if (info === undefined) return undefined;
  if (!info.isFile() || info.nlink !== 1 || info.size > limit) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > limit) fail();
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}
function atomicWrite(file, content) {
  // Exclusive startup owns this reserved temporary path, including recovery after a crash.
  const temporary = path.join(path.dirname(file), ".oce-workspace-setup.tmp");
  readRegular(temporary);
  fs.rmSync(temporary, { force: true });
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally { fs.rmSync(temporary, { force: true }); }
}
function renderTemplate(content) {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const opening = /^---[^\S\n]*\n/.exec(normalized);
  if (opening === null) return content;
  const tail = normalized.slice(opening[0].length);
  const closing = /(?:^|\n)---[^\S\n]*(?:\n|(?![\s\S]))/.exec(tail);
  return closing === null ? content : tail.slice(closing.index + closing[0].length).replace(/^\s+/, "");
}
function main() {
  const delivery = process.env.OPENCLAW_WORKSPACE_SETUP_PATH;
  const raw = fs.readFileSync(delivery ?? 0, "utf8");
  if (Buffer.byteLength(raw) > 400000) fail();
  const setup = JSON.parse(raw);
  if (!setup || Array.isArray(setup) || typeof setup !== "object" ||
      Object.keys(setup).some((key) => !["id", "namespaceId", "agentId", "defaultsId", "files", "completed"].includes(key)) ||
      [setup.id, setup.namespaceId, setup.agentId].some((value) => typeof value !== "string" || value.length === 0 || value.length > 256 || !value.isWellFormed()) ||
      typeof setup.completed !== "boolean" ||
      (setup.defaultsId !== undefined && (typeof setup.defaultsId !== "string" || !/^[a-f0-9]{64}$/.test(setup.defaultsId)))) fail();
  const files = setup.files ?? {};
  if (!files || typeof files !== "object" || Array.isArray(files) ||
      (setup.completed && setup.files !== undefined) ||
      (!setup.completed && Object.keys(files).length === 0) ||
      Object.entries(files).some(([name, value]) => !names.includes(name) || typeof value !== "string" ||
        !value.isWellFormed() || value.includes("\0") || Buffer.byteLength(value) > 16384)) fail();
  const workspace = process.env.OPENCLAW_WORKSPACE_DIR;
  if (!workspace || !path.isAbsolute(workspace) || path.resolve(workspace) !== workspace) fail();
  directoryChain(workspace);
  const markerPath = path.join(workspace, markerName);
  const identity = { id: setup.id, namespaceId: setup.namespaceId, agentId: setup.agentId,
    ...(setup.defaultsId === undefined ? {} : { defaultsId: setup.defaultsId }) };
  const marker = readRegular(markerPath, 4096);
  if (marker !== undefined) {
    const saved = JSON.parse(marker);
    if (JSON.stringify(saved) !== JSON.stringify(identity)) fail();
  } else {
    if (setup.completed) fail();
    const executable = fs.realpathSync(process.env.OPENCLAW_EXECUTABLE ?? "/app/openclaw.mjs");
    let packageRoot = path.dirname(executable);
    let manifest;
    for (let depth = 0; depth < 4; depth++) {
      const manifestPath = path.join(packageRoot, "package.json");
      if (inspect(manifestPath) !== undefined) {
        const candidate = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (candidate.name === "openclaw") { manifest = candidate; break; }
      }
      packageRoot = path.dirname(packageRoot);
    }
    // The saved preview must match the installed templates, independently of the
    // package release. Native setup below still must succeed before completion.
    if (manifest === undefined) fail();
    const templates = names.map((name) => [name, renderTemplate(fs.readFileSync(
      path.join(packageRoot, "docs", "reference", "templates", name), "utf8"))]);
    const defaultsId = createHash("sha256").update(JSON.stringify(templates)).digest("hex");
    if (setup.defaultsId !== undefined && setup.defaultsId !== defaultsId) fail();
    const stock = Object.fromEntries(templates);
    // Validate every native file before setup can create defaults or modify lifecycle state.
    for (const name of names) {
      const content = readRegular(path.join(workspace, name));
      if (Object.hasOwn(files, name) && content !== undefined && content !== stock[name] && content !== files[name]) fail();
    }
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oce-workspace-setup-"));
    try {
      const configPath = path.join(temporary, "openclaw.json");
      fs.writeFileSync(configPath, JSON.stringify({
        agents: { defaults: { workspace }, entries: { main: {} } },
        gateway: { mode: "local" },
      }), { mode: 0o600 });
      const nativeSetup = () => {
        const result = spawnSync(process.execPath, [executable, "setup", "--baseline", "--workspace", workspace], {
          env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
          stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 1048576,
        });
        if (result.error || result.status !== 0) fail();
      };
      nativeSetup();
      for (const [name, value] of Object.entries(files)) {
        const file = path.join(workspace, name);
        const content = readRegular(file);
        if (content === value) continue;
        if (content !== undefined && content !== stock[name]) fail();
        atomicWrite(file, value);
      }
      // Native BOOTSTRAP lifecycle sees the submitted profile before any gateway starts.
      nativeSetup();
      for (const [name, value] of Object.entries(files)) {
        if (readRegular(path.join(workspace, name)) !== value) fail();
      }
      atomicWrite(markerPath, JSON.stringify(identity));
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  // A completed metadata file may be the permanent restart guard; retain it.
  if (delivery !== undefined && !setup.completed) {
    try { fs.unlinkSync(delivery); }
    catch (error) { if (!["ENOENT", "EROFS", "EACCES", "EPERM"].includes(error.code)) throw error; }
  }
  process.stdout.write(JSON.stringify({ completed: true, id: setup.id }) + "\n");
}
try { main(); }
catch { process.stderr.write("WORKSPACE_SETUP_FAILED\n"); process.exitCode = 1; }
`;

/** Metadata-only guard for Harness processes that share the initialized workspace. */
export function workspaceSetupVerifier(
  setup: Pick<WorkspaceSetup, "id" | "namespaceId" | "agentId" | "defaultsId">,
  workspace: string,
): string {
  const identity = {
    id: setup.id,
    namespaceId: setup.namespaceId,
    agentId: setup.agentId,
    ...(setup.defaultsId === undefined ? {} : { defaultsId: setup.defaultsId }),
    completed: true,
  };
  return `{
    const verification = require("node:child_process").spawnSync(process.execPath,
      ["-e", ${JSON.stringify(WORKSPACE_SETUP_RUNTIME)}], {
        input: ${JSON.stringify(JSON.stringify(identity))},
        env: { ...process.env, OPENCLAW_WORKSPACE_SETUP_PATH: undefined,
          OPENCLAW_WORKSPACE_DIR: ${JSON.stringify(workspace)} },
        stdio: ["pipe", "pipe", "pipe"], timeout: 10000, maxBuffer: 4096,
      });
    if (verification.error || verification.status !== 0) {
      process.stderr.write("WORKSPACE_SETUP_FAILED\\n");
      process.exit(1);
    }
  }`;
}
