import { Type } from "typebox";
import { ConnectionTemplateId, ModelProviderId, RequestId } from "./common.ts";

export const InferenceProtocolSchema = Type.Union([
  Type.Literal("openai-responses"),
  Type.Literal("openai-completions"),
]);
const strict = { additionalProperties: false };
const modelId = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\s\\x00-\\x1f\\x7f]+$" });
const nonnegative = Type.Number({ minimum: 0 });
const model = Type.Object(
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
        strict,
      ),
    ),
  },
  strict,
);
const fields = {
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  baseUrl: Type.String({ maxLength: 2048, pattern: "^https://" }),
  protocol: InferenceProtocolSchema,
  models: Type.Array(model, { minItems: 1, maxItems: 256 }),
  defaultModelId: Type.Optional(modelId),
  connectionTemplateId: ConnectionTemplateId,
};
export const ModelProviderBody = Type.Object(fields, strict);
export const ModelProviderParams = Type.Object({ modelProviderId: ModelProviderId }, strict);
const provider = Type.Object({ id: ModelProviderId, ...fields }, strict);
const meta = Type.Object({ requestId: RequestId }, strict);
export const ModelProviderResponse = Type.Object({ data: provider, meta }, strict);
export const ModelProviderListResponse = Type.Object({ data: Type.Array(provider), meta }, strict);
