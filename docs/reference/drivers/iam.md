---
kind: reference/driver
---

# IAMDriver contract

## Overview

`IAMDriver` resolves provisioned identities and decides whether they may act on a
specific platform resource. Authentication establishes the caller's issuer and
subject; the Driver resolves the corresponding identity and evaluates authority.
OpenClaw Control Plane (OCC) owns request admission, resource scope, mutations,
and audit records.

Trusted Installation YAML requires one IAM Driver and defaults to native IAM;
operators can select an installed package. See [Driver selection](selection.md)
and the [authorization reference](../authorization.md).

## Interface

### Identity and authorization operations

The [shared interface](../../../packages/contracts/src/drivers/iam/index.ts) requires two
methods. Optional `coversIdentityAccess(request)` takes a `principalId` and
`targetIdentityId` and returns `true` only when the principal already holds
every grant of the target at the same or a broader scope. OCC requires it before
issuing or revoking a service key and before changing a human account; a Driver
without it cannot issue or revoke service keys.

| Method                  | Contract                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookupIdentity(input)` | Takes an authenticated `issuer`, `subject`, and optional Namespace scope. Returns one provisioned Identity, or `undefined` when no identity can be established. It does not create an account or grant a Role.                                                                                                                                                            |
| `authorize(request)`    | Takes a `principalId`, exact action, and server-owned resource reference. For an `agent_revision` or `sandbox_policy`, OCC also passes `parentAgentId`, the owning Agent from stored state, and an exact binding on that Agent applies its Role's permissions for the requested kind. Returns an allow or deny decision with a reason, selected `driverId`, and evidence. |

Evidence identifies the contributing identity, Groups, AccessBindings, Roles,
and Restrictions. OCC uses it to attribute audit records. The worker rejects
malformed decisions, including a mismatched Driver identity; an invalid result
cannot grant permission.

### Namespace policy operations

Optional Namespace policy methods list, read, create, or delete Roles and
AccessBindings, and list, read, or create ServicePrincipals. OCC supplies their
policy repository. Writes require the Driver to declare
`namespacePolicyTransaction: "platform-unit-of-work"` and participate in that
original transaction; policy and audit must commit or roll back together.
OCC rejects a write before invoking a Driver without that declaration. Reads
remain available when their methods are implemented.

### Configured policy and Owner binding operations

These optional methods support [Default users](../authorization/default-users.md).
They have the same transaction requirement as Namespace policy writes; OCC
returns `503 DEPENDENCY_UNAVAILABLE` when a Driver has one without that
declaration.

| Method                                  | Contract                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `applyConfiguredPolicy(context, input)` | Takes `policy` (configured `roles`, `groups`, and Group `bindings`, with configured IDs) and an optional `namespaceId`. Makes the configured rows match `policy` and returns what it created, updated, and deleted. With `namespaceId`, it only writes what is missing for that Namespace. |
| `createOwnerBinding(context, input)`    | Takes binding `id`, `namespaceId`, `principalId`, the configured Owner `roleId`, and an optional `resourceKind` and `resourceId`. Binds that identity to the Role: exact, or Namespace-wide with no resource.                                                                              |

OCC calls `applyConfiguredPolicy` at startup and when it creates a Namespace,
and `createOwnerBinding` after each create when `ownerRole` is set. It skips each
when the Driver has no such method. The supplied `IAMPolicyRepository` provides
`listConfiguredPolicy`, `putConfiguredRole`, `deleteConfiguredRole`,
`createConfiguredGroup`, `deleteConfiguredGroup`, `createOCCBinding`, and
`deleteConfiguredBinding` for these methods. They change only rows with
configured ID prefixes, and write bindings only to configured Roles, in a
`provisioning` or `ready` Namespace or Installation-wide.

## IAM

The authentication system verifies credentials; the IAM Driver resolves the
provisioned Principal or ServicePrincipal and decides access. OCC supplies the
resource scope. A backend credential or installed package identity does not
replace the caller's authority. An explicit applicable binding can grant access;
Restrictions override grants. ServicePrincipals use their own scoped bindings
and do not inherit a human Principal's Group membership.

When the worker picks up queued operations, it rechecks the original actor's
authority against current policy. Revocation therefore affects later decisions;
a denied request or unavailable authority cannot become an allow. See
[authentication](../authentication.md) for sessions and password handling.

## Lifecycle

Startup creates the selected IAM Driver. The API and worker use it for later
lookups and decisions; policy remains persisted platform state and is not frozen
in Installation YAML or a deployment. The shared interface has no startup or
disposal hook.

### Native IAM behavior

The native Driver reads controller-owned IAM state once per PostgreSQL State unit
of work, such as one list request, and validates and indexes it once there; a
lookup or decision outside a unit opens its own. A later unit reads the policy
again, so a revocation applies to the next request. The Driver accepts only an
empty startup configuration. Lookup returns no identity for
an absent or ambiguous match, invalid scope, or invalid policy. Authorization
denies invalid requests or policy, unknown identities, cross-Namespace identity
use, and requests without an applicable grant. A storage error propagates instead
of becoming permission. Principal Group membership may contribute a grant.

## Limits

### Installed Driver boundary

Installed factories receive the controller-owned `platformState` and must read
current policy through `loadNativeIAMState()` for both methods. Tenants and
Installation YAML cannot supply this object. Installed code runs with
control-plane authority: startup can validate its identity and interface but
cannot prove it honors persisted policy. The Installation operator must review
the package; see [package trust](selection.md).

IAM does not own sign-in, passwords, token issuance, or automatic account
provisioning. Existing authorization policy remains the canonical source for
supported resource actions and Restrictions.

## Troubleshooting

| Symptom                                                     | What to check                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Valid credentials do not resolve an identity                | Check the issuer and subject, Namespace scope, and that exactly one matching identity was provisioned. Signing in does not provision a Role.     |
| A known identity is denied                                  | Check the exact action and resource, applicable bindings and Roles, and overriding Restrictions. For a ServicePrincipal, check its own bindings. |
| Previously queued work is denied                            | Check whether the original caller or its grant was revoked. Restore only the intended permission or start a newly authorized operation.          |
| IAM or policy storage is unavailable                        | Restore the dependency and retry; never turn an error or malformed decision into an allow.                                                       |
| Creates or startup return `503` with an `iam` configuration | Check that the Driver declares `namespacePolicyTransaction: "platform-unit-of-work"` with its configured policy and owner methods.               |

## Implementations

- [Native IAM Driver](../../../packages/iam/src/index.ts): bundled implementation
  using OCC's stored IAM state.
- Operator-installed IAM packages use the same shared methods and controller-owned
  state; see [selection and package requirements](selection.md).

## Runtime entry assignment

`authorizeRuntimeAccess` resolves Agent `use` and the exact human runtime-role assignment from one current policy snapshot. It returns ordinary decision evidence plus an opaque `runtimeRole`. Restrictions still override grants; absent or ambiguous assignments deny entry. The managed policy contract adds `updateNamespaceRuntimeRole` for changing only the runtime assignment on an existing binding. Native permission definitions belong to the runtime.

## Related

- [Authorization policy](../authorization.md) and [authentication](../authentication.md)
- [OCC resource operations](../../../packages/occ/src/index.ts) and [worker authorization](../../../apps/controller/src/worker.ts)
