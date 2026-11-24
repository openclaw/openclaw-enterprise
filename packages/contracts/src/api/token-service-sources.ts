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
    "Non-secret configuration. provider_preset selects the approved permitted-use preset outside TokenService: openai for a model key, or github for one fine-grained personal access token. A github Source also requires repositories, a comma-separated repository ceiling of owner/name:read or owner/name:write entries.",
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
      "Register a managed static Source. OCC allocates its identity and selects the TokenService owner.",
  },
);

export const UpdateTokenServiceSourceBody = Type.Object(
  { config: Type.Optional(managedConfig), secret: Type.Optional(material) },
  {
    $id: "UpdateTokenServiceSourceBody",
    minProperties: 1,
    additionalProperties: false,
    description:
      "Update a managed static Source through its persisted owner. Supply at least one of config or secret. Omitted fields retain their values. An effective provider_preset change or removal combined with replacement credential material returns 409 RESOURCE_CONFLICT. Repeating the current preset with replacement material is allowed. The github preset cannot be added or removed after registration. A github Source's config update must repeat repositories with the preset; its repositories change only separately from material and while the Source is unbound.",
  },
);

export type RegisterTokenServiceSourceBody = Type.Static<typeof RegisterTokenServiceSourceBody>;
export type UpdateTokenServiceSourceBody = Type.Static<typeof UpdateTokenServiceSourceBody>;
