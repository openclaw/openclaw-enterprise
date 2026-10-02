---
created: 2026-08-24
updated: 2026-10-01
last_updated_session: authoring-run/afd78df4-12de-4f41-b2df-7ebb53ed3213
---

# Bootstrap and human authentication flow

## Overview

Fresh native-IAM bootstrap creates human and service administrators, shares their
Role through separate bindings, and commits them with the Installation. It writes
the initial service key to protected storage. Production also delivers a generated
human password; development uses its configured password. This flow covers
initialization, human sign-in, and exact IAM authorization. The
[service API key flow](service-api-keys.md) covers verification, rotation, and revocation.

## Entry Points

- Trigger: `node scripts/bootstrap-installation.mjs` with `NODE_ENV=development`
  or `production`, `POST /api/auth/sign-in/email`, `POST /api/auth/providers/github/start`,
  `GET /api/auth/providers/github/callback`, the matching `google` routes, or a protected
  controller request.
- Source: [`scripts/bootstrap-installation.mjs`](../../scripts/bootstrap-installation.mjs),
  [`apps/controller/src/auth/index.ts:createControllerAuth`](../../apps/controller/src/auth/index.ts),
  and [`apps/controller/src/index.ts:createFastifyApp`](../../apps/controller/src/index.ts).
- Assumptions: Migrated PostgreSQL, configured Better Auth, native IAM bootstrap,
  protected output storage, disabled public signup, and exact IAM authorization.
  Production receives a private password path and sibling service-key path;
  development receives only the service-key output path.

## Flow

```mermaid
graph TD
  subgraph Bootstrap["Shared installation initializer: one attempt"]
    A["Load Installation"] -->|Existing| B["Verify persisted identity; retain credentials"]
    A -->|Fresh| C["Create human and native IAM seed with service administrator"]
    C --> D["Better Auth persists service-key hash"]
    D --> E["Sync private key JSON and production password file"]
    E --> F["Commit Installation, IAM seed, and audit"]
  end
  F --> G["Complete startup"]
  B --> G
  Bootstrap -->|Any error| H["Exit unsuccessfully; preserve tracked artifacts for manual repair"]
  subgraph Request["Human controller request"]
    G --> P["Verify password or enrolled GitHub identity"]
    P -->|GitHub profile enabled| Q["State rechecks account and method; commits session and audit"]
    Q --> J["Release session cookie"]
    P -->|Password-only profile| J
    Q -->|Disabled, stale proof, or commit failure| R["Reject login; no cookie"]
    J --> N{"Unsafe session request?"}
    N -->|Yes| O["Check console origin and Fetch Metadata"]
    N -->|No| K["Resolve current IAM identity and exact authority"]
    O -->|Trusted| K
    O -->|Rejected| M
    K -->|Allowed| L["Run and audit OCC operation"]
    K -->|Invalid session or denied authority| M["Return 401 or 403"]
  end
```

## Execution Trace

### 1. Load state and create the fresh administrator identities

[`scripts/bootstrap-installation.mjs`](../../scripts/bootstrap-installation.mjs)
loads the singleton Installation. Existing Installations only verify the
configured administrator's immutable account/IAM identity: no key issuance,
output changes, or identity/grant repair, including Installations predating service-administrator bootstrap.

For fresh setup, production creates a Better Auth account with a random password;
development creates the configured `OPENCLAW_DEV_EMAIL`/`OPENCLAW_DEV_PASSWORD`
account. `packages/iam/src/index.ts:createBootstrapAdministratorSeed` adds a
non-Agent `spn_<uuid>` without a Namespace and a separate unrestricted binding to
the human's administrator Role. The [authorization reference](../reference/authorization.md#supported-policy-surface)
defines exact actions. Additional-account provisioning creates no service administrator.

### 2. Issue private output, then commit the Installation

[`apps/controller/src/auth/index.ts:createServiceKey`](../../apps/controller/src/auth/index.ts) persists a Better
Auth key named `bootstrap-admin` with the default 30-day expiry, scoped to this
Installation and service principal. This auth write is independent of the OCC
transaction. An uncommitted IAM seed cannot authorize normal OCC operations;
startup does not expose the application until bootstrap succeeds.

[`bootstrap-output.ts:writeProtectedBootstrapFile`](../../apps/controller/src/composition/bootstrap-output.ts)
creates owner-only output exclusively and syncs it before OCC commit. The JSON
contains the key response and attempt Installation ID; production also writes its
password file on the same protected PVC. Development writes to its bootstrap-only
volume or explicit direct-initialization path. No plaintext reaches logs, audit, HTTP
bootstrap responses, or the worker.

Both modes commit Installation/IAM/audit through the same controller
transaction. The initializer owns one attempt scope for account creation, key
issuance, output, and commit. The API subsequently loads committed state without
signing into itself or calling `POST /installation/bootstrap`; that public
endpoint remains human-session-only and does not issue bootstrap credentials.
Singleton database constraints select at most one committed seed. A losing
initializer fails and preserves completed tracked artifacts for operator
inspection.

Any error ends the single initialization attempt with
`installation.bootstrap-failed`, available non-secret IDs and paths, and a
nonzero exit. Completed tracked accounts, keys, and files remain available for
manual inspection; even a partially written output file is preserved. One
pre-return Better Auth failure is narrower: if password `linkAccount` fails
inside `createAccount`, the helper attempts to delete the just-created user
before rethrowing. The initializer does not treat that cleanup attempt as a
general artifact-recovery path, and it does not automatically revoke, retry,
repair, or reset committed or uncertain state.
The Helm initialization Job uses `backoffLimit: 0`.

The operator confirms the original transaction has finished and compares exact
attempt IDs before manual repair; file existence or another Installation is
insufficient. An uncertain commit can already have persisted the seed, so an
error never authorizes an automatic wipe. A deliberate reset must identify the
disposable Installation and its dedicated storage. The
[recovery procedure](../guides/deploy/service-keys.md#recover-an-incomplete-bootstrap) owns
those operator actions.

After confirmed success, the operator retrieves/imports the existing file and
retains its non-secret IDs. Lost output does not trigger regeneration; normal
[service-key management](service-api-keys.md) owns replacement and revocation.

### 3. Construct session authentication

`apps/controller/src/auth/index.ts:createPostgresControllerAuth` uses OCC's
[public binding](../reference/postgres-auth-binding.md): the caller-owned pool and
full schema, no construction I/O or teardown, rejection without fallback, and
unchanged PostgreSQL/camelCase/transaction settings.

`apps/controller/src/auth/index.ts:createControllerAuth` configures Better Auth
email/password authentication, protected session cookies, and durable PostgreSQL
storage. Sign-in returns `{ authenticated: true }`; the session token stays
in its HttpOnly cookie and is omitted from session-inspection responses.
`safeSessionResponse` projects `sessionKey`, an HMAC of the session record ID
under the auth secret (`apps/controller/src/auth/session-binding.ts`), alongside
public user identity. Console compares it to invalidate retained views and drafts
after a new session, including for the same user. Sign-out revokes the session,
and public signup is disabled. In both profiles
`auth/admission.ts:passwordFailureAdmission` counts failures; fast success clears
the selected identity, not the address. `onLimited` reports
`authentication.sign-in-limited` once per lane/window. `auth/known-device.ts`
checks the email-bound MAC before controller-bounded password-state reads
(see [known devices](../reference/authentication.md#known-devices)).
Verified bindings select the device lane. Failed/refused reads retain signed keys
as additional email/address constraints, never exemptions or renewed allowances.
Completed reads rejecting bindings use the shared lane. Reserved passwords remain
checkable through slow pacing. Password-only admission captures issuance state
before credentials, preserving reset-race invalidation; success may reissue it.
In the password-only profile with PostgreSQL State, `passwordSignInAudit` attempts
`authentication.login`: success names the Principal and `userId`; denial uses
`INVALID_CREDENTIALS` without an account. A failed success audit returns `503`
without a session cookie. The controller attempts session deletion; creation or
cleanup may remain unconfirmed.
A failed denial audit (`DenialAuditUnavailable`) counts as a credential failure
against tracked entries, ordinarily returning `503`; the slow lane may return
`429`. Untracked or exhausted lanes are paced without necessarily adding a
tracked failure. An unconfirmed audit write has an unknown persistence outcome.
With an external provider, `/oce/password` marks a failed denial audit with
`PASSWORD_DENIAL_AUDIT_UNAVAILABLE`; the controller applies the same accounting.
Better Auth logs only errors, so a wrong password writes no unstructured console
warning.

`requireSessionKey` applies the optional `x-occ-session-key` header after the
cookie session resolves, in `ControllerAdmissionVerifier.verify` (protected API
and native admin proxy), `session`, `resolveSession`, and `signOut`. An absent
header changes nothing; a malformed, duplicated, or foreign key returns `401`, so
the header narrows but never selects a session. Sign-out with a foreign key
revokes and clears nothing. The native admin proxy strips the header upstream.

When GitHub is configured, `apps/controller/src/auth/github.ts:createHumanLogin`
wraps the Better Auth adapter and provides curated password, GitHub, and logout
endpoints. `packages/occ/src/state/human-authentication.ts:PostgresHumanAuthentication`
owns persisted account/method checks and the original State transaction.
Password verification captures the credential and account version before the
session transaction rechecks them. Both methods pass a controller-private proof
to the same guarded session creation path; the session and required audit commit
before Better Auth releases its cookie. Session reads check the current account,
method, version, and Principal, with an eight-hour absolute lifetime and no refresh.
HTTPS uses a `__Host-` session cookie so a sibling host cannot plant the active
cookie through a parent-domain `Domain` attribute. Session readers and logout
reject ambiguous duplicate active-session cookies.

For GitHub, the Console reads `GET /api/auth/providers` and sends a same-origin
`POST /api/auth/providers/github/start`. The server stores a five-minute attempt with state and browser
secret digests, provider instance, callback, and PKCE verifier. A host-only
HttpOnly cookie binds the browser; this profile rejects shared-domain sessions.
Authorization requests omit OAuth scopes. Callback consumption commits before
exchange; a losing, expired, or invalid attempt does not exchange a code.
`apps/controller/src/auth/github.ts:exchangeGithubSubject` exchanges the code
with the GitHub App client ID and secret, uses the returned user access token
only for `/user`, and returns the numeric subject. Access and refresh tokens,
expiry, and scope data are discarded; the App private key remains with the
repository credential consumer. The subject selects an exact existing enrollment;
email, login name, and tokens do not become identity or policy. Success redirects
to exactly `/console/`; failure redirects to the fixed
Console URL with a sanitized error marker.

`attemptId` authenticates the attempt-state digest with HMAC. Success sets a signed, two-minute
`SameSite=Strict` v2 receipt binding provider instance, session and attempt. The
same-origin result handler verifies signature, expiry and configured provider
before State lookup; unfinished legacy sign-ins must restart. Wrong-provider refusals
neither consume nor clear the receipt. Matching attempt and current cookie session
permit one exchange per process-local ledger: record consumption until expiry,
clear the receipt; return the session key without issuing or extending sessions. Password sign-in returns
it. Callback denials are audited as
`INVALID_ATTEMPT` (malformed, unbound, replayed, or expired), `PROVIDER_UNAVAILABLE`
(transport failure, deadline, 429/5xx, malformed body), or `EXTERNAL_IDENTITY_REJECTED`;
State dependency failure or uncertain session completion is not a denial. Neither path retries.

Google (and generic OIDC) reuses `apps/controller/src/auth/github.ts:externalProviderEndpoints` for
start, callback, and result, with provider instance `google:<sha256(client ID)>`.
Authorization adds scope `openid email` and an auth-secret HMAC of attempt state
as nonce, without extra storage.
`apps/controller/src/auth/google.ts:exchangeGoogleSubject` exchanges the code, fetches
Google's signing keys through the same bounded transport, verifies the RS256 ID token's
signature, issuer, audience, expiry, and nonce (plus `hd` and `email_verified` when
allowed domains are set), and returns only `sub`. Tokens and email are discarded.

Password sign-in is admitted by the controller route before `/oce/password` runs, with the
recovery email reserved like an administrator's. Start, callback, and result each have
bounded process-local admission (`keyedAdmission`), shared by GitHub, Google and OIDC, keyed on
the client address only behind a trusted proxy and otherwise on the browser's cookies. Provider HTTP shares a deadline and
limits streamed response bytes; State bounds pending attempts and expired cleanup.
State sets the five-minute attempt and eight-hour session deadlines. Cookie
Max-Age subtracts monotonic elapsed work from that persisted lifetime; expired
completion cannot release a cookie.

Activation requires stopped admission, drained or terminated requests, and every
old controller stopped. Both PostgreSQL compositions reject
GitHub with enabled native administration, even when its cookie domain is missing.
`apps/controller/src/auth/index.ts:createPostgresControllerAuth` constructs and
initializes authentication before activation, checking the secret, canonical HTTP
origin, and supported profile. Invalid static configuration leaves legacy sessions,
account enrollment, and the recovery designation unchanged.
`PostgresHumanAuthentication.activateRecovery` then validates and enrolls the complete existing password-user/Principal population,
fixes the usable recovery administrator, and removes unbound historical sessions
in one State transaction before serving resumes. Unsupported or incomplete
populations fail activation. This is a stopped-maintenance contract; startup does
not fence an old live reader. See the
[deployment procedure](../guides/deploy/production-installation.md#enable-github-browser-sign-in).

The controller's account routes authorize native IAM Installation `administer`
and require a current human session and the configured Origin. State locks both
actor and target, rechecks the actor session, and applies the caller's
`expectedVersion`. Attachment, disablement, and account-wide revocation advance
that version and invalidate target sessions and proofs without changing IAM.
A guarded read returns current account and method state, not a prior operation
receipt. Unknown completion returns an explicit dependency failure without
replay or compensation; operators must resolve uncertainty before a new action.
Without GitHub or Google, the composition supplies no account operations; the routes
still authorize the caller, then return `409 RESOURCE_CONFLICT`.
Logout commits deletion and audit before clearing the cookie. The [authentication reference](../reference/authentication/external-sign-in.md#github-sign-in-for-existing-accounts)
owns configuration, recovery limits, and operator-visible behavior.

### 4. Admit and authorize protected API calls

`ControllerAdmissionVerifier.verifyControllerRequest` requires the configured console Origin for
unsafe session requests before admission. A supplied `Sec-Fetch-Site` must be
`same-origin`. Sign-out applies the same check before revoking the session, and the
GitHub result exchange before reading it; that exchange shares the GitHub admission lane.
Explicit service API keys do not use the cookie origin check, and an invalid key
cannot fall back to a cookie.

`apps/controller/src/index.ts:createFastifyApp` validates the session, resolves
its installation-owned issuer and user ID through the selected IAM Driver, and
authorizes the exact resource through that same Driver. The Driver loads current
policy separately for identity lookup and authorization, so account and
permission changes are visible across controller instances. Missing or invalid
sessions return `401`; denied permissions return `403`; dependency failures fail
closed. Bearer credentials and caller-supplied identity headers are rejected.

### 5. Provision additional accounts

`apps/controller/src/index.ts:createFastifyApp` permits an authorized human
Installation administrator to create another account, with or without GitHub
sign-in. `prepareAccount` validates and hashes the password without writing; the
PostgreSQL composition then calls `provisionPasswordAccount`, which writes the
user, password method, Principal, explicit existing-role binding, enrollment,
and audit in one State transaction, so a failure leaves no partial account.
Nothing is compensated after the transaction. A lost COMMIT reply returns `503`
stating that the outcome is unknown; the account is either complete or absent,
so a deliberate retry with the same email creates it only if the first attempt
did not commit, and otherwise returns `409`.
Account creation issues no session and infers no grants.

## Debugging and Verification

- `node --test tests/integration/native-admin-access.test.mjs` covers trusted and
  untrusted origins on session mutations and sign-out, plus service-key admission.
- `node --test tests/integration/postgres-production-wireup.test.mjs` with
  `OCC_PRODUCTION_WIREUP_DATABASE_URL` proves actual bootstrap, protected random
  password/key delivery, human sign-in, service-key access, and no reissue on rerun.
- `node --test tests/integration/postgres-auth-accounts.test.mjs` with
  `OCC_TEST_DATABASE_URL` covers account provisioning, transactional rollback, and
  a lost provisioning COMMIT reply.
  Its fresh development bootstrap case additionally verifies the service identity,
  protected output, and key access; it skips when an Installation already exists.
- `node --test tests/integration/bootstrap-output.test.mjs` covers exclusive
  output and rejected unsafe paths. Failed writes retain any created file.
  Database cases require the [disposable PostgreSQL setup](../testing/postgresql.md#postgresql-test-environment);
  an unconfigured/skipped suite is not runtime proof.
- `node --test tests/integration/postgres-bootstrap-failures.test.mjs` with
  `OCC_BOOTSTRAP_FAILURE_DATABASE_URL` exercises concurrent production attempts
  and preserves both environment modes' credentials when a test fault discards the
  acknowledgement after a real COMMIT. The suite resets a dedicated loopback
  database; see [its settings](../testing/postgresql.md#postgresql-test-environment).
- Verify copied output is `0600` without printing it; use a key-authenticated
  `GET /installation` and Namespace create/read to check current authority.
  A `401` indicates credential rejection; `403` indicates identity/scope/policy
  denial. Preserve failed bootstrap artifacts and compare safe IDs through
  [operator recovery](../guides/deploy/service-keys.md#recover-an-incomplete-bootstrap).
- `pnpm typecheck`, `pnpm format:check`, and `pnpm check:workspace` validate source
  and workspace structure. Compose/PVC permission checks require real runtime
  execution; chart rendering alone does not prove storage access.

## Related docs

- [Authentication](../reference/authentication.md)
- [Configuration reference](../reference/settings.md)
- [IAM](../reference/authorization.md)
- [Platform startup flow](platform-startup.md)
- [Docker Compose development](docker-compose-development.md) and [production startup](production-startup.md)
- [Service API keys](service-api-keys.md)
- [Bootstrap specification](../../specs/plans/16-bootstrap-admin-service-account/index.md)
- [Feature spec](../../specs/.archive/10-local-password-authentication.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-01 14:36: Bind result receipts to provider instances. (authoring-run/afd78df4-12de-4f41-b2df-7ebb53ed3213 - f22a584e6ce21d505b40a72fdb5ae1c6e74c1c84)

- 2026-09-30 20:57: Receive landed PR751 while preserving bounded device proofs and both documentation histories. (authoring-run/b38fdf7a-4e45-40ac-a7d7-7da3aa8e0070 - 0e59bf4479aabfa0d00c6940c55be760fa19a200)

- 2026-09-30 20:28: Receive bounded device proofs and clarify audit-failure accounting and cookie delivery. (authoring-run/b84d8248-fb41-44b3-8ed5-30d7fd777926 - 2702a01c6c2136cf9fb5b6808d3972379158f2ff)

- 2026-09-30 20:12: Qualify audit-failure session cleanup and tracked-budget accounting. (authoring-run/d58e793e-df0f-40de-8f08-5d0ee989927a - d7b2e4c0697ace45cf2d4b3ab630ce3976334a16)

- 2026-09-30 17:01: Bound fresh device proofs without reopening spent allowances. (authoring-run/bc25e670-bfac-4568-9e6d-d0104391ed45 - 6b43652ca0792ca1a4be0f8bc628f62c1f72fe17)

- 2026-09-30 12:00: Trace the password-only refusal of account and recovery routes. (fix/dogfood-2)

- 2026-09-30 01:03: Receive the PostgreSQL binding and independent schema views. (authoring-run/f1ccd2eb-7d83-40d8-9fe1-c79672f9f98f - f2c9f98b0b89762cc9edda189c102ed8c593c678)

- 2026-09-28 04:00: Trace the GitHub attempt receipt, result exchange, and `x-occ-session-key` narrowing in the accompanying source change. (feat/github-session-binding-20260928)

- 2026-09-26 21:09: Trace origin checks for cookie-authenticated mutations and sign-out. (authoring-run/6d7cf57f-03f3-4ea7-8694-38edd9f3c9c2 - 849b2b24111fe237b12da5be1d4b411d3146cefb)

[Bootstrap and human authentication documentation history](local-password-authentication/history.md) preserves the older dated entries.
