import { Type } from "typebox";

import { CredentialSourceConfig, Name, SecretValue } from "./common.ts";

const material = Type.Record(Type.String(), SecretValue, {
  minProperties: 1,
  maxProperties: 1,
  writeOnly: true,
  description:
    "Write-only: one opaque credential value. The field name does not grant destination authority.",
});

const managedConfig = {
  ...CredentialSourceConfig,
  description:
    "Non-secret configuration. provider_preset=openai selects the approved permitted-use preset outside TokenService.",
};

export const RegisterTokenServiceSourceBody = Type.Object(
  {
    name: Name,
    type: Type.Literal("static"),
    config: Type.Optional(managedConfig),
    secret: material,
  },
  {
    $id: "RegisterTokenServiceSourceBody",
    additionalProperties: false,
    description:
      "Staged managed static registration contract. The public route currently returns 501 NOT_IMPLEMENTED after authorization. When enabled, OCC allocates the identity and selects the TokenService owner.",
  },
);

export const UpdateTokenServiceSourceBody = Type.Union(
  [
    Type.Object(
      { config: managedConfig, secret: Type.Optional(material) },
      { additionalProperties: false },
    ),
    Type.Object(
      { config: Type.Optional(managedConfig), secret: material },
      { additionalProperties: false },
    ),
  ],
  {
    $id: "UpdateTokenServiceSourceBody",
    description:
      "Staged managed static update contract. Supply configuration, a credential value, or both. The public route currently returns 501 NOT_IMPLEMENTED after authorization. When enabled, OCC must dispatch by the persisted Source owner; omitted fields retain their values. An effective provider_preset change or removal combined with replacement credential material returns 409 RESOURCE_CONFLICT. Send these changes in separate operations; repeating the current preset with replacement material is allowed.",
  },
);

export type RegisterTokenServiceSourceBody = Type.Static<typeof RegisterTokenServiceSourceBody>;
export type UpdateTokenServiceSourceBody = Type.Static<typeof UpdateTokenServiceSourceBody>;
