---
tags: [human_verified]
---

# CI

Choose a test workflow for its scenarios, prerequisites, run procedure, and expected
results. For triggers and failure consequences across workflows, use the
[workflow cheat sheet](../reference/cheatsheets/github-actions.md).

<a id="ci-overview-and-configuration"></a>
<a id="ci-configuration-and-testing"></a>
<a id="overview"></a>
<a id="checks-and-gates"></a>
<a id="tests"></a>
<a id="production-observability-lane"></a>
<a id="special-cases"></a>
<a id="pr-exceptions"></a>
<a id="qa-matrix"></a>
<a id="qa-matrix-advisory"></a>
<a id="openshell-file-coverage"></a>
<a id="scenarios"></a>
<a id="local-inputs"></a>
<a id="outcomes-and-recovery"></a>
<a id="full-integration"></a>
<a id="manual-full-integration-lanes"></a>
<a id="observability-demo"></a>
<a id="qualify-a-published-release-for-staging"></a>
<a id="local-k3d-quickstart-on-a-fresh-runner"></a>
<a id="tests-in-each-workflow"></a>
<a id="github-actions"></a>

## Checks

| Check                                                        | Use it to                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [CI required checks](ci/required-checks.md)                  | Verify source, component workflows, persistence, and packaging for a change. |
| [First Agent Smoke](ci/first-agent-smoke.md)                 | Exercise the installed Agent lifecycle with a simulated model provider.      |
| [QA Matrix Advisory](ci/qa-advisory.md)                      | Test Agent workflows with real providers and OpenShell.                      |
| [Full Integration](ci/full-integration.md)                   | Dispatch selected integration lanes and inspect their aggregate result.      |
| [Observability Demo](ci/observability-demo.md)               | Verify fixture telemetry and rendered monitoring dashboards.                 |
| [Staging Release Qualification](ci/staging-qualification.md) | Check published container images with trusted startup tests.                 |
| [Local k3d Quickstart](ci/k3d-quickstart.md)                 | Exercise browser onboarding, Linear, and Git on one Agent.                   |

## Setup and execution

<a id="ci-configuration"></a>
<a id="configuration"></a>
<a id="shared-settings"></a>
<a id="environments"></a>
<a id="integration-environments"></a>
<a id="setting-overrides"></a>
<a id="local-runner-overrides"></a>
<a id="cleanup-command-deadlines"></a>
<a id="select-immutable-images-for-local-preparation"></a>

- [Configure CI](ci/configuration.md): repository settings, protected environments,
  credentials, images, and runner overrides.

<a id="find-test-coverage"></a>
<a id="results-and-cleanup"></a>
<a id="test-scenarios"></a>

- [Find and run test lanes](ci/run-lanes.md): locate a test's manifest, audit
  registration, and prepare and clean up local runs.

<a id="no-github-workflow-entrypoint"></a>
<a id="manually-selected-lanes-without-github-workflows"></a>

- [Manual tests](manual-tests.md): select lanes without GitHub workflows and
  complete their setup requirements.

<a id="guides"></a>
<a id="run-a-protected-integration-lane"></a>
<a id="run-the-hosted-local-installation-lane"></a>

- [Dispatch Full Integration](ci/full-integration.md#execution): select a hosted lane
  or run the local installation rehearsal.
- [Document a CI check](../contributing/ci-check-template.md): use the shared
  template when changing coverage documentation.
