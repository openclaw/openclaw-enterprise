---
published: false
---

# Agent provisioning documentation history

This record preserves the dated changes to the Agent provisioning flow. See the [parent flow](../agent-provisioning.md) for its context and overall sequence.

## Changelog

- 2026-10-13 09:37: Reconcile current admission and lifecycle behavior with external OAuth custody in the accompanying merge. (authoring-run/fd902939-ed58-4508-8d33-95a863d966af - e8d39978d801e7a5a8ac7242f32035f426da94e1)

- 2026-10-12 22:30: Provisioning refuses undeliverable repository bindings and Sandbox workspace files before queueing. (fix-1144-1145b - d34b4a8f7)

- 2026-10-12 11:55: Follow the initial deployment on the original provisioning handle and retain its failure identity. (authoring-run/adccd418-cf61-4fbb-b3ba-0fcad194d907 - 040e7498ecd89e0e565af71f234776ecfaad2186)

- 2026-10-09 13:59: Keep OpenShell initialization and current provisioning limits within the flow budget. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - a9298d2ed)

- 2026-10-09 12:00: A Configuration create still absent 90 seconds after it began is resent. (fix-911)

- 2026-10-08 23:00: Guided provisioning registers model sources and preserves exact source authority for both Dedicated Harnesses. (Codex/01a0e8ec-d02f-7b93-a59b-5b7fccf2ebaa)

- 2026-10-08 14:00: Missing or `runtime` Harness authentication is a named `400`, not a generic `404`. (fix-821-824)
- 2026-10-08 13:00: Say that no API deletes a provisioning request, and link how to clear one with a legacy plan that blocks migration `0049`. A plan bound to an account without an access token on an Installation with no ChatGPT Backend fails with a message naming the Backend. (fix-780-781/d540-d541)
- 2026-10-08 12:30: The provisioning worker inspects an unsettled external write before its authority check, so a permanent refusal fails the work with `PROVISIONING_REJECTED` instead of retrying it as `PROVISIONING_OUTCOME_UNKNOWN` until attempts run out. (fix-808-815)
- 2026-10-08 11:30: The provisioning worker fails accepted work whose Secrets the selected Secret Driver does not own with `PROVISIONING_REJECTED` and the fixed message, instead of retrying it as an unavailable dependency. (fix-809)
- 2026-10-08 11:00: A Secret stored through a previously selected Secret Driver answers a `503` that names the fix (replacement Secrets, a new request) instead of the generic dependency text. (fix-802)
- 2026-10-07 11:00: Provisioning authorizes its Namespace-level grants before it validates the plan, so a caller without them gets `403` instead of a `400` or `404` about the body. (fix-member-1007/d530)

- 2026-10-06 17:00: A Compute Harness authentication refusal that names a setting in the caller's Configuration answers `400` naming it on request and retry, and the failed work's message keeps it, as deployment does. Status no longer rechecks Harness authentication. (fix-648-652/provisioning-harness-refusal)

- 2026-10-06 13:30: A Compute refusal of a caller's gateway setting names the setting in the `409` and the failed work's message; other Compute refusals keep fixed text and are logged with the request ID as `agent_provisioning.compute_refused`. (fix-635-636/compute-gateway-setting)

- 2026-10-06 12:00: Compute plan refusals answer `400` (unsupported execution mode) or `409` instead of `500`, the worker rejects them on the first attempt, and status no longer rechecks them. Status also skips the runtime image's native worker support check (#1499). (audit-1006b/provisioning-compute-refusal)

- 2026-10-06 05:00: The worker rejects stored plans refused by the current Plugin Driver or runtime image on the first attempt. (audit-1006/provisioning-refusal-class)

- 2026-10-05 23:30: A binding destination failure names the broken rule; a reserved destination also names its key, with a `/configuration/secretBindings/<key>` detail. (findings-sweep-1-api)

- 2026-10-03 15:30: Provisioning rejects reserved binding destinations and cross-Namespace Secret references as invalid requests instead of not-found. (f239/provisioning-binding-validation)

- 2026-10-03 05:30: Namespace deletion no longer waits on failed provisioning whose effect is already settled. (fix-d354/namespace-settled-provisioning)

- 2026-10-01 17:20: Point provisioning admission at the extracted Agent HTTP handlers. (authoring-run/bef09bf6-deaa-4189-9568-5f13beb451e7 - 7a6cc931d)

- 2026-09-30 17:31: Reconcile Console Harness selection with Embedded defaults, native-worker admission, and current provisioning navigation. (Codex/01a0e8ec-d02f-7b93-a59b-5b7fccf2ebaa - a0970577)

- 2026-09-29 17:30: Agent deletion settles an effect left by cancelled provisioning instead of waiting for it forever. (fix-1/agent-deletion-unsettled-effect)

- 2026-09-29 05:00: Document request-time channel credential validation. (authoring-run/bb89c55f-8771-46c9-801d-e5bc028d7e5c - 756b02ce)

- 2026-09-29 02:33: Open Agent details after provisioning hands off the first deployment, and show pending or failed deployment status there. (Codex/01a0eaf9-6dcf-76b1-a376-d2a2fbfd6c60 - a14435c8)

- 2026-09-28 17:30: Separate Console Harness selection from Dedicated placement and document retained Sandbox delivery requirements. (Codex/01a0e8ec-d02f-7b93-a59b-5b7fccf2ebaa - e2b739f5)

- 2026-09-23 21:00: Integrate provider model discovery and saved API-key/PAT references with canonical Dedicated provisioning and deployment activation. (Codex/01a0cf27-71c6-7042-8357-74d1811a2ef8 - fb711b49)

- 2026-09-23 20:21: Integrate repository selections with asynchronous provisioning and preserve draft-only discovery recovery. (public-pr/295 - 8bd367636aff766d484b4e684d42f6b4419c9e4e)

- 2026-09-23 11:20: Reused the channel setup Secret modal and preserved ordinary-create grant recovery when rebasing onto PR #323. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - f2dd1d3f)

- 2026-09-23 08:37: Simplified Secret saving, delayed resource creation, retry ownership and deployment handoff. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - 01331ac4)

- 2026-09-23 02:43: Restored existing repository-session deletion safeguards alongside the provisioning cleanup guard. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - 1e4936f0)
- 2026-09-23 02:20: Clarified pre-handoff mutation reservations, retained failed-work receipts, and cancellation-owned cleanup. (Codex/01a0cc7f-028b-7803-acf5-803c3d799d75 - a20f0b07)
- 2026-09-23 01:25: Corrected provisioning effect recovery to use inspect-first recovery and clarified terminal cleanup ownership. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 5886094b)
- 2026-09-23 00:51: Restored concrete status, exact-create recovery, generation, external-effect, retry, and cleanup details from the accepted spec. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
- 2026-09-23 00:45: Clarified Console first-time provisioning, ordinary create separation, and versioned provisioning keyring prerequisites. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
- 2026-09-23 00:22: Added the source-backed Agent provisioning flow. (cody/01a0cd23-4e0e-7a92-ab33-32a667859782 - 79ca801d)
