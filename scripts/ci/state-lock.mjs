// Serializes read-modify-write updates of one CI state file across processes.
//
// prepareFile and cleanupResourceIds read the lane state, run commands, and write the
// whole state back. The runner queues them in its own process, but a test may call
// prepareFile itself (a template database per file, a copy per test). Without a lock
// shared by both processes, one side's write can drop the other side's resource.
//
// The lock is `<state>.lock`, created atomically with link(2), holding the owner's pid
// and a random token. Waiters poll it. A lock whose owner process no longer exists is
// abandoned (a test killed by its timeout): a waiter renames it aside, so only one
// waiter can take it, and removes it. A reused pid, or a zombie, reads as alive, so such
// a lock is only given up at the timeout. Callers in one process queue in memory first,
// and a nested call in the same async context reuses the held lock instead of
// deadlocking. The holder keeps the lock for its whole operation (a fresh database's
// migration included), so a waiter's wait counts against its own test timeout.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const defaultTimeoutMs = 10 * 60_000;
const held = new AsyncLocalStorage();
const queues = new Map();

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

async function readLock(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function lockOwner(content) {
  return Number.parseInt(content?.split(" ")[0] ?? "", 10);
}

// Removes the lock if the process that took it has exited. Renaming it aside first
// means two waiters cannot both remove it, and a waiter never removes a lock it did not
// inspect: if the lock changed hands in between, it goes back where it was.
async function removeAbandonedLock(path, content) {
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
    if (error.code === "ENOENT") {
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
      // timeout) and three live contenders. The runner and each test process that calls
      // prepareFile contend, so a lane has up to fileConcurrency + 1 (PostgreSQL
      // Application: seven, as six of its files call it). The likely result is this
      // error on a run that is already failing.
      await link(aside, path).catch((error) => {
        if (error.code === "EEXIST") {
          throw new Error(`Displaced a live CI state lock ${path} and could not restore it.`);
        }
        throw error;
      });
    }
  } finally {
    await unlink(aside);
  }
}

async function acquireFileLock(path, timeoutMs) {
  const token = `${process.pid} ${randomUUID()}\n`;
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // The lock appears complete or not at all, so a waiter never sees an empty owner.
  await writeFile(temp, token, { mode: 0o600, flag: "wx" });
  const deadline = Date.now() + timeoutMs;
  try {
    for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
      try {
        await link(temp, path);
        return token;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }
      const content = await readLock(path);
      await removeAbandonedLock(path, content);
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for the CI state lock ${path} (held by pid ${lockOwner(content) || "unknown"}).`,
        );
      }
      await delay(wait);
    }
  } finally {
    await unlink(temp);
  }
}

async function releaseFileLock(path, token) {
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
export async function withStateLock(statePath, operation, { timeoutMs = defaultTimeoutMs } = {}) {
  if (held.getStore()?.has(statePath)) {
    return operation();
  }
  const previous = queues.get(statePath) ?? Promise.resolve();
  let finish;
  const current = new Promise((resolve) => {
    finish = resolve;
  });
  const tail = previous.then(() => current);
  queues.set(statePath, tail);
  try {
    await previous;
    const path = `${statePath}.lock`;
    const token = await acquireFileLock(path, timeoutMs);
    const paths = new Set(held.getStore() ?? []);
    paths.add(statePath);
    let result;
    try {
      result = await held.run(paths, operation);
    } catch (error) {
      // Report the operation's own failure; a lost lock is secondary to it.
      await releaseFileLock(path, token).catch((releaseError) => {
        console.error(releaseError.message);
      });
      throw error;
    }
    await releaseFileLock(path, token);
    return result;
  } finally {
    finish();
    if (queues.get(statePath) === tail) {
      queues.delete(statePath);
    }
  }
}
