---
created: 2026-09-21
updated: 2026-10-03
last_updated_session: authoring-run/264cfb8c-8627-40cb-8ac4-0b67ef3134dc
---

# Container publication flow

## Overview

Manual Enterprise publication builds controller and runtime OCI archives for
Linux amd64 and arm64, checks both variants, and transfers the tested bytes to
public GHCR packages. Each package receives one multi-platform index digest.
With `publish_chart: true`, a separate protected job tags those digests with the
OCE version and publishes a Helm chart. Image-only publication is the default.

## Entry Points

- `.github/workflows/container-publish.yml:jobs.validate`: manual dispatch on
  `main` with its exact source SHA, successful main-push CI run ID, publish flag,
  optional mutable image tag, and opt-in chart flag.
- `scripts/ci/container-release.mjs:main`: validation, smoke, seal, and publication
  commands called by the workflow.
- `scripts/ci/chart-release.mjs:publish`: version-tag and chart publication after
  the image receipt exists.
- Publication requires pre-existing public packages. The manual dispatch
  authorizes publication without a separate environment approval. GitHub grants
  manual dispatch to repository writers, including maintainers.

## Flow

```mermaid
graph TD
  A["Operator selects main SHA and successful CI"] --> B["Validate source, CI and approved base"]
  B --> C["Pin timestamps to the source commit"]
  C --> D["Build controller and runtime on native AMD64 and ARM64"]
  D --> E["Load and smoke each native config ID"]
  E --> H["Canonicalize descriptors and assemble OCI indexes"]
  H -->|either fails| X["Stop before publication"]
  H -->|both pass| F["Seal and upload each archive"]
  F -->|publish false| G["Finish with retained artifacts"]
  F -->|publish true| I["Recheck source, CI, seals and public packages"]
  I --> J["Copy and verify both immutable source tags"]
  J --> K["Copy and verify selected mutable aliases"]
  K --> L["Recheck digests and write image receipt"]
  L -->|publish_chart false| O["Finish image publication"]
  L -->|publish_chart true| M["Separate job tags image digests and pushes chart"]
  M --> N["Pull chart, verify bytes and write release receipt"]
```

Source review does not prove a hosted build or registry transfer succeeded.

## Execution Trace

### 1. Admit the source and initialize preparation

`scripts/ci/container-release.mjs:validate` verifies the trusted workflow, exact
main source and successful CI identity, approved Node base digest, and the optional
image tag. An empty tag selects `latest`; invalid or reserved tags fail before
preparation. No-push preparation accepts private or public source only when
`PUBLISH` is the exact string `"false"`. Publication and recovery require the
public Enterprise repository and public packages. Publication also checks the
main-only environment branch policy. No-push preparation has no package write
permission or protected-environment credentials.

`.github/workflows/container-publish.yml:jobs.prepare` calls the reusable
`.github/workflows/container-check.yml:jobs.prepare` image/architecture matrix. Controller and runtime each build on native AMD64 and ARM64 Linux runners.
The defaults are `blacksmith-16vcpu-ubuntu-2404` and
`blacksmith-8vcpu-ubuntu-2404-arm`; `CONTAINER_AMD64_RUNNER` and
`CONTAINER_ARM64_RUNNER` repository variables can select other provisioned labels.
Each job checks its architecture and logs CPU, memory, and available disk.
Jobs require at least four CPUs and 12 GiB RAM; the reported runner label alone
is not evidence of allocated capacity.
`scripts/ci/setup-tools.sh` installs checksum-pinned kubectl, k3d, Helm, and yq
for both native Linux architectures before runtime smoke tests.
The standard AMD64 override retains guarded toolchain cleanup: required roots
are checked, unsafe optional paths are skipped, and 36 GiB free is required.
Larger runners do not depend on deleting preinstalled SDKs.

Each Buildx builder runs at most two steps concurrently. The default Blacksmith
runners retain BuildKit layers on a sticky disk scoped by image and architecture,
so builds do not export the large intermediate cache over the network. A custom
non-Blacksmith runner uses the GitHub Actions cache with the same scope.
Maintainers can also dispatch `container-check.yml` on a branch for native image
verification; manual `CI` dispatches call the same workflow so branches can be
verified before the workflow first lands on main. It has no publication job or
package-write permission.
The build exports
an OCI directory without registry publication or credentials.
Before Buildx runs, the workflow derives `SOURCE_DATE_EPOCH` from the exact
source commit. BuildKit rewrites image and filesystem timestamps to that epoch,
so wall-clock time does not change the image manifests on a cold-cache rebuild.

`deploy/runtime/Dockerfile:openclaw-source` verifies the pinned OpenClaw main source archive,
uses its stock Codex 0.158.0 dependency/lockfile selection, and applies the temporary
OpenClaw read-only-paths compatibility patch and the `connect --ephemeral`
expired-setup patch. The build verifies both patch hashes and records them in
runtime provenance. The OpenClaw bridge forwards the bound
Agent's stock network settings without modifying the Codex binary. Both installs use
frozen lockfiles and upstream's selected-plugin manifests, retaining required
bundled plugins plus Codex and Slack. The standalone Codex command links to the
plugin's installation. Build tools remain in full Bookworm stages; final images
use a separately pinned Node 24 Bookworm slim base.

`deploy/runtime/Dockerfile:runtime` disables npm's background update notifier in
the final image environment. Harness child processes inherit that default, so
local npm scripts do not trigger a separate version-check network request.
See the [runtime defaults](../../deploy/runtime/README.md) for scope.

`scripts/build-runtime-assets.mjs` removes development/QA source, extension tests,
and documentation media, while retaining runtime templates, skills, and help.
It follows importer-relative runtime dependencies to remove unreachable pnpm
store entries without collapsing distinct package versions. It writes initial
provenance containing source, patch, lockfile, and inventory hashes. The runtime
copies the assembled directory directly; there is no gzip archive or second
Codex installation. After final-stage permission normalization, the inventory
helper rewrites `contents.json` from `/app/node_modules/openclaw` and updates
`runtimeContentsSha256` and the stock `codex` package/binary identity. Provenance
therefore describes the final runtime tree. Upstream
import-closure and native-addon checks remain. See the
[runtime recipe](../../deploy/runtime/README.md).

### 2. Verify and assemble both platform variants

`scripts/ci/container-release.mjs:smoke` requires a native runner matching the
selected platform. It binds the OCI export to the build output digest, loads it
with Skopeo, checks Docker's config ID and architecture, and runs the existing
startup suite with native deadlines. A success receipt binds the platform digest
to the source, workflow, run/attempt, CI evidence, image, and build base. Failed
smokes cannot upload platform artifacts. The temporary loaded image is removed.

`.github/workflows/container-publish.yml:jobs.assemble` downloads both successful
platform artifacts from this exact run/attempt. `container-release.mjs:assemble`
rejects mismatched receipts, platform configs, blob sizes, or hashes before linking
blobs into one OCI layout. It retains only the manifest media type, digest, size,
and platform in each assembled descriptor, excluding exporter-only annotations
such as the build time and local reference name. It writes the multi-platform
index and archive without rebuilding either variant, then removes the temporary layouts.
`readArchivePlatforms` checks the archive contains exactly one AMD64 and one ARM64
Linux manifest with matching config and content digests. Publication still consumes
this sealed archive; registry access is not needed during assembly.

Before runtime smoke, `scripts/ci/prepare.mjs:prepareRuntimeImageSmoke` imports
the loaded config ID into a disposable k3d cluster. It reuses the Images and
Packaging lane's reviewed Codex seccomp derivation and sandbox probes, then passes
the resulting profile and ownership state to the Docker tests. This preparation
does not rebuild the runtime. Cleanup removes the owned cluster and temporary
image tag on success or failure; a workflow cleanup step also runs after an
interrupted smoke command.

### 3. Seal and enter publication

`scripts/ci/container-release.mjs:seal` rechecks the platform contents and records
the archive hash, multi-platform index digest, platform list, source, workflow,
run attempt, CI identity, and approved base. Both prepared artifacts must exist
before `.github/workflows/container-publish.yml:jobs.publish` can start. The
publish job runs only when the operator selected `publish: true`.

No-push runs end with artifacts. See [operator instructions](../../.github/containers.md)
for retention and package access.

### 4. Publish and hand off immutable references

`scripts/ci/container-release.mjs:publishPrepared` checks both seals, archive hashes,
index digests, and destinations before copying either image. It repeats source,
CI, environment branch policy, and package checks during transfer. A matching existing source tag is retained;
a conflicting tag or ambiguous registry error fails. An absent tag receives the
entire index and both child manifests through Skopeo `--all --preserve-digests`.
After both source tags verify, ordinary publication copies each sealed archive to
`latest` or the selected custom alias, then checks both source and alias digests.
The custom alias replaces `latest` for that dispatch; recovery does not move an
alias. The two aliases are updated separately, so a failed run can leave them on
different digests. The receipt is written only after both verify.

Package metadata must report the expected name and public visibility. Reported
repository linkage must match the public Enterprise repository. Omitted linkage
is accepted without review-history lookups; package setup owns that connection.

Each remote index digest must match before the receipt is written. Deployment
uses that index digest, letting the container runtime select its architecture.
A partial failure leaves existing published bytes intact. Recovery consumes the
same retained multi-platform archives and original producer identity; it does
not rebuild them. Old amd64-only seals cannot satisfy this platform contract.

The optional `jobs.publish-chart` downloads this run/attempt's image receipt only
after `jobs.publish` succeeds. `scripts/ci/chart-release.mjs` requires
both entries to match the current source, producer run, CI run, package names,
and immutable digests. Root `package.json`, the chart version, and appVersion
must agree before a version tag is written. The staged chart carries the source
SHA and both digest references in annotations; its default controller image is
the verified controller digest. Operator values can override that default.

Both jobs share the protected environment. Workflow-level concurrency retains
the publication lock across preparation and both writes; jobs never reacquire it.
The chart publisher checks image version tags and any existing chart before writing. Existing tags must resolve to the receipt's digests;
an existing chart version must have identical packaged files. It rechecks the trusted
source, CI, environment, and public chart package before each write. After
`helm push`, it pulls the chart, compares its packaged files and new-push archive bytes, inspects the remote
manifest digest, and writes a separate `chart-publication.json`. A partial
failure requires a new full dispatch with identical source; chart-only reruns
lack the new attempt's image receipt. Chart failure leaves image success intact
but fails the combined run. `jobs.summary` reports both outcomes.
The receipt binds the chart manifest digest observed after the pull. This
assumes the protected publication workflows and trusted package administrators
are the only package writers; their workflow concurrency group does not exclude
independent GHCR writers. A tag change between the pull and digest lookup could
make the receipt refer to a different manifest. The operator's
[single-writer requirement](../../.github/chart-publication.md#choose-one-release-version)
owns package-write access and coordination.

## Debugging and Verification

- Run `node --test tests/integration/container-{release,resume,promote}.test.mjs`
  for platform/archive validation and release gate coverage. The archive case uses
  real OCI blobs and tar; recovery uses transport fixtures.
- Run the [registry integration](../testing/images.md#container-publication-registry-proof)
  to check real Skopeo alias replacement against a disposable local registry.
  This does not prove GHCR access.
- Run `actionlint .github/workflows/container-publish.yml` for workflow syntax.
- In a hosted preparation, require smoke output for both architectures of both
  images. A config mismatch, missing platform, or failed startup blocks upload.
- Repeat publication for the same source and CI evidence to prove that the
  registry index identity is stable; the second run must retain the existing
  source tag. Mutable external package inputs can still produce a legitimate
  conflict, which remains fail-closed.
- Use `docker buildx imagetools inspect` on both the source tag and selected alias.
  Require Linux amd64 and arm64 plus the receipt's index digest. Startup checks
  do not establish native ARM64 performance, cluster behavior, or model turns.

## Related docs

- [Publication and recovery instructions](../../.github/containers.md)
- [Chart publication and pull](../../.github/chart-publication.md)
- [Package bootstrap flow](container-package-bootstrap.md)
- [Image startup checks](../testing/images.md)

## Manual Notes

## Changelog

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

- 2026-09-22 01:34: Record bounded QEMU smoke timeouts while retaining native deadlines and startup assertions (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - 473d9b45ee5aa8d8a081cca7664973fee5bd7e11)

- 2026-09-22 01:10: Bound disk use by pruning the job-owned build cache and removing each successfully checked image variant (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - 1e486bffadbe5f5f9f6437bfc8da2e4176ffefd6)

- 2026-09-21 22:14: Describe multi-platform preparation, per-platform smoke and immutable publication with the accompanying workflow change (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - b233abec94bce0448768a013f44fcbfab2ce7919)
