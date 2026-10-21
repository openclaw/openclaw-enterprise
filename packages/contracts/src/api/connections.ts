import { Type } from "typebox";
import {
  AgentId,
  CredentialSourceId,
  NamespaceId,
  Meta,
  Name,
  PermissionActionSchema,
  ResourceKindSchema,
} from "./common.ts";

export const ConnectionTemplateId = Type.String({
  pattern: "^ctp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

const HttpsUrl = Type.String({ minLength: 9, maxLength: 2048, pattern: "^https://" });
const Scope = Type.String({ minLength: 1, maxLength: 512, pattern: "^[!#-\\[\\]-~]+$" });

const ConnectionEndpointSchema = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 253 }),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: "^/" })),
  },
  { additionalProperties: false },
);

const ConnectionTemplateFields = {
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  issuer: HttpsUrl,
  authorizationUrl: HttpsUrl,
  tokenUrl: HttpsUrl,
  clientId: Type.String({ minLength: 1, maxLength: 256 }),
  scopes: Type.Array(Scope, { minItems: 1, maxItems: 32 }),
  authorizationParameters: Type.Optional(
    Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.String({ maxLength: 512 }), {
      maxProperties: 16,
    }),
  ),
  endpoint: ConnectionEndpointSchema,
  envVar: Type.String({ pattern: "^[A-Z_][A-Z0-9_]{0,63}$" }),
};

/** Write-only; never returned. Required only for an OAuth client that is not registered yet. */
const ClientSecret = Type.String({ minLength: 1, maxLength: 4096 });

export const ConnectionTemplateParams = Type.Object(
  { connectionTemplateId: ConnectionTemplateId },
  { additionalProperties: false },
);

export const CreateConnectionTemplateBody = Type.Object(
  { ...ConnectionTemplateFields, clientSecret: Type.Optional(ClientSecret) },
  { additionalProperties: false },
);

export const UpdateConnectionTemplateBody = Type.Object(
  {
    displayName: Type.Optional(ConnectionTemplateFields.displayName),
    issuer: Type.Optional(ConnectionTemplateFields.issuer),
    authorizationUrl: Type.Optional(ConnectionTemplateFields.authorizationUrl),
    tokenUrl: Type.Optional(ConnectionTemplateFields.tokenUrl),
    clientId: Type.Optional(ConnectionTemplateFields.clientId),
    scopes: Type.Optional(ConnectionTemplateFields.scopes),
    authorizationParameters: ConnectionTemplateFields.authorizationParameters,
    endpoint: Type.Optional(ConnectionEndpointSchema),
    envVar: Type.Optional(ConnectionTemplateFields.envVar),
    clientSecret: Type.Optional(ClientSecret),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const RotateConnectionClientSecretBody = Type.Object(
  { clientSecret: ClientSecret },
  { additionalProperties: false },
);

const ConnectionTemplateVersionSchema = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    issuer: Type.String(),
    authorizationUrl: Type.String(),
    tokenUrl: Type.String(),
    clientId: Type.String(),
    clientRegistrationId: Type.String(),
    scopes: Type.Array(Type.String()),
    authorizationParameters: Type.Record(Type.String(), Type.String()),
    endpoint: Type.Object(
      { host: Type.String(), port: Type.Integer(), path: Type.String() },
      { additionalProperties: false },
    ),
    envVar: Type.String(),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

export const ConnectionTemplateSchema = Type.Object(
  {
    id: ConnectionTemplateId,
    displayName: Type.String(),
    current: ConnectionTemplateVersionSchema,
    /** The exact URI administrators register with the provider. */
    redirectUri: Type.Optional(Type.String()),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

export const ConnectionTemplateResponse = Type.Object(
  { data: ConnectionTemplateSchema, meta: Meta },
  { additionalProperties: false },
);

export const ConnectionTemplateListResponse = Type.Object(
  { data: Type.Array(ConnectionTemplateSchema), meta: Meta },
  { additionalProperties: false },
);

export const InstallationAccessBindingParams = Type.Object(
  { bindingId: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false },
);

/** Installation Roles may also grant `use` on Installation resources such as connection templates. */
const InstallationPermissionSchema = Type.Object(
  {
    action: Type.Union([...PermissionActionSchema.anyOf, Type.Literal("use")]),
    resourceKind: Type.Union([...ResourceKindSchema.anyOf, Type.Literal("connection_template")]),
  },
  { additionalProperties: false },
);

const InstallationRoleSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    name: Type.Optional(Name),
    permissions: Type.Array(InstallationPermissionSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const InstallationRoleListResponse = Type.Object(
  { data: Type.Array(InstallationRoleSchema), meta: Meta },
  { additionalProperties: false },
);

/** An Installation binding belongs to no Namespace; a Namespace subject names one instead. */
const InstallationAccessBindingSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    subjectKind: Type.Union([Type.Literal("identity"), Type.Literal("namespace")]),
    subjectId: Type.String({ minLength: 1, maxLength: 200 }),
    roleId: Type.String({ minLength: 1, maxLength: 200 }),
    resourceKind: Type.Literal("connection_template"),
    resourceId: ConnectionTemplateId,
  },
  { additionalProperties: false },
);

export const InstallationAccessBindingResponse = Type.Object(
  { data: InstallationAccessBindingSchema, meta: Meta },
  { additionalProperties: false },
);

export const InstallationAccessBindingListResponse = Type.Object(
  { data: Type.Array(InstallationAccessBindingSchema), meta: Meta },
  { additionalProperties: false },
);

export const CreateInstallationAccessBindingBody = Type.Object(
  {
    subjectKind: Type.Union([Type.Literal("identity"), Type.Literal("namespace")]),
    subjectId: Type.String({ minLength: 1, maxLength: 200 }),
    roleId: Type.String({ minLength: 1, maxLength: 200 }),
    resourceKind: Type.Literal("connection_template"),
    resourceId: ConnectionTemplateId,
  },
  { additionalProperties: false },
);

export const StartAgentConnectionBody = Type.Object(
  { connectionTemplateId: ConnectionTemplateId },
  { additionalProperties: false },
);

export const AgentConnectionParams = Type.Object(
  { namespaceId: NamespaceId, agentId: AgentId, credentialSourceId: CredentialSourceId },
  { additionalProperties: false },
);

export const AgentConnectionStartResponse = Type.Object(
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

const AgentConnectionSchema = Type.Object(
  {
    namespaceId: NamespaceId,
    credentialSourceId: CredentialSourceId,
    agentId: AgentId,
    ownerPrincipalId: Type.String(),
    connectionTemplateId: ConnectionTemplateId,
    connectionTemplateVersion: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentConnectionListResponse = Type.Object(
  { data: Type.Array(AgentConnectionSchema), meta: Meta },
  { additionalProperties: false },
);

export const AgentConnectionDisconnectResponse = Type.Object(
  {
    data: Type.Object(
      {
        /** True when the active revision held the source and withdrawal was requested. */
        withdrawalRequested: Type.Boolean(),
        /** False while a revision, deployment, or withdrawal still holds the source. */
        deleted: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);
