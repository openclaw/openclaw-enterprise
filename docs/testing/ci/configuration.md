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

Full Integration runs on `main` when a scheduled tick passes
[admission](full-integration.md#trigger), or when the dispatcher approves a
manual run through `integration-main-approval`. The approval environment has
no secrets or variables. Set its sole required reviewer to
`@openclaw/maintainers-oce`, allow self-review, and disable administrator
bypass. Both environments must have exactly one custom deployment rule for
branch `main`. Keep `integration-main` free of required reviewers so admitted
scheduled runs do not wait for approval.

After a manual approval, preflight reads the environment policy and the run's
review history with the workflow token. The approved review must name the exact
approval environment and match the dispatcher's user ID and triggering login.
Missing, rejected, conflicting, or unverifiable reviews fail before
`integration-main` jobs start. Repository write access alone does not authorize
a manual dispatch.

To retry a scheduled or manual run, start a new approved manual dispatch on
`main`. Each credentialed job checks the event and attempt before reading
credentials. Preflight rejects extra branches, tags, incomplete policy metadata,
and a missing or enabled bypass flag.

The separate `integration-qa-pr` environment permits `main` and
`refs/pull/*/merge`. Its [fixed coverage labels](qa-advisory.md#trigger) select full QA, Compose
OpenShell, Keycloak installation, or OpenClaw model/browser advisory runs. Keep its two secret values separate from `integration-main`.
Full Integration preflight does not govern this environment.

Full Integration rejects tags and all branch dispatches outside `main`. Check
the source commit before dispatch and confirm the run's `headSha` matches it.

`dev-up-k3d` and `skipper-prepared-git-installed` need no credential environment,
but manual runs still require `main` and the dispatcher's team approval. The Skipper job uses synthetic, job-local model and Git credentials for the
[installed private Git fixture](../repository-credentials.md#verify-prepared-native-git)
and a GitHub Actions cache token to build images. `helper-timeout` and standalone
`logging-collector` also need no environment, but both require `main`.

The table distinguishes secret names from variable names. The common runtime
image variables are optional `OCC_TEST_KUBERNETES_GATEWAY_IMAGE` and
`OCC_TEST_KUBERNETES_AGENT_IMAGE`; unset values use preparation's builds/defaults.
`CONTAINER_NODE_BASE_IMAGE` remains a shared repository setting.

| GitHub environment  | Used by                                                                                      | Secrets                                                                      | Variables                                                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration-main`  | Full Integration: Docker Model Runtime, k3d Model Runtime, Production TUI                    | `OPENAI_API_KEY`                                                             | `OCC_TEST_OPENAI_MODEL`, `NODE_BASE_IMAGE`; Docker: `OCC_DOCKER_RUNTIME_IMAGE`; k3d: common runtime images; TUI: `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`, `OCC_TEST_KUBERNETES_RUNTIME_IMAGE`, `OCC_TEST_PRODUCTION_POSTGRES_IMAGE`, `OCC_TEST_PRODUCTION_NODE_IMAGE`. |
| `integration-main`  | Full Integration: Gateway Routing                                                            | `OPENAI_API_KEY`                                                             | `OCC_TEST_OPENAI_MODEL`, common runtime images.                                                                                                                                                                                                                       |
| `integration-main`  | Full Integration: k3d OTEL                                                                   | `OPENAI_API_KEY`                                                             | `OCC_TEST_OPENAI_MODEL`, `NODE_BASE_IMAGE`, common runtime images.                                                                                                                                                                                                    |
| `integration-main`  | Full Integration: Slack Live                                                                 | `OPENAI_API_KEY`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SENDER_TOKEN` | `OCC_TEST_OPENAI_MODEL`, common runtime images, `OCC_TEST_QA_SLACK_CHANNEL_ID`.                                                                                                                                                                                       |
| `integration-main`  | Full Integration: OpenShell                                                                  | `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`                                       | `OCC_TEST_OPENAI_MODEL`, common runtime images, `OCC_TEST_OPENSHELL_GATEWAY_IMAGE`, `OCC_TEST_OPENSHELL_SANDBOX_IMAGE`, `OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE`, `OCC_TEST_OPENSHELL_SECRET_PROJECTION` (default `1`).                                                  |
| `integration-qa-pr` | QA Matrix Advisory: QA advisory (compose), QA advisory (kubernetes), QA advisory (OpenShell) | `CODEX_ACCESS_TOKEN`, `OPENAI_API_KEY`                                       | `OCC_TEST_QA_CODEX_MODEL` and `OCC_TEST_OPENAI_MODEL`. Code on `main` and selected trusted PRs receives these credentials.                                                                                                                                            |
| `integration-main`  | Full Integration: Shipped Installation QA Matrix                                             | `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`                                       | `OCC_TEST_QA_OPENAI_MODEL`, `OCC_TEST_QA_CODEX_MODEL`.                                                                                                                                                                                                                |

`NODE_BASE_IMAGE` is a separate variable consumed by selected Full Integration
jobs; it is not an alias for `CONTAINER_NODE_BASE_IMAGE`. Model/image requirements
and defaults differ by lane: follow its linked suite guide. Missing required
inputs fail selected lanes.

OpenShell image overrides must retain the pinned release digest, or use the
[complete candidate image and chart selection](openshell-execution.md#select-candidate-images-and-charts)
during local preparation. Hosted jobs do not acquire candidate source checkouts
or charts from image variables alone.

QA model overrides default to `gpt-6-luna`.

For hosted QA scenario exclusions, see [Full Integration](full-integration.md#scenarios).

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
Preparation also selects the verified Gateway image in the host container engine
for `OCC_DOCKER_RUNTIME_IMAGE`, used by the loopback Gateway relay. Kubernetes
selectors use the separately verified references imported into the cluster.

Before a cold local source build, [check for an exact-source retained CI runtime](run-lanes.md#find-a-retained-runtime-before-building-locally). This discovers candidate artifacts; it does not import or qualify them.

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

## Rehearse a controller and broker upgrade with a running Agent

Use a dedicated amd64 runner with the installed lane's Kubernetes, Docker and
synthetic model prerequisites. The baseline is commit
`54bfa7fc1b99e362450beb5f9211e164991fa7b4`. Set
`OCC_SKIPPER_PREVIOUS_CHECKOUT` to its clean checkout. Stage these image inputs:

| Variable                                                                           | Required input                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_DEVELOPMENT_CONTROLLER_IMAGE`                                                 | Published baseline controller at `ghcr.io/openclaw/openclaw-enterprise-controller@sha256:968ef69a70c0f2ac927e0e7515ba8c07c9887e7b23211351f58bbf706662ffed` |
| `OCC_KUBERNETES_RUNTIME_IMAGE`                                                     | Baseline runtime with the test model's CA. Use its matching `OCC_FIRST_AGENT_SMOKE_MODEL_DIRECTORY`.                                                       |
| `OCC_DEVELOPMENT_REPOSITORY_IMAGE`                                                 | Digest-pinned broker built from the baseline                                                                                                               |
| `OCC_SKIPPER_CANDIDATE_CONTROLLER_IMAGE`, `OCC_SKIPPER_CANDIDATE_REPOSITORY_IMAGE` | Digest-pinned candidate pair available to Docker and pullable by the k3d node                                                                              |

Keep the upgrade checkout clean. Set `GITHUB_SHA` to its commit and use a fresh
numeric `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`. Use the dedicated runner's
loopback ports 3000, 6443 and 8443, with its development Console hostname
resolving to loopback. Use the default First Agent Smoke slot (0), a dedicated
Docker daemon with the baseline images loaded, and the candidate checkout's
frozen pnpm dependencies. The baseline `prepared-git-images` command generates the matching model TLS
files. The runner copies that certificate and key into its own model directory
with the candidate's command fixture.
Full Integration dispatch on `main` selects the withdrawal case. To run this
rehearsal on a hosted runner, provision a separate job with the same tool and
sandbox setup, stage both releases, and run the command below. The rehearsal
writes private evidence outside the ordinary CI receipt aggregation.

```sh
host=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
TMPDIR=/tmp OCC_DEVELOPMENT_PREPARED_GIT_HOST_IP="$host" \
  node scripts/qualification/skipper-private-git-fixture.mjs -- \
  node scripts/ci/skipper-prepared-git-installed.mjs --upgrade
```

The baseline CLI installs the old release. The test deploys two Agents, stops
one, and records a conversation turn, workspace marker and private commit on
the other. The candidate runs `scripts/upgrade-production-images` in preflight
and apply modes. Success requires the same conversation history, retained
workspace and a fresh Git fetch under the renewed standing session. The
installed client must refuse a push to another ref, the broker must refuse a
new fetch from an unregistered repository, and the stopped Agent must retain
its revision history without starting.

A legacy-policy preflight refusal fails this test. The test also checks that
the old writers and Agent still serve. The run directory retains private logs
and upgrade evidence. Reconcile unfinished preflight or apply operations
before removing retained cluster resources. The outer fixture closes its
temporary issuer and Git origin when the command exits. The controlled model
and native sender cover the runtime with its fixture trust layer. Protected
senders require their own installed proof.
