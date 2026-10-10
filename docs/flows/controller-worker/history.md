---
published: false
---

# Controller worker documentation history

This record preserves the dated changes to the controller worker flow. See the [parent flow](../controller-worker.md) for its context and overall sequence.

## Changelog

- 2026-10-10 11:40: Stop a refused first deployment on any Compute. (fix-1016)

- 2026-10-10 06:40: Back off and report a failing refused-candidate stop. (fix-1002-1004)

- 2026-10-10 03:10: Stop an exclusive candidate the worker refuses before publishing its failure. (fix-990-991)

- 2026-10-05 10:51: Preserve shared tenant placement while incorporating main startup and runtime diagnostics. (01a0fe72-58b2-7cc3-b770-7310f5401deb - 71a1cedb)

- 2026-10-04 04:20: Abort Compute when the last confirmed claim lease runs out, even if a renewal never answers. (bughunt-10-claimloss)

- 2026-10-03 17:00: Finish published deployments after a last-attempt crash. (fix-recover-active-revision)

- 2026-10-03 16:02: Run configured development API and worker Compute preflight before admitting work. (01a0fe72-58b2-7cc3-b770-7310f5401deb - c04093189f2ba6240f8dc431847c2f487afd11de)

- 2026-10-03 16:00: Bound worker queries and restart a stuck run loop. (fix-worker-liveness)

- 2026-10-02 06:30: Name Compute's pending reason in deployment progress and slow rechecks for long-pending revisions. (fix-deploy-pending-reasons)

- 2026-10-01 17:20: Point Agent lifecycle admission at its HTTP owner; deployment audit keeps the admitted authorization. (authoring-run/bef09bf6-deaa-4189-9568-5f13beb451e7 - 7a6cc931d)

- 2026-10-01 16:37: Added bounded Compute preparation failure diagnostics without changing retry outcomes. (authoring-run/dda71266-f9f6-404c-aaba-b0c03f010ae2 - 987c8c2b4ace1e152262ef6920b6d0f9ff26a086)

- 2026-10-01 04:06: Document metrics client error ownership through release. (authoring-run/d0545dc8-f524-4ce5-a3ce-918838dddd92 - 97dfb6b9)

- 2026-09-29 18:40: Continue maintenance past expired exhausted claims.

- 2026-09-29 12:00: Continue maintenance after dependency exhaustion.

- 2026-09-28 22:10: Expose exact-work pending reconciliation results through deployment status and the Console. (01a0eb85-73a8-7572-92a9-a6a06fbdf0a5 - 0aedecfd)

- 2026-09-28 21:25: Apply the Driver interval to every incomplete repository cleanup pass. (authoring-run/b7089bf7-3566-4ce4-a761-d0e9fc197f6f - 8352c093)

- 2026-09-28 12:53: Document deployment audit attribution and its transaction boundary. (authoring-run/c43b309b-ac83-4ece-ba43-85dc673d5342 - da62a0368fa4f3ab0a2fa6cca40d9952bf93cdb2)

- 2026-09-27 22:05: Allow the initiating caller to requeue failed Agent teardown through repeated DELETE, retaining active claims and prior audit. (01a0cf72-6985-7712-ba92-d8cc32470f24 - ae31581574744bea2745066f189eea6e826fe823)

- 2026-09-24 11:28: Document exclusive dedicated preparation and durable RWO workspaces in the accompanying change. (01a0cf72-6985-7712-ba92-d8cc32470f24 - 14a4508baad876d3eea4e6fe6388f8d8a91559b7)

- 2026-09-21 07:24: Tighten the baseline execution trace while preserving lifecycle boundaries and historical notes. (authoring-run/7fb656ee-ae7a-45a8-a160-6d73bc5ae25b - d2b31887be1d114c9147e2ed6f07c1f38e765c6f)

- 2026-09-21 05:32: Reconcile accompanying platform credential documentation with current source history and native Git boundaries. (authoring-run/fba2d7fa-6603-465e-a7c8-df0375ad202d - a051a2406eec7cafde2e0dd5e2ec63dba6ce1581)

- 2026-09-21 00:56: Integrate Agent-deletion metrics. (01a0af6f-d097-7ef0-a2b7-c8ce31703bd9 - 1de0877d28f7c77e6ef4aab97531ad7d56b583d0)

- 2026-09-20 17:23: Document cached startup failure persistence. (codex/01a0bce5-9f29-7110-85fd-6b140674d362 - 1ff76eb2)

- 2026-09-20 10:50: Documented legacy terminal work outcome backfill during migration 0019, including unknown result data and fallback behavior. (authoring-run/a2f901df-d27a-4a05-9468-e1ee895ae89d - 08b1b8fe)

- 2026-09-18 17:17: Generalized terminal details to result_data for success warnings and failure metadata, retaining live-claim fencing and the deployment API projection. (codex/01a0b0fc-4a24-76c0-8fb7-f3a3a434d464 - 6a582ce9)

- 2026-09-17 21:20: Keep maintenance successor buckets monotonic when database and worker clocks differ. (codex/01a0b0fc-4a24-76c0-8fb7-f3a3a434d464 - 7f968f39)

- 2026-09-17 20:28: Replaced terminal plugin receipts with verified optional-plugin exclusion, current startup status, and successful deployment warnings; runtime verification in progress. (codex/01a0b0fc-4a24-76c0-8fb7-f3a3a434d464 - 7771526d)
- 2026-09-17 20:28: Removed the first-failure receipt and acknowledgment lifecycle under the approved best-effort plugin decision. (NOT_IN_SPEC)

- 2026-09-18 03:04: Link the accompanying repository-session preparation, maintenance and cleanup flow. (authoring-run/7e9ee7cd-e36a-4de7-8f67-29f3b03bd94d - 8500b2da103063b4503b62e5529f3910513e84a9)

- 2026-09-17 12:09: Separate health reporting from claim renewal, preserve lease-loss fencing, and restore admitted Agent bindings before stop effects. (01a03526-12b3-7f50-b599-e8414052909d - 683d0e253ad827af7c6098650097fa6a8ad61f57)

- 2026-09-17 07:34: Add lifecycle snapshots, oldest pending age, and post-commit operation timing alongside the accompanying implementation. (authoring-run/7f165131-ca19-465b-a7a6-7138c2065f72 - d4dc39fc8c7f86917387a738fc1d3892c98a46bd)

- 2026-09-17 01:22: Include failed candidates and interrupted retirement in exact Agent-stop cleanup, preserving later deployments and retained state. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - 73c2ef49)

- 2026-09-08 07:53: Include optional development activation and retry in the post-commit handoff. (01a07d92-d866-7731-afe5-abab67d8966c - 4d83087229961f3665b923d2581c0b71b988cc9c)

- 2026-09-01 19:09: Preserve providerless API-key execution and document Provider metadata checks before workload effects. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d) (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-08-28 17:56: Converted the worker overview into a source-ordered execution trace covering startup, admission, lease ownership, current authorization, Compute and Sandbox delegation, activation, and retry. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
