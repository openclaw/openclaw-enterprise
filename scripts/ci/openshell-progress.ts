import { types } from "node:util";
import { installationPhase, type InstallationPhase } from "./openshell-installation-phase.ts";

export const openShellProgressPrefix = "openclaw-ci-progress ";
export const upstreamOutageCase = Object.freeze({
  entry: "tests/integration/openshell-upstream-real.test.ts",
  declaration: "tests/helpers/openshell-sandbox-workflows.mjs",
  name: "OpenShell model and tool upstream outages fail closed",
});
export const openShellReplacementCheckpoints = Object.freeze([
  "redeploy-request",
  "activation",
  "reconciliation",
] as const);

const failureCategories = [
  "AssertionError",
  "Error",
  "TypeError",
  "RangeError",
  "AbortError",
  "TimeoutError",
  "unknown",
] as const;
const nativeFailureCategories = new Map<unknown, FailureCategory>([
  [Error.prototype, "Error"],
  [TypeError.prototype, "TypeError"],
  [RangeError.prototype, "RangeError"],
]);
const failureCodes = [
  "ERR_ASSERTION",
  "ABORT_ERR",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOENT",
  null,
] as const;
const failureLocation = "tests/helpers/openshell-sandbox-workflows.mjs";
const openShellStages = [
  "plugin-check",
  "exposure-auth",
  "installation",
  "scratch-sibling-isolation",
  "scratch-queued-actor-revocation",
  "initial-model",
  "filesystem-network",
  "network-policy",
  "credential-route",
  "replacement",
  "untrusted-upstream",
  "tool-outage",
  "model-outage",
  "gateway-outage",
  "oauth-refresh",
  "non-model-source",
  "credential-absence",
  "credential-withdrawal",
  "embedded-refusal",
  "native-policy",
] as const;

type Stage = (typeof openShellStages)[number];
type FailureCategory = (typeof failureCategories)[number];
type FailureCode = (typeof failureCodes)[number];

export type OpenShellProgress =
  | InstallationPhase
  | {
      kind: "openshell-replacement-checkpoint";
      checkpoint: (typeof openShellReplacementCheckpoints)[number];
    }
  | {
      kind: "openshell-stage-failure";
      stage: Stage;
      category: FailureCategory;
      code: FailureCode;
      location: typeof failureLocation;
    }
  | { kind: "openshell-stage"; stage: Stage; outcome: "started" | "passed" | "failed" };

function isOneOf<T>(values: readonly T[], value: unknown): value is T {
  return values.some((allowed) => value === allowed);
}

function hasProperties(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

// Progress records carry only fixed categories. Reject extra fields to keep
// arbitrary diagnostic data out of this channel.
export function openShellProgress(value: unknown): OpenShellProgress | undefined {
  if (!hasProperties(value)) {
    return undefined;
  }
  const { kind } = value;
  if (kind === "openshell-installation") {
    return installationPhase(value);
  }
  if (kind === "openshell-replacement-checkpoint") {
    if (Object.keys(value).length !== 2) {
      return undefined;
    }
    const { checkpoint } = value;
    return isOneOf(openShellReplacementCheckpoints, checkpoint) ? { kind, checkpoint } : undefined;
  }
  if (kind === "openshell-stage-failure") {
    if (Object.keys(value).length !== 5) {
      return undefined;
    }
    const { stage, category, code, location } = value;
    if (
      isOneOf(openShellStages, stage) &&
      isOneOf(failureCategories, category) &&
      isOneOf(failureCodes, code) &&
      location === failureLocation
    ) {
      return { kind, stage, category, code, location };
    }
    return undefined;
  }
  if (
    kind !== "openshell-stage" ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3
  ) {
    return undefined;
  }
  const { stage, outcome } = value;
  return isOneOf(openShellStages, stage) &&
    (outcome === "started" || outcome === "passed" || outcome === "failed")
    ? { kind, stage, outcome }
    : undefined;
}

export function emitOpenShellProgress(stage: string, outcome: string) {
  const value = openShellProgress({ kind: "openshell-stage", stage, outcome });
  if (value) {
    process.stdout.write(`\n${openShellProgressPrefix}${JSON.stringify(value)}\n`);
  }
}

export function emitOpenShellReplacementCheckpoint(checkpoint: string) {
  const value = openShellProgress({ kind: "openshell-replacement-checkpoint", checkpoint });
  if (value) {
    process.stdout.write(`\n${openShellProgressPrefix}${JSON.stringify(value)}\n`);
  }
}

// The location identifies the workflow owner, not a frame from an error's text.
export function emitOpenShellStageFailure(stage: string, error: unknown) {
  let category: FailureCategory = "unknown";
  let code: FailureCode = null;
  if (types.isNativeError(error)) {
    // Descriptors do not invoke accessors; proxies are not native errors.
    const name: unknown = Object.getOwnPropertyDescriptor(error, "name")?.value;
    const ownCode: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    category = nativeFailureCategories.get(Object.getPrototypeOf(error)) ?? "unknown";
    if (isOneOf(failureCategories, name)) {
      category = name;
    }
    code = isOneOf(failureCodes, ownCode) ? ownCode : null;
  }
  const value = openShellProgress({
    kind: "openshell-stage-failure",
    stage,
    category,
    code,
    location: failureLocation,
  });
  if (value) {
    process.stdout.write(`\n${openShellProgressPrefix}${JSON.stringify(value)}\n`);
  }
}

// Keep at most one small partial record, even when a child never sends a newline.
// Oversized lines are ignored through their terminator; a following record can resume.
export function boundedProgressLines(onLine: (line: string) => void) {
  let partial = "";
  let dropping = false;
  return (text: string) => {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline;
      if (!dropping) {
        if (partial.length + end - start > 256) {
          partial = "";
          dropping = true;
        } else {
          partial += text.slice(start, end);
        }
      }
      if (newline !== -1) {
        if (!dropping) {
          onLine(partial);
        }
        partial = "";
        dropping = false;
      }
      start = end + 1;
    }
  };
}
