import { appendFile } from "node:fs/promises";

type Phase = "docker-setup" | "pnpm-install" | "image-pulls";
type Outcome = "success" | "failure" | "skipped" | "cancelled";

function isPhase(value: string | undefined): value is Phase {
  return value === "docker-setup" || value === "pnpm-install" || value === "image-pulls";
}

function isOutcome(value: string | undefined): value is Outcome {
  return value === "success" || value === "failure" || value === "skipped" || value === "cancelled";
}

async function appendTiming(path: string | undefined, line: string) {
  if (path) {
    try {
      await appendFile(path, line);
    } catch {
      // Diagnostics must not change a lane's result.
    }
  }
}

export async function recordLoggingSetupTiming(
  phase: string | undefined,
  outcome: string | undefined,
  elapsedMs?: number,
) {
  if (!isPhase(phase) || !isOutcome(outcome)) {
    return;
  }
  const duration =
    (outcome === "success" || outcome === "failure") &&
    elapsedMs !== undefined &&
    Number.isSafeInteger(elapsedMs) &&
    elapsedMs >= 0
      ? ` (${elapsedMs} ms)`
      : "";
  await appendTiming(
    process.env.GITHUB_STEP_SUMMARY,
    `- logging-collector / ${phase}: ${outcome}${duration}\n`,
  );
}

function elapsedSince(startedNs: string | undefined) {
  if (!startedNs || !/^[0-9]{1,20}$/.test(startedNs)) {
    return undefined;
  }
  // Steps in the composite share the same Linux runner's monotonic clock.
  const elapsed = process.hrtime.bigint() - BigInt(startedNs);
  return elapsed >= 0n ? Number(elapsed / 1_000_000n) : undefined;
}

if (import.meta.main) {
  const [command, phase] = process.argv.slice(2);
  if (command === "start") {
    await appendTiming(process.env.GITHUB_OUTPUT, `started-ns=${process.hrtime.bigint()}\n`);
  } else if (command === "finish") {
    await recordLoggingSetupTiming(
      phase,
      process.env.LOGGING_SETUP_OUTCOME,
      elapsedSince(process.env.LOGGING_SETUP_STARTED_NS),
    );
  }
}
