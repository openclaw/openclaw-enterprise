---
rfc: ./index.md
---

# Proposal amendment: retain durable cleanup through OCC participants

This amendment adapts [RFC-0035](index.md) to main's
[Namespace Driver lifecycle](https://github.com/openclaw/openclaw-enterprise/blob/8b0d0518cb8786253d9632ae4beb8a75758a2e61/specs/rfcs/0035-namespace-driver-lifecycle.md), introduced at
`8b0d0518cb8786253d9632ae4beb8a75758a2e61`. It remains Proposed. Submission
permits implementation in parallel with review; it does not establish acceptance,
completed implementation, or genuine provider proof. Original decisions and
submission links remain in the parent; implementation plan 0027 remains the owner.

## Orchestration and journal ownership

OCC retains main's selected-registration orchestration: Compute prepares backing
infrastructure, then selected hooks run in registration order; deletion runs
participant cleanup before Compute teardown. Registration identity, cancellation,
evidence, authorization and final live-claim checks remain in their current owners.
Compute must not dispatch the Sandbox again internally.

Rename the durable callback type to `NamespaceLifecycleJournal`, leaving main's
common `NamespaceLifecycleContext` with its immutable Namespace and signal. The
journal retains lifecycle identity, target, read and compare-and-checkpoint
callbacks. State still checks claim liveness using the database clock, saves
checkpoints with attributable audit evidence in one transaction, and rejects
stale callers. This amendment requires no database-schema migration. It adds no
compatibility adoption, provider-specific core payload, or terminal-work checkpoint.

An invocation-scoped composition binding factory receives the exact Compute
journal and creates the Sandbox hook adapter for that invocation. Do not store
that journal in mutable controller or worker state. Generic Driver hooks retain
their current public context; this amendment makes no new durability guarantee
for unrelated third-party hooks.

Compute exposes a Namespace-bound resolution containing its restricted Sandbox
child context, any committed generic cleanup result, and an awaited callback
that validates and saves a returned result. The selected adapter first obtains
this resolution under the current placement and selected-Driver binding. If no
completion is saved, it awaits Sandbox cleanup and then the callback before
reporting participant completion. A lost callback acknowledgment requires a
read of durable state before another effect. A saved result permits receipt-based
retry; it is not authority to adopt a replacement or skip current identity checks.

Compute deletion eligibility uses this same journal and original Namespace UID;
omitting journal authority must not provide a weaker path. Keep proven no-effect
cancellation, partial preparation, original-Terminating retry behavior, retained
external claim-release witnesses and preprovisioned teardown refusal. Compute's
final deletion consumes the saved generic absent/retained references and refuses
missing required confirmation. The actual parent sweep still protects against
reappearance and uses observed UID/resourceVersion preconditions.

## Namespace-owned gateway and storage

Extend the Sandbox child inventory to cover configured gateway resources and
its generated signing Secret. Keep private keys and provider responses out of
the journal. Record an attempt and creation marker before effects, bind original
UIDs from authoritative responses/readback, refuse drift and replacements, and
preserve the existing persisted payload bound. Configured Secrets retain their
original initialization and provider-managed values; retries must not rotate keys.

StatefulSet-generated PVCs require a finite inventory derived from admitted claim
templates and replicas before the producer starts. Bind original claim UIDs
before provider readiness. Template markers alone do not establish that the
producer has stopped: final tail absence also requires supported evidence of
producer quiescence so delayed creation cannot outlive completion. Do not adopt
current-label LIST results, delete replacement claims, infer an unconfirmed
creation from absence, or widen the payload bound. Unexpected or unprovable
claim origin/quiescence leaves cleanup incomplete. Confirm this protocol against
actual Kubernetes controller behavior before relying on it; the exact recovery
boundary for partial StatefulSet creation remains an implementation proof gap.

No PV, external mount or underlying storage erasure authority follows from this
inventory. Keep those retention boundaries distinct from deleting an original
Namespace-owned PVC.

Confirm the original Workspace/provider removal and commit that evidence before
removing gateway workload, Service, signing Secret or storage that can make the
provider unreachable. A durable never-attempted provider stage permits cleanup
of exact original infrastructure; an attempted or unknown stage does not.
Unlike main's initial gateway implementation, no Ready Pod, recognized transport
outage, or absent Namespace is evidence of provider completion. Without saved
confirmation, loss of the endpoint remains fail-closed. This is an explicit
stricter failure outcome; there is no force-completion path.

## Implementation and proof

1. Adapt the production worker and deterministic OCC harness to supply the same
   durable authority through the new orchestration; adapt all Compute callers.
2. Move Sandbox dispatch to the invocation-scoped binding and test receipt commit,
   unknown acknowledgment, missing receipt, binding drift, claim loss and protected
   references through the actual lifecycle owner. Preserve revision stop/retirement.
3. Extend gateway inventory with actual supported SDK/Kubernetes resource creation
   and controller-origin evidence. Cover partial setup, delayed storage creation,
   restart, replacement and finalizer waits; never fabricate a producer barrier.
4. Select proportional real PostgreSQL/caller regressions for changed composition,
   perform independent integration review, and update owning reference/flow only
   with implemented behavior. Genuine OpenShell/model/bare-endpoint/live-SSH proof,
   prior guarded review gaps, security disposition and RFC review remain separate.
