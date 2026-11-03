---
published: false
---

# Production image upgrade flow documentation history

This record preserves the dated changes to the production image upgrade flow. See the [parent flow](../coordinated-production-upgrade.md) for its context and overall sequence.

## Changelog

- 2026-10-09 21:10: Gateways migrate an older agent database with Doctor before OpenClaw starts. (fix-971)
- 2026-10-09 20:10: Point the split-layout export at the split-layout upgrade page, where in-place adoption comes first. (fix-533-adopt)
- 2026-10-07 21:20: Refuse a two-cluster upgrade before quiescence when the execution chart lacks this release's tenant grants. (fix-758)
- 2026-10-07 12:00: Say that a controller-only release leaves existing versions on their old Pod specification until the next deployment. (dogfood-r43)
- 2026-10-05 15:01: Keep filesystem layers outside the image identity metadata budget. (authoring-run/0b8bd46b-85c0-4664-8dbd-2ee77cd7b602 - 08248f8dbf227dfb7b73162056b6afd1c33cee0d)
- 2026-10-05 06:00: Save and report every preflight Pod's result before cleanup, not only the first failure.
- 2026-10-05 04:00: Load the candidate Installation with the selected controller image in one-shot Pods before quiescence.
- 2026-09-28 12:36: Qualify the selected repository image pair and verify deployed identities and capability. (01a0e6ca-95a4-7e80-aab8-38c5e92a53da - 374dfd4c58587f64d859d4aa4fdaf446b158402a)
- 2026-09-28 11:36: Restrict candidate changes to the reviewed proxy and curated catalog settings. (authoring-run/829b465b-4176-428a-a748-59968ab63b04 - e3bcdb9b3a82d16016c023a8a77d683bf0079ce7)
- 2026-09-28 08:49: Verify the named controller image across ordinary and restartable worker placement. (authoring-run/4c22438e-4a96-4125-bdbb-47a3547a1232 - dcf7c58ef3fe7f6ec6ffc33c1062fee93c9bdeb2)
- 2026-09-28 07:58: Guard repository Backend, Driver, network, and cluster trust settings during candidate preparation. (authoring-run/1d4977e8-b5e5-4b20-9909-bedc3c5b3900 - 2fd914a7273bb09e9d91543c806a4091772191f6)
- 2026-09-28 07:39: Record reviewed configuration candidates and strict live baseline checks. (authoring-run/3c681647-a494-4613-809e-11113e5ed11c - ec51e917954207b49d66f3cb28a7d4887fcd9ea1)
- 2026-09-28 07:02: Record quiesced migrations and resumable release and dispatch recovery. (authoring-run/ef0e4dd2-3f52-48b4-a742-60dfbb85864a - e06ff9625e72ff5ab3483a504a2f02a69a370cbb)
- 2026-09-26 22:28: Preserve the selected repository broker hostname before image upgrades. (authoring-run/1495f489-e298-44e9-b75d-6a49445d35e3 - 7caf53332219db12fed62180c3c6d270baa8ea63)
- 2026-09-25 13:40: Document Helm migration ordering and add post-readiness OpenClaw Doctor lint for replacement gateways. (authoring-run/d35fd05b-5bbd-4f21-a747-820c2df23b2c - 077e26ba0c0babe033569105e3a7e89abf06f40d)
- 2026-09-25 12:29: Split controller and runtime releases while retaining an optional combined path. (authoring-run/ab700e2e-1baf-400c-ab18-0aa9a351f351 - 5e747ac1722f757d7949746e9ff9982142c8536b)
- 2026-09-24 21:21: Separate operator instructions from the runtime trace; require version-read admission, HTTPS, Kubernetes reads with request timeouts, and the complete execution-mode workload set. (authoring-run/613d1e94-a661-4781-bae5-e28613aa3cf9 - c799988036f43ce1bb828373233f03cc77bb0ea9)
- 2026-09-24: Record cluster/OCC identity binding, live/protected input equivalence, the supported empty-fleet path, and runtime Pod readiness discovered by the production rehearsal.
- 2026-09-24 13:43: Trace fail-closed inventory admission, nonterminal deployment rejection, and the one-time controller-only bootstrap for older OCC versions. (authoring-run/0fc7c19b-0e15-498c-8328-e436bc702f37 - a7a609d5867398dd0dfd3bb77cfebf91b2cad116)
- 2026-09-23 12:32: Trace matched image replacement and concurrent exact-Agent deployment through durable status convergence. (authoring-run/d29bdbc5-2a6a-46fa-a8e5-6ad78ea2e486 - 78cf9fd25f08e91158617fbd0ae3e42a22e54361)
