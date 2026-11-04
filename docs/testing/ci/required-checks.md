# CI required checks

## Overview

Use CI to check a pull request's source, packaging, persistence, and supported
component workflows. `CI Required` is the merge gate. Its successful conclusion
covers the lanes selected for that change, not every registered integration.

## When it runs

The workflow runs on pull requests, pushes to `main`, merge groups, and manual
dispatch. Documentation-only changes run static checks. Recognized test-only
changes select affected lanes, including TypeScript test checks. Other changes
run the ordinary lane matrix. Failed main-push CI also prevents release workflows
that require successful CI for that source.

## Scenarios

`pr-safe` runs the selected matrix jobs below; `runtime-image-fixture` runs
separately. If selection cannot be verified, CI runs every ordinary lane.

| Jobs                                                                                          | What they test / suite guide                                                                       | Exact manifests                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Checks and Conformance 1, 2                                                                   | [API, Drivers, authorization, CLI and tooling](../local.md)                                        | [1](../../../scripts/ci/test-suites/checks-baseline-1.json), [2](../../../scripts/ci/test-suites/checks-baseline-2.json)                                                                                                                                                             |
| Console Browser, Console Browser 2                                                            | [Console forms, Agent editing and permissions](../local.md#console-browser-checks)                 | [1](../../../scripts/ci/test-suites/checks-browser.json), [2](../../../scripts/ci/test-suites/checks-browser-2.json)                                                                                                                                                                 |
| PostgreSQL Migrations, Application, Authentication, Platform                                  | [Migrations, version workers, sign-in and persistence](../postgresql.md)                           | [Migrations](../../../scripts/ci/test-suites/postgres.json), [Application](../../../scripts/ci/test-suites/postgres-application.json), [Authentication](../../../scripts/ci/test-suites/postgres-auth.json), [Platform](../../../scripts/ci/test-suites/postgres-platform.json)      |
| Images and Packaging; Image Runtime Startup, Image Runtime Startup 2, Image Runtime Startup 3 | [Packaging, readiness, shutdown and workspace state](../docker.md)                                 | [Packaging](../../../scripts/ci/test-suites/images-packaging.json), [Startup 1](../../../scripts/ci/test-suites/images-runtime-startup.json), [2](../../../scripts/ci/test-suites/images-runtime-startup-2.json), [3](../../../scripts/ci/test-suites/images-runtime-startup-3.json) |
| Runtime Image Fixture                                                                         | [Runtime fixture images](../fixtures-and-scenarios.md)                                             | [Fixture](../../../scripts/ci/test-suites/runtime-image-fixture.json)                                                                                                                                                                                                                |
| k3d Fixture and Configuration; k3d State and Lifecycle; k3d Plugin Status                     | [Kubernetes configuration, isolation, state and plugins](../kubernetes.md#kubernetes-http-fixture) | [Configuration](../../../scripts/ci/test-suites/k3d-fixture-configuration.json), [State](../../../scripts/ci/test-suites/k3d-fixture-state.json), [Plugins](../../../scripts/ci/test-suites/k3d-fixture-plugins.json)                                                                |
| Production Observability; Logging Collector                                                   | [Fixture metrics, OTLP and collector recovery](../local.md#metrics-and-observability-tests)        | [Observability](../../../scripts/ci/test-suites/k3d-observability.json), [Collector](../../../scripts/ci/test-suites/logging-collector.json)                                                                                                                                         |
| Repository Credentials                                                                        | [Controlled Git/gh, credential isolation, expiry and recovery](../repository-credentials.md)       | [Container](../../../scripts/ci/test-suites/repository-credentials-container.json)                                                                                                                                                                                                   |
| Keycloak OIDC                                                                                 | [Sign-in, rotation, denied users and sign-out](../kubernetes.md#keycloak-oidc-tests)               | [Keycloak](../../../scripts/ci/test-suites/keycloak-oidc.json)                                                                                                                                                                                                                       |

CI Impact selects coverage; Suite Audit checks ownership; Static Checks runs
workspace, lint, format, OpenAPI and docs checks. Affected Packages reports impact;
`CI Required` aggregates required results. Manual Native Container Verification calls the
[native image workflow](../../../.github/workflows/container-check.yml). The [CI flow](../../flows/github-actions-testing.md)
explains these jobs; the PR-controlled workflow is not independent trusted enforcement.

## Run it

Open or update a pull request for automatic selection. For local reproduction,
use the linked suite guide and exact manifest in the table; prerequisites differ
between browser, PostgreSQL, container, and Kubernetes lanes. Follow the shared
[prepare, run, and cleanup procedure](run-lanes.md#results-and-cleanup).

To inspect a run, replace the example PR number with yours:

```sh
gh pr checks 4695 --repo openclaw/openclaw-enterprise
```

## Results and limits

Inspect the terminal `CI Required` conclusion and the selected jobs' results,
including `ci-results` artifacts. A queued job has not necessarily acquired a
runner. Use the job summary's phase timings to distinguish queue time, execution,
and result publication. Skipped real-provider lanes establish no provider proof.

[First Agent Smoke](first-agent-smoke.md) is a separate job and is not a
`CI Required` dependency. A green merge gate does not establish that smoke passed.
The [CI flow](../../flows/github-actions-testing.md) describes result accounting.

## Files

- [CI workflow](../../../.github/workflows/ci.yml): selection, jobs, and merge gate.
- [Suite index](../../../scripts/ci/test-suites.json): lane groups; individual manifests are linked above.
- [Lane action](../../../.github/actions/run-ci-lane/action.yml): preparation, execution, artifacts, and cleanup.
- [Test runner](../../../scripts/ci/run-tests.mjs): inventory checks, execution, and aggregation.
