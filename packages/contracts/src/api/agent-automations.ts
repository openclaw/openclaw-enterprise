import { Type } from "typebox";

import { AgentParams, Meta } from "./common.ts";

const revision = Type.String({ minLength: 1, maxLength: 128 });
const name = Type.String({ minLength: 1, maxLength: 200 });
const prompt = Type.String({ minLength: 1, maxLength: 16_384 });

// Native scheduling owns semantic validation and generated anchor/stagger fields.
const schedule = Type.Union([
  Type.Object(
    { kind: Type.Literal("at"), at: Type.String({ format: "date-time", maxLength: 64 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("every"),
      everyMs: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("cron"),
      expr: Type.String({ minLength: 1, maxLength: 256 }),
      tz: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
]);

export const AgentAutomationParams = Type.Object(
  {
    ...AgentParams.properties,
    automationId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
  },
  { additionalProperties: false },
);

export const CreateAgentAutomationBody = Type.Object(
  { name, enabled: Type.Boolean(), schedule, prompt },
  { additionalProperties: false },
);

export const UpdateAgentAutomationBody = Type.Object(
  {
    name: Type.Optional(name),
    enabled: Type.Optional(Type.Boolean()),
    schedule: Type.Optional(schedule),
    prompt: Type.Optional(prompt),
    expectedConfigRevision: revision,
  },
  { additionalProperties: false, minProperties: 2 },
);

export const DeleteAgentAutomationQuery = Type.Object(
  { expectedConfigRevision: revision },
  { additionalProperties: false },
);

export const AgentAutomationPageQuery = Type.Object(
  {
    offset: Type.Optional(Type.String({ pattern: "^(0|[1-9][0-9]{0,8})$" })),
    limit: Type.Optional(Type.String({ pattern: "^([1-9][0-9]?|100)$" })),
  },
  { additionalProperties: false },
);

const nativeSchedule = Type.Union([
  schedule.anyOf[0],
  Type.Object(
    {
      ...schedule.anyOf[1].properties,
      anchorMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...schedule.anyOf[2].properties,
      staggerMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    },
    { additionalProperties: false },
  ),
]);
const nullableTime = Type.Union([
  Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  Type.Null(),
]);
const runStatus = Type.Union([
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("skipped"),
  Type.Null(),
]);
export const AgentAutomationSchema = Type.Object(
  {
    id: AgentAutomationParams.properties.automationId,
    configRevision: revision,
    name,
    enabled: Type.Boolean(),
    schedule: nativeSchedule,
    prompt,
    nextRunAtMs: nullableTime,
    lastRunStatus: runStatus,
  },
  { additionalProperties: false },
);
export const AgentAutomationUnsupportedSummary = Type.Object(
  {
    id: AgentAutomationParams.properties.automationId,
    configRevision: revision,
    name,
    enabled: Type.Boolean(),
    scheduleKind: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
const summary = Type.Union([
  Type.Omit(AgentAutomationSchema, ["prompt"]),
  AgentAutomationUnsupportedSummary,
]);
export const AgentAutomationResponse = Type.Object(
  { data: AgentAutomationSchema, meta: Meta },
  { additionalProperties: false },
);
export const AgentAutomationListResponse = Type.Object(
  {
    data: Type.Object(
      {
        jobs: Type.Array(summary),
        total: Type.Integer({ minimum: 0 }),
        nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        snapshotRevision: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);
export const AgentAutomationRunsPageSchema = Type.Object(
  {
    runs: Type.Array(
      Type.Object(
        {
          runId: Type.String({ minLength: 1, maxLength: 200 }),
          startedAtMs: nullableTime,
          finishedAtMs: nullableTime,
          status: runStatus,
          completionStatus: Type.Union([
            Type.Literal("succeeded"),
            Type.Literal("failed"),
            Type.Literal("unknown"),
            Type.Null(),
          ]),
          deliveryStatus: Type.Union([
            Type.Literal("delivered"),
            Type.Literal("not-delivered"),
            Type.Literal("not-requested"),
            Type.Literal("unknown"),
            Type.Null(),
          ]),
          summary: Type.Optional(Type.String()),
          error: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    total: Type.Integer({ minimum: 0 }),
    nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export const AgentAutomationRunsResponse = Type.Object(
  { data: AgentAutomationRunsPageSchema, meta: Meta },
  { additionalProperties: false },
);
export type AgentAutomationCreateInput = Type.Static<typeof CreateAgentAutomationBody>;
export type AgentAutomationUpdateInput = Type.Static<typeof UpdateAgentAutomationBody>;
export type AgentAutomationData = Type.Static<typeof AgentAutomationSchema>;
export type AgentAutomationSummary = Type.Static<typeof summary>;
export type AgentAutomationRunsPage = Type.Static<typeof AgentAutomationRunsPageSchema>;
