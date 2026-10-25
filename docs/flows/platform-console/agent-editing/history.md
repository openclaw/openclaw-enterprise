---
published: false
---

# Console Agent editing documentation history

This record preserves the dated changes to the Console Agent editing flow. See the [parent flow](../agent-editing.md) for its context and overall sequence.

## Changelog

- 2026-10-25: Agent-side tabs follow the reread after a channel save; Disable waits for a rebind. (findings 2470, 2471)
- 2026-10-25: The sources note names a Harness ServiceAccount's `read`. (finding 2459)
- 2026-10-25: Channel saves may replace unoperable Secrets. (finding 2444)
- 2026-10-25: Secret pickers refuse readable Secrets the caller may not `operate`. (finding 2453)
- 2026-10-25: Draft labels, recovery and inline Secret creation follow permissions. (findings 2441, 2442)
- 2026-10-25: Agent-side editors follow bound source `operate`. (finding 2441)
- 2026-10-25: Readers see the draft read-only. (finding 2421)
- 2026-10-25: Mark failed versions from the revision list. (finding 2422)
- 2026-10-24: Restoring parked Workspace files applies the latest observed Agent operate answer. (pr-3474)
- 2026-10-24 17:30: Stop and Run diagnostics follow the latest observed operate answer. (fix-2328)
- 2026-10-24 23:40: Apply a newer Agent operate answer when parked Workspace files return, and keep unsaved text if operate is removed. (workspace-operate-restore)
- 2026-10-24 22:05: Say in the Secret value help that line breaks are saved as LF, as browsers normalize textarea CRLF. (fix-backlog-1024b)
- 2026-10-24 19:00: Check inline Create Secret names and values with the API's rules, keeping multiline values exact. (fix-2339-2341)
- 2026-10-22 13:00: Rebuild after a plugin save from the save response, so a Stop requested on the page stays shown. (bughunt-1022b)
- 2026-10-22 10:28: Distinguish a missing workspace file from an unavailable Agent, on first read and after an uncertain save. (01a162e5-4303-7a21-81d4-bb51cec37c66 - 596fdb088)
- 2026-10-22 10:14: Trace plugin save confirmation and recovery when the response is incomplete or identifies different settings. (01a162ec-b748-7c42-9034-1f0a92b05703 - 345d9f63d)
- 2026-10-22 01:30: Fill the folded Deployment activity row with a first record read after the page shows; keep the summary note and version record rows. (fix-2163)
- 2026-10-20 05:00: Move steps 7 and 8 (stop, deletion) to [their own trace](../agent-stop-and-deletion.md). (docs-split-1020)
- 2026-10-18 20:30: Show each failure's next step; add Deploy again. (ux-a1)
- 2026-10-18 12:30: Keep open Workspace editors when another version becomes current. (lows-1018h)
- 2026-10-17 09:01: Keep keyboard focus on the pending Configuration save. (lows-1017k-1646 - 5d82453999)
- 2026-10-16 22:40: Patch deployment polls in place; reserve pending rows. (ui-jank-code-12)
- 2026-10-16 00:38: Reconcile in-place OAuth save feedback after merging main. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - 697ca86d47f67a9671f07708f362bcfb671650e6)
- 2026-10-15 22:35: Reconcile failed-version recovery and OAuth editing. (authoring-run/8c4ab973-b5a0-4bcf-8fcf-5f9d908ea26c - c997748f661b5df1198047de5a97c9cf23fb241a)
- 2026-10-15 22:26: Reconcile current main behavior with OpenShell OAuth contracts in the accompanying merge. (authoring-run/41e4bb7a-c8eb-4332-b1f9-07fb8e234f63 - b747cf5b6402ad36ce9f1ae6dbed08928ddcf3dc)
- 2026-10-15 21:30: Separate selected version, recorded deployment, and live-serving uncertainty; surface failed-version recovery. (authoring-run/6d9b833d-e4fc-4f58-98a8-f0fac29f709d - 7adac57cc03545bdd3cdc383c88219396a677fd9)
- 2026-10-15 04:40: Hide stop controls for a never-deployed Agent in the accompanying change. (authoring-run/2aecf15b-82ac-4724-94d9-45b8c1c99fc6 - c78f96b706ce94dbfe6aadfdac9c40e7e7e759ae)
- 2026-10-13 09:37: Reconcile current admission and lifecycle behavior with external OAuth custody in the accompanying merge. (authoring-run/fd902939-ed58-4508-8d33-95a863d966af - e8d39978d801e7a5a8ac7242f32035f426da94e1)
- 2026-10-10 20:00: Keep untouched CRLF workspace files clean; only an edit enables Save. (public-pr/2000 - a3ca862c37d05ba850d3c9595e5668917d7f480d)
- 2026-10-10 08:46: Trace keyboard focus after Stop confirmation cancellation. (authoring-run/9c1f0e85-9f16-436e-900f-b3d0e6e8cdd9 - b8783d7942e875c6eb751222329c63fac5c028a1)
- 2026-10-10 02:44: Trace explicit missing-file readback after an uncertain workspace create in the accompanying change. (authoring-run/16c725e2-438f-46bf-a31c-305458ac49d8 - 5bf37b274fcdfefb49dfa99984a15d99b757dc8e)
- 2026-10-10 01:41: Trace confirmed manual deletion recovery and uncertain repeat readback in the accompanying change. (authoring-run/da61175b-df1b-4e96-b202-94e9e82538f9 - 243b38ba6d951240065e5061e1e4abccdb44410c)
- 2026-10-10 00:08: Trace explicit repeated Stop recovery in the accompanying change. (authoring-run/52a975bb-0283-40ba-9126-2c2f6eb8992c - 21f34928437fb7d6f4391ba4af5d3e15bf9ce480)
- 2026-10-09 20:35: Replace only the old Harness source binding while preserving unrelated sources. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - ece639c78)
- 2026-10-07 17:42: Trace exact CredentialSource grants alongside Secret grants after authentication saves. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - da984340a)
- 2026-09-29 20:00: Trace draft repository editing and save guards. (public-pr/374)
- 2026-09-29 02:55: Trace Gateway password access staging through the existing Configuration editor and save path. (01a0eb0e-dbc1-78d1-91b0-ea91ee87c00f - fdccee5cab532bc7ef2085c5ec6f8f922663f5ce)
- 2026-09-28 21:31: Trace metadata-preserving browsing and unreadable saved settings in the accompanying change. (01a0e9c2-e0cd-7ed2-a1b9-a70247c43db2 - 176a52892f72aefc45505f89ae6d33e7526fe4da)

- 2026-09-28 01:39: Move the sharing trace to its own flow. (authoring-run/462d5207-c3a1-4203-af4a-8db2551ccb9a - 4f32ebbca5d699296a142dfbd34c8ec46844fce7)

- 2026-09-27 21:44: Trace backdrop dismissal through existing cancellation handlers. (01a0e4d1-c52a-7231-9d1f-d2ceadb556d1 - ab9527bb2615168649438f7f591bd098083b62cb)

- 2026-09-26 18:38: Trace searchable Secret selection, editable names, and duplicate-name recovery. (01a0e069-9ef8-7d81-802c-82c72c1f1e5d - dc07fe34cd2b0057693777acf4db394d211da393)

- 2026-09-26 17:42: Trace Console plugin draft saves and immutable revision views in the accompanying change. (authoring-run/3aa63184-7716-4d27-90ed-33974110d0f5 - cdd6e3c8413f7cca4909f98d2d4c5f6bd17dbe54)

- 2026-09-26 05:16: Document first-deployment transport credentials; the SHA is the inspected baseline. (authoring-run/62448d39-d070-4830-87c3-cc8b66dece6f - 2a0f94bec87f9358f78a4e22d69404f87e16b989)

- 2026-09-26 00:37: Trace exact Secret metadata reads for draft and immutable revision summaries in the accompanying change. (01a0db1e-7ab2-7bf1-936b-e71c9d6f9911 - e387b38cc259ee4a55936ecb848bbce8210bcd68)

- 2026-09-25 01:15: Trace DM policy selection, sender validation, and organization-wide restrictions. (01a0d5e6-743e-7743-8a5e-2d8c24b78b81 - 919f92c3bb3ea63acf7042b138e9a0c6e1d97719)

- 2026-09-25 00:24: Trace authentication Secret grants, partial-save recovery, and persistent deployment errors in the accompanying change. (01a0d5ee-ab06-7571-8d4a-9ae0f33d5737 - 5f2f3a7448c7f5f0f4a5ed08be2395f2c5623ed7)
- 2026-09-24 22:03: Trace shared document-local drafts, navigation capture, explicit discard, and retained save baselines. (01a0d557-f6e3-7da2-af52-993d05735554 - a91cbfdd37b64c88b7ee48647096ff6bfd993e02)

- 2026-09-24 06:09: Preserve current Slack editing behavior alongside existing-person sharing. (01a0b0e4-839a-71b3-9ec1-3b1000b5d06a - c3a3913f0aded736b17140d6caa7c5c857641a9d)

- 2026-09-23 19:52: Record unsupported mixed Slack sender lists, unrepresentable sender IDs, and channel wildcard maps in the simple drawer. (01a0d150-104a-71a3-9e56-6c5e3ee510ea - 77aedc620f443056f9ee859050b8dc657a9c3133)

- 2026-09-23 08:30: Trace Slack Secret menus, immediate creation, staged bindings, and explicit IAM grants before Configuration save. (01a0cd92-fd3f-7d83-a51e-f6264ef6be09 - 941edc9f6971a24ae29a74a6ca749b6375e6ec01)

- 2026-09-23 02:26: Trace Slack credential navigation and preservation of unsaved channel edits; remove the generic drawer sharing footnote. (01a0cd92-fd3f-7d83-a51e-f6264ef6be09 - 380f7706e2856f1ac1e3bed7f5ddd9c71d133ba8)
- 2026-09-24: Use shared Secret pickers for draft harness authentication and Slack runtime credential bindings; switching references no longer overwrites existing Secret values.

- 2026-09-22 23:30: Trace native Configuration draft editing, save checks, and immutable snapshot navigation. (01a0ccc0-00fa-7173-ab45-f7a5fb55b3b6 - 0dabaafb97326254e5ae173491be014aaa6388c6)

- 2026-09-22 20:56: Rename the deployment-facing Console view to New revision. (01a0cc48-2eda-7fc2-a19e-096b68fccb7b - 081bccfcf3f5b114588dde1b42a0deb07f326017)

- 2026-09-22 20:43: Add confirmed Console stop requests and exact Agent state refresh. (01a0cc48-2eda-7fc2-a19e-096b68fccb7b - 6adfd148a517e84ae064a8e08438b051f80820fb)
- 2026-09-22 20:35: Trace metadata-derived Slack token masks and replacement-only Secret writes. (01a0cc48-2eda-7fc2-a19e-096b68fccb7b - 43776d25c5007e017f7d0ffdca6b06f063afcd37)
- 2026-09-22 20:23: Align Agent editing with supported Console controls. (01a0cc48-2eda-7fc2-a19e-096b68fccb7b - 43776d25c5007e017f7d0ffdca6b06f063afcd37)
- 2026-09-22 20:23: Remove the placeholder serving-status banner and unsupported Teams editor; retain deployment evidence and the Teams deployment guard. (01a0cc48-2eda-7fc2-a19e-096b68fccb7b - 43776d25c5007e017f7d0ffdca6b06f063afcd37) (NOT_IN_SPEC)
- 2026-09-21 21:46: Trace Agent deletion, readback, and recovery from denied or uncertain requests. (01a0c76f-2534-7991-932a-345782408759 - b61c3cae6c35e28db4153eaee9b477e8f5637894)
