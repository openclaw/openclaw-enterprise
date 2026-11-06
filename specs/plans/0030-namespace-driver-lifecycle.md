---
rfc: ../rfcs/0030-namespace-driver-lifecycle.md
---

# Implementation plan: Namespace Driver lifecycle

- **ID:** RFC-0030
- **Delivery status:** Planned
- **Owner:** kevinlin-openai
- **Authority:** [Proposed Namespace lifecycle RFC](../rfcs/0030-namespace-driver-lifecycle.md)
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

| Required outcome                               | Real check and prerequisites                                                                                                           | Result  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Default gateway and Workspace before any Agent | Shipped bootstrap, PostgreSQL, worker, real OpenShell on disposable loopback k3d; inspect persisted Agent count and resolved namespace | Not run |
| Later Namespace and regular Agent workflow     | API creation, distinct resources, real gateway and model turn in both Namespaces                                                       | Not run |
| Pending, refusal, worker loss and resume       | Real provider failure and worker interruption with durable PostgreSQL claims                                                           | Not run |
| IAM denial and revocation                      | Denied API creation and revoked queued actor, inspect infrastructure effects                                                           | Not run |
| Partial deletion and ownership limits          | API deletion through worker; inspect Workspace, gateway, and backing namespace                                                         | Not run |
| Selection and contracts                        | Focused composition and controller coverage, typecheck, lint, workspace checks                                                         | Not run |
| Documentation                                  | Length, specification links, docs checks, flow validator                                                                               | Not run |

The live suite requires approved images and existing model credentials, enforcing
NetworkPolicies, and administrator/migrator/application PostgreSQL roles. Missing
prerequisites do not permit replacing runtime proof with mocks or claiming
completion. Cleanup applies only to task-owned disposable resources.

## Delivery record

RFC submission, implementation, and verification are pending. No Driver contract
has changed and no runtime proof has run.

## Manual Notes

## Changelog

- 2026-11-06: Adapted the proposal and planned source-backed delivery at `ecb2973b13c1`.
