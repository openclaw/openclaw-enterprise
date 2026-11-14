import { writeSync } from "node:fs";
import {
  maxInstallationInvocations,
  type InstallationPhase,
} from "../../scripts/ci/openshell-installation-phase.ts";
import { openShellProgressPrefix } from "../../scripts/ci/openshell-progress.mjs";

type Operation<T> = () => Promise<T>;

const writeProgress =
  process.env.OCC_TEST_OPENSHELL_INSTALLATION_PROGRESS === "1"
    ? (row: InstallationPhase) =>
        writeSync(1, "\n" + openShellProgressPrefix + JSON.stringify(row) + "\n")
    : undefined;

function installationObserver(
  firstStage: "workspace-helm" | "namespace-ready",
  write: ((row: InstallationPhase) => void) | undefined,
  now = () => performance.now(),
) {
  let invocationCount = 0;
  return () => {
    const invocation = ++invocationCount;
    const start = now();
    const record = (
      stage: InstallationPhase["stage"],
      outcome: InstallationPhase["outcome"],
      refusal?: InstallationPhase["refusal"],
    ) => {
      if (
        write &&
        (invocation <= maxInstallationInvocations ||
          (invocation === maxInstallationInvocations + 1 &&
            stage === firstStage &&
            outcome === "entered"))
      ) {
        try {
          write({
            kind: "openshell-installation",
            stage,
            invocation,
            outcome,
            ...(refusal ? { refusal } : {}),
            offsetMs: Math.round(now() - start),
          });
        } catch {
          // An unavailable diagnostic stream cannot change the installation result.
        }
      }
    };
    return async <R>(
      stage: InstallationPhase["stage"],
      run: Operation<R>,
      classify?: (error: unknown) => InstallationPhase["refusal"],
    ) => {
      record(stage, "entered");
      try {
        const result = await run();
        record(stage, "passed");
        return result;
      } catch (error) {
        let refusal: InstallationPhase["refusal"];
        try {
          refusal = classify?.(error);
        } catch {
          // An opaque thrown value can also refuse inspection.
        }
        record(stage, "failed", refusal);
        throw error;
      }
    };
  };
}

export const beginProductionInstallation = installationObserver("namespace-ready", writeProgress);

export function observeGatewayInstallation(
  write?: (row: InstallationPhase) => void,
  now = () => performance.now(),
) {
  const begin = installationObserver("workspace-helm", write, now);
  return async function install<Values, T>(
    workspaceHelm: Operation<unknown>,
    gatewayValues: Operation<Values>,
    gatewayHelm: (values: Values) => Promise<unknown>,
    gatewayPodReady: Operation<T>,
  ): Promise<T> {
    const measure = begin();
    await measure("workspace-helm", workspaceHelm);
    const values = await gatewayValues();
    await measure("gateway-helm", () => gatewayHelm(values));
    return measure("gateway-pod-ready", gatewayPodReady);
  };
}

export const runGatewayInstallation = observeGatewayInstallation(writeProgress);
