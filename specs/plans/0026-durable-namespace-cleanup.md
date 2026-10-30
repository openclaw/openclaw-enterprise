---
rfc: ../rfcs/0026-durable-namespace-cleanup.md
---

# Implementation plan: durable Namespace cleanup

- **ID:** RFC-0026
- **Delivery status:** In progress
- **Owner:** @russellb
- **Authority:** [RFC-0026](../rfcs/0026-durable-namespace-cleanup.md)
- **Source baseline:** PR #4088 at `bfef7f0d5f8091390d5ec8296d0be4cd5bb5faaa` and main `330073017`.

## Outcome and scope

Keep the full repair in [PR #4088](https://github.com/openclaw/openclaw-enterprise/pull/4088).
Namespace deletion must preserve exact preparation bindings and persist confirmed
provider cleanup before destroying provider access. Follow the RFC's failure,
ownership, and lease requirements. Revision stop/retirement ownership checks stay
in place. No model execution, force-completion API, or general journal subsystem
is included.

## Contract and source touchpoints

- `packages/contracts/src/drivers/compute/index.ts`: required Namespace lifecycle
  context and checkpoint types; export public types through the top-level index.
- `packages/contracts/src/drivers/sandbox/index.ts`: restricted Namespace-only
  child context for preparation/cleanup and required generic Namespace cleanup
  result; retain revision cleanup semantics.
- `packages/occ/src/state/{platform-state,postgres-state,postgres-schema}.ts` and
  the existing schema/migration owner: Namespace lifecycle repository, constraints,
  revision CAS, and in-memory adapter invariants.
- `apps/controller/src/worker.ts`: construct the journal callbacks using State
  transactions and current queue claims; preserve existing finalization/audit.
- `packages/occ/src/index.ts:handleNamespaceLifecycle`: adapt the deterministic
  direct caller and its conformance tests consistently.
- Kubernetes Compute owns placement/inventory and delegates Sandbox state;
  OpenShell owns Workspace binding, confirmed provider removal, and exact
  Kubernetes resource deletion. Docker/SSH/memory Compute implementations adapt
  to the same contract without provider-specific core behavior.

## Ordered implementation

The cleanup-result amendment was submitted in documentation-only commit
`ef2cf007043819118c83fd8339496a92bcab9fb3` with an
[explicit human-review request](https://github.com/openclaw/openclaw-enterprise/pull/4088#issuecomment-6524582605).
RFC status remains Proposed; implementation and review proceed in parallel.

Both contract submissions precede implementation. Keep the PR draft and its
security/runtime holds until the amended behavior is proved.

1. Submit RFC-0026 and this plan in an initial documentation-only commit on
   PR #4088. Record submission SHA and explicit human-review comment URL below.
   Do not change Driver contracts before that submission.
2. Verify pinned OpenShell operation replay semantics. Define versioned
   Compute/Sandbox payloads, exact selectors, immutable IDs, creation nonces, and
   the explicit unconfirmed outcomes. Do not depend on name-only conditional
   deletion or undocumented provider tombstones.
3. Add the Namespace journal repository and database constraints. Create the
   lifecycle identity atomically with Namespace creation/audit/enqueue, before
   dispatch; implement claim-checked read/CAS in the
   same State transaction using the database clock. Test rollback, unknown commit,
   stale token, takeover, CAS conflict, and payload limits against PostgreSQL.
4. Wire real worker callbacks, generic Driver contracts, and direct conformance
   harness. Persist original bindings during preparation before ready. Reject
   unbound existing state and selector drift explicitly. Distinguish never-attempted,
   attempted/unknown, and bound stages; deletion before first ensure and during
   partial preparation must not invent IDs or turn uncertainty into absence.
   Preserve initial operator-owned preparation under the exact preprovisioned
   Namespace UID: bind observed existing Workspace/resource immutable IDs after
   selected-target, ownership and approved-policy checks, before readiness.
   Never use that authority to adopt an earlier controller creation attempt.
   No silent compatibility
   state or provider-specific core branches.
5. Implement staged Kubernetes/OpenShell teardown. Await persisted provider
   confirmation before the configured Kubernetes tail or Gateway/Namespace
   deletion. Read original resource identities, delete with UID/resourceVersion
   preconditions, and confirm absence. Exercise retry after finalizer waits,
   external claim loss, reassignment, and worker restart. Retain externally supplied
   Namespaces and release only their exact OCC claim with an atomic release witness
   and UID/resourceVersion preconditions. Test lost release replies and committed
   release retries. Keep preprovisioned automatic-teardown refusal unchanged.
   Require a validated generic Sandbox cleanup result before the parent sweep:
   confirmed-absent references refuse any reappearance; intentionally retained
   original references exclude only their saved UID. Persist these Namespace-bound
   facts before parent effects and test replacement after child cleanup, not only
   while its tail is pending. Do not inspect a provider's private child schema.
6. Extend the existing real OpenShell development installation case using an
   owned disposable cluster, private kubeconfig, isolated database, and official
   provider. Build this worktree's CLI. Test missing Namespace and foreign or
   replacement Workspace/resources through ordinary API/worker operations.
   Separately exercise tenant-local gateway loss after durable confirmation.
7. Vet the Agent preparation-failure scenario: remove only the owned OpenShell
   Sandbox-creation RoleBinding after Workspace readiness; normal deployment must
   create actual runtime-provider resources before real RBAC refusal and no
   Harness/model execution. Only then request stop/retirement and observe exact
   cleanup through the worker. If the required state is not reached, report the
   missing proof rather than substituting a fake component or successful model
   result. Any synthetic source is fixture input, never model-authentication proof.
8. Update Compute/Sandbox references, operator recovery, worker/provisioning flows,
   database entities cheat sheet, and affected test setup/CI selection. Run
   proportional checks and independent implementation review. Keep the PR draft
   until the material security and real-provider proof holds are resolved.

## Verification

| Required outcome                                                      | Check and prerequisites                                                                                                    | Result                         |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Cancel before first ensure and during partial/failed preparation      | Namespace creation with atomic initial journal; actual worker cancellation before dispatch and after an attempted creation | Not run                        |
| Original bindings survive uncertain create and commit                 | PostgreSQL plus real Driver boundary with distinct replacement IDs and a saved intent                                      | Not run                        |
| Live claim alone writes/consumes journal                              | Real PostgreSQL queue claims, expired/lost lease, takeover, concurrent finalization; database-clock checks                 | Passed against PostgreSQL 18.6 |
| Confirmed cleanup survives lost acknowledgment/restart                | Worker with PostgreSQL; interrupt after commit before teardown, then restart                                               | Not run                        |
| Tenant-local gateway disappears only after durable receipt            | Disposable Kubernetes/provider case with actual tenant-local service routing                                               | Not run                        |
| Foreign/reassigned resources survive                                  | Real Workspace identity and Kubernetes UID/resourceVersion refusal, including retry                                        | Not run                        |
| External Namespace remains after successful cleanup and release retry | Real retained external Namespace, conditional claim-release witness, lost reply and worker restart                         | Not run                        |
| Missing placement still removes owned provider resources              | Real API/worker/OpenShell development installation, with generated private kubeconfig                                      | Not run                        |
| Revision stop/retirement uses real caller and provider                | Supported Agent preparation failure with observed provider inventory and no Harness execution                              | Not run                        |
| Unsupported or permanently lost provider evidence fails closed        | Provider response/operation-replay boundary; do not accept bare absence                                                    | Not run                        |

Component qualification passes: six real PostgreSQL/worker journal cases cover
atomic reservation, CAS/restart, actual lease takeover, lock order, audit rollback,
and a lost real COMMIT reply. The canonical migration/native-catalog and logical
restore qualification passes 41 cases. Kubernetes controlled-SDK cases cover
partial preparation, unknown creates, original UIDs, external release reply loss,
parent handoff, and post-list replacement; they are not live cluster proof.
OpenShell controlled-provider and pinned wire cases, Docker conformance, and SSH
actual local-helper fixtures exercise their respective ownership boundaries.
Targeted guard-removal mutants fail the corresponding ownership/lease assertions.
The genuine Kubernetes/provider rows above remain unrun.

Current tools include a Podman-backed engine, k3d, kubectl, Helm, PostgreSQL
client, OpenSSL, Go, Node, and pnpm. Existing shared contexts and containers are
out of scope. The full OpenShell CI lane requires model credentials and is not
a substitute for the narrowly selected cleanup proof. The first frozen-source
owned-stack attempt rolled back before cleanup scenarios: runtime-image layer
commit exhausted available engine storage. No live cleanup result is claimed.
Further real builds require available authorized capacity; shared resources remain
untouched.

## Review repair

The initial frozen implementation is `922a031ef91f6dc14329034f50964752757ec29b`.
The canonical eight-pass P2 review produced findings with **incomplete** coverage:
unchanged queue, transaction, reconciliation, and supplier context was unavailable
in individual evidence batches, and genuine runtime proof was absent. It is not
a clean review result.

Repairs distinguish never-claimed external selection from unknown claims, recover
attempted infrastructure bindings only through creation metadata, preserve the
later Agent-created Namespace policy, and record definitive first configured-resource
creation refusals. SSH uses explicit HostKeyAlias verbatim. An additional actual
Compute/RepositoryMaterialStore reproduction exposed a placement change during
Secret listing; the Namespace caller now fences the snapshot before deletion.
A delayed-create reproduction also exposed repeat requests after unknown outcomes.
Namespace, Gateway, infrastructure, and OpenShell resource stages now refuse a
second create on absent readback; matching creation metadata can bind the late
original. Bound infrastructure updates carry original UID/resourceVersion.
Focused regressions exercise the real Driver/Store and controlled transports;
they do not replace the pending owned-stack proof or complete independent review.

The follow-up P2 review of `bb90801` against main `7db24e009` returned all
32 passes with **incomplete** coverage. It found one invalid real-test fixture:
the external physical Namespace name exceeded OpenShell's 19-character limit.
The corrected name has 17 characters; the actual Backend validator rejects the
old name and accepts the replacement. This input check is not a live-stack result.
Remaining context gaps include Kubernetes `resolveNamespace`, `getOwned`,
`reconcile`, and `request`, surrounding Worker dispatch/finalization, and production
changes absent from individual evidence batches. No clean-review claim is made.

## Delivery record

- Both RFC submissions precede contract code. Implementation and component qualification are in progress; genuine provider proof and independent review remain pending.
- RFC submission: documentation-only commit `536e71d95bf39797f2b60048cb3677e879ed046b`; [explicit human-review request](https://github.com/openclaw/openclaw-enterprise/pull/4088#issuecomment-6523250103). Decision status remains Proposed.
- Implementation PR: [#4088](https://github.com/openclaw/openclaw-enterprise/pull/4088), draft with existing proof/security holds.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-30: Draft the Namespace journal, connected implementation, and proof plan against the source baseline above.
