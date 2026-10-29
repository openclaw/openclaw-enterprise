---
status: Proposed
implementation_status: Not implemented
author: grs
---

# Proposal: OpenShell managed Workspaces

- **ID:** RFC-0024
- **Created:** 2026-10-23
- **Last updated:** 2026-10-28
- **Prototype:** `openshell-managed-workspaces`

## Summary

Use one stable OpenShell Sandbox per Agent, with OpenShell owning Harness
placement and persistent storage.

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

A dedicated Compute implementation reuses Kubernetes Gateway orchestration and
delegates Harness lifecycle to OpenShell. Runtime bootstrap prepares retained
directories.

OCE owns Agent authorization, revisions, activation, and Gateway resources.
OpenShell owns Harness placement, execution, and persistent storage, which OCE
manages through OpenShell APIs. Existing credential and network isolation must
be preserved.

Each Agent has one stable Sandbox across revisions. Redeployment stops the
previous workload, updates the existing Sandbox, then starts and verifies the
replacement. Stop and revision retirement preserve the Sandbox and its data;
Agent deletion removes them. Unsupported updates fail explicitly, and delayed
operations from an older revision must not affect its successor.

## Delivery and verification

The prototype requires rebuilt runtime images and expanded OpenShell
`UpdateSandbox` support. The author verified Codex creation in two Workspaces,
Agent redeployment, and data retention across redeployment. Deletion and failure
recovery need further verification through the Agent workflow.

## Rationale and alternatives

OpenShell ownership lets sandboxed Harness placement and storage remain separate
from OCE-managed Gateway resources. Prefer a dedicated Compute implementation
with an explicit interface for ownership and lifecycle, reducing implicit
assumptions about placement and storage in the existing Kubernetes/Sandbox
integration.

## References

- [Platform architecture](../../docs/design.md)
- [Compute contract](../../docs/reference/drivers/compute.md)
- [Sandbox contract](../../docs/reference/drivers/sandbox.md)
