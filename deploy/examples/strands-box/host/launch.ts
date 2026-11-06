import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROLLED_INFERENCE_MARKER, policy } from "./egress.ts";
import {
  collectDiagnostics,
  drainDiagnostics,
  exitReason,
  report,
  safeReason,
} from "./diagnostics.ts";
import type { EgressRoute } from "./egress.ts";
import {
  WORKSPACE_VERIFIER,
  verifyWorkspaceVerifier,
  workspaceVerifierPolicy,
  workspaceVerifierTool,
} from "./workspace-verifier.ts";
import {
  bridge,
  INVALID_CAPABILITY,
  listen,
  PORT,
  processIdentity,
  sameProcess,
  sameSocket,
  socketIdentity,
  upgradeStatus,
  waitFor,
} from "./transport.ts";
import type { ProcessIdentity, SocketIdentity } from "./transport.ts";

const ownerOnly = { mode: 0o600, flag: "wx" } as const;
export const PATH = "/usr/local/bin:/usr/bin:/bin";
export const APP_SOCKET = "app-server.sock";
export const READY_FILE = "ready.json";
export const OWNER_STOP_MS = 10_000;
const DIGEST = /^[a-f0-9]{64}$/;

const startupMessages = new Set([
  "usage",
  "invalid_object",
  "unknown_field",
  "invalid_string",
  "invalid_path",
  "noncanonical_path",
  "invalid_binary",
  "native_executable_required",
  "private_directory",
  "invalid_grants",
  "dedicated_linux_owner_required",
  "runtime_workspace_separation",
  "compiled_agent_missing",
  "grant_covers_private_runtime",
  "workspace_verifier_refused",
  "owner_config_file",
  "linux_arm64_required",
  "runtime_already_used",
  "owner_cleanup_failed",
  "startup_refused:stage-inputs",
  "startup_refused:start-box",
  "startup_refused:wait-original-native",
  "startup_refused:verify-native-auth",
  "startup_refused:publish-owner-socket",
]);
const startupErrnos = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EEXIST",
  "ENOTDIR",
  "EROFS",
  "ENOSPC",
  "ELOOP",
  "ENAMETOOLONG",
]);

type StartupPhase =
  | "usage"
  | "config-file"
  | "config-shape"
  | "platform"
  | "runtime-directory"
  | "workspace-directory"
  | "runtime-layout"
  | "compiled-agent-directory"
  | "compiled-agent-entry"
  | "compiled-agent-transport"
  | "compiled-agent-diagnostics"
  | "box-binary"
  | "node-binary"
  | "codex-binary"
  | "read-grants"
  | "exec-grants"
  | "grant-layout"
  | "runtime-claim"
  | "owner-home-create"
  | "codex-home-create"
  | "launch"
  | "retirement";

class StartupRefusal extends Error {
  readonly phase: StartupPhase;
  readonly reason: string;
  constructor(phase: StartupPhase, reason: string) {
    super(`phase=${phase} reason=${reason}`);
    this.phase = phase;
    this.reason = reason;
  }
}

function startupFailure(phase: StartupPhase, error: unknown): StartupRefusal {
  if (error instanceof StartupRefusal) return error;
  if (error instanceof Error && startupMessages.has(error.message))
    return new StartupRefusal(phase, error.message);
  if (error instanceof SyntaxError) return new StartupRefusal(phase, "invalid_json");
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    startupErrnos.has(error.code)
  ) {
    return new StartupRefusal(phase, error.code);
  }
  return new StartupRefusal(phase, "unexpected");
}

function checked<T>(phase: StartupPhase, action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw startupFailure(phase, error);
  }
}

export interface HostConfig {
  boxBin: string;
  agentBuildDir: string;
  nodeBin: string;
  codexBin: string;
  runtimeDir: string;
  workspace: string;
  read: string[];
  exec: string[];
  linuxPreview: true;
  workspaceVerifierSha256?: string;
}

export interface StartInput {
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
  readOnly: readonly string[];
  writable: readonly string[];
  files?: readonly { name: string; content: string; environmentVariable: string }[];
  workspaceNodeSetupCode?: string;
  workspaceNodeSetupExpiresAt?: number;
  egress?: readonly EgressRoute[];
}

export interface OwnerReady {
  version: 1;
  pid: number;
  uid: number;
  bootId: string;
  startTicks: string;
  socketDev: string;
  socketIno: string;
}

export interface Execution {
  readonly ready: Promise<OwnerReady>;
  readonly done: Promise<number>;
  stop(): Promise<number>;
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_object");
  return value as Record<string, unknown>;
}

export function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((name) => !allowed.includes(name))) throw new Error("unknown_field");
}

export function string(value: unknown, max = 1024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  ) {
    throw new Error("invalid_string");
  }
  return value;
}

function pathWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

function cleanPath(value: unknown): string {
  const path = string(value);
  if (
    !isAbsolute(path) ||
    path === "/" ||
    resolve(path) !== path ||
    /[\u0000-\u001f\u007f*?\[\]{}]/.test(path)
  ) {
    throw new Error("invalid_path");
  }
  if (realpathSync(path) !== path) throw new Error("noncanonical_path");
  return path;
}

function binary(value: unknown): string {
  const path = cleanPath(value);
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o7022) !== 0) throw new Error("invalid_binary");
  accessSync(path, constants.X_OK);
  return path;
}

function nativeBinary(value: unknown): string {
  const path = binary(value);
  const fd = openSync(path, "r");
  try {
    const magic = Buffer.alloc(4);
    if (
      readSync(fd, magic, 0, magic.length, 0) !== 4 ||
      !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    ) {
      throw new Error("native_executable_required");
    }
  } finally {
    closeSync(fd);
  }
  return path;
}

export function privateDirectory(value: unknown): string {
  const path = cleanPath(value);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("private_directory");
  }
  return path;
}

function grants(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 80) throw new Error("invalid_grants");
  return value.map(cleanPath);
}

const hostKeys = [
  "agentBuildDir",
  "boxBin",
  "nodeBin",
  "codexBin",
  "runtimeDir",
  "workspace",
  "read",
  "exec",
  "linuxPreview",
  "workspaceVerifierSha256",
];
export function hostConfig(input: unknown, additionalKeys: readonly string[] = []): HostConfig {
  const data = checked("config-shape", () => {
    const record = object(input);
    fields(record, [...hostKeys, ...additionalKeys]);
    return record;
  });
  if (
    process.platform !== "linux" ||
    process.getuid?.() === undefined ||
    process.getuid() === 0 ||
    data.linuxPreview !== true
  ) {
    throw startupFailure("platform", new Error("dedicated_linux_owner_required"));
  }
  const runtimeDir = checked("runtime-directory", () => privateDirectory(data.runtimeDir));
  const workspace = checked("workspace-directory", () => privateDirectory(data.workspace));
  if (
    pathWithin(runtimeDir, workspace) ||
    pathWithin(workspace, runtimeDir) ||
    Buffer.byteLength(join(runtimeDir, "bridge", "native.sock")) > 107
  )
    throw startupFailure("runtime-layout", new Error("runtime_workspace_separation"));
  const agentBuildDir = checked("compiled-agent-directory", () => cleanPath(data.agentBuildDir));
  for (const [name, phase] of [
    ["box-agent.js", "compiled-agent-entry"],
    ["transport.js", "compiled-agent-transport"],
    ["diagnostics.js", "compiled-agent-diagnostics"],
  ] as const) {
    checked(phase, () => {
      const staged = cleanPath(join(agentBuildDir, name));
      if (!lstatSync(staged).isFile() || (lstatSync(staged).mode & 0o022) !== 0)
        throw new Error("compiled_agent_missing");
    });
  }
  const config: HostConfig = {
    agentBuildDir,
    boxBin: checked("box-binary", () => binary(data.boxBin)),
    nodeBin: checked("node-binary", () => nativeBinary(data.nodeBin)),
    codexBin: checked("codex-binary", () => nativeBinary(data.codexBin)),
    runtimeDir,
    workspace,
    read: checked("read-grants", () => grants(data.read)),
    exec: checked("exec-grants", () => grants(data.exec)),
    linuxPreview: true,
  };
  if (data.workspaceVerifierSha256 !== undefined) {
    config.workspaceVerifierSha256 = checked("grant-layout", () => {
      const sha = string(data.workspaceVerifierSha256);
      verifyWorkspaceVerifier(sha, workspace);
      return sha;
    });
  }
  const grantsAndBins = [
    config.agentBuildDir,
    config.boxBin,
    config.nodeBin,
    config.codexBin,
    ...config.read,
    ...config.exec,
    ...(config.workspaceVerifierSha256 === undefined ? [] : [WORKSPACE_VERIFIER]),
  ];
  for (const path of grantsAndBins) {
    if (
      pathWithin(path, runtimeDir) ||
      pathWithin(runtimeDir, path) ||
      pathWithin(workspace, path) ||
      pathWithin(path, workspace)
    ) {
      throw startupFailure("grant-layout", new Error("grant_covers_private_runtime"));
    }
  }
  return config;
}

export function readConfig(path: string): unknown {
  const file = cleanPath(path);
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid!() ||
    (stat.mode & 0o7777) !== 0o600 ||
    stat.size > 256_000
  ) {
    throw new Error("owner_config_file");
  }
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

// TOML strings and JS JSON share these escapes for the safe Unicode inputs here.
function quoted(value: string): string {
  if (/\p{Surrogate}/u.test(value)) throw new Error("invalid_unicode");
  return JSON.stringify(value).replaceAll("\u007f", "\\u007f");
}

function outermost(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)].sort((left, right) => left.length - right.length);
  return unique.filter(
    (path, index) => !unique.slice(0, index).some((parent) => pathWithin(parent, path)),
  );
}

function safeEnvironment(
  environment: Readonly<Record<string, string>>,
  hasControlledInference: boolean,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      /^(?:AWS_|GITHUB_|GIT_|GH_|LD_|DYLD_|PYTHON|OTEL_EXPORTER_OTLP_|SSH_|KUBE)/.test(key) ||
      /^(?:APP_SERVER_TOKEN|OPENCLAW_NODE_SETUP_CODE|NODE_OPTIONS|BASH_ENV|ENV|RUBYOPT|PERL5LIB|PERL5OPT|GEM_PATH|CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|CODEX_CA_CERTIFICATE|REQUESTS_CA_BUNDLE|PWD|USER)$/.test(
        key,
      )
    ) {
      throw new Error("unsupported_environment");
    }
    // The example admits no model, Git, cloud, OAuth or native bearer material.
    // The literal per-revision APP_TOKEN_SHA is a verifier, never a bearer.
    const controlled =
      key === "OPENAI_API_KEY" && hasControlledInference && value === CONTROLLED_INFERENCE_MARKER;
    if (
      /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/.test(key) &&
      key !== "APP_TOKEN_SHA" &&
      !controlled
    ) {
      throw new Error("credential_environment_refused");
    }
    if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 128_000) {
      throw new Error("invalid_environment");
    }
    result[key] = value;
  }
  if (
    !DIGEST.test(result.APP_TOKEN_SHA ?? "") ||
    result.APP_SERVER_PORT !== String(PORT) ||
    result.APP_TOKEN_SHA === createHash("sha256").update(INVALID_CAPABILITY).digest("hex")
  ) {
    throw new Error("invalid_native_verifier");
  }
  return result;
}

function openProjection(value: string, active: () => boolean): ReturnType<typeof createServer> {
  const bytes = Buffer.from(value, "utf8");
  const server = createServer((socket) => {
    if (!active() || bytes.every((byte) => byte === 0)) {
      socket.destroy();
      return;
    }
    server.close();
    socket.on("error", () => socket.destroy());
    socket.setTimeout(2_000, () => socket.destroy());
    const oneShot = Buffer.from(bytes);
    bytes.fill(0);
    socket.end(oneShot, () => oneShot.fill(0));
  });
  server.on("close", () => bytes.fill(0));
  return server;
}

/** Starts one previously admitted command; this API never accepts an alternate destination. */
export function start(
  config: HostConfig,
  input: StartInput,
  standaloneCapability?: string,
): Execution {
  const abort = new AbortController();
  let readyResolve!: (value: OwnerReady) => void;
  let readyReject!: (reason: Error) => void;
  const ready = new Promise<OwnerReady>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // A control request receives 'starting' without waiting on this promise.
  void ready.catch(() => {});
  const done = run();
  return {
    ready,
    done,
    stop: () => {
      abort.abort();
      return done;
    },
  };

  async function run(): Promise<number> {
    const run = config.runtimeDir;
    const authority = join(run, "authority");
    const bridgeDir = join(run, "bridge");
    const projectionDir = join(run, "projection");
    const boxHome = join(authority, "home");
    const app = join(run, APP_SOCKET);
    const inner = join(bridgeDir, "native.sock");
    const pinned = join(run, "pinned.sock");
    const projection = join(projectionDir, "setup.sock");
    const finalReceipt = join(run, READY_FILE);
    const stagedReceipt = join(run, "ready.tmp");
    const capabilityPath = join(run, "capability");
    let relay: ReturnType<typeof bridge> | undefined;
    let handoff: ReturnType<typeof openProjection> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let childDone: Promise<number> | undefined;
    let diagnosticDone: Promise<void> | undefined;
    let owner: ProcessIdentity | undefined;
    let watch: NodeJS.Timeout | undefined;
    let pinnedIdentity: SocketIdentity | undefined;
    let publicIdentity: SocketIdentity | undefined;
    let requestedStop = false;
    let cleanupFailed = false;
    let capabilityOwned = false;
    let receiptOwned = false;
    let stage = "stage-inputs";
    try {
      const staging = join(run, "input");
      mkdirSync(staging, { mode: 0o700 });
      const effectiveEnvironment = { ...input.environment };
      const stagedPaths: string[] = [];
      for (const file of input.files ?? []) {
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(file.name) ||
          Object.hasOwn(effectiveEnvironment, file.environmentVariable) ||
          Buffer.byteLength(file.content) > 128_000
        ) {
          throw new Error("invalid_admitted_file");
        }
        const staged = join(staging, `file-${file.name}`);
        writeFileSync(staged, file.content, ownerOnly);
        stagedPaths.push(staged);
        effectiveEnvironment[file.environmentVariable] = staged;
      }
      const environment = safeEnvironment(
        effectiveEnvironment,
        input.egress?.some((route) => route.kind === "controlled-inference") === true,
      );
      const readOnly = input.readOnly.map(cleanPath);
      const writable = input.writable.map(privateDirectory);
      for (const path of [...readOnly, ...writable]) {
        if (pathWithin(run, path) || pathWithin(path, run))
          throw new Error("mount_covers_owner_state");
      }
      const agentHome = privateDirectory(environment.HOME);
      if (pathWithin(agentHome, run) || pathWithin(run, agentHome))
        throw new Error("agent_home_covers_owner_state");
      for (const directory of [authority, bridgeDir, projectionDir, boxHome])
        mkdirSync(directory, { mode: 0o700 });
      const agentFile = join(authority, "agent.json");
      const policyFile = join(authority, "policy.dw");
      const boxFile = join(authority, "box.toml");
      const agentEntry = join(config.agentBuildDir, "box-agent.js");
      const helper = join(config.agentBuildDir, "transport.js");
      const diagnostics = join(config.agentBuildDir, "diagnostics.js");
      // Keeping the exact admitted argv in an authority-owned file also avoids
      // Box's TOML argument interpolation changing the generated Node program.
      writeFileSync(
        agentFile,
        JSON.stringify({
          command: input.command,
          workspace: config.workspace,
          codexBin: config.codexBin,
          socketPath: inner,
          ...(input.workspaceNodeSetupCode === undefined ? {} : { projectionSocket: projection }),
        }),
        ownerOnly,
      );
      const verifier = config.workspaceVerifierSha256;
      if (verifier !== undefined) {
        if (
          [
            ...config.read,
            ...config.exec,
            config.nodeBin,
            config.codexBin,
            ...readOnly,
            ...writable,
          ].some((path) => pathWithin(path, WORKSPACE_VERIFIER))
        )
          throw new Error("workspace_verifier_refused");
        verifyWorkspaceVerifier(verifier, config.workspace);
      }
      writeFileSync(
        policyFile,
        policy(input.egress ?? []) +
          (verifier === undefined ? "" : workspaceVerifierPolicy(config.workspace)),
        ownerOnly,
      );
      // Box excludes its own box.toml and policy directory from every native grant.
      // Stage the Node input separately: the authority directory is never mounted.
      const visibleAgentInput = join(staging, "agent.json");
      renameSync(agentFile, visibleAgentInput);
      const read = outermost([
        ...config.read,
        ...readOnly,
        ...writable,
        config.workspace,
        bridgeDir,
        agentEntry,
        helper,
        diagnostics,
        visibleAgentInput,
        ...stagedPaths,
        ...(input.workspaceNodeSetupCode === undefined ? [] : [projectionDir]),
      ]);
      const write = outermost([...writable, config.workspace, bridgeDir]);
      const exec = outermost([...config.exec, config.codexBin, config.nodeBin]);
      const configText = [
        'name = "oce-strands"',
        `box_dir = ${quoted(join(run, "box-state"))}`,
        `policy = ${quoted(policyFile)}`,
        "",
        "[agent]",
        `command = [${[config.nodeBin, "--jitless", agentEntry, visibleAgentInput].map(quoted).join(", ")}]`,
        `workspace = ${quoted(config.workspace)}`,
        "",
        "[agent.env]",
        ...Object.entries(environment).map(([key, value]) => `${key} = ${quoted(value)}`),
        "",
        "[agent.filesystem]",
        ...Object.entries({ read, write, exec }).map(
          ([operation, paths]) => `${operation} = [${paths.map(quoted).join(", ")}]`,
        ),
        "",
      ].join("\n");
      writeFileSync(
        boxFile,
        configText + (verifier === undefined ? "" : "\n" + workspaceVerifierTool(config.workspace)),
        ownerOnly,
      );
      if (input.workspaceNodeSetupCode !== undefined) {
        if (
          input.workspaceNodeSetupExpiresAt === undefined ||
          Date.now() >= input.workspaceNodeSetupExpiresAt
        )
          throw new Error("setup_projection_expired");
        const expiresAt = input.workspaceNodeSetupExpiresAt;
        handoff = openProjection(
          input.workspaceNodeSetupCode,
          () =>
            owner !== undefined &&
            sameProcess(owner) &&
            !abort.signal.aborted &&
            Date.now() < expiresAt,
        );
        handoff.on("error", () => abort.abort());
        await listen(handoff, projection);
      }
      stage = "start-box";
      report("box", "exec", "entered");
      child = spawn(config.boxBin, ["run", "--config", boxFile], {
        cwd: config.workspace,
        stdio: ["ignore", "pipe", "pipe"],
        env: { HOME: boxHome, PATH, LANG: "C.UTF-8", EXPERIMENTAL_LINUX_SUPPORT: "TRUE" },
      });
      child.stdout?.resume();
      if (child.stderr !== null) diagnosticDone = collectDiagnostics(child.stderr, "box");
      childDone = new Promise<number>((resolve) => {
        child!.once("exit", (code, signal) => {
          report("box", "exit", exitReason(code, signal));
          abort.abort();
          resolve(code ?? 1);
        });
        child!.once("error", (error) => {
          report("box", "exec", safeReason(error));
          abort.abort();
          resolve(1);
        });
      });
      if (child.pid === undefined) throw new Error("box_start_failed");
      owner = processIdentity(child.pid);
      stage = "wait-original-native";
      report("box", "listener", "entered");
      pinnedIdentity = await waitFor(() => {
        try {
          return socketIdentity(inner);
        } catch {
          return undefined;
        }
      }, abort.signal);
      report("box", "listener", "observed");
      // A host-only hardlink pins the kernel pathname inode before any caller can
      // use it. Replacing the sandbox-visible pathname cannot reroute host traffic.
      linkSync(inner, pinned);
      const exactPinned = pinnedIdentity;
      const exactOwner = owner;
      const original = () =>
        sameProcess(exactOwner) &&
        sameSocket(inner, exactPinned) &&
        sameSocket(pinned, exactPinned);
      if (!original()) throw new Error("native_socket_replaced");
      relay = bridge({ path: pinned }, () => !abort.signal.aborted && original());
      watch = setInterval(() => {
        if (!original() || (publicIdentity !== undefined && !sameSocket(app, publicIdentity)))
          abort.abort();
      }, 200);
      stage = "verify-native-auth";
      if (
        (await upgradeStatus({ path: pinned })) !== 401 ||
        (await upgradeStatus({ path: pinned }, INVALID_CAPABILITY)) !== 401 ||
        (standaloneCapability !== undefined &&
          (await upgradeStatus({ path: pinned }, standaloneCapability)) !== 101)
      ) {
        throw new Error("native_auth_unconfirmed");
      }
      abort.signal.throwIfAborted();
      stage = "publish-owner-socket";
      publicIdentity = await listen(relay.server, app);
      if (standaloneCapability !== undefined) {
        writeFileSync(capabilityPath, `${standaloneCapability}\n`, ownerOnly);
        capabilityOwned = true;
      }
      const receipt: OwnerReady = {
        version: 1,
        pid: process.pid,
        uid: process.getuid!(),
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        startTicks: processIdentity(process.pid).startTicks,
        socketDev: publicIdentity.dev,
        socketIno: publicIdentity.ino,
      };
      if (!original() || abort.signal.aborted) throw new Error("native_stopped_during_startup");
      writeFileSync(stagedReceipt, `${JSON.stringify(receipt)}\n`, ownerOnly);
      renameSync(stagedReceipt, finalReceipt);
      receiptOwned = true;
      readyResolve(receipt);
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) resolve();
        else abort.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      requestedStop = child.exitCode === null && child.signalCode === null && original();
    } catch (error) {
      if (stage === "wait-original-native")
        report("box", "listener", safeReason(error, abort.signal.aborted ? "stopped" : "refused"));
      process.stderr.write(`strands-box-host: startup refused at ${stage}\n`);
      readyReject(new Error(`startup_refused:${stage}`));
    } finally {
      relay?.close();
      handoff?.close();
      if (watch !== undefined) clearInterval(watch);
      function removeOwned(path: string): void {
        try {
          unlinkSync(path);
        } catch (error) {
          if (
            error === null ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            cleanupFailed = true;
        }
      }
      if (receiptOwned) removeOwned(finalReceipt);
      if (capabilityOwned) removeOwned(capabilityPath);
      if (pinnedIdentity !== undefined && sameSocket(pinned, pinnedIdentity)) removeOwned(pinned);
      if (publicIdentity !== undefined && sameSocket(app, publicIdentity)) removeOwned(app);
      if (
        child !== undefined &&
        child.exitCode === null &&
        child.signalCode === null &&
        childDone !== undefined
      ) {
        child.kill("SIGTERM");
        const kill = setTimeout(() => child?.kill("SIGKILL"), OWNER_STOP_MS);
        await childDone;
        clearTimeout(kill);
      }
    }
    if (diagnosticDone !== undefined) await drainDiagnostics(diagnosticDone);
    child?.stderr?.destroy();
    child?.stdout?.destroy();
    if (cleanupFailed) throw new Error("owner_cleanup_failed");
    return requestedStop ? 0 : (await childDone) || 1;
  }
}

export function ensureEmpty(path: string): void {
  if (readdirSync(path).length !== 0) throw new Error("runtime_already_used");
}

export function smokeInput(config: HostConfig): { input: StartInput; capability: string } {
  const capability = randomBytes(32).toString("base64url");
  const sibling = join(dirname(config.runtimeDir), `${basename(config.runtimeDir)}-home`);
  checked("owner-home-create", () => mkdirSync(sibling, { mode: 0o700 }));
  const codexHome = join(sibling, "codex");
  try {
    checked("codex-home-create", () => mkdirSync(codexHome, { mode: 0o700 }));
  } catch (error) {
    try {
      rmSync(sibling, { recursive: true, force: true });
    } catch {
      /* Keep the original stage. */
    }
    throw error;
  }
  const digest = createHash("sha256").update(capability).digest("hex");
  return {
    capability,
    input: {
      command: [
        config.codexBin,
        "app-server",
        "--listen",
        `ws://127.0.0.1:${PORT}`,
        "--ws-auth",
        "capability-token",
        "--ws-token-sha256",
        digest,
      ],
      environment: {
        HOME: sibling,
        CODEX_HOME: codexHome,
        PATH,
        APP_SERVER_PORT: String(PORT),
        APP_TOKEN_SHA: digest,
      },
      readOnly: [],
      writable: [sibling],
    },
  };
}

function prepareStandalone(path: string): ReturnType<typeof smokeInput> & { config: HostConfig } {
  const data = checked("config-file", () => readConfig(path));
  const config = hostConfig(data);
  if (process.arch !== "arm64") throw startupFailure("platform", new Error("linux_arm64_required"));
  checked("runtime-claim", () => ensureEmpty(config.runtimeDir));
  process.umask(0o077);
  return { config, ...smokeInput(config) };
}

function retireSmoke(input: StartInput): void {
  const home = input.writable[0];
  if (home !== undefined)
    checked("retirement", () => rmSync(home, { recursive: true, force: true }));
}

export function standalonePreflight(path: string): void {
  const { input } = prepareStandalone(path);
  retireSmoke(input);
}

async function standalone(path: string): Promise<number> {
  const { config, input, capability } = prepareStandalone(path);
  try {
    const execution = start(config, input, capability);
    const onStop = () => {
      void execution.stop();
    };
    process.once("SIGTERM", onStop);
    process.once("SIGINT", onStop);
    try {
      await execution.ready;
      process.stdout.write("strands-box-host: ready\n");
      return await execution.done;
    } finally {
      process.off("SIGTERM", onStop);
      process.off("SIGINT", onStop);
      await execution.stop();
    }
  } finally {
    retireSmoke(input);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const preflight = process.argv[2] === "--preflight";
    const path = process.argv[preflight ? 3 : 2];
    if (path === undefined || process.argv.length !== (preflight ? 4 : 3))
      throw startupFailure("usage", new Error("usage"));
    if (preflight) {
      standalonePreflight(path);
      process.stdout.write("strands-box-host: preflight ready\n");
    } else {
      process.exitCode = await standalone(path);
    }
  } catch (error) {
    const failure = startupFailure("launch", error);
    process.stderr.write(`strands-box-host: startup refused ${failure.message}\n`);
    process.exitCode = 1;
  }
}
