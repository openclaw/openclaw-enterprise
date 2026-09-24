---
created: 2026-09-21
updated: 2026-09-24
last_updated_session: codex/01a0d171-59c4-7b42-95ab-4050d18eab79
---

# Container publication flow

## Overview

Manual Enterprise container publication builds controller and runtime OCI archives
for Linux amd64 and arm64, checks both variants, and transfers the tested bytes
to private GHCR packages. Each package receives one multi-platform index digest.
This flow ends with verified remote digests and a publication receipt; it does
not deploy workloads or change package visibility.

## Entry Points

- `.github/workflows/container-publish.yml:jobs.validate`: manual dispatch on
  `main` with its exact source SHA, successful main-push CI run ID, and publish flag.
- `scripts/ci/container-release.mjs:main`: validation, smoke, seal, and publication
  commands called by the workflow.
- Publication requires pre-existing private packages. The manual dispatch
  authorizes publication without a separate environment approval. GitHub grants
  manual dispatch to repository writers, including maintainers.

## Flow

```mermaid
graph TD
  A["Operator selects main SHA and successful CI"] --> B["Validate source, CI and approved base"]
  B --> C["Build controller and runtime OCI indexes"]
  C --> D["Verify amd64 and arm64 manifests and configs"]
  D --> E["Load and smoke each platform's exact config ID"]
  E -->|either fails| X["Stop before publication"]
  E -->|both pass| F["Seal and upload each archive"]
  F -->|publish false| G["Finish with retained artifacts"]
  F -->|publish true| I["Recheck source, CI, seals and private packages"]
  I --> J["Copy all manifests with digest preservation"]
  J --> K["Verify remote index digests and write receipt"]
```

The workflow implements these gates; source review alone does not prove that a
particular hosted build or registry transfer succeeded.

## Execution Trace

### 1. Admit the source and initialize preparation

`scripts/ci/container-release.mjs:validate` verifies the trusted workflow, exact
main source and successful CI identity, and approved Node base digest. Publication
also checks the main-only environment branch policy. No-push preparation has no package write
permission or protected-environment credentials.

`.github/workflows/container-publish.yml:jobs.prepare` runs once per image. It
registers ARM64 QEMU support and asks Buildx for `linux/amd64,linux/arm64`, with
provenance disabled, in a single OCI archive. The approved Node base index must
provide both platforms. The controller and runtime use their existing recipes.
`deploy/runtime/Dockerfile:openclaw-source` downloads the pinned public OpenClaw
source archive, rejects a SHA-256 mismatch, installs its frozen dependency graph,
and follows the upstream Docker build and production-dependency assembly with
Codex and Slack selected. Plugin-local dependencies retain their own versions.
Missing package-root dependencies are linked from those plugin installations so
shared compiled chunks resolve them; existing core versions remain unchanged.
The runtime stage verifies the assembled runtime archive checksum before extraction and
retains `/opt/oce/runtime/provenance.json`; this archive is not an npm package.
Matching bundled plugins replace
independently installed plugin packages; the Dedicated Codex executable remains
separately pinned. See the [runtime recipe](../../deploy/runtime/README.md) for
source identity and installed-image checks.
Before starting the runtime build,
`scripts/ci/repository-platform-headroom.mjs:main` verifies it is running on the
Ubuntu 24 GitHub-hosted runner and removes only its unused, fixed Android SDK
directory. The helper rejects symlinks, mounts, and unexpected runner/SDK paths
and logs free bytes and inodes before and after cleanup. This makes room for
the source-build dependency layers before OCI export; local and self-hosted
runners are rejected. Controller preparation does not use this cleanup.

After OCI export, the job prunes only its dedicated Buildx builder's cache so
the cache and unpacked smoke images do not exhaust the runner's disk together.

### 2. Verify and execute both platform variants

`scripts/ci/container-release.mjs:readArchivePlatforms` reads blobs directly from
the archive by validated digest and checks their SHA-256 hashes. The root must be
an OCI index with exactly one amd64 and one arm64 Linux image manifest. Each child
config must agree with the index's platform; missing, duplicate, unsupported, or
corrupt entries stop preparation.

`scripts/ci/container-release.mjs:smoke` binds the archive's root digest to the
Buildx output, then uses Skopeo's explicit platform selection to load one variant
at a time. Docker's loaded config ID must match the selected index entry before
the existing controller or runtime startup suite runs against that ID. AMD64 runs
natively and ARM64 under QEMU. The ARM64 invocation scales smoke command and
probe deadlines by six; native deadlines and all outcome assertions stay unchanged.
Both must pass, and the archive hash must remain
unchanged. A failure prevents sealing and artifact upload for that image.
After each successful platform smoke, the loaded image tag is removed before
the next variant is loaded. The exported archive remains the publication input.

### 3. Seal and enter publication

`scripts/ci/container-release.mjs:seal` rechecks the platform contents and records
the archive hash, multi-platform index digest, platform list, source, workflow,
run attempt, CI identity, and approved base. Both prepared artifacts must exist
before `.github/workflows/container-publish.yml:jobs.publish` can start. The
publish job runs only when the operator selected `publish: true`.

No-push runs end with artifacts. Publishing runs proceed directly to automated
validation. Archive retention and package access requirements are owned
by the [operator instructions](../../.github/containers.md).

### 4. Publish and hand off immutable references

`scripts/ci/container-release.mjs:publishPrepared` checks both seals, archive hashes,
index digests, and destinations before copying either image. It repeats source,
CI, environment branch policy, and package checks during transfer. A matching existing source tag is retained;
a conflicting tag or ambiguous registry error fails. An absent tag receives the
entire index and both child manifests through Skopeo `--all --preserve-digests`.

Package metadata must report the expected name and private visibility. Reported
repository linkage must match the private Enterprise repository. Omitted linkage
is accepted without review-history lookups; package setup owns that connection.

Each remote index digest must match before the receipt is written. Deployment
uses that index digest, letting the container runtime select its architecture.
A partial failure leaves existing published bytes intact. Recovery consumes the
same retained multi-platform archives and original producer identity; it does
not rebuild them. Old amd64-only seals cannot satisfy this platform contract.

## Debugging and Verification

- Run `node --test tests/integration/container-{release,resume,promote}.test.mjs`
  for platform/archive validation and release gate coverage. The archive case uses
  real OCI blobs and tar; recovery uses transport fixtures, not a live registry.
- Run `actionlint .github/workflows/container-publish.yml` for workflow syntax.
- In a hosted preparation, require smoke output for both architectures of both
  images. A config mismatch, missing platform, or failed startup blocks upload.
- Inspect the published reference with `docker buildx imagetools inspect` and
  require Linux amd64 and arm64 plus the receipt's index digest. Startup checks
  do not establish native ARM64 performance, cluster behavior, or model turns.

## Related docs

- [Publication and recovery instructions](../../.github/containers.md)
- [Package bootstrap flow](container-package-bootstrap.md)
- [Image startup checks](../testing/images.md)

## Manual Notes

## Changelog

- 2026-09-24 04:30: Return Enterprise container builds to reviewed manual dispatch and update the runtime source to OpenClaw `2765f7a3341b8be4835afacbff3d04c6e3c3c79b` with its verified archive checksum. (codex/01a0d171-59c4-7b42-95ab-4050d18eab79 - 0224b638)

- 2026-09-24 00:30: Reclaim unused hosted Android SDK space before the runtime source build, retaining both platforms and all startup checks. (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - ae96345b)

- 2026-09-24 00:05: Build and smoke PR merge commits without release artifacts or publication; keep manual main release validation. (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - 75ce7de8)

- 2026-09-23 20:39: Link missing plugin dependencies for shared compiled runtime chunks without replacing core versions. (public-pr/295 - cf486a31)

- 2026-09-23 19:47: Build the runtime from verified public source with matching bundled plugins and retained runtime archive provenance. (public-pr/295 - 7f6d9107)

- 2026-09-22 03:04: Use manual dispatch without an independent approval or linkage comment (codex/01a0c70f-8a8f-7c62-ac81-ee1a3e99f48b - 149ac0fe)

- 2026-09-22 01:34: Record bounded QEMU smoke timeouts while retaining native deadlines and startup assertions (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - 473d9b45ee5aa8d8a081cca7664973fee5bd7e11)

- 2026-09-22 01:10: Bound disk use by pruning the job-owned build cache and removing each successfully checked image variant (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - 1e486bffadbe5f5f9f6437bfc8da2e4176ffefd6)

- 2026-09-21 22:14: Describe multi-platform preparation, per-platform smoke and immutable publication with the accompanying workflow change (codex/01a0c179-19f7-7111-8bb4-fc7680da5545 - b233abec94bce0448768a013f44fcbfab2ce7919)
