# Enterprise container publication

Use **Enterprise Containers** to prepare or publish controller and runtime
images for Linux amd64 and arm64.

## Prepare and publish

1. Check the [base image and runners](configuration.md#build-settings). For
   publication, also complete [publication configuration](configuration.md#publication-configuration).
   Select the reviewed current `main` SHA. Require the entire push CI workflow
   conclusion and its `CI Required` job to be successful for that commit.
   First Agent Smoke must succeed when selected. PR checks are insufficient.
   With Node 24 and `gh`, find the inputs:

   ```sh
   node scripts/ci/container-source.ts "$REVIEWED_SHA"
   ```

   The command prints `source_sha` and `ci_run_id` as JSON.

2. Choose no-push preparation (`publish: false`) or publication
   (`publish: true`). **For publication, a blank `image_tag` updates mutable
   `latest` for both images.** A custom alias is also mutable and can replace
   an existing tag. An alias is at most 128 ASCII letters, digits, underscores,
   periods, or hyphens and starts with a letter, digit, or underscore. The
   case-insensitive prefixes `sha-` and `bootstrap-`, and SemVer release tags,
   are reserved. For a chart release, also set `publish_chart: true` and follow
   the [Helm chart steps](chart-publication.md#publish).
3. Dispatch [Enterprise Containers](../../.github/workflows/container-publish.yml)
   on `main` with the selected inputs. If `main` moved, review the new commit
   and use its own CI run. If publication stops, inspect both remote digests and
   use [recovery](#recover-a-partial-publication).
4. For no-push preparation, require successful validation, native preparation,
   runtime smoke, and both assembly jobs. Retain the sealed
   `container-<controller|runtime>-<run-id>-<attempt>` artifacts; there is no
   publication receipt or registry digest. For publication, also require the
   successful image job. Compare both remote index digests with its summary and
   `container-publication-<run-id>-<attempt>` receipt. Deploy with
   `image@sha256:...`, not a mutable alias. The immutable
   `sha-<source-sha>` tags cannot be replaced with different bytes.

No-push runs upload image artifacts accessible to repository readers, even for
public source; review the contents and audience before dispatch. OCI archives
expire after seven days; receipts expire after 30 days. Preparation never
publishes a chart, even if `publish_chart` is selected.

Each image has one multi-platform index digest; a pull selects the matching
architecture. Publication also adds an OCE version tag when the chart is selected.
The workflow holds its shared publication lock across preparation and both
publication jobs. An active run keeps the lock, but a queued run can be superseded
before it starts. The lock does not control independent registry administrators.

The two image copies and alias updates are not atomic. After a partial failure,
inspect both remote digests and use digest references until a successful
publication updates both aliases. A rebuild with changed external package inputs can produce different bytes even
for the same source. Do not delete or overwrite conflicting tags.
Recovery restores source tags only; it does not move aliases. A chart failure
fails the combined run but leaves successful image publication intact. See
[chart retry](chart-publication.md#publish) and the
[publication flow](../flows/container-publication.md) for details.

<a id="source-visibility"></a>
<a id="operator-setup"></a>
<a id="confirm-package-linkage"></a>
<a id="bootstrap-ghcr-packages"></a>

## Configuration

See [release configuration](configuration.md), [package linkage](configuration.md#confirm-package-linkage),
and [package bootstrap](configuration.md#bootstrap-ghcr-packages). No-push
preparation permits private or public source; real publication requires public
source and packages.

## Check native images without publication

To check a reviewed ref independently, dispatch
[Check Native Container Images](../../.github/workflows/container-check.yml):

```sh
selected_ref='REPLACE_WITH_BRANCH_OR_TAG'
expected_sha='REPLACE_WITH_REVIEWED_FULL_COMMIT_SHA'
gh workflow run container-check.yml --repo openclaw/openclaw-enterprise \
  --ref "$selected_ref" -f source_sha="$expected_sha"
```

A moved ref fails the SHA comparison. Omitting `source_sha` removes that
independent check. This workflow pushes no images. Repository readers can download the artifacts;
review their contents and audience before dispatch.

### Retain native export evidence

Require a successful terminal run: all four `Prepare` jobs and both
`Smoke runtime` jobs must succeed. After smoke failure, rerun the whole
workflow; a smoke-only retry cannot use the previous attempt's artifact.
Download the four qualified
`platform-<controller|runtime>-<amd64|arm64>-<run-id>-<attempt>` artifacts
before their one-day expiry. `built-runtime-*` artifacts are unqualified.

Keep the original ZIP, artifact ID and SHA-256, run, attempt, source SHA, and
successful job records. Compare the ZIP checksum with artifact metadata. Extract
into a private directory and verify the unchanged layout with the producer's
build digest from **Build native OCI image without publication**
(`steps.build.outputs.digest`), workflow SHA, and pinned Node base:

```sh
SOURCE_SHA="$expected_sha" GITHUB_WORKFLOW_SHA="$workflow_sha" \
GITHUB_RUN_ID="$run_id" GITHUB_RUN_ATTEMPT="$attempt" \
CI_RUN_ID='' CI_ATTEMPT='' NODE_BASE_IMAGE="$pinned_node_base" \
IMAGE=runtime PLATFORM=linux/arm64 IMAGE_DIGEST="$build_digest" \
node scripts/ci/container-release.ts verify-platform "$extracted_layout"
```

Use empty CI fields for a direct native check, the CI run's own ID/attempt for
manual CI, or the validated source CI ID/attempt for Enterprise Containers.
The command prints platform, build root, manifest, and config digests. A ZIP
checksum is not an OCI image digest.

## Recover a partial publication

Preserve the original seven-day OCI artifacts. Do not rerun their producer:
recovery requires its unchanged attempt. If artifacts expired, this path cannot
reconstruct the original bytes.

Dispatch [Resume Enterprise Container Publication](../../.github/workflows/container-resume.yml)
on reviewed `main` with:

- `source_sha`: original image source SHA, still in `main` history and equal to
  or an ancestor of the recovery workflow commit.
- `preparation_run_id`, `preparation_attempt`: original Enterprise Containers
  run with successful validation, four native preparation jobs, two runtime
  smoke jobs, and two assembly jobs.
- `workflow_ci_run_id`: successful exact push CI for the recovery workflow
  commit, separate from the original source CI.

Review original digests, public package settings, and the approved Node base.
Recovery checks original and workflow CI, artifact IDs, seals, and hashes.
The approved Node base must still match the original seals. Older producers
without separate runtime smoke jobs and old single-platform archives are
ineligible; fresh qualification cannot reconstruct their original bytes.
It leaves matching source tags unchanged after checking package metadata and
remote manifest digest. Only an authenticated manifest-unknown response permits
a missing-tag copy. It copies missing tags with the original
bytes, and refuses conflicts or uncertain registry responses. It does not roll
back a partial copy, replace tags, update aliases, or deploy.

Require both remote digests to match and retain
`container-recovery-publication-<run-id>-<attempt>` (30 days). This receipt
cannot be used for Docker Hub promotion, which requires an ordinary successful
producer.

## Proof boundaries

Native startup checks qualify the newly built bytes; source CI alone does not.
They do not prove a live GHCR transfer, cluster deployment, provider behavior,
or staging readiness. See the [registry proof](../testing/docker.md#container-publication-registry-proof)
and [staging qualification](staging-qualification.md).
