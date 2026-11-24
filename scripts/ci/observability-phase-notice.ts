import { writeSync } from "node:fs";

const laneName = "k3d-observability";
const maximumElapsedMs = 24 * 60 * 60 * 1_000;
type Outcome = "success" | "failure" | "skipped";

function emit(message: string) {
  const line = `::notice title=Production Observability timing::${message}\n`;
  try {
    return writeSync(2, line) === line.length;
  } catch {
    // The notice is optional. A closed log must not change the phase's outcome.
    return false;
  }
}

export function startObservabilityPhase(lane: string, phase: string) {
  if (
    lane !== laneName ||
    (phase !== "cluster-build-pull" &&
      phase !== "workload-image-imports" &&
      phase !== "lane-cleanup") ||
    process.env.GITHUB_ACTIONS !== "true"
  ) {
    return;
  }
  const { GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sha } = process.env;
  if (
    !run ||
    !/^[1-9][0-9]{0,19}$/u.test(run) ||
    !attempt ||
    !/^[1-9][0-9]{0,9}$/u.test(attempt) ||
    !sha ||
    !/^[a-f0-9]{40}$/u.test(sha)
  ) {
    return;
  }
  const binding = `lane=${laneName} run_id=${run} run_attempt=${attempt} source_sha=${sha} phase=${phase}`;
  if (!emit(`${binding} event=start`)) {
    return;
  }
  return (outcome: Outcome, elapsedMs: number) => {
    if (outcome === "skipped" && phase === "lane-cleanup") {
      emit(`${binding} event=finish outcome=skipped`);
    } else if (
      (outcome === "success" || outcome === "failure") &&
      Number.isSafeInteger(elapsedMs) &&
      elapsedMs >= 0 &&
      elapsedMs <= maximumElapsedMs
    ) {
      emit(`${binding} event=finish outcome=${outcome} elapsed_ms=${elapsedMs}`);
    }
  };
}
