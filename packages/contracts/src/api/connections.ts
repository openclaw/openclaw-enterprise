import { Type } from "typebox";
import { AgentId, CredentialSourceId, Meta, NamespaceId } from "./common.ts";
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

const PluginId = Type.String({ minLength: 1, maxLength: 256 });
const SlotId = Type.String({ minLength: 1, maxLength: 128 });

export const PluginSlotParams = Type.Object(
  { namespaceId: NamespaceId, agentId: AgentId, pluginId: PluginId, slotId: SlotId },
  { additionalProperties: false },
);
export const StartPluginConnectionBody = Type.Object(
  {
    connectionTemplateId: ConnectionTemplateId,
    connectionTemplateVersion: Type.Integer({ minimum: 1 }),
    pluginId: PluginId,
    slotId: SlotId,
    releaseSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
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
        },
        { additionalProperties: false },
      ),
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

export const AgentConnectionParams = Type.Object(
  { namespaceId: NamespaceId, agentId: AgentId, credentialSourceId: CredentialSourceId },
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
