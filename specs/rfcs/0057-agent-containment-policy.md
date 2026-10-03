---
status: Proposed
---

# Proposal: Agent containment policy

- **ID:** RFC-0057
- **Owner:** OCC resource and IAM maintainers, with Sandbox and Kubernetes Compute maintainers
- **Created:** 2026-10-03
- **Last updated:** 2026-10-03
- **RFC PR:** [PR #1003](https://github.com/openclaw/openclaw-enterprise/pull/1003)
- **Current references:** [Agents](../../docs/reference/agents.md), [Sandbox Driver](../../docs/reference/drivers/sandbox.md), and [runtime security](../../docs/reference/security/runtime-isolation.md)
- **Architecture:** [Resources](../../docs/design/resources.md), [Drivers](../../docs/design/drivers.md), and [safeguards](../../docs/design/safeguards.md)
- **Delivery:** [Implementation plan](../plans/0057-agent-containment-policy.md)
- **Related:** [OpenShell hardening #919](https://github.com/openclaw/openclaw-enterprise/pull/919), [0.x egress decision](40-agent-egress-0x/index.md), and [Sandbox credential injection](39-sandbox-credential-injection.md)

## Problem and decision

An operator needs assurance that containment applies before an Agent executes and continues to apply after replacement or policy changes. Today, selecting a Sandbox Driver applies Installation-configured policy to dedicated Harnesses. The AgentRevision records its Driver ID, but no exact platform policy or trustworthy enforcement receipt. Facet declarations and Pod readiness cannot establish that boundary. The stock pinned OpenShell gateway also lacks workload projections needed for a supported production deployment.

First qualify trustworthy enforcement of the existing Installation policy through the regular Agent workflow. Then introduce the already-designed Namespace-owned `SandboxPolicy` for narrower Agent policies. For example, an operator may permit source-control access for one Agent and an external tool API for another without granting both destinations to every Agent. The second milestone delivers that distinction; it is not a prerequisite for proving the existing Installation policy.

OpenClaw Control Plane (OCC) owns admission, immutable revision snapshots, IAM and activation. The Sandbox Driver translates and enforces policy; Compute retains identity, gateway, routing, baseline isolation and cleanup. No milestone may silently fall back to an unsandboxed Harness.

## Scope and contract

Selecting a Sandbox Driver implies required containment for deployments using that Installation. This proposal adds no separate `requires containment` switch. The first qualification target is dedicated native OpenClaw on bundled Kubernetes Compute with the paired OpenShell Backend and an `openai` static CredentialSource (`credential_source` authentication). This remains a target, not supported production behavior. Session workers share the Agent's boundary; this proposal does not isolate mutually untrusted sessions within one Agent.

Dedicated Codex with CredentialSource authentication needs a separate qualification of protected app-server transport. Codex OAuth and repository credential bindings remain unavailable with a selected Sandbox Driver. Embedded and SSH execution, direct model-secret delivery, other source types, and additional providers require separate qualification. Declared facets do not expand these combinations.

### Installation ceiling and Agent policy

The Installation operator owns the maximum allowed network, filesystem and process policy in trusted Driver configuration. The first milestone freezes that policy and its translation contract into the AgentRevision, with no Namespace policy reference. There is one canonical snapshot format; no legacy fallback qualifies containment.

The second milestone adds a versioned, provider-neutral Namespace `SandboxPolicy`. Its vocabulary expresses default denial, outbound destinations and peers, readable/writable paths, user/privilege requirements and permitted capabilities. Admission rejects unknown requirements, unsupported Driver features, and policies broader than the Installation ceiling. It does not silently intersect an overbroad request with that ceiling. The Driver enforces exactly the admitted policy, including explicitly permitted runtime baseline additions. Provider settings cannot widen it.

The ceiling identity is a deterministic digest of the normalized policy loaded from trusted Installation configuration and its translation contract version; static Driver configuration has no independent generation counter. Changes take effect when the API and worker restart with that configuration. Qualification must prove that mismatched API/worker ceiling digests cannot admit or activate a revision.

Only the Installation operator may change the ceiling. Namespace administrators may manage Agent policies within it; this milestone does not delegate ceiling changes. Reading and attaching a more permissive Namespace policy therefore cannot exceed the operator's maximum. Policy create/update/delete and Agent deploy/read operations require exact IAM authorization and attributable audit records. Deployment requires `deploy` on the Agent and `read` on a same-Namespace policy. A missing policy reference in the second milestone is rejected.

The revision freezes the policy ID/generation when applicable, normalized contents and digest, ceiling digest, selected Driver ID, and translation contract version. Later policy edits affect later deployments only. A ceiling change never rewrites a revision: OCC checks whether the frozen policy still fits the current maximum during admission and reconciliation. A newly incompatible active revision must lose routing and stop executing until explicitly redeployed under an admitted policy. In the first milestone, each frozen policy equals the Installation ceiling: tightening that ceiling invalidates every active sandboxed revision admitted under the earlier ceiling. Loosening it leaves existing revisions on their narrower frozen policies until redeployment; it does not expand running workloads.

### Evidence and execution

The Sandbox Driver contract needs admission, translation, enforcement observation and suspension operations. They consume platform types and exact owner identities; they cannot grant IAM permissions, rewrite revisions or select another target. Existing provisioning and cleanup remain lifecycle operations. Enforcement before execution and evidence before activation are separate requirements.

Evidence must come through an authenticated provider control-plane interface whose trust boundary excludes the Agent workload. Workload annotations, logs, files and sandbox-authenticated RPCs cannot independently establish enforcement. A control plane merely relaying those claims is insufficient. The provider must establish that the exact instance loaded the policy before child execution and gate every restart on that condition; OCC cannot infer ordering from readiness or a timestamp.

OCC compares the provider's effective policy version and canonical digest with the expected digest of the Driver's translation of the frozen snapshot. Evidence binds the exact AgentRevision, workload instance/generation, selected Driver, translation version and policy version/digest. Baseline additions must be described by the vocabulary and included in the expected translation. Unexplained changes, including widening, fail qualification. Sandbox-originated policy changes, policy sync writes and draft approvals must be disabled or refused for contained Agents; trusted operator changes are subject to the same digest check.

At OCE's [pinned OpenShell revision](https://github.com/NVIDIA/OpenShell/blob/dde8a9a57f34f9d998618b3d35821608165c980f/proto/openshell.proto), `ReportPolicyStatus`, `ReportSandboxConfiguration` and `SubmitPolicyAnalysis` use sandbox authentication. Its [UpdateConfig validation](https://github.com/NVIDIA/OpenShell/blob/dde8a9a57f34f9d998618b3d35821608165c980f/crates/openshell-server/src/grpc/policy.rs) permits sandbox-scoped policy sync. Those signals alone do not satisfy this contract. Qualification must prove a trusted observation and mutation boundary; until then, the production path remains unavailable.

### Activation and drift

The worker rechecks actor authorization, ownership, ceiling and selected Driver before effects. Compute prepares a nonserving candidate; the Driver must enforce the snapshot before untrusted execution. OCC activates only on matching evidence and ready credential attachments. Pending evidence defers; unsupported policy or denial fails the candidate.

Each workload generation requires new matching evidence. A Pod restart, supervisor re-sync, different effective policy version, operator mutation or unobservable enforcement invalidates the prior receipt. OCC withdraws routing and the Driver must suspend or terminate execution; route withdrawal alone does not stop tools or existing connections. The provider must prevent execution during a generation change or policy reload before OCC observes it. Observation failure cannot extend an old receipt indefinitely. Recovery requires matching evidence for the current instance and policy, renewed authorization checks and normal activation. The provider's execution gate, bounded observation interval and lease expiry require qualification together.

### Resource lifecycle

Policy updates do not change active revision snapshots. Deletion is rejected while an Agent draft or a live/retiring revision references that policy; detach drafts and finish stop/retirement first. Historical retired snapshots remain self-contained and do not block deletion. Use database constraints for persisted reference invariants and exact-owner cleanup.

Revisions lacking the canonical policy snapshot/evidence are unsupported under required containment. They cannot activate or resume; reconciliation withdraws routing and stops execution rather than continuing under an inferred Installation policy. Redeployment in the first milestone freezes the Installation policy; in the second, it requires a policy reference. No dual persisted format or silent default is introduced. When this milestone ships, existing sandboxed revisions without snapshots stop and require redeployment. The API and Console must expose an attributable "redeploy required" diagnostic rather than presenting the intentional refusal as an unexplained outage; release notes must identify this behavior. Stop, retirement and Namespace deletion preserve existing exact-owner cleanup and retries, including credential revocation through `harnessResource`.

## Ownership and trust boundaries

| Owner                   | Responsibility                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| OCC                     | Policy/ceiling admission, IAM, immutable revision contents, evidence comparison, audit and activation.           |
| Compute Driver          | Identity, gateway, workload generation, baseline networking, routing and lifecycle ordering.                     |
| Sandbox Driver/provider | Exact translation, trusted enforcement evidence, pre-execution gates, drift observation, suspension and cleanup. |
| Kubernetes runtime      | Baseline isolation and separately qualified host containment; neither replaces Agent policy or IAM.              |

Network permission grants neither credentials nor OCC authority. Credential Gateway attachments remain separately authorized and must be ready before activation.

Kubernetes NetworkPolicies combine additively within Kubernetes for each direction. Traffic crossing multiple boundaries must satisfy every applicable layer and stay within the admitted policy. Qualification must identify the exact enforcement point for each traffic class:

| Traffic class                                          | Exact policy enforcement required                                                                                               | Other boundaries                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Proxied external/model egress                          | Selected provider proxy enforces admitted destination and protocol rules.                                                       | Kubernetes baseline is defense in depth; credential binding grants no network permission. |
| Direct sockets, including attempts to bypass the proxy | Provider network isolation must deny bypass or enforce the same admitted rules before packets leave the Harness.                | Broader additive Kubernetes allowances cannot establish exact Agent confinement.          |
| Harness Pod-to-Pod traffic                             | Compute compiles admitted peer rules into Kubernetes policy and verifies the union of all selecting policies cannot widen them. | Provider rules may further restrict; operator policy cannot override the ceiling.         |
| Ingress                                                | Compute enforces admitted peer/port rules through Kubernetes policy; exposed provider routes must also enforce them.            | Gateway authentication supplies identity, not a substitute for peer restrictions.         |

Qualification fails if any traffic class lacks its exact enforcement point. Current Compute TCP/443 exceptions and operator `gateway.networkPolicyResources` must be accounted for in that union. The provider cannot compensate for arbitrary direct-socket bypass merely by filtering proxied requests. The [0.x egress decision](40-agent-egress-0x/index.md) remains the authority for choosing OpenShell's proxy.

Network qualification assumes a CNI that enforces Kubernetes NetworkPolicy and the tested workload selectors. Compute can attest only the selecting namespaced policies it can read. Cluster-scoped or CNI-specific controls are outside that observation: the operator must identify and include them in qualification, including any effect on admitted traffic. An unobservable network-policy configuration cannot be claimed as confined from Compute's policy list alone.

## Delivery and verification

The [plan](../plans/0057-agent-containment-policy.md) separates evidence for Installation policy from the Namespace resource. Require real Agent workflow proof for trusted receipts, permitted/denied filesystem and network actions, pre-child refusal, credential placement, mutation rejection, restarts and observation loss. Test both Kubernetes-allow/provider-deny and provider-allow/Kubernetes-deny. Simulated providers and declared facets do not qualify production.

[PR #919](https://github.com/openclaw/openclaw-enterprise/pull/919) merged on 2026-10-03 as `f34d220290c3246d9d61c6ee4ff73696ac836161`, requiring mandatory Landlock policy compatibility and rejecting weaker Installation settings. The pinned provider already requires a mandatory capability baseline; generic unavailable-kernel refusal does not demonstrate that flag's effect. That hardening does not deliver the canonical policy snapshot, trusted evidence or a qualified production containment path.

## Rationale and alternatives

- **Retain Installation-only policy without evidence:** Smallest change, but leaves pre-execution ordering and drift unproved. Mandatory flags alone do not resolve that gap.
- **Qualify Installation policy and stop there:** Provides the essential assurance with fewer resource/IAM changes. This is the first delivery milestone and may ship independently. It cannot express different narrower policies for Agents sharing an Installation.
- **Introduce per-Agent policy and evidence together:** Delivers least privilege sooner, but ties provider qualification to a larger resource change. Prefer sequential milestones so the essential proof is independently reviewable.
- **Rely on Kubernetes policy or declared facets:** Neither establishes filesystem/process enforcement or exact proxied egress. Host isolation such as gVisor may complement the selected Driver but requires separate qualification.

## Open decisions

- **OCC resource and IAM maintainers:** Approve the minimal normalized vocabulary and ceiling administration. Unknown requirements and widening remain denied.
- **Sandbox integration maintainers:** Select a provider control-plane evidence mechanism with trusted execution ordering, mutation restrictions and bounded enforcement observation. Sandbox self-reports remain insufficient.
- **Kubernetes Compute maintainers:** Define the instance/generation mapping, observation expiry and suspension/route recovery integration. Changed or unobservable enforcement remains nonserving and nonexecuting.
- **Harness and Credential Gateway maintainers:** Qualify dedicated native OpenClaw/static OpenAI first; decide when separate Codex transport, source types and other topologies meet the same invariants.

## Current implementation boundary

Mandatory OpenShell Landlock configuration is implemented by #919. `SandboxPolicy`, ceiling snapshots and trusted enforcement evidence remain unimplemented. Today's Sandbox contract has optional `configureAgent`, `ensureNamespace`, `provisionHarness`, `harnessResource` and `readSandboxLogs` hooks plus required cleanup. `harnessResource` supplies exact Sandbox identity for credential revocation; logs are diagnostic, never enforcement evidence. Dedicated native OpenClaw requires provisioning and all three facets; selected Sandboxes reject embedded execution. Current OpenShell projection and networking limits remain in the linked references.
