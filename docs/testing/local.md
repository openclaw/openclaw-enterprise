# Local, browser, and metrics tests

## Overview

Run local checks, browser suites, and metrics and observability tests. Start with the [requirements](README.md#requirements-and-credentials).

## Local checks

With infrastructure selectors unset, run:

```sh
pnpm check:workspace
pnpm check:modules
pnpm lint
pnpm format:check
pnpm typecheck
pnpm openapi:check
pnpm test:conformance
pnpm test:integration
```

The conformance tests cover domain and Driver contracts. Local integration
uses real API routes with test Drivers and in-memory state. Neither proves a
live cluster or model execution. SSH conformance uses local transport and
fixtures; it does not prove SSH reachability, OS account isolation, real systemd,
or OpenClaw. See the [testing index](README.md) for tests with real infrastructure.

Run one file or one named case:

```sh
node --test tests/integration/secret-api.test.mjs
node --test --test-name-pattern='part of the test name' tests/integration/secret-api.test.mjs
```

## Linting and formatting

Use `pnpm lint:fix` and `pnpm format:fix` to apply fixes; review the diff and
run the corresponding checks. Do not expand the
[lint suppression baseline](../../eslint-suppressions.json). After fixing an
existing finding, run `pnpm exec eslint . --prune-suppressions` and commit the
reduced baseline. Counts are per file and rule; review still must catch a new
finding that replaces an old one.

## Authentication and authorization coverage

`tests/conformance/iam.test.mjs` and `tests/integration/occ-api.test.mjs` cover
identity, authorization, isolation, and audit behavior. The service API key
suite uses memory storage. Run the [PostgreSQL tests](postgresql.md) for
persistence and GitHub sign-in; memory-backed success does not prove them.

`tests/integration/oidc-ca-trust.test.mjs` requires Helm, yq, and OpenSSL;
`OCC_HELM_BIN` can select Helm. It exercises loopback TLS trust and callback
transport, not a live IdP, PostgreSQL authentication, or an installed deployment.

## Packaged-driver integration

`tests/integration/driver-plugin-installation.test.mjs` installs precompiled
Driver tarballs in an isolated dependency root and exercises production startup
with in-memory state. It does not prove database persistence, Kubernetes, a real
gateway, or a model turn.

## Console browser checks

On a host approved for browser automation:

```sh
pnpm exec playwright install chromium
pnpm test:console-browser
```

Set `OCC_TEST_BROWSER_EXECUTABLE` to use an approved existing browser. The test
fails if no browser is available; it does not install one. Do not change managed
browser policies. Set `OCC_TEST_CONSOLE_ARTIFACT_DIR` to retain screenshots.

The browser fixture uses real controller routes with in-memory state and test
Drivers. It does not prove persistence, routing through a deployed gateway, or
Agent runtime behavior. The API checks can run without a browser:

```sh
node --test tests/integration/console-api.test.mjs
```

### Browser failure diagnostics

Failed `checks-browser` CI lanes retain `browser-failures-*` artifacts for three
days. Use the [CI evidence overrides](ci.md#local-runner-overrides) to collect them
locally, including an optional Playwright trace. Open a trace with
`pnpm exec playwright show-trace`.

## Repository and tooling configuration

The repository pins Node and pnpm requirements in [package.json](../../package.json).
After changing API routes or schemas, run `pnpm openapi:generate`, then
`pnpm openapi:check`. To check the generated Markdown against the existing
OpenAPI contract without controller dependencies, run:

```sh
node scripts/generate-occ-api-reference.mjs --check
```

Run `pnpm hooks:install` to reinstall the managed pre-push hook. It refuses to
replace an unmanaged hook and preserves `core.hooksPath`. The hook checks files
on disk in the active checkout, including unstaged edits. To verify formatting
for a trusted outgoing commit, run `pnpm format:check` in a clean, isolated
checkout of its exact commit ID with matching dependencies already installed.

## Metrics and observability tests

### Start the development dashboard

Start the [Compose quickstart](../guides/quickstart.md) first. This overlay
recreates the API and worker, so allow existing work to finish. Use the same
Compose project and `.env`. Run this block in Bash (start `bash` first if your
shell is zsh):

```bash
read -rs -p 'Development Grafana password: ' OCC_METRICS_GRAFANA_PASSWORD
printf '\n'
export OCC_METRICS_GRAFANA_PASSWORD
docker compose -f compose.yaml -f compose.metrics.yaml up -d --build
```

Open `http://127.0.0.1:3001`, sign in as `admin`, and select **OCC → OCC
observability**. In Prometheus at `http://127.0.0.1:9090`, query
`up{job=~"occ-api|occ-worker"}` after about 15 seconds; expect two series at
`1`. Remote-write targets do not appear on the server's Targets page. Set
`OCC_GRAFANA_PORT` or `OCC_PROMETHEUS_PORT` if a port is in use.

Use a trusted development machine: the server accepts unauthenticated remote
writes on the development network. Grafana state is disposable; back up data
that you need before recreating it. For Podman, include `compose.podman.yaml` and
the selected socket as described in the quickstart.

A draft Agent can exercise inventory metrics. The current Docker Driver rejects
Agent harness authentication bindings, so its real Agent model scenarios fail
at admission; the dashboard does not establish a deployed Agent or model turn.
Use [Kubernetes runtime tests](kubernetes.md) for that proof.

### Troubleshoot and stop

Rate panels need at least two scrapes. Missing inventory data does not mean zero
Agents. For failures, inspect `docker compose -f compose.yaml -f compose.metrics.yaml
logs --tail=100 metrics-api metrics-worker prometheus grafana` and check remote
writes, datasource URL, project/network, and mounts.

```sh
docker compose -f compose.yaml -f compose.metrics.yaml stop metrics-api metrics-worker grafana prometheus
docker compose -f compose.yaml -f compose.metrics.yaml rm -f metrics-api metrics-worker grafana prometheus
unset OCC_METRICS_GRAFANA_PASSWORD
```

To disable OCC listeners, recreate the API and worker with the original
quickstart Compose files. Keep PostgreSQL volumes, `.env`, and Agent workloads;
do not use `down -v` to clean up monitoring.

### Automated proof

With an exclusively used disposable database from [PostgreSQL setup](postgresql.md), run:

```sh
OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_test_local \
OCC_METRICS_TEST_MIGRATION_DATABASE_URL=postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/openclaw_test_local \
  node --test tests/integration/occ-metrics.test.mjs
```

The migration URL must target the same database; without it the lock case skips.
This verifies instrumentation and persistence with a Compute fixture, not live
workload readiness.

On Linux with Podman, run the real monitoring containers:

```sh
OCC_TEST_METRICS_MONITORING=1 OCC_METRICS_TEST_ENGINE=podman \
  node --test tests/integration/occ-metrics-monitoring.test.mjs
```

Use `docker` for Docker Engine. The test removes its randomly named containers.
It proves collection and dashboard provisioning, not live Agent behavior.

### Kubernetes observability acceptance

With Node 24+, pinned pnpm and installed dependencies, Helm, kubectl, k3d,
and Docker or an explicitly selected compatible Podman engine, run the
credential-free lane on a disposable loopback cluster. NetworkPolicy must be
enforced. Use a fresh private state directory for each run:

```sh
OBS_LANE=k3d-observability
OBS_RUN_DIR=$(mktemp -d)
env -u OPENAI_API_KEY node scripts/ci/prepare.mjs --lane "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" && \
  env -u OPENAI_API_KEY node scripts/ci/run-tests.mjs run "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" --results "$OBS_RUN_DIR/results.json"
```

Inspect the exit status and result counts, including skips. After preparation
or testing, including failure, run `node scripts/ci/cleanup.mjs --state
"$OBS_RUN_DIR/state.json"`. Retain state if cleanup fails. After interruption,
confirm owned subprocesses have stopped before cleanup. See [CI testing](ci.md).

This lane checks Helm-installed OCC metrics and logs, with no model calls or
Prometheus, Grafana, or Loki. For the demo smoke, install Playwright Chromium
with `pnpm exec playwright install --with-deps chromium`, use a fresh directory,
and set `OBS_LANE=k3d-observability-demo` in the commands above. It checks a
fixture dashboard stack, not OCC runtime behavior. CI retains `demo-log-dashboard`
for seven days without login state, request headers, full responses, browser
traces, or credentials.

For the separate `k3d-otel` model lane, set `OCC_TEST_OPENAI_MODEL`, a
digest-pinned `NODE_BASE_IMAGE`, and an existing authorized `OPENAI_API_KEY`.
Use a matching installed dependency graph and a fresh state directory:

```sh
OBS_LANE=k3d-otel
OBS_RUN_DIR=$(mktemp -d)
pnpm_config_verify_deps_before_run=false node scripts/ci/prepare.mjs --lane "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" && \
  pnpm_config_verify_deps_before_run=false node scripts/ci/run-tests.mjs run "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" --results "$OBS_RUN_DIR/results.json"
```

Inspect results and clean up as above. The model lane checks embedded and
dedicated turns and attributed logs in a production topology fixture; it does
not prove Helm-installed model coverage or version cutover. See
[Kubernetes image requirements](kubernetes.md#kubernetes-model-turns-and-secrets).

On macOS, Podman needs a compatible rootful engine with cpuset delegation. Select
its connection without changing the default. Bootstrap storage must preserve
Linux UID/GID and modes; use a task-owned VM-native `RUNNER_TEMP` when necessary.
For model builds, first pull `NODE_BASE_IMAGE` and the base pinned in
[`deploy/runtime/Dockerfile`](../../deploy/runtime/Dockerfile); the external
receiver files in `RUNNER_TEMP` must be visible to the host and VM. Do not weaken
permission checks.
