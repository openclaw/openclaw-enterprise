---
kind: reference/ci
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Full Integration

## Overview

Run selected integration lanes against their required databases, containers,
clusters, and provider services. The workflow collects the selected results in
`Full Integration Aggregate`; it is separate from the pull-request merge gate.

<a id="when-it-runs"></a>

## Trigger

Verified documentation-only main pushes select no runtime lanes. Other pushes
to `main` select `all`. Missing history or uncertain impact retains full execution. Manual dispatch selects one supported `lane` or
`all` on `main` and requires the dispatcher's [team approval](configuration.md#environments).
A scheduled advisory run does not run the Full Integration workflow.

## Scenarios

For main pushes, `pr-safe-same-sha` can reuse successful [CI suite](required-checks.md#scenarios)
results at the same commit. Manual dispatch runs fresh. Runtime Image Fixture,
image lanes, Repository Credentials, and [Demo Observability Smoke](observability-demo.md)
always run fresh. Dispatch Preflight checks policy; Full Integration Aggregate
requires selected results. QA waits for Slack to finish, including after Slack failure.
Some lanes are also selected by [CI](required-checks.md) or
[QA Advisory](qa-advisory.md); those pages own automatic selection rules.

| Tests                                                                                                   | What is verified                                                                                                                                                                       | GitHub jobs and manifests                                                                                                                      |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker and Kubernetes model execution                                                                   | [Docker deployment refusals](../docker.md) and [Kubernetes model calls, Pod replacement, Secret rotation, and first-Agent reuse](../kubernetes.md#kubernetes-model-turns-and-secrets). | [Docker Model Runtime](../../../scripts/ci/test-suites/docker-model.json), [k3d Model Runtime](../../../scripts/ci/test-suites/k3d-model.json) |
| [Private gateway routing](../kubernetes.md#private-gateway-routing)                                     | Workspace files and native administration requests pass through Envoy and OCC while preserving Agent access boundaries.                                                                | [Gateway Routing](../../../scripts/ci/test-suites/gateway-routing.json)                                                                        |
| [Terminal chat across deployment changes](../kubernetes.md#production-tui-tests)                        | Interactive terminal chat continues across an Agent revision change in a Helm installation.                                                                                            | [Production TUI](../../../scripts/ci/test-suites/production-tui.json)                                                                          |
| [Slack access](../slack.md)                                                                             | Slack isolation, issued credentials, and model calls.                                                                                                                                  | [Slack Live](../../../scripts/ci/test-suites/slack.json)                                                                                       |
| [OpenShell Agent deployment and sandbox policies](../openshell.md)                                      | Sandbox enforcement and first-Agent setup.                                                                                                                                             | [OpenShell](../../../scripts/ci/test-suites/openshell.json)                                                                                    |
| [Local Kubernetes installation and recovery](../kubernetes.md#local-kubernetes-installation)            | Installation, recovery, and Keycloak sign-in.                                                                                                                                          | [Local Kubernetes Installation](../../../scripts/ci/test-suites/dev-up-k3d.json)                                                               |
| [Private Git access and credential withdrawal](../repository-credentials.md#verify-prepared-native-git) | An installed Agent can use private Git; withdrawing its credentials interrupts an authenticated fetch while chat remains available. Uses synthetic model and Git credentials.          | [Installed Skipper private Git and live withdrawal](../../../scripts/ci/test-suites/skipper-prepared-git-installed.json)                       |
| [Log forwarding and recovery](../local.md#metrics-and-observability-tests)                              | The collector forwards logs and recovers after exporter failures.                                                                                                                      | [Logging Collector](../../../scripts/ci/test-suites/logging-collector.json)                                                                    |
| [Logs from live model calls](../local.md#kubernetes-observability-acceptance)                           | Embedded and dedicated runtimes emit OpenTelemetry logs during real model calls.                                                                                                       | [k3d OTEL](../../../scripts/ci/test-suites/k3d-otel.json)                                                                                      |
| [Worker startup deadline](../../../tests/integration/dev-up-timeout.test.mjs)                           | Local Setup waits the full 300-second deadline before failing a worker that is running but not ready.                                                                                  | [Helper Timeout](../../../scripts/ci/test-suites/helper-timeout.json)                                                                          |
| [Agent workflows across installations](qa-advisory.md#scenarios)                                        | Selected installation, preset, and scenario combinations.                                                                                                                              | [Shipped Installation QA Matrix](../../../scripts/ci/test-suites/qa-matrix.json)                                                               |

Job links use the exact names shown in GitHub Actions and open their manifests.

`all` selects the workflow's supported lanes, not every lane registered in the
repository. [Manually prepared lanes](../manual-tests.md)
remain excluded. QA's default `all` also excludes its four
[explicit scenario selectors](qa-advisory.md#select-scenarios).

In the hosted QA matrix, the CI account can select only built-in Codex
permission profiles. Both Compose and Kubernetes run OpenClaw model/UI checks
and Console Secrets for both presets. The matrix excludes Codex Git write,
denied Git push, and Slack because each starts a native
Codex turn with a custom permission profile. The test log and `matrix.json`
list the exclusions. The separate Slack Live lane still runs. A local QA run
with an account that supports custom profiles can select all three scenarios.

<a id="run-it"></a>

## Execution

### Run a protected integration lane

Configure [integration environments](configuration.md#environments), inspect the
intended `main` commit, then dispatch one lane, for example Gateway Routing:

```sh
gh workflow run full-integration.yml --ref main -f lane=gateway-routing
```

Confirm the run's `headSha` matches the inspected commit, then complete the
[dispatcher's team approval](configuration.md#environments). Use `lane=all` only
when you need every supported Full Integration lane.

Manual dispatch uses a separate workflow queue, so this focused run can proceed
while an automatic full run is active.

### Run the hosted local installation lane

```sh
gh workflow run full-integration.yml --ref main -f lane=dev-up-k3d
```

Check `headSha` and `full-results-dev-up-k3d`; every case must pass without skips.
The 180-minute job budget includes setup/cleanup. Manual runs require the same
team approval as credentialed lanes. Start a new approved dispatch to retry a manual run.
Jobs triggered by a main push can retry at the original commit.

## Results and limits

Check `Full Integration Aggregate`, the selected job conclusions, and their
`full-results` artifacts for the dispatch commit. Apply the shared
[result and cleanup requirements](run-lanes.md#results-and-cleanup) to each selected lane.

The OpenShell lane runs its manifest serially. QA Advisory instead uses
[parallel per-file runners](qa-advisory.md#openshell-file-coverage).
Use the [shared cleanup procedure](run-lanes.md#results-and-cleanup) for local runs.

The reuse job polls ordinary CI every 30 seconds for at most 12 minutes. Other
Full Integration lanes continue without waiting for it. Reuse requires a successful
canonical `main` push run, its current attempt's successful lane and static-check
jobs, and immutable result artifacts with matching source commit and full coverage.
Preparation profiles and Node versions must match. The existing result validator
checks required cases and cleanup before results are published as `full-results-reused`.
Missing, expired, incomplete, or unavailable evidence runs fresh instead. A failed
artifact download or publication also runs fresh. The job log identifies the CI
producer run and attempt; Full Integration Aggregate validates reused and fresh
results together.

## Files

- [Full Integration workflow](../../../.github/workflows/full-integration.yml): selectable lanes, dependencies, and aggregate.
- [Dispatch preflight](../../../scripts/ci/full-integration-preflight.mjs): lane and environment policy.
- [CI result reuse](../../../scripts/ci/full-integration-reuse.mjs): producer admission, result validation, and fresh-lane fallback.
- [Suite index](../../../scripts/ci/test-suites.json): group membership; exact manifests are linked in Scenarios.
- [Test runner](../../../scripts/ci/run-tests.mjs): expected-case and result checks.
- [Lane action](../../../.github/actions/run-ci-lane/action.yml): preparation and cleanup.
