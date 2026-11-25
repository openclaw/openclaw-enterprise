---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# CI

Every pull request runs static checks. CI selects integration tests from the
changed files. A passing `CI Required` check covers only the selected tests.
See the [workflow cheat sheet](../reference/cheatsheets/github-actions.md) for
workflow triggers and failure consequences.

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

### What blocks merge or release?

- **Merge into `main`** requires [CI Required](ci/required-checks.md). It checks
  the static results and the selected test lanes. It is the only required status check.
- **Standalone container and CLI publication** requires the entire CI run for the push to
  `main` and its `CI Required` check to pass for the exact release commit.
  [First Agent Smoke](ci/first-agent-smoke.md) uses a simulated model provider.
  Its failure blocks publication when selected, but does not block merge.
  Container preparation also requires [native image checks](ci/required-checks.md#scenarios).
- [Release OCE](../release/README.md) requires approval and a successful Full
  Integration Aggregate for `lane=all` at the selected source SHA in the release
  run. It can qualify any commit in protected `main` history without prior push CI.

### When does ordinary CI run integration tests?

| Change or event                                                                            | Tests selected in addition to static checks                                |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Allowlisted docs-only PR or verified forward docs-only push to `main`                      | None                                                                       |
| PR limited to eligible tests and related edits                                             | The lanes that own those tests and, for TypeScript, the type-checking lane |
| Other PRs, other pushes to `main` (including test-only pushes), merge groups and manual CI | All ordinary CI lanes and First Agent Smoke                                |

Ordinary CI includes PostgreSQL, container and Kubernetes integration tests.
If CI cannot verify a narrower selection, it runs all ordinary lanes.
Manual CI also runs native image checks. See the [selection rules](ci/required-checks.md#trigger)
and [lane coverage](ci/required-checks.md#scenarios).

### When do separate integration workflows run?

Ordinary CI in `full` mode does not start Full Integration. These separate
workflows have their own triggers.

- [Full Integration](ci/full-integration.md#trigger) includes live model and Slack tests.
  A schedule checks `main` every 15 minutes.
  A scheduled run can start only for the current commit without verified full coverage.
  It must start at least 60 minutes after the previous full run started and 15 minutes
  after it finished. A successful schedule check can skip all tests. To run one lane
  or the full suite manually on `main`, the dispatcher must be a member of
  the [required reviewer team](ci/configuration.md#environments) and approve the run.
- [QA Matrix Advisory](ci/qa-advisory.md#trigger) runs every six hours on `main`,
  manually on `main`, or on eligible labeled PRs. Pushes to `main` run QA only
  when `QA_ADVISORY_ON_PUSH=true`.
  Coverage includes native rootful Podman.
- [Observability Demo](ci/observability-demo.md) runs for relevant PR and `main`
  changes, merge groups and manual dispatches.
- [Local k3d Quickstart](ci/k3d-quickstart.md) runs manually on protected `main`
  or on a designated development-branch push that matches the reviewed commit.

For account-creation races, see the
[PostgreSQL account provisioning checks](../flows/local-password-authentication.md#debugging-and-verification).

Published-image qualification is a [release operation](../release/README.md#release-guides).
It does not establish CI test coverage or staging installation readiness.

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

### Native Podman advisory

The `dev-up-podman` lane uses native rootful Podman and the pinned
`podman-compose` version. It checks rollback after failed and blocked
initialization and an interrupted build. It also checks private Envoy routing
from the fixture's pinned Compose addresses. The accompanying QA matrix job
exercises the Codex model and Console through the trusted browser endpoint.

Both jobs follow the trusted full-advisory selection on main and on eligible
same-repository PRs with `full-qa`. The required checks omit this lane, and a fork
PR cannot select it. For local prerequisites, see the [rootful Podman setup](../guides/deploy/local-kubernetes-development.md#start-the-openshell-fail-closed-profile)
and the [lane manifest](../../scripts/ci/test-suites/dev-up-podman.json).
