import type { TestContext } from "node:test";

import {
  credentialReplacementCase,
  credentialReplacementStage,
  emitOpenShellProgress,
  emitOpenShellStageFailure,
} from "../../scripts/ci/openshell-progress.mjs";

export async function runOpenShellStage<Result>(
  context: Pick<TestContext, "diagnostic"> & Partial<Pick<TestContext, "name">>,
  stage: string,
  operation: () => Result,
  sandboxPhase?: string,
): Promise<Awaited<Result>> {
  emitOpenShellProgress(stage, "started");
  const started = performance.now();
  let outcome: "passed" | "failed" = "failed";
  let finished: number | undefined;
  try {
    const result = await operation();
    outcome = "passed";
    return result;
  } catch (error: unknown) {
    finished = performance.now();
    // node:test reports errors after hooks; report only closed metadata now.
    try {
      emitOpenShellStageFailure(stage, error);
      if (
        context.name === credentialReplacementCase.name &&
        error instanceof Error &&
        !("openclawCiDiagnostic" in error) &&
        credentialReplacementStage(stage) !== undefined
      ) {
        Object.assign(error, {
          openclawCiDiagnostic: { kind: "openshell-credential-replacement", stage },
        });
      }
    } catch {
      // Diagnostics must not replace the failed operation.
    }
    throw error;
  } finally {
    const elapsedMs = Math.round((finished ?? performance.now()) - started);
    emitOpenShellProgress(stage, outcome);
    function reportMeasurement(kind: "openshell-stage" | "openshell-sandbox-phase", stage: string) {
      context.diagnostic(
        `openclaw-ci-measurement ${JSON.stringify({ kind, stage, outcome, elapsedMs })}`,
      );
    }

    if (stage !== "exposure-auth") {
      reportMeasurement("openshell-stage", stage);
    }
    if (sandboxPhase !== undefined) {
      reportMeasurement("openshell-sandbox-phase", sandboxPhase);
    }
  }
}
