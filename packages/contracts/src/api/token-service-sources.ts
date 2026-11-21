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

export const UpdateTokenServiceSourceBody = Type.Object(
  { config: Type.Optional(managedConfig), secret: Type.Optional(material) },
  {
    $id: "UpdateTokenServiceSourceBody",
    minProperties: 1,
    additionalProperties: false,
    description:
      "Supply at least one of config or secret. Omitted fields retain their values. Change or remove provider_preset separately from credential replacement; otherwise the update returns 409 RESOURCE_CONFLICT. Repeating the current preset with replacement material is allowed.",
  },
);

export type RegisterTokenServiceSourceBody = Type.Static<typeof RegisterTokenServiceSourceBody>;
export type UpdateTokenServiceSourceBody = Type.Static<typeof UpdateTokenServiceSourceBody>;
