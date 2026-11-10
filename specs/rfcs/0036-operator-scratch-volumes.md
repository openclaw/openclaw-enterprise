---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Operator-owned scratch volumes for dedicated Agents

- **ID** RFC-0036
- **Created** 2026-11-10
- **Related** [RFC-0003 Gateway–Harness storage split](0003-gateway-harness-storage-split.md)

## Summary

Give an installation operator a way to mount a dedicated Kubernetes
PersistentVolumeClaim (PVC) at `/sandbox/scratch` for one dedicated OpenShell
Agent. The Agent can use the mount for large builds, worktrees, and caches. Its
workspace and Gateway state keep their existing storage and ownership.

## Proposal

Add optional `runtime.scratchVolumes` to the Kubernetes Compute Driver
configuration. Each entry binds an exact OCE `namespaceId` and `agentId` to a
PVC identified by its Kubernetes `namespace`, `claimName`, and `claimUid`.
The installation operator provides the filesystem claim and keeps it
exclusive to the Agent. Without a matching entry, the Agent gets its existing
mounts.

Compute saves the matching entry in the Agent revision during admission.
Configuration changes apply to subsequent admissions. Compute checks the
saved claim identity in the resolved execution namespace during preparation
and activation. Missing claims, changed UIDs, and overlap with the durable
workspace fail the deployment. The operator-owned claim stays outside
Agent cleanup.

Compute passes the approved mount through the existing Harness workload
contract. The OpenShell Sandbox Driver mounts its writable `scratch` subpath
at `/sandbox/scratch` under the native filesystem policy. Agent users do not
select Kubernetes claims through the Agent API. The durable workspace and
Gateway claims remain separate.

The operator checks capacity, node placement, access, and compatibility with
the existing workspace before deploying a replacement. The worker stops the
predecessor before candidate preparation. Kubernetes uses the claim name when
it mounts the volume, so the UID checks require the operator to prevent
substitution during deployment and while any retained revision can use the
claim. The operator also accounts for the filesystem permissions Kubernetes
or the storage driver may change through `fsGroup`, and for claim deletion
if the backing Kubernetes namespace is deleted.

### Agent CPU and memory

An installation operator can use OpenShell Sandbox Driver
`kubernetes.agentResourceOverrides` to assign CPU and memory to a selected
Agent. Each entry names an exact `namespaceId` and `agentId`, and supplies
`requests` and `limits` maps for `cpu` and `memory`. Each value must be a
valid non-negative Kubernetes quantity. The override replaces the specified
keys in `kubernetes.agentResources`. Startup rejects duplicate Agent bindings
and any effective request that exceeds its limit, including inherited values.

The driver uses the effective values in the selected Agent container's
OpenShell Sandbox specification. OpenShell uses that specification when it
replaces the Pod. The installation defaults continue to apply to other
Agents. The supervisor and Gateway keep their own sizing. The existing
ephemeral-storage request of `256Mi` and limit of `1Gi` continue to apply.

The setting belongs to the trusted installation configuration. A change that
makes an existing Sandbox differ from its expected specification causes the
driver to refuse that Sandbox. The operator deploys a new revision to apply
new values. An Agent revision does not store a copy of this resource setting.

## Rationale

A separate claim lets operators choose node-local storage and keep large
temporary workloads out of the durable workspace. Increasing the workspace
size leaves both uses on the same volume. Accepting arbitrary mounts from an
Agent request would give callers a way to select storage outside the
installation operator's binding.

This proposal leaves volume provisioning, placement, sizing, and recovery
with the operator. A claim backed by instance storage can lose its contents
on node replacement.

## Acceptance criteria

- **AC-1** An installation operator binds a scratch claim and deploys a
  dedicated OpenShell Agent. The normal Agent tool writes, syncs, reads back,
  and removes a file on scratch. It also writes and reads from the independent
  durable workspace.
- **AC-2** A change to the Driver configuration leaves an existing revision's
  saved binding intact. A subsequent deployment with a missing claim or wrong
  UID fails and leaves the good claims in place.
- **AC-3** An Agent without a scratch binding keeps its existing mounts. Agent
  cleanup preserves the operator-owned claim.

- **AC-4** An exact Agent binding changes the CPU and memory in its Agent
  container specification. A different Agent keeps the installation defaults.
  The existing ephemeral-storage values and separate supervisor sizing remain
  in effect. Verify duplicate and invalid entries, request/limit comparisons
  after inheritance, and refusal when an existing Sandbox has a different
  specification.

## Delivery and verification

Extend Kubernetes Compute admission and preparation and reuse OpenShell's
existing workload mount path. Verify the Driver boundaries and run the
registered Codex/OpenShell workflow with disposable Kubernetes storage.
Qualify NVMe backing, capacity, and placement on the destination node before
a production cutover.
