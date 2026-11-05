import { spawn, type SpawnOptions } from "node:child_process";
import { availableParallelism } from "node:os";

// Like Promise.all, but waits for every promise so no process outlives its test's
// temporary directories, then rethrows the first failure.
export async function settled<T>(promises: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>[]> {
  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  const values: Awaited<T>[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      values.push(result.value);
    }
  }
  return values;
}

export const eachSettled = <T, U>(items: T[], each: (item: T, index: number, array: T[]) => U) =>
  settled(items.map(each));

// Runs at most `size` tasks at once (by default about one per CPU); a finished task hands
// its slot to the oldest waiter. Returns `limit(task)`, which resolves as `task()` does.
export function concurrencyLimit(size = Math.max(2, availableParallelism())) {
  let free = size;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => T | PromiseLike<T>): Promise<Awaited<T>> => {
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

type CaptureChildOptions = Omit<SpawnOptions, "stdio"> & {
  input?: string | Uint8Array | undefined;
};
export type CaptureChildTextOptions = CaptureChildOptions & {
  encoding?: BufferEncoding | undefined;
};
type CaptureChildBufferOptions = CaptureChildOptions & { encoding: null };
type CaptureChildAnyOptions = CaptureChildOptions & {
  encoding?: BufferEncoding | null | undefined;
};
type CaptureChildResult<T> = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: T;
  stderr: T;
};

// Spawns `program` with piped output and resolves on close with
// { status, signal, stdout, stderr }; `encoding: null` keeps the output as Buffers.
// `input`, when given, is written to its standard input (otherwise it has none).
// Rejects only when the process cannot start.
export function captureChild(
  program: string,
  args: readonly string[],
  options?: CaptureChildTextOptions,
): Promise<CaptureChildResult<string>>;
export function captureChild(
  program: string,
  args: readonly string[],
  options: CaptureChildBufferOptions,
): Promise<CaptureChildResult<Buffer>>;
export function captureChild(
  program: string,
  args: readonly string[],
  options: CaptureChildAnyOptions,
): Promise<CaptureChildResult<string | Buffer>>;
export function captureChild(
  program: string,
  args: readonly string[],
  { encoding = "utf8", input, ...options }: CaptureChildAnyOptions = {},
): Promise<CaptureChildResult<string | Buffer>> {
  return new Promise((resolve, reject) => {
    const child =
      input === undefined
        ? spawn(program, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(program, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    if (input !== undefined) {
      // A child that exits before reading all of it closes the pipe; its status reports why.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const text = (chunks: Buffer[]) =>
        encoding === null ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding);
      resolve({ status, signal, stdout: text(stdout), stderr: text(stderr) });
    });
  });
}
