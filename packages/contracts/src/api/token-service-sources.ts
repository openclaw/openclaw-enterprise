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
  maxProperties: 16,
  writeOnly: true,
  description: "Credential values keyed by the secret fields declared by the source type.",
});

export const RegisterTokenServiceSourceBody = Type.Object(
  {
    name: Name,
    type: CredentialSourceType,
    connectionTemplateId: Type.Optional(ConnectionTemplateId),
    config: Type.Optional(CredentialSourceConfig),
    secret: Type.Optional(material),
  },
  {
    $id: "RegisterTokenServiceSourceBody",
    additionalProperties: false,
    description:
      "Proposed registration body for a Namespace credential source. OCC allocates the identity and selects the TokenService Driver. An attached Connection Template supplies its current settings. Supply the secret fields required by the source type.",
  },
);

export const UpdateTokenServiceSourceBody = Type.Union(
  [
    Type.Object(
      { config: CredentialSourceConfig, secret: Type.Optional(material) },
      { additionalProperties: false },
    ),
    Type.Object(
      { config: Type.Optional(CredentialSourceConfig), secret: material },
      { additionalProperties: false },
    ),
  ],
  {
    $id: "UpdateTokenServiceSourceBody",
    description:
      "Proposed update to credential material, mutable lifecycle settings, or both. Omitted fields retain their values.",
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
