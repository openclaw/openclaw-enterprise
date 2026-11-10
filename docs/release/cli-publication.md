# Publish the OCC CLI

The [Release OCC CLI workflow](../../.github/workflows/cli-release.yml) publishes four
standalone `occ` binaries and `SHA256SUMS` as a GitHub Release. It does not
install OpenClaw Enterprise or make `occ dev up` usable outside a source checkout.

Advance the SemVer version in root `package.json` and keep the Helm chart's
`version` and `appVersion` equal to it. Merge the version and release code to
`main`, then wait for that exact main-push CI run to pass, including
`CI Required`. Configure the main-only `container-publish` environment from
[operator setup](containers.md#operator-setup) before dispatch. Use the same source commit for the chart and image publication
when releasing the complete OCE version. This workflow checks version equality
but does not prove that GHCR publication succeeded.

Dispatch **Release OCC CLI** on `main` with the full `source_sha` of the selected
`main` commit and its successful `ci_run_id`. The workflow requires the source
commit SHA to match the selected workflow commit and checks CI identity. It
cross-compiles `darwin` and `linux` binaries for `amd64` and `arm64` with pinned
Go 1.27.3, then checks each binary's source commit SHA and platform metadata.
It also runs the binary for the runner's platform to check its release version
and help output. It uploads those exact bytes and checksums as a run
artifact before the protected publication job starts. A failed-job rerun uses
the artifact name from the successful build job, even when the run attempt
number changes.

Publication creates a lightweight `v<version>` tag at the source SHA and a draft
GitHub Release. It uploads missing assets, downloads every asset to compare it
with the verified build, then publishes the draft. A retry can finish a matching
draft without replacing assets. The publisher finds drafts through the
authenticated release list, since the tag lookup covers published releases.
A tag pointing elsewhere, a changed asset, an
unexpected asset, or an already published release stops the workflow. Inspect
the draft and tag before retrying a partial publication; do not delete or move
a tag to evade a conflict. The same source, Go toolchain, and binary inputs must
produce identical bytes on retry; the packaging integration test builds them
twice and compares their checksums. Only trusted release administrators may
change the tag or draft during publication; the concurrency group serializes
participating workflows, not independent GitHub writers. A concurrent tag or
asset change between verification and publication could invalidate the result.

After publication, check the release page, the tag's source SHA, the five
assets, and a downloaded binary's `occ --version`. The binaries are useful for
an existing OCC endpoint with a service-key file. Follow [CLI setup](../guides/cli.md)
for download and authentication. A private repository requires GitHub
authentication to download its release assets.
