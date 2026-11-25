import { writeSync } from "node:fs";

const maximumElapsedMs = 24 * 60 * 60 * 1_000;
type Outcome = "success" | "failure" | "skipped";

function emit(line: string) {
  try {
    return writeSync(2, line) === line.length;
  } catch {
    // The notice is optional. A closed log must not change the phase's outcome.
    return false;
  }
}

function startPhaseNotice(
  title: string,
  lane: string,
  phase: string,
  events: "start-and-finish" | "finish-only",
) {
  if (process.env.GITHUB_ACTIONS !== "true") {
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
  const binding = `::notice title=${title}::lane=${lane} run_id=${run} run_attempt=${attempt} source_sha=${sha} phase=${phase}`;
  if (events === "start-and-finish" && !emit(`${binding} event=start\n`)) {
    return;
  }
  return (outcome: Outcome, elapsedMs: number) => {
    if (outcome === "skipped" && phase === "lane-cleanup") {
      emit(`${binding} event=finish outcome=skipped\n`);
    } else if (
      (outcome === "success" || outcome === "failure") &&
      Number.isSafeInteger(elapsedMs) &&
      elapsedMs >= 0 &&
      elapsedMs <= maximumElapsedMs
    ) {
      emit(`${binding} event=finish outcome=${outcome} elapsed_ms=${elapsedMs}\n`);
    }
  };
}

export function startObservabilityPhase(lane: string, phase: string) {
  if (
    lane === "k3d-observability" &&
    ["cluster-build-pull", "workload-image-imports", "lane-cleanup"].includes(phase)
  ) {
    return startPhaseNotice("Production Observability timing", lane, phase, "start-and-finish");
  }
}

export function startImageRuntimeStartupPhase(lane: string, phase: string) {
  if (lane !== "images-runtime-startup") {
    return;
  }
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: event,
    GITHUB_REF: ref,
    GITHUB_WORKFLOW_REF: workflow,
  } = process.env;
  if (
    repository === "openclaw/openclaw-enterprise" &&
    event === "push" &&
    ref === "refs/heads/main" &&
    workflow === "openclaw/openclaw-enterprise/.github/workflows/ci.yml@refs/heads/main" &&
    [
      "runtime-image-build-cluster",
      "image-load",
      "k3d-create",
      "workspace-envoy-image",
      "runtime-image-import",
      "codex-seccomp-profile",
    ].includes(phase)
  ) {
    // Six phases share the Actions step's budget of ten notices.
    return startPhaseNotice("Image Runtime Startup preparation", lane, phase, "finish-only");
  }
}
