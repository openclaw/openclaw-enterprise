import { Type } from "typebox";

import { AgentParams, Meta } from "./common.ts";

const name = Type.String({ minLength: 1, maxLength: 200 });
const prompt = Type.String({ minLength: 1, maxLength: 16_384 });
const revision = Type.String({ minLength: 1, maxLength: 128 });
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
      tz: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false },
  ),
]);

export const AgentAutomationParams = Type.Object(
  { ...AgentParams.properties, automationId: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);
export const CreateAgentAutomationBody = Type.Object(
  { name, enabled: Type.Boolean(), schedule, prompt },
  { additionalProperties: false },
);
export const UpdateAgentAutomationBody = Type.Object(
  {
    expectedConfigRevision: revision,
    name: Type.Optional(name),
    enabled: Type.Optional(Type.Boolean()),
    schedule: Type.Optional(schedule),
    prompt: Type.Optional(prompt),
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
/** OpenClaw owns the normalized job and page representations. */
export const AgentAutomationResponse = Type.Object(
  { data: Type.Record(Type.String(), Type.Unknown()), meta: Meta },
  { additionalProperties: false },
);
