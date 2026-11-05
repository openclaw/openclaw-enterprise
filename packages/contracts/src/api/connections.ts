import { Type } from "typebox";
import { CredentialSourceId, Meta, NamespaceId } from "./common.ts";
import {
  ConnectionRecipientSchema,
  ConnectionTemplateId,
  OAuthScope,
} from "./connection-templates.ts";

export const StartNamespaceConnectionBody = Type.Object(
  {
    connectionTemplateId: ConnectionTemplateId,
    selectedScopes: Type.Optional(Type.Array(OAuthScope, { uniqueItems: true })),
  },
  { additionalProperties: false },
);

export const ConnectionStartResponse = Type.Object(
  {
    data: Type.Object(
      {
        credentialSourceId: CredentialSourceId,
        authorizationUrl: Type.String(),
        expiresAt: Type.String(),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

const SavedConnectionSchema = Type.Object(
  {
    namespaceId: NamespaceId,
    credentialSourceId: CredentialSourceId,
    ownerPrincipalId: Type.String(),
    tokenUrl: Type.String(),
    mcpServerUrl: Type.Optional(Type.String()),
    oauthClientId: Type.String(),
    clientId: Type.String(),
    issuer: Type.String(),
    recipient: ConnectionRecipientSchema,
    resource: Type.Optional(Type.String()),
    requestedScopes: Type.Array(Type.String()),
    grantedScopes: Type.Array(Type.String()),
    connectionTemplateId: ConnectionTemplateId,
    connectionTemplateVersion: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

export const SavedConnectionListResponse = Type.Object(
  { data: Type.Array(SavedConnectionSchema), meta: Meta },
  { additionalProperties: false },
);
