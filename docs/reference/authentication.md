# Authentication

OpenClaw Control Plane (OCC) authenticates human controller API clients with
user sessions established through email/password sign-in or an administrator-enrolled
GitHub, Google or OIDC identity. Programmatic non-Agent automation authenticates with service
API keys. Better Auth owns
password verification, revocable session cookies, and hashed API-key storage.
The selected IAM Driver resolves the authenticated account or service identity
to an explicitly provisioned Principal or ServicePrincipal and owns
[authorization](authorization.md).

For a sign-in procedure, see
[human administrator sign-in](authentication/service-api-keys.md#sign-in-as-a-human-administrator).
For non-Agent automation, see the [service-key procedure](authentication/service-api-keys.md).
The [platform console](console.md) at `/console/` uses these session endpoints. Public signup, OIDC
provisioning or claim mapping, and bearer credentials are unsupported; generic OIDC
sign-in for enrolled accounts is in [OIDC sign-in](../guides/deploy/oidc-sign-in.md).

## Installation and account ownership

Authentication belongs to one bootstrapped Installation. The controller requires
`OCC_AUTH_SECRET` and `OCC_AUTH_BASE_URL` (see [settings](settings.md)). An account's immutable Better Auth user ID
and Installation-specific trusted issuer identify its IAM Principal. Neither
email nor display name grants access.

Fresh native-IAM bootstrap creates the first human administrator and one
Installation-scoped, non-Agent ServicePrincipal. Both have separate bindings to
the same [administrator Role](authorization.md#supported-policy-surface).
The service identity has no email, password, session, Namespace, or Agent owner;
its authority does not depend on the human account remaining present.

Fresh bootstrap also creates the initial [`default` Namespace](namespaces.md#initial-namespace)
under the bootstrap Principal's ordinary Namespace creation permission.
Installation/IAM state, the Namespace, its queued reconciliation, and bootstrap
audit commit together. Worker provisioning is asynchronous.

Bootstrap issues a 30-day service API key named `bootstrap-admin` and writes its
one-time response to `OCC_BOOTSTRAP_SERVICE_KEY_FILE`. The JSON contains
`data.id`, `data.servicePrincipalId`, `data.name`, `data.expiresAt`, `data.key`,
and `meta.installationId`.
Better Auth keeps only the hash; there is no server-side plaintext retrieval.

Production also creates the configured `OCC_BOOTSTRAP_ADMIN_EMAIL` account with
a random password written to `OCC_BOOTSTRAP_PASSWORD_FILE`. Both paths must be
absolute, distinct siblings on protected operator-owned storage. Output is
exclusive, owner-only (`0600`), and synced before committing Installation/IAM
state; existing files, symlinks, or unsafe parent directories fail closed.
Credentials never appear in logs, audit, or the bootstrap response. OCC creates no Kubernetes Secret or PVC for delivery.

In Helm, `bootstrap.password.claimName` selects the existing protected PVC.
Only the initialization Job mounts it; `bootstrap.password.fileName` and
`bootstrap.serviceKey.fileName` are written under `bootstrap.password.mountPath`.
See [initial-key retrieval](authentication/service-api-keys.md#retrieve-the-bootstrap-service-key)
and [bootstrap recovery](authentication/service-api-keys.md#recover-an-incomplete-bootstrap).

The shared `scripts/bootstrap-installation.mjs` initializer runs after migration
and before either API or worker startup in Compose and Helm. Development
provisions the configured `OPENCLAW_DEV_EMAIL` and
`OPENCLAW_DEV_PASSWORD` on a fresh database, using the defaults in
[settings](settings/development.md#required-development-controller-environment), and
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
The Helm initialization Job uses `backoffLimit: 0`. Better Auth persistence and the Installation/IAM commit are separate,
so an error leaves the commit outcome unknown; resolve it before manual repair
or reset an identified disposable Installation. See [incomplete bootstrap recovery](authentication/service-api-keys.md#recover-an-incomplete-bootstrap).
File existence alone is not proof of successful initialization.

## Browser request origin

Cookie-authenticated controller API mutations must include an
`Origin` matching the origin of `OCC_AUTH_BASE_URL`. This includes sign-out. A missing,
malformed, or different origin is rejected with `403`, and the error message says
that a trusted browser origin is required. If `Sec-Fetch-Site` is
present, it must be `same-origin`. Safe reads do not require an Origin.

Sign-in rejects an explicitly untrusted or malformed Origin and also rejects
`Sec-Fetch-Site: cross-site` when Origin is missing. Command-line sign-in may
omit both headers. For later cookie-authenticated mutations, command-line clients
must provide the configured Origin. An explicitly supplied service API key does
not require Origin, and an invalid key never falls back to a session cookie.

## Session lifecycle

| Operation                      | Supported behavior                                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/sign-in/email` | Verifies an existing account's email and password and issues a session cookie. The JSON response confirms authentication, and with GitHub enabled returns `sessionKey`, never a session token. |
| `GET /api/auth/session`        | Returns safe account identity and a noncredential `sessionKey`, or `data: null` without a valid session.                                                                                       |
| `POST /api/auth/sign-out`      | Revokes the current session. Protected API requests using that session subsequently return `401`.                                                                                              |

The `sessionKey` names the current session, stays stable across reads, and changes
on each sign-in. It cannot authenticate; the token stays in its HttpOnly cookie.
Sending it back as `x-occ-session-key` narrows a request to that session: a
foreign, malformed, or duplicated key returns `401`, and such a sign-out neither
revokes nor clears the cookie. Without the header, requests are unchanged. Console
pins each tab's key this way.

Sign-in takes `{"email": "...", "password": "..."}`. The session arrives only
through `Set-Cookie`.

In both profiles, after 10 failed sign-ins per minute per email, or 20
per client address with [`api.trustedProxy`](settings/production.md#github-sign-in-and-trusted-proxies),
attempts wait 1–8 s and return `429` with `Retry-After`, whether or not the email
exists; an Installation administrator's correct password still signs in, and so does
the recovery account's with an external provider. Successful sign-ins spend nothing. Without
one, browsers share the ingress address and startup logs
`authentication.sign-in-limit-warning`. A successful sign-in within the budget
clears that email's failures, not the address's; an administrator's success in
the slowed lane does not, so pacing lasts until the minute rolls over. The first
slowed attempt per lane each minute logs `authentication.sign-in-limited` at WARN
with its `lane` (`email`, `device`, `address`, or `untracked` when the budget table is
full). `email`, `device`, and `address` events also carry `keyHash`, a truncated HMAC under
the auth secret; `untracked` events have no key and no hash. The email and
address are never logged. The bundled Collector
exports the event and lane, not the hash.

Every password sign-in whose password is checked attempts an
`authentication.login` audit: success names the account's Principal and `userId`;
a wrong password or unknown email is `denied` with `INVALID_CREDENTIALS` and no
account. Audit writes fail closed: a success whose audit cannot be written
returns `503` without issuing a session cookie. A server-side session may
persist if its creation or cleanup cannot be confirmed. In both profiles, a wrong
password whose denial cannot be written counts as a credential failure against
any tracked sign-in budgets. The ordinary response is `503`; the slow lane may
instead return `429`. An untracked or already-exhausted lane is paced without
necessarily adding a new tracked failure entry. If the audit write cannot be
confirmed, its persistence outcome may be unknown. A `429` is also unaudited when admission
refuses the attempt before the password is checked;
`authentication.sign-in-limited` reports the limited lane.
An administrator's attempt in the slow lane is still checked, so a wrong password
there returns `429` and is audited as `denied` when the write succeeds.

### Known devices

Every successful sign-in, password or external, sets `__Host-occ_known_device`
(`occ_known_device` over plain HTTP): HttpOnly, `SameSite=Strict`, `Path=/`, no
`Domain`, 90 days. It holds up to three entries, one per recent account, each an
HMAC under the auth secret over a hash of the account's email, the issue time and
a random nonce, so every sign-in gets its own entry; it never carries the email.
Each entry is also bound to the account's password: its user, password method and
that method's authentication version, which the database bumps on every password
change. An external sign-in marks the browser only when the account has a password.
When fresh account proof is available, a later password attempt with a valid
entry spends that browser's own budget, the size of the email's, and does not
wait for the email's slowed slots. Spending the shared email budget alone cannot
refuse that verified browser. If finite proof capacity is exhausted or the reader
is unavailable, the attempt instead uses shared email/address admission with
signed-device constraints. A nonreserved account can then receive `429` from a
spent shared lane despite its valid cookie. Administrator and recovery accounts
retain their existing paced password checks.

The cookie never authenticates: a wrong password with it is `401` and spends the
browser's lane, and the address lane and global caps still apply. Tampered,
expired, foreign-account, stale, or duplicated cookies are ignored, returning the
attempt to the shared lane with the same answer a new browser gets. Resetting an
account's password, or deleting and recreating the account, revokes every entry
issued before, including a reset that commits while a sign-in with the old password
is in flight: that sign-in's entry is bound to the state read before its password
check. With external sign-in, a disabled account's entries verify
nothing until it is enabled again; reset the password as well to revoke them for
good. The controller reads the account only for an entry issued for the attempted
email, so forged or foreign cookies add no timing signal about which emails exist,
and a completed read that rejects the binding gives no exemption. Proof reads are
bounded per controller: 30 per signed entry per minute, two active per entry,
600 per minute overall, and 16 active overall. There is no proof cache or waiting
queue. If a read fails or is refused, its signed entry keys also constrain the
ordinary email/address lane: losing proof cannot reopen a spent device allowance.
These keys never grant an exemption. Reserved accounts retain the existing paced
password check. Rotating the auth secret invalidates every entry; the next
successful sign-in issues a new one. A new browser gets no exemption.

The controller configures the Better Auth cookie with the `openclaw_occ`
prefix; the OpenAPI contract names it `openclaw_occ.session_token`. Cookies are
HTTP-only, use `SameSite=Lax`, and cover `/`. Production enables secure cookies;
the configured base URL is also the trusted origin. Session inspection exposes
only `authenticated`, `sessionKey`, and the account's `id`, `email`, and `name`.

Protected requests resolve the current stored session with cookie caching
disabled. A missing, expired, revoked, or forged session is rejected, as is an
`Authorization` header even alongside a session cookie.

## GitHub sign-in for existing accounts

An Installation can let enrolled existing accounts sign in with GitHub, Google or one
generic OIDC issuer.
[External sign-in and account controls](authentication/external-sign-in.md)
defines the single-controller profile, provider flow, session binding, the
recovery user, the administrator account API, and sign-in limits.

## Session and recovery controls

See [session and recovery controls](authentication/external-sign-in.md#session-and-recovery-controls).

## Native admin shared sessions

Agent native admin UI access starts from an ordinary controller browser session.
With the trusted-operator pilot enabled, the session cookie is scoped to the
explicit `nativeAdmin.sharedCookieDomain` parent so the console and derived Agent
hosts share one human session. Service API keys cannot open native admin UI.
When native admin is disabled, leftover shared-cookie-domain configuration is
ignored and the host-only `openclaw_occ` cookie remains.

The explicit parent domain is validated against the console origin and Agent host
suffix on DNS-label boundaries. Public suffixes, malformed domains, and outside
hosts are rejected; OCC never infers a broader parent. Because a domain cookie
cannot use `__Host-`, the shared session uses prefix `openclaw_occ_shared`
(`__Secure-openclaw_occ_shared.session_token` on HTTPS). Successful sign-in and
sign-out clear prior host-only `openclaw_occ` and `openclaw_occ_shared` cookie
names so browsers never choose between duplicates.

Native-host requests authenticate the shared OCE session, resolve the exact
Agent represented by the requested host, authorize exact Agent `administer`, and
validate the current active revision and supported native configuration before
proxying. OCC strips browser cookies, `Authorization`, API and session keys,
forwarded identity, and native scope headers before forwarding upstream, so the native
gateway never receives the OCE session cookie. Native chat or other Agent-host
activity does not renew the console session.

## Account provisioning

`POST /api/auth/accounts` requires a human session and `administer` on the
singleton Installation, and stays available with GitHub sign-in enabled. One
transaction writes the account, Principal, grant, enrollment and an optional
`"github":{"subject":"<numeric id>"}` identity (`409` if GitHub is off or taken).

An optional `roleId` binds an existing Installation Role (`400` if unknown or
Namespace-scoped); without one the account has no grants. It cannot create Roles
or infer grants. Audit records `principalId` and `roleId` or `grant: "none"`.
Creation issues no session.

The only Installation Role is the built-in Installation administrator
(`role_admin_<uuid>`). The API cannot create other Installation Roles, and the
Namespace policy API does not list this one. The account binds it to the exact
Installation, so only its Installation `administer` and `read` apply: account
and service key administration, not Namespace or Agent access (bootstrap's
binding is unscoped). Otherwise omit `roleId`, then grant Namespace access with
the returned `principalId`; see [Add a person](../guides/topics/iam.md#add-a-person).
A representative provisioning body is:

```json
{
  "email": "operator@example.invalid",
  "password": "<generated-random-password>"
}
```

Emails are normalized to lowercase. Passwords must contain 12–128 characters.
Provisioning has no public email-verification or signup flow; duplicates are
rejected.

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

Anonymous session inspection returns `200` with `data: null`.

## Automation credentials

Non-Agent automation uses `x-api-key` with an existing IAM ServicePrincipal. [Service API keys](authentication/service-api-keys.md) defines issuance, credential precedence, exact scope, revocation, audit behavior, and failures. Keys do not inherit their issuer’s permissions or create human sessions.

## Evidence and related references

The [authentication implementation](../../apps/controller/src/auth/index.ts)
owns sessions; the [HTTP routes](../../apps/controller/src/index.ts) own
endpoint exposure and provisioning authorization.

- [Local authentication tests](../testing/local.md#authentication-and-authorization-coverage)
- [Service-key persistence tests](../testing/postgresql.md#service-key-persistence)
- [Service API key flow](../flows/service-api-keys.md)
- [Issue or rotate a service API key](authentication/service-api-keys.md#issue-a-service-key)
- [IAM overview](../guides/topics/iam.md)
- [Authorization](authorization.md)
- [Generated API reference](api.md)
- [Controller settings](settings.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-30 22:10: Qualify known-browser availability when finite account proof is unavailable. (authoring-run/d22560bc-da4b-4470-ab17-83e8ce51825c - a4daf446aef9eb3571c4b43dac986a6f58d86cf0)

- 2026-09-20 08:53: Replaced native-admin launch-code sessions with the shared OCE session cookie boundary and cookie-domain validation. (cody/01a0b7fd-13fa-7dc2-8653-5c5814b59305 - 5e5f12f37842ae7239d73432e00609547627ded8)

- 2026-08-31 22:29: Define single-attempt bootstrap failure handling with retained artifacts, no automatic recovery, and manual operator repair. (01a05a3d-526f-7553-8cd8-070bd1847acb - 94a5440898bf331987148d7733f0075506af64a6)

- 2026-08-31 17:43: Document fresh human/service administrator bootstrap, private key delivery, and operator recovery. (codex/01a05a69-3fbe-7441-9e6d-20394758cf94 - 0797098646028ac00cb26cd4afcbc9b2cf8bcb24)

- [2026-08-28 20:17]: Allow IAM-authorized service administrators to issue and revoke keys; retain human-session account creation and bootstrap. (codex/01a04927-11d8-7083-a4b7-9f3124559d82 - d4b5b01d02cf68a89965f7c00a0fc7d0dcec18d8)

- [2026-08-28 17:54]: Reorganize as a current feature reference; move procedural setup to the shared guides. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
