import { Type } from "typebox";
import { Check } from "typebox/value";

import { linkedTurnEntry, runtimeAuditPageEntry } from "../runtime-audit.ts";
import { AuditId, Meta, RequestId, RevisionId, Timestamp } from "./common.ts";

export const AGENT_AUDIT_PAGE_LIMIT = 100;
export const AGENT_AUDIT_PROJECTION_VERSION = 3;

export const AGENT_LIFECYCLE_AUDIT_ACTIONS = {
  agent: [
    "openclaw.agents.create",
    "openclaw.agents.update",
    "openclaw.agents.stop",
    "openclaw.agents.lifecycle.stop",
    "openclaw.agents.provision.checkpoint",
  ],
  revision: [
    "openclaw.agents.deploy",
    "openclaw.agents.lifecycle.activate",
    "openclaw.agents.lifecycle.supersede",
  ],
  provisioningFailure: "openclaw.agents.provision.failure",
} as const;

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

const AgentLifecycleAuditDetails = Type.Object(
  {
    event: Type.Literal("agent_lifecycle"),
    action: Type.Enum([
      ...AGENT_LIFECYCLE_AUDIT_ACTIONS.agent,
      ...AGENT_LIFECYCLE_AUDIT_ACTIONS.revision,
      AGENT_LIFECYCLE_AUDIT_ACTIONS.provisioningFailure,
    ]),
    agentRevisionId: Type.Optional(RevisionId),
    provisioningPhase: Type.Optional(
      Type.Union([
        Type.Literal("admitted"),
        Type.Literal("configuration"),
        Type.Literal("transport"),
        Type.Literal("handoff"),
      ]),
    ),
  },
  { additionalProperties: false },
);

const AgentLifecycleAuditEntry = Type.Object(
  { ...auditEntryFields, ...AgentLifecycleAuditDetails.properties },
  { additionalProperties: false },
);

export function projectAgentLifecycleAuditDetails(
  action: unknown,
  agentRevisionId: unknown,
  provisioningPhase: unknown,
): Type.Static<typeof AgentLifecycleAuditDetails> | undefined {
  const projected = {
    event: "agent_lifecycle",
    action,
    ...(agentRevisionId === null ? {} : { agentRevisionId }),
    ...(provisioningPhase === null ? {} : { provisioningPhase }),
  };
  return Check(AgentLifecycleAuditDetails, projected) ? projected : undefined;
}

const AgentAuditEntry = Type.Union([
  ControlPlaneAgentAuditEntry,
  AgentLifecycleAuditEntry,
  runtimeAuditPageEntry(auditEntryFields),
]);

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

const AgentAuditLinkedTurn = linkedTurnEntry(auditEntryFields);
export type AgentAuditLinkedTurn = Type.Static<typeof AgentAuditLinkedTurn>;

export function isAgentAuditLinkedTurn(entry: AgentAuditEntry): entry is AgentAuditLinkedTurn {
  return Check(AgentAuditLinkedTurn, entry);
}

export const AGENT_AUDIT_MESSAGE_BYTES = 64 * 1024;
const AgentAuditMessage = Type.Object(
  { role: Type.Literal("user"), text: Type.String({ maxLength: AGENT_AUDIT_MESSAGE_BYTES }) },
  { additionalProperties: false },
);
export type AgentAuditMessage = Type.Static<typeof AgentAuditMessage>;
export const AgentAuditMessageResponse = Type.Object(
  {
    data: Type.Object(
      { event: AgentAuditLinkedTurn, message: AgentAuditMessage },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);
