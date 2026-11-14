---
published: false
---

# GitHub Actions testing documentation history

This record preserves the dated changes to the GitHub Actions testing flow. See the [parent flow](../github-actions-testing.md) for its context and overall sequence.

## Changelog

- 2026-10-23 03:43: Order Docker timestamps and retain twelve latest retry kinds independently of locale. (authoring-run/01a10a81-070c-7aa3-97d0-fbce8f285d4d - 9bca605f5175bb225a522c3d5537a7ee6e1a7751)

- 2026-10-21 04:42: Preserve submillisecond Docker event order. (authoring-run/458f4777-70d1-4992-a922-ab387c6a4aba - e8185dac805b737363c7178d3068b310a53a7c24)

- 2026-10-14 22:31: Complete all selection. (authoring-run/d5130a41-8ae6-4a80-aef3-32d61a53348c - 9b50982b75a578d6967ee12befb1fa3904e20a38)

- 2026-10-14 14:09: Remove environment approvals. (authoring-run/ff0eb53f-ceb9-43fc-a81a-c1bc88b5c9fb - 909b0b9d4)

- 2026-10-14 14:04: Scope PAT authentication and OpenShell prerequisites. (authoring-run/dba0a6cb-33d9-40fd-b38b-e20cddf4b75f - 96a2b79fa)

- 2026-10-14 16:37: Document hosted QA image cleanup. (authoring-run/0733d076-37af-4fd5-ade5-869487072f47 - 1c406aef)

- 2026-10-14 10:19: Retain cleanup ownership. (authoring-run/ee448fbe-3e0a-40d4-b7d1-3f122d3e5f1b - 10f34280f56dc2375f48df9d2161024520a35882)

- 2026-10-14 09:44: Document command-group termination, pipes with shutdown deadlines, and abandoned runner and fixture handoffs in the accompanying fix. (authoring-run/6dec0b67-a5cd-4a9e-82dc-7609f956b115 - 47d5b8cc901e225e51227a905ee688c69c8ea729)

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

- 2026-10-10 09:04: Preserve failed-wait container evidence when optional watch startup fails. (authoring-run/c7f52e93-d02d-497c-b146-43640cef1418 - acb84f827e22218bdb8432c48cbb22d644503cfb)

- 2026-10-10 06:28: Await initial Agent watch synchronization before each test file. (authoring-run/1daba808-076b-48c2-a2ef-79a5f6149f31 - 792304b6a09b5df4f46e3889066f231610b294cf)

- 2026-11-11 23:18: Require the complete installer cohort’s credentials before setup. (authoring-run/1eb4586e-e5dd-41d2-80e3-338b75d13f6a - 0e264d010c2f5c80f4077a1e9fee5515216bcfe4)

- 2026-11-11 23:11: Include declared file model selectors in OpenShell credential admission. (authoring-run/0759ff85-9e18-4fc7-b2bb-29e29bb5935a - f63959062058a5e5c630f36318a381e27ac07cf2)

- 2026-11-11 10:47: Fix PostgreSQL topology ordering. (01a1cbd6-deb9-71a1-bebc-ec5228d76c16 - 225ef5203)

- 2026-11-11 16:52: Publish journals atomically. (authoring-run/fac6c060-7d04-496a-9194-8dfc3ba080e5 - 9209a107a78a5850f7f11b68e1763956d65cde3a)

- 2026-11-11 16:18: Bind child cleanup ownership. (authoring-run/bfbc4468-ece0-4912-b2df-e60c34f373b1 - b5eb70f7384601a69ad62e089e5909c01789e011)

- 2026-11-11 15:55: Retain child cleanup custody. (authoring-run/567c3011-a36a-4bfb-b1f1-c2390ca67345 - cbd2ffb5bff1896373bd4a91d0a1636fcd3a40ff)

- 2026-11-11 15:48: Preserve named-test selection. (authoring-run/8a46c797-57e1-4ac7-8fae-a65a81c7975a - 757f3c5eaf042c55e92f0776384fdbb853cd7bc5)

- 2026-11-11 15:36: Require the real PostgreSQL preparation lifecycle in its Docker-capable lane. (authoring-run/8381f18d-77a3-4a7a-91af-23d1151f2f9e - 7dbcfc5ec7a62c35ff3585e965470db8cc8c840b)

- 2026-11-11 15:21: Literal selection. (authoring-run/713d85c0-4416-4c1d-b492-d63c41faeea4 - 93460c542b3ca6840aab156e2311fe5b22d1ad29)

- 2026-11-11 14:43: Preserve installed sign-in and complete CI lifecycle paths. (authoring-run/e533d196-4ff0-450d-b662-d41ede51e945 - 21417f21dd22a6410350395ac43a24146a2f8027)

- 2026-11-11 14:02: Document canonical manifest guard. (authoring-run/c4d4109e-2324-46f7-bceb-42e3780475b1 - 6bfff2b8a3a07d91637dac4391affc9dde8e0547)

- 2026-11-11 13:14: Refresh the exact current sign-in profile. (authoring-run/d71f35f5-549c-4312-9000-cc24c8cee1cd - 2b8436a5da1e75427c8aa72523d16b9bdc6d0f35)

- 2026-11-11 09:34: Allocate PostgreSQL ports through Docker and retain discovery cleanup ownership. (authoring-run/24db2a8e-6abc-40a2-9332-103ff02f4d4f - 89e4d8b565e511f0dc4688e6dcaed093659e447a)

- 2026-11-11 08:45: Preserve uncertain cleanup. (authoring-run/2f6528e7-fc71-4854-a473-7c5fd68410cc - b561b6bc134053ea9ff7ab4286c4f2f501a80391)

- 2026-11-11 08:39: Retain unacknowledged staging resources. (authoring-run/43e450db-975c-4b32-b88b-ed179d4d50f0 - 16478e96645985bd7501e149a19dbbd784500501)

- 2026-11-11 08:17: Carry prepared custody into destructive cleanup. (authoring-run/f3df3f10-664e-40c7-9f31-907e3bcf7ad1 - 6a60e750c83a3508041ef5100a36f7232ed226ea)

- 2026-11-11 08:11: Bind sign-in rehearsal to the current v3 profile. (authoring-run/8a266aca-074d-4db2-a374-624cabc77861 - 9bf18bf3244b0a0e6f26f5a10263f51ea0b08b3c)

- 2026-11-11 07:55: Retain selected runtime Codex provenance in CI evidence. (authoring-run/59e3fbae-c2ef-496b-ad18-c965758bee04 - 7fa7a37738bb24b27d9a835e409ea20eafb43cee)

- 2026-11-11 04:31: Order OpenShell cache prerequisites. (authoring-run/3b974b52-31d5-4b10-a36c-7cd8a485fc74 - 5d28dd8e93338af9f0ece8796b3bb4a83bd46295)

- 2026-11-11 03:43: Guard reuse and fresh fallback. (authoring-run/c0ca6f34-2aa6-47f9-87c1-e5f3708617f6 - 993a38b318c249b00f951bf92c8d136214ec82fd)
- 2026-11-11 03:28: Explain qualified CI reuse. (authoring-run/1b85588b-87c6-47d0-8c6e-8b78b0030aea - dfd55e679c9c9869ddc786b85f6f9b27a53fb833)

- 2026-11-11 02:49: Trace installed failure receipts. (authoring-run/ca550d16-3b1c-4ed9-9ec7-d10efbb6baf9 - 2f93d2d9a4e452c79813467b4fbe0f9218410835)

- 2026-11-11 02:22: Persist defaults separately. (authoring-run/468c8b0e-17e2-4d4e-988e-f00f3434ccfa - 52faf13e94dab59c20c80b161169c1d32429da36)

- 2026-11-11 02:08: Trace per-file environment precedence and preparation boundaries. (authoring-run/3950ed4c-e0a8-42f9-8fc0-6b5fa60d7d3a - 08c7419aea802667090483843a386071c13e9050)

- 2026-11-11 01:21: Include the OTEL lane in sanitized image-cache observations. (authoring-run/d63d3aa5-5c9c-493a-b4ea-51a1d64e9454 - 60289cbf3d6995ed46960ddb32402e52bf5efad7)

- 2026-11-11 00:08: Select focused advisory jobs and verify their PR merge identity. (authoring-run/bf3df73c-1de0-42d0-b8e4-1326f775739f - 90cee90b34bf20c96538423778a652e55ff02eb4)

- 2026-11-10 19:00: Classify RFC PNG illustrations as documentation. (authoring-run/320d719f-dd4a-44fd-968c-59c377d1a5bc - b3f542cdf738ffcbc4c351e7c9123228ae76a415)

- 2026-11-10 18:32: Preserve safe Installed Skipper operation details for asynchronous failures. (authoring-run/0336b456-2d89-4535-9e04-eeb36c2970d9 - b4528e53458339a1df59473f068142675b1982a5)

- 2026-11-10 17:37: Admit eligible Full Integration work before acquiring its execution lock. (authoring-run/9f72faf1-4740-48d3-8519-5d38e749b961 - c6541831756ae40d0485d16d8f0ffeab9851372d)

- 2026-11-10 16:48: Consolidate native proof diagnostics and clarify observation limits. (authoring-run/62ff26b1-e2b9-4035-a938-e86a07a423b7 - faf4426fba16f164353970c5eaebd4b6b41b60f4)

- 2026-11-10 16:26: Reconcile installation receipts and cleanup coverage. (authoring-run/b99ad0c3-5ba1-40a6-8719-e0216a7c49a8 - 9641a352044b81f1f00afc40870ba54cccdefa75)

- 2026-11-10 16:05: Preserve cleanup failures across missing-state retries. (authoring-run/9259c9bd-8e96-4172-ba73-d945dedd0c0e - ef14f2ab13e47d703fd4bddac3c1862de65b0092)

- 2026-11-10 16:02: Document installation receipt retention. (authoring-run/a06db5de-e6ec-40b7-811e-7f04ff14b7e2 - 242eed4481d16c13227383acd8b58c4d8757ae1f)

- 2026-11-10 15:47: Require final lane cleanup evidence for execution coverage. (authoring-run/8af45432-2706-4ed9-aafd-7750cfea1905 - 60dba17cf36b796aee257e61499803b5dacc5a8c)

- 2026-11-10 13:06: Admit navigation in docs-only CI. (authoring-run/3fcf2723-e440-4ce4-8994-00066241bc2b - 554857e441d9348adfac651bd382c17ffef67c8d)

- 2026-11-10 12:53: Trace cache observations. (authoring-run/9ff30b3c-1145-4acb-9fa3-8a4eb3a5e594 - dd7a47c0e1d7428068bdc79d311ceb07fbea767f)

- 2026-11-10 10:38: Reconcile builder reuse and live progress documentation. (authoring-run/d839dc55-f4be-4689-85a1-3ab9527ad4c4 - 280ae7e6db4b38b68bd76bd7aefdd7d874d28bbd)

- 2026-11-10 10:19: Trace portable, bounded OpenShell progress through the reporter and runner. (authoring-run/d839dc55-f4be-4689-85a1-3ab9527ad4c4 - 1af8c3c4f21c6fe1c8b36ef9545e9e4754e74de6)

- 2026-11-10 10:07: Preserve the builder and epoch for full OpenShell source-build tests. (authoring-run/0c79fd33-2fb7-4114-a408-f08f34d1048d - ce80e6a6b254add076625a1087d098327370672c)

- 2026-11-10 09:09: Document qualified registry-tool reuse and APT setup deadlines in the preparation flow. (authoring-run/dc4064e9-3291-42b3-aaf2-9c36fb81f1a6 - 49e3f601c762f94c8d7b97f594c4a342986d68bd)

- 2026-11-08 08:28: Preserve matrix failure attribution alongside admitted CI reuse. (authoring-run/7219e3b9-3091-4a5b-8712-c543ff5f0c68 - 006cf6288913ff8eb56d0fbc2283885bd551ecc9)

- 2026-11-08 16:09: Reuse admitted same-source ordinary CI results before fresh Full Integration execution. (authoring-run/d394120a-859d-45f1-ba62-9bf9dd9b66c1 - 832dbfca29eca2dd3cb98bd9dd5d803d9100911e)

- 2026-11-08 16:02: Select documentation-only main pushes from verified before-tree policy. (authoring-run/bafcfe3a-329e-4d07-8f36-f178b64e37d0 - ca3ad3c4f3ec8ec5660ec2909bd4673adf78ff90)

- 2026-11-04 12:10: Isolate the Codex Git proof queue without Slack. (authoring-run/14bcb9d6-2d4c-449d-8bbc-b64e3ef7e632 - aa60a72115e342ec020d1083fb5e30c139202c84)

- 2026-11-06 09:03: Validate lane identity before attributing outcomes from matrix results. (authoring-run/acefb857-8e57-4f00-b7f5-ed9224944d88 - 048b2cd25cc59087bcb2551fce03a39eef023340)

- 2026-11-04 10:07: Consolidate Full Integration policy and bound the cutover proof routes. (authoring-run/79147f32-199a-48ad-9b7e-fbdf94bf9d60 - 2628dba73edd44e4980711129e48fb7842828019)

- 2026-11-03 01:07: Bind staging tests to release source. (authoring-run/c1bf6b1d-bea1-4de7-b3af-4a2ea197ba06 - d2fc28e1d6d70292e462956cedef0dae9281c48c)

- 2026-11-02 23:56: Trace staging authentication. (authoring-run/5817dfd2-487d-44bc-a2f7-2d57659ea0fc - db2cc11c4fd767c47394d680ef46bf26e1202fbc)

- 2026-10-29 02:11: Add focused Compose OpenShell selection and sanitized native worker observations. (authoring-run/01a17fae-f253-7d71-af12-d3f259c4faf0 - aa2cfe543b3bba361679e7e1a3028c3327d2c388)

- 2026-10-23 07:40: Preserve upstream CI selection alongside locale-independent timestamp ordering after conflict resolution. (authoring-run/01a10a81-070c-7aa3-97d0-fbce8f285d4d - a6a49a5192fa1c9cc5035801eed7d64b03336491)

[GitHub Actions testing documentation history](github-actions-testing/history.md) preserves the older dated entries.
