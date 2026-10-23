---
created: "2026-09-20"
updated: 2026-10-15
last_updated_session: "authoring-run/ec3b3e9d-0724-4b9e-a41d-4eb8a44d4851"
---

# Namespace IAM Policy Flow

## Overview

Namespace IAM policy management begins when an authenticated caller uses the OCC
API or CLI to list, create, read, or delete a Namespace Role or exact
AccessBinding, or to list, create, or read a Namespace ServicePrincipal. OCC authorizes the administrator, validates that the policy entry
belongs to the requested Namespace, and delegates the policy mutation to the
selected IAM Driver. The flow stops after the policy and audit event commit
together in the platform state transaction.

## Entry Points

- Trigger: `GET`, `POST`, or `DELETE` under `/namespaces/:namespaceId/iam/*`
- Source: `packages/contracts/src/api/routes.ts:occApiRoutes`
- Source: `apps/controller/src/index.ts:requiredPermissions`
- Source: `apps/controller/src/http/iam.ts:iamHandlers`
- Assumptions: the caller is admitted to the Installation, the selected IAM
  Driver implements Namespace policy management, and the requested Namespace
  already exists.

## Flow

```mermaid
graph TD
  A["Caller invokes Namespace IAM route"] --> B["OCC admits identity and required permissions"]
  B --> C{"Read or mutation?"}
  C -->|read| D["Controller asks selected IAM Driver to read Namespace policy"]
  C -->|create/delete| S{"Human-session caller?"}
  S -->|yes| L{"Assigning session current?"}
  L -->|yes, held through transaction| E["Controller validates Role, subject, and exact target"]
  L -->|revoked or expired| X["Roll back and deny"]
  S -->|no| E
  E --> T{"IAM Driver joins transaction?"}
  T -->|yes| F["Selected IAM Driver mutates platform IAM policy"]
  T -->|no| U["Reject with 503 before policy write"]
  F --> G["Controller appends audit event in the same transaction"]
  D --> H["API returns policy metadata"]
  G -->|COMMIT validates held session| H
  G -->|held session expired| X
```

## Execution Trace

### 1. Route admission and permission selection

`apps/controller/src/index.ts:requiredPermissions`

The API route declares IAM operations as Installation administration plus exact
Namespace read. Admission and identity resolution remain in
`apps/controller/src/index.ts`; they resolve the caller before dispatching to
the IAM handler. The OCC controller uses the selected IAM Driver for both
permission checks. Ordinary access to the target resource does not authorize
policy delegation.

### 2. Role and AccessBinding commands reach the controller

`apps/controller/src/http/iam.ts:iamHandlers`

List and read operations call the corresponding `OpenClawController` IAM method
and return policy metadata. Create and delete operations use the handler's `transactIAM` callback, append an attributable mutation audit event, and return
only after the transaction commits. For human sessions, authentication wraps
`controller.transact` and retains the admitted session before the IAM command and
checks its expiry again after the command and audit append. PostgreSQL locks the
user before the session, then the controller takes its existing Namespace and
account locks. Guarded profiles first reuse
`packages/occ/src/state/human-authentication.ts:PostgresHumanAuthentication.holdSession`,
which validates the bound account and sign-in method through the existing actor guard.
Session retention takes shared user locks and preserves the policy transaction's
timeout settings. Account-management operations keep their exclusive locks and
five-second lock and ten-second statement limits. Independent sessions can write
different Namespaces concurrently while revocation still waits for both holders.
Logout or account/method revocation must wait for a protected
write to finish; revocation that completes first makes the write fail. Expiry
during the write or before server-side COMMIT validation rolls back policy and its success audit. The memory auth adapter
serializes policy writes with local logout and rechecks the session inside the
transaction. Non-session credentials keep their existing admission behavior.
The event's authorization records the
Installation `administer` check. Role events carry the Namespace as resource and
`roleId` plus `permissions` in details. AccessBinding create and delete events
carry the bound target as resource (the Namespace for a Namespace binding) and
`bindingId`, `subjectKind`, `subjectId`, and `roleId` in details. Deletion reads
the removed Role or AccessBinding in the same transaction to record it.
ServicePrincipal creation takes an empty body; its event carries the Namespace
as resource and `servicePrincipalId` in details. The new non-Agent identity is
fixed to the Namespace, holds no grant until an AccessBinding names it, and is
listed only in that Namespace. No route deletes it yet; the [service key flow](service-api-keys.md)
issues and revokes its keys.

### 3. OCC validates policy ownership

`packages/occ/src/index.ts:createIAMAccessBinding`

Role creation accepts only nonempty, duplicate-free permissions for Namespace
resource kinds; `namespace` permissions support only `read`. `iamRolePermissions`
also refuses action/kind pairs outside `SUPPORTED_PERMISSION_ACTIONS` (contracts),
because no operation checks them, and then any `create` Permission, because `create`
is checked on the Namespace and this API binds only exact resources
(`NAMESPACE_POLICY_CREATE_REASON`). AccessBinding creation accepts identity subjects and exact
targets in the same Namespace, including the Namespace itself when the target
ID matches the path Namespace. OCC verifies the target resource exists and that
the caller can read it before asking the IAM Driver to create the binding.
`assertAccessBindingRoleApplies` then refuses, with `400`, a Role that has no
Permission for the target's kind, or a `create` Permission stored before Role
creation refused them, because evaluation would drop those grants.

### 4. The IAM Driver persists or reads policy

`packages/iam/src/index.ts:NativeIAMDriver`

The native IAM Driver implements Namespace policy methods against the
platform-provided policy repository. Before a policy write, OCC requires the
selected Driver's `namespacePolicyTransaction: "platform-unit-of-work"`
declaration. An unsupported Driver returns `503` before its mutation method is
called; reads do not require that declaration. The native Driver rejects missing Roles, cross-Namespace
targets, unsupported subjects, duplicate IDs, referenced Role deletion, and
unknown exact bindings without weakening authorization. Invalid Role or
binding input (an unsupported Permission, or a subject, Role or target not
usable in the path Namespace) raises `IAMPolicyValidationError`, which HTTP
maps to `400 INVALID_REQUEST` with the offending field as the detail path.
Referenced Role deletion raises `IAMRoleInUseError` (`409 RESOURCE_CONFLICT`).
Existing human Principals can receive bindings without a Namespace service
identity. ServicePrincipal subjects must belong to that exact Namespace.

When the selected native Driver reloads policy during a PostgreSQL State callback,
`PostgresPlatformState.loadNativeIAMState` reads through that State instance's
original transaction. Authorization therefore sees that unit's pending grants
and removals. Outside a callback, the loader opens its ordinary read transaction.
Work that escapes the callback retains its original closed lifetime and fails;
it cannot obtain another client after commit, rollback, or an unknown outcome.
This transaction binding alone does not fence concurrent policy invalidation.
Human HTTP policy writers additionally retain their session through the original
unit's `holdAuthenticationSession` operation, implemented by PostgreSQL State.

A unit reads the policy once, not once per decision. `readNativeIAMState` keeps
the policy it read on that unit's transaction context. A read-only unit is one
REPEATABLE READ snapshot that writes nothing, so it reuses the policy for every
lookup and decision; a list route therefore reads the policy once for all its
items. A writing unit reuses it only until it issues any other statement, so its
own IAM writes and any locks it takes come before the next read. Two
back-to-back decisions in a writing unit do not see a commit another unit makes
between them, as if it had committed just after; the read was never a fence.
The policy is built fresh from that read's rows and frozen in place as an
immutable snapshot (`freezeSnapshot`), and the native Driver validates and
indexes each snapshot once (identities by id, issuer and subject; bindings by
subject; Restrictions by action and kind). Nothing outlives the
unit: the next request reads the policy again.

### 5. Platform state commits policy and audit together

`packages/occ/src/state/postgres-state.ts:PostgresPlatformState`

The PostgreSQL state implementation writes Roles and AccessBindings through the
same unit of work used by the API audit append. Holding a session issues an
unchanged-row UPDATE that locks it without extending its lifetime or changing
authentication metadata. This queues the deferred
`occ.require_held_authentication_session` constraint for server-side COMMIT
validation. It checks expiry with the database clock, including when the client's
COMMIT request was delayed after the last authentication check. An expired
session raises the named `held_authentication_session_is_current` constraint;
State maps that rejection to an authorization denial (`403`). The policy and
success audit roll back together; the API records the denial separately.
If commit outcome is unknown,
State discards the connection without another query. OCC reports dependency
failure; a caller must not infer rollback or replay the mutation from that
result. Later authorization requests read the current policy through the IAM
Driver. Namespace locking serializes grant creation with Namespace deletion;
exact resource targets retain their existing deletion locks, and deleting a
target resource deletes the bindings on it in the same transaction. Identity foreign
keys protect persisted bindings without expanding application-role privileges.
Deletion audit projections and Namespace policy removal live in
`packages/occ/src/iam-policy-cleanup.ts`; callers pass their existing transaction
unit, so cleanup and its audit retain the same commit boundary.
Both adapters apply one subject rule on every AccessBinding write: a human
without a Namespace, a non-Agent ServicePrincipal of the exact Namespace, or the
ServicePrincipal of a live Agent there. PostgreSQL checks the owning Agent in
the same query because its Agent owner key is deferred to commit. The in-memory
adapter resolves subjects live through its `resolveIAMIdentity` lookup, so
humans enrolled after construction can be bound, then falls back to identities
provisioned at construction. Agent-owned ServicePrincipals resolve only through
its current Agent state.

State also provides an opt-in Installation authority and native-IAM barrier
for an original transaction. Its SQL supplier is unregistered, and the
Namespace routes above do not use it. It does not protect these routes until the
selected account, session, and policy writers join the same protocol.

## Debugging and Verification

- `node --test tests/integration/occ-api.test.mjs` checks the HTTP contract and
  API admission behavior for Namespace IAM policy, including refusal of all five
  writes without declared transaction participation.
- `node --test tests/conformance/occ-api-security.test.mjs` checks that Agent
  responses expose `servicePrincipalId` without accepting caller-supplied values.
- `node --test tests/integration/postgres-namespace-iam-policy.test.mjs` checks
  PostgreSQL persistence, audit atomicity, and deletion behavior with real state.
- `node --test tests/conformance/postgres-transaction-unknown-commit.test.mjs`
  checks that an unknown commit does not wait for a later rollback query.
- The production bootstrap Sharing case in
  `tests/integration/postgres-production-wireup.test.mjs` checks revocation after
  real HTTP admission, cross-replica logout ordering, expiry during policy work,
  and expiry after the final client check with COMMIT paused at the transport. It uses
  real authentication, IAM and PostgreSQL; its passive Compute does not prove a native Gateway.
- The guarded activation case in
  `tests/integration/postgres-password-default-activation.test.mjs` checks a
  Namespace wait beyond five seconds, an independent session's write, and
  subsequent account revocation. These cases emit credential-free execution
  diagnostics for review evidence.
- A `403` can also mean the admitted assigning session was revoked or expired
  before its protected transaction completed. A `403` means the caller lacks Installation administration, exact Namespace
  read, or target read for binding creation. A `400` names the invalid
  field in its detail path. A `409` on Role deletion means a binding still
  references the Role.

## Related docs

- [Identity and access management](../reference/authorization.md)
- [Agents](../reference/agents.md)
- [API reference](../reference/api.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-15 13:28: Retain assigning sessions through policy COMMIT, require transactional IAM writes, and preserve caller limits with shared guarded-session holds. (authoring-run/ec3b3e9d-0724-4b9e-a41d-4eb8a44d4851 - a302a3e2061575b64dcc37e212c55075d5c74b9a)
- 2026-10-14 11:00: Read, validate and index native policy once per State unit of work instead of once per decision. (fix-1322)
- 2026-10-01 20:30: Refuse AccessBindings whose Role cannot apply to the target. (fix-d93-d100)
- 2026-09-29 16:40: Record the Installation authorization and the Role or AccessBinding changed in IAM policy audit events. (fix-5)
- 2026-09-29 05:28: Bind selected native policy reloads to the original State transaction and reject escaped reads. (codex/01a0eb4c-5933-7752-bddc-f787e8da79e7 - 2a191c74c0079e329db130d0a81a1f0f87869bb9)
- 2026-09-27 19:15: Clarify unknown commit handling and the unregistered authority barrier. (codex/01a0b3bf-83a8-7392-ae2d-1a369b54ab3f - 181b0472f9a5a9d422035edf5121d3a15c200cb5)
- 2026-09-23 22:56: Update source ownership for extracted IAM HTTP handlers; preserve admission and transaction boundaries. (codex/01a0d075-a358-7620-8c16-fd4290acddf1 - 4df9f9800836dc1c2b57afd5f8af4d91f55088d5)

- 2026-09-23 08:44: Extend the managed grant path to existing humans and exact Namespace targets. (authoring-run/1d5da2d1-e61e-4277-bd91-037d64c10744 - 370570d788725a178a7441f8388a333c47c29798)
- 2026-09-20 09:32: Document Namespace IAM policy management flow. (codex/01a0bce5-9f29-7110-85fd-6b140674d362 - 5f7728e8c5d128bc7067b7035e07f06c3c4da92c)
