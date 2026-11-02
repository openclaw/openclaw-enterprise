---
status: Proposed
implementation_status: Not implemented
author: grs
---

# Proposal: OpenShell managed Workspaces

- **ID:** RFC-0027
- **Created:** 2026-10-23
- **Last updated:** 2026-11-02
- **Prototype:** `openshell-managed-workspaces`

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
capability. With the bundled OpenShell Sandbox in managed Workspace mode,
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
manages through OpenShell APIs. Existing credential and network isolation must
be preserved.

Each Agent has one stable Sandbox across revisions. Redeployment stops the
previous workload, updates the existing Sandbox, then starts and verifies the
replacement. Stop and revision retirement preserve the Sandbox and its data;
Agent deletion removes them. Replacement uses resource-version checks and reads
back the updated specification before starting the workload. Unsupported updates
fail explicitly.

## Delivery and verification

The implementation requires rebuilt runtime images and expanded
OpenShell `UpdateSandbox` support. The author verified Codex creation
in two Workspaces, Agent redeployment, and data retention across
redeployment. Deletion and failure recovery need further verification
through the Agent workflow.

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
