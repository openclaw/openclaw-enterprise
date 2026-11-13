#!/usr/bin/env node
import { execFile as execFileCallback, type ExecFileException } from "node:child_process";
import { prepareDevelopmentCodexSeccompProfile } from "./lib/codex-seccomp-k3d.ts";

const [directory, image, timeoutSeconds, ...extra] = process.argv.slice(2);
const timeoutMs = Number(timeoutSeconds) * 1_000;
if (
  !directory ||
  !image ||
  extra.length ||
  !Number.isInteger(timeoutMs) ||
  timeoutMs < 1_000 ||
  timeoutMs > 86_400_000
) {
  throw new Error(
    "Expected the owned development state directory, immutable runtime image, and startup timeout.",
  );
}

const stderrLimit = 400;

function failureReason(error: ExecFileException) {
  if (typeof error.code === "string") {
    return error.code;
  }
  if (error.killed) {
    return "timed out";
  }
  return error.signal ? `signal ${error.signal}` : `exit ${error.code}`;
}

// Name why a command failed and keep the end of its stderr. Never include
// stdout: CRI inspection output can contain mount details.
function failureMessage(command: string, error: ExecFileException, stderr: string) {
  const detail = stderr.trim().replace(/\s+/g, " ");
  const tail = detail.length > stderrLimit ? `...${detail.slice(-stderrLimit)}` : detail;
  return `${command} failed (${failureReason(error)})${tail ? `: ${tail}` : "."}`;
}

const execFile: Parameters<typeof prepareDevelopmentCodexSeccompProfile>[0]["execFile"] = (
  command,
  args,
  { timeoutMs: commandTimeoutMs },
) => {
  return new Promise((resolve, reject) => {
    execFileCallback(
      command,
      args,
      { timeout: commandTimeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(new Error(failureMessage(command, error, stderr)), {
              stdout,
              stderr,
              exitCode: error.code,
              signal: error.signal,
              killed: error.killed,
              timedOut: error.killed === true,
            }),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
};

try {
  const result = await prepareDevelopmentCodexSeccompProfile({
    directory,
    image,
    execFile,
    timeoutMs,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // Do not print CRI output: even a probe inspection can include mount details.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Development Codex sandbox preparation failed: ${message}\n`);
  process.exitCode = 1;
}
