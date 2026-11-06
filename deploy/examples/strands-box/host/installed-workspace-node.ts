import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { basename, dirname, join, sep } from "node:path";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  CODEX_WORKSPACE_NODE_COMMANDS,
  PROVIDER_CODEX_ONLY_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  nodeProgramArguments,
  withoutLineComments,
} from "../../../../apps/controller/src/drivers/compute/node-program.ts";
import type { EgressRoute } from "./egress.ts";
import { fields, object, privateDirectory, string } from "./launch.ts";
import { bridge, listen } from "./transport.ts";

export const SEPARATE_WORKSPACE_NODE = "file-only-v1";
export const FILE_NODE_STATE = "/home/node/.openclaw-node";
const BWRAP = "/usr/bin/bwrap";
const SHA256 = /^[a-f0-9]{64}$/;

export interface MountIdentity {
  readonly dev: string;
  readonly ino: string;
}

export interface NodeInstallation {
  readonly mode: typeof SEPARATE_WORKSPACE_NODE;
  readonly rootfs: string;
  readonly rootfsIdentity: MountIdentity;
  readonly runtimeSha256: string;
  readonly caSha256?: string;
  readonly workspaceVolume: { readonly claimUid: string; readonly volumeName: string };
}

export interface NodeLaunch {
  readonly installation: NodeInstallation;
  readonly workspace: string;
  readonly workspaceIdentity: MountIdentity;
  readonly stateIdentity: MountIdentity;
  readonly volumeMounts: readonly {
    readonly path: string;
    readonly subPath: string;
    readonly identity: MountIdentity;
  }[];
  readonly runtime: string;
  readonly route: EgressRoute;
  readonly ca?: string;
  readonly displayName: string;
  readonly setupCode?: string;
  readonly expiresAt?: number;
}

export function mountIdentity(value: unknown): MountIdentity {
  const identity = object(value);
  fields(identity, ["dev", "ino"]);
  const dev = string(identity.dev);
  const ino = string(identity.ino);
  if (!/^\d+$/.test(dev) || !/^[1-9]\d*$/.test(ino)) throw new Error("invalid_mount_identity");
  return { dev, ino };
}

export function fileIdentity(path: string): MountIdentity {
  const stat = lstatSync(privateDirectory(path), { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameMount(observed: MountIdentity, expected: MountIdentity): boolean {
  return observed.dev === expected.dev && observed.ino === expected.ino;
}

export function assertPinnedDirectory(path: string, expected: MountIdentity): void {
  if (!sameMount(fileIdentity(path), expected)) throw new Error("workspace_mount_replaced");
}

export function nodeInstallation(value: unknown): NodeInstallation {
  const data = object(value);
  fields(data, [
    "mode",
    "rootfs",
    "rootfsIdentity",
    "runtimeSha256",
    "caSha256",
    "workspaceVolume",
  ]);
  const runtimeSha256 = string(data.runtimeSha256);
  const caSha256 = data.caSha256 === undefined ? undefined : string(data.caSha256);
  const volume = object(data.workspaceVolume);
  fields(volume, ["claimUid", "volumeName"]);
  const claimUid = string(volume.claimUid);
  const volumeName = string(volume.volumeName);
  if (
    data.mode !== SEPARATE_WORKSPACE_NODE ||
    !SHA256.test(runtimeSha256) ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(claimUid) ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(volumeName) ||
    (caSha256 !== undefined && !SHA256.test(caSha256))
  ) {
    throw new Error("invalid_file_node_installation");
  }
  const rootfs = privateDirectory(data.rootfs);
  const rootfsIdentity = mountIdentity(data.rootfsIdentity);
  assertPinnedDirectory(rootfs, rootfsIdentity);
  return {
    mode: SEPARATE_WORKSPACE_NODE,
    rootfs,
    rootfsIdentity,
    runtimeSha256,
    workspaceVolume: { claimUid, volumeName },
    ...(caSha256 === undefined ? {} : { caSha256 }),
  };
}

export function splitStockCommand(program: Buffer): readonly string[] {
  if (!program.equals(Buffer.from(withoutLineComments(AGENT_WITH_NODE_ENTRYPOINT)))) {
    throw new Error("unrecognized_combined_workspace_node_command");
  }
  return [...RUNTIME_WRAPPER_COMMAND, ...nodeProgramArguments(PROVIDER_CODEX_ONLY_ENTRYPOINT)];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertNodeTrust(route: EgressRoute, ca: string | undefined, pin?: string): void {
  const url = new URL(route.url);
  if (route.kind !== "workspace-node" || isIP(url.hostname) !== 0 || Number(url.port) < 1024) {
    throw new Error("file_node_requires_fixed_unprivileged_tls_origin");
  }
  if (ca === undefined && pin === undefined) return;
  if (
    ca === undefined ||
    pin !== sha256(ca) ||
    !/^(?:-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*)+$/u.test(
      ca,
    )
  ) {
    throw new Error("unadmitted_file_node_gateway_ca");
  }
  const certs = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu) ?? [];
  if (certs.some((cert) => !new X509Certificate(cert).ca)) {
    throw new Error("unadmitted_file_node_gateway_ca");
  }
}

function mountedDirectories() {
  const unescape = (path: string) =>
    path.replace(/\\([0-7]{3})/gu, (_escape, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
  return readFileSync("/proc/self/mountinfo", "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [, , device, root, path] = line.split(" ");
      if (!device || !root?.startsWith("/") || !path?.startsWith("/")) {
        throw new Error("invalid_file_node_mount_inventory");
      }
      return { device, root: unescape(root), path: unescape(path) };
    });
}

export function assertNodeInputs(input: NodeLaunch): void {
  assertPinnedDirectory(input.installation.rootfs, input.installation.rootfsIdentity);
  const observed = mountedDirectories();
  const writable = new Set([
    input.installation.rootfs,
    ...input.volumeMounts.map(({ path }) => path),
  ]);
  const sources = new Set<string>();
  for (const { path, subPath, identity } of input.volumeMounts) {
    assertPinnedDirectory(path, identity);
    const bindings = observed.filter((mount) => mount.path === path);
    const [binding] = bindings;
    if (bindings.length !== 1 || binding === undefined || basename(binding.root) !== subPath) {
      throw new Error("file_node_requires_exact_bound_volume_subpaths");
    }
    sources.add(`${binding.device}:${dirname(binding.root)}`);
  }
  if (sources.size !== 1) throw new Error("file_node_requires_one_bound_volume");
  if (observed.some(({ path }) => [...writable].some((root) => path.startsWith(root + sep)))) {
    throw new Error("file_node_nested_mount");
  }
  assertNodeTrust(input.route, input.ca, input.installation.caSha256);
}

export function nodeRuntimeBytes(input: NodeLaunch): Buffer {
  const script = lstatSync(input.runtime);
  if (!script.isFile() || script.size > 32_768 || (script.mode & 0o7022) !== 0) {
    throw new Error("file_node_runtime_changed");
  }
  const bytes = readFileSync(input.runtime, {
    flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  });
  if (bytes.length > 32_768 || sha256(bytes) !== input.installation.runtimeSha256) {
    throw new Error("file_node_runtime_changed");
  }
  return bytes;
}

function openPinned(path: string, pin: MountIdentity): number {
  const fd = openSync(path, constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!sameMount({ dev: String(stat.dev), ino: String(stat.ino) }, pin)) {
      throw new Error("workspace_mount_replaced");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// The mount descriptors are inherited as 3–5. Linux mounts those exact
// directories, even if a path changes between validation and process start.
export function workspaceNodeArguments(
  input: NodeLaunch,
  paths: {
    readonly hosts: string;
    readonly socket: string;
    readonly ca: string;
    readonly runtime: string;
  },
): string[] {
  return [
    "--unshare-all",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--ro-bind-fd",
    "3",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/home/node",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/tmp",
    "--bind-fd",
    "4",
    input.workspace,
    "--bind-fd",
    "5",
    FILE_NODE_STATE,
    "--ro-bind",
    paths.hosts,
    "/etc/hosts",
    "--ro-bind",
    paths.socket,
    "/run/oce-file-node/gateway.sock",
    "--ro-bind",
    paths.runtime,
    "/run/oce-file-node/launch.mjs",
    ...(input.ca === undefined ? [] : ["--ro-bind", paths.ca, "/run/oce-file-node/gateway-ca.pem"]),
    "--chdir",
    input.workspace,
    "--",
    "/usr/local/bin/node",
    "/run/oce-file-node/launch.mjs",
  ];
}

export async function startWorkspaceNode(
  input: NodeLaunch,
  directory: string,
  signal: AbortSignal,
): Promise<{ readonly done: Promise<number>; stop(): void }> {
  const code = input.setupCode;
  const expiresAt = input.expiresAt;
  if (code === undefined || expiresAt === undefined || Date.now() >= expiresAt) {
    throw new Error("file_node_setup_expired_or_missing");
  }
  assertNodeInputs(input);
  const runtime = nodeRuntimeBytes(input);
  const wrapper = lstatSync(BWRAP);
  if (!wrapper.isFile() || wrapper.uid !== 0 || (wrapper.mode & 0o7022) !== 0) {
    throw new Error("untrusted_file_node_isolation");
  }
  signal.throwIfAborted();
  const url = new URL(input.route.url);
  const port = Number(url.port);
  mkdirSync(directory, { mode: 0o700 });
  const paths = {
    hosts: join(directory, "hosts"),
    socket: join(directory, "gateway.sock"),
    ca: join(directory, "gateway-ca.pem"),
    runtime: join(directory, "launch.mjs"),
  };
  writeFileSync(paths.hosts, `127.0.0.1 localhost ${url.hostname}\n::1 localhost\n`, {
    flag: "wx",
    mode: 0o600,
  });
  if (input.ca !== undefined) writeFileSync(paths.ca, input.ca, { flag: "wx", mode: 0o600 });
  writeFileSync(paths.runtime, runtime, { flag: "wx", mode: 0o600 });
  const relay = bridge({ host: input.route.address, port }, () => {
    if (signal.aborted) return false;
    try {
      assertNodeInputs(input);
      return true;
    } catch {
      return false;
    }
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    relay.close();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    await listen(relay.server, paths.socket);
    signal.throwIfAborted();
    assertNodeInputs(input);
    if (Date.now() >= expiresAt) throw new Error("file_node_setup_expired_or_missing");
    const descriptors: number[] = [];
    const child = (() => {
      try {
        descriptors.push(openPinned(input.installation.rootfs, input.installation.rootfsIdentity));
        descriptors.push(openPinned(input.workspace, input.workspaceIdentity));
        descriptors.push(openPinned(FILE_NODE_STATE, input.stateIdentity));
        return spawn(BWRAP, workspaceNodeArguments(input, paths), {
          stdio: ["pipe", "pipe", "ignore", ...descriptors],
          env: {},
        });
      } finally {
        for (const fd of descriptors) closeSync(fd);
      }
    })();
    let forcedStop: NodeJS.Timeout | undefined;
    const stop = () => {
      relay.close();
      child.kill("SIGTERM");
      forcedStop ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    signal.addEventListener("abort", stop, { once: true });
    const done = new Promise<number>((resolve) => {
      child.once("error", () => resolve(1));
      child.once("close", (code) => resolve(code ?? 1));
    });
    void done.then(() => {
      clearTimeout(forcedStop);
      signal.removeEventListener("abort", stop);
      close();
    });
    const localStart = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("file_node_start_timeout")), 10_000);
      child.stdout?.once("data", (line: Buffer) => {
        clearTimeout(timer);
        if (line.toString("utf8") === "file-node-started\n") resolve();
        else reject(new Error("file_node_start_refused"));
      });
      void done.then(() => {
        clearTimeout(timer);
        reject(new Error("file_node_start_refused"));
      });
    });
    child.stdin?.on("error", stop);
    child.stdin?.end(
      JSON.stringify({
        code,
        commands: CODEX_WORKSPACE_NODE_COMMANDS,
        displayName: input.displayName,
        port,
        hasCa: input.ca !== undefined,
      }),
    );
    try {
      await localStart;
      signal.throwIfAborted();
    } catch (error) {
      stop();
      await done;
      throw error;
    }
    return { done, stop };
  } catch (error) {
    close();
    throw error;
  }
}
