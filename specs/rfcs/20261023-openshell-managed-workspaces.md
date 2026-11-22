---
status: Proposed
implementation_status: Partially implemented
author: grs
---

# Proposal: OpenShell managed Workspaces

- **ID:** RFC-20261023-openshell-managed-workspaces
- **Created:** 2026-10-23
- **Last updated:** 2026-11-22
- **Original proposal:** [PR #3959](https://github.com/openclaw/openclaw-enterprise/pull/3959)
- **Implementation:** [PR #4432](https://github.com/openclaw/openclaw-enterprise/pull/4432) and [PR #6641](https://github.com/openclaw/openclaw-enterprise/pull/6641)

## Summary

Use one stable OpenShell Sandbox per Agent through the existing Kubernetes
Compute Driver, with OpenShell owning Harness placement and persistent storage.

## Motivation

The primary aim is to allow more complete separation of sandboxed workloads from
non-sandboxed workloads. OpenClaw Enterprise (OCE) currently couples OpenShell
execution to Kubernetes Harness placement and storage, limiting that separation.

## Goals

- Preserve workspace state, Agent data, and Sandbox identity across redeployments.
- Separate Agent Gateway placement from the managed Harness namespace.
- Support dedicated OpenClaw and Codex Harnesses through the ordinary Agent workflow.

## Non-goals

Embedded OpenClaw mode and cross-cluster deployment.

## Proposal

### Architecture

The existing Kubernetes Compute Driver owns Gateway orchestration and delegates
Harness lifecycle through an internal runtime selected from the Sandbox
capability. With the bundled OpenShell Sandbox in `integrationMode: service`,
composition supplies `ManagedOpenShellSandbox` and Compute selects
`ManagedOpenShellHarnessRuntime`. The configured Compute ID and
`occ/kubernetes` implementation identity stay unchanged.

Compute builds a shared Harness launch description with logical retained
directories. The managed runtime delegates placement, readiness, stop, and
deletion to OpenShell. Runtime bootstrap prepares retained directories under
`/sandbox/oce`; OCE does not create or manage a Harness PVC. The existing
Kubernetes and operator Sandbox paths retain their lifecycle and storage behavior.

OCE owns Agent authorization, revisions, activation, and Gateway resources.
OpenShell owns Harness placement, execution, and persistent storage, which OCE
manages through OpenShell APIs. The workspace node connects to the Agent Gateway
through Envoy. Operators must admit the managed supervisor to Envoy and the
OpenShell gateway. Each
workload gets a private home outside the retained volume. Only the declared
workspace, session, generated image and node directories carry over.
Existing credential and network isolation must be preserved.

Each Agent has one stable Sandbox across revisions. Redeployment stops the
previous workload, updates the existing Sandbox, then starts and verifies the
replacement. Stop and revision retirement preserve the Sandbox and its data;
Agent deletion removes them. Replacement uses resource-version checks and reads
back the updated specification before starting the workload. Unsupported updates
fail explicitly.

## Interface changes

### APIs

No changes. Callers use the existing Agent deployment, stop, workspace and
deletion operations.

### IAM

No changes. OCE uses existing Agent permissions. The OpenShell gateway still
requires its own workspace authorization. For example, the gateway requires
workspace-admin authority for policy updates.

### Database entities

`occ.egress_installations` stores one receipt per
`(sender_id, sandbox_id, revision_id)`. Retiring a receipt preserves the history
and removes it from the current-receipt lookup. A partial unique index allows
one current receipt per `(sender_id, sandbox_id)`. This lets OCE keep a stable
Sandbox ID while enforcing the Git authorization for the selected revision.
See the [entity reference](../../docs/reference/cheatsheets/database-entities.md#egress_installations)
and the [schema change](../../migrations/0084_revision_egress_installations.sql).

### Driver contracts

- Remove `drivers.sandbox.configuration.gateway.workspaceMode` from OCE
  Installation settings before upgrade. The OCE schema rejects that setting.
  Configure OpenShell's own workspace mode on the server. Legacy integration
  requires `workspaceMode: operator` on the OpenShell gateway. See the
  [OpenShell Sandbox configuration](../../docs/reference/drivers/openshell-sandbox.md).
- OCE defaults to `integrationMode: legacy`. Set `integrationMode: service`
  when selecting OpenShell-owned storage before deploying an Agent. Prepare,
  activate, stop and retire each revision with the storage owner saved for that
  revision. Restore the original Installation settings if the owner differs.
  See the [service configuration](../../docs/reference/drivers/kubernetes-openshell-compute.md).
- The Sandbox launch contract supplies `retainedDirectories` with logical
  directories and environment bindings. When the Sandbox Driver declares
  `workspaceStorage: "provider"`, Compute passes an empty `workspaceMounts` list.
  See the [Sandbox provisioning inputs](../../docs/reference/drivers/sandbox.md#provisioning-inputs).
- The Credential Proxy contract lets an `online-request` Git recipient bind to
  the retained Sandbox execution. In that case, it can omit both
  `processInstanceId` and `networkInstanceId`. The Provider ID and attachment
  epoch remain required, and the adapter checks current execution readiness
  separately. Exact-dispatch and observed-hook recipients still require both
  instance IDs. See the
  [recipient contract](../../packages/contracts/src/drivers/credential-proxy/index.ts).

## Simplifications

The existing Kubernetes Compute Driver shares Gateway orchestration across
both modes. Service mode delegates retained storage to OpenShell and removes
the need for OCE to create a Harness PVC or read Pods in the managed namespace.
A mode switch still requires the right server configuration and supported
Sandbox update methods.

## Acceptance Criteria

Run the [managed OpenShell checklist](../../docs/testing/openshell-managed.md)
through the normal Agent workflow for each dedicated Harness. Use one OCE worker,
a compatible OpenShell gateway with persistent Sandbox storage, enforcing
NetworkPolicies, and authorized model credentials. Deny OCE Pod-read access in
the managed namespace. Record the OCE commit, controller and runtime digests,
OpenShell version, and Envoy route.

- **AC-1 — Connect through Envoy.** Deploy an Agent and complete a model turn.
  Redeploy and complete another turn through the Envoy route. Verify that OCE
  removes obsolete direct ingress policies and rejects a peer outside the
  approved path.
- **AC-2 — Retain and delete workspace state.** Write a workspace marker, stop
  the Agent and resume it. Check the same Sandbox and PVC identities and read
  the marker after replacement and resume. Delete the Agent and confirm that
  OpenShell removes the Sandbox and PVC.
- **AC-3 — Refuse unsafe replacement.** Test failed bootstrap, an unsupported
  update and a lost update acknowledgment. Verify that failed bootstrap and
  unsupported updates block startup. Verify that the update uses the observed
  resource version as a write precondition. After a lost acknowledgment, verify
  that the retry checks the requested workload and active policy before starting.
- **AC-4 — Retire Git authorization.** With the
  [two-repository fixture](../../docs/testing/openshell-git-replacement.md),
  replace an Agent revision with different repository bindings. Through Envoy,
  verify that the replacement can use its new binding and that the retired
  revision loses access.

## Delivery and verification

The original prototype demonstrated Codex creation in two Workspaces and
retention across revisions. Service mode reached main in
[9e1803da03b1](https://github.com/openclaw/openclaw-enterprise/commit/9e1803da03b1a625a208e253aeb45affbbeae0a3)
at maintainer direction. The architectural decision remains Proposed.

- **Codex (AC-1 and AC-2).** At
  [`7293fdf98d`](https://github.com/openclaw/openclaw-enterprise/commit/7293fdf98dcd1ba57701d502aaa7f5b451f11585),
  live k3d validation used stock OpenShell 0.1.8, mTLS, Envoy and a real model.
  The run verified replacement, peer isolation, the saved marker, stop/resume
  and deletion. [PR #6641 verification](https://github.com/openclaw/openclaw-enterprise/pull/6641#verification)
  records the controller and runtime digests, setup and outcomes.
- **Replacement failures (AC-3).** The checklist distinguishes Driver tests
  with fixture transports from live tests. The final live report verified
  external policy drift refusal. Live proof for failed bootstrap, every
  unsupported update and lost acknowledgments remains pending.
- **Dedicated OpenClaw (AC-1 and AC-2).** The intermediate
  [`127f4c22a7`](https://github.com/openclaw/openclaw-enterprise/commit/127f4c22a737594c1d068384e46bc387836df9e0)
  completed an initial model and tool turn. Resume failed. At the final head,
  all three native trials failed before completing the initial turn. Trials on
  main also failed initial or resumed turns. Native rollout remains unqualified.
- **Private Git (AC-4).** Database and protocol tests verified retired
  authorization. [Gordon's live replacement runs](https://github.com/openclaw/openclaw-enterprise/pull/4432#issuecomment-6631613098)
  predate Envoy. The final installation lacked a second authorized repository
  and protected proxy, so live two-repository recovery remains pending.

## Rationale and alternatives

OpenShell ownership lets sandboxed Harness placement and storage remain separate
from OCE-managed Gateway resources. Keep one Kubernetes Compute Driver and make
Harness lifecycle and storage ownership explicit through its internal runtimes
and the Sandbox contract. This preserves shared Gateway orchestration and launch
preparation. A distinct Compute Driver would duplicate that integration without
changing the ownership boundary.

## References

- [Platform architecture](../../docs/design.md)
- [Compute contract](../../docs/reference/drivers/compute.md)
- [Sandbox contract](../../docs/reference/drivers/sandbox.md)
