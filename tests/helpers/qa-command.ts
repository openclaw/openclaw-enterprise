import assert from "node:assert/strict";
import { execFile, type ExecException, type ExecFileOptions } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { maskPrivateKeyLines } from "../../scripts/ci/failure-redaction.ts";
import { qaCommandFailureDetail, redactedQaTail, registerQaSecret } from "./qa-secrets.ts";

const repository = resolve(import.meta.dirname, "../..");

type CommandOutput = string | Buffer;
type CommandExitCode = number | null;
type CommandProcessError = Omit<ExecException, "code"> & { code?: CommandExitCode | string };
type CommandOptions = ExecFileOptions & {
  input?: string | Uint8Array | undefined;
  allowExitCodes?: readonly CommandExitCode[] | undefined;
};

export type QaCommandOptions = CommandOptions & {
  privateFailureOutput?: boolean | undefined;
  captureStartupTimings?: boolean | undefined;
};

export interface ImageBuildEvidence {
  lines: string[];
}

interface StartupTiming {
  stage: string;
  elapsedMs: number;
  failed: boolean;
}

interface StartupTimingEvidence {
  records: StartupTiming[];
  omittedRecords: number;
}

export interface QaCommandFixture {
  directory: string;
  stateDirectory: string;
  env: NodeJS.ProcessEnv;
  credentials?: { password?: string };
  record?: (name: string, value: ImageBuildEvidence | StartupTimingEvidence) => Promise<string>;
}

function execute(
  command: string,
  args: readonly string[],
  { input, allowExitCodes = [0], timeout = 0, ...options }: CommandOptions,
): Promise<CommandOutput> {
  assert.ok(Number.isInteger(timeout) && timeout >= 0, "command timeout must be non-negative");
  // execFile also reports spawn errors such as ENOENT. Keep the original membership check.
  const allowedCodes: readonly unknown[] = allowExitCodes;
  const started = performance.now();
  return new Promise((accept, reject: (reason: unknown) => void) => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error, stdout: CommandOutput = "", stderr: CommandOutput = "") => {
      reject(
        Object.assign(error, {
          stdout,
          stderr,
          timedOut,
          elapsedMs: Math.round(performance.now() - started),
          timeoutMs: timeout,
        }),
      );
    };

    const child = execFile(
      command,
      args,
      options,
      (error: CommandProcessError | null, stdout, stderr) => {
        clearTimeout(timer);
        if (timedOut) {
          fail(
            error ??
              Object.assign(new Error("command deadline exceeded"), {
                code: child.exitCode,
                signal: child.signalCode,
              }),
            stdout,
            stderr,
          );
        } else if (error && !allowedCodes.includes(error.code)) {
          fail(error, stdout, stderr);
        } else {
          accept(stdout);
        }
      },
    );
    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        // Match execFile's timeout teardown while keeping the deadline as the primary
        // cause even if writing to a closed pipe ends the child with SIGPIPE.
        child.stdout?.destroy();
        child.stderr?.destroy();
        try {
          child.kill(options.killSignal ?? "SIGTERM");
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }, timeout);
    }
    child.stdin?.end(input);
  });
}

// BuildKit interleaves step output and repeats step numbers across builds. Keep the last
// failed step in the last build. Podman has no step prefixes, so use the stderr tail.
export function imageBuildFailureOutput(
  stderr: unknown,
  { lines = 200 }: { lines?: number } = {},
): string[] | undefined {
  const text = String(stderr ?? "").trimEnd();
  if (!/^ERROR: (?:failed to build: )?failed to solve: |^Error: building at STEP /m.test(text)) {
    return undefined;
  }
  const all = text.split("\n");
  const first = Math.max(
    0,
    all.findLastIndex((line) =>
      /^#0 building with |^#1 \[internal\] load build definition/.test(line),
    ),
  );
  const build = all.slice(first);
  // Mask before slicing so a key that starts outside the selected step or the tail
  // cannot leak body lines. An unterminated key masks everything that follows.
  const masked = maskPrivateKeyLines(all).slice(first);
  const step = build.findLast((line) => /^#\d+ ERROR: /.test(line))?.match(/^#\d+ /)?.[0];
  return (step ? masked.filter((_, index) => build[index]?.startsWith(step)) : masked).slice(
    -lines,
  );
}

export async function recordImageBuildFailure(
  record: ((name: string, value: ImageBuildEvidence) => Promise<string>) | undefined,
  stderr: unknown,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const output = imageBuildFailureOutput(stderr);
  if (output === undefined) {
    return undefined;
  }
  if (record === undefined) {
    throw new TypeError("record is not a function");
  }
  return record(`image-build-failure-${Date.now()}`, {
    lines: redactedQaTail(output.join("\n"), env, { lines: output.length, lineChars: 800 }),
  });
}

function startupCommandTimings(stdout: unknown): StartupTimingEvidence {
  // Only exact records from internal/occdev/timing.go can appear in public evidence.
  const pattern =
    /(?:^|\n)\[occ-dev-timing\] stage=(runtime-build|controller-build|compose-build-and-start|compose-build|image-pull|image-export|image-import|node-image-pull|cluster-create|k3d-image-import|kubernetes-readiness|helm-install) elapsed_ms=(0|[1-9][0-9]{0,15}) failed=(true|false)(?=\n|$)/g;
  const records: StartupTiming[] = [];
  let omittedRecords = 0;
  for (const [, stage, duration, failed] of String(stdout ?? "").matchAll(pattern)) {
    const elapsedMs = Number(duration);
    if (stage === undefined || !Number.isSafeInteger(elapsedMs)) {
      continue;
    }
    records.push({ stage, elapsedMs, failed: failed === "true" });
    if (records.length > 64) {
      records.shift();
      omittedRecords++;
    }
  }
  return { records, omittedRecords };
}

// Native errors vary across spawn, deadline, and execFile setup failures. Their
// transient output stays private and is removed before the same error is rethrown.
type CommandFailure = Error & {
  cmd?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  code?: unknown;
  signal?: unknown;
  timedOut?: unknown;
  elapsedMs?: unknown;
  timeoutMs?: unknown;
};

export function runQaCommand(
  f: QaCommandFixture,
  command: string,
  args: readonly string[],
  options?: Omit<QaCommandOptions, "encoding"> & { encoding?: BufferEncoding },
): Promise<string>;
export function runQaCommand(
  f: QaCommandFixture,
  command: string,
  args: readonly string[],
  options: QaCommandOptions & { encoding: "buffer" | null | undefined },
): Promise<Buffer>;
export function runQaCommand(
  f: QaCommandFixture,
  command: string,
  args: readonly string[],
  options: QaCommandOptions,
): Promise<CommandOutput>;
export async function runQaCommand(
  f: QaCommandFixture,
  command: string,
  args: readonly string[],
  options: QaCommandOptions = {},
): Promise<CommandOutput> {
  const {
    privateFailureOutput = false,
    captureStartupTimings = false,
    ...executeOptions
  } = options;
  try {
    return await execute(command, args, {
      cwd: repository,
      env: f.env,
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
      ...executeOptions,
    });
  } catch (thrown) {
    const error: CommandFailure = thrown instanceof Error ? thrown : new Error(String(thrown));
    await writeFile(
      join(f.directory, `command-failure-${Date.now()}.log`),
      privateFailureOutput
        ? "protected subprocess output withheld\n"
        : `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
      { mode: 0o600 },
    );
    if (f.credentials?.password) {
      registerQaSecret(f.credentials.password);
    }
    const env = executeOptions.env ?? f.env;
    const detail = privateFailureOutput ? "" : qaCommandFailureDetail(error.stderr, env);
    const buildOutput = privateFailureOutput
      ? undefined
      : await recordImageBuildFailure(f.record, error.stderr, env).catch((recordError: unknown) => {
          const message =
            typeof recordError === "object" && recordError !== null && "message" in recordError
              ? recordError.message
              : undefined;
          return `not recorded (${message ?? recordError})`;
        });
    let startupTimings: string | undefined;
    if (captureStartupTimings && !privateFailureOutput) {
      const timings = startupCommandTimings(error.stdout);
      if (timings.records.length > 0) {
        try {
          startupTimings = f.record
            ? await f.record(`startup-timings-${Date.now()}`, timings)
            : "unavailable";
        } catch {
          // A failed artifact write must not replace the command failure or expose its path.
          startupTimings = "unavailable";
        }
      }
    }

    // execFile errors embed argv and output, potentially containing tokens.
    const timing = Number.isInteger(error.elapsedMs)
      ? ` after ${error.elapsedMs} ms (limit ${error.timeoutMs} ms)`
      : "";
    error.message = `${command.split("/").at(-1)} ${error.timedOut ? "timed out" : "failed"}${timing} (exit ${error.code ?? "unknown"}, signal ${error.signal ?? "none"}); private state: ${f.stateDirectory}${buildOutput ? `; failed image build step output: ${buildOutput}` : ""}${startupTimings ? `; startup timings: ${startupTimings}` : ""}${detail ? `; stderr: ${detail}` : ""}`;
    delete error.cmd;
    delete error.stdout;
    delete error.stderr;
    delete error.stack;
    throw error;
  }
}
