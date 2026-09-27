# Test OCC metrics with Prometheus and Grafana

Start from the [Compose quickstart](../guides/quickstart.md) with a working
development API and worker. No model credential is needed to collect metrics;
an active Agent requires the normal supported deployment prerequisites.

## Start the development dashboard

Run from the repository root with Docker Compose. Keep the same Compose project
name and `.env` as your existing development stack. This overlay recreates the
API and worker to enable their metrics listeners; allow existing work to finish
before restarting. Choose a local Grafana password without putting it in shell
history:

```bash
read -rs -p 'Development Grafana password: ' OCC_METRICS_GRAFANA_PASSWORD
export OCC_METRICS_GRAFANA_PASSWORD
docker compose -f compose.yaml -f compose.metrics.yaml up -d --build
```

Sign in at `http://127.0.0.1:3001` as `admin` and open **OCC → OCC development**.
Provisioning is in `deploy/metrics/development/`; the shared dashboard is in
`deploy/helm/openclaw-observability-demo/files/`. Prometheus is at
`http://127.0.0.1:9090`. Override occupied ports with `OCC_GRAFANA_PORT` or
`OCC_PROMETHEUS_PORT`.

Each OCC listener stays on container loopback. Two Prometheus agent-mode collectors share the
API/worker network namespaces, scrape every five seconds and remote-write to the
local server queried by Grafana. This single-deployment example does not change
production scraping or support a multi-replica Compose topology. Recreate agents
when replacing their owner containers.

The server accepts unauthenticated remote writes on the development network;
its UI and Grafana bind host loopback. Use a trusted development machine, not
production. Collector/WAL and dashboard state is disposable; retention is 24 hours
/ 256 MB. The overlay pins image digests and adds no model credentials. Back up
`/var/lib/grafana` before recreating an instance whose local dashboard or account
changes you need to keep.

For Podman, include `compose.podman.yaml` with the socket from `podman info`;
the [quickstart helper](../guides/quickstart.md) prepares it. Namespace sharing
and remote write were verified on Podman. The pinned Grafana image supports
amd64 and arm64 without a local override.

## Generate traffic and check results

Wait about 15 seconds, then evaluate `up{job=~"occ-api|occ-worker"}` in
Prometheus: expect two series equal to 1. The receiving server's Targets page
does not list remote-write targets; query `up` instead.

Create an Agent draft in the console and refresh the list: the lifecycle panel
should gain one draft. Deploy it through the regular workflow: expect `deploying`,
then `running` after finalization. Redeploying counts the Agent once, replacing
`running` with `deploying` until completion. On stop, expect `stopping`, then
`stopped`, with no return to `draft`. These are persisted lifecycle states, not
continuous runtime-health measurements.

Agent operation p95 includes queue wait and retries for deploy/stop requests
completed in its five-minute window. Failed or unfinished operations yield no
duration samples. Compare reconciliation-pass p95 and oldest pending work age
to distinguish slow passes from waiting. Age is zero for an empty queue and
includes delayed retries and scheduled maintenance. Retry/failure rates and API
5xx percentage use existing counters.

For an easy error-rate check, request an unknown API path several times:

```bash
for attempt in 1 2 3 4 5; do
  curl --silent --output /dev/null http://127.0.0.1:3000/metrics-demo-missing
done
```

Expect 4xx activity. Rate panels need at least two scrapes; new counters can
initially show no data. Request latency, reconciliation, queue depth, memory,
CPU, and event-loop panels become useful with traffic or work. A quiet worker may
have no attempt series yet.

Scrape directly without publishing a new host port:

```bash
docker compose -f compose.yaml -f compose.metrics.yaml exec -T worker node -e \
  "fetch('http://127.0.0.1:9464/metrics').then(async r=>{console.log(r.status);console.log(await r.text())})"
```

Stop **metrics-worker collector** temporarily to test transport loss without
interrupting reconciliation, then restart it and wait for fresh samples. The
previous `up` sample can remain until lookback expires; inspect its age. A running
collector observing a scrape failure reports `up=0`. An absent inventory panel
does not mean zero Agents.

## Troubleshoot and stop

Inspect `docker compose -f compose.yaml -f compose.metrics.yaml logs --tail=100
metrics-api metrics-worker prometheus grafana`. Check failed remote writes,
Grafana datasource URL, wrong project/network, and inaccessible mounted files.
Do not relabel or change ownership of the repository to fix a container mount;
use an appropriate development checkout/container setup.

Remove only monitoring containers (their disposable data may be lost):

```bash
docker compose -f compose.yaml -f compose.metrics.yaml stop metrics-api metrics-worker grafana prometheus
docker compose -f compose.yaml -f compose.metrics.yaml rm -f metrics-api metrics-worker grafana prometheus
unset OCC_METRICS_GRAFANA_PASSWORD
```

To disable OCC listeners too, recreate API/worker using the original quickstart
Compose files. Keep PostgreSQL volumes, `.env`, and Agent workloads. Do not use
`down -v` to clean up monitoring.

## Automated proof

`tests/integration/occ-metrics.test.mjs` covers real Fastify/auth HTTP requests,
separate registries/listeners, and PostgreSQL inventory and redeployment with a
deterministic Compute fixture. Its database case exercises queue age before claim,
retry-inclusive completion timing, real lock contention, concurrent scrape failure,
recovery, and closed-pool failure. It proves persistence and instrumentation, not
live workload readiness.

Run with an exclusively used disposable database from the
[PostgreSQL setup](postgresql.md), migrated by the migrator role:

```bash
OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_test_local \
  OCC_METRICS_TEST_MIGRATION_DATABASE_URL=postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/openclaw_test_local \
  node --test tests/integration/occ-metrics.test.mjs
```

Optional `OCC_METRICS_TEST_MIGRATION_DATABASE_URL` must target the same disposable
database; it supplies table-owner permission solely for the lock scenario. Omit it
and that subtest is skipped. Application reads still use the limited role.

`docker-compute-real.test.mjs` scrapes both processes after Agent deployment;
the Podman path also stops the Agent and checks lifecycle and completion metrics.
Follow its [runtime prerequisites](docker.md). Helm rendering proves selectors
and ports, not live NetworkPolicy enforcement. Record unrun runtime or cluster proof.

Run the real Prometheus remote-write and Grafana provisioning test on Linux:

```bash
OCC_TEST_METRICS_MONITORING=1 OCC_METRICS_TEST_ENGINE=podman \
  node --test tests/integration/occ-metrics-monitoring.test.mjs
```

Use `docker` for Docker Engine. The test creates and removes only randomly named
monitoring containers, uses host networking and loopback listeners to reach a real
test API, and validates dashboard queries against Prometheus. It proves collection
and provisioning, not Compose namespace sharing or live Agent behavior.

The test disables plugin installation and mounts Grafana's data tmpfs `noexec`.
A plugin update can otherwise break the Prometheus datasource while Grafana
remains healthy.

## Kubernetes observability acceptance

From the repository root, run the `k3d-observability` CI lane with Node 24+,
pinned pnpm and installed dependencies, Helm, kubectl, k3d, and Docker or an
explicitly selected compatible Podman engine. Enforce NetworkPolicy with bridge
netfilter. Preparation owns a loopback k3d cluster, builds the controller and
imports pinned images; it preserves the default kubeconfig and other clusters.
Use a fresh private state directory per run:

```sh
OBS_LANE=k3d-observability
OBS_RUN_DIR=$(mktemp -d)
env -u OPENAI_API_KEY node scripts/ci/prepare.mjs --lane "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" && \
  env -u OPENAI_API_KEY node scripts/ci/run-tests.mjs run "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" --results "$OBS_RUN_DIR/results.json"
```

Run tests only after successful preparation. Inspect the exit status and
`results.json` for case counts, failures, skips, and TODOs. After preparation or
testing, including on failure, clean up recorded resources:

```sh
node scripts/ci/cleanup.mjs --state "$OBS_RUN_DIR/state.json"
```

Check cleanup's exit status and retain failed state for recovery. After an
interruption, verify owned tests and subprocesses have stopped before cleanup;
an exited parent does not prove detached commands have stopped. Do not remove
unrelated resources. See the [CI testing guide](ci.md) for state and diagnostics.

This lane removes `OPENAI_API_KEY` and makes no model calls. It installs the Helm
API/worker and PostgreSQL with migrator/application roles on one node. HTTP
requests verify metrics, a request counter, default-deny access and paired scraper
selectors. The chart Collector exports actual API/worker logs to a minimal OTLP
receiver; decoded records are checked for attribution and credential exclusion.
It installs no Prometheus, Grafana or Loki.

For the demo smoke test, set `OBS_LANE=k3d-observability-demo` above and use a
fresh private directory. Before a local run, install the pinned browser with
`pnpm exec playwright install --with-deps chromium`. The lane installs Prometheus,
Grafana, and Loki and checks fixture metric discovery, scraping, log ingestion,
and both Grafana data sources. Playwright checks rows, metadata, and Service/Event
controls. Grafana's interpolated Loki queries cover INFO HTTP failures and worker
retry, permanent, and failure outcomes; event bodies and request correlation
remain queryable.

The [Observability Demo workflow](../../.github/workflows/observability-demo.yml)
runs on relevant demo-chart and test-infrastructure changes, merge groups, and
manual dispatch. It retains synthetic PNGs and bounded failure diagnostics as
`demo-log-dashboard` for seven days, excluding login state, request headers, full
responses, browser traces, and credentials. This uses fixtures and installs no OCC,
PostgreSQL, or Collector. The production smoke checks real OCC telemetry.

The smoke tests omit Agent lifecycle, Pod replacement, Collector ownership
handoff, metrics opt-out upgrades, and exporter outage/retry exhaustion. Focused
integration tests cover metrics semantics and Collector resilience; Helm rendering
covers selector and opt-out configurations, not those live upgrade or failure cases.

For the protected `k3d-otel` lane, select `OCC_TEST_OPENAI_MODEL` and a
digest-pinned `NODE_BASE_IMAGE`, and provide an existing authorized
`OPENAI_API_KEY` through the environment. Independently prepare an installed
dependency graph matching the checkout. The pnpm setting below prevents implicit
verification and repair; it does not validate the graph or prevent explicit
installs. Use a fresh private directory:

```sh
OBS_LANE=k3d-otel
OBS_RUN_DIR=$(mktemp -d)
pnpm_config_verify_deps_before_run=false node scripts/ci/prepare.mjs --lane "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" && \
  pnpm_config_verify_deps_before_run=false node scripts/ci/run-tests.mjs run "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" --results "$OBS_RUN_DIR/results.json"
```

Run the test only after successful preparation, then inspect results and clean
up as above. Preparation builds reviewed runtime sources and imports immutable
images; see [approved overrides](kubernetes.md#kubernetes-model-turns-and-secrets).
Missing selections or credentials fail before provisioning. This lane is separate
from ordinary PR/main CI; a credential-free pass does not prove gateway/Codex model
logs. Embedded and dedicated cases use the production topology fixture to check
model turns and attributed runtime logs for one revision. Helm-installed model
coverage and revision-cutover checks are deferred.

For macOS Podman, k3d needs a compatible rootful engine with cpuset delegation.
Use an explicitly selected connection/socket; do not change the default engine.
Shared bootstrap storage must preserve Linux UID/GID/modes: use a task-owned
VM-native path via `RUNNER_TEMP` if the host's shared filesystem does not.
For Podman model builds, first pull the approved `NODE_BASE_IMAGE` and the runtime
base pinned in [`deploy/runtime/Dockerfile`](../../deploy/runtime/Dockerfile):
those builds use `--pull=false` and require both bases in the local image store.
The separate model lane mounts its external receiver files from `RUNNER_TEMP`,
so that path must instead be visible to both macOS and the VM; its single-node
bootstrap volume stays inside the k3d container.
Do not weaken permission checks to accommodate a shared mount. The local baseline
was verified with rootful Podman and VM-native storage; Docker remains the hosted
CI path. See [the baseline report](../../specs/reports/36-production-observability-baseline.md).
