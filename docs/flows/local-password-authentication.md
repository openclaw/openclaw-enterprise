---
created: 2026-08-24
updated: "2026-11-18 14:31"
last_updated_session: "authoring-run/71818c11-eeb5-4a34-8231-ea32f513c574"
---

# Bootstrap and human authentication flow

## Overview

Native IAM bootstrap commits Installation administrators and protects credentials.
Human sign-in requires exact IAM authorization.

## Entry Points

- Trigger: `node scripts/bootstrap-installation.mjs` with `NODE_ENV=development`
  or `production`, `POST /api/auth/sign-in/email`, `POST /api/auth/providers/oidc/start`,
  `GET /api/auth/providers/oidc/callback`, the matching `google` routes, or a protected
  controller request.
- Source: [`scripts/bootstrap-installation.mjs`](../../scripts/bootstrap-installation.mjs),
  [`apps/controller/src/auth/index.ts:createControllerAuth`](../../apps/controller/src/auth/index.ts),
  and [`apps/controller/src/index.ts:createFastifyApp`](../../apps/controller/src/index.ts).
- Assumptions: Migrated PostgreSQL, configured Better Auth, native IAM bootstrap,
  protected credential input files, disabled public signup, and exact IAM authorization.
  Fresh development and production initialization require both input paths.

## Flow

```mermaid
graph TD
  subgraph Bootstrap["Shared installation initializer: one attempt"]
    A["Load Installation"] -->|Existing| B["Verify persisted identity; retain credentials"]
    A -->|Fresh| I["Read and validate both supplied credential files"]
    I --> C["Create human and native IAM seed with service administrator"]
    C --> D["Better Auth registers supplied service-key hash"]
    D --> F["Commit Installation, IAM seed, and audit"]
  end
  F --> G["Complete startup"]
  B --> G
  Bootstrap -->|Any error| H["Exit unsuccessfully; preserve tracked artifacts for manual repair"]
  subgraph Request["Human controller request"]
    G --> P["Verify password or external identity"]
    P -->|OIDC enrollment configured| T["Check signed admission; enroll account and grants"]
    T --> Q
    P -->|External profile enabled| Q["State rechecks account, method and recovery eligibility; commits session and audit"]
    Q --> J["Release session cookie"]
    P -->|Password-only profile| J
    Q -->|Disabled, stale proof, or commit failure| R["Reject login; no cookie"]
    J --> N{"Unsafe session request?"}
    N -->|Yes| O["Check console origin and Fetch Metadata"]
    N -->|No| K["Resolve current IAM identity and exact authority"]
    O -->|Trusted| K
    O -->|Rejected| M
    K -->|Other allowed| L["Run and audit OCC operation"]
    K -->|Create account| U["Hold session; recheck selected IAM; commit account"]
    K -->|Invalid session or denied authority| M["Return 401 or 403"]
  end
```

## Execution Trace

### 1. Load state and create the fresh administrator identities

[`scripts/bootstrap-installation.mjs`](../../scripts/bootstrap-installation.mjs)
loads the singleton Installation. Existing Installations, including those predating
service administrators, verify immutable account/IAM identity without reading
inputs, issuing keys or repairing grants. Both paths first check the base URL.
`verifiedWithoutAuth` checks the administrator's `occ."user"` row and IAM Principal
before Better Auth. Success logs `installation.already-bootstrapped` with
`step: "fast-path"`; misses or errors use the full check.

`scripts/lib/bootstrap-credentials.ts:bootstrapCredentials` validates both inputs
before authentication writes, following Secret symlinks under the
[input contract](../reference/authentication.md#installation-and-account-ownership).
Both modes use the supplied password.
`packages/iam/src/index.ts:createBootstrapAdministratorSeed` adds a non-Agent
`spn_<uuid>` without a Namespace, with a separate unrestricted binding to the human's
administrator Role ([exact actions](../reference/authorization.md#supported-policy-surface)).
Additional accounts create no service administrator.

### 2. Register the supplied key, then commit the Installation

[`apps/controller/src/auth/index.ts:registerBootstrapServiceKey`](../../apps/controller/src/auth/index.ts)
uses initializer-only auth and the API-key plugin's supported `customKeyGenerator`.
The plugin hashes and persists the supplied `bootstrap-admin` key with a 30-day
expiry and this Installation's service principal. The database's unique key
constraint rejects duplicate ownership. Auth writes remain outside the OCC
transaction. Uncommitted IAM cannot authorize OCC operations; startup waits for
bootstrap success.

The initializer writes no credential output. Helm projects the precreated Secret
only during install, read-only at `/run/openclaw-bootstrap`; Compose mounts input
files as secrets. Migration, API and worker containers receive neither input.
No plaintext reaches logs, audit or the bootstrap result.

Singleton constraints reject competing Installation/IAM/audit commits. API startup
verifies committed state without `POST /installation/bootstrap`.

Errors record `installation.bootstrap-failed` with available non-secret IDs and
then exit nonzero. Helm sets `backoffLimit: 0`. Tracked accounts and keys
remain for inspection. If password `linkAccount` fails before
`createAccount` returns, the helper attempts to delete the new user and rethrows.
The initializer never automatically revokes, retries, repairs or resets uncertain
or committed state.

[Recovery](../guides/deploy/service-keys.md#recover-an-incomplete-bootstrap)
requires confirming transaction completion and exact attempt IDs; source files
cannot prove commit or rotate credentials. Identify the disposable Installation
and storage before reset. Retain confirmed attempt IDs.
[Service-key management](service-api-keys.md) covers replacement and revocation.

### 3. Construct session authentication

`apps/controller/src/auth/index.ts:createPostgresControllerAuth` uses OCC's
[public binding](../reference/postgres-auth-binding.md#composition) for the
caller-owned pool, full schema, construction failures, and adapter settings.

`apps/controller/src/auth/index.ts:createControllerAuth` configures Better Auth
password authentication, protected cookies, and PostgreSQL storage. Sign-in
returns `{ authenticated: true }` and keeps the token in an HttpOnly cookie.
`safeSessionResponse` returns public identity and `sessionKey`, an auth-secret HMAC
of the session ID (`apps/controller/src/auth/session-binding.ts`). The
[Console](platform-console.md#2-resolve-the-session-before-private-reads) clears
retained views and drafts when the key changes.
`apps/controller/src/auth/password-sign-out.ts:passwordSignOut` deletes the
password-only session through the selected database adapter before clearing its
cookie. Storage failure returns `503` and leaves the cookie intact for retry after recovery.
`auth/admission.ts:passwordFailureAdmission` counts failures. Fast success clears
only the selected identity's count. `onLimited` reports
`authentication.sign-in-limited` once per lane/window. `auth/known-device.ts`
checks the email-bound MAC before rate- and concurrency-limited password-state
reads (see [known devices](../reference/authentication.md#known-devices)).
Verified bindings select the device lane. Rejected bindings use the shared lane.
After failed or refused reads, signed keys still constrain email and address.
Password-only admission captures issuance state before credentials so resets
invalidate stale state. Success may reissue it. With password-only PostgreSQL State,
`passwordSignInAudit` attempts `authentication.login`. If that audit fails, it
attempts session deletion and returns `503` without a cookie.
`DenialAuditUnavailable` counts as a credential failure, as does
`PASSWORD_DENIAL_AUDIT_UNAVAILABLE` from guarded `/oce/password`. See
[audit fields, statuses, and unconfirmed outcomes](../reference/authentication.md#session-lifecycle).
Better Auth logs only errors, so wrong passwords produce no unstructured console warning.

`requireSessionKey` checks optional `x-occ-session-key` after cookie resolution in
`ControllerAdmissionVerifier.verify`, `session`, `resolveSession`, and `signOut`.
Malformed, duplicated or foreign keys return `401` without revoking the session
or clearing its cookie. The header only narrows the cookie-selected session.
The native admin proxy strips it upstream.

For `GET /api/auth/session`, `apps/controller/src/auth/index.ts:session` omits
Better Auth's cookie headers. A late invalid-session response preserves a newer
sign-in cookie.

When external sign-in is configured, `apps/controller/src/auth/human-login.ts:createHumanLogin`
provides password, provider, and logout endpoints through a guarded Better Auth adapter.
`packages/occ/src/state/human-authentication.ts:PostgresHumanAuthentication` owns
account and method checks and the State transaction. With `recovery-only`,
`snapshotPassword` reads a credential only for the durable recovery holder.
Password verification finishes before `issueSession` starts its `READ COMMITTED`
transaction. That transaction takes the Installation recovery advisory lock before
user locks, compares the proof's user, Principal and method with the current
designation, then rechecks account and credential versions. It holds the lock
through session, binding and success-audit commit. If replacement commits first,
the former holder receives an audited `401` for bad credentials. If session
creation commits first, that session survives the move. Lock failure or uncertain
`COMMIT` returns `503` without a cookie or session key. Admission reads the durable
holder for the reserved password lane. Session reads still
check account, method, version and Principal; sessions expire after eight hours
without refresh. HTTPS uses the [shared session cookie](../reference/authentication.md#native-admin-shared-sessions);
session reads and logout reject duplicates.

OIDC start reaches `auth/human-login.ts:oidcProvider`. It binds the five-minute
attempt to the provider instance, client-secret digest, and enrollment-policy
digest; `createPostgresControllerAuth` resolves default Groups first. The attempt
stores state and browser-secret digests, callback, and PKCE verifier. A host-only
HttpOnly cookie binds the browser. Callback consumption commits before exchange;
invalid or consumed attempts cannot exchange codes.

`auth/oidc.ts:oidcLoginConfiguration` pins the selected HTTPS endpoints.
`exchangeOidcSubject` sends client authentication only to the token URL, fetches
the selected JWKS, and checks the issuer exactly;
`auth/provider-transport.ts:providerJSON` refuses redirects.

`apps/controller/src/auth/oidc.ts:exchangeOidcSubject` verifies the ID token and,
when configured, its admission claim. One string is one group. Arrays require
strings only. Matching is exact and case-sensitive, with no trimming or comma
splitting. Missing, malformed or unmatched claims fail before account lookup.
Signed `sub` selects the identity. Only eligible unknown identities reach
[enrollment profile checks](#6-enroll-an-oidc-identity). No provider token enters State.

The signed login receipt binds provider, session and attempt. The Console
[consumes it once](../reference/authentication/external-sign-in.md) with the
matching origin and session cookie.

Google reuses `auth/human-login.ts:externalProviderEndpoints`.
`apps/controller/src/auth/google.ts:exchangeGoogleSubject` verifies its ID token,
including `hd` and `email_verified` for allowed domains, and returns `sub` without
applying OIDC enrollment policy.

`apps/controller/src/auth/client-address.ts:clientAddressConfiguration` canonicalizes
IPv4-mapped addresses before prefix validation, refusing entries covering every
IPv4 or IPv6 address. `resolveClientAddress` uses dotted IPv4 for mapped peers and
header hops.

Password admission validates email before known-device or State reads.
Each profile owns its refusal audit. See [errors and failure accounting](../reference/authentication.md#session-lifecycle).
Google and OIDC share process-local rate and concurrency limits for start,
callback and result admission (`keyedAdmission`). The key is the client address
behind trusted proxies or the browser cookie otherwise. Provider HTTP shares a
deadline and response-byte cap. State limits pending attempts and expired cleanup,
and stores attempt and session deadlines. Cookie Max-Age subtracts monotonic
elapsed time. Expired completion releases no cookie.

`scripts/auth-maintain.ts` calls
`scripts/lib/auth-maintain-arguments.ts:parseAuthMaintainArguments` before
configuration or database access. Undeclared commands, including inherited object
properties, exit `64` with usage. See [maintenance commands and exit codes](../guides/deploy/auth-maintenance.md).

Stop admission, drain or terminate requests, and stop old controllers before
activation. Startup leaves live readers unfenced. Both PostgreSQL compositions
reject Google with native administration. OIDC permits shared-cookie or host-only exchange.
`apps/controller/src/auth/index.ts:createPostgresControllerAuth` checks the secret,
canonical origin and profile before activation. Invalid configuration leaves
sessions, enrollment and recovery designation unchanged.
On first activation, `PostgresHumanAuthentication.activateRecovery` enrolls
qualifying password users with their Principals and reports skipped users, who
cannot sign in until repaired. It requires a usable selected recovery
administrator, then designates that account and removes unbound historical
sessions in one State transaction before serving. See the
[deployment procedure](../guides/deploy/production-installation.md#enable-external-browser-sign-in).

`apps/controller/src/index.ts:humanAccountActor` requires a current human session,
Native IAM Installation `administer`, and the configured `Origin`. For a GET without
`Origin`, it requires the configured Console `Host` and same-origin browser Fetch
Metadata. Reads return current state, not prior-operation receipts. The [session and recovery controls](../reference/authentication/external-sign-in.md#session-and-recovery-controls)
define the headers. Authorized calls without an external provider return `409 RESOURCE_CONFLICT`.

State locks actor and target to check `expectedVersion`. After method or recovery
locks, `human-authentication.ts:guardAuthority` holds six IAM tables through commit
(`0073_account_administration_policy.sql`), rechecks IAM through the actor
callback, then rechecks the session. `READ COMMITTED` sees grant changes during
waits. `NOWAIT` contention returns retryable `503`. HTTP audits after denial rollback.
Attaching, disabling or revoking advances the account version and ends target sessions
and proofs. IAM grants persist. Unknown outcomes return a dependency failure.
Resolve them before another action, without replay or compensation.
Logout commits deletion and audit before clearing the cookie.

### 4. Admit and authorize protected API calls

`ControllerAdmissionVerifier.verifyControllerRequest` checks
[browser origin](../reference/authentication.md#browser-request-origin) before
admitting unsafe session requests, including before sign-out revokes the session
and before the external admission lane reads a result for exchange. Explicit service
API keys skip the check and never fall back to a cookie.

`apps/controller/src/index.ts:createFastifyApp` validates the session. The selected
IAM Driver resolves its Installation-owned issuer/user ID and authorizes the exact
resource. Lookup and authorization read current policy separately, exposing
account and permission changes across controllers. Missing or invalid sessions
return `401`. Permission denials return `403`. Dependency failures fail closed.
The controller rejects bearer credentials and caller-supplied identity headers.

### 5. Provision additional accounts

After [admission and throttling](../reference/authentication.md#account-provisioning)
and password hashing, `apps/controller/src/auth/index.ts:createPostgresAuthAccountProvisioner`
holds the original session, shared IAM configuration, and Native IAM
account-administration policy, in order, through the original State
`READ COMMITTED` commit. The originally selected IAM Driver rechecks
`administer` on the same Installation. State revalidates the requested Role and atomically writes the
account, password method, Principal, grants, enrollment, and final success audit.
Earlier session revocation, expiry by `COMMIT`, or a denied final IAM decision
rolls back creation. With Native IAM, a policy withdrawal that commits first is
visible to that decision.
Sign-out waits for the session lock. Lost `COMMIT` replies return `503` with
unknown outcome. Never compensate or replay.

### 6. Enroll an OIDC identity

`auth/oidc-enrollment.ts:oidcEnrollmentPolicy` validates and canonicalizes policy.
`resolveOidcEnrollmentPolicy` fills default Groups and
fingerprints the policy once, including resolved `createAccount.requireVerifiedEmail`.
Composition applies configured IAM before checking Role, Namespace and Group references.
`auth/oidc.ts:oidcEnrollmentProfile` validates email and enforces the verification
policy. It refuses non-boolean verification claims. With `requireVerifiedEmail: false`,
absent or false verification yields `emailVerified: false`. The callback uses
the profile only for creation. Existing identities keep their saved profile.

`snapshotExternal` distinguishes missing identities from refused existing ones.
Creation requires a missing identity and valid profile. The callback hashes a random
password and asks native IAM for the configured initial binding or no direct grant.

`packages/occ/src/state/human-authentication.ts:PostgresHumanAuthentication.enrollExternal`
serializes by provider and subject, holds the shared IAM configuration lock,
validates references and resolves the identity again. Existing identities retain
attempt-currentness and disabled-status checks; new identities reuse
`insertPasswordAccount`. Only the inserting transaction can snapshot new methods
without an older attempt timestamp. State writes the actual verification boolean
to `email_verified`. Account, Principal, external method, initial Role binding,
Group memberships and audits commit together. Existing accounts receive only
missing Group memberships. The session transaction rechecks the proof before
issuing its cookie.

## Debugging and Verification

- `tests/integration/postgres-auth-account-session.test.ts` covers provisioning
  races and uncertain commits in the `postgres-auth` lane.
- `node --test tests/integration/postgres-oidc-enrollment.test.ts` exercises
  production authentication, PostgreSQL and IAM through the Agent API.
  OIDC and Compute fixtures leave provider registration and model execution unverified. `oidc-agent-chat` uses real Keycloak, a deployed
  Agent and a model reply.
- `node --test tests/integration/native-admin-access.test.mjs` covers trusted and
  untrusted origins on session mutations and sign-out, plus service-key admission.
- `postgres-production-wireup.test.ts` with `OCC_PRODUCTION_WIREUP_DATABASE_URL`
  covers bootstrap, human/service access and no reissue.
- `postgres-auth-accounts.test.ts` with `OCC_TEST_DATABASE_URL` covers provisioning,
  rollback, lost COMMIT replies and password-only logout under contention. Its
  fresh-bootstrap case verifies service identity and access, skipping existing Installations.
- `tests/integration/bootstrap-credentials.test.ts` covers local parsing,
  symlinks, spaces and invalid inputs, not Kubernetes or persistence. Database
  cases require [disposable PostgreSQL](../testing/postgresql.md#postgresql-test-environment);
  skipped suites provide no runtime proof.
- `postgres-bootstrap-failures.test.ts` with `OCC_BOOTSTRAP_FAILURE_DATABASE_URL`
  uses a dedicated loopback database for concurrent production bootstrap,
  credential preservation after lost COMMIT acknowledgement in both modes, and
  fast/full-path selection.
- Verify retained host credentials are private without printing them; use a key-authenticated
  `GET /installation` and Namespace create/read to check current authority.
  A `401` indicates credential rejection; `403` indicates identity/scope/policy
  denial. For a failed bootstrap, follow
  [operator recovery](../guides/deploy/service-keys.md#recover-an-incomplete-bootstrap).
- `postgres-oidc-recovery-replacement.test.ts` uses real routes to exercise
  recovery-only sign-in, both session/replacement lock orders, retained sessions
  and lost COMMIT replies. The two-controller fixture checks the State invariant
  only. Production multi-controller qualification is separate.
- `pnpm typecheck`, `pnpm format:check`, and `pnpm check:workspace` check source/workspace
  structure. Only real Compose/Kubernetes execution proves input access; chart rendering does not.

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

- 2026-11-18 14:31: Compose recovery, OIDC transport and account-read traces. (authoring-run/71818c11-eeb5-4a34-8231-ea32f513c574 - 0cdebc5eda71caeb08b5036d15655a1f23f23903)
- 2026-11-18 09:44: Trace same-origin browser reads of account and recovery state. (authoring-run/05059b24-93d6-4c07-b659-2d0b084a3070 - 43194d2b141b43d5da490c21661c85a91662ec83)

- 2026-11-18 06:03: Trace OIDC endpoint routing. (authoring-run/9be587a9-79fa-49ca-9b7c-c0a743b5a058 - d8d985bc57d5d6861f244bac8b3f18d070658ca2)

- 2026-11-18 07:50: Condense the bootstrap and authentication trace. (authoring-run/ecdff9cc-850a-496d-a883-2485233e72ab - 4657570be473fd721dc059021d0f6dda1f9451eb)
- 2026-11-18 03:10: Order recovery-only password-session creation with online replacement. (authoring-run/99c6c84d-1684-4d25-9675-3414cb6273cf - 4657570be473fd721dc059021d0f6dda1f9451eb)

- 2026-11-16 09:42: Align verification pointers with supplied-input parsing; no runtime suites run for this documentation pass. (authoring-run/e8039d10-1e3b-41aa-82f2-0d2c709b421f - 81ab0a9fbe38cd2eea88f599a5e0ac9aad9c4f92)

- 2026-11-16 09:39: Trace supplied bootstrap inputs and server-only key registration in the accompanying changes. (pi/01a1e4f4-3138-71b5-b224-7ecf7ed57406 - 81ab0a9fbe38cd2eea88f599a5e0ac9aad9c4f92)

- 2026-11-12 09:36: Clarify the Native IAM account-creation guarantee. (authoring-run/a948a3cb-f16f-4bfd-bcb8-6dcebafc7e37 - affc6f39cf54a1da65b7f1121c83fb74f55c433e)
- 2026-11-12 09:25: Retain account authority through commit. (authoring-run/276118f6-2838-4088-8f68-2deba06ca89d - affc6f39cf54a1da65b7f1121c83fb74f55c433e)

- 2026-11-11 10:23: Document exact scalar group admission and creation-only email verification policy. (authoring-run/4ed1deac-0365-4912-90fb-946108b6abaa - 1fefb0644)

- 2026-11-11 09:25: Document how a session check preserves a newer browser cookie. (authoring-run/020599f2-46fb-4eca-94b0-53f51af3deca - f0b9c002c0577bcc8854913b0eafa5449bd5fbe3)

- 2026-11-09 16:10: Trace startup policy resolution and the single external identity lookup. (authoring-run/17c43ed1-f4cd-439d-adb5-d2532f4e7755 - 65aa5bd78)

- 2026-11-09 15:02: Trace OIDC admission, initial grants and native GitHub retirement in the accompanying changes. (authoring-run/fa345547-f102-4631-804e-25fc90a46621 - daecab29c452af39945f5526257288771a77bdfc)

- 2026-11-06 19:16: Preserve team enrollment and host-only browser access; trace configured account memberships. (authoring-run/58e06c73-4f86-4a03-b654-b9af9a6429d1 - 491908448534fbcee539aac386180fbf9268d59b)

- 2026-11-06 08:56: Document host-only GitHub native administration. (authoring-run/2205da1f-3410-4bcb-9697-f2bbb5ebc49a - 4d7abb4a7f48c9dddf19afe87bbedfa1807a5749)

- 2026-11-06 02:07: Trace opt-in GitHub team enrollment and transactional identity creation. (authoring-run/8d231212-5a96-46b9-8dee-2eac79700e32 - 201eed939abe18e2d522f2b2ead5047626ade755)

- 2026-11-04 11:22: Record durable password-only session revocation and storage failure handling. (authoring-run/d3b76aba-07fb-422b-b0fd-f5957926b7b8 - 0c7126dc16df1a01e2242e9bd35f9e742d6cee56)

- 2026-10-15 18:55: Record verified GitHub identity and correlate matched sign-in attempts in audit. (authoring-run/b841a0a4-490b-486f-ab3c-2074d75f0ee6 - aad21c63837ef24f9f9bae152877812abe9b1abd)

- 2026-10-10 20:56: Reject unstorable email before State reads while preserving denial audits and admission. (authoring-run/6a102658-a68a-460f-bb67-be99a2490d8d - f6526eed518b689cc99e70f2c8ad349c500e936d)

[Bootstrap and human authentication documentation history](local-password-authentication/history.md) preserves older entries.
