---
published: false
---

# Platform console request documentation history

This record preserves the dated changes to the platform console request flow. See the [parent flow](../platform-console.md) for its context and overall sequence.

## Changelog

- 2026-10-30 16:00: A rebuilt Agents list keeps the refocused row control and its note in view. (fix-dogfood-r60)
- 2026-10-30 12:30: A permission answer read before a Stop or Delete refusal no longer lifts it; a rebuilt Agents list moves focus from a gone or disabled row control to the row's name or the heading. (fix-4183-followups)
- 2026-10-30 12:00: Refocus rereads the Agent page's permission answer and keeps focus on a rebuilt Agents list row. (fix-dogfood-r59)
- 2026-10-29 20:40: Refocus does not read again a version the page proved unreadable. (fix-console-r53)
- 2026-10-29 18:30: A Tab lap past the page end starts no refocus check. (fix-keyboard-sweep)
- 2026-10-28 13:01: Keep a held press on one Agent’s copy button from activating another Agent’s button after navigation. (fix-3678 - 594de5868)
- 2026-10-27 14:42: Trace Namespace deletion and recovery. (authoring-run/20fc7b4c-0501-4d3e-9f0c-16a3fd016866 - 0402f1cf1)
- 2026-10-25 20:40: Activate a shell control whose mouse press a load render replaced before release. (fix-2505)
- 2026-10-21 22:22: Connect console themes to API startup and the shared shell. (authoring-run/634a754f-a79e-4aac-94fe-0646caf6a287 - 2c9e7f6c4)
- 2026-10-20 15:53: Add Namespace Secret management and uncertain-write recovery in the accompanying console change. (authoring-run/9b10a6df-a6ce-4d38-859d-480a59d95cf0 - e8185dac8)
- 2026-10-20 14:55: Add startup-loaded console themes and public asset confinement with accompanying source changes. (authoring-run/485ab8a9-4293-44df-a85f-f8f051b74bf8 - e8185dac805b737363c7178d3068b310a53a7c24)
- 2026-10-20 05:00: Move the Create Agent form trace to [Agent creation](platform-console/agent-creation.md). (docs-split-1020)
- 2026-10-19 15:16: Namespace creation and recovery. (authoring-run/e988d724-dd95-4e63-a711-5fd44393f211 - 141515257737cccdb75137fabbeec707915856af)
- 2026-10-24 22:05: Say that a Secret value textarea saves CRLF line endings as LF. (fix-backlog-1024b)
- 2026-10-20 08:40: Create Agent sends no IAM grant a session knows is refused; a failed permission read offers Retry permission check. (fix-1020c)

- 2026-10-18 15:02: Honor an explicit higher identity weight when serving static scripts and styles. (authoring-run/fe116f0f-fbc0-4682-affa-70eda6bbbd1d - bcf4fbcf0f082367910d262b1f06732b0bdd80c8)

- 2026-10-18 10:30: Count the row loading text's 150 ms from the frame it shows in. (lows-1018f)

- 2026-10-17 16:30: Keep row loading text 150 ms once shown; refocus at phone width focuses Open navigation. (ui-fix-1680)
- 2026-10-17 12:10: Keep list focus when refocusing during row reads or from sidebar and header controls. (lows-1017n)

- 2026-10-17 10:50: Delay row loading text 250 ms; keep focus through sidebar navigation and list refocus. (lows-1017m)
- 2026-10-17 10:36: Restore the reader’s focus when a tab recheck reuses the same view.
- 2026-10-17 08:32: Show the rechecked Agents list before refreshing visible deployment cells. (fix-1644 - c29af02c98)
- 2026-10-16 22:40: Hold loading 300 ms; open recovery links in view; reread status on a log refusal. (ui-jank-code-12)
- 2026-10-16 18:30: Forget denials at logout, clear refused logs or Pod status, and show the page Back checked. (lows-1016o / log-refusal-followup - 1fb2170)
- 2026-10-16 16:40: Open a Logs URL at its output; reuse a member's Agent view on Back; keep the startup status to 400 ms. (ui-jank-code-11)
- 2026-10-16 14:45: Keep the startup status on a fresh Agent load until the overview reveals; leave tab moves to a full load until then. (lows-1016k)
- 2026-10-16 14:30: Scroll a Logs view that loads before its Agent page shows to its newest output. (flake-fix-1016)
- 2026-10-16 13:00: Keep the shown page until an entered Agent reveals; keep a held page's selector disabled on the way to another page. (ui-jank-code-10)
- 2026-10-16 12:00: Paint Create Agent with its permission answer; keep a clicked Logs tab's strip in place. (ui-jank-code-9)
- 2026-10-16 11:30: Hold the shown page in its own navigation and header; show an Agent’s heading and overview together when ready. (ui-jank-code-9)
- 2026-10-15 23:00: Keep views across abandoned returns; show slow rechecks. (console-nav-1015)
- 2026-10-15 20:00: Hold pages until returns revalidate. (public-pr/2523)
- 2026-10-15 19:40: Compress static console scripts and styles per `Accept-Encoding`. (console-gzip)
- 2026-10-15 19:03: Preserve scoped destinations across sign-in and resolve Agent recovery after session admission. (authoring-run/05ac6c84-8444-4dc1-8311-13c4e84369a3 - 91ac04d6919860b7d7386444468a3dc0ddc90481)
- 2026-10-13 12:00: Explain outage sign-in reasons. (kc-guide-fix)
- 2026-10-09 21:10: Preserve cancellation, deadline and transport failures during response body reads (authoring-run/2e195d67-c77d-43d0-8c32-2179523eb3a2 - 013bcf5f76819ca280a164745d470855fc5b74cd)
- 2026-10-08 15:59: Trace responsive drawer and tab visibility, destination focus, scoped authentication feedback, and compact plugin setup. (01a11d68-d6e8-7033-ab93-03767bced2da - 58daaa5a3ac4c64bc5fb3af00759b59b365b20ca)
- 2026-10-08 14:30: Trace client navigation from a failed deployment to its exact version and focus its Logs tab and scroll the panel into view. (01a11d68-d6e8-7033-ab93-03767bced2da - 0ff96342dc416325770eebed5963e9886fd3dff3)
- 2026-10-07 12:30: Explain a disabled account's provider sign-in (`authReason=account-disabled`). (fix-member-1007/d534)
- 2026-10-03 22:38: Trace switching between listed and manual model entry, preserving listed models and one submitted model. (01a10328-9de5-7081-ada2-d88ff80161e4 - 340feea42)
- 2026-10-03 20:00: Rebuild a view retained without a Namespace selection once one is readable, so the header selector shows the default.
- 2026-10-03 18:00: Re-enable the header selector during retained-view reads once Namespace access is checked.
- 2026-09-30 19:00: Remember denied Agent detail snapshot reads per tab so reloads do not add an audited denial per view.

- 2026-09-29 20:00: Trace repository descriptions and inherited access. (public-pr/374)

- 2026-09-29 07:19: Guard recovery until session and Namespace reads finish. (authoring-run/1ca6a40a-a247-465f-9a83-182dbcb6ff4e - 90326e6fab11f84fc11b8990b6c8e197a2752c60)

- 2026-09-28 01:39: Move the sharing trace to its child flow. (authoring-run/462d5207-c3a1-4203-af4a-8db2551ccb9a - 4f32ebbca5d699296a142dfbd34c8ec46844fce7)

- 2026-09-27 19:38: Preserve validated page and tab DOM in accompanying changes. (01a0b1f2-e696-7232-a439-5b668154bcd9 - 0663fa97)

- 2026-09-27 05:05: Keep supported Dedicated provisioning available without optional repository discovery. (01a0cf72-6985-7712-ba92-d8cc32470f24 - c0f792d5b92e2dee596711654784759d327e0817)

- 2026-09-27 02:30: Use selected PAT Secrets for discovery. (01a0e099-da9d-78f1-8e79-ea4a919edf7d - ec4e9dc517497afe05be63a320542abcf61e8a55)

- 2026-09-26 00:37: Link Secret summary metadata flow. (01a0db1e-7ab2-7bf1-936b-e71c9d6f9911 - e387b38cc259ee4a55936ecb848bbce8210bcd68)

- 2026-09-25 17:27: Trace scoped return previews and session-aware invalidation in accompanying changes. (01a0d992-db83-7843-b40c-355c0f2c2b9a - 64ab72aed5c4926e4a2080ade91d785e531801a2)

- 2026-09-25 01:15: Trace channel-only Slack reply defaults and explicit DM policy editing. (01a0d5e6-743e-7743-8a5e-2d8c24b78b81 - 919f92c3bb3ea63acf7042b138e9a0c6e1d97719)

- 2026-09-25 00:15: Trace new Slack reply defaults and preservation through gateway rendering. (01a0d5e6-743e-7743-8a5e-2d8c24b78b81 - 29bf7a8681390fe60ced612beeb538101c87bc34)

- 2026-09-25 00:00: Retain repository draft bindings through failed rediscovery. (01a0d557-f6e3-7da2-af52-993d05735554 - 2e0604a2)

- 2026-09-24 22:03: Link shared editor draft capture before tab teardown. (01a0d557-f6e3-7da2-af52-993d05735554 - a91cbfdd37b64c88b7ee48647096ff6bfd993e02)
- 2026-09-24 20:03: Recover unavailable Namespace selection inline. (authoring-run/bb42c16a-c6e1-4900-adf5-9ba37629e491 - 09a392cbda669a99e69d5f6a905921b9f10b43d9)

- 2026-09-24 17:13: Trace the header Namespace selector and preserved navigation scope. (authoring-run/fdba83e7-9f34-4b8b-8af2-625214851f27 - 1a458b227585c572ec0ac70fd10efc3834165075)

- 2026-09-24: Keep Preset bindings internal.

- 2026-09-24 17:20: Expose upstream OpenClaw provenance separately. (01a0c179-19f7-7111-8bb4-fc7680da5545 - bd1a5c46eb069bfa7feedbb99b074dc015c4e9bc)

- 2026-09-24 15:44: Trace opt-in sidebar build metadata and authorized Compute image observations. (01a0c179-19f7-7111-8bb4-fc7680da5545 - 6b5c9093)

- 2026-09-24 06:19: Replace Console model discovery with an intentional static starter list and preserve manual entry. (01a0d20c-dc1b-7d22-a965-60b9c244b29d - 24ecb94b)

- 2026-09-24 05:40: Added Create Agent plugin JSON controls and transient PAT catalog discovery; policy integration remains pending. (01a0d1dd-aa36-7622-9f43-8376f6ff935e - f62e17c)

- 2026-09-23 21:41: Preserve edited Codex plugin settings across model and key changes. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - b8f23be17de4a4b077dab8d6b90b4add1f9146cb)

- 2026-09-23 23:50: Describe Service Accounts hints and expired-model filtering; consolidate repeated creation and action details. (01a0cf27-71c6-7042-8357-74d1811a2ef8 - 9e0095c7)

- 2026-09-23 19:28: Condense Console flow within the documentation length budget. (01a0cf27-71c6-7042-8357-74d1811a2ef8 - da797e3afa3752a7b3321733d27b6b5e6d0a505a)

- 2026-09-23 18:51: Trace provider-dependent harness choices, derived execution mode, and Codex PAT switching boundaries. (01a0cf9b-8c16-7a73-a3d6-1496593034a0 - 6c6c3e4308946e7e66d656fb553da4dd5177f2c4)

- 2026-09-23 18:48: Keep saved API-key and PAT Presets bound to their provider before Configuration or Agent writes. (01a0cf27-71c6-7042-8357-74d1811a2ef8 - 4da114ac7b11f926d4b774b8d32a09fa136135eb)

- 2026-09-23 18:35: Reconcile provider credential creation with staged Slack Secret grants and shared retry recovery. (authoring-run/2516b0a6-7a82-4268-a586-d821679b2a78 - ae092fc7c13aad4c637b0238ae2f41ecb2b03219)

- 2026-09-23 20:21: Integrate repository selections with asynchronous provisioning and preserve draft-only discovery recovery. (public-pr/295 - 8bd367636aff766d484b4e684d42f6b4419c9e4e)

- 2026-09-23 19:39: Trace pending Slack grants across drawer applications and reconciliation with final saved bindings. (public-pr/295 - 7f6d9107dcb23ff1ad093c4914c89a0210169d20)

- 2026-09-23 19:52: Trace channel-scoped Slack sender access and leave direct-message access outside the drawer. (01a0d150-104a-71a3-9e56-6c5e3ee510ea - 77aedc620f443056f9ee859050b8dc657a9c3133)

- 2026-09-23 19:09: Trace image-baked OCC revision metadata and OCE sidebar branding. (01a0cfaa-2b68-7e61-b8ff-a7eb82f1edc5 - 150ec08f059cebc4897b839d8318f7b1e3aba0e3)

- 2026-09-23 11:20: Distinguished worker-owned first-time provisioning and Secret grants from ordinary Console draft creation. (01a0cc7f-028b-7803-acf5-803c3d799d75 - f2dd1d3f)

- 2026-09-23 08:30: Trace pre-Agent Slack Secret selection and creation, staged Configuration bindings, and Agent Secret grants. (01a0cd92-fd3f-7d83-a51e-f6264ef6be09 - 941edc9f6971a24ae29a74a6ca749b6375e6ec01)

- 2026-09-23 07:45: Preserve provider transport across model/key edits and classify model-discovery failures without exposing upstream responses. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - f292aa623335021e3012a3e94f83fc183f93e2e1)

- 2026-09-23 07:20: Discover API-key model choices during Agent creation without saving credentials or selecting a hardcoded model. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - 553423dd2419ec19d2d71a2d1f8de75839a1642b)

- 2026-09-23 06:27: Move two-provider API-key setup into Agent creation using existing Secret and IAM operations. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - a8272f4e2760e5ff06dc09c5658f48bea382c790)

- 2026-09-22 23:02: Trace GitHub sign-in discovery and callback recovery. (public-pr/305 - 311bc23012d0fd269483168b865adf79df630542)

- 2026-09-22 23:19: Enable native Control UI in Console starters with explicit loopback origins; preserve Preset and edited configuration. (01a0ccc0-00fa-7173-ab45-f7a5fb55b3b6 - 6d23cef977270fdf8ced6ea54ac8e1302cf8acd6)

- 2026-09-22 20:56: Rename the deployment-facing Console view to New revision. (01a0cc48-2eda-7fc2-a19e-096b68fccb7b - 081bccfcf3f5b114588dde1b42a0deb07f326017)

- 2026-09-22 20:43: Trace Console stop confirmation, admission, and state refresh. (01a0cc48-2eda-7fc2-a19e-096b68fccb7b - 6adfd148a517e84ae064a8e08438b051f80820fb)
- 2026-09-22 20:32: Remove the deleted Teams editor from current module ownership. (01a0cc48-2eda-7fc2-a19e-096b68fccb7b - 43776d25c5007e017f7d0ffdca6b06f063afcd37)

- 2026-09-22 04:31: Trace initial workspace inputs separately from Configuration creation and link setup before execution. (01a0c755-0518-7502-a533-64cd7465de15 - f3dbdd41c8f3b49573d1353a4b06ce510ee43a56)

- 2026-09-22 04:11: Preserve existing Slack policies while editing channel settings. (01a0b1f2-e696-7232-a439-5b668154bcd9 - f3dbdd41)

- 2026-09-22 04:07: Keep Agent tab navigation within the content panel and preserve page state and browser history. (01a0b1f2-e696-7232-a439-5b668154bcd9 - f3dbdd41)

- 2026-09-21 21:46: Trace confirmed Agent deletion, exact readback, and permission or uncertain-outcome recovery. (01a0c76f-2534-7991-932a-345782408759 - b61c3cae6c35e28db4153eaee9b477e8f5637894)

- 2026-09-22 00:47: Mask authentication Secret IDs in forms and omit them from configuration summaries. (01a0b1f2-e696-7232-a439-5b668154bcd9 - ebcdaac25bc3890486badcfadf56cfc7c99bb95e)

- 2026-09-21 19:52: Trace the shared default in dedicated and embedded Agent creation and preserve edited model selection. (01a0c580-9e39-7e21-bb0f-28fcc4752c59 - 4ec004dbefd25070ff1bdeb89cfb16d245296ac9)

- 2026-09-17 19:14: Expose operator-managed credentials without a managed-credential deployment gate. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - b8cabaf9a49e069a7668ccf88b9e71a7484227b7)

- 2026-09-01 19:09: Trace static serving, session resolution, exact collection authorization, Namespace isolation, and logout. (01a05e1d-6dc8-7231-bf58-58c80ef580f3 - 97911d361ac02ddf561e46c8af0864ad66a6df45) (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)
- 2026-09-01 17:47: Add Agent creation, detail revision selection, and saved channel draft editing flow boundaries. (01a05f94-886b-7122-8784-c4b5aa5c5d1d - b02a07f2e575b13260b8792f87975d51c5ef7a61)
- 2026-09-01 18:07: Trace association discovery and Configuration-first creation from editable starter JSON. (01a05f89-ff1c-7643-a77f-7e1e3aed9e5f - 1dd4b6b)
