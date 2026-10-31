// Serializes read-modify-write updates of one CI state file across processes.
//
// prepareFile and cleanupResourceIds read the lane state, run commands, and write the
// whole state back. The runner prepares and cleans files in its own process, but a test
// may call prepareFile itself (a copy of its file's prepared database per test). Without
// a lock shared by both processes, one side's write can drop the other side's resource.
//
// The lock is `<state>.lock`, created atomically with link(2), holding the owner's pid
// and a random token. A lock whose owner process no longer exists is abandoned (a test
// killed by its timeout): a waiter renames it aside, so only one waiter can take it, and
// removes it. A reused pid, or a zombie, reads as alive, so such a lock is only given up
// at the timeout. A nested call in the same async context reuses the held lock instead
// of deadlocking. The holder keeps the lock for its whole operation (a fresh database's
// migration included), so a waiter's wait counts against its own test timeout.
//
// Waiters are served first come, first served, across processes and within one. Each
// call writes a ticket next to the lock, named by a system-wide monotonic clock and its
// deadline, and only the waiter with the oldest live ticket tries the lock, at a fixed
// short interval. A ticket whose process has exited, or which outlived its deadline (a
// reused pid), is removed. Each waiter scans the lock's directory, which in CI holds a
// few files. Before tickets, waiters raced on the lock: long waiters backed off to 100 ms
// polls while new arrivals polled at 5-40 ms and the holder's process re-took the lock
// at once, so waits reached 30-110 s under load and tests timed out on the lock
// (finding 2179).
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
    return hasErrorCode(error, "EPERM");
  }
}

async function readLock(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function lockOwner(content: string | undefined) {
  return Number.parseInt(content?.split(" ")[0] ?? "", 10);
}

// Removes the lock if the process that took it has exited. Renaming it aside first
// means two waiters cannot both remove it, and a waiter never removes a lock it did not
// inspect: if the lock changed hands in between, it goes back where it was.
async function removeAbandonedLock(path: string, content: string | undefined) {
  if (content === undefined || processExists(lockOwner(content))) {
    return;
  }
  if ((await readLock(path)) !== content) {
    return;
  }
  const aside = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.abandoned`);
  try {
    await rename(path, aside);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  try {
    if ((await readFile(aside, "utf8")) !== content) {
      // Another waiter removed the abandoned lock and a live process took a new one.
      // link(2) never replaces a file. If a third process took the lock in this gap,
      // two holders now overlap: fail here rather than let them both write the state.
      // It needs a holder that died with the lock (in practice a test killed by its
      // timeout) and three live processes trying the lock at once. Only the waiter with
      // the oldest ticket tries it, so two of them must also have written their tickets
      // just after the third read the queue. The likely result is this error on a run
      // that is already failing.
      await link(aside, path).catch((error: unknown) => {
        if (hasErrorCode(error, "EEXIST")) {
          throw new Error(`Displaced a live CI state lock ${path} and could not restore it.`);
        }
        throw error;
      });
    }
  } finally {
    await unlink(aside);
  }
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
  return new RegExp(`^\\.${name}\\.\\d{20}\\.(\\d{20})\\.(\\d+)\\.[0-9a-f-]{36}\\.ticket$`);
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
    await unlink(join(dirname(path), name)).catch(ignoreMissing);
  }
  return ahead;
}

async function acquireFileLock(path: string, timeoutMs: number) {
  const id = randomUUID();
  const token = `${process.pid} ${id}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // process.hrtime reads CLOCK_MONOTONIC (Linux) or its equivalent, which every process
  // on the host shares, so the names order waiters by arrival.
  const clock = process.hrtime.bigint();
  const expiry =
    clock + BigInt(Math.ceil(Math.min(timeoutMs, 2 ** 40)) + ticketGraceMs) * 1_000_000n;
  const ticket = `.${basename(path)}.${clockDigits(clock)}.${clockDigits(expiry)}.${process.pid}.${id}.ticket`;
  const ticketPath = join(dirname(path), ticket);
  // The ticket becomes the lock by link(2), so the lock appears complete or not at all
  // and a waiter never sees an empty owner.
  await writeFile(ticketPath, token, { mode: 0o600, flag: "wx" });
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const ahead = await ticketsAhead(path, ticket);
      let content: string | undefined;
      if (ahead === 0) {
        try {
          await link(ticketPath, path);
          return token;
        } catch (error) {
          if (!hasErrorCode(error, "EEXIST")) {
            throw error;
          }
        }
        content = await readLock(path);
        await removeAbandonedLock(path, content);
      }
      if (Date.now() >= deadline) {
        content ??= await readLock(path);
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for the CI state lock ${path} (held by pid ${lockOwner(content) || "unknown"}, ${ahead} waiting ahead).`,
        );
      }
      await delay(ahead === 0 ? firstPollMs : queuePollMs);
    }
  } finally {
    await unlink(ticketPath).catch(ignoreMissing);
  }
}

async function releaseFileLock(path: string, token: string) {
  const content = await readLock(path);
  if (content === undefined) {
    throw new Error(`The CI state lock ${path} was removed while this process held it.`);
  }
  if (content !== token) {
    throw new Error(`The CI state lock ${path} was taken while this process held it.`);
  }
  await unlink(path);
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
  const token = await acquireFileLock(path, timeoutMs);
  const paths = new Set(held.getStore() ?? []);
  paths.add(statePath);
  let result: T;
  try {
    result = await held.run(paths, operation);
  } catch (error) {
    // Report the operation's own failure; a lost lock is secondary to it.
    await releaseFileLock(path, token).catch((releaseError: unknown) => {
      console.error(releaseError instanceof Error ? releaseError.message : releaseError);
    });
    throw error;
  }
  await releaseFileLock(path, token);
  return result;
}
