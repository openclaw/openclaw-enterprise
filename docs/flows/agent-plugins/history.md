---
published: false
---

# Agent plugin deployment documentation history

This record preserves the dated changes to the Agent plugin deployment flow. See the [parent flow](../agent-plugins.md) for its context and overall sequence.

## Changelog

- 2026-10-03 18:00: Create discovery and existing-Agent `oauthLogin` discovery reject a Secret reference to another Namespace as an invalid request instead of not-found. (binding-400b)

- 2026-09-28 21:26: Batch Codex metadata reads; preserve ordered writes and verification. (authoring-run/7c8bff1b-a2d1-48f6-a996-1be6a06719fa - 8352c0932bcbde43e88b44c6975496ca5431ff55)

- 2026-09-28 10:46: Materialize inherited app policy; native proof pending. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - 44ed2405)

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
