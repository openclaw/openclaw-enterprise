# Feature Spec: Service API keys

**Date:** 2026-08-28
**Status:** Implementation complete
**Owner:** OCC authentication and IAM
**Current reference:** [Authentication](../../docs/reference/authentication/service-api-keys.md#service-api-keys)

## Completion record

Implemented and independently verified in PR #42.
The final runtime source at `1a6d2ef0d988ff0ca3673549cece1d71c1c22357` passes
54 focused HTTP/API/IAM tests plus the real PostgreSQL lifecycle proof, with no
skips; TypeScript, generated API, formatting, workspace, and documentation
checks pass. CI is not configured in this repository, and the requested Slack
notice was not delivered because its local prerequisites are unavailable.
Those delivery limitations are not claims of failed product behavior or green
CI. The current authentication reference above owns supported behavior; the
original proposal and its delivery targets below remain historical.

## 2026-08-28 amendment: IAM-authorized service administrators

Kevin approved removing the human-only restriction on service-key issuance
and revocation. These operations accept a human session or an existing
Installation-scoped non-Agent service API key, with current IAM `administer`
on the singleton Installation required for either caller. Authorized automation
can issue and revoke keys for itself or another eligible principal in that
Installation, including implementing rotation through issue, switch, and revoke.
No rotation daemon is introduced.

The [authentication reference](../../docs/reference/authentication/service-api-keys.md#service-api-keys)
owns the current contract. Account creation and bootstrap remain restricted to
human sessions; Namespace containment, Agent exclusion, explicit-key precedence,
current IAM policy, and revocation/audit behavior are unchanged. Focused HTTP
verification must cover authorized service management, missing or removed
grants, Namespace denial, invalid or revoked management keys, and audit
attribution to the service administrator.

The original decisions and verification plan below are retained as delivery
history. Their human-only key-management restriction is superseded by this
amendment, not current guidance.

## Problem and Decision

Non-Agent automation needs a revocable controller credential without borrowing
human sessions. Use Better Auth's supported API-key plugin to authenticate an
existing IAM ServicePrincipal, then retain the selected IAM Driver's exact
resource authorization. This spec records the settled task contract and the
implementation already reviewed in this task; the remaining milestone is PR
delivery with independent verification.

The [platform design](../../docs/design/access.md#iam-and-authority) remains authoritative
for identities and authorization. This task supplies the previously deferred
controller API-key authentication mechanism. It does not implement future OAG
admission or the separate Agent workload identity exchange.

## Scope

**Changes**

- Human-administrator key issuance and revocation.
- Service-key admission through the existing controller request pipeline.
- Better Auth PostgreSQL persistence and native IAM by-ID identity lookup.
- Focused HTTP/security and real PostgreSQL proof, plus API/auth documentation.

**Does not change**

- Human sign-in/session behavior, IAM permissions/Restrictions, or tenant scope.
- Agent-owned identities and their workload-bound authentication requirement.
- IAM provisioning, key inventory/edit APIs, automatic rotation, or provider
  credentials managed by ServiceAccount Drivers.
- Production deployments, operational credentials, or unrelated checkout edits.

## Contract

A service key belongs to exactly one existing non-Agent ServicePrincipal. That
principal belongs to the singleton Installation or one Namespace. Multiple
keys can reference the same principal for manual rotation. Better Auth owns
key material, hashing, expiration, and the plugin record; IAM owns identities,
Roles, AccessBindings, Restrictions, and all authorization decisions.

Issuance requires a human session with `administer` on the Installation. OCC
resolves the requested principal through the selected IAM Driver and checks
its exact scope and non-Agent ownership. It does not create an identity or
grant. The credential snapshots the Installation and optional Namespace at
issuance; current identity scope must still match that snapshot on every use.

`POST /api/auth/service-keys` returns the plaintext credential once, alongside
the non-secret ID needed for revocation. The exact request fields and lifetime
limits are owned by the [API reference](../../docs/reference/api.md) and
[authentication reference](../../docs/reference/authentication/service-api-keys.md#service-api-keys). Credentials
must not enter audit evidence or ordinary logs. If issuance audit persistence
fails, OCC returns no credential and attempts to remove the unreturned key.

A supplied `x-api-key` selects Better Auth verification before cookie handling.
An invalid key cannot fall back to an accompanying administrator session.
Successful verification resolves the existing service identity through IAM;
OCC still authorizes the exact action/resource with current policy. Namespace
keys cannot call Installation-level operations or another Namespace. An
Installation key needs an explicit grant for every requested operation.

Keys cannot bootstrap, create human accounts, or manage other keys. Human
sessions remain the management credential. Public plugin management endpoints,
sessions-from-keys, and bearer-token compatibility remain disabled.

`DELETE /api/auth/service-keys/:keyId` requires the same human Installation
administrator authority. It deletes the Better Auth record and records the
actor and non-secret key/principal IDs. Ordinary concurrent verification
updates cannot recreate the deleted row. Subsequent requests fail across
instances; an already authorized request may finish. Revocation does not
delete IAM policy, and an audit failure cannot restore a deleted credential.

Missing/invalid/expired/revoked credentials return `401`; a verified caller
without the matching identity, scope, or exact IAM grant returns `403`.
Unavailable required dependencies fail closed. Rotation is issue, switch the
client, then revoke the old key. No extra daemon, cache, or authorization store
is needed.

## Implementation

1. **Authentication and storage:** configure the pinned Better Auth plugin in
   [the shared auth factory](../../apps/controller/src/auth/index.ts). Use its
   supported server calls/adapter and [plugin schema](../../packages/occ/src/state/postgres-schema.ts)
   with [SQL persistence](../../migrations/0012_service_api_keys.sql).
2. **Identity and request authorization:** extend the existing IAM lookup
   contract for a verified service-principal ID; use the same native policy
   evaluation and controller resource authorization. Keep the shared
   Installation-admin check for bootstrap, account provisioning, and keys in
   [the controller](../../apps/controller/src/index.ts).
3. **Delivery:** retain meaningful HTTP and PostgreSQL tests, generated API
   artifacts, [authentication](../../docs/reference/authentication.md) and
   [authorization](../../docs/reference/authorization.md) references, and the shared
   [deployment guide](../../docs/guides/deploy/service-keys.md#service-api-keys-for-automation). Run disjoint code,
   simplification, documentation, and dead-code reviews before independent
   verification. Document the primary runtime path in a validated flow doc,
   then publish a ready PR and verify its current-head checks.

The implementation and test-quality cleanup were completed before this delivery
spec. A fresh one-pass spec review confirms that the recorded contract and
remaining delivery work are complete before further implementation changes.

## Verification

| Required outcome                                             | Proof and boundary                                                                                                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid key performs only a granted operation                  | `tests/integration/service-api-keys.test.mjs`: real Fastify HTTP, Better Auth, OCC and native IAM.                                                                                                    |
| Invalid/revoked key cannot use an accompanying human session | Same HTTP suite: blank, forged, tampered, expired and revoked credentials; human session still works independently.                                                                                   |
| Unauthorized and cross-Namespace calls fail                  | Same HTTP suite: exact grants, live binding removal, Restrictions, Namespace/Installation containment, human-only management and Agent exclusion.                                                     |
| Identity lookup is correct                                   | `tests/conformance/iam.test.mjs`.                                                                                                                                                                     |
| Persistent keys are hashed and revocation crosses instances  | `tests/integration/postgres-service-api-keys.test.mjs`: real PostgreSQL 18.6, official adapter, limited application role, foreign Installation rejection and concurrent verification during deletion. |
| Existing auth/API behavior remains supported                 | `tests/conformance/occ-api-security.test.mjs` and `tests/integration/occ-api.test.mjs`.                                                                                                               |
| Source/artifacts are consistent                              | TypeScript build, formatting, `openapi:check`, workspace-boundary check, and source equality with the dependency-compatible verifier copy.                                                            |
| Delivery is ready for review                                 | Scoped ready PR, current-head CI green, actionable review findings resolved, requested Slack alert delivered.                                                                                         |

Run the listed focused files with `node --test <file-path>`. For the persistent
case, set `OCC_TEST_DATABASE_URL` to the limited application-role connection
and run `node --test tests/integration/postgres-service-api-keys.test.mjs`; use
the existing [PostgreSQL test environment](../../docs/testing/postgresql.md#postgresql-test-environment)
instructions.

Use the existing isolated dependency-compatible verification copy. The original
checkout's dependency tree stays untouched. The PostgreSQL case requires a
dedicated disposable database, migrations through the limited migrator role,
and tests through the application role; remove only task-owned test resources.
No gateway, model credential, or Kubernetes runtime is needed for this feature.
A skipped test does not satisfy its corresponding required outcome.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-08-31 18:06]: Repaired repository links while preserving historical citations and implementation decisions. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4e16a74272e716d998c6da59fff95fde806d86fa)

- 2026-08-28 20:17: Record Kevin's approved IAM-authorized service-management amendment; preserve the original contract as history. (codex/01a04927-11d8-7083-a4b7-9f3124559d82 - d4b5b01d02cf68a89965f7c00a0fc7d0dcec18d8)

- 2026-08-28 16:52: Recorded the settled service-key contract and remaining swarm delivery gates. (01a04927-11d8-7083-a4b7-9f3124559d82 - ab560806dbd945436835ab092ebd10bf3e50d942)
