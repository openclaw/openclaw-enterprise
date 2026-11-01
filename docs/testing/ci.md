# CI configuration and testing

## Overview

Configure GitHub Actions variables, secrets, environments, and setting overrides. Use this page to run integration lanes and inspect their results; the [workflow cheat sheet](../reference/cheatsheets/github-actions.md) lists triggers and blocking failures.

<a id="checks-and-gates"></a>

## Tests

| Check                             | When it runs                                          | Blocks merge               | GitHub Actions                                                                                                     |
| --------------------------------- | ----------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| CI                                | Every PR                                              | Yes, through `CI Required` | [ci.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/ci.yml)                                 |
| First Agent Smoke (job within CI) | [Every PR](#special-cases)                            | No                         | [ci.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/ci.yml)                                 |
| QA Matrix Advisory                | [`main`; every 6 h; selected trusted PRs](#qa-matrix) | No                         | [qa-advisory.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/qa-advisory.yml)               |
| Full Integration                  | Manual                                                | No                         | [full-integration.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/full-integration.yml)     |
| Observability Demo                | [Every PR](#special-cases)                            | No                         | [observability-demo.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/observability-demo.yml) |
| Publish private documentation     | Manual                                                | No                         | [docs-pages.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/docs-pages.yml)                 |

<a id="pr-exceptions"></a>

### Special Cases

- **First Agent Smoke:** skips docs-only and recognized test-only PRs.
- **QA Matrix Advisory:** runs every 6 hours on `main`. Runs after each push to `main` are
  [paused](#qa-matrix). To qualify a change before merge, a maintainer can
  [request full QA on a trusted pull request](#qa-matrix).
- **Observability Demo:** runs only when the changed files match its workflow path filters.

Docs-only PRs run static checks in CI. Recognized test-only PRs select affected
lanes, including Checks and Conformance 2 to type-check TypeScript tests.
Other changes run all ordinary lanes. `CI Required` currently blocks
merge on `main`. These workflows do not gate each Agent/platform deployment.

<a id="ci-configuration"></a>

## Configuration

Set Actions variables/secrets under **Settings → Secrets and variables → Actions**
or the named **Settings → Environments** entry. Keep provider credentials in
their environments. GitHub supplies workflow/cache tokens automatically.
Manual dispatch inputs are per-run values; use the commands below.

### Shared Settings

Public repositories need no `CODEQL_ENABLED` setting. For private repositories,
set that repository variable to `true` only after approved, licensed Code Security
advanced setup. Native image checks use the [release build settings](../release/configuration.md#build-settings).

Ordinary CI, First Agent Smoke, cache warming, Storybook, and Observability Demo
need no provider secrets. Runner labels, tool pins, triggers, timeouts, and job
permissions are set in the [workflow files](../../.github/workflows);
[test lane definitions](../../scripts/ci/test-suites.json) own required inputs.

<a id="integration-environments"></a>

### Environments

Create only environments needed by selected jobs. Full Integration preflight
requires no required reviewers. Its environments allow protected branches or a
custom policy containing `main`; `integration-provider-account` instead requires
exactly one custom rule: branch `main`. The advisory `integration-qa-pr` environment
permits `main` and GitHub's `refs/pull/*/merge` branches. The `full-qa` and `qa-openshell-compose` labels select runs within
that policy. Full Integration preflight does not govern this environment.

Full Integration rejects tags. Before dispatch, confirm the branch points
to the reviewed commit; rely on the run only if its `headSha` matches that commit. Four
lanes accept branches other than `main`.
For `k3d-model` (`integration-model`) and `openshell` (`integration-openshell`),
the custom environment policy must allow both `main` and the exact reviewed
branch. A wildcard alone does not authorize the branch. Remove the temporary
branch exception afterward.

`dev-up-k3d` and `skipper-prepared-git-installed` accept branches without a
GitHub environment. The Skipper job uses synthetic, job-local model and Git credentials for the
[installed private Git fixture](repository-credentials.md#verify-prepared-native-git)
and a GitHub Actions cache token to build images. `helper-timeout` and standalone
`logging-collector` also need no environment, but both require `main`.

The table distinguishes secret names from variable names. The common runtime
image variables are optional `OCC_TEST_KUBERNETES_GATEWAY_IMAGE` and
`OCC_TEST_KUBERNETES_AGENT_IMAGE`; unset values use preparation's builds/defaults.
`CONTAINER_NODE_BASE_IMAGE` remains a shared repository setting.

| GitHub environment             | Used by                                                                                      | Secrets                                                                                                                                   | Variables                                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration-model`            | Full Integration: Docker Model Runtime, k3d Model Runtime, Production TUI                    | `OPENAI_API_KEY`                                                                                                                          | `OCC_TEST_OPENAI_MODEL`, `NODE_BASE_IMAGE`; Docker: `OCC_DOCKER_RUNTIME_IMAGE`; k3d: common runtime images; TUI: `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`, `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`, `OCC_TEST_PRODUCTION_POSTGRES_IMAGE`, `OCC_TEST_PRODUCTION_NODE_IMAGE`. |
| `integration-routing`          | Full Integration: Gateway Routing                                                            | `OPENAI_API_KEY`                                                                                                                          | `OCC_TEST_OPENAI_MODEL`, common runtime images.                                                                                                                                                                                                                       |
| `integration-otel`             | Full Integration: k3d OTEL                                                                   | `OPENAI_API_KEY`                                                                                                                          | `OCC_TEST_OPENAI_MODEL`, `NODE_BASE_IMAGE`, common runtime images.                                                                                                                                                                                                    |
| `integration-slack`            | Full Integration: Slack Live                                                                 | `OPENAI_API_KEY`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `OCC_TEST_SLACK_SENDER_BOT_TOKEN`                                                 | `OCC_TEST_OPENAI_MODEL`, common runtime images, `OCC_TEST_SLACK_PROXY_URL`, `OCC_TEST_SLACK_CHANNEL_ID`.                                                                                                                                                              |
| `integration-provider-account` | Full Integration: Provider Account                                                           | `OCC_TEST_CHATGPT_ADMIN_KEY_JSON`                                                                                                         | `OCC_TEST_CHATGPT_WORKSPACE_ID`, `OCC_TEST_OPENAI_MODEL`, common runtime images.                                                                                                                                                                                      |
| `integration-openshell`        | Full Integration: OpenShell                                                                  | `CODEX_ACCESS_TOKEN`                                                                                                                      | `OCC_TEST_OPENAI_MODEL`, common runtime images, `OCC_TEST_OPENSHELL_GATEWAY_IMAGE`, `OCC_TEST_OPENSHELL_SANDBOX_IMAGE`, `OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE`, `OCC_TEST_OPENSHELL_SECRET_PROJECTION` (default `1`).                                                  |
| `integration-qa-pr`            | QA Matrix Advisory: QA advisory (compose), QA advisory (kubernetes), QA advisory (OpenShell) | `CODEX_ACCESS_TOKEN`                                                                                                                      | `OCC_TEST_QA_CODEX_MODEL`, `OCC_TEST_OPENAI_MODEL`, and Calendar settings below. Code on `main` and selected trusted PRs receives these credentials.                                                                                                                  |
| `integration-qa`               | Full Integration: Shipped Installation QA Matrix                                             | `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SENDER_TOKEN`, plus repository fixture secrets below | `OCC_TEST_QA_OPENAI_MODEL`, `OCC_TEST_QA_CODEX_MODEL`, `OCC_TEST_QA_SLACK_CHANNEL_ID`, Calendar settings, `REPOSITORY_UPSTREAM_CIDRS_JSON`.                                                                                                                           |

`NODE_BASE_IMAGE` is a separate variable consumed by older Full Integration
jobs; it is not an alias for `CONTAINER_NODE_BASE_IMAGE`. Model/image requirements
and defaults differ by lane: follow its linked suite guide. Missing required
inputs fail selected lanes.

Calendar requires variables `OCC_TEST_CODEX_CALENDAR_TOOL_NAME` and
`OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT`; `OCC_TEST_CODEX_CALENDAR_PROMPT` is
optional. QA model overrides default to `gpt-6-luna`.

In `integration-qa`, the default repository fixture needs secrets
`REPOSITORY_OBSERVER_TOKEN`, `REPOSITORY_REGISTRY_JSON`, and `REPOSITORY_APP_KEY`.
For `qa_repository_fixture: isolated`, replace those with secrets
`QA_ISOLATED_REPOSITORY_REGISTRY_JSON`, `QA_ISOLATED_REPOSITORY_APP_KEY`, and
variable `QA_ISOLATED_REPOSITORY_FULL_NAME`. The registry must contain exactly
that lowercase `owner/repository`, different from this workflow repository.
Isolated runs mint short-lived observer tokens from the App; no static observer
token is needed. Both fixtures use approved IPv4 `/32` endpoints in
`REPOSITORY_UPSTREAM_CIDRS_JSON`. Missing or mismatched inputs fail without fallback.

<a id="cleanup-command-deadlines"></a>
<a id="select-immutable-images-for-local-preparation"></a>

<a id="local-runner-overrides"></a>

### Setting Overrides

These process environment variables are optional. Keep the same directory and
slot for First Agent `images` and `run`; only a distinct slot isolates host-wide names.

| Setting                                     | Default                                                       | Purpose                                                                            |
| ------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `OCC_FIRST_AGENT_SMOKE_DIRECTORY`           | `$RUNNER_TEMP/first-agent-smoke`, or `/tmp/first-agent-smoke` | Images, certificates, and Local Setup state.                                       |
| `OCC_FIRST_AGENT_SMOKE_SLOT`                | `0`                                                           | `0`–`31`; other cluster, registry, model names, port, subnet. Also vary dev ports. |
| `CI_RUNNER_TEST_TIMEOUT_MS`                 | `3600000`                                                     | Per-file test deadline; hosted lane/job deadlines still apply.                     |
| `CI_RUNNER_CLEANUP_TIMEOUT_MS`              | `120000`                                                      | Per-file cleanup allowance.                                                        |
| `CI_RUNNER_FILE_CONCURRENCY`                | Lane limit capped by available CPUs                           | `1`–`32` for lanes permitting parallel files; serial-only lanes stay serial.       |
| `OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS`    | `300000`                                                      | Container-engine/k3d cleanup command limit; database drops use at most 60 seconds. |
| `OPENCLAW_CI_COMMAND_KILL_GRACE_MS`         | `5000`                                                        | TERM-to-KILL and pipe-drain grace during preparation/cleanup.                      |
| `OPENCLAW_CI_K3S_IMAGE`                     | Immutable pin in `scripts/ci/prepare.mjs`                     | Approved digest-pinned Kubernetes 1.35.x image; OpenShell has a separate pin.      |
| `OPENCLAW_CI_IMAGE_CACHE_EXPORT_TIMEOUT_MS` | `1200000`                                                     | Bound hosted BuildKit cache export.                                                |
| `OPENCLAW_CI_BROWSER_FAILURE_DIR`           | Unset                                                         | Retain browser failure evidence locally.                                           |
| `OPENCLAW_CI_BROWSER_FAILURE_TRACE`         | Unset                                                         | Set `1` to include Playwright traces.                                              |

Cleanup timeout/grace overrides that are not positive numbers use defaults.
Deadlines include pipe drain; a wait timeout does not prove deletion. Preparation
verifies imported image references on every node and fails on import timeout.

<a id="github-actions"></a>

<a id="tests-in-each-workflow"></a>

## Test Scenarios

Manifests list test files, selectors, prerequisites, and any expected-case checks.
[The suite index](../../scripts/ci/test-suites.json) defines lane groups. Workflows
without test suites build, publish, scan, or dispatch; see the [workflow index](../reference/cheatsheets/github-actions.md).
Files that share a runner start longest first, by [measured file times](../../scripts/ci/test-suites/file-durations.json).
A file without a row starts first; refresh rows when a lane's longest files change.

<a id="production-observability-lane"></a>

### CI

`pr-safe` runs the selected matrix jobs below; `runtime-image-fixture` runs
separately. Documentation-only PRs skip product tests. If selection cannot be
verified, CI runs every ordinary lane.

| Jobs                                                                                          | What they test / suite guide                                                                                                 | Exact manifests                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Checks and Conformance 1, 2                                                                   | [API, Drivers, authorization, CLI and tooling](local.md)                                                                     | [1](../../scripts/ci/test-suites/checks-baseline-1.json), [2](../../scripts/ci/test-suites/checks-baseline-2.json)                                                                                                                                                       |
| Console Browser, Console Browser 2                                                            | [Console forms, Agent editing and permissions](local.md#console-browser-checks)                                              | [1](../../scripts/ci/test-suites/checks-browser.json), [2](../../scripts/ci/test-suites/checks-browser-2.json)                                                                                                                                                           |
| PostgreSQL Migrations, Application, Authentication, Platform                                  | [Migrations, version workers, sign-in and persistence](postgresql.md)                                                        | [Migrations](../../scripts/ci/test-suites/postgres.json), [Application](../../scripts/ci/test-suites/postgres-application.json), [Authentication](../../scripts/ci/test-suites/postgres-auth.json), [Platform](../../scripts/ci/test-suites/postgres-platform.json)      |
| Images and Packaging; Image Runtime Startup, Image Runtime Startup 2, Image Runtime Startup 3 | [Packaging, readiness, shutdown and workspace state](docker.md)                                                              | [Packaging](../../scripts/ci/test-suites/images-packaging.json), [Startup 1](../../scripts/ci/test-suites/images-runtime-startup.json), [2](../../scripts/ci/test-suites/images-runtime-startup-2.json), [3](../../scripts/ci/test-suites/images-runtime-startup-3.json) |
| Runtime Image Fixture                                                                         | [Runtime fixture images](fixtures-and-scenarios.md)                                                                          | [Fixture](../../scripts/ci/test-suites/runtime-image-fixture.json)                                                                                                                                                                                                       |
| k3d Fixture and Configuration; k3d State and Lifecycle; k3d Plugin Status                     | [Kubernetes configuration, isolation, state and plugins](kubernetes.md#kubernetes-http-fixture)                              | [Configuration](../../scripts/ci/test-suites/k3d-fixture-configuration.json), [State](../../scripts/ci/test-suites/k3d-fixture-state.json), [Plugins](../../scripts/ci/test-suites/k3d-fixture-plugins.json)                                                             |
| Production Observability; Logging Collector                                                   | [Fixture metrics, OTLP and collector recovery](local.md#metrics-and-observability-tests)                                     | [Observability](../../scripts/ci/test-suites/k3d-observability.json), [Collector](../../scripts/ci/test-suites/logging-collector.json)                                                                                                                                   |
| Repository Credentials                                                                        | [Controlled Git/gh, credential isolation, expiry and recovery](repository-credentials.md)                                    | [Container](../../scripts/ci/test-suites/repository-credentials-container.json)                                                                                                                                                                                          |
| Keycloak OIDC                                                                                 | [Sign-in, rotation, denied users and sign-out](kubernetes.md#keycloak-oidc-tests)                                            | [Keycloak](../../scripts/ci/test-suites/keycloak-oidc.json)                                                                                                                                                                                                              |
| First Agent Smoke                                                                             | Local installation, chat, stop/restart and public-reader retirement/isolation with a simulated model; no real-provider proof | No manifest: [smoke script](../../scripts/ci/first-agent-smoke.mjs)                                                                                                                                                                                                      |

CI Impact selects coverage; Suite Audit checks ownership; Static Checks runs
workspace, lint, format, OpenAPI and docs checks. Affected Packages reports impact;
CI Required aggregates results. Manual Native Container Verification calls the
[native image workflow](../../.github/workflows/container-check.yml). The [CI flow](../flows/github-actions-testing.md)
explains these jobs; the PR-controlled workflow is not independent trusted enforcement.

<a id="qa-matrix-advisory"></a>

### QA matrix

The explicit `sandbox-policy` selector exercises shared configuration discovery,
preview, and the real OpenShell network-policy lifecycle. It requires a prepared
OpenShell file environment; see [policy proof setup](openshell-coverage.md#qa-matrix-selector).
The OpenShell advisory job covers the same workflow automatically. The separate
`plugin-install` selector verifies dedicated Codex installation, native-process
restart discovery, and selection removal through the Agent workflow; see
[plugin installation proof](openshell.md#codex-plugin-installation).

The matrix creates disposable Compose and Kubernetes control planes, both with
Kubernetes compute, and separate OpenClaw/Codex Agents for each scenario. It does
not use existing clusters or change the default kubeconfig. The exact test list
is in the [QA manifest](../../scripts/ci/test-suites/qa-matrix.json).

The `model-ui` scenario mounts the example console theme on Compose or Kubernetes
and checks its branding through sign-in and the Agent workflow. Its OpenClaw
cell also redeploys the same Agent with an explicitly configured provider alias,
the existing OCC Secret, and `OCE_MODEL_API_KEY`, then requires a real model turn.
This stage runs wherever the OpenClaw `model-ui` cell is selected; the Codex-only
advisory selection does not cover it. Other scenarios
do not require the theme or an extra API rollout.

Every push to `main` runs the marked Codex scenarios on Compose and Kubernetes, and the
complete OpenShell lane. Each push has its own concurrency group so a later
merge cannot cancel the result. The author of the change that first breaks a lane owns triage;
use the failed run's commit and retained results. These jobs do not block merge or publication.
Push runs are paused until the `integration-qa-pr` credentials work again. To start them again,
set the repository variable `QA_ADVISORY_ON_PUSH` to `true`.

For changes to OpenShell, image pins, Helm installation or another live integration, a maintainer
can add the `full-qa` label to a reviewed, same-repository pull request. Create that repository
label once before enabling this workflow. Adding it starts those three jobs on GitHub's PR merge
commit, plus the hosted local installation rehearsal. A manual dispatch on `main` and the
schedule (every 6 hours, at minute 17) also run the whole matrix with that rehearsal. Check
the run's commit and results before merging; skipped jobs provide no live QA result.
As long as the label remains, pushing a new commit replaces the previous run. Removing
it stops selection on future pushes; cancel an active run separately. Forks and Dependabot PRs are
ineligible. This is trusted code with real credentials, under the [existing environment policy](#environments).

For the Compose OpenShell first-Agent workflow alone, add `qa-openshell-compose`
to a reviewed, same-repository PR. Create that label once if it is absent. The job
uses `integration-qa-pr` and runs only
`tests/integration/local-first-agent-openshell-real.test.mjs`, including its native
worker and redeployment cases. Its control plane runs in Compose; its workloads
still use Kubernetes Compute. `full-qa` takes precedence when both labels exist.
The focused run skips the other advisory jobs, keeps manifest case requirements
and cleanup, and records `scope: focused`. It cannot satisfy full-lane aggregation.
Inspect `qa-advisory-compose-openshell` and its attempt-specific artifacts.

Ordinary PRs keep the [required CI suites](#ci) and, when selected, First Agent Smoke with a
simulated model. Full Integration's `Shipped Installation QA Matrix` runs every selected combination.

```sh
pnpm cli:build
OCC_TEST_QA_MATRIX=1 node --env-file="$TEST_ENV_FILE" \
  --test tests/integration/qa-matrix-real.test.mjs
```

#### Scenarios

| Scenario                | In advisory | Presets         | Checks                                                                                                                                  |
| ----------------------- | ----------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `model-ui`              | Yes (Codex) | OpenClaw, Codex | Real model turn and native browser response.                                                                                            |
| `console-secrets`       | Yes (Codex) | OpenClaw, Codex | Console Secret lifecycle and Agent draft references; Namespace deletion refusal names the deployed Agent and scopes cleanup navigation. |
| `git-write`             | No          | OpenClaw, Codex | Clone, edit, commit, push to the run's granted branch, dispose credentials.                                                             |
| `git-push-denied`       | No          | Codex           | Reject a push to any other branch and dispose credentials.                                                                              |
| `calendar`              | Yes (Codex) | Codex           | Successful Calendar read, approvals and tool restrictions.                                                                              |
| `slack`                 | No          | Codex           | Threaded reply and new root message.                                                                                                    |
| `openshell-linear-read` | No          | Codex           | Opt-in shipped OpenShell setup, Linear installation and verified native read.                                                           |
| `codex-search-config`   | No          | Codex           | API-key Agent user configuration with omitted, false and true capability declarations; persistence after supported stop/deploy.         |

`OCC_TEST_QA_INSTALLATION` accepts `all` (default), `compose`, `kubernetes`;
`OCC_TEST_QA_PRESET` accepts `all` (default), `OpenClaw`, `Codex`.
`OCC_TEST_QA_SCENARIOS` accepts `all` (default) or comma-separated selectors.
Invalid or wholly inapplicable selections fail before provisioning; missing
inputs fail selected checks. Omitting `OCC_TEST_QA_MATRIX=1` skips the suite.

`codex-search-config` requires an exclusive explicit scenario selection. It changes
only its disposable Installation, uses dedicated Codex API-key authentication,
and needs `OCC_TEST_QA_CODEX_MODEL_BASE_URL`. Supply the model key through
`OCC_TEST_QA_MODEL_API_KEY` in the consuming test process, or the existing private
`OCC_TEST_QA_OPENAI_KEY_FILE` input. Environment injection is registered for error
redaction and excluded from launcher children. Existing file inputs still require
private regular files and reject symlinks. Set `OCC_TEST_QA_CODEX_MODEL` to an
available model. The scenario proves generated configuration and native startup;
it does not prove live web-search results. It is excluded from `all` and advisory
jobs because its explicit endpoint and API-key inputs differ from account-login QA.

All combinations check startup and authenticated console login. Git alone starts
the broker. Linear reads use the explicit `openshell-linear-read` scenario,
which boots a separate shipped OpenShell stack and requires a connected Codex
identity plus the read fixture described in [OpenShell testing](openshell.md#linear-tool-use-qualification).
`OCC_TEST_QA_CONCURRENCY=1..4` selects workers
(default `2`); installations and Slack run sequentially. Each gateway can use
4 GiB beyond shared services.

#### Local inputs

Prepare [Kubernetes](kubernetes.md) and [Compose](../guides/deploy/local-compose-kubernetes.md):
workspace dependencies, Docker, k3d, kubectl, Helm, Go, OpenSSL, Chromium/Playwright,
and `certutil`. Store selected inputs in a private environment file. Credential
files must be regular files without group/other permissions. Hosted settings
are under [integration environments](#environments).

| Scenario/preset           | Inputs                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw model            | `OCC_TEST_QA_OPENAI_KEY_FILE`                                                                                                                                                          |
| Codex, including Calendar | `OCC_TEST_QA_CODEX_TOKEN_FILE`: authorized service-account PAT                                                                                                                         |
| Git                       | `OCC_TEST_QA_REPOSITORY_AUTHORIZED=1`, `OCC_TEST_QA_REPOSITORY_INPUT_DIRECTORY`, and `OCC_TEST_QA_GITHUB_OBSERVER_TOKEN_FILE` or absolute managed `OCC_TEST_QA_GITHUB_OBSERVER_BINARY` |
| Calendar                  | `OCC_TEST_CODEX_CALENDAR_TOOL_NAME`, `OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT`: harmless read and successful-result pattern                                                              |
| Slack                     | `OCC_TEST_QA_SLACK_APP_TOKEN_FILE`, `OCC_TEST_QA_SLACK_BOT_TOKEN_FILE`, `OCC_TEST_QA_SLACK_SENDER_TOKEN_FILE`, `OCC_TEST_QA_SLACK_CHANNEL_ID`                                          |

Slack sender and gateway bot must be distinct channel members; the sender needs
post/history/reply access. Reserve the Socket Mode app for this run.

Git's private input directory contains `registry.json`, `private-key.pem`, and
`upstream-cidrs.json`. Follow [fixture setup](../guides/deploy/local-repository-credentials.md):
exactly one authorized repository, `${OCC_INITIAL_NAMESPACE_ID}`, approved IPv4 `/32`
endpoints, and run-branch push permissions. The run grants `git-write` with `git-only`
transport on one branch, `oce-qa-<run>`, and opens no PR. The run generates the
worker's custody key.
`OCC_TEST_QA_GITHUB_OBSERVER_APP_INPUT_DIRECTORY` instead supplies an isolated
observer App's `registry.json` and `private-key.pem`. Observer credentials stay outside Agents and clean
only verified run-owned refs.

`OCC_TEST_QA_ARTIFACTS` selects private results; otherwise the runner prints its
temporary path. Set `OCC_TEST_QA_CONTROLLER_IMAGE` and `OCC_TEST_QA_RUNTIME_IMAGE`
together to reuse immutable builds; `OCC_TEST_QA_REPOSITORY_IMAGE` selects the
broker. Model defaults are [above](#environments); the [manifest](../../scripts/ci/test-suites/qa-matrix.json)
lists overrides.

#### Outcomes and recovery

`matrix.json` records completed stages as `passed`, `failed`, or `blocked`.
Inspect selections, runner failures and cleanup: absent, filtered or interrupted
stages are not passes. `scope: full` means all scenarios were selected. Hosted
outcomes expire after seven days.

Cleanup stops run-owned Agents/installations. Uncertain credential disposal retains the installation and reports recovery.
Keep its broker until sessions are `DISPOSED` without active uses or pending,
uncertain or auxiliary cleanup. Preserve other runs' resources. For Git TLS
errors, compare broker DNS with approved endpoints/NetworkPolicy,
[refresh approved inputs](../guides/deploy/local-repository-credentials.md#prepare-the-approved-inputs),
complete disposal, then recreate only this run's installation.

Add stages in [qa-matrix-real.test.mjs](../../tests/integration/qa-matrix-real.test.mjs),
following [fixture conventions](fixtures-and-scenarios.md); register inputs in
the manifest and workflow. Workers own Agents/cleanup; keep dependent steps
sequential and installation-wide changes outside workers. Preserve failure,
security and disposal assertions.

<a id="manual-full-integration-lanes"></a>

### Full Integration

`pr-safe-same-sha` and Runtime Image Fixture repeat the [CI suites](#ci) at the
dispatch commit when `all` is selected; its matrix also adds Demo Observability
Smoke below. Dispatch Preflight checks policy; Full Integration Aggregate requires
selected results. QA waits for Slack to finish, including after Slack failure.
The PR column identifies suites reused by other workflows; Full Integration
itself remains manual.

| Jobs                                    | What they test / suite guide                                                                                                                                           | Exact manifests                                                                                                       | Runs on PRs                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Docker Model Runtime; k3d Model Runtime | [Docker](docker.md) deploy refusal; [Kubernetes](kubernetes.md#kubernetes-model-turns-and-secrets) real models, Pod replacement, Secret rotation and first-Agent reuse | [Docker](../../scripts/ci/test-suites/docker-model.json), [k3d](../../scripts/ci/test-suites/k3d-model.json)          | No                                                       |
| Gateway Routing; Production TUI         | [Envoy/OCC routing](kubernetes.md#private-gateway-routing), [Helm/TUI version cutover](kubernetes.md#production-tui-tests)                                             | [Routing](../../scripts/ci/test-suites/gateway-routing.json), [TUI](../../scripts/ci/test-suites/production-tui.json) | No                                                       |
| Slack Live; Provider Account            | [Live Slack isolation, issued credentials and model turns](slack.md)                                                                                                   | [Slack](../../scripts/ci/test-suites/slack.json), [Account](../../scripts/ci/test-suites/provider-account.json)       | No                                                       |
| OpenShell                               | [Sandbox enforcement and first-Agent flows](openshell.md)                                                                                                              | [OpenShell](../../scripts/ci/test-suites/openshell.json)                                                              | With `full-qa`; Compose-only with `qa-openshell-compose` |
| Local Kubernetes Installation           | [Installation/recovery, including Keycloak](kubernetes.md#local-kubernetes-installation)                                                                               | [Installation](../../scripts/ci/test-suites/dev-up-k3d.json)                                                          | With `full-qa`                                           |
| Logging Collector                       | [Collector forwarding and recovery](local.md#metrics-and-observability-tests)                                                                                          | [Collector](../../scripts/ci/test-suites/logging-collector.json)                                                      | Yes: CI                                                  |
| k3d OTEL; Helper Timeout                | [Real runtime OTLP logs](local.md#kubernetes-observability-acceptance); 300-second worker readiness deadline                                                           | [OTEL](../../scripts/ci/test-suites/k3d-otel.json), [Timeout](../../scripts/ci/test-suites/helper-timeout.json)       | No                                                       |
| Shipped Installation QA Matrix          | [All installation/preset/scenario combinations](#qa-matrix)                                                                                                            | [QA](../../scripts/ci/test-suites/qa-matrix.json)                                                                     | With `full-qa`; see QA scenarios                         |

### Observability Demo

`Demo Observability Smoke` checks the chart, metrics/log ingestion and rendered
dashboards. See the [suite guide](local.md#kubernetes-observability-acceptance)
and [exact manifest](../../scripts/ci/test-suites/k3d-observability-demo.json).

### No GitHub workflow entrypoint

These lanes are excluded from `ci`, `full`, and Full Integration dispatch:

- [`egress-connected`](static-egress.md#select-the-prepared-connected-lane): select explicitly after preparing the protected controller, database, authenticated OpenShell stack, and synthetic HTTPS origin. CI runs the request preflight in `checks-baseline-2`; the generic `openshell` lane does not run this qualification.
- [`egress-custody-installed`](protected-repository-custody.md): qualify repository dispatch and response custody on a separately prepared controller and OpenShell pair, with an independent dispatch observer.
- `repository-credentials-live`: requires an authorized disposable repository and cleanup. See [repository credentials](repository-credentials.md).
- `repository-credentials-installed`: temporarily refused pending safe remote cleanup. See [installed Agent qualification](repository-credentials.md#qualify-an-installed-agent-against-github).
- `postgres-azure-workload-identity`: see [Azure PostgreSQL tests](postgresql.md#azure-workload-identity-connections).
- `ssh-host`: requires a disposable Linux/systemd host. Its optional model selector adds provider execution. See [SSH tests](ssh.md).
- `plugin-model`: requires a disposable cluster with Envoy Gateway and cert-manager, its Gateway CA certificate and key, an authorized Codex account, an immutable Agent image and three distinct scenario databases. See [plugin tests](plugins.md#native-runtime-prerequisites).
- `openshell-linear`: starts a shipped OpenShell installation and verifies a Linear read through a normal Agent turn. It requires the connected-account file, model and read fixture from [Linear qualification](openshell.md#linear-tool-use-qualification).
- `k3d-two-cluster`: requires two separately prepared clusters, a private configuration file and an OpenAI API key. See [two-cluster validation](kubernetes.md#two-cluster-validation).
- `openshell-oauth`: requires a prepared OpenShell OAuth gateway, trust files, tokens and a Kubernetes context. See [OpenShell OAuth tests](openshell-oauth.md).
- `image-pair-qualification`: requires staged old and new controller and broker images. See [image-pair qualification](docker.md#repository-image-pair-qualification).

### Results and cleanup

Selected lanes reject missing/skipped/TODO cases (skipped suites and Go tests too), failures, and cleanup errors. Results prove only selected coverage: inspect outcomes, source, cleanup and image digests. Retries have attempt-specific artifacts and replace the current result. Kubernetes preparation failures retain sanitized diagnostics when collection succeeds. Missing state or empty inventory does not prove cleanup.

Prepare infrastructure on a disposable host. Keep the private state file until cleanup completes:

```sh
node scripts/ci/prepare.mjs --lane <lane> --state <private-state-file>
node scripts/ci/run-tests.mjs run <lane> --state <private-state-file> --results <results-file>
node scripts/ci/cleanup.mjs --state <private-state-file>
```

Run cleanup after preparation or test failures too. See [local browser diagnostics](local.md#browser-failure-diagnostics) and the [CI flow](../flows/github-actions-testing.md) for failure evidence.

For focused local proof, first validate the exact manifest path with
`node scripts/ci/run-tests.mjs check-selection <lane> --file <manifest-path>`.
Then prepare the lane and pass the same `--file` argument to `run`. Omit `--file`
for the complete lane. The composite action validates focused selection before
tool setup or preparation; an unknown path, path alias, or another lane's file fails.

## Guides

### Run a protected integration lane

Configure [integration environments](#environments), inspect the
commit, then dispatch the selected lane or `all` on `main`:

```sh
gh workflow run full-integration.yml --ref main -f lane=all
```

Branch exceptions are listed above. `qa_repository_fixture` applies to both
`qa-matrix` and `all`; QA and focused Slack share a serial execution path.

### Run the hosted local installation lane

```sh
gh workflow run full-integration.yml --ref '<reviewed-branch>' -f lane=dev-up-k3d
```

Check `headSha` and `full-results-dev-up-k3d`; every case must pass without skips.
The 180-minute job budget includes setup/cleanup. Advisory results use
`qa-advisory-local-installation-dev-up-k3d`; OpenShell uses `qa-advisory-openshell`.
