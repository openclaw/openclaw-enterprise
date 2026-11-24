# Release OpenClaw Enterprise

Use **Release OCE** to test and publish the controller image, runtime image,
Helm chart, and OCC CLI from one reviewed commit. Start with a rehearsal.

<a id="overview"></a>
<a id="release-guides"></a>

## Rehearse a release

1. Set root `package.json` and the Helm chart's `version` and `appVersion` to
   the same numeric `X.Y.Z` version. Merge the version change to protected `main`.
2. Select a reviewed commit in `main` history. Check [release configuration](configuration.md),
   [GHCR package setup](configuration.md#bootstrap-ghcr-packages), and the
   [integration approval environment](../testing/ci/configuration.md#environments).
3. Dispatch [Release OCE](../../.github/workflows/release-oce.yml) on `main`.
   Supply the full 40-character `source_sha` (the only required input).
   Leave `publish` false for a rehearsal. No previous push CI run is required.
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

Keep the original failed or cancelled publication run at attempt 1. Image, chart, and
alias-baseline artifacts expire after seven days. Inspect the run summary, registry
digests, and GitHub Release or draft. Writes are not atomic; aliases can point
to different versions. Use digest references during recovery.

Dispatch **Release OCE** on current protected `main` with the original
`source_sha`, original `image_tag`, `publish: true`, and
`recovery_run_id` set to the failed publication run ID. Approve the new run.
Recovery verifies the original qualification and bytes, then completes missing
steps. The source must remain in `main` history. Expired evidence, conflicting
bytes, or a newer alias stops recovery. Preserve the original run and refer
conflicts to a release maintainer.

## Standalone publication

- [Publish images independently](containers.md#prepare-and-publish)
- [Publish images with a Helm chart](chart-publication.md#publish)
- [Publish the OCC CLI independently](cli-publication.md#publish)

These workflows qualify only their own outputs. Before the first versioned
rollout, maintainers must decide whether versioned releases require Release OCE
or verified recovery, and whether `latest` is reserved for complete releases.
Coordinate writers until that decision is made.

Other tasks: [Configuration](configuration.md), [Docker Hub promotion](container-promotion.md#promote),
[standalone image recovery](containers.md#recover-a-partial-publication), and
[checks for standalone published images](staging-qualification.md).

## Implementation flows

- [Release OCE](../flows/release-oce.md)
- [Container publication](../flows/container-publication.md)
- [Package bootstrap](../flows/container-package-bootstrap.md)
- [CLI publication](../flows/cli-publication.md)
