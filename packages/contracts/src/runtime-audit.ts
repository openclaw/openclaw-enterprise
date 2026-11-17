import { Type, type Static, type TProperties } from "typebox";

export const RUNTIME_AUDIT_ACTIONS = {
  sessionStarted: "openclaw.runtime.session.started",
  sessionEnded: "openclaw.runtime.session.ended",
  turnAdmitted: "openclaw.runtime.turn.admitted",
  turnStarted: "openclaw.runtime.turn.started",
  turnCompleted: "openclaw.runtime.turn.completed",
  modelCallStarted: "openclaw.runtime.model_call.started",
  modelCallCompleted: "openclaw.runtime.model_call.completed",
  toolCallRequested: "openclaw.runtime.tool_call.requested",
  toolCallCompleted: "openclaw.runtime.tool_call.completed",
  reviewDecision: "openclaw.runtime.review.decision",
  fileDecision: "openclaw.runtime.file.decision",
  networkDecision: "openclaw.runtime.network.decision",
} as const;

export type RuntimeAuditAction = (typeof RUNTIME_AUDIT_ACTIONS)[keyof typeof RUNTIME_AUDIT_ACTIONS];

const ref = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\s\\x00-\\x1f\\x7f-\\x9f]+$",
});
export const RUNTIME_AUDIT_REASON_LIMIT = 250;
const reason = Type.String({ minLength: 1, maxLength: RUNTIME_AUDIT_REASON_LIMIT });
const optionalReason = Type.Optional(reason);
const path = Type.String({ minLength: 1, maxLength: 1024 });
const source = Type.Union([
  Type.Literal("openclaw"),
  Type.Literal("codex"),
  Type.Literal("openshell"),
]);

const session = {
  sessionId: ref,
};
const sessionLifecycle = { ...session, nativeSessionId: Type.Optional(ref) };

const turn = {
  ...session,
  turnId: ref,
  messageId: Type.Optional(ref),
};

const execution = {
  sessionId: Type.Optional(ref),
  turnId: Type.Optional(ref),
  messageId: Type.Optional(ref),
};

const outcome = literals("succeeded", "failed", "cancelled", "unknown");
const tool = {
  ...turn,
  toolCallId: ref,
  toolName: ref,
};
const model = {
  ...execution,
  modelCallId: ref,
  model: ref,
  provider: ref,
};

function literals<const Value extends string>(...values: Value[]) {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

const observations = {
  [RUNTIME_AUDIT_ACTIONS.sessionStarted]: sessionLifecycle,
  [RUNTIME_AUDIT_ACTIONS.sessionEnded]: sessionLifecycle,
  [RUNTIME_AUDIT_ACTIONS.turnAdmitted]: turn,
  [RUNTIME_AUDIT_ACTIONS.turnStarted]: turn,
  [RUNTIME_AUDIT_ACTIONS.turnCompleted]: {
    ...turn,
    outcome: literals("succeeded", "failed", "cancelled", "blocked", "unknown"),
    blockedBy: Type.Optional(literals("auto_review", "file_policy", "network_policy")),
    reason: optionalReason,
  },
  [RUNTIME_AUDIT_ACTIONS.modelCallStarted]: model,
  [RUNTIME_AUDIT_ACTIONS.modelCallCompleted]: {
    ...model,
    outcome,
    reason: optionalReason,
  },
  [RUNTIME_AUDIT_ACTIONS.toolCallRequested]: tool,
  [RUNTIME_AUDIT_ACTIONS.toolCallCompleted]: {
    ...tool,
    outcome: literals("succeeded", "failed", "denied", "cancelled", "unknown"),
    reason: optionalReason,
  },
  [RUNTIME_AUDIT_ACTIONS.reviewDecision]: {
    ...execution,
    reviewId: Type.Optional(ref),
    toolCallId: Type.Optional(ref),
    decision: literals("allowed", "denied", "ask"),
    rationale: Type.Optional(Type.Union([reason, Type.Null()])),
  },
  [RUNTIME_AUDIT_ACTIONS.fileDecision]: {
    ...execution,
    toolCallId: Type.Optional(ref),
    toolName: ref,
    path,
    decision: literals("allowed", "denied"),
    reason: optionalReason,
  },
  [RUNTIME_AUDIT_ACTIONS.networkDecision]: {
    host: Type.Optional(ref),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    decision: Type.Literal("denied"),
    enforcement: Type.Literal("blocked"),
    reason: optionalReason,
  },
} as const;

const envelope = {
  eventId: Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  }),
  occurredAt: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
};

function detailSchema<Properties extends TProperties>(properties: Properties) {
  return Type.Object(
    { ...properties, agentRevisionId: ref, runtimeSource: source },
    { additionalProperties: false },
  );
}

export const RUNTIME_AUDIT_DETAIL_SCHEMAS = {
  [RUNTIME_AUDIT_ACTIONS.sessionStarted]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.sessionStarted],
  ),
  [RUNTIME_AUDIT_ACTIONS.sessionEnded]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.sessionEnded],
  ),
  [RUNTIME_AUDIT_ACTIONS.turnAdmitted]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.turnAdmitted],
  ),
  [RUNTIME_AUDIT_ACTIONS.turnStarted]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.turnStarted],
  ),
  [RUNTIME_AUDIT_ACTIONS.turnCompleted]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.turnCompleted],
  ),
  [RUNTIME_AUDIT_ACTIONS.modelCallStarted]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.modelCallStarted],
  ),
  [RUNTIME_AUDIT_ACTIONS.modelCallCompleted]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.modelCallCompleted],
  ),
  [RUNTIME_AUDIT_ACTIONS.toolCallRequested]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.toolCallRequested],
  ),
  [RUNTIME_AUDIT_ACTIONS.toolCallCompleted]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.toolCallCompleted],
  ),
  [RUNTIME_AUDIT_ACTIONS.reviewDecision]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.reviewDecision],
  ),
  [RUNTIME_AUDIT_ACTIONS.fileDecision]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.fileDecision],
  ),
  [RUNTIME_AUDIT_ACTIONS.networkDecision]: detailSchema(
    observations[RUNTIME_AUDIT_ACTIONS.networkDecision],
  ),
} as const;

type ObservationFor<Action extends RuntimeAuditAction> = {
  readonly action: Action;
  readonly eventId: string;
  readonly occurredAt: string;
} & Omit<
  Static<(typeof RUNTIME_AUDIT_DETAIL_SCHEMAS)[Action]>,
  "agentRevisionId" | "runtimeSource"
>;

export type RuntimeAuditObservation = {
  [Action in RuntimeAuditAction]: ObservationFor<Action>;
}[RuntimeAuditAction];

export function runtimeAuditObservationSchema(action: RuntimeAuditAction) {
  return Type.Object(
    { ...envelope, action: Type.Literal(action), ...observations[action] },
    { additionalProperties: false },
  );
}

export type RuntimeAuditSource = Static<typeof source>;
