import { appendFile, readFile, writeFile } from "node:fs/promises";

import {
  skipperOperations,
  skipperOperationDiagnostic,
  skipperSelectedFailure,
  skipperTestCheckpoints,
} from "./skipper-release.ts";

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
  | ["skipper_test_operation", (typeof skipperOperations)[number] | "unknown"]
  | ["skipper_last_test_checkpoint", string]
  | ["skipper_stage", (typeof stages)[number]]
  | ["skipper_installed_cleanup", (typeof cleanups)[number]];

export async function recordSkipperCheckpoint(...[key, value]: Checkpoint): Promise<void> {
  const output = process.env.GITHUB_OUTPUT;
  if (process.env.GITHUB_ACTIONS === "true" && output) {
    // A failure to record evidence must leave the original proof and cleanup in charge.
    await appendFile(output, key + "=" + value + "\n").catch(() => {});
  }
}

/** Failed runners retain only the valid prefix; successful runners require the whole ledger. */
export async function readSkipperJourney(ledgerPath: string, failed: boolean) {
  const ledger = await readFile(ledgerPath, "utf8").catch(() => "");
  const entries: Record<string, unknown>[] = [];
  for (const line of ledger.trim().split("\n")) {
    if (failed ? !line.trim() : !line) {
      continue;
    }
    try {
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new TypeError("Invalid installed Skipper journey entry.");
      }
      entries.push(entry as Record<string, unknown>);
    } catch (error) {
      if (!failed) {
        throw error;
      }
      break;
    }
  }
  return entries;
}

/** Retain bounded failure evidence before optional ledger I/O. */
export async function recordSkipperTestFailure(
  resultText: string,
  ledgerPath: string,
  teamReview: boolean,
) {
  let operation: (typeof skipperOperations)[number] | "unknown" = "unknown";
  try {
    operation =
      skipperOperationDiagnostic(skipperSelectedFailure(resultText).error.diagnostic)?.operation ??
      "unknown";
  } catch {
    // Missing or malformed runner evidence does not establish an operation.
  }
  await recordSkipperCheckpoint("skipper_test_operation", operation);
  const entries = await readSkipperJourney(ledgerPath, true);
  const known = skipperTestCheckpoints(teamReview);
  const last =
    entries
      .map((entry) => entry.phase)
      .filter((phase): phase is string => typeof phase === "string" && known.includes(phase))
      .at(-1) ?? "unknown";
  await recordSkipperCheckpoint("skipper_last_test_checkpoint", last);
  return { entries, last };
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
    const lastStage = selected(stages, process.env.SKIPPER_STAGE);
    const receipt = {
      version: 1,
      runId,
      attempt,
      sourceSha,
      outcome: "failed",
      lastStage,
      ...(lastStage === "selected-test"
        ? {
            testOperation: selected(skipperOperations, process.env.SKIPPER_TEST_OPERATION),
            lastTestCheckpoint: selected(
              [...skipperTestCheckpoints(false), ...skipperTestCheckpoints(true)],
              process.env.SKIPPER_LAST_TEST_CHECKPOINT,
            ),
          }
        : {}),
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
