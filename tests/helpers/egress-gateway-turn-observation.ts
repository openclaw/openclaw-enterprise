import {
  isArray,
  isBoundedInteger,
  isChoice,
  isRecord,
  record,
} from "./egress-observation-values.ts";

const turnStatuses = ["completed", "failed", "interrupted", "inProgress"] as const;
// Codex app-server v2 CodexErrorInfo. Forward-compatible extension keys and strings
// are admitted by the wire schema but must never reach a diagnostic.
const codexErrorCodes = [
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
] as const;
const codexHttpErrorCodes = [
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
] as const;

function summarizeTurnError(error: unknown) {
  if (error === undefined) {
    return { state: "absent" as const };
  }
  if (error === null) {
    return { state: "null" as const };
  }
  if (!isRecord(error) || typeof error.message !== "string") {
    return { state: "invalid" as const };
  }
  const info = error.codexErrorInfo;
  if (info === undefined) {
    return { state: "absent" as const };
  }
  if (info === null) {
    return { state: "null" as const };
  }
  if (typeof info === "string") {
    return isChoice(codexErrorCodes, info)
      ? { state: "known" as const, variant: info }
      : { state: "unknown" as const };
  }
  if (!isRecord(info) || Object.keys(info).length !== 1) {
    return { state: "invalid" as const };
  }
  const variant = Object.keys(info)[0] ?? "";
  const payload = info[variant];
  if (variant === "activeTurnNotSteerable") {
    const { turnKind } = record(payload);
    return isRecord(payload) && isChoice(["review", "compact"] as const, turnKind)
      ? { state: "known" as const, variant, turnKind }
      : { state: "invalid" as const };
  }
  if (!isChoice(codexHttpErrorCodes, variant)) {
    return { state: "unknown" as const };
  }
  if (!isRecord(payload)) {
    return { state: "invalid" as const };
  }
  const code = payload.httpStatusCode;
  let httpStatus: { state: "invalid" | "absent" | "null" } | { state: "present"; code: number } = {
    state: "invalid" as const,
  };
  if (!Object.hasOwn(payload, "httpStatusCode")) {
    httpStatus = { state: "absent" as const };
  } else if (code === null) {
    httpStatus = { state: "null" as const };
  } else if (isBoundedInteger(code, 65_535)) {
    // Preserve the wire uint16. Its value alone does not establish a response origin.
    httpStatus = { state: "present", code };
  }
  return { state: "known" as const, variant, httpStatus };
}

type TurnStatus = (typeof turnStatuses)[number] | "unknown";
type TurnError = ReturnType<typeof summarizeTurnError>;
export type GatewayTurnSummary = {
  expectedStatus: TurnStatus;
  actualStatus: TurnStatus;
  lastAcknowledged: "turn/start" | null;
  terminalEvent: "turn/completed" | null;
  terminalError: TurnError | null;
  errorNotifications: { willRetry: boolean; error: TurnError }[];
};

export function summarizeGatewayTurnResult(
  expected: unknown,
  rawResult: unknown,
): GatewayTurnSummary {
  const result = record(rawResult);
  const expectedStatus = isChoice(turnStatuses, expected) ? expected : "unknown";
  const actualStatus = isChoice(turnStatuses, result.status) ? result.status : "unknown";
  const summary: GatewayTurnSummary = {
    expectedStatus,
    actualStatus,
    lastAcknowledged: null,
    terminalEvent: null,
    terminalError: null,
    errorNotifications: [],
  };
  const observation = record(result.terminalObservation);
  if (observation?.lastAcknowledged !== "turn/start" || !isArray(result.items)) {
    return summary;
  }
  const { terminalEventIndex, errorEventIndexes } = observation;
  if (!isBoundedInteger(terminalEventIndex, Number.MAX_SAFE_INTEGER)) {
    return summary;
  }
  const items: unknown[] = result.items;
  const event = record(items[terminalEventIndex]);
  const terminal = record(event.params);
  const turn = record(terminal.turn);
  if (
    event?.method !== "turn/completed" ||
    event.id !== undefined ||
    typeof terminal?.threadId !== "string" ||
    !terminal.threadId ||
    typeof turn.id !== "string" ||
    !turn.id ||
    actualStatus === "unknown" ||
    turn.status !== actualStatus
  ) {
    return summary;
  }
  summary.lastAcknowledged = "turn/start";
  summary.terminalEvent = "turn/completed";
  summary.terminalError = summarizeTurnError(turn.error);
  if (!isArray(errorEventIndexes) || errorEventIndexes.length > 4) {
    return summary;
  }
  const indexes: unknown[] = errorEventIndexes;
  for (const index of indexes) {
    if (!isBoundedInteger(index, terminalEventIndex - 1)) {
      continue;
    }
    const notice = record(items[index]);
    const params = record(notice.params);
    if (
      notice?.method === "error" &&
      notice.id === undefined &&
      params?.threadId === terminal.threadId &&
      params?.turnId === turn.id &&
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
