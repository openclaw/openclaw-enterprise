---
status: Proposed
implementation_status: Not implemented
author: russellb
---

# Proposal: Manage the Installation network policy ceiling

- **ID:** RFC-0030
- **Created:** 2026-11-06
- **Related:** [RFC-0022](0022-driver-configuration-contributions.md), [RFC-0025](0025-installation-driver-values.md)

## Summary

Make the Installation network policy ceiling a versioned, persistent Installation
setting that administrators can manage through the Console. Use trusted startup
configuration once to initialize it; PostgreSQL owns subsequent values. Changes
govern future policy admission and pending applications. They do not revoke
access from running Agents or change Sandbox Driver defaults.

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
Persist the rules, a monotonically increasing version, and update attribution and
time. Use the existing
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

After initialization, startup configuration remains subject to normal startup
validation but cannot replace the saved value. If a supplied seed differs from
the persisted rules, emit a diagnostic that it is seed-only and direct the
operator to the admin control. Do not print the complete policy in the diagnostic.
Removing the startup field also leaves saved state unchanged.

An empty saved ceiling is initialized state, not a request to seed again. A
restart after removing every rule must keep the ceiling empty. Missing state
outside initialization, unreadable state, or invalid persisted state causes
dependent policy operations to fail explicitly. There is no fallback to a
process-local seed or a previously cached value.

### Admin operations and Console

Propose owner-specific `GET` and `PUT` operations at
`/installation/sandbox-network-policy-ceiling`. Both authorize `administer` on
the actual Installation through the selected IAM Driver. Callers cannot select
another Installation ID. The write accepts `{ expectedVersion, rules }` and
returns the persisted rules and new version in the standard response envelope.
Reject malformed or invalid rules with field details and a stale version with a
conflict. Commit a successful write and its attributable audit event together.

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

Implementation is not started. Write a separate implementation plan after review
submission. Cover persistence and initialization, owner API, every admission
caller, worker rechecks, Console behavior, and current reference/guide/flow updates.
Keep proposed behavior out of current feature references until implemented.
Any Driver contract changes discovered during planning require a submitted RFC
that explicitly covers them before code changes.

Required proof includes:

- PostgreSQL integration for one-time seeding, concurrent initialization,
  explicit empty state, restart persistence, stale saves, authorization denials,
  audit atomicity, and fail-closed reads.
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

This RFC receives documentation checks only. No implementation, browser, or
runtime acceptance is claimed by the proposal.

## Rationale and alternatives

**One-time seed and persistent ownership** preserves a useful initial operator
configuration while letting administrators make durable changes without
restarts. It makes the authority transition explicit and avoids two competing
live sources.

**Keep startup configuration authoritative:** simpler storage, but the requested
UI cannot manage the effective value without rewriting deployment configuration
and coordinating restarts.

**Require a separate initialization command:** makes initialization explicit,
but adds an operator step to a setting that already has a trusted seed. The
transactional initialization path provides the required distinction between
missing and deliberately empty state.

**Overlay UI values on startup configuration:** creates precedence and reset
ambiguities, especially after clearing all rules. A single persisted owner is
easier to inspect and enforce consistently.
