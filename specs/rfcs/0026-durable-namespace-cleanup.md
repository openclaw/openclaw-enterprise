---
status: Proposed
implementation_status: Not implemented
author: russellb
---

# Proposal: persist Namespace cleanup before removing its provider access

- **ID:** RFC-0026
- **Created:** 2026-10-30
- **Last updated:** 2026-10-30
- **RFC PR:** [PR #4088](https://github.com/openclaw/openclaw-enterprise/pull/4088)
- **Implementation plan:** [RFC-0026 plan](../plans/0026-durable-namespace-cleanup.md)

## Summary

Add a durable, Namespace-scoped lifecycle journal to the existing Namespace
primitive. The worker supplies claim-checked checkpoint callbacks to Compute;
Compute delegates only its Sandbox-owned portion to the selected Sandbox Driver.
A Driver must await persistence of confirmed provider cleanup before it removes
any resource that can make that provider unreachable. Retried deletion can then
use the saved confirmation after the tenant gateway or Namespace disappears.
Core stores the journal and enforces its transaction boundaries. Drivers own
resource identity, provider confirmation, and their journal payloads.

## Problem and current behavior

The production [worker](../../apps/controller/src/worker.ts) calls
`ComputeDriver.deleteNamespace` and later commits lifecycle observation and queue
completion. [Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts)
first calls Sandbox cleanup, then deletes the Gateway and execution Namespace.
Neither `NamespaceDeleteResult` nor the Namespace repository retains intermediate
cleanup evidence. `ControllerWork.resultData` is a terminal result, not a journal.

[PR #4088](https://github.com/openclaw/openclaw-enterprise/pull/4088) requires
Sandbox cleanup after Namespace loss. Its Namespace path also makes normal
asynchronous deletion retry provider cleanup after the Namespace is gone. An
OpenShell Backend with bare `serviceName` resolves inside that tenant Namespace,
so its gateway can disappear before this retry. Accepting absence would restore
false completion; requiring another provider call can strand confirmed cleanup.

The proposal also addresses configured OpenShell Kubernetes resources currently
deleted by name. Labels alone do not protect a replacement between a read and a
delete. The relevant contracts are [Compute](../../packages/contracts/src/drivers/compute/index.ts),
[Sandbox](../../packages/contracts/src/drivers/sandbox/index.ts), and the
[OpenShell client](../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts).
This is a new Namespace lifecycle decision, not a revision of the historical
[repository credential recovery decision](0015-repository-credential-recovery.md).

## Outcomes and scope

- Normal deletion completes after provider confirmation has been saved, including
  worker restart, lost checkpoint acknowledgment, and tenant gateway loss.
- Namespace absence alone never confirms external cleanup.
- Original placement and dependency identities survive preparation and deletion
  retries. Foreign or replaced resources cause refusal before their deletion.
- Claim loss prevents the stale worker from saving or obtaining journal authority.
- Existing Namespace authorization, audit, retry ownership, and cancellation apply.

This RFC adds no force-completion endpoint, provider-specific core branches,
model execution, general journal framework, or compatibility adoption of resources
without the required durable identity. Existing development state without a
binding fails explicitly; it is not reconstructed from names or labels.

## Contract and ownership

Extend Compute `ensureNamespace` and `deleteNamespace` with a required
`NamespaceLifecycleContext`. Its proposed surface is:

```ts
interface NamespaceLifecycleContext {
  readonly lifecycleId: string;
  readonly target: "ready" | "deleted";
  readonly signal: AbortSignal;
  read(): Promise<NamespaceLifecycleCheckpoint>;
  checkpoint(
    expectedRevision: number,
    data: Readonly<Record<string, unknown>>,
  ): Promise<NamespaceLifecycleCheckpoint>;
}

interface NamespaceLifecycleCheckpoint {
  readonly revision: number;
  readonly data: Readonly<Record<string, unknown>>;
}
```

These callbacks are bound by construction to one Namespace and selected Compute
Driver ID and implementation; the Driver cannot select another scope. The
64-KiB JSON payload contains no credentials, bearer material, private keys, or
provider response text. Core does not interpret provider names or phases.
Compute versions and validates its payload, including any selected Sandbox
Driver ID/implementation and a restricted child payload. Sandbox Namespace
preparation and cleanup receive that child checkpoint context. Revision cleanup
keeps its revision-scoped context and existing completion requirement.

The checkpoint returns only after its State transaction commits. Returning
`namespaceDeleted: false`, updating process memory, or returning a payload in a
Driver result cannot substitute for that awaited commit.

## Durable identity and preparation

Create `occ.namespace_lifecycle` with a Namespace foreign key, immutable
`lifecycle_id`, Compute ID/implementation, journal revision, JSON data, and
State-clock timestamps. Create its initial empty intent in the same transaction
as Namespace creation, the create audit, and work enqueue, before any dispatch. This lifecycle identity survives both work keys: Namespace preparation
and deletion are separate claims, but refer to the same Namespace incarnation.
A deletion retry or authorized actor takeover does not mint a new identity.
An absent journal is unsupported state, never proof that no effects occurred.

Each preparation stage starts as **NEVER-ATTEMPTED**. Compute checkpoints
**ATTEMPTED/UNKNOWN** before issuing a creation effect; **BOUND** follows only an
authoritative response or supported readback of that attempt. The initial
revision-zero journal proves
that no Driver effects were dispatched. A never-attempted stage needs no
nonexistent resource ID and can be skipped during deletion. Before a creation RPC,
checkpoint its attempt identity and nonce; a lost response remains unknown until
supported readback or replay establishes the exact binding. Missing IDs in an
attempted stage must not be interpreted as no resource. Once bound, use only the
saved immutable identity. Deletion while provisioning or failed resumes these
stage records, including cancellation before the first ensure claim. An in-flight
creation during cancellation remains attempted, not never-attempted; no later
creation step starts after deletion is observed.

Drivers record exact effect selectors and immutable resource identities:
cluster endpoint and trust selection, control/execution plane, Kubernetes
Namespace name and UID, selected Drivers, provider endpoint and Workspace ID,
and configured resource kind/name/UID. Configuration values unrelated to these
targets, such as limits or rotated credentials, do not invalidate cleanup.
Changed selectors, unknown payload versions, absent required IDs, or mismatched
incarnations fail explicitly.

Before creation, save a unique creation intent/nonce. Kubernetes creates carry
that nonce and ownership metadata; readback must match it before an observed UID
is bound. Provider creation uses an operation identity only where its supported
protocol establishes replay identity. An uncertain creation response must not
fall back to adopting a same-name replacement. Preparation cannot report ready
until the binding checkpoint commits. Unknown commit outcomes are resolved by
reading the same journal, not by repeating an unbound create.

## Deletion protocol

1. Under the live deletion claim, load the saved binding, check current selected
   Drivers and effect selectors, and persist deletion intent. Validate any
   observable Namespace incarnation before provider or Kubernetes effects.
   A missing Namespace does not discard its saved binding.
2. The selected Sandbox Driver verifies the original provider identity and
   removes its owned resources. It confirms provider removal through the actual
   provider protocol, then awaits its child checkpoint **before** deleting any
   configured Kubernetes resource or gateway access path.
3. Kubernetes cleanup reads each saved resource, checks ownership and the saved
   UID, and deletes using UID and current resourceVersion preconditions. A
   changed/reassigned object is refused. Readback must confirm removal; a
   finalizer leaves cleanup pending. An API error is not absence.
4. Compute saves completion of dependency cleanup before Gateway/Namespace
   deletion. A retry can skip completed provider RPCs only when the durable
   receipt and its exact binding match. It must still refuse a current foreign
   or replacement Kubernetes Namespace or configured resource.
5. For a Compute-managed Namespace, delete only the saved UID, with the observed
   resourceVersion precondition, and confirm physical removal before returning
   `namespaceDeleted: true`. For an externally supplied Namespace, retain the
   physical Namespace: complete only after owned-resource removal and exact claim
   release. A preprovisioned operator-owned Namespace keeps its existing automatic
   teardown refusal; a journal grants no additional deletion authority.
6. External claim release first saves its intent, including Namespace UID and
   original ownership. A UID/resourceVersion-conditional patch removes only this
   OCC claim and writes a release witness containing this lifecycle ID in the
   same atomic patch. If its reply is lost, an authorized read of the same UID
   must show that witness and no current OCC claim before checkpointing release.
   Bare missing labels are not confirmation. A different UID, owner, or witness
   is a refusal. Once release commits, a retry checks current UID/ownership and can
   complete without mutating the retained Namespace. The witness cannot authorize later mutations
   or removal of a new owner's resources.
7. The worker commits logical Namespace deletion, policy removal, attributable
   audit, and queue completion through its existing path. Keep the journal with
   the Namespace tombstone; no receipt garbage collection is introduced here.

For previously created resources, original bindings remain necessary even after
Namespace loss.
A newly supplied external Namespace can be claimed only when no live OCC
Namespace already reserves it, preserving the existing database uniqueness rule.
For an external Namespace with missing OCC claim labels, use neither its name as
authority nor unconditional configured-resource deletes. Refuse an observable
foreign/reassigned incarnation. Only saved owned identities and confirmed
removal can complete cleanup; unresolved ownership stays incomplete.

## Claims, transactions, and uncertain outcomes

Each production journal read/write validates the exact work ID, claim token,
unexpired lease using PostgreSQL time, current Namespace lifecycle state, and
Compute binding in the **same** State transaction. A write uses journal revision
compare-and-swap. Lock the claim and Namespace in the repository's established
order; no separate lease read followed by an unfenced write. Journal changes and
sanitized lifecycle audit evidence commit together. A stale claim cannot record
or consume confirmation. The successor resumes the saved lifecycle with its own
live claim, never the predecessor's claim token.

The existing worker heartbeat supplies cancellation. Drivers check cancellation
and current authority before consequential effects. An in-flight external call
can outlive cancellation; exact supported effect preconditions remain necessary.
The deterministic `handleNamespaceLifecycle` conformance harness must use the
same State-backed checkpoint contract without claiming to prove production
leases. In-memory, Docker, and SSH implementations adapt explicitly; implementations
without external dependencies still checkpoint their own exact cleanup boundary.

If checkpoint commit is unknown, do not remove gateway access. Read the journal
again under current authority; a committed matching confirmation is usable, an
absent one is not. A crash after persistence but before teardown safely resumes
from the saved receipt. A crash before persistence does not manufacture one.

OpenShell currently generates a fresh `request_id` for each Workspace call.
Its name-only deletion RPC has no generation precondition. Stable request IDs
may recover a lost provider acknowledgment only after the pinned supplier's
replay guarantees are verified. Bare `NOT_FOUND` or `ALREADY_ABSENT` cannot prove
an unrecorded deletion after provider state loss. If authoritative replay is
unavailable, preserve an explicit unconfirmed state and the reachable authority;
do not infer completion. This read guard does not claim atomic protection against
an adversarial provider-side replacement between read and delete.

## Delivery and evidence

The [plan](../plans/0026-durable-namespace-cleanup.md) connects the contract,
PostgreSQL repository, real worker, selected Drivers, documentation, and tests.
Required proof includes successful and unknown checkpoint commits, restart and
lease takeover, target drift, original versus replacement IDs, configured
Kubernetes resource preconditions, and a bare tenant-local gateway disappearing
after a committed provider receipt.

Extend the existing model-free
[OpenShell installation test](../../tests/integration/dev-up-openshell-k3d-real.test.mjs)
for real API/worker/PostgreSQL/Workspace cleanup after Namespace loss. A supported
Agent preparation failure may exercise actual provider creation and subsequent
stop/retirement without inference; its prerequisites and reached state must be
observed before claiming proof. Controlled fixtures do not clear the existing
real-provider/security hold. No runtime proof has been run for this RFC.

## Alternatives and remaining protocol verification

Persisting terminal work results is too late: resource teardown already happened.
An in-memory receipt does not survive restart. Banning tenant-local gateways
removes currently supported placement. Treating absent resources as confirmation
loses the security boundary. A generic journal service expands the change beyond
its Namespace owner.

Before implementation depends on supplier replay, verify OpenShell's pinned
create/delete admission semantics, including returned results after replay and
state loss. If they cannot establish exact confirmation, that branch remains
fail-closed and must be documented and tested as such. RFC submission permits
implementation to proceed under the existing contribution policy; acceptance
and removal of PR #4088's proof hold remain separate decisions.
