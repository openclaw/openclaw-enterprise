# Publish the OCC CLI

Publish four standalone `occ` binaries and `SHA256SUMS` as a GitHub Release.
Complete [release configuration](configuration.md) once.

## Publish

1. Set root `package.json` to a strict `X.Y.Z` version and set the chart's
   `version` and `appVersion` to the same value. Merge the version and release
   code to `main`. Wait for its entire exact push CI run to succeed.
2. Dispatch [Release OCC CLI](../../.github/workflows/cli-release.yml) on
   `main` with the full `source_sha` and successful `ci_run_id`. The source
   must match the selected workflow commit. For a complete OCE release, use the
   same source for images and chart; this workflow does not verify GHCR publication.
   The build cross-compiles with pinned Go 1.27.3, checks each binary’s source
   and platform metadata, runs the runner-platform binary, and retains the exact
   binaries and checksums before publication.
3. Check the published `vX.Y.Z` tag points to that SHA. Verify the release has
   the four Darwin/Linux amd64/arm64 binaries and `SHA256SUMS`, then check a
   downloaded binary's `occ --version`.

If publication stops, inspect the tag and draft release before retrying. A retry
can complete a matching draft without replacing assets, including a failed-job
rerun using the successful build artifact. A conflicting tag, changed or
unexpected asset, or already published release stops the workflow. The publisher downloads
every asset and compares it with the verified build before publishing the draft. Do not delete
or move a tag to evade a conflict. Limit release writes to trusted administrators;
workflow concurrency does not exclude independent writers. See the
[CLI publication flow](../flows/cli-publication.md) for build and verification details.

Use [CLI setup](../guides/cli.md) for download and authentication. A private
repository requires GitHub authentication for release assets. The binaries do
not install OCE or make `occ dev up` work outside a source checkout.
