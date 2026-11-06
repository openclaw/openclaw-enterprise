---
published: false
---

# Container publication documentation history

This record preserves the dated changes to the container publication flow. See the [parent page](../container-publication.md) for its context.

## Changelog

- 2026-10-08 13:36: Pin the shared stock Codex dependency to 0.163.0-alpha.1 before frozen installation and record its dependency patch alongside the existing bridge patches. (authoring-run/74dc7eaf-a67b-47ef-91bd-2ecd0463fb10 - ae695e7f2b0c7bcd2416ed8146baeecb765ae233)

- 2026-10-05 12:10: Update the OpenClaw pin, workspace templates, and Codex sandbox qualification to 0.160.0. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - dd344a97)

- 2026-10-03 16:19: Refresh the OpenClaw main pin to `6f91eda9c72` (openclaw/openclaw#162156), its archive checksum, the rebased read-only-paths bridge patch checksum, and the matching workspace-template version; bridge behavior is unchanged. (authoring-run/264cfb8c-8627-40cb-8ac4-0b67ef3134dc - 8193ad3cadec560e3f97401fb999e672b1517aec)

- 2026-09-30 11:18: Change publication and recovery policy to public source with public GHCR packages; no-push preparation remains allowed only with literal `PUBLISH=false`. (authoring-run/ccc78f8c-ca87-4c18-bf6e-f06120699584 - 76e9de599a1c5b1319af4f9003f86ecbf53aa9ec)

- 2026-09-29 10:10: Make chart publication opt-in with separate image/chart jobs and outcomes. (01a0eda8-1144-78e3-a1f7-82e8562e5125 - 2d251975fba5b05bd83e96f95ee89c2c67635d50)

- 2026-09-29 08:03: Refresh the OpenClaw main pin, archive and bridge-patch checksums, and matching workspace-template version; bridge behavior is unchanged. (authoring-run/5e3ebbae-97b8-4709-8c03-6a032657e102 - 8f3fc12cca3cb2e2a387aefb2be4d1c1eb2b39b6)

- 2026-09-29 12:00: Apply a verified OpenClaw bridge patch so a dedicated native worker reconnects with its saved device token after its replayed setup code expires; record its hash in runtime provenance. (fix/native-worker-restart-expired-setup)

- 2026-09-29 10:00: Update the runtime source to OpenClaw `01d7131999ca4805242ed8b0d8037f4544a9d7b0` (release/2026.9.7 head) with its verified archive checksum; the read-only-paths bridge patch applies unchanged. (chore/openclaw-pin-01d7131999)

- 2026-09-28 14:51: Use upstream Codex 0.158.0 dependencies and remove the old version override. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - 6c56149f)

- 2026-09-28 03:13: Disable npm background update checks in the runtime image. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - 587b3096b2b5de9c5575a13b36133be99a93ebe2)

- 2026-09-27 20:26: Build the selected upstream commit with a verified temporary read-only-paths compatibility patch and record its hash. (codex/01a0e437-0dda-7ca2-9704-2c37c71f8d11 - 5d906bf9ad82bca1ec4f05d5958250607e185c6d)

- 2026-09-27 19:28: Publish a verified mutable alias after both immutable source tags; keep recovery source-only. (codex/01a0e437-0dda-7ca2-9704-2c37c71f8d11 - 181b0472f9a5a9d422035edf5121d3a15c200cb5)

- 2026-09-26 20:36: Prepare the reviewed Codex seccomp profile for native release smoke using the exact exported runtime image. (codex/01a0b1f2-e696-7232-a439-5b668154bcd9 - 849b2b24)

- 2026-09-26 09:07: Retain final runtime provenance while selecting stock Codex packages and forwarding stock broker network settings. (authoring-run/c29b3860-d1f0-4a14-a264-49090586cb20 - 20123a3aa96021391616e918deee0ce60b009fa3)
  Removed the custom Codex private-endpoint requirement. (NOT_IN_SPEC)

- 2026-09-26 02:37: Recompute runtime contents after final-stage Codex replacement and permission normalization so provenance describes the final OpenClaw package tree. (authoring-run/5396927a-061a-4dda-b2d1-d3975a89c1e8 - 2ba56d35)

- 2026-09-25 00:51: Pin build timestamps to the source commit and exclude exporter-only annotations from registry image identity so same-source publication is idempotent when resolved inputs are unchanged. (authoring-run/79b51ae7-5ded-47f2-bb2f-ebcb115445d0 - 0f3a4789)

- 2026-09-24 17:20: Keep the default native build cache on Blacksmith sticky disks and avoid exporting the same intermediate layers to the GitHub Actions cache. (codex/01a0d171-59c4-7b42-95ab-4050d18eab79 - 6b5c9093)

- 2026-09-24 06:36: Build and smoke on native runners with architecture caches, slim images, and shared Codex 0.156.0. (public-pr/363 - 24ecb94b)

- 2026-09-24 04:45: Keep host emulator registrations mounted and execute an ARM64 container before building. (public-pr/348 - 467bcc83)

- 2026-09-24 03:50: Use the existing Blacksmith runner for runtime preparation after GitHub-hosted builds exhausted disk; keep both platforms and all smoke checks. (public-pr/348 - ee6a5a3d)

- 2026-09-24 05:30: Retain the updated main source and manual-only publication gate while applying sequential platform assembly. (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - b3469cc4)

- 2026-09-24 04:30: Return Enterprise container builds to reviewed manual dispatch and update the runtime source to OpenClaw `2765f7a3341b8be4835afacbff3d04c6e3c3c79b` with its verified archive checksum. (codex/01a0d171-59c4-7b42-95ab-4050d18eab79 - 0224b638)

- 2026-09-24 04:03: Export architectures sequentially, release build snapshots between them, and assemble validated OCI blobs before startup checks. (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - bac4602c)

- 2026-09-24 03:01: Limit concurrent BuildKit steps and remove temporary pnpm stores before committing dependency layers. (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - 1a126137)

- 2026-09-24 00:30: Reclaim unused hosted Android SDK space before the runtime source build, retaining both platforms and all startup checks. (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - ae96345b)

- 2026-09-24 00:05: Build and smoke PR merge commits without release artifacts or publication; keep manual main release validation. (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - 75ce7de8)

- 2026-09-23 20:39: Link missing plugin dependencies for shared compiled runtime chunks without replacing core versions. (public-pr/295 - cf486a31)

- 2026-09-23 19:47: Build the runtime from verified public source with matching bundled plugins and retained runtime archive provenance. (public-pr/295 - 7f6d9107)

- 2026-09-22 03:04: Use manual dispatch without an independent approval or linkage comment (codex/01a0c70f-8a8f-7c62-ac81-ee1a3e99f48b - 149ac0fe)

- 2026-09-22 01:34: Record QEMU smoke test deadlines while retaining native deadlines and startup assertions (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - 473d9b45ee5aa8d8a081cca7664973fee5bd7e11)

- 2026-09-22 01:10: Bound disk use by pruning the job-owned build cache and removing each successfully checked image variant (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - 1e486bffadbe5f5f9f6437bfc8da2e4176ffefd6)

- 2026-09-21 22:14: Describe multi-platform preparation, per-platform smoke and immutable publication with the accompanying workflow change (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - b233abec94bce0448768a013f44fcbfab2ce7919)
