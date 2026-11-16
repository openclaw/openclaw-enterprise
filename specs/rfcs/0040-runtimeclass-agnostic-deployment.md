---
status: Proposed
implementation_status: Not implemented
author: sjenning
---

# Proposal: leave Kubernetes RuntimeClass selection outside OCE

- **ID:** RFC-0040
- **Created:** 2026-11-16
- **Last updated:** 2026-11-16
- **Implementation plan:** [TASK-0052](../plans/0052-optional-runtimeclass.md)
- **Related:** [RFC-0038](0038-operator-scratch-volumes.md), [OpenShell Sandbox Driver](../../docs/reference/drivers/openshell-sandbox.md)

## Summary

Remove RuntimeClass configuration and provisioning from OpenClaw Enterprise
(OCE), including the associated Pod Security Admission (PSA) exemption. OCE
neither selects nor requires a RuntimeClass. Operators retain runtime selection
through Kubernetes and independently managed OpenShell configuration.

## Motivation

The OpenShell Sandbox Driver requires `kubernetes.runtimeClassName`, propagates
it into Sandbox and preparation workloads, and supports a per-Agent override.
OCE's development and CI setup create `openshell-sandbox` with handler `runc`
and configure an API server PSA exemption for that name. Deployment templates
also select it explicitly. This couples OCE installation to runtime selection
and API server configuration that managed-cluster operators may not control.

Earlier OpenShell network initialization requested capabilities incompatible
with restricted PSA. Current pinned OpenShell 0.1.8 renders non-root workload,
bootstrap, and supervisor containers with all capabilities dropped and privilege
escalation disabled. This proposal assumes it no longer needs that exemption;
live restricted-PSA proof must verify that assumption before delivery.

## Goals

- Deploy and run Agents without a RuntimeClass resource or OCE-generated PSA exemption.
- Remove installation-wide and per-Agent RuntimeClass fields rather than retain optional controls.
- Preserve restricted tenant PSA, per-Agent CPU/memory sizing, ownership checks,
  and existing network and filesystem enforcement.

## Non-goals

Do not configure node runtimes, add a replacement admission bypass or runtime
placement API, or change external clusters' API server configuration. Do not
claim compatibility with every container runtime. External Driver packages are
outside this proposal.

## Proposal

OpenShell is the only bundled Sandbox Driver; the shared SandboxDriver contract
has no RuntimeClass setting. Remove these OpenShell configuration properties:

- `kubernetes.runtimeClassName`
- `kubernetes.agentResourceOverrides[].runtimeClassName`

Existing closed configuration schemas reject the removed fields. Do not silently
ignore them or preserve compatibility aliases. Keep CPU/memory overrides.

The Driver stops sending `template.runtime_class_name` and Kubernetes
`driver_config.pod.runtime_class_name`, and stops setting or comparing the class
on workspace-preparation Pods. Preserve ownership and other OCE-controlled spec
checks. Keep the upstream protobuf definition intact; an upstream wire field
is not an OCE configuration capability.

Remove class defaults from paired deployment templates and shared/namespace
OpenShell setup. Remove RuntimeClass creation, class/handler requirements,
class-specific smoke assumptions, and related test inputs from development and
CI. Delete PSA exemption file generation, mounts, API server startup flags, and
probes that expect privileged Pods to be admitted. Keep useful smoke checks
against the default runtime.

OCE supplies no runtime selection. Without external selection Kubernetes uses
each node's default runtime. An independently configured provider or admission
policy can select placement; OCE does not install, validate, or override that
choice. Upstream runtime failures remain deployment failures. No new Agent
permissions, credentials, or platform resources are introduced.

If actual OpenShell workloads fail restricted PSA, record the rejection and
block completion. Do not restore the exemption or weaken tenant enforcement
silently. Earlier specifications remain historical; this proposal supersedes
RFC-0038's OCE-owned per-Agent RuntimeClass selection, not its resource sizing.

## Acceptance Criteria

- **AC-1 — Configuration removal:** Given registered bundled Drivers, class-free
  Installation configuration succeeds; either removed setting is rejected by
  structured validation. Generated Sandbox and preparation requests contain no
  OCE class selection. Existing CPU/memory override checks still pass.
- **AC-2 — Installed Agent workflow:** Given authorized operator/API credentials,
  approved images/model credentials, disposable PostgreSQL, and a loopback k3d
  cluster with no RuntimeClasses, no custom PSA exemption, restricted tenant PSA,
  and enforcing NetworkPolicies, install paired charts and deploy dedicated Codex
  and native OpenClaw Agents through the API/durable worker. Model turns, native
  workspace preparation, retry/adoption, and cleanup succeed. Inspect actual Pod
  and Sandbox specs and retain network/filesystem denial proof.
- **AC-3 — Development and CI:** Exercise both Compose-backed and Kubernetes-only
  development workflows and the owning CI preparation. They create no RuntimeClass
  or exemption file and supply no API server admission override. Run real Agent
  journeys, not only mocked launcher-command checks.
- **AC-4 — Admission remains enforcing:** In the real tenant namespace, ordinary
  privileged and forbidden-capability Pods fail PSA while actual OpenShell
  workloads are admitted. No RuntimeClass exemption or replacement bypass is present.

## Delivery and verification

[TASK-0052](../plans/0052-optional-runtimeclass.md) owns implementation order,
checks, and results. Submission permits implementation alongside RFC review,
subject to specific holds. Missing cluster, database, image, or model prerequisites
leave AC-2 through AC-4 unverified. No live proof has run for this proposal.

## Rationale and alternatives

Keeping a mandatory class preserves unnecessary coupling to a node handler and
API server exemption. Making it optional removes the default requirement but
still makes OCE own runtime selection and per-Agent placement. Full removal
matches the requested ownership boundary and deletes the obsolete exemption
rather than supporting a second admission mode.

## References

- [Pinned OpenShell chart default](https://github.com/NVIDIA/OpenShell/blob/f3d976590d3eb1379690a2abaf0f0e26c21d487d/deploy/helm/openshell/values.yaml#L491-L496)
- [Pinned workload/bootstrap configuration](https://github.com/NVIDIA/OpenShell/blob/f3d976590d3eb1379690a2abaf0f0e26c21d487d/crates/openshell-driver-kubernetes/src/driver.rs#L7406-L7594)
- [Pinned supervisor configuration](https://github.com/NVIDIA/OpenShell/blob/f3d976590d3eb1379690a2abaf0f0e26c21d487d/crates/openshell-driver-kubernetes/src/sandbox_runtime.rs#L578-L630)
