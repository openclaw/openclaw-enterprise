import { spawn, type SpawnOptions } from "node:child_process";
import { availableParallelism } from "node:os";

/**
 * Waits for every operation before test fixture cleanup, then rethrows the first
 * rejection in input order.
 */
export async function settled<T>(promises: Iterable<T>): Promise<Awaited<T>[]> {
  const results = await Promise.allSettled(promises);
  return results.map((result) => {
    if (result.status === "rejected") {
      throw result.reason;
    }
    return result.value;
  });
}

export const eachSettled = <T, R>(items: readonly T[], each: (item: T, index: number) => R) =>
  settled(items.map(each));

// Runs at most `size` tasks at once (by default about one per CPU); a finished task hands
// its slot to the oldest waiter. Returns `limit(task)`, which resolves as `task()` does.
export function concurrencyLimit(size = Math.max(2, availableParallelism())) {
  let free = size;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => T): Promise<Awaited<T>> => {
    if (free > 0) {
      free -= 1;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
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

type CaptureOptions = Omit<SpawnOptions, "stdio"> & {
  encoding?: BufferEncoding | null | undefined;
  input?: string | Uint8Array | undefined;
  expectedStderr?: string | undefined;
};

type Arrival = { firstStderrMs: number | null; expectedPrefixMs: number | null };
type StderrTiming = Arrival & {
  exactStderr: boolean;
  parentSentSignal: boolean;
  exitMs: number | null;
  exitToCloseMs: number | null;
};
type Captured<T> = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: T;
  stderr: T;
  timing?: StderrTiming;
};

// Spawns `program` with piped output and resolves on close with
// { status, signal, stdout, stderr }; `encoding: null` keeps the output as Buffers.
// `input`, when given, is written to its standard input (otherwise it has none).
// With expectedStderr (a UTF-8 string), also times receipt of its complete byte prefix and
// records whether the final stream matches it. All clocks measure parent event delivery.
// Spawn errors reject; nonzero exit codes and terminating signals are reported in the result.
export function captureChild(
  program: string,
  args: readonly string[],
  options: CaptureOptions & { encoding: null },
): Promise<Captured<Buffer>>;
export function captureChild(
  program: string,
  args: readonly string[],
  options?: CaptureOptions & { encoding?: BufferEncoding | undefined },
): Promise<Captured<string>>;
export function captureChild(
  program: string,
  args: readonly string[],
  options: CaptureOptions,
): Promise<Captured<string | Buffer>>;
export function captureChild(
  program: string,
  args: readonly string[],
  { encoding = "utf8", input, expectedStderr, ...options }: CaptureOptions = {},
): Promise<Captured<string | Buffer>> {
  return new Promise((resolve, reject) => {
    const expected = typeof expectedStderr === "string" ? Buffer.from(expectedStderr) : null;
    const started = performance.now();
    const child =
      input === undefined
        ? spawn(program, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(program, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    if (child.stdin !== null) {
      // A child that exits before reading all of it closes the pipe; its status reports why.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    let exited: number | undefined;
    const timing: Arrival | undefined =
      expected === null ? undefined : { firstStderrMs: null, expectedPrefixMs: null };
    if (expected !== null && timing) {
      let received = 0;
      child.stderr.on("data", (chunk: Buffer) => {
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
      const text = (buffer: Buffer) => (encoding === null ? buffer : buffer.toString(encoding));
      const stderrBytes = Buffer.concat(stderr);
      const result: Captured<string | Buffer> = {
        status,
        signal,
        stdout: text(Buffer.concat(stdout)),
        stderr: text(stderrBytes),
      };
      if (expected !== null && timing) {
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
