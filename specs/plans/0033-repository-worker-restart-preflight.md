---
rfc: ../rfcs/0033-repository-worker-restart-preflight.md
---

# Implementation plan: repository worker-restart preflight

- **ID:** RFC-0033
- **Delivery status:** In progress
- **Owner:** Repository lifecycle and deployment tooling maintainers
- **Authority:** [RFC-0033](../rfcs/0033-repository-worker-restart-preflight.md)
- **Initial source baseline:** `e658fa14b627fc6d55c8d67a68f5668efc27397c`
- **Implementation candidate:** `a8047d1df49f201264fd76516535c486a39f67af` in [#5003](https://github.com/openclaw/openclaw-enterprise/pull/5003)

## Outcome and scope

The upgrade helper reports repository restart risk for every retained active,
desired-running revision before stopping either controller writer. The existing
authorized inventory obtains the assessment from the selected owner without
renewing credentials or transferring authority. Follow the RFC's four
dispositions and conservative refusal for missing assessment, including older
servers and no-repository revisions. The RFC remains Proposed; implementation
progress does not establish acceptance.

[TASK-0050](0050-production-deployment-tooling.md) coordinates existing deployment
tooling but leaves Driver contracts unchanged. RFC-0033 proposes their extension;
this plan tracks its delivery. Preserve TASK-0050 and RFC-0011 as historical records. Merged
[#5000](https://github.com/openclaw/openclaw-enterprise/pull/5000) already requires
inventory and retained Harness reads; the repository assessment remains a
separate result. No new orchestrator, credential protocol, migration or live
rollout is included.

## Implementation

1. **Expose the selected owner's read.** The optional operation and shared
   disposition belong to the existing [Compute](../../packages/contracts/src/drivers/compute/index.ts)
   and [Sandbox](../../packages/contracts/src/drivers/sandbox/index.ts) contracts,
   with curated top-level exports. Kubernetes Compute returns `unknown` without
   Sandbox delegation when repository credentials are absent but either Git plan
   field is present. When all three are absent, it checks Namespace ownership
   before reporting `not-applicable`. When repository credentials are present,
   `repositoryAccessContext` checks Namespace ownership and selects the Sandbox
   for delegation. These reads share the cancellation budget. The
   [OpenShell owner](../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts)
   shares held-launch classification with verification and uses the
   [route store's read-only evidence](../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts).
   API composition enables no adoption, issuance or reconciliation. Supported
   held/preview launches require the original worker; unsupported legacy routes
   remain unknown. No bundled owner produces `reverification-supported`.
2. **Produce a complete authorized assessment.**
   [OCC's inventory](../../packages/occ/src/index.ts) snapshots the authorized fleet
   and active revisions, observes owners outside the State transaction within a
   shared ten-second budget, then reauthorizes and compares the fleet and selected
   Drivers. Changed selections refuse the read. The existing browsing reader keeps
   a recognized unreadable historical configuration in inventory with its exact
   active ID and `unknown`, without invoking the owner. Other failures still fail
   the request. Strict writes and execution retain their validation.
3. **Use the assessment before mutation.** The existing
   [`upgrade-production-images`](../../scripts/upgrade-production-images)
   preflight refuses original-worker, unknown or missing dispositions for retained
   revisions. It refreshes the complete fleet immediately before the first stop,
   including resume while the worker still runs. If API=0 and worker=1 makes fresh
   inventory unavailable, it leaves the worker untouched and reports the partial
   stop. It does not reuse stale evidence, restart the API, submit Helm or deploy
   an Agent automatically. Already stopped workers are reconciled without another
   stop or a retrospective guarantee. Exclusive maintenance ownership remains
   required; this is not concurrent-operator fencing.
4. **Document the boundary.** The implementation updates current Compute and
   Sandbox references, the repository worker-replacement reference,
   [upgrade guide](../../docs/guides/deploy/production-upgrade.md), and
   [coordinated-upgrade flow](../../docs/flows/coordinated-production-upgrade.md),
   plus generated OpenAPI and its API cheat sheet. A disposition is not proof of
   successful post-restart Git access.

## Verification evidence

The native PostgreSQL runs use disposable databases, the documented migrator and
application roles, and separate API and worker instances. They exercise the
supported inventory caller and actual owner classification. Infrastructure
records and unrelated runtime transport remain controlled.

| Outcome                                                  | Evidence and limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Status                                                                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authenticated inventory and stale-fleet refusal          | [API suite](https://github.com/openclaw/openclaw-enterprise/blob/bd26aa1e8e43dd9c9b8bc5504344888ec7e887e9/tests/integration/occ-api.test.mjs) exercises exact-resource authorization, pending work and changed inventory.                                                                                                                                                                                                                                                                                                                 | Focused case passed at `bd26aa1e`.                                                                                                                           |
| Original-worker dependency without custody effects       | [Cold-worker journey](https://github.com/openclaw/openclaw-enterprise/blob/bd26aa1e8e43dd9c9b8bc5504344888ec7e887e9/tests/integration/postgres-openshell-standing-cold-worker.test.ts) reads the healthy original worker's disposition, compares custody/fences/issuance/work, then exercises the existing terminal replacement result.                                                                                                                                                                                                   | Native PostgreSQL: 1 pass, 0 failures/skips at `bd26aa1e`; cleanup passed.                                                                                   |
| Supported no-repository allowance and unreadable history | [Revision lifecycle journey](https://github.com/openclaw/openclaw-enterprise/blob/bd26aa1e8e43dd9c9b8bc5504344888ec7e887e9/tests/integration/postgres-worker-agent-revision-stop.test.mjs) admits and activates a no-repository revision. Ownership mismatch yields `unknown`; restoration yields `not-applicable`. Recognized unreadable history keeps its exact ID with `unknown`, while current writes and strict execution reject it. Owner state remains unchanged.                                                                  | New historical assertion failed with HTTP 503 before correction; native PostgreSQL passed afterward at `bd26aa1e`, 1 pass, 0 failures/skips; cleanup passed. |
| Refusal before stop and recovery                         | [Recovery suite](https://github.com/openclaw/openclaw-enterprise/blob/6665c7f7e3c8ef13f8d7eb8962749840ff82f6c5/tests/integration/production-image-upgrade-recovery.test.mjs) and [helper suite](https://github.com/openclaw/openclaw-enterprise/blob/6665c7f7e3c8ef13f8d7eb8962749840ff82f6c5/tests/integration/production-image-upgrade.test.mjs) cover unsafe/missing assessment, empty fleet, changed selections, API=0/worker=1 refusal, no replay and dispatch reconciliation. Generic positive input proves only consumer handling. | 66 recovery and 5 ownership cases passed at parent `6665c7f7`; not relabeled as a successor rerun.                                                           |

Both successful native PostgreSQL runs verified the same 2,350 bound non-document
inputs as `bd26aa1e`. Typecheck, lint, formatting, workspace isolation, OpenAPI and
documentation checks also passed for that candidate. Independent source review
at `bd26aa1e` closed the original finding with no open P0–P3 findings. Later
[hosted CI](https://github.com/openclaw/openclaw-enterprise/actions/runs/42788377720)
passed for implementation successor `a8047d1d`. That run does not relabel the
local proof above. The implementation remains unmerged; this RFC still needs
its own final review and hosted CI. No product tests are run solely for this
specification update.

The PostgreSQL and authenticated Fastify/OCC path are real. Kubernetes records,
Gateway/supervisor peers, workload transport and test password hashing were
controlled. This does not qualify a live cluster, installed image upgrade,
model/provider execution or cold transfer. The historical-configuration regression
does not rerun the separate migration scenario for older missing Harness settings.

## Selected tradeoff and completion

Retain the existing inventory permissions adopted by #5000. An older inventory
without `repositoryWorkerRestart` cannot authorize retention, even for a
no-repository revision. The selected paths are an explicit stop-and-settle
interruption or supported normal runtime replacement with its existing journal.
The latter still requires readable baseline Harness settings; restoring inventory
diagnostics does not make an unreadable revision eligible for runtime replacement.
A complete inventory with no retained running revisions needs no assessment.

This resolves the former proposal's authority and first-adoption questions as a
selected implementation tradeoff, not as evidence of human RFC review or
acceptance. Keep delivery In progress until the RFC and implementation are merged
and the current-reference handoff is complete. Recheck review and CI after any
further correction. Merge does not establish deployment verification.

## Changelog

- 2026-11-10: Recorded the completed `bd26aa1e` source review and `a8047d1d`
  hosted CI separately, pinned local proof links to their tested revisions, and
  clarified Compute classification and RFC contract ownership. Delivery remains
  In progress; the earlier entry below records its original review state.

- 2026-11-10: Renumbered the active RFC/plan to RFC-0033 against main `eef0b3f1`;
  aligned the selected first-adoption behavior and recorded candidate `bd26aa1e`
  proof. Final review and CI remain pending.

- 2026-11-07: Added the linked delivery plan against source `e658fa14` and RFC
  draft `42d6d0fd`; all implementation proof remains pending.

- 2026-11-07: Clarified unavailable-inventory partial-stop refusal, bounded
  Namespace ownership reads, and separate API/worker proof after plan review.
