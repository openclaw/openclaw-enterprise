---
rfc: ../rfcs/36-agent-access.md
---

# Per-person Agent runtime-role assignments

Status: In progress; awaiting upstream integration and review.

## Problem and scope

The initial Agent sharing release admits every person as the shared native administrator. [Checkpoint 3](../rfcs/36-agent-access.md#delivery-checkpoints) calls for granular native permissions and verified human identity handoff. This change implements the Gateway-entry portion for embedded Kubernetes by selecting any configured OpenClaw role; it does not introduce an administrator/member role list or duplicate OpenClaw's permission engine.

OCE owns the exact person/Agent assignment and entry revocation. `gateway.roles` owns the native definitions. OpenClaw owns its native profiles and all configured permission checks. Installation administration remains separate from runtime access. The [current reference](../../docs/reference/agent-native-admin.md) owns the contract.

## Implementation

- Add Agent `use` and an optional opaque `runtimeRole` on an exact human AccessBinding. Persist one assignment per person/Agent with database constraints and immutable OCE Role permissions.
- Extend IAM to resolve entry permission plus assigned role from one current policy snapshot. Extend Compute to expose the active catalog and human transport descriptor; core consumes only those contracts.
- Share and change roles through ordinary policy APIs and the Console. Changes update only the existing assignment, preserving binding identity and audit atomicity. Revocation removes the binding.
- Strip browser role/identity headers. Proxy the verified stable Principal ID, selected role and policy digest through the dedicated human route. Recheck WebSocket leases and close changed/revoked authority within 30 seconds.
- Apply the native profile assignment before Gateway admission using a temporary patch to the exact pinned runtime. Preserve the separate privileged service identity for workspace operations.

## Checkpoint relationship and review holds

This is an extension of the existing sharing path into checkpoint 3, not a replacement milestone. It covers named native roles and OCE browser identity handoff. Personal/team channel authority, Slack/Teams mapping, named teams, delegated integration use, credential gateways and external Git/model permission mediation remain outside this PR. Shared runtime files, tools, plugins and provider accounts are not isolated by separate human profiles.

Checkpoint 1/2 session-currentness through every sharing COMMIT and durable unknown-outcome receipts remain existing gaps; the UI still treats readback as current configuration, not a historical receipt. This PR does not declare those checkpoints accepted or the wider RFC complete.

Local verification on 2026-10-02 at `a946032a` passed the native Gateway/SQLite, PostgreSQL migration and Console browser checks. All three installed gateway-routing cases passed with Helm, PostgreSQL, Envoy, enforcing NetworkPolicies, rebuilt runtime images and genuine model turns. They proved distinct human profiles and roles, downgrade/reconnect, selective revocation and retained platform workspace access. An additional installed diagnostic passed session-only permissions and a real model turn. Results are recorded in [PR #1](https://github.com/raw-labs/openclaw-enterprise/pull/1).

Before merge, integrate current upstream and validate the resulting revision, complete outstanding CI and platform checks, and attach current Console screenshots and video. The initial runtime startup suite had one timeout; an unchanged focused rerun passed, but its cause and earlier repository-clone failures remain unresolved. The runtime patch still requires maintainer review, and policy normalization mismatches must continue to fail closed.

## Manual Notes

[keep this for the user to add notes. do not change between edits]
