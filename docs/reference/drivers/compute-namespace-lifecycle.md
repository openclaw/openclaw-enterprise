---
kind: reference/driver
---

# Durable Namespace lifecycle context

Implement Compute `ensureNamespace(namespace, lifecycle)` and
`deleteNamespace(namespace, lifecycle)` with the supplied
[`NamespaceLifecycleContext`](../../../packages/contracts/src/drivers/compute/index.ts).
Use it to save creation intent, immutable resource identities, and confirmed
cleanup before removing access needed by a retry. These generation checks govern
Namespace preparation and deletion.

## State and authority

OCC reserves one `namespace_lifecycle` row in the same PostgreSQL transaction
that creates the Namespace. Its lifecycle ID remains unchanged across preparation,
deletion, retries, and actor takeover. A missing row is unsupported state. An empty
revision-zero journal proves that no Driver effect was dispatched; an empty
payload at a later revision does not.

The production worker binds callbacks to the Namespace, selected Compute ID and
implementation, work ID, claim token, and current lifecycle target. Each callback
checks the PostgreSQL-clock lease and Namespace state in the same transaction
as its journal operation. Writes compare the expected revision and append
sanitized, attributable checkpoint audit evidence before commit. A stale worker
cannot read a receipt or advance it. The deterministic controller lifecycle
harness uses State transactions; it does not provide production queue-lease proof.

`read()` and `checkpoint(expectedRevision, data)` return only `{ revision, data }`.
A checkpoint resolves after commit. On an unknown commit result, stop effects and
read durable state before continuing. A returned pending observation or process
memory does not establish persistence.

## Driver-owned data

The JSON object is at most 65,536 bytes in PostgreSQL JSONB text form. Save no
credentials, bearer tokens, private keys, or raw provider responses. Core stores
opaque data; Compute owns its schema and validates its version and transitions.

Record exact target selectors and immutable resource identities before using
cleanup authority: the selected Drivers, cluster or Engine endpoint and trust
selection, physical placement, and original resource IDs. Credential rotation or
unrelated limits do not change a target. Changed selectors, replacement IDs, and
unknown payload versions require explicit refusal.

Save an attempt before creation. Save a binding only after authoritative readback
or a supported creation response. A later rejected request cannot settle an earlier
unknown request. An unknown create with absent readback must not be resubmitted:
a delayed earlier request could otherwise create again after cleanup. Bind only
supported late original readback. Do not adopt a same-name replacement from labels alone.

Kubernetes Compute delegates only the selected Sandbox Driver's child payload.
Namespace-only Sandbox context also carries `kubernetesNamespaceUid`, the original
physical UID saved by Compute. Revision cleanup keeps its revision context.
Sandbox must confirm provider cleanup and commit its child checkpoint before
removing configured Kubernetes resources or gateway access. A saved receipt can
skip provider RPCs after gateway loss, but cannot authorize deletion of a foreign
or reassigned resource. Use the saved UID and the current resourceVersion as
Kubernetes deletion preconditions, then confirm removal. A finalizer keeps cleanup
pending.

## Sandbox resource handoff

Namespace cleanup returns `kubernetesResources`. Each reference names a
namespace-scoped API version, kind, physical Namespace, and name. It records
confirmed `absent` state or an intentionally `retained` original UID. Missing,
duplicate, malformed, or cross-Namespace references refuse cleanup. Revision
cleanup returns no resource handoff.

Sandbox saves these facts in its child journal before returning them. Compute
commits the normalized result before gateway removal or its own resource sweep.
A retry reconstructs the same set. An absent reference that reappears refuses;
a retained reference excludes only its saved UID from the parent sweep. A present
replacement refuses; authorized absence requires no invented deletion. A retained
resource still present also prevents managed Namespace deletion, which would
otherwise remove it by Kubernetes cascade.

Compute checks protected references in each actual deletion snapshot. Its orphan
sweep rechecks the original Namespace UID after each list, then deletes
unprotected objects with the observed UID and resourceVersion. These checks do
not make multiple Kubernetes objects one atomic transaction.

## Partial preparation and late resources

External placement binding and claim progress are distinct. A rejected selection
that never attempted a claim can cancel while preserving the original, unclaimed
physical Namespace. A definitive first claim PATCH rejection also records no
claim effect; a later refusal or failed verification GET cannot prove this.
Changed UIDs or current foreign claims refuse. A lost claim
reply remains attempted until authorized observation confirms its outcome.

The first authoritative refusal of a configured-resource create can establish no
effect. A later refusal cannot settle an earlier unknown attempt. An infrastructure
UID checkpoint that did not commit can recover through validated lifecycle
creation metadata in the original Namespace, then commit before cleanup effects.
Absent or mismatched unknown creation remains unconfirmed.

Kubernetes Compute records the later Agent-created Namespace policy's UID or
confirmed absence before provider cleanup. Its deletion retains that original
binding through finalizer waits and refuses replacement. Repository-material
cleanup checks the saved Namespace UID after listing Secrets, before consuming
its UID/resourceVersion snapshots. A missing placement discards the snapshot;
a replacement refuses.

## Completion and recovery

Managed Namespace deletion requires removal of the original physical UID.
Externally supplied Namespaces remain present: remove owned resources, then
release only the original claim with UID/resourceVersion preconditions and a
lifecycle release witness. A lost release reply requires the same UID, the witness,
and no current claim before recording completion. Retry reads ownership even
after release commits. Operator-preprovisioned Namespace teardown remains refused.

A missing tenant Namespace never proves external provider absence. Unknown
provider creation or deletion stays unconfirmed when the provider cannot establish
the original identity and outcome. Restore the authorized target and investigate
its original resources; there is no force-completion endpoint or name-only
reconstruction path. Keep the journal with the Namespace tombstone.

See the [Namespace placement flow](../../flows/kubernetes-existing-namespace-placement.md)
for the source trace and [OpenShell testing](../../testing/openshell.md) for real
provider verification prerequisites and proof limits.
