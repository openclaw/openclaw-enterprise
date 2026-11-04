# Observability Demo

## Overview

Use Demo Observability Smoke to check the disposable monitoring chart and the
Grafana views backed by fixture metrics and OpenTelemetry Protocol (OTLP) logs.
The lane installs a real Kubernetes monitoring stack; its telemetry is test data.

## When it runs

The workflow runs on pull requests and `main` pushes that match its path filters,
plus merge groups and manual dispatch. Filters cover the demo chart, its tests
and helpers, CI scripts/actions, and the lockfile; the workflow is the exact list.
It is separate from `CI Required` and is not a merge or publication gate.
Full Integration also selects this lane when `all` is requested.

## Scenarios

| Setup and action                                                                         | Expected outcome                                                                                                  | Test source                                                                    |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Render the chart with supported release names and values that resemble YAML scalars.     | Service names, identifiers, and Grafana URLs remain valid and aligned.                                            | [Chart tests](../../../tests/integration/observability-demo-chart.test.mjs).   |
| Configure disposable Grafana storage and repeat installation after a cold-cache timeout. | SQLite stays off node disk and the documented installation can be rerun.                                          | [Chart tests](../../../tests/integration/observability-demo-chart.test.mjs).   |
| Install the demo in k3d and send fixture telemetry.                                      | Grafana's Prometheus connection returns fixture metrics; dashboards exist and log queries return expected events. | [Kubernetes test](../../../tests/integration/observability-demo-k3d.test.mjs). |
| Open the dashboard in Chromium, inspect log details, and apply a worker filter.          | Navigation and displayed log records match the expected queries; screenshots record the rendered views.           | [Kubernetes test](../../../tests/integration/observability-demo-k3d.test.mjs). |

## Run it

For a hosted run, dispatch from the Actions page or the repository root:

```sh
gh workflow run observability-demo.yml --ref main
```

For local reproduction, follow the
[Kubernetes observability prerequisites](../local.md#kubernetes-observability-acceptance)
and use the shared [lane preparation and cleanup](run-lanes.md#results-and-cleanup)
with `k3d-observability-demo`. The manifest requires a disposable context and
explicit monitoring images. Keep other clusters and the default kubeconfig intact.

## Results and limits

Check **Demo Observability Smoke**, its `demo-results` lane artifacts, and
`demo-log-dashboard`. The dashboard upload retains PNGs and failure diagnostics
for seven days. A successful lane with missing dashboard artifacts fails upload;
setup failures do not create a second missing-artifact error.

This proves the demo's fixture ingestion and browser views, not production
telemetry from a deployed Agent fleet. Inspect the images as well as the job
conclusion when investigating rendering failures. Clean up run-owned resources
through the lane procedure after local failures.

## Files

- [Workflow](../../../.github/workflows/observability-demo.yml): exact triggers and artifact policy.
- [Manifest](../../../scripts/ci/test-suites/k3d-observability-demo.json): files, cases, images, and context requirements.
- [Chart tests](../../../tests/integration/observability-demo-chart.test.mjs) and [Kubernetes test](../../../tests/integration/observability-demo-k3d.test.mjs): scenario assertions.
- [Demo helper](../../../tests/helpers/observability-demo-k3d.mjs): fixture stack and telemetry.
- [Demo Helm chart](../../../deploy/helm/openclaw-observability-demo): installed monitoring components.
