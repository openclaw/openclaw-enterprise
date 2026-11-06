import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// Linux open(2) O_PATH; Node does not expose this flag by name. A descriptor
// opened this way retains the filesystem socket inode across a pathname swap.
const O_PATH = 0x200000;
const BOOT_ID = "/proc/sys/kernel/random/boot_id";
const RECEIPT_LIMIT = 2_048;
const PROC_UNIX_LIMIT = 1024 * 1024;
const EXPECTED_FIELDS = ["bootId", "pid", "socketDev", "socketIno", "startTicks", "uid", "version"];

interface GenerationReceipt {
  readonly version: 1;
  readonly pid: number;
  readonly uid: number;
  readonly bootId: string;
  readonly startTicks: string;
  readonly socketDev: string;
  readonly socketIno: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value);
}

function receipt(bytes: Buffer): GenerationReceipt {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== EXPECTED_FIELDS.join(",") ||
    value.version !== 1 ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    value.pid > 4_194_304 ||
    typeof value.uid !== "number" ||
    !Number.isSafeInteger(value.uid) ||
    value.uid <= 0 ||
    typeof value.bootId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.bootId) ||
    !decimal(value.startTicks) ||
    !decimal(value.socketDev) ||
    !decimal(value.socketIno)
  ) {
    throw new Error("Invalid generation receipt.");
  }
  return {
    version: 1,
    pid: value.pid,
    uid: value.uid,
    bootId: value.bootId,
    startTicks: value.startTicks,
    socketDev: value.socketDev,
    socketIno: value.socketIno,
  };
}

function owned(s: BigIntStats, uid: number, mode: number): boolean {
  return s.uid === BigInt(uid) && (s.mode & 0o7777n) === BigInt(mode);
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function readReady(path: string, uid: number): Promise<{ stat: BigIntStats; bytes: Buffer }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      !owned(before, uid, 0o600) ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(RECEIPT_LIMIT)
    ) {
      throw new Error("Expected one private, bounded ready receipt.");
    }
    const buffer = Buffer.alloc(RECEIPT_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(bytesRead) !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      !sameFile(after, await lstat(path, { bigint: true }))
    ) {
      throw new Error("Ready receipt changed while opening.");
    }
    return { stat: before, bytes: buffer.subarray(0, bytesRead) };
  } finally {
    await handle.close();
  }
}

async function processMatches(expected: GenerationReceipt): Promise<boolean> {
  const [boot, stat, status] = await Promise.all([
    readFile(BOOT_ID, "utf8"),
    readFile(`/proc/${expected.pid}/stat`, "utf8"),
    readFile(`/proc/${expected.pid}/status`, "utf8"),
  ]);
  const endCommand = stat.lastIndexOf(")");
  // Fields following comm start at stat field 3. Linux starttime is field 22.
  const fields =
    endCommand >= 0
      ? stat
          .slice(endCommand + 2)
          .trim()
          .split(/\s+/)
      : [];
  const ids = /^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)$/m.exec(status);
  const pid = /^Pid:[ \t]+(\d+)$/m.exec(status);
  return (
    boot.trim() === expected.bootId &&
    stat.startsWith(`${expected.pid} (`) &&
    fields[0] !== "Z" &&
    fields[0] !== "X" &&
    fields[19] === expected.startTicks &&
    pid?.[1] === String(expected.pid) &&
    ids !== null &&
    ids.slice(1).every((id) => id === String(expected.uid))
  );
}

async function listenerInode(path: string, pid: number): Promise<string> {
  // The kernel's listening socket inode is distinct from the filesystem inode.
  // Match a unique bound stream listener and confirm the original PID owns an fd.
  const table = await open("/proc/net/unix", constants.O_RDONLY);
  let text: string;
  try {
    const storage = Buffer.alloc(PROC_UNIX_LIMIT + 1);
    let offset = 0;
    while (offset < storage.length) {
      const { bytesRead } = await table.read(storage, offset, storage.length - offset, null);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset >= storage.length) {
      throw new Error("Unix listener inventory is too large.");
    }
    text = storage.toString("utf8", 0, offset);
  } finally {
    await table.close();
  }
  const candidates = text.split("\n").flatMap((line) => {
    const match = /^\S+:\s+[a-f0-9]+\s+[a-f0-9]+\s+00010000\s+0001\s+01\s+(\d+)\s+(.*)$/.exec(line);
    const inode = match?.[1];
    return inode !== undefined && match?.[2] === path ? [inode] : [];
  });
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error("Expected one original Unix stream listener.");
  }
  const inode = candidates[0];
  if (!(await ownsListener(pid, inode))) {
    throw new Error("Original process does not own the Unix listener.");
  }
  return inode;
}

async function ownsListener(pid: number, inode: string): Promise<boolean> {
  const path = `/proc/${pid}/fd`;
  const fds = await readdir(path);
  if (fds.length > 1_024) {
    throw new Error("Original process has too many file descriptors.");
  }
  for (const fd of fds) {
    try {
      if ((await readlink(join(path, fd))) === `socket:[${inode}]`) {
        return true;
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return false;
}

export interface OriginalSocket {
  readonly pinnedPath: string;
  valid(): Promise<boolean>;
  close(): Promise<void>;
}

export async function openOriginalSocket(
  runtimeDir: string,
  readySha256: string,
): Promise<OriginalSocket> {
  const uid = process.getuid?.();
  if (
    process.platform !== "linux" ||
    uid === undefined ||
    uid === 0 ||
    !isAbsolute(runtimeDir) ||
    (await realpath(runtimeDir)) !== runtimeDir ||
    !/^[a-f0-9]{64}$/.test(readySha256)
  ) {
    throw new Error(
      "A Linux nonroot owner, canonical runtime directory and ready receipt pin are required.",
    );
  }
  const directory = await lstat(runtimeDir, { bigint: true });
  if (!directory.isDirectory() || !owned(directory, uid, 0o700)) {
    throw new Error("The runtime directory must be private and owned by the launcher UID.");
  }
  const readyPath = join(runtimeDir, "ready.json");
  const socketPath = join(runtimeDir, "app-server.sock");
  const initial = await readReady(readyPath, uid);
  const expected = receipt(initial.bytes);
  if (
    createHash("sha256").update(initial.bytes).digest("hex") !== readySha256 ||
    expected.uid !== uid ||
    !(await processMatches(expected))
  ) {
    throw new Error("The ready receipt does not identify the live original launcher.");
  }

  const handle: FileHandle = await open(socketPath, O_PATH | constants.O_NOFOLLOW);
  try {
    const pinned = await handle.stat({ bigint: true });
    if (
      !pinned.isSocket() ||
      !owned(pinned, uid, 0o600) ||
      pinned.nlink !== 1n ||
      pinned.dev.toString() !== expected.socketDev ||
      pinned.ino.toString() !== expected.socketIno ||
      !sameFile(pinned, await lstat(socketPath, { bigint: true }))
    ) {
      throw new Error("The socket pathname does not identify the original owner socket.");
    }
    const listening = await listenerInode(socketPath, expected.pid);
    let closed = false;
    const valid = async (): Promise<boolean> => {
      if (closed) {
        return false;
      }
      try {
        const [nowDir, nowSocket, nowReady, processOk, listeningOk] = await Promise.all([
          lstat(runtimeDir, { bigint: true }),
          lstat(socketPath, { bigint: true }),
          lstat(readyPath, { bigint: true }),
          processMatches(expected),
          ownsListener(expected.pid, listening),
        ]);
        return (
          !closed &&
          sameFile(directory, nowDir) &&
          owned(nowDir, uid, 0o700) &&
          nowSocket.isSocket() &&
          owned(nowSocket, uid, 0o600) &&
          nowSocket.nlink === 1n &&
          sameFile(pinned, nowSocket) &&
          nowReady.isFile() &&
          owned(nowReady, uid, 0o600) &&
          sameFile(initial.stat, nowReady) &&
          nowReady.nlink === 1n &&
          initial.stat.size === nowReady.size &&
          initial.stat.mtimeNs === nowReady.mtimeNs &&
          initial.stat.ctimeNs === nowReady.ctimeNs &&
          processOk &&
          listeningOk
        );
      } catch {
        return false;
      }
    };
    if (!(await valid())) {
      throw new Error("The original socket changed while opening.");
    }
    return {
      pinnedPath: `/proc/self/fd/${handle.fd}`,
      valid,
      async close() {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
