import { appendFile, writeFile } from "node:fs/promises";

const stages = [
  "preflight",
  "install",
  "bind-images",
  "bind-database",
  "selected-test",
  "verify-proof",
  "write-success-receipt",
  "finish-fixture",
] as const;
const cleanups = ["passed", "failed", "unknown"] as const;

type Checkpoint =
  | ["skipper_stage", (typeof stages)[number]]
  | ["skipper_installed_cleanup", (typeof cleanups)[number]];

export async function recordSkipperCheckpoint(...[key, value]: Checkpoint): Promise<void> {
  const output = process.env.GITHUB_OUTPUT;
  if (process.env.GITHUB_ACTIONS === "true" && output) {
    // A failure to record evidence must leave the original proof and cleanup in charge.
    await appendFile(output, key + "=" + value + "\n").catch(() => {});
  }
}

function selected<T extends string>(
  allowed: readonly T[],
  input: string | undefined,
): T | "unknown" {
  return allowed.find((value) => value === input) ?? "unknown";
}

if (import.meta.main && process.env.SKIPPER_PROOF_OUTCOME === "failure") {
  const { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sourceSha } = process.env;
  const output = process.argv[2];
  if (
    !output ||
    !runId ||
    !/^[1-9]\d{0,15}$/.test(runId) ||
    !attempt ||
    !/^[1-9]\d{0,3}$/.test(attempt) ||
    !sourceSha ||
    !/^[a-f0-9]{40}$/.test(sourceSha)
  ) {
    console.error("Invalid installed Skipper failure receipt identity.");
    process.exitCode = 1;
  } else {
    const receipt = {
      version: 1,
      runId,
      attempt,
      sourceSha,
      outcome: "failed",
      lastStage: selected(stages, process.env.SKIPPER_STAGE),
      installedCleanup: selected(cleanups, process.env.SKIPPER_INSTALLED_CLEANUP),
    };
    try {
      await writeFile(output, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
    } catch {
      console.error("Could not write installed Skipper failure receipt.");
      process.exitCode = 1;
    }
  }
}
