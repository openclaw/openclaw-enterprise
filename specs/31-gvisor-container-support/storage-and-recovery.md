# gVisor storage and recovery

[Overview](../31-gvisor-container-support.md) · [Storage interfaces](interfaces.md#storage-contract-index)

See the [2026-09-24 amendment](../31-gvisor-container-support.md#current-disposition--2026-09-24-amendment)
for release scope and changes to the historical source and storage baseline.

Disposable execution and retained replacement answer different questions.
Disposable policy identifies the revision whose temporary stores may eventually
be removed. Retained replacement must establish that the old Agent can no
longer write before a successor touches the same state. Neither condition
follows from a Pod label, a material generation or a storage access-mode name.

## Disposable admission and custody

The initial disposable store has an explicit, server-admitted **revision-owned**
lifetime. It does not claim attested physical-incarnation ownership. Admission
selects a closed storage policy without side effects and persists it in the
existing deployment transaction. Absence of stored policy never permits
disposal and never converts an Agent-retained claim into temporary storage.

The legacy Compute record and proposed storage-bearing record need strict
validation. API and State validation, immutable revision copies and the
installed PostgreSQL constraint must agree. Acceptance includes exact SQL review
and real fresh-install and upgrade checks, including rejection of unknown keys
and malformed policy. The [record shape](interfaces.md#storage-contract-index)
does not itself authorize provisioning or deletion.

Separate gateway and Harness Pods need a real shared workspace and a distinct
SQLite-compatible gateway-private store. Pod-local `emptyDir` cannot share
state between Pods. Both roles receive the workspace, while only the trusted
gateway receives private state. Secret-bearing runtime homes and credential
overlays keep their existing separation.

SQLite compatibility means reliable locking, durable writes and support for the
database and its WAL/SHM companion files. A Kubernetes access mode does not
certify those filesystem properties. The existing
[dedicated storage topology](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/docs/reference/drivers/kubernetes-compute/storage-and-credentials.md)
provides useful mounts, not the new disposable lifetime guarantee.

Before publishing any workload that mounts a claim, the existing State and
Compute owners must retain the original create plan and operation identity,
the Namespace UID and immutable confirmed PVC identities. A PersistentVolumeClaim
(PVC) names a request for storage. Its UID distinguishes that original claim
from a later object using the same name.

An unknown commit or create acknowledgment requires readback against the
original operation. Matching a name, label or desired specification alone
cannot establish original ownership. A lost create whose original UID cannot
be established remains unknown. Preserve partial receipts across restarts
instead of assuming that a failed reply rolled back an external effect.

## Disposal and unknown creates

Do not expose disposable selection until admission, creation, use and disposal
work as one lifecycle. Stop closes execution and session access. Disposal
eligibility and confirmed disposal are separate states, and the exact terminal
transition remains a Compute, State and storage owner decision. Retained stop
preserves data. Purge is a separate operation.

The disposal owner must close ordinary preparation, withdraw only the affected
revision's selected route, and stop its exact workloads before deleting stores.
For each deletion:

1. Verify the original Namespace and PVC UIDs against preserved custody.
2. Verify the full expected specification, storage profile and ownership.
3. Establish that no remaining Pod or workload template references the claim.
4. Delete conditionally against the exact observed object, preserving replacement
   objects on conflict.
5. Retain partial receipts and an immutable closed marker after completion.

Unresolved creates keep cleanup pending. A closed marker does not cancel an
earlier submitted Kubernetes create. If that request later succeeds, its owner
must retain and settle the late outcome under the original operation. A lost
delete response similarly needs readback rather than a new name-based deletion.
PVC deletion or disappearance proves no physical erasure of underlying data.

These rules prevent temporary cleanup from becoming authority to remove an
Agent-retained claim, a successor or an unrelated resource. They also preserve
truthful pending outcomes when a dependency cannot prove what happened.

## Retained writer exclusion

The retained increment preserves current files, local commits and completed
context across qualified same-build, same-cluster replacement. Persist the
whole-Agent handoff in the existing State and sole journal. That durable record
allows another worker to resume the handoff after a restart without inventing a
second authority store.

Establish predecessor stop or an independently verified fence **before the first
successor writable init, preparation, repair or restore**. A fence is evidence
that the predecessor cannot continue writing even if it is unreachable. Cover
the complete writer set:

- Gateway file access and the Harness.
- Tool children and background processes.
- Writable mappings and outstanding or unresolved creates.

Include same-revision writers as well as predecessor-revision writers when
establishing exclusive access. Unknown termination or unknown exclusion blocks
replacement. Preserve an explicit unavailable or termination-unverified result
until the owning observer can establish the required fact.

Replica counts, database pointers, storage access-mode names and Pod absence
during a partition do not prove writer exclusion. Delete acceptance, an expired
wait or an unavailable node does not prove physical stop. In particular,
ReadWriteOnce permits multiple Pods on one node and is not a single-writer
guarantee. Current prepare/activate/retire ordering cannot be credited with this
stronger pre-write property without the required join.

Repository material-generation readiness only proves the selected rollout's
material condition. It is not a retained-writer fence. The retained path must
establish exclusion independently, even after a material repair succeeds.

## Completed context and restore

Persistence and native-runtime owners must supply the actual supported shared
ReadWriteMany and private ReadWriteOnce store binding, plus a real supported
native quiet-import artifact. A dormant importer, data-transfer type or source
declaration does not establish a usable receiver, runtime image or activation
path. The exact native artifact and import interface remain
[owner decisions](interfaces.md#owner-decisions).

Completed context must come from canonical bytes and successful terminal
records in the sole journal. A checkpoint identifies the state that those
records actually commit. Restoring a directory or a draft transcript cannot
substitute for that canonical relationship.

The selected restore order is:

1. Verify the checkpoint and its completed-context artifact, including supported
   compatibility and integrity.
2. Establish exclusive successor access using the whole-Agent exclusion rule.
3. Quiet-import into a fresh, exclusively held native context. Quiet import
   reconstructs context without starting another model or tool effect.
4. Read back and compare the exact imported digest.
5. Activate under fresh authority and complete a resumed ordinary turn.

Refuse missing, corrupt or incompatible state. Fresh authority means a new
current admission for continued execution, not replay of an old credential or
invocation decision. Do not revive stale sessions merely because the recovered
bytes are valid. Gateway-only, Harness-only and combined replacement each need
qualification with this sequence.

## Continuing recovery

Continuing recovery captures actual visible writes, verifies the selected
artifact, exports it and restores supported state into a fresh store under
fresh authority. The capture owner must see writes where they actually occur,
including any writable layer that affects the supported state. Capturing an
underlying volume while relevant changes remain elsewhere does not satisfy
the promise.

Prove the recovery artifact and its compatibility with the selected runtime.
Same-build, same-cluster qualification does not establish host-loss or
changed-build recovery. Those stronger claims require separate persistence and
native-runtime qualification, including the loss window.

Preserve uncertain remote effects through capture and restore. Never blindly
repeat an uncertain model dispatch, push or PR creation. The existing Work,
journal and repository owners must resolve or retain the original outcome.
Recovery lookup is evidence about that operation and does not grant authority
to replay it. This continuation reuses the existing capture, export and native
context owners. It does not introduce a snapshot service or recovery RPC.
