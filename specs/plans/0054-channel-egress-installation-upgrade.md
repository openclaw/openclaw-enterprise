---
status: In progress
rfc: ../rfcs/0044-channel-egress.md
---

# Implementation plan: Install channel egress and provide a one-off upgrade

- **ID:** TASK-0054
- **Delivery status:** In progress; approved for implementation on 2026-11-19.
- **Owner:** kevinlin-openai
- **Authority:** [RFC-0044](../rfcs/0044-channel-egress.md) and the user's decision to use a documented one-off script and existing Stop → Deploy operations.
- **Source baseline:** Merged implementation `32662b9d22aed39f782a7058ace80d0f82df44a6` ([PR #6529](https://github.com/openclaw/openclaw-enterprise/pull/6529)); implementation baseline `ebcbd2f60535c36b3a9b63847a2d052363cd29a6`.

## Outcome and scope

Make channel egress easy to configure for new installations. Give existing
Slack-proxy installations a documented, one-off transition to Envoy. Keep
release-specific migration logic in a repository script linked from
[One Off Upgrades](../../docs/guides/deploy/one-off-upgrades.md), rather than
running it on every controller image upgrade.

Restart affected Agents with the existing Stop → Deploy workflow. Deploy
creates a new revision from the current saved draft. This intentionally adopts
unpublished draft edits, including changed models, channels, and runtime choices.
The operator reviews those drafts before the maintenance window. Do not add
historical-revision restoration, an Agent migration API, or a new worker state machine.

The transition retains Agent identities, credentials, and supported persistent
state through ordinary Stop/Deploy behavior. It does not delete Agents or promise
uninterrupted sessions. Channel-free Agents receive no channel access merely
because egress infrastructure is enabled. Preserve the merged
[per-Agent enforcement contract](../../docs/reference/drivers/kubernetes-compute/channel-egress.md).

Slack is the first live proof. Shared setup remains provider-independent for
Microsoft Teams. Teams implementation, customer upstream proxies, and SPIFFE/SPIRE
remain separate work. Per-Agent listener ports remain temporary until workload
identity supports shared listeners; this plan does not expand that mechanism.

## Source owners

| Responsibility                              | Existing owner                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Generate matching Helm and OCC settings     | [Profile renderer](../../scripts/render-installation-profile.ts), which already writes one channel-egress object into both outputs. |
| Install dependencies and channel resources  | [Local routing setup](../../internal/occdev/gateway_k3d.go) and [OCE chart](../../deploy/helm/openclaw-enterprise/Chart.yaml).      |
| Validate and execute the controller upgrade | [Image-upgrade helper](../../scripts/upgrade-production-images) and [Helm attempt evidence](../../scripts/upgrade-helm-state.py).   |
| Stop and deploy Agents                      | Existing [Agent lifecycle](../../docs/reference/agents/deployment.md#stop-and-resume), worker, and Kubernetes Compute.              |

Preserve the [original implementation record](0043-channel-egress.md). Its
fresh-install proof is not evidence for this new transition.

## Implementation

### 1. Reuse configuration generation and dependency setup

- [ ] Default managed channel egress on in supported fresh-install profiles and
      Helm defaults, preserving an explicit false. The runtime configuration and
      chart must agree; a raw Helm toggle alone does not rewrite an external
      Installation Secret.
- [ ] Reuse the renderer's existing shared object for names, namespaces, ports,
      and exclusions. Keep ports 10001–10062 for Agents, 10000 for OCC, and 19004 for
      inspection unless explicitly overridden and validated. Drop the proposed extra
      configuration fragment and startup loader.
- [ ] Reuse pinned Envoy dependency setup across local installation, production
      setup, and the one-off script. Install/verify required CRDs, Envoy Gateway with
      patch policies enabled, and the GatewayClass before OCE resources depend on them.
      An existing externally managed controller is verified, not silently adopted.
- [ ] Keep dependency changes ordered: CRDs, controller, readiness, then channel
      resources. Helm alone does not upgrade its `crds/` directory; follow the
      [upstream dependency procedure](https://gateway.envoyproxy.io/v1.6/install/install-helm/#upgrading-from-the-previous-version).
      Avoid duplicate local manifest and Helm ownership.
- [ ] Keep built-in address exclusions. Discover installation Pod, Service, and
      node ranges where complete information is available; otherwise require explicit
      ranges. Include public node addresses. Discovery belongs to setup tooling,
      not new cluster-wide permissions for runtime workers.

### 2. Add the one-off entrypoint and operator instructions

- [ ] Implement the proposed `scripts/upgrade-channel-egress` entrypoint. It is
      explicitly invoked for the old Slack-proxy transition, not dispatched by every
      image upgrade. Reuse existing upgrade functions and evidence handling where
      possible; do not build a general migration registry or framework.
- [ ] Complete the Envoy section of **One Off Upgrades** with exact supported
      source/target versions, target selection, required permissions, reviewed image
      pins, configuration files, commands, expected results, recovery, and a link to
      the implemented script. The current page marks this procedure as planned.
- [ ] Accept explicit cluster, release, Installation, and protected-file inputs.
      Inspect the old configuration and reject unknown or mixed states. A check-only
      phase shows the intended changes without mutations. A separate execution phase
      performs them. Do not print credentials or replace unrelated Secret data.
- [ ] Start from the actual current Helm values and Installation files. Patch only
      named channel fields and assert that their normalized remainder is unchanged.
      Reuse normal renderer defaults if useful, without adding legacy parsing to
      the renderer or core. Keep Installation identity, Secret ownership protections,
      unrelated settings, and protected originals for recovery.
- [ ] When legacy channels are disabled, preserve explicit false. Remove obsolete
      keys only as configuration cleanup; skip Envoy provisioning and Agent transitions.
- [ ] Resolve the protected-input restriction explicitly. The normal image-upgrade
      command continues to reject arbitrary configuration changes. The one-off path
      validates the exact channel transformation and reuses the existing shutdown,
      migration, Helm, and verification machinery. Extract shared internals if needed;
      do not fake the baseline, disable comparisons, or add a general bypass switch.

### 3. Execute the one-off transition

1. **Check the target and drafts.** Inventory affected Agents, including those
   without repositories. Persist the complete original running set before any Stop request. Inspect channel references
   across saved revisions and pending cleanup, not just the latest draft. Review
   the drafts that will be deployed and verify their required grants, credentials,
   images, and available listener capacity. Settle conflicting deployments.
2. **Prepare Envoy.** Use the shared setup to install or verify dependencies before
   stopping workloads. Check controller readiness, GatewayClass acceptance,
   patch-policy support, and actual policy delivery with a temporary owned probe.
   Do not pre-create resources owned by the new OCE release. Dependency or access
   failures at this stage leave the old controller and Agents serving.
3. **Stop affected running Agents.** Call the existing authorized Stop API using
   the old controller and wait for completion. A `202` response only acknowledges
   queued work. Stop can remove both Gateway and Harness execution. Settle cleanup
   that still requires the old code before replacing it. Leave previously stopped
   Agents stopped and never restart deleting Agents. Freeze competing changes
   during the maintenance window.
4. **Upgrade OCC and its configuration.** Stop API and worker through the existing
   checked shutdown. Apply the validated channel configuration change and run the
   normal database and Helm sequence. The new chart removes the old Slack proxy.
   Verify API/worker rollout and authenticated access to the same Installation.
5. **Deploy the recorded running set.** Call the existing deployment API. Each
   request creates a new revision from the current saved draft; no old revision
   is restored. Normal preparation derives Channel Driver rules, allocates and
   verifies Envoy listeners, and starts the workloads. A draft with Slack removed
   correctly receives no Slack grant. Wait for actual deployment completion.
6. **Verify and finish.** Check OCC's channel route and the new Agent workloads.
   Report completed and failed deployments. Keep a small protected execution
   receipt with affected Agent IDs, returned deployment/revision IDs, and completed
   phases so an interrupted script does not blindly submit duplicate deployments.
   Record intent before each request and response IDs and completion after it.
   If submission might have been accepted without a definite response, stop and
   tell the operator what to inspect. Never automatically resubmit an uncertain
   deployment. Use existing Helm recovery and manual inspection; do not build an
   automatic Agent restoration subsystem. Do not retain Harness overrides when
   deploying the current saved draft.

Database modes `hook` and `separate` retain their current behavior, including
upgrades with no pending SQL. The separate-mode handoff may extend the outage.
After a partial failure, inspect actual Helm and deployment state before resuming.
Do not automatically roll back the database or claim an absent completion marker
means nothing ran. Already-transitioned installations skip the one-off procedure
and use normal image upgrades.

### 4. Keep documentation aligned

- [ ] Link **One Off Upgrades** from production upgrade guidance and register it
      under Deploy & Operate. Keep one entry per release-specific transition; split
      long procedures into child pages when needed.
- [ ] Update installation profiles, local/production setup, the channel reference,
      and the channel flow with actual defaults and dependency ownership. Explain
      that ordinary image upgrades do not rerun historical scripts.
- [ ] Check affected configuration cheat sheets and navigation. Submit any newly
      required Driver configuration-contract change through the existing RFC process
      before coding it. Existing Stop/Deploy semantics require no new lifecycle contract.

## Required verification

All implementation proof below is **not run**. Use real enforcing Kubernetes,
Helm-installed OCC, PostgreSQL with separate migrator/application roles, and
[authorized Slack test credentials](../../docs/testing/slack.md).

| Outcome                        | Required proof                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh installation             | Local and production setup provision or verify Envoy, generate matching configuration, and deploy a channel Agent through the regular workflow.                                                                                |
| Default and external ownership | Explicit false, externally managed dependencies, incomplete CIDRs, and conflicting settings produce the documented results.                                                                                                    |
| One-off upgrade                | Start with an old-image/old-chart Slack installation, run the actual script, then prove model execution, a real Slack exchange, and OCC directory access. Include an Agent without a repository.                               |
| Current-draft semantics        | Give a running Agent a different saved draft before the transition. Prove Deploy creates a new revision from that draft while retaining its Agent identity and supported workspace state.                                      |
| Failure and retry              | Exercise pre-Stop dependency failure, asynchronous Stop, database handoff, uncertain Helm submission, and partial deployment. Retrying does not duplicate completed deployments or restart previously stopped/deleting Agents. |
| Isolation                      | Verify distinct destination sets, channel-free and Harness denial, private-address/public-node exclusion, and DNS answers resolving to excluded addresses.                                                                     |
| Later upgrades                 | An already-transitioned installation uses ordinary image upgrades without replaying the one-off script. Test both database modes and no-pending-SQL cases.                                                                     |

Extend existing channel-egress and production-upgrade integration suites and
register coverage in their CI lanes. Keep exact-version restoration tests out of
scope. Record actual results and remaining gaps here when implementation runs.

## Delivery record

Implementation started against the baseline above. Required proof remains pending.
The approved TASK-0054 identity and original implementation history remain in place
under the current specification naming rules. This page keeps one complete
transition and its recovery together.

## Manual Notes

## Changelog

- 2026-11-19: Drafted TASK-0054 against `4eb1ff7b` and main `01193824`; implementation awaits user review.

- 2026-11-19: Revised to a documented one-off script, shared profile generation, and existing Stop → Deploy using current drafts; removed historical-revision restoration.

- 2026-11-19: Approved execution; require field-only configuration patches, durable pre-Stop inventory, disabled-channel preservation, and manual recovery for uncertain deployment responses.
