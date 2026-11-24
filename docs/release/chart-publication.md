# Publish the OCE Helm chart

Publish a versioned OpenClaw Control Plane (OCC) Helm chart and matching image
tags through **Enterprise Containers**. Complete [release configuration](configuration.md)
once. The receipt records the immutable chart and image digests.

## Choose one release version

Set root `package.json` and both `version` and `appVersion` in
`deploy/helm/openclaw-enterprise/Chart.yaml` to the same SemVer version.
Advance it for every chart release, including image changes. Image-only
publication does not require a new chart version. Merge the reviewed change to
`main` and wait for its exact push CI to succeed.

## Publish

1. [Choose and merge the release version](#choose-one-release-version), then
   [select the source and CI run](containers.md#prepare-and-publish).
2. Dispatch [Enterprise Containers](../../.github/workflows/container-publish.yml)
   on `main` with `source_sha`, `ci_run_id`, `publish: true`, and
   `publish_chart: true`. Choose `image_tag` deliberately: blank updates
   `latest` for both images.
3. Require successful image and chart jobs. Retain
   `chart-publication-<run-id>-<attempt>`, which records the chart manifest
   digest, source SHA, and both image digests. The image receipt remains separate.

If the chart job fails, the verified images can remain published. Inspect the
registry digests and retry the **full dispatch** for the same source while it
is still the selected `main` commit. If `main` moved, review the new source and
advance the version. A chart-only
job rerun has no matching image receipt for its new attempt. There is no separate
chart recovery workflow. Matching existing content is accepted; different bytes
at a source or version tag are refused. Never delete or retag a conflict.
A later source commit needs a new version. Restrict package writes to reviewed
workflows and trusted administrators; workflow concurrency does not lock out
external writers. An independent writer can change a version tag between the
chart pull and digest lookup. Use a registry-supported conditional write or an
equivalent shared lock if external writers must participate.

## Pull and install

Use the version and digest from the receipt:

```bash
export OCE_VERSION='<published-version>'
helm pull oci://ghcr.io/openclaw/charts/openclaw-enterprise \
  --version "$OCE_VERSION" --destination "${OCC_INPUT_DIRECTORY:?select a protected directory}"
chart="$OCC_INPUT_DIRECTORY/openclaw-enterprise-$OCE_VERSION.tgz"
helm show chart "$chart"
helm show values "$chart"
```

Compare the pull digest and the chart's `openclaw.dev/source-revision`,
`openclaw.dev/controller-image`, and `openclaw.dev/runtime-image` annotations
with the receipt. Set `images.controller` in protected Helm values to the
controller digest and the Installation's
`drivers.compute.configuration.images.gateway` and `agent` to the runtime
digest. Replace the production example's placeholder image. Public GHCR pulls
need no login; private mirrors need operator-configured pull credentials.

Prepare database, Secrets, routing, values, and bootstrap credentials using
[production installation](../guides/deploy/production-installation.md). Use the
matching CLI and reviewed archive for [first install and handoff](../guides/deploy/production-handoff.md#record-the-initialization-job-for-handoff):

```bash
INSTALL_RECEIPT_DIRECTORY="$OCC_INPUT_DIRECTORY/install-receipt"
occ installation install --release oce --chart "$chart" \
  --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" --kube-namespace openclaw-system \
  --values "$OCC_INPUT_DIRECTORY/values.yaml" --receipt "$INSTALL_RECEIPT_DIRECTORY"
```

If an install response is lost or Helm refuses the release name, stop and
[resume the original installation](../guides/deploy/production-handoff.md#resume-an-installation-in-progress);
do not rerun or switch to an upgrade. The chart does not distribute repository
bootstrap helpers or Installation examples.
