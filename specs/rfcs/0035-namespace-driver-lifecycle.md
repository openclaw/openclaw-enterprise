---
status: Proposed
implementation_status: Implemented
author: kevinlin-openai
---

# Proposal: Run Driver setup for every new Namespace

- **ID:** RFC-0035
- **Created:** 2026-11-06
- **Last updated:** 2026-11-10
- **Implementation plan:** [Namespace Driver lifecycle](../plans/0035-namespace-driver-lifecycle.md)
- **Related:** [Namespace lifecycle](../../docs/reference/namespaces.md),
  [Sandbox contract](../../docs/reference/drivers/sandbox.md),
  [closed Installation lifecycle proposal](https://github.com/openclaw/openclaw-enterprise/pull/176)

## Summary

OpenClaw Control Plane (OCC) must run selected Drivers' Namespace setup through
one lifecycle, outside Compute. Compute prepares backing infrastructure first.
OCC then calls each registered `ensureNamespace` hook and marks the Namespace
`ready` only when every required step succeeds. This applies to bootstrap's
`default` Namespace and every Namespace created later through the API, CLI, or
Console. Hooks run in asynchronous reconciliation and tolerate repeated calls.

With OpenShell selected for namespace-owned gateway setup, reconciliation must
create and start the actual OpenShell gateway and create its owned Workspace
before any Agent exists. Installation-wide operator prerequisites remain
separate from those namespace-owned resources.

## Motivation and current behavior

[Installation bootstrap](../../scripts/bootstrap-installation.mjs) and API creation
share `OpenClawController.createNamespace` in [OCC](../../packages/occ/src/index.ts).
It saves a `provisioning` Namespace and queues work. The
[worker](../../apps/controller/src/worker.ts) asks Compute to ensure the Namespace.
[Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts)
invokes `ComputeLifecycleHooks.afterNamespacePrepared` and
`SandboxDriver.ensureNamespace` internally. Another Compute implementation must
reproduce this dispatch, and other capabilities have no common setup contract.

[OpenShell](../../apps/controller/src/drivers/sandbox/openshell.ts) currently
applies or verifies configured workspace RBAC and network policies, checks an
existing gateway, and creates the Namespace-owned Workspace. Its configured
`operatorWorkspaceResources` allow ServiceAccounts, Roles, RoleBindings, and
NetworkPolicies, not gateway workloads. Existing
[real Kubernetes fixtures](../../tests/helpers/openshell-kubernetes-real.mjs)
install the gateway with Helm before reconciliation. Moving dispatch alone
therefore cannot prove that bootstrap creates the gateway.

OpenShell's `workspaceMode: managed` is explicitly unimplemented. This proposal
retains supported operator Workspace topology and adds explicit namespace-owned
gateway resources; it does not enable OpenShell's managed Workspace mode.

## Scope

- Use one lifecycle for default and subsequently created Namespaces.
- Register setup once per selected Driver registration, independently of its
  capabilities or Compute implementation.
- Preserve IAM authorization, tenant isolation, durable claims, cancellation,
  retries, and cleanup.
- Deliver OpenShell gateway and Workspace creation through that lifecycle and
  continue into the regular Agent workflow.

Installation-wide install/update/uninstall events, Driver hot replacement,
automatic initialization of already-ready Namespaces, and managed OpenShell
Workspace mode are outside scope. Restarting bootstrap does not recreate a
deleted `default` Namespace. Namespace hooks create no Agents or model credentials.

## Proposal

### Registration contract and composition

Add optional `namespaceLifecycleHooks` to
[`DriverRegistration`](../../packages/contracts/src/drivers/index.ts), exposing
`ensureNamespace(context)` and optional `deleteNamespace(context)`. The common
context contains the immutable logical Namespace and operation `AbortSignal`.
Hooks return the existing `NamespaceEnsureResult` and `NamespaceDeleteResult`
shapes, including the exact Namespace ID, completion, and failure classification.
Move shared result types from Compute into a common lifecycle contract and export
public types through the package's top-level index.

Composition collects selected registrations once per registration, even for
multiple capabilities. Unselected registrations do not participate. Missing
hooks mean no setup requirement; invalid advertised hooks prevent startup.
Invoke participants sequentially in stable registration-ID order. Hooks may
depend on prepared Compute infrastructure, but not on another registration's
effects. Coordinated effects belong in one registration; no dependency scheduler
is added.

### Reconciliation and readiness

1. Bootstrap or authorized creation saves the Namespace and queues work atomically
   with existing audit evidence, without external effects in the transaction.
2. The worker claims work and reauthorizes its original actor through selected IAM.
3. Compute prepares and verifies backing infrastructure. Pending or failure stops
   the pass before participant hooks.
4. OCC invokes selected hooks. An incomplete hook stops the pass; later hooks wait.
5. OCC commits `ready` only when Compute and every participant complete for the
   correct Namespace, the claim remains live, and the saved Namespace permits it.
   Agent deployment retains its `ready` gate.

The worker and direct controller reconciliation use the same runner. Neither can
bypass participants. Bootstrap remains possible before provider services exist.

### Sandbox context and Compute boundaries

The Sandbox registration adapts its current setup and Namespace-only cleanup to
common hooks. Composition supplies a resolver through the explicit
`ComputeDriver.resolveSandboxNamespaceContext(namespace, signal)` contract,
extracting Kubernetes Compute's private `sandboxNamespaceContext` behavior.
The resolver returns `SandboxNamespaceContext` with resolved runtime placement,
the selected cluster client, and the supplied signal. It performs no provisioning
or cross-Driver dispatch.

Keep logical Namespace identity separate from runtime placement: logical
`default` must resolve to its owned Kubernetes namespace, not Kubernetes' built-in
`default`. Preserve managed, explicitly selected external, and supported
split-cluster ownership checks. A Sandbox that needs the resolver with an
incompatible Compute selection fails composition.

Clients and credentials stay in composition and adapters. OCC sees common hooks
and results, with no OpenShell-specific branches. The resolver cannot broaden
client authority or select another tenant's placement.

Remove nested Sandbox Namespace dispatch from Kubernetes Compute. Move Namespace
members of `ComputeLifecycleHooks` into registration lifecycle hooks. Workload
start/stop hooks remain with Compute. Port existing implementations without a
second Namespace dispatch path.

### OpenShell gateway ownership

Add explicit OpenShell configuration for namespace-owned gateway manifests,
separate from existing operator-owned workspace resources. Driver configuration
owns image selection, gateway settings, Service, workload, persistence, identity,
and network policies. Composition validates the supported resource kinds and
rejects conflicting ownership modes. The manifests use the resolved backing
namespace and carry exact logical Namespace ownership. Resource reconciliation
must refuse foreign ownership before updating or deleting resources.

The OpenShell adapter first reconciles those gateway resources, then checks
Service and workload readiness and gateway health, then creates or observes the
owned Workspace through the real gateway API. Repeated reconciliation preserves
one Workspace. Operator-owned gateway configuration retains verification-only
behavior; selecting namespace-owned setup must not silently fall back to it.

The Driver creates a private gateway signing key per Namespace, separate from
Agent and model credentials. Other gateway Secret templates are create-only;
retries verify their initial values and preserve provider-managed fields.
It retains that key across retries and removes it
after owned gateway teardown.

Cluster-wide CRDs, RuntimeClasses, operator installation, approved images, and
controller credentials remain explicit installation prerequisites. Tests may
prepare these prerequisites but must not install the namespace-owned gateway,
create its Workspace, or pre-mark the Namespace ready. Model credentials belong
only to their existing Agent-owned execution boundary.

### Failure, cancellation, cleanup, and evidence

Keep existing retry and attempt limits. Pending or retryable setup leaves the
Namespace `provisioning`; permanent failure or exhausted work follows the current
failed transition. Preserve permanent Sandbox refusals, including provider
authorization refusal. Sanitize unexpected exceptions under the worker's retry
policy. Invalid result scope is a permanent contract failure.

Pass claim cancellation to every hook. After claim loss, start no further hooks
and commit no success. Effects can precede cancellation, so hooks must be
idempotent under overlapping retries. Each retry rechecks Compute and participants;
there are no per-hook success receipts or exactly-once guarantees.

Keep partially prepared resources for retry or explicit deletion. Do not
compensate automatically when a later hook fails. After Agent cleanup, authorized
Namespace deletion invokes participant cleanup in reverse order before Compute
removes backing infrastructure. Pending or failed cleanup blocks completion.
Adapt Sandbox Namespace-only cleanup; leave revision cleanup on its existing path.
Remove owned Workspaces before a reachable gateway. If a namespace-owned gateway
has no ready Pod or a recognized transport outage, remove its owned resources
without the Workspace RPC. Provider authorization refusals still block cleanup.
Cleanup tolerates absent and partial resources, retains operator-owned
infrastructure, and preserves deletion prohibitions.

Compute exposes a side-effect-free deletion eligibility check. OCC runs it before
participant cleanup so a prohibited deletion cannot remove provider resources
first. For a never-claimed external backing namespace, eligibility can return
`skipParticipantCleanup: true`; OCC skips provider hooks and lets Compute retain
external resources while removing only its own gateway. Preserve ownership checks
again at each consequential mutation.

Record participant registration ID, phase, and sanitized outcome in operation
evidence, attributed to the originating actor and Namespace. Exclude credentials,
provider responses, and foreign tenant identifiers. Hooks cannot grant IAM
permissions or mark the Namespace ready.

## Delivery and verification

Submit this proposal for human review before contract implementation. The
[implementation plan](../plans/0035-namespace-driver-lifecycle.md) tracks work and
proof separately from the RFC decision. Required evidence:

- Bootstrap a fresh Installation through shipped bootstrap, real PostgreSQL,
  queued reconciliation, selected Kubernetes Compute, and selected OpenShell.
  Before creating an Agent, assert zero persisted Agents, actual gateway readiness
  and health in default's resolved backing namespace, and the owned Workspace.
  Then deploy an Agent and complete a model turn.
- Create a second Namespace through the API, verify distinct owned resources and
  readiness, then run its Agent workflow.
- Exercise pending setup, provider refusal, and actual worker interruption. Verify
  blocked readiness, ownership-preserving retries, and successor recovery without
  duplicate Workspaces.
- Deny creation and revoke authorization before dispatch; verify no hook effects.
- Delete partial resources and verify provider cleanup before infrastructure
  removal, including external-namespace and operator ownership limits.
- Verify dispatch once per multi-capability registration and explicit refusal of
  incompatible Compute/Sandbox composition.

Extend the [QA Agent workflow](../../tests/integration/qa-matrix-real.test.mjs),
installation/bootstrap coverage, and PostgreSQL worker coverage. Register cases
in QA selection and CI. Run on an explicitly disposable loopback k3d cluster with
enforcing NetworkPolicies and separately provisioned PostgreSQL administrator,
migrator, and application roles. Use authorized runtime images and credentials.
Mocks and test-created gateway resources do not satisfy this proof. Missing
infrastructure remains a delivery gap; no integration waiver applies.

Update owning Namespace, Driver, worker-flow, and testing documentation with code.
Current references continue to describe current behavior until implementation.
Source findings are from `ecb2973b13c1`; no runtime verification is claimed.
RFC-0035 remains provisional until merge. The repository
requires renumbering against the current base before merge.

## Rationale and alternatives

Compute-local dispatch repeats participant rules in each implementation. Bootstrap
hooks miss later Namespaces. Creation-transaction hooks hold database transactions
across provider work and require infrastructure during bootstrap. Requiring tests
to install gateways would preserve current topology but would not deliver
namespace-owned initialization.

The shared lifecycle reuses queued work, authorization, and state transitions.
Registration-level hooks prevent duplicate setup for multiple capabilities.
Explicit OpenShell resource ownership makes gateway creation and cleanup part of
the real Namespace lifecycle without adding provider branches to OCC.
