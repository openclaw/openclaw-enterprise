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
const model = {
  ...turn,
  modelCallId: reference,
  model: reference,
  provider: reference,
};
const outcome = Type.Enum(["succeeded", "failed", "cancelled", "unknown"]);

function runtimeEvent<const Action extends string, Fields extends TProperties>(
  action: Action,
  fields: Fields,
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
    closed,
  );
  const details = Type.Object(
    { agentRevisionId: RevisionId, runtimeSource: source, ...fields },
    closed,
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

const schemas = [
  runtimeEvent("openclaw.runtime.session.started", session),
  runtimeEvent("openclaw.runtime.session.ended", session),
  runtimeEvent("openclaw.runtime.turn.admitted", turn),
  runtimeEvent("openclaw.runtime.turn.started", turn),
  runtimeEvent("openclaw.runtime.turn.completed", {
    ...turn,
    outcome: Type.Union([outcome, Type.Literal("blocked")]),
  }),
  runtimeEvent("openclaw.runtime.model_call.started", model),
  runtimeEvent("openclaw.runtime.model_call.completed", { ...model, outcome }),
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
