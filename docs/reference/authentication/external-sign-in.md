# External sign-in and account controls

Google and generic OIDC sign-in for existing OpenClaw Control Plane (OCC)
accounts share these session, recovery and account controls. The
[authentication reference](../authentication.md) covers bootstrap, password sessions,
request origin, provisioning and failures.

## Console sign-in destinations

Sign-in restores the validated page, Namespace, and Agent tab or version after
expiry, then rechecks access. It clears private views and drafts and never
replays writes. Logout or failed external sign-in clears the destination. Agent
recovery ends at its console page; opening native UI remains a separate action.

## External sign-in profile

Google and generic OIDC sign-in require one serving controller, one Installation,
PostgreSQL with its restricted application role, native IAM, a canonical HTTPS
Console origin, and an Agent DNS suffix for
[shared browser sessions](../authentication.md#native-admin-shared-sessions).
Rolling or mixed-version serving and external identity or policy writers are
unsupported. Keep bootstrap, seeding and recovery-affecting changes stopped during
activation. Loopback development does not qualify deployed HTTPS.

[OIDC](../../guides/deploy/oidc-sign-in.md) supports native Agent access.
[Google](../../guides/deploy/google-sign-in.md) requires native administration to be
disabled. Both use the generic `OCC_AUTH_RECOVERY_USER_ID` setting, rendered from
Helm `auth.recoveryUserId`, to seed the first local recovery administrator.
Activation enrolls qualifying existing accounts and reports accounts that cannot
sign in. Account creation remains available after activation.

A human administrator explicitly attaches the provider's immutable subject to an
existing OCE account. Attachment keeps its user ID, Principal and grants, advances
its account version, and invalidates sessions and pending proofs. An identity
already held by another account returns `409 RESOURCE_CONFLICT`. Email association,
identity transfer and self-service linking are unsupported. Opt-in
[OIDC enrollment](team-enrollment.md) can create unknown identities and assign
initial access; it never links them by email.

Changing a client ID, or the OIDC issuer, creates a new provider instance and ends
old-instance sessions on their next request. Attach identities under the intended
instance explicitly. Client-secret rotation invalidates pending attempts and
preserves attachments. Direct GitHub browser sign-in is retired; follow the
[upgrade procedure](../../guides/deploy/oidc-upgrade.md) before installing this release.
Repository GitHub credentials remain separate.

## Browser callback and audit

`GET /api/auth/providers` returns `google`, `oidc`, `password` and `sessionBinding`.
When OIDC is configured, `oidcSignIn` supplies its `label` and `authorizationUrl`.
A same-origin `POST /api/auth/providers/oidc/start` returns `data.url` and a public
`data.attemptId`, and sets a browser-binding cookie. Google uses the matching
`google` routes. Callers cannot select callback or return destinations.

The callback consumes a five-minute, browser-bound attempt before exchanging its
code. Signature, issuer, audience, expiry and nonce checks precede identity lookup.
Success returns to `/console/` with a two-minute HttpOnly, `SameSite=Strict` receipt.
The starting tab posts `attemptId` to the provider's `/result` route and receives
the callback session's `sessionKey` once, only while that session cookie is current.
The exchange does not issue or extend a session.

Failure returns to `/console/?authError=oidc` (or `google`) without automatic retry.
An authenticated identity attached to a disabled account gets
`authReason=account-disabled`, audited as `ACCOUNT_DISABLED`. Provider unavailability
gets `authReason=provider-unavailable`, audited as `PROVIDER_UNAVAILABLE`.
Other identity and admission refusals remain generic. An internal dependency
failure or uncertain commit gets `authReason=unavailable`; it is not an identity
denial and is not retried automatically.

Malformed, replayed, expired or unbound callbacks prove nothing about their sender.
They increment [`occ_sign_in_unmatched_callbacks_total`](../metrics.md#application-families)
instead of writing audit records. Matched attempts record denials. Successful
external login audits include the verified subject and attempt ID.

Provider failures log `authentication.provider-unavailable-warning` with the
provider, instance, step (`authorization`, `token` or `jwks`), and a bounded cause.
Causes include network errors, timeout, redirect, HTTP failure, oversized or malformed
response, provider error, and rejected client configuration. Logs omit tokens,
client secrets and response bodies. Check the endpoint, client credentials, TLS
trust and API egress. Provider bodies share a 64 KiB limit and requests share a
10-second deadline.

## Recovery-only password sign-in

By default every enrolled account can still sign in with its password once a
provider is enabled, so strangers who know an email can spend that account's
password sign-in budget. `OCC_AUTH_PASSWORD_SIGN_IN=recovery-only` (Helm
`auth.passwordSignIn: recovery-only`; default `all`) removes that surface:
only the recovery account signs in with a password, and every other account uses
its attached Google or OIDC identity. It requires a configured provider;
startup and Helm refuse it otherwise, and any other value.

Every other email, existing or not, receives the ordinary `401` bad-credential
answer after the same password hashing, audited as `INVALID_CREDENTIALS`; no
account is read, so the answer reveals nothing. `GET /api/auth/providers`
reports `password: false`. The Console keeps the password form behind
**Recovery sign-in** while discovering sign-in methods, then adds the configured
provider buttons. During a provider outage only the recovery account can sign in.

An account without an identity for a configured provider cannot sign in until an
administrator attaches one. Each startup with `recovery-only` logs
`authentication.password-sign-in-warning` (`EXTERNAL_IDENTITY_MISSING`) with the
enabled accounts, other than the recovery account, that lack one, in the
`skippedUserIds` fields that the activation warning also uses. To switch:

1. Keep `all`. As an Installation administrator, attach an identity to every
   ordinary account ([attachment](#external-sign-in-profile)), and
   have each person sign in with it once.
2. Set `recovery-only` and upgrade. If the warning lists accounts, attach their
   identities; that takes effect without a restart. Setting `all` again and upgrading restores
   passwords.

The setting gates new password sign-ins only. Password sessions that already
exist keep working until they expire (at most 8 hours): those of ordinary
accounts after the switch to `recovery-only`, and the former holder's after
`POST /api/auth/recovery` moves the designation. To end them at once, call
`POST /api/auth/accounts/:userId/revoke` for each account, which ends all of its
sessions, or run `purge-sessions` with
[stopped maintenance](../../guides/deploy/auth-maintenance.md).

Attach an identity explicitly to a manually created account, or use OIDC enrollment for a new identity.

## Session and recovery controls

Password, Google and OIDC sessions share admission rules: an eight-hour lifetime without refresh, current account and
method checks, and required audit before a cookie is released or, on logout,
cleared. Older sessions without account/method binding are rejected; users sign in again.
An external session authenticates only while its provider instance is configured: removing
a provider, or changing its client ID (or OIDC issuer), ends that instance's sessions on their
next request, audited once as `authentication.session.end` with reason
`PROVIDER_NOT_CONFIGURED`. Password sessions are unaffected. Activation is one-way:
removing every provider fails startup, and the database refuses sessions from older
binaries. Returning to password-only sign-in needs [stopped maintenance](../../guides/deploy/auth-maintenance.md#deactivate-external-sign-in).

The recovery user needs one local password, its Installation Principal, and
native IAM Installation `administer`; disabling it returns `409`. Keep its password
in protected custody; out-of-band database or policy changes can remove
it. Password login never depends on an external provider.

`POST /api/auth/recovery` (`userId`, `expectedCurrentUserId`, target
`expectedVersion`) moves the designation (`GET` reads it) to another qualifying
user. The caller needs every IAM grant of the current holder's Principal (else
`403`). The variable, like `auth:maintain activate --recovery-user`, then only
seeds first activation; a differing value warns, and each start re-checks the holder.

Account reads and mutations require a human session, exact `Origin`, and
Installation `administer`; service keys are refused. Account mutations also
require every IAM grant of the target account's Principal (else `403`, audited as
`ACCOUNT_PRINCIPAL_GRANTS_NOT_COVERED` with the target `userId` and `principalId`, the current
holder's for a recovery move); Agent `administer`
counts for a delegated Agent `read_logs` grant, as for [service keys](service-api-keys.md#issuance).
After locking, State rechecks caller authority, target coverage and the
recovery successor, then the session. Policy stays stable through commit.
Lock contention returns retryable `503`; lost caller authority or target coverage
returns `403` without mutation. Stale `expectedVersion`, disabled targets or
successors lacking Installation `administer` return `409 RESOURCE_CONFLICT`.

Send the version just read, such as `{"expectedVersion":1}`:

| Operation                                                  | Effect                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /api/auth/accounts/:userId/disable`                  | Disables the account, invalidating sessions and pending proofs; refuses the recovery user.            |
| `POST /api/auth/accounts/:userId/enable`                   | Re-enables a disabled account; users sign in again.                                                   |
| `POST /api/auth/accounts/:userId/revoke`                   | Invalidates all account sessions and pending proofs; fresh sign-in still works.                       |
| `POST /api/auth/accounts/:userId/methods/:methodId/detach` | Removes one attached external identity and ends every account session; password methods return `409`. |

`POST /api/auth/accounts/:userId/enrol` (no body) enrolls a skipped account holding
its Principal and one password. These operations serialize with session issuance
and leave IAM grants unchanged.
An unknown administrative COMMIT returns `503 DEPENDENCY_UNAVAILABLE` with an
unknown-outcome message, never success, automatic replay, or compensation. An
account read shows present state, **not a receipt**: the original transaction may
still be running. Resolve uncertainty before choosing a new action and version.
Password reset and deletion remain deferred.

These account and recovery routes need Google or OIDC sign-in. In the
password-only profile an authorized administrator receives
`409 RESOURCE_CONFLICT` naming that requirement; the profile has no account
version, disabled state, or session binding, so it cannot disable an account or
revoke its sessions online. Enable an external provider to use these controls.

Password sign-in has the password-only profile's
[failure-counting limit](../authentication.md#session-lifecycle): only failed sign-ins
spend it, and a spent email is slowed and answered with `429` and `Retry-After`. The
recovery account and Installation administrators are slowed, never refused: their
correct password still signs in. A browser with a valid
[known-device cookie](../authentication.md#known-devices) for the email spends its own
budget instead. Google and OIDC start, callback, and result each allow 30
requests/minute and four active per client address, eight active in all; a sign-in
spends one of each. Without
[trusted proxies](../cheatsheets/environment-variables.md#controller-and-authentication)
every browser behind an ingress shares its address, so the address is never a key:
callback and result key on the browser's attempt and receipt cookies, and start is
limited only by the active request cap and the 1,000 pending attempts (oldest evicted).
Startup and Helm's install notes warn
([trusted proxies](../settings/production.md#external-sign-in-and-trusted-proxies)).
A 4,096-key table bounds memory. Provider calls share a ten-second deadline, refuse
redirects, read at most 64 KiB. Limits are per controller.
