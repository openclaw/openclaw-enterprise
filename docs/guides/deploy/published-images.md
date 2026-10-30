# Use published controller and runtime images

Select the controller and runtime with matching `stable` or `latest` tags, then use the source
checkout and chart that match those images. This procedure works for
[local setup](../quickstart.md#optional-use-matching-published-images) and
[production installation](production-installation.md#use-published-images).
Run it before generating Installation configuration.

You need Bash, Docker, Git, jq, and an existing repository checkout. The published
GHCR packages are public. The deployment tools use immutable image references
internally; the commands below resolve the selected tags so you do not need to
find or copy a SHA manually.

<a id="pull-the-latest-pair"></a>

## Pull a matching pair

From a Bash shell in the repository root, select and pull both images
anonymously. Set `export OCE_IMAGE_CHANNEL=stable` for the stable publication. The
default selects `latest`. Run the
whole block; it clears earlier selections and exports them only after both pulls
and source commit checks succeed:

```bash
unset CONTROLLER_IMAGE RUNTIME_IMAGE OCE_IMAGE_REVISION
CHANNEL="${OCE_IMAGE_CHANNEL:-latest}"
CONTROLLER_TAG="ghcr.io/openclaw/openclaw-enterprise-controller:$CHANNEL"
RUNTIME_TAG="ghcr.io/openclaw/openclaw-enterprise-runtime:$CHANNEL"
if docker pull "$CONTROLLER_TAG" && docker pull "$RUNTIME_TAG" &&
   controller_image="$(docker image inspect "$CONTROLLER_TAG" --format '{{json .RepoDigests}}' |
     jq -er --arg repo "${CONTROLLER_TAG%:*}@" 'map(select(startswith($repo))) | unique | select(length == 1) | first')" &&
   runtime_image="$(docker image inspect "$RUNTIME_TAG" --format '{{json .RepoDigests}}' |
     jq -er --arg repo "${RUNTIME_TAG%:*}@" 'map(select(startswith($repo))) | unique | select(length == 1) | first')" &&
   controller_revision="$(docker image inspect "$controller_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" &&
   runtime_revision="$(docker image inspect "$runtime_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" &&
   [[ "$controller_image" =~ @sha256:[a-f0-9]{64}$ ]] &&
   [[ "$runtime_image" =~ @sha256:[a-f0-9]{64}$ ]] &&
   [[ "$controller_revision" =~ ^[a-f0-9]{40}$ ]] &&
   [[ "$controller_revision" = "$runtime_revision" ]]; then
  export CONTROLLER_IMAGE="$controller_image"
  export RUNTIME_IMAGE="$runtime_image"
  export OCE_IMAGE_REVISION="$controller_revision"
  printf 'Source: %s\nController: %s\nRuntime: %s\n' \
    "$OCE_IMAGE_REVISION" "$CONTROLLER_IMAGE" "$RUNTIME_IMAGE"
else
  printf '%s\n' 'Image selection failed or revisions differ; stop before installation.' >&2
  false
fi
```

Stop if selection fails. If an anonymous pull fails with `unauthorized` or
`denied`, the packages have not been published publicly yet:
[build images from your checkout](production-installation.md#build-and-publish-production-images)
instead, or [start the local stack](../quickstart.md#start-the-local-stack)
without image selections, which builds this checkout. The two aliases are not
updated atomically; retry both pulls after publication completes if they refer
to different source commits.
Each alias identifies the last publication to that channel. The two channels can point to different commits.

## Check publication and source

Open the [Enterprise Containers runs](https://github.com/openclaw/openclaw-enterprise/actions/workflows/container-publish.yml)
and find the successful publication for the printed source commit. Compare
both resolved image references with its publication summary or receipt. Matching
labels establish consistency; the publication record establishes which bytes
passed the image checks. If the record is missing or either reference differs,
stop and ask the publisher to identify the approved pair.

Compare the source commit with your checkout:

```bash
git rev-parse HEAD
printf '%s\n' "${OCE_IMAGE_REVISION:?Select the published images first}"
```

If they differ, keep the existing checkout. In the Codex app, use the managed
worktree action to create or select a release checkout at the exact commit in
`OCE_IMAGE_REVISION`. If the app requests worktree permission, wait for the
operator to approve that request before continuing. In the shell that holds the
image selections, change to the path supplied by the app.

For a shell-managed worktree, choose a new path and run:

```bash
OCE_RELEASE_CHECKOUT="../oce-release-${OCE_IMAGE_REVISION:?}"
git fetch origin "$OCE_IMAGE_REVISION" &&
  git worktree add --detach "$OCE_RELEASE_CHECKOUT" "$OCE_IMAGE_REVISION" &&
  cd "$OCE_RELEASE_CHECKOUT"
```

For either route, confirm the checkout matches before installing:

```bash
test "$(git rev-parse HEAD)" = "${OCE_IMAGE_REVISION:?}"
```

Continue in this shell so the image selections remain exported. Use the chart,
CLI, configuration renderer, and installation instructions from this matching
checkout. If you need a feature introduced after the published commit,
[build images from that newer checkout](production-installation.md#build-and-publish-production-images)
instead of combining its configuration with images from a different revision.

For production, public GHCR pulls need no pull Secret. See
[private-registry delivery](private-registry-images.md) only when copying images
to a private mirror. For local setup, export the resolved pair as
[development image selections](../quickstart.md#optional-use-matching-published-images).

## Verify after installation

The publication's startup checks do not establish a working Agent on your
cluster. Finish [local first-Agent verification](../first-agent.md) or
[production Agent verification](production-agents.md#verify-production-workloads).
Keep the resolved image references with your deployment record so a later move
of the selected alias does not change which images were selected for this installation.
