---
tags: [human_verified]
# Backfilled from the verification tag recorded in 17ff921c5.
last_verified: "2026-11-04"
---

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
pnpm cli:build
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

The first-Agent startup suite invokes the checkout's real CLI. Rebuild it from
current source before running that file by itself:

```sh
pnpm cli:build
node --test tests/integration/first-agent-startup.test.mjs
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
persistence and external sign-in; memory-backed success does not prove them.

`tests/integration/oidc-ca-trust.test.mjs` requires Helm, yq, and OpenSSL;
`OCC_HELM_BIN` can select Helm. It exercises loopback TLS trust and callback
transport, not a live IdP, PostgreSQL authentication, or an installed deployment.

### Synthetic OIDC issuer

With Node.js 24 and OpenSSL available, run the portable issuer checks:

```sh
node --test tests/integration/oidc-provider.test.ts
```

The HTTPS fixture and the `fakeOidc` fetch adapter share the
[OIDC protocol handler](../../tests/helpers/oidc-provider.mjs). The fixture grants
one synthetic subject without a login screen; keep it on a disposable test network.
These checks exercise the fixture, not a real identity provider or installed OCE
sign-in.

[Create run-owned material](../../tests/helpers/oidc-provider-material.mjs) once
per rehearsal and retain it across controller replacements. It generates the
client, subject, and TLS material in a private subdirectory and removes partial
output if setup fails. Stop provider users before calling its returned `dispose`.

The [server entrypoint](../../tests/helpers/oidc-provider-server.mjs) takes that
material directory as its argument. `OIDC_LISTEN_HOST` and `OIDC_LISTEN_PORT`
default to loopback and an ephemeral port; select the disposable network's bind
address and port explicitly for a packaged fixture. The caller owns stopping the
server and removing its material.

## Staged sign-in cleanup

On an isolated Linux Docker host with Node.js 24, k3d, kubectl, Python 3 and the
repository's installed dependencies, select the real cleanup fixture:

```sh
OCC_TEST_STAGED_SIGNIN_CLEANUP_REAL=1 node --test --test-concurrency=1 tests/integration/staged-signin-cleanup-real.test.ts
```

The `k3d-fixture-configuration` PR lane runs this file serially before its
shared fixture tests, without preparing a separate database for it. All three
cases must pass without skips. For the direct Node invocation, set
`OCC_TEST_STAGED_SIGNIN_CLEANUP_ARTIFACT_DIR` to a fresh directory to
retain source identity, observed resource identities, refusal output, assertion
outcomes and final cleanup status. The normal PR lane does not forward this
optional directory; use its ordinary result and cleanup reports.

Prepare the digest-pinned K3s image selected by `scripts/ci/prepare.mjs` and
k3d's support images before execution. Allow capacity for one disposable
single-server cluster and one small volume consumer at a time. The host must
expose its local Docker socket and the server's PID/cgroup identity. The fixture
uses private kubeconfigs and loopback API ports; it preserves the default
kubeconfig and unrelated resources. No controller/runtime build, model
credential or published release pair is needed.

The cases share a fifteen-minute admission deadline and stop creating resources
after a failure. The preparer runs in a child with a four-minute test budget.
Staged creation disables rollback and retains unacknowledged resources after a
timeout instead of deleting by name or retrying. After hooks stop further stages
and await the body before cleanup. Final cleanup has a
separate three-minute budget. A hard-killed runner can prevent those hooks;
retained private state is diagnostic, and the outer lane does not automatically
recover it. This suite does not prove recovery from arbitrary runner termination.
No timeout or uncertain command outcome counts as successful cleanup.

The cleanup CLI must remove the owned resources after a settled
failed case, and refuse both a replaced cluster and a newly shared volume.
Assertions inspect those effects before the fixture's separate final cleanup.
The runner, release and settlement inputs are synthetic; this proves real
Docker/k3d cleanup effects, not GitHub admission, image publication, child
settlement or installed sign-in. A failed settled case never qualifies a release.

Staged cleanup passes the prepared state digest and captured Docker custody into
the cleanup owner. It checks the state under its lock, removes the exact server
and network IDs, and rechecks volume generation and consumers before non-forced
removal. A consumer attached after server removal preserves the volume and fails
cleanup. Docker has no atomic generation condition for named-volume deletion;
these checks do not protect against a privileged actor recreating an unused
same-name volume between inspection and removal. Run this proof on an isolated
host without competing Docker writers. The CLI records mutation intent before
deletion. Without its completed cleanup receipt, the fixture retains state and
never retries deletion. Fallback requires a verified pre-mutation refusal.
Partial or uncertain cleanup never qualifies a release.

## Packaged-driver integration

`tests/integration/driver-plugin-installation.test.ts` installs precompiled
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

The three native Agent admin cases use Linux Chromium's NSS trust store. The
Console browser command reports these three as skipped on macOS and Windows.
For the full suite, use a disposable Ubuntu VM with Chromium sandbox support,
`libnss3-tools`, and the Go version in `go.mod`. Set up the checkout as above,
then run the Console browser command or just the Agent detail cases:

```sh
node --test 'tests/browser/console-agent-detail-2.test.{mjs,ts}'
```

The existing **Console Browser** check on a pull request also runs these
cases. The tests create and remove their own certificates and browser trust
store.

The browser fixture uses real controller routes with in-memory state and test
Drivers. It does not prove persistence, routing through a deployed gateway, or
Agent runtime behavior. The API checks can run without a browser:

```sh
node --test tests/integration/console-api.test.ts
```

### Browser failure diagnostics

Failed `checks-browser` CI lanes retain `browser-failures-*` artifacts for three
days. Use the [CI evidence overrides](ci/configuration.md#runner-overrides) to collect them
locally, including an optional Playwright trace. Open a trace with
`pnpm exec playwright show-trace`.

## Repository and tooling configuration

The repository pins Node and pnpm requirements in [package.json](../../package.json).
After changing API routes or schemas, run `pnpm openapi:generate`, then
`pnpm openapi:check`. To check the generated Markdown against the existing
OpenAPI contract without controller dependencies, run:

```sh
node scripts/generate-occ-api-reference.ts --check
```

Run `pnpm hooks:install` to reinstall the managed pre-push hook. It refuses to
replace an unmanaged hook and preserves `core.hooksPath`. The hook requires the
Bun version in `.bun-version` and invokes that executable's formatter directly,
without running package scripts. It checks files on disk in the active checkout,
including unstaged edits. To verify formatting
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

Use Node matching `package.json`, pinned pnpm and installed dependencies, the Go
toolchain in `go.mod`, Helm, kubectl, k3d, and the
[production helper prerequisites](../guides/deploy/production-upgrade.md#prepare-the-release),
including jq and yq. Run this credential-free lane with Docker or an explicitly
selected compatible Podman engine on a disposable loopback cluster with enforced
NetworkPolicy. Use a fresh private state directory for each run:

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
Prometheus, Grafana, or Loki. It also checks separate database upgrades: revoked
application access must fail the real migration hook without restarting either
writer; after grant repair and an independent migration Job, Helm must recover
the API and worker and deploy an Agent. The PostgreSQL lane separately verifies
that pending migration history is refused without applying SQL.
For the demo smoke, install Playwright Chromium
with `pnpm exec playwright install --with-deps chromium`, use a fresh directory,
and set `OBS_LANE=k3d-observability-demo` in the commands above. It checks a
fixture dashboard stack, not OCC runtime behavior. CI retains `demo-log-dashboard`
for seven days without login state, request headers, full responses, browser
traces, or credentials.

For the separate `k3d-otel` model lane, set `OCC_TEST_OPENAI_MODEL`, a
digest-pinned `NODE_BASE_IMAGE`, and an existing authorized `OPENAI_API_KEY`.
Run from the checkout root with a fresh state directory.

```sh
OBS_LANE=k3d-otel
OBS_RUN_DIR=$(mktemp -d)
corepack pnpm exec node scripts/ci/prepare.mjs --lane "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" && \
  corepack pnpm exec node scripts/ci/run-tests.mjs run "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" --results "$OBS_RUN_DIR/results.json"
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

### Worker termination observer

The `k3d-observability` lane also runs the observer against actual Helm-installed
workers. A namespace-scoped ServiceAccount lists and watches Pods. The test sends
SIGTERM to each worker twice, waits for kubelet to restart the container in the
same Pod, and checks that the OTLP receiver still holds both terminations
after the second restart. The two cases cover the ordinary worker container and
the native repository sender profile, where the worker is a restartable init
container. The latter uses generated keys and an unadmitted test repository; it
does not call a Git provider or prove repository operations. The lane builds the
real native sender image and requires `OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE` in
its prepared state. To run both installed cases in that environment:

```sh
OCC_TEST_PRODUCTION_OBSERVABILITY=1 node --test tests/integration/production-observability-k3d.test.ts
```

Both cases must pass. The receiver writes decoded OTLP to a temporary volume.
Its contents verify receipt after the second restart. Backend retention over
time needs a separate check against the operator's storage policy.

For the synthetic LIST/WATCH case, use Node.js 24+ and `kubectl`:

```sh
OCC_TEST_WORKER_COLLECTOR_BIN=/trusted/bin/otelcol-contrib \
  node --test tests/integration/worker-termination-observer.test.ts
```

In CI, the test extracts `/otelcol-contrib` from the host image pinned by
`logging.collector.image` in the production chart. It creates a temporary
container with `--pull=never` and removes it after copying the binary.
`OCC_TEST_OBSERVABILITY_COLLECTOR_IMAGE` identifies the separate k3d import.
`OCC_DOCKER_BIN` and `OCC_KUBECTL_BIN` select the executables. The standalone
binary override above bypasses image extraction and requires a verified 0.159.0
Collector.

The synthetic API exercises backoff before the restart count advances, distinct
139/137 exits, missing status, and watch closure. The real Collector reads the
private file, rejects malformed records and excludes canaries from OTLP. Set
`OCC_TEST_WORKER_OBSERVATION_EVIDENCE` to a new private file path to retain the
synthetic batches. See the [operator guide](../guides/observability/worker-terminations.md)
for deployment and retention.
