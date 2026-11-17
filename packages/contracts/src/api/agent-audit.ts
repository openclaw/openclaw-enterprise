import { Type } from "typebox";
import { Check } from "typebox/value";

import {
  RUNTIME_AUDIT_ACTIONS,
  RUNTIME_AUDIT_DETAIL_SCHEMAS,
  type RuntimeAuditAction,
} from "../runtime-audit.ts";
import { AuditId, Meta, RequestId, Timestamp } from "./common.ts";

export const AGENT_AUDIT_PAGE_LIMIT = 100;
export const AGENT_AUDIT_PROJECTION_VERSION = 2;

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

const auditEntryFields = {
  id: AuditId,
  occurredAt: Type.String({
    format: "date-time",
    pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$",
  }),
  outcome: Type.Union([Type.Literal("success"), Type.Literal("denied"), Type.Literal("failure")]),
  actorId: Type.Optional(Type.String({ pattern: "^(prn|spn)_[a-f0-9-]{36}$" })),
  requestId: Type.Optional(RequestId),
};

const ControlPlaneAgentAuditEntry = Type.Object(
  {
    ...auditEntryFields,
    event: Type.Union([
      Type.Literal("api_request"),
      Type.Literal("work_queued"),
      Type.Literal("work_claimed"),
      Type.Literal("work_deferred"),
      Type.Literal("work_completed"),
      Type.Literal("work_result"),
    ]),
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

function runtimeAgentAuditEntry<Action extends RuntimeAuditAction>(action: Action) {
  return Type.Object(
    {
      ...auditEntryFields,
      event: Type.Literal("runtime_activity"),
      action: Type.Literal(action),
      details: RUNTIME_AUDIT_DETAIL_SCHEMAS[action],
    },
    { additionalProperties: false },
  );
}

const RuntimeAgentAuditEntry = Type.Union(
  Object.values(RUNTIME_AUDIT_ACTIONS).map(runtimeAgentAuditEntry),
);
const AgentAuditEntry = Type.Union([ControlPlaneAgentAuditEntry, RuntimeAgentAuditEntry]);

type ControlPlaneAgentAuditEntry = Type.Static<typeof ControlPlaneAgentAuditEntry>;
type RuntimeAgentAuditDetails = {
  [Action in RuntimeAuditAction]: {
    event: "runtime_activity";
    action: Action;
    details: Type.Static<(typeof RUNTIME_AUDIT_DETAIL_SCHEMAS)[Action]>;
  };
}[RuntimeAuditAction];

export function projectRuntimeAgentAuditDetails(
  action: unknown,
  details: unknown,
): RuntimeAgentAuditDetails | undefined {
  if (
    typeof action !== "string" ||
    !Object.hasOwn(RUNTIME_AUDIT_DETAIL_SCHEMAS, action) ||
    details === null ||
    typeof details !== "object" ||
    Array.isArray(details)
  ) {
    return undefined;
  }
  const runtimeAction = action as RuntimeAuditAction;
  const schema = RUNTIME_AUDIT_DETAIL_SCHEMAS[runtimeAction];
  const projected = Object.fromEntries(
    Object.entries(details).filter(([field]) => Object.hasOwn(schema.properties, field)),
  );
  return Check(schema, projected)
    ? ({
        event: "runtime_activity",
        action: runtimeAction,
        details: projected,
      } as RuntimeAgentAuditDetails)
    : undefined;
}

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

export type AgentAuditEntry =
  | ControlPlaneAgentAuditEntry
  | (Omit<
      ControlPlaneAgentAuditEntry,
      "event" | "operationId" | "workId" | "attemptId" | "workState"
    > &
      RuntimeAgentAuditDetails & {
        operationId?: never;
        workId?: never;
        attemptId?: never;
        workState?: never;
      });
export type AgentAuditPage = Omit<Type.Static<typeof AgentAuditPage>, "events"> & {
  events: AgentAuditEntry[];
};
export type AgentAuditQuery = Type.Static<typeof AgentAuditQuery>;
