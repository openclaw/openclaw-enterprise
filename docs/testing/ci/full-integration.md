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

Quarter-hour ticks can admit a full run on the current main commit. Automatic
starts are at least 60 minutes apart and at least 15 minutes after the preceding
full run finishes. Stale ticks and revisions with verified full execution select
no lanes. The outer preflight screens ticks before the execution queue. The
reusable workflow rechecks admission in the queue and confirms its admission
receipt before starting the full suite. Missing admission metadata fails visibly.

Manual dispatch selects one supported `lane` or `all` on `main` and requires the
dispatcher's [team approval](configuration.md#environments). The ordinary PR
and merge-group checks still provide targeted premerge feedback. QA Advisory
has its own schedule.

## Scenarios

First-attempt scheduled and manual `all` runs can [reuse qualified CI results](#results-and-limits).
Other selected lanes run fresh. Dispatch Preflight checks environment policy;
Full Integration Aggregate requires selected results.
QA waits for Slack to finish, including after Slack failure.
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

Job links name the execution jobs and open their manifests. GitHub groups these
under `Execute`, including `Execute / Full Integration Aggregate`.

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

Manual dispatch uses a separate execution queue per run, so this focused run can proceed
while an automatic full run is active.

### Run the hosted local installation lane

```sh
gh workflow run full-integration.yml --ref main -f lane=dev-up-k3d
```

Check `headSha` and `full-results-dev-up-k3d`; every case must pass without skips.
The 180-minute job budget includes setup/cleanup. Manual runs require the same
team approval as credentialed lanes. Start a new approved dispatch to retry a manual run.
Retry a scheduled failure through a new approved manual dispatch.

## Results and limits

Check `Execute / Full Integration Aggregate`, the selected job conclusions, and their
`full-results` artifacts for the dispatch commit. Apply the shared
[result and cleanup requirements](run-lanes.md#results-and-cleanup) to each selected lane.

The first attempt of a full run can publish two receipts. The admission receipt,
`full-integration-admitted-v1`, expires after one day. The preflight uploads it
after the run acquires the execution queue and repeats source and environment
validation. It records admission before the lanes run, only when all are selected.

The execution receipt, `full-integration-exercised-v1-<sha>`, expires after
seven days. The aggregate uploads it after complete same-SHA case evidence,
including qualified CI reuse. Each lane must record successful final cleanup
separately from file cleanup. Missing resource state cannot clear a previous cleanup
failure on retry. It can accompany a red aggregate when all cases
complete and case failures come from assertions. Setup errors, missing or skipped
cases, unproved or failed cleanup, cancellation, focused runs, and retries cannot qualify. Use the run,
attempt and tested SHA to bind either receipt. An absent receipt gives no
execution proof. Use the aggregate for the pass or fail result. Later artifact
export or upload failures still fail their job and aggregate; they do not undo
completed execution or cleanup. Missing lane artifacts prevent qualification.

The installed-Skipper lane publishes a sanitized passing receipt only after its
test and owned-resource cleanup succeed. Complete full-scope results retain
empty issue lists and each file's exercised status, exit code, and signal for
coverage validation. Focused or incomplete results carry no full-coverage proof.
Raw test output and diagnostics remain private. Failed native operations report a known operation label and, when available, a bounded exit code or allowlisted signal/error code. These log fields do not prove that the installed journey passed.

If the installed proof fails and the job can continue, look for
`attempt-<attempt>-full-failure-skipper-prepared-git-installed`, retained for seven
days. Its single JSON file records the run, attempt, source SHA, failed outcome,
last recorded stage and installed cleanup status. For `selected-test`, the
receipt also records the allowlisted `testOperation` and `lastTestCheckpoint`,
with `unknown` for missing or unrecognized values. After a failed runner, the
writer uses complete valid ledger rows before the first malformed or non-object
row. It ignores blank rows and selects the last recognized checkpoint for the
selected mode, excluding retirement. A missing or unreadable ledger leaves the
checkpoint `unknown` but preserves a verified operation. Optional failure
evidence cannot replace the selected-test failure; passing proof still requires
strict ledger parsing. A missed stage write can leave an earlier stage
visible. Checkpoints do not establish successful cleanup.

Cleanup `passed` covers registered teardown callbacks, verified cluster and
network removal, released installation ports and model-directory removal. It
excludes the private work directory and the outer Git fixture's teardown. This
failure receipt is separate from success aggregation and cannot qualify images.
Cancellation, runner loss or job timeout can prevent its publication. A passing
proof does not exercise this failure upload.

Checkout image-build failures identify each failed role (controller or runtime), exit code, known error code or signal, killed flag, elapsed time and configured budget. Process fields come only from Docker command failures; journal and pre-dispatch failures leave them `unknown`. Accessor-backed fields also stay `unknown`. A signal or elapsed time alone does not prove a timeout. The [build helper](../../../tests/helpers/dev-up-model-provider.mjs) preserves original errors for local inspection but excludes their command arguments and output from CI summaries.

The `openshell` dispatch runs two OpenShell lanes on separate VMs. Each runs
its assigned files serially, and the aggregate requires both results. QA Advisory uses
[parallel per-file runners](qa-advisory.md#openshell-file-coverage).
Use the [shared cleanup procedure](run-lanes.md#results-and-cleanup) for local runs.

First-attempt scheduled and manual `all` runs can reuse eligible ordinary CI
lanes from a successful push CI run on official `main` at the exact source SHA.
Discovery waits at most 12 minutes. Required producer jobs must pass, and
current-attempt artifacts must contain complete case and cleanup evidence.
Validated results must be published as `full-ci-reused-results` before their lanes
are omitted from fresh execution. Ineligible lanes and unavailable, invalid or
unpublished results fall back to fresh runs. Preflight supplies the full matrix
if the optional reuse job fails or times out before completing its plan; that
failure alone does not fail the workflow. Aggregation reads
retained results only for a successful plan; abandoned uploads cannot replace
fresh evidence. The aggregate applies the same
case and cleanup rules to both sources; reuse is not independent execution.
Hosted discovery, publication and final reuse accounting remain unverified.

## Files

- [Full Integration workflow](../../../.github/workflows/full-integration.yml): events, approval, preflight, and execution queue admission.
- [Execution workflow](../../../.github/workflows/full-integration-execution.yml): same-commit revalidation, selectable lanes, dependencies, and aggregate.
- [Dispatch preflight](../../../scripts/ci/full-integration-preflight.mjs): lane and environment policy.
- [CI lane planning](../../../scripts/ci/full-integration-reuse.mjs): ordinary CI lane selection and result validation.
- [Suite index](../../../scripts/ci/test-suites.json): group membership; exact manifests are linked in Scenarios.
- [Test runner](../../../scripts/ci/run-tests.mjs): expected-case and result checks.
- [Lane action](../../../.github/actions/run-ci-lane/action.yml): preparation and cleanup.
