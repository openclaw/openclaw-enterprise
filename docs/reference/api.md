# Development OCC API reference

<!-- Generated from packages/contracts/openapi/occ-api.openapi.json. Do not edit directly. -->

Version `0.1.0`; OpenAPI `3.1.0`.

This reference is generated from the
[checked-in OpenAPI contract](../../packages/contracts/openapi/occ-api.openapi.json).
Run `pnpm openapi:generate` after changing an API route or schema;
`pnpm openapi:check` verifies the generated contract, this reference,
and the [API cheat sheet](cheatsheets/api.md).

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
| `error.code` | `"INVALID_REQUEST" or "UNAUTHENTICATED" or "FORBIDDEN" or "NOT_FOUND" or "METHOD_NOT_ALLOWED" or "INSTALLATION_EXISTS" or "RESOURCE_CONFLICT" or "AGENT_DELETING" or "NAMESPACE_NOT_READY" or "NAMESPACE_NOT_EMPTY" or "PAYLOAD_TOO_LARGE" or "UNSUPPORTED_MEDIA_TYPE" or "UNKNOWN_OUTCOME" or "NOT_IMPLEMENTED" or "INTERNAL_ERROR" or "DEPENDENCY_UNAVAILABLE" or "REPOSITORY_OPTIONS_UNAVAILABLE" or "MODEL_DISCOVERY_CREDENTIALS_REJECTED" or "MODEL_DISCOVERY_RATE_LIMITED" or "MODEL_DISCOVERY_UNAVAILABLE" or "MODEL_DISCOVERY_INVALID_RESPONSE" or "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED" or "PLUGIN_DISCOVERY_RATE_LIMITED" or "PLUGIN_DISCOVERY_UNAVAILABLE" or "PLUGIN_DISCOVERY_INVALID_RESPONSE" or "CHANNEL_DIRECTORY_CREDENTIALS_REJECTED" or "CHANNEL_DIRECTORY_MISSING_SCOPE" or "CHANNEL_DIRECTORY_RATE_LIMITED" or "CHANNEL_DIRECTORY_INVALID_RESPONSE" or "CHANNEL_DIRECTORY_UNAVAILABLE"` | Yes | — |
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
| [Backends](#backends) | 1 operation |
| [Installation](#installation) | 3 operations |
| [Namespaces](#namespaces) | 4 operations |
| [Agents](#agents) | 24 operations |
| [Agent deployments](#agent-deployments) | 2 operations |
| [Agent revisions](#agent-revisions) | 2 operations |
| [Configurations](#configurations) | 4 operations |
| [Credential sources](#credential-sources) | 4 operations |
| [IAM](#iam) | 8 operations |
| [Presets](#presets) | 5 operations |
| [Secrets](#secrets) | 5 operations |
| [Service accounts](#service-accounts) | 6 operations |

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

**Permissions:** Returns authenticated status, public account identity, and a noncredential sessionKey that stays stable across reads and changes for a new session, or null without a valid session; session tokens and credentials are never returned.

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

<span id="backends"></span>

### Backends

| Operation | Summary |
| --- | --- |
| [`GET /backends`](#get-backends) | List configured Backends (experimental) |

#### `GET /backends`

<span id="get-backends"></span>

List configured Backends (experimental)

**Operation ID:** `listBackends`

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
| `data[].type` | `"chatgpt" or "github" or "openshell"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="installation"></span>

### Installation

| Operation | Summary |
| --- | --- |
| [`GET /installation`](#get-installation) | Get the singleton Installation |
| [`POST /installation/bootstrap`](#post-installationbootstrap) | Bootstrap the singleton Installation |
| [`GET /installation/deployment-inventory`](#get-installationdeploymentinventory) | Get the complete authorized Agent deployment inventory |

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
| `data.capabilities` | `object` | No | — |
| `data.capabilities.agentProvisioning` | `object` | No | — |
| `data.capabilities.agentProvisioning.executionModes` | `array<"embedded" or "dedicated">` | Yes | min items: 1; max items: 2 |
| `data.capabilities.pluginDiscovery` | `object` | No | — |
| `data.capabilities.pluginDiscovery.credential` | `"required" or "none"` | Yes | — |
| `data.capabilities.pluginPolicies` | `object` | No | — |
| `data.capabilities.pluginPolicies.approvers` | `object` | No | — |
| `data.capabilities.pluginPolicies.approvers.agent` | `boolean` | Yes | — |
| `data.capabilities.pluginPolicies.approvers.plugin` | `boolean` | Yes | — |
| `data.capabilities.pluginPolicies.approvers.tools` | `boolean` | Yes | — |
| `data.capabilities.pluginPolicies.driver` | `PluginDriverIdentity` | Yes | — |
| `data.capabilities.pluginPolicies.driver.id` | `string` | Yes | min length: 1 |
| `data.capabilities.pluginPolicies.driver.implementation` | `string` | Yes | min length: 1 |
| `data.capabilities.pluginPolicies.driverPolicySchema` | `object<string, any>` | Yes | — |
| `data.capabilities.pluginPolicies.toolDefaults` | `object` | Yes | — |
| `data.capabilities.pluginPolicies.toolDefaults.approval` | `array<"provider_default" or "all_actions" or "write_actions" or "none">` | Yes | — |
| `data.capabilities.pluginPolicies.toolDefaults.enabled` | `boolean` | Yes | — |
| `data.capabilities.pluginPolicies.toolDefaults.reviewer` | `array<"human" or "auto">` | Yes | — |
| `data.capabilities.pluginPolicies.tools` | `object` | Yes | — |
| `data.capabilities.pluginPolicies.tools.approval` | `array<"provider_default" or "all_actions" or "write_actions" or "none">` | Yes | — |
| `data.capabilities.pluginPolicies.tools.enabled` | `boolean` | Yes | — |
| `data.capabilities.pluginPolicies.tools.reviewer` | `array<"human" or "auto">` | Yes | — |
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
| `data.capabilities` | `object` | No | — |
| `data.capabilities.agentProvisioning` | `object` | No | — |
| `data.capabilities.agentProvisioning.executionModes` | `array<"embedded" or "dedicated">` | Yes | min items: 1; max items: 2 |
| `data.capabilities.pluginDiscovery` | `object` | No | — |
| `data.capabilities.pluginDiscovery.credential` | `"required" or "none"` | Yes | — |
| `data.capabilities.pluginPolicies` | `object` | No | — |
| `data.capabilities.pluginPolicies.approvers` | `object` | No | — |
| `data.capabilities.pluginPolicies.approvers.agent` | `boolean` | Yes | — |
| `data.capabilities.pluginPolicies.approvers.plugin` | `boolean` | Yes | — |
| `data.capabilities.pluginPolicies.approvers.tools` | `boolean` | Yes | — |
| `data.capabilities.pluginPolicies.driver` | `PluginDriverIdentity` | Yes | — |
| `data.capabilities.pluginPolicies.driver.id` | `string` | Yes | min length: 1 |
| `data.capabilities.pluginPolicies.driver.implementation` | `string` | Yes | min length: 1 |
| `data.capabilities.pluginPolicies.driverPolicySchema` | `object<string, any>` | Yes | — |
| `data.capabilities.pluginPolicies.toolDefaults` | `object` | Yes | — |
| `data.capabilities.pluginPolicies.toolDefaults.approval` | `array<"provider_default" or "all_actions" or "write_actions" or "none">` | Yes | — |
| `data.capabilities.pluginPolicies.toolDefaults.enabled` | `boolean` | Yes | — |
| `data.capabilities.pluginPolicies.toolDefaults.reviewer` | `array<"human" or "auto">` | Yes | — |
| `data.capabilities.pluginPolicies.tools` | `object` | Yes | — |
| `data.capabilities.pluginPolicies.tools.approval` | `array<"provider_default" or "all_actions" or "write_actions" or "none">` | Yes | — |
| `data.capabilities.pluginPolicies.tools.enabled` | `boolean` | Yes | — |
| `data.capabilities.pluginPolicies.tools.reviewer` | `array<"human" or "auto">` | Yes | — |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.id` | `string` | Yes | pattern: `^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /installation/deployment-inventory`

<span id="get-installationdeploymentinventory"></span>

Get the complete authorized Agent deployment inventory

**Operation ID:** `getInstallationDeploymentInventory`

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
| `data` | `object` | Yes | — |
| `data.installationId` | `string` | Yes | pattern: `^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.namespaces` | `array<object>` | Yes | — |
| `data.namespaces[].agents` | `array<object>` | Yes | — |
| `data.namespaces[].agents[].activeRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.namespaces[].agents[].deploymentInProgress` | `boolean` | Yes | — |
| `data.namespaces[].agents[].desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data.namespaces[].agents[].executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.namespaces[].agents[].id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.namespaces[].agents[].status` | `"active" or "deleting"` | Yes | — |
| `data.namespaces[].id` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.namespaces[].status` | `"provisioning" or "ready" or "failed" or "deleting"` | Yes | — |
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
| [`POST /namespaces/{namespaceId}/agents/models`](#post-namespacesnamespaceidagentsmodels) | List provider models for Agent creation without storing the supplied credential |
| [`POST /namespaces/{namespaceId}/agents/plugins`](#post-namespacesnamespaceidagentsplugins) | List or search available plugins for Agent creation using the selected Driver |
| [`POST /namespaces/{namespaceId}/agents/plugins/details`](#post-namespacesnamespaceidagentspluginsdetails) | Read plugin details using the selected Driver |
| [`POST /namespaces/{namespaceId}/agents/provision`](#post-namespacesnamespaceidagentsprovision) | Create a new Agent and queue first-time provisioning |
| [`GET /namespaces/{namespaceId}/agents/provision/{workId}`](#get-namespacesnamespaceidagentsprovisionworkid) | Get first-time provisioning status for one exact work item |
| [`POST /namespaces/{namespaceId}/agents/provision/{workId}/retry`](#post-namespacesnamespaceidagentsprovisionworkidretry) | Retry failed first-time provisioning for one exact work item |
| [`GET /namespaces/{namespaceId}/agents/repository-options`](#get-namespacesnamespaceidagentsrepositoryoptions) | List approved repository choices for Agent creation in one Namespace |
| [`DELETE /namespaces/{namespaceId}/agents/{agentId}`](#delete-namespacesnamespaceidagentsagentid) | Begin deletion of an exact Namespace-owned Agent and its AgentRevisions |
| [`GET /namespaces/{namespaceId}/agents/{agentId}`](#get-namespacesnamespaceidagentsagentid) | Get an exact Namespace-owned Agent |
| [`PATCH /namespaces/{namespaceId}/agents/{agentId}`](#patch-namespacesnamespaceidagentsagentid) | Replace an exact Namespace-owned Agent's editable draft |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/deploy`](#post-namespacesnamespaceidagentsagentiddeploy) | Admit an immutable revision from the Agent's saved draft |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/native-admin`](#get-namespacesnamespaceidagentsagentidnativeadmin) | Resolve native admin UI launch availability for one Agent |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/plugins`](#post-namespacesnamespaceidagentsagentidplugins) | List or search plugins for an active Agent; caller needs Agent read/update. Curated discovery needs no Secret; hosted discovery needs the Agent's bound Service Accounts Secret with caller and Agent Secret operate grants |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/plugins/capabilities`](#get-namespacesnamespaceidagentsagentidpluginscapabilities) | Read selected Plugin Driver policy capabilities for an active Agent with caller Agent read/update permission |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/plugins/details`](#post-namespacesnamespaceidagentsagentidpluginsdetails) | Read plugin details for an active Agent; caller needs Agent read/update. Curated discovery needs no Secret; hosted discovery needs the Agent's bound Service Accounts Secret with caller and Agent Secret operate grants |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`](#get-namespacesnamespaceidagentsagentidruntimecredentials) | Get metadata for one Agent's provisioned runtime credentials |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`](#post-namespacesnamespaceidagentsagentidruntimecredentials) | Provision initial runtime credentials for one undeployed Agent |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/runtime-images`](#get-namespacesnamespaceidagentsagentidruntimeimages) | Read observed images and source commits for an Agent's active runtime |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/stop`](#post-namespacesnamespaceidagentsagentidstop) | Stop one Agent while retaining its revision and persistent state |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`](#get-namespacesnamespaceidagentsagentidworkspacefilesname) | Read an allowed workspace file from one active Agent |
| [`PUT /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`](#put-namespacesnamespaceidagentsagentidworkspacefilesname) | Create or replace an allowed workspace file for one active Agent |
| [`POST /namespaces/{namespaceId}/channel-directory/lookup`](#post-namespacesnamespaceidchanneldirectorylookup) | Search a channel directory using an authorized Namespace Secret |

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
| `data[].backendId` | `string or null` | Yes | — |
| `data[].configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data[].desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data[].executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data[].harnessAuth` | `object or object or object or object or object or null` | Yes | — |
| `data[].id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data[].pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data[].pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data[].plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data[].repositoryBindings` | `array<object>` | No | min items: 1; max items: 16 |
| `data[].repositoryBindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data[].repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data[].servicePrincipalId` | `string` | Yes | min length: 1; max length: 200 |
| `data[].status` | `"active" or "deleting"` | Yes | — |
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
| `backendId` | `string or null` | No | — |
| `configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `executionMode` | `"embedded" or "dedicated"` | No | — |
| `harnessAuth` | `object or object or object or object or object or null` | No | — |
| `initialWorkspaceFiles` | `object` | No | — |
| `initialWorkspaceFiles.AGENTS.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.IDENTITY.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.SOUL.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.USER.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `repositoryBindings` | `array<object>` | No | max items: 16; Requested repository references and optional profiles. Omission means no bindings on create and preserves bindings on update; an empty update clears bindings. Admission requires unique repository references. |
| `repositoryBindings[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `workspaceDefaultsId` | `string` | No | pattern: `^[a-f0-9]{64}$` |

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
| `data.backendId` | `string or null` | Yes | — |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harnessAuth` | `object or object or object or object or object or null` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryBindings` | `array<object>` | No | min items: 1; max items: 16 |
| `data.repositoryBindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.servicePrincipalId` | `string` | Yes | min length: 1; max length: 200 |
| `data.status` | `"active" or "deleting"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/models`

<span id="post-namespacesnamespaceidagentsmodels"></span>

List provider models for Agent creation without storing the supplied credential

**Operation ID:** `discoverAgentModels`

**Permissions:** Requires create permission for Agent resources in the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `apiKey` | `string` | Yes | min length: 1; max length: 8192; pattern: `\S` |
| `authMethod` | `"api_key" or "codex_pat"` | Yes | — |
| `provider` | `"openai" or "anthropic"` | Yes | — |

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
| `429` | Too Many Requests |
| `500` | Internal Server Error |
| `501` | Not Implemented |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `array<object>` | Yes | — |
| `data[].id` | `string` | Yes | — |
| `data[].name` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/plugins`

<span id="post-namespacesnamespaceidagentsplugins"></span>

List or search available plugins for Agent creation using the selected Driver

**Operation ID:** `discoverAgentPlugins`

**Permissions:** Requires create permission for Agent resources in the requested Namespace. Requires operate permission on the exact same-Namespace Secret when a Secret reference is supplied.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
| `operate` | `secret` | `request_body` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

Schema: `object or object or object`.

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
| `429` | Too Many Requests |
| `500` | Internal Server Error |
| `501` | Not Implemented |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.nextCursor` | `string or null` | Yes | — |
| `data.plugins` | `array<object>` | Yes | — |
| `data.plugins[].available` | `boolean` | No | — |
| `data.plugins[].description` | `string` | No | — |
| `data.plugins[].id` | `string` | Yes | — |
| `data.plugins[].logoUrl` | `string` | No | — |
| `data.plugins[].name` | `string` | Yes | — |
| `data.plugins[].privacyPolicyUrl` | `string` | No | — |
| `data.plugins[].remoteId` | `string` | No | — |
| `data.plugins[].selectableWithoutTools` | `boolean` | No | — |
| `data.plugins[].termsOfServiceUrl` | `string` | No | — |
| `data.plugins[].tools` | `null or array<object>` | Yes | — |
| `data.plugins[].unavailableHelp` | `object` | No | — |
| `data.plugins[].unavailableHelp.label` | `string` | Yes | — |
| `data.plugins[].unavailableHelp.url` | `string` | Yes | — |
| `data.plugins[].unavailableReason` | `string` | No | — |
| `data.plugins[].websiteUrl` | `string` | No | — |
| `data.setup` | `object` | No | — |
| `data.setup.links` | `array<object>` | Yes | — |
| `data.setup.links[].label` | `string` | Yes | — |
| `data.setup.links[].url` | `string` | Yes | — |
| `data.setup.message` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/plugins/details`

<span id="post-namespacesnamespaceidagentspluginsdetails"></span>

Read plugin details using the selected Driver

**Operation ID:** `discoverAgentPluginDetails`

**Permissions:** Requires create permission for Agent resources in the requested Namespace. Requires operate permission on the exact same-Namespace Secret when a Secret reference is supplied.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
| `operate` | `secret` | `request_body` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

Schema: `object or object or object`.

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
| `429` | Too Many Requests |
| `500` | Internal Server Error |
| `501` | Not Implemented |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.available` | `boolean` | No | — |
| `data.description` | `string` | No | — |
| `data.id` | `string` | Yes | — |
| `data.logoUrl` | `string` | No | — |
| `data.name` | `string` | Yes | — |
| `data.privacyPolicyUrl` | `string` | No | — |
| `data.remoteId` | `string` | No | — |
| `data.selectableWithoutTools` | `boolean` | No | — |
| `data.termsOfServiceUrl` | `string` | No | — |
| `data.tools` | `null or array<object>` | Yes | — |
| `data.unavailableHelp` | `object` | No | — |
| `data.unavailableHelp.label` | `string` | Yes | — |
| `data.unavailableHelp.url` | `string` | Yes | — |
| `data.unavailableReason` | `string` | No | — |
| `data.websiteUrl` | `string` | No | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/provision`

<span id="post-namespacesnamespaceidagentsprovision"></span>

Create a new Agent and queue first-time provisioning

**Operation ID:** `provisionAgent`

**Permissions:** Requires create permission for Agent resources in the requested Namespace. Requires create permission for Configuration resources in the requested Namespace. Requires read permission on each currently associated or newly associated ServiceAccount when present. Requires operate permission on each existing Secret reference supplied in provisioning inputs.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
| `create` | `configuration` | `namespace` |
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
| `backendId` | `string or null` | No | — |
| `configuration` | `object` | Yes | — |
| `configuration.kind` | `"agent"` | Yes | — |
| `configuration.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OPENAI_*`, `ANTHROPIC_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables. Model authentication belongs to Agent.harnessAuth. |
| `configuration.values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `executionMode` | `"embedded" or "dedicated"` | No | — |
| `harnessAuth` | `object or object or object or object or object or null` | No | — |
| `initialWorkspaceFiles` | `object` | No | — |
| `initialWorkspaceFiles.AGENTS.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.IDENTITY.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.SOUL.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.USER.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `repositoryBindings` | `array<object>` | No | max items: 16; Requested repository references and optional profiles. Omission means no bindings on create and preserves bindings on update; an empty update clears bindings. Admission requires unique repository references. |
| `repositoryBindings[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `workspaceDefaultsId` | `string` | No | pattern: `^[a-f0-9]{64}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `202` | Accepted |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`202` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.provisioning` | `object` | Yes | — |
| `data.provisioning.agentId` | `string` | No | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.provisioning.attemptCount` | `integer` | Yes | minimum: 0 |
| `data.provisioning.configurationId` | `string` | No | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.provisioning.error` | `object` | No | — |
| `data.provisioning.error.code` | `string` | Yes | min length: 1; max length: 64 |
| `data.provisioning.error.message` | `string` | Yes | min length: 1; max length: 256 |
| `data.provisioning.phase` | `"admitted" or "configuration" or "transport" or "handoff"` | Yes | — |
| `data.provisioning.revisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.provisioning.status` | `"queued" or "running" or "succeeded" or "failed"` | Yes | — |
| `data.provisioning.updatedAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.provisioning.url` | `string` | Yes | min length: 1 |
| `data.provisioning.workId` | `string` | Yes | min length: 1; max length: 200 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/provision/{workId}`

<span id="get-namespacesnamespaceidagentsprovisionworkid"></span>

Get first-time provisioning status for one exact work item

**Operation ID:** `getAgentProvisioning`

**Permissions:** Requires current read authorization for the accepted Agent provisioning record. Before Agent creation, only the initiating actor in the exact Namespace can use the work item.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `workId` | path | `string` | Yes | min length: 1; max length: 200; pattern: `^[A-Za-z0-9._~:@/-]{1,200}$` |

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
| `data.agentId` | `string` | No | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.attemptCount` | `integer` | Yes | minimum: 0 |
| `data.configurationId` | `string` | No | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.error` | `object` | No | — |
| `data.error.code` | `string` | Yes | min length: 1; max length: 64 |
| `data.error.message` | `string` | Yes | min length: 1; max length: 256 |
| `data.phase` | `"admitted" or "configuration" or "transport" or "handoff"` | Yes | — |
| `data.revisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.status` | `"queued" or "running" or "succeeded" or "failed"` | Yes | — |
| `data.updatedAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.url` | `string` | Yes | min length: 1 |
| `data.workId` | `string` | Yes | min length: 1; max length: 200 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/provision/{workId}/retry`

<span id="post-namespacesnamespaceidagentsprovisionworkidretry"></span>

Retry failed first-time provisioning for one exact work item

**Operation ID:** `retryAgentProvisioning`

**Permissions:** Requires current operate authorization for the accepted Agent provisioning record. Before Agent creation, only the initiating actor in the exact Namespace can use the work item.

| Action | Resource | Scope |
| --- | --- | --- |
| `operate` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `workId` | path | `string` | Yes | min length: 1; max length: 200; pattern: `^[A-Za-z0-9._~:@/-]{1,200}$` |

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
| `data.agentId` | `string` | No | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.attemptCount` | `integer` | Yes | minimum: 0 |
| `data.configurationId` | `string` | No | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.error` | `object` | No | — |
| `data.error.code` | `string` | Yes | min length: 1; max length: 64 |
| `data.error.message` | `string` | Yes | min length: 1; max length: 256 |
| `data.phase` | `"admitted" or "configuration" or "transport" or "handoff"` | Yes | — |
| `data.revisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.status` | `"queued" or "running" or "succeeded" or "failed"` | Yes | — |
| `data.updatedAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.url` | `string` | Yes | min length: 1 |
| `data.workId` | `string` | Yes | min length: 1; max length: 200 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/repository-options`

<span id="get-namespacesnamespaceidagentsrepositoryoptions"></span>

List approved repository choices for Agent creation in one Namespace

**Operation ID:** `listRepositoryOptions`

**Permissions:** Requires create permission for Agent resources in the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |

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
| `409` | Conflict |
| `500` | Internal Server Error |
| `503` | Check `error.code`: `REPOSITORY_OPTIONS_UNAVAILABLE` means optional repository discovery is unavailable after Namespace lifecycle and Agent create authorization checks. Creation without repository bindings remains available subject to fresh authorization. `DEPENDENCY_UNAVAILABLE` includes IAM and other required dependency failures and does not permit proceeding. Successful discovery returns a data array, including an empty array when no repositories are approved. |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `array<object>` | Yes | max items: 128 |
| `data[].allowedProfiles` | `array<string>` | Yes | min items: 1; max items: 16 |
| `data[].displayName` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}/agents/{agentId}`

<span id="delete-namespacesnamespaceidagentsagentid"></span>

Begin deletion of an exact Namespace-owned Agent and its AgentRevisions

**Operation ID:** `deleteAgent`

**Permissions:** Requires delete permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `delete` | `agent` | `requested` |

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
| `data.activeRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.backendId` | `string or null` | Yes | — |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harnessAuth` | `object or object or object or object or object or null` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryBindings` | `array<object>` | No | min items: 1; max items: 16 |
| `data.repositoryBindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.servicePrincipalId` | `string` | Yes | min length: 1; max length: 200 |
| `data.status` | `"active" or "deleting"` | Yes | — |
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
| `data.backendId` | `string or null` | Yes | — |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harnessAuth` | `object or object or object or object or object or null` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryBindings` | `array<object>` | No | min items: 1; max items: 16 |
| `data.repositoryBindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.servicePrincipalId` | `string` | Yes | min length: 1; max length: 200 |
| `data.status` | `"active" or "deleting"` | Yes | — |
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
| `backendId` | `string or null` | No | — |
| `configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `executionMode` | `"embedded" or "dedicated"` | No | — |
| `harnessAuth` | `object or object or object or object or object or null` | No | — |
| `pluginApprovers` | `PluginApprovers or null` | No | — |
| `plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `repositoryBindings` | `array<object>` | No | max items: 16; Requested repository references and optional profiles. Omission means no bindings on create and preserves bindings on update; an empty update clears bindings. Admission requires unique repository references. |
| `repositoryBindings[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |

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
| `data.backendId` | `string or null` | Yes | — |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harnessAuth` | `object or object or object or object or object or null` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryBindings` | `array<object>` | No | min items: 1; max items: 16 |
| `data.repositoryBindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.servicePrincipalId` | `string` | Yes | min length: 1; max length: 200 |
| `data.status` | `"active" or "deleting"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/deploy`

<span id="post-namespacesnamespaceidagentsagentiddeploy"></span>

Admit an immutable revision from the Agent's saved draft

**Operation ID:** `deployAgent`

**Permissions:** Requires deploy permission on the requested Agent. Requires read permission on the requested Configuration. Requires read permission on the Agent when the selected Compute Driver must generate missing runtime credentials for its first deployment. Requires operate permission on the Agent when the selected Compute Driver must generate missing runtime credentials for its first deployment. Requires read permission on each currently associated or newly associated ServiceAccount when present. Requires operate permission on each bound Secret when Secret bindings are present or selected. Deployment also requires the owning Agent service principal to have operate permission on each bound Secret.

| Action | Resource | Scope |
| --- | --- | --- |
| `deploy` | `agent` | `requested` |
| `read` | `configuration` | `requested` |
| `read` | `agent` | `requested` |
| `operate` | `agent` | `requested` |
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
| `data.backendId` | `string or null` | Yes | — |
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
| `data.harnessAuth` | `object or object or object or object or object` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `object` | No | — |
| `data.plugins.driver` | `PluginDriverIdentity` | Yes | — |
| `data.plugins.driver.id` | `string` | Yes | min length: 1 |
| `data.plugins.driver.implementation` | `string` | Yes | min length: 1 |
| `data.plugins.plugins` | `PluginDesiredState` | Yes | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryCredentials` | `object` | No | — |
| `data.repositoryCredentials.bindings` | `array<object>` | Yes | min items: 1; max items: 16 |
| `data.repositoryCredentials.bindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryCredentials.bindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryCredentials.deadlineWallMs` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data.repositoryCredentials.driver` | `object` | Yes | — |
| `data.repositoryCredentials.driver.id` | `string` | Yes | min length: 1 |
| `data.repositoryCredentials.driver.implementation` | `string` | Yes | min length: 1 |
| `data.revision` | `integer` | Yes | minimum: 1 |
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OPENAI_*`, `ANTHROPIC_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables. Model authentication belongs to Agent.harnessAuth. |
| `data.secretDriverId` | `string` | No | min length: 1 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/native-admin`

<span id="get-namespacesnamespaceidagentsagentidnativeadmin"></span>

Resolve native admin UI launch availability for one Agent

**Operation ID:** `getAgentNativeAdmin`

**Permissions:** Requires a human session with administer permission on the exact Agent. Service API keys cannot launch or inspect native admin UI access.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | min length: 1; max length: 200 |
| `agentId` | path | `string` | Yes | min length: 1; max length: 200 |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.activeRevisionId` | `string` | No | — |
| `data.host` | `string` | No | — |
| `data.origin` | `string (uri)` | No | — |
| `data.status` | `"available" or "disabled" or "stopped" or "unavailable" or "unsupported"` | Yes | — |
| `data.url` | `string (uri)` | No | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/plugins`

<span id="post-namespacesnamespaceidagentsagentidplugins"></span>

List or search plugins for an active Agent; caller needs Agent read/update. Curated discovery needs no Secret; hosted discovery needs the Agent's bound Service Accounts Secret with caller and Agent Secret operate grants

**Operation ID:** `discoverSavedAgentPlugins`

**Permissions:** Requires update permission on the requested Agent. Requires read permission on the requested Agent. Requires operate permission on the Agent's bound Secret when the selected Plugin Driver requires a discovery credential.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `agent` | `requested` |
| `read` | `agent` | `requested` |
| `operate` | `secret` | `requested` |

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
| `cursor` | `string` | No | min length: 1; max length: 8192 |
| `q` | `string` | No | max length: 1024 |

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
| `429` | Too Many Requests |
| `500` | Internal Server Error |
| `501` | Not Implemented |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.nextCursor` | `string or null` | Yes | — |
| `data.plugins` | `array<object>` | Yes | — |
| `data.plugins[].available` | `boolean` | No | — |
| `data.plugins[].description` | `string` | No | — |
| `data.plugins[].id` | `string` | Yes | — |
| `data.plugins[].logoUrl` | `string` | No | — |
| `data.plugins[].name` | `string` | Yes | — |
| `data.plugins[].privacyPolicyUrl` | `string` | No | — |
| `data.plugins[].remoteId` | `string` | No | — |
| `data.plugins[].selectableWithoutTools` | `boolean` | No | — |
| `data.plugins[].termsOfServiceUrl` | `string` | No | — |
| `data.plugins[].tools` | `null or array<object>` | Yes | — |
| `data.plugins[].unavailableHelp` | `object` | No | — |
| `data.plugins[].unavailableHelp.label` | `string` | Yes | — |
| `data.plugins[].unavailableHelp.url` | `string` | Yes | — |
| `data.plugins[].unavailableReason` | `string` | No | — |
| `data.plugins[].websiteUrl` | `string` | No | — |
| `data.setup` | `object` | No | — |
| `data.setup.links` | `array<object>` | Yes | — |
| `data.setup.links[].label` | `string` | Yes | — |
| `data.setup.links[].url` | `string` | Yes | — |
| `data.setup.message` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/plugins/capabilities`

<span id="get-namespacesnamespaceidagentsagentidpluginscapabilities"></span>

Read selected Plugin Driver policy capabilities for an active Agent with caller Agent read/update permission

**Operation ID:** `getSavedAgentPluginPolicyCapabilities`

**Permissions:** Requires update permission on the requested Agent. Requires read permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `agent` | `requested` |
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
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `501` | Not Implemented |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.approvers` | `object` | No | — |
| `data.approvers.agent` | `boolean` | Yes | — |
| `data.approvers.plugin` | `boolean` | Yes | — |
| `data.approvers.tools` | `boolean` | Yes | — |
| `data.discoveryCredential` | `"required" or "none"` | Yes | — |
| `data.driver` | `PluginDriverIdentity` | Yes | — |
| `data.driver.id` | `string` | Yes | min length: 1 |
| `data.driver.implementation` | `string` | Yes | min length: 1 |
| `data.driverPolicySchema` | `object<string, any>` | Yes | — |
| `data.toolDefaults` | `object` | Yes | — |
| `data.toolDefaults.approval` | `array<"provider_default" or "all_actions" or "write_actions" or "none">` | Yes | — |
| `data.toolDefaults.enabled` | `boolean` | Yes | — |
| `data.toolDefaults.reviewer` | `array<"human" or "auto">` | Yes | — |
| `data.tools` | `object` | Yes | — |
| `data.tools.approval` | `array<"provider_default" or "all_actions" or "write_actions" or "none">` | Yes | — |
| `data.tools.enabled` | `boolean` | Yes | — |
| `data.tools.reviewer` | `array<"human" or "auto">` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/plugins/details`

<span id="post-namespacesnamespaceidagentsagentidpluginsdetails"></span>

Read plugin details for an active Agent; caller needs Agent read/update. Curated discovery needs no Secret; hosted discovery needs the Agent's bound Service Accounts Secret with caller and Agent Secret operate grants

**Operation ID:** `discoverSavedAgentPluginDetails`

**Permissions:** Requires update permission on the requested Agent. Requires read permission on the requested Agent. Requires operate permission on the Agent's bound Secret when the selected Plugin Driver requires a discovery credential.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `agent` | `requested` |
| `read` | `agent` | `requested` |
| `operate` | `secret` | `requested` |

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
| `pluginId` | `string` | Yes | min length: 1; max length: 256 |

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
| `429` | Too Many Requests |
| `500` | Internal Server Error |
| `501` | Not Implemented |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.available` | `boolean` | No | — |
| `data.description` | `string` | No | — |
| `data.id` | `string` | Yes | — |
| `data.logoUrl` | `string` | No | — |
| `data.name` | `string` | Yes | — |
| `data.privacyPolicyUrl` | `string` | No | — |
| `data.remoteId` | `string` | No | — |
| `data.selectableWithoutTools` | `boolean` | No | — |
| `data.termsOfServiceUrl` | `string` | No | — |
| `data.tools` | `null or array<object>` | Yes | — |
| `data.unavailableHelp` | `object` | No | — |
| `data.unavailableHelp.label` | `string` | Yes | — |
| `data.unavailableHelp.url` | `string` | Yes | — |
| `data.unavailableReason` | `string` | No | — |
| `data.websiteUrl` | `string` | No | — |
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

Schema: `object`.

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
| `data.transportConfigured` | `boolean` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/runtime-images`

<span id="get-namespacesnamespaceidagentsagentidruntimeimages"></span>

Read observed images and source commits for an Agent's active runtime

**Operation ID:** `getAgentRuntimeImages`

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
| `data.images` | `array<object>` | Yes | — |
| `data.images[].commit` | `string or null` | Yes | — |
| `data.images[].container` | `string` | Yes | — |
| `data.images[].image` | `string` | Yes | — |
| `data.images[].imageId` | `string or null` | Yes | — |
| `data.images[].openclawCommit` | `string or null` | Yes | — |
| `data.images[].workload` | `string` | Yes | — |
| `data.status` | `"observed" or "undeployed" or "unsupported"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/stop`

<span id="post-namespacesnamespaceidagentsagentidstop"></span>

Stop one Agent while retaining its revision and persistent state

**Operation ID:** `stopAgent`

**Permissions:** Requires operate permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `operate` | `agent` | `requested` |

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
| `data.activeRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.backendId` | `string or null` | Yes | — |
| `data.configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harnessAuth` | `object or object or object or object or object or null` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryBindings` | `array<object>` | No | min items: 1; max items: 16 |
| `data.repositoryBindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.servicePrincipalId` | `string` | Yes | min length: 1; max length: 200 |
| `data.status` | `"active" or "deleting"` | Yes | — |
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
| `503` | Service Unavailable. Check `error.code`: `DEPENDENCY_UNAVAILABLE` means workspace access is unavailable. `UNKNOWN_OUTCOME` means OCC could not confirm the write or its audit record; the file may already contain the requested content. Read the same file with `GET` and compare its content before deciding whether to retry. If the content matches, do not retry. If you cannot read it, wait or ask someone with `read` permission on the Agent to check. |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.name` | `"AGENTS.md" or "SOUL.md" or "IDENTITY.md" or "USER.md"` | Yes | — |
| `data.size` | `integer` | No | minimum: 0; maximum: 16384 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/channel-directory/lookup`

<span id="post-namespacesnamespaceidchanneldirectorylookup"></span>

Search a channel directory using an authorized Namespace Secret

**Operation ID:** `lookupChannelDirectory`

**Permissions:** Requires operate permission on the exact Secret named by secretId. Without an edit target, requires Agent create permission in the Namespace. With agentId, requires update permission on that exact Agent. With configurationId, requires update permission on that exact Configuration.

| Action | Resource | Scope |
| --- | --- | --- |
| `operate` | `secret` | `request_body` |
| `create` | `agent` | `namespace` |
| `update` | `agent` | `request_body` |
| `update` | `configuration` | `request_body` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

Schema: `object or object or object or object or object or object`.

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
| `429` | Too Many Requests |
| `500` | Internal Server Error |
| `501` | Not Implemented |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.candidates` | `array<object>` | Yes | max items: 100 |
| `data.candidates[].displayName` | `string` | No | min length: 1; max length: 200 |
| `data.candidates[].id` | `string` | Yes | min length: 1; max length: 200 |
| `data.candidates[].name` | `string` | Yes | min length: 1; max length: 200 |
| `data.complete` | `boolean` | Yes | — |
| `data.nextCursor` | `string` | No | min length: 1; max length: 2048 |
| `data.workspaceId` | `string` | Yes | min length: 1; max length: 200 |
| `data.workspaceName` | `string` | No | min length: 1; max length: 200 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="agent-deployments"></span>

### Agent deployments

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}`](#get-namespacesnamespaceidagentsagentiddeploymentsdeploymentid) | Get the durable deployment status for one admitted Agent revision |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}/diagnostics`](#post-namespacesnamespaceidagentsagentiddeploymentsdeploymentiddiagnostics) | Run explicit current-runtime diagnostics for one exact Agent revision |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}`

<span id="get-namespacesnamespaceidagentsagentiddeploymentsdeploymentid"></span>

Get the durable deployment status for one admitted Agent revision

**Operation ID:** `getAgentDeployment`

**Permissions:** Requires read permission on the requested AgentRevision.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent_revision` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `deploymentId` | path | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `data.deploymentId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.error` | `null or object` | Yes | Null unless deployment failed. A failure contains code, a fixed safe message, and optional allowlisted data. CONVERGENCE_DEADLINE_EXCEEDED may include data.timeoutMs and data.runtimeFailure with bounded startup-failure evidence. Native error text is never returned. |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.status` | `"queued" or "running" or "succeeded" or "failed"` | Yes | — |
| `data.warnings` | `array<object>` | Yes | Warnings recorded from this deployment startup. Plugin install and connector-auth warnings mean the deployment succeeded after the runtime disabled the affected admitted plugin for that startup. |
| `data.warnings[].code` | `"PLUGIN_INSTALL_FAILED" or "PLUGIN_AUTH_REQUIRED"` | Yes | — |
| `data.warnings[].pluginId` | `string` | Yes | min length: 1; max length: 253; pattern: `^[A-Za-z0-9._~:@-]{1,253}$`; The admitted Agent plugin selection key. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}/diagnostics`

<span id="post-namespacesnamespaceidagentsagentiddeploymentsdeploymentiddiagnostics"></span>

Run explicit current-runtime diagnostics for one exact Agent revision

**Operation ID:** `diagnoseAgentDeployment`

**Permissions:** Requires operate permission on the requested Agent. Requires read permission on the requested Agent. Requires read permission on the requested AgentRevision.

| Action | Resource | Scope |
| --- | --- | --- |
| `operate` | `agent` | `requested` |
| `read` | `agent` | `requested` |
| `read` | `agent_revision` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `deploymentId` | path | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.checks` | `array<object>` | Yes | max items: 32 |
| `data.checks[].check` | `string` | Yes | min length: 1; max length: 64; pattern: `^[A-Za-z0-9._~:@-]{1,64}$` |
| `data.checks[].checkedAt` | `string (date-time) or null` | Yes | — |
| `data.checks[].code` | `string` | No | min length: 1; max length: 64; pattern: `^[A-Za-z0-9._~:@-]{1,64}$` |
| `data.checks[].component` | `string` | Yes | min length: 1; max length: 64; pattern: `^[A-Za-z0-9._~:@-]{1,64}$` |
| `data.checks[].state` | `"succeeded" or "failed" or "unknown"` | Yes | — |
| `data.observedAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
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
| `data[].backendId` | `string or null` | Yes | — |
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
| `data[].harnessAuth` | `object or object or object or object or object` | Yes | — |
| `data[].id` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data[].pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data[].pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data[].plugins` | `object` | No | — |
| `data[].plugins.driver` | `PluginDriverIdentity` | Yes | — |
| `data[].plugins.driver.id` | `string` | Yes | min length: 1 |
| `data[].plugins.driver.implementation` | `string` | Yes | min length: 1 |
| `data[].plugins.plugins` | `PluginDesiredState` | Yes | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data[].repositoryCredentials` | `object` | No | — |
| `data[].repositoryCredentials.bindings` | `array<object>` | Yes | min items: 1; max items: 16 |
| `data[].repositoryCredentials.bindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data[].repositoryCredentials.bindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data[].repositoryCredentials.deadlineWallMs` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data[].repositoryCredentials.driver` | `object` | Yes | — |
| `data[].repositoryCredentials.driver.id` | `string` | Yes | min length: 1 |
| `data[].repositoryCredentials.driver.implementation` | `string` | Yes | min length: 1 |
| `data[].revision` | `integer` | Yes | minimum: 1 |
| `data[].secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OPENAI_*`, `ANTHROPIC_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables. Model authentication belongs to Agent.harnessAuth. |
| `data[].secretDriverId` | `string` | No | min length: 1 |
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
| `data.backendId` | `string or null` | Yes | — |
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
| `data.harnessAuth` | `object or object or object or object or object` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `object` | No | — |
| `data.plugins.driver` | `PluginDriverIdentity` | Yes | — |
| `data.plugins.driver.id` | `string` | Yes | min length: 1 |
| `data.plugins.driver.implementation` | `string` | Yes | min length: 1 |
| `data.plugins.plugins` | `PluginDesiredState` | Yes | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryCredentials` | `object` | No | — |
| `data.repositoryCredentials.bindings` | `array<object>` | Yes | min items: 1; max items: 16 |
| `data.repositoryCredentials.bindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryCredentials.bindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryCredentials.deadlineWallMs` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data.repositoryCredentials.driver` | `object` | Yes | — |
| `data.repositoryCredentials.driver.id` | `string` | Yes | min length: 1 |
| `data.repositoryCredentials.driver.implementation` | `string` | Yes | min length: 1 |
| `data.revision` | `integer` | Yes | minimum: 1 |
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OPENAI_*`, `ANTHROPIC_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables. Model authentication belongs to Agent.harnessAuth. |
| `data.secretDriverId` | `string` | No | min length: 1 |
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
| `secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OPENAI_*`, `ANTHROPIC_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables. Model authentication belongs to Agent.harnessAuth. |
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
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OPENAI_*`, `ANTHROPIC_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables. Model authentication belongs to Agent.harnessAuth. |
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
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OPENAI_*`, `ANTHROPIC_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables. Model authentication belongs to Agent.harnessAuth. |
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
| `secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OPENAI_*`, `ANTHROPIC_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables. Model authentication belongs to Agent.harnessAuth. |
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
| `data.secretBindings` | `object<string, object>` | No | Optional Secret binding map. Keys are destination environment variable names; at most 64 bindings are accepted. Each value must contain `source.kind`, `source.namespaceId`, and `source.id`, and may contain `delivery.type: "env"`. Admission rejects reserved or process-control destinations such as `OPENCLAW_*`, `CODEX_*`, `OPENAI_*`, `ANTHROPIC_*`, `OCC_*`, `KUBERNETES_*`, `PATH`, `HOME`, and proxy variables. Model authentication belongs to Agent.harnessAuth. |
| `data.values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="credential-sources"></span>

### Credential sources

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/credential-sources`](#get-namespacesnamespaceidcredentialsources) | List readable credential sources without revealing credential values |
| [`POST /namespaces/{namespaceId}/credential-sources`](#post-namespacesnamespaceidcredentialsources) | Register a credential source with the selected Credential Gateway |
| [`DELETE /namespaces/{namespaceId}/credential-sources/{credentialSourceId}`](#delete-namespacesnamespaceidcredentialsourcescredentialsourceid) | Remove an unreferenced credential source from the Credential Gateway |
| [`GET /namespaces/{namespaceId}/credential-sources/{credentialSourceId}`](#get-namespacesnamespaceidcredentialsourcescredentialsourceid) | Get one credential source and its live Credential Gateway status |

#### `GET /namespaces/{namespaceId}/credential-sources`

<span id="get-namespacesnamespaceidcredentialsources"></span>

List readable credential sources without revealing credential values

**Operation ID:** `listCredentialSources`

**Permissions:** Requires read permission for CredentialSource resources in the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `credential_source` | `namespace` |

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
| `data[].config` | `object<string, string>` | Yes | Non-secret source configuration keyed by catalog field name. |
| `data[].id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].ref` | `object` | Yes | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data[].ref.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].ref.kind` | `"credential_source"` | Yes | — |
| `data[].ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].secrets` | `object<string, object>` | Yes | Secret inputs keyed by catalog field name. Each value references an OCC Secret in the same Namespace; OCC never returns its value. |
| `data[].state` | `"registering" or "ready" or "deleting"` | Yes | — |
| `data[].status` | `object` | No | Live status reported by the selected Credential Gateway. It never contains credential values. |
| `data[].status.reason` | `string` | No | max length: 512 |
| `data[].status.state` | `"ready" or "pending" or "failed" or "absent"` | Yes | — |
| `data[].type` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9-]{0,63}$`; Source type from the selected Credential Gateway catalog, for example `openai`. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/credential-sources`

<span id="post-namespacesnamespaceidcredentialsources"></span>

Register a credential source with the selected Credential Gateway

**Operation ID:** `createCredentialSource`

**Permissions:** Requires create permission for CredentialSource resources in the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `credential_source` | `namespace` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `config` | `object<string, string>` | No | Non-secret source configuration keyed by catalog field name. |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `secrets` | `object<string, object>` | No | Secret inputs keyed by catalog field name. Each value references an OCC Secret in the same Namespace; OCC never returns its value. |
| `type` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9-]{0,63}$`; Source type from the selected Credential Gateway catalog, for example `openai`. |

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
| `data.config` | `object<string, string>` | Yes | Non-secret source configuration keyed by catalog field name. |
| `data.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref` | `object` | Yes | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data.ref.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref.kind` | `"credential_source"` | Yes | — |
| `data.ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secrets` | `object<string, object>` | Yes | Secret inputs keyed by catalog field name. Each value references an OCC Secret in the same Namespace; OCC never returns its value. |
| `data.state` | `"registering" or "ready" or "deleting"` | Yes | — |
| `data.status` | `object` | No | Live status reported by the selected Credential Gateway. It never contains credential values. |
| `data.status.reason` | `string` | No | max length: 512 |
| `data.status.state` | `"ready" or "pending" or "failed" or "absent"` | Yes | — |
| `data.type` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9-]{0,63}$`; Source type from the selected Credential Gateway catalog, for example `openai`. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}/credential-sources/{credentialSourceId}`

<span id="delete-namespacesnamespaceidcredentialsourcescredentialsourceid"></span>

Remove an unreferenced credential source from the Credential Gateway

**Operation ID:** `deleteCredentialSource`

**Permissions:** Requires delete permission on the requested CredentialSource.

| Action | Resource | Scope |
| --- | --- | --- |
| `delete` | `credential_source` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `credentialSourceId` | path | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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

#### `GET /namespaces/{namespaceId}/credential-sources/{credentialSourceId}`

<span id="get-namespacesnamespaceidcredentialsourcescredentialsourceid"></span>

Get one credential source and its live Credential Gateway status

**Operation ID:** `getCredentialSource`

**Permissions:** Requires read permission on the requested CredentialSource.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `credential_source` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `credentialSourceId` | path | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `data.config` | `object<string, string>` | Yes | Non-secret source configuration keyed by catalog field name. |
| `data.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref` | `object` | Yes | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data.ref.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref.kind` | `"credential_source"` | Yes | — |
| `data.ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secrets` | `object<string, object>` | Yes | Secret inputs keyed by catalog field name. Each value references an OCC Secret in the same Namespace; OCC never returns its value. |
| `data.state` | `"registering" or "ready" or "deleting"` | Yes | — |
| `data.status` | `object` | No | Live status reported by the selected Credential Gateway. It never contains credential values. |
| `data.status.reason` | `string` | No | max length: 512 |
| `data.status.state` | `"ready" or "pending" or "failed" or "absent"` | Yes | — |
| `data.type` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9-]{0,63}$`; Source type from the selected Credential Gateway catalog, for example `openai`. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="iam"></span>

### IAM

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/iam/access-bindings`](#get-namespacesnamespaceidiamaccessbindings) | List exact Namespace IAM AccessBindings |
| [`POST /namespaces/{namespaceId}/iam/access-bindings`](#post-namespacesnamespaceidiamaccessbindings) | Create an immutable exact-resource Namespace IAM AccessBinding |
| [`DELETE /namespaces/{namespaceId}/iam/access-bindings/{bindingId}`](#delete-namespacesnamespaceidiamaccessbindingsbindingid) | Delete one exact Namespace IAM AccessBinding |
| [`GET /namespaces/{namespaceId}/iam/access-bindings/{bindingId}`](#get-namespacesnamespaceidiamaccessbindingsbindingid) | Get an exact Namespace IAM AccessBinding |
| [`GET /namespaces/{namespaceId}/iam/roles`](#get-namespacesnamespaceidiamroles) | List exact Namespace IAM Roles |
| [`POST /namespaces/{namespaceId}/iam/roles`](#post-namespacesnamespaceidiamroles) | Create an immutable Namespace IAM Role |
| [`DELETE /namespaces/{namespaceId}/iam/roles/{roleId}`](#delete-namespacesnamespaceidiamrolesroleid) | Delete an unreferenced exact Namespace IAM Role |
| [`GET /namespaces/{namespaceId}/iam/roles/{roleId}`](#get-namespacesnamespaceidiamrolesroleid) | Get an exact Namespace IAM Role |

#### `GET /namespaces/{namespaceId}/iam/access-bindings`

<span id="get-namespacesnamespaceidiamaccessbindings"></span>

List exact Namespace IAM AccessBindings

**Operation ID:** `listIAMAccessBindings`

**Permissions:** Requires administer permission on the requested Installation. Requires read permission on the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |
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
| `data` | `array<object or object>` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/iam/access-bindings`

<span id="post-namespacesnamespaceidiamaccessbindings"></span>

Create an immutable exact-resource Namespace IAM AccessBinding

**Operation ID:** `createIAMAccessBinding`

**Permissions:** Requires administer permission on the requested Installation. Requires read permission on the requested Namespace. Requires read permission on the request body Agent when the AccessBinding targets that resource kind. Requires read permission on the request body AgentRevision when the AccessBinding targets that resource kind. Requires read permission on the request body Configuration when the AccessBinding targets that resource kind. Requires read permission on the request body Secret when the AccessBinding targets that resource kind. Requires read permission on the request body ServiceAccount when the AccessBinding targets that resource kind.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |
| `read` | `namespace` | `requested` |
| `read` | `agent` | `request_body` |
| `read` | `agent_revision` | `request_body` |
| `read` | `configuration` | `request_body` |
| `read` | `secret` | `request_body` |
| `read` | `service_account` | `request_body` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `resourceId` | `string` | Yes | min length: 1; max length: 200 |
| `resourceKind` | `"agent" or "agent_revision" or "configuration" or "credential_source" or "preset" or "secret" or "service_account"` | Yes | — |
| `roleId` | `string` | Yes | min length: 1; max length: 200 |
| `subjectId` | `string` | Yes | min length: 1; max length: 200 |
| `subjectKind` | `"identity"` | Yes | — |

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
| `data` | `object or object` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}/iam/access-bindings/{bindingId}`

<span id="delete-namespacesnamespaceidiamaccessbindingsbindingid"></span>

Delete one exact Namespace IAM AccessBinding

**Operation ID:** `deleteIAMAccessBinding`

**Permissions:** Requires administer permission on the requested Installation. Requires read permission on the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |
| `read` | `namespace` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `bindingId` | path | `string` | Yes | min length: 1; max length: 200 |

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

#### `GET /namespaces/{namespaceId}/iam/access-bindings/{bindingId}`

<span id="get-namespacesnamespaceidiamaccessbindingsbindingid"></span>

Get an exact Namespace IAM AccessBinding

**Operation ID:** `getIAMAccessBinding`

**Permissions:** Requires administer permission on the requested Installation. Requires read permission on the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |
| `read` | `namespace` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `bindingId` | path | `string` | Yes | min length: 1; max length: 200 |

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
| `data` | `object or object` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/iam/roles`

<span id="get-namespacesnamespaceidiamroles"></span>

List exact Namespace IAM Roles

**Operation ID:** `listIAMRoles`

**Permissions:** Requires administer permission on the requested Installation. Requires read permission on the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |
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
| `data` | `array<object>` | Yes | — |
| `data[].id` | `string` | Yes | min length: 1; max length: 200 |
| `data[].name` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].permissions` | `array<object>` | Yes | min items: 1; max items: 64 |
| `data[].permissions[].action` | `"create" or "read" or "update" or "delete" or "deploy" or "operate" or "administer"` | Yes | — |
| `data[].permissions[].resourceKind` | `"installation" or "namespace" or "configuration" or "preset" or "service_account" or "secret" or "agent" or "agent_revision" or "credential_source"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/iam/roles`

<span id="post-namespacesnamespaceidiamroles"></span>

Create an immutable Namespace IAM Role

**Operation ID:** `createIAMRole`

**Permissions:** Requires administer permission on the requested Installation. Requires read permission on the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |
| `read` | `namespace` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `name` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `permissions` | `array<object>` | Yes | min items: 1; max items: 64 |
| `permissions[].action` | `"create" or "read" or "update" or "delete" or "deploy" or "operate" or "administer"` | Yes | — |
| `permissions[].resourceKind` | `"agent" or "agent_revision" or "configuration" or "credential_source" or "preset" or "secret" or "service_account"` | Yes | — |

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
| `data.id` | `string` | Yes | min length: 1; max length: 200 |
| `data.name` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.permissions` | `array<object>` | Yes | min items: 1; max items: 64 |
| `data.permissions[].action` | `"create" or "read" or "update" or "delete" or "deploy" or "operate" or "administer"` | Yes | — |
| `data.permissions[].resourceKind` | `"installation" or "namespace" or "configuration" or "preset" or "service_account" or "secret" or "agent" or "agent_revision" or "credential_source"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}/iam/roles/{roleId}`

<span id="delete-namespacesnamespaceidiamrolesroleid"></span>

Delete an unreferenced exact Namespace IAM Role

**Operation ID:** `deleteIAMRole`

**Permissions:** Requires administer permission on the requested Installation. Requires read permission on the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |
| `read` | `namespace` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `roleId` | path | `string` | Yes | min length: 1; max length: 200 |

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

#### `GET /namespaces/{namespaceId}/iam/roles/{roleId}`

<span id="get-namespacesnamespaceidiamrolesroleid"></span>

Get an exact Namespace IAM Role

**Operation ID:** `getIAMRole`

**Permissions:** Requires administer permission on the requested Installation. Requires read permission on the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |
| `read` | `namespace` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `roleId` | path | `string` | Yes | min length: 1; max length: 200 |

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
| `data.id` | `string` | Yes | min length: 1; max length: 200 |
| `data.name` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.permissions` | `array<object>` | Yes | min items: 1; max items: 64 |
| `data.permissions[].action` | `"create" or "read" or "update" or "delete" or "deploy" or "operate" or "administer"` | Yes | — |
| `data.permissions[].resourceKind` | `"installation" or "namespace" or "configuration" or "preset" or "service_account" or "secret" or "agent" or "agent_revision" or "credential_source"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="presets"></span>

### Presets

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/presets`](#get-namespacesnamespaceidpresets) | List readable Presets in one Namespace |
| [`POST /namespaces/{namespaceId}/presets`](#post-namespacesnamespaceidpresets) | Create a reusable Namespace-owned Agent Preset |
| [`DELETE /namespaces/{namespaceId}/presets/{presetId}`](#delete-namespacesnamespaceidpresetspresetid) | Delete a Preset without changing existing Agents |
| [`GET /namespaces/{namespaceId}/presets/{presetId}`](#get-namespacesnamespaceidpresetspresetid) | Read one exact Namespace-owned Preset |
| [`PATCH /namespaces/{namespaceId}/presets/{presetId}`](#patch-namespacesnamespaceidpresetspresetid) | Update a Preset without changing existing Agents |

#### `GET /namespaces/{namespaceId}/presets`

<span id="get-namespacesnamespaceidpresets"></span>

List readable Presets in one Namespace

**Operation ID:** `listPresets`

**Permissions:** Only Preset resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `preset` | `each_returned` |

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
| `data[].createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data[].id` | `string` | Yes | pattern: `^pre_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].template` | `object` | Yes | Reusable partial Agent launch settings. Scalar values may use {{ vars.name }}. Admission validates template syntax and credential boundaries. Ordinary creation APIs validate concrete launch settings. |
| `data[].template.agent` | `object` | No | — |
| `data[].template.agent.backendId` | `SafeJsonValue` | No | — |
| `data[].template.agent.executionMode` | `SafeJsonValue` | No | — |
| `data[].template.agent.harnessAuth` | `SafeJsonValue` | No | — |
| `data[].template.agent.initialWorkspaceFiles` | `object` | No | — |
| `data[].template.agent.initialWorkspaceFiles.AGENTS.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data[].template.agent.initialWorkspaceFiles.IDENTITY.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data[].template.agent.initialWorkspaceFiles.SOUL.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data[].template.agent.initialWorkspaceFiles.USER.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data[].template.agent.name` | `SafeJsonValue` | No | — |
| `data[].template.agent.plugins` | `SafeJsonValue` | No | — |
| `data[].template.configuration` | `object` | No | — |
| `data[].template.configuration.secretBindings` | `object<string, SafeJsonValue>` | No | Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}. |
| `data[].template.configuration.values` | `object<string, SafeJsonValue>` | No | A native OpenClaw configuration document. |
| `data[].template.variables` | `object<string, object or object or object or object>` | No | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/presets`

<span id="post-namespacesnamespaceidpresets"></span>

Create a reusable Namespace-owned Agent Preset

**Operation ID:** `createPreset`

**Permissions:** Requires create permission for Preset resources in the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `preset` | `namespace` |

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
| `template` | `object` | Yes | Reusable partial Agent launch settings. Scalar values may use {{ vars.name }}. Admission validates template syntax and credential boundaries. Ordinary creation APIs validate concrete launch settings. |
| `template.agent` | `object` | No | — |
| `template.agent.backendId` | `SafeJsonValue` | No | — |
| `template.agent.executionMode` | `SafeJsonValue` | No | — |
| `template.agent.harnessAuth` | `SafeJsonValue` | No | — |
| `template.agent.initialWorkspaceFiles` | `object` | No | — |
| `template.agent.initialWorkspaceFiles.AGENTS.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `template.agent.initialWorkspaceFiles.IDENTITY.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `template.agent.initialWorkspaceFiles.SOUL.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `template.agent.initialWorkspaceFiles.USER.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `template.agent.name` | `SafeJsonValue` | No | — |
| `template.agent.plugins` | `SafeJsonValue` | No | — |
| `template.configuration` | `object` | No | — |
| `template.configuration.secretBindings` | `object<string, SafeJsonValue>` | No | Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}. |
| `template.configuration.values` | `object<string, SafeJsonValue>` | No | A native OpenClaw configuration document. |
| `template.variables` | `object<string, object or object or object or object>` | No | — |

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
| `data.id` | `string` | Yes | pattern: `^pre_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.template` | `object` | Yes | Reusable partial Agent launch settings. Scalar values may use {{ vars.name }}. Admission validates template syntax and credential boundaries. Ordinary creation APIs validate concrete launch settings. |
| `data.template.agent` | `object` | No | — |
| `data.template.agent.backendId` | `SafeJsonValue` | No | — |
| `data.template.agent.executionMode` | `SafeJsonValue` | No | — |
| `data.template.agent.harnessAuth` | `SafeJsonValue` | No | — |
| `data.template.agent.initialWorkspaceFiles` | `object` | No | — |
| `data.template.agent.initialWorkspaceFiles.AGENTS.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.initialWorkspaceFiles.IDENTITY.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.initialWorkspaceFiles.SOUL.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.initialWorkspaceFiles.USER.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.name` | `SafeJsonValue` | No | — |
| `data.template.agent.plugins` | `SafeJsonValue` | No | — |
| `data.template.configuration` | `object` | No | — |
| `data.template.configuration.secretBindings` | `object<string, SafeJsonValue>` | No | Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}. |
| `data.template.configuration.values` | `object<string, SafeJsonValue>` | No | A native OpenClaw configuration document. |
| `data.template.variables` | `object<string, object or object or object or object>` | No | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}/presets/{presetId}`

<span id="delete-namespacesnamespaceidpresetspresetid"></span>

Delete a Preset without changing existing Agents

**Operation ID:** `deletePreset`

**Permissions:** Requires delete permission on the requested Preset.

| Action | Resource | Scope |
| --- | --- | --- |
| `delete` | `preset` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `presetId` | path | `string` | Yes | pattern: `^pre_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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

#### `GET /namespaces/{namespaceId}/presets/{presetId}`

<span id="get-namespacesnamespaceidpresetspresetid"></span>

Read one exact Namespace-owned Preset

**Operation ID:** `getPreset`

**Permissions:** Requires read permission on the requested Preset.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `preset` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `presetId` | path | `string` | Yes | pattern: `^pre_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `data.id` | `string` | Yes | pattern: `^pre_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.template` | `object` | Yes | Reusable partial Agent launch settings. Scalar values may use {{ vars.name }}. Admission validates template syntax and credential boundaries. Ordinary creation APIs validate concrete launch settings. |
| `data.template.agent` | `object` | No | — |
| `data.template.agent.backendId` | `SafeJsonValue` | No | — |
| `data.template.agent.executionMode` | `SafeJsonValue` | No | — |
| `data.template.agent.harnessAuth` | `SafeJsonValue` | No | — |
| `data.template.agent.initialWorkspaceFiles` | `object` | No | — |
| `data.template.agent.initialWorkspaceFiles.AGENTS.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.initialWorkspaceFiles.IDENTITY.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.initialWorkspaceFiles.SOUL.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.initialWorkspaceFiles.USER.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.name` | `SafeJsonValue` | No | — |
| `data.template.agent.plugins` | `SafeJsonValue` | No | — |
| `data.template.configuration` | `object` | No | — |
| `data.template.configuration.secretBindings` | `object<string, SafeJsonValue>` | No | Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}. |
| `data.template.configuration.values` | `object<string, SafeJsonValue>` | No | A native OpenClaw configuration document. |
| `data.template.variables` | `object<string, object or object or object or object>` | No | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `PATCH /namespaces/{namespaceId}/presets/{presetId}`

<span id="patch-namespacesnamespaceidpresetspresetid"></span>

Update a Preset without changing existing Agents

**Operation ID:** `updatePreset`

**Permissions:** Requires update permission on the requested Preset.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `preset` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `presetId` | path | `string` | Yes | pattern: `^pre_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `name` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `template` | `object` | No | Reusable partial Agent launch settings. Scalar values may use {{ vars.name }}. Admission validates template syntax and credential boundaries. Ordinary creation APIs validate concrete launch settings. |
| `template.agent` | `object` | No | — |
| `template.agent.backendId` | `SafeJsonValue` | No | — |
| `template.agent.executionMode` | `SafeJsonValue` | No | — |
| `template.agent.harnessAuth` | `SafeJsonValue` | No | — |
| `template.agent.initialWorkspaceFiles` | `object` | No | — |
| `template.agent.initialWorkspaceFiles.AGENTS.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `template.agent.initialWorkspaceFiles.IDENTITY.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `template.agent.initialWorkspaceFiles.SOUL.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `template.agent.initialWorkspaceFiles.USER.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `template.agent.name` | `SafeJsonValue` | No | — |
| `template.agent.plugins` | `SafeJsonValue` | No | — |
| `template.configuration` | `object` | No | — |
| `template.configuration.secretBindings` | `object<string, SafeJsonValue>` | No | Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}. |
| `template.configuration.values` | `object<string, SafeJsonValue>` | No | A native OpenClaw configuration document. |
| `template.variables` | `object<string, object or object or object or object>` | No | — |

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
| `data.id` | `string` | Yes | pattern: `^pre_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.template` | `object` | Yes | Reusable partial Agent launch settings. Scalar values may use {{ vars.name }}. Admission validates template syntax and credential boundaries. Ordinary creation APIs validate concrete launch settings. |
| `data.template.agent` | `object` | No | — |
| `data.template.agent.backendId` | `SafeJsonValue` | No | — |
| `data.template.agent.executionMode` | `SafeJsonValue` | No | — |
| `data.template.agent.harnessAuth` | `SafeJsonValue` | No | — |
| `data.template.agent.initialWorkspaceFiles` | `object` | No | — |
| `data.template.agent.initialWorkspaceFiles.AGENTS.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.initialWorkspaceFiles.IDENTITY.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.initialWorkspaceFiles.SOUL.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.initialWorkspaceFiles.USER.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `data.template.agent.name` | `SafeJsonValue` | No | — |
| `data.template.agent.plugins` | `SafeJsonValue` | No | — |
| `data.template.configuration` | `object` | No | — |
| `data.template.configuration.secretBindings` | `object<string, SafeJsonValue>` | No | Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}. |
| `data.template.configuration.values` | `object<string, SafeJsonValue>` | No | A native OpenClaw configuration document. |
| `data.template.variables` | `object<string, object or object or object or object>` | No | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="secrets"></span>

### Secrets

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/secrets`](#get-namespacesnamespaceidsecrets) | List readable Namespace-owned Secret metadata without revealing material |
| [`POST /namespaces/{namespaceId}/secrets`](#post-namespacesnamespaceidsecrets) | Create exact Namespace-owned Secret material and return metadata only |
| [`DELETE /namespaces/{namespaceId}/secrets/{secretId}`](#delete-namespacesnamespaceidsecretssecretid) | Delete exact unbound Namespace-owned Secret material |
| [`GET /namespaces/{namespaceId}/secrets/{secretId}`](#get-namespacesnamespaceidsecretssecretid) | Get exact Namespace-owned Secret metadata without revealing material |
| [`PATCH /namespaces/{namespaceId}/secrets/{secretId}`](#patch-namespacesnamespaceidsecretssecretid) | Replace exact Namespace-owned Secret material and return stable metadata |

#### `GET /namespaces/{namespaceId}/secrets`

<span id="get-namespacesnamespaceidsecrets"></span>

List readable Namespace-owned Secret metadata without revealing material

**Operation ID:** `listSecrets`

**Permissions:** Requires read permission for Secret resources in the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `secret` | `namespace` |

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
| `data[].id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].ref` | `object` | Yes | Exact OCC Secret reference. Shape: `{ "kind": "secret", "namespaceId": "ns_...", "id": "sec_..." }`. |
| `data[].ref.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].ref.kind` | `"secret"` | Yes | — |
| `data[].ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `data.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Shared schemas

Reusable schema names are referenced by operation request and response tables.

| Schema | Type |
| --- | --- |
| `SafeJsonValue` | `string or boolean or number or null or array<SafeJsonValue> or object<string, SafeJsonValue>` |
| `PluginDriverIdentity` | `object` |
| `SecretResponse` | `object` |
| `CredentialSourceResponse` | `object` |
| `PluginApprovers` | `array<object>` |
| `PluginToolPolicy` | `object` |
| `PluginToolDefaults` | `object` |
| `PluginDesiredSelection` | `object` |
| `PluginDesiredState` | `object<string, PluginDesiredSelection>` |
| `ErrorResponse` | `object` |
| `AgentDeploymentDiagnosticsResponse` | `object` |
| `AgentRuntimeCredentialResponse` | `object` |
