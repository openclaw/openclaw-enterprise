import { Type } from "typebox";

import {
  BackendId,
  ConnectionTemplateId,
  CREDENTIAL_SOURCE_FIELD_NAME_PATTERN,
  CredentialSourceConfig,
  CredentialSourceId,
  CredentialSourceReference,
  CredentialSourceType,
  Name,
  NamespaceId,
  SecretValue,
} from "./common.ts";
import { CredentialSourceStatusSchema } from "./resources.ts";

const connectionTemplateApproval = Type.Object(
  {
    id: ConnectionTemplateId,
    version: Type.Integer({ minimum: 1 }),
  },
  {
    additionalProperties: false,
    description: "Connection Template version approved by the credential owner.",
  },
);

const material = Type.Record(Type.String(), SecretValue, {
  propertyNames: { pattern: CREDENTIAL_SOURCE_FIELD_NAME_PATTERN.source },
  minProperties: 1,
  maxProperties: 16,
  writeOnly: true,
  description: "Credential values keyed by the secret fields declared by the source type.",
});

export const RegisterTokenServiceSourceBody = Type.Object(
  {
    name: Name,
    type: CredentialSourceType,
    connectionTemplate: Type.Optional(connectionTemplateApproval),
    config: Type.Optional(CredentialSourceConfig),
    secret: Type.Optional(material),
  },
  {
    $id: "RegisterTokenServiceSourceBody",
    additionalProperties: false,
    description:
      "Proposed registration body for a Namespace credential source. OCC allocates the identity and selects the TokenService Driver. Supply the secret fields required by the source type.",
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
      "Proposed update to the recorded owner's credential material, mutable lifecycle settings, or both. Omitted fields retain their values.",
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
    connectionTemplate: Type.Optional(connectionTemplateApproval),
    state: Type.Union([
      Type.Literal("registering"),
      Type.Literal("ready"),
      Type.Literal("deleting"),
    ]),
    ownerCapability: Type.Literal("token_service"),
    driverId: BackendId,
    delivery: Type.Optional(
      Type.Union([Type.Literal("push"), Type.Literal("native")], {
        description: "Delivery mode reported by the owner after registration.",
      }),
    ),
    version: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Opaque usable credential version when recorded by the owner.",
      }),
    ),
    status: Type.Optional(CredentialSourceStatusSchema),
  },
  {
    $id: "TokenServiceSourceMetadata",
    additionalProperties: false,
    description:
      "Proposed public metadata for a Namespace source. OCC retains the owner's backend reference internally. Metadata reads do not resolve a usable credential.",
  },
);

export type RegisterTokenServiceSourceBody = Type.Static<typeof RegisterTokenServiceSourceBody>;
export type UpdateTokenServiceSourceBody = Type.Static<typeof UpdateTokenServiceSourceBody>;
export type TokenServiceSourceMetadata = Type.Static<typeof TokenServiceSourceMetadata>;
