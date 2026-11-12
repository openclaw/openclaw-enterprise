---
rfc: ../rfcs/0037-kubernetes-agent-operator.md
---

# Implementation plan: Deploy Agents through Argo CD

- **ID:** RFC-0037
- **Delivery status:** In progress
- **Authority:** [Kubernetes Agent Operator proposal](../rfcs/0037-kubernetes-agent-operator.md)
- **Source baseline:** `72884ff`

## Outcome and scope

After administrator bootstrap, a user commits supported custom resources and
Argo CD creates, updates, observes and prunes the corresponding Enterprise
resources. No local sync runner is part of this path. Deliver the RFC's
[acceptance criteria](../rfcs/0037-kubernetes-agent-operator.md#acceptance-criteria)
through the regular Agent workflow. The alpha implementation covers existing-resource references, reviewed Agent
adoption, versioned apply and Retain release. Creation, Secret import/rotation
and Delete cleanup remain unimplemented.

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

The table lists the full target proof, not completed acceptance. API, PostgreSQL
and scoped Kubernetes SDK cases have passed locally. Live Argo adoption,
Git updates, stopped intent and Retain prune/re-adoption have also passed;
running-state Operator restart and a Git settings rollback have passed. A real
model turn and native Telegram outbound delivery passed before and after the
rollback. The user also confirmed a reply to their Telegram input after
restoration. Document checks are not product proof.
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

Public draft [PR #5500](https://github.com/openclaw/openclaw-enterprise/pull/5500)
submitted by `uggy-ug` before implementation. The first alpha adds the four CRDs,
namespace-scoped Operator/chart, exact-ID adoption, exclusive management,
versioned apply receipts, emergency-stop suspension and Retain release. See the
[current contract](../../docs/reference/kubernetes-agent-operator.md).

Local proof: three production API/IAM cases, one PostgreSQL API/persistence case
and one real Kubernetes SDK/Lease/TLS/identity case passed without skips. A
populated backup upgrade preserved Agent/revision/Namespace counts; fresh and
logical-restore catalog differences were measured. An existing local installation
then verified Argo Git polling, exact-ID adoption without a new revision,
a configuration update reaching deployment, and Degraded status when the
selected runtime failed its provenance gate. Git stopped intent removed all
runtime Pods. Retain prune and fresh reviewed re-adoption preserved the Agent,
Configuration and revision count. Stopped verification exposed the runtime API
rate limit; reads now wait 600 milliseconds between revisions and completed
against a populated history.

Matching, qualified immutable runtime images restored the live Agent after
completed offline Doctor maintenance on backed-up, stopped node state. Protected
OpenShell maintenance had refused process-group cleanup; unattended runtime-state
upgrades under that restriction remain unqualified. No process-signal boundary
or provenance gate was weakened.

The live workflow then reached Argo Synced/Healthy with the requested revision
active and fresh ready Pods. A Git settings rollback produced exactly one new
Configuration generation and revision. Genuine model turns returned unique
markers and native Telegram reported one successful outbound delivery before
and after rollback. Running-state Operator restart preserved the source,
management receipt and revision count. The Telegram bridge remained scaled to
zero. The user confirmed that the bot replied to their Telegram input after
restoration; this is user-reported inbound proof.

This proof exposed that current Gateway configuration/authentication/connectivity
diagnostics describe Slack. The Operator now requires those checks only when
Slack is configured; held startup failures still block readiness. The same live
revision became Ready without a new receipt or deployment. The real Kubernetes
SDK case passed again after the correction. Required native image checks at the
final PR head, independent review and maintainer feedback remain merge requirements.

The RFC exceeds the 1,500-word review threshold and stays below the 2,500-word
limit. It remains one document because ownership, credential handling and
cleanup define one Operator contract. Execution steps and proof are separate
in this plan.

## Manual Notes

## Changelog

- 2026-11-11: Added the RFC-linked delivery plan and required integration proof.
