---
rfc: ../rfcs/0031-repository-worker-restart-preflight.md
---

# Implementation plan: repository worker-restart preflight

- **ID:** RFC-0031
- **Delivery status:** Planned
- **Owner:** Repository lifecycle and deployment tooling maintainers
- **Authority:** [RFC-0031](../rfcs/0031-repository-worker-restart-preflight.md)
- **Source baseline:** `e658fa14b627fc6d55c8d67a68f5668efc27397c`

## Outcome and scope

The supported upgrade helper reports repository restart risk for every retained
active revision before stopping either controller writer. The existing API
inventory obtains that assessment from the selected owner without renewing
credentials or transferring authority. Follow the RFC's four dispositions,
authorization requirements and older-server refusal; this plan does not accept
those proposed contract changes.

[TASK-0050](0050-production-deployment-tooling.md) coordinates existing deployment
tooling but explicitly leaves Driver contracts unchanged. This linked plan owns
delivery of RFC-0031's extension. Preserve TASK-0050 and RFC-0011 as historical
records. Keep the independent Harness inventory guard and repository assessment
separate. No new orchestrator, credential protocol, migration or live rollout is
included.

## Ordered implementation

1. **Expose the selected owner's read.** Add the optional operation and shared
   disposition type to the existing [Compute](../../packages/contracts/src/drivers/compute/index.ts)
   and [Sandbox](../../packages/contracts/src/drivers/sandbox/index.ts) contracts,
   using the curated top-level exports. Kubernetes Compute delegates through
   its existing `repositoryAccessContext`, preserving the read-only Namespace
   ownership GET. Cover that GET and the delegated assessment with the shared
   cancellation budget; missing or unverifiable ownership cannot return a
   positive disposition. Do not contact a credential provider or OpenShell to
   observe or adopt an execution. In the
   [OpenShell Git owner](../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts),
   share `requiresOriginalLauncher` with execution verification and use the
   [route store's read-only evidence](../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts).
   Wire that reader into API-process composition without enabling worker
   adoption, issuance or reconciliation. Absence of `repositoryCredentials`
   alone is not positive evidence when the admitted egress plan contradicts it.
2. **Produce a complete authorized assessment.** Extend
   [OCC's inventory](../../packages/occ/src/index.ts) and its
   [wire schema](../../packages/contracts/src/api/resources.ts). Snapshot the
   authorized fleet and immutable active revisions, then observe owners outside
   the State transaction with a shared bounded cancellation budget (initially
   ten seconds). Repeat the complete authorized snapshot, including newly added
   Agents and pending deployment work, and compare the selected Drivers before
   returning results. A changed fleet, denied read or incomplete observation
   cannot authorize a stop. Return only dispositions alongside revision IDs.
3. **Use the assessment before mutation.** Integrate with the existing
   [`upgrade-production-images`](../../scripts/upgrade-production-images)
   inventory/Harness preflight. Refuse unsafe, unknown or missing dispositions
   for retained revisions; refresh before the first writer stop. Preserve the
   existing partial-stop and resume evidence: recheck while the worker stop is
   still ahead. If API=0 and worker=1 makes fresh inventory unavailable, refuse,
   leave the worker untouched and report the partial stop for reconciliation of
   the existing attempt. Do not reuse stale evidence, restart the API
   automatically, submit Helm or deploy an Agent. Reassess when inventory is
   legitimately available again; never repeat an already completed worker stop.
   Keep the RFC's distinction between an empty authorized fleet and an old
   server that cannot supply the inventory. This read is not concurrent-operator
   fencing.
4. **Document the implemented boundary.** Update the existing Compute and
   Sandbox references, [repository restart guide](../../docs/reference/repository-credentials/openshell-git-restarts.md),
   [upgrade guide](../../docs/guides/deploy/production-upgrade.md), and
   [coordinated-upgrade flow](../../docs/flows/coordinated-production-upgrade.md).
   Regenerate OpenAPI and its API cheat sheet. Describe the actual authority,
   refusal and recovery behavior without promoting a disposition to proof of
   successful post-restart Git access.

## Required verification

Use existing authorized disposable PostgreSQL infrastructure with the documented
migrator and application roles, with separate API and worker instances over
the same database. Missing infrastructure remains an explicit proof
gap; a fixture that invents the owner's classification is not a substitute.
No product tests have run for this documentation change.

| Required outcome                                       | Existing integration owner and proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Status  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Complete authorized inventory                          | [API inventory case](../../tests/integration/occ-api.test.mjs): exercise the actual HTTP route, exact-resource denial, unsupported owner, and a new-Agent or authorization change during observation; reject stale results.                                                                                                                                                                                                                                                                                                                                                   | Not run |
| Accurate original-worker dependency without effects    | [Selected-repository journey](../../tests/helpers/postgres-repository-set-journey.ts) and [PostgreSQL suite](../../tests/integration/postgres-openshell-standing-selected-repository.test.ts): call the actual API while the worker and Git are healthy; compare durable custody, fence, issuance and work before/after; then perform the existing owner replacement.                                                                                                                                                                                                         | Not run |
| Positive cold re-verification and conservative unknown | [Standing-route suite](../../tests/integration/postgres-openshell-standing-route.test.ts): match durable evidence, exercise real predecessor verification, and cover preview, missing evidence, unsupported delivery and inconsistent no-repository state.                                                                                                                                                                                                                                                                                                                    | Not run |
| No stop on unsafe or stale inventory                   | [Upgrade recovery suite](../../tests/integration/production-image-upgrade-recovery.test.mjs) and [helper suite](../../tests/integration/production-image-upgrade.test.mjs): assert original replicas and no new Helm/deploy on refusal; retain safe/empty success and changed-fleet refusal. Make inventory unavailable after API=0, worker=1: resume must preserve the worker, refuse stale evidence and issue no API restart, Helm or Agent deploy. Preserve no-replay for a worker already stopped. These command-boundary fixtures do not prove live Kubernetes behavior. | Not run |

Record exact source, outcomes and fixture limits with implementation evidence.
Run proportional contract/schema/type/lint checks and the required integrations;
use the owning test inventory for CI registration. Do not claim installed
OpenShell or live-provider qualification from controlled peers.

## Decisions and completion

The RFC owners and deployment maintainers must resolve the existing inventory
permissions and older-server retention boundary before shipping. Submission
allows implementation and review to proceed together under the contribution
policy; it does not accept the RFC. Required integration results and current
reference/flow updates remain incomplete until recorded here with the final
implementation revision.

## Changelog

- 2026-11-07: Added the linked delivery plan against source `e658fa14` and RFC
  draft `42d6d0fd`; all implementation proof remains pending.

- 2026-11-07: Clarified unavailable-inventory partial-stop refusal, bounded
  Namespace ownership reads, and separate API/worker proof after plan review.
