import { spawn } from "node:child_process";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
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
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOX_UPSTREAM_CA_KEY,
  CONTROLLED_INFERENCE_MARKER,
  MODEL_KEY_ENV,
  modelCredentials,
  policy,
  githubCredentials,
  upstreamCaPem,
} from "./egress.ts";
import {
  MODEL_MAX_BODY_BYTES,
  SOURCE_BEARER_ENV,
  SOURCE_MAX_BODY_BYTES,
  SOURCE_TIMEOUT_MS,
} from "./credential-source.ts";
import {
  collectDiagnostics,
  drainDiagnostics,
  exitReason,
  report,
  safeReason,
} from "./diagnostics.ts";
import type { EgressRoute, UpstreamCa } from "./egress.ts";
import {
  WORKSPACE_VERIFIER,
  verifyWorkspaceVerifier,
  workspaceVerifierPolicy,
  workspaceVerifierTool,
} from "./workspace-verifier.ts";
import {
  ensureWorkspaceCodex,
  execCoversGit,
  stockGitPolicy,
  stockGitTools,
} from "./stock-git.ts";
import {
  nativeHookPolicy,
  nativeHookProbe,
  nativeHookTool,
  verifyNativeHookCommand,
} from "./native-hook.ts";
import {
  BOOTSTRAP_MS,
  bridge,
  ENROLLMENT_PATH,
  ENROLLMENT_WAIT_MS,
  INVALID_CAPABILITY,
  listen,
  PORT,
  processIdentity,
  RELEASE_LINE,
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
/**
 * The Harness HOME's native hook credential directory (Compute's NATIVE_HOOK_CREDENTIAL_DIRECTORY).
 * The stock Harness program that prepares it does not run in Box, so the host gives each
 * execution a fresh, empty, private one; Codex writes only the Gateway's relay credentials there.
 */
export const NATIVE_HOOK_DIRECTORY = "/home/node/.oce-native-hooks";
export const OWNER_STOP_MS = 10_000;
// Box hosts: Linux ARM64 (released Box) or Linux x86-64 (Box main and fork builds, which the
// launcher starts with EXPERIMENTAL_X86_SUPPORT=TRUE). Box itself refuses any other platform.
export function boxHostArch(arch: string = process.arch): boolean {
  return arch === "arm64" || arch === "x64";
}
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
  "agent_exec_covers_git",
  "owner_config_file",
  "linux_arm64_required",
  "runtime_already_used",
  "owner_cleanup_failed",
  "startup_refused:stage-inputs",
  "startup_refused:start-box",
  "startup_refused:wait-release",
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
  /**
   * Protected startup: Box's request-time credential source for the two GitHub routes. `socket`
   * is the host's listener in a directory no grant covers; `bearer` is the per-execution bearer
   * the paired Driver minted, held only in memory and in the `box run` environment. Box presents
   * it to the source with each ask. No token is ever given to Box.
   */
  credentialSource?: {
    readonly socket: string;
    readonly bearer: string;
    readonly caSha256?: string;
    /**
     * The protected Harness model: Box's second source on its own socket, for the
     * controlled-inference route in `egress`, narrowed to `POST <path>`. Box gives the workload
     * only a placeholder in `OPENAI_API_KEY`; the host relays each request's target to the Worker.
     */
    readonly model?: { readonly socket: string; readonly path: string };
  };
  /** Protected startup: Box starts, but the command waits until `release()` is called. */
  releaseGate?: true;
  /**
   * Protected startup: the reservation generation the host fixed before any material existed,
   * repeated in ready.json and presented by host ingress.
   */
  reservationGeneration?: string;
  /** The execution's one extra upstream CA bundle; every route in `egress` must opt in to it. */
  upstreamCa?: UpstreamCa;
  /** Recreate this exact directory empty (0700) and grant it writable: `NATIVE_HOOK_DIRECTORY`. */
  nativeHookDirectory?: string;
}

/** The trusted `box run` process of this execution, read from /proc after spawn. */
export interface BoxProcess {
  readonly bootId: string;
  readonly pid: number;
  readonly startTicks: string;
}

export interface OwnerReady {
  version: 1;
  pid: number;
  uid: number;
  bootId: string;
  startTicks: string;
  socketDev: string;
  socketIno: string;
  /** Protected startup only: the reservation generation reported before the release. */
  generationSha256?: string;
}

export interface Execution {
  readonly ready: Promise<OwnerReady>;
  readonly done: Promise<number>;
  /** Present once `box run` was spawned; `undefined` before that or after it exited. */
  boxProcess(): BoxProcess | undefined;
  /** Settles once `box run` was spawned (or refused before that). */
  readonly spawned: Promise<void>;
  /**
   * Protected startup only: SHA-256 of the reservation (this host process, the execution and the
   * execution bearer digest), fixed before the release and repeated in ready.json.
   */
  generation(): string | undefined;
  /** Open the protected startup gate once; only the caller that verified the release calls it. */
  release(): Promise<void>;
  /**
   * Protected startup only: one enrollment request to the stock program's own challenge listener
   * in Box, through the bridge the host pinned before it opened the gate. `undefined` while the
   * program is not listening yet and after Codex listens (the bridge is closed then).
   */
  enrollment(request: EnrollmentRequest): Promise<EnrollmentAnswer | undefined>;
  stop(): Promise<number>;
}

/** The only two requests the host sends to the stock program's enrollment listener. */
export type EnrollmentRequest =
  | { readonly method: "GET"; readonly bearer: string }
  | { readonly method: "POST"; readonly bearer: string; readonly body: string };

export interface EnrollmentAnswer {
  readonly status: number;
  readonly document: unknown;
}

/** The stock program caps the release body at 4 KiB; its answers are smaller still. */
export const ENROLLMENT_MAX_BYTES = 4_096;
const BEARER = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * Send one enrollment request over a Unix socket and read one bounded JSON answer. `undefined`
 * when nothing answers: no listener, a closed bridge, a timeout, or an oversized answer.
 */
export function enrollmentRequest(
  socketPath: string,
  input: EnrollmentRequest,
): Promise<EnrollmentAnswer | undefined> {
  if (
    input.bearer.length === 0 ||
    input.bearer.length > 4_096 ||
    !BEARER.test(input.bearer) ||
    (input.method === "POST" && Buffer.byteLength(input.body) > ENROLLMENT_MAX_BYTES)
  ) {
    return Promise.reject(new Error("invalid_enrollment_request"));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: EnrollmentAnswer | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outgoing.destroy();
      resolve(answer);
    };
    const outgoing = httpRequest(
      {
        socketPath,
        method: input.method,
        path: ENROLLMENT_PATH,
        agent: false,
        headers: {
          host: "localhost",
          authorization: `Bearer ${input.bearer}`,
          connection: "close",
          ...(input.method === "POST"
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(input.body)),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > ENROLLMENT_MAX_BYTES) finish(undefined);
          else chunks.push(chunk);
        });
        response.once("error", () => finish(undefined));
        response.once("end", () => {
          let document: unknown;
          try {
            document = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          } catch {
            document = null;
          }
          finish({ status: response.statusCode ?? 0, document });
        });
      },
    );
    // Inside the host control request's own 5 s and the Worker's.
    const timer = setTimeout(() => finish(undefined), 3_000);
    outgoing.once("error", () => finish(undefined));
    outgoing.end(input.method === "POST" ? input.body : undefined);
  });
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
    exec: checked("exec-grants", () => {
      // Codex's own git would evaluate workspace Git configuration in the agent's boundary.
      if (
        Array.isArray(data.exec) &&
        execCoversGit(data.exec.filter((path): path is string => typeof path === "string"))
      )
        throw new Error("agent_exec_covers_git");
      return grants(data.exec);
    }),
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

/**
 * Compute's two public enrollment inputs, which the stock protected program reads to verify its
 * own release: the admitted revision id and Compute's Ed25519 release verification key (SPKI DER,
 * base64url, 59 characters). Neither authorizes anything; only a gated run takes them.
 */
export const ENROLLMENT_REVISION_ENV = "OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID";
export const RELEASE_PUBLIC_KEY_ENV = "OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY";

function releaseVerificationKey(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{59}$/.test(value)) return false;
  try {
    return (
      createPublicKey({ key: Buffer.from(value, "base64url"), format: "der", type: "spki" })
        .asymmetricKeyType === "ed25519"
    );
  } catch {
    return false;
  }
}

function safeEnvironment(
  environment: Readonly<Record<string, string>>,
  hasControlledInference: boolean,
  gated: boolean,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (key === ENROLLMENT_REVISION_ENV || key === RELEASE_PUBLIC_KEY_ENV) {
      if (
        !gated ||
        typeof value !== "string" ||
        (key === RELEASE_PUBLIC_KEY_ENV
          ? !releaseVerificationKey(value)
          : !/^[A-Za-z0-9_-]{1,128}$/.test(value))
      )
        throw new Error("unsupported_environment");
      result[key] = value;
      continue;
    }
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
  beforeBoxExec?: () => string | void,
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
  let boxRun: BoxProcess | undefined;
  let boxOwner: ProcessIdentity | undefined;
  let gate: ReturnType<typeof createServer> | undefined;
  let gatePath: string | undefined;
  // The in-Box enrollment bridge (`box-agent`), its host-only pinned link and its inode.
  let enrollInner: string | undefined;
  let enrollPinned: string | undefined;
  let enrollIdentity: SocketIdentity | undefined;
  let enrollClosed = false;
  let gateStopped = false;
  let reservation: string | undefined;
  let gateOpened!: () => void;
  const opened = new Promise<void>((resolve) => {
    gateOpened = resolve;
  });
  let spawnedResolve!: () => void;
  let spawnedReject!: (reason: Error) => void;
  const spawned = new Promise<void>((resolve, reject) => {
    spawnedResolve = resolve;
    spawnedReject = reject;
  });
  void spawned.catch(() => {});
  const done = run();
  return {
    ready,
    spawned,
    done,
    async release() {
      const owner = boxOwner;
      const path = gatePath;
      if (
        gate !== undefined ||
        gateStopped ||
        path === undefined ||
        owner === undefined ||
        !sameProcess(owner) ||
        abort.signal.aborted
      ) {
        throw new Error("release_gate_unavailable");
      }
      // Pin box-agent's enrollment bridge while nothing but box-agent runs in Box: the workload
      // starts only after this gate opens, so a later replacement of the visible path is ignored.
      if (enrollIdentity === undefined) {
        const inner = enrollInner;
        const pinned = enrollPinned;
        if (inner === undefined || pinned === undefined)
          throw new Error("release_gate_unavailable");
        const identity = await waitFor(
          () => {
            try {
              return socketIdentity(inner);
            } catch {
              return undefined;
            }
          },
          abort.signal,
          3_000,
        ).catch(() => {
          throw new Error("enrollment_bridge_unavailable");
        });
        if (gate !== undefined || gateStopped || !sameProcess(owner))
          throw new Error("release_gate_unavailable");
        linkSync(inner, pinned);
        if (!sameSocket(pinned, identity)) {
          unlinkSync(pinned);
          throw new Error("enrollment_bridge_replaced");
        }
        enrollIdentity = identity;
      }
      gate = createServer((socket) => {
        socket.on("error", () => socket.destroy());
        if (!sameProcess(owner) || abort.signal.aborted) socket.destroy();
        else socket.end(RELEASE_LINE);
      });
      await listen(gate, path);
      gateOpened();
    },
    async enrollment(request) {
      const pinned = enrollPinned;
      const identity = enrollIdentity;
      const owner = boxOwner;
      if (
        enrollClosed ||
        gate === undefined ||
        pinned === undefined ||
        identity === undefined ||
        owner === undefined ||
        !sameProcess(owner) ||
        abort.signal.aborted ||
        !sameSocket(pinned, identity)
      ) {
        return undefined;
      }
      return enrollmentRequest(pinned, request);
    },
    generation: () => reservation,
    boxProcess: () =>
      boxRun !== undefined && boxOwner !== undefined && sameProcess(boxOwner) ? boxRun : undefined,
    stop: () => {
      abort.abort();
      return done;
    },
  };

  async function run(): Promise<number> {
    let verifiedBootId: string | void;
    const run = config.runtimeDir;
    // The runtime directory is single-use per run; Box starts once per execution.
    const work = run;
    const authority = join(work, "authority");
    const bridgeDir = join(work, "bridge");
    const projectionDir = join(work, "projection");
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
      const staging = join(work, "input");
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
      const source = input.credentialSource;
      if (
        // A protected run is reserved, held at the gate, and carries the GitHub source routes
        // from its one start. An ordinary run takes none of them.
        (input.reservationGeneration === undefined) !== (input.releaseGate !== true) ||
        (input.releaseGate === true) !== (source !== undefined) ||
        (input.reservationGeneration !== undefined &&
          !/^[a-f0-9]{64}$/.test(input.reservationGeneration)) ||
        (source !== undefined &&
          (!/^[A-Za-z0-9_-]{43}$/.test(source.bearer) ||
            !pathWithin(run, source.socket) ||
            source.socket === run)) ||
        Object.keys(effectiveEnvironment).some((name) =>
          /^(?:GITHUB_|GH_|GIT_|OCE_GITHUB_|OCE_SOURCE_)/.test(name),
        )
      ) {
        throw new Error("github_route_unadmitted");
      }
      const modelSource = source?.model;
      const modelRoute = input.egress?.filter((route) => route.kind === "controlled-inference");
      if (
        modelSource !== undefined &&
        // Box alone sets the model placeholder; the admitted environment carries no model value.
        (Object.hasOwn(effectiveEnvironment, MODEL_KEY_ENV) ||
          modelRoute?.length !== 1 ||
          !pathWithin(run, modelSource.socket) ||
          modelSource.socket === source?.socket ||
          dirname(modelSource.socket) !== dirname(source!.socket) ||
          new URL(modelRoute[0]!.url).pathname + "/responses" !== modelSource.path)
      ) {
        throw new Error("model_route_unadmitted");
      }
      // Used only in the spawn below; never written to a file.
      const sourceEnvironment =
        source === undefined ? undefined : { [SOURCE_BEARER_ENV]: source.bearer };
      const environment = safeEnvironment(
        effectiveEnvironment,
        input.egress?.some((route) => route.kind === "controlled-inference") === true,
        input.releaseGate === true,
      );
      // The stock protected program verifies its own release with these; without them it fails.
      if (
        input.releaseGate === true &&
        (environment[ENROLLMENT_REVISION_ENV] === undefined ||
          environment[RELEASE_PUBLIC_KEY_ENV] === undefined)
      )
        throw new Error("enrollment_environment_missing");
      const readOnly = input.readOnly.map(cleanPath);
      const hooks = input.nativeHookDirectory;
      if (hooks !== undefined) {
        if (
          hooks !== NATIVE_HOOK_DIRECTORY ||
          environment.HOME !== dirname(hooks) ||
          input.writable.some((path) => pathWithin(path, hooks) || pathWithin(hooks, path))
        )
          throw new Error("native_hook_directory");
        // Box runs the hook command only under the exact permit and table below; the files it
        // names must be root's alone.
        verifyNativeHookCommand();
        // As the stock Harness does for its HOME: remove whatever is there (a link itself, never
        // its target) and start each execution with an empty private directory.
        rmSync(hooks, { recursive: true, force: true });
        mkdirSync(hooks, { mode: 0o700 });
        chmodSync(hooks, 0o700);
      }
      const writable = [...input.writable, ...(hooks === undefined ? [] : [hooks])].map(
        privateDirectory,
      );
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
      const caFile = join(authority, "upstream-ca.pem");
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
          ...(input.releaseGate === true
            ? {
                releaseSocket: join(projectionDir, "release.sock"),
                enrollmentSocket: join(bridgeDir, "enroll.sock"),
              }
            : {}),
          // The in-Box agent refuses to start Codex unless this exact hook command runs.
          ...(hooks === undefined ? {} : { nativeHookProbe: nativeHookProbe(hooks) }),
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
      // The git and gh tables deny the workspace's `.codex`, which must exist when Box starts.
      if (source !== undefined) ensureWorkspaceCodex(config.workspace);
      writeFileSync(
        policyFile,
        policy(input.egress ?? [], source !== undefined) +
          // A protected repository run: the workload's shell runs stock git and gh (finding 3314).
          (source === undefined ? "" : stockGitPolicy(config.workspace)) +
          (verifier === undefined ? "" : workspaceVerifierPolicy(config.workspace)) +
          (hooks === undefined ? "" : nativeHookPolicy(config.workspace, hooks)),
        ownerOnly,
      );
      // Only the CA bundle verified at host config load is written, into the authority directory
      // that no grant covers, and only when every route Box dials opts in to it again here.
      // Stock Box refuses the key, so it fails closed before any egress.
      // Box trusts the bundle for every upstream, GitHub included: the GitHub routes opt in too.
      if (source !== undefined && source.caSha256 !== input.upstreamCa?.sha256)
        throw new Error("upstream_ca_route_not_declared");
      const caPem =
        upstreamCaPem(input.upstreamCa, input.egress ?? []) ??
        (source?.caSha256 === undefined || input.upstreamCa === undefined
          ? undefined
          : `${input.upstreamCa.pem.trim()}\n`);
      if (caPem !== undefined) writeFileSync(caFile, caPem, ownerOnly);
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
        ...(input.workspaceNodeSetupCode === undefined && input.releaseGate !== true
          ? []
          : [projectionDir]),
      ]);
      const write = outermost([...writable, config.workspace, bridgeDir]);
      const exec = outermost([...config.exec, config.codexBin, config.nodeBin]);
      // Also no git or gh on the search path the agent's environment names (finding 3325).
      if (execCoversGit(exec, (environment.PATH ?? "").split(":").filter(isAbsolute)))
        throw new Error("agent_exec_covers_git");
      const configText = [
        'name = "oce-strands"',
        `box_dir = ${quoted(join(work, "box-state"))}`,
        `policy = ${quoted(policyFile)}`,
        "",
        ...(caPem === undefined
          ? []
          : ["[gateway]", `${BOX_UPSTREAM_CA_KEY} = ${quoted(caFile)}`, ""]),
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
      // The credential tables name a socket and variables; no credential enters box.toml.
      writeFileSync(
        boxFile,
        configText +
          (source === undefined
            ? ""
            : "\n" +
              githubCredentials({
                socket: source.socket,
                bearerEnv: SOURCE_BEARER_ENV,
                timeoutMs: SOURCE_TIMEOUT_MS,
                maxBodyBytes: SOURCE_MAX_BODY_BYTES,
              })) +
          (modelSource === undefined || modelRoute === undefined
            ? ""
            : "\n" +
              modelCredentials(modelRoute[0]!, {
                socket: modelSource.socket,
                bearerEnv: SOURCE_BEARER_ENV,
                timeoutMs: SOURCE_TIMEOUT_MS,
                maxBodyBytes: MODEL_MAX_BODY_BYTES,
                path: modelSource.path,
              })) +
          (verifier === undefined ? "" : "\n" + workspaceVerifierTool(config.workspace)) +
          (hooks === undefined ? "" : "\n" + nativeHookTool(config.workspace, hooks)) +
          // A protected repository run: git and gh in their own boundaries (finding 3320).
          (source === undefined
            ? ""
            : "\n" + stockGitTools(config.workspace, agentHome, verifier !== undefined)),
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
      verifiedBootId = beforeBoxExec?.();
      report("box", "exec", "entered");
      child = spawn(config.boxBin, ["run", "--config", boxFile], {
        cwd: config.workspace,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: boxHome,
          PATH,
          LANG: "C.UTF-8",
          EXPERIMENTAL_LINUX_SUPPORT: "TRUE",
          // Box main runs on Linux x86-64 only with this exact opt-in; ARM64 needs none.
          ...(process.arch === "x64" ? { EXPERIMENTAL_X86_SUPPORT: "TRUE" } : {}),
          ...sourceEnvironment,
        },
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
      if (input.releaseGate === true) {
        gatePath = join(projectionDir, "release.sock");
        enrollInner = join(bridgeDir, "enroll.sock");
        enrollPinned = join(run, "enroll-pinned.sock");
      }
      boxOwner = owner;
      boxRun = {
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        pid: owner.pid,
        startTicks: owner.startTicks,
      };
      reservation = input.reservationGeneration;
      spawnedResolve();
      if (input.releaseGate === true) {
        stage = "wait-release";
        // No deadline: the held execution waits for Compute's release or for retirement.
        await new Promise<void>((resolve, reject) => {
          if (abort.signal.aborted) reject(new Error("stopped"));
          abort.signal.addEventListener("abort", () => reject(new Error("stopped")), {
            once: true,
          });
          void opened.then(resolve);
        });
      }
      stage = "wait-original-native";
      report("box", "listener", "entered");
      // A gated run's stock program first waits for its own enrollment (at most 180 s).
      pinnedIdentity = await waitFor(
        () => {
          try {
            return socketIdentity(inner);
          } catch {
            return undefined;
          }
        },
        abort.signal,
        input.releaseGate === true ? ENROLLMENT_WAIT_MS : BOOTSTRAP_MS,
      );
      report("box", "listener", "observed");
      // Codex listens: the program was released, so the pre-ready enrollment path ends here.
      enrollClosed = true;
      if (enrollIdentity !== undefined && sameSocket(enrollPinned!, enrollIdentity)) {
        try {
          unlinkSync(enrollPinned!);
        } catch {
          /* Removed again, and checked, at retirement. */
        }
      }
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
        bootId: verifiedBootId ?? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        startTicks: processIdentity(process.pid).startTicks,
        socketDev: publicIdentity.dev,
        socketIno: publicIdentity.ino,
        ...(reservation === undefined ? {} : { generationSha256: reservation }),
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
      const refusal = new Error(`startup_refused:${stage}`);
      spawnedReject(refusal);
      readyReject(refusal);
    } finally {
      gateStopped = true;
      gate?.close();
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
      enrollClosed = true;
      if (
        enrollIdentity !== undefined &&
        enrollPinned !== undefined &&
        sameSocket(enrollPinned, enrollIdentity)
      )
        removeOwned(enrollPinned);
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
  if (!boxHostArch()) throw startupFailure("platform", new Error("linux_arm64_required"));
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
