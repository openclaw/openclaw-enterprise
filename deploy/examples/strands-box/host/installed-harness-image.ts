import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fields, object, string } from "./launch.ts";
import { mountIdentity } from "./installed-workspace-node.ts";
import type { MountIdentity } from "./installed-workspace-node.ts";

const MODE = "dedicated-read-only-root-v3";
const NODE = "/usr/local/bin/node";
const CODEX = "/opt/oce/runtime/codex/codex";
const TINI = "/usr/bin/tini";
const APP = "/app/openclaw.mjs";
const LOADER = "/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1";
const IMAGE_TREES = [
  "/app",
  "/bin",
  "/etc/ld.so.cache",
  "/etc/ld.so.preload",
  "/etc/ssl",
  "/lib",
  "/opt/oce/runtime",
  "/usr/lib",
  "/usr/local",
  TINI,
];
export const STOCK_BOX = {
  box: "ba33afffe5ae54bdc2e6eaa377f96e54f89d3b10cbb35c666d553854a3a2741b",
  "strands-box-contain-trampoline":
    "58ab37fa0f8fb27a83ae072064cf78f865db4d6334f2c648252af9567983b54c",
  "strands-box-sock-alias": "7c0e69499deb257a7dcfe2d18862742131e3e4fbaa6487f04151f74462909a69",
};
// The host Box release was independently pinned to this Debian ARM64 closure.
// An image selected for the Harness may share these bytes, but cannot replace them.
export const STOCK_BOX_RUNTIME = {
  [LOADER]: "17538b8f9889a470c061f69a8fea8124da89627311cd16546c133a89f09056df",
  "/lib/aarch64-linux-gnu/libc.so.6":
    "e4ac8ae1d81e4865e3aadedb962879cf9415903b3f2ba81ec75e9962b86ab8b0",
  "/lib/aarch64-linux-gnu/libgcc_s.so.1":
    "046856f95f4636f1fc7c3a12bf4f3cd5634c2fc5145c3fdf7395d4f349fa69c7",
  "/lib/aarch64-linux-gnu/libm.so.6":
    "3c4cb3be0b974edf05f023f85ab15107fb5afc2687163593d0d4cf8e80c17b39",
};
const RUNTIME_FILES = {
  node: NODE,
  codex: CODEX,
  tini: TINI,
  openclaw: APP,
};
const AGENT_FILES = {
  agentEntry: "box-agent.js",
  agentTransport: "transport.js",
  agentDiagnostics: "diagnostics.js",
};
const PROC_HELPER = "harness-proc";
const SHA256 = /^[a-f0-9]{64}$/;
// Reproduced from the public OCE Compute draft at 84106ae99484dec818f15c896c65fb1b24247071.
export const HARNESS_SPLIT_COMBINED_SHA256 =
  "669f5a4b92a2cac021bddce8a9ccb1ba3598cef1ce1760ad640e352725d0ef1f";
export const HARNESS_SPLIT_COMMAND_SHA256 =
  "a14ebffa8503ba2ca4f78872b2784d70576b308563ecb01cbb69d34999874402";
const BOOT_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STOCK_PATH =
  "/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface HarnessImageInstallation {
  readonly bootId: string;
  readonly mountId: string;
  readonly root: MountIdentity;
  readonly commandSha256: string;
  readonly proc?: {
    readonly fd: number;
    readonly mountId: string;
    readonly identity: MountIdentity;
    readonly helper: SupportFile;
  };
  readonly support?: {
    readonly directories: readonly string[];
    readonly mounts: string;
    readonly files: readonly SupportFile[];
  };
}

interface SupportFile {
  readonly path: string;
  readonly sha256: string;
  readonly elf: boolean;
  readonly identity: MountIdentity;
}

function overlaps(parent: string, child: string): boolean {
  return (
    parent === "/" ||
    child === "/" ||
    parent === child ||
    child.startsWith(parent + "/") ||
    parent.startsWith(child + "/")
  );
}

/** Validate the effective root and refuse any overmount of an image runtime path. */
export function assertHarnessImageMounts(
  mountinfo: string,
  mountId: string,
  supportDirectories: readonly string[] = [],
  expectedSupportMounts?: string,
): string {
  const unescape = (path: string) =>
    path.replace(/\\([0-7]{3})/gu, (_escape, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
  const mounts = mountinfo
    .trim()
    .split("\n")
    .map((row) => {
      const [id, , device, backing, rawPath, options] = row.split(" ", 7);
      if (!id || !device || !backing?.startsWith("/") || !rawPath?.startsWith("/") || !options) {
        throw new Error("invalid_harness_image_mount_inventory");
      }
      return {
        id,
        device,
        backing: unescape(backing),
        path: unescape(rawPath),
        readOnly: options.split(",").includes("ro"),
      };
    });
  const roots = mounts.filter(({ path }) => path === "/");
  const [root] = roots;
  if (roots.length !== 1 || root?.id !== mountId || !root.readOnly) {
    throw new Error("harness_image_root_not_read_only_or_replaced");
  }
  const scratch = mounts.filter(({ path }) => path === "/tmp");
  if (scratch.length !== 1 || scratch[0]?.readOnly !== false) {
    throw new Error("harness_image_requires_separate_box_scratch");
  }
  for (const mount of mounts) {
    if (mount.path === "/") {
      continue;
    }
    if (IMAGE_TREES.some((tree) => overlaps(tree, mount.path))) {
      throw new Error("harness_image_runtime_overmounted");
    }
    if (!mount.readOnly && mount.device === root.device && overlaps(root.backing, mount.backing)) {
      throw new Error("harness_image_writable_alias");
    }
  }
  const supportMounts = mounts
    .filter(({ path }) => path !== "/" && supportDirectories.some((dir) => overlaps(dir, path)))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(supportMounts.map(({ path }) => path)).size !== supportMounts.length) {
    throw new Error("harness_image_support_mount_refused");
  }
  for (const mount of supportMounts) {
    if (
      !mount.readOnly ||
      supportDirectories.some((dir) => mount.path.startsWith(dir + "/")) ||
      mounts.some(
        (alias) =>
          !alias.readOnly &&
          alias.device === mount.device &&
          overlaps(alias.backing, mount.backing),
      )
    ) {
      throw new Error("harness_image_support_mount_refused");
    }
  }
  const snapshot = JSON.stringify(supportMounts);
  if (expectedSupportMounts !== undefined && expectedSupportMounts !== snapshot) {
    throw new Error("harness_image_support_mount_replaced");
  }
  return snapshot;
}

function inspectHarnessImageView(
  installation: HarnessImageInstallation,
  supportDirectories?: readonly string[],
): string {
  const root = lstatSync("/", { bigint: true });
  if (
    root.uid !== 0n ||
    (root.mode & 0o022n) !== 0n ||
    String(root.dev) !== installation.root.dev ||
    String(root.ino) !== installation.root.ino
  ) {
    throw new Error("harness_image_root_identity_changed");
  }
  return assertHarnessImageMounts(
    readHarnessProc(installation).mountinfo,
    installation.mountId,
    supportDirectories,
    installation.support?.mounts,
  );
}

export function readHarnessProc(installation: HarnessImageInstallation): {
  readonly mountinfo: string;
  readonly bootId: string;
} {
  const proc = installation.proc;
  if (proc === undefined) {
    throw new Error("harness_image_proc_not_pinned");
  }
  const helper = proc.helper;
  verifySupportFile(helper.path, helper.sha256, helper.elf, helper.identity);
  const result = spawnSync(helper.path, [], {
    stdio: ["ignore", "pipe", "ignore", proc.fd],
    env: {},
    encoding: "utf8",
    timeout: 3_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("harness_image_proc_refused");
  }
  const snapshot = object(JSON.parse(result.stdout));
  fields(snapshot, ["mountinfo", "bootId", "proc"]);
  const observed = object(snapshot.proc);
  fields(observed, ["mountId", "dev", "ino"]);
  if (
    observed.mountId !== proc.mountId ||
    observed.dev !== proc.identity.dev ||
    observed.ino !== proc.identity.ino ||
    snapshot.bootId !== installation.bootId
  ) {
    throw new Error("harness_image_proc_identity_changed");
  }
  return {
    bootId: installation.bootId,
    mountinfo: string(snapshot.mountinfo, 512 * 1024),
  };
}

export function assertHarnessImageView(installation: HarnessImageInstallation): void {
  inspectHarnessImageView(installation, installation.support?.directories);
}

export function assertHarnessImageLaunch(installation: HarnessImageInstallation): void {
  assertHarnessImageView(installation);
  if (installation.support === undefined) {
    throw new Error("harness_image_support_not_verified");
  }
  for (const { path, sha256, elf, identity } of installation.support.files) {
    verifySupportFile(path, sha256, elf, identity);
  }
  assertHarnessImageView(installation);
}

export function assertHarnessImageCommand(
  installation: HarnessImageInstallation,
  command: readonly string[],
  path: string | undefined,
): void {
  const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  if (digest !== installation.commandSha256) {
    throw new Error("harness_image_command_changed");
  }
  if (path !== STOCK_PATH) {
    throw new Error("harness_image_requires_stock_path");
  }
}

/** The read grant for /app carries this alias, and the exec grant carries its native target. */
export function assertHarnessImageExecutables(root: string): void {
  const bin = join(root, "/app/node_modules/.bin");
  const codex = join(bin, "codex");
  if (
    realpathSync(bin) !== bin ||
    !lstatSync(codex).isSymbolicLink() ||
    realpathSync(codex) !== join(root, CODEX) ||
    !lstatSync(join(root, CODEX)).isFile()
  ) {
    throw new Error("harness_image_codex_alias_changed");
  }
  accessSync(codex, constants.X_OK);
  for (const directory of STOCK_PATH.split(":")) {
    if (directory === dirname(NODE)) {
      break;
    }
    if (lstatSync(join(root, directory, "node"), { throwIfNoEntry: false }) !== undefined) {
      throw new Error("harness_image_node_path_shadowed");
    }
  }
  accessSync(join(root, NODE), constants.X_OK);
}

function requireRootAncestors(path: string): void {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error("harness_image_owner_path_required");
    }
    if (parent === "/") {
      return;
    }
  }
}

function openRegular(path: string, rootOwned: boolean): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o7022) !== 0 || (rootOwned && stat.uid !== 0)) {
      throw new Error("invalid_harness_image_file");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function verifyHarnessImageFile(
  path: string,
  expected: unknown,
  elf: boolean,
  rootOwned = false,
  original?: MountIdentity,
): MountIdentity {
  if (typeof expected !== "string" || !SHA256.test(expected)) {
    throw new Error("invalid_harness_image_file_digest");
  }
  const fd = openRegular(path, rootOwned);
  try {
    const stat = fstatSync(fd, { bigint: true });
    const identity = { dev: String(stat.dev), ino: String(stat.ino) };
    if (
      original !== undefined &&
      (original.dev !== identity.dev || original.ino !== identity.ino)
    ) {
      throw new Error("harness_image_support_file_replaced");
    }
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(64 * 1024);
    if (stat.size === 0n || stat.size > 256n * 1024n * 1024n) {
      throw new Error("invalid_harness_image_file_size");
    }
    let length = readSync(fd, bytes, 0, bytes.length, null);
    if (
      elf &&
      (length < 20 ||
        !bytes.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) ||
        bytes.readUInt16LE(18) !== 183 ||
        (stat.mode & 0o111n) === 0n)
    ) {
      throw new Error("harness_image_arm64_executable_required");
    }
    while (length !== 0) {
      hash.update(bytes.subarray(0, length));
      length = readSync(fd, bytes, 0, bytes.length, null);
    }
    if (hash.digest("hex") !== expected) {
      throw new Error("harness_image_file_changed");
    }
    return identity;
  } finally {
    closeSync(fd);
  }
}

function verifySupportFile(
  path: string,
  sha256: string,
  elf: boolean,
  original?: MountIdentity,
): MountIdentity {
  requireRootAncestors(path);
  return verifyHarnessImageFile(path, sha256, elf, true, original);
}

function readOwnerJson(path: string, maxBytes: number) {
  if (resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error("invalid_harness_image_owner_path");
  }
  requireRootAncestors(path);
  const fd = openRegular(path, true);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (stat.nlink !== 1n || stat.size > BigInt(maxBytes) || (stat.mode & 0o222n) !== 0n) {
      throw new Error("invalid_harness_image_owner_file");
    }
    return {
      data: JSON.parse(readFileSync(fd, "utf8")) as unknown,
      identity: { dev: String(stat.dev), ino: String(stat.ino) },
    };
  } finally {
    closeSync(fd);
  }
}

export function readHarnessImageSplit(
  buildDir: string,
  image: HarnessImageInstallation,
  expected?: MountIdentity,
) {
  if (image.commandSha256 !== HARNESS_SPLIT_COMMAND_SHA256) {
    throw new Error("harness_image_split_not_approved");
  }
  const file = readOwnerJson(join(buildDir, "harness-split-argv.json"), 512_000);
  if (
    expected !== undefined &&
    (expected.dev !== file.identity.dev || expected.ino !== file.identity.ino)
  ) {
    throw new Error("harness_image_split_replaced");
  }
  return file;
}

export function installHarnessImage(
  receiptPath: unknown,
  image: string,
  config: {
    boxBin: string;
    nodeBin: string;
    codexBin: string;
    agentBuildDir: string;
    read: readonly string[];
    exec: readonly string[];
  },
): HarnessImageInstallation {
  if (
    process.platform !== "linux" ||
    process.arch !== "arm64" ||
    process.getuid?.() !== 1000 ||
    process.getgid?.() !== 1000
  ) {
    throw new Error("harness_image_requires_linux_arm64");
  }
  const data = object(readOwnerJson(string(receiptPath), 4096).data);
  fields(data, ["mode", "image", "bootId", "mountId", "root", "proc", "commandSha256", "files"]);
  const bootId = string(data.bootId);
  const mountId = string(data.mountId);
  const commandSha256 = string(data.commandSha256);
  if (
    data.mode !== MODE ||
    data.image !== image ||
    !BOOT_ID.test(bootId) ||
    !/^[1-9]\d*$/.test(mountId) ||
    !SHA256.test(commandSha256) ||
    config.nodeBin !== NODE ||
    config.codexBin !== CODEX ||
    config.read.length !== 2 ||
    !config.read.includes("/app") ||
    !config.read.includes("/opt/oce/runtime") ||
    config.exec.length !== 1 ||
    config.exec[0] !== TINI ||
    basename(config.boxBin) !== "box" ||
    IMAGE_TREES.some(
      (tree) => overlaps(tree, dirname(config.boxBin)) || overlaps(tree, config.agentBuildDir),
    )
  ) {
    throw new Error("unsupported_harness_image_installation");
  }
  const expectedProc = object(data.proc);
  fields(expectedProc, ["mountId", "dev", "ino"]);
  const procMountId = string(expectedProc.mountId);
  if (!/^[1-9]\d*$/.test(procMountId)) {
    throw new Error("invalid_harness_image_proc_identity");
  }
  const procIdentity = mountIdentity({ dev: expectedProc.dev, ino: expectedProc.ino });
  const files = object(data.files);
  fields(files, [...Object.keys(RUNTIME_FILES), ...Object.keys(AGENT_FILES), "procVerifier"]);
  const helperPath = join(config.agentBuildDir, PROC_HELPER);
  const helperSha256 = string(files.procVerifier);
  const helper = {
    path: helperPath,
    sha256: helperSha256,
    elf: true,
    identity: verifySupportFile(helperPath, helperSha256, true),
  };
  const fd = openSync("/proc", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return verifyInstallation({
      bootId,
      mountId,
      root: mountIdentity(data.root),
      commandSha256,
      proc: { fd, mountId: procMountId, identity: procIdentity, helper },
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }

  function verifyInstallation(installation: HarnessImageInstallation): HarnessImageInstallation {
    const directories = [dirname(config.boxBin), config.agentBuildDir];
    const supportMounts = inspectHarnessImageView(installation, directories);
    if (
      realpathSync("/lib/ld-linux-aarch64.so.1") !== LOADER ||
      lstatSync("/etc/ld.so.cache", { throwIfNoEntry: false }) !== undefined ||
      lstatSync("/etc/ld.so.preload", { throwIfNoEntry: false }) !== undefined ||
      lstatSync("/lib/aarch64-linux-gnu/glibc-hwcaps", { throwIfNoEntry: false }) !== undefined ||
      lstatSync("/usr/lib/aarch64-linux-gnu/glibc-hwcaps", { throwIfNoEntry: false }) !== undefined
    ) {
      throw new Error("harness_image_loader_changed");
    }
    assertHarnessImageExecutables("/");
    for (const [key, runtimePath] of Object.entries(RUNTIME_FILES)) {
      const resolved = realpathSync(runtimePath);
      if (key === "openclaw" ? !resolved.startsWith("/app/") : resolved !== runtimePath) {
        throw new Error("harness_image_runtime_path_changed");
      }
      verifyHarnessImageFile(
        resolved,
        files[key],
        key === "node" || key === "codex" || key === "tini",
      );
    }
    for (const [runtimePath, sha256] of Object.entries(STOCK_BOX_RUNTIME)) {
      if (realpathSync(runtimePath) !== runtimePath) {
        throw new Error("harness_image_loader_changed");
      }
      verifyHarnessImageFile(runtimePath, sha256, false, true);
    }
    const stockBoxFiles = Object.entries(STOCK_BOX).map(([name, sha256]) => ({
      path: join(dirname(config.boxBin), name),
      sha256,
      elf: true,
    }));
    const agentFiles = Object.entries(AGENT_FILES).map(([key, name]) => ({
      path: join(config.agentBuildDir, name),
      sha256: string(files[key]),
      elf: false,
    }));
    const supportFiles = [...stockBoxFiles, ...agentFiles].map((file) => ({
      ...file,
      identity: verifySupportFile(file.path, file.sha256, file.elf),
    }));
    const verified = {
      ...installation,
      support: { directories, mounts: supportMounts, files: [...supportFiles, helper] },
    };
    assertHarnessImageView(verified);
    return verified;
  }
}
