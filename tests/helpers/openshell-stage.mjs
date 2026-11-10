import {
  emitOpenShellProgress,
  emitOpenShellStageFailure,
} from "../../scripts/ci/openshell-progress.mjs";

export async function runOpenShellStage(context, stage, operation, sandboxPhase) {
  emitOpenShellProgress(stage, "started");
  const started = performance.now();
  let outcome = "failed";
  let finished;
  try {
    const result = await operation();
    outcome = "passed";
    return result;
  } catch (error) {
    finished = performance.now();
    // node:test reports errors after hooks; report only closed metadata now.
    try {
      emitOpenShellStageFailure(stage, error);
    } catch {
      // Diagnostics must not replace the failed operation.
    }
    throw error;
  } finally {
    const elapsedMs = Math.round((finished ?? performance.now()) - started);
    emitOpenShellProgress(stage, outcome);
    if (stage !== "exposure-auth") {
      context.diagnostic(
        `openclaw-ci-measurement ${JSON.stringify({ kind: "openshell-stage", stage, outcome, elapsedMs })}`,
      );
    }
    if (sandboxPhase !== undefined) {
      context.diagnostic(
        `openclaw-ci-measurement ${JSON.stringify({
          kind: "openshell-sandbox-phase",
          stage: sandboxPhase,
          outcome,
          elapsedMs,
        })}`,
      );
    }
  }
}
