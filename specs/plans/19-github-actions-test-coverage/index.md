# Feature Spec: GitHub Actions integration and test coverage for Enterprise

**Date:** 2026-09-04
**Status:** Implementation in progress — PR coverage verified; specialized live acceptance remains
**Owner:** Enterprise maintainers (suite coverage and cleanup); repository administrators (Actions policy and protected environments)

## Problem and Decision

Start with PR-safe local and PostgreSQL checks, then add disposable image/Kubernetes checks and a protected real-model lane. Extend those same two workflows to complete the broader test inventory once specialized resources are ready. Preserve the Node test runner, existing Drivers and test contracts. A selected missing prerequisite or skipped expected case must fail its lane.

The [refreshed report](source-audit.md) was completed first and owns upstream evidence, source mismatches and the full inventory. This plan targets reviewed main [`1233e13`](https://github.com/openclaw/openclaw-enterprise/commit/1233e13aa6e1a2e4f502fa5febf06f5531c19f2c): 19 conformance, 37 integration and two browser files. Canonical authoring HEAD `f0b17b7` additionally contains three logging files and new gated log assertions. Inventory the eventual implementation SHA; do not change branches or restore historical `setup-*` suites to meet an old count.

The user removed the workflow prohibition from [AGENTS.md](../../../AGENTS.md) and authorized implementation on September 4. GitHub accepted the workflow push in [PR #23](https://github.com/openclaw/openclaw-enterprise/pull/23). This proposal follows [the platform design](../../../docs/design.md) and changes test orchestration, not application architecture.

## Scope

**Included:** PR-safe integration, protected provider-backed execution, current conformance/browser coverage, skip accounting, disposable setup/cleanup, bounded failure evidence, and repairs needed to exercise supported tests. The September 4 continuation also authorizes runtime/API compatibility repairs for routing identity scopes, dedicated Codex sandbox execution, outgoing image visibility, and OpenShell packet filtering, while preserving authorization and isolation. The complete inventory remains the target; partial delivery must name its remaining lanes.

**Excluded:** production/customer resources; live credentialed execution without the approved dedicated resources and budget below; unrelated product API/auth changes; Vitest migration; wholesale upstream CI import; native-platform matrices and timing/sharding infrastructure without measured need.

## Contract

### Workflow and trust boundary

See [Workflow and trust boundary](workflow-and-lanes.md#workflow-and-trust-boundary).

### Lane responsibilities and prerequisites

See [Lane responsibilities and prerequisites](workflow-and-lanes.md#lane-responsibilities-and-prerequisites).

### Coverage and failure contract

See [Coverage and failure contract](coverage-state-and-limits.md#coverage-and-failure-contract).

### Disposable state, images and secrets

See [Disposable state, images and secrets](coverage-state-and-limits.md#disposable-state-images-and-secrets).

### Cost and runner limits

See [Cost and runner limits](coverage-state-and-limits.md#cost-and-runner-limits).

## Implementation

1. **Authorize and inventory.** The user has authorized workflow implementation and removed the instruction prohibition. CI maintainers select the reviewed main SHA, freeze the file/scenario map, and verify public package/image availability. Generate the suite map from the actual checked-out implementation SHA and map every file present there, including unmerged branch additions. The report's 58 files describe only `1233e13`. No organization mutation is part of this document edit.
2. **Deliver minimum PR coverage.** Add the suite map/runner and `ci.yml` with baseline/browser, PostgreSQL and `ci-required`. Reuse existing test/Compose entrypoints; add only the per-file DB setup and result checks they lack. The four live-Configuration cases remain explicitly assigned to the next lane until repaired. Prove missing prerequisites, mixed-worker coverage, fresh-state retries, failure DB admission and aggregate failure behavior.
3. **Add PR infrastructure.** Add image/packaging and the three k3d fixture cases. Repair the four stale live-Configuration tests against current Configuration/Agent APIs and real Driver startup, then require them in the same infrastructure lane. Do not weaken validation or invent mock success. Require the lane before expanding `ci-required`'s documented scope. [Confirmed mismatch](source-audit/enterprise-coverage-and-gaps.md#gaps-ci-configuration-alone-cannot-fix).
4. **Deliver minimum protected coverage.** Add `full-integration.yml`, approved model environment and `docker-model` plus `runtime-integration`; prove actual embedded/dedicated responses and cleanup. Then add the three ordinary k3d model cases using the same immutable image selection. Keep policy and secrets in job/environment scope, with exact main SHA approval.
5. **Complete specialized coverage.** Add routing/controllers/test CA, production TUI and the noncredentialed timeout case; add provider-account, Slack and OpenShell only after their resource/runner approvals. Incorporate landed logging assertions. Rerun all PR-safe lanes at the same protected SHA, then add `full-test-suite` once every mapped scenario executes. Enable a schedule only after full acceptance; until then publish an explicit partial-coverage result.
6. **Trial reuse and document operation.** Trial the [SHA-pinned upstream pnpm action](source-audit.md#what-enterprise-can-reuse) with cold/warm Enterprise installs and PR merge-ref read/write isolation during initial CI development. If it adds coupling, use standard pnpm/cache actions. Update `docs/testing.md`, settings and relevant helper docs with reproducible lane commands, selected-case/skip interpretation and cleanup; keep this spec historical after implementation. Factor a local composite only when setup is actually duplicated.

## Verification

| Required outcome                                   | Acceptance evidence at the implementation SHA                                                                                                                                                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coverage is accurately named                       | Audit all 58 baseline files plus landed additions; unmapped new files/renamed expected cases fail. Browser cases appear separately from `pnpm test`. Staged CI clearly lists undelivered lanes; only complete runs emit `full-test-suite` success.                                      |
| Missing setup fails selected work                  | Controlled runs omit one DB input, Helm/browser executable, image or selected credential; runner and aggregate fail without printing secrets. Name filters cannot produce zero-case success.                                                                                            |
| Real database and infrastructure coverage executes | Fresh auth/platform Installation, failure/race, production bootstrap, six worker DB and two provider-ownership cases run; three cluster fixture and four repaired Configuration cases execute without unintended skips.                                                                 |
| Model/service results retain their boundaries      | Separate evidence for Docker turns, three k3d topologies/persistence, Envoy denial/rotation/files, Helm/TUI cutover, Slack reply, real account issuance/use/deletion, OpenShell enforcement and the long helper deadline. Include actual OTLP observations if the logging branch lands. |
| Trust and aggregate checks fail closed             | Fork PR receives no external credential or persistent runner; its cache writes remain confined to the PR merge ref. Non-main dispatch cannot obtain protected secrets. Inject failed/skipped/cancelled selected jobs, missing results and cleanup failures; aggregates cannot pass.     |
| Resources are disposable                           | Fail after provisioning, verify removal of owned cluster/DB/Compose/provider resources while unrelated sentinel resources survive. Exercise cancellation and document external-resource recovery after a simulated runner loss.                                                         |
| Reuse and cost claims are measured                 | Pinned cache action cold/warm/fork trial, runner disk/memory/time and real usage/cost recorded; no claim that upstream success proves Enterprise compatibility.                                                                                                                         |

## Delivery status

See [Delivery status](delivery-status.md#delivery-status).

## Open Decisions

The user approved branch/PR creation, browser provisioning, bounded live model/service testing, and selection of pinned routing/OpenShell bootstrap recipes on 2026-09-04. Use the documented `gpt-5.1` model for initial live proof and existing test timeouts to bound attempts.

- Administrators: six protected environments are configured with main-only deployment policies, a required reviewer, and prevention of self-review. Protected workflow execution still requires the exact main revision and its environment review.
- Test owners: supply the dedicated ChatGPT workspace/admin credential and Slack app/bot/sender/channel/proxy inputs; approval alone does not supply missing credentials.
- Runtime owners: dedicated existing-session restart remains blocked by the current plugin remote-owner requirement. The user approved this runtime/API scope expansion in the continuation. Prefer maintained compatible releases and supported runtime configuration. Preserve the existing authorization, sandbox and artifact-visibility requirements.
- Verification: after dedicated Slack/ChatGPT inputs are available, complete those live proofs and execute the protected workflow at the reviewed main SHA.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-05: Simplified CI to whole-file lanes, one lane descriptor, shared workflow execution and single-owner case validation. Retained all acceptance outcomes and the existing live verification gaps.

- 2026-09-04 22:52: Recorded the final 216260f OpenShell pass, final f515 failure status, and narrowed remaining gaps to dedicated restart, dedicated Slack/ChatGPT inputs, and protected main review. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - 216260fc902d43e99d6f7513d8c0f962c63f44f5)

- 2026-09-04 22:40: Added the f515 Codex home ownership diagnostic, d6d6278 OpenShell run result, and 216260f runtime-image ownership repair status. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - 216260fc902d43e99d6f7513d8c0f962c63f44f5)

- 2026-09-04 22:22: Added 93c0125 hosted CI, OpenShell 05:05 UTC failure evidence, upstream OpenShell stderr citations, and d6d6278 diagnostic verification status. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - d6d62786ccb3464c5195ba9774f4df18ffe41979)

- 2026-09-04 22:01: Replaced the pending db6464d routing retry status with the passing 04:56 UTC result and preserved the separate dedicated restart blocker. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - db6464de90ccde811ff2a1177c820bff52207a24)

- 2026-09-04 21:56: Replaced the pending OpenShell e491 status with the failed 04:43 UTC result and added the db6464d independent source-check delta. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - db6464de90ccde811ff2a1177c820bff52207a24)

- 2026-09-04 21:44: Added current e491 evidence for hosted CI, embedded live pass, routing host-publisher failure, dedicated cold-resume limitation and pending OpenShell result. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - e491e7618ee894e6cf0c2336e5d16081be512b73)

- 2026-09-04 21:04: Recorded the 87234e1 live bootstrap result: seccomp preparation passed, embedded startup blocked before model turn, cleanup passed, and no final reporter result was produced. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - 87234e1766e5802b45424523246a52a4b2d45590)

- 2026-09-04 20:44: Distinguished prior live failures from current runtime repairs awaiting new proof, including runtime pins, startup, seccomp and runc OpenShell preparation. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - d189689018ab11faa9b97d01d9c1310b597482f0)

- 2026-09-04 20:04: Recorded approval to repair runtime/API compatibility while preserving authorization, sandbox and media-visibility requirements. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - f7a85e72d70c46d05022aa0877665514d2cfd84d)

- 2026-09-04 19:44: Recorded green PR CI, TUI and OTLP proof, verified OpenShell admission/cleanup repair, and source-backed runtime compatibility blockers. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - 82ce1569d51b092d2d60d80aa7b0baf758600ae1)

- 2026-09-04 12:12: Derived staged PR-safe and protected integration setup from refreshed current-source report; updated coverage, resource ownership, cleanup, trust and acceptance prerequisites. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - f0b17b79e25b020e7cf1adb5ed143ef8adc502c2)
- 2026-09-01 15:18: Proposed all-test CI after the upstream report; mapped revision-aware coverage, real-infrastructure prerequisites, trust gates and verification. (01a05901-204b-7b52-b9da-527ee94cbf81 - 264d6d2f58cd97504c2b8b58d607d002cd62cc5e)
