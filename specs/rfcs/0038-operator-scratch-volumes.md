---
status: Proposed
implementation_status: Partially implemented
author: freeqaz-openai
---

# Operator-owned scratch storage and placement for dedicated OpenShell Agents

- **ID** RFC-0038
- **Created** 2026-11-10
- **Related** [RFC-0003 Gateway–Harness storage split](0003-gateway-harness-storage-split.md)

## Proposal

An installation operator can give one dedicated OpenShell Agent writable build and cache space at `/sandbox/scratch`, CPU and memory settings, or a RuntimeClass. Each binding selects an exact OCE `namespaceId` and `agentId`. The Agent API grants no authority to select a claim or change placement.

**Storage.** In Kubernetes Compute's `runtime.scratchVolumes`, bind the Agent to an existing filesystem PVC by execution Kubernetes namespace, claim name and UID (`namespace`, `claimName`, `claimUid`). Admission freezes the binding or its absence in the revision. Preparation and activation reread the claim. Refuse a missing, replaced, terminating, Lost or nonwritable claim, the wrong namespace, or overlap with durable storage. OpenShell mounts the approved writable `scratch` subpath under its filesystem policy. The workspace and Gateway keep their own claims. Agent cleanup preserves scratch. Deleting its Kubernetes namespace deletes the PVC.

**Sizing and placement.** OpenShell Sandbox's `kubernetes.agentResourceOverrides` accepts `requests` and `limits` maps of quoted non-negative Kubernetes CPU and memory quantities. Omitted keys inherit `kubernetes.agentResources`. Both maps may be empty for a placement-only entry. Startup refuses duplicate Agent bindings, invalid quantities or class names, and effective requests above limits. The Agent container retains its ephemeral-storage request of `256Mi` and limit of `1Gi`. An optional `runtimeClassName` selects the Sandbox Pod class and the native OpenClaw workspace-preparation Pod class. Supervisor placement and sizing are configured separately. Unmatched Agents use installation defaults.

OpenShell reads sizing and class from the current installation settings when provisioning. A changed expected specification prevents adoption of an existing Sandbox. Deploy a new revision to apply changes and retain the previous installation settings for rollback.

## Before replacement

The worker stops the predecessor before candidate preparation. Reserve the scratch claim exclusively while any retained revision can use it and prevent name reuse. Kubernetes mounts PVCs by name after the driver's UID check. Verify directory access under the workload identity and account for kubelet or CSI changes through `fsGroup`. For native OpenClaw, an existing `scratch` directory must have the workload owner and mode `0700`.

Verify the RuntimeClass handler, admission policy, node selector and tolerations on the destination. Check node allocatable resources, remaining capacity, quotas, local PV affinity and durable disk topology together. Verify actual backing and free space for NVMe dogfooding. Instance-local scratch can disappear on node replacement.

## Acceptance criteria

1. Deploy the selected Agent. Inspect its Pod's node, class, container resources and mounted PVC. Through an ordinary Agent tool, write, sync, read and remove a scratch file and independently write and read the durable workspace.
2. Change the scratch binding and verify an admitted revision retains its choice. A new revision with a missing or wrong-UID claim fails and preserves the good claims. Agent deletion preserves scratch.
3. Verify an unmatched Agent retains its mounts, resources and class. Exercise invalid overrides, request/limit inheritance, stale Sandbox refusal and the selected class on native preparation when applicable.
