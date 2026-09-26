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

Open Grafana at `http://127.0.0.1:3001`, sign in as `admin` with that password,
and open **OCC → OCC development**. The datasource and dashboard are provisioned
from `deploy/metrics/development/`; its shared dashboard lives in
`deploy/helm/openclaw-observability-demo/files/`. Prometheus is at `http://127.0.0.1:9090`.
Override host ports with `OCC_GRAFANA_PORT` and `OCC_PROMETHEUS_PORT` if occupied.

Each OCC metrics listener stays on container loopback. Two Prometheus agent-mode
collectors share the respective API/worker network namespaces, scrape every
five seconds, and remote-write to the local Prometheus server. Grafana queries
that server. This development-only arrangement requires no change to production
scraping. The example is a single development deployment, not a multi-replica
Compose topology. Recreate its collectors when replacing their owner containers.

The central server accepts unauthenticated remote writes on the development
network; its UI and Grafana are published only on host loopback. Use this on a
trusted development machine, never as production packaging. Collector/WAL and
dashboard state is disposable; server retention is 24 hours / 256 MB. The overlay
uses pinned image digests and introduces no model credentials into monitoring.
For Podman, include `compose.podman.yaml` with the socket reported by
`podman info`; the [quickstart helper](../guides/quickstart.md) prepares that
configuration. Namespace sharing and remote write were also verified on Podman.
The Grafana 13.2.2 pin selects a multi-platform image index with native amd64
and arm64 variants, so Docker and Podman select the host architecture without
a local image override. Back up `/var/lib/grafana` before
recreating an instance whose local dashboard or account changes you need to keep.

## Generate traffic and check results

Wait about 15 seconds, then evaluate `up{job=~"occ-api|occ-worker"}` in
Prometheus: expect two series equal to 1. The receiving server's Targets page
does not list remote-write targets; query `up` instead.

Use the console to create an Agent draft and refresh its list. The lifecycle
panel should gain one draft. Deploy it through the regular Agent workflow:
expect `deploying`, then `running` after finalization. Redeploying counts that
Agent once, with `deploying` replacing `running` until completion. Stop it:
expect `stopping`, then `stopped`, with no return to `draft`. These are persisted
lifecycle states, not continuous runtime-health measurements.

The Agent operation p95 panel includes queue wait and retry delays for completed
deploy/stop requests. It needs completed operations in its five-minute window;
failed or unfinished operations do not produce duration samples. Compare it with
reconciliation-pass p95 and oldest pending work age to distinguish slow passes
from accumulated waiting. Oldest age is zero when the queue is empty and includes
delayed retries and scheduled maintenance. Retry/failure rates and API 5xx
percentage use the existing counters.

For an easy error-rate check, request an unknown API path several times:

```bash
for attempt in 1 2 3 4 5; do
  curl --silent --output /dev/null http://127.0.0.1:3000/metrics-demo-missing
done
```

Expect 4xx activity. Allow at least two scrapes for rate panels; new counters
can initially show no data. Request latency, reconciliation passes, queue depth,
memory, CPU, and event-loop panels become useful as traffic/work occurs. A quiet
worker may have no attempt series yet.

Scrape directly without publishing a new host port:

```bash
docker compose -f compose.yaml -f compose.metrics.yaml exec -T worker node -e \
  "fetch('http://127.0.0.1:9464/metrics').then(async r=>{console.log(r.status);console.log(await r.text())})"
```

Temporarily stopping the **metrics-worker collector** tests transport loss
without interrupting reconciliation. Start it again and wait for fresh samples.
Because remote write stops too, the previous `up` sample can remain visible
until Prometheus's lookback expires; inspect sample age as well as `up`. A
running collector observing a worker scrape failure instead reports `up=0`.
Do not interpret an absent inventory panel as zero Agents.

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
separate registries/listeners, and PostgreSQL inventory/redeployment with the
existing deterministic Compute fixture. Its database case also exercises queue age before claim, retry-inclusive
completion timing, real lock contention, concurrent scrape failure, recovery,
and closed-pool failure.
It proves persistence and instrumentation, not live workload readiness.

Run with an exclusively used disposable database from the
[PostgreSQL setup](postgresql.md), migrated by the migrator role:

```bash
OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_test_local \
  OCC_METRICS_TEST_MIGRATION_DATABASE_URL=postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/openclaw_test_local \
  node --test tests/integration/occ-metrics.test.mjs
```

The optional `OCC_METRICS_TEST_MIGRATION_DATABASE_URL` must target the same
disposable database and supplies table-owner permission solely for the lock
scenario. Omitting it skips that subtest; application reads still use the
limited application role.

The existing `docker-compute-real.test.mjs` journey now scrapes both processes
after actual Agent deployment; the Podman path also stops the Agent and
checks its lifecycle and completion metric. Follow its [runtime prerequisites](docker.md).
Helm rendering proves selectors/ports but does not prove live NetworkPolicy
enforcement. Record any unrun runtime or cluster proof explicitly.

Run the real Prometheus remote-write and Grafana provisioning test on Linux:

```bash
OCC_TEST_METRICS_MONITORING=1 OCC_METRICS_TEST_ENGINE=podman \
  node --test tests/integration/occ-metrics-monitoring.test.mjs
```

Choose `docker` instead for Docker Engine. This test creates and removes only
randomly named monitoring containers. It uses host networking with loopback-only
listeners to reach a real test API and validates every dashboard query against
Prometheus. It verifies collection and provisioning, not Compose's namespace
sharing or live Agent runtime behavior.

The test disables Grafana's startup plugin installation so it uses the plugins
bundled in the pinned image. Background updates can replace the working
Prometheus backend with a download that cannot execute from the data tmpfs,
causing datasource health to fail while Grafana's own health stays ready. The
test explicitly mounts that directory with `noexec` on both Docker and Podman.

## Kubernetes observability acceptance

From the repository root, prepare and run the `k3d-observability` CI lane. Use
Node 24+, the pinned pnpm and installed dependencies, Helm, kubectl, k3d, and
Docker or an explicitly selected compatible Podman engine. NetworkPolicy must
be enforced with bridge netfilter. Preparation owns a loopback k3d cluster,
builds the current controller, and imports pinned images; it preserves the
default kubeconfig and other clusters. Use a fresh private state directory for
each run:

```sh
OBS_LANE=k3d-observability
OBS_RUN_DIR=$(mktemp -d)
env -u OPENAI_API_KEY node scripts/ci/prepare.mjs --lane "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" && \
  env -u OPENAI_API_KEY node scripts/ci/run-tests.mjs run "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" --results "$OBS_RUN_DIR/results.json"
```

Run the test command only if preparation succeeds. Inspect its exit status and
`results.json` for case counts, failures, skips, and TODOs. After preparation or
testing finishes, including on failure, clean up the recorded resources:

```sh
node scripts/ci/cleanup.mjs --state "$OBS_RUN_DIR/state.json"
```

Check cleanup's exit status and retain failed state for recovery. If a command
is interrupted, verify that its owned test and subprocesses have stopped before
cleanup; an exited parent alone does not establish that detached commands have
stopped. Do not remove unrelated resources. The
[CI testing guide](ci.md) describes state, diagnostics, and cleanup.

This lane requires no model credential, and the commands above remove
`OPENAI_API_KEY` from their environments. It makes no model calls. It installs
the real Helm API/worker and PostgreSQL with migrator/application roles on one
node. Raw HTTP requests verify API/worker metrics, a request counter, default-deny
access, and paired scraper selectors. The shipped chart Collector exports actual API and worker logs to a
minimal OTLP receiver; the test reads the decoded records and checks attribution
and credential exclusion. No Prometheus, Grafana, or Loki is installed.

For the separate demo smoke test, replace `OBS_LANE=k3d-observability` with
`OBS_LANE=k3d-observability-demo` in the commands above and use a fresh private
directory. It installs only Prometheus, Grafana, and Loki. Small protocol fixtures
publish a known metric and OTLP record; queries through Grafana verify discovery, scraping, ingestion,
and both data-source connections. The test also checks dashboard provisioning.
It does not build or install OCC, PostgreSQL, or a Collector. It runs in the
[Observability Demo workflow](../../.github/workflows/observability-demo.yml) for
relevant demo-chart and test-infrastructure changes, on merge groups,
and on manual dispatch. This proves the demo chart using fixture telemetry;
the separate production smoke proves real OCC telemetry.

These are installation smoke tests. They do not exercise Agent lifecycle, Pod
replacement, Collector ownership handoff, metrics opt-out upgrades, or exporter
outage/retry exhaustion. Metrics semantics and Collector resilience retain their
focused integration coverage; Helm rendering covers the selector and opt-out
configuration matrix. Those checks do not establish the omitted live Kubernetes
upgrade or failure scenarios.

For the protected `k3d-otel` lane, select `OCC_TEST_OPENAI_MODEL` and a
digest-pinned `NODE_BASE_IMAGE`, and provide the existing authorized
`OPENAI_API_KEY` through the environment. Independently prepare an installed
dependency graph matching the checkout before running the lane. The pnpm
setting below prevents implicit dependency verification and repair during these
commands; it does not validate the graph or prevent explicit installs. Use a
fresh private directory and run:

```sh
OBS_LANE=k3d-otel
OBS_RUN_DIR=$(mktemp -d)
pnpm_config_verify_deps_before_run=false node scripts/ci/prepare.mjs --lane "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" && \
  pnpm_config_verify_deps_before_run=false node scripts/ci/run-tests.mjs run "$OBS_LANE" --state "$OBS_RUN_DIR/state.json" --results "$OBS_RUN_DIR/results.json"
```

Run the test only after successful preparation, then inspect its results and
clean up as described above. Preparation builds the reviewed runtime sources and
imports immutable images; approved image overrides follow
[Kubernetes model turns](kubernetes.md#kubernetes-model-turns-and-secrets).
Missing selections or credentials fail before provisioning. This lane is separate
from ordinary PR/main CI; a passing credential-free run does not prove
gateway/Codex model logs. The retained embedded and dedicated cases use the
existing production topology fixture and check model turns and attributed
runtime logs for one revision. Helm-installed model coverage and checks across
revision cutover are deferred.

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
