# Service API keys

Authenticate non-Agent automation with a scoped service API key. [Authentication](../authentication.md) defines Installation bootstrap, human sessions, and account provisioning.

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
provider credentials managed by [Service accounts](../service-accounts.md).

The controller uses Better Auth's pinned
[API-key plugin](https://better-auth.com/docs/plugins/api-key) through server-only
calls. It does not expose the plugin's public create/update/list routes, enable
sessions from keys, use plugin permissions as IAM grants, or add another
credential store. Database-backed verification does not cache keys; the
plugin's per-key rate limit is disabled. The same service-key contract applies
to development and production; their existing listener and storage boundaries
remain in force. Normal issuance and verification require no additional settings;
initial bootstrap delivery uses the [bootstrap settings](../settings/production.md#production-installation-bootstrap-environment).

## Issuance

`POST /api/auth/service-keys` accepts a human session or an Installation-scoped
service API key. Either caller requires current IAM `administer` on the
singleton Installation, including when issuing a Namespace key. The body
names the existing `servicePrincipalId` and its exact `namespaceId`, or omits
`namespaceId` for an Installation-scoped principal. `name` contains 1–32
characters and cannot be blank. Optional `expiresIn` is an integer lifetime in
seconds from 86,400 to 31,536,000 (1–365 days); omission gives 30 days.
Unsupported fields are rejected. The [generated API reference](../api.md) owns
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

## Request admission and scope

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

## Revocation and audit

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
a deleted key. See the [deployment guide](../../guides/deploy/service-keys.md#revoke-or-rotate-a-service-key)
for rotation procedures using a human session or service key.

## Service-key failures

| Condition                                                                                                              | Result                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Missing, invalid, expired, or revoked credential; key used for account creation or bootstrap                           | `401 UNAUTHENTICATED`.                                                                      |
| Missing current identity or exact IAM grant, changed principal scope, cross-Namespace request, or matching Restriction | `403 FORBIDDEN`.                                                                            |
| Unknown, Agent-owned, or incorrectly scoped principal at issuance; unsupported fields or invalid name/lifetime         | `400 INVALID_REQUEST`.                                                                      |
| Unknown or already removed key at revocation                                                                           | `404 NOT_FOUND`.                                                                            |
| Required authentication, IAM, or audit dependency unavailable                                                          | `503 DEPENDENCY_UNAVAILABLE`; do not retry with a different identity or broader credential. |
