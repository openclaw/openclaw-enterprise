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
const toolFields = {
  invocationId: reference,
  toolName: Type.String({ pattern: "^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}$" }),
};
const gatewayToolPolicy = Type.Enum([
  "tool_policy",
  "gateway_tool_audit",
  "exec_policy",
  "codex_guardian",
]);

function runtimeEvent<
  const Action extends string,
  Fields extends TProperties,
  Source extends TSchema = typeof source,
>(action: Action, fields: Fields, producer?: Source) {
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
    { agentRevisionId: RevisionId, runtimeSource: (producer ?? source) as Source, ...fields },
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

function turnSchemas<Fields extends TProperties>(fields: Fields) {
  return [
    runtimeEvent("openclaw.runtime.turn.started", fields),
    runtimeEvent("openclaw.runtime.turn.completed", {
      ...fields,
      outcome: Type.Union([outcome, Type.Literal("blocked")]),
    }),
  ] as const;
}

export function linkedTurnEntry<Common extends TProperties>(common: Common) {
  const linked = turnSchemas({ ...turn, messageId: reference });
  return schemaUnion(linked.map((schema) => schema.pageEntry(common)));
}

function toolSchemas<Fields extends TProperties, Policy extends TSchema>(
  tool: Fields,
  policy: Policy,
) {
  const approval = { ...tool, approvalId: reference };
  const attempt = { ...tool, attemptId: reference };
  return [
    runtimeEvent("openclaw.runtime.tool_call.requested", tool),
    runtimeEvent("openclaw.runtime.policy.decided", {
      ...tool,
      policy,
      decision: Type.Enum(["allow", "deny", "require_approval"]),
    }),
    runtimeEvent("openclaw.runtime.approval.requested", approval),
    runtimeEvent("openclaw.runtime.approval.resolved", {
      ...approval,
      decision: Type.Enum([
        "allow-once",
        "allow-always",
        "allow-session",
        "deny",
        "expired",
        "cancelled",
        "unavailable",
      ]),
    }),
    runtimeEvent("openclaw.runtime.tool_attempt.admitted", {
      ...attempt,
      approvalId: Type.Optional(reference),
    }),
    runtimeEvent("openclaw.runtime.tool_attempt.completed", {
      ...attempt,
      outcome: Type.Union([outcome, Type.Literal("blocked")]),
    }),
  ] as const;
}

const gatewaySchemas = [
  runtimeEvent("openclaw.runtime.session.started", session),
  runtimeEvent("openclaw.runtime.session.ended", session),
  ...turnSchemas(turn),
  runtimeEvent("openclaw.runtime.model_call.started", model),
  runtimeEvent("openclaw.runtime.model_call.completed", { ...model, outcome }),
  runtimeEvent("openclaw.runtime.model_response.observed", {
    ...turn,
    model: reference,
    provider: reference,
    responseIdHash: Type.String({ pattern: "^sha256:[0-9a-f]{16}$" }),
  }),
  ...toolSchemas(
    { ...turn, ...toolFields, boundary: Type.Enum(["gateway_hook", "runtime"]) },
    gatewayToolPolicy,
  ),
  ...toolSchemas(
    {
      ...toolFields,
      boundary: Type.Literal("managed_mcp"),
      sessionId: Type.Optional(reference),
      turnId: Type.Optional(reference),
    },
    Type.Literal("managed_mcp_policy"),
  ),
];

const network = runtimeEvent(
  "openclaw.runtime.policy.decided",
  {
    policy: Type.Literal("network_policy"),
    decision: Type.Enum(["allow", "deny"]),
    sandboxId: reference,
  },
  Type.Literal("openshell"),
);
const repository = runtimeEvent(
  "openclaw.runtime.policy.decided",
  {
    policy: Type.Literal("repository_send"),
    decision: Type.Literal("allow"),
    receiptId: reference,
    operationId: Type.Optional(reference),
  },
  Type.Literal("occ"),
);
const egress = runtimeEvent(
  "openclaw.runtime.policy.decided",
  {
    policy: Type.Literal("egress_send"),
    decision: Type.Literal("allow"),
    senderId: reference,
    senderGeneration: Type.Integer({ minimum: 1 }),
    instanceId: reference,
    useId: reference,
    attemptId: reference,
  },
  Type.Literal("occ"),
);
const schemas = [...gatewaySchemas, network, repository, egress];

// TypeBox infers unions from tuples. Preserve the union of the individual
// schemas when the variants come from a mapped array.
function schemaUnion<Schema extends TSchema>(variants: Schema[]) {
  return Type.Unsafe<Static<Schema>>(Type.Union(variants));
}

export const RUNTIME_AUDIT_ACTIONS = Object.freeze([
  ...new Set(schemas.map((schema) => schema.action)),
]);
export const RuntimeAuditObservationSchema = schemaUnion(
  gatewaySchemas.map((schema) => schema.observation),
);
export type RuntimeAuditObservation =
  Static<typeof RuntimeAuditObservationSchema> | Static<typeof network.observation>;
export type RuntimeAuditSource = Static<typeof source> | "openshell";

export function runtimeAuditPageEntry<Common extends TProperties>(common: Common) {
  return schemaUnion(schemas.map((schema) => schema.pageEntry(common)));
}

export function projectRuntimeAgentAuditDetails(action: unknown, details: unknown) {
  if (details === null || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  for (const schema of schemas) {
    if (schema.action !== action) {
      continue;
    }
    const fields = schema.projection.properties.details.properties;
    const projection = {
      event: "runtime_activity",
      action,
      details: Object.fromEntries(
        Object.entries(details).filter(([key]) => Object.hasOwn(fields, key)),
      ),
    };
    if (Check(schema.projection, projection)) {
      return projection;
    }
  }
  return undefined;
}
