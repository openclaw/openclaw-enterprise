---
kind: reference/ci
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# CI required checks

## Overview

Use CI to check a pull request's source, packaging, persistence, and supported
component workflows. `CI Required` is the merge gate. Its successful conclusion
covers the lanes selected for that change, not every registered integration.

<a id="when-it-runs"></a>

## Trigger

The workflow runs on pull requests, pushes to `main`, merge groups, and manual
dispatch. Documentation-only pull requests and verified, forward main pushes
run static checks. Main pushes compare the complete `before` to `after` range
using the policy from `before`; missing history, forced pushes, or a policy that
does not support push selection run the ordinary lane matrix. Recognized
test-only pull requests select affected lanes, including TypeScript test checks.
Other changes run the ordinary lane matrix. Failed main-push CI also prevents release workflows
that require successful CI for that source.

For a main push that modifies one registered test, the `CI main test advisory v2`
notice in `CI Impact` can list the predicted lanes and the verified before and
after commits. A broad notice without commit IDs leaves the range unverified.
If the notice is missing, no prediction was received. Test-only main pushes
still run full CI.

Documentation-only changes include regular, non-executable `.png` illustrations
under `specs/rfcs/`. Images elsewhere and other image extensions still select full
CI. Mixing an RFC image with runtime or tooling changes also selects full CI.

## Scenarios

`pr-safe` runs the selected matrix jobs below; `runtime-image-fixture` runs
separately. If selection cannot be verified, CI runs every ordinary lane.

| Tests                                                                           | What is verified                                                                                                                                                                      | GitHub jobs and manifests                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Domain, API, CLI, and tooling](../local.md)                                    | Driver contracts, authorization, API behavior, CLI commands, and test tooling.                                                                                                        | [Checks and Conformance 1](../../../scripts/ci/test-suites/checks-baseline-1.json), [Checks and Conformance 2](../../../scripts/ci/test-suites/checks-baseline-2.json)                                                                                                                                                                                  |
| [Console browser behavior](../local.md#console-browser-checks)                  | Forms, Agent configuration, user actions, and permissions.                                                                                                                            | [Console Browser](../../../scripts/ci/test-suites/checks-browser.json), [Console Browser 2](../../../scripts/ci/test-suites/checks-browser-2.json)                                                                                                                                                                                                      |
| [PostgreSQL persistence and sign-in](../postgresql.md)                          | Schema migrations, saved platform state, worker operations, and authentication.                                                                                                       | [PostgreSQL Migrations](../../../scripts/ci/test-suites/postgres.json), [PostgreSQL Application](../../../scripts/ci/test-suites/postgres-application.json), [PostgreSQL Authentication](../../../scripts/ci/test-suites/postgres-auth.json), [PostgreSQL Platform](../../../scripts/ci/test-suites/postgres-platform.json)                             |
| [Container packaging and startup](../docker.md)                                 | Packaged files, startup readiness, shutdown, and retained workspace state.                                                                                                            | [Images and Packaging](../../../scripts/ci/test-suites/images-packaging.json), [Image Runtime Startup](../../../scripts/ci/test-suites/images-runtime-startup.json), [Image Runtime Startup 2](../../../scripts/ci/test-suites/images-runtime-startup-2.json), [Image Runtime Startup 3](../../../scripts/ci/test-suites/images-runtime-startup-3.json) |
| [Runtime image metadata](../../../tests/integration/runtime-images.test.ts)     | The image attached to a container is reported even after its tag changes; containers from another Agent revision are rejected; Enterprise and OpenClaw commit metadata are validated. | [Runtime Image Fixture](../../../scripts/ci/test-suites/runtime-image-fixture.json)                                                                                                                                                                                                                                                                     |
| [Kubernetes deployment and isolation](../kubernetes.md#kubernetes-http-fixture) | Agent workloads, identities, configuration, persistent state, network isolation, and plugin status.                                                                                   | [k3d Fixture and Configuration](../../../scripts/ci/test-suites/k3d-fixture-configuration.json), [k3d State and Lifecycle](../../../scripts/ci/test-suites/k3d-fixture-state.json), [k3d Network Isolation](../../../scripts/ci/test-suites/k3d-fixture-network.json), [k3d Plugin Status](../../../scripts/ci/test-suites/k3d-fixture-plugins.json)    |
| [Metrics and log collection](../local.md#metrics-and-observability-tests)       | Metrics and logs reach their configured stores; forwarded records retain workload identity; collection recovers after an exporter outage.                                             | [Production Observability](../../../scripts/ci/test-suites/k3d-observability.json), [Logging Collector](../../../scripts/ci/test-suites/logging-collector.json)                                                                                                                                                                                         |
| [Repository credential isolation](../repository-credentials.md)                 | Git and GitHub CLI access, credential isolation, expiry, and recovery.                                                                                                                | [Repository Credentials](../../../scripts/ci/test-suites/repository-credentials-container.json)                                                                                                                                                                                                                                                         |
| [Keycloak sign-in](../kubernetes.md#keycloak-oidc-tests)                        | Sign-in, signing-key rotation, access denial, and sign-out through OpenID Connect.                                                                                                    | [Keycloak OIDC](../../../scripts/ci/test-suites/keycloak-oidc.json)                                                                                                                                                                                                                                                                                     |

The first column describes the tests. The last column preserves the job names
shown in GitHub Actions and links to their test manifests. Runtime image metadata
tests use real Docker containers with lightweight fixture images; they do not
run a complete Agent or call a model provider.

CI Impact selects coverage. Suite Audit and Static Checks is one job that runs
in every mode: it lints workflows, audits suite ownership, and runs workspace,
lint, format, OpenAPI, documentation checks, and the documentation build.
Affected Packages reports impact; `CI Required` aggregates required results. Manual Native Container Verification calls the
[native image workflow](../../../.github/workflows/container-check.yml). The [CI flow](../../flows/github-actions-testing.md)
explains these jobs; the PR-controlled workflow is not independent trusted enforcement.

### Compare a shadow prediction with the jobs that ran

On a full pull-request run, download the `affected-lanes-ATTEMPT` artifact from
Affected Packages. The JSON identifies the tested merge, its first parent
(`base`), and its second parent (`head`). A change confined to the Controller's
`console-assets.ts` reader can report candidate CI lanes and the standalone
Console Storybook build. Other paths, additional affected packages, or missing
evidence produce a broad prediction. A mixed change that touches the reader can
still list its known consumers. These hints cover only that module. A changed
Storybook workflow, asset preparer, or either package script that connects them
requires fresh verification before the report can list Storybook again. A missing artifact
leaves the prediction unknown. CI still executes its ordinary checks.

For a completed run, set `run` and `attempt` to its numeric IDs. From the
repository checkout, use GitHub CLI, jq, and yq (v4) to compare the artifact
with the original attempt. Independently confirm the workflow commit from the
original job before attributing its matrix to the run. The artifact is produced
by pull-request code. If the workflow commit cannot be confirmed, the lane
comparison remains unverified.

```sh
gh run download "$run" --name "affected-lanes-$attempt" --dir "shadow-$run-$attempt"
receipt="shadow-$run-$attempt/affected-lanes.json"
head=$(gh api "repos/{owner}/{repo}/actions/runs/$run/attempts/$attempt" --jq '.head_sha') || exit 1
workflow=$(jq -er --arg run "$run" --arg attempt "$attempt" --arg head "$head" '
  select(.run.runId == $run and .run.attempt == $attempt and .identity.head == $head)
  | .run.workflowSha | select(type == "string" and test("\\A([0-9a-f]{40}|[0-9a-f]{64})\\z"))' "$receipt") || exit 1
git show "$workflow:.github/workflows/ci.yml" |
  yq -r '.jobs.impact.steps[] | select(.id == "matrix") | .env.LANE_TABLE' |
  jq --slurpfile r "$receipt" '[.[] | select(.lane as $id | $r[0].lanes | index($id)) | .title]' > "shadow-$run-$attempt/titles.json"
gh api --paginate "repos/{owner}/{repo}/actions/runs/$run/attempts/$attempt/jobs?per_page=100" |
  jq --slurpfile titles "shadow-$run-$attempt/titles.json" '.jobs[] | {name, conclusion, started_at, completed_at, listed_consumer: (.name as $name | $titles[0] | index($name) != null)}'
```

Inspect every failed or incomplete job, including those outside the candidate
set. For the separate Storybook workflow, match the original pull-request head
and base against its run before comparing the build conclusion and timestamps.
The timestamps measure the original jobs. A candidate prediction alone supplies
no measurement of time saved.

<a id="run-it"></a>

## Execution

Open or update a pull request for automatic selection. For local reproduction,
use the linked suite guide and exact manifest in the table; prerequisites differ
between browser, PostgreSQL, container, and Kubernetes lanes. Follow the shared
[prepare, run, and cleanup procedure](run-lanes.md#results-and-cleanup).

`checks-baseline-2` requires full Git history for its sign-in qualification profile
tests. CI and Full Integration fetch that history during checkout for this lane;
other matrix lanes keep a shallow checkout. Local runs need the reviewed profile
commit available before starting; the tests do not fetch missing history.

Runtime-image bridge tests and typechecks write temporary compiler artifacts to
disk so memory pressure can reclaim their page cache. Each verification step
starts with an empty artifact directory and removes it before committing the
layer. Test selection and the final runtime remain unchanged.

To inspect a run, replace the example PR number with yours:

```sh
gh pr checks 4695 --repo openclaw/openclaw-enterprise
```

## Results and limits

Inspect the terminal `CI Required` conclusion and the selected jobs' results,
including `ci-results` artifacts. A queued job has not necessarily acquired a
runner. Use the job summary's phase timings to distinguish queue time, execution,
and result publication. A skipped lane does not verify access to its model provider.

[First Agent Smoke](first-agent-smoke.md) is a separate job and is not a
`CI Required` dependency. A green merge gate does not establish that smoke passed.
The [CI flow](../../flows/github-actions-testing.md) describes result accounting.

## Files

- [CI workflow](../../../.github/workflows/ci.yml): selection, jobs, and merge gate.
- [Suite index](../../../scripts/ci/test-suites.json): lane groups; individual manifests are linked above.
- [Lane action](../../../.github/actions/run-ci-lane/action.yml): preparation, execution, artifacts, and cleanup.
- [Test runner](../../../scripts/ci/run-tests.mjs): inventory checks, execution, and aggregation.
