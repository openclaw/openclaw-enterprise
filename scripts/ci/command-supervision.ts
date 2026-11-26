import { fork, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

interface Deadline {
  readonly timeoutMs: number;
  readonly graceMs: number;
}

type Supervision =
  | {
      readonly phase: "prepare";
      readonly processGroup: boolean;
      readonly deadline?: Deadline | undefined;
    }
  | {
      readonly phase: "cleanup";
      readonly deadline: Deadline;
      readonly activeCommands: Set<() => void>;
    };

interface ExitStatus {
  readonly code: number | null;
  readonly signal: string | null;
}

type CommandOutcome = (
  | ({ readonly kind: "exit" | "timeout" | "supervisor-lost" } & ExitStatus)
  | { readonly kind: "spawn-error"; readonly error: Error }
) & { readonly signalError: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

interface SupervisorResult extends ExitStatus {
  readonly error?: { message: string; code?: string };
}

function isSupervisorResult(value: unknown): value is SupervisorResult {
  return (
    isRecord(value) &&
    (value.code === null || typeof value.code === "number") &&
    (value.signal === null || typeof value.signal === "string") &&
    (value.error === undefined ||
      (isRecord(value.error) &&
        typeof value.error.message === "string" &&
        (value.error.code === undefined || typeof value.error.code === "string")))
  );
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    stdio: SpawnOptions["stdio"];
  },
  supervision: Supervision,
  configurePipes: (child: ChildProcess) => void,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const activeCleanupCommands =
      supervision.phase === "cleanup" ? supervision.activeCommands : undefined;
    const processGroup =
      process.platform !== "win32" && (supervision.phase === "cleanup" || supervision.processGroup);
    const spawnOptions = {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...options.env },
      stdio: options.stdio,
    };
    // The supervisor retains the group ID and stops the group if the caller loses its IPC channel.
    const child = processGroup
      ? fork(new URL("./cleanup-command.ts", import.meta.url), [], {
          ...spawnOptions,
          detached: true,
          execArgv: [],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        })
      : spawn(command, args, spawnOptions);
    if (processGroup && process.env.OPENCLAW_CI_COMPLETE_PHASE === "1" && process.send) {
      process.send({ type: "ci-lifecycle-group", id: child.pid });
    }

    let supervisorResult: SupervisorResult | undefined;
    let signalError: unknown;
    let killSent = false;
    if (processGroup) {
      child.on("message", (result: unknown) => {
        if (isSupervisorResult(result)) {
          supervisorResult = result;
        } else if (!activeCleanupCommands) {
          // Cleanup retains the latest valid result across stray messages.
          supervisorResult = undefined;
        }
      });
    }
    function signalCommand(signal: NodeJS.Signals): void {
      if (signal === "SIGKILL") {
        killSent = true;
      }
      if (!processGroup && !activeCleanupCommands) {
        child.kill(signal);
        return;
      }
      try {
        if (!processGroup) {
          child.kill(signal);
        } else if (
          child.pid !== undefined &&
          child.pid > 1 &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          // Once the supervisor exits, the ID may belong to another group.
          process.kill(-child.pid, signal);
        }
      } catch (error) {
        if (!isRecord(error) || error.code !== "ESRCH") {
          signalError ??= error;
        }
      }
    }

    const forwardedSignals: readonly NodeJS.Signals[] =
      processGroup && !activeCleanupCommands ? ["SIGINT", "SIGTERM"] : [];
    function stopForwardingSignals(): void {
      for (const signal of forwardedSignals) {
        process.removeListener(signal, forwardSignal);
      }
    }
    function forwardSignal(signal: NodeJS.Signals): void {
      stopForwardingSignals();
      signalCommand(signal);
      process.kill(process.pid, signal);
    }
    for (const signal of forwardedSignals) {
      process.once(signal, forwardSignal);
    }

    const stop = () => signalCommand("SIGKILL");
    activeCleanupCommands?.add(stop);
    configurePipes(child);

    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let abandonTimer: NodeJS.Timeout | undefined;
    const { deadline } = supervision;
    const timeoutTimer =
      deadline &&
      setTimeout(() => {
        timedOut = true;
        signalCommand("SIGTERM");
        killTimer = setTimeout(() => {
          signalCommand("SIGKILL");
          // An escaped descendant can keep inherited output pipes open after escalation.
          abandonTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (activeCleanupCommands) {
              child.unref();
            }
            finish(child.exitCode, child.signalCode);
          }, deadline.graceMs);
        }, deadline.graceMs);
      }, deadline.timeoutMs);

    function finish(code: number | null, signal: string | null, spawnError?: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      stopForwardingSignals();
      activeCleanupCommands?.delete(stop);
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(abandonTimer);
      if (timedOut && activeCleanupCommands && !killSent) {
        // A timed-out cleanup command can close its pipes before escalation.
        signalCommand("SIGKILL");
      }
      if (spawnError && (!activeCleanupCommands || !timedOut)) {
        resolve({ kind: "spawn-error", error: spawnError, signalError });
      } else if (timedOut) {
        resolve({ kind: "timeout", code, signal, signalError });
      } else if (!processGroup) {
        resolve({ kind: "exit", code, signal, signalError });
      } else if (supervisorResult === undefined) {
        resolve({ kind: "supervisor-lost", code, signal, signalError });
      } else if (supervisorResult.error) {
        const error = Object.assign(
          new Error(supervisorResult.error.message),
          supervisorResult.error,
        );
        resolve({ kind: "spawn-error", error, signalError });
      } else {
        resolve({
          kind: "exit",
          code: supervisorResult.code,
          signal: supervisorResult.signal,
          signalError,
        });
      }
    }

    child.on("error", (error) => {
      if (child.pid !== undefined && (processGroup || activeCleanupCommands)) {
        // IPC and signal failures after startup still need to drain or reach the deadline.
        signalError ??= error;
      } else {
        finish(null, null, error);
      }
    });
    // A child may exit before its inherited output pipes close.
    child.on("close", (code, signal) => finish(code, signal));
    if (processGroup) {
      child.send?.({ command, args });
    }
  });
}
