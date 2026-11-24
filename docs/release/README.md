# Release OpenClaw Enterprise

Use **Release OCE** to qualify and publish the controller image, runtime image,
Helm chart, and OpenClaw Control Plane (OCC) CLI from one reviewed commit.
Start with a rehearsal.

<a id="overview"></a>

## Rehearse a release

1. Set the root `package.json` version and Helm chart `version` and `appVersion` to the
   same numeric `major.minor.patch` version. Merge the change to protected `main`.
2. Record the full commit SHA and the GitHub Actions run ID for its successful
   **CI** push run on `main`. The entire run, including **CI Required**, must succeed.
   Check [release configuration](configuration.md), the [GHCR package setup](containers.md#bootstrap-ghcr-packages),
   and the [integration approval environment](../testing/ci/configuration.md#environments).
3. In **Actions → Release OCE → Run workflow**, select `main`. Set `source_sha`
   to the reviewed commit and `ci_run_id` to the CI run ID. The selected
   workflow commit must match `source_sha`. Leave `publish` unchecked.
4. To move a custom image tag such as `candidate` at publication, set
   `image_tag`. A blank value selects `latest`. A custom tag leaves `latest`
   unchanged. The [image tag rules](containers.md#prepare-and-publish) reserve
   source, bootstrap, and version tags.
5. Check the version, commit, and alias in the run summary. As the dispatcher,
   approve the run through `integration-main-approval`. Wait for **Full
   Integration Aggregate** for `lane=all`, native image checks on Linux AMD64
   and ARM64, CLI verification, and chart preparation.

A successful rehearsal checks the release destinations and leaves the prepared
artifacts and `qualified-release-<run-id>-1` record in GitHub Actions. It
creates no registry tags or GitHub Release. A later push to `main` cannot change
the commit in a running release.

## Publish and verify

Start a fresh **Release OCE** dispatch with the reviewed inputs, select
`publish`, and approve the new run. It qualifies its own artifacts. Check
the following results before announcing the release.

| Output                 | What to verify                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller and runtime | Both GHCR packages have the verified multi-platform digest at `sha-<source_sha>` and `<version>`.                                                                                           |
| Helm chart             | The published chart version and appVersion match the release. Its controller and runtime digest references match the images. See [Pull and install](chart-publication.md#pull-and-install). |
| OCC CLI                | The public GitHub Release at `v<version>` identifies the source commit and provides four macOS/Linux binaries and `SHA256SUMS`. See [CLI setup](../guides/cli.md).                          |
| Selected image alias   | Both images have the selected alias at their verified digests. The workflow moves the alias after it verifies the chart and CLI.                                                            |

## Recover a partial release

If publication stops, inspect the run summary, the GitHub Release or draft,
and each registry digest. Record which assets are already public. Writes to GitHub and GHCR are separate. Even a
failure between the two alias updates can leave different versions active.
Use digest references while recovering.

Keep the original failed or cancelled run at attempt 1. The image and chart
artifacts expire after seven days. Start a new **Release OCE** run on
protected `main`. Enter the original
`source_sha`, `ci_run_id`, and `image_tag`, select `publish`, and set
`recovery_run_id` to the original publication run ID. Complete the new
approval. Recovery checks the original run, attempt, qualification, and
prepared bytes before it completes missing steps. The original commit must
still be on `main`. Expired evidence, conflicting bytes, or a newer alias
stops recovery. Preserve the original run and refer the conflict to a release
maintainer.

## Standalone publication

**Enterprise Containers** and **Release OCC CLI** also support independent
publication. Their release gates apply only to the outputs they own. Before the
first versioned rollout, maintainers must decide whether to require the combined
workflow or verified recovery for versioned releases and reserve `latest` for
complete releases. Coordinate writers until that decision takes effect.

## Release guides

| Guide                                          | Purpose                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| [Configuration](configuration.md)              | Set environment policies, registry destinations, credentials, and native runners. |
| [Containers](containers.md)                    | Bootstrap packages, publish images, and recover partial publication.              |
| [Helm chart](chart-publication.md)             | Publish a versioned chart with matching image tags and install it.                |
| [OCC CLI](cli-publication.md)                  | Publish versioned macOS and Linux binaries.                                       |
| [Docker Hub promotion](container-promotion.md) | Copy verified GHCR image digests to private Docker Hub repositories.              |

[Staging release qualification](staging-qualification.md) checks
published container startup on amd64. It does not install or promote a release,
prove staging readiness, or replace CI coverage.

## Implementation flows

- [Release OCE](../flows/release-oce.md)
- [Container publication](../flows/container-publication.md)
- [Package bootstrap](../flows/container-package-bootstrap.md)
- [CLI publication](../flows/cli-publication.md)
