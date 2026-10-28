---
published: false
---

# Agent plugin deployment documentation history

This record preserves the dated changes to the Agent plugin deployment flow. See the [parent flow](../agent-plugins.md) for its context and overall sequence.

## Changelog

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
