---
published: false
---

# Harness execution topology documentation history

This record preserves the dated changes to the harness execution topology flow. See the [parent flow](../harness-execution-topology.md) for its context and overall sequence.

## Changelog

- 2026-10-23 13:33: Trace protected Codex connection failure behavior and condense the activation flow. (authoring-run/d909ff44-894e-4e57-91e2-ab5bea7532c7 - 162c9131f3dacb48979fba68bec7e88af317e6b3)

- 2026-10-23 07:40: Resolve documentation conflicts. (authoring-run/01a10a81-070c-7aa3-97d0-fbce8f285d4d - 13f38c6206926541c354a50e92200502dae52130)

- 2026-10-22 23:01: Merge current upstream lifecycle and source-bound native endpoint documentation without changing runtime behavior. (agent:roboclaw:dashboard:578a8b10-8406-4f5c-a2cc-21ab6524bf68 - 88df65bada94a85fff7fd50eb0728423b58dbb31)

- 2026-10-22 22:10: Gateway readiness also requires native `/startupz`. Native `/readyz` admits a Gateway while OpenClaw still inspects its agent databases in the background, for example after an unclean stop, and the first chat turn then failed with HTTP 500. `/startupz` holds until that inspection ends. (fix-2185 - 16e97918f)

- 2026-10-21 05:00: Validate execution peer label types. (authoring-run/9c5e8c34-6292-465b-a82a-7b56e03b535d - e8185dac805b737363c7178d3068b310a53a7c24)

- 2026-10-20 00:53: Record Gateway managed-mode deployment, launch, and replacement. (Codex/01a1558e-c27f-7bc0-a403-af59e9364ddf - cde9a870aa0be0e168a8eabb2c031369fc8508ff)

- 2026-10-17 17:48: Restrict custom native endpoints to CredentialSources and retain upstream temporary-directory ownership. (authoring-run/b639668e-1ef2-4d43-bed4-ed1a6a4be5d6 - 7eebfc12c)

- 2026-10-17 15:09: Preserve compatible native model endpoints and private worker temporary state. (authoring-run/b639668e-1ef2-4d43-bed4-ed1a6a4be5d6 - bcdb0b10f)

- 2026-10-16 17:02: Persist worktrees and Git sources. (Codex/01a13654-be66-7741-b54f-f8ae80f2d496 - 68b95a2514f183b194a478e72d734b719bf4c2e8)

- 2026-10-14: Merge current contracts with native provisioning and retained-workspace preparation. (Codex/01a13654-be66-7741-b54f-f8ae80f2d496)

- 2026-10-10 04:41: Reconcile endpoint validation and routing with credential refresh, native approval and readiness contracts. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - 90268463bbd255c3c13a0e0bdeb437728189eb1a)

- 2026-10-10 02:49: Refuse native listener TLS before deployment work. (authoring-run/8446b4d7-87ac-43ab-9323-5fc7f6953628 - 5d303757fb488fe34c8cbb9e7b6b975921fc1061)

- 2026-10-10 00:29: Reserve private status TCP/18791 before native listeners start. (authoring-run/edaa639f-bb63-47bd-9fa4-83e9ff735733 - 3e34cc0f4b469d29fc79d2c10a33f87a0921ee47)

- 2026-10-09 20:27: Integrate main lifecycle, native workspace and readiness contracts without dropping endpoint safeguards. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - 90268463bbd255c3c13a0e0bdeb437728189eb1a)

- 2026-10-09 18:44: Resolve an adopted split-layout storage namespace as the tenant namespace only while it keeps its storage label. (fix-533-adopt)

- 2026-10-09 17:35: Qualify explicit subagent selectors; rename the Codex endpoint option. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - f9126efaada11f8cc18931aa8327f7e16cae59b6)

- 2026-10-08 15:29: Trace default pinned-runtime support and native Node model-egress allowance in the accompanying change. (authoring-run/da7b4107-43b4-4a3f-b941-194218df6457 - 13405e1fee089db09c4d592e6dba7adb566f3b17)

- 2026-10-08 14:19: Move Kubernetes runtime readiness to private HTTP with unchanged gates. (authoring-run/5a25b09c-b1c6-4dd2-b281-8b10a847e8b9 - aac339d52e472dd96489599dc1818da414abf556)

- 2026-10-08 04:40: Reconciled dedicated endpoint flow with current native callback routing. (authoring-run/02228d02-e16c-4a55-9a43-16b9efb35ebe - 31b1b6a9ab59f219d0fbe3d44b1550f8c8f2fe4a)

- 2026-10-08 02:42: Align the admitted native Agent workspace and Gateway file-transfer binding with OpenShell's approved data mount. (authoring-run/4fbff731-5f62-4865-9fee-a2a117c3d0a6 - a8d2969355bd3c0478337e16a01e267ad3607595)

- 2026-10-08 02:38: Consume the Driver-owned native workspace path so OpenShell file operations reach the admitted mount. (authoring-run/4fbff731-5f62-4865-9fee-a2a117c3d0a6 - e23d7dc5bf63ca103d6c7dec76d36ced9e1fbf5f)

- 2026-10-08 02:28: Project dedicated native models through canonical node configuration in the accompanying change; retain required placement and separate image qualification. (authoring-run/4fbff731-5f62-4865-9fee-a2a117c3d0a6 - 1f97586276fde1dbddec9f14dca3d6d783aade63)

- 2026-10-07 12:07: Unify imported and managed PAT authentication while preserving source ownership and existing OAuth behavior. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - be5006e62)

- 2026-10-06 11:17: Reconciled endpoint flow with current namespace and provider provisioning; condensed repeated prose. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - b6dc6b87a461ad33374e133d15cc739d8e074fea)

- 2026-10-05 14:24: Route dedicated Codex native hook callbacks with per-relay capabilities. (authoring-run/05067642-df93-4716-8f90-5b7430e50c41 - dfa091b6)

- 2026-10-05 11:36: Normalize runtime endpoints with the shared Driver validator; trim repeated topology narration. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - 9958ef0412565864efba7b13995536d7c2a51d22)

- 2026-10-05 00:06: Add custom Codex Responses endpoint selection and explicit native-provider rendering while preserving admitted model IDs and Harness-only credentials. (authoring-run/4e4824a1-f107-44c2-90bf-00fe13ff650c - d269c6d03)

- 2026-10-03 16:02: Run configured development API and worker Compute preflight before admitting work. (01a0fe72-58b2-7cc3-b770-7310f5401deb - c04093189f2ba6240f8dc431847c2f487afd11de)

- 2026-10-03 15:38: Refuse unsafe split-layout upgrades and converge concurrent legacy password creation. (01a0fe72-58b2-7cc3-b770-7310f5401deb - 94364ae9)

- 2026-10-02: Stabilize canonical credential layout across execution modes with legacy source compatibility. (01a0fe72-58b2-7cc3-b770-7310f5401deb)

- 2026-10-02: Retain dedicated predecessor projections during shared-namespace embedded cutover until Harness retirement. (01a0fe72-58b2-7cc3-b770-7310f5401deb)

- 2026-10-02: Share the single-cluster tenant namespace while preserving role-specific runtime delivery and version cleanup. (01a0fe72-58b2-7cc3-b770-7310f5401deb)

- 2026-10-02 14:00: End node pairing and ack waits early for claimable Work. (r7-d221)

- 2026-10-02 12:00: Delete a replaced embedded predecessor's Secret and ConfigMap copies at activation re-render. (fix-d280-embedded-retire)

- 2026-10-02 06:00: Budget the workspace node binding ack wait per binding across activation retries. (fix-deploy-node-pairing)

- 2026-09-30 21:00: Delete a repaired embedded predecessor's Secret and ConfigMap copies at repair time. (fix/dogfood3b-1)

- 2026-09-30 10:30: Repair a never-served unready embedded Gateway during redeploy with pending workspace setup. (fix-dogfood-1)

- 2026-09-30 09:54: Correct dedicated replacement: the worker stops the predecessor Gateway before preparation, so redeploys interrupt service. (authoring-run/a37a9c9b-9e94-4bd2-88c5-dfa5c5f94d12 - 90899dc55ab7)

- 2026-09-30 09:30: Include the Harness network profile in Service selectors for EKS policy resolution. (authoring-run/1373b7f3-e273-466a-b9da-bb197bdb469e - 0d00e8970b69)

- 2026-09-28 02:55: Trace dedicated native OpenClaw on paired node hosts with full-facet Sandbox provisioning. (oce-pr-440-sync - e2b739f51f89)

- 2026-09-25 18:25: Document candidate Gateway bootstrap during dedicated recovery from an unready predecessor. (authoring-run/9b15ee1e-3767-4dd0-8d9a-56ad2087dcb5 - 7b2345a3cd6e78b9c7c8bae530f3379db56be443)

- 2026-09-24 13:08: Align the dedicated Harness Service selector trace with gateway-to-Harness NetworkPolicy matching. (01a0d504-19bd-7833-9ef5-237750f5831a - b4b6a0e0d8700930f21d58b3724c055f8249c486)

- 2026-09-24 11:28: Document exclusive dedicated preparation and durable RWO workspaces in the accompanying change. (01a0cf72-6985-7712-ba92-d8cc32470f24 - 14a4508baad876d3eea4e6fe6388f8d8a91559b7)

- 2026-09-23 13:13: Keep fixture credential delivery namespace-local, matching native runtime placement. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - df4ca4474d90de2d4ab0dd6f6d03a64ebb92526a)

- 2026-09-23 12:38: Guard cross-mode retirement and inspect both targets during final Agent cleanup. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - 25a520de9d0259c3ae6b7ef6d7c0e7e6ccce0349)

- 2026-09-23 12:26: Describe canonical CP sources and the selected DP runtime projection. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - 429f46735be45247c3b8a406e1c9f57c2ef0327f)

- 2026-09-23 11:31: Trace dedicated control-plane Gateway placement, scoped credential delivery and cross-namespace lifecycle. (01a0cf72-6985-7712-ba92-d8cc32470f24 - b141ba1157c2f28276717d35c8c63028f209a479)

- 2026-09-23 03:24: Move durable claim cleanup from revision retirement to Agent deletion. (01a0cc43-d13b-7cb2-ae15-1fd56e61bbf4 - 43776d25c5007e017f7d0ffdca6b06f063afcd37)

- 2026-09-22 22:31: Describe supported auth admission without legacy gateway credential compatibility handling. (authoring-run/d7126920-6a2a-4126-ad7d-fafd57593855 - c387eef76420f05a060689d2fa04b57a3e416956)
- Removed legacy gateway credential compatibility handling. (NOT_IN_SPEC)

- 2026-09-22 22:02: Trace Docker managed gateway passwords while preserving harness admission limits and Codex transport authentication. (authoring-run/b91ebd83-2105-4b1e-aad8-6747fe22c2f1 - 01b42feaf8321e231fbe23a80e00ba641bb9fbcb)
- Bundled Compute Drivers use managed passwords or trusted proxy for native gateway authentication. (NOT_IN_SPEC)

- 2026-09-17 19:14: Distinguish SSH operator credentials from Kubernetes managed authentication. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - b8cabaf9a49e069a7668ccf88b9e71a7484227b7)

- 2026-09-17 02:58: Remove embedded preflight and trace shared-gateway cutover before actual startup credential validation. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - cfb384f22ebcbadcfb421b3020b4bb72fd657160)

- 2026-09-17 01:10: Document native authentication gates before dedicated readiness and embedded replacement cutover. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - 177a24e4)

- 2026-09-17 00:31: Align credential selection and delivery with Agent harnessAuth and the shared Kubernetes rendering path. (01a0acc2-a404-77e3-b1a0-9fa4ffbbdb04 - d2bcbd1c53acb2582a774b5158f254d726abd33f)

- 2026-09-01 19:09: Corrected Kubernetes after-commit activation semantics and merged the dedicated shared-workspace runtime ordering into this topology trace. (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)

- 2026-08-28 21:20: Removed host-process local-test topology coverage; document Docker and Kubernetes runtime execution and verification. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 3ec166eb5fae39ed0f51ffb5ebd93338c4a2db94)

- 2026-08-28 17:58: Updated moved feature-reference links for the documentation organization. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)

- 2026-08-27 00:05: Replaced the removed schema-contract suite with the authoritative harness-placement conformance test. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - ab560806dbd945436835ab092ebd10bf3e50d942)

- 2026-08-24 23:46: Distinguished operator-materialized API keys from API Compute-owned account Secrets, provider-neutral revision snapshots, direct dedicated-Codex token projection, and worker Secret authority. (01a03542-30ff-77a1-9967-587d55548ace - 51033bee121374332df2791e90e2290a5c892e5d)

- 2026-08-21 19:17: Documented explicit placement, immutable native Harness resolution, embedded versus dedicated Compute ownership, existing production credential/transport boundaries, recoverable activation, and two real provider-turn integration scenarios. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 149882c)

- 2026-08-21 14:01: Consolidated explicit runtime selection, canonical approval, isolated dedicated credentials, predecessor-safe activation, and real dual model-turn proof. (01a021b2-292b-7ee1-ab55-4f8dc4f0ba7c - 8796ccc)

- 2026-08-21 12:43: Documented dedicated and embedded model execution, the supported shared model, isolated in-memory Codex authentication, managed execution policy, and bounded proxy propagation. (01a0119a-9843-7423-a4c6-955ff4187bd9 - be58d1b)
