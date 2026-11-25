# Release OpenClaw Enterprise

Use **Release OCE** to publish from one reviewed commit in protected `main`. Choose:

- [Publish images only](#publish-images-only): controller and runtime images, without Full Integration.
- [Rehearse a full release](#rehearse-a-release), then [publish and verify](#publish-and-verify): images, Helm chart, and OCC CLI.
- [Recover an image-only publication](#recover-an-image-only-publication) or [a full release](#recover-a-partial-release).

<a id="overview"></a>
<a id="release-guides"></a>

## Publish images only

1. Check [release configuration](configuration.md) and [GHCR package setup](configuration.md#bootstrap-ghcr-packages).
   Select a reviewed commit in `main` history. No version change or previous push CI run is required.
2. Dispatch [Release OCE](../../.github/workflows/release-oce.yml) on `main` with the full
   40-character `source_sha`, `publish: true`, and `images_only: true`. Leave
   `recovery_run_id` empty. **A blank `image_tag` updates `latest` for both images.**
   Use a [custom alias](containers.md#prepare-and-publish) to leave `latest` unchanged.
   There is no image-only rehearsal.
3. Check the SHA and alias in the summary, then approve through `integration-main-approval`.
   Require the native Linux amd64 and arm64 checks for both images.
4. Compare both `sha-<source_sha>` tags and selected aliases with the digests in
   `container-publication-<run-id>-1`. The receipt expires after 30 days.
   If publication stops, [recover it](#recover-an-image-only-publication).

This mode skips Full Integration. It publishes no version tags, Helm chart, OCC CLI,
or GitHub Release. Docker Hub promotion and Staging Release Qualification do not accept this run.

### Recover an image-only publication

If publication fails, times out, or is cancelled, inspect both source tags and aliases.
Use digest references if the aliases differ.

1. Keep the original run at attempt 1. Its prepared images and
   `release-image-baseline-<run-id>-1` expire after seven days.
2. Dispatch **Release OCE** on `main` with the original `source_sha` and `image_tag`,
   `publish: true`, `images_only: true`, and `recovery_run_id` set to the original run ID.
   Approve the new run.
3. Check the new receipt and both aliases. Recovery reuses the original bytes and
   accepts each alias only at its previous or intended digest. A conflict stops recovery;
   preserve the evidence and contact a release maintainer.

## Rehearse a release

1. Set root `package.json` and the Helm chart's `version` and `appVersion` to
   the same numeric `X.Y.Z` version. Merge the version change to protected `main`.
2. Select a reviewed commit in `main` history. Check [release configuration](configuration.md),
   [GHCR package setup](configuration.md#bootstrap-ghcr-packages), and the
   [integration approval environment](../testing/ci/configuration.md#environments).
3. Dispatch [Release OCE](../../.github/workflows/release-oce.yml) on `main`.
   Supply the full 40-character `source_sha` (the only required input).
   Leave `publish` and `images_only` false for a rehearsal. No previous push CI run is required.
   Choose `image_tag` now: **blank selects `latest` for both images**;
   a custom alias leaves `latest` unchanged. See [alias rules](containers.md#prepare-and-publish).
4. Check the version, SHA, and alias in the summary. Approve your dispatch through
   `integration-main-approval`. Require **Full Integration Aggregate** for
   `lane=all`, native Linux amd64/arm64 image checks, CLI verification, and chart preparation.

A successful rehearsal checks destinations and retains prepared artifacts and
`qualified-release-<run-id>-1`. It publishes nothing. The source SHA identifies
the release code; the workflow SHA identifies the protected workflow that tested it.

## Publish and verify

Dispatch a fresh **Release OCE** run with the reviewed inputs and `publish: true`.
Approve it and wait for its own qualification and publication to succeed. Verify:

- controller and runtime: verified multi-platform digests at `sha-<source_sha>` and `<version>`;
- chart: matching version, appVersion, and image digests; [pull and inspect it](chart-publication.md#pull-and-install);
- CLI: public GitHub Release `v<version>` at the source SHA, four macOS/Linux binaries and `SHA256SUMS`;
- alias: both images point to the verified digests. The workflow moves aliases after chart and CLI verification.

If any step fails, inspect the public outputs before retrying or [recovering](#recover-a-partial-release).

## Recover a partial release

Keep the original failed or cancelled full publication run at attempt 1.
Image, chart, and alias-baseline artifacts expire after seven days. Inspect the run
summary, registry digests, and GitHub Release or draft. Writes are not atomic;
use digest references if the aliases differ.

Dispatch **Release OCE** on current protected `main` with the original
`source_sha`, original `image_tag`, `publish: true`, and
`recovery_run_id` set to the failed publication run ID. Approve the new run.
Recovery verifies the original qualification and bytes, then completes missing
steps. The source must remain in `main` history. Expired evidence, conflicting
bytes, or a newer alias stops recovery. Preserve the original run and refer
conflicts to a release maintainer.

<a id="standalone-publication"></a>

## Advanced

Use these procedures when you need to publish an individual component or copy
released images to another registry:

- [Publish container images independently](containers.md#prepare-and-publish)
- [Publish images with a Helm chart](chart-publication.md#publish)
- [Publish the OCC CLI independently](cli-publication.md#publish)
- [Check standalone published images](staging-qualification.md)
- [Copy released images to private Docker Hub repositories](container-promotion.md#promote)
- [Recover a standalone image publication](containers.md#recover-a-partial-publication)

Standalone workflows qualify only their own outputs. Before the first versioned
rollout, maintainers must decide whether versioned releases require Release OCE
or verified recovery. Coordinate updates to `latest` across all image publishers.

## Implementation flows

- [Release OCE](../flows/release-oce.md)
- [Container publication](../flows/container-publication.md)
- [Package bootstrap](../flows/container-package-bootstrap.md)
- [CLI publication](../flows/cli-publication.md)
