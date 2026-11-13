import { types } from "node:util";
import { installationPhase } from "./openshell-installation-phase.ts";

export const openShellProgressPrefix = "openclaw-ci-progress ";

const failureCategories = new Set([
  "AssertionError",
  "Error",
  "TypeError",
  "RangeError",
  "AbortError",
  "TimeoutError",
  "unknown",
]);
const nativeFailureCategories = new Map([
  [Error.prototype, "Error"],
  [TypeError.prototype, "TypeError"],
  [RangeError.prototype, "RangeError"],
]);
const failureCodes = new Set([
  "ERR_ASSERTION",
  "ABORT_ERR",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOENT",
  null,
]);
const failureLocation = "tests/helpers/openshell-sandbox-workflows.mjs";
const openShellStages = new Set([
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
]);

// A live log carries only fixed categories. Reject extra fields rather than
// accidentally turning this channel into an arbitrary diagnostic transport.
export function openShellProgress(value) {
  if (value?.kind === "openshell-installation") {
    return installationPhase(value);
  }
  if (value?.kind === "openshell-stage-failure") {
    if (
      Object.keys(value).length !== 5 ||
      !openShellStages.has(value.stage) ||
      !failureCategories.has(value.category) ||
      !failureCodes.has(value.code) ||
      value.location !== failureLocation
    ) {
      return undefined;
    }
    return {
      kind: value.kind,
      stage: value.stage,
      category: value.category,
      code: value.code,
      location: failureLocation,
    };
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    value.kind !== "openshell-stage" ||
    !openShellStages.has(value.stage) ||
    !["started", "passed", "failed"].includes(value.outcome)
  ) {
    return undefined;
  }
  return { kind: value.kind, stage: value.stage, outcome: value.outcome };
}

export function emitOpenShellProgress(stage, outcome) {
  const value = openShellProgress({ kind: "openshell-stage", stage, outcome });
  if (value) {
    process.stdout.write(`\n${openShellProgressPrefix}${JSON.stringify(value)}\n`);
  }
}

// The location identifies the workflow owner, not a frame from an error's text.
export function emitOpenShellStageFailure(stage, error) {
  let category = "unknown";
  let code = null;
  if (types.isNativeError(error)) {
    // Descriptors do not invoke accessors; proxies are not native errors.
    const name = Object.getOwnPropertyDescriptor(error, "name")?.value;
    const ownCode = Object.getOwnPropertyDescriptor(error, "code")?.value;
    category = nativeFailureCategories.get(Object.getPrototypeOf(error)) ?? "unknown";
    if (failureCategories.has(name)) {
      category = name;
    }
    code = failureCodes.has(ownCode) ? ownCode : null;
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
export function boundedProgressLines(onLine) {
  let partial = "";
  let dropping = false;
  return (text) => {
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
