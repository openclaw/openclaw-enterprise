import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

// Like Promise.all, but waits for every promise so no process outlives its test's
// temporary directories, then rethrows the first failure.
export async function settled(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) {
    throw failed.reason;
  }
  return results.map((result) => result.value);
}

export const eachSettled = (items, each) => settled(items.map(each));

// Runs at most `size` tasks at once (by default about one per CPU); a finished task hands
// its slot to the oldest waiter. Returns `limit(task)`, which resolves as `task()` does.
export function concurrencyLimit(size = Math.max(2, availableParallelism())) {
  let free = size;
  const waiting = [];
  return async (task) => {
    if (free > 0) {
      free -= 1;
    } else {
      await new Promise((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        free += 1;
      }
    }
  };
}

// Spawns `program` with piped output and resolves on close with
// { status, signal, stdout, stderr }; `encoding: null` keeps the output as Buffers.
// Rejects only when the process cannot start.
export function captureChild(program, args, { encoding = "utf8", ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const text = (chunks) =>
        encoding === null ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding);
      resolve({ status, signal, stdout: text(stdout), stderr: text(stderr) });
    });
  });
}
