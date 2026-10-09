---
rfc: ../rfcs/0019-agent-containment-policy.md
---

# Implementation plan: Agent containment policy

- **ID:** RFC-0019
- **Delivery status:** Planned; #919 foundation hardening merged, containment milestones unimplemented
- **Owner:** OCC resource and IAM maintainers, with Sandbox and Kubernetes Compute maintainers
- **Authority:** [RFC-0019](../rfcs/0019-agent-containment-policy.md) and the [platform design](../../docs/design.md)
- **Source baseline:** Initial plan: `main` at `8193ad3ca`, including merged #919. Implementation planning follow-up: `main` at `cb6783fae`; current qualification refresh: `main` at `bb7d2a110` (2026-10-07).

## Outcome and scope

First prove enforcement of the existing Installation policy through the regular Agent deployment workflow. Then add narrower Namespace-owned policies beneath the operator's ceiling. Selecting a Sandbox Driver implies required containment; no extra enable switch is proposed. RFC-0019 owns the exact trust, drift, lifecycle and traffic-class requirements.

The first qualification target is dedicated native OpenClaw on Kubernetes with the paired OpenShell Backend and an OpenAI static CredentialSource. Dedicated Codex with CredentialSource auth now has an experimental provider-file and bearer-passthrough path; production transport and containment qualification remain separate. OAuth, repository credentials, embedded/SSH execution and other source types remain unavailable in this milestone. No qualifying production path exists today.

Gateway sharding, capacity scheduling, `OpenShellSandboxClass`, multi-cluster placement and fleet rollout changes are deferred. This work keeps the existing deployment-paired OpenShell gateway. Namespace policy delivery follows qualification of Installation enforcement; it is not part of the first implementation slice.

## Contract and source touchpoints

OCC owns policy/ceiling authorization, canonical immutable snapshots and receipt comparison. The worker rechecks authorization, owner and selected Driver. Sandbox owns translation, trusted observation and execution gates; Compute owns identity, generation, routing and lifecycle. Extend the [Sandbox contract](../../docs/reference/drivers/sandbox.md), [Agent deployment](../../docs/reference/agents.md) and [OpenShell flow](../../docs/flows/openshell-sandbox-provisioning.md) through their real callers.

| Owner                         | Current source and planned change                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts and composition     | [Public contracts](../../packages/contracts/src/index.ts) and [Installation composition](../../apps/controller/src/composition/installation-config.ts): define admitted policy, trusted observation and suspension requirements, then validate selected Driver capabilities. Export public types through the existing entry point. |
| Admission and persistence     | [Agent provisioning](../../packages/occ/src/agent-provisioning.ts), [provisioning state](../../packages/occ/src/state/agent-provisioning.ts) and [PostgreSQL schema](../../packages/occ/src/state/postgres-schema.ts): freeze canonical policy contents at revision admission and enforce persisted invariants.                    |
| OpenShell integration         | [Backend](../../apps/controller/src/backends/openshell.ts), [Sandbox Driver](../../apps/controller/src/drivers/sandbox/openshell.ts) and [gateway client](../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts): translate and apply policy, authenticate evidence and stop exact owned execution.                |
| Reconciliation and activation | [Worker](../../apps/controller/src/worker.ts) and [Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts): compare evidence, track workload identity, gate activation and withdraw routes on failure.                                                                                                  |
| Credential lifecycle          | [Credential Gateway](../../apps/controller/src/drivers/credential-gateway/openshell.ts): retain exact revision/Sandbox attachment and revocation through refusal, suspension and retirement.                                                                                                                                       |
| Operator diagnostics          | [Agent HTTP routes](../../apps/controller/src/http/agents.ts) and [Console Agent detail](../../apps/controller/src/console/agents/detail.mjs): expose actionable refusal and redeployment diagnostics without leaking credentials.                                                                                                 |

Keep provider RPCs and translated policy details inside the OpenShell integration. Extend existing contracts through composition and their regular callers; introduce no independent containment controller or inheritance hierarchy. Exact public signatures and persisted representation remain subject to the RFC owners' decisions below.

## Implementation

### Foundation already merged

[PR #919](https://github.com/openclaw/openclaw-enterprise/pull/919) merged as `f34d220290c3246d9d61c6ee4ff73696ac836161` on 2026-10-03. Mandatory Landlock configuration and rejection of weaker settings are implemented; its validation belongs to that PR. This prerequisite does not qualify the evidence or Namespace policy milestones.

### Step 1: Qualify the provider mechanism

- [ ] Sandbox maintainers qualify the existing isolated OpenShell supervisor and configuration admission at the current provider pin. Prove credential isolation, effective policy identity, baseline additions, generation binding and policy-before-child ordering. Use gateway interceptor bindings to reject widening and workload-authored proposals while permitting exact admitted supervisor synchronization.
- [ ] Harness and Credential Gateway maintainers qualify the requested identity and credential boundary. Codex already uses runtime provider files, an app-server verifier and bearer passthrough; the local profile disables projected identity and rejects explicit requests it cannot preserve. Its workspace-node setup envelope is development-only. Native OpenClaw still requires a supported path without its verification bridge.
- [ ] Compute maintainers define instance/generation mapping, observation lifetime, suspension acknowledgement and recovery. Enforcement must expire or stop at the provider even when OCC cannot reach it; removing a route alone does not stop outbound Agent work.
- [ ] Prepare a disposable enforcing Kubernetes cluster, compatible Landlock kernel, migrated PostgreSQL database with a limited application role, immutable runtime images and existing authorized model credentials. Follow [OpenShell testing](../../docs/testing/openshell.md), [Kubernetes testing](../../docs/testing/kubernetes.md) and [PostgreSQL setup](../../docs/testing/postgresql.md).

**Exit evidence:** A pinned provider can produce independently trusted observations, gate every Agent child start/restart and bound execution after observation loss. Record missing upstream work and its owner. Contract drafting and source exploration may proceed in parallel, but do not implement a pretend receipt or claim qualification while this dependency is unresolved.

### Provider inspection and adapter work

The 2026-10-04 review selected existing mechanisms for qualification. The 2026-10-07 refresh checks OCE's current OpenShell `v0.1.3-pre.2` pin (`021400be8af471f8669369e679de3e18cf0bd672`); sandbox-scoped authentication alone does not identify an untrusted reporter. The [v0.1.2 architecture](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/architecture/sandbox.md) separates supervisor credentials from the Agent; the current pin includes the [governance interceptor](https://github.com/NVIDIA/OpenShell/blob/021400be8af471f8669369e679de3e18cf0bd672/examples/governance-interceptor/README.md). This refresh records existing main behavior, not a provider upgrade.

| Producer                                     | Adapter consumer and required comparison                                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GetSandbox.status.configuration_admission`  | Extend OCE's existing protobuf/client response and Sandbox observation: require accepted state, current supervisor instance, policy hash/version, configuration revision and provider-environment revision. |
| `GetSandbox.status.main_process_instance_id` | Compute's exact workload identity must agree with the admitted instance; stale/replacement records cannot activate.                                                                                         |
| `GetSandboxPolicyStatus`                     | Read canonical effective policy contents/hash through the provider interface; status alone cannot establish freshness, authority or pre-child ordering.                                                     |
| Governed mutation interceptors               | Sandbox/Backend integration validates exact frozen policy and baseline composition across create, synchronization, proposal approval, global policy and provider-profile changes.                           |
| `StopSandbox`                                | Suspension targets the exact owned Sandbox and confirms execution stopped; a successful RPC admission or route withdrawal alone is insufficient.                                                            |

Names above are existing upstream fields/RPCs, not implemented OCE contracts. The provider's [configuration handler](https://github.com/NVIDIA/OpenShell/blob/021400be8af471f8669369e679de3e18cf0bd672/crates/openshell-server/src/grpc/policy.rs#L4387) checks instance and configuration consistency; live qualification must additionally prove that the Agent cannot obtain reporting credentials, forge acceptance or launch before admission. Observe provider-admitted baseline enrichment rather than trusting workload annotations.

**Remaining dependency:** Supervisor/workload disconnect freezes execution, but gateway polling failures retain prior policy. Select and qualify a provider-local execution deadline or equivalent mechanism for loss of OCC observation authority. Admission inspection does not resolve that gap. No runtime capability or real-provider proof has been completed.

### Step 2: Connect Installation policy to the Agent lifecycle

Deliver a focused runtime PR linked to #1003. It must include the execution and continuous-enforcement steps below; storing a snapshot alone is not a releasable containment capability.

- [ ] Define the minimal normalized Installation policy and canonical digest calculation with the resource/IAM owner. Freeze policy, ceiling identity, selected Sandbox Driver and translation version in admitted revision contents before enqueueing deployment work. Include every security-relevant translation input; exclude secret values from policy records and audit output.
- [ ] Extend PostgreSQL persistence and revision read/write paths together. Place persisted invariants in database constraints and mirror them only where an in-memory adapter substitutes for PostgreSQL. Revisions without canonical snapshots cannot activate or resume.
- [ ] Extend Sandbox admission, translation, observation and suspension through Installation composition. Required containment remains implied by Driver selection. Explicitly reject unsupported provider/execution combinations.
- [ ] The worker compares its loaded ceiling digest with the admitted snapshot, rechecks authorization and supplies frozen requirements to Compute. Mixed API/worker configuration cannot activate; tightening suspends old full-ceiling revisions, while loosening preserves their frozen requirements until redeployment.
- [ ] OpenShell installs the admitted policy before Agent-owned execution. Validate exact effective policy digest/version and the matching workload instance/generation through the trusted mechanism from step 1. Preserve exact Sandbox ownership and idempotent creation/adoption on retries, including lost create responses; readiness and ownership annotations are not enforcement evidence.
- [ ] Compute activates only after matching evidence. Before activation, verify credential attachment, workload identity and the supported native OpenClaw connection. Refusal keeps the candidate nonexecuting and inactive; cleanup revokes exact owned attachments without touching another revision.

### Step 3: Bound execution continuously

- [ ] Integrate bounded evidence refresh with the existing worker lifecycle. Provider-side gates cover child restarts and policy reloads before execution; a successful initial receipt cannot authorize a later unverified instance.
- [ ] Drift, mismatched generation, unknown policy or expired/lost evidence stops exact owned execution and withdraws routing. Treat an uncertain stop as unresolved; retry idempotently and expose the failure. Prove enforcement remains bounded across controller restart, lost work lease and provider disconnection.
- [ ] Recovery requires fresh matching evidence, current ceiling compatibility and authorization. A stale receipt cannot reactivate a replacement Pod or widened policy.
- [ ] Expose API/Console refusal reasons and a "redeploy required" diagnostic for unsupported snapshots. Include release notes explaining the intentional stop. Console changes require updated stories, browser walkthrough, screenshots and video as described in [Console Storybook](../../docs/contributing/console-storybook.md).

**Exit evidence for steps 2–3:** The supported API → PostgreSQL → worker → Compute → OpenShell workflow completes a real native OpenClaw model turn under the frozen policy and passes the material denial, drift, restart and observation-loss cases below without substituting a simulated provider. Until then the delivery remains incomplete.

### Step 4: Add narrower Namespace policies

Start this separate runtime milestone after Installation enforcement qualifies and resource/IAM maintainers decide the policy vocabulary and administration contract.

- [ ] Add the Namespace-owned resource, exact IAM/audit/API operations and PostgreSQL constraints. Freeze the same-Namespace Agent reference and policy generation into revisions; reject unknown requirements and policies above the Installation ceiling.
- [ ] Reject deletion while drafts or live/retiring revisions reference a policy; permit it after detach and completed retirement. Historical retired snapshots remain independent of the mutable resource.
- [ ] Extend real API/PostgreSQL/worker/OpenShell coverage for authorization denials, cross-Namespace refusal, immutable active snapshots, ceiling changes and resource retirement.

Dedicated Codex's existing development path needs separate transport/evidence qualification. Additional execution modes remain reviewed milestones; gVisor/Kata, OAuth, repository credentials and other source types do not become supported through this change.

Each runtime milestone updates its reference, guide, flow and integration coverage. The API cheat sheet is generated from its schema. Model credentials stay only in their authorized runtime/provider boundary. No simulated provider substitutes for required execution proof.

## Verification

All capability rows below are planned, not executed. #919 owns its separate startup-check results. Extend [the real OpenShell Kubernetes suite](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs) through supported Agent callers; ensure new cases exercise the ordinary path rather than its compatibility bridge. Extend [PostgreSQL revision/worker coverage](../../tests/integration/postgres-worker-agent-revision.test.mjs) for persisted lifecycle outcomes. Use [startup coverage](../../tests/integration/sandbox-driver-startup.test.mjs) for composition refusal only; it is not provider enforcement proof.

Select the exact cases and prerequisites from the testing guides. Missing infrastructure or credentials keep the affected proof incomplete. Unit, injected-client and Kubernetes fixture results cannot replace required runtime integration. Record tested commits, provider/image digests, pass/fail/skip counts and proof limits with each runtime PR.

| Required outcome                                        | Real workflow proof                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed/denied actions and policy-before-child ordering | Pinned compatible provider with a real dedicated native OpenClaw turn; refusal before an Agent-owned child marker on unavailable enforcement.                                                                                         |
| Trusted receipts and exact effective policy             | Reject Agent-written annotations/files/logs, Agent-forged or wrong-instance reports, unexpected baseline additions and mismatched translated digests.                                                                                 |
| No workload-originated policy widening                  | Admitted supervisor synchronization succeeds; widening sync, workload proposals/approvals and operator mutations cannot authorize an unadmitted policy.                                                                               |
| Each traffic class stays within the snapshot            | Allowed/denied proxy requests, direct sockets, Pod peers and ingress; both conflicting Kubernetes/provider layer cases must deny.                                                                                                     |
| Drift cannot retain execution or routing                | Restart/re-sync, changed policy version/generation and lost observation/expired receipt gate execution and withdraw routes; matching evidence and authorization are required to recover.                                              |
| Static ceiling identity and restart                     | Canonical configuration digests match across API/worker; tightening suspends prior first-milestone revisions, loosening preserves them until redeploy, and mixed configuration cannot activate.                                       |
| Network-policy visibility                               | Enforcing CNI and operator-reviewed cluster/plugin controls are part of real qualification; Compute claims only the selecting namespaced policies it can read.                                                                        |
| Redeployment diagnostic                                 | API and Console show "redeploy required" for unsupported snapshots; release notes disclose the intentional stop before the milestone ships.                                                                                           |
| Exact scope, ceiling, authorization and snapshot        | Real API/worker integration with PostgreSQL proves cross-Namespace refusal, ceiling rejection/tightening and immutable active revisions.                                                                                              |
| Resource deletion and unsupported snapshots             | Reject deletion with draft/live/retiring references; allow after cleanup. Refuse activation/resume of revisions without canonical snapshots; redeploy requires admitted inputs.                                                       |
| Identity, credentials and cleanup survive provisioning  | Real OpenShell workflow verifies exact requested identity or refusal, credentials, model turn and exact `harnessResource` revocation. Codex development files/passthrough and the native bridge are not production containment proof. |

## Open decisions

Decision owners and binding invariants are listed in [RFC-0019](../rfcs/0019-agent-containment-policy.md#open-decisions). Resource/IAM maintainers own vocabulary/ceiling administration; Sandbox maintainers own supervisor qualification and governed mutation; Compute maintainers own generation/expiry/suspension; Harness and Credential Gateway maintainers own supported combinations. Acceptance of a document does not complete any delivery milestone.

| Decision                                                  | Owner and affected work                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Supervisor trust and supported provider interfaces        | Sandbox and Harness/Credential Gateway maintainers; qualifies admission and credential isolation. |
| Normalization, ceiling digest and snapshot representation | OCC resource/IAM maintainers; blocks final admission and persisted contract.                      |
| Generation, expiry, stop and recovery semantics           | Compute and Sandbox maintainers; blocks continuous enforcement and runtime completion.            |
| Namespace policy API and administration                   | OCC resource/IAM maintainers; blocks step 4 only.                                                 |

RFC review and implementation discovery can proceed together. The PR's owning-team merge decision remains unresolved; merging the RFC as Proposed would not authorize unresolved architecture or expand approved milestones.

## Delivery record

The foundation hardening in [PR #919](https://github.com/openclaw/openclaw-enterprise/pull/919) has merged; its adapter, startup-test, reference and flow changes are present on main. The Installation evidence and Namespace policy milestones in this plan have not shipped. Its head-bound validation and diagnostics remain in that PR. The Namespace resource, canonical containment snapshot and enforcement evidence are unimplemented. A compatible Landlock kernel, disposable Kubernetes fixtures, qualified workload identity/transport boundaries and authorized model credentials remain prerequisites for real-runtime proof.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-08: Rename the unmerged primary plan to RFC-0019’s number and topic; resolve the index conflict using main’s status icons and Author column. RFC-0019 must be rechecked against the base immediately before human merge. Earlier records and Manual Notes remain unchanged.

- 2026-10-07: Renumbered the active proposal from RFC-0057 to RFC-0019 under current main rules, retained this existing plan filename and historical records, repaired owning-RFC links and refreshed OpenShell `v0.1.3-pre.2` development/qualification limits (inspected main `bb7d2a110`).

- 2026-10-04: Selected existing isolated-supervisor admission and governance interceptors for qualification; mapped upstream fields to real adapter/lifecycle consumers and retained OCC observation expiry as an unresolved delivery requirement. The plan remains one coherent implementation workflow; review its length within the 1,500–2,500-word budget.

- 2026-10-03: Inspected pinned provider status/reporting, policy-sync authority and stop interfaces; recorded the unresolved trusted-evidence and bounded-execution dependency before runtime edits.

- 2026-10-03: Refined the ordered implementation work, provider qualification gates, existing source/test owners and continuous-enforcement exit criteria; deferred gateway sharding and class templates (source `f01ae02ac`, inspected main `cb6783fae`).

- 2026-10-03: Recorded merged #919 and clarified configuration-derived ceiling identity, tightening/loosening, redeployment diagnostics, release-note requirements and CNI observation limits after follow-up review (source `111aaf024`).

- 2026-10-03: Created RFC-0057 and its primary plan in PR #1003, separated from #919. Revised after architectural feedback to stage Installation evidence before Namespace policy; specify ceiling, trusted receipts, drift, traffic classes, deletion and qualification scope. Earlier hardening history belongs to [PR #919](https://github.com/openclaw/openclaw-enterprise/pull/919).

## Earlier draft record

These preserved notes record the predecessor draft and branch validation. They do not establish completion of this Planned delivery or change the RFC's Proposed decision.

- 2026-10-03: Recorded local startup and repository validation after explicitly approved dependency setup; mandatory runtime proof and owning-team decisions remain open (source `599776430`).

- 2026-10-03: Separated the proposal from PR #919, allocated RFC-0057 after inspecting open RFCs through RFC-0056, and corrected network permission across enforcement layers with both conflicting-layer proof cases (source `1d36d4390`).

- 2026-10-02: Added explicit mandatory-setting startup coverage and recorded PR #919's remaining runtime proof and maintainer decision (source `78db8531f`).

- 2026-10-02: Split the proposal into RFC-0043 and its implementation plan after the repository adopted separate RFC and plan locations (source `a10baed3c`).
