# Feature Spec: Local Email and Password Authentication

**Date:** 2026-08-24
**Status:** Completed
**Owner:** OCC controller, installation bootstrap, and native IAM

## Problem and Decision

The controller currently authenticates one bearer-token Principal instead of separate human users.
Replace development and production controller/API bearer authentication with Better Auth email/password
authentication and revocable sessions. Installation bootstrap creates the first administrator with a
securely generated random password. Better Auth owns credentials and sessions; the selected `IAMDriver`
continues to own identity lookup and exact-resource authorization.

## Scope

**Changes**

- Backend-only email/password sign-in, sign-out, persisted revocable sessions, and protected API access.
- Installation bootstrap of the first administrator, its random initial password, and existing IAM binding.
- Administrator-authorized backend creation of additional accounts and explicit existing IAM bindings.
- User sessions replace every development and production controller/API bearer-authentication path.

**Does not change**

- Installation and Namespace ownership, selected `IAMDriver`, exact-resource authorization, attributable
  audit, development loopback restrictions, private production networking, or workload isolation.
- Internal Agent/app-server WebSocket capability tokens are workload transport, not controller/API user
  authentication, and remain unchanged.
- No login UI, public signup, OIDC, API-key authentication, bearer compatibility, password recovery,
  new auth Driver, or Better Auth-owned platform authorization. OIDC and API keys remain deferred.

## Contract

### Authentication and authorization boundaries

Better Auth validates email/password credentials and issues an opaque, revocable session cookie. The
controller exposes only the supported backend sign-in, sign-out, and session capabilities; public
signup is disabled. Human and programmatic API clients use the same verified session mechanism.

For each protected request, resolve the user session's stable Better Auth user ID and installation-owned
issuer through the selected [`IAMDriver`](../../packages/contracts/src/index.ts), then authorize the
exact server-owned resource through that same driver. Email is not the authorization identity. OCC
continues to own Principals, roles, bindings, and audit attribution; authentication never creates
implicit permissions or replaces IAM authorization.

Missing, expired, revoked, forged, or bearer-only credentials are rejected as unauthenticated. Unknown
identities, absent bindings, denied operations, and cross-Namespace access are denied. Authentication
or IAM dependency failure fails closed. Successful mutation and denied-operation audit remains actor-
attributed without recording passwords, session values, or authentication secrets.

### Administrator bootstrap and account provisioning

The existing [installation bootstrap](../../scripts/bootstrap-production.mjs) creates exactly one first
administrator using the configured email and a cryptographically generated random initial password.
It creates the matching installation-scoped Principal and existing administrator role binding, using
the Better Auth user ID as the Principal subject. Repeated bootstrap must not silently create a second
first administrator or replace an existing credential.

Deliver the initial password exactly once to an explicitly configured, operator-controlled output
file created with owner-only permissions. Bootstrap fails if the path is missing, already exists, or
cannot be protected. Kubernetes operators provide the writable storage mounted at that path; the
platform does not create credential Secrets, storage resources, or additional RBAC. Never place the
password in logs, audit records, normal API responses, or tracked configuration; credential
persistence stores a password verifier, not the plaintext password.

After bootstrap, only a session Principal authorized to administer the exact Installation can create
additional accounts through an OCC-owned backend capability. Create the Better Auth account and its
explicit installation-scoped IAM Principal/binding; never grant an implicit default role. Reject
unauthenticated callers, nonadministrators, duplicate accounts, invalid bindings, and public signup.

### Session security

Use the existing PostgreSQL-backed persistence and the configuration needed for durable, revocable
user sessions. Session cookies must be HTTP-only, appropriately same-site protected, and secure
in production. Sign-out revokes the session. Authentication secrets must remain protected; never trust
caller-supplied identity headers or fall back to development or production bearer authentication.

## Implementation

1. Integrate Better Auth and its required PostgreSQL-backed user, credential, and session persistence
   in the [controller](../../apps/controller/src) and existing [OCC persistence](../../packages/occ/src/state).
   Enable only backend email/password sign-in, sign-out, session handling, and supported server-side
   account creation; disable public signup.
2. Replace controller [admission](../../apps/controller/src/admission) and
   [composition](../../apps/controller/src/composition) bearer checks with verified user sessions,
   installation-owned issuer/user-ID identity lookup, and existing selected-driver IAM authorization.
3. Extend [installation bootstrap](../../scripts/bootstrap-production.mjs) to create the randomly generated
   first administrator, protected credential delivery, and existing administrator Principal/binding.
   Add one administrator-authorized backend capability for additional explicitly bound accounts.
4. Remove development and production controller/API bearer settings, admission, OpenAPI security,
   examples, and packaging; retain unrelated internal Agent/app-server transport capability tokens.
   Update the [API reference](../../docs/reference/api.md), [configuration](../../docs/reference/settings.md), and
   [deployment guide](../../docs/guides/deploy.md) to describe the supported session workflow.

## Verification

| Required outcome                                     | How to verify                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One first administrator can authenticate immediately | Run actual installation bootstrap against PostgreSQL; verify the administrator account, securely generated password in its protected output file, matching IAM binding, successful Better Auth sign-in, and cookie-authenticated `GET /installation`. Verify no plaintext appears in logs or audit. |
| Real password sign-in and revocable sessions         | Exercise actual controller sign-in, protected API access, and sign-out; verify wrong-password rejection, authenticated session access, and rejection after revocation.                                                                                                                              |
| Administrator-controlled additional accounts         | Use the actual backend provisioning capability as an administrator and nonadministrator; verify explicit IAM binding, subsequent sign-in, nonadministrator rejection, and disabled public signup.                                                                                                   |
| IAM remains authoritative                            | Use separately bound accounts to verify allowed exact-resource access, denied missing bindings, rejected cross-Namespace access, and actor-attributed audit.                                                                                                                                        |
| Controller/API bearer authentication is removed      | Reject former development and production bearer credentials, remove bearer security documentation/configuration, and preserve unrelated internal Agent/app-server transport tokens.                                                                                                                 |
| Session and dependency failures fail closed          | Verify protected cookie settings, invalid or revoked session rejection, and denial when authentication or the selected IAM driver is unavailable.                                                                                                                                                   |

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-24 12:00]: Specify backend-only user sessions established through email/password sign-in, generated bootstrap administrator credentials, explicit IAM ownership, and complete bearer removal. (01a03507-d209-7ca0-83ce-e93bfca3b97d - 2e9769c)
- [2026-08-24 12:16]: Simplify bootstrap delivery, session integration, IAM-owned account provisioning, and controller bearer removal while preserving internal transport tokens. (01a0352c-debe-73b1-baa6-379855af874f - 2e9769c)
- [2026-08-24 12:39]: Define protected bootstrap credential handoff and require real bootstrap-to-authenticated-installation integration proof. (01a0352c-debe-73b1-baa6-379855af874f - 2e9769c)
- [2026-08-24 13:49]: Complete user sessions, protected administrator bootstrap, explicit-role account provisioning, atomic IAM audit, and real PostgreSQL integration proof. (01a0352c-debe-73b1-baa6-379855af874f - 3b349dd)
