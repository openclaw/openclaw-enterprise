import { writeSync } from "node:fs";
import {
  maxInstallationInvocations,
  type InstallationPhase,
} from "../../scripts/ci/openshell-installation-phase.ts";
import { openShellProgressPrefix } from "../../scripts/ci/openshell-progress.mjs";

type Operation<T> = () => Promise<T>;

export function observeGatewayInstallation(
  write?: (row: InstallationPhase) => void,
  now = () => performance.now(),
) {
  let invocationCount = 0;
  return async function install<Values, T>(
    workspaceHelm: Operation<unknown>,
    gatewayValues: Operation<Values>,
    gatewayHelm: (values: Values) => Promise<unknown>,
    gatewayPodReady: Operation<T>,
  ): Promise<T> {
    const invocation = ++invocationCount;
    const start = now();
    const record = (stage: InstallationPhase["stage"], outcome: InstallationPhase["outcome"]) => {
      if (
        write &&
        (invocation <= maxInstallationInvocations ||
          (invocation === maxInstallationInvocations + 1 &&
            stage === "workspace-helm" &&
            outcome === "entered"))
      ) {
        try {
          write({
            kind: "openshell-installation",
            stage,
            invocation,
            outcome,
            offsetMs: Math.round(now() - start),
          });
        } catch {
          // An unavailable diagnostic stream cannot change the installation result.
        }
      }
    };
    const measure = async <R>(stage: InstallationPhase["stage"], run: Operation<R>) => {
      record(stage, "entered");
      try {
        const result = await run();
        record(stage, "passed");
        return result;
      } catch (error) {
        record(stage, "failed");
        throw error;
      }
    };
    await measure("workspace-helm", workspaceHelm);
    const values = await gatewayValues();
    await measure("gateway-helm", () => gatewayHelm(values));
    return measure("gateway-pod-ready", gatewayPodReady);
  };
}

export const runGatewayInstallation = observeGatewayInstallation(
  process.env.OCC_TEST_OPENSHELL_INSTALLATION_PROGRESS === "1"
    ? (row) => writeSync(1, "\n" + openShellProgressPrefix + JSON.stringify(row) + "\n")
    : undefined,
);
