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
const custodyOutcomes = new WeakMap();
const custodyContexts = new WeakMap();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const custodyRequestId = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const containerIdentity = /^[a-z0-9]+:\/\/[a-f0-9]{64}$/;
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

// Counters remain safe for terminal output. Validated correlation IDs are kept
// separately for the private ledger, never copied from rejected tracing fields.
export function rememberCustodyOutcome(error, value) {
  if (!(error instanceof Error)) {
    return error;
  }
  const count = (number) =>
    Number.isSafeInteger(number) && number >= 0 && number <= 2000 ? number : null;
  const choice = (value, allowed) => (allowed.includes(value) ? value : "unknown");
  const labels = new Set([
    "resolve_accepted",
    "resolve_no_material_accepted",
    "resolve_refused",
    "permit_accepted",
    "permit_no_material_accepted",
    "no_permit",
    "response_released",
    "response_blocked",
    "response_delivery_incomplete",
  ]);
  const input = value.evidence;
  const evidence =
    input &&
    uuid.test(input.sandboxId) &&
    uuid.test(input.supervisorUid) &&
    containerIdentity.test(input.containerId)
      ? {
          sandboxId: input.sandboxId,
          supervisorUid: input.supervisorUid,
          containerId: input.containerId,
          identityCheck: choice(input.identityCheck, [
            "unobserved",
            "pending",
            "matched",
            "failed",
          ]),
          expected: input.expected.filter((event) => labels.has(event)).slice(0, 9),
          events: input.events
            .slice(0, 9)
            .filter(
              (entry) =>
                typeof entry.requestId === "string" &&
                custodyRequestId.test(entry.requestId) &&
                labels.has(entry.event),
            )
            .map(({ requestId, event }) => ({ requestId, event })),
          truncated: input.truncated === true,
          uniqueRequest: input.uniqueRequest === true,
          singleRequest: input.singleRequest === true,
          ordered: input.ordered === true,
        }
      : undefined;
  custodyOutcomes.set(error, {
    evidence,
    readAttempts: count(value.readAttempts),
    successfulReads: count(value.successfulReads),
    lastRead: choice(value.lastRead, ["unobserved", "pending", "returned", "deadline", "error"]),
    ring: choice(value.ring, [
      "unobserved",
      "valid",
      "incomplete",
      "prefix-disappeared",
      "prefix-changed",
      "foreign-sandbox",
      "invalid-transition",
    ]),
    lineCount: count(value.lineCount),
    bufferTotal: count(value.bufferTotal),
    freshCount: count(value.freshCount),
    labels: value.labels.filter((label) => labels.has(label)).slice(0, 9),
    sequence: choice(value.sequence, ["unobserved", "none", "partial", "complete", "invalid"]),
  });
  return error;
}

// This context is owned by the turn caller. Session observations are independent
// of custody request IDs: temporal proximity does not bind a request to a session.
export function rememberCustodyContext(error, phase, sessions) {
  if (error instanceof Error && /^[a-z][a-z0-9-]{0,79}$/.test(phase)) {
    const time = (value) =>
      typeof value === "string" &&
      value.length <= 35 &&
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) &&
      Number.isFinite(Date.parse(value))
        ? value
        : null;
    const gateways = (Array.isArray(sessions?.gateways) ? sessions.gateways : [])
      .slice(0, 9)
      .filter((entry) => uuid.test(entry?.podUid) && containerIdentity.test(entry?.containerId))
      .map((entry) => ({
        podUid: entry.podUid,
        containerId: entry.containerId,
        outcome: entry.outcome === "observed" ? "observed" : "unavailable",
        stage: ["identity-before", "logs", "identity-after", "parse"].includes(entry.stage)
          ? entry.stage
          : null,
        total:
          Number.isSafeInteger(entry.total) && entry.total >= 0 && entry.total <= 2000
            ? entry.total
            : null,
        truncated: entry.truncated === true,
        events: (Array.isArray(entry.events) ? entry.events : [])
          .slice(0, 9)
          .filter(
            (event) =>
              uuid.test(event?.sessionId) &&
              time(event?.at) &&
              ["accepted", "inbound_eof", "gateway_closed", "ended"].includes(event?.event),
          )
          .map((event) => ({
            sessionId: event.sessionId,
            at: time(event.at),
            event: event.event,
            ...(typeof event.epoch === "string" &&
            /^[1-9]\d{0,19}$/.test(event.epoch) &&
            BigInt(event.epoch) <= 18446744073709551615n
              ? { epoch: event.epoch }
              : {}),
          })),
      }));
    custodyContexts.set(error, {
      turnPhase: phase,
      sessions: {
        outcome: ["observed", "timeout", "unavailable"].includes(sessions?.outcome)
          ? sessions.outcome
          : "unavailable",
        since: time(sessions?.since),
        requestSessionCorrelation: "unavailable",
        truncated: sessions?.truncated === true,
        gateways,
      },
    });
  }
  return error;
}

// The test owns stage through its checkpoints. Error payloads cannot choose it.
export async function safeConnectedFailure(error, stage, recordFailure) {
  // Only fixed source names and bounded V8 coordinates can reach the reporter.
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  // V8 prefixes the frames with the complete Error string, including message
  // newlines. That untrusted prefix cannot choose a source location.
  const headers = error instanceof Error ? [Error.prototype.toString.call(error)] : [];
  if (error instanceof Error && typeof error.code === "string") {
    headers.push(`${error.name} [${error.code}]: ${error.message}`);
  }
  const header = headers.find((value) => stack.startsWith(value + "\n"));
  const frames = header === undefined ? "" : stack.slice(header.length + 1);
  const frame = frames.match(
    /^ +at [^\n]*[/\\]((?:agent-openshell-static-egress-k3d-real\.test|egress-(?:connected-inputs|controller-upgrade|custody-observations|installed-(?:agent|resource-cleanup|stack)|managed-workload-exec|supplier-custody-transitions|supervisor-reconnect)|openshell-kubernetes-real)\.mjs|egress-supervisor-sessions\.ts):(\d{1,5}):(\d{1,4})(?:\))?$/m,
  );
  const location = frame ? `${frame[1]}:${frame[2]}:${frame[3]}` : "external-operation";
  const kind = error?.code === "ERR_ASSERTION" ? "assertion" : "operation";
  const { operation = null, nativeTurnResult } = failedOperations.get(error) ?? {};
  const local = kubectlOutcomes.get(error);
  const kubectl = local?.kubectl ?? null;
  const observedCustody = custodyOutcomes.get(error);
  const { evidence: custodyEvidence, ...custodySummary } = observedCustody ?? {};
  const custody = observedCustody ? custodySummary : undefined;
  const custodyContext = custodyContexts.get(error);
  const nativeExec = operation === "gateway-codex-exec" ? local?.nativeExec : undefined;
  if (operation !== null || kubectl !== null) {
    try {
      await recordFailure?.({
        kind,
        operation,
        kubectl,
        ...(nativeExec && { nativeExec }),
        ...(custody && { custody }),
        ...(custodyEvidence && { custodyEvidence }),
        ...(custodyContext && { custodyContext }),
        ...(nativeTurnResult && { nativeTurnResult }),
      });
    } catch {
      // A diagnostic write must not replace the triggering failure or interrupt cleanup.
    }
  }
  const step = operation === null ? "" : ` / ${operation}`;
  const process = kubectl === null ? "" : ` kubectl=${JSON.stringify(kubectl)}`;
  const native = nativeExec === undefined ? "" : ` nativeExec=${JSON.stringify(nativeExec)}`;
  const observed = custody ? ` custody=${JSON.stringify(custody)}` : "";
  const turn = nativeTurnResult ? ` nativeTurnResult=${JSON.stringify(nativeTurnResult)}` : "";
  return new Error(
    `Connected egress ${kind} failed at ${stage}${step} (${location})${process}${native}${turn}${observed}; inspect the per-run ledger`,
  );
}
