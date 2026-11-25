import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";

import { RevisionId } from "./api/common.ts";

const source = Type.Enum(["openclaw", "codex"]);
const reference = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\s\\x00-\\x1f\\x7f-\\x9f]+$",
});
const session = { sessionId: reference, nativeSessionId: Type.Optional(reference) };
const turn = {
  sessionId: reference,
  turnId: reference,
  messageId: Type.Optional(reference),
};
export const RUNTIME_AUDIT_MESSAGE_LINK_VALUES = [
  "linked",
  "unknown",
  "input_hidden",
  "input_blocked",
  "steering_input",
  "internal_input",
  "multiple_inputs",
  "invalid_reference",
] as const;
const messageLink = Type.Enum(RUNTIME_AUDIT_MESSAGE_LINK_VALUES);
const model = {
  ...turn,
  modelCallId: reference,
  model: reference,
  provider: reference,
};
const outcome = Type.Enum(["succeeded", "failed", "cancelled", "unknown"]);
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });

function runtimeEvent<const Action extends string, Fields extends TProperties>(
  action: Action,
  fields: Fields,
  constraints: Record<string, unknown> = {},
) {
  const closed = { additionalProperties: false };
  const observation = Type.Object(
    {
      action: Type.Literal(action),
      eventId: Type.String({
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      }),
      occurredAt: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
      ...fields,
    },
    { ...closed, ...constraints },
  );
  const details = Type.Object(
    { agentRevisionId: RevisionId, runtimeSource: source, ...fields },
    { ...closed, ...constraints },
  );
  const projection = Type.Object(
    {
      event: Type.Literal("runtime_activity"),
      action: Type.Literal(action),
      details,
    },
    closed,
  );
  return {
    action,
    observation,
    projection,
    pageEntry<Common extends TProperties>(common: Common) {
      return Type.Object({ ...common, ...projection.properties }, closed);
    },
  };
}

function turnSchemas<Fields extends TProperties>(fields: Fields) {
  const constraints = {
    if: { type: "object", properties: { messageLink: { const: "linked" } } },
    then: { type: "object", required: ["messageId"] },
    else: { not: { type: "object", required: ["messageId"] } },
  };
  return [
    runtimeEvent("openclaw.runtime.turn.started", fields, constraints),
    runtimeEvent(
      "openclaw.runtime.turn.completed",
      { ...fields, outcome: Type.Union([outcome, Type.Literal("blocked")]) },
      constraints,
    ),
  ] as const;
}

export function linkedTurnEntry<Common extends TProperties>(common: Common) {
  const linked = turnSchemas({
    ...turn,
    messageId: reference,
    messageLink: Type.Literal("linked"),
  });
  return schemaUnion(linked.map((schema) => schema.pageEntry(common)));
}

const schemas = [
  runtimeEvent("openclaw.runtime.session.started", session),
  runtimeEvent("openclaw.runtime.session.ended", session),
  ...turnSchemas({ ...turn, messageLink }),
  runtimeEvent("openclaw.runtime.model_call.started", model),
  runtimeEvent("openclaw.runtime.model_call.completed", { ...model, outcome }),
  runtimeEvent(
    "openclaw.runtime.model_attempt.observed",
    {
      sessionId: reference,
      turnId: reference,
      model: reference,
      provider: reference,
      modelCallId: reference,
      modelAttemptId: digest,
      attempt: Type.Integer({ minimum: 1, maximum: 1000 }),
      httpStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
      failureCode: Type.Optional(Type.Literal("TRANSPORT_ERROR")),
    },
    {
      oneOf: [
        { type: "object", required: ["httpStatus"] },
        { type: "object", required: ["failureCode"] },
      ],
    },
  ),
  runtimeEvent("openclaw.runtime.model_response.observed", {
    ...turn,
    model: reference,
    provider: reference,
    responseIdHash: Type.String({ pattern: "^sha256:[0-9a-f]{16}$" }),
  }),
  runtimeEvent("openclaw.runtime.model_error.observed", {
    sessionId: reference,
    turnId: reference,
    model: reference,
    provider: reference,
    errorCode: Type.Optional(Type.String({ pattern: "^[45][0-9]{2}$" })),
  }),
];

// TypeBox infers unions from tuples. Preserve the union of the individual
// schemas when the variants come from a mapped array.
function schemaUnion<Schema extends TSchema>(variants: Schema[]) {
  return Type.Unsafe<Static<Schema>>(Type.Union(variants));
}

export const RUNTIME_AUDIT_ACTIONS = Object.freeze(schemas.map((schema) => schema.action));
export const RuntimeAuditObservationSchema = schemaUnion(
  schemas.map((schema) => schema.observation),
);
export type RuntimeAuditObservation = Static<typeof RuntimeAuditObservationSchema>;
export type RuntimeAuditSource = Static<typeof source>;

export function runtimeAuditPageEntry<Common extends TProperties>(common: Common) {
  return schemaUnion(schemas.map((schema) => schema.pageEntry(common)));
}

export function projectRuntimeAgentAuditDetails(action: unknown, details: unknown) {
  const schema = schemas.find((item) => item.action === action);
  if (
    schema === undefined ||
    details === null ||
    typeof details !== "object" ||
    Array.isArray(details)
  ) {
    return undefined;
  }
  const fields = schema.projection.properties.details.properties;
  const projection = {
    event: "runtime_activity",
    action,
    details: Object.fromEntries(
      Object.entries(details).filter(([key]) => Object.hasOwn(fields, key)),
    ),
  };
  return Check(schema.projection, projection) ? projection : undefined;
}
