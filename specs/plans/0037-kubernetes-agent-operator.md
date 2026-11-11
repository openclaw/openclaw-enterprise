---
rfc: ../rfcs/0037-kubernetes-agent-operator.md
---

# Implementation plan: Deploy Agents through Argo CD

- **ID:** RFC-0037
- **Delivery status:** Planned
- **Authority:** [Kubernetes Agent Operator proposal](../rfcs/0037-kubernetes-agent-operator.md)
- **Source baseline:** `61b0fb0`

## Outcome and scope

After administrator bootstrap, a user commits supported custom resources and
Argo CD creates, updates, observes and prunes the corresponding Enterprise
resources. No local sync runner is part of this path. Deliver the RFC's
[acceptance criteria](../rfcs/0037-kubernetes-agent-operator.md#acceptance-criteria)
through the regular Agent workflow. This document plans work; no Operator or
CRD has been implemented, installed, or tested.

Human OAuth consent, Installation-selected Drivers, credential creation outside
approved imports, and general IAM provisioning remain separate prerequisites.
Native Telegram qualification is an independent dependency for its live-channel
case. Preserve the current running installation while developing this feature.

## Owners and source touchpoints

| Owner                  | Proposed work and existing integration                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public contracts       | Extend curated exports and API schemas under `packages/contracts/src/`; regenerate OpenAPI and its cheat sheet from those schemas.                                                                                   |
| OCC resource lifecycle | Extend `packages/occ/src/index.ts`, repositories and reviewed PostgreSQL constraints for management ownership and recoverable apply/update/release. Reuse provisioning and the work queue.                           |
| HTTP application       | Integrate real routes in `apps/controller/src/http/` and composition; preserve exact operation authorization and sanitized errors.                                                                                   |
| Operator               | Propose `apps/operator` within the selected TypeScript/pnpm workspace. It consumes the HTTP API and Kubernetes watches, never OCC repositories or runtime Driver internals. Placement needs maintainer review.       |
| Packaging              | Add opt-in Operator/CRD Helm packaging under existing `deploy/` conventions, namespace-scoped RBAC, service identity and leader Lease. Keep CRD upgrades explicit.                                                   |
| Documentation          | Update architecture implementation status only when delivered, layout/workspace inventory, current references, an Operator flow, operator guide and Argo setup. Register each current page once in `docs/docs.json`. |

## Ordered implementation

### 1. Settle and submit the architecture

Review the four kinds, Connection trust boundary, management ownership, retention
defaults and proposed workspace extension. Reserve the RFC number again against
current main before publication/merge. Submit this RFC for human review before
changing required Driver behavior. No Driver contract change is currently
proposed; discovery of one requires revising the owning RFC first. Do not treat
drafting as approval. Implementation is authorized separately by the user.

### 2. Add managed-resource lifecycle through the API

Define typed apply, read, operation recovery and release contracts, request
limits, management-version conflicts and source registration. Specify authority
rotation and immutable target identity. Add database-enforced uniqueness and
ownership references rather than discovering resources by display name.

Reuse `provisionAgent` and its durable result for creation. Extend normal
Configuration/Agent update and deployment admission to settle one accepted
desired state, including authorized dependencies and Harness settings. Recover
uncertain external effects without blindly reissuing writes. Add server-enforced
managed-field conflicts, audited suspension/release and deletion completion.
Keep direct Console, CLI and worker callers on the same owning lifecycle.

### 3. Add the Operator and declarative schemas

Implement Connection, Namespace, Secret and Agent controllers with structural
schemas and CEL reference immutability. Start with one supported alpha version;
do not add a conversion webhook without a second served representation.
Define effective-input canonicalization and dependency version tracking.

Watch dependencies, use optimistic status writes, elect a leader, and implement
rate-limited reconciliation. Set API deadlines, retry limits, observation-age
limits and progress reasons in the supported contract. Resolve lost status
through server ownership receipts. Expose no secret values or secret-derived
digests. Protect approved input Secret keys with exact-name reads and RBAC.

Resolve `nativeAdmin` through existing server preparation. Support both ready
credential-source references and consent-required status. Never implement a
headless workaround for personal ChatGPT consent. Keep dedicated runtime model
credentials out of the Gateway and Telegram tokens out of the Harness.

### 4. Package the real Argo workflow

Provide CRD/Operator installation, scoped credentials, supported upgrades,
Connection trust configuration, Application ordering, health Lua and examples.
Health must reject stale generations and dependencies, handle stopped intent,
and avoid claiming an API receipt proves readiness. Give prune clear retain,
delete, dependency ordering and blocked-finalizer behavior. Runtime workload
ownership remains with OCC.

The first runnable example must create a separate Agent and approved token
binding in a disposable tenant. It must not adopt, replace, or stop the current
Telegram agent as a side effect of installing the Operator.

After disposable-cluster proof, back up the explicitly selected existing Agent
and exercise administrator-authorized adoption by exact IDs. Stop its previous
Git reconciler, verify configuration generations and credential references,
and transfer management without changing its serving revision. Then exercise
Argo-driven settings update and native Telegram before/after behavior. Retain
the prior desired state and reconciler for a reviewed ownership release rollback.

## Required verification

All rows are **not run**. Document checks on this proposal are not product proof.
Use [enterprise-testing](../../.agents/skills/enterprise-testing/SKILL.md) and
[test-audit](../../.agents/skills/test-audit/SKILL.md) when implementing tests.
Register TypeScript integration tests in the CI lane that actually runs them.

| Outcome                      | Required real integration                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable apply and conflicts  | Production HTTP application with PostgreSQL; repeat requests, drop responses after accepted writes, restart processes, exercise stale versions, ownership collisions and privilege withdrawal.                             |
| Git commit to running Agent  | Disposable enforcing Kubernetes cluster, Helm-installed OCC/worker/PostgreSQL, Operator, real Argo CD and reachable test Git repository. Commit CRs and inspect OCC resources, generated workloads and current health.     |
| No duplicate effects         | Repeat sync, restart the Operator, erase status, rotate its service key and delay a former leader's request. Inspect persisted management receipts and revision counts, not mocked return values.                          |
| Secret delivery and rotation | Privately supplied test token and model credential, exact projection isolation, denied cross-tenant and unapproved-key reads, effective rotation and runtime behavior after reconciliation.                                |
| Native Telegram and OAuth    | Authorized real bot and operator-sent message before/after update; unauthorized sender refusal. Human consent through the supported login, same-Namespace grants, revocation and sanitized pending status.                 |
| Prune and stopped intent     | Argo removal with Retain/Delete, unavailable API during cleanup, still-referenced Secret, DeleteEmpty refusal, stopped desired state and audited emergency stop. Confirm finalizers and actual retained/deleted resources. |

Fixture-only success does not establish a genuine model turn, Telegram delivery,
Argo reconciliation or enforcing NetworkPolicies. Provision the disposable
database and cluster using the existing [Kubernetes test setup](../../docs/testing/kubernetes.md).
Keep credentials private and remove only the test-owned resources.

## Review decisions and dependencies

- Platform maintainers: approve the component/workspace boundary and API group.
- Lifecycle/IAM maintainers: review management authority, exact grants, safe stop,
  apply receipts and resource retention before the corresponding implementation.
- Runtime owners: select qualified immutable images and observation signals.
  A partial native-channel implementation cannot satisfy live-channel proof.
- Operator implementers: document concrete retry and staleness limits, package
  the Argo health checks and supply required genuine integration evidence.

## Delivery record

Design draft prepared. Public submission, implementation and the selected live
Agent adoption are now authorized. Record actual publication, runtime changes
and verification below as they occur; authorization is not delivery evidence.

The RFC exceeds the 1,500-word review threshold and stays below the 2,500-word
limit. It remains one document because ownership, credential handling and
cleanup define one Operator contract. Execution steps and proof are separate
in this plan.

## Manual Notes

## Changelog

- 2026-11-11: Added the RFC-linked delivery plan and required integration proof.
