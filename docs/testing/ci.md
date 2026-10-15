# GitHub Actions testing

## Overview

This page explains which tests GitHub Actions runs and how to run additional integration lanes. It also shows where to find results and failure evidence.

## GitHub Actions

[CI](../../.github/workflows/ci.yml) runs on pull requests, pushes to `main`, merge groups, and manual dispatch. `CI Required` checks the selected lanes and their results at the same source commit. Docs-only changes run static checks without product tests; test-only changes select affected CI lanes. Other changes and unverifiable selection evidence use full CI. See the [CI flow](../flows/github-actions-testing.md) for selection and result accounting.

A green `CI Required` does not prove manual or advisory integration coverage. See [manual integration lanes](#manual-full-integration-lanes) and the [QA matrix](qa-matrix.md).

The [suite index](../../scripts/ci/test-suites.json) and its lane files define test ownership, inputs, and resources. Check ownership with:

```sh
node scripts/ci/run-tests.mjs audit
```

Static checks include workspace, lint, format, OpenAPI, and docs checks. `pnpm docs:check-length` reports documentation word counts. The PR workflow itself is PR-controlled; the base-controlled impact selector does not prevent a changed workflow from bypassing checks. No external trusted required workflow is established here.

## First Agent smoke

The non-required `First Agent Smoke` runs in full CI mode, without secrets. It installs Local Setup and deploys, chats with, stops, and restarts embedded OpenClaw and dedicated Codex Agents. Its stand-in provider proves the request path, not compatibility with a real model provider. The job summary has phase timings; failure logs include Agent and cluster diagnostics.

On a disposable Linux host with Docker, k3d, kubectl, Helm, Go, and enforced NetworkPolicies:

```sh
go build -trimpath -o bin/occ ./cmd/occ
node scripts/ci/first-agent-smoke.mjs images
node scripts/ci/first-agent-smoke.mjs run
```

Set `OCC_FIRST_AGENT_SMOKE_DIRECTORY` to choose the work directory. The script creates fixed-name containers and a Docker network. Remove them and run `occ dev down` using the printed state directory after the run. See [local Kubernetes troubleshooting](../guides/deploy/local-kubernetes-development.md#resolve-node-dns-failures) for DNS failures.

## Run a protected integration lane

[Full Integration](../../.github/workflows/full-integration.yml) is manually dispatched. `all` excludes `qa-matrix` and `dev-up-k3d`; select either explicitly. Most lanes use `main`. Users with repository write access can dispatch credentialed lanes without separate environment approval. `dev-up-k3d` is credential-free and can run on a reviewed branch. `helper-timeout` and standalone `logging-collector` have no environment gate. `provider-account` is main-only and has no per-run approval.

An administrator can permit an exact branch for `k3d-model` in `integration-model` or `openshell` in `integration-openshell`, preserving `main` and no required reviewers. Wildcards fail preflight. Inspect the commit before dispatch; the workflow tests that immutable event commit. Remove the branch rule after the run.

```sh
gh workflow run full-integration.yml --ref '<approved-branch>' -f lane=k3d-model
gh workflow run full-integration.yml --ref '<approved-branch>' -f lane=openshell
```

### Run the hosted local installation lane

Run the credential-free `dev-up-k3d` lane on a reviewed branch:

```sh
gh workflow run full-integration.yml --ref '<reviewed-branch>' -f lane=dev-up-k3d
```

Check the run's `headSha` and `full-results-dev-up-k3d` artifact: all six cases must pass without skips. The job allows 180 minutes, including setup and cleanup. Trusted PRs also run this lane in QA advisory, with artifact `qa-advisory-local-installation-dev-up-k3d`. It is excluded from `CI Required` and Full Integration `all`.

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

A cleanup timeout fails the lane and retains failed resources in private state for retry. `OPENCLAW_CI_CLEANUP_COMMAND_TIMEOUT_MS` defaults to 300000 (five minutes) per container-engine or k3d command; database drops use the smaller of this value and 60 seconds. `OPENCLAW_CI_COMMAND_KILL_GRACE_MS` defaults to 5000 (five seconds) for TERM-to-KILL and pipe closure, and also applies to preparation. Scope overrides per invocation; invalid values use defaults. Deadlines include pipe drain. Bounded waiting does not prove resource deletion. See [termination and ownership](../flows/github-actions-testing.md#4-clean-up-and-publish-the-bounded-result).

### Select immutable images for local preparation

Kubernetes lanes use the pinned K3s image in `scripts/ci/prepare.mjs`. Set `OPENCLAW_CI_K3S_IMAGE` to an approved `image@sha256:<digest>` to override it. The API server must report Kubernetes 1.35.x; OpenShell has a separate pin. Preparation verifies image references on each node; an import failure or timeout fails the lane.

## Production observability lane

`k3d-observability` checks metrics and OTLP exports in CI. Real gateway and Codex model-log proof requires protected `k3d-otel`; see [observability acceptance](local.md#kubernetes-observability-acceptance).
