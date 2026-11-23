import { Type } from "typebox";
import { Meta } from "./common.ts";
import {
  ConnectionTemplateId,
  ConnectionTemplateResponse,
  OAuthScope,
} from "./connection-templates.ts";

/** Namespace use lists connectable templates; the Installation's editor presets stay in the admin catalog. */
export const UsableConnectionTemplatesResponse = Type.Object(
  { data: Type.Array(ConnectionTemplateResponse.properties.data), meta: Meta },
  { additionalProperties: false },
);

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
        authorizationUrl: Type.String(),
        expiresAt: Type.String(),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);
