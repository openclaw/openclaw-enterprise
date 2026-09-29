# Publish the OCE Helm chart

The protected [Enterprise Containers workflow](workflows/container-publish.yml)
optionally publishes the OpenClaw Control Plane (OCC) chart to private GHCR at
`oci://ghcr.io/openclaw/charts/openclaw-enterprise`. It also gives the controller
and runtime images a tag matching the chart. The existing `sha-<source-sha>` tags
remain available. Deploy with the digest references recorded in the chart and
publication receipt.

## Choose one release version

Advance the SemVer version in root `package.json` and set both `version` and
`appVersion` in `deploy/helm/openclaw-enterprise/Chart.yaml` to the same value.
Do this for each chart release, including releases with image changes.
Image-only publication does not require a new chart version. OCE is evolving quickly;
one version gives operators a chart and image pair tested from one source revision
without an independent chart compatibility matrix. The shared tag identifies the
release, while the recorded digests identify the exact bytes.

Review and merge the version change to `main`. Wait for that exact main-push CI
run to pass, including `CI Required`. Follow [private package setup](containers.md#operator-setup)
and [bootstrap](containers.md#bootstrap-private-packages) once. Bootstrap creates
a nondeployable chart marker as well as image markers; confirm all three packages
are private and grant this repository Actions access. Then dispatch **Enterprise
Containers** on `main` with its full `source_sha`, matching `ci_run_id`, and
`publish: true` and `publish_chart: true` (the latter defaults to false).

The image job publishes and verifies images first. A separate chart job consumes
that run/attempt's image receipt, checks version tags against its digests, then
packages and pushes the chart. Both jobs use the protected publication environment.
The workflow holds the shared publication lock across both jobs, including
preparation, so overlapping runs cannot replace a pending chart job. The chart job rejects an existing version whose
packaged files differ. Its `chart-publication-<run-id>-<attempt>` artifact
records the chart manifest digest, source SHA, and both image digests. The older
`container-publication` receipt retains its image-only format. If a step fails,
inspect registry digests before starting a new full dispatch for the same source;
existing tags with different bytes are never replaced. Rerunning only a failed
chart job is unsupported: its new attempt has no matching image receipt. There
is no dedicated chart recovery workflow. A later source revision requires a new
OCE version for chart publication.

A chart failure fails the combined run, while the image job and its verified
images remain successful. Use the separate job results and final run summary to
distinguish these outcomes. Image-only publication never calls the chart publisher.

Treat release version tags as single-writer state. Limit package-write access for
the chart and both images to this repository's reviewed publication workflows
and trusted package administrators; do not retag them during publication. The
workflow concurrency group serializes participating jobs only. The receipt
records the chart's immutable manifest digest after verification, but an
independent writer changing the version tag between the pull and digest lookup
would break that binding. Coordinated external writers need a registry-supported
conditional write or an equivalent shared lock before using this flow.

## Pull and install

Authenticate a workstation with a GitHub personal access token (classic) with
`read:packages`; enter the token at the password prompt, not on the command line.
Authorize organization SSO if required. Select the version from the completed
publication receipt:

```bash
helm registry login ghcr.io --username '<your-github-username>'
export OCE_VERSION='<published-version>'
helm show chart oci://ghcr.io/openclaw/charts/openclaw-enterprise \
  --version "$OCE_VERSION"
helm show values oci://ghcr.io/openclaw/charts/openclaw-enterprise \
  --version "$OCE_VERSION"
```

Check the chart's `openclaw.dev/source-revision`, `openclaw.dev/controller-image`,
and `openclaw.dev/runtime-image` annotations against the receipt. Set
`images.controller` in your protected Helm values to the controller digest and
set the Installation's `drivers.compute.configuration.images.gateway` and
`agent` to the runtime digest. The packaged controller default is pinned, but
operator values take precedence. The production example values contain a
placeholder image, so replace it before installation.

Prepare the other operator-owned values, database, Secrets, routing, and
bootstrap volume as described in the [production installation guide](../docs/guides/deploy/production-installation.md).
Cluster nodes need their own pull credentials for both private image packages;
workstation Helm login does not provide those credentials. Install the selected
chart version after the prerequisites are ready:

```bash
helm upgrade --install oce oci://ghcr.io/openclaw/charts/openclaw-enterprise \
  --version "$OCE_VERSION" --namespace openclaw-system \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  -f "$OCC_INPUT_DIRECTORY/values.yaml" --wait --timeout 5m
```

This release packages the chart and images. It does not distribute the
repository's bootstrap helper or Installation examples, and does not complete a
fresh k3d trial without a checkout. Public GHCR access is a later change.
