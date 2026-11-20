---
published: false
---

# Credential source lifecycle documentation history

This record preserves the dated changes to the credential source lifecycle flow. See the [parent page](../credential-source-lifecycle.md) for its context.

## Changelog

- 2026-11-20: Document native staged Proxy operation and holds. (01a1eae9-8497-74d2-a9c7-9bc93809e94a - 291d3b1de)

- 2026-11-20 04:20: Link the separate internal static custody flow. (authoring-run/1a7c3a53-041d-40fe-bdea-664eca7f6d97 - edd728580)

- 2026-11-19 03:15: Keep the flow current while moving catalog enforcement to a separate change. (authoring-run/b0e8e24d-3e5e-40a1-ae3b-10e0dfe3e6a8 - ea34779cc)

- 2026-11-18 14:02: Check the selected catalog type during registration. (authoring-run/f10d3e7e-18d9-4ae8-9bdb-8004b6815fb7 - 293833c72)

- 2026-11-18 12:46: Check catalog field names and report malformed config keys. (authoring-run/f10d3e7e-18d9-4ae8-9bdb-8004b6815fb7 - 4875ab0f5)

- 2026-11-17 19:44: Distinguish the published TokenService schemas from the current registration handler. (01a1eb01-0dea-7f01-8613-761574377d3f - 23b54e285)

- 2026-11-17 19:24: Correct session ownership. (authoring-run/a1a47d55-3248-4349-81a2-ca786027b634 - c5ddcd80cb4cfcd0b969a52ef5c4cafff552a8e8)

- 2026-11-13 15:44: Recheck the Git-only model lifecycle before Kubernetes attachment and release. (authoring-run/f3a542b0-ca6b-426f-8759-3ca2500f79ce - a14ccd99)

- 2026-11-11 19:04: Keep ordinary Gateway model delivery independent of Git Proxy selection. (authoring-run/1e8e6ab1-7c1b-4d49-a362-2dc060e32bbb - aea0cb511)

- 2026-11-11 16:45: Expose structured retry guidance for the existing registration deletion fence. (authoring-run/b642b758-0314-4f01-a300-5e37962b8fb4 - 5eed51d18d8ea86a6c9450c352e967b433fa47da)

- 2026-11-03 16:57: Correct catalog-field refusal status. (authoring-run/4d0e1a9c-b86a-4b59-be3e-d4306d5da9fc - 82a04653d)

- 2026-11-03 15:09: Document shared provider routing and separate destination authorization. (authoring-run/4d0e1a9c-b86a-4b59-be3e-d4306d5da9fc - 47e0e95df)

- 2026-10-30 02:05: Resolve fresh static provider identities consistently with source updates. (authoring-run/ddbd21a8-0432-4c61-b4ad-e48d12268c8c - 262a2188226cbcd2ee22630040617f6c39969352)

- 2026-10-29 21:40: Validate an owned revision snapshot under ordered storage locks. (authoring-run/833462ab-9c82-438a-95c4-53d1dbb2e7e9 - a9884d11bf325a39f3308f787a5ea266ebab5144)

- 2026-10-29 20:41: Validate static source endpoints without Gateway placement. (authoring-run/cf8bb25e-ffb8-4349-9770-a0b07d6bf50f - 2eed3c36a)

- 2026-10-29 19:11: Use the recorded owner’s catalog for fresh source admission. (authoring-run/d88f92d2-4a34-4001-aaa0-70d424201741 - 3a4244461)

- 2026-10-29 15:48: Preserve DELETE ownership when live registration loses readiness without an external write. (authoring-run/0f4f447d-cd98-4f49-9d16-217bf7500d1d - 6ead449d5)

- 2026-10-23 08:05: Refuse unselected protected withdrawals. (fix-2235 - 860eea712)

- 2026-10-16 22:08: Distinguish OpenShell-owned OAuth from protected source admission. (authoring-run/9fd90bae-7158-4df5-8f2e-62b0bd548272 - 4f98051f14)

- 2026-10-15 22:26: Reconcile current main behavior with OpenShell OAuth contracts in the accompanying merge. (authoring-run/41e4bb7a-c8eb-4332-b1f9-07fb8e234f63 - b747cf5b6402ad36ce9f1ae6dbed08928ddcf3dc)

- 2026-10-15 18:17: Pin OpenShell v0.1.4. (authoring-run/openshell-014-rebase-20261015 - 64a3424a9)

- 2026-10-14 14:04: Scope PAT authentication and OpenShell prerequisites. (authoring-run/dba0a6cb-33d9-40fd-b38b-e20cddf4b75f - 96a2b79fa)

- 2026-10-13 20:30: Document provider-managed Codex PAT authentication. (01a136ee-8824-7043-b9e2-49eccacac3bd - ed9018c09)

- 2026-10-14 01:11: Reconcile endpoint validation and provider ownership with external OAuth custody in the accompanying merge. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - c5fb4880ebf2df2aedae12f99adb1992a930ba1b)

- 2026-10-13 20:07: Check provider ownership before profile updates. (authoring-run/01a136d4-3550-7042-834c-cf11f51f41f2 - 146c80ef66b5860cb9bea296d2574156468a103c)

- 2026-10-12 14:00: Every source, including `openai`, owns its OpenShell profile; no profile is shared by type. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - e0bb26d84)

- 2026-10-10 04:53: Reconcile credential refresh; report invalid offered-source values as field-specific 400 before effects. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - 90268463bbd255c3c13a0e0bdeb437728189eb1a)

- 2026-10-13 18:56: Use source-owned OpenShell profiles for Codex OAuth. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - af184d6224af7c60b81027ca307097ecfc5007cc)

- 2026-10-13 09:37: Reconcile current admission and lifecycle behavior with external OAuth custody in the accompanying merge. (authoring-run/fd902939-ed58-4508-8d33-95a863d966af - e8d39978d801e7a5a8ac7242f32035f426da94e1)

- 2026-10-09 20:27: Integrate main lifecycle, native workspace and readiness contracts without dropping endpoint safeguards. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - 90268463bbd255c3c13a0e0bdeb437728189eb1a)

- 2026-10-09 20:28: Retain external Harness authentication alongside explicit Agent source-list admission. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - ece639c78)

- 2026-10-09 08:30: Replays take over withdrawal work. (fix-892-894)

- 2026-10-09 06:00: Exhausted withdrawals retry later without Compute maintenance. (fix-887)

- 2026-10-09 17:37: Trace Refresh-owned device authorization in the accompanying merge. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - 1c2fbd2bc2953430e3ddaf68882176c6943ea7b2)

- 2026-10-09 17:01: Trace operator-TLS retrieval and Gateway-owned refresh in the accompanying change. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - 4f902e2ab7738568fc8bb278296e54255355b8b7)

- 2026-10-08 12:47: Trace the experimental OpenShell device-login, warm-read, and JWT-placeholder integration in the accompanying local change. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - ece639c78765727a67753639f6ab225a243e064d)

- 2026-10-08 20:30: Maintenance leaves denied withdrawals for a replay. (fix-853)

- 2026-10-08 17:30: Withdrawal covers unretired predecessors. (fix-816-819)

- 2026-10-08 16:00: Preparation rechecks revoked withdrawals against a late Sandbox create. (fix-790)

- 2026-10-08 14:00: An unoffered source type is a `409` naming the fix, not `404`; worker credential codes have their own status messages. (fix-821-824)

- 2026-10-08 12:00: A withdrawal also covers later versions admitted with the source. (fix-810)

- 2026-10-08 11:45: DELETE checks gateway ownership before `deleting`. (fix-811-812 - e461e1621)

- 2026-10-08 11:42: Reconciled binding and withdrawal behavior with endpoint validation; trimmed repeated lifecycle detail. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - 1eceea5dfb864ff469dce04a42fe3cce9c7f5f75)

- 2026-10-08 10:00: Replays take over stranded withdrawals; withdrawn sources skip the grant recheck. (fix-787-788)

- 2026-10-08 09:30: Agent PATCH needs only `operate` on already-bound sources. (fix-782)

- 2026-10-08 09:00: Deploying listed sources without a Sandbox Driver returns `409` with its message, not the generic "already exists". (fix-786)

- 2026-10-08 08:30: Agent binding reports a missing Credential Gateway as `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` and an unlisted Harness source as `400`, after the caller's `operate` checks. (fix-783-784)

- 2026-10-08 04:40: Reconciled OpenAI endpoint validation with the new tool-token source lifecycle. (authoring-run/02228d02-e16c-4a55-9a43-16b9efb35ebe - 31b1b6a9ab59f219d0fbe3d44b1550f8c8f2fe4a)

- 2026-10-07 18:00: Unified binding: one `credentialSources` list holds every source, and a credential-source `harnessAuth` names a listed entry. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - ee950468c)

- 2026-10-07 12:07: Unify imported and managed PAT authentication while preserving source ownership and existing OAuth behavior. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - be5006e62)

- 2026-10-06 21:30: Keep tool-withdrawal recovery scheduled after model revocation without preparing the version again. (pr-851-rebase - bb6c7449b)

- 2026-10-06 16:12: Reject normalized hostname stars, zero ports, and OpenShell bracket hosts before credential-source persistence. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - 129b9b98812a861cfbdcec386daf5258902ebba8)

- 2026-10-05 11:36: Validate source configuration before persistence and recover invalid rows without guessing remote ownership. (agent:roboclaw:dashboard:9d0532e1-befb-4fc3-935e-7cd2a0c72110 - 9958ef0412565864efba7b13995536d7c2a51d22)

- 2026-10-07 17:36: Trace source-owned device authorization and warm configuration discovery; remove legacy OAuth fallback. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - da984340ae4aafb03bb0c66bfd94ba40252625a5)

- 2026-10-07 00:22: Documented the external ChatGPT placeholder and account-metadata handoff into native Codex in the accompanying change. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - ca0df6314ddddabc2f039de791f35c2e5de7ec43)

- 2026-10-03 18:00: Registration and update reject a Secret reference to another Namespace as an invalid request instead of not-found, as Secret bindings do. (binding-400b)

- 2026-10-03 16:00: Report `withdrawalInProgress` so an exhausted withdrawal no longer reads as in progress; maintenance re-queues only where it is scheduled. (fix-withdrawal-exhausted)

- 2026-10-02 10:00: Authorized each batched withdrawal by its own requester and recovered pending non-model withdrawals during maintenance. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 92e33389d)

- 2026-10-01 21:30: Added non-model sources bound through `credentialSources`, their admission, dispatch and withdrawal. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 9a202599b)

- 2026-10-01 20:30: Report a missing Credential Gateway as `409 CREDENTIAL_GATEWAY_NOT_CONFIGURED` at registration. (fix-d93-d100)

- 2026-10-01 11:37: Updated the OpenShell wire-fixture pin to v0.1.3-pre.2. (authoring-run/f1f395c4-2594-4b07-9e92-ae829a5b5dd4 - f22a584e6ce21d505b40a72fdb5ae1c6e74c1c84)

- 2026-09-30 21:14: Updated the independent OpenShell wire-contract verification pointer to v0.1.3-pre.1. (authoring-run/b158c89c-3010-42ae-95b4-350b05de7441 - 37bbee705ea3808ad000413dd54bdcc718980179)

- 2026-09-30 04:00: Recorded withdrawal attempt reasons, replay deduplication, and maintenance of a withdrawn version; corrected the update ordering. (pr-553-alignment - 3a5e48035)

- 2026-09-28 18:00: Added source update and per-Agent withdrawal through worker-executed revocation. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 7cd4a210)

- 2026-09-28 05:13: Documented the controller transaction boundary for credential source writes. (authoring-run/5da74b2e-b249-44da-87e4-ca85f018c832 - 646b067220f6b7f8f3059eaa0710db2654b61499)

- 2026-09-27 22:51: Extended credential-source Harness delivery to dedicated native OpenClaw without projecting the model Secret. (authoring-run/88764ea7-c6bb-4ac8-919f-c21071946c37 - 859c0b11e5f1c350acda231c89ad3573504324eb)

- 2026-09-26 14:29: Documented credential source registration, Agent binding, admission, dispatch resolution, and retried deletion for the uncommitted Credential Gateway change. (claude-code/session_014fi7Uq1LyofgqwLrLoQ3yY - 849b2b24111fe237b12da5be1d4b411d3146cefb)
