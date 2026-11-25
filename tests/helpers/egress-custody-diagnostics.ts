import { isArray, isBoundedInteger, isChoice, record } from "./egress-observation-values.ts";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const custodyRequestId = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const containerIdentity = /^[a-z0-9]+:\/\/[a-f0-9]{64}$/;
// Counters remain safe for terminal output. Validated correlation IDs are kept
// separately for the private ledger, never copied from rejected tracing fields.
type CustodyInput = {
  evidence?: {
    sandboxId: string;
    supervisorUid: string;
    containerId: string;
    identityCheck: unknown;
    expected: readonly unknown[];
    events: readonly { requestId: unknown; event: unknown }[];
    truncated: unknown;
    uniqueRequest: unknown;
    singleRequest: unknown;
    ordered: unknown;
  } | null;
  readAttempts: unknown;
  successfulReads: unknown;
  lastRead: unknown;
  ring: unknown;
  lineCount: unknown;
  bufferTotal: unknown;
  freshCount: unknown;
  labels: readonly unknown[];
  sequence: unknown;
};

export function summarizeCustodyOutcome(value: CustodyInput) {
  const count = (value: unknown) => (isBoundedInteger(value, 2000) ? value : null);
  const choice = <Value extends string>(value: unknown, allowed: readonly Value[]) =>
    isChoice(allowed, value) ? value : ("unknown" as const);
  const labels = [
    "resolve_accepted",
    "resolve_no_material_accepted",
    "resolve_refused",
    "permit_accepted",
    "permit_no_material_accepted",
    "no_permit",
    "response_released",
    "response_blocked",
    "response_delivery_incomplete",
  ] as const;
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
          expected: input.expected
            .filter((event): event is (typeof labels)[number] => isChoice(labels, event))
            .slice(0, 9),
          events: input.events
            .slice(0, 9)
            .filter(
              (entry): entry is { requestId: string; event: (typeof labels)[number] } =>
                typeof entry.requestId === "string" &&
                custodyRequestId.test(entry.requestId) &&
                isChoice(labels, entry.event),
            )
            .map(({ requestId, event }) => ({ requestId, event })),
          truncated: input.truncated === true,
          uniqueRequest: input.uniqueRequest === true,
          singleRequest: input.singleRequest === true,
          ordered: input.ordered === true,
        }
      : undefined;
  return {
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
    labels: value.labels
      .filter((label): label is (typeof labels)[number] => isChoice(labels, label))
      .slice(0, 9),
    sequence: choice(value.sequence, ["unobserved", "none", "partial", "complete", "invalid"]),
  };
}

// This context is owned by the turn caller. Session observations are independent
// of custody request IDs: temporal proximity does not bind a request to a session.
export function summarizeCustodyContext(phase: string, rawSessions: unknown) {
  if (/^[a-z][a-z0-9-]{0,79}$/.test(phase)) {
    const sessions = record(rawSessions);
    const time = (value: unknown) =>
      typeof value === "string" &&
      value.length <= 35 &&
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) &&
      Number.isFinite(Date.parse(value))
        ? value
        : null;
    const rawGateways: unknown[] = isArray(sessions.gateways) ? sessions.gateways : [];
    const gateways = rawGateways
      .slice(0, 9)
      .map(record)
      .filter(
        (entry): entry is Record<string, unknown> & { podUid: string; containerId: string } =>
          typeof entry.podUid === "string" &&
          uuid.test(entry.podUid) &&
          typeof entry.containerId === "string" &&
          containerIdentity.test(entry.containerId),
      )
      .map((entry) => {
        const events: unknown[] = isArray(entry.events) ? entry.events : [];
        return {
          podUid: entry.podUid,
          containerId: entry.containerId,
          outcome: entry.outcome === "observed" ? "observed" : "unavailable",
          stage: isChoice(
            ["identity-before", "logs", "identity-after", "parse"] as const,
            entry.stage,
          )
            ? entry.stage
            : null,
          total: isBoundedInteger(entry.total, 2000) ? entry.total : null,
          truncated: entry.truncated === true,
          events: events
            .slice(0, 9)
            .map(record)
            .flatMap((event) => {
              const at = time(event.at);
              if (
                typeof event.sessionId !== "string" ||
                !uuid.test(event.sessionId) ||
                at === null ||
                !isChoice(
                  ["accepted", "inbound_eof", "gateway_closed", "ended"] as const,
                  event.event,
                )
              ) {
                return [];
              }
              return [
                {
                  sessionId: event.sessionId,
                  at,
                  event: event.event,
                  ...(typeof event.epoch === "string" &&
                  /^[1-9]\d{0,19}$/.test(event.epoch) &&
                  BigInt(event.epoch) <= 18446744073709551615n
                    ? { epoch: event.epoch }
                    : {}),
                },
              ];
            }),
        };
      });
    return {
      turnPhase: phase,
      sessions: {
        outcome: isChoice(["observed", "timeout", "unavailable"] as const, sessions.outcome)
          ? sessions.outcome
          : "unavailable",
        since: time(sessions?.since),
        requestSessionCorrelation: "unavailable" as const,
        truncated: sessions?.truncated === true,
        gateways,
      },
    };
  }
}
