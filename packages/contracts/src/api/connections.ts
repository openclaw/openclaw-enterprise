import { Type } from "typebox";
import { AgentId, CredentialSourceId, Meta, NamespaceId } from "./common.ts";
import { ConnectionTemplateId, OAuthScope } from "./connection-templates.ts";

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
    recipient: Type.Object(
      {
        host: Type.String(),
        port: Type.Integer({ minimum: 1, maximum: 65535 }),
        path: Type.String(),
      },
      { additionalProperties: false },
    ),
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

const PluginId = Type.String({ minLength: 1, maxLength: 256 });
const SlotId = Type.String({ minLength: 1, maxLength: 128 });

export const PluginSlotParams = Type.Object(
  {
    namespaceId: NamespaceId,
    agentId: AgentId,
    pluginId: PluginId,
    slotId: SlotId,
  },
  { additionalProperties: false },
);
export const StartPluginConnectionBody = Type.Object(
  {
    connectionTemplateId: ConnectionTemplateId,
    connectionTemplateVersion: Type.Integer({ minimum: 1 }),
    pluginId: PluginId,
    slotId: SlotId,
    releaseSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    selectedScopes: Type.Optional(Type.Array(OAuthScope, { uniqueItems: true })),
    expectedCredentialSourceId: Type.Union([CredentialSourceId, Type.Null()]),
  },
  { additionalProperties: false },
);
export const PluginTemplateChoicesResponse = Type.Object(
  {
    data: Type.Array(
      Type.Object(
        {
          id: ConnectionTemplateId,
          displayName: Type.String(),
          version: Type.Integer({ minimum: 1 }),
          mode: Type.Union([Type.Literal("manual"), Type.Literal("mcp_discovery")]),
          scopes: Type.Array(Type.String()),
          requiredScopes: Type.Array(Type.String()),
          offeredScopes: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

export const AgentConnectionParams = Type.Object(
  {
    namespaceId: NamespaceId,
    agentId: AgentId,
    credentialSourceId: CredentialSourceId,
  },
  { additionalProperties: false },
);

export const AgentConnectionDetachResponse = Type.Object(
  {
    data: Type.Object(
      {
        /** True when runtime withdrawal was requested for this Agent. */
        withdrawalRequested: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);
