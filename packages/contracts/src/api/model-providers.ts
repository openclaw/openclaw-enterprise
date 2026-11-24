import { Type } from "typebox";
import { ConnectionTemplateId, ModelProviderId, RequestId } from "./common.ts";

export const InferenceBaseUrlSchema = Type.String({
  maxLength: 2048,
  pattern: "^https://",
  description:
    "Exact HTTPS inference URL with a DNS hostname or private IPv4 address and a path ending in /v1.",
});
export const InferenceProtocolSchema = Type.Union([
  Type.Literal("openai-responses"),
  Type.Literal("openai-completions"),
]);
const strict = { additionalProperties: false };
const modelId = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\s\\x00-\\x1f\\x7f]+$" });
const nonnegative = Type.Number({ minimum: 0 });
export const ModelProviderModelSchema = Type.Object(
  {
    id: modelId,
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    cost: Type.Optional(
      Type.Object(
        {
          input: nonnegative,
          output: nonnegative,
          cacheRead: nonnegative,
          cacheWrite: nonnegative,
        },
        { ...strict, description: "Cost in USD per million tokens." },
      ),
    ),
  },
  { ...strict, $id: "ModelProviderModel", title: "Model offered by this provider" },
);
const fields = {
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  baseUrl: InferenceBaseUrlSchema,
  protocol: InferenceProtocolSchema,
  models: Type.Array(Type.Ref("ModelProviderModel"), {
    minItems: 1,
    maxItems: 256,
    description: "Models offered by this provider. Each model ID must be unique.",
  }),
  defaultModelId: Type.Optional(
    Type.String({
      ...modelId,
      description: "Optional default from the models offered by this provider.",
    }),
  ),
  connectionTemplateId: Type.String({
    ...ConnectionTemplateId,
    description:
      "Installation-wide static-key Connection Template that approves the inference request.",
  }),
};
const settingsFingerprint = Type.String({
  pattern: "^[a-f0-9]{64}$",
  description: "Fingerprint of the saved settings, used for conditional updates.",
});
export const ModelProviderBody = Type.Object(fields, strict);
export const UpdateModelProviderBody = Type.Object(
  { ...fields, expectedSettingsFingerprint: settingsFingerprint },
  strict,
);
export const ModelProviderParams = Type.Object({ modelProviderId: ModelProviderId }, strict);
export const ModelProviderSchema = Type.Object(
  { id: ModelProviderId, ...fields, settingsFingerprint },
  { ...strict, $id: "ModelProvider", title: "Model Provider" },
);
const provider = Type.Ref("ModelProvider");
const meta = Type.Object({ requestId: RequestId }, strict);
export const ModelProviderResponse = Type.Object({ data: provider, meta }, strict);
export const ModelProviderListResponse = Type.Object({ data: Type.Array(provider), meta }, strict);
