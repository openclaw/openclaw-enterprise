# Full Integration

## Overview

Run selected integration lanes against their required databases, containers,
clusters, and provider services. The workflow collects the selected results in
`Full Integration Aggregate`; it is separate from the pull-request merge gate.

## When it runs

Manual dispatch only. Select one supported `lane` or `all`.
A scheduled advisory run does not run the Full Integration workflow.

## Scenarios

`pr-safe-same-sha` and Runtime Image Fixture repeat the [CI suites](required-checks.md#scenarios) at the
dispatch commit when `all` is selected; its matrix also adds [Demo Observability Smoke](observability-demo.md). Dispatch Preflight checks policy; Full Integration Aggregate requires
selected results. QA waits for Slack to finish, including after Slack failure.
Some lanes are also selected by [CI](required-checks.md) or
[QA Advisory](qa-advisory.md); those pages own automatic selection rules.

| Jobs                                              | What they test / suite guide                                                                                                                                                                             | Exact manifests                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Docker Model Runtime; k3d Model Runtime           | [Docker](../docker.md) deploy refusal; [Kubernetes](../kubernetes.md#kubernetes-model-turns-and-secrets) real models, Pod replacement, Secret rotation and first-Agent reuse                             | [Docker](../../../scripts/ci/test-suites/docker-model.json), [k3d](../../../scripts/ci/test-suites/k3d-model.json)          |
| Gateway Routing; Production TUI                   | [Envoy/OCC routing](../kubernetes.md#private-gateway-routing), [Helm/TUI version cutover](../kubernetes.md#production-tui-tests)                                                                         | [Routing](../../../scripts/ci/test-suites/gateway-routing.json), [TUI](../../../scripts/ci/test-suites/production-tui.json) |
| Slack Live; Provider Account                      | [Live Slack isolation, issued credentials and model turns](../slack.md)                                                                                                                                  | [Slack](../../../scripts/ci/test-suites/slack.json), [Account](../../../scripts/ci/test-suites/provider-account.json)       |
| OpenShell                                         | [Sandbox enforcement and first-Agent flows](../openshell.md)                                                                                                                                             | [OpenShell](../../../scripts/ci/test-suites/openshell.json)                                                                 |
| Local Kubernetes Installation                     | [Installation/recovery, including Keycloak](../kubernetes.md#local-kubernetes-installation)                                                                                                              | [Installation](../../../scripts/ci/test-suites/dev-up-k3d.json)                                                             |
| Installed Skipper private Git and live withdrawal | [Prepared native private Git, withdrawal during an authenticated fetch, and continued chat](../repository-credentials.md#verify-prepared-native-git); uses synthetic job-local model and Git credentials | [Installed Skipper](../../../scripts/ci/test-suites/skipper-prepared-git-installed.json)                                    |
| Logging Collector                                 | [Collector forwarding and recovery](../local.md#metrics-and-observability-tests)                                                                                                                         | [Collector](../../../scripts/ci/test-suites/logging-collector.json)                                                         |
| k3d OTEL; Helper Timeout                          | [Real runtime OTLP logs](../local.md#kubernetes-observability-acceptance); 300-second worker readiness deadline                                                                                          | [OTEL](../../../scripts/ci/test-suites/k3d-otel.json), [Timeout](../../../scripts/ci/test-suites/helper-timeout.json)       |
| Shipped Installation QA Matrix                    | [Selected installation/preset/scenario combinations](qa-advisory.md#scenarios)                                                                                                                           | [QA](../../../scripts/ci/test-suites/qa-matrix.json)                                                                        |

`all` selects the workflow's supported lanes, not every lane registered in the
repository. [Manually prepared lanes](run-lanes.md#manually-selected-lanes-without-github-workflows)
remain excluded. QA's default `all` also excludes its four
[explicit scenario selectors](qa-advisory.md#select-scenarios).

## Run it

### Run a protected integration lane

Configure [integration environments](configuration.md#environments), inspect the
commit, then dispatch the selected lane or `all` on `main`:

```sh
gh workflow run full-integration.yml --ref main -f lane=all
```

Branch exceptions are listed in [environment policy](configuration.md#environments). `qa_repository_fixture` applies to both
`qa-matrix` and `all`; QA and focused Slack share a serial execution path.

### Run the hosted local installation lane

```sh
gh workflow run full-integration.yml --ref '<reviewed-branch>' -f lane=dev-up-k3d
```

Check `headSha` and `full-results-dev-up-k3d`; every case must pass without skips.
The 180-minute job budget includes setup/cleanup.

## Results and limits

Check `Full Integration Aggregate`, the selected job conclusions, and their
`full-results` artifacts for the dispatch commit. Apply the shared
[result and cleanup requirements](run-lanes.md#results-and-cleanup) to each selected lane.

The OpenShell lane runs its manifest serially. QA Advisory instead uses
[parallel per-file runners](qa-advisory.md#openshell-file-coverage).
Use the [shared cleanup procedure](run-lanes.md#results-and-cleanup) for local runs.

## Files

- [Full Integration workflow](../../../.github/workflows/full-integration.yml): selectable lanes, dependencies, and aggregate.
- [Dispatch preflight](../../../scripts/ci/full-integration-preflight.mjs): lane and environment policy.
- [Suite index](../../../scripts/ci/test-suites.json): group membership; exact manifests are linked in Scenarios.
- [Test runner](../../../scripts/ci/run-tests.mjs): expected-case and result checks.
- [Lane action](../../../.github/actions/run-ci-lane/action.yml): preparation and cleanup.
