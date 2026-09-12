# Development OCC API reference

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

Version `0.1.0`; OpenAPI `3.1.0`.

This reference is generated from the
[checked-in OpenAPI contract](../../packages/contracts/openapi/occ-api.openapi.json).
Run `pnpm openapi:generate` after changing an API route or schema;
`pnpm openapi:check` verifies the generated contract and API reference.

The exported contract comes from the development-enabled OCC app, which is
why the generated title is `Development OCC API`. Use
`POST /installation/bootstrap` only for development or bootstrap flows
that create the first Installation; production bootstraps through the
[Helm initialization Job](../guides/deploy/production-installation.md#provision-system-secrets-and-install)
before serving requests.
After bootstrap, production uses the same authenticated controller resource
operations through the selected Drivers and settings described in
[settings](settings.md).

See [authentication](authentication.md) for supported credentials and their scope.

## Error responses

Non-success JSON responses use the following envelope.
Each operation lists its supported status codes.

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `error` | `object` | Yes | — |
| `error.code` | `"INVALID_REQUEST" or "UNAUTHENTICATED" or "FORBIDDEN" or "NOT_FOUND" or "METHOD_NOT_ALLOWED" or "INSTALLATION_EXISTS" or "RESOURCE_CONFLICT" or "NAMESPACE_NOT_READY" or "NAMESPACE_NOT_EMPTY" or "PAYLOAD_TOO_LARGE" or "UNSUPPORTED_MEDIA_TYPE" or "UNKNOWN_OUTCOME" or "NOT_IMPLEMENTED" or "INTERNAL_ERROR" or "DEPENDENCY_UNAVAILABLE"` | Yes | — |
| `error.details` | `array<object>` | No | max items: 32 |
| `error.details[].code` | `"REQUIRED" or "UNKNOWN_FIELD" or "INVALID_TYPE" or "INVALID_FORMAT" or "INVALID_VALUE" or "TOO_LONG" or "TOO_DEEP"` | Yes | — |
| `error.details[].path` | `string` | Yes | max length: 512; pattern: `^(?:/(?:[^~/]\|~0\|~1)*)*$` |
| `error.message` | `string` | Yes | min length: 1; max length: 256 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Resources

| Resource | Operations |
| --- | --- |
| [Authentication](#authentication) | 6 operations |
| [Installation](#installation) | 2 operations |
| [Namespaces](#namespaces) | 4 operations |
| [Agents](#agents) | 9 operations |
| [Agent revisions](#agent-revisions) | 2 operations |
| [Configurations](#configurations) | 4 operations |
| [Secrets](#secrets) | 4 operations |
| [Service accounts](#service-accounts) | 6 operations |
| [Providers](#providers) | 1 operation |

## Operations

<span id="authentication"></span>

### Authentication

| Operation | Summary |
| --- | --- |
| [`POST /api/auth/accounts`](#post-apiauthaccounts) | Create an administrator-controlled local auth account |
| [`POST /api/auth/service-keys`](#post-apiauthservicekeys) | Issue a service API key |
| [`DELETE /api/auth/service-keys/{keyId}`](#delete-apiauthservicekeyskeyid) | Revoke a service API key |
| [`GET /api/auth/session`](#get-apiauthsession) | Inspect authentication without revealing session tokens |
| [`POST /api/auth/sign-in/email`](#post-apiauthsigninemail) | Sign in with email and password |
| [`POST /api/auth/sign-out`](#post-apiauthsignout) | Sign out of the current session |

#### `POST /api/auth/accounts`

<span id="post-apiauthaccounts"></span>

Create an administrator-controlled local auth account

**Operation ID:** `createAuthAccount`

**Permissions:** Requires administer permission on the Installation. Creates a Better Auth account, an explicit IAM Principal, and a binding to the requested existing IAM Role; public signup remains disabled.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `email` | `string` | Yes | min length: 3; max length: 320 |
| `name` | `string` | No | min length: 1; max length: 200 |
| `password` | `string` | Yes | min length: 12; max length: 128 |
| `roleId` | `string` | Yes | min length: 1; max length: 200 |

##### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `409` | Conflict |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.email` | `string (email)` | Yes | — |
| `data.id` | `string` | Yes | — |
| `data.name` | `string` | Yes | — |
| `data.principalId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/service-keys`

<span id="post-apiauthservicekeys"></span>

Issue a service API key

**Operation ID:** `createServiceKey`

**Permissions:** Requires a session or Installation-scoped service key with administer on the Installation. Issues a Better Auth key for an existing non-Agent ServicePrincipal in its exact scope; creates no identity or IAM grant. The plaintext key is returned only here.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expiresIn` | `integer` | No | minimum: 86400; maximum: 31536000; Lifetime in seconds; defaults to 30 days. |
| `name` | `string` | Yes | min length: 1; max length: 32; pattern: `\S` |
| `namespaceId` | `string` | No | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `servicePrincipalId` | `string` | Yes | min length: 1; max length: 200 |

##### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.expiresAt` | `string (date-time)` | Yes | — |
| `data.id` | `string` | Yes | — |
| `data.key` | `string` | Yes | — |
| `data.name` | `string` | Yes | — |
| `data.namespaceId` | `string` | No | — |
| `data.servicePrincipalId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `DELETE /api/auth/service-keys/{keyId}`

<span id="delete-apiauthservicekeyskeyid"></span>

Revoke a service API key

**Operation ID:** `revokeServiceKey`

**Permissions:** Requires a session or Installation-scoped service key with administer on the Installation. Deletes the stored Better Auth key; subsequent requests cannot authenticate with it.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `keyId` | path | `string` | Yes | min length: 1; max length: 200 |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.id` | `string` | Yes | — |
| `data.revoked` | `true` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `GET /api/auth/session`

<span id="get-apiauthsession"></span>

Inspect authentication without revealing session tokens

**Operation ID:** `getAuthSession`

**Permissions:** Returns only authenticated status and public account identity, or null without a valid session; session tokens and credentials are never returned.

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `null or object` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/sign-in/email`

<span id="post-apiauthsigninemail"></span>

Sign in with email and password

**Operation ID:** `signInEmail`

**Permissions:** Authenticates a local account and issues a user session cookie.

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `email` | `string` | Yes | min length: 3; max length: 320 |
| `password` | `string` | Yes | min length: 12; max length: 128 |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Unauthorized |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.authenticated` | `true` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/sign-out`

<span id="post-apiauthsignout"></span>

Sign out of the current session

**Operation ID:** `signOut`

**Permissions:** Revokes the current user session cookie.

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Unauthorized |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

<span id="installation"></span>

### Installation

| Operation | Summary |
| --- | --- |
| [`GET /installation`](#get-installation) | Get the singleton Installation |
| [`POST /installation/bootstrap`](#post-installationbootstrap) | Bootstrap the singleton Installation |

#### `GET /installation`

<span id="get-installation"></span>

Get the singleton Installation

**Operation ID:** `getInstallation`

**Permissions:** Requires read permission on the requested Installation.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `installation` | `requested` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.id` | `string` | Yes | pattern: `^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /installation/bootstrap`

<span id="post-installationbootstrap"></span>

Bootstrap the singleton Installation

**Operation ID:** `bootstrapInstallation`

**Permissions:** Requires administer permission on the requested Installation.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.id` | `string` | Yes | pattern: `^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="namespaces"></span>

### Namespaces

| Operation | Summary |
| --- | --- |
| [`GET /namespaces`](#get-namespaces) | List authorized Namespaces |
| [`POST /namespaces`](#post-namespaces) | Create an Installation-owned Namespace |
| [`DELETE /namespaces/{namespaceId}`](#delete-namespacesnamespaceid) | Begin deletion of an empty Installation-owned Namespace |
| [`GET /namespaces/{namespaceId}`](#get-namespacesnamespaceid) | Get an exact Installation-owned Namespace |

#### `GET /namespaces`

<span id="get-namespaces"></span>

List authorized Namespaces

**Operation ID:** `listNamespaces`

**Permissions:** Only Namespace resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `namespace` | `each_returned` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `array<object>` | Yes | — |
| `data[].createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data[].existingNamespace` | `string` | No | min length: 1; max length: 63; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$` |
| `data[].id` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].status` | `"provisioning" or "ready" or "failed" or "deleting"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces`

<span id="post-namespaces"></span>

Create an Installation-owned Namespace

**Operation ID:** `createNamespace`

**Permissions:** Requires create permission for Namespace resources in the Installation. Requires administer permission on the Installation when selecting an existing Kubernetes namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `namespace` | `installation` |
| `administer` | `installation` | `requested` (when selecting an existing namespace) |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `existingNamespace` | `string` | No | min length: 1; max length: 63; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$` |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.existingNamespace` | `string` | No | min length: 1; max length: 63; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$` |
| `data.id` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.status` | `"provisioning" or "ready" or "failed" or "deleting"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}`

<span id="delete-namespacesnamespaceid"></span>

Begin deletion of an empty Installation-owned Namespace

**Operation ID:** `deleteNamespace`

**Permissions:** Requires delete permission on the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `delete` | `namespace` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `202` | Accepted |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`202` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.existingNamespace` | `string` | No | min length: 1; max length: 63; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$` |
| `data.id` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.status` | `"provisioning" or "ready" or "failed" or "deleting"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}`

<span id="get-namespacesnamespaceid"></span>

Get an exact Installation-owned Namespace

**Operation ID:** `getNamespace`

**Permissions:** Requires read permission on the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `namespace` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.existingNamespace` | `string` | No | min length: 1; max length: 63; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$` |
| `data.id` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.status` | `"provisioning" or "ready" or "failed" or "deleting"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="agents"></span>

### Agents

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/agents`](#get-namespacesnamespaceidagents) | List authorized Agents in one exact Namespace |
| [`POST /namespaces/{namespaceId}/agents`](#post-namespacesnamespaceidagents) | Create a Namespace-owned Agent |
| [`GET /namespaces/{namespaceId}/agents/{agentId}`](#get-namespacesnamespaceidagentsagentid) | Get an exact Namespace-owned Agent |
| [`PATCH /namespaces/{namespaceId}/agents/{agentId}`](#patch-namespacesnamespaceidagentsagentid) | Replace an exact Namespace-owned Agent's editable draft |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/deploy`](#post-namespacesnamespaceidagentsagentiddeploy) | Admit an immutable revision from the Agent's saved draft |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`](#get-namespacesnamespaceidagentsagentidruntimecredentials) | Get metadata for one Agent's provisioned runtime credentials |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`](#post-namespacesnamespaceidagentsagentidruntimecredentials) | Provision initial runtime credentials for one undeployed Agent |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`](#get-namespacesnamespaceidagentsagentidworkspacefilesname) | Read an allowed workspace file from one active Agent |
| [`PUT /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`](#put-namespacesnamespaceidagentsagentidworkspacefilesname) | Create or replace an allowed workspace file for one active Agent |

#### `GET /namespaces/{namespaceId}/agents`

<span id="get-namespacesnamespaceidagents"></span>

List authorized Agents in one exact Namespace

**Operation ID:** `listAgents`

**Permissions:** Requires read permission on the requested Namespace. Only Agent resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `namespace` | `requested` |
| `read` | `agent` | `each_returned` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `array<object>` | Yes | — |
| `data[].activeRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data[].executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data[].id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data[].providerId` | `string or null` | Yes | — |
| `data[].serviceAccountId` | `string` | No | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents`

<span id="post-namespacesnamespaceidagents"></span>

Create a Namespace-owned Agent

**Operation ID:** `createAgent`

**Permissions:** Requires create permission for Agent resources in the requested Namespace. Requires read permission on the requested Configuration. Requires read permission on each currently associated or newly associated ServiceAccount when present. Requires operate permission on each bound Secret when Secret bindings are present or selected.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
| `read` | `configuration` | `requested` |
| `read` | `service_account` | `requested` (when associated) |
| `operate` | `secret` | `requested` (when bound) |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `executionMode` | `"embedded" or "dedicated"` | No | — |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `providerId` | `string or null` | No | — |
| `serviceAccountId` | `string` | No | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.activeRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.providerId` | `string or null` | Yes | — |
| `data.serviceAccountId` | `string` | No | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}`

<span id="get-namespacesnamespaceidagentsagentid"></span>

Get an exact Namespace-owned Agent

**Operation ID:** `getAgent`

**Permissions:** Requires read permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.activeRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.providerId` | `string or null` | Yes | — |
| `data.serviceAccountId` | `string` | No | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `PATCH /namespaces/{namespaceId}/agents/{agentId}`

<span id="patch-namespacesnamespaceidagentsagentid"></span>

Replace an exact Namespace-owned Agent's editable draft

**Operation ID:** `updateAgent`

**Permissions:** Requires update permission on the requested Agent. Requires read permission on the requested Configuration. Requires read permission on each currently associated or newly associated ServiceAccount when present. Requires operate permission on each bound Secret when Secret bindings are present or selected.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `agent` | `requested` |
| `read` | `configuration` | `requested` |
| `read` | `service_account` | `requested` (when associated) |
| `operate` | `secret` | `requested` (when bound) |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `executionMode` | `"embedded" or "dedicated"` | No | — |
| `plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `providerId` | `string or null` | No | — |
| `serviceAccountId` | `string or null` | No | — |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.activeRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.providerId` | `string or null` | Yes | — |
| `data.serviceAccountId` | `string` | No | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/deploy`

<span id="post-namespacesnamespaceidagentsagentiddeploy"></span>

Admit an immutable revision from the Agent's saved draft

**Operation ID:** `deployAgent`

**Permissions:** Requires deploy permission on the requested Agent. Requires read permission on the requested Configuration. Requires read permission on each currently associated or newly associated ServiceAccount when present. Requires operate permission on each bound Secret when Secret bindings are present or selected. Deployment also requires the owning Agent service principal to have operate permission on each bound Secret.

| Action | Resource | Scope |
| --- | --- | --- |
| `deploy` | `agent` | `requested` |
| `read` | `configuration` | `requested` |
| `read` | `service_account` | `requested` (when associated) |
| `operate` | `secret` | `requested` (when bound) |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `202` | Accepted |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`202` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.agentId` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.compute` | `object` | Yes | — |
| `data.compute.id` | `string` | Yes | min length: 1 |
| `data.compute.implementation` | `string` | Yes | min length: 1 |
| `data.configuration` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `data.configurationGeneration` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.configurationKind` | `"agent"` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.harness` | `object` | Yes | — |
| `data.harness.id` | `string` | Yes | min length: 1 |
| `data.harness.mode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harness.version` | `string` | Yes | min length: 1 |
| `data.id` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.plugins` | `object` | No | — |
| `data.plugins.driver` | `PluginDriverIdentity` | Yes | — |
| `data.plugins.driver.id` | `string` | Yes | min length: 1 |
| `data.plugins.driver.implementation` | `string` | Yes | min length: 1 |
| `data.plugins.plugins` | `PluginDesiredState` | Yes | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.providerId` | `string or null` | Yes | — |
| `data.revision` | `integer` | Yes | minimum: 1 |
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `data.secretDriverId` | `string` | No | min length: 1 |
| `data.serviceAccount` | `object` | No | — |
| `data.serviceAccount.credential` | `object` | Yes | — |
| `data.serviceAccount.credential.kind` | `"api_key" or "access_token"` | Yes | — |
| `data.serviceAccount.credential.secretRef` | `object` | Yes | — |
| `data.serviceAccount.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data.serviceAccount.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data.serviceAccount.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`

<span id="get-namespacesnamespaceidagentsagentidruntimecredentials"></span>

Get metadata for one Agent's provisioned runtime credentials

**Operation ID:** `getAgentRuntimeCredentials`

**Permissions:** Requires read permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.modelConfigured` | `boolean` | Yes | — |
| `data.slackConfigured` | `boolean` | Yes | — |
| `data.transportConfigured` | `boolean` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`

<span id="post-namespacesnamespaceidagentsagentidruntimecredentials"></span>

Provision initial runtime credentials for one undeployed Agent

**Operation ID:** `provisionAgentRuntimeCredentials`

**Permissions:** Requires operate permission on the requested Agent. Requires read permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `operate` | `agent` | `requested` |
| `read` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `modelApiKey` | `string` | No | min length: 1; max length: 65536; pattern: `^[^\u0000]*$`; Protected Agent runtime credential value. OCC accepts at most 65,536 UTF-8 bytes and never returns the value. |
| `slack` | `object` | No | — |
| `slack.appToken` | `string` | Yes | min length: 1; max length: 65536; pattern: `^[^\u0000]*$`; Protected Agent runtime credential value. OCC accepts at most 65,536 UTF-8 bytes and never returns the value. |
| `slack.botToken` | `string` | Yes | min length: 1; max length: 65536; pattern: `^[^\u0000]*$`; Protected Agent runtime credential value. OCC accepts at most 65,536 UTF-8 bytes and never returns the value. |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.modelConfigured` | `boolean` | Yes | — |
| `data.slackConfigured` | `boolean` | Yes | — |
| `data.transportConfigured` | `boolean` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`

<span id="get-namespacesnamespaceidagentsagentidworkspacefilesname"></span>

Read an allowed workspace file from one active Agent

**Operation ID:** `getAgentWorkspaceFile`

**Permissions:** Requires read permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `name` | path | `"AGENTS.md" or "SOUL.md" or "IDENTITY.md" or "USER.md"` | Yes | — |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.content` | `string` | Yes | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.name` | `"AGENTS.md" or "SOUL.md" or "IDENTITY.md" or "USER.md"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `PUT /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`

<span id="put-namespacesnamespaceidagentsagentidworkspacefilesname"></span>

Create or replace an allowed workspace file for one active Agent

**Operation ID:** `putAgentWorkspaceFile`

**Permissions:** Requires operate permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `operate` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `name` | path | `"AGENTS.md" or "SOUL.md" or "IDENTITY.md" or "USER.md"` | Yes | — |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `content` | `string` | Yes | max length: 16384; pattern: `^[^\u0000]*$`; Workspace file content. The controller also enforces a 16 KiB UTF-8 byte limit and rejects unpaired UTF-16 surrogates. |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.name` | `"AGENTS.md" or "SOUL.md" or "IDENTITY.md" or "USER.md"` | Yes | — |
| `data.size` | `integer` | No | minimum: 0; maximum: 16384 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="agent-revisions"></span>

### Agent revisions

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/revisions`](#get-namespacesnamespaceidagentsagentidrevisions) | List authorized immutable revisions for one exact Agent |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/revisions/{revisionId}`](#get-namespacesnamespaceidagentsagentidrevisionsrevisionid) | Get an exact authorized immutable Agent revision |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/revisions`

<span id="get-namespacesnamespaceidagentsagentidrevisions"></span>

List authorized immutable revisions for one exact Agent

**Operation ID:** `listAgentRevisions`

**Permissions:** Requires read permission on the requested Agent. Only AgentRevision resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |
| `read` | `agent_revision` | `each_returned` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `array<object>` | Yes | — |
| `data[].agentId` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].compute` | `object` | Yes | — |
| `data[].compute.id` | `string` | Yes | min length: 1 |
| `data[].compute.implementation` | `string` | Yes | min length: 1 |
| `data[].configuration` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `data[].configurationGeneration` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data[].configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].configurationKind` | `"agent"` | Yes | — |
| `data[].createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data[].harness` | `object` | Yes | — |
| `data[].harness.id` | `string` | Yes | min length: 1 |
| `data[].harness.mode` | `"embedded" or "dedicated"` | Yes | — |
| `data[].harness.version` | `string` | Yes | min length: 1 |
| `data[].id` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].plugins` | `object` | No | — |
| `data[].plugins.driver` | `PluginDriverIdentity` | Yes | — |
| `data[].plugins.driver.id` | `string` | Yes | min length: 1 |
| `data[].plugins.driver.implementation` | `string` | Yes | min length: 1 |
| `data[].plugins.plugins` | `PluginDesiredState` | Yes | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data[].providerId` | `string or null` | Yes | — |
| `data[].revision` | `integer` | Yes | minimum: 1 |
| `data[].secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `data[].secretDriverId` | `string` | No | min length: 1 |
| `data[].serviceAccount` | `object` | No | — |
| `data[].serviceAccount.credential` | `object` | Yes | — |
| `data[].serviceAccount.credential.kind` | `"api_key" or "access_token"` | Yes | — |
| `data[].serviceAccount.credential.secretRef` | `object` | Yes | — |
| `data[].serviceAccount.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data[].serviceAccount.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data[].serviceAccount.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/revisions/{revisionId}`

<span id="get-namespacesnamespaceidagentsagentidrevisionsrevisionid"></span>

Get an exact authorized immutable Agent revision

**Operation ID:** `getAgentRevision`

**Permissions:** Requires read permission on the requested AgentRevision.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent_revision` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `revisionId` | path | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.agentId` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.compute` | `object` | Yes | — |
| `data.compute.id` | `string` | Yes | min length: 1 |
| `data.compute.implementation` | `string` | Yes | min length: 1 |
| `data.configuration` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `data.configurationGeneration` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.configurationKind` | `"agent"` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.harness` | `object` | Yes | — |
| `data.harness.id` | `string` | Yes | min length: 1 |
| `data.harness.mode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harness.version` | `string` | Yes | min length: 1 |
| `data.id` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.plugins` | `object` | No | — |
| `data.plugins.driver` | `PluginDriverIdentity` | Yes | — |
| `data.plugins.driver.id` | `string` | Yes | min length: 1 |
| `data.plugins.driver.implementation` | `string` | Yes | min length: 1 |
| `data.plugins.plugins` | `PluginDesiredState` | Yes | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.providerId` | `string or null` | Yes | — |
| `data.revision` | `integer` | Yes | minimum: 1 |
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `data.secretDriverId` | `string` | No | min length: 1 |
| `data.serviceAccount` | `object` | No | — |
| `data.serviceAccount.credential` | `object` | Yes | — |
| `data.serviceAccount.credential.kind` | `"api_key" or "access_token"` | Yes | — |
| `data.serviceAccount.credential.secretRef` | `object` | Yes | — |
| `data.serviceAccount.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data.serviceAccount.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data.serviceAccount.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="configurations"></span>

### Configurations

| Operation | Summary |
| --- | --- |
| [`POST /namespaces/{namespaceId}/configurations`](#post-namespacesnamespaceidconfigurations) | Create a native Namespace-owned Agent Configuration |
| [`DELETE /namespaces/{namespaceId}/configurations/{configurationId}`](#delete-namespacesnamespaceidconfigurationsconfigurationid) | Delete an exact unreferenced Namespace-owned Configuration |
| [`GET /namespaces/{namespaceId}/configurations/{configurationId}`](#get-namespacesnamespaceidconfigurationsconfigurationid) | Get an exact Namespace-owned Configuration |
| [`PATCH /namespaces/{namespaceId}/configurations/{configurationId}`](#patch-namespacesnamespaceidconfigurationsconfigurationid) | Replace values and increment an exact Namespace-owned Configuration generation |

#### `POST /namespaces/{namespaceId}/configurations`

<span id="post-namespacesnamespaceidconfigurations"></span>

Create a native Namespace-owned Agent Configuration

**Operation ID:** `createConfiguration`

**Permissions:** Requires create permission for Configuration resources in the requested Namespace. Requires operate permission on each Secret supplied in request body Secret bindings.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `configuration` | `namespace` |
| `operate` | `secret` | `request_body` (when bound) |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `kind` | `"agent"` | Yes | — |
| `secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |

##### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.generation` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data.id` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.kind` | `"agent"` | Yes | — |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `data.values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}/configurations/{configurationId}`

<span id="delete-namespacesnamespaceidconfigurationsconfigurationid"></span>

Delete an exact unreferenced Namespace-owned Configuration

**Operation ID:** `deleteConfiguration`

**Permissions:** Requires delete permission on the requested Configuration.

| Action | Resource | Scope |
| --- | --- | --- |
| `delete` | `configuration` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `configurationId` | path | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `204` | No Content |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

#### `GET /namespaces/{namespaceId}/configurations/{configurationId}`

<span id="get-namespacesnamespaceidconfigurationsconfigurationid"></span>

Get an exact Namespace-owned Configuration

**Operation ID:** `getConfiguration`

**Permissions:** Requires read permission on the requested Configuration.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `configuration` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `configurationId` | path | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.generation` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data.id` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.kind` | `"agent"` | Yes | — |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `data.values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `PATCH /namespaces/{namespaceId}/configurations/{configurationId}`

<span id="patch-namespacesnamespaceidconfigurationsconfigurationid"></span>

Replace values and increment an exact Namespace-owned Configuration generation

**Operation ID:** `updateConfiguration`

**Permissions:** Requires update permission on the requested Configuration. Requires operate permission on each Secret bound by the resulting Configuration.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `configuration` | `requested` |
| `operate` | `secret` | `requested` (when bound) |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `configurationId` | path | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.generation` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data.id` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.kind` | `"agent"` | Yes | — |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables; `OPENAI_API_KEY` is the only allowed `OPENAI_*` destination. |
| `data.values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="secrets"></span>

### Secrets

| Operation | Summary |
| --- | --- |
| [`POST /namespaces/{namespaceId}/secrets`](#post-namespacesnamespaceidsecrets) | Create exact Namespace-owned Secret material and return metadata only |
| [`DELETE /namespaces/{namespaceId}/secrets/{secretId}`](#delete-namespacesnamespaceidsecretssecretid) | Delete exact unbound Namespace-owned Secret material |
| [`GET /namespaces/{namespaceId}/secrets/{secretId}`](#get-namespacesnamespaceidsecretssecretid) | Get exact Namespace-owned Secret metadata without revealing material |
| [`PATCH /namespaces/{namespaceId}/secrets/{secretId}`](#patch-namespacesnamespaceidsecretssecretid) | Replace exact Namespace-owned Secret material and return stable metadata |

#### `POST /namespaces/{namespaceId}/secrets`

<span id="post-namespacesnamespaceidsecrets"></span>

Create exact Namespace-owned Secret material and return metadata only

**Operation ID:** `createSecret`

**Permissions:** Requires create permission for Secret resources in the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `secret` | `namespace` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `value` | `string` | Yes | min length: 1; max length: 65536; pattern: `^[^\u0000]*$`; Protected Secret value. It must be nonempty UTF-8 without NUL; OCC accepts at most 65,536 UTF-8 bytes and still enforces the route request body limit. |

##### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref` | `object` | Yes | Exact OCC Secret reference. Shape: `{ "kind": "secret", "namespaceId": "ns_...", "id": "sec_..." }`. |
| `data.ref.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref.kind` | `"secret"` | Yes | — |
| `data.ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}/secrets/{secretId}`

<span id="delete-namespacesnamespaceidsecretssecretid"></span>

Delete exact unbound Namespace-owned Secret material

**Operation ID:** `deleteSecret`

**Permissions:** Requires delete permission on the requested Secret.

| Action | Resource | Scope |
| --- | --- | --- |
| `delete` | `secret` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `secretId` | path | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `204` | No Content |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

#### `GET /namespaces/{namespaceId}/secrets/{secretId}`

<span id="get-namespacesnamespaceidsecretssecretid"></span>

Get exact Namespace-owned Secret metadata without revealing material

**Operation ID:** `getSecret`

**Permissions:** Requires read permission on the requested Secret.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `secret` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `secretId` | path | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref` | `object` | Yes | Exact OCC Secret reference. Shape: `{ "kind": "secret", "namespaceId": "ns_...", "id": "sec_..." }`. |
| `data.ref.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref.kind` | `"secret"` | Yes | — |
| `data.ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `PATCH /namespaces/{namespaceId}/secrets/{secretId}`

<span id="patch-namespacesnamespaceidsecretssecretid"></span>

Replace exact Namespace-owned Secret material and return stable metadata

**Operation ID:** `updateSecret`

**Permissions:** Requires update permission on the requested Secret.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `secret` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `secretId` | path | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `value` | `string` | Yes | min length: 1; max length: 65536; pattern: `^[^\u0000]*$`; Protected Secret value. It must be nonempty UTF-8 without NUL; OCC accepts at most 65,536 UTF-8 bytes and still enforces the route request body limit. |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref` | `object` | Yes | Exact OCC Secret reference. Shape: `{ "kind": "secret", "namespaceId": "ns_...", "id": "sec_..." }`. |
| `data.ref.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref.kind` | `"secret"` | Yes | — |
| `data.ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="service-accounts"></span>

### Service accounts

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/service-accounts`](#get-namespacesnamespaceidserviceaccounts) | List authorized Namespace-owned ServiceAccounts in one exact Namespace |
| [`POST /namespaces/{namespaceId}/service-accounts`](#post-namespacesnamespaceidserviceaccounts) | Create a native Namespace-owned ServiceAccount |
| [`DELETE /namespaces/{namespaceId}/service-accounts/{serviceAccountId}`](#delete-namespacesnamespaceidserviceaccountsserviceaccountid) | Delete an exact unreferenced Namespace-owned ServiceAccount |
| [`GET /namespaces/{namespaceId}/service-accounts/{serviceAccountId}`](#get-namespacesnamespaceidserviceaccountsserviceaccountid) | Get an exact Namespace-owned ServiceAccount |
| [`PATCH /namespaces/{namespaceId}/service-accounts/{serviceAccountId}/credential`](#patch-namespacesnamespaceidserviceaccountsserviceaccountidcredential) | Associate an exact Namespace-local credential reference with a ServiceAccount |
| [`POST /namespaces/{namespaceId}/service-accounts/{serviceAccountId}/credentials`](#post-namespacesnamespaceidserviceaccountsserviceaccountidcredentials) | Issue a managed credential for an exact Namespace-owned ServiceAccount |

#### `GET /namespaces/{namespaceId}/service-accounts`

<span id="get-namespacesnamespaceidserviceaccounts"></span>

List authorized Namespace-owned ServiceAccounts in one exact Namespace

**Operation ID:** `listServiceAccounts`

**Permissions:** Requires read permission on the requested Namespace. Only ServiceAccount resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `namespace` | `requested` |
| `read` | `service_account` | `each_returned` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `array<object>` | Yes | — |
| `data[].credential` | `object` | No | — |
| `data[].credential.kind` | `"api_key" or "access_token" or "oauth_access_token"` | Yes | — |
| `data[].credential.secretRef` | `object` | Yes | — |
| `data[].credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data[].credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data[].id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/service-accounts`

<span id="post-namespacesnamespaceidserviceaccounts"></span>

Create a native Namespace-owned ServiceAccount

**Operation ID:** `createServiceAccount`

**Permissions:** Requires create permission for ServiceAccount resources in the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `service_account` | `namespace` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.credential` | `object` | No | — |
| `data.credential.kind` | `"api_key" or "access_token" or "oauth_access_token"` | Yes | — |
| `data.credential.secretRef` | `object` | Yes | — |
| `data.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}/service-accounts/{serviceAccountId}`

<span id="delete-namespacesnamespaceidserviceaccountsserviceaccountid"></span>

Delete an exact unreferenced Namespace-owned ServiceAccount

**Operation ID:** `deleteServiceAccount`

**Permissions:** Requires delete permission on the requested ServiceAccount.

| Action | Resource | Scope |
| --- | --- | --- |
| `delete` | `service_account` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `serviceAccountId` | path | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `204` | No Content |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

#### `GET /namespaces/{namespaceId}/service-accounts/{serviceAccountId}`

<span id="get-namespacesnamespaceidserviceaccountsserviceaccountid"></span>

Get an exact Namespace-owned ServiceAccount

**Operation ID:** `getServiceAccount`

**Permissions:** Requires read permission on the requested ServiceAccount.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `service_account` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `serviceAccountId` | path | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.credential` | `object` | No | — |
| `data.credential.kind` | `"api_key" or "access_token" or "oauth_access_token"` | Yes | — |
| `data.credential.secretRef` | `object` | Yes | — |
| `data.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `PATCH /namespaces/{namespaceId}/service-accounts/{serviceAccountId}/credential`

<span id="patch-namespacesnamespaceidserviceaccountsserviceaccountidcredential"></span>

Associate an exact Namespace-local credential reference with a ServiceAccount

**Operation ID:** `updateServiceAccountCredential`

**Permissions:** Requires update permission on the requested ServiceAccount.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `service_account` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `serviceAccountId` | path | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `kind` | `"api_key" or "oauth_access_token"` | Yes | — |
| `secretRef` | `object` | Yes | — |
| `secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.credential` | `object` | No | — |
| `data.credential.kind` | `"api_key" or "access_token" or "oauth_access_token"` | Yes | — |
| `data.credential.secretRef` | `object` | Yes | — |
| `data.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/service-accounts/{serviceAccountId}/credentials`

<span id="post-namespacesnamespaceidserviceaccountsserviceaccountidcredentials"></span>

Issue a managed credential for an exact Namespace-owned ServiceAccount

**Operation ID:** `createServiceAccountCredential`

**Permissions:** Requires update permission on the requested ServiceAccount.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `service_account` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `serviceAccountId` | path | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

Schema: `object`.

##### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`201` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.credential` | `object` | No | — |
| `data.credential.kind` | `"api_key" or "access_token" or "oauth_access_token"` | Yes | — |
| `data.credential.secretRef` | `object` | Yes | — |
| `data.credential.secretRef.key` | `string` | Yes | max length: 253; pattern: `^(?![.]{1,2}$)[-._a-zA-Z0-9]+$` |
| `data.credential.secretRef.name` | `string` | Yes | max length: 253; pattern: `^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:[.][a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$` |
| `data.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="providers"></span>

### Providers

| Operation | Summary |
| --- | --- |
| [`GET /providers`](#get-providers) | List configured Providers |

#### `GET /providers`

<span id="get-providers"></span>

List configured Providers

**Operation ID:** `listProviders`

**Permissions:** Requires administer permission on the requested Installation.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `array<object>` | Yes | — |
| `data[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].type` | `"chatgpt"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Shared schemas

Reusable schema names are referenced by operation request and response tables.

| Schema | Type |
| --- | --- |
| `SafeJsonValue` | `string or boolean or number or null or array<SafeJsonValue> or object<string, SafeJsonValue>` |
| `PluginDriverIdentity` | `object` |
| `PluginToolPolicy` | `object` |
| `PluginDesiredSelection` | `object` |
| `PluginDesiredState` | `object<string, PluginDesiredSelection>` |
| `ErrorResponse` | `object` |
| `AgentRuntimeCredentialResponse` | `object` |
| `SecretResponse` | `object` |
