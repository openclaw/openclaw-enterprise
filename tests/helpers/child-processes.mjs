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
// `input`, when given, is written to its standard input (otherwise it has none).
// With expectedStderr (a UTF-8 string), also times receipt of its complete byte prefix and
// records whether the final stream matches it. All clocks measure parent event delivery.
// Rejects only when the process cannot start.
export function captureChild(
  program,
  args,
  { encoding = "utf8", input, expectedStderr, ...options } = {},
) {
  return new Promise((resolve, reject) => {
    const expected = typeof expectedStderr === "string" ? Buffer.from(expectedStderr) : null;
    const started = performance.now();
    const child = spawn(program, args, {
      ...options,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined) {
      // A child that exits before reading all of it closes the pipe; its status reports why.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    let timing;
    let exited;
    if (expected) {
      timing = { firstStderrMs: null, expectedPrefixMs: null };
      let received = 0;
      child.stderr.on("data", (chunk) => {
        const elapsed = Math.round(performance.now() - started);
        timing.firstStderrMs ??= elapsed;
        if (received < expected.length) {
          received += chunk.length;
          if (
            received >= expected.length &&
            Buffer.concat(stderr, expected.length).equals(expected)
          ) {
            timing.expectedPrefixMs = elapsed;
          }
        }
      });
      child.once("exit", () => {
        exited = performance.now();
      });
    }
    child.on("close", (status, signal) => {
      const text = (buffer) => (encoding === null ? buffer : buffer.toString(encoding));
      const stderrBytes = Buffer.concat(stderr);
      const result = {
        status,
        signal,
        stdout: text(Buffer.concat(stdout)),
        stderr: text(stderrBytes),
      };
      if (timing) {
        result.timing = {
          ...timing,
          exactStderr: stderrBytes.equals(expected),
          parentSentSignal: child.killed,
          exitMs: exited === undefined ? null : Math.round(exited - started),
          exitToCloseMs: exited === undefined ? null : Math.round(performance.now() - exited),
        };
      }
      resolve(result);
    });
  });
}
