import type { ChildProcess, ChildProcessByStdio, SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { asRecord } from "../../packages/utils/src/index.ts";
import { runCommand } from "./command-supervision.ts";

export type PreparationChild = ChildProcessByStdio<Writable | null, Readable, Readable>;
type CommandOutput = { stdout: string; stderr: string };
export type PrepareCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  processGroup?: boolean;
  timeoutMs?: number | undefined;
  maxOutputChars?: number;
  streamStdout?: boolean;
  input?: Readable;
  onSpawn?: (child: PreparationChild) => void;
  stage?: string;
  stdio?: SpawnOptions["stdio"];
};

type CommandExit = { exitCode?: number | null; signal?: string | null; timedOut?: boolean };
type CommandFailure = "timeout" | "signal" | "exit" | "spawn";

function hasCommandPipes(child: ChildProcess): child is PreparationChild {
  return child.stdout !== null && child.stderr !== null;
}

// A timed-out command gets SIGTERM, SIGKILL after this grace, and after the same
// grace again its held output pipes are abandoned. Tests shorten it.
const commandKillGraceMs =
  Number(process.env.OPENCLAW_CI_COMMAND_KILL_GRACE_MS) > 0
    ? Number(process.env.OPENCLAW_CI_COMMAND_KILL_GRACE_MS)
    : 5_000;

export async function execFile(
  command: string,
  args: string[],
  options: PrepareCommandOptions = {},
): Promise<CommandOutput> {
  let stdout = "";
  let stderr = "";
  const { timeoutMs } = options;
  const result = await runCommand(
    command,
    args,
    {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    },
    {
      phase: "prepare",
      processGroup: options.processGroup === true,
      deadline:
        timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? { timeoutMs, graceMs: commandKillGraceMs }
          : undefined,
    },
    (child) => {
      if (options.input) {
        // A consumer that exits early reports its own status.
        if (!child.stdin) {
          throw new Error("Preparation command input requires a stdin pipe.");
        }
        child.stdin.on("error", () => {});
        options.input.pipe(child.stdin);
      }
      if (options.onSpawn) {
        if (!hasCommandPipes(child)) {
          throw new Error("Preparation command output requires stdout and stderr pipes.");
        }
        options.onSpawn(child);
      }
      // A streamed stdout belongs to the caller.
      if (!options.streamStdout) {
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout = (stdout + chunk.toString()).slice(-(options.maxOutputChars ?? Infinity));
        });
      }
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-(options.maxOutputChars ?? Infinity));
      });
    },
  );

  function preparationError(error: Error, failure: CommandFailure, properties?: CommandExit) {
    const details = Object.assign(error, { command, args, stdout, stderr }, properties);
    const { stage } = options;
    if (
      stage === "database-create" ||
      stage === "database-schema" ||
      stage === "database-migrate"
    ) {
      Object.assign(details, { code: "CI_PREPARATION_COMMAND_FAILED", stage, failure });
    }
    return details;
  }
  function commandError(message: string, failure: CommandFailure, properties?: CommandExit) {
    const error = new Error(
      message,
      result.signalError ? { cause: result.signalError } : undefined,
    );
    return preparationError(error, failure, properties);
  }

  if (result.kind === "spawn-error") {
    throw preparationError(result.error, "spawn");
  }
  const { code: exitCode, signal } = result;
  if (result.kind === "supervisor-lost") {
    throw commandError("Preparation command supervisor exited without a result.", "exit");
  }
  const timedOut = result.kind === "timeout";
  if (timedOut) {
    throw commandError(
      `${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`,
      "timeout",
      {
        exitCode,
        signal,
        timedOut,
      },
    );
  }
  if (exitCode === 0) {
    return { stdout, stderr };
  }
  const message = stderr.trim() || stdout.trim() || signal || String(exitCode);
  throw commandError(
    `${command} ${args.join(" ")} failed: ${message}`,
    signal ? "signal" : "exit",
    {
      exitCode,
      signal,
      timedOut,
    },
  );
}

export async function commandAvailable(
  command: string,
  args = ["--version"],
  options?: PrepareCommandOptions,
) {
  try {
    await execFile(command, args, options);
  } catch (error) {
    if (asRecord(error)?.code === "ENOENT") {
      throw new Error(`Missing required command on PATH: ${command}`, { cause: error });
    }
    throw error;
  }
}
