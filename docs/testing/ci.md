# CI configuration and testing

## Overview

Configure GitHub Actions variables, secrets, environments, and local runner overrides. Use this page to run integration lanes and inspect their results; the [workflow cheat sheet](../reference/cheatsheets/github-actions.md) lists triggers and blocking failures.

## Checks and gates

| Check                             | When it runs               | Blocks merge               | GitHub Actions                                                                                                     |
| --------------------------------- | -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| CI                                | Every PR                   | Yes, through `CI Required` | [ci.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/ci.yml)                                 |
| First Agent Smoke (job within CI) | [Every PR](#pr-exceptions) | No                         | [ci.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/ci.yml)                                 |
| QA Matrix Advisory                | [Every PR](#pr-exceptions) | No                         | [qa-advisory.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/qa-advisory.yml)               |
| Full Integration                  | Manual                     | No                         | [full-integration.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/full-integration.yml)     |
| Observability Demo                | [Every PR](#pr-exceptions) | No                         | [observability-demo.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/observability-demo.yml) |
| Publish private documentation     | Manual                     | No                         | [docs-pages.yml](https://github.com/openclaw/openclaw-enterprise/actions/workflows/docs-pages.yml)                 |

### PR exceptions

- **First Agent Smoke:** skips docs-only and recognized test-only PRs.
- **QA Matrix Advisory:** skips fork and Dependabot PRs.
- **Observability Demo:** runs only when the changed files match its workflow path filters.

The table shows PR or manual entrypoints. Some workflows also run on pushes or
merge groups; documentation deploys automatically on `main` pushes. See the
[workflow cheat sheet](../reference/cheatsheets/github-actions.md) for those triggers.

In the CI workflow, docs-only PRs run static checks without product tests. Test-only PRs select
affected CI suites; other changes and main pushes run all ordinary CI test lanes. QA advisory and
Full Integration are separate workflows, not prerequisites for publication.

`CI Required` is the required status check on `main`; branch rules can change.
There is no automatic integration-test gate for each Agent or platform deployment.
The documentation deployment is separate. See the [workflow cheat sheet](../reference/cheatsheets/github-actions.md)
for the complete workflow index and the [publication flow](../flows/container-publication.md)
for artifact gates.

## CI configuration

Configure Actions variables and secrets under repository **Settings → Secrets
and variables → Actions**, or under the named **Settings → Environments** entry.
Keep provider credentials in their environment, not repository-wide secrets.
The tables list operator settings; GitHub supplies `GITHUB_TOKEN` and cache
runtime tokens automatically. Local test selectors stay in their suite guides.
Manual dispatch inputs are per-run values, not saved settings: use the commands
below for test lanes and the [publication runbooks](../reference/cheatsheets/github-actions.md#details)
for source/run IDs and publication switches.

### Shared settings

| Repository variable         | Required/default                                                | Purpose                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTAINER_NODE_BASE_IMAGE` | Required for native builds and publication; no approved default | Full Node 24 `image@sha256:...` matching `scripts/ci/test-suites/images-packaging.json` and `deploy/runtime/Dockerfile`. Use repository or organization scope: preparation has no environment. |
| `CONTAINER_AMD64_RUNNER`    | Optional; `blacksmith-16vcpu-ubuntu-2404`                       | Native AMD64 image checks.                                                                                                                                                                     |
| `CONTAINER_ARM64_RUNNER`    | Optional; `blacksmith-8vcpu-ubuntu-2404-arm`                    | Native ARM64 image checks.                                                                                                                                                                     |
| `CODEQL_ENABLED`            | Public repositories need no setting                             | For private repositories, set `true` only after approved, licensed Code Security advanced setup.                                                                                               |

Runner overrides must select provisioned Linux runners with the matching
architecture, at least four CPUs, 12 GiB RAM, and enough disk for the build.
Ordinary CI, First Agent Smoke, cache warming, Storybook, and Observability Demo
need no provider secrets. Runner labels, tool pins, triggers, timeouts, and job
permissions are set in the [workflow files](../../.github/workflows);
[test lane definitions](../../scripts/ci/test-suites.json) own required inputs.

### Integration environments

Create only environments needed by selected lanes. Full Integration preflight
requires no required reviewers. Its environments allow protected branches or a
custom policy containing `main`; `integration-provider-account` instead requires
exactly one custom rule: branch `main`. The advisory `integration-qa-pr` environment
must permit trusted PR jobs; Full Integration preflight does not govern it.

Only `k3d-model`, `openshell`, and credential-free `dev-up-k3d` accept a branch
dispatch. For the first two, temporarily add the exact reviewed branch to the
corresponding custom environment policy, preserving `main`; a wildcard alone
does not authorize it. Remove the exception afterward. `dev-up-k3d`,
`helper-timeout`, and standalone `logging-collector` need no environment.

The table distinguishes secret names from variable names. The common runtime
image variables are optional `OCC_TEST_KUBERNETES_GATEWAY_IMAGE` and
`OCC_TEST_KUBERNETES_AGENT_IMAGE`; unset values use preparation's builds/defaults.
`CONTAINER_NODE_BASE_IMAGE` remains a shared repository setting.

| Environment / lanes                              | Secrets                                                                                                                                   | Variables                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration-model`: Docker, k3d, production TUI | `OPENAI_API_KEY`                                                                                                                          | `OCC_TEST_OPENAI_MODEL`, `NODE_BASE_IMAGE`; Docker: `OCC_DOCKER_RUNTIME_IMAGE`; k3d: common runtime images; TUI: `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`, `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`, `OCC_TEST_PRODUCTION_POSTGRES_IMAGE`, `OCC_TEST_PRODUCTION_NODE_IMAGE`. |
| `integration-routing`: gateway routing           | `OPENAI_API_KEY`                                                                                                                          | `OCC_TEST_OPENAI_MODEL`, common runtime images.                                                                                                                                                                                                                       |
| `integration-otel`: runtime logs                 | `OPENAI_API_KEY`                                                                                                                          | `OCC_TEST_OPENAI_MODEL`, `NODE_BASE_IMAGE`, common runtime images.                                                                                                                                                                                                    |
| `integration-slack`: Slack                       | `OPENAI_API_KEY`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `OCC_TEST_SLACK_SENDER_BOT_TOKEN`                                                 | `OCC_TEST_OPENAI_MODEL`, common runtime images, `OCC_TEST_SLACK_PROXY_URL`, `OCC_TEST_SLACK_CHANNEL_ID`.                                                                                                                                                              |
| `integration-provider-account`: service account  | `OCC_TEST_CHATGPT_ADMIN_KEY_JSON`                                                                                                         | `OCC_TEST_CHATGPT_WORKSPACE_ID`, `OCC_TEST_OPENAI_MODEL`, common runtime images.                                                                                                                                                                                      |
| `integration-openshell`: OpenShell               | `CODEX_ACCESS_TOKEN`                                                                                                                      | `OCC_TEST_OPENAI_MODEL`, common runtime images, `OCC_TEST_OPENSHELL_GATEWAY_IMAGE`, `OCC_TEST_OPENSHELL_SANDBOX_IMAGE`, `OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE`, `OCC_TEST_OPENSHELL_SECRET_PROJECTION` (default `1`).                                                  |
| `integration-qa-pr`: advisory QA and OpenShell   | `CODEX_ACCESS_TOKEN`                                                                                                                      | `OCC_TEST_QA_CODEX_MODEL`, `OCC_TEST_OPENAI_MODEL`, and Calendar settings below. Trusted PR code receives these credentials.                                                                                                                                          |
| `integration-qa`: complete QA matrix             | `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SENDER_TOKEN`, plus repository fixture secrets below | `OCC_TEST_QA_OPENAI_MODEL`, `OCC_TEST_QA_CODEX_MODEL`, `OCC_TEST_QA_SLACK_CHANNEL_ID`, Calendar settings, `REPOSITORY_UPSTREAM_CIDRS_JSON`.                                                                                                                           |

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

### Publication configuration

Protect `main`, require `CI Required`, and review workflow changes. Publication
requires the entire exact-source main-push CI run to succeed, including First Agent Smoke. Repository writers can dispatch;
there is no second-person approval or approval-comment requirement.

Create a separate `container-publish` environment: no required reviewers or wait
timer, administrator bypass disabled, and exactly one deployment rule, branch
`main`. The validator enforces the name, bypass, and branch policy, not reviewer
or timer settings. Do not reuse integration environments.

| Environment setting                                               | Required for                                             | Value                                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Variables `GHCR_CONTROLLER_IMAGE`, `GHCR_RUNTIME_IMAGE`           | Bootstrap, image publication/recovery, chart publication | Distinct full `ghcr.io/openclaw/...` names without tags or digests.                                                                               |
| Variables `DOCKERHUB_CONTROLLER_IMAGE`, `DOCKERHUB_RUNTIME_IMAGE` | Docker Hub promotion                                     | Distinct pre-existing private `docker.io/<namespace>/<repository>` names without tags or digests. Creation needs separate operator authorization. |
| Secret `DOCKERHUB_USERNAME`                                       | Promotion                                                | Account identifier; organization name for an organization access token.                                                                           |
| Secret `DOCKERHUB_TOKEN`                                          | Promotion                                                | Scoped PAT or organization access token with read/write access only to authorized destinations.                                                   |

GHCR uses the workflow's short-lived token with `packages: write`; no PAT is
required. Promotion uses `packages: read` and exposes Docker Hub credentials
only to transfer. Preparation has no environment or registry credentials.

Publication/recovery require the public Enterprise repository and pre-existing
public image packages; chart publication also needs public
`ghcr.io/openclaw/charts/openclaw-enterprise`. Confirm repository linkage and
**Manage Actions access** using the [package checks](../../.github/containers.md#confirm-package-linkage).
Before making packages public, inventory retained versions and grants: every
layer/chart must be intended for public release. Visibility exposes all retained
versions and cannot revert to private; use separate destinations if needed.
[Marker bootstrap](../../.github/containers.md#bootstrap-ghcr-packages) creates
private placeholders, not visibility changes or grants. Missing configuration,
conflicting identity, inaccessible metadata, or incorrect visibility stops publication.

### Other workflow setup

- **ClawSweeper:** install its App on this repository and `openclaw/clawsweeper`;
  set repository secret `CLAWSWEEPER_APP_PRIVATE_KEY`. Dispatch tokens need
  contents write on ClawSweeper; acknowledgement tokens need issues write and
  pull-request read here. Follow [dispatch verification](../flows/clawsweeper-dispatch.md#setup-and-first-run-verification).
- **Documentation:** select GitHub Actions as the Pages source and use
  environment `github-pages`. The job grants `pages: write` and `id-token: write`;
  no deploy secret or Cloudflare credential is needed. Domain, privacy, and
  verification remain in [documentation hosting](../contributing/documentation-hosting.md).

### Local runner overrides

These process environment variables are optional. Keep the same directory for
First Agent `images` and `run`; changing it does not isolate fixed-name containers.

| Setting                                     | Default                                                       | Purpose                                                                            |
| ------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `OCC_FIRST_AGENT_SMOKE_DIRECTORY`           | `$RUNNER_TEMP/first-agent-smoke`, or `/tmp/first-agent-smoke` | Images, certificates, and Local Setup state.                                       |
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
Deadlines include pipe drain; bounded waiting does not prove deletion. Preparation
verifies imported image references on every node and fails on import timeout.

## GitHub Actions

[CI](../../.github/workflows/ci.yml) checks selected lanes and their results at the same source commit. If CI cannot safely identify the affected tests, it runs all ordinary CI test lanes. See [checks and gates](#checks-and-gates) for triggers and blocking failures, and the [CI flow](../flows/github-actions-testing.md) for selection and result accounting.

The [suite index](../../scripts/ci/test-suites.json) and its lane files define test ownership, inputs, and resources. Check ownership with:

```sh
node scripts/ci/run-tests.mjs audit
```

Static checks include workspace, lint, format, OpenAPI, and docs checks. `pnpm docs:check-length` reports documentation word counts. The PR workflow itself is PR-controlled; the base-controlled impact selector does not prevent a changed workflow from bypassing checks. No external trusted required workflow is established here.

## First Agent smoke

`First Agent Smoke` runs automatically on PRs that change application code or
configuration, pushes to `main`, merge groups, and manual CI runs. It skips
docs-only PRs and recognized test-only PRs. It also runs when CI cannot safely
identify the affected tests.

The test installs Local Setup, deploys embedded OpenClaw and dedicated Codex
Agents, checks chat, stops and restarts them, and checks chat again. It uses a
simulated model service without provider credentials. It does not verify a real
model provider. The job summary has phase timings; failure logs include Agent
and cluster diagnostics. Its failure is outside `CI Required`; see
[checks and gates](#checks-and-gates).

On a disposable Linux host with Docker, k3d, kubectl, Helm, Go, and enforced NetworkPolicies:

```sh
go build -trimpath -o bin/occ ./cmd/occ
node scripts/ci/first-agent-smoke.mjs images
node scripts/ci/first-agent-smoke.mjs run
```

Use the optional [work-directory override](#local-runner-overrides) if needed. The script creates fixed-name containers and a Docker network. Remove them and run `occ dev down` using the printed state directory after the run. See [local Kubernetes troubleshooting](../guides/deploy/local-kubernetes-development.md#resolve-node-dns-failures) for DNS failures.

## Run a protected integration lane

[Full Integration](../../.github/workflows/full-integration.yml) is manually dispatched.
`all` selects every lane and requires their credentials and passing results.
Configure the [integration environments](#integration-environments) before dispatch.
Inspect the commit first; the workflow tests that immutable event commit.

```sh
gh workflow run full-integration.yml --ref '<approved-branch>' -f lane=k3d-model
gh workflow run full-integration.yml --ref '<approved-branch>' -f lane=openshell
```

To run every Full Integration lane on `main`:

```sh
gh workflow run full-integration.yml --ref main -f lane=all
```

The QA matrix starts after the focused Slack job finishes, even when that job fails. The aggregate requires both results. The `qa_repository_fixture` choice applies to `all` as well as `qa-matrix`.

### Run the hosted local installation lane

Run the credential-free `dev-up-k3d` lane on a reviewed branch:

```sh
gh workflow run full-integration.yml --ref '<reviewed-branch>' -f lane=dev-up-k3d
```

Check the run's `headSha` and `full-results-dev-up-k3d` artifact: all six cases must pass without skips. The job allows 180 minutes, including setup and cleanup. Trusted PRs also run this lane in QA advisory, with artifact `qa-advisory-local-installation-dev-up-k3d`. It is included in Full Integration `all` and excluded from `CI Required`.

## Manual Full Integration lanes

The QA advisory workflow also runs the full [OpenShell lane](qa-matrix.md#automatic-openshell-coverage) on trusted PRs.

| Lane                | Coverage and guide                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `qa-matrix`         | Four installation/preset combinations, including live model, Git, Calendar, and Slack. See [QA matrix](qa-matrix.md).       |
| `dev-up-k3d`        | Six local installation and recovery cases, including Keycloak. No provider credentials. Also runs in advisory PR CI.        |
| `docker-model`      | Docker Compute and real model turns. See [Docker tests](docker.md).                                                         |
| `k3d-model`         | Real runtime turns, Pod replacement, secret rotation, and first-Agent reuse. See [Kubernetes tests](kubernetes.md).         |
| `gateway-routing`   | Dedicated Codex through Envoy/OCC. See [gateway routing](kubernetes.md#private-gateway-routing).                            |
| `production-tui`    | Helm-installed control plane and TUI revision cutover. See [production TUI](kubernetes.md#production-tui-tests).            |
| `slack`             | Live Slack delivery, credentials, and proxy isolation. See [Slack tests](slack.md).                                         |
| `provider-account`  | Service-account creation, credential delivery, and a Codex turn. See [service accounts](slack.md#chatgpt-service-accounts). |
| `openshell`         | Sandbox enforcement and first-Agent flows. See [OpenShell tests](openshell.md).                                             |
| `k3d-otel`          | Real runtime OTLP logs. See [metrics tests](local.md#metrics-and-observability-tests).                                      |
| `helper-timeout`    | The full 300-second worker readiness deadline.                                                                              |
| `logging-collector` | Collector and dashboard provisioning. See [metrics tests](local.md#metrics-and-observability-tests).                        |

## No GitHub workflow entrypoint

These lanes are excluded from `ci`, `full`, and Full Integration dispatch:

- `repository-credentials-live`: requires an authorized disposable repository and cleanup. See [repository credentials](repository-credentials.md).
- `repository-credentials-installed`: temporarily refused pending safe remote cleanup. See [installed Agent qualification](repository-credentials.md#qualify-an-installed-agent-against-github).
- `postgres-azure-workload-identity`: see [Azure PostgreSQL tests](postgresql.md#azure-workload-identity-connections).
- `ssh-host`: requires a disposable Linux/systemd host. Its optional model selector adds provider execution. See [SSH tests](ssh.md).

## Results and cleanup

A selected lane fails on missing cases, skips, TODOs, failed cases, or cleanup errors. A targeted lane proves only its selected coverage. Check the job log and result artifact for case outcomes, source commit, cleanup status, and image digests. Each retry has an attempt-specific artifact; a retry replaces the lane's current result. Kubernetes preparation failures also produce a sanitized diagnostics artifact when collection succeeds. Missing state or an empty inventory is not proof of cleanup.

Prepare infrastructure on a disposable host. Keep the private state file until cleanup completes:

```sh
node scripts/ci/prepare.mjs --lane <lane> --state <private-state-file>
node scripts/ci/run-tests.mjs run <lane> --state <private-state-file> --results <results-file>
node scripts/ci/cleanup.mjs --state <private-state-file>
```

Run cleanup after preparation or test failures too. See [local browser diagnostics](local.md#browser-failure-diagnostics) and the [CI flow](../flows/github-actions-testing.md) for failure evidence.

### Cleanup command deadlines

A cleanup timeout fails the lane and retains failed resources in private state
for retry. Configure [cleanup deadlines](#local-runner-overrides) per invocation;
see [termination and ownership](../flows/github-actions-testing.md#4-clean-up-and-publish-the-bounded-result).

### Select immutable images for local preparation

Use the [K3s image override](#local-runner-overrides) only with an approved immutable
reference. Preparation verifies each node; failed imports fail the lane.

## Production observability lane

`k3d-observability` checks metrics and OTLP exports in CI. Real gateway and Codex model-log proof requires protected `k3d-otel`; see [observability acceptance](local.md#kubernetes-observability-acceptance).
