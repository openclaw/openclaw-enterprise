# GitHub Actions testing

Select automated or manually dispatched test lanes and understand the coverage
reported by each workflow.

## GitHub Actions

Metrics HTTP/persistence coverage belongs to the `postgres` lane, including a
separate migrator-role connection for test-only table contention. The
`logging-collector` lane also runs real Prometheus/Grafana collection and
dashboard provisioning. See [metrics testing](metrics.md) for local setup.

The [suite map](../../scripts/ci/test-suites.json) assigns each active test file to exactly one lane, with its required inputs and preparation resources. Check its coverage after adding or renaming tests:

```sh
node scripts/ci/run-tests.mjs audit
```

Both workflows reuse the [run-ci-lane action](../../.github/actions/run-ci-lane/action.yml) for setup, tests and cleanup; each job retains its own environment and credentials.

The `checks-baseline` lane runs `pnpm docs:check`: pages above 1,500 visible words
are flagged for review and pages above 2,500 fail, except the approved single-page
[API reference](../reference/api.md) and `AGENTS.md` instruction files (see the
[length policy](../../AGENTS.md#documentation-length-budget)). The generated API, site build, navigation,
and links must pass. Run `pnpm docs:check-length` for the word-count
check alone.

The PR workflow runs seven lanes on ephemeral runners: checks/baseline/browser, PostgreSQL, image/packaging, Kubernetes fixture/Configuration, logging collector, `repository-credentials-container`, and `repository-credentials-platform`. The container lane builds separate emitted service/client images and a combined qualification image, then selects controlled provider and separate-container cases; it does not contact a live GitHub installation. The platform lane exercises ordinary Agent repository bindings through HTTP, PostgreSQL, Unix control and Kubernetes using a fixture Harness and controlled repositories; it does not use a model or live GitHub. Full Integration runs through manual dispatch using the immutable event commit. All lanes require `main` except `k3d-model`, which also accepts a branch explicitly allowed by the `integration-model` environment. Environment gates apply only to lanes that declare an environment; `helper-timeout` and standalone `logging-collector` declare none. The ChatGPT `provider-account` lane keeps its main-only credential environment without per-run approval. Other model, routing, Slack, OpenShell, and additional OpenTelemetry lanes require separately approved environments. A missing environment or selected prerequisite fails the run. A PR aggregate is not full credentialed coverage; targeted protected runs also report only their selected lanes.

The `repository-credentials-container` lane builds
`.build/repository-credentials/{service,client}` using Dockerfiles under
`deploy/runtime/repository-credentials/` and records source, `gh` version and
three image IDs. It selects immutable IDs through
`REPOSITORY_CREDENTIALS_TEST_IMAGE`, `REPOSITORY_CREDENTIALS_SERVICE_IMAGE` and
`REPOSITORY_CREDENTIALS_CLIENT_IMAGE`; its real Git/gh fixtures also receive
`REPOSITORY_CREDENTIALS_NODE_IMAGE` and the extracted, version-checked
`REPOSITORY_CREDENTIALS_GH_BINARY`. The [credential test guide](repository-credentials.md)
separates detached artifacts, the combined image, rendered Compose, running
container isolation and authorized live proof. CI preparation and suite ownership
alone establish no result: inspect executed cases and skips at the exact tested
commit, including whether a pull-request run tested a merge commit.

The Kubernetes fixture lane uses a server and worker node with shared test-owned
local-path storage. Preparation registers and verifies the fixture image's digest
on both nodes and derives the API server's proxy source `/32` from its route to
the worker Pod network. It supplies that address to the
[plugin status tests](plugins.md#local-and-integration-suites), which exercise
the private status endpoint across nodes with NetworkPolicy enforcement.

The `k3d-model`, `gateway-routing`, `slack`, and `k3d-otel` lanes prepare the controller image and workspace routing for dedicated Harness node enrollment. Supply an immutable `NODE_BASE_IMAGE` for the controller build. Preparation supplies the imported controller digest and private routing CA paths; the Slack lane still requires approved runtime images and credentials.

Implementation status: routing, OpenShell, and logging now have concrete CI preparation contracts. Routing installs pinned Gateway API, cert-manager v1.18.4, and Envoy Gateway v1.6.7 controller manifests and generates a private test CA. OpenShell creates an owned K3s v1.36.4 cluster, installs a matched kubectl, configures the selected RuntimeClass with the cluster's `runc` handler, verifies handler availability with a smoke Pod, installs OpenShell CLI/chart assets, imports gateway and supervisor images, and installs Agent Sandbox resources. Only the disposable CI OpenShell cluster exempts its selected RuntimeClass from Pod Security Admission. Preparation proves that a violating ordinary Pod is rejected in a restricted namespace and that the same Pod is admitted with the selected class. The full OpenShell suite proves provider-owned supervisor enforcement for filesystem, endpoint/L7 network, and process boundaries while preserving the current binary-unaware sidecar policy. Logging preparation owns a real OpenTelemetry Collector backend with JSONL evidence, and `OCC_TEST_OTEL_LOGS_URL` is no longer a required external input. The Collector and Docker-model jobs use the shared [setup-test-docker action](../../.github/actions/setup-test-docker/action.yml) to pin Docker 29.4.0, which supports the production `fluentd-write-timeout` logging option. The action stops the preinstalled daemon on the ephemeral runner, installs Docker 29.4.0 through the SHA-pinned official Docker setup action, and points `/var/run/docker.sock` at the action socket so the CLI, production Compose, and Driver use one daemon. Other jobs keep the runner Docker daemon. Full-suite acceptance remains incomplete until main-only protected hosted execution records every selected lane. See the [delivery status](../../specs/19-github-actions-test-coverage/delivery-status.md#delivery-status) for current proof boundaries and live gaps.

Each lane runs whole test files. The runner validates actual Node case results and required names; any skip or TODO fails a selected lane. Missing results, zero cases, failures and cleanup errors also fail. The aggregate checks required job and lane results at the same source commit without repeating case validation. Ordinary `pull_request` jobs may save pnpm-store caches within the PR merge-ref scope; protected jobs use the approved event commit and do not promote PR build artifacts.

Prepare infrastructure only on a disposable host or through the reviewed CI helpers. Each run owns its Compose project, file-specific databases, cluster and temporary files. CI writes private cleanup state under `RUNNER_TEMP` and uploads only sanitized result JSON, so hosted-runner cleanup state is unavailable after the job ends. Local failures can retain cleanup state while the host and state path still exist. On local Docker Desktop or equivalent VM-backed Docker hosts, run one Kubernetes lane at a time when disk or network pressure has caused measured instability. The GitHub matrix remains parallel; this local guidance is for reproducible operator runs. Model/service tests require the approved credentials and spend policy described in the [implementation specification](../../specs/19-github-actions-test-coverage.md); configuring workflow files does not prove those tests have passed.

See the [execution flow](../flows/github-actions-testing.md) for entrypoints, result accounting, cleanup and failure interpretation. Use the [suite-specific guides](README.md#integration-tests) to reproduce a run locally.

A lane retry replaces that lane's result artifact within the workflow run so the
aggregate reads its latest result. Other lanes keep their existing artifacts.
Preserve a failed result before retrying if it is needed for investigation;
earlier attempt logs remain available. Reruns still require every selected lane
and the aggregate to pass.

### Select immutable images for local preparation

Set `OPENCLAW_CI_K3S_IMAGE` to an approved `image@sha256:<digest>` reference before
running `node scripts/ci/prepare.mjs --lane <lane> --state <private-state-file>`
to bypass k3d's online release-channel lookup. Ordinary Kubernetes lanes default
to the `+v1.35` channel when this variable is absent. Both paths require the
running API server to report Kubernetes 1.35.x. OpenShell retains its separately
pinned cluster image. Invalid mutable overrides fail before resource creation.
Clean up a failed run's owned resources before preparing again with its state path.

Supplied immutable workload images can already exist in the local Docker daemon.
Preparation reuses one only when `docker image inspect` records the requested
digest in `RepoDigests`; a mutable tag or unverified local image is insufficient.
Missing or mismatched images are pulled and checked again before import. Other
Docker inspection failures stop preparation. Cleanup removes owned import tags
and preserves the supplied source image.

### Integration coverage by trigger

The [CI workflow](../../.github/workflows/ci.yml) runs seven noncredentialed lanes on
pull requests, pushes to `main`, merge groups, and manual dispatch.
[Full Integration](../../.github/workflows/full-integration.yml) runs only through
manual dispatch, using the requested lane or `all`. The `k3d-model` branch exception below does not enable other lanes outside `main`. It does not run
on pushes or merges. The `provider-account` lane remains manual because its
configured admin credential cannot authenticate from the hosted runner.

### Run Kubernetes model tests before merge

A repository administrator must add the exact branch name to the
`integration-model` environment's deployment branch rules, retaining `main`,
required reviewers, and self-review prevention. Wildcard rules do not satisfy
the preflight. This grants the reviewed branch access to the existing model
credential only after a reviewer approves the run.

```sh
gh workflow run full-integration.yml --ref '<approved-branch>' -f lane=k3d-model
```

The reviewer must inspect the run's commit before approval. Every job checks out
that immutable `github.sha`; moving the branch does not change an existing run.
The dispatcher cannot approve their own run. Have a different collaborator
perform one of those actions. Remove the branch rule after the proof completes.
Other lanes, including `all` and `provider-account`, remain main-only. This lane
runs the real Kubernetes topology tests, including embedded invalid-credential
cutover and recovery. It also runs the local first-Agent proof: a fresh installer
deploys and reuses their own Agent, verifies real model responses, and cannot
replace the credential after external changes. Ordinary fixture CI does not
run these tests.

### Integration tests outside automatic CI

The following integration files have no automatic workflow entrypoint.
A green `CI Required` check does not establish their coverage. This inventory describes workflow selection, not
whether a test has ever passed in a local or hosted run.

#### Manual Full Integration lanes

In GitHub Actions, these ten files run only when explicitly selected in
[Full Integration](../../.github/workflows/full-integration.yml), using
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
| `k3d-model`        | [local-first-agent-real.test.mjs](../../tests/integration/local-first-agent-real.test.mjs)                       | Fresh local Agent deployment and reuse with real model replies; external changes block credential replacement.           |
| `gateway-routing`  | [harness-topology-k3d-routing-real.test.mjs](../../tests/integration/harness-topology-k3d-routing-real.test.mjs) | Dedicated Codex consumption of workspace files through the real Envoy/OCC route.                                         |
| `production-tui`   | [production-tui-k3d-real.test.mjs](../../tests/integration/production-tui-k3d-real.test.mjs)                     | Helm-installed production control plane, interactive TUI, and revision cutover.                                          |
| `slack`            | [harness-topology-k3d-slack-real.test.mjs](../../tests/integration/harness-topology-k3d-slack-real.test.mjs)     | Real Slack ingress and a gateway-authored reply through the approved proxy and Codex Agent.                              |
| `provider-account` | [service-account-driver-real.test.mjs](../../tests/integration/service-account-driver-real.test.mjs)             | Actual ChatGPT service-account creation, credential delivery, and a dedicated Codex model turn.                          |
| `openshell`        | [sandbox-driver-openshell-k3d-real.test.mjs](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs) | Provider-owned dedicated Codex Harness and real OpenShell sandbox enforcement.                                           |
| `helper-timeout`   | [dev-up-timeout.test.mjs](../../tests/integration/dev-up-timeout.test.mjs)                                       | Full 300-second readiness deadline for a running but unready worker.                                                     |
| `k3d-otel`         | [harness-topology-k3d-otel-real.test.mjs](../../tests/integration/harness-topology-k3d-otel-real.test.mjs)       | Actual OTLP logs emitted during embedded and dedicated runtime model turns.                                              |

#### No GitHub workflow entrypoint

[repository-credentials-k3d-real.test.mjs](../../tests/integration/repository-credentials-k3d-real.test.mjs)
belongs to the explicitly selected `repository-credentials-installed` CLI lane.
It is excluded from both workflow groups and Full Integration dispatch options.
Follow the [installed repository credential qualification](repository-credentials.md)
procedure for protected App inputs, authorized live writes, model execution, and cleanup.

[repository-credentials-live.test.mjs](../../tests/integration/repository-credentials-live.test.mjs)
belongs to the `repository-credentials-live` lane, excluded from both workflow
groups and Full Integration dispatch options. Follow the
[repository credential qualification guide](repository-credentials.md) for the
authorized disposable repository, protected service setup, and cleanup. The
automatic container lane exercises controlled provider behavior and separate
container credential isolation. A passing run establishes only its selected
checks at its recorded source and images; it does not establish installed
platform or live-provider qualification.

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
its disposable Linux/systemd SSH host or invokes that lane. The readiness-only
selector proves real-host readiness, revision cutover, state isolation/persistence,
and deletion without a model call. The optional `OCC_TEST_SSH_MODEL=1` selector adds
[real provider execution and runtime credential proof](ssh.md#runtime-credential-model-proof).
Follow [SSH raw hosts](ssh.md#ssh-raw-hosts) for the disposable host, required
environment settings, and direct test command.

Every current `tests/integration/*.test.mjs` file has a suite-map owner. Ownership
alone does not mean a workflow runs it; keep this list aligned with both the
suite-map groups and workflow entrypoints.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
