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
A NUL character or an unpaired UTF-16 surrogate in any request body string,
object key or path parameter is refused with `400 INVALID_REQUEST`.
A JSON body with a value more than 24 levels below its root is refused
with `400 INVALID_REQUEST` and a `TOO_DEEP` detail before it is parsed,
so that answer comes before any other body error.
Operations that take a request body list `413` and `415`. Any request whose
declared body size exceeds the route's limit is refused with
`413 PAYLOAD_TOO_LARGE`, and any POST, PUT, PATCH or DELETE request with a
body that is not JSON with `415 UNSUPPORTED_MEDIA_TYPE`, even on an
operation that takes no body. A query string sent to an operation that lists
no query parameters is refused with `400 INVALID_REQUEST`, except on the
sign-in, sign-out, session and provider operations under `/api/auth`, which
do not refuse one; most operations that take no body refuse a JSON body the
same way.
A detail path longer than 512 characters is cut to its leading whole
segments (or the start of a long first key, keeping whole `~0` and `~1`
escapes). When whole segments were dropped, a contract validation message
says that the cut path contains the offending field. To fit the
256-character message cap, a message cuts long paths (ending them with `…`)
and shows fewer problems before it cuts any problem wording; `details` keeps
the paths.

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `error` | `object` | Yes | — |
| `error.code` | `"INVALID_REQUEST" or "UNAUTHENTICATED" or "FORBIDDEN" or "NOT_FOUND" or "METHOD_NOT_ALLOWED" or "INSTALLATION_EXISTS" or "RESOURCE_CONFLICT" or "AGENT_DELETING" or "NAMESPACE_NOT_READY" or "NAMESPACE_NOT_EMPTY" or "PAYLOAD_TOO_LARGE" or "UNSUPPORTED_MEDIA_TYPE" or "UNKNOWN_OUTCOME" or "NOT_IMPLEMENTED" or "INTERNAL_ERROR" or "DEPENDENCY_UNAVAILABLE" or "CREDENTIAL_GATEWAY_NOT_CONFIGURED" or "CREDENTIAL_WITHDRAWAL_IN_PROGRESS" or "CREDENTIAL_TOKEN_UNSETTLED" or "SANDBOX_POLICY_PROTECTED_EXECUTION" or "REPOSITORY_GIT_SENDER_UNQUALIFIED" or "REPOSITORY_GIT_PROFILE_UNSUPPORTED" or "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED" or "REPOSITORY_OPTIONS_UNAVAILABLE" or "MODEL_DISCOVERY_CREDENTIALS_REJECTED" or "MODEL_DISCOVERY_RATE_LIMITED" or "MODEL_DISCOVERY_UNAVAILABLE" or "MODEL_DISCOVERY_INVALID_RESPONSE" or "PLUGIN_DISCOVERY_CREDENTIALS_REJECTED" or "PLUGIN_DISCOVERY_RATE_LIMITED" or "PLUGIN_DISCOVERY_UNAVAILABLE" or "PLUGIN_DISCOVERY_INVALID_RESPONSE" or "CHANNEL_DIRECTORY_CREDENTIALS_REJECTED" or "CHANNEL_DIRECTORY_MISSING_SCOPE" or "CHANNEL_DIRECTORY_RATE_LIMITED" or "CHANNEL_DIRECTORY_INVALID_RESPONSE" or "CHANNEL_DIRECTORY_UNAVAILABLE" or "CHANNEL_CREDENTIAL_ROLE_MISMATCH" or "CHANNEL_CREDENTIAL_CREDENTIALS_REJECTED" or "CHANNEL_CREDENTIAL_UNAVAILABLE" or "CHANNEL_CREDENTIAL_BINDING_REQUIRED" or "RUNTIME_LOGS_CURSOR_INVALID" or "RUNTIME_LOGS_POD_INVALID" or "RUNTIME_LOGS_SOURCE_UNAVAILABLE" or "NATIVE_ADMIN_RETURN_RATE_LIMITED" or "RUNTIME_LOGS_RATE_LIMITED" or "RUNTIME_LOGS_CLUSTER_RBAC" or "RUNTIME_LOGS_SANDBOX_NOT_FOUND" or "RUNTIME_LOGS_UNAVAILABLE" or "RUNTIME_LOGS_AUDIT_UNAVAILABLE" or "RUNTIME_LOGS_TIMEOUT" or "RUNTIME_CREDENTIALS_CLUSTER_RBAC"` | Yes | — |
| `error.details` | `array<object>` | No | max items: 32 |
| `error.details[].code` | `"REQUIRED" or "UNKNOWN_FIELD" or "INVALID_TYPE" or "INVALID_FORMAT" or "INVALID_VALUE" or "TOO_LONG" or "TOO_DEEP" or "INVALID_RANGE" or "OUTSIDE_CEILING"` | Yes | — |
| `error.details[].message` | `string` | No | max length: 512 |
| `error.details[].path` | `string` | Yes | max length: 512; pattern: `^(?:/(?:[^~/]\|~0\|~1)*)*$` |
| `error.message` | `string` | Yes | min length: 1; max length: 256 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Resources

| Resource | Operations |
| --- | --- |
| [Authentication](#authentication) | 27 operations |
| [Backends](#backends) | 1 operation |
| [Installation](#installation) | 5 operations |
| [Namespaces](#namespaces) | 5 operations |
| [Agents](#agents) | 47 operations |
| [Agent deployments](#agent-deployments) | 4 operations |
| [Agent revisions](#agent-revisions) | 2 operations |
| [Configurations](#configurations) | 4 operations |
| [Credential sources](#credential-sources) | 6 operations |
| [IAM](#iam) | 11 operations |
| [Presets](#presets) | 5 operations |
| [Secrets](#secrets) | 5 operations |
| [Service accounts](#service-accounts) | 6 operations |

## Operations

<span id="authentication"></span>

### Authentication

| Operation | Summary |
| --- | --- |
| [`POST /api/auth/accounts`](#post-apiauthaccounts) | Create an administrator-controlled local auth account |
| [`GET /api/auth/accounts/{userId}`](#get-apiauthaccountsuserid) | Inspect current human account state |
| [`POST /api/auth/accounts/{userId}/disable`](#post-apiauthaccountsuseriddisable) | Disable a human account |
| [`POST /api/auth/accounts/{userId}/enable`](#post-apiauthaccountsuseridenable) | Re-enable a disabled human account |
| [`POST /api/auth/accounts/{userId}/enrol`](#post-apiauthaccountsuseridenrol) | Enrol an existing account that activation skipped |
| [`POST /api/auth/accounts/{userId}/methods/{methodId}/detach`](#post-apiauthaccountsuseridmethodsmethodiddetach) | Detach an external sign-in identity from an account |
| [`POST /api/auth/accounts/{userId}/providers/github`](#post-apiauthaccountsuseridprovidersgithub) | Attach an exact GitHub identity to an existing account |
| [`POST /api/auth/accounts/{userId}/providers/google`](#post-apiauthaccountsuseridprovidersgoogle) | Attach an exact Google identity to an existing account |
| [`POST /api/auth/accounts/{userId}/providers/oidc`](#post-apiauthaccountsuseridprovidersoidc) | Attach an exact OIDC identity to an existing account |
| [`POST /api/auth/accounts/{userId}/revoke`](#post-apiauthaccountsuseridrevoke) | Revoke all sessions for a human account |
| [`GET /api/auth/providers`](#get-apiauthproviders) | List configured browser sign-in methods |
| [`GET /api/auth/providers/github/callback`](#get-apiauthprovidersgithubcallback) | Complete an enrolled GitHub sign-in |
| [`POST /api/auth/providers/github/result`](#post-apiauthprovidersgithubresult) | Confirm which session a GitHub sign-in created |
| [`POST /api/auth/providers/github/start`](#post-apiauthprovidersgithubstart) | Start GitHub sign-in for an enrolled account |
| [`GET /api/auth/providers/google/callback`](#get-apiauthprovidersgooglecallback) | Complete an enrolled Google sign-in |
| [`POST /api/auth/providers/google/result`](#post-apiauthprovidersgoogleresult) | Confirm which session a Google sign-in created |
| [`POST /api/auth/providers/google/start`](#post-apiauthprovidersgooglestart) | Start Google sign-in for an enrolled account |
| [`GET /api/auth/providers/oidc/callback`](#get-apiauthprovidersoidccallback) | Complete an enrolled OIDC sign-in |
| [`POST /api/auth/providers/oidc/result`](#post-apiauthprovidersoidcresult) | Confirm which session an OIDC sign-in created |
| [`POST /api/auth/providers/oidc/start`](#post-apiauthprovidersoidcstart) | Start OIDC sign-in for an enrolled account |
| [`GET /api/auth/recovery`](#get-apiauthrecovery) | Inspect the recovery account designation |
| [`POST /api/auth/recovery`](#post-apiauthrecovery) | Move the recovery designation to another administrator |
| [`POST /api/auth/service-keys`](#post-apiauthservicekeys) | Issue a service API key |
| [`DELETE /api/auth/service-keys/{keyId}`](#delete-apiauthservicekeyskeyid) | Revoke a service API key |
| [`GET /api/auth/session`](#get-apiauthsession) | Inspect authentication without revealing session tokens |
| [`POST /api/auth/sign-in/email`](#post-apiauthsigninemail) | Sign in with email and password |
| [`POST /api/auth/sign-out`](#post-apiauthsignout) | Sign out of the current session |

#### `POST /api/auth/accounts`

<span id="post-apiauthaccounts"></span>

Create an administrator-controlled local auth account

**Operation ID:** `createAuthAccount`

**Permissions:** Requires administer permission on the Installation. Creates a Better Auth account and an explicit IAM Principal in one transaction. Supplying roleId also creates a binding to that existing IAM Role; omitting roleId creates no grants. Public signup remains disabled. An optional github.subject attaches that GitHub identity in the same transaction; it conflicts when GitHub sign-in is not configured or the identity is already assigned.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `email` | `string` | Yes | min length: 3; max length: 320 |
| `github` | `object` | No | — |
| `github.subject` | `string` | Yes | pattern: `^[1-9][0-9]{0,19}$` |
| `name` | `string` | No | min length: 1; max length: 200 |
| `password` | `string` | Yes | min length: 12; max length: 128 |
| `roleId` | `string` | No | min length: 1; max length: 200 |

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

#### `GET /api/auth/accounts/{userId}`

<span id="get-apiauthaccountsuserid"></span>

Inspect current human account state

**Operation ID:** `getAuthAccount`

**Permissions:** Requires a current human Native IAM Installation administrator and trusted Origin. Returns guarded present state, not a receipt for any prior operation.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `userId` | path | `string` | Yes | min length: 1; max length: 200 |

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
| `data.disabled` | `boolean` | Yes | — |
| `data.methods` | `array<object>` | Yes | — |
| `data.methods[].methodId` | `string` | Yes | — |
| `data.methods[].providerId` | `string` | Yes | — |
| `data.methods[].subject` | `string` | Yes | — |
| `data.principalId` | `string` | Yes | — |
| `data.userId` | `string` | Yes | — |
| `data.version` | `integer` | Yes | minimum: 1 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/accounts/{userId}/disable`

<span id="post-apiauthaccountsuseriddisable"></span>

Disable a human account

**Operation ID:** `disableAuthAccount`

**Permissions:** Requires a current human Native IAM Installation administrator who holds every grant of the target account's Principal, trusted Origin and expectedVersion from a guarded account read. Commits state and audit together. An unknown outcome must be inspected without automatic retry; present state does not attribute the earlier request.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `userId` | path | `string` | Yes | min length: 1; max length: 200 |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |

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
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.userId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/accounts/{userId}/enable`

<span id="post-apiauthaccountsuseridenable"></span>

Re-enable a disabled human account

**Operation ID:** `enableAuthAccount`

**Permissions:** Requires a current human Native IAM Installation administrator who holds every grant of the target account's Principal, trusted Origin and expectedVersion from a guarded account read. Commits state and audit together. An unknown outcome must be inspected without automatic retry; present state does not attribute the earlier request.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `userId` | path | `string` | Yes | min length: 1; max length: 200 |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |

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
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.userId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/accounts/{userId}/enrol`

<span id="post-apiauthaccountsuseridenrol"></span>

Enrol an existing account that activation skipped

**Operation ID:** `enrolAuthAccount`

**Permissions:** Requires a current human Native IAM Installation administrator and trusted Origin. The account must already have its IAM Principal and exactly one password. Idempotent; enrolment grants no access beyond the account's existing IAM bindings.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `userId` | path | `string` | Yes | min length: 1; max length: 200 |

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
| `data.created` | `boolean` | Yes | — |
| `data.principalId` | `string` | Yes | — |
| `data.userId` | `string` | Yes | — |
| `data.version` | `integer` | Yes | minimum: 1 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/accounts/{userId}/methods/{methodId}/detach`

<span id="post-apiauthaccountsuseridmethodsmethodiddetach"></span>

Detach an external sign-in identity from an account

**Operation ID:** `detachAuthMethod`

**Permissions:** Requires a current human Native IAM Installation administrator who holds every grant of the target account's Principal, trusted Origin and expectedVersion from a guarded account read. Commits state and audit together. An unknown outcome must be inspected without automatic retry; present state does not attribute the earlier request.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `userId` | path | `string` | Yes | min length: 1; max length: 200 |
| `methodId` | path | `string` | Yes | min length: 1; max length: 200 |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |

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
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.userId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/accounts/{userId}/providers/github`

<span id="post-apiauthaccountsuseridprovidersgithub"></span>

Attach an exact GitHub identity to an existing account

**Operation ID:** `attachGitHubIdentity`

**Permissions:** Requires a current human Native IAM Installation administrator who holds every grant of the target account's Principal, trusted Origin and expectedVersion from a guarded account read. Commits state and audit together. An unknown outcome must be inspected without automatic retry; present state does not attribute the earlier request.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `userId` | path | `string` | Yes | min length: 1; max length: 200 |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `subject` | `string` | Yes | pattern: `^[1-9][0-9]{0,19}$` |

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
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.userId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/accounts/{userId}/providers/google`

<span id="post-apiauthaccountsuseridprovidersgoogle"></span>

Attach an exact Google identity to an existing account

**Operation ID:** `attachGoogleIdentity`

**Permissions:** Requires a current human Native IAM Installation administrator who holds every grant of the target account's Principal, trusted Origin and expectedVersion from a guarded account read. Commits state and audit together. An unknown outcome must be inspected without automatic retry; present state does not attribute the earlier request.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `userId` | path | `string` | Yes | min length: 1; max length: 200 |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `subject` | `string` | Yes | pattern: `^[\x21-\x7E]{1,255}$` |

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
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.userId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/accounts/{userId}/providers/oidc`

<span id="post-apiauthaccountsuseridprovidersoidc"></span>

Attach an exact OIDC identity to an existing account

**Operation ID:** `attachOidcIdentity`

**Permissions:** Requires a current human Native IAM Installation administrator who holds every grant of the target account's Principal, trusted Origin and expectedVersion from a guarded account read. Commits state and audit together. An unknown outcome must be inspected without automatic retry; present state does not attribute the earlier request.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `userId` | path | `string` | Yes | min length: 1; max length: 200 |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `subject` | `string` | Yes | pattern: `^[\x21-\x7E]{1,255}$` |

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
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.userId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/accounts/{userId}/revoke`

<span id="post-apiauthaccountsuseridrevoke"></span>

Revoke all sessions for a human account

**Operation ID:** `revokeAuthAccountSessions`

**Permissions:** Requires a current human Native IAM Installation administrator who holds every grant of the target account's Principal, trusted Origin and expectedVersion from a guarded account read. Commits state and audit together. An unknown outcome must be inspected without automatic retry; present state does not attribute the earlier request.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `userId` | path | `string` | Yes | min length: 1; max length: 200 |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |

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
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.userId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `GET /api/auth/providers`

<span id="get-apiauthproviders"></span>

List configured browser sign-in methods

**Operation ID:** `getAuthProviders`

**Permissions:** No IAM permission required.

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
| `data.github` | `boolean` | Yes | — |
| `data.google` | `boolean` | Yes | — |
| `data.oidc` | `boolean` | Yes | — |
| `data.oidcSignIn` | `object` | No | Present only when OIDC sign-in is configured: the Console's button label and the configured authorization endpoint that the start URL must use. |
| `data.oidcSignIn.authorizationUrl` | `string (uri)` | Yes | — |
| `data.oidcSignIn.label` | `string` | Yes | min length: 1; max length: 40 |
| `data.password` | `boolean` | Yes | False when password sign-in is recovery-only: ordinary accounts sign in with an external provider, and only the recovery account uses a password. |
| `data.sessionBinding` | `boolean` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `GET /api/auth/providers/github/callback`

<span id="get-apiauthprovidersgithubcallback"></span>

Complete an enrolled GitHub sign-in

**Operation ID:** `completeGitHubSignIn`

**Permissions:** Consumes the browser-bound attempt before provider exchange. Redirects to Console after session and audit commit or with a fixed failure classification.

##### Responses

| Status | Meaning |
| --- | --- |
| `302` | Redirect to Console |

#### `POST /api/auth/providers/github/result`

<span id="post-apiauthprovidersgithubresult"></span>

Confirm which session a GitHub sign-in created

**Operation ID:** `confirmGitHubSignIn`

**Permissions:** Requires the configured browser Origin, the one-use login receipt cookie set by the callback, the matching attemptId and the session cookie that callback issued. Returns that session's sessionKey; never issues or extends a session.

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `attemptId` | `string` | Yes | pattern: `^[A-Za-z0-9_-]{43}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.sessionKey` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/providers/github/start`

<span id="post-apiauthprovidersgithubstart"></span>

Start GitHub sign-in for an enrolled account

**Operation ID:** `startGitHubSignIn`

**Permissions:** Requires the exact configured browser Origin and, when Sec-Fetch-Site is present, same-origin. Creates a one-use browser-bound login attempt and returns its public attemptId for the result exchange; does not create an account or grant access.

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Unauthorized |
| `403` | Forbidden |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.attemptId` | `string` | Yes | pattern: `^[A-Za-z0-9_-]{43}$` |
| `data.url` | `string (uri)` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `GET /api/auth/providers/google/callback`

<span id="get-apiauthprovidersgooglecallback"></span>

Complete an enrolled Google sign-in

**Operation ID:** `completeGoogleSignIn`

**Permissions:** Consumes the browser-bound attempt before provider exchange. Redirects to Console after session and audit commit or with a fixed failure classification.

##### Responses

| Status | Meaning |
| --- | --- |
| `302` | Redirect to Console |

#### `POST /api/auth/providers/google/result`

<span id="post-apiauthprovidersgoogleresult"></span>

Confirm which session a Google sign-in created

**Operation ID:** `confirmGoogleSignIn`

**Permissions:** Requires the configured browser Origin, the one-use login receipt cookie set by the callback, the matching attemptId and the session cookie that callback issued. Returns that session's sessionKey; never issues or extends a session.

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `attemptId` | `string` | Yes | pattern: `^[A-Za-z0-9_-]{43}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.sessionKey` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/providers/google/start`

<span id="post-apiauthprovidersgooglestart"></span>

Start Google sign-in for an enrolled account

**Operation ID:** `startGoogleSignIn`

**Permissions:** Requires the exact configured browser Origin and, when Sec-Fetch-Site is present, same-origin. Creates a one-use browser-bound login attempt and returns its public attemptId for the result exchange; does not create an account or grant access.

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Unauthorized |
| `403` | Forbidden |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.attemptId` | `string` | Yes | pattern: `^[A-Za-z0-9_-]{43}$` |
| `data.url` | `string (uri)` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `GET /api/auth/providers/oidc/callback`

<span id="get-apiauthprovidersoidccallback"></span>

Complete an enrolled OIDC sign-in

**Operation ID:** `completeOidcSignIn`

**Permissions:** Consumes the browser-bound attempt before provider exchange. Redirects to Console after session and audit commit or with a fixed failure classification.

##### Responses

| Status | Meaning |
| --- | --- |
| `302` | Redirect to Console |

#### `POST /api/auth/providers/oidc/result`

<span id="post-apiauthprovidersoidcresult"></span>

Confirm which session an OIDC sign-in created

**Operation ID:** `confirmOidcSignIn`

**Permissions:** Requires the configured browser Origin, the one-use login receipt cookie set by the callback, the matching attemptId and the session cookie that callback issued. Returns that session's sessionKey; never issues or extends a session.

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `attemptId` | `string` | Yes | pattern: `^[A-Za-z0-9_-]{43}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.sessionKey` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/providers/oidc/start`

<span id="post-apiauthprovidersoidcstart"></span>

Start OIDC sign-in for an enrolled account

**Operation ID:** `startOidcSignIn`

**Permissions:** Requires the exact configured browser Origin and, when Sec-Fetch-Site is present, same-origin. Creates a one-use browser-bound login attempt and returns its public attemptId for the result exchange; does not create an account or grant access.

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Unauthorized |
| `403` | Forbidden |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.attemptId` | `string` | Yes | pattern: `^[A-Za-z0-9_-]{43}$` |
| `data.url` | `string (uri)` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `GET /api/auth/recovery`

<span id="get-apiauthrecovery"></span>

Inspect the recovery account designation

**Operation ID:** `getAuthRecovery`

**Permissions:** Requires a current human Native IAM Installation administrator and trusted Origin. Returns the present designation, whose password the database protects; not a receipt for any prior operation.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.methodId` | `string` | Yes | — |
| `data.principalId` | `string` | Yes | — |
| `data.userId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/recovery`

<span id="post-apiauthrecovery"></span>

Move the recovery designation to another administrator

**Operation ID:** `replaceAuthRecovery`

**Permissions:** Requires a current human Native IAM Installation administrator and trusted Origin who holds every IAM grant of the current holder's Principal (else 403). The target must be an enrolled, enabled account with one password whose Principal administers the Installation. expectedCurrentUserId comes from the recovery read and expectedVersion from the target's account read. Commits state and audit together; an unknown outcome must be inspected without automatic retry.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedCurrentUserId` | `string` | Yes | min length: 1; max length: 200 |
| `expectedVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `userId` | `string` | Yes | min length: 1; max length: 200 |

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
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.changed` | `boolean` | Yes | — |
| `data.methodId` | `string` | Yes | — |
| `data.principalId` | `string` | Yes | — |
| `data.userId` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /api/auth/service-keys`

<span id="post-apiauthservicekeys"></span>

Issue a service API key

**Operation ID:** `createServiceKey`

**Permissions:** Requires a session or Installation-scoped service key with administer on the Installation. Issues a Better Auth key for an existing non-Agent ServicePrincipal in its exact scope when the caller already holds every IAM grant of that ServicePrincipal at the same or a broader scope; creates no identity or IAM grant. The plaintext key is returned only here.

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
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
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

**Permissions:** Requires a session or Installation-scoped service key with administer on the Installation, plus every IAM grant of the key's ServicePrincipal, as for issuance. Deletes the stored Better Auth key; subsequent requests cannot authenticate with it.

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

**Permissions:** Authenticates a local account and issues a user session cookie. In both profiles, repeated failed attempts for one email, or from one client address behind a trusted proxy, spend the password budget and may return 429 once it is spent. A successful sign-in also sets an HttpOnly known-device cookie; later attempts for that email from the same browser spend the browser's own budget instead of the email's. The cookie never authenticates. An email with a NUL character or an unpaired UTF-16 surrogate is refused with 400 INVALID_REQUEST and spends budget like a rejected password; the password is not checked for either.

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
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `429` | Too Many Requests |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.authenticated` | `true` | Yes | — |
| `data.sessionKey` | `string` | No | — |
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
| `403` | Forbidden |
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
| `data[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| [`GET /installation/driver-configurations`](#get-installationdriverconfigurations) | Inspect selected Driver startup configuration schemas |
| [`GET /observability`](#get-observability) | Get the configured external observability destination |

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
| `data.capabilities.credentialSources` | `object` | No | — |
| `data.capabilities.credentialSources.types` | `array<object>` | Yes | — |
| `data.capabilities.credentialSources.types[].config` | `array<object>` | Yes | — |
| `data.capabilities.credentialSources.types[].config[].description` | `string` | No | — |
| `data.capabilities.credentialSources.types[].config[].issuerRotated` | `boolean` | No | — |
| `data.capabilities.credentialSources.types[].config[].name` | `string` | Yes | min length: 1 |
| `data.capabilities.credentialSources.types[].config[].required` | `boolean` | Yes | — |
| `data.capabilities.credentialSources.types[].deviceAuthorization` | `object` | No | — |
| `data.capabilities.credentialSources.types[].deviceAuthorization.harnessId` | `string` | Yes | min length: 1 |
| `data.capabilities.credentialSources.types[].harnessAuth` | `object` | No | — |
| `data.capabilities.credentialSources.types[].harnessAuth.loginMode` | `"api_key" or "codex_pat" or "chatgptAuthTokens"` | Yes | — |
| `data.capabilities.credentialSources.types[].harnessAuth.modelProvider` | `string` | Yes | min length: 1 |
| `data.capabilities.credentialSources.types[].rotation` | `"none" or "external" or "refresh"` | Yes | — |
| `data.capabilities.credentialSources.types[].secrets` | `array<object>` | Yes | — |
| `data.capabilities.credentialSources.types[].secrets[].description` | `string` | No | — |
| `data.capabilities.credentialSources.types[].secrets[].issuerRotated` | `boolean` | No | — |
| `data.capabilities.credentialSources.types[].secrets[].name` | `string` | Yes | min length: 1 |
| `data.capabilities.credentialSources.types[].secrets[].required` | `boolean` | Yes | — |
| `data.capabilities.credentialSources.types[].type` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9-]{0,63}$`; Source type from the selected Credential Gateway catalog, for example `openai`. |
| `data.capabilities.nativeWorkers` | `object` | No | Present only when dedicated native OpenClaw can be admitted, and says where its native worker support comes from. |
| `data.capabilities.nativeWorkers.support` | `"pinned-runtime" or "custom-image"` | Yes | — |
| `data.capabilities.openclaw` | `object` | No | — |
| `data.capabilities.openclaw.executionModes` | `array<"embedded" or "dedicated">` | Yes | max items: 2; The OpenClaw execution modes this Installation's Sandbox Driver and runtime let an Agent deploy. Agent save refuses Embedded with a selected Sandbox Driver, and Dedicated when the Sandbox Driver's settings refuse it (settingRefusals); it saves Dedicated without a Sandbox Driver that can provision it, which deploy refuses. Empty when no mode can deploy: a selected Sandbox Driver refuses Embedded execution, Dedicated needs one that can provision dedicated OpenClaw with settings that allow it, and a selected Sandbox Driver that is unavailable admits neither. |
| `data.capabilities.openclaw.sandboxDriverUnavailable` | `true` | No | Present while the selected Sandbox Driver is unavailable. executionModes is then empty until it returns, and Agent save and deploy answer 503 DEPENDENCY_UNAVAILABLE. |
| `data.capabilities.openclaw.settingRefusals` | `object` | No | Present when the selected Sandbox Driver can provision a mode missing from executionModes but its settings refuse it. Each value is the message Agent save and deploy return for that mode, naming the setting an operator changes. Absent for other reasons a mode is missing. |
| `data.capabilities.openclaw.settingRefusals.dedicated` | `string` | No | min length: 1 |
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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |

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
| `data.capabilities.credentialSources` | `object` | No | — |
| `data.capabilities.credentialSources.types` | `array<object>` | Yes | — |
| `data.capabilities.credentialSources.types[].config` | `array<object>` | Yes | — |
| `data.capabilities.credentialSources.types[].config[].description` | `string` | No | — |
| `data.capabilities.credentialSources.types[].config[].issuerRotated` | `boolean` | No | — |
| `data.capabilities.credentialSources.types[].config[].name` | `string` | Yes | min length: 1 |
| `data.capabilities.credentialSources.types[].config[].required` | `boolean` | Yes | — |
| `data.capabilities.credentialSources.types[].deviceAuthorization` | `object` | No | — |
| `data.capabilities.credentialSources.types[].deviceAuthorization.harnessId` | `string` | Yes | min length: 1 |
| `data.capabilities.credentialSources.types[].harnessAuth` | `object` | No | — |
| `data.capabilities.credentialSources.types[].harnessAuth.loginMode` | `"api_key" or "codex_pat" or "chatgptAuthTokens"` | Yes | — |
| `data.capabilities.credentialSources.types[].harnessAuth.modelProvider` | `string` | Yes | min length: 1 |
| `data.capabilities.credentialSources.types[].rotation` | `"none" or "external" or "refresh"` | Yes | — |
| `data.capabilities.credentialSources.types[].secrets` | `array<object>` | Yes | — |
| `data.capabilities.credentialSources.types[].secrets[].description` | `string` | No | — |
| `data.capabilities.credentialSources.types[].secrets[].issuerRotated` | `boolean` | No | — |
| `data.capabilities.credentialSources.types[].secrets[].name` | `string` | Yes | min length: 1 |
| `data.capabilities.credentialSources.types[].secrets[].required` | `boolean` | Yes | — |
| `data.capabilities.credentialSources.types[].type` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9-]{0,63}$`; Source type from the selected Credential Gateway catalog, for example `openai`. |
| `data.capabilities.nativeWorkers` | `object` | No | Present only when dedicated native OpenClaw can be admitted, and says where its native worker support comes from. |
| `data.capabilities.nativeWorkers.support` | `"pinned-runtime" or "custom-image"` | Yes | — |
| `data.capabilities.openclaw` | `object` | No | — |
| `data.capabilities.openclaw.executionModes` | `array<"embedded" or "dedicated">` | Yes | max items: 2; The OpenClaw execution modes this Installation's Sandbox Driver and runtime let an Agent deploy. Agent save refuses Embedded with a selected Sandbox Driver, and Dedicated when the Sandbox Driver's settings refuse it (settingRefusals); it saves Dedicated without a Sandbox Driver that can provision it, which deploy refuses. Empty when no mode can deploy: a selected Sandbox Driver refuses Embedded execution, Dedicated needs one that can provision dedicated OpenClaw with settings that allow it, and a selected Sandbox Driver that is unavailable admits neither. |
| `data.capabilities.openclaw.sandboxDriverUnavailable` | `true` | No | Present while the selected Sandbox Driver is unavailable. executionModes is then empty until it returns, and Agent save and deploy answer 503 DEPENDENCY_UNAVAILABLE. |
| `data.capabilities.openclaw.settingRefusals` | `object` | No | Present when the selected Sandbox Driver can provision a mode missing from executionModes but its settings refuse it. Each value is the message Agent save and deploy return for that mode, naming the setting an operator changes. Absent for other reasons a mode is missing. |
| `data.capabilities.openclaw.settingRefusals.dedicated` | `string` | No | min length: 1 |
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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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

#### `GET /installation/driver-configurations`

<span id="get-installationdriverconfigurations"></span>

Inspect selected Driver startup configuration schemas

**Operation ID:** `discoverInstallationConfigurations`

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
| `data.configurations` | `array<object>` | Yes | — |
| `data.configurations[].actions` | `object` | Yes | — |
| `data.configurations[].actions.apply` | `object` | No | — |
| `data.configurations[].actions.apply.available` | `boolean` | Yes | — |
| `data.configurations[].actions.apply.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configurations[].actions.apply.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configurations[].actions.read` | `object` | No | — |
| `data.configurations[].actions.read.available` | `boolean` | Yes | — |
| `data.configurations[].actions.read.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configurations[].actions.read.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configurations[].actions.save` | `object` | No | — |
| `data.configurations[].actions.save.available` | `boolean` | Yes | — |
| `data.configurations[].actions.save.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configurations[].actions.save.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configurations[].actions.validate` | `object` | No | — |
| `data.configurations[].actions.validate.available` | `boolean` | Yes | — |
| `data.configurations[].actions.validate.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configurations[].actions.validate.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configurations[].binding` | `"installation-startup" or "sandbox-policy"` | Yes | — |
| `data.configurations[].capability` | `string` | Yes | — |
| `data.configurations[].configurationSchema` | `object<string, any>` | Yes | — |
| `data.configurations[].driverId` | `string` | Yes | — |
| `data.configurations[].implementation` | `string` | Yes | — |
| `data.configurations[].key` | `string` | Yes | — |
| `data.configurations[].scope` | `"installation" or "agent"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /observability`

<span id="get-observability"></span>

Get the configured external observability destination

**Operation ID:** `getObservability`

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
| `data.url` | `string (uri) or null` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="namespaces"></span>

### Namespaces

| Operation | Summary |
| --- | --- |
| [`GET /namespaces`](#get-namespaces) | List authorized Namespaces |
| [`POST /namespaces`](#post-namespaces) | Create an Installation-owned Namespace |
| [`DELETE /namespaces/{namespaceId}`](#delete-namespacesnamespaceid) | Begin or retry deletion of an empty Installation-owned Namespace |
| [`GET /namespaces/{namespaceId}`](#get-namespacesnamespaceid) | Get an exact Installation-owned Namespace |
| [`GET /namespaces/{namespaceId}/permissions`](#get-namespacesnamespaceidpermissions) | Report advisory primary IAM permissions on a readable Namespace, not authorization for a later operation |

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
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |

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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.status` | `"provisioning" or "ready" or "failed" or "deleting"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}`

<span id="delete-namespacesnamespaceid"></span>

Begin or retry deletion of an empty Installation-owned Namespace

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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.status` | `"provisioning" or "ready" or "failed" or "deleting"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/permissions`

<span id="get-namespacesnamespaceidpermissions"></span>

Report advisory primary IAM permissions on a readable Namespace, not authorization for a later operation

**Operation ID:** `getNamespaceCallerPermissions`

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
| `data.agents` | `object` | Yes | — |
| `data.agents.create` | `boolean` | Yes | Whether the selected IAM Driver allows Agent creation in this Namespace now. Advisory only: other required permissions, lifecycle state, or a later authorization decision can still prevent the operation. |
| `data.secrets` | `object` | Yes | — |
| `data.secrets.create` | `boolean` | Yes | Whether the selected IAM Driver allows Secret creation in this Namespace now. Advisory only: other required permissions, lifecycle state, or a later authorization decision can still prevent the operation. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="agents"></span>

### Agents

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/agents`](#get-namespacesnamespaceidagents) | List authorized Agents in one exact Namespace |
| [`POST /namespaces/{namespaceId}/agents`](#post-namespacesnamespaceidagents) | Create a Namespace-owned Agent |
| [`POST /namespaces/{namespaceId}/agents/device-authorizations`](#post-namespacesnamespaceidagentsdeviceauthorizations) | Experimental: Start a private device login for Agent configuration |
| [`DELETE /namespaces/{namespaceId}/agents/device-authorizations/{secretId}`](#delete-namespacesnamespaceidagentsdeviceauthorizationssecretid) | Experimental: Discard a local device login without upstream revocation |
| [`POST /namespaces/{namespaceId}/agents/device-authorizations/{secretId}/poll`](#post-namespacesnamespaceidagentsdeviceauthorizationssecretidpoll) | Experimental: Complete device login without returning credential material |
| [`POST /namespaces/{namespaceId}/agents/models`](#post-namespacesnamespaceidagentsmodels) | List provider models for Agent creation without storing the supplied credential |
| [`POST /namespaces/{namespaceId}/agents/plugins`](#post-namespacesnamespaceidagentsplugins) | List or search available plugins for Agent creation using the selected Driver |
| [`POST /namespaces/{namespaceId}/agents/plugins/details`](#post-namespacesnamespaceidagentspluginsdetails) | Read plugin details using the selected Driver |
| [`POST /namespaces/{namespaceId}/agents/provision`](#post-namespacesnamespaceidagentsprovision) | Create a new Agent and queue first-time provisioning |
| [`GET /namespaces/{namespaceId}/agents/provision/{workId}`](#get-namespacesnamespaceidagentsprovisionworkid) | Get first-time provisioning status for one exact work item |
| [`POST /namespaces/{namespaceId}/agents/provision/{workId}/retry`](#post-namespacesnamespaceidagentsprovisionworkidretry) | Retry failed first-time provisioning for one exact work item |
| [`GET /namespaces/{namespaceId}/agents/repository-options`](#get-namespacesnamespaceidagentsrepositoryoptions) | List approved repository choices for Agent creation in one Namespace |
| [`POST /namespaces/{namespaceId}/agents/validate`](#post-namespacesnamespaceidagentsvalidate) | Check an unsaved Agent Configuration, plugin selections, initial workspace files and Harness authentication as Configuration and Agent create would, without saving anything |
| [`DELETE /namespaces/{namespaceId}/agents/{agentId}`](#delete-namespacesnamespaceidagentsagentid) | Begin or retry deletion of the requested Agent and its Agent revisions |
| [`GET /namespaces/{namespaceId}/agents/{agentId}`](#get-namespacesnamespaceidagentsagentid) | Get an exact Namespace-owned Agent |
| [`PATCH /namespaces/{namespaceId}/agents/{agentId}`](#patch-namespacesnamespaceidagentsagentid) | Replace an exact Namespace-owned Agent's editable draft |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/credential-sources/{credentialSourceId}/withdraw`](#post-namespacesnamespaceidagentsagentidcredentialsourcescredentialsourceidwithdraw) | Revoke one credential source from the selected Agent revision |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/credential-sources/{credentialSourceId}/withdrawal`](#get-namespacesnamespaceidagentsagentidcredentialsourcescredentialsourceidwithdrawal) | Get the withdrawal state of a credential source for an Agent |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/deploy`](#post-namespacesnamespaceidagentsagentiddeploy) | Save an Agent revision from the Agent's saved settings |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/device-authorizations`](#post-namespacesnamespaceidagentsagentiddeviceauthorizations) | Experimental: Start a private device login for Agent configuration |
| [`DELETE /namespaces/{namespaceId}/agents/{agentId}/device-authorizations/{secretId}`](#delete-namespacesnamespaceidagentsagentiddeviceauthorizationssecretid) | Experimental: Discard a local device login without upstream revocation |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/device-authorizations/{secretId}/poll`](#post-namespacesnamespaceidagentsagentiddeviceauthorizationssecretidpoll) | Experimental: Complete device login without returning credential material |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/driver-configurations`](#get-namespacesnamespaceidagentsagentiddriverconfigurations) | Discover authorized Agent Driver configuration contributions |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/harness-status`](#get-namespacesnamespaceidagentsagentidharnessstatus) | Read the Sandbox Driver's record of a running Agent's dedicated Harness Sandbox |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/native-admin`](#get-namespacesnamespaceidagentsagentidnativeadmin) | Resolve native admin UI launch availability for one Agent |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/permissions`](#get-namespacesnamespaceidagentsagentidpermissions) | Report advisory primary IAM permissions on a readable Agent, not authorization for a later operation |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/plugins`](#post-namespacesnamespaceidagentsagentidplugins) | List or search plugins for an active Agent; caller needs Agent read/update. Curated discovery needs no Secret; hosted discovery needs the Agent's bound Service Accounts Secret with caller and Agent Secret operate grants |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/plugins/capabilities`](#get-namespacesnamespaceidagentsagentidpluginscapabilities) | Read selected Plugin Driver policy capabilities for an active Agent with caller Agent read/update permission |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/plugins/details`](#post-namespacesnamespaceidagentsagentidpluginsdetails) | Read plugin details for an active Agent; caller needs Agent read/update. Curated discovery needs no Secret; hosted discovery needs the Agent's bound Service Accounts Secret with caller and Agent Secret operate grants |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/repository-approval-scopes`](#get-namespacesnamespaceidagentsagentidrepositoryapprovalscopes) | Review resolved repository scope before explicitly approving it |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/repository-approvals`](#get-namespacesnamespaceidagentsagentidrepositoryapprovals) | Read attributable repository approvals and removed generations for one Agent |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/repository-approvals/{approvalId}/remove`](#post-namespacesnamespaceidagentsagentidrepositoryapprovalsapprovalidremove) | Remove repository approval independently of configuration or runtime cleanup |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/repository-options`](#get-namespacesnamespaceidagentsagentidrepositoryoptions) | List approved repository choices for updating one Agent |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/revisions/{revisionId}/sandbox-policy/{facet}/recommendations`](#get-namespacesnamespaceidagentsagentidrevisionsrevisionidsandboxpolicyfacetrecommendations) | Read policy suggestions for the requested Agent revision |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`](#get-namespacesnamespaceidagentsagentidruntimecredentials) | Get metadata for one Agent's provisioned runtime credentials |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/runtime-credentials`](#post-namespacesnamespaceidagentsagentidruntimecredentials) | Provision initial runtime credentials for one undeployed Agent |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/runtime-images`](#get-namespacesnamespaceidagentsagentidruntimeimages) | Read observed images and source commits for an Agent's active runtime |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}`](#get-namespacesnamespaceidagentsagentidsandboxpolicyfacet) | Read one Agent sandbox policy and delegation ceiling |
| [`PUT /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}`](#put-namespacesnamespaceidagentsagentidsandboxpolicyfacet) | Replace one Agent network policy additions |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}/apply`](#post-namespacesnamespaceidagentsagentidsandboxpolicyfacetapply) | Apply the saved policy to the running Agent revision |
| [`PATCH /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}/editing`](#patch-namespacesnamespaceidagentsagentidsandboxpolicyfacetediting) | Temporarily enable or disable future policy edits for one Agent |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}/validate`](#post-namespacesnamespaceidagentsagentidsandboxpolicyfacetvalidate) | Preview Agent network policy admission without saving or applying |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/stop`](#post-namespacesnamespaceidagentsagentidstop) | Stop one Agent and keep its saved Agent revision and persistent state |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`](#get-namespacesnamespaceidagentsagentidworkspacefilesname) | Read an allowed workspace file from one active Agent |
| [`PUT /namespaces/{namespaceId}/agents/{agentId}/workspace/files/{name}`](#put-namespacesnamespaceidagentsagentidworkspacefilesname) | Create or replace an allowed workspace file for one active Agent |
| [`POST /namespaces/{namespaceId}/channel-directory/lookup`](#post-namespacesnamespaceidchanneldirectorylookup) | Search a channel directory using an authorized Namespace Secret |
| [`GET /native-admin/return/{agentKey}`](#get-nativeadminreturnagentkey) | Resolve an authorized Agent from a copied native chat link |

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
| `data` | `array<object or object>` | Yes | An Agent with readable saved settings, or Agent metadata with configurationReadError (code SAVED_CONFIGURATION_UNREADABLE and the unreadable field). The error variant omits plugins, pluginApprovers, repositoryBindings, repositoryAccess, harnessAuth, and credentialSources. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents`

<span id="post-namespacesnamespaceidagents"></span>

Create a Namespace-owned Agent

**Operation ID:** `createAgent`

**Permissions:** Requires create permission for Agent resources in the requested Namespace. Requires read permission on the requested Configuration. Requires read permission on each currently associated or newly associated ServiceAccount when present. Requires operate permission on each bound Secret when Secret bindings are present or selected. Requires operate permission on each CredentialSource listed in credentialSources or named by a credential-source harnessAuth.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
| `read` | `configuration` | `requested` |
| `read` | `service_account` | `requested` (when associated) |
| `operate` | `secret` | `requested` (when bound) |
| `operate` | `credential_source` | `request_body` (when bound) |

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
| `credentialSources` | `array<object>` | No | max items: 8; Every credential source the Agent uses, at each source's endpoints. A credential-source harnessAuth names one entry. The selected Credential Gateway injects them at deployment; the Agent never receives their values. |
| `credentialSources[].sourceId` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `executionMode` | `"embedded" or "dedicated"` | No | — |
| `harnessAuth` | `object or object or object or object or null` | No | — |
| `initialWorkspaceFiles` | `object` | No | — |
| `initialWorkspaceFiles.AGENTS.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.IDENTITY.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.SOUL.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.USER.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `repositoryAccess` | `object` | No | Desired repository access. Each omitted repository profile inherits defaultProfile; explicit profiles remain overrides. Mutually exclusive with repositoryBindings in create, provision, and update requests. |
| `repositoryAccess.defaultProfile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryAccess.repositories` | `array<object>` | Yes | max items: 16 |
| `repositoryAccess.repositories[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryAccess.repositories[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
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
| `data.credentialSources` | `array<object>` | No | max items: 8; Every credential source the Agent uses, at each source's endpoints. A credential-source harnessAuth names one entry. The selected Credential Gateway injects them at deployment; the Agent never receives their values. |
| `data.credentialSources[].sourceId` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harnessAuth` | `object or object or object or object or null` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryAccess` | `object` | No | Desired repository access. Each omitted repository profile inherits defaultProfile; explicit profiles remain overrides. Mutually exclusive with repositoryBindings in create, provision, and update requests. |
| `data.repositoryAccess.defaultProfile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryAccess.repositories` | `array<object>` | Yes | max items: 16 |
| `data.repositoryAccess.repositories[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryAccess.repositories[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings` | `array<object>` | No | min items: 1; max items: 16 |
| `data.repositoryBindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.sandboxPolicyEditing` | `boolean` | No | — |
| `data.servicePrincipalId` | `string` | Yes | min length: 1; max length: 200 |
| `data.status` | `"active" or "deleting"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/device-authorizations`

<span id="post-namespacesnamespaceidagentsdeviceauthorizations"></span>

Experimental: Start a private device login for Agent configuration

**Operation ID:** `startAgentDeviceAuthorization`

**Permissions:** Requires create permission for Agent resources in the requested Namespace. Requires create permission for Secret resources in the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
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
| `harnessId` | `string` | Yes | min length: 1; max length: 100 |

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
| `data.expiresAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.intervalSeconds` | `integer` | Yes | minimum: 1 |
| `data.session` | `object` | Yes | Exact OCC Secret reference. Shape: `{ "kind": "secret", "namespaceId": "ns_...", "id": "sec_..." }`. |
| `data.session.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.session.kind` | `"secret"` | Yes | — |
| `data.session.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.source` | `object` | No | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data.source.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.source.kind` | `"credential_source"` | Yes | — |
| `data.source.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.status` | `"pending" or "ready"` | Yes | — |
| `data.userCode` | `string` | Yes | — |
| `data.verificationUrl` | `string (uri)` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}/agents/device-authorizations/{secretId}`

<span id="delete-namespacesnamespaceidagentsdeviceauthorizationssecretid"></span>

Experimental: Discard a local device login without upstream revocation

**Operation ID:** `cancelAgentDeviceAuthorization`

**Permissions:** Requires create permission for Agent resources in the requested Namespace. Requires operate permission on the requested Secret.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
| `operate` | `secret` | `requested` |

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
| `501` | Not Implemented |
| `503` | Service Unavailable |

#### `POST /namespaces/{namespaceId}/agents/device-authorizations/{secretId}/poll`

<span id="post-namespacesnamespaceidagentsdeviceauthorizationssecretidpoll"></span>

Experimental: Complete device login without returning credential material

**Operation ID:** `pollAgentDeviceAuthorization`

**Permissions:** Requires create permission for Agent resources in the requested Namespace. Requires operate permission on the requested Secret.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
| `operate` | `secret` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `secretId` | path | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `501` | Not Implemented |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.expiresAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.intervalSeconds` | `integer` | Yes | minimum: 1 |
| `data.session` | `object` | Yes | Exact OCC Secret reference. Shape: `{ "kind": "secret", "namespaceId": "ns_...", "id": "sec_..." }`. |
| `data.session.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.session.kind` | `"secret"` | Yes | — |
| `data.session.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.source` | `object` | No | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data.source.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.source.kind` | `"credential_source"` | Yes | — |
| `data.source.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.status` | `"pending" or "ready"` | Yes | — |
| `data.userCode` | `string` | Yes | — |
| `data.verificationUrl` | `string (uri)` | Yes | — |
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

Schema: `object or object or object or object`.

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

Schema: `object or object or object or object`.

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

**Permissions:** Requires create permission for Agent resources in the requested Namespace. Requires create permission for Configuration resources in the requested Namespace. Requires administer permission on the requested Installation. Requires read permission on each currently associated or newly associated ServiceAccount when present. Requires operate permission on each existing Secret reference supplied in provisioning inputs.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
| `create` | `configuration` | `namespace` |
| `administer` | `installation` | `requested` |
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
| `harnessAuth` | `object or object or object or object or null` | No | Dedicated Harness authentication, required. Omitted, null and `runtime` are refused with 400 INVALID_REQUEST. A ready model `credential_source` is supported when the selected Credential Gateway owns it and the caller has source `operate` permission. |
| `initialWorkspaceFiles` | `object` | No | — |
| `initialWorkspaceFiles.AGENTS.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.IDENTITY.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.SOUL.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.USER.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `repositoryAccess` | `object` | No | Desired repository access. Each omitted repository profile inherits defaultProfile; explicit profiles remain overrides. Mutually exclusive with repositoryBindings in create, provision, and update requests. |
| `repositoryAccess.defaultProfile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryAccess.repositories` | `array<object>` | Yes | max items: 16 |
| `repositoryAccess.repositories[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryAccess.repositories[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
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
| `data.provisioning.progress` | `object` | No | Present while a job past handoff is queued or running. The job defers without spending attempts while it waits, so `attemptCount` can stay 0. |
| `data.provisioning.progress.lastAttempt` | `null or object` | Yes | With `agent_revision:read`, this can report the deployment's named wait. Otherwise it reports the job's own `PROVISIONING_DEPLOYMENT_PENDING`, or null if the job has not recorded that wait. The controller writes the message; a refusal can include a code restricted to uppercase letters, digits, and underscores. |
| `data.provisioning.progress.phase` | `"deployment"` | Yes | Handoff is done; the job waits for its initial deployment. |
| `data.provisioning.requestId` | `string` | No | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; The client request ID stored when this job was admitted. Older controllers omit it. The separate meta.requestId identifies the current HTTP request. |
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

**Permissions:** Requires create permission for Agent and Configuration resources in the requested Namespace and administer permission on the Installation. These are checked from the request path before any lookup, so a caller without them gets 403 whether or not the Namespace or work item exists. Only the principal that started the work can read it. The caller also needs read, operate and deploy permission on the work's Agent and read and update permission on its Configuration once the work has created them, operate permission on each Secret the work binds or uses for Harness authentication, and read permission on its Harness ServiceAccount when present. OCC re-checks these grants against the initiator while the work runs.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
| `create` | `configuration` | `namespace` |
| `administer` | `installation` | `requested` |
| `read` | `agent` | `requested` (once created) |
| `operate` | `agent` | `requested` (once created) |
| `deploy` | `agent` | `requested` (once created) |
| `read` | `configuration` | `requested` (once created) |
| `update` | `configuration` | `requested` (once created) |
| `read` | `service_account` | `requested` (when associated) |
| `operate` | `secret` | `requested` (when bound) |

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
| `409` | Conflict |
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
| `data.progress` | `object` | No | Present while a job past handoff is queued or running. The job defers without spending attempts while it waits, so `attemptCount` can stay 0. |
| `data.progress.lastAttempt` | `null or object` | Yes | With `agent_revision:read`, this can report the deployment's named wait. Otherwise it reports the job's own `PROVISIONING_DEPLOYMENT_PENDING`, or null if the job has not recorded that wait. The controller writes the message; a refusal can include a code restricted to uppercase letters, digits, and underscores. |
| `data.progress.phase` | `"deployment"` | Yes | Handoff is done; the job waits for its initial deployment. |
| `data.requestId` | `string` | No | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; The client request ID stored when this job was admitted. Older controllers omit it. The separate meta.requestId identifies the current HTTP request. |
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

**Permissions:** Requires create permission for Agent and Configuration resources in the requested Namespace and administer permission on the Installation. These are checked from the request path before any lookup, so a caller without them gets 403 whether or not the Namespace or work item exists. Only the principal that started the work can retry it. The caller also needs read, operate and deploy permission on the work's Agent and read and update permission on its Configuration once the work has created them, operate permission on each Secret the work binds or uses for Harness authentication, and read permission on its Harness ServiceAccount when present. OCC re-checks these grants against the initiator while the work runs.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `agent` | `namespace` |
| `create` | `configuration` | `namespace` |
| `administer` | `installation` | `requested` |
| `read` | `agent` | `requested` (once created) |
| `operate` | `agent` | `requested` (once created) |
| `deploy` | `agent` | `requested` (once created) |
| `read` | `configuration` | `requested` (once created) |
| `update` | `configuration` | `requested` (once created) |
| `read` | `service_account` | `requested` (when associated) |
| `operate` | `secret` | `requested` (when bound) |

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
| `data.progress` | `object` | No | Present while a job past handoff is queued or running. The job defers without spending attempts while it waits, so `attemptCount` can stay 0. |
| `data.progress.lastAttempt` | `null or object` | Yes | With `agent_revision:read`, this can report the deployment's named wait. Otherwise it reports the job's own `PROVISIONING_DEPLOYMENT_PENDING`, or null if the job has not recorded that wait. The controller writes the message; a refusal can include a code restricted to uppercase letters, digits, and underscores. |
| `data.progress.phase` | `"deployment"` | Yes | Handoff is done; the job waits for its initial deployment. |
| `data.requestId` | `string` | No | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; The client request ID stored when this job was admitted. Older controllers omit it. The separate meta.requestId identifies the current HTTP request. |
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
| `503` | Check `error.code`: `REPOSITORY_OPTIONS_UNAVAILABLE` means optional repository discovery is unavailable after Namespace lifecycle and Agent create authorization checks, because the selected Compute or Sandbox Driver cannot support repository credentials or the selected repository Driver is unavailable. Without repository settings the answer is 200 with `meta.notConfigured` instead. Creation without repository bindings remains available subject to fresh authorization. `DEPENDENCY_UNAVAILABLE` includes IAM and other required dependency failures and does not permit proceeding. Successful discovery returns a data array, including an empty array when no repositories are approved. |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `array<object>` | Yes | max items: 1000 |
| `data[].allowedProfiles` | `array<string>` | Yes | min items: 1; max items: 16 |
| `data[].description` | `string` | No | min length: 1; max length: 512 |
| `data[].displayName` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `meta` | `object` | Yes | — |
| `meta.notConfigured` | `true` | No | Present when the Installation has no repository settings, so no repository credential Driver is selected. `data` is then empty, and Agent save refuses repository bindings with 409 RESOURCE_CONFLICT. |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/validate`

<span id="post-namespacesnamespaceidagentsvalidate"></span>

Check an unsaved Agent Configuration, plugin selections, initial workspace files and Harness authentication as Configuration and Agent create would, without saving anything

**Operation ID:** `validateAgentCreate`

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
| `configuration` | `object` | Yes | The Agent Configuration the caller will save, not yet saved. |
| `configuration.kind` | `"agent"` | Yes | — |
| `configuration.values` | `object<string, SafeJsonValue>` | Yes | A native OpenClaw configuration document. |
| `executionMode` | `"embedded" or "dedicated"` | No | — |
| `harnessAuth` | `object or object or object or object or object or null` | No | The Harness authentication Agent create will name, so Agent save's check of it against the execution mode and Compute settings runs here too. For a Secret the caller saves next, send only its `method`. The Secret and credential source are not read; omitted or null skips this check. |
| `initialWorkspaceFiles` | `object` | No | — |
| `initialWorkspaceFiles.AGENTS.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.IDENTITY.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.SOUL.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `initialWorkspaceFiles.USER.md` | `string` | No | max length: 16384; pattern: `^[^\u0000]*$` |
| `name` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$`; The Agent name create will use. A name that another Agent in the Namespace has is refused with create's `409`. |
| `pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |

##### Responses

| Status | Meaning |
| --- | --- |
| `204` | No Content |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

#### `DELETE /namespaces/{namespaceId}/agents/{agentId}`

<span id="delete-namespacesnamespaceidagentsagentid"></span>

Begin or retry deletion of the requested Agent and its Agent revisions

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
| `data.credentialSources` | `array<object>` | No | max items: 8; Every credential source the Agent uses, at each source's endpoints. A credential-source harnessAuth names one entry. The selected Credential Gateway injects them at deployment; the Agent never receives their values. |
| `data.credentialSources[].sourceId` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harnessAuth` | `object or object or object or object or null` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryAccess` | `object` | No | Desired repository access. Each omitted repository profile inherits defaultProfile; explicit profiles remain overrides. Mutually exclusive with repositoryBindings in create, provision, and update requests. |
| `data.repositoryAccess.defaultProfile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryAccess.repositories` | `array<object>` | Yes | max items: 16 |
| `data.repositoryAccess.repositories[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryAccess.repositories[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings` | `array<object>` | No | min items: 1; max items: 16 |
| `data.repositoryBindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.sandboxPolicyEditing` | `boolean` | No | — |
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
| `data` | `object or object` | Yes | An Agent with readable saved settings, or Agent metadata with configurationReadError (code SAVED_CONFIGURATION_UNREADABLE and the unreadable field). The error variant omits plugins, pluginApprovers, repositoryBindings, repositoryAccess, harnessAuth, and credentialSources. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `PATCH /namespaces/{namespaceId}/agents/{agentId}`

<span id="patch-namespacesnamespaceidagentsagentid"></span>

Replace an exact Namespace-owned Agent's editable draft

**Operation ID:** `updateAgent`

**Permissions:** Requires update permission on the requested Agent. Requires read permission on the requested Configuration. Requires read permission on each currently associated or newly associated ServiceAccount when present. Requires operate permission on each bound Secret when Secret bindings are present or selected. Requires operate permission on each CredentialSource the Agent lists or names in harnessAuth, before and after the update.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `agent` | `requested` |
| `read` | `configuration` | `requested` |
| `read` | `service_account` | `requested` (when associated) |
| `operate` | `secret` | `requested` (when bound) |
| `operate` | `credential_source` | `requested` (when bound) |

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
| `credentialSources` | `array<object>` | No | max items: 8; Every credential source the Agent uses, at each source's endpoints. A credential-source harnessAuth names one entry. The selected Credential Gateway injects them at deployment; the Agent never receives their values. |
| `credentialSources[].sourceId` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `executionMode` | `"embedded" or "dedicated"` | No | — |
| `harnessAuth` | `object or object or object or object or null` | No | — |
| `pluginApprovers` | `PluginApprovers or null` | No | — |
| `plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `repositoryAccess` | `object` | No | Desired repository access. Each omitted repository profile inherits defaultProfile; explicit profiles remain overrides. Mutually exclusive with repositoryBindings in create, provision, and update requests. |
| `repositoryAccess.defaultProfile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryAccess.repositories` | `array<object>` | Yes | max items: 16 |
| `repositoryAccess.repositories[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryAccess.repositories[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryBindings` | `array<object>` | No | max items: 16; Requested repository references and optional profiles. Omission means no bindings on create and preserves bindings on update; an empty update clears bindings. Admission requires unique repository references. |
| `repositoryBindings[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `repositoryStandingApproval` | `object or object` | No | — |

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
| `data.credentialSources` | `array<object>` | No | max items: 8; Every credential source the Agent uses, at each source's endpoints. A credential-source harnessAuth names one entry. The selected Credential Gateway injects them at deployment; the Agent never receives their values. |
| `data.credentialSources[].sourceId` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harnessAuth` | `object or object or object or object or null` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryAccess` | `object` | No | Desired repository access. Each omitted repository profile inherits defaultProfile; explicit profiles remain overrides. Mutually exclusive with repositoryBindings in create, provision, and update requests. |
| `data.repositoryAccess.defaultProfile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryAccess.repositories` | `array<object>` | Yes | max items: 16 |
| `data.repositoryAccess.repositories[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryAccess.repositories[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings` | `array<object>` | No | min items: 1; max items: 16 |
| `data.repositoryBindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.sandboxPolicyEditing` | `boolean` | No | — |
| `data.servicePrincipalId` | `string` | Yes | min length: 1; max length: 200 |
| `data.status` | `"active" or "deleting"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/credential-sources/{credentialSourceId}/withdraw`

<span id="post-namespacesnamespaceidagentsagentidcredentialsourcescredentialsourceidwithdraw"></span>

Revoke one credential source from the selected Agent revision

**Operation ID:** `withdrawAgentCredentialSource`

**Permissions:** Requires operate permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `operate` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `credentialSourceId` | path | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `data.completedAt` | `string (date-time)` | No | — |
| `data.credentialSourceId` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.lastAttemptAt` | `string (date-time)` | No | — |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.reason` | `string` | No | pattern: `^[A-Z0-9_]{1,64}$`; Reason code of the worker's most recent attempt, for example `CREDENTIAL_WITHDRAWAL_PENDING` while the gateway has not confirmed revocation. |
| `data.requestedAt` | `string (date-time)` | Yes | — |
| `data.requestedBy` | `string` | Yes | min length: 1; max length: 256; Principal whose `agent:operate` permission the worker re-checks before revoking. |
| `data.revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; Identifies the Agent revision for the reported withdrawal. This is the selected Agent revision unless another Agent revision that can still run has a `pending` withdrawal for this source. A status read first reports a `pending` withdrawal with no queued or running attempt. `revoked` means every Agent revision that can still run with this source has confirmed withdrawal. |
| `data.state` | `"pending" or "revoked"` | Yes | `revoked` only after the Credential Gateway confirms that the Agent revision's placeholders no longer resolve. |
| `data.withdrawalInProgress` | `boolean` | Yes | `true` while a withdrawal attempt is queued or running. A `pending` withdrawal with `false` has no queued or running attempt. OCC maintenance can queue a new attempt. To request another attempt, send the withdraw request again. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/credential-sources/{credentialSourceId}/withdrawal`

<span id="get-namespacesnamespaceidagentsagentidcredentialsourcescredentialsourceidwithdrawal"></span>

Get the withdrawal state of a credential source for an Agent

**Operation ID:** `getAgentCredentialWithdrawal`

**Permissions:** Requires read permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
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
| `data.agentId` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.completedAt` | `string (date-time)` | No | — |
| `data.credentialSourceId` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.lastAttemptAt` | `string (date-time)` | No | — |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.reason` | `string` | No | pattern: `^[A-Z0-9_]{1,64}$`; Reason code of the worker's most recent attempt, for example `CREDENTIAL_WITHDRAWAL_PENDING` while the gateway has not confirmed revocation. |
| `data.requestedAt` | `string (date-time)` | Yes | — |
| `data.requestedBy` | `string` | Yes | min length: 1; max length: 256; Principal whose `agent:operate` permission the worker re-checks before revoking. |
| `data.revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; Identifies the Agent revision for the reported withdrawal. This is the selected Agent revision unless another Agent revision that can still run has a `pending` withdrawal for this source. A status read first reports a `pending` withdrawal with no queued or running attempt. `revoked` means every Agent revision that can still run with this source has confirmed withdrawal. |
| `data.state` | `"pending" or "revoked"` | Yes | `revoked` only after the Credential Gateway confirms that the Agent revision's placeholders no longer resolve. |
| `data.withdrawalInProgress` | `boolean` | Yes | `true` while a withdrawal attempt is queued or running. A `pending` withdrawal with `false` has no queued or running attempt. OCC maintenance can queue a new attempt. To request another attempt, send the withdraw request again. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/deploy`

<span id="post-namespacesnamespaceidagentsagentiddeploy"></span>

Save an Agent revision from the Agent's saved settings

**Operation ID:** `deployAgent`

**Permissions:** Requires deploy permission on the requested Agent. Requires read permission on the requested Configuration. Requires read permission on the Agent when the selected Compute Driver must generate missing runtime credentials for its first deployment. Requires operate permission on the Agent when the selected Compute Driver must generate missing runtime credentials for its first deployment. Requires read permission on each currently associated or newly associated ServiceAccount when present. Requires operate permission on each bound Secret when Secret bindings are present or selected. Requires operate permission on each CredentialSource the Agent lists or names in harnessAuth. Deployment also requires the owning Agent service principal to have operate permission on each bound Secret and on each CredentialSource the Agent lists.

| Action | Resource | Scope |
| --- | --- | --- |
| `deploy` | `agent` | `requested` |
| `read` | `configuration` | `requested` |
| `read` | `agent` | `requested` |
| `operate` | `agent` | `requested` |
| `read` | `service_account` | `requested` (when associated) |
| `operate` | `secret` | `requested` (when bound) |
| `operate` | `credential_source` | `requested` (when bound) |

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
| `data.credentialSources` | `array<object>` | No | max items: 8; Every credential source the Agent uses, at each source's endpoints. A credential-source harnessAuth names one entry. The selected Credential Gateway injects them at deployment; the Agent never receives their values. |
| `data.credentialSources[].sourceId` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.harness` | `object` | Yes | — |
| `data.harness.id` | `string` | Yes | min length: 1 |
| `data.harness.mode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harness.version` | `string` | Yes | min length: 1 |
| `data.harnessAuth` | `object or object or object or object` | Yes | — |
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

#### `POST /namespaces/{namespaceId}/agents/{agentId}/device-authorizations`

<span id="post-namespacesnamespaceidagentsagentiddeviceauthorizations"></span>

Experimental: Start a private device login for Agent configuration

**Operation ID:** `startSavedAgentDeviceAuthorization`

**Permissions:** Requires update permission on the requested Agent. Requires read permission on the requested Agent. Requires create permission for Secret resources in the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `agent` | `requested` |
| `read` | `agent` | `requested` |
| `create` | `secret` | `namespace` |

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
| `harnessId` | `string` | Yes | min length: 1; max length: 100 |

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
| `data.expiresAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.intervalSeconds` | `integer` | Yes | minimum: 1 |
| `data.session` | `object` | Yes | Exact OCC Secret reference. Shape: `{ "kind": "secret", "namespaceId": "ns_...", "id": "sec_..." }`. |
| `data.session.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.session.kind` | `"secret"` | Yes | — |
| `data.session.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.source` | `object` | No | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data.source.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.source.kind` | `"credential_source"` | Yes | — |
| `data.source.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.status` | `"pending" or "ready"` | Yes | — |
| `data.userCode` | `string` | Yes | — |
| `data.verificationUrl` | `string (uri)` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `DELETE /namespaces/{namespaceId}/agents/{agentId}/device-authorizations/{secretId}`

<span id="delete-namespacesnamespaceidagentsagentiddeviceauthorizationssecretid"></span>

Experimental: Discard a local device login without upstream revocation

**Operation ID:** `cancelSavedAgentDeviceAuthorization`

**Permissions:** Requires update permission on the requested Agent. Requires read permission on the requested Agent. Requires operate permission on the requested Secret.

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
| `501` | Not Implemented |
| `503` | Service Unavailable |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/device-authorizations/{secretId}/poll`

<span id="post-namespacesnamespaceidagentsagentiddeviceauthorizationssecretidpoll"></span>

Experimental: Complete device login without returning credential material

**Operation ID:** `pollSavedAgentDeviceAuthorization`

**Permissions:** Requires update permission on the requested Agent. Requires read permission on the requested Agent. Requires operate permission on the requested Secret.

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
| `secretId` | path | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `501` | Not Implemented |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.expiresAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.intervalSeconds` | `integer` | Yes | minimum: 1 |
| `data.session` | `object` | Yes | Exact OCC Secret reference. Shape: `{ "kind": "secret", "namespaceId": "ns_...", "id": "sec_..." }`. |
| `data.session.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.session.kind` | `"secret"` | Yes | — |
| `data.session.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.source` | `object` | No | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data.source.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.source.kind` | `"credential_source"` | Yes | — |
| `data.source.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.status` | `"pending" or "ready"` | Yes | — |
| `data.userCode` | `string` | Yes | — |
| `data.verificationUrl` | `string (uri)` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/driver-configurations`

<span id="get-namespacesnamespaceidagentsagentiddriverconfigurations"></span>

Discover authorized Agent Driver configuration contributions

**Operation ID:** `discoverAgentConfigurations`

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
| `data.configurations` | `array<object>` | Yes | — |
| `data.configurations[].actions` | `object` | Yes | — |
| `data.configurations[].actions.apply` | `object` | No | — |
| `data.configurations[].actions.apply.available` | `boolean` | Yes | — |
| `data.configurations[].actions.apply.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configurations[].actions.apply.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configurations[].actions.read` | `object` | No | — |
| `data.configurations[].actions.read.available` | `boolean` | Yes | — |
| `data.configurations[].actions.read.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configurations[].actions.read.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configurations[].actions.save` | `object` | No | — |
| `data.configurations[].actions.save.available` | `boolean` | Yes | — |
| `data.configurations[].actions.save.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configurations[].actions.save.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configurations[].actions.validate` | `object` | No | — |
| `data.configurations[].actions.validate.available` | `boolean` | Yes | — |
| `data.configurations[].actions.validate.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configurations[].actions.validate.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configurations[].binding` | `"installation-startup" or "sandbox-policy"` | Yes | — |
| `data.configurations[].capability` | `string` | Yes | — |
| `data.configurations[].configurationSchema` | `object<string, any>` | Yes | — |
| `data.configurations[].driverId` | `string` | Yes | — |
| `data.configurations[].implementation` | `string` | Yes | — |
| `data.configurations[].key` | `string` | Yes | — |
| `data.configurations[].scope` | `"installation" or "agent"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/harness-status`

<span id="get-namespacesnamespaceidagentsagentidharnessstatus"></span>

Read the Sandbox Driver's record of a running Agent's dedicated Harness Sandbox

**Operation ID:** `getAgentHarnessStatus`

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
| `data.harness` | `object` | No | The Sandbox Driver reports this provider-owned Harness Sandbox (OpenShell). `lost` means that the Sandbox does not serve this Agent revision. OCC will not restart it. Deploy the Agent again to replace it. `starting` with `HARNESS_RESTARTING` means that the provider is restarting a Harness process that exited. |
| `data.harness.code` | `"SANDBOX_MISSING" or "SANDBOX_DELETING" or "SANDBOX_STOPPED" or "SANDBOX_FAILED" or "HARNESS_EXITED" or "HARNESS_RESTARTING" or "UNAVAILABLE"` | No | — |
| `data.harness.exitCode` | `integer` | No | minimum: -2147483648; maximum: 2147483647; Present only with HARNESS_RESTARTING: the Harness process's last exit code. |
| `data.harness.restarts` | `integer` | No | minimum: 1; maximum: 4294967295; Present only with HARNESS_RESTARTING: the restart number in the current crash loop (1 for a first restart). |
| `data.harness.state` | `"running" or "starting" or "lost" or "unknown"` | Yes | — |
| `data.revisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.status` | `"observed" or "unobserved"` | Yes | `observed` when OCC read the Sandbox record of the running Agent's active revision. `unobserved` when there is nothing to read: the Agent is stopped, deleting or has no active revision, its Harness is not dedicated, or the selected Sandbox Driver keeps no lifecycle record. |
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

#### `GET /namespaces/{namespaceId}/agents/{agentId}/permissions`

<span id="get-namespacesnamespaceidagentsagentidpermissions"></span>

Report advisory primary IAM permissions on a readable Agent, not authorization for a later operation

**Operation ID:** `getAgentCallerPermissions`

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
| `data.administer` | `boolean` | Yes | Whether the selected IAM Driver allows Agent administer now, which native admin UI access needs. Advisory only: other required permissions (native admin UI also needs a signed-in console session), lifecycle state, or a later authorization decision can still prevent the operation. |
| `data.agentSourcesOperate` | `boolean` | Yes | Whether the selected IAM Driver allows, now, the source grants that each Agent update checks: Secret operate on every Secret that the Agent's Configuration binds and on a Secret Harness authentication source, credential source operate on every credential source the Agent lists or uses for Harness authentication, and ServiceAccount read on a ServiceAccount Harness authentication source. `true` when the Agent and its Configuration bind no source. Reported only to a caller with Agent update and Configuration read whose Agent settings are readable; otherwise `false`. Advisory only: other required permissions, lifecycle state, sources that an update adds, or a later authorization decision can still prevent the operation. |
| `data.configurationSecretsOperate` | `boolean` | Yes | Whether the selected IAM Driver allows Secret operate now on every Secret that the Agent's Configuration binds. Each Configuration save needs it for the Secrets it binds. `true` when the Configuration binds no Secret. Reported only to a caller with Configuration read and update; otherwise `false`. Advisory only: other required permissions, lifecycle state, or a later authorization decision can still prevent the operation. |
| `data.configurationUpdate` | `boolean` | Yes | Whether the selected IAM Driver allows update of the Agent's Configuration now, which saving its draft Configuration needs. Advisory only: other required permissions, lifecycle state, or a later authorization decision can still prevent the operation. |
| `data.delete` | `boolean` | Yes | Whether the selected IAM Driver allows Agent delete now. Advisory only: other required permissions, lifecycle state, or a later authorization decision can still prevent the operation. |
| `data.deploy` | `boolean` | Yes | Whether the selected IAM Driver allows Agent deploy now. Advisory only: other required permissions, lifecycle state, or a later authorization decision can still prevent the operation. |
| `data.operate` | `boolean` | Yes | Whether the selected IAM Driver allows Agent operate (used for Stop) now. Advisory only: other required permissions, lifecycle state, or a later authorization decision can still prevent the operation. |
| `data.update` | `boolean` | Yes | Whether the selected IAM Driver allows Agent update now. Advisory only: other required permissions, lifecycle state, or a later authorization decision can still prevent the operation. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `credentialSource` | `object` | No | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `credentialSource.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `credentialSource.kind` | `"credential_source"` | Yes | — |
| `credentialSource.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
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
| `credentialSource` | `object` | No | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `credentialSource.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `credentialSource.kind` | `"credential_source"` | Yes | — |
| `credentialSource.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
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

#### `GET /namespaces/{namespaceId}/agents/{agentId}/repository-approval-scopes`

<span id="get-namespacesnamespaceidagentsagentidrepositoryapprovalscopes"></span>

Review resolved repository scope before explicitly approving it

**Operation ID:** `listAgentStandingApprovalScopes`

**Permissions:** Requires administer permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `agent` | `requested` |

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
| `data[].binding` | `object<string, any>` | Yes | — |
| `data[].repositoryRef` | `string` | Yes | — |
| `data[].scope` | `object<string, any>` | Yes | — |
| `data[].scopeFingerprint` | `string` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/repository-approvals`

<span id="get-namespacesnamespaceidagentsagentidrepositoryapprovals"></span>

Read attributable repository approvals and removed generations for one Agent

**Operation ID:** `listAgentStandingApprovals`

**Permissions:** Requires administer permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `agent` | `requested` |

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
| `data[].approvedBy` | `string` | Yes | — |
| `data[].createdAt` | `string` | Yes | — |
| `data[].generation` | `integer` | Yes | minimum: 1 |
| `data[].id` | `string` | Yes | — |
| `data[].profile` | `string` | Yes | — |
| `data[].repositoryRef` | `string` | Yes | — |
| `data[].revokedAt` | `string` | No | — |
| `data[].scopeFingerprint` | `string` | Yes | — |
| `data[].status` | `"active" or "removed"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/repository-approvals/{approvalId}/remove`

<span id="post-namespacesnamespaceidagentsagentidrepositoryapprovalsapprovalidremove"></span>

Remove repository approval independently of configuration or runtime cleanup

**Operation ID:** `removeAgentStandingApproval`

**Permissions:** Requires administer permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `approvalId` | path | `string` | Yes | pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedGeneration` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |

##### Responses

| Status | Meaning |
| --- | --- |
| `204` | No Content |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `413` | Payload Too Large |
| `415` | Unsupported Media Type |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/repository-options`

<span id="get-namespacesnamespaceidagentsagentidrepositoryoptions"></span>

List approved repository choices for updating one Agent

**Operation ID:** `listAgentRepositoryOptions`

**Permissions:** Requires update permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `agent` | `requested` |

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
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `array<object>` | Yes | max items: 1000 |
| `data[].allowedProfiles` | `array<string>` | Yes | min items: 1; max items: 16 |
| `data[].description` | `string` | No | min length: 1; max length: 512 |
| `data[].displayName` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `meta` | `object` | Yes | — |
| `meta.notConfigured` | `true` | No | Present when the Installation has no repository settings, so no repository credential Driver is selected. `data` is then empty, and Agent save refuses repository bindings with 409 RESOURCE_CONFLICT. |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/revisions/{revisionId}/sandbox-policy/{facet}/recommendations`

<span id="get-namespacesnamespaceidagentsagentidrevisionsrevisionidsandboxpolicyfacetrecommendations"></span>

Read policy suggestions for the requested Agent revision

**Operation ID:** `getAgentSandboxRecommendations`

**Permissions:** Requires read permission on the requested Agent. Requires read permission on the requested SandboxPolicy.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |
| `read` | `sandbox_policy` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `facet` | path | `"networking" or "filesystem" or "process"` | Yes | — |
| `revisionId` | path | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `409` | Conflict |
| `429` | Too Many Requests |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.providerVersion` | `string` | No | max length: 128 |
| `data.recommendations` | `array<object>` | Yes | max items: 32 |
| `data.recommendations[].grant` | `object` | Yes | — |
| `data.recommendations[].grant.binary` | `string` | Yes | min length: 2; max length: 512; pattern: `^/[^\s\x00-\x1f]+$`; Absolute path of the executable receiving access. |
| `data.recommendations[].grant.host` | `string` | Yes | min length: 1; max length: 253; pattern: `^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`; DNS hostname or permitted single-label wildcard. Grants allow access; omitted destinations stay denied. |
| `data.recommendations[].grant.id` | `string` | Yes | pattern: `^[a-z][a-z0-9-]{0,47}$` |
| `data.recommendations[].grant.ports` | `array<object>` | Yes | min items: 1; max items: 16 |
| `data.recommendations[].grant.ports[].from` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `data.recommendations[].grant.ports[].to` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `data.recommendations[].id` | `string` | Yes | — |
| `data.recommendations[].observations` | `integer` | No | minimum: 0 |
| `data.recommendations[].status` | `"pending" or "approved" or "rejected"` | Yes | — |
| `data.truncated` | `boolean` | Yes | — |
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

#### `GET /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}`

<span id="get-namespacesnamespaceidagentsagentidsandboxpolicyfacet"></span>

Read one Agent sandbox policy and delegation ceiling

**Operation ID:** `getAgentSandboxPolicy`

**Permissions:** Requires read permission on the requested Agent. Requires read permission on the requested SandboxPolicy.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |
| `read` | `sandbox_policy` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `facet` | path | `"networking" or "filesystem" or "process"` | Yes | — |

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
| `data.capability` | `null or object` | Yes | — |
| `data.ceiling` | `array<object>` | Yes | max items: 32 |
| `data.ceiling[].binary` | `string` | Yes | min length: 2; max length: 512; pattern: `^/[^\s\x00-\x1f]+$`; Absolute path of the executable receiving access. |
| `data.ceiling[].host` | `string` | Yes | min length: 1; max length: 253; pattern: `^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`; DNS hostname or permitted single-label wildcard. Grants allow access; omitted destinations stay denied. |
| `data.ceiling[].id` | `string` | Yes | pattern: `^[a-z][a-z0-9-]{0,47}$` |
| `data.ceiling[].ports` | `array<object>` | Yes | min items: 1; max items: 16 |
| `data.ceiling[].ports[].from` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `data.ceiling[].ports[].to` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `data.configuration` | `object` | No | — |
| `data.configuration.actions` | `object` | Yes | — |
| `data.configuration.actions.apply` | `object` | No | — |
| `data.configuration.actions.apply.available` | `boolean` | Yes | — |
| `data.configuration.actions.apply.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configuration.actions.apply.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configuration.actions.read` | `object` | No | — |
| `data.configuration.actions.read.available` | `boolean` | Yes | — |
| `data.configuration.actions.read.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configuration.actions.read.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configuration.actions.save` | `object` | No | — |
| `data.configuration.actions.save.available` | `boolean` | Yes | — |
| `data.configuration.actions.save.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configuration.actions.save.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configuration.actions.validate` | `object` | No | — |
| `data.configuration.actions.validate.available` | `boolean` | Yes | — |
| `data.configuration.actions.validate.href` | `string` | Yes | max length: 2048; pattern: `^/[^/]` |
| `data.configuration.actions.validate.method` | `"GET" or "POST" or "PUT"` | Yes | — |
| `data.configuration.binding` | `"installation-startup" or "sandbox-policy"` | Yes | — |
| `data.configuration.capability` | `string` | Yes | — |
| `data.configuration.configurationSchema` | `object<string, any>` | Yes | — |
| `data.configuration.driverId` | `string` | Yes | — |
| `data.configuration.implementation` | `string` | Yes | — |
| `data.configuration.key` | `string` | Yes | — |
| `data.configuration.scope` | `"installation" or "agent"` | Yes | — |
| `data.defaults` | `null or object<string, any>` | Yes | — |
| `data.defaultsRevisionId` | `string` | No | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.editingEnabled` | `boolean` | Yes | — |
| `data.policy` | `object` | Yes | — |
| `data.policy.additions` | `array<object>` | Yes | max items: 32 |
| `data.policy.additions[].binary` | `string` | Yes | min length: 2; max length: 512; pattern: `^/[^\s\x00-\x1f]+$`; Absolute path of the executable receiving access. |
| `data.policy.additions[].host` | `string` | Yes | min length: 1; max length: 253; pattern: `^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`; DNS hostname or permitted single-label wildcard. Grants allow access; omitted destinations stay denied. |
| `data.policy.additions[].id` | `string` | Yes | pattern: `^[a-z][a-z0-9-]{0,47}$` |
| `data.policy.additions[].ports` | `array<object>` | Yes | min items: 1; max items: 16 |
| `data.policy.additions[].ports[].from` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `data.policy.additions[].ports[].to` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `data.policy.agentId` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.policy.application` | `object` | No | — |
| `data.policy.application.id` | `string (uuid)` | Yes | — |
| `data.policy.application.policyVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `data.policy.application.providerVersion` | `string` | No | — |
| `data.policy.application.reason` | `string` | No | — |
| `data.policy.application.requestedAt` | `string` | Yes | — |
| `data.policy.application.requestedBy` | `string` | Yes | — |
| `data.policy.application.revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.policy.application.state` | `"pending" or "applied" or "failed"` | Yes | — |
| `data.policy.applied` | `object` | No | — |
| `data.policy.applied.appliedAt` | `string` | Yes | — |
| `data.policy.applied.policyVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `data.policy.applied.providerVersion` | `string` | Yes | — |
| `data.policy.applied.revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.policy.id` | `string` | Yes | pattern: `^sbp_[0-9a-f-]{36}$` |
| `data.policy.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.policy.version` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `data.protectedExecution` | `boolean` | Yes | True while the active revision or the next deploy runs under protected execution. Saving network policy additions is then refused with SANDBOX_POLICY_PROTECTED_EXECUTION; saving an empty policy stays allowed. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `PUT /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}`

<span id="put-namespacesnamespaceidagentsagentidsandboxpolicyfacet"></span>

Replace one Agent network policy additions

**Operation ID:** `updateAgentSandboxPolicy`

**Permissions:** Requires manage_policy permission on the requested Agent. Requires update permission on the requested SandboxPolicy.

| Action | Resource | Scope |
| --- | --- | --- |
| `manage_policy` | `agent` | `requested` |
| `update` | `sandbox_policy` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `facet` | path | `"networking" or "filesystem" or "process"` | Yes | — |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `additions` | `array<object>` | Yes | max items: 32 |
| `additions[].binary` | `string` | Yes | min length: 2; max length: 512; pattern: `^/[^\s\x00-\x1f]+$`; Absolute path of the executable receiving access. |
| `additions[].host` | `string` | Yes | min length: 1; max length: 253; pattern: `^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`; DNS hostname or permitted single-label wildcard. Grants allow access; omitted destinations stay denied. |
| `additions[].id` | `string` | Yes | pattern: `^[a-z][a-z0-9-]{0,47}$` |
| `additions[].ports` | `array<object>` | Yes | min items: 1; max items: 16 |
| `additions[].ports[].from` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `additions[].ports[].to` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `expectedVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |

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
| `data.additions` | `array<object>` | Yes | max items: 32 |
| `data.additions[].binary` | `string` | Yes | min length: 2; max length: 512; pattern: `^/[^\s\x00-\x1f]+$`; Absolute path of the executable receiving access. |
| `data.additions[].host` | `string` | Yes | min length: 1; max length: 253; pattern: `^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`; DNS hostname or permitted single-label wildcard. Grants allow access; omitted destinations stay denied. |
| `data.additions[].id` | `string` | Yes | pattern: `^[a-z][a-z0-9-]{0,47}$` |
| `data.additions[].ports` | `array<object>` | Yes | min items: 1; max items: 16 |
| `data.additions[].ports[].from` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `data.additions[].ports[].to` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `data.agentId` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.application` | `object` | No | — |
| `data.application.id` | `string (uuid)` | Yes | — |
| `data.application.policyVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `data.application.providerVersion` | `string` | No | — |
| `data.application.reason` | `string` | No | — |
| `data.application.requestedAt` | `string` | Yes | — |
| `data.application.requestedBy` | `string` | Yes | — |
| `data.application.revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.application.state` | `"pending" or "applied" or "failed"` | Yes | — |
| `data.applied` | `object` | No | — |
| `data.applied.appliedAt` | `string` | Yes | — |
| `data.applied.policyVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `data.applied.providerVersion` | `string` | Yes | — |
| `data.applied.revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.id` | `string` | Yes | pattern: `^sbp_[0-9a-f-]{36}$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.version` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}/apply`

<span id="post-namespacesnamespaceidagentsagentidsandboxpolicyfacetapply"></span>

Apply the saved policy to the running Agent revision

**Operation ID:** `applyAgentSandboxPolicy`

**Permissions:** Requires manage_policy permission on the requested Agent. Requires update permission on the requested SandboxPolicy.

| Action | Resource | Scope |
| --- | --- | --- |
| `manage_policy` | `agent` | `requested` |
| `update` | `sandbox_policy` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `facet` | path | `"networking" or "filesystem" or "process"` | Yes | — |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `data.additions` | `array<object>` | Yes | max items: 32 |
| `data.additions[].binary` | `string` | Yes | min length: 2; max length: 512; pattern: `^/[^\s\x00-\x1f]+$`; Absolute path of the executable receiving access. |
| `data.additions[].host` | `string` | Yes | min length: 1; max length: 253; pattern: `^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`; DNS hostname or permitted single-label wildcard. Grants allow access; omitted destinations stay denied. |
| `data.additions[].id` | `string` | Yes | pattern: `^[a-z][a-z0-9-]{0,47}$` |
| `data.additions[].ports` | `array<object>` | Yes | min items: 1; max items: 16 |
| `data.additions[].ports[].from` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `data.additions[].ports[].to` | `integer` | Yes | minimum: 1; maximum: 65535 |
| `data.agentId` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.application` | `object` | No | — |
| `data.application.id` | `string (uuid)` | Yes | — |
| `data.application.policyVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `data.application.providerVersion` | `string` | No | — |
| `data.application.reason` | `string` | No | — |
| `data.application.requestedAt` | `string` | Yes | — |
| `data.application.requestedBy` | `string` | Yes | — |
| `data.application.revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.application.state` | `"pending" or "applied" or "failed"` | Yes | — |
| `data.applied` | `object` | No | — |
| `data.applied.appliedAt` | `string` | Yes | — |
| `data.applied.policyVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `data.applied.providerVersion` | `string` | Yes | — |
| `data.applied.revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.id` | `string` | Yes | pattern: `^sbp_[0-9a-f-]{36}$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.version` | `integer` | Yes | minimum: 1; maximum: 2147483647 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `PATCH /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}/editing`

<span id="patch-namespacesnamespaceidagentsagentidsandboxpolicyfacetediting"></span>

Temporarily enable or disable future policy edits for one Agent

**Operation ID:** `TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing`

**Permissions:** Requires administer permission on the requested Agent. Requires administer permission for Installation resources in the Installation.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `agent` | `requested` |
| `administer` | `installation` | `installation` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `facet` | path | `"networking" or "filesystem" or "process"` | Yes | — |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `enabled` | `boolean` | Yes | — |

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
| `data.credentialSources` | `array<object>` | No | max items: 8; Every credential source the Agent uses, at each source's endpoints. A credential-source harnessAuth names one entry. The selected Credential Gateway injects them at deployment; the Agent never receives their values. |
| `data.credentialSources[].sourceId` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harnessAuth` | `object or object or object or object or null` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryAccess` | `object` | No | Desired repository access. Each omitted repository profile inherits defaultProfile; explicit profiles remain overrides. Mutually exclusive with repositoryBindings in create, provision, and update requests. |
| `data.repositoryAccess.defaultProfile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryAccess.repositories` | `array<object>` | Yes | max items: 16 |
| `data.repositoryAccess.repositories[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryAccess.repositories[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings` | `array<object>` | No | min items: 1; max items: 16 |
| `data.repositoryBindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.sandboxPolicyEditing` | `boolean` | No | — |
| `data.servicePrincipalId` | `string` | Yes | min length: 1; max length: 200 |
| `data.status` | `"active" or "deleting"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/sandbox-policy/{facet}/validate`

<span id="post-namespacesnamespaceidagentsagentidsandboxpolicyfacetvalidate"></span>

Preview Agent network policy admission without saving or applying

**Operation ID:** `validateAgentSandboxPolicy`

**Permissions:** Requires manage_policy permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `manage_policy` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `facet` | path | `"networking" or "filesystem" or "process"` | Yes | — |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `additions` | `any` | Yes | — |
| `expectedVersion` | `integer` | Yes | minimum: 1; maximum: 2147483647 |

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
| `data` | `object or object` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/stop`

<span id="post-namespacesnamespaceidagentsagentidstop"></span>

Stop one Agent and keep its saved Agent revision and persistent state

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
| `data.credentialSources` | `array<object>` | No | max items: 8; Every credential source the Agent uses, at each source's endpoints. A credential-source harnessAuth names one entry. The selected Credential Gateway injects them at deployment; the Agent never receives their values. |
| `data.credentialSources[].sourceId` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.desiredRuntimeState` | `"running" or "stopped"` | Yes | — |
| `data.executionMode` | `"embedded" or "dedicated"` | Yes | — |
| `data.harnessAuth` | `object or object or object or object or null` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.pluginApprovers` | `PluginApprovers` | No | max items: 64 |
| `data.pluginApprovers[].channel` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9_-]*$` |
| `data.pluginApprovers[].id` | `string` | Yes | min length: 1; max length: 200; pattern: `^[^\u0000-\u0020\u007f]+$` |
| `data.plugins` | `PluginDesiredState` | No | Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$. |
| `data.repositoryAccess` | `object` | No | Desired repository access. Each omitted repository profile inherits defaultProfile; explicit profiles remain overrides. Mutually exclusive with repositoryBindings in create, provision, and update requests. |
| `data.repositoryAccess.defaultProfile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryAccess.repositories` | `array<object>` | Yes | max items: 16 |
| `data.repositoryAccess.repositories[].profile` | `string` | No | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryAccess.repositories[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings` | `array<object>` | No | min items: 1; max items: 16 |
| `data.repositoryBindings[].profile` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.repositoryBindings[].repositoryRef` | `string` | Yes | min length: 1; max length: 128; pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `data.sandboxPolicyEditing` | `boolean` | No | — |
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

#### `GET /native-admin/return/{agentKey}`

<span id="get-nativeadminreturnagentkey"></span>

Resolve an authorized Agent from a copied native chat link

**Operation ID:** `resolveAgentNativeAdminReturn`

**Permissions:** Requires a human session with administer permission on the exact Agent. Unknown and inaccessible Agents both return 404. This lookup does not launch or start the Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `agentKey` | path | `string` | Yes | pattern: `^[0-9a-f]{32}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | OK |
| `400` | Invalid Agent key |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `429` | Too many requests; wait for Retry-After |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.agentId` | `string` | Yes | min length: 1; max length: 200 |
| `data.namespaceId` | `string` | Yes | min length: 1; max length: 200 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | — |

<span id="agent-deployments"></span>

### Agent deployments

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}`](#get-namespacesnamespaceidagentsagentiddeploymentsdeploymentid) | Get the saved deployment status for an Agent revision |
| [`POST /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}/diagnostics`](#post-namespacesnamespaceidagentsagentiddeploymentsdeploymentiddiagnostics) | Check the current runtime for an Agent revision |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}/runtime`](#get-namespacesnamespaceidagentsagentiddeploymentsdeploymentidruntime) | Read Pod status, restart counts, Events, and log sources for an Agent revision |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}/runtime/logs`](#get-namespacesnamespaceidagentsagentiddeploymentsdeploymentidruntimelogs) | Read one page of redacted container output for an Agent revision |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}`

<span id="get-namespacesnamespaceidagentsagentiddeploymentsdeploymentid"></span>

Get the saved deployment status for an Agent revision

**Operation ID:** `getAgentDeployment`

**Permissions:** Requires read permission on the requested Agent revision.

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
| `data.cleanup` | `null or object` | Yes | Saved cleanup status for this Agent revision, separate from its deployment result. `null` means no cleanup requirement was recorded. `succeeded` confirms that cleanup is complete. |
| `data.deploymentId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.error` | `null or object` | Yes | `null` unless deployment failed. A failure contains `code`, a fixed safe message, and optional data with known fields. `CONVERGENCE_DEADLINE_EXCEEDED` can include `data.timeoutMs` and `data.runtimeFailure` with startup failure details. A component, check, or code unknown to the runtime is shown as `UNRECOGNIZED`. `RUNTIME_MODEL_PROBE_FAILED` can include `data.runtimeFailure` with the cause of the failed startup model check. The response never includes native error text. |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.progress` | `null or object` | Yes | Pending deployment progress. Null for terminal outcomes. A last attempt describes a recorded result, not current runtime health. |
| `data.status` | `"queued" or "running" or "succeeded" or "failed"` | Yes | — |
| `data.warnings` | `array<object>` | Yes | Warnings recorded from this deployment startup. Plugin install and connector-auth warnings mean the deployment succeeded after the runtime disabled the affected admitted plugin for that startup. |
| `data.warnings[].code` | `"PLUGIN_INSTALL_FAILED" or "PLUGIN_AUTH_REQUIRED"` | Yes | — |
| `data.warnings[].pluginId` | `string` | Yes | min length: 1; max length: 253; pattern: `^[A-Za-z0-9._~:@-]{1,253}$`; The admitted Agent plugin selection key. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}/diagnostics`

<span id="post-namespacesnamespaceidagentsagentiddeploymentsdeploymentiddiagnostics"></span>

Check the current runtime for an Agent revision

**Operation ID:** `diagnoseAgentDeployment`

**Permissions:** Requires operate permission on the requested Agent. Requires read permission on the requested Agent. Requires read permission on the requested Agent revision.

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

#### `GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}/runtime`

<span id="get-namespacesnamespaceidagentsagentiddeploymentsdeploymentidruntime"></span>

Read Pod status, restart counts, Events, and log sources for an Agent revision

**Operation ID:** `getAgentDeploymentRuntime`

**Permissions:** Requires operate permission on the requested Agent. Requires read permission on the requested Agent. Requires read permission on the requested Agent revision.

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
| `429` | Too Many Requests |
| `500` | Internal Server Error |
| `501` | Not Implemented |
| `503` | Service Unavailable |
| `504` | Gateway Timeout |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.harness` | `object` | No | The Sandbox Driver reports this provider-owned Harness Sandbox (OpenShell). `lost` means that the Sandbox does not serve this Agent revision. OCC will not restart it. Deploy the Agent again to replace it. `starting` with `HARNESS_RESTARTING` means that the provider is restarting a Harness process that exited. |
| `data.harness.code` | `"SANDBOX_MISSING" or "SANDBOX_DELETING" or "SANDBOX_STOPPED" or "SANDBOX_FAILED" or "HARNESS_EXITED" or "HARNESS_RESTARTING" or "UNAVAILABLE"` | No | — |
| `data.harness.exitCode` | `integer` | No | minimum: -2147483648; maximum: 2147483647; Present only with HARNESS_RESTARTING: the Harness process's last exit code. |
| `data.harness.restarts` | `integer` | No | minimum: 1; maximum: 4294967295; Present only with HARNESS_RESTARTING: the restart number in the current crash loop (1 for a first restart). |
| `data.harness.state` | `"running" or "starting" or "lost" or "unknown"` | Yes | — |
| `data.observedAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.pods` | `array<object>` | Yes | max items: 16 |
| `data.pods[].cluster` | `"control" or "execution"` | Yes | — |
| `data.pods[].containers` | `array<object>` | Yes | max items: 16 |
| `data.pods[].containers[].lastTermination` | `object or null` | Yes | — |
| `data.pods[].containers[].name` | `string` | Yes | min length: 1; max length: 253; pattern: `^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$` |
| `data.pods[].containers[].ready` | `boolean` | Yes | — |
| `data.pods[].containers[].reason` | `string or null` | Yes | — |
| `data.pods[].containers[].restartCount` | `integer` | Yes | minimum: 0 |
| `data.pods[].containers[].startedAt` | `string (date-time) or null` | Yes | — |
| `data.pods[].containers[].state` | `"waiting" or "running" or "terminated" or "unknown"` | Yes | — |
| `data.pods[].createdAt` | `string (date-time) or null` | Yes | — |
| `data.pods[].events` | `array<object>` | Yes | max items: 100 |
| `data.pods[].events[].container` | `string or null` | Yes | — |
| `data.pods[].events[].count` | `integer` | Yes | minimum: 1 |
| `data.pods[].events[].lastObservedAt` | `string (date-time) or null` | Yes | — |
| `data.pods[].events[].message` | `string` | Yes | max length: 2048 |
| `data.pods[].events[].reason` | `string` | Yes | max length: 128 |
| `data.pods[].events[].type` | `"Normal" or "Warning"` | Yes | — |
| `data.pods[].name` | `string` | Yes | min length: 1; max length: 253; pattern: `^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$` |
| `data.pods[].phase` | `string` | Yes | max length: 64 |
| `data.pods[].ready` | `boolean` | Yes | — |
| `data.pods[].role` | `"gateway" or "agent"` | Yes | — |
| `data.pods[].uid` | `string` | Yes | min length: 1; max length: 64; pattern: `^[A-Za-z0-9-]+$` |
| `data.revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.sources` | `array<object>` | Yes | max items: 4 |
| `data.sources[].available` | `boolean` | Yes | — |
| `data.sources[].id` | `"gateway" or "agent" or "sandbox"` | Yes | — |
| `data.sources[].kind` | `"container" or "sandbox"` | Yes | — |
| `data.sources[].pods` | `array<object>` | Yes | max items: 256 |
| `data.sources[].pods[].container` | `string` | Yes | min length: 1; max length: 253; pattern: `^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$` |
| `data.sources[].pods[].name` | `string` | Yes | min length: 1; max length: 253; pattern: `^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$` |
| `data.sources[].pods[].restartCount` | `integer` | Yes | minimum: 0 |
| `data.sources[].pods[].uid` | `string` | Yes | min length: 1; max length: 64; pattern: `^[A-Za-z0-9-]+$` |
| `data.sources[].retention` | `string` | Yes | max length: 512 |
| `data.sources[].unavailableCode` | `"NO_POD"` | No | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/deployments/{deploymentId}/runtime/logs`

<span id="get-namespacesnamespaceidagentsagentiddeploymentsdeploymentidruntimelogs"></span>

Read one page of redacted container output for an Agent revision

**Operation ID:** `getAgentDeploymentRuntimeLogs`

**Permissions:** Requires read_logs permission on the requested Agent. Without read_logs, administer permission on the requested Agent also admits the read. Requires read permission on the requested Agent.

| Action | Resource | Scope |
| --- | --- | --- |
| `read_logs` | `agent` | `requested` |
| `administer` | `agent` | `requested` (instead of `read_logs`) |
| `read` | `agent` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `source` | query | `"gateway" or "agent" or "sandbox"` | Yes | — |
| `pod` | query | `string` | No | min length: 1; max length: 253; pattern: `^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$` |
| `container` | query | `string` | No | min length: 1; max length: 253; pattern: `^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$` |
| `previous` | query | `"true" or "false"` | No | — |
| `tailLines` | query | `string` | No | pattern: `^(?:[1-9][0-9]{0,2}\|1000)$` |
| `sinceSeconds` | query | `string` | No | pattern: `^(?:[1-9][0-9]{0,3}\|[1-7][0-9]{4}\|8[0-5][0-9]{3}\|86[0-3][0-9]{2}\|86400)$` |
| `minLevel` | query | `"error" or "warn" or "info" or "debug"` | No | — |
| `cursor` | query | `string` | No | max length: 2048; pattern: `^v[12]\.[A-Za-z0-9_-]{1,1900}\.[A-Za-z0-9_-]{43}$` |
| `download` | query | `"true" or "false"` | No | — |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `agentId` | path | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `deploymentId` | path | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | One page of records, or a text/plain attachment when `download=true` |
| `400` | Bad Request |
| `401` | Unauthorized |
| `403` | Forbidden |
| `404` | Not Found |
| `429` | Too Many Requests |
| `500` | Internal Server Error |
| `501` | Not Implemented |
| `503` | Service Unavailable |
| `504` | Gateway Timeout |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.cursor` | `string or null` | Yes | — |
| `data.observedAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data.records` | `array<object or object or object>` | Yes | max items: 1100 |
| `data.revisionId` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.source` | `"gateway" or "agent" or "sandbox"` | Yes | — |
| `data.stream` | `object or null` | Yes | — |
| `data.truncated` | `boolean` | Yes | — |
| `data.withheld` | `integer` | Yes | minimum: 0 |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

**`200` response body:** `text/plain`

Schema: `string`.

<span id="agent-revisions"></span>

### Agent revisions

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/revisions`](#get-namespacesnamespaceidagentsagentidrevisions) | List Agent revision summaries that you can read for the requested Agent, newest first |
| [`GET /namespaces/{namespaceId}/agents/{agentId}/revisions/{revisionId}`](#get-namespacesnamespaceidagentsagentidrevisionsrevisionid) | Get an Agent revision that you can read |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/revisions`

<span id="get-namespacesnamespaceidagentsagentidrevisions"></span>

List Agent revision summaries that you can read for the requested Agent, newest first

**Operation ID:** `listAgentRevisions`

**Permissions:** Requires read permission on the requested Agent. Only Agent revision resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `agent` | `requested` |
| `read` | `agent_revision` | `each_returned` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `limit` | query | `string` | No | pattern: `^(?:[1-9][0-9]?\|100)$` |
| `cursor` | query | `string` | No | max length: 32; pattern: `^v1\.[1-9][0-9]{0,14}$` |
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
| `data` | `array<object>` | Yes | max items: 100; Agent revisions that you can read, newest first. |
| `data[].agentId` | `string` | Yes | pattern: `^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].backendId` | `string or null` | Yes | — |
| `data[].configurationGeneration` | `integer` | Yes | minimum: 1; maximum: 9007199254740991 |
| `data[].configurationId` | `string` | Yes | pattern: `^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].createdAt` | `string (date-time)` | Yes | pattern: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$` |
| `data[].deploymentErrorCode` | `string or null` | Yes | The `error.code` that reading this revision's deployment would report, or `null` when it reports no error. It tells a failure from a deployment that a newer version or a Stop ended. |
| `data[].deploymentStatus` | `"queued" or "running" or "succeeded" or "failed" or null` | Yes | The status that reading this revision's deployment would report, or `null` when OCC has no deployment record for it. |
| `data[].harness` | `object` | Yes | — |
| `data[].harness.id` | `string` | Yes | min length: 1 |
| `data[].harness.mode` | `"embedded" or "dedicated"` | Yes | — |
| `data[].harness.version` | `string` | Yes | min length: 1 |
| `data[].id` | `string` | Yes | pattern: `^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].revision` | `integer` | Yes | minimum: 1 |
| `meta` | `object` | Yes | — |
| `meta.nextCursor` | `string or null` | Yes | Pass this value as `cursor` to read older Agent revisions. OCC returns a cursor only when it finds an older Agent revision that you can read during this request. A later page can be empty if access changes. `null` means OCC found no older Agent revision that you can read. |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/agents/{agentId}/revisions/{revisionId}`

<span id="get-namespacesnamespaceidagentsagentidrevisionsrevisionid"></span>

Get an Agent revision that you can read

**Operation ID:** `getAgentRevision`

**Permissions:** Requires read permission on the requested Agent revision.

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
| `data` | `object or object` | Yes | Returns an Agent revision with saved settings that cannot change. If OCC cannot read them, the response omits saved configuration fields and includes `configurationReadError` with code `SAVED_CONFIGURATION_UNREADABLE` and the unreadable field. |
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
| `expectedGeneration` | `integer` | No | minimum: 1; maximum: 9007199254740991; The generation this update replaces, from the caller's last read. A Configuration at another generation refuses the update with 409 and an `/expectedGeneration` detail, and keeps its content. Omitted, the update replaces whatever generation is current. |
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
| [`PATCH /namespaces/{namespaceId}/credential-sources/{credentialSourceId}`](#patch-namespacesnamespaceidcredentialsourcescredentialsourceid) | Push current or replacement Secret values to the Credential Gateway copy |
| [`POST /namespaces/{namespaceId}/credential-sources/{credentialSourceId}/rotate`](#post-namespacesnamespaceidcredentialsourcescredentialsourceidrotate) | Force the Credential Refresh Driver to mint a new token for a refresh-type source |

#### `GET /namespaces/{namespaceId}/credential-sources`

<span id="get-namespacesnamespaceidcredentialsources"></span>

List readable credential sources without revealing credential values

**Operation ID:** `listCredentialSources`

**Permissions:** Requires read permission on the requested Namespace. Only CredentialSource resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `namespace` | `requested` |
| `read` | `credential_source` | `each_returned` |

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
| `data[].egress` | `object` | No | Protected live static, eligible prepared, or explicitly credential-free metadata access. Each profile requires its own grant; missing material never selects credential-free access. Runtime readiness requires current authenticated supervisor evidence. |
| `data[].egress.adoption` | `"live" or "prepared" or "credential_free"` | Yes | — |
| `data[].egress.retention` | `"none"` | Yes | — |
| `data[].id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].ownerCapability` | `"credential_gateway" or "credential_proxy"` | Yes | The Driver capability that admitted this source. Changing the selected Driver does not transfer ownership. |
| `data[].ref` | `object` | Yes | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data[].ref.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].ref.kind` | `"credential_source"` | Yes | — |
| `data[].ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].secrets` | `object<string, object>` | Yes | Secret inputs keyed by catalog field name. Each value references an OCC Secret in the same Namespace; OCC never returns its value. |
| `data[].state` | `"registering" or "ready" or "deleting"` | Yes | — |
| `data[].status` | `object` | No | Source admission or selected Credential Gateway status. For protected sources, ready does not attest an installed enforcing Sandbox; current supervisor evidence is checked separately. Never contains credential values. |
| `data[].status.reason` | `string` | No | max length: 512 |
| `data[].status.refresh` | `object` | No | Token refresh status reported by the selected Credential Refresh Driver for a refresh-type source. It never contains tokens or refresh material. |
| `data[].status.refresh.expiresAt` | `string (date-time)` | No | — |
| `data[].status.refresh.failureCode` | `string` | No | max length: 128 |
| `data[].status.refresh.lastRefreshAt` | `string (date-time)` | No | — |
| `data[].status.refresh.nextRefreshAt` | `string (date-time)` | No | — |
| `data[].status.refresh.recoveryAction` | `"retry" or "reauthorize" or "fix_configuration" or "investigate"` | No | — |
| `data[].status.refresh.state` | `"pending" or "ready" or "failed"` | Yes | — |
| `data[].status.state` | `"ready" or "pending" or "failed" or "absent"` | Yes | — |
| `data[].type` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9-]{0,63}$`; Source type from the selected Credential Gateway catalog, for example `openai`. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/credential-sources`

<span id="post-namespacesnamespaceidcredentialsources"></span>

Register a credential source with the selected Credential Gateway

**Operation ID:** `createCredentialSource`

**Permissions:** Requires create permission for CredentialSource resources in the requested Namespace. Requires operate permission on each Secret named in the request body secrets.

| Action | Resource | Scope |
| --- | --- | --- |
| `create` | `credential_source` | `namespace` |
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
| `config` | `object<string, string>` | No | Non-secret source configuration keyed by catalog field name. |
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `data.egress` | `object` | No | Protected live static, eligible prepared, or explicitly credential-free metadata access. Each profile requires its own grant; missing material never selects credential-free access. Runtime readiness requires current authenticated supervisor evidence. |
| `data.egress.adoption` | `"live" or "prepared" or "credential_free"` | Yes | — |
| `data.egress.retention` | `"none"` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ownerCapability` | `"credential_gateway" or "credential_proxy"` | Yes | The Driver capability that admitted this source. Changing the selected Driver does not transfer ownership. |
| `data.ref` | `object` | Yes | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data.ref.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref.kind` | `"credential_source"` | Yes | — |
| `data.ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secrets` | `object<string, object>` | Yes | Secret inputs keyed by catalog field name. Each value references an OCC Secret in the same Namespace; OCC never returns its value. |
| `data.state` | `"registering" or "ready" or "deleting"` | Yes | — |
| `data.status` | `object` | No | Source admission or selected Credential Gateway status. For protected sources, ready does not attest an installed enforcing Sandbox; current supervisor evidence is checked separately. Never contains credential values. |
| `data.status.reason` | `string` | No | max length: 512 |
| `data.status.refresh` | `object` | No | Token refresh status reported by the selected Credential Refresh Driver for a refresh-type source. It never contains tokens or refresh material. |
| `data.status.refresh.expiresAt` | `string (date-time)` | No | — |
| `data.status.refresh.failureCode` | `string` | No | max length: 128 |
| `data.status.refresh.lastRefreshAt` | `string (date-time)` | No | — |
| `data.status.refresh.nextRefreshAt` | `string (date-time)` | No | — |
| `data.status.refresh.recoveryAction` | `"retry" or "reauthorize" or "fix_configuration" or "investigate"` | No | — |
| `data.status.refresh.state` | `"pending" or "ready" or "failed"` | Yes | — |
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
| `data.egress` | `object` | No | Protected live static, eligible prepared, or explicitly credential-free metadata access. Each profile requires its own grant; missing material never selects credential-free access. Runtime readiness requires current authenticated supervisor evidence. |
| `data.egress.adoption` | `"live" or "prepared" or "credential_free"` | Yes | — |
| `data.egress.retention` | `"none"` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ownerCapability` | `"credential_gateway" or "credential_proxy"` | Yes | The Driver capability that admitted this source. Changing the selected Driver does not transfer ownership. |
| `data.ref` | `object` | Yes | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data.ref.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref.kind` | `"credential_source"` | Yes | — |
| `data.ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secrets` | `object<string, object>` | Yes | Secret inputs keyed by catalog field name. Each value references an OCC Secret in the same Namespace; OCC never returns its value. |
| `data.state` | `"registering" or "ready" or "deleting"` | Yes | — |
| `data.status` | `object` | No | Source admission or selected Credential Gateway status. For protected sources, ready does not attest an installed enforcing Sandbox; current supervisor evidence is checked separately. Never contains credential values. |
| `data.status.reason` | `string` | No | max length: 512 |
| `data.status.refresh` | `object` | No | Token refresh status reported by the selected Credential Refresh Driver for a refresh-type source. It never contains tokens or refresh material. |
| `data.status.refresh.expiresAt` | `string (date-time)` | No | — |
| `data.status.refresh.failureCode` | `string` | No | max length: 128 |
| `data.status.refresh.lastRefreshAt` | `string (date-time)` | No | — |
| `data.status.refresh.nextRefreshAt` | `string (date-time)` | No | — |
| `data.status.refresh.recoveryAction` | `"retry" or "reauthorize" or "fix_configuration" or "investigate"` | No | — |
| `data.status.refresh.state` | `"pending" or "ready" or "failed"` | Yes | — |
| `data.status.state` | `"ready" or "pending" or "failed" or "absent"` | Yes | — |
| `data.type` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9-]{0,63}$`; Source type from the selected Credential Gateway catalog, for example `openai`. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `PATCH /namespaces/{namespaceId}/credential-sources/{credentialSourceId}`

<span id="patch-namespacesnamespaceidcredentialsourcescredentialsourceid"></span>

Push current or replacement Secret values to the Credential Gateway copy

**Operation ID:** `updateCredentialSource`

**Permissions:** Requires update permission on the requested CredentialSource. Requires operate permission on each Secret the source references after the update, including its current references when the request omits secrets.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `credential_source` | `requested` |
| `operate` | `secret` | `requested` (when bound) |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `credentialSourceId` | path | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Request body

**Required:** Yes

**Content type:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `adoption` | `"live"` | No | Opt an unbound static source into protected live Secret reads. A legacy or narrower source also requires explicit authorityScope: execution. Requires source update and Secret operate permission. |
| `authorityScope` | `"execution"` | No | Consent to every process in this dedicated execution using the constrained inference grant. An older executable-specific grant is never broadened by an upgrade or Secret change. |
| `secrets` | `object<string, object>` | No | Secret inputs keyed by catalog field name. Each value references an OCC Secret in the same Namespace; OCC never returns its value. |

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
| `data.config` | `object<string, string>` | Yes | Non-secret source configuration keyed by catalog field name. |
| `data.egress` | `object` | No | Protected live static, eligible prepared, or explicitly credential-free metadata access. Each profile requires its own grant; missing material never selects credential-free access. Runtime readiness requires current authenticated supervisor evidence. |
| `data.egress.adoption` | `"live" or "prepared" or "credential_free"` | Yes | — |
| `data.egress.retention` | `"none"` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ownerCapability` | `"credential_gateway" or "credential_proxy"` | Yes | The Driver capability that admitted this source. Changing the selected Driver does not transfer ownership. |
| `data.ref` | `object` | Yes | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data.ref.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref.kind` | `"credential_source"` | Yes | — |
| `data.ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secrets` | `object<string, object>` | Yes | Secret inputs keyed by catalog field name. Each value references an OCC Secret in the same Namespace; OCC never returns its value. |
| `data.state` | `"registering" or "ready" or "deleting"` | Yes | — |
| `data.status` | `object` | No | Source admission or selected Credential Gateway status. For protected sources, ready does not attest an installed enforcing Sandbox; current supervisor evidence is checked separately. Never contains credential values. |
| `data.status.reason` | `string` | No | max length: 512 |
| `data.status.refresh` | `object` | No | Token refresh status reported by the selected Credential Refresh Driver for a refresh-type source. It never contains tokens or refresh material. |
| `data.status.refresh.expiresAt` | `string (date-time)` | No | — |
| `data.status.refresh.failureCode` | `string` | No | max length: 128 |
| `data.status.refresh.lastRefreshAt` | `string (date-time)` | No | — |
| `data.status.refresh.nextRefreshAt` | `string (date-time)` | No | — |
| `data.status.refresh.recoveryAction` | `"retry" or "reauthorize" or "fix_configuration" or "investigate"` | No | — |
| `data.status.refresh.state` | `"pending" or "ready" or "failed"` | Yes | — |
| `data.status.state` | `"ready" or "pending" or "failed" or "absent"` | Yes | — |
| `data.type` | `string` | Yes | min length: 1; max length: 64; pattern: `^[a-z][a-z0-9-]{0,63}$`; Source type from the selected Credential Gateway catalog, for example `openai`. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/credential-sources/{credentialSourceId}/rotate`

<span id="post-namespacesnamespaceidcredentialsourcescredentialsourceidrotate"></span>

Force the Credential Refresh Driver to mint a new token for a refresh-type source

**Operation ID:** `rotateCredentialSource`

**Permissions:** Requires update permission on the requested CredentialSource.

| Action | Resource | Scope |
| --- | --- | --- |
| `update` | `credential_source` | `requested` |

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
| `409` | Conflict |
| `500` | Internal Server Error |
| `503` | Service Unavailable |

**`200` response body:** `application/json`

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `data` | `object` | Yes | — |
| `data.config` | `object<string, string>` | Yes | Non-secret source configuration keyed by catalog field name. |
| `data.egress` | `object` | No | Protected live static, eligible prepared, or explicitly credential-free metadata access. Each profile requires its own grant; missing material never selects credential-free access. Runtime readiness requires current authenticated supervisor evidence. |
| `data.egress.adoption` | `"live" or "prepared" or "credential_free"` | Yes | — |
| `data.egress.retention` | `"none"` | Yes | — |
| `data.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ownerCapability` | `"credential_gateway" or "credential_proxy"` | Yes | The Driver capability that admitted this source. Changing the selected Driver does not transfer ownership. |
| `data.ref` | `object` | Yes | Exact OCC credential source reference. Shape: `{ "kind": "credential_source", "namespaceId": "ns_...", "id": "cs_..." }`. |
| `data.ref.id` | `string` | Yes | pattern: `^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.ref.kind` | `"credential_source"` | Yes | — |
| `data.ref.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.secrets` | `object<string, object>` | Yes | Secret inputs keyed by catalog field name. Each value references an OCC Secret in the same Namespace; OCC never returns its value. |
| `data.state` | `"registering" or "ready" or "deleting"` | Yes | — |
| `data.status` | `object` | No | Source admission or selected Credential Gateway status. For protected sources, ready does not attest an installed enforcing Sandbox; current supervisor evidence is checked separately. Never contains credential values. |
| `data.status.reason` | `string` | No | max length: 512 |
| `data.status.refresh` | `object` | No | Token refresh status reported by the selected Credential Refresh Driver for a refresh-type source. It never contains tokens or refresh material. |
| `data.status.refresh.expiresAt` | `string (date-time)` | No | — |
| `data.status.refresh.failureCode` | `string` | No | max length: 128 |
| `data.status.refresh.lastRefreshAt` | `string (date-time)` | No | — |
| `data.status.refresh.nextRefreshAt` | `string (date-time)` | No | — |
| `data.status.refresh.recoveryAction` | `"retry" or "reauthorize" or "fix_configuration" or "investigate"` | No | — |
| `data.status.refresh.state` | `"pending" or "ready" or "failed"` | Yes | — |
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
| [`GET /namespaces/{namespaceId}/iam/service-principals`](#get-namespacesnamespaceidiamserviceprincipals) | List the Namespace's non-Agent ServicePrincipals |
| [`POST /namespaces/{namespaceId}/iam/service-principals`](#post-namespacesnamespaceidiamserviceprincipals) | Create a Namespace ServicePrincipal with no grants for automation or CLI keys |
| [`GET /namespaces/{namespaceId}/iam/service-principals/{servicePrincipalId}`](#get-namespacesnamespaceidiamserviceprincipalsserviceprincipalid) | Get an exact Namespace ServicePrincipal |

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

**Permissions:** Requires administer permission on the requested Installation. Requires read permission on the requested Namespace. Requires read permission on the request body Agent when the AccessBinding targets that resource kind. Requires read permission on the request body Agent revision when the AccessBinding targets that resource kind. Requires read permission on the request body Configuration when the AccessBinding targets that resource kind. Requires read permission on the request body CredentialSource when the AccessBinding targets that resource kind. Requires read permission on the request body Namespace when the AccessBinding targets that resource kind. Requires read permission on the request body Preset when the AccessBinding targets that resource kind. Requires read permission on the request body Secret when the AccessBinding targets that resource kind. Requires read permission on the request body ServiceAccount when the AccessBinding targets that resource kind.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |
| `read` | `namespace` | `requested` |
| `read` | `agent` | `request_body` |
| `read` | `agent_revision` | `request_body` |
| `read` | `configuration` | `request_body` |
| `read` | `credential_source` | `request_body` |
| `read` | `namespace` | `request_body` |
| `read` | `preset` | `request_body` |
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
| `resourceKind` | `"namespace" or "agent" or "agent_revision" or "configuration" or "credential_source" or "sandbox_policy" or "preset" or "secret" or "service_account"` | Yes | — |
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
| `data[].name` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data[].permissions` | `array<object>` | Yes | min items: 1; max items: 64 |
| `data[].permissions[].action` | `"create" or "read" or "update" or "delete" or "deploy" or "operate" or "administer" or "read_logs" or "manage_policy"` | Yes | — |
| `data[].permissions[].resourceKind` | `"installation" or "namespace" or "configuration" or "preset" or "service_account" or "secret" or "agent" or "agent_revision" or "credential_source" or "sandbox_policy"` | Yes | — |
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
| `name` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `permissions` | `array<object>` | Yes | min items: 1; max items: 64 |
| `permissions[].action` | `"create" or "read" or "update" or "delete" or "deploy" or "operate" or "administer" or "read_logs" or "manage_policy"` | Yes | — |
| `permissions[].resourceKind` | `"namespace" or "agent" or "agent_revision" or "configuration" or "credential_source" or "sandbox_policy" or "preset" or "secret" or "service_account"` | Yes | — |

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
| `data.name` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.permissions` | `array<object>` | Yes | min items: 1; max items: 64 |
| `data.permissions[].action` | `"create" or "read" or "update" or "delete" or "deploy" or "operate" or "administer" or "read_logs" or "manage_policy"` | Yes | — |
| `data.permissions[].resourceKind` | `"installation" or "namespace" or "configuration" or "preset" or "service_account" or "secret" or "agent" or "agent_revision" or "credential_source" or "sandbox_policy"` | Yes | — |
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
| `data.name` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.permissions` | `array<object>` | Yes | min items: 1; max items: 64 |
| `data.permissions[].action` | `"create" or "read" or "update" or "delete" or "deploy" or "operate" or "administer" or "read_logs" or "manage_policy"` | Yes | — |
| `data.permissions[].resourceKind` | `"installation" or "namespace" or "configuration" or "preset" or "service_account" or "secret" or "agent" or "agent_revision" or "credential_source" or "sandbox_policy"` | Yes | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/iam/service-principals`

<span id="get-namespacesnamespaceidiamserviceprincipals"></span>

List the Namespace's non-Agent ServicePrincipals

**Operation ID:** `listIAMServicePrincipals`

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
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `POST /namespaces/{namespaceId}/iam/service-principals`

<span id="post-namespacesnamespaceidiamserviceprincipals"></span>

Create a Namespace ServicePrincipal with no grants for automation or CLI keys

**Operation ID:** `createIAMServicePrincipal`

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
| `data` | `object` | Yes | A non-Agent automation identity fixed to one Namespace. It holds only the grants of AccessBindings that name it. |
| `data.id` | `string` | Yes | min length: 1; max length: 200 |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

#### `GET /namespaces/{namespaceId}/iam/service-principals/{servicePrincipalId}`

<span id="get-namespacesnamespaceidiamserviceprincipalsserviceprincipalid"></span>

Get an exact Namespace ServicePrincipal

**Operation ID:** `getIAMServicePrincipal`

**Permissions:** Requires administer permission on the requested Installation. Requires read permission on the requested Namespace.

| Action | Resource | Scope |
| --- | --- | --- |
| `administer` | `installation` | `requested` |
| `read` | `namespace` | `requested` |

##### Parameters

| Name | In | Type | Required | Constraints |
| --- | --- | --- | --- | --- |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `servicePrincipalId` | path | `string` | Yes | min length: 1; max length: 200 |

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
| `data` | `object` | Yes | A non-Agent automation identity fixed to one Namespace. It holds only the grants of AccessBindings that name it. |
| `data.id` | `string` | Yes | min length: 1; max length: 200 |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="presets"></span>

### Presets

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/presets`](#get-namespacesnamespaceidpresets) | List readable Preset summaries in one Namespace |
| [`POST /namespaces/{namespaceId}/presets`](#post-namespacesnamespaceidpresets) | Create a reusable Namespace-owned Agent Preset |
| [`DELETE /namespaces/{namespaceId}/presets/{presetId}`](#delete-namespacesnamespaceidpresetspresetid) | Delete a Preset without changing existing Agents |
| [`GET /namespaces/{namespaceId}/presets/{presetId}`](#get-namespacesnamespaceidpresetspresetid) | Read one exact Namespace-owned Preset |
| [`PATCH /namespaces/{namespaceId}/presets/{presetId}`](#patch-namespacesnamespaceidpresetspresetid) | Update a Preset without changing existing Agents |

#### `GET /namespaces/{namespaceId}/presets`

<span id="get-namespacesnamespaceidpresets"></span>

List readable Preset summaries in one Namespace

**Operation ID:** `listPresets`

**Permissions:** Requires read permission on the requested Namespace. Only Preset resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `namespace` | `requested` |
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
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data[].namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
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
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `template.agent.pluginApprovers` | `SafeJsonValue` | No | — |
| `template.agent.plugins` | `SafeJsonValue` | No | — |
| `template.agent.repositoryAccess` | `SafeJsonValue` | No | — |
| `template.agent.repositoryBindings` | `SafeJsonValue` | No | — |
| `template.configuration` | `object` | No | — |
| `template.configuration.secretBindings` | `object<string, SafeJsonValue>` | No | Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}. |
| `template.configuration.values` | `object<string, SafeJsonValue>` | No | A native OpenClaw configuration document. |
| `template.variables` | `object<string, object>` | No | — |

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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `data.template.agent.pluginApprovers` | `SafeJsonValue` | No | — |
| `data.template.agent.plugins` | `SafeJsonValue` | No | — |
| `data.template.agent.repositoryAccess` | `SafeJsonValue` | No | — |
| `data.template.agent.repositoryBindings` | `SafeJsonValue` | No | — |
| `data.template.configuration` | `object` | No | — |
| `data.template.configuration.secretBindings` | `object<string, SafeJsonValue>` | No | Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}. |
| `data.template.configuration.values` | `object<string, SafeJsonValue>` | No | A native OpenClaw configuration document. |
| `data.template.variables` | `object<string, object>` | No | — |
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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `data.template.agent.pluginApprovers` | `SafeJsonValue` | No | — |
| `data.template.agent.plugins` | `SafeJsonValue` | No | — |
| `data.template.agent.repositoryAccess` | `SafeJsonValue` | No | — |
| `data.template.agent.repositoryBindings` | `SafeJsonValue` | No | — |
| `data.template.configuration` | `object` | No | — |
| `data.template.configuration.secretBindings` | `object<string, SafeJsonValue>` | No | Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}. |
| `data.template.configuration.values` | `object<string, SafeJsonValue>` | No | A native OpenClaw configuration document. |
| `data.template.variables` | `object<string, object>` | No | — |
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
| `name` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `template.agent.pluginApprovers` | `SafeJsonValue` | No | — |
| `template.agent.plugins` | `SafeJsonValue` | No | — |
| `template.agent.repositoryAccess` | `SafeJsonValue` | No | — |
| `template.agent.repositoryBindings` | `SafeJsonValue` | No | — |
| `template.configuration` | `object` | No | — |
| `template.configuration.secretBindings` | `object<string, SafeJsonValue>` | No | Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}. |
| `template.configuration.values` | `object<string, SafeJsonValue>` | No | A native OpenClaw configuration document. |
| `template.variables` | `object<string, object>` | No | — |

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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `data.template.agent.pluginApprovers` | `SafeJsonValue` | No | — |
| `data.template.agent.plugins` | `SafeJsonValue` | No | — |
| `data.template.agent.repositoryAccess` | `SafeJsonValue` | No | — |
| `data.template.agent.repositoryBindings` | `SafeJsonValue` | No | — |
| `data.template.configuration` | `object` | No | — |
| `data.template.configuration.secretBindings` | `object<string, SafeJsonValue>` | No | Namespace-owned Secret bindings. Reference fields may use {{ vars.name }}. |
| `data.template.configuration.values` | `object<string, SafeJsonValue>` | No | A native OpenClaw configuration document. |
| `data.template.variables` | `object<string, object>` | No | — |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

<span id="secrets"></span>

### Secrets

| Operation | Summary |
| --- | --- |
| [`GET /namespaces/{namespaceId}/secrets`](#get-namespacesnamespaceidsecrets) | List readable Namespace-owned Secret metadata without revealing material |
| [`POST /namespaces/{namespaceId}/secrets`](#post-namespacesnamespaceidsecrets) | Create exact Namespace-owned Secret material and return metadata only |
| [`DELETE /namespaces/{namespaceId}/secrets/{secretId}`](#delete-namespacesnamespaceidsecretssecretid) | Delete exact unbound Namespace-owned Secret material |
| [`GET /namespaces/{namespaceId}/secrets/{secretId}`](#get-namespacesnamespaceidsecretssecretid) | Get exact Namespace-owned Secret metadata and its readable consumers |
| [`PATCH /namespaces/{namespaceId}/secrets/{secretId}`](#patch-namespacesnamespaceidsecretssecretid) | Replace exact Namespace-owned Secret material and return stable metadata |

#### `GET /namespaces/{namespaceId}/secrets`

<span id="get-namespacesnamespaceidsecrets"></span>

List readable Namespace-owned Secret metadata without revealing material

**Operation ID:** `listSecrets`

**Permissions:** Requires read permission on the requested Namespace. Only Secret resources with individual read permission are returned.

| Action | Resource | Scope |
| --- | --- | --- |
| `read` | `namespace` | `requested` |
| `read` | `secret` | `each_returned` |

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
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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

Get exact Namespace-owned Secret metadata and its readable consumers

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
| `data.consumers` | `object` | Yes | Current references that block deletion of the Secret. Returned by the exact Secret read only. |
| `data.consumers.agents` | `array<string>` | Yes | max items: 50; Agents that you can read. Each Agent has a Secret reference in its saved settings, selected Agent revision, or pending deployment. Deploy each Agent again to use a rotated value. |
| `data.consumers.configurations` | `array<string>` | Yes | max items: 50; Readable Configurations whose `secretBindings` reference the Secret. |
| `data.consumers.credentialSources` | `array<string>` | Yes | max items: 50; Readable credential sources that hold the Secret. |
| `data.consumers.provisioningRequests` | `array<string>` | Yes | max items: 50; Work IDs of queued or running Agent provisioning requests that reference the Secret, listed only for the actor that started them. |
| `data.consumers.truncated` | `boolean` | Yes | `true` when the Secret has more than 50 references; only the first 50, ordered by kind and ID, are examined. |
| `data.consumers.unreadable` | `integer` | Yes | minimum: 0; maximum: 50; Examined references to resources the caller may not read. They are counted, never named. |
| `data.id` | `string` | Yes | pattern: `^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `data[].name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |

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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `force` | query | `"true" or "false"` | No | — |
| `namespaceId` | path | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `serviceAccountId` | path | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

##### Responses

| Status | Meaning |
| --- | --- |
| `200` | A forced deletion removed the account and its credential Secret but could not revoke its issued access token. |
| `204` | No Content |
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
| `data.backendId` | `string` | No | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.id` | `string` | Yes | pattern: `^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `data.revocation` | `"skipped"` | Yes | The account's issued access token was not revoked: no ChatGPT Backend can revoke it. Revoke it at the provider; the audit event names its Backend and credential ID. |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
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
| `data.name` | `string` | Yes | min length: 1; max length: 200; pattern: `^(?!\s)(?!.*\s$)[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$` |
| `data.namespaceId` | `string` | Yes | pattern: `^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `meta` | `object` | Yes | — |
| `meta.requestId` | `string` | Yes | pattern: `^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

## Shared schemas

Reusable schema names are referenced by operation request and response tables.

| Schema | Type |
| --- | --- |
| `SafeJsonValue` | `string or boolean or number or null or array<SafeJsonValue> or object<string, SafeJsonValue>` |
| `PluginDriverIdentity` | `object` |
| `AgentRuntimeLogsResponse` | `object` |
| `AgentRuntimeCredentialResponse` | `object` |
| `SecretResponse` | `object` |
| `CredentialSourceResponse` | `object` |
| `PluginApprovers` | `array<object>` |
| `PluginToolPolicy` | `object` |
| `PluginToolDefaults` | `object` |
| `PluginDesiredSelection` | `object` |
| `PluginDesiredState` | `object<string, PluginDesiredSelection>` |
| `ErrorResponse` | `object` |
| `AgentDeploymentDiagnosticsResponse` | `object` |
| `AgentRuntimeResponse` | `object` |
