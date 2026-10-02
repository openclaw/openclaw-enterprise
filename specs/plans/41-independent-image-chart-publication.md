# Independent image and chart publication

**Date:** 2026-09-29  
**Status:** Implementing  
**Owner:** Enterprise release tooling

## Problem and Decision

Publish images independently by default. Make chart publication an explicit
option in a separate job, using the existing image receipt and chart publisher.

In [run 36597039249](https://github.com/openclaw/openclaw-enterprise/actions/runs/36597039249),
both images were published before chart metadata returned 404. The combined
publication job reported failure after successful image publication. The
production installation guide and upgrade script use the checked-in chart;
no automated consumer of the published chart was found in this repository.
The [published chart guide](../../.github/chart-publication.md) documents manual use.

## Scope

- Default to image-only publication and make charts opt-in.
- Separate image and chart job outcomes without changing release validation.
- Update operator instructions and the existing publication flow.

Dedicated chart recovery, extra preflight orchestration, upstream pin automation,
package creation, deployment, and Docker Hub promotion changes are deferred.
Chart recovery can be reconsidered when a concrete consumer needs it.

## Contract

Add `publish_chart`, a boolean defaulting to `false`, to
[Enterprise Containers](../../.github/workflows/container-publish.yml).

| Inputs                                | Result                                                                |
| ------------------------------------- | --------------------------------------------------------------------- |
| `publish=false`, either chart setting | Prepare images without publishing images or chart.                    |
| `publish=true`, `publish_chart=false` | Publish verified images and the requested alias; no chart work.       |
| `publish=true`, `publish_chart=true`  | Publish images, then publish the chart and matching OCE version tags. |

The existing image job verifies both remote image digests and uploads
`container-publication-{run}-{attempt}` before completing successfully. It needs
no chart package access. Native image builds and smoke tests remain unchanged.

A separate chart job depends on successful image publication and consumes that
exact run/attempt's receipt. It installs Helm and invokes the existing
[chart publisher](../../scripts/ci/chart-release.mjs). The publisher continues to
validate source, CI, environment, package access, receipt identity, version tags,
and published chart contents. Image-only releases do not create OCE version tags;
chart releases retain the existing shared-version policy.

Both publication jobs use the protected `container-publish` environment. The
workflow holds `enterprise-container-publish` concurrency with cancellation
disabled through preparation and both publications; jobs do not reacquire it.
Queued runs can be superseded before starting, but an active release cannot lose
a pending chart job to another run. Preparation-only runs use independent groups.
Existing version conflicts remain errors; differing content is never overwritten.

The run summary reports whether each publication was requested and its job
result. The publishers retain their existing digest summaries and receipts.
A chart failure leaves the successful image job intact, but fails the overall
combined run. A failed image job prevents chart publication. An image-only run
can succeed without the chart package existing.

Chart retries use a new full dispatch for the same source and its successful CI.
Existing publisher checks verify and reuse matching content. Rerunning only a
failed chart job is unsupported because the new attempt has no matching image
receipt. A new source requires a new OCE version when publishing a chart.
Existing image recovery remains unchanged.

## Implementation

1. Add the default-false input and split
   [container-publish.yml](../../.github/workflows/container-publish.yml) at the
   existing image receipt upload. Keep the image job ID and release scripts.
2. Give the chart job its exact receipt download, existing publication tooling,
   protected environment, and workflow-level publication lock. Add a final job that
   reports both publication results even when a dependency fails.
3. Update [image publication](../../.github/containers.md),
   [chart publication](../../.github/chart-publication.md),
   [production installation](../../docs/guides/deploy/production-installation.md), and
   the [publication flow](../../docs/flows/container-publication.md). Keep local-chart
   installation as the documented default.

## Verification

| Required outcome                                                    | Proof                                                                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Workflow inputs, conditions, permissions and dependencies are valid | Run `actionlint` and inspect all three input combinations against the job graph.                |
| Release validation and chart receipt binding remain intact          | Run container-release and container-publication-workflow tests; report missing tools and skips. |
| Image-only releases need no chart package                           | Hosted image-only dispatch succeeds without chart access or chart publication.                  |
| Chart failure preserves image success                               | Hosted opt-in run reports chart failure separately while retaining verified image receipts.     |
| Optional chart uses the same release                                | Hosted opt-in success has chart annotations and version tags matching the image receipt.        |

Hosted checks require reviewed main workflow code and authorized publishing
resources. Workflow contract tests parse the real YAML and execute its summary shell step.
They do not simulate GitHub scheduling or prove hosted execution or GHCR writes. Record those gaps rather than claim live publication.
Run documentation formatting, link and length checks for the accompanying docs.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-29 10:10: Narrow to default image-only publication and an opt-in chart job; defer chart recovery and extra preflight orchestration. (01a0eda8-1144-78e3-a1f7-82e8562e5125 - 2d251975fba5b05bd83e96f95ee89c2c67635d50)

- 2026-09-29 09:56: Proposed independent image/chart publication and chart recovery. (01a0eda8-1144-78e3-a1f7-82e8562e5125 - 2d251975fba5b05bd83e96f95ee89c2c67635d50)
