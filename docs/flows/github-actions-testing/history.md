---
published: false
---

# GitHub Actions testing documentation history

This record preserves the dated changes to the GitHub Actions testing flow. See the [parent flow](../github-actions-testing.md) for its context and overall sequence.

## Changelog

- 2026-10-08 11:04: Isolate launcher queue. (authoring-run/09563984-5be9-4e9d-bf17-142ceb70d96d - 9e7a30a5da374826b1a2ba79b3bca9cdcb74d1f2)

- 2026-10-08 09:57: Documented Keycloak egress repair and manual qualification. (authoring-run/e5c12029-7b1c-4214-a4b9-bde04d03ab41 - 12719f1d366291b774eb9d4948be451c9dd7d805)

- 2026-10-06 02:00: Per-file Agent namespace watch files. (audit-followup-ci-runner)

- 2026-10-04 03:44: Add a non-required affected-package advisory to the accompanying CI change. (authoring-run/5808365b-c590-4c11-92d6-4ee32efc3626 - 070147565f45e720918de9e649b93cad71820b07)

- 2026-10-04 03:00: Split the baseline lane into two parallel parts. (ci-split-checks - 77323afe4d57960c37e07b62e684942a418d585a)

- 2026-10-04 01:41: Document metrics image preparation, shared pins and pull failure handling in the accompanying changes. (authoring-run/091c2e1e-27cb-4514-a1ea-8308051d6ab9 - 61ce8407ac7f46c137f17e7d3bdaf8e9377fa4ff)

- 2026-10-01 02:34: Document the advisory impact summary in the accompanying changes. (authoring-run/0f81a0c3-327f-4389-ae2e-89431878a2d7 - c61836797191a0924671eaaec074863fe2d80cfe)

- 2026-10-01 01:06: Preserve Git path byte identity in the selector and document its coverage decision in the accompanying changes. (authoring-run/2403db12-cdf4-4070-aece-2f4b45ff0234 - 5e0906ccd42473596c2006474adf199d42ab74df)

- 2026-09-29 22:55: Split browser, PostgreSQL authentication, and image model-probe lanes; cache hosted controller/runtime builds while retaining required result accounting. (01a0f0d0-002a-7dc3-af73-e7d25dfe92e2 - b8d7e48f5837d11e54e04dce40650f7ccc5100f0)

- 2026-09-30 02:42: Document generated API reference selection in the accompanying changes. (authoring-run/cd1c4c87-0519-4df7-8bf2-abbff0d53424 - a56c027ff8ec22655cca49aa6a912081cb98b593)

- 2026-09-30 02:03: Describe the documentation-only checks and required gate in the accompanying changes. (authoring-run/ac4af003-ce47-4e8d-83af-040e227a7673 - 20c06dffda90748e5ea16348eaa04feb79d551ab)

- 2026-09-30 01:24: Describe implemented CI selection and its workflow trust boundary in the accompanying changes. (authoring-run/5e0d97eb-d171-45a3-8d25-24825b3545ef - f2c9f98b0b89762cc9edda189c102ed8c593c678)

- 2026-09-30 01:14: Correct the CI lane inventory and describe the proposed docs-only selection. (authoring-run/c4a28d56-7f94-4870-8688-f150945b32ff - f2c9f98b0b89762cc9edda189c102ed8c593c678)

- 2026-09-27 03:44: Retain bounded CI image cleanup evidence. (authoring-run/9266dd42-e257-4e84-b7ac-d6c87ba3ed23 - 3a1acc0db234f8d018593ea3a8b2fd59ad94a4da)

- 2026-09-26: Recorded the PR #445 Images and Packaging failure as a stale native-smoke seccomp hash, rejected the self-hash-only repair, and bound dynamic Docker seccomp profiles to the prepared CI state path/SHA. Local validation covered the helper case (1 pass, 11 image-dependent skips); earlier native image proof remains distinct from the changed harness.

- 2026-09-24 13:09: Document the shared offline seccomp generator and meaningful outside-workspace denial probe in the accompanying changes. (01a0d502-6efc-7063-a88c-4f1739da163c - b4b6a0e0d8700930f21d58b3724c055f8249c486)

- 2026-09-23 23:07: Document lane-owned suite definitions and the shared loader; retain workflow selection, preparation, and result accounting. (01a0d075-a358-7620-8c16-fd4290acddf1 - 4df9f9800836dc1c2b57afd5f8af4d91f55088d5)
- 2026-09-24: Trace fixture-cluster startup metrics and bounded failure diagnostics saved before cleanup.

- 2026-09-23 06:35: Start the audit and required lanes independently on the existing ephemeral Blacksmith pool; split PostgreSQL and Kubernetes fixtures across owned runners and retain the final coverage gate. (01a0ccf5-96e4-7541-9845-c9a6443fa7b2 - 3ac9d07a4d7ede8c4e1c010f598ef67673f97b74)

- 2026-09-21 01:50: Replace earlier lane result artifacts on retry so aggregation reads current evidence. (01a0c179-19f7-7111-8bb4-fc7680da5545 - e836c3f9ec002d91d6f26c6ca49a08345a8c9f4f)

- 2026-09-18 00:00: Bound plugin-status rollout diagnostics to allowlisted Pod and container state. (codex/01a0b0fc-4a24-76c0-8fb7-f3a3a434d464 - 18d8ef0d)

- 2026-09-17 23:40: Retain closed plugin-status wait stages in sanitized CI results. (codex/01a0b0fc-4a24-76c0-8fb7-f3a3a434d464 - 6ef5ff74)

- 2026-09-17 22:59: Gate fixture inputs on storage readiness after image import and expose bounded storage scheduling diagnostics. (codex/01a0b0fc-4a24-76c0-8fb7-f3a3a434d464 - a5a11ad1)

- 2026-09-17 20:55: Trace two-node plugin status fixture preparation, precise proxy ingress sources, shared test storage, and image verification on both nodes. (codex/01a0b0fc-4a24-76c0-8fb7-f3a3a434d464 - 7771526d)

- 2026-09-17 17:18: Allow manual Kubernetes model proof on an explicitly granted branch while retaining independent environment review and immutable checkout. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - d5e41d93d601a0349d7d551ff45b50f7580d72f3)

- 2026-09-09: Restore manual-only Full Integration dispatch because the configured provider admin credential cannot authenticate from the hosted runner.

- 2026-09-09: Run provider-account automatically for every main push, preserve main-only credentials, and retain per-run approvals for other credentialed lanes.

- 2026-09-08 07:42: Distinguish the explicit SSH host lane from automatic CI and full-group coverage. (01a07d92-d866-7731-afe5-abab67d8966c - 4d83087229961f3665b923d2581c0b71b988cc9c)

- 2026-09-05: Documented whole-file selection, centralized lane prerequisites, shared workflow execution and aggregate boundaries.

- 2026-09-04 22:40: Added the real-image nested Codex home ownership startup-smoke regression boundary. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - 216260fc902d43e99d6f7513d8c0f962c63f44f5)

- 2026-09-04 21:44: Documented the separate Docker-local gateway publisher image ID required by routing proof. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - e491e7618ee894e6cf0c2336e5d16081be512b73)

- 2026-09-04 21:04: Clarified that interrupted runs without final reporter output are not completed lane results. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - 87234e1766e5802b45424523246a52a4b2d45590)

- 2026-09-04 20:44: Clarified the dedicated Codex seccomp preparation order and the effective-model guard before live turns. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - d189689018ab11faa9b97d01d9c1310b597482f0)

- 2026-09-04 20:04: Documented runtime package compatibility, startup smoke and distinct routing/media acceptance gates. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - f7a85e72d70c46d05022aa0877665514d2cfd84d)

- 2026-09-04 13:52: Documented explicit CI selection, disposable resource ownership, Node outcome accounting and aggregate boundaries. (01a06dd0-9fff-7e90-aae3-4e7099a6d154 - f0b17b79e25b020e7cf1adb5ed143ef8adc502c2)
- 2026-09-04 14:13: Corrected hosted-runner cleanup-state limits and named the PR-safe logging collector lane. (01a06e43-6504-7810-9f09-4dd31b2e9681 - f0b17b79e25b020e7cf1adb5ed143ef8adc502c2)
- 2026-09-04 15:10: Clarified independent logging backend cleanup and local one-Kubernetes-lane-at-a-time guidance after measured Docker VM pressure.
- 2026-09-04 15:35: Documented the shared Docker 29.4.0 setup action for Collector and Docker-model compatibility.
- 2026-09-04 16:00: Pointed evolving proof status to spec19 after PR #23 head `27bd0e9` passed the hosted PR lanes and local live Docker-model execution passed.
