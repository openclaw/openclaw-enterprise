import { constants } from "node:os";

const operations = new Set([
  "before-custody-supervisor-get",
  "before-custody-log-read",
  "before-custody-supervisor-recheck",
  "gateway-codex-exec",
  "gateway-turn-verification",
  "after-custody-observation",
  "after-custody-supervisor-get",
  "after-custody-log-read",
  "after-custody-supervisor-recheck",
]);

const signals = new Set(Object.keys(constants.signals));
const outcomes = new Set(["exit", "signal", "cancelled", "deadline", "transport"]);
const failedOperations = new WeakMap();
const kubectlOutcomes = new WeakMap();

export async function observeConnectedOperation(operation, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && operations.has(operation) && !failedOperations.has(error)) {
      failedOperations.set(error, operation);
    }
    throw error;
  }
}

export function rememberKubectlOutcome(
  error,
  { outcome, exitCode, signal, killed, signalAborted },
) {
  kubectlOutcomes.set(error, {
    outcome: outcomes.has(outcome) ? outcome : "transport",
    exitCode: Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null,
    signal: signals.has(signal) ? signal : null,
    killed: typeof killed === "boolean" ? killed : null,
    signalAborted: signalAborted === true,
  });
  return error;
}

// The test owns stage through its checkpoints. Error payloads cannot choose it.
export async function safeConnectedFailure(error, stage, recordFailure) {
  // Only fixed source names and bounded V8 coordinates can reach the reporter.
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  const frame = stack.match(
    /^ +at [^\n]*[/\\](agent-openshell-static-egress-k3d-real\.test|egress-(?:connected-inputs|controller-upgrade|custody-observations|installed-(?:agent|resource-cleanup|stack)|managed-workload-exec|supplier-custody-transitions)|openshell-kubernetes-real)\.mjs:(\d{1,5}):(\d{1,4})(?:\))?$/m,
  );
  const location = frame ? `${frame[1]}.mjs:${frame[2]}:${frame[3]}` : "external-operation";
  const kind = error?.code === "ERR_ASSERTION" ? "assertion" : "operation";
  const operation = failedOperations.get(error) ?? null;
  const kubectl = kubectlOutcomes.get(error) ?? null;
  if (operation !== null || kubectl !== null) {
    try {
      await recordFailure?.({ kind, operation, kubectl });
    } catch {
      // A diagnostic write must not replace the triggering failure or interrupt cleanup.
    }
  }
  const step = operation === null ? "" : ` / ${operation}`;
  const process = kubectl === null ? "" : ` kubectl=${JSON.stringify(kubectl)}`;
  return new Error(
    `Connected egress ${kind} failed at ${stage}${step} (${location})${process}; inspect the per-run ledger`,
  );
}
