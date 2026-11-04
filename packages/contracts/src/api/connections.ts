import { Type } from "typebox";
import { CredentialSourceId, Meta, NamespaceId } from "./common.ts";
import { ConnectionTemplateId } from "./connection-templates.ts";

export const StartNamespaceConnectionBody = Type.Object(
  { connectionTemplateId: ConnectionTemplateId },
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
