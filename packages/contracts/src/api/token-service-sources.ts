import { Type } from "typebox";

import {
  ConnectionTemplateId,
  CredentialSourceConfig,
  CredentialSourceId,
  CredentialSourceReference,
  CredentialSourceType,
  Name,
  NamespaceId,
  SecretValue,
} from "./common.ts";
import { CredentialSourceSchema } from "./resources.ts";

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
      "Staged managed static update contract. Supply configuration, a credential value, or both. The public route currently returns 501 NOT_IMPLEMENTED after authorization. When enabled, OCC must dispatch by the persisted Source owner; omitted fields retain their values.",
  },
);

export const TokenServiceSourceMetadata = Type.Object(
  {
    id: CredentialSourceId,
    namespaceId: NamespaceId,
    ref: CredentialSourceReference,
    name: Name,
    type: CredentialSourceType,
    config: CredentialSourceConfig,
    connectionTemplateId: Type.Optional(ConnectionTemplateId),
    state: CredentialSourceSchema.properties.state,
    version: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Opaque usable credential version when recorded by the owner.",
      }),
    ),
    status: CredentialSourceSchema.properties.status,
  },
  {
    $id: "TokenServiceSourceMetadata",
    additionalProperties: false,
    description:
      "Proposed public metadata for a Namespace source. OCC keeps the TokenService instance and private registration reference internally. Metadata reads do not resolve a usable credential.",
  },
);

export type RegisterTokenServiceSourceBody = Type.Static<typeof RegisterTokenServiceSourceBody>;
export type UpdateTokenServiceSourceBody = Type.Static<typeof UpdateTokenServiceSourceBody>;
export type TokenServiceSourceMetadata = Type.Static<typeof TokenServiceSourceMetadata>;
