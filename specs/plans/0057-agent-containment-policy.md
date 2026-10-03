---
rfc: ../rfcs/0057-agent-containment-policy.md
---

# Implementation plan: Agent containment policy

- **ID:** RFC-0057
- **Delivery status:** Planned; #919 foundation hardening merged, containment milestones unimplemented
- **Owner:** OCC resource and IAM maintainers, with Sandbox and Kubernetes Compute maintainers
- **Authority:** [RFC-0057](../rfcs/0057-agent-containment-policy.md) and the [platform design](../../docs/design.md)
- **Source baseline:** `main` at `8193ad3ca`, including merged #919

## Outcome and scope

First prove enforcement of the existing Installation policy through the regular Agent deployment workflow. Then add narrower Namespace-owned policies beneath the operator's ceiling. Selecting a Sandbox Driver implies required containment; no extra enable switch is proposed. RFC-0057 owns the exact trust, drift, lifecycle and traffic-class requirements.

The first qualification target is dedicated native OpenClaw on Kubernetes with the paired OpenShell Backend and an OpenAI static CredentialSource. Dedicated Codex with CredentialSource auth requires separate protected transport qualification. OAuth, repository credentials, embedded/SSH execution and other source types remain unavailable in this milestone. No qualifying production path exists today.

## Contract and source touchpoints

OCC owns policy/ceiling authorization, canonical immutable snapshots and receipt comparison. The worker rechecks authorization, owner and selected Driver. Sandbox owns translation, trusted observation and execution gates; Compute owns identity, generation, routing and lifecycle. Extend the [Sandbox contract](../../docs/reference/drivers/sandbox.md), [Agent deployment](../../docs/reference/agents.md) and [OpenShell flow](../../docs/flows/openshell-sandbox-provisioning.md) through their real callers.

## Implementation

1. **Merged foundation:** [PR #919](https://github.com/openclaw/openclaw-enterprise/pull/919) merged as `f34d220290c3246d9d61c6ee4ff73696ac836161` on 2026-10-03. Mandatory Landlock configuration and rejection of weaker settings are implemented; its validation belongs to that PR. This prerequisite does not qualify the evidence or Namespace policy milestones.
2. **Installation policy evidence:** Freeze the operator's ceiling, normalized policy and translation version into canonical AgentRevision contents without adding a Namespace resource. Use a canonical loaded-configuration digest as ceiling identity; verify restart and API/worker configuration mismatch behavior. Extend Driver admission/translation/observation/suspension and worker/Compute integration. Prove authenticated control-plane evidence independent of Agent-writable signals, exact effective digest comparison and policy-before-child ordering. Reject sandbox-originated policy sync and draft approvals. Qualify direct sockets and all traffic classes, accounting for additive Kubernetes/operator policies. Keep unsupported upstream combinations unavailable.
3. **Continuous enforcement:** Require matching receipts per instance/generation. Gate provider restarts/reloads; on drift or observation loss, stop execution and withdraw routes. Recheck authorization and ceiling before recovery. Reject revisions without canonical snapshots; no legacy fallback. Before release, require an API/Console-visible "redeploy required" diagnostic and a release note explaining that existing sandboxed revisions stop until redeployed. This is planned product behavior; no upgrade or migration procedure is added here. Prove Pod restart, supervisor sync, operator mutation, expiry, route withdrawal and termination through the real worker lifecycle.
4. **Namespace resource:** Add the policy resource, exact IAM/audit/API operations, PostgreSQL constraints, same-Namespace Agent reference and frozen policy generation. Reject policies above the Installation ceiling and redeployments without references. Reject deletion while drafts or live/retiring revisions reference a policy; permit it after detach and completed retirement. Verify ceiling tightening suspends all first-milestone sandboxed revisions, loosening preserves their old snapshots, immutable active snapshots and unsupported snapshot refusal through API → PostgreSQL → worker → Compute → real Driver.
5. **Additional qualification:** Qualify dedicated Codex transport separately before expanding the caller. Host isolation such as gVisor/Kata, other source types, OAuth, repository credentials or other execution modes need separate reviewed milestones, not silent admission expansion.

Each runtime milestone updates its reference, guide, flow and integration coverage. The API cheat sheet is generated from its schema. Model credentials stay only in their authorized runtime/provider boundary. No simulated provider substitutes for required execution proof.

## Verification

All capability rows below are planned, not executed. #919 owns its separate startup-check results.

| Required outcome                                        | Real workflow proof                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed/denied actions and policy-before-child ordering | Pinned compatible provider with a real dedicated native OpenClaw turn; refusal before an Agent-owned child marker on unavailable enforcement.                                                   |
| Trusted receipts and exact effective policy             | Reject Agent-written annotations/files/logs, sandbox-authenticated reports, unexpected baseline additions and mismatched translated digests.                                                    |
| No workload-originated policy widening                  | Real sandbox-authenticated sync, draft submission/approval and operator mutations cannot authorize an unadmitted policy.                                                                        |
| Each traffic class stays within the snapshot            | Allowed/denied proxy requests, direct sockets, Pod peers and ingress; both conflicting Kubernetes/provider layer cases must deny.                                                               |
| Drift cannot retain execution or routing                | Restart/re-sync, changed policy version/generation and lost observation/expired receipt gate execution and withdraw routes; matching evidence and authorization are required to recover.        |
| Static ceiling identity and restart                     | Canonical configuration digests match across API/worker; tightening suspends prior first-milestone revisions, loosening preserves them until redeploy, and mixed configuration cannot activate. |
| Network-policy visibility                               | Enforcing CNI and operator-reviewed cluster/plugin controls are part of real qualification; Compute claims only the selecting namespaced policies it can read.                                  |
| Redeployment diagnostic                                 | API and Console show "redeploy required" for unsupported snapshots; release notes disclose the intentional stop before the milestone ships.                                                     |
| Exact scope, ceiling, authorization and snapshot        | Real API/worker integration with PostgreSQL proves cross-Namespace refusal, ceiling rejection/tightening and immutable active revisions.                                                        |
| Resource deletion and unsupported snapshots             | Reject deletion with draft/live/retiring references; allow after cleanup. Refuse activation/resume of revisions without canonical snapshots; redeploy requires admitted inputs.                 |
| Identity, credentials and cleanup survive provisioning  | Pinned OpenShell Kubernetes workflow verifies projections, ready attachments, model turn and exact `harnessResource` revocation. Current stock projections block qualification.                 |

## Open decisions

Decision owners and binding invariants are listed in [RFC-0057](../rfcs/0057-agent-containment-policy.md#open-decisions). Resource/IAM maintainers own vocabulary/ceiling administration; Sandbox maintainers own trusted proof; Compute maintainers own generation/expiry/suspension; Harness and Credential Gateway maintainers own supported combinations. Acceptance of a document does not complete any delivery milestone.

## Delivery record

The foundation hardening in [PR #919](https://github.com/openclaw/openclaw-enterprise/pull/919) has merged; its adapter, startup-test, reference and flow changes are present on main. The Installation evidence and Namespace policy milestones in this plan have not shipped. Its head-bound validation and diagnostics remain in that PR. The Namespace resource, canonical containment snapshot and enforcement evidence are unimplemented. A compatible Landlock kernel, disposable Kubernetes fixtures, qualified upstream projections and authorized model credentials remain prerequisites for real-runtime proof.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-03: Recorded merged #919 and clarified configuration-derived ceiling identity, tightening/loosening, redeployment diagnostics, release-note requirements and CNI observation limits after follow-up review (source `111aaf024`).

- 2026-10-03: Created RFC-0057 and its primary plan in PR #1003, separated from #919. Revised after architectural feedback to stage Installation evidence before Namespace policy; specify ceiling, trusted receipts, drift, traffic classes, deletion and qualification scope. Earlier hardening history belongs to [PR #919](https://github.com/openclaw/openclaw-enterprise/pull/919).

## Earlier draft record

These preserved notes record the predecessor draft and branch validation. They do not establish completion of this Planned delivery or change the RFC's Proposed decision.

- 2026-10-03: Recorded local startup and repository validation after explicitly approved dependency setup; mandatory runtime proof and owning-team decisions remain open (source `599776430`).

- 2026-10-03: Separated the proposal from PR #919, allocated RFC-0057 after inspecting open RFCs through RFC-0056, and corrected network permission across enforcement layers with both conflicting-layer proof cases (source `1d36d4390`).

- 2026-10-02: Added explicit mandatory-setting startup coverage and recorded PR #919's remaining runtime proof and maintainer decision (source `78db8531f`).

- 2026-10-02: Split the proposal into RFC-0043 and its implementation plan after the repository adopted separate RFC and plan locations (source `a10baed3c`).
