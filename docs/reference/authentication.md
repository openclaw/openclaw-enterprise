# Authentication

OpenClaw Control Center (OCC) authenticates human controller API clients with
user sessions established through email/password sign-in. Programmatic
non-Agent automation authenticates with service API keys. Better Auth owns
password verification, revocable session cookies, and hashed API-key storage.
The selected IAM Driver resolves the authenticated account or service identity
to an explicitly provisioned Principal or ServicePrincipal and owns
[authorization](authorization.md).

This page defines the currently supported authentication behavior. For a
working sign-in procedure, see
[human administrator sign-in](../guides/deploy.md#sign-in-as-a-human-administrator).
For non-Agent automation, see the [service-key procedure](../guides/deploy.md#service-api-keys-for-automation).
The [platform console](console.md) provides email/password login at `/console/`
and uses these same session endpoints. Public signup, OIDC, and bearer
credentials are not supported controller API authentication paths.

## Installation and account ownership

Authentication belongs to one bootstrapped Installation. The controller requires
`OCC_AUTH_SECRET` and `OCC_AUTH_BASE_URL`; their deployment configuration is
specified in [settings](settings.md). An account's immutable Better Auth user ID
and Installation-specific trusted issuer identify its IAM Principal. Email
addresses and display names do not grant access.

Fresh native-IAM bootstrap creates the first human administrator and one
Installation-scoped, non-Agent ServicePrincipal. Both have separate bindings to
the same [administrator Role](authorization.md#supported-policy-surface).
The service identity has no email, password, session, Namespace, or Agent owner;
its authority does not depend on the human account remaining present.

Fresh bootstrap also creates the initial [`default` Namespace](namespaces.md#initial-namespace)
under the bootstrap Principal's ordinary Namespace creation permission.
Installation/IAM state, the Namespace, its queued reconciliation, and bootstrap
audit commit together. Worker provisioning remains asynchronous.

Bootstrap issues a 30-day service API key named `bootstrap-admin` and writes its
one-time response to `OCC_BOOTSTRAP_SERVICE_KEY_FILE`. The JSON contains
`data.id`, `data.servicePrincipalId`, `data.name`, `data.expiresAt`, `data.key`,
and `meta.installationId`; it is usable with the existing service-key examples.
Better Auth retains the hash, not plaintext. The file remains readable until the
operator removes it; there is no server-side plaintext retrieval endpoint.

Production also creates the configured `OCC_BOOTSTRAP_ADMIN_EMAIL` account with
a random password written to `OCC_BOOTSTRAP_PASSWORD_FILE`. Both paths must be
absolute, distinct siblings on protected operator-owned storage. Output is
exclusive, owner-only (`0600`), and synced before committing Installation/IAM
state; existing files, symlinks, or unsafe parent directories fail closed.
Credentials never appear in bootstrap logs, audit, or the HTTP bootstrap
response. OCC creates no Kubernetes Secret or PVC for delivery.

In Helm, `bootstrap.password.claimName` selects the existing protected PVC.
Only the initialization Job mounts it; `bootstrap.password.fileName` and
`bootstrap.serviceKey.fileName` are written under `bootstrap.password.mountPath`.
See [initial-key retrieval](../guides/deploy.md#retrieve-the-bootstrap-service-key)
and [bootstrap recovery](../guides/deploy.md#recover-an-incomplete-bootstrap).

The shared `scripts/bootstrap-installation.mjs` initializer runs after migration
and before either API or worker startup in Compose and Helm. Development
provisions the configured `OPENCLAW_DEV_EMAIL` and
`OPENCLAW_DEV_PASSWORD` on a fresh database, using the defaults in
[settings](settings.md#required-development-controller-environment), and
bootstraps the Installation before serving requests. It does not generate a
password output file or rotate an existing account's password. Compose stores
the service-key JSON on the bootstrap-only `occ_bootstrap_data` volume. The API
and worker do not mount it. Direct development runs the same initializer with
an explicit private key-file path before starting the API or worker.
The [quickstart](../guides/quickstart.md) uses the service key for its API check.

An already-bootstrapped Installation receives no new Namespace, identity, grants, key, or
output, including installations created before initial-key delivery existed.
Restarting does not replace missing files, expired/revoked keys, removed service
identities, or removed grants. Use normal issuance/revocation for credential
recovery and rotation.

Bootstrap makes one attempt. Any error emits `installation.bootstrap-failed`
with available non-secret IDs and paths, then exits unsuccessfully. Created
accounts, keys, and files remain, including partial output from a failed write.
Bootstrap does not automatically revoke, delete, retry, repair, or reset them.
The Helm initialization Job uses `backoffLimit: 0` and does not retry a failed
attempt. Better Auth persistence and the Installation/IAM commit are separate;
an error does not establish whether the transaction committed. Operators must
resolve that outcome before manual repair, or explicitly reset an identified
disposable Installation. See [incomplete bootstrap recovery](../guides/deploy.md#recover-an-incomplete-bootstrap).
File existence alone is not proof of successful initialization.

## Browser request origin

Browser sign-in and sign-out requests must use the origin configured by
`OCC_AUTH_BASE_URL`. An explicit untrusted or malformed `Origin` is rejected
before password verification or session revocation. A request marked
`Sec-Fetch-Site: cross-site` without an Origin is also rejected. Rejection leaves
an existing session intact. Command-line clients that send neither browser
header keep the documented sign-in/sign-out flow.

## Session lifecycle

| Operation                      | Supported behavior                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/sign-in/email` | Verifies an existing account's email and password and issues a session cookie. The JSON response confirms authentication without returning a session token. |
| `GET /api/auth/session`        | Returns safe account identity for a valid session or `data: null` without one. Inspecting the session is optional.                                          |
| `POST /api/auth/sign-out`      | Revokes the current session. Protected API requests using that session subsequently return `401`.                                                           |

For example, the sign-in body is:

```json
{
  "email": "admin@example.invalid",
  "password": "<account-password>"
}
```

The successful sign-in response contains `data: { "authenticated": true }` and
request metadata. The session credential is delivered through `Set-Cookie`, not
the JSON body. Protected OCC API calls use that cookie.

The controller configures the Better Auth cookie with the `openclaw_occ`
prefix; the OpenAPI contract names it `openclaw_occ.session_token`. Cookies are
HTTP-only, use `SameSite=Lax`, and cover `/`. Production enables secure cookies;
the configured base URL is also the trusted origin. Session inspection exposes
only `authenticated` and the account's `id`, `email`, and `name`.

Protected requests resolve the current stored session with cookie caching
disabled. A missing, expired, revoked, or forged session is rejected. Supplying
an `Authorization` header is rejected even if a session cookie is also present.

## Account provisioning

`POST /api/auth/accounts` requires a human session and `administer` on the singleton Installation.
It creates a Better Auth account, its explicit IAM Principal, and an
AccessBinding to an existing Role. The request must supply `roleId`; it cannot
implicitly create a Role or infer a grant from the account's email or session.
Creating an account does not sign it in or issue a session.

A representative provisioning body is:

```json
{
  "email": "operator@example.invalid",
  "password": "<generated-random-password>",
  "roleId": "role-existing-operator"
}
```

Emails are normalized to lowercase. Passwords must contain 12–128 characters.
The backend provisions the account without a public email-verification or
signup flow. Duplicate accounts are rejected. General account management and
password reset endpoints are not exposed by the controller API.

## Authorization and failures

For each protected request, OCC resolves the session user or service-key
principal through the selected IAM Driver and authorizes the exact resource
operation. Each identity lookup
and authorization decision loads current IAM policy, so account and permission
changes are visible across controller instances. Caller-supplied identity
headers and bearer credentials are not authorization evidence.

| Condition                                                      | Result                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Missing or invalid session or service key on a protected route | `401 UNAUTHENTICATED`.                                                             |
| Valid credential without the required IAM grant                | `403 FORBIDDEN`.                                                                   |
| Duplicate account during provisioning                          | `409 RESOURCE_CONFLICT`.                                                           |
| Authentication or IAM dependency unavailable                   | The request fails closed; dependency failures return `503 DEPENDENCY_UNAVAILABLE`. |

The optional session-inspection route is not a protected resource operation:
anonymous inspection returns `200` with `data: null`.

## Service API keys

Service keys authenticate non-Agent automation as an existing IAM
`ServicePrincipal`, not as the administrator who issues the key. Issuance
creates no account, session, identity, Role, or AccessBinding. The selected IAM
Driver must support lookup by `servicePrincipalId` and load current policy for
each identity lookup and authorization decision. Unknown identities are denied.

The current API does not provision service principals or their grants. An
operator uses the service administrator created by fresh bootstrap or provisions
another identity and explicit bindings through the selected IAM authority.
Native IAM supports these records internally; there is no public IAM-management
API. Agent-owned principals cannot use service keys: Agent authentication requires the separate workload-bound
credential flow. These controller keys are also distinct from upstream
provider credentials managed by [Service accounts](service-accounts.md).

The controller uses Better Auth's pinned
[API-key plugin](https://better-auth.com/docs/plugins/api-key) through server-only
calls. It does not expose the plugin's public create/update/list routes, enable
sessions from keys, use plugin permissions as IAM grants, or add another
credential store. Database-backed verification does not cache keys; the
plugin's per-key rate limit is disabled. The same service-key contract applies
to development and production; their existing listener and storage boundaries
remain in force. Normal issuance and verification require no additional settings;
initial bootstrap delivery uses the [bootstrap settings](settings.md#production-installation-bootstrap-environment).

### Issuance

`POST /api/auth/service-keys` accepts a human session or an Installation-scoped
service API key. Either caller requires current IAM `administer` on the
singleton Installation, including when issuing a Namespace key. The body
names the existing `servicePrincipalId` and its exact `namespaceId`, or omits
`namespaceId` for an Installation-scoped principal. `name` contains 1–32
characters and cannot be blank. Optional `expiresIn` is an integer lifetime in
seconds from 86,400 to 31,536,000 (1–365 days); omission gives 30 days.
Unsupported fields are rejected. The [generated API reference](api.md) owns
the complete wire schema.

Success returns `201` with the plaintext key exactly once in `data.key`,
alongside `id`, `servicePrincipalId`, optional `namespaceId`, `name`, and
`expiresAt` as a date-time string. Store the credential privately; there is no
plaintext retrieval endpoint. Multiple keys can reference the same principal
for rotation.

An Installation-scoped non-Agent ServicePrincipal with that authority can
issue and revoke keys for itself or another eligible principal in the same
Installation. Namespace-scoped keys cannot manage keys. Account creation and
bootstrap still require human sessions; service keys cannot enter those paths.
The controller provides no automatic rotation service, but authorized
automation can use issuance and revocation to rotate credentials. Keys are
independent credentials: revoking an issuer's key does not revoke other keys
issued through it. Issuance never grants permissions to the target principal.

### Request admission and scope

Clients send the credential in `x-api-key`. An explicitly supplied key takes
precedence over a session cookie. A blank, invalid, expired, or revoked key
cannot fall back to the cookie. `Authorization: Bearer` remains unsupported,
and a key cannot produce a human session through `GET /api/auth/session`.

The key's Installation and optional Namespace are fixed at issuance. A
Namespace key cannot access another Namespace or Installation-level endpoints.
An Installation key still needs the exact IAM permission for each requested
resource; it never inherits its issuer's permissions. Removal of an identity,
binding, or Role, and matching Restrictions, affect subsequent requests
immediately. If the principal's scope changes, the old key fails closed; a new
key is required for that scope.

### Revocation and audit

`DELETE /api/auth/service-keys/:keyId` uses the non-secret ID returned at
issuance and the same IAM Installation-administrator authority as issuance. Success
returns `200` with `data: {"id":"<key-id>","revoked":true}`. Revocation deletes
the Better Auth record so concurrent verification updates cannot re-enable it.
Subsequent requests fail authentication across controller instances; a request
already authorized may finish. An unknown or already removed key returns
`404 NOT_FOUND`. Revocation does not delete the principal or its IAM bindings.

HTTP issuance and revocation emit audit events containing the administrator and
non-secret key/principal IDs, never plaintext credentials. If issuance audit
persistence fails, the controller returns `503` without disclosing the key and
attempts to remove it. This cleanup is best effort, not an atomic transaction
with the audit sink. A failed revocation audit returns `503` but never restores
a deleted key. See the [deployment guide](../guides/deploy.md#revoke-or-rotate-a-service-key)
for rotation procedures using a human session or service key.

### Service-key failures

| Condition                                                                                                              | Result                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Missing, invalid, expired, or revoked credential; key used for account creation or bootstrap                           | `401 UNAUTHENTICATED`.                                                                      |
| Missing current identity or exact IAM grant, changed principal scope, cross-Namespace request, or matching Restriction | `403 FORBIDDEN`.                                                                            |
| Unknown, Agent-owned, or incorrectly scoped principal at issuance; unsupported fields or invalid name/lifetime         | `400 INVALID_REQUEST`.                                                                      |
| Unknown or already removed key at revocation                                                                           | `404 NOT_FOUND`.                                                                            |
| Required authentication, IAM, or audit dependency unavailable                                                          | `503 DEPENDENCY_UNAVAILABLE`; do not retry with a different identity or broader credential. |

## Evidence and related references

The [authentication implementation](../../apps/controller/src/auth/index.ts)
owns session verification and safe responses; the
[HTTP routes](../../apps/controller/src/index.ts) own public endpoint exposure
and account-provisioning authorization.
[API integration tests](../../tests/integration/occ-api.test.mjs) cover safe
session inspection and administrator-provisioned accounts with scoped IAM
access. These tests are not proof of a production installation.

[Service-key HTTP integration tests](../../tests/integration/service-api-keys.test.mjs)
exercise real Fastify HTTP with Better Auth memory storage and native IAM,
including valid, invalid, expired, revoked, unauthorized, and cross-Namespace
requests, IAM-authorized service-key management, human session preservation,
Agent exclusion, and audit attribution.
[PostgreSQL service-key tests](../../tests/integration/postgres-service-api-keys.test.mjs)
separately cover stored hashing, foreign-Installation rejection, cross-instance
revocation, and deletion during concurrent verification. These focused tests
do not prove a production installation; their commands and required
[test environment](settings.md#postgresql-test-environment) are linked from the
[service API key flow](../flows/service-api-keys.md#debugging-and-verification).

- [Service API key flow](../flows/service-api-keys.md)
- [Deployment procedure](../guides/deploy.md#service-api-keys-for-automation)
- [Authorization](authorization.md)
- [Generated API reference](api.md)
- [Controller settings](settings.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-08-31 22:29: Define single-attempt bootstrap failure handling with retained artifacts, no automatic recovery, and manual operator repair. (01a05a3d-526f-7553-8cd8-070bd1847acb - 94a5440898bf331987148d7733f0075506af64a6)

- 2026-08-31 17:43: Document fresh human/service administrator bootstrap, private key delivery, and operator recovery. (codex/01a05a69-3fbe-7441-9e6d-20394758cf94 - 0797098646028ac00cb26cd4afcbc9b2cf8bcb24)

- [2026-08-28 20:17]: Allow IAM-authorized service administrators to issue and revoke keys; retain human-session account creation and bootstrap. (codex/01a04927-11d8-7083-a4b7-9f3124559d82 - d4b5b01d02cf68a89965f7c00a0fc7d0dcec18d8)

- [2026-08-28 17:54]: Reorganize as a current feature reference; move procedural setup to the shared guides. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
