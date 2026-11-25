---
created: "2026-11-24"
updated: "2026-11-25"
last_updated_session: authoring-run/7c685762-5846-42ed-80aa-4038fc0856b2
---

# OpenClaw Enterprise release flow

## Overview

A maintainer dispatches **Release OCE** on protected `main`. The default
rehearsal qualifies the images, Helm chart, and CLI from one commit. A full
publication verifies all four outputs before moving the selected image alias.
Image-only publication runs the native image checks and skips Full Integration.

## Entry Points

- `.github/workflows/release-oce.yml:jobs.validate` requires only the 40-character source SHA.
  The image alias, publication choices, and recovery run ID are optional.
- `scripts/ci/full-integration-preflight.ts:validateManualApproval` verifies
  the protected environment, reviewer team, and dispatcher's approval.

## Flow

```mermaid
graph TD
  Gate["Verify dispatch and source ancestry"] --> Approval["Approve release run"]
  Approval -->|new release| Tests["Full Integration, lane all"]
  Approval -->|new release| Build["Native images, chart and CLI"]
  Tests --> Check["Verify qualification and prepared bytes"]
  Build --> Check
  Approval -->|recovery| Lock
  Check -->|rehearsal| End["Check destinations and report artifacts"]
  Check -->|publish| Lock["Acquire shared publication lock"]
  Lock --> Recheck["Verify original evidence and destinations"]
  Recheck --> Image["Verify immutable images and chart"]
  Image --> CLI["Verify and publish GitHub Release"]
  CLI --> Alias["Update selected image aliases"]
  Approval -->|images only| Native["Build and test both native images"]
  Native --> ImageLock["Acquire shared publication lock"]
  ImageLock --> Sha["Verify both immutable source tags"]
  Sha --> Alias
```

## Execution Trace

### 1. Bind approval to the reviewed release

`.github/workflows/release-oce.yml:jobs.validate` verifies that the
selected source commit is the protected workflow commit or one of its
ancestors. Full releases validate the package and chart versions at that source.
The summary identifies the source, alias, and publication mode before approval.
`scripts/ci/full-integration-preflight.ts:validateManualApproval`
checks the dispatcher against the approval history of the release run.

### 2. Qualify one set of artifacts

`.github/workflows/full-integration-execution.yml:jobs.full-aggregate` checks
the results for `lane=all` at the selected source SHA.
`scripts/ci/release-oce.ts:validateQualification` requires evidence that the
full aggregate passed for that source in this release run and attempt. The
qualification record identifies the protected workflow commit separately
from the source under test.

`scripts/ci/container-release/oci.ts:assemble` joins the natively tested
controller and runtime exports into two Linux AMD64/ARM64 indexes. Their
digests identify the exact images for the packaged chart.
`scripts/ci/cli-release.ts:packageCli` builds and verifies four OCC binaries.
Artifacts in Actions preserve the prepared bytes for publication and recovery.
The qualification job saves `release.json` in
`qualified-release-<run-id>-1`. A rehearsal checks registry and CLI
destinations with read permissions, then ends.

### 3. Verify each public write

`scripts/ci/cli-release.ts:publish` runs after verification of the immutable
source and version tags and the chart. The caller holds the shared
`enterprise-container-publish` lock from its evidence checks through both
alias updates. Keep external writers off these tags during the release. Package jobs can write
GHCR packages. The CLI publisher can write repository contents. It verifies
the release tag, uploads missing draft assets, and compares the downloaded
files to the prepared binaries and checksum file before publishing the draft.
Release OCE also downloads the five public assets without credentials.
`scripts/ci/release-registry.ts:advanceReleaseAliases` then verifies each alias
against its recorded prior digest or the intended release digest before moving it.

With `images_only=true`, the caller requires `publish=true` and an empty
`recovery_run_id`. It skips Full Integration, chart and CLI preparation, and
release qualification. `.github/workflows/release-oce.yml:jobs.publish-images` acquires the shared publication lock,
verifies each image's immutable source tag, then moves both selected aliases.
The `container-publication-<run-id>-1` receipt identifies the two published images. The full release
version tags, chart, CLI binaries, and GitHub Release belong to the qualified path.

### 4. Recover from an interrupted publication

`scripts/ci/release-oce.ts:verifyProducer` checks the producer for a fresh recovery dispatch with the
original publish run ID. The recovery workflow runs at the protected `main`
commit selected for recovery. It checks the original producer's workflow SHA,
source SHA, approval, full-suite result, and artifact evidence. The reviewed
source must remain in `main` history.
Recovery uses the original bytes. It verifies completed steps and stops at a
conflicting immutable object or an alias that another release has moved. Each
registry or GitHub write can succeed before the next one fails.

An interrupted image-only publication uses a fresh image-only dispatch. A
conflicting digest at an existing source tag stops publication.

## Debugging and Verification

- For an admission failure, check whether the selected source belongs to the
  protected workflow commit's history. For a qualification failure, inspect
  that run's environment review and full-suite aggregate for the source SHA.
- For a partial publication, inspect the protected jobs and compare registry
  digests, the Git tag target, and the five release assets with the original
  preparation evidence. Follow [release recovery](../release/README.md#recover-a-partial-release).
- Staging qualification and Docker Hub promotion have separate entry points
  and evidence.

## Related docs

- [Release OpenClaw Enterprise](../release/README.md)
- [Container publication](container-publication.md)
- [OCC CLI publication](cli-publication.md)
- [Full Integration coverage](../testing/ci/full-integration.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-25 08:08: Document image-only publication and its native checks. (authoring-run/7c685762-5846-42ed-80aa-4038fc0856b2 - 67865414220f9d67820f165fe932fe23df025322)

- 2026-11-24 13:12: Document selection of a reviewed source in protected main history and its qualifying workflow commit. (authoring-run/90c31b49-3d89-43f7-922e-ba48b6f34371 - 165ced7e4797491e18768dafac4a76b369a025cb)

- 2026-11-24 11:31: Document release qualification, publication order, and recovery. (authoring-run/90c31b49-3d89-43f7-922e-ba48b6f34371 - 6908216b29038bd850b44f084b07ba7f886614d5)
