import { constants } from "node:os";

const operations = new Set([
  "before-custody-supervisor-get",
  "before-custody-log-read",
  "before-custody-supervisor-recheck",
  "gateway-selection-list",
  "gateway-exec-target-get",
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

const urlShapes = new Set([
  "unknown",
  "missing",
  "empty",
  "malformed",
  "ws",
  "wss",
  "http",
  "https",
  "other",
]);
const failureSites = new Set([
  "startup",
  "configuration",
  "websocket-constructor",
  "websocket-error",
  "websocket-close",
  "message-decode",
  "client",
]);

// Also embedded in the generated client. Classify the input without changing
// what is passed to WebSocket or retaining any part of the URL.
export function appServerUrlShape(value) {
  if (value === undefined) {
    return "missing";
  }
  if (value === "") {
    return "empty";
  }
  try {
    const scheme = new URL(value).protocol;
    return ["ws:", "wss:", "http:", "https:"].includes(scheme) ? scheme.slice(0, -1) : "other";
  } catch {
    return "malformed";
  }
}

export function describeGatewayAppServerDeclaration(pod, containerName) {
  const containers = pod.spec.containers;
  const defaultContainer =
    containerName ?? pod.metadata.annotations?.["kubectl.kubernetes.io/default-container"];
  const container =
    containers.find(({ name }) => name === defaultContainer) ??
    (containerName === undefined && containers.length === 1 ? containers[0] : undefined);
  if (container === undefined) {
    return null;
  }
  const describe = (name, classify) => {
    const entry = container.env?.findLast((entry) => entry.name === name);
    if (entry === undefined) {
      return {
        source: container.envFrom?.length ? "env-from-possible" : "not-declared",
        value: null,
      };
    }
    if (entry.valueFrom !== undefined) {
      return { source: "reference", value: null };
    }
    const value = entry.value ?? "";
    // Kubernetes may expand a literal using other environment variables.
    return { source: "literal", value: value.includes("$(") ? null : classify(value) };
  };
  const url = describe("APP_SERVER_URL", appServerUrlShape);
  const token = describe("APP_SERVER_TOKEN", Boolean);
  return {
    urlSource: url.source,
    urlShape: url.value,
    tokenSource: token.source,
    tokenNonEmpty: token.value,
  };
}

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
    const {
      phase,
      lastAcknowledged,
      pendingRequests,
      receivedMessages,
      actionSeen,
      failureSite,
      urlShape,
      tokenPresent,
    } = JSON.parse(encoded);
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
      typeof actionSeen !== "boolean" ||
      !failureSites.has(failureSite) ||
      !urlShapes.has(urlShape) ||
      (tokenPresent !== null && typeof tokenPresent !== "boolean")
    ) {
      return invalid;
    }
    const record = {
      phase,
      lastAcknowledged,
      pendingRequests,
      receivedMessages,
      actionSeen,
      failureSite,
      urlShape,
      tokenPresent,
    };
    // Re-encode only the closed schema. Unknown or duplicate keys and noncanonical
    // values must never survive a mixed stderr stream.
    return JSON.stringify(record) === encoded ? { status: "recorded", ...record } : invalid;
  } catch {
    return invalid;
  }
}

const turnStatuses = new Set(["completed", "failed", "interrupted", "inProgress"]);
// Codex app-server v2 CodexErrorInfo. Forward-compatible extension keys and strings
// are admitted by the wire schema but must never reach a diagnostic.
const codexErrorCodes = new Set([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "rateLimitExceeded",
  "flexUnavailable",
  "serverOverloaded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "tooManyDenials",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "other",
]);
const codexHttpErrorCodes = new Set([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);

function jsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summarizeTurnError(error) {
  if (error === undefined) {
    return { state: "absent" };
  }
  if (error === null) {
    return { state: "null" };
  }
  if (!jsonObject(error) || typeof error.message !== "string") {
    return { state: "invalid" };
  }
  const info = error.codexErrorInfo;
  if (info === undefined) {
    return { state: "absent" };
  }
  if (info === null) {
    return { state: "null" };
  }
  if (typeof info === "string") {
    return codexErrorCodes.has(info) ? { state: "known", variant: info } : { state: "unknown" };
  }
  if (!jsonObject(info) || Object.keys(info).length !== 1) {
    return { state: "invalid" };
  }
  const [variant] = Object.keys(info);
  const payload = info[variant];
  if (variant === "activeTurnNotSteerable") {
    const turnKind = payload?.turnKind;
    return jsonObject(payload) && ["review", "compact"].includes(turnKind)
      ? { state: "known", variant, turnKind }
      : { state: "invalid" };
  }
  if (!codexHttpErrorCodes.has(variant)) {
    return { state: "unknown" };
  }
  if (!jsonObject(payload)) {
    return { state: "invalid" };
  }
  const code = payload.httpStatusCode;
  let httpStatus = { state: "invalid" };
  if (!Object.hasOwn(payload, "httpStatusCode")) {
    httpStatus = { state: "absent" };
  } else if (code === null) {
    httpStatus = { state: "null" };
  } else if (Number.isInteger(code) && code >= 0 && code <= 65_535) {
    // Preserve the wire uint16. Its value alone does not establish a response origin.
    httpStatus = { state: "present", code };
  }
  return { state: "known", variant, httpStatus };
}

export function summarizeGatewayTurnResult(expected, result) {
  const expectedStatus = turnStatuses.has(expected) ? expected : "unknown";
  const actualStatus = turnStatuses.has(result?.status) ? result.status : "unknown";
  const summary = {
    expectedStatus,
    actualStatus,
    lastAcknowledged: null,
    terminalEvent: null,
    terminalError: null,
    errorNotifications: [],
  };
  const observation = result?.terminalObservation;
  if (observation?.lastAcknowledged !== "turn/start" || !Array.isArray(result.items)) {
    return summary;
  }
  const { terminalEventIndex, errorEventIndexes } = observation;
  if (!Number.isSafeInteger(terminalEventIndex) || terminalEventIndex < 0) {
    return summary;
  }
  const event = result.items[terminalEventIndex];
  const terminal = event?.params;
  if (
    event?.method !== "turn/completed" ||
    event.id !== undefined ||
    typeof terminal?.threadId !== "string" ||
    !terminal.threadId ||
    typeof terminal.turn?.id !== "string" ||
    !terminal.turn.id ||
    actualStatus === "unknown" ||
    terminal.turn.status !== actualStatus
  ) {
    return summary;
  }
  summary.lastAcknowledged = "turn/start";
  summary.terminalEvent = "turn/completed";
  summary.terminalError = summarizeTurnError(terminal.turn.error);
  if (!Array.isArray(errorEventIndexes) || errorEventIndexes.length > 4) {
    return summary;
  }
  for (const index of errorEventIndexes) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= terminalEventIndex) {
      continue;
    }
    const notice = result.items[index];
    const params = notice?.params;
    if (
      notice?.method === "error" &&
      notice.id === undefined &&
      params?.threadId === terminal.threadId &&
      params?.turnId === terminal.turn.id &&
      typeof params.willRetry === "boolean"
    ) {
      summary.errorNotifications.push({
        willRetry: params.willRetry,
        error: summarizeTurnError(params.error),
      });
    }
  }
  return summary;
}

export async function observeConnectedOperation(operation, action, nativeTurnResult) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && operations.has(operation) && !failedOperations.has(error)) {
      failedOperations.set(error, {
        operation,
        nativeTurnResult: operation === "gateway-turn-verification" ? nativeTurnResult : undefined,
      });
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
    /^ +at [^\n]*[/\\](agent-openshell-static-egress-k3d-real\.test|egress-(?:connected-inputs|controller-upgrade|custody-observations|installed-(?:agent|resource-cleanup|stack)|managed-workload-exec|supplier-custody-transitions|supervisor-reconnect)|openshell-kubernetes-real)\.mjs:(\d{1,5}):(\d{1,4})(?:\))?$/m,
  );
  const location = frame ? `${frame[1]}.mjs:${frame[2]}:${frame[3]}` : "external-operation";
  const kind = error?.code === "ERR_ASSERTION" ? "assertion" : "operation";
  const { operation = null, nativeTurnResult } = failedOperations.get(error) ?? {};
  const local = kubectlOutcomes.get(error);
  const kubectl = local?.kubectl ?? null;
  const nativeExec = operation === "gateway-codex-exec" ? local?.nativeExec : undefined;
  if (operation !== null || kubectl !== null) {
    try {
      await recordFailure?.({
        kind,
        operation,
        kubectl,
        ...(nativeExec && { nativeExec }),
        ...(nativeTurnResult && { nativeTurnResult }),
      });
    } catch {
      // A diagnostic write must not replace the triggering failure or interrupt cleanup.
    }
  }
  const step = operation === null ? "" : ` / ${operation}`;
  const process = kubectl === null ? "" : ` kubectl=${JSON.stringify(kubectl)}`;
  const native = nativeExec === undefined ? "" : ` nativeExec=${JSON.stringify(nativeExec)}`;
  const turn = nativeTurnResult ? ` nativeTurnResult=${JSON.stringify(nativeTurnResult)}` : "";
  return new Error(
    `Connected egress ${kind} failed at ${stage}${step} (${location})${process}${native}${turn}; inspect the per-run ledger`,
  );
}
