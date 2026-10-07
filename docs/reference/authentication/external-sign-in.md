# External sign-in and account controls

This page covers GitHub, Google and generic OIDC browser sign-in for existing OpenClaw Control
Plane (OCC) accounts, and the session, recovery, and account controls that apply
once an external provider is enabled. The [authentication reference](../authentication.md)
covers bootstrap, password sessions, request origin, provisioning, and failures.

## GitHub sign-in for existing accounts

GitHub sign-in requires one serving controller, one Installation, PostgreSQL with
its restricted application role, native IAM, one GitHub App on github.com, and one
canonical HTTPS Console origin with host-only cookies. Shared-cookie native
administration (startup fails with `EXTERNAL_SIGN_IN_NATIVE_ADMIN_UNSUPPORTED`),
other session readers, rolling or mixed-version serving, and mutable Installation
policy are unsupported. Keep bootstrap, seeding, external
policy writers, and recovery-affecting changes stopped.
Native IAM's policy read remains separate from State's actor guard. Loopback
development does not qualify deployed HTTPS.
[Google sign-in](../../guides/deploy/google-sign-in.md) and
[OIDC sign-in](../../guides/deploy/oidc-sign-in.md) use this profile and its
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
[production settings](../settings/production.md#github-sign-in-and-trusted-proxies). An
optional [organization and team allowlist](#organization-and-team-allowlist) limits sign-in
to members.

Use the repository integration's GitHub App. Register `OCC_AUTH_BASE_URL` +
`/api/auth/providers/github/callback` as its callback. Login receives the
[client ID and secret](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app);
the private key stays with the existing repository credential consumer.

OCE requests no OAuth scopes. [App permissions and user access](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-login-with-github-button-with-a-github-app#specify-additional-parameters)
govern the bearer token, which may carry repository authority; `read:user` would
not restrict it. Login uses only [`GET /user`](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
(and, with an [allowlist](#organization-and-team-allowlist), the membership lookups),
then discards tokens, expiry, and scope data. It performs no refresh, creates no
repository grants, and gives no provider credentials to repository consumers or Agents.

A new client ID requires reattachment under a new provider instance; then detach
old methods by `methodId`. Sessions from the old instance end
([session controls](#session-and-recovery-controls)). Secret rotation preserves enrollment
and invalidates pending attempts.

A human Installation administrator reads `GET /api/auth/accounts/:userId`
([requirements](#session-and-recovery-controls)). Its no-store response
contains `userId`, `principalId`, `version`, `disabled`, and `methods` with
`methodId`, `providerId`, and `subject`. Attach a verified positive decimal GitHub
user ID (1–20 digits, no leading zero) through
`POST /api/auth/accounts/:userId/providers/github` with
`{"subject":"12345678","expectedVersion":1}`, using the version just read.

Attachment keeps the user, Principal, and grants, advances the version,
and invalidates sessions and pending proofs. A subject another account already
holds returns `409 RESOURCE_CONFLICT` ("The external identity is already
assigned."), as account creation does. Email association, signup, identity
transfer, and self-service linking are rejected. For unknown identities, follow the
[enrollment procedure](../../guides/deploy/production-installation.md#enable-github-browser-sign-in).

Without an [allowlist](#organization-and-team-allowlist), OCE does not check GitHub
organization or team membership: any attached GitHub user ID signs in. Either way, OCE
does not learn when someone leaves the organization or GitHub suspends them: without
an allowlist someone who left can still sign in, and live sessions continue until they
expire (at most 8 hours). Offboarding also means acting in OCE
([account controls](#session-and-recovery-controls)): disable the account to end all
access and its sessions, or detach its GitHub method to end GitHub sign-in and all its
sessions; revoke ends sessions but allows a fresh sign-in. None of these ends a
[service key](service-api-keys.md#revoke-or-rotate-a-service-key) the person uses
from the CLI: revoke it, or delete its service principal's AccessBindings.

`GET /api/auth/providers` returns `github`, `google`, `oidc`, and `sessionBinding` as `true` when enabled,
with `oidcSignIn` (`label`, `authorizationUrl`) while OIDC is configured,
and `password` as `false` only when [password sign-in is recovery-only](#recovery-only-password-sign-in). A
same-origin `POST /api/auth/providers/github/start` returns `data.url` and a public
`data.attemptId`, and sets a browser-binding cookie. Other provider names return `404`; callers cannot select
callback or return destinations. The [Console flow](../../flows/platform-console.md#2-resolve-the-session-before-private-reads)
owns button and error display.

The callback consumes a short-lived, browser-bound attempt once before code
exchange and resolves the immutable numeric GitHub user ID's exact enrollment.
Unknown identities fail without signup. Success returns to exactly `/console/`
and sets a two-minute HttpOnly, `SameSite=Strict` login receipt; failure returns
to `/console/?authError=github` without automatic retry. An identity attached to a
disabled account returns with `authReason=account-disabled`, audited as `ACCOUNT_DISABLED`
with the account's `userId`; only the person the provider just authenticated reaches it,
and every other refusal stays generic. The starting tab sends its
`attemptId` with the configured Origin to `POST /api/auth/providers/github/result`,
which returns the callback session's `sessionKey` once, only while that session's
cookie is current. It never issues or extends a session.

A callback that is malformed, or whose state and browser cookie match no pending,
unexpired attempt, writes no audit event: its sender is unauthenticated and can mint
both values. The API counts it in
[`occ_sign_in_unmatched_callbacks_total`](../metrics.md#application-families) by
`provider` instead; with metrics disabled only its `http.completed` log record
remains. Once a callback matches its attempt, every denial is audited.

When a provider cannot answer a consumed attempt (transport failure, deadline,
redirect, 429 or 5xx, an oversized or malformed body, or its own `server_error`
or `temporarily_unavailable`), or its token endpoint refuses the configured client
(`invalid_client`, `unauthorized_client`, `unsupported_grant_type`, or GitHub's
`incorrect_client_credentials` or `redirect_uri_mismatch`: check the client ID, secret
and registered callback), the denial is audited as `PROVIDER_UNAVAILABLE` and the API
logs one `authentication.provider-unavailable-warning` at WARN. It carries `provider`
(`github`, `google`, or `oidc`), the provider instance `providerId`, `step`
(`authorization`, `token`, `jwks`, `profile`, or `membership`), a bounded `cause` (`connect_refused`,
`dns`, `timeout`, `tls`, `connection_reset`, `network`, `redirect`, `http_status`,
`oversized_response`, `malformed_response`, `provider_error`, or `client_rejected`), and,
when present, the HTTP `status` or transport `code` such as `ECONNREFUSED`. It never carries URLs,
authorization codes, tokens, response bodies, or user data. A rejected identity logs nothing.

### Organization and team allowlist

`OCC_AUTH_GITHUB_ALLOWED_ORGS` (Helm `auth.github.allowedOrgs`) lists GitHub organization
logins, and `OCC_AUTH_GITHUB_ALLOWED_TEAMS` (`auth.github.allowedTeams`) lists `org/team-slug`
entries, whose active members may use GitHub sign-in. Both are empty by default,
which admits any attached identity as above. Entries are lowercased, at most 10 in total;
other values, or either list without the GitHub client, fail startup. Helm refuses invalid
entries, and either list without `auth.github.enabled`, at render time; the installation
profile wants them lowercase.

With a list, the callback reads membership with the user token after `GET /user` and before
the account lookup, so a refusal reveals nothing about OCE accounts. It reads
[`GET /user/memberships/orgs/{org}`](https://docs.github.com/en/rest/orgs/members#get-an-organization-membership-for-the-authenticated-user)
for each organization, then, for each team whose organization membership is active,
[`GET /orgs/{org}/teams/{team}/memberships/{login}`](https://docs.github.com/en/rest/teams/members#get-team-membership-for-a-user)
(child-team members count). Only `state: active` matches; a pending invitation does not. The
first match admits, even after another lookup failed. The lookups share the 10-second
deadline and refuse redirects.

The GitHub App needs the organization permission **Members: read**, accepted by the owner of
each listed organization, and an installation on each one. Members: read is read-only, and
also lets the App's installation token list those organizations' members and teams. No OAuth
scope is requested.

| Outcome                                     | Audit `reasonCode`       | Console (`authReason`)   |
| ------------------------------------------- | ------------------------ | ------------------------ |
| Not an active member of any entry           | `MEMBERSHIP_REQUIRED`    | `membership`             |
| No match, and a lookup GitHub didn't answer | `MEMBERSHIP_UNAVAILABLE` | `membership-unavailable` |

Both are `authentication.login` denials whose `details` carry `provider: github` and the
numeric GitHub `subject`. The callback returns to
`/console/?authError=github&authReason=<reason>`, and the Console explains the refusal.
`MEMBERSHIP_UNAVAILABLE` covers a transport failure, the deadline, a redirect, an oversized or
malformed answer, and any status other than `200` or `404`. It fails closed and logs
`authentication.provider-unavailable-warning` with `step: membership`. A `403` there usually
means configuration: the organization blocked the App, its owner has not accepted Members:
read, or SAML SSO wants a session the user lacks.

GitHub may answer `404`, not `403`, for an organization where the App is not installed, a
misspelled organization or team slug, or (unverified) an unauthorized SAML session. That
refuses every member as `MEMBERSHIP_REQUIRED` with no warning log. If known members are
refused, check the slugs, that the App is installed on each listed organization, and that its
owner accepted Members: read.

Membership is checked only at sign-in. Turning the list on applies from the next sign-in
after the API restarts; existing sessions run until they expire (at most 8 hours), so revoke
them to apply it at once. Removing someone from the organization or team stops their next
GitHub sign-in but not a live session; disable or detach in OCE to end it.

## Recovery-only password sign-in

By default every enrolled account can still sign in with its password once a
provider is enabled, so strangers who know an email can spend that account's
password sign-in budget. `OCC_AUTH_PASSWORD_SIGN_IN=recovery-only` (Helm
`auth.passwordSignIn: recovery-only`; default `all`) removes that surface:
only the recovery account signs in with a password, and every other account uses
its attached GitHub, Google or OIDC identity. It is the target posture once every
ordinary account has an external identity. It requires a configured provider;
startup and Helm refuse it otherwise, and any other value.

Every other email, existing or not, receives the ordinary `401` bad-credential
answer after the same password hashing, audited as `INVALID_CREDENTIALS`; no
account is read, so the answer reveals nothing. `GET /api/auth/providers`
reports `password: false`, and the Console shows provider buttons with the
password form behind **Recovery sign-in**. During a provider outage only the
recovery account can sign in.

An account without an identity for a configured provider cannot sign in until an
administrator attaches one. Each startup with `recovery-only` logs
`authentication.password-sign-in-warning` (`EXTERNAL_IDENTITY_MISSING`) with the
enabled accounts, other than the recovery account, that lack one, in the
`skippedUserIds` fields that the activation warning also uses. To switch:

1. Keep `all`. As an Installation administrator, attach an identity to every
   ordinary account ([attachment](#github-sign-in-for-existing-accounts)), and
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

New accounts need an identity too: create them with `github.subject`, or attach
one straight after creation.

## Session and recovery controls

Password, GitHub, Google and OIDC sessions share admission rules: an eight-hour lifetime without refresh, current account and
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
it. Password login never depends on GitHub.

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
counts for a delegated Agent `read_logs` grant, as for [service keys](service-api-keys.md#issuance). State locks actor and target
accounts (retryable `503` after five-second lock waits) and rechecks the actor
session. A stale
`expectedVersion` or disabled target returns `409 RESOURCE_CONFLICT`.

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

These account and recovery routes need GitHub, Google or OIDC sign-in. In the
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
budget instead. GitHub, Google and OIDC start, callback, and result each allow 30
requests/minute and four active per client address, eight active in all; a sign-in
spends one of each. Without
[trusted proxies](../cheatsheets/environment-variables.md#controller-and-authentication)
every browser behind an ingress shares its address, so the address is never a key:
callback and result key on the browser's attempt and receipt cookies, and start is
bounded only by the active cap and the 1,000 pending attempts (oldest evicted).
Startup and Helm's install notes warn
([trusted proxies](../settings/production.md#github-sign-in-and-trusted-proxies)).
A 4,096-key table bounds memory. Provider calls share a ten-second deadline, refuse
redirects, read at most 64 KiB. Limits are per controller.
