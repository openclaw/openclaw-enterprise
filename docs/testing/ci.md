# GitHub Actions testing

Select automated or manually dispatched test lanes and understand the coverage
reported by each workflow.

## GitHub Actions

The [suite map](../../scripts/ci/test-suites.json) assigns each active test file to exactly one lane, with its required inputs and preparation resources. Check its coverage after adding or renaming tests:

```sh
node scripts/ci/run-tests.mjs audit
```

Both workflows reuse the [run-ci-lane action](../../.github/actions/run-ci-lane/action.yml) for setup, tests and cleanup; each job retains its own environment and credentials.

The `checks-baseline` lane runs `pnpm docs:check`: pages above 1,500 visible words
are flagged for review and pages above 2,500 fail, except the approved single-page
[API reference](../reference/api.md). The generated API, site build, navigation,
and links must pass. Run `pnpm docs:check-length` for the word-count
check alone.

The PR workflow runs exactly five lanes on ephemeral runners: checks/baseline/browser, PostgreSQL, image/packaging, Kubernetes fixture/Configuration, and logging collector. Full Integration runs only through manual dispatch from `main`, using that immutable commit. Environment gates apply only to lanes that declare an environment; `helper-timeout` and standalone `logging-collector` declare none. The ChatGPT `provider-account` lane keeps its main-only credential environment without per-run approval. Other model, routing, Slack, OpenShell, and additional OpenTelemetry lanes require separately approved environments. A missing environment or selected prerequisite fails the run. A PR aggregate is not full credentialed coverage; targeted protected runs also report only their selected lanes.

Implementation status: routing, OpenShell, and logging now have concrete CI preparation contracts. Routing installs pinned Gateway API, cert-manager v1.18.4, and Envoy Gateway v1.6.7 controller manifests and generates a private test CA. OpenShell creates an owned K3s v1.36.4 cluster, installs a matched kubectl, configures the selected RuntimeClass with the cluster's `runc` handler, verifies handler availability with a smoke Pod, installs OpenShell CLI/chart assets, imports gateway and supervisor images, and installs Agent Sandbox resources. Only the disposable CI OpenShell cluster exempts its selected RuntimeClass from Pod Security Admission. Preparation proves that a violating ordinary Pod is rejected in a restricted namespace and that the same Pod is admitted with the selected class. The full OpenShell suite proves provider-owned supervisor enforcement for filesystem, endpoint/L7 network, and process boundaries while preserving the current binary-unaware sidecar policy. Logging preparation owns a real OpenTelemetry Collector backend with JSONL evidence, and `OCC_TEST_OTEL_LOGS_URL` is no longer a required external input. The Collector and Docker-model jobs use the shared [setup-test-docker action](../../.github/actions/setup-test-docker/action.yml) to pin Docker 29.4.0, which supports the production `fluentd-write-timeout` logging option. The action stops the preinstalled daemon on the ephemeral runner, installs Docker 29.4.0 through the SHA-pinned official Docker setup action, and points `/var/run/docker.sock` at the action socket so the CLI, production Compose, and Driver use one daemon. Other jobs keep the runner Docker daemon. Full-suite acceptance remains incomplete until main-only protected hosted execution records every selected lane. See the [delivery status](../../specs/19-github-actions-test-coverage/delivery-status.md#delivery-status) for current proof boundaries and live gaps.

Each lane runs whole test files. The runner validates actual Node case results and required names; any skip or TODO fails a selected lane. Missing results, zero cases, failures and cleanup errors also fail. The aggregate checks required job and lane results at the same source commit without repeating case validation. Ordinary `pull_request` jobs may save pnpm-store caches within the PR merge-ref scope; protected jobs use trusted main inputs.

Prepare infrastructure only on a disposable host or through the reviewed CI helpers. Each run owns its Compose project, file-specific databases, cluster and temporary files. CI writes private cleanup state under `RUNNER_TEMP` and uploads only sanitized result JSON, so hosted-runner cleanup state is unavailable after the job ends. Local failures can retain cleanup state while the host and state path still exist. On local Docker Desktop or equivalent VM-backed Docker hosts, run one Kubernetes lane at a time when disk or network pressure has caused measured instability. The GitHub matrix remains parallel; this local guidance is for reproducible operator runs. Model/service tests require the approved credentials and spend policy described in the [implementation specification](../../specs/19-github-actions-test-coverage.md); configuring workflow files does not prove those tests have passed.

See the [execution flow](../flows/github-actions-testing.md) for entrypoints, result accounting, cleanup and failure interpretation. Use the [suite-specific guides](README.md#integration-tests) to reproduce a run locally.

### Integration coverage by trigger

The [CI workflow](../../.github/workflows/ci.yml) runs five noncredentialed lanes on
pull requests, pushes to `main`, merge groups, and manual dispatch.
[Full Integration](../../.github/workflows/full-integration.yml) runs only through
manual dispatch from `main`, using the requested lane or `all`. It does not run
on pushes or merges. The `provider-account` lane remains manual because its
configured admin credential cannot authenticate from the hosted runner.

### Integration tests outside automatic CI

The following integration files have no automatic workflow entrypoint.
A green `CI Required` check does not establish their coverage. This inventory describes workflow selection, not
whether a test has ever passed in a local or hosted run.

#### Manual Full Integration lanes

In GitHub Actions, these nine files run only when explicitly selected in
[Full Integration](../../.github/workflows/full-integration.yml) from `main`, using
the listed lane or `all`. The model/service lanes require their configured
credentials and infrastructure. All credentialed lanes except `provider-account`
require protected-environment approval; `provider-account` remains restricted to
`main` without per-run approval. `helper-timeout`
has no environment approval gate; it is separate because it spends five minutes
testing the real helper deadline.

| Lane               | Integration test file                                                                                            | Coverage absent from automatic CI                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `docker-model`     | [docker-compute-real.test.mjs](../../tests/integration/docker-compute-real.test.mjs)                             | Docker Compose deployment and real embedded OpenClaw/dedicated Codex model turns.                                        |
| `k3d-model`        | [harness-topology-k3d-real.test.mjs](../../tests/integration/harness-topology-k3d-real.test.mjs)                 | Dedicated Codex continuity across Pod replacement and embedded model turns with persisted credentials or the Secret API. |
| `gateway-routing`  | [harness-topology-k3d-routing-real.test.mjs](../../tests/integration/harness-topology-k3d-routing-real.test.mjs) | Dedicated Codex consumption of workspace files through the real Envoy/OCC route.                                         |
| `production-tui`   | [production-tui-k3d-real.test.mjs](../../tests/integration/production-tui-k3d-real.test.mjs)                     | Helm-installed production control plane, interactive TUI, and revision cutover.                                          |
| `slack`            | [harness-topology-k3d-slack-real.test.mjs](../../tests/integration/harness-topology-k3d-slack-real.test.mjs)     | Real Slack ingress and a gateway-authored reply through the approved proxy and Codex Agent.                              |
| `provider-account` | [service-account-driver-real.test.mjs](../../tests/integration/service-account-driver-real.test.mjs)             | Actual ChatGPT service-account creation, credential delivery, and a dedicated Codex model turn.                          |
| `openshell`        | [sandbox-driver-openshell-k3d-real.test.mjs](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs) | Provider-owned dedicated Codex Harness and real OpenShell sandbox enforcement.                                           |
| `helper-timeout`   | [dev-up-timeout.test.mjs](../../tests/integration/dev-up-timeout.test.mjs)                                       | Full 300-second readiness deadline for a running but unready worker.                                                     |
| `k3d-otel`         | [harness-topology-k3d-otel-real.test.mjs](../../tests/integration/harness-topology-k3d-otel-real.test.mjs)       | Actual OTLP logs emitted during embedded and dedicated runtime model turns.                                              |

#### No GitHub workflow entrypoint

[postgres-azure-workload-identity.test.mjs](../../tests/integration/postgres-azure-workload-identity.test.mjs)
belongs to the `postgres-azure-workload-identity` lane, excluded from both the
`ci` and `full` groups and from Full Integration dispatch options. Follow the
[Azure PostgreSQL test procedure](postgresql.md#azure-workload-identity-connections)
for private input setup and result handling. The ordinary constructor,
security-rejection, and password cases in
[postgres-connection-auth.test.mjs](../../tests/integration/postgres-connection-auth.test.mjs)
run in the mandatory `postgres` lane.

[ssh-compute-real.test.mjs](../../tests/integration/ssh-compute-real.test.mjs) belongs
to the `ssh-host` lane, which is excluded from both the `ci` and `full` groups
and is not a Full Integration dispatch option. No current workflow provisions
its disposable Linux/systemd SSH host or invokes that lane. It proves real-host
readiness, revision cutover, state isolation/persistence, and deletion, without a
model call. Follow [SSH raw hosts](ssh.md#ssh-raw-hosts) for the disposable host,
required environment settings, and direct test command.

Every current `tests/integration/*.test.mjs` file has a suite-map owner. Ownership
alone does not mean a workflow runs it; keep this list aligned with both the
suite-map groups and workflow entrypoints.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
