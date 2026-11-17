import {
  fork,
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
} from "node:child_process";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { asRecord } from "../../packages/utils/src/index.ts";
import { isSupervisorResult } from "./cleanup.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

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

export function execFile(
  command: string,
  args: string[],
  options: PrepareCommandOptions = {},
): Promise<CommandOutput> {
  return new Promise((resolvePromise, reject) => {
    const processGroup = options.processGroup === true && process.platform !== "win32";
    const spawnOptions = {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...(options.env ?? {}) },
    };
    // Reuse cleanup's supervisor to anchor the group ID until its last signal.
    const child = processGroup
      ? fork(new URL("./cleanup-command.ts", import.meta.url), [], {
          ...spawnOptions,
          detached: true,
          execArgv: [],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        })
      : spawn(command, args, {
          ...spawnOptions,
          stdio: options.stdio ?? [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        });
    if (processGroup && process.env.OPENCLAW_CI_COMPLETE_PHASE === "1" && process.send) {
      process.send({ type: "ci-lifecycle-group", id: child.pid });
    }
    let commandResult: unknown;
    let signalError: unknown;
    if (processGroup) {
      child.on("message", (result: unknown) => {
        commandResult = result;
      });
    }
    const signalCommand = (signal: NodeJS.Signals) => {
      if (processGroup) {
        try {
          if (
            child.pid !== undefined &&
            child.pid > 1 &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            process.kill(-child.pid, signal);
          }
        } catch (error) {
          if (asRecord(error)?.code !== "ESRCH") {
            signalError ??= error;
          }
        }
        return;
      }
      child.kill(signal);
    };
    // A separate group no longer receives the terminal's or runner's signals.
    // Pass them on while the command runs, then let the default action stop us.
    // Each command with an owned process group adds one listener per signal.
    const forwardSignal = (signal: NodeJS.Signals) => {
      stopForwardingSignals();
      signalCommand(signal);
      process.kill(process.pid, signal);
    };
    const forwardedSignals: readonly NodeJS.Signals[] = processGroup ? ["SIGINT", "SIGTERM"] : [];
    const stopForwardingSignals = () => {
      for (const signal of forwardedSignals) {
        process.removeListener(signal, forwardSignal);
      }
    };
    for (const signal of forwardedSignals) {
      process.once(signal, forwardSignal);
    }
    if (options.input) {
      // A consumer that exits early reports its own status; never crash on EPIPE.
      if (!child.stdin) {
        throw new Error("Preparation command input requires a stdin pipe.");
      }
      child.stdin.on("error", () => {});
      options.input.pipe(child.stdin);
    }
    // A streamed stdout belongs to the caller and is never buffered here.
    if (options.onSpawn) {
      if (!hasCommandPipes(child)) {
        throw new Error("Preparation command output requires stdout and stderr pipes.");
      }
      options.onSpawn(child);
    }
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let abandonTimer: NodeJS.Timeout | undefined;
    const { timeoutMs } = options;
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        signalCommand("SIGTERM");
        killTimer = setTimeout(() => {
          signalCommand("SIGKILL");
          // A descendant outside the child's group can hold its output pipes
          // open, and "close" waits for them. Stop waiting after a grace period.
          // A streamed stdout is only unpiped here; its consumer's own timeout
          // bounds the consumer.
          abandonTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(() => reject(timedOutError(child.exitCode, child.signalCode)));
          }, commandKillGraceMs);
        }, commandKillGraceMs);
      }, timeoutMs);
    }
    let stdout = "";
    let stderr = "";
    if (!options.streamStdout) {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-(options.maxOutputChars ?? Infinity));
      });
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-(options.maxOutputChars ?? Infinity));
    });
    function commandError(message: string, properties: CommandExit = {}) {
      const error = new Error(message, signalError ? { cause: signalError } : undefined);
      return preparationError(
        error,
        timedOut ? "timeout" : properties.signal ? "signal" : "exit",
        properties,
      );
    }

    function preparationError(error: Error, failure: CommandFailure, properties?: CommandExit) {
      const details = Object.assign(error, { command, args, stdout, stderr }, properties);
      const { stage } = options;
      if (
        stage === "database-create" ||
        stage === "database-schema" ||
        stage === "database-migrate"
      ) {
        Object.assign(details, {
          code: "CI_PREPARATION_COMMAND_FAILED",
          stage,
          failure,
        });
      }
      return details;
    }

    function finish(callback: () => void) {
      if (settled) {
        return;
      }
      settled = true;
      stopForwardingSignals();
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(abandonTimer);
      callback();
    }
    function timedOutError(exitCode: number | null, signal: string | null) {
      return commandError(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`, {
        exitCode,
        signal,
        timedOut: true,
      });
    }
    child.on("error", (error) => {
      if (processGroup && child.pid !== undefined) {
        // An IPC or signal error is not a failed fork. Keep ownership and the
        // timeout until the supervisor exits or the pipe-abandonment bound.
        signalError ??= error;
        return;
      }
      finish(() => reject(preparationError(error, "spawn")));
    });
    // Exit can precede pipe drain; callers need complete diagnostics to classify failures.
    child.on("close", (code, signal) => {
      finish(() => {
        let exitCode = code;
        let exitSignal: string | null = signal;
        if (processGroup && !timedOut) {
          if (!isSupervisorResult(commandResult)) {
            reject(commandError("Preparation command supervisor exited without a result."));
            return;
          }
          ({ code: exitCode, signal: exitSignal } = commandResult);
          if (commandResult.error) {
            const error = Object.assign(
              new Error(commandResult.error.message),
              commandResult.error,
            );
            reject(preparationError(error, "spawn"));
            return;
          }
        }
        if (timedOut) {
          reject(timedOutError(exitCode, exitSignal));
        } else if (exitCode === 0) {
          resolvePromise({ stdout, stderr });
        } else {
          const message = stderr.trim() || stdout.trim() || exitSignal || String(exitCode);
          reject(
            commandError(`${command} ${args.join(" ")} failed: ${message}`, {
              exitCode,
              signal: exitSignal,
              timedOut: false,
            }),
          );
        }
      });
    });
    if (processGroup) {
      child.send?.({ command, args });
    }
  });
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
