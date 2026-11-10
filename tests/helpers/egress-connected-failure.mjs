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
export const nativeFailureMarker = "OCC_NATIVE_FAILURE_V1 ";
const acknowledgementsByPhase = new Map([
  ["connect", [null]],
  ["initialize", [null, "initialize"]],
  ["thread/start", [null, "initialize", "thread/start"]],
  ["turn/start", ["thread/start"]],
  ["turn", ["turn/start"]],
]);

function readNativeFailure(stderr, tag, clientExit) {
  const marker = nativeFailureMarker + tag;
  const start = stderr?.indexOf(marker) ?? -1;
  if (start === -1) {
    return { status: "absent" };
  }
  const invalid = { status: "invalid" };
  const payload = start + marker.length + 1;
  const end = stderr.indexOf("\n", payload);
  if (
    !clientExit ||
    stderr[start - 1] !== "\n" ||
    stderr[payload - 1] !== " " ||
    end === -1 ||
    end - payload > 512 ||
    stderr.includes(marker, payload - 1)
  ) {
    return invalid;
  }
  try {
    const encoded = stderr.slice(payload, end);
    const { phase, lastAcknowledged, pendingRequests, receivedMessages, actionSeen } =
      JSON.parse(encoded);
    if (
      !acknowledgementsByPhase.get(phase)?.includes(lastAcknowledged) ||
      !Array.isArray(pendingRequests) ||
      pendingRequests.length > 1 ||
      !pendingRequests.every(
        (method) =>
          method === phase && phase !== "connect" && phase !== "turn" && lastAcknowledged !== phase,
      ) ||
      !Number.isSafeInteger(receivedMessages) ||
      receivedMessages < 0 ||
      receivedMessages > 1_000_000 ||
      typeof actionSeen !== "boolean"
    ) {
      return invalid;
    }
    const record = { phase, lastAcknowledged, pendingRequests, receivedMessages, actionSeen };
    // Re-encode only the closed schema. Unknown or duplicate keys and noncanonical
    // values must never survive a mixed stderr stream.
    return JSON.stringify(record) === encoded ? { status: "recorded", ...record } : invalid;
  } catch {
    return invalid;
  }
}

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
  nativeFailure,
) {
  kubectlOutcomes.set(error, {
    kubectl: {
      outcome: outcomes.has(outcome) ? outcome : "transport",
      exitCode: Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null,
      signal: signals.has(signal) ? signal : null,
      killed: typeof killed === "boolean" ? killed : null,
      signalAborted: signalAborted === true,
    },
    nativeExec:
      nativeFailure === undefined
        ? undefined
        : readNativeFailure(nativeFailure.stderr, nativeFailure.tag, nativeFailure.clientExit),
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
  const local = kubectlOutcomes.get(error);
  const kubectl = local?.kubectl ?? null;
  const nativeExec = operation === "gateway-codex-exec" ? local?.nativeExec : undefined;
  if (operation !== null || kubectl !== null) {
    try {
      await recordFailure?.({ kind, operation, kubectl, ...(nativeExec && { nativeExec }) });
    } catch {
      // A diagnostic write must not replace the triggering failure or interrupt cleanup.
    }
  }
  const step = operation === null ? "" : ` / ${operation}`;
  const process = kubectl === null ? "" : ` kubectl=${JSON.stringify(kubectl)}`;
  const native = nativeExec === undefined ? "" : ` nativeExec=${JSON.stringify(nativeExec)}`;
  return new Error(
    `Connected egress ${kind} failed at ${stage}${step} (${location})${process}${native}; inspect the per-run ledger`,
  );
}
