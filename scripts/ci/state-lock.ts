// Serializes read-modify-write updates of one CI state file across processes.
//
// prepareFile and cleanupResourceIds read the lane state, run commands, and write the
// whole state back. The runner prepares and cleans files in its own process, but a test
// may call prepareFile itself (a copy of its file's prepared database per test). Without
// a lock shared by both processes, one side's write can drop the other side's resource.
//
// The lock is a non-empty `<state>.lock` directory, published by rename(2). Its one
// marker has the owner's pid and a unique generation in both its name and contents.
// Recovery unlinks only the observed dead owner's marker; release unlinks only its own.
// Both then use nonrecursive rmdir(2), which cannot remove a live successor's non-empty
// directory. This requires a shared, local POSIX filesystem where rename is atomic and
// refuses a non-empty directory destination. A reused pid, or a zombie, reads as alive,
// so such a lock is only given up at the timeout. A nested call in the same async context
// reuses the held lock instead of deadlocking. The holder keeps the lock for its whole operation (a fresh database's
// migration included), so a waiter's wait counts against its own test timeout.
//
// Waiters are served first come, first served, across processes and within one. Each
// call creates a ticket directory next to the lock, named by a system-wide monotonic
// clock and its deadline, and only the waiter with the oldest live ticket tries the lock, at a fixed
// short interval. A ticket whose process has exited, or which outlived its deadline (a
// reused pid), is removed. Each waiter scans the lock's directory, which in CI holds a
// few files. Before tickets, waiters raced on the lock: long waiters backed off to 100 ms
// polls while new arrivals polled at 5-40 ms and the holder's process re-took the lock
// at once, so waits reached 30-110 s under load and tests timed out on the lock
// (finding 2179).
//
// Every process sharing a state file must use this protocol. Before upgrading from the
// old file-lock protocol, stop and reap all old users/reclaimers, then remove their
// abandoned lock and ticket files while quiescent. A running old reclaimer can rename
// a new lock directory; merely observing no old lock is not a safe transition.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const defaultTimeoutMs = 10 * 60_000;
// The first waiter tries the lock every 5 ms. The others only check whether they are
// first; they become first when it takes the lock, which it then holds for an operation.
const firstPollMs = 5;
const queuePollMs = 20;
// A waiter removes its own ticket at its deadline; one still there this much later belongs
// to a process that died with it, whose pid now reads as alive.
const ticketGraceMs = 10_000;
const held = new AsyncLocalStorage<ReadonlySet<string>>();
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const markerPattern = new RegExp(`^([1-9]\\d*)\\.(${uuidPattern})\\.owner$`);
type LockOwner = { marker: string; pid: number; token: string };

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function processExists(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    if (hasErrorCode(error, "EPERM")) {
      return true;
    }
    if (hasErrorCode(error, "ESRCH")) {
      return false;
    }
    throw error;
  }
}

function invalidLock(path: string) {
  return new Error(
    `Unrecognized CI state lock ${path}. All users must use the directory-lock protocol; stop and reap legacy users before removing old lock or ticket files.`,
  );
}

async function readLock(path: string) {
  try {
    if (!(await lstat(path)).isDirectory()) {
      throw invalidLock(path);
    }
    const entries = await readdir(path, { withFileTypes: true });
    // A releaser may have removed its marker but not yet removed the empty directory.
    // Publication can replace that empty directory atomically.
    if (entries.length === 0) {
      return undefined;
    }
    const entry = entries[0];
    const match = entry && markerPattern.exec(entry.name);
    if (entries.length !== 1 || !entry?.isFile() || !match) {
      throw invalidLock(path);
    }
    const pid = Number(match[1]);
    const token = `${pid} ${match[2]}\n`;
    if (!Number.isSafeInteger(pid) || (await readFile(join(path, entry.name), "utf8")) !== token) {
      throw invalidLock(path);
    }
    return { marker: entry.name, pid, token };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

// A delayed rmdir can find a successor, but cannot remove its non-empty directory.
async function removeEmptyLock(path: string) {
  try {
    await rmdir(path);
  } catch (error) {
    if (
      hasErrorCode(error, "ENOENT") ||
      hasErrorCode(error, "ENOTEMPTY") ||
      hasErrorCode(error, "EEXIST")
    ) {
      return;
    }
    throw error;
  }
}

async function removeAbandonedLock(path: string, owner: LockOwner | undefined) {
  if (owner === undefined || processExists(owner.pid)) {
    return;
  }
  await unlink(join(path, owner.marker)).catch(ignoreMissing);
  await removeEmptyLock(path);
}

function ignoreMissing(error: unknown) {
  if (!hasErrorCode(error, "ENOENT")) {
    throw error;
  }
}

function clockDigits(nanoseconds: bigint) {
  return String(nanoseconds).padStart(20, "0");
}

function ticketPattern(path: string) {
  const name = basename(path).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\.${name}\\.\\d{20}\\.(\\d{20})\\.([1-9]\\d*)\\.(${uuidPattern})\\.ticket$`);
}

async function removeTicket(path: string, marker: string) {
  // Validate the unique ticket before claiming it. Its live waiter can still publish
  // it, even after expiry, so never empty the directory at its original pathname.
  // A process can die while writing this unpublished marker; its name, not potentially
  // partial contents, identifies the only removable file.
  try {
    if (!(await lstat(path)).isDirectory()) {
      throw invalidLock(path);
    }
    const entries = await readdir(path, { withFileTypes: true });
    if (
      entries.length > 1 ||
      (entries[0] && (entries[0].name !== marker || !entries[0].isFile()))
    ) {
      throw invalidLock(path);
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const claimed = join(dirname(path), `.${randomUUID()}.reaping`);
  try {
    // Publication and reclamation compete for this exact directory. If publication
    // wins, ENOENT leaves its canonical generation untouched. If reclamation wins,
    // the publisher can no longer move the directory after we remove its marker.
    await rename(path, claimed);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  await unlink(join(claimed, marker)).catch(ignoreMissing);
  await rmdir(claimed).catch(ignoreMissing);
}

// Counts the live tickets older than `ticket` and removes the others. The names sort by
// the clock reading they start with.
async function ticketsAhead(path: string, ticket: string) {
  const pattern = ticketPattern(path);
  const now = clockDigits(process.hrtime.bigint());
  let ahead = 0;
  for (const name of await readdir(dirname(path))) {
    const match = pattern.exec(name);
    if (!match || name >= ticket) {
      continue;
    }
    if (match[1] !== undefined && match[1] > now && processExists(Number(match[2]))) {
      ahead += 1;
      continue;
    }
    const ticketPath = join(dirname(path), name);
    const marker = `${match[2]}.${match[3]}.owner`;
    await removeTicket(ticketPath, marker);
  }
  return ahead;
}

async function acquireFileLock(path: string, timeoutMs: number) {
  const id = randomUUID();
  const token = `${process.pid} ${id}\n`;
  const owner = { marker: `${process.pid}.${id}.owner`, pid: process.pid, token };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // process.hrtime reads CLOCK_MONOTONIC (Linux) or its equivalent, which every process
  // on the host shares, so the names order waiters by arrival.
  const clock = process.hrtime.bigint();
  const expiry =
    clock + BigInt(Math.ceil(Math.min(timeoutMs, 2 ** 40)) + ticketGraceMs) * 1_000_000n;
  const ticket = `.${basename(path)}.${clockDigits(clock)}.${clockDigits(expiry)}.${process.pid}.${id}.ticket`;
  const ticketPath = join(dirname(path), ticket);
  await mkdir(ticketPath, { mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  try {
    await writeFile(join(ticketPath, owner.marker), token, { mode: 0o600, flag: "wx" });
    for (;;) {
      const ahead = await ticketsAhead(path, ticket);
      let content: LockOwner | undefined;
      if (ahead === 0) {
        try {
          // Both directories are on the same filesystem. A live holder's directory
          // stays non-empty, so rename cannot replace it.
          await rename(ticketPath, path);
          return owner;
        } catch (error) {
          if (hasErrorCode(error, "ENOTDIR") || hasErrorCode(error, "EISDIR")) {
            throw invalidLock(path);
          }
          if (!hasErrorCode(error, "EEXIST") && !hasErrorCode(error, "ENOTEMPTY")) {
            throw error;
          }
        }
        content = await readLock(path);
        await removeAbandonedLock(path, content);
      }
      if (Date.now() >= deadline) {
        content ??= await readLock(path);
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for the CI state lock ${path} (held by pid ${content?.pid ?? "unknown"}, ${ahead} waiting ahead).`,
        );
      }
      await delay(ahead === 0 ? firstPollMs : queuePollMs);
    }
  } catch (error) {
    await removeTicket(ticketPath, owner.marker);
    throw error;
  }
}

async function releaseFileLock(path: string, owner: LockOwner) {
  const content = await readLock(path);
  if (content === undefined) {
    throw new Error(`The CI state lock ${path} was removed while this process held it.`);
  }
  if (content.marker !== owner.marker) {
    throw new Error(`The CI state lock ${path} was taken while this process held it.`);
  }
  await unlink(join(path, owner.marker));
  await removeEmptyLock(path);
}

// Runs `operation` while holding the lock for `statePath`, an absolute path.
export async function withStateLock<T>(
  statePath: string,
  operation: () => T | Promise<T>,
  { timeoutMs = defaultTimeoutMs }: { timeoutMs?: number | undefined } = {},
): Promise<T> {
  if (held.getStore()?.has(statePath)) {
    return operation();
  }
  const path = `${statePath}.lock`;
  const owner = await acquireFileLock(path, timeoutMs);
  const paths = new Set(held.getStore() ?? []);
  paths.add(statePath);
  let result: T;
  try {
    result = await held.run(paths, operation);
  } catch (error) {
    // Report the operation's own failure; a lost lock is secondary to it.
    await releaseFileLock(path, owner).catch((releaseError: unknown) => {
      console.error(releaseError instanceof Error ? releaseError.message : releaseError);
    });
    throw error;
  }
  await releaseFileLock(path, owner);
  return result;
}
