---
status: Proposed
implementation_status: Partially implemented
author: russellb
---

# Proposal: Manage the Installation network policy ceiling

- **ID:** RFC-0038
- **Created:** 2026-11-06
- **Related:** [RFC-0022](0022-driver-configuration-contributions.md), [RFC-0025](0025-installation-driver-values.md)

## Summary

Make the Installation network policy ceiling a versioned, persistent Installation
setting that administrators can manage through the Console. Use trusted startup
configuration once to initialize it; PostgreSQL owns runtime values. Operators
can opt in to replacing the saved ceiling from startup configuration on each
control-plane start for GitOps management. Changes govern future policy admission
and pending applications. They do not revoke access from running Agents or change
Sandbox Driver defaults.

## Motivation

Today, `sandboxNetworkPolicyCeiling` comes from trusted startup configuration.
The [controller](../../packages/occ/src/index.ts) and
[worker](../../apps/controller/src/worker.ts) retain separate startup copies.
Administrators can inspect the ceiling from an Agent's network policy dialog,
but changing it requires configuration edits and restarts.

[RFC-0022](0022-driver-configuration-contributions.md) explicitly defers ceiling
configuration integration. This proposal supplies that decision without making
arbitrary Driver startup configuration editable.

## Goals and boundaries

- Let an Installation administrator inspect, add, edit, and remove ceiling rules.
- Give the API and worker one authoritative value that survives restarts.
- Support an explicit GitOps option to replace saved rules at startup.
- Preserve current grant semantics and exact-resource authorization.
- Reject stale saves and record attributable initialization, mutations, and
  authorization denials.

This does not introduce automatic revocation, a general settings store, editable
Sandbox defaults, or a new IAM action. Agent editing flags, protected execution,
Driver admission, and policy save/application authority keep their existing owners.
The ceiling permits requests; it does not grant access by itself.

## Proposal

### Ownership and persisted state

OCC owns one ceiling record associated with the server-selected Installation.
Persist the rules, management mode (`console` or `startup`), a monotonically
increasing version, and update attribution and time. Use the existing
[platform state transaction boundary](../../packages/occ/src/state/platform-state.ts)
with PostgreSQL persistence and its in-memory counterpart. Enforce singleton
ownership and valid version constraints in the database.

Reuse the shared
[network grant schema and semantics](../../packages/contracts/src/sandbox-policy.ts):
at most 32 rules, at most 16 inclusive port ranges per rule, exact executable paths,
and the existing hostname and wildcard rules. Keep provider-specific enforcement
in the selected Sandbox Driver. Changing a ceiling neither invokes that Driver
nor changes its defaults; actual Agent rules still require provider admission.

### Initialize once from startup configuration

The trusted Installation initialization path validates
`sandboxNetworkPolicyCeiling` and atomically creates version 1 when no ceiling
record exists. An omitted seed creates an explicit empty rule list. Commit the
initialization audit evidence with the record, using the established bootstrap
identity rather than inventing a human requester.

Perform initialization for both newly created Installations and existing
Installations that have no ceiling record. A unique Installation association and
transactional initialization ensure concurrent starts cannot overwrite a record.
Only the trusted initialization path seeds state; the worker never initializes
from its own startup copy. Policy operations and worker processing require
initialization to have completed.

By default, startup configuration remains subject to normal startup
validation but cannot replace an initialized value. If a supplied seed differs from
the persisted rules, emit a diagnostic that it is seed-only and direct the
operator to the admin control. Do not print the complete policy in the diagnostic.
Removing the startup field also leaves saved state unchanged.

An empty saved ceiling is initialized state, not a request to seed again. A
restart after removing every rule must keep the ceiling empty. Missing state
outside initialization, unreadable state, or invalid persisted state causes
dependent policy operations to fail explicitly. There is no fallback to a
process-local seed or a previously cached value.

### Optional overwrite at startup

Add `sandboxNetworkPolicyCeilingOverwriteOnStartup`, defaulting to `false`.
When `true`, the trusted initialization path replaces the persisted ceiling with
the validated startup rules before the API admits policy operations. Require an
explicit `sandboxNetworkPolicyCeiling` value in this mode; omission fails startup.
An explicit empty list deliberately clears the ceiling. The worker never writes
the startup rules and continues to read the persisted value.

Serialize replacement with ceiling updates and dependent policy admission. If the
rules or management mode change, increment the saved version and commit
attributable startup audit evidence in the same transaction. Identical rules and
mode are a no-op, preserving the version. Failed replacement prevents startup from admitting policy operations;
do not continue with stale rules while claiming GitOps configuration took effect.

This option reconciles at startup, not continuously when a configuration file
changes. All API instances must use the same startup rules and option; competing
startup configurations are unsupported. The implementation plan must define how
startup ownership prevents conflicting configurations during a rollout. Turning
the option off preserves the last saved rules and restores the default behavior.
Startup replacement retains the same guarantee as UI saves: no automatic
revocation of access from running Agents.

The proposed GitOps mode makes the admin editor read-only and labels the ceiling
as managed by startup configuration. The API checks the persisted management mode
within the write transaction and rejects edits with a conflict in `startup` mode,
even from an administrator. Return that mode with the read response. Only trusted
startup configuration can change it. Turning overwrite off sets `console` mode
without changing rules; stale editor versions remain subject to conflict checks.

### Admin operations and Console

Propose owner-specific `GET` and `PUT` operations at
`/installation/sandbox-network-policy-ceiling`. Both authorize `administer` on
the actual Installation through the selected IAM Driver. Callers cannot select
another Installation ID. The write accepts `{ expectedVersion, rules }` and
returns the persisted rules and new version in the standard response envelope.
Reject malformed or invalid rules with field details and a stale version with a
conflict. Commit a successful write and its attributable audit event together.

`POST /installation/sandbox-network-policy-ceiling/validate` previews the same
input through shared validation. It requires the same Installation authority and
checks current mode and version without changing state. Return a configuration
result with validated rules or safe field details. Preview success grants no
authority to a later write; PUT repeats its checks.

The proposed Console entry point is an admin-only **Network policy ceiling**
section in Settings. Reuse the existing rule editor patterns and shared
validation; do not expose provider YAML. Show the saved version and explain that
the ceiling grants no access and changes leave running access unchanged. Review
the proposed changes before saving, including an explicit warning when removing
rules or clearing the ceiling.

Retain the Agent's read-only **View network limits** dialog. Show the effective
persisted ceiling through its existing Agent/SandboxPolicy authorization path,
and offer administrators a link to Settings. Non-admin users gain no Installation
write authority or access to admin-only attribution.

Keep drafts after validation, permission, or network failures. On conflict, offer
reload and review without overwriting the newer value. An uncertain write outcome
requires reading the same resource; do not repeat the write automatically. Confirm
the returned resource, version, and rules before reporting success. Hide admin
controls when access is withdrawn, while every API operation independently
rechecks authorization.

### Admission and application

Remove startup ceiling copies from runtime admission. Preview, policy save,
application admission, and deployment admission read the persisted ceiling.
The worker reads it again on each pending application attempt before provider
effects, preserving existing authority and lifecycle checks.

Serialize ceiling updates with the transactional policy admission checks that
depend on them. An admission ordered after a ceiling update must use that update;
an earlier successful preview grants no authority to a later save or application.
The implementation plan must specify the lock order shared by these paths.

A pending application whose rules exceed the new ceiling fails through the
existing `SANDBOX_POLICY_CEILING_CHANGED` path. If a provider request already
started, a later ceiling update does not undo it or promise to prevent its
completion. Preserve the existing unconfirmed-outcome handling; never send a
compensating policy merely because the ceiling changed.

Do not reconcile running Agents solely because of a ceiling update. Preserve
their saved policies, revision snapshots, and applied evidence. A later policy
save, deployment admission, or application must satisfy the then-current ceiling.
Widening the ceiling also grants no access until an Agent policy is admitted and
deployed or applied through its normal workflow.

## Delivery and verification

The owner API, PostgreSQL persistence, startup ownership, worker rechecks, and
Console editor are implemented in [PR #4920](https://github.com/openclaw/openclaw-enterprise/pull/4920).
The [implementation plan](../plans/0038-installation-network-policy-ceiling.md)
records verification and remaining delivery requirements. Current behavior is
specified in [Sandbox policies](../../docs/reference/sandbox-policies.md#installation-ceiling).
The decision remains Proposed; implementation does not establish acceptance.

Required proof includes:

- PostgreSQL integration for one-time seeding, concurrent initialization,
  explicit empty state, restart persistence, stale saves, authorization denials,
  audit atomicity, and fail-closed reads. Cover opted-in startup replacement,
  missing input rejection, explicit clearing, unchanged-rule no-ops, startup
  failure, refusal of admin writes in GitOps mode, and returning to the default
  mode without resetting saved rules.
- The regular Agent workflow through real controller routes: administrator saves
  a ceiling, permitted Agent rules save/apply, excessive rules fail, tightening
  rejects pending work, and widening alone grants no access. Include concurrent
  ceiling changes and preserve an already running Agent's access until an
  explicit later operation changes it.
- Runtime qualification on the user-selected Fedora VM over SSH: run OCE services
  in Podman with PostgreSQL, Kubernetes Compute on disposable k3d, and OpenShell.
  Prove allowed and denied traffic and the selected lifecycle behavior through
  real Agent callers. Use enforcing NetworkPolicies, scoped database roles, and
  approved runtime images and credentials under the
  [Kubernetes](../../docs/testing/kubernetes.md) and
  [OpenShell](../../docs/testing/openshell.md) procedures.
- Rebuilt Storybook and browser coverage for empty, loading, invalid, forbidden,
  conflict, uncertain-save, and successful-save states. Capture screenshots and
  an interaction video; publish reviewable attachments when a PR exists. Label
  simulated UI evidence separately from runtime proof.

The proposal itself does not establish runtime acceptance. The implementation
plan distinguishes source, PostgreSQL, browser, and real runtime evidence.

## Rationale and alternatives

**One-time seed and persistent ownership** preserves a useful initial operator
configuration while letting administrators make durable changes without
restarts. It makes the authority transition explicit and avoids two competing
live sources.

**Startup configuration always wins:** suits GitOps but makes Console changes
unexpectedly disappear on restart for operators who did not select that model.
An explicit overwrite option preserves that workflow without making it the default.

**Require a separate initialization command:** makes initialization explicit,
but adds an operator step to a setting that already has a trusted seed. The
transactional initialization path provides the required distinction between
missing and deliberately empty state.

**Overlay UI values on startup configuration:** creates precedence and reset
ambiguities, especially after clearing all rules. A single persisted owner is
easier to inspect and enforce consistently.
