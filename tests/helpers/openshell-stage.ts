import type { TestContext } from "node:test";
import { types } from "node:util";

import {
  credentialReplacementCase,
  credentialReplacementDiagnostic,
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
        types.isNativeError(error) &&
        !("openclawCiDiagnostic" in error)
      ) {
        const diagnostic = credentialReplacementDiagnostic(stage);
        if (diagnostic) {
          Object.assign(error, { openclawCiDiagnostic: diagnostic });
        }
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
