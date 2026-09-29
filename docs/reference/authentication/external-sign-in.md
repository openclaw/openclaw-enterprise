# External sign-in and account controls

This page covers GitHub and Google browser sign-in for existing OpenClaw Control
Plane (OCC) accounts, and the session, recovery, and account controls that apply
once an external provider is enabled. The [authentication reference](../authentication.md)
covers bootstrap, password sessions, request origin, provisioning, and failures.

## GitHub sign-in for existing accounts

GitHub sign-in requires one serving controller, one Installation, PostgreSQL with
its restricted application role, native IAM, one GitHub App on github.com, and one
canonical HTTPS Console origin with host-only cookies. Shared-cookie native
administration, other session readers, rolling or mixed-version serving, and
mutable Installation policy are unsupported. Keep bootstrap, seeding, external
policy writers, and recovery-affecting changes stopped.
Native IAM's policy read remains separate from State's actor guard. Loopback
development does not qualify deployed HTTPS.
[Google sign-in](../../guides/deploy/google-sign-in.md) uses this profile and its
controls.

HTTPS sessions use `__Host-openclaw_occ.session_token`, `Secure`, `HttpOnly`,
`Path=/`, and no `Domain`, preventing sibling hosts from planting that cookie.
Session reads, protected requests, and logout reject duplicate session cookies.

Activation enrolls qualifying existing accounts and reports the rest, which cannot
sign in. Creation continues and enrolls new accounts in the same transaction (see
[Account provisioning](../authentication.md#account-provisioning)).
Set all three API-process variables; partial configuration fails startup:

| Variable                           | Purpose                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `OCC_AUTH_GITHUB_CLIENT_ID`        | GitHub App client ID, not App ID; determines the provider-instance key. |
| `OCC_AUTH_GITHUB_CLIENT_SECRET`    | GitHub App client secret in protected server configuration.             |
| `OCC_AUTH_GITHUB_RECOVERY_USER_ID` | Local password administrator seeding the first recovery designation.    |

Helm renders them from `auth.github` and `auth.recoveryUserId`; see
[production settings](../settings/production.md#github-sign-in-and-trusted-proxies).

Use the repository integration's GitHub App. Register `OCC_AUTH_BASE_URL` +
`/api/auth/providers/github/callback` as its callback. Login receives the
[client ID and secret](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app);
the private key stays with the existing repository credential consumer.

OCE requests no OAuth scopes. [App permissions and user access](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-login-with-github-button-with-a-github-app#specify-additional-parameters)
govern the bearer token, which may carry repository authority; `read:user` would
not restrict it. Login uses only [`GET /user`](https://docs.github.com/en/rest/users/users#get-the-authenticated-user),
then discards tokens, expiry, and scope data. It performs no refresh, creates no
repository grants, and gives no provider credentials to repository consumers or Agents.

A new client ID requires reattachment under a new provider instance; then detach
old methods by `methodId`. Secret rotation preserves enrollment and invalidates
pending attempts.

A human Installation administrator reads `GET /api/auth/accounts/:userId`
([requirements](#session-and-recovery-controls)). Its no-store response
contains `userId`, `principalId`, `version`, `disabled`, and `methods` with
`methodId`, `providerId`, and `subject`. Attach a verified positive decimal GitHub
user ID (1–20 digits, no leading zero) through
`POST /api/auth/accounts/:userId/providers/github` with
`{"subject":"12345678","expectedVersion":1}`, using the version just read.

Attachment keeps the user, Principal, and grants, advances the version,
and invalidates sessions and pending proofs. Subjects owned by another
user, email association, signup, identity transfer, and self-service linking are
rejected. For unknown identities, follow the
[enrollment procedure](../../guides/deploy/production-installation.md#enable-github-browser-sign-in).

`GET /api/auth/providers` returns `github`, `google`, and `sessionBinding` as `true` when enabled. A
same-origin `POST /api/auth/providers/github/start` returns `data.url` and a public
`data.attemptId`, and sets a browser-binding cookie. Other provider names return `404`; callers cannot select
callback or return destinations. The [Console flow](../../flows/platform-console.md#2-resolve-the-session-before-private-reads)
owns button and error display.

The callback consumes a short-lived, browser-bound attempt once before code
exchange and resolves the immutable numeric GitHub user ID's exact enrollment.
Unknown identities fail without signup. Success returns to exactly `/console/`
and sets a two-minute HttpOnly, `SameSite=Strict` login receipt; failure returns
to `/console/?authError=github` without automatic retry. The starting tab sends its
`attemptId` with the configured Origin to `POST /api/auth/providers/github/result`,
which returns the callback session's `sessionKey` once, only while that session's
cookie is current. It never issues or extends a session.

## Session and recovery controls

Password and GitHub sessions share admission rules: an eight-hour lifetime without refresh, current account and
method checks, and required audit before a cookie is released or, on logout,
cleared. Older sessions without account/method binding are rejected; users sign in again. Activation is one-way: removing every provider
fails startup, and the database refuses sessions from older
binaries. Returning to password-only sign-in needs [stopped maintenance](../../guides/deploy/auth-maintenance.md#deactivate-github-sign-in).

The recovery user needs one local password, its Installation Principal, and
native IAM Installation `administer`; disabling it returns `409`. Keep its password
in protected custody; out-of-band database or policy changes can remove
it. Password login never depends on GitHub.

`POST /api/auth/recovery` (`userId`, `expectedCurrentUserId`, target
`expectedVersion`) moves the designation (`GET` reads it) to another qualifying
user. The caller needs every IAM grant of the current holder's Principal (else
`403`). The variable, like `auth:maintain activate --recovery-user`, then only
seeds first activation; a differing value warns, and each start re-checks the holder.

Account reads and mutations require a human session, exact `Origin`, and
Installation `administer`; service keys are refused. Account mutations also
require every IAM grant of the target account's Principal (else `403`). State locks actor and target
accounts (retryable `503` after five-second lock waits) and rechecks the actor
session. A stale
`expectedVersion` or disabled target returns `409 RESOURCE_CONFLICT`.

Send the version just read, such as `{"expectedVersion":1}`:

| Operation                                                  | Effect                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `POST /api/auth/accounts/:userId/disable`                  | Disables the account, invalidating sessions and pending proofs; refuses the recovery user. |
| `POST /api/auth/accounts/:userId/enable`                   | Re-enables a disabled account; users sign in again.                                        |
| `POST /api/auth/accounts/:userId/revoke`                   | Invalidates all account sessions and pending proofs; fresh sign-in still works.            |
| `POST /api/auth/accounts/:userId/methods/:methodId/detach` | Removes one attached external identity and its sessions; password methods return `409`.    |

`POST /api/auth/accounts/:userId/enrol` (no body) enrolls a skipped account holding
its Principal and one password. These operations serialize with session issuance
and leave IAM grants unchanged.
An unknown administrative COMMIT returns `503 DEPENDENCY_UNAVAILABLE` with an
unknown-outcome message, never success, automatic replay, or compensation. An
account read shows present state, **not a receipt**: the original transaction may
still be running. Resolve uncertainty before choosing a new action and version.
Password reset and deletion remain deferred.

Password sign-in allows 10 requests/minute, two active, per client address and
per email; GitHub start/callback (even invalid) allows 30 and four per
address. Global caps: four and eight active. The recovery email has a
reserved lane (20, two active). A 4,096-key table bounds memory. Clients behind
an ingress share its address unless
[trusted proxies](../cheatsheets/environment-variables.md#controller-and-authentication)
are set. Pending attempts cap at 1,000, oldest evicted. Provider
calls share a ten-second deadline, refuse redirects, read at most 64 KiB. Limits
are per controller.
