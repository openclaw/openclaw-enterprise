# Authentication

OpenClaw Control Plane (OCC) authenticates human API clients with
sessions from email/password sign-in or an enrolled
Google or OIDC identity. OIDC supports opt-in
[team enrollment](authentication/team-enrollment.md). Non-Agent automation uses service
API keys. Better Auth owns
password verification, revocable session cookies, and hashed API-key storage.
The selected IAM Driver resolves the authenticated account or service identity
to an explicitly provisioned Principal or ServicePrincipal and owns
[authorization](authorization.md).

See [human administrator sign-in](authentication/service-api-keys.md#sign-in-as-a-human-administrator)
or the [service-key procedure](authentication/service-api-keys.md).
The [platform console](console.md) at `/console/` uses these session endpoints. Unrestricted public signup, OIDC
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
its authority survives human account deletion.

Fresh bootstrap also creates the initial [`default` Namespace](namespaces.md#initial-namespace)
under the bootstrap Principal's ordinary Namespace creation permission.
Installation/IAM state, the Namespace, its queued reconciliation, and bootstrap
audit commit together. Worker provisioning is asynchronous.

Fresh development and production initialization require
`OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE` and `OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE`:
absolute paths to readable regular UTF-8 files, each at most 4 KiB, without NUL
or embedded line breaks. Bootstrap removes one final LF or CRLF, preserving
password spaces. Passwords require 12–128 characters. Generate the key
cryptographically: `occ_` plus canonical unpadded base64url encoding of 32 random
bytes. Format validation cannot prove entropy. Never reuse the password as the key.

Bootstrap validates both inputs before creating credentials. It follows projected
Secret symlinks. Host installers must restrict file access to required identities.
Retired output settings `OCC_BOOTSTRAP_PASSWORD_FILE` and
`OCC_BOOTSTRAP_SERVICE_KEY_FILE` fail with a non-secret diagnostic.

Better Auth hashes the supplied `bootstrap-admin` key with its service identity,
Installation metadata and 30-day expiry from registration. No plaintext reaches bootstrap output,
audit or logs. Ordinary issuance generates keys.

Before Helm installation, precreate `bootstrap.credentials.secretName` in the
release namespace. `passwordKey` and `serviceKeyKey` default to `admin-password`
and `admin-service-key`. Only fresh-install bootstrap receives the read-only
projection; migration, API and worker do not. Upgrades need no Secret. No bootstrap PVC, preparation/reader Pod or Secret API permission is needed.
Operators retain sources.

`scripts/bootstrap-installation.mjs` runs between migration and API/worker
startup. Compose uses bootstrap-only input secrets. Setup tools prepare private
files outside the checkout; `OPENCLAW_DEV_PASSWORD` selects their password, not
an initializer credential. Direct runs supply both paths.

An already-bootstrapped Installation receives no new Namespace, identity, grants,
key or password. It verifies the administrator without reading credential files.
Restarting does not replace missing files, expired/revoked keys, removed service
identities, or removed grants. Use normal issuance/revocation for credential
recovery and rotation.

Bootstrap makes one attempt. Any error emits `installation.bootstrap-failed`
with available non-secret attempt IDs, then exits unsuccessfully. Created
accounts and keys remain for reconciliation.
Bootstrap does not automatically revoke, delete, retry, repair, or reset them.
The Helm initialization Job uses `backoffLimit: 0`. Better Auth persistence and the Installation/IAM commit are separate,
so an error leaves the commit outcome unknown; resolve it before manual repair
or reset an identified disposable Installation. See [incomplete bootstrap recovery](authentication/service-api-keys.md#recover-an-incomplete-bootstrap).
A retained input or locally prepared CLI key file is not proof of successful
initialization. Confirm access with `occ installation get`. Editing a source
Secret does not rotate credentials, restore grants or renew an expired key.

## Browser request origin

Cookie-authenticated API mutations, including sign-out, require the `Origin` from
`OCC_AUTH_BASE_URL`. A missing, malformed, or different origin returns `403` for an
untrusted browser origin. When present, `Sec-Fetch-Site` must be `same-origin`. See
[Session and recovery controls](authentication/external-sign-in.md#session-and-recovery-controls)
for guarded account and recovery reads.

Sign-in rejects an explicitly untrusted or malformed Origin and also rejects
`Sec-Fetch-Site: cross-site` when Origin is missing. Command-line sign-in may
omit both headers. For later cookie-authenticated mutations, command-line clients
must provide the configured Origin. An explicitly supplied service API key does
not require Origin, and an invalid key never falls back to a session cookie.

## Session lifecycle

| Operation                      | Supported behavior                                                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/sign-in/email` | Verifies an existing account's email and password and issues a session cookie. The JSON response confirms authentication, and with external sign-in enabled returns `sessionKey`, never a session token. |
| `GET /api/auth/session`        | Returns safe account identity and a noncredential `sessionKey`, or `data: null` without a valid session.                                                                                                 |
| `POST /api/auth/sign-out`      | Revokes the current session. Protected API requests using that session subsequently return `401`.                                                                                                        |

Human-session Namespace IAM writes retain assigning authority through their transaction; see
[Sharing commit guarantees](authorization.md#manage-namespace-policy).

The `sessionKey` identifies the session, stays stable across reads,
and changes at sign-in. It cannot authenticate; the token stays in its HttpOnly
cookie. Console pins each
tab's requests with `x-occ-session-key`. Foreign, malformed, or duplicated keys
return `401`; rejected sign-out preserves sessions and cookies. Omitting the
header leaves requests unchanged.

Session inspection never sets cookies; late old-session responses cannot clear
newer sign-in cookies.

Password-only sign-out confirms session deletion before clearing its cookie. A
storage failure returns `503 DEPENDENCY_UNAVAILABLE` without clearing the cookie;
retry sign-out after storage recovers.

Password-only sessions expire seven days after sign-in; use does not extend
them. With Google or OIDC sign-in enabled, every session expires after
eight hours ([session controls](authentication/external-sign-in.md#session-and-recovery-controls)).
Password-only has no online way to end another account's session: removing its
IAM bindings and Group memberships refuses permissioned requests from the next
one (native admin WebSockets within about 25 s), and `purge-sessions --user
<userId> --writers-stopped` ([stopped maintenance](../guides/deploy/auth-maintenance.md#choose-the-operation))
ends it.

Sign-in takes `{"email": "...", "password": "..."}`. The session arrives only
through `Set-Cookie`.

Sign-in rejects NUL or unpaired-surrogate emails with `400 INVALID_REQUEST`
before account or known-device State reads. Both profiles retain denial audits
and budget accounting, including recovery-only and counted `503` audit failures.
Limited attempts remain `429`; passwords are unchanged. Stored U+FFFD email is
unsupported: password-only returns `400 FORBIDDEN` without a session. Guarded
credential checks can create a session and cookie, but HTTP session inspection
returns `500 INTERNAL_ERROR`, not usable-session proof.

In both profiles, after 10 failed sign-ins per minute per email, or 20
per client address with [`api.trustedProxy`](settings/production.md#external-sign-in-and-trusted-proxies),
attempts wait 1–8 s and return `429` with `Retry-After`, repeated in the message, whether
or not the email exists; an Installation administrator's correct password still signs in, and so does
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

Password checks attempt an `authentication.login` audit: success names the
account's Principal and `userId`; wrong passwords and unknown emails produce
`denied`/`INVALID_CREDENTIALS` without account identity. Audit writes fail closed.
Failed success audits return `503` without a cookie; uncertain session creation
or cleanup may leave a server-side session. Failed denial audits still count
against tracked budgets, returning `503` or, in the slow lane, `429`. Untracked
or exhausted lanes are paced without necessarily adding failure entries.
Unconfirmed audit writes have unknown persistence outcomes. Admission `429`s
before password checking are unaudited and reported by
`authentication.sign-in-limited`. Slow-lane administrator checks remain audited;
wrong passwords return `429`.

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
and a completed read that rejects the binding gives no exemption. Each controller
limits proof reads to 30 per signed entry per minute, two active per entry,
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

## External sign-in for existing accounts

An Installation can let enrolled existing accounts sign in with Google or one
generic OIDC issuer.
[External sign-in and account controls](authentication/external-sign-in.md)
defines the single-controller profile, provider flow, session binding, the
recovery user, the administrator account API, and sign-in limits.

## Session and recovery controls

See [session and recovery controls](authentication/external-sign-in.md#session-and-recovery-controls).

## Native admin shared sessions

By default, browser sessions use one shared cookie scope, including when native Agent
access is disabled. Configure an HTTPS Console origin and an Agent DNS suffix.
OCC derives their longest common DNS-label suffix and rejects IP literals,
missing or unrelated hosts, public suffixes, and malformed DNS names. For
`console.oce.example.com` and `agents.oce.example.com`, the scope is
`oce.example.com`. There is no cookie-domain override. Guarded OIDC can instead select the
[host-only exchange](agent-native-admin.md#host-only-session-exchange): the
Console cookie stays on its host, and the Agent receives a revocable handle
bound to the parent session. The exchange creates no account or grant.

Every host that receives this domain cookie must be a trusted OCE ingress
endpoint. Public preview hosts must remain outside it. The cookie uses
`__Secure-openclaw_occ_shared.session_token`, `Secure`, `HttpOnly`, `Path=/`,
and the existing SameSite and CSRF protections. Password, OIDC and Google
sign-in share this format. Duplicate session-cookie values are rejected.

Sign-out revokes the current session and expires its cookie. OCE does not
clear obsolete cookie names or scopes. Remove stale OCE cookies in the browser
if they cause duplicate-cookie refusals. External-provider attempt cookies
remain host-only.

Native-host requests authenticate the shared OCE session or host-only handle, resolve the exact
Agent represented by the requested host, authorize exact Agent `operate` or `administer`, and
validate the selected version and supported native configuration before
proxying. OCC strips browser cookies, `Authorization`, API and session keys,
forwarded identity, and native scope headers before forwarding upstream, so the native
gateway never receives the OCE session cookie. Native chat or other Agent-host
activity does not renew the console session.

## Account provisioning

`POST /api/auth/accounts` requires a human session and the selected IAM Driver's
`administer` grant on the server-owned singleton Installation. Emails are
lowercase and unique. Passwords require 12–128 characters. OCE skips email
verification. Attach external identities explicitly or use
[OIDC enrollment](authentication/team-enrollment.md) for unknown identities.

Before hashing, each controller allows 10 attempts per authorized administrator
Principal across sessions and target emails, refilling one every six seconds.
Exhaustion returns `429 RATE_LIMITED` with `Retry-After`.

Optional `roleId` binds an existing Installation Role. Omit it for no direct
binding. Unknown, Namespace-scoped, and configured `role_config_` Roles return `400`. The sole non-configured Role,
`role_admin_<uuid>`, grants only `installation:administer` and `installation:read`
here. APIs cannot create more Installation Roles. The Namespace policy API omits it.

Creation holds the original session through commit and rechecks the selected IAM
Driver before inserting the account. With Native IAM, the assigning authority
must also remain current through commit; otherwise creation rolls back. Creation joins [configured default Groups](authorization/default-users.md#group-membership)
and issues no session. The success audit records `principalId`, `roleId` or
`grant: "none"`, and any `groupIds`. A lost `COMMIT` reply returns
`503 DEPENDENCY_UNAVAILABLE`. Confirm the outcome before retrying or changing grants.

See the [request example](../guides/topics/iam.md#add-a-person) and
[transaction flow](../flows/local-password-authentication.md#5-provision-additional-accounts).

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

[Authentication documentation history](authentication/history.md) preserves the older dated entries.
