import { Type } from "typebox";

import { AuditId, Meta, RequestId, Timestamp } from "./common.ts";

export const AGENT_AUDIT_PAGE_LIMIT = 100;
export const AGENT_AUDIT_PROJECTION_VERSION = 1;

const AgentAuditCursor = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: "^[A-Za-z0-9_-]+$",
  description: "Continuation from the preceding page for the same Agent and session.",
});
export const AgentAuditQuery = Type.Object(
  {
    limit: Type.Optional(
      Type.String({
        pattern: "^(?:[1-9][0-9]?|100)$",
        description: "Number of records per page, from 1 to 100. The default is 50.",
      }),
    ),
    cursor: Type.Optional(AgentAuditCursor),
  },
  { additionalProperties: false },
);

const AgentAuditEntry = Type.Object(
  {
    id: AuditId,
    occurredAt: Type.String({
      format: "date-time",
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$",
    }),
    event: Type.Union([
      Type.Literal("api_request"),
      Type.Literal("work_queued"),
      Type.Literal("work_claimed"),
      Type.Literal("work_deferred"),
      Type.Literal("work_completed"),
      Type.Literal("work_result"),
    ]),
    outcome: Type.Union([Type.Literal("success"), Type.Literal("denied"), Type.Literal("failure")]),
    actorId: Type.Optional(Type.String({ pattern: "^(prn|spn)_[a-f0-9-]{36}$" })),
    requestId: Type.Optional(RequestId),
    operationId: Type.Optional(Type.Literal("getAgent")),
    workId: Type.Optional(Type.String({ pattern: "^work_[0-9a-f]{64}$" })),
    attemptId: Type.Optional(AuditId),
    workState: Type.Optional(
      Type.Union([
        Type.Literal("queued"),
        Type.Literal("claimed"),
        Type.Literal("succeeded"),
        Type.Literal("failed_permanent"),
        Type.Literal("superseded"),
      ]),
    ),
  },
  { additionalProperties: false },
);
const AgentAuditPage = Type.Object(
  {
    projectionVersion: Type.Literal(AGENT_AUDIT_PROJECTION_VERSION),
    window: Type.Object({ start: Timestamp, end: Timestamp }, { additionalProperties: false }),
    events: Type.Array(AgentAuditEntry, { maxItems: AGENT_AUDIT_PAGE_LIMIT }),
    nextCursor: Type.Union([AgentAuditCursor, Type.Null()]),
  },
  { additionalProperties: false },
);
export const AgentAuditResponse = Type.Object(
  { data: AgentAuditPage, meta: Meta },
  { additionalProperties: false },
);

export type AgentAuditEntry = Type.Static<typeof AgentAuditEntry>;
export type AgentAuditPage = Type.Static<typeof AgentAuditPage>;
export type AgentAuditQuery = Type.Static<typeof AgentAuditQuery>;
