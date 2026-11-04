# Configure CI

Set Actions variables/secrets under **Settings → Secrets and variables → Actions**
or the named **Settings → Environments** entry. Keep provider credentials in
their environments. GitHub supplies workflow/cache tokens automatically.
Manual dispatch inputs are per-run values; use the owning check page for commands.

## Shared settings

Public repositories need no `CODEQL_ENABLED` setting. For private repositories,
set that repository variable to `true` only after approved, licensed Code Security
advanced setup. Native image checks use the [release build settings](../../release/configuration.md#build-settings).

Ordinary CI, First Agent Smoke, cache warming, Storybook, and Observability Demo
need no provider secrets. Runner labels, tool pins, triggers, timeouts, and job
permissions are set in the [workflow files](../../../.github/workflows);
[test lane definitions](../../../scripts/ci/test-suites.json) own required inputs.

<a id="integration-environments"></a>

## Environments

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
[installed private Git fixture](../repository-credentials.md#verify-prepared-native-git)
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
| `integration-qa-pr`            | QA Matrix Advisory: QA advisory (compose), QA advisory (kubernetes), QA advisory (OpenShell) | `CODEX_ACCESS_TOKEN`, `OPENAI_API_KEY`                                                                                                    | `OCC_TEST_QA_CODEX_MODEL`, `OCC_TEST_OPENAI_MODEL`, and Calendar settings below. Code on `main` and selected trusted PRs receives these credentials.                                                                                                                  |
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

## Runner overrides

For lanes that accept optional Kubernetes runtime images, set both
`OCC_TEST_KUBERNETES_GATEWAY_IMAGE` and `OCC_TEST_KUBERNETES_AGENT_IMAGE` to
immutable references, or omit both to build from source. Supplying only one fails
preparation before state or resources are created.

These process environment variables are optional. First Agent Smoke has its own
[directories and slot settings](first-agent-smoke.md#local-isolation).

| Setting                                     | Default                                   | Purpose                                                                            |
| ------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `CI_RUNNER_TEST_TIMEOUT_MS`                 | `3600000`                                 | Per-file test deadline; hosted lane/job deadlines still apply.                     |
| `CI_RUNNER_CLEANUP_TIMEOUT_MS`              | `120000`                                  | Per-file cleanup allowance.                                                        |
| `CI_RUNNER_FILE_CONCURRENCY`                | Lane limit capped by available CPUs       | `1`–`32` for lanes permitting parallel files; serial-only lanes stay serial.       |
| `OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS`    | `300000`                                  | Container-engine/k3d cleanup command limit; database drops use at most 60 seconds. |
| `OPENCLAW_CI_COMMAND_KILL_GRACE_MS`         | `5000`                                    | TERM-to-KILL and pipe-drain grace during preparation/cleanup.                      |
| `OPENCLAW_CI_K3S_IMAGE`                     | Immutable pin in `scripts/ci/prepare.mjs` | Approved digest-pinned Kubernetes 1.35.x image; OpenShell has a separate pin.      |
| `OPENCLAW_CI_IMAGE_CACHE_EXPORT_TIMEOUT_MS` | `1200000`                                 | Bound hosted BuildKit cache export.                                                |
| `OPENCLAW_CI_BROWSER_FAILURE_DIR`           | Unset                                     | Retain browser failure evidence locally.                                           |
| `OPENCLAW_CI_BROWSER_FAILURE_TRACE`         | Unset                                     | Set `1` to include Playwright traces.                                              |

Cleanup timeout/grace overrides that are not positive numbers use defaults.
Deadlines include pipe drain; a wait timeout does not prove deletion. Preparation
verifies imported image references on every node and fails on import timeout.
