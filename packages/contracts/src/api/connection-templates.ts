import { Type } from "typebox";
import { oauthScopeTokenPattern } from "../connection-templates.ts";
import { RequestId, NamespaceId } from "./common.ts";

const ConnectionTemplateId = Type.String({
  pattern: "^ctp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

const HttpsUrl = Type.String({ maxLength: 2048, pattern: "^https://[^\\s/]" });
export const OAuthScope = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: oauthScopeTokenPattern.source,
});

const ConnectionEndpointSchema = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 253 }),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: "^/" })),
  },
  { additionalProperties: false },
);

export const ConnectionDestinationsSchema = Type.Array(
  Type.Object(
    { host: Type.String(), port: Type.Integer(), path: Type.String() },
    { additionalProperties: false },
  ),
  { minItems: 1 },
);

const Meta = Type.Object(
  { requestId: RequestId, redirectUri: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
const OAuthClientId = Type.String({
  pattern: "^ccr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const DisplayName = Type.String({ minLength: 1, maxLength: 200 });
const ClientSecret = Type.String({ minLength: 1, maxLength: 4096, writeOnly: true });
const AuthMethod = Type.Union([
  Type.Literal("none"),
  Type.Literal("client_secret_basic"),
  Type.Literal("client_secret_post"),
]);
const Scopes = Type.Array(OAuthScope, {
  uniqueItems: true,
  description:
    "Scopes approved by the administrator. An empty list leaves scope selection to the account owner and provider.",
});
const Parameters = Type.Record(
  Type.String({ minLength: 1, maxLength: 128 }),
  Type.String({ maxLength: 1024 }),
  { maxProperties: 32 },
);
const fields = {
  scopes: Scopes,
  authorizationParameters: Type.Optional(Parameters),
  oauthClientId: Type.Optional(OAuthClientId),
};
const manual = {
  mode: Type.Literal("manual"),
  issuer: HttpsUrl,
  authorizationUrl: HttpsUrl,
  tokenUrl: HttpsUrl,
  revocationUrl: Type.Optional(HttpsUrl),
  destinations: Type.Array(ConnectionEndpointSchema, { minItems: 1 }),
};
const mcp = { mode: Type.Literal("mcp_discovery"), serverUrl: HttpsUrl, issuer: HttpsUrl };
const strict = { additionalProperties: false };
const create = { displayName: DisplayName, namespaceId: Type.Optional(NamespaceId) };
const rename = { displayName: Type.Optional(DisplayName) };
export const CreateConnectionTemplateBody = Type.Union([
  Type.Object({ ...create, ...fields, ...manual }, strict),
  Type.Object({ ...create, ...fields, ...mcp }, strict),
]);
export const UpdateConnectionTemplateBody = Type.Union([
  Type.Object({ displayName: DisplayName }, strict),
  Type.Object({ ...rename, ...fields, ...manual }, strict),
  Type.Object({ ...rename, ...fields, ...mcp }, strict),
]);
export const ConnectionTemplateParams = Type.Object(
  { connectionTemplateId: ConnectionTemplateId },
  strict,
);
export const OAuthClientParams = Type.Object({ oauthClientId: OAuthClientId }, strict);
const registration = {
  displayName: DisplayName,
  clientId: Type.String({ minLength: 1, maxLength: 256 }),
  tokenEndpointAuthMethod: AuthMethod,
};
export const CreateOAuthClientBody = Type.Object(
  {
    ...registration,
    connectionTemplateId: ConnectionTemplateId,
    connectionTemplateVersion: Type.Integer({ minimum: 1 }),
    clientSecret: Type.Optional(ClientSecret),
  },
  strict,
);
export const RotateOAuthClientSecretBody = Type.Object({ clientSecret: ClientSecret }, strict);
export const DiscoverTemplateBody = Type.Object(
  { serverUrl: HttpsUrl, issuer: Type.Optional(HttpsUrl) },
  strict,
);
const Observed = Type.Object(
  {
    serverUrl: HttpsUrl,
    resource: HttpsUrl,
    issuers: Type.Array(HttpsUrl),
    requestedScopes: Type.Array(OAuthScope),
    resourceScopes: Type.Optional(Type.Array(OAuthScope)),
    issuer: Type.Optional(HttpsUrl),
    authorizationUrl: Type.Optional(HttpsUrl),
    tokenUrl: Type.Optional(HttpsUrl),
    revocationUrl: Type.Optional(HttpsUrl),
    registrationUrl: Type.Optional(HttpsUrl),
    supportedScopes: Type.Optional(Type.Array(OAuthScope)),
    tokenEndpointAuthMethods: Type.Optional(Type.Array(Type.String())),
  },
  strict,
);
const publicClient = Type.Object(
  {
    ...registration,
    namespaceId: Type.Optional(NamespaceId),
    issuer: HttpsUrl,
    tokenUrl: HttpsUrl,
    revocationUrl: Type.Optional(HttpsUrl),
    id: OAuthClientId,
    createdAt: Type.String(),
  },
  strict,
);
export const OAuthConnectionTemplateVersionSchema = Type.Object(
  {
    templateId: ConnectionTemplateId,
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    mode: Type.Union([Type.Literal("manual"), Type.Literal("mcp_discovery")]),
    issuer: HttpsUrl,
    authorizationUrl: HttpsUrl,
    tokenUrl: HttpsUrl,
    revocationUrl: Type.Optional(HttpsUrl),
    destinations: ConnectionDestinationsSchema,
    scopes: Scopes,
    authorizationParameters: Parameters,
    oauthClientId: Type.Optional(OAuthClientId),
    mcp: Type.Optional(Type.Object({ serverUrl: HttpsUrl, resource: HttpsUrl }, strict)),
    observed: Type.Optional(Observed),
  },
  { $id: "OAuthConnectionTemplateVersion", title: "OAuth connection template version", ...strict },
);
export const ConnectionTemplateSchema = Type.Object(
  {
    ...create,
    id: ConnectionTemplateId,
    current: Type.Ref("OAuthConnectionTemplateVersion"),
    createdAt: Type.String(),
  },
  { $id: "ConnectionTemplate", title: "OAuth connection template", ...strict },
);
const template = Type.Ref("ConnectionTemplate");
export const ConnectionTemplateResponse = Type.Object({ data: template, meta: Meta }, strict);
export const ConnectionTemplateListResponse = Type.Object(
  { data: Type.Array(template), meta: Meta },
  strict,
);
export const OAuthClientResponse = Type.Object({ data: publicClient, meta: Meta }, strict);
export const OAuthClientListResponse = Type.Object(
  { data: Type.Array(publicClient), meta: Meta },
  strict,
);
export const DiscoverTemplateResponse = Type.Object({ data: Observed, meta: Meta }, strict);
