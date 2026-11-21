---
published: false
---

# Agent Presets documentation history

This record preserves the dated changes to the Agent Presets flow. See the [parent page](../agent-presets.md) for its context.

## Changelog

- 2026-10-09 19:46: Authorize Preset writes before reading the body. (authoring-run/5b89726f-4b6c-43e9-8cfb-ad77c9f3a320 - deeb84b5e)

- 2026-10-06 22:22: Locate Preset file loading in its adjacent composition module; initialization remains unchanged. (authoring-run/a45c48cd-bde3-41b1-8e3d-57bf774df237 - 17e10b6d34cc2c805b3910fddfef191d3dd1b3f8)

- 2026-10-05 05:30: Only the API logs Preset warnings.

- 2026-10-05 03:30: A file named like a bundled default replaces it and warns.

- 2026-10-05 02:30: Skip and warn on a default creation a deny Restriction refuses.

- 2026-10-04 23:40: The bundled Collector exports the skipped-refresh warning with only its Namespace and Preset IDs. (bh13-fu2-collector - e54a08048)

- 2026-10-04 23:30: A refused default refresh, such as one a Namespace deny Restriction on Preset update forbids, keeps the copy and logs a warning instead of stopping API startup.

- 2026-10-04 22:00: Refresh superseded copies only when `includeDefaults` seeded them; a `presets.files` copy of a bundled file stays.

- 2026-10-04 14:00: Refresh untouched copies of superseded bundled defaults at startup, and let any shipped version pass the Namespace deletion check.

- 2026-10-03 20:30: Seed default Presets with the next Installation administrator when one cannot create them, so an upgrade that adds a default no longer stops API startup.

- 2026-09-28 10:36: Restore explicit creation without a Preset. (authoring-run/c140c47a-799b-48c8-929a-5d1a37eb31d1 - 9f7ae3cfb749a58394f8446f3a429db6ffa6f129)

- 2026-09-27 01:09: Preserve exit discard for the default Preset shortcut and retain explicitly selected Preset drafts. (authoring-run/048d8546-acd0-4d1a-8231-61c9d9ccb9dc - 7d0da53a8f092b0e2533464424dcb9c7fe15b139)

- 2026-09-27 00:28: Discard no-Preset creation state when leaving the flow. (authoring-run/c1812a3c-f760-4167-80ca-f4a66d8572e4 - ea187c93468f399b00ebb504fcbbed5ab21ddd8e)

- 2026-09-26 18:52: Load the plain console starter from the installed default-codex Preset and share its shipped configuration base (codex/01a0df07-06ad-7ef3-8cb9-3e4cbf7beac6 - e4a807e785e1a242e27200c8e8396f58136cbbc6)

- 2026-09-26 13:34: Trace main-form Secret selection, immediate creation, and metadata-only draft restoration. (authoring-run/33370d63-d3f8-4d66-8ad2-02dab55954e2 - 5b9fa853a23c47d410e3b7338a20ee0509041493)

- 2026-09-26 00:31: Grant ordinary drafts access to model Secrets already bound in Presets. (authoring-run/27646efe-b5bb-44a4-8d76-0506bd266237 - e387b38cc259ee4a55936ecb848bbce8210bcd68)

- 2026-09-24 21:39: Retain unsaved Console draft edits across navigation in memory, clearing credentials and preserving explicit discard (codex/01a0d557-f6e3-7da2-af52-993d05735554 - 12fc35b9c358c7992c09f7f23ffb5d4df349a19c)

- 2026-09-24 12:03: Default SWE Agent to GPT-6-Astra with Codex service-account authentication; allow existing or new model Secrets in the Preset chooser (codex/01a0d172-2f0a-7ec3-91ff-323d532464c7 - a4733ed0759840ff65907be03b49cf8979256ecf)

- 2026-09-24: Seed both standard harness presets and keep named DevDay copies opt-in.

- 2026-09-24 11:03: Load installation-linked JSON Presets and carry rendered workspace contents through Agent creation (codex/01a0d172-2f0a-7ec3-91ff-323d532464c7 - 935f91072adee63fc569e63db5fb2a5e64c77c5b)

- 2026-09-24 03:19: Grant observed clean-build hosts in the standard Codex Preset while retaining cached search and limited native networking (codex/01a0cfbd-e4cc-7d62-8542-c1358ab1bc5b - 63a70947fed440a875b2e6338d0a22500f9a9f5e)

- 2026-09-24 02:30: Add opt-in Installation default Presets with authorized, atomic seeding and preservation of existing copies (codex/01a0cfbd-e4cc-7d62-8542-c1358ab1bc5b - 451a35dbd713be383f93cd50407fc9b880b2561e)

- 2026-09-24: Add password variables and reuse the ordinary Secret creation and recovery flow (codex/01a0cfbd-e4cc-7d62-8542-c1358ab1bc5b - b682ffad80e92a9cdee1d265f0b51c735847d503)

- 2026-09-24 00:28: Bind omitted Preset SecretRef scopes to the request Namespace before admission and storage (codex/01a0cfbd-e4cc-7d62-8542-c1358ab1bc5b - 3ca1ead02d47b84fb2c4f13b305cbf263c0612a6)

- 2026-09-21 22:00: Simplify Preset selection to one-time prefill and defer ordinary launch-field validation to creation (codex/01a0b1f2-e696-7232-a439-5b668154bcd9 - f997fca7e7f739a460274c74396afbcfda63f53a)

- 2026-09-21 19:58: Link the guarded administrator grant upgrade and its eligibility contract (codex/01a0b1f2-e696-7232-a439-5b668154bcd9 - aa6dd7415d65ffba5fa40098b2142eb2a7d73df4)

- 2026-09-21 19:48: Document Preset storage, rendering, and independent Agent creation (codex/01a0b1f2-e696-7232-a439-5b668154bcd9 - aa6dd7415d65ffba5fa40098b2142eb2a7d73df4)
