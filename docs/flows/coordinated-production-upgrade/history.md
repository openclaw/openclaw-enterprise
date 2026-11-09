---
published: false
---

# Production image upgrade flow documentation history

This record preserves the dated changes to the production image upgrade flow. See the [parent flow](../coordinated-production-upgrade.md) for its context and overall sequence.

## Changelog

- 2026-11-04 00:26: Record completion after final evidence capture and refuse resuming completed upgrades. (authoring-run/a85b1fc7-d58e-4c10-b80c-6464a0aaaa4f - c8a9b55bd67175e0d1ae3fbb7fefe1a0de44f573)

- 2026-11-03 10:46: Document stock chart verification. (authoring-run/1308615d-068b-473e-8062-2baec5b66ab0 - 11099b579a5c197e0ec5c342bffb78036c321a32)

- 2026-11-03 02:34: Preserve journaled replacements when evidence is restored. (authoring-run/a4cf6a1b-e333-44d4-8e78-138caa5c190a - 19f63529413d4a530ac4eb65204980720d6d8ce9)

- 2026-11-02 23:23: Bind directory identity; preserve evidence paths. (authoring-run/1d065972-0bb5-4523-81d3-7d83a64ff8f3 - cf67413c378cce3989d28fa8178ed29a405b9ce6)

- 2026-10-29 23:05: Retain the upgrade lock after interruption until operations are reconciled. (authoring-run/729e3e30-1ab9-4e2c-bae2-42834bf535c4 - 5a61a08eec78fbae99e21b858af5c8dd5911ba03)

- 2026-10-29 12:28: Validate baseline mapping streams. (authoring-run/b9a98c72-bd73-45d4-b50d-f12d185f39b5 - 389a51336cd5)
- 2026-10-29 11:04: Document protected baseline comparison. (authoring-run/35ed2337-614f-4587-a16d-7c1973bb4819 - 51de7c164aab)
- 2026-10-29: Check Agent drafts before writers stop. (fix-2809)
- 2026-10-29: Check model providers; budget drafts by Installation. (fix-2815-2816)
- 2026-10-28 18:11: Check Helm status before reconciliation reads. (authoring-run/44ebe5a4-904f-4a6b-8796-e86c3ab7a26a - 541cc3f43bdfb09615ecee0cfb79c533e6a0b56c)
- 2026-10-28 21:01: Check API themes before writer quiescence. (authoring-run/bf262f39-fa9d-4e70-94e1-e2fc516234e9 - 304fcfb169bc8403794e8562a08b1e3ee4cc23ac)

- 2026-10-28 06:40: Check every revision Pod, not only the gateway, after Doctor. (fix-2755)
- 2026-10-28 05:40: Check gateways after failed Doctors. (bughunt-1028)
- 2026-10-28 00:40: Run Doctors serially; fail on gateways changed afterward. (fix-2736)
- 2026-10-26 23:24: Record source checkout verification before private inputs. (authoring-run/dc3e51c1-8f14-4410-9c70-e4a993ea58fe - 821bee5fe0bb446319fab40ad21055b1e942eb37)
- 2026-10-25 11:53: Record native scale, Helm upgrade, and rollout failures; preserve recovery. (authoring-run/f03f716e-ea13-48ab-ad6e-e179b342d585 - 87784a3230964bd8a7a1763f8350c1fd2b4284e0)
- 2026-10-25 09:19: Keep preflight kubectl errors in private evidence. (authoring-run/6fccb13c-5ec3-44d5-aded-c3c3e9c1da81 - aaabca1fec6b28fbbb674f48f11f015242f86b59)
- 2026-10-25 06:51: Identify temporary preflight resources by UID before cleanup. (authoring-run/d15969fb-1113-416f-9573-e045dd683b66 - dd36945fec0ec3de38cd15b971537eb10a90d0e4)
- 2026-10-23 09:50: Document preflight-only rehearsal and fresh checks at deployment. (authoring-run/3c1a4d88-d619-47e3-9eba-dbaf0988d2e9 - 4e9f5935d5fa4878a719e82db5e504ec6ae55d64)
- 2026-10-20 01:48: Preserve field diagnostics before quiescence. (authoring-run/9d1ff825-b9f4-492a-9420-1e316d820e28 - e7e5f3321cb0a8471d74964eba56ddd069a4e4c5)
- 2026-10-19 22:34: Document that pending repository cleanup does not block upgrade preparation. (authoring-run/d59b973b-1f0b-46bb-b16f-d67bd24ed6d3 - 57acafe81482a890b02ae530793246f2c2e7be79)
- 2026-10-18: The initialization hook checks the Installation before migration.

- 2026-10-12 15:14: Record bootstrap Job grants required by the two-cluster upgrade preflight alongside the fixture correction. (authoring-run/ebb1c629-97b2-4b9a-aa67-a5e750346031 - 9578f6f7aaff9b8545346f43043cbc5b9bcf674e)
- 2026-10-10 03:30: Say that the worker's next preparation of an existing version applies the new controller's Pod templates and rolls changed Pods once. (fix-990-991)
- 2026-10-10 02:10: Require complete successful API responses before publishing the split-layout export bundle. (authoring-run/35b00357-b0c6-459f-aec1-b4fb63620dff - 0886f47d05fdeb2fa4359f4840fb77378d643bac)

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
