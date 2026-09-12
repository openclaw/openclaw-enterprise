import { spawn } from "node:child_process";
import { currentComputeAbortSignal } from "../operation-context.ts";

export interface SshCommand {
  readonly address: string;
  readonly port: number;
  readonly user: string;
  readonly nodePath: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
  readonly connectTimeoutSeconds: number;
  readonly helper: string;
  readonly operation: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface SshCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SshCommandExecutor {
  execute(command: SshCommand): Promise<SshCommandResult>;
}

export class SystemSshCommandExecutor implements SshCommandExecutor {
  async execute(command: SshCommand): Promise<SshCommandResult> {
    const owner = command.signal ?? currentComputeAbortSignal();
    const timeout = AbortSignal.timeout(command.timeoutMs);
    const signal = owner === undefined ? timeout : AbortSignal.any([owner, timeout]);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `UserKnownHostsFile=${command.knownHostsFile}`,
          "-o",
          "IdentitiesOnly=yes",
          "-i",
          command.identityFile,
          "-o",
          `ConnectTimeout=${command.connectTimeoutSeconds}`,
          "-o",
          "LogLevel=ERROR",
          "-p",
          String(command.port),
          "-l",
          command.user,
          command.address,
          "--",
          command.nodePath,
          "-",
          command.operation,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let termination: ReturnType<typeof setTimeout> | undefined;
      let failed: Error | undefined;
      const terminate = () => {
        child.kill("SIGTERM");
        termination ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
        termination.unref();
      };
      const abort = () => {
        failed = new Error("SSH compute operation cancelled or timed out.");
        terminate();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 64 * 1024) {
          failed = new Error("SSH helper output exceeded its limit.");
          terminate();
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        // Diagnostics never include SSH's untrusted raw stderr in a thrown error.
        stderr = (stderr + chunk).slice(0, 4_096);
      });
      child.once("error", () => {
        failed = new Error("SSH client could not be started.");
      });
      child.stdin.on("error", () => {
        failed ??= new Error("SSH helper input could not be delivered.");
      });
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        clearTimeout(termination);
        if (failed !== undefined) reject(failed);
        else resolve({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.end(command.helper);
    });
  }
}
