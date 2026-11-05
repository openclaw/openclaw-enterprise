---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

# Configure CI

Set Actions variables/secrets under **Settings → Secrets and variables → Actions**
or the named **Settings → Environments** entry. Keep provider credentials in
their environments. GitHub supplies workflow/cache tokens automatically.
Manual dispatch inputs are per-run values; use the owning check page for commands.

## Shared settings

Native image checks use the [release build settings](../../release/configuration.md#build-settings).

Ordinary CI, First Agent Smoke, and Observability Demo
need no provider secrets. Runner labels, tool pins, triggers, timeouts, and job
permissions are set in the [workflow files](../../../.github/workflows);
[test lane definitions](../../../scripts/ci/test-suites.json) list required inputs.

<a id="integration-environments"></a>

## Environments

Full Integration uses `integration-main` for its credentialed jobs. Main dispatch
requires exactly one custom deployment rule: branch `main`, with no required
reviewers. Disable administrator bypass. Preflight rejects a broader branch rule,
a tag rule, incomplete rule metadata, or an enabled bypass flag. If the API omits
the bypass flag, verify it separately in the environment settings.

The temporary proof route runs `all` after a push to exactly
`dev/kevinlin/integration-main-cutover`. On that same branch, a manual dispatch
can select only `qa-matrix` with the `isolated` fixture. This dispatch runs
`git-write` and `git-push-denied` on dedicated Codex across Compose and k3d,
including remote cleanup. It selects no Slack scenario and receives no Slack
credentials. Its separate `full-integration-isolated-repository-proof` queue
serializes runs against that distinct repository. The default push proof keeps
all supported scenarios and both presets; the focused proof does not replace it.
Both routes require
`kevinlin-openai` as the actor and rerun actor in this repository, and exactly two
environment branch rules: `main` and the named cutover branch. Remove the proof
routes and temporary branch rule after verification.

The separate `integration-qa-pr` environment permits `main` and
`refs/pull/*/merge`. Its `full-qa` and `qa-openshell-compose` labels select
advisory runs. Keep its two secret values separate from `integration-main`.
Full Integration preflight does not govern this environment.

Full Integration rejects tags and other credentialed branch dispatches. Check
the source commit before dispatch and confirm the run's `headSha` matches it.

`dev-up-k3d` and `skipper-prepared-git-installed` accept branches without a
GitHub environment. The Skipper job uses synthetic, job-local model and Git credentials for the
[installed private Git fixture](../repository-credentials.md#verify-prepared-native-git)
and a GitHub Actions cache token to build images. `helper-timeout` and standalone
`logging-collector` also need no environment, but both require `main`.

The table distinguishes secret names from variable names. The common runtime
image variables are optional `OCC_TEST_KUBERNETES_GATEWAY_IMAGE` and
`OCC_TEST_KUBERNETES_AGENT_IMAGE`; unset values use preparation's builds/defaults.
`CONTAINER_NODE_BASE_IMAGE` remains a shared repository setting.

| GitHub environment  | Used by                                                                                      | Secrets                                                                                                                                   | Variables                                                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration-main`  | Full Integration: Docker Model Runtime, k3d Model Runtime, Production TUI                    | `OPENAI_API_KEY`                                                                                                                          | `OCC_TEST_OPENAI_MODEL`, `NODE_BASE_IMAGE`; Docker: `OCC_DOCKER_RUNTIME_IMAGE`; k3d: common runtime images; TUI: `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`, `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`, `OCC_TEST_PRODUCTION_POSTGRES_IMAGE`, `OCC_TEST_PRODUCTION_NODE_IMAGE`. |
| `integration-main`  | Full Integration: Gateway Routing                                                            | `OPENAI_API_KEY`                                                                                                                          | `OCC_TEST_OPENAI_MODEL`, common runtime images.                                                                                                                                                                                                                       |
| `integration-main`  | Full Integration: k3d OTEL                                                                   | `OPENAI_API_KEY`                                                                                                                          | `OCC_TEST_OPENAI_MODEL`, `NODE_BASE_IMAGE`, common runtime images.                                                                                                                                                                                                    |
| `integration-main`  | Full Integration: Slack Live                                                                 | `OPENAI_API_KEY`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SENDER_TOKEN`                                                              | `OCC_TEST_OPENAI_MODEL`, common runtime images, `OCC_TEST_QA_SLACK_CHANNEL_ID`.                                                                                                                                                                                       |
| `integration-main`  | Full Integration: OpenShell                                                                  | `CODEX_ACCESS_TOKEN`                                                                                                                      | `OCC_TEST_OPENAI_MODEL`, common runtime images, `OCC_TEST_OPENSHELL_GATEWAY_IMAGE`, `OCC_TEST_OPENSHELL_SANDBOX_IMAGE`, `OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE`, `OCC_TEST_OPENSHELL_SECRET_PROJECTION` (default `1`).                                                  |
| `integration-qa-pr` | QA Matrix Advisory: QA advisory (compose), QA advisory (kubernetes), QA advisory (OpenShell) | `CODEX_ACCESS_TOKEN`, `OPENAI_API_KEY`                                                                                                    | `OCC_TEST_QA_CODEX_MODEL`, `OCC_TEST_OPENAI_MODEL`, and Calendar settings below. Code on `main` and selected trusted PRs receives these credentials.                                                                                                                  |
| `integration-main`  | Full Integration: Shipped Installation QA Matrix                                             | `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SENDER_TOKEN`, plus repository fixture secrets below | `OCC_TEST_QA_OPENAI_MODEL`, `OCC_TEST_QA_CODEX_MODEL`, `OCC_TEST_QA_SLACK_CHANNEL_ID`, Calendar settings.                                                                                                                                                             |

`NODE_BASE_IMAGE` is a separate variable consumed by selected Full Integration
jobs; it is not an alias for `CONTAINER_NODE_BASE_IMAGE`. Model/image requirements
and defaults differ by lane: follow its linked suite guide. Missing required
inputs fail selected lanes.

Calendar requires variables `OCC_TEST_CODEX_CALENDAR_TOOL_NAME` and
`OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT`; `OCC_TEST_CODEX_CALENDAR_PROMPT` is
optional. QA model overrides default to `gpt-6-luna`.

Default repository QA reads
[`scripts/ci/qa-repositories/default.json`](../../../scripts/ci/qa-repositories/default.json)
and secret `REPOSITORY_APP_KEY`. Isolated QA reads
[`isolated.json`](../../../scripts/ci/qa-repositories/isolated.json), secret
`QA_ISOLATED_REPOSITORY_APP_KEY`, and variable `QA_ISOLATED_REPOSITORY_FULL_NAME`.
The isolated registry must contain exactly that lowercase `owner/repository`,
different from this workflow repository. The metadata files contain no private
keys. Before either fixture writes credentials, hosted QA fetches GitHub Meta and selects the public IPv4 networks in both the `api` and `git` categories. The worker uses those networks on TCP 443. Each fixture mints short-lived observer tokens from its selected App. No static observer token is required. Missing or mismatched inputs
fail without fallback.

Every `integration-main` job can reference its combined secret set. Workflow
steps pass only their selected inputs to tests. Preserve the old environments
until credential migration and hosted verification are complete.

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
| `OPENCLAW_CI_IMAGE_CACHE_EXPORT_TIMEOUT_MS` | `1200000`                                 | Maximum time for a hosted BuildKit cache export.                                   |
| `OPENCLAW_CI_BROWSER_FAILURE_DIR`           | Unset                                     | Retain browser failure evidence locally.                                           |
| `OPENCLAW_CI_BROWSER_FAILURE_TRACE`         | Unset                                     | Set `1` to include Playwright traces.                                              |

Cleanup timeout/grace overrides that are not positive numbers use defaults.
Deadlines include pipe drain; a wait timeout does not prove deletion. Preparation
verifies imported image references on every node and fails on import timeout.
