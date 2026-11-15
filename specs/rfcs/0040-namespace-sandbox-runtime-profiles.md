---
status: Proposed
implementation_status: Not implemented
author: eranco74
---

# Proposal: Namespace-owned sandbox runtime profiles

- **ID:** RFC-0040
- **Created:** 2026-11-15
- **Last updated:** 2026-11-15
- **RFC PR:** Not opened
- **Implementation plan:** Not started
- **Related:** [RFC-0011](0011-coordinated-image-upgrade.md),
  [RFC-0030](0030-agent-harness-overrides.md),
  [runtime image recipe](../../deploy/runtime/README.md),
  [Kubernetes Compute](../../docs/reference/drivers/kubernetes-compute.md),
  [OpenShell image-volume request](https://github.com/NVIDIA/OpenShell/issues/5463)

<a id="problem-and-decision"></a>

## Summary

Add Namespace-owned sandbox runtime profiles. A profile selects an immutable
image digest for a dedicated Agent Harness. An Installation administrator must
approve the exact profile generation and digest for an OCE release before a team
can deploy it.

The Installation image remains the default. OCE continues to own the Gateway
image, Sandbox Driver, workload command, containment policy, credentials, and
network admission. Teams can manage their toolchain images without gaining
authority to approve executable code for the Installation.

## Motivation

Teams need their Agent Harness to use the same toolchain as local development
and continuous integration:

- CLIs such as Jira, `gh`, `kubectl`, and `helm`;
- validation tools such as `pre-commit`, `golangci-lint`, and `pytest`; and
- team-specific versions such as Go 1.26 or Python 3.13.

Today Kubernetes Compute reads `images.agent` and `images.gateway` from trusted
Installation startup configuration. Production configuration requires both
references to use immutable digests. `HarnessWorkloadRequirements.image` carries
the Installation-selected Agent image into OpenShell. Agent Configuration has no
image field, and an Agent revision does not save a team-selected runtime image.

Adding every team's tools to the OCE runtime image creates version conflicts and
couples team dependency changes to an OCE release. An unrestricted image field
would let Namespace users replace security-relevant runtime code. A profile and
an Installation-owned approval keep those responsibilities separate.

<a id="scope"></a>

## Goals

- Let Namespaces use different toolchains in one Installation.
- Let teams manage profiles while Installation administrators approve executable
  image digests.
- Save an immutable selection in each Agent revision so later profile changes do
  not change an accepted deployment.
- Preserve Sandbox filesystem, process, credential, and network enforcement.
- Report the profiles that require new approval before a runtime fleet upgrade.

## Non-goals

- Changing the controller or dedicated Gateway image per Namespace.
- Installing tools into a running Sandbox or granting network access because an
  image contains a CLI.
- Building a second signature, software bill of materials, or vulnerability
  policy engine in OCC.
- Supporting embedded OpenClaw in the initial implementation. Its Gateway and Harness
  share one image and need a separate trust and lifecycle decision.

<a id="design"></a>

## Proposal

### Namespace resource and Agent selection

Add `sandbox_runtime_profile` to the IAM resource-kind contract and add a
Namespace-owned `SandboxRuntimeProfile` resource. A team supplies these fields:

```json
{
  "name": "team-a-go-python",
  "image": "registry.example.com/team-a/oce-runtime@sha256:<digest>"
}
```

The image must be an OCI reference with an explicit SHA-256 digest. OCC owns the
profile generation and approval state, including the OCE release, runtime base,
and platform values associated with an approval.

Updating the digest advances the generation, and the new generation starts
unapproved. An earlier generation's approval remains available to revisions that
saved it until an administrator revokes that exact approval. The profile change
affects only future Agent revisions. Deletion returns a conflict while an Agent
draft selects the profile or an Agent's `activeRevisionId` points to a revision
that selected it. Historical revisions keep their saved snapshot after deletion.

An Agent has an optional `sandboxRuntimeProfileId`. Create and update validate
that the profile belongs to the same Namespace. An absent value uses the current
Installation Agent image. Native Agent Configuration remains an OpenClaw
document and gains no image field. The initial Console implementation selects an
existing profile and displays its ID and resolved digest. Profile management uses
the API or CLI. Approval uses an Installation-admin API or CLI.

### Exact-digest approval and revocation

Custom profiles are disabled by default. Installation configuration can enable
them and allow exact registry repositories or repository prefixes. Prefixes end
in `/` and match descendant path components. Matching is literal after registry
host and repository-path normalization; the initial implementation has no
wildcards or regular expressions. Profile create and update, approval, and
deployment each reject a repository that the current Installation configuration
does not allow.

An Installation administrator qualifies an image outside OCC, then approves the
exact `(profile ID, generation, image digest)` for one trusted OCE runtime base
digest and release. The approval also records the image platforms that were
qualified, approver, time, and a reference to external qualification evidence.
The controller release publishes its trusted runtime base digest and release
identity. The server reads those values from its release metadata; the approval
request cannot replace them. The administrator must retain evidence that connects
the base and resulting digests and shows a successful Harness readiness check on
every approved platform. Teams normally build `FROM` the published OCE runtime
base and preserve that relationship in the qualification evidence.

Approval is an explicit trust decision for executable code that runs with the
Harness's existing authority. Qualification must account for projected model or
repository credentials, mounted workspace data, workload identity, and admitted
network access. Cluster admission policy remains responsible for registry trust,
signatures, software bills of materials, and vulnerability requirements. Image
pull credentials remain in the existing operator-managed Kubernetes path;
profiles and OCC approval records contain none.

An administrator can revoke an approval. In the revocation transaction, OCC
marks every selected Agent revision that uses the approval unavailable for new
work and queues its running workload for stop and deprovisioning. Every OCE-owned
request path rejects a new session, turn, or operation for those revisions;
existing sessions cannot submit more work. The stop can interrupt work already
executing. Revocation therefore makes no availability promise.

Before every queued or retried attempt that can create a workload, the worker
reloads the approval saved in the revision and requires it to remain unrevoked
and to match the saved profile generation and image digest. Revocation blocks a
new attempt even when deployment admission happened earlier. An attempt that
passed this check before revocation is subject to the same stop behavior as an
already-running workload. A profile update always requires approval of the new
generation and digest.

### Authorization

The new `sandbox_runtime_profile` kind supports Namespace-scoped `create`,
`read`, `update`, and `delete` actions. Create checks the Namespace collection;
other operations check the exact profile. Agent create or update requires the
existing Agent permission and profile `read`. Deployment reauthorizes Agent
`deploy` and profile `read`.

Approval and revocation require `installation:administer` and read access to the
exact profile. Restrictions continue to override grants. Existing custom Roles
gain no permission automatically. A migration can add profile permissions only
to an unchanged built-in Administrator Role, following the existing Preset
upgrade precedent; operators must update customized or separately managed Roles.

### Revision admission and execution

Deployment resolves the profile once and requires a current, unrevoked approval
whose profile generation and image digest match. The Agent revision saves the
profile ID, generation, image digest, approval identity, OCE release, trusted
runtime base digest, and approved platform set. First-deployment intent carries
the same snapshot. A changed or deleted profile does not alter it. The saved
approval is evidence, not continuing authority: the worker performs the
revocation check above immediately before each workload-creating Compute effect.
OCE never falls back to the Installation image after selection or admission
fails.

Kubernetes Compute requires a dedicated Harness with a provisioning Sandbox
Driver. It intersects the approval's platform set with existing workload
placement and adds the corresponding `kubernetes.io/os` and
`kubernetes.io/arch` constraints. An empty intersection fails before workload
creation. It passes the saved digest through
`HarnessWorkloadRequirements.image`; the dedicated Gateway and supporting jobs
keep their Installation-selected image.

OCE and OpenShell provide the workload command, non-root identity, mounts,
read-only root filesystem, and Sandbox policy outside team-managed image
metadata. Startup succeeds only after the OCE- and OpenShell-owned Harness
readiness and identity checks pass. Image-pull or readiness failure fails the
deployment and does not trigger fallback.

A custom image adds no grants, but its code can exercise all authority already
available to the Harness, including projected credentials, mounted workspace
data, workload identity, and admitted network destinations. Installation
approval accepts that inherited authority for the exact image digest. Teams
should place tools below `/opt/team-tools`, retain the published runtime user's
UID and GID, and leave OCE paths, `ENTRYPOINT`, and `CMD` unchanged. These are
image qualification rules that the administrator verifies before approval.

OpenShell network grants continue to use the kernel-resolved executable identity.
A standalone binary such as `gh` uses its resolved executable path. For
`python3.13 -m pytest`, the interpreter owns the connection, so the policy names
the canonical Python executable. Teams use OpenShell denial evidence when
authoring rules; a profile approval grants no network access.

### Release, upgrade, and rollback lifecycle

This RFC extends the operator workflow in
[RFC-0011](0011-coordinated-image-upgrade.md). The existing
`scripts/upgrade-production-images` caller gains one read-only target-release
preflight. From the reviewed immutable release receipt, it reads the target
runtime base digest and reports selected profiles and Agent revisions referenced
by `activeRevisionId` that lack an approval for that base and release. It does not
approve images, rebuild them, create revisions, or orchestrate rollback.

A controller-only upgrade does not rewrite profiles or Agent revisions. Before a
runtime fleet upgrade, teams publish new digests and Installation administrators
approve the corresponding profile generations for the target release. The normal
RFC-0011 runtime path then creates Agent revisions with those saved approvals.
Rollback uses a previously approved profile generation and digest for the
selected earlier release. The workflow preserves Agent storage, identities, and
secrets and makes no zero-downtime promise.

## Acceptance Criteria

- **AC-1 — Namespace toolchain selection:** Given two Namespace members with
  profile and Agent permissions, two administrator-approved digest-pinned images,
  and a disposable enforcing Kubernetes/OpenShell environment, each member
  selects their Namespace profile and deploys through the ordinary Agent API.
  Each Harness reports only its selected Go or Python version and runs its
  validation command. Verify with an integration test that records the profile,
  digest, Pod image ID, command output, and Namespace for both Agents.
- **AC-2 — Approval and IAM boundaries:** Given an ordinary Namespace member and
  an Installation administrator, attempts to select a cross-Namespace profile,
  approve without `installation:administer`, deploy an unapproved or revoked
  generation, or bypass a Restriction are denied without workload creation or
  fallback. Approval evidence identifies the Harness credentials, mounts,
  identity, and network authority inherited by the image. Verify with API
  integration cases and attributable audit records for each denial and for one
  successful exact-digest approval.
- **AC-3 — Immutable revision and revocation behavior:** Given a deployed Agent,
  updating its profile advances the generation and leaves the new generation
  unapproved. The earlier revision retains its saved digest and approval
  snapshot. A worker attempt succeeds while that saved approval remains active.
  Revoking it blocks queued attempts and retries, denies new work on a serving
  Harness, and stops its workload; a request already executing can be
  interrupted. Verify with persistence, worker, and native-request integration
  tests that compare revision records, first-deployment intent, dispatched image
  digests, request denials, workload termination, and audit events.
- **AC-4 — Platform and runtime failure:** Given real multi-platform manifests,
  approved platform subsets, and constrained cluster nodes, deployment schedules
  only on an approved OS and architecture. Empty placement intersection, image
  pull failure, and failed Harness readiness each fail without fallback. Verify
  with installed-runtime cases that capture admission results, Pod placement,
  image-pull events, and readiness status.
- **AC-5 — Executable-specific network policy:** Given the selected OpenShell
  version and a profile containing a standalone binary, a symlink, and
  `python3.13 -m pytest`, denial evidence identifies the executable identity used
  for policy. A rule for that identity permits only the intended request; profile
  approval alone permits none. Verify with OpenShell policy events and successful
  and denied requests through the deployed Harness.
- **AC-6 — Upgrade and rollback:** Given active profiles for the current release
  and a reviewed target-release receipt, preflight reports every profile and
  current revision without target-base approval and changes no state. After
  approval, runtime upgrade and rollback use their respective saved digests while
  preserving PVCs, identities, secrets, and historical revisions. Verify with a
  disposable production-shaped upgrade run and its RFC-0011 evidence directory.

## Delivery and verification

A separate implementation plan must define the API, CLI, IAM and built-in-Role
migration, persistence, Console selection, audit events, Driver changes,
placement, approval workflow, and RFC-0011 preflight extension. It must map
integration and installed-runtime evidence to AC-1 through AC-6.

Final proof requires an enforcing disposable Kubernetes cluster, the selected
OpenShell version, real digest-pinned images, and the ordinary Agent deployment
path. Documentation, source inspection, fixtures, and mocked registries do not
prove installed-runtime outcomes.

<a id="rationale-and-alternatives"></a>

## Rationale and alternatives

**Automatic base-image ancestry validation** appears stricter but OCI manifests
do not provide a trustworthy parent relation, and later layers can replace base
files. Exact-digest administrator approval makes the trust decision explicit and
reuses RFC-0011's release-approval model.

**Installation-wide custom images** preserve current control but force unrelated
teams onto one dependency set and turn a team tool update into a fleet change.

**A raw image field in Agent Configuration** mixes native OpenClaw settings with
platform workload selection and gives no reusable ownership, approval, or
revision snapshot boundary.

**OCI image volumes** keep the OCE runtime image unchanged and mount a read-only
tool artifact at a fixed path. They could support relocatable toolchains without
a complete runtime variant. Kubernetes image volumes are stable from Kubernetes
1.36, but OpenShell does not currently expose caller-specified image volumes.
OpenShell issue [#5463](https://github.com/NVIDIA/OpenShell/issues/5463) tracks
that dependency. An artifact-backed profile can reuse the Agent selection and
revision snapshot model if that dependency becomes available.

**An init container and writable volume** supports older clusters but copies
content into mutable storage and adds ownership, cleanup, capacity, and
verification behavior. A sidecar or remote execution service changes CLI
process, filesystem, and workspace semantics.

## References

- [Current Installation and Agent Configuration boundary](../../docs/reference/configuration.md)
- [Runtime image build and provenance](../../deploy/runtime/README.md)
- [Image approval and immutability](../../docs/reference/security.md#image-approval-and-immutability)
- [Sandbox executable-path policy](../../docs/reference/sandbox-policies.md#authority-and-admission)
- [Agent revision Harness settings](0030-agent-harness-overrides.md)
- [Kubernetes image volumes](https://kubernetes.io/docs/concepts/storage/volumes/#image)
