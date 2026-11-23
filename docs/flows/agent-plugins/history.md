---
published: false
---

# Agent plugin deployment documentation history

This record preserves the dated changes to the Agent plugin deployment flow. See the [parent flow](../agent-plugins.md) for its context and overall sequence.

## Changelog

- 2026-11-21 12:38: Document rejection of duplicate hosted catalog selections. (authoring-run/c4d8dbfd-1681-4b5b-a0d6-45a805b2aa68 - 7dd321619d7400e144f805ec7b9bde5e98b59ed2)
- 2026-11-20 19:04: Refresh sources. (authoring-run/8a8bde8b-71de-4de5-80bf-e32f0e335c34 - 220f62d86ceb3dfc6f66dbee7c6f86cda50e5d05)
- 2026-11-20 16:13: Update discovery source. (authoring-run/88a672f2-519f-40b1-8422-9bdafa6636fa - 83c718c15ec9fed6fcc77f8db70c81982bdfd566)
- 2026-11-20 06:15: End a silent plugin-request WebSocket preflight within 400 ms. (authoring-run/b72f51ee-120b-45ad-ae2d-faa889f8b0ef - 4c9357e905eb)
- 2026-11-19 01:12: With the runtime pin at OpenClaw `44f24d8398`, dedicated Codex lists a pinned Skill Library skill by name and description with a note to read it through `skills_read` instead of its Gateway-only path. (authoring-run/0cdd91e7-47ea-4661-a124-c23fd4479805 - cea7d46c6956c59ba9604a710022159930eb5aa4)
- 2026-11-18 22:08: Allow Gateway-side read-only `skills_search` and `skills_read` over session-eligible skills in the default Gateway tool policy, so a dedicated Harness can read skills whose files exist only in the Gateway, such as pinned Skill Library instructions. (authoring-run/19cca54a-1443-4e43-87cd-86a89718b7e4 - 715d7cfbc45f99abdfe9181049affc68218db2c2)
- 2026-11-18 06:02: Describe static Google action and discovery paths at admission. (authoring-run/c5b621b3-7d32-4ae1-a88e-295aab3e7532 - 99e7ca47e0d979596f3834a16a73e6ad17cf66ae)
- 2026-11-17 21:20: Check guard compatibility before attachment. (01a1eb01-409e-7270-a471-5a104ce7b468 - a5ebff48cd9cb180ea21ecd9740a034fde254864)
- 2026-11-17 19:48: Trace OpenClaw deployment requirements through account validation. (01a1eb01-409e-7270-a471-5a104ce7b468 - 23b54e2855d0a8d60b2168588fe8c7d7f06e9b36)
- 2026-11-12 11:28: Accept omitted hosted executor metadata. (authoring-run/b8442d2f-2982-4cf1-8421-13f99290aa97 - b80d084ba843cb8e9ff99e9550bb35dcf6b820f6)
- 2026-11-05 21:02: Trace plugin JSON refusal. (authoring-run/ead82952-8ee4-4f4a-82fe-148da7fa2edc - 3768cfd0d640f450f485cb334b6753ac1e5ea1c3)
- 2026-11-05 13:37: Trace plugin-policy refusal recovery. (authoring-run/9cb771c4-f1a8-44ec-a4ef-7c914a5ddb6e - a8259883139ac831b32c0a7b0fe872f6db4ee290)
- 2026-11-05 01:02: Select the Harness catalog and recheck its identity before cutover. (01a169f0-a851-7b81-8e83-ff597893aa21 - 0e9575278)
- 2026-11-03 01:40: Trace startup of multiple managed packages on one dedicated Agent. (authoring-run/e29308a5-ef76-4952-b439-23483c4dbd99 - 54b2a30498f690e2a16a3198e84a6363f69d91ae)
- 2026-11-03 01:10: Describe hosted MCP packages and Driver-owned request policy. (authoring-run/1bd8c7a3-997a-45b2-93a4-e24d114c9ca8 - 4178b555ac5dc711c818055bd7fe34c3e4d4943b)

- 2026-11-03 00:16: Describe plugin types. (authoring-run/c005ad62-46dd-4f91-8224-3934bc3dbfe7 - e1a6ce75ac414131e759b985d280833b3b26b90e)

- 2026-11-02 23:59: Discover live MCP tools. (authoring-run/f6c72b81-af00-4c3d-9758-96b1d6ca64b1 - 6f95625048a1d20ebb5cc6e26368192b3300849c)

- 2026-11-02 23:45: Describe discovery and deployment from a managed MCP release. (authoring-run/39268f6b-739c-4af1-82dd-3ecfe85d6ffa - 5d58446a2a6e200510da738698ef832612aab50d)

- 2026-11-02 22:29: Trace the Slack account and tool selection through dedicated Agent deployment. (authoring-run/84451153-a081-4e74-aa29-e1a4acecddad - 5c0623f136d881356cec3c104b8657c761c14782)

- 2026-10-31 05:52: Classify native install failures. (authoring-run/86b48c89-0c80-493f-b48a-6999988d4766 - 6d941c15081e95ef36b4ba1ffbbbc0b117972c0a)
- 2026-10-31 03:36: Restore experimental plugin search with the upstream Codex version. (authoring-run/dc99918c-2f5c-4141-bffd-b216830017d0 - 25364fcfdc905e95b5a813a6cd7b2de47b66ca71)

- 2026-10-28 14:40: Trace worker installation and discovery of Slack MCP tools. (authoring-run/55da35a7-f123-436e-9c32-65036b85894d - 0ba3c0fd5a26a82dba6551f04b74a697c5324fdd)

- 2026-10-31 03:03: Resolve plugins through the pinned catalog API with these changes. (authoring-run/19fe4474-0b66-462e-9fcd-5afe08fe9c8a - d10715a3d0dfef7592ca35efebed0b3c6867c7ab)

- 2026-10-29 22:19: Release deferred catalog loading when its tab is no longer current. (authoring-run/7a2bb516-4223-4156-b1a8-1d89f60a54d4)

- 2026-10-28 22:10: Move Google request checks to the shared execution-cluster guard. (authoring-run/c087e31e-0fa9-4e3c-b838-1d07f0e65106 - ce4688a9)

- 2026-10-28 20:30: Trace independent credential attachment, Google request authorization and recovery after withdrawal. (authoring-run/eb0c7e7c-b271-4619-851b-f117782bdded - dbe0d78a)

- 2026-10-27 17:55: Trace the Google account binding and the worker’s guarded request. (01a169f0-a851-7b81-8e83-ff597893aa21)

- 2026-10-27 16:32: Trace the Google package from selection to worker installation. (authoring-run/008c4288-2df5-4712-a902-c0f0ed7608f1 - 838c18304a845fc025e0639aaa223b9ef9d6ef3e)

- 2026-10-27 15:00: Repeat a stop signal that OpenClaw ignored during an in-place restart (finding 2711). (fix-2711-gateway-stop)

- 2026-10-27 03:30: Check the Gateway tool policy at Configuration save and for embedded Agents on every Compute, not on maintenance passes (findings 2688, 2689, 2694, 2695). (fix-2688-policy)

- 2026-10-26 20:21: Stop hosted reads on disconnect and clarify credential checks and catalog results. (authoring-run/dc13892f-22e2-4838-b5d7-a716768e7243 - cbad284a4d3d5f567e96e6c3dbb3fc5e7b86b14e)

- 2026-10-18 03:00: Check the primary model's `tools.byProvider` deny lists and a sole entry's `alsoAllow` under a profile (findings 1855, 1857). (lows-1018c)

- 2026-10-18 02:20: Check roster entries' `tools.deny` in the OpenClaw Driver's selection check (finding 1848). (lows-1018b - 628ee9fbf)

- 2026-10-17 06:05: Preserve OAuth discovery changes while integrating the native reader fix. (authoring-run/629826fb-b521-49bb-865a-dbc1b5c975a5 - 23965d64cc2824f0c5a2b5d704f767fead13f11b)

- 2026-10-17 00:10: Contain non-object native catalog envelopes in the discovery error path. (authoring-run/3d8efdc8-6da6-4cf9-99f7-adebd5e5649d - 42fb0a90337209e28318765c1b537bc4f3623506)

- 2026-10-16 19:14: Apply the Gateway tool policy after plugin grants, before startup or peer respawn. (01a13683-3916-7880-b1a6-27175b853600 - b768af1b24c6d9130e46eb0bb470fa761ade2bfb)

- 2026-10-15 22:26: Reconcile main and OpenShell OAuth in the accompanying merge. (authoring-run/41e4bb7a-c8eb-4332-b1f9-07fb8e234f63 - b747cf5b6402ad36ce9f1ae6dbed08928ddcf3dc)

- 2026-10-15 04:39: Grant read-only access to bundled Codex system skills. (authoring-run/97a67c3a-0aaa-4d59-bccf-19183079b169 - 00bbc7cd976ab7be317ce1e0a9d36ad72ce10567)

- 2026-10-14 12:23: Document runtime-status streaming limits and oversized error responses. (authoring-run/a404e7a3-9acf-4b50-9307-31e50b1b3582 - 4727e9b109a2127150e03e39e859d45e0668f82f)

- 2026-10-14 17:46: Preserve Docker Codex readiness reasons and transport codes when a loopback status response is interrupted. (issue-2403 - 944068b35b5a9bd86a3b1cf7361038a12b3de71a)

- 2026-10-13 09:37: Reconcile current admission and lifecycle behavior with external OAuth custody in the accompanying merge. (authoring-run/fd902939-ed58-4508-8d33-95a863d966af - e8d39978d801e7a5a8ac7242f32035f426da94e1)

- 2026-10-10 09:00: Render `on-failure` as the Gateway's `on-request`; Compute refuses `untrusted`, and the Codex PluginDriver an automatic reviewer without an explicit policy. (fix-987-988)

- 2026-10-10 04:49: Preserve writable native configuration during Harness peer recovery and same-Pod container restarts. (codex/thirty-compute-07-oct10 - 8e5a06ce)

- 2026-10-10 04:10: Check the Codex automatic reviewer policy at Agent create and update too. (fix-994-995)

- 2026-10-10 04:00: Hold an unusable writable-configuration peer bridge record unready with its file and remedy named. (fix-994-995)

- 2026-10-10 00:30: Keep the earlier Codex `config.toml` of revisions prepared before an upgrade. (fix-982)

- 2026-10-09 17:01: Clarify that CredentialGateway retrieval may refresh before authorized plugin discovery in the accompanying change. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - 4f902e2ab7738568fc8bb278296e54255355b8b7)

- 2026-10-09 15:02: Preserve the configured Codex session approval policy during startup. (authoring-run/72c276e8-6db5-44e5-aac1-f9e3fdc34ff2 - 504bf89a0707b66e1612d26e3d67ed6f6b16232f)

- 2026-10-08 22:00: Integrate validated plugin default-off grants before native install, with final app-policy verification and skill-only selections. (authoring-run/74dc7eaf-a67b-47ef-91bd-2ecd0463fb10 - 65911984b3f6d9ee398aed913a0b8dd08e2ae094)

- 2026-10-07 17:42: Replace login-bundle discovery with warm CredentialSource token callbacks. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - da984340a)
- 2026-10-07 19:30: Pass the admitted model to native Codex before reviewer validation. (authoring-run/bc793557-585a-4c1a-9463-b2c55682ea02 - b1be0e0602b9db1035a689ca2a4ac4982f6d0b3b)

- 2026-09-30 13:32: Clarify readiness and routing propagation. (codex/01a0b0e4-839a-71b3-9ec1-3b1000b5d06a - a0ca6376)

- 2026-10-04 05:00: Recheck Create Agent discovery grants after the Secret read. (bughunt-11)

- 2026-10-01 00:57: Reconcile peer recovery with current runtime. (codex/01a0b0e4-839a-71b3-9ec1-3b1000b5d06a - e57e777238104b1de0d3bee5c6c631722c4af575)

- 2026-09-30 02:10: Recheck the peer before replacement readiness. (authoring-run/fc09b5f8-3fc8-4144-ac80-8bfd8ef24f52 - ed69e6eee87ca004d2970069e8e18cf4cce29a32)

- 2026-09-30 00:33: Propagate Gateway exits while awaiting peer recovery. (authoring-run/bf3b8146-9d72-42a4-84e5-2293581c890c - 0d72f6a4e4e3003d457c4498e81e7de414f85649)

- 2026-09-28 21:26: Batch Codex metadata reads; preserve ordered writes and verification. (authoring-run/7c8bff1b-a2d1-48f6-a996-1be6a06719fa - 8352c0932bcbde43e88b44c6975496ca5431ff55)

- 2026-09-28 10:46: Materialize inherited app policy; native proof pending. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - 44ed2405)

- 2026-10-03 18:00: Create discovery and existing-Agent `oauthLogin` discovery reject a Secret reference to another Namespace as an invalid request instead of not-found. (binding-400b)

- 2026-09-28 00:02: Reconciled Codex startup policy verification with approval scopes. (01a0b17c-68b6-7e11-bedc-f74de7d606ed - b96eadc1)

- 2026-09-27 23:40: Catalog prefetch and loading feedback. (01a0e53a-f2be-7bd1-a9c1-36e827b2ee47 - b38554ac)

- 2026-09-27 22:17: Document native Codex bundled skill support and pending account-plugin activation restriction. (01a0d4f7-8085-70e0-9d0c-69a465a81fe3 - 19f72841c3aed621137bd438ae91fa016c39b292)

- 2026-09-27 21:52: Debounced catalog searches and canceled obsolete requests. (01a0e4d2-4f51-7780-b0fc-2352cb99078f - a599db7e)

- 2026-09-27 20:21: Documented approval mapping. (01a0e3cf-cfd3-7c02-91ac-19a0efbd7645 - 0663fa97ed5c0fcabc680241dbe7fbde9fde3562)

- 2026-09-27 06:07: Expanded the curated catalog and marked unsupported releases unavailable. (01a0e176-b1ee-7641-85e8-c167f10c6a66 - eb3d6c4c0b8881e5f7efe17c03cc05357e7c7734)

- 2026-09-27 05:49: Added selected token-free curated catalog discovery and preserved runtime credential checks. (01a0e164-ee0e-7c51-a28f-b1179d5917dd - 7812d81bce78a415b7a47b4e335812304caf98ea)

- 2026-09-27 05:38: Resolve catalog IDs through owned runtime metadata. (01a0d4f7-8085-70e0-9d0c-69a465a81fe3 - 6f7534fa)

- 2026-09-27 02:41: Authorize the selected Secret before reporting unsupported plugin discovery. (01a0e099-da9d-78f1-8e79-ea4a919edf7d - 36cb6d6a4a515ad7328eb596b3da174f262f6d18)

- 2026-09-27 02:03: Link the Agent approval and channel directory flow. (01a0df20-f340-7810-bb59-b1df6c0bbbd3 - b2de165412191a4c9d124acf59fa1efb25cc29d6)

- 2026-09-27 02:08: Added exact-Secret-authorized transient plugin discovery and current-value reads. (01a0e099-da9d-78f1-8e79-ea4a919edf7d - 41aae7750e33b8739efc5f7c6a0ebd160f42f711)

- 2026-09-26 21:38: Added Agent skill paths. (c5a050f1-e44a-48c1-9c18-f7661d50623f - 41aae775)

- 2026-09-26 19:16: Saved-Secret discovery. (authoring-run/828a8a37-a9f6-4bb5-9eed-912780152d5c - e5867bcd)

- 2026-09-26 17:42: Document Console new-revision plugin editing and read-only revision snapshots in the accompanying change. (authoring-run/3aa63184-7716-4d27-90ed-33974110d0f5 - cdd6e3c8413f7cca4909f98d2d4c5f6bd17dbe54)

- 2026-09-24 23:36: Normalize equivalent Codex category defaults during verification. (01a0b17c-68b6-7e11-bedc-f74de7d606ed - 8ce00a84)

- 2026-09-24 23:09: Clarified disabled-app verification and shortened startup readback prose. (01a0b17c-68b6-7e11-bedc-f74de7d606ed - 27d44ac0)

- 2026-09-24 19:44: Added Driver-owned setup and recovery links. (01a0d1dd-aa36-7622-9f43-8376f6ff935e - ef89ded5)

- 2026-09-24 08:00: Added transient PAT discovery through the selected PluginDriver before Agent creation. (01a0d1dd-aa36-7622-9f43-8376f6ff935e - f62e17c)
- 2026-09-24 07:50: Verify nested tool and account/link policy before readiness; retain session and live-enforcement gates (codex/01a0b17c-68b6-7e11-bedc-f74de7d606ed - 073bb5c1)

- 2026-09-24 07:02: Aligned the common reviewer contract and scoped capabilities with the accepted specification; runtime reviewer/session checks remain draft gates (codex/01a0b17c-68b6-7e11-bedc-f74de7d606ed - 3606f2e9)

- 2026-09-24 06:19: Documented nested policy validation, capabilities, owned-tool discovery, and native configuration translation; compatible session/runtime enforcement and live proof remain required (codex/01a0b17c-68b6-7e11-bedc-f74de7d606ed - d39727589)

- 2026-09-21 21:23: Reconciled policy composition and installation without enablement changes with optional-plugin warnings and the bundled Driver reference; runtime release and Kubernetes proof remain pending (codex/01a0b17c-68b6-7e11-bedc-f74de7d606ed - 9405e20)

- 2026-09-21 19:15: Ignore template metadata while retaining concrete app policy and startup mapping checks. (codex/01a0b632-4907-7362-9c51-28129db5a3b9 - aa6dd741)

- 2026-09-18 17:38: Documented plugin policy conflict rejection, tool allowlist composition, and installation without enablement changes; runtime release and Kubernetes proof remain pending (codex/01a0b17c-68b6-7e11-bedc-f74de7d606ed - 724dcb5)

- 2026-09-18 17:17: Linked plugin warning persistence to the generalized controller work result. (codex/01a0b0fc-4a24-76c0-8fb7-f3a3a434d464 - 6a582ce9)

- 2026-09-17 20:28: Replaced terminal plugin receipts with verified optional-plugin exclusion, current startup status, and successful deployment warnings; runtime verification in progress. (codex/01a0b0fc-4a24-76c0-8fb7-f3a3a434d464 - 7771526d)
- 2026-09-17: Verified native OpenClaw and Codex plugin turns, successful warning persistence, failed selection exclusion, and Agent-only restart recovery. Ordered initial dedicated gateway startup after its Agent status dependency. (codex/01a0b0fc-4a24-76c0-8fb7-f3a3a434d464 - a5a11ad1)
- 2026-09-17 20:28: Removed the first-failure receipt and acknowledgment lifecycle under the approved best-effort plugin decision. (NOT_IN_SPEC)

- 2026-09-17 15:02: Added the Kubernetes receipt and terminal plugin-failure path for Compute-owned plugin startup without claiming native proof completion. (codex/01a0b0fc-4a24-76c0-8fb7-f3a3a434d464 - 58ead994)

- 2026-09-08 16:05: Corrected Codex Linear support to the existing bridge path and kept live local-Kubernetes proof pending (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 79021fa)
- 2026-09-08 17:02: Recorded current Codex Linear proof boundary: native install/readiness passed, bridge app batch request passed, force-refresh app state showed Linear enabled/callable, and a normal turn invoked Linear `list_teams` before timing out in native `waitingOnApproval` without a result (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 79021fa)
- 2026-09-08 17:34: Recorded the native diagnostic blocker: direct Linear execution requires app reauthentication, the diagnostic native model turn emitted a Codex Apps URL elicitation that was declined, and normal OCC proof remains pending reconnection and rerun (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - b4fa273)
- 2026-09-08 18:05: User substituted Google Calendar for the required Codex live proof; Calendar curated metadata and normal-turn `list_calendars(max_results:1)` proof remain pending, while Linear remains historical connector evidence (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - b4fa273)
- 2026-09-08 18:12: Verified Google Calendar curated metadata from live Agent cache after native install: `google-calendar@openai-curated-remote` version `1.2.7`, app `connector_947e0d954944416db111db556030eea6`, `required:true`; Calendar normal-turn proof remains pending (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - b4fa273)
- 2026-09-08 15:30: Added opt-in Kubernetes and test-only Docker plugin proof prerequisites without claiming live proof completion (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 1471b4c)
- 2026-09-08 14:30: Documented plugin admission, the Codex 501 boundary, and serialized OpenClaw replacement (codex/01a082a0-aa05-7af0-af28-5568d12d623f - 1471b4c217e4879a6b430890ac216b2026e9bd46)

- 2026-09-08 18:18: Google Calendar 1.2.7 normal-Agent acceptance passed with the designated service account, matching tool/result evidence, and zero skips (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - ef51e45).
- 2026-09-09 13:39: Updated the flow for Agent-owned plugin maps, full-map replacement, startup catalog resolution, and revision snapshots that freeze requested state rather than native release artifacts (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 237dd0a).
- 2026-09-09 14:50: Simplified bootstrap and catalog projection, kept native metadata/configuration readiness, and standardized both native plugin proofs on Kubernetes (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 44f80f2).
- 2026-09-09 15:49: Aligned bootstrap/install ordering, replacement semantics, and pre-commit versus post-commit failure and worker completion with current implementation (codex/01a08228-c3ec-7ab2-b0c0-74f49a8ec8a7 - 08abf9c).

- 2026-09-11: Removed the per-Agent plugin inventory GET and its inferred installation query. Read desired selections from Agent configuration and deployment outcomes from existing revision/status surfaces; native catalog discovery remains available to the PluginDriver. (NOT_IN_SPEC)
