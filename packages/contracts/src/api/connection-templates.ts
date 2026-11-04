import { Type } from "typebox";
import { Meta, NamespaceId } from "./common.ts";

export const ConnectionTemplateId = Type.String({
  pattern: "^ctp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

const HttpsUrl = Type.String({ maxLength: 2048, pattern: "^https://[^\\s/]" });
const Scope = Type.String({ minLength: 1, maxLength: 512, pattern: "^[!#-\\[\\]-~]+$" });

const EndpointAccess = Type.Union([Type.Literal("read-only"), Type.Literal("full")]);

const ConnectionEndpointSchema = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 253 }),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: "^/" })),
    access: Type.Optional(EndpointAccess),
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
  {
    ...ConnectionTemplateFields,
    namespaceId: Type.Optional(NamespaceId),
    clientSecret: Type.Optional(ClientSecret),
  },
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
      { host: Type.String(), port: Type.Integer(), path: Type.String(), access: EndpointAccess },
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
    namespaceId: Type.Optional(NamespaceId),
    displayName: Type.String(),
    current: ConnectionTemplateVersionSchema,
    createdAt: Type.String(),
  },
  { $id: "ConnectionTemplate", title: "Connection template", additionalProperties: false },
);

const template = Type.Ref("ConnectionTemplate");

export const ConnectionTemplateResponse = Type.Object(
  { data: template, meta: Meta },
  { additionalProperties: false },
);

export const ConnectionTemplateListResponse = Type.Object(
  { data: Type.Array(template), meta: Meta },
  { additionalProperties: false },
);
