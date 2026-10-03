#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { prepareDevelopmentCodexSeccompProfile } from "./lib/codex-seccomp-k3d.mjs";

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

function failureReason(error) {
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
function failureMessage(command, error, stderr) {
  const detail = stderr.trim().replace(/\s+/g, " ");
  const tail = detail.length > stderrLimit ? `...${detail.slice(-stderrLimit)}` : detail;
  return `${command} failed (${failureReason(error)})${tail ? `: ${tail}` : "."}`;
}

function execFile(command, args, { timeoutMs: commandTimeoutMs }) {
  return new Promise((resolve, reject) => {
    execFileCallback(
      command,
      args,
      { timeout: commandTimeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const failure = new Error(failureMessage(command, error, stderr));
          failure.stdout = stdout;
          failure.stderr = stderr;
          failure.timedOut = error.killed === true;
          reject(failure);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

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
  process.stderr.write(`Development Codex sandbox preparation failed: ${error.message}\n`);
  process.exitCode = 1;
}
