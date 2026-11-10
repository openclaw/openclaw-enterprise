---
rfc: ../rfcs/0034-namespace-driver-lifecycle.md
---

# Implementation plan: Namespace Driver lifecycle

- **ID:** RFC-0034
- **Delivery status:** In progress
- **Owner:** kevinlin-openai
- **Authority:** [Proposed Namespace lifecycle RFC](../rfcs/0034-namespace-driver-lifecycle.md)
- **Source baseline:** `ecb2973b13c1a338c7b9ddbc468fca6fa8e9a848`

## Outcome and scope

Bootstrap and later Namespace creation run selected Driver setup after Compute
preparation. OpenShell creates its namespace-owned gateway and Workspace before
any Agent. Preserve the RFC's ownership, authorization, cancellation, and cleanup
boundaries. Submission permits implementation while review is pending; it does
not establish acceptance.

## Implementation

1. Submit the RFC and this plan for human review before contract changes.
2. Add shared lifecycle contracts in `packages/contracts/src/drivers/`, selected
   participant composition in `apps/controller/src/composition/`, and one runner
   in `packages/occ/src/`. Route direct controller and durable worker reconciliation
   through it. Keep durable claims and IAM gates in their current owners.
3. Extract Kubernetes Sandbox context resolution and deletion eligibility.
   Move Namespace hooks out of Compute, including existing registration hooks.
4. Extend OpenShell configuration and resource reconciliation for explicitly
   namespace-owned gateway resources. Keep operator installation, credentials,
   and selected runtime topology separate. Preserve existing operator-owned mode.
5. Extend supported bootstrap and QA Agent workflows. Register scenarios and
   inputs in QA selection, CI manifests, and applicable advisory jobs.
6. Update current Namespace and Driver references, owning worker flow, setup
   guidance, and testing documentation. Complete proportional checks and review.

## Verification

| Required outcome                               | Evidence and result                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default gateway and Workspace before any Agent | Passed: shipped bootstrap, PostgreSQL, queued worker, selected Drivers and real OpenShell; zero persisted Agents at the checkpoint.                                                                                       |
| Later Namespace and regular Agent workflow     | Later Namespace readiness and distinct owned resources passed. Agent/model-turn coverage is added; its live run is pending.                                                                                               |
| Pending, refusal and worker resume             | Zero-replica pending state, real quota refusal, and graceful worker stop/restart passed. This does not prove active database-lease loss during a provider call.                                                           |
| IAM denial and revocation                      | Denied API creation and revoked queued actor passed; no Namespace infrastructure was created for the denied work.                                                                                                         |
| Deletion and ownership                         | Partial and fully ready Namespace deletion passed; another Namespace remained healthy. Live external-namespace cleanup through the new hook path remains unverified.                                                      |
| Selection and contracts                        | 20 lifecycle conformance cases, 443 Kubernetes/SSH conformance cases, all six installed-registration cases, and five focused Sandbox startup cases passed with zero skips.                                                |
| Kubernetes fixtures                            | The three required real-cluster files passed four tests with zero skips. They do not establish Agent model execution.                                                                                                     |
| Repository checks                              | Typecheck, lint, workspace isolation, formatting, documentation links/length and flow structure passed. These are not runtime proof.                                                                                      |
| Independent review                             | GitHub Codex review of `d136156233` reported two cleanup defects and missing Agent proof. Cleanup fixes are under verification; Agent proof remains pending. The earlier local reviewer failed before producing a report. |

The live suite requires approved images and existing model credentials, enforcing
NetworkPolicies, and administrator/migrator/application PostgreSQL roles. Missing
prerequisites do not permit replacing runtime proof with mocks or claiming
completion. Cleanup applies only to task-owned disposable resources.

## Delivery record

[RFC PR #4956](https://github.com/openclaw/openclaw-enterprise/pull/4956) was
submitted at `91b1a51eb` before contract changes. Implementation is in progress
on the same assigned branch. The RFC remains Proposed.

The expanded `namespace-driver-openshell-k3d-real.test.ts` passed one real scenario
with zero failures and zero skips on 2026-11-07. An additional 45 controller/API
lifecycle checks passed after updating the foreign-scope result assertion to the
RFC's permanent-failure contract. The registered Namespace-only
QA entry point also passed two tests with zero failures and zero skips. It covers the Namespace outcomes
above without creating an Agent. Two live cleanup failures were corrected:
retry after asynchronous namespace removal must tolerate the lost tenant
RoleBinding, and PVC list entries require an explicit type for generic deletion.

On 2026-11-10, the user authorized the existing OpenShell Credential Gateway
topology for Agent/model-turn proof, with an explicit exception to the generic
projected-identity and Agent-only model-credential constraints. The test uses that
topology without changing its identity or credential contracts. The user also
authorized merging after CI becomes green. No integration waiver or RFC acceptance
is recorded; the new Agent proof and cleanup regressions still need live verification.

Current behavior belongs to [Namespace lifecycle](../../docs/reference/drivers/namespace-lifecycle.md)
and [namespace-owned gateways](../../docs/reference/drivers/openshell-sandbox/namespace-gateway.md).
The [testing page](../../docs/testing/openshell-coverage.md#namespace-bootstrap)
owns the runnable Namespace checkpoint and its limits.

## Manual Notes

## Changelog

- 2026-11-10: Renumbered to RFC-0034, the next contiguous ID on main; other open proposals also use 0034 and must be checked again before merge; added regression coverage for unavailable managed gateways and unclaimed external namespaces. Live verification is pending.

- 2026-11-07: Renumbered the unmerged proposal and plan to RFC-0031 after main assigned RFC-0030 to Harness overrides.

- 2026-11-07: Implemented shared orchestration and recorded real Namespace proof; delivery remains incomplete.
- 2026-11-06: Adapted the proposal and planned source-backed delivery at `ecb2973b13c1`.
