# GitHub Actions testing

Choose automated or manual test lanes and understand their coverage.

## GitHub Actions

Metrics HTTP/persistence coverage belongs to the `postgres-application` lane, including a
separate migrator-role connection for test-only table contention. The
`logging-collector` lane also runs real Prometheus/Grafana collection and
dashboard provisioning. See [metrics testing](metrics.md) for local setup.

The [suite index](../../scripts/ci/test-suites.json) holds lane references and coverage groups. Each `scripts/ci/test-suites/<lane>.json` owns its files, inputs, environment and resources; edit it for test changes, or the index for lane or group changes. The [loader](../../scripts/ci/test-suites.mjs) assembles them. Check that every test file under `tests/conformance`, `tests/integration`, `tests/browser` and `tests/docs` has one lane owner:

```sh
node scripts/ci/run-tests.mjs audit
```

CI uses [run-ci-lane](../../.github/actions/run-ci-lane/action.yml) for setup, tests, cleanup and job isolation.

The non-required [First Agent smoke](first-agent-smoke.md) installs Local Setup and deploys two Agents against a stand-in model provider on every run.

Full CI has twenty required lanes. `checks-baseline-1` and `checks-baseline-2` split the baseline conformance and local integration files by measured file durations. Only part 1 runs the type and Go CLI checks and installs the docs site its docs tests need; part 2 builds the workspace output its tests read. Register new baseline files in either part, keeping job times close. Lanes with `fileConcurrency` run `parallelFiles` up to that many at once, longest first; other files, including `serialFiles`, run alone first. `checks-browser` and `checks-browser-2` split browser tests likewise, plus some baseline files (only part 1 installs the docs site); `postgres-auth` owns sign-in, session and account authentication tests and its own PostgreSQL server; `images-model-probes` builds only the runtime image and runs the CPU-contention model probe without a cluster; `images-runtime-startup` and `images-runtime-startup-2` each build the runtime image and run startup smoke files apart from packaging (part 2 also the other model probes); `runtime-image-startup.test.mjs`, `runtime-image-startup-probe.test.mjs`, `runtime-image-gateway-peer.test.mjs` and `runtime-image-native-worker.test.mjs` are split by measured case durations and share `tests/helpers/runtime-image-startup.mjs`.

Hosted image builds use separate controller/runtime caches. Packaging exports on main pushes; model probes, runtime startup and the repository credential platform restore. A never-cancelled main [cache workflow](../../.github/workflows/ci-image-cache.yml) also exports; pull requests only read main's cache. The platform lane loads its cached runtime image into the Docker engine and derives its fixture from it with the default builder. Transfers time out after one minute, export failures are ignored, and builds load locally. Cache credentials stay in preparation. Local builds remain unchanged.

Compare per-file `wallDurationMs`, preparation `[ci-timing]` phases and Actions timestamps for slow setup or tests. [k3d image preparation](ci-k3d-images.md) covers how images reach the cluster nodes.

`static-checks` runs `pnpm docs:check` and the [dependency policy](repository-boundaries.md). Pages above 1,500 visible words require review; above 2,500 fail except the approved [API reference](../reference/api.md) and `AGENTS.md` files. The generated API, site build, navigation, and links must pass. The [specification check](../contributing/specifications.md#status-and-review) also validates non-archived RFC metadata and spec link targets. Run `pnpm docs:check-length` for word counts alone.

CI Impact and Suite Audit start independently. Full mode runs the nineteen-lane matrix and `runtime-image-fixture`; `CI Required` requires their outcomes and same-source artifacts. Kubernetes fixture and observability lanes use `ubuntu-22.04` for bridge netfilter support; `runtime-image-fixture` and `CI Required` also use it. The repository credential platform lane uses `blacksmith-16vcpu-ubuntu-2404` to build the delivered runtime image and platform fixture in one job; other lanes and the audit use `blacksmith-8vcpu-ubuntu-2404`.

In every mode, `static-checks` verifies checkout identity and runs the workspace, lint, format, OpenAPI and docs checks beside the lanes. The docs check covers word limits, site links and navigation, but not outgoing links in root or `specs/` Markdown. Docs mode (a verified documentation-only PR merge tree) runs no product tests. `CI Required` verifies the mode and requires successful impact, audit and static checks, with docs mode's test jobs skipped. Missing, failed, cancelled or unexpectedly skipped selected jobs fail. Docs mode does not run the test-result aggregator or require test artifacts.

Test-only PRs run only their files' `ci` lanes plus `checks-baseline-1` ([rules](../flows/github-actions-testing.md)).

An independent full-mode PR advisory job reports pnpm's affected TypeScript workspace packages for verified, clean PR merge checkouts. It uses declared package dependencies; Go, files outside a workspace package, non-TypeScript changes and missing evidence are reported as unavailable. It does not select or skip tests and cannot change the required CI result.

API reference outputs and Markdown under `docs/reference/api/` select full for `openapi:check`. The selector loads policy from, and compares against, the tested merge's first parent: the current base, which is newer than the event base when the base moved after a push. An event base present in the checkout must be its ancestor. Code, configuration, workflow, mixed or unknown changes and non-PR events select full; unavailable or unverifiable evidence selects full or fails closed. A base without the selector also selects full. Hosted validation is not yet established.

The `pull_request` workflow itself is PR-controlled. Base-controlled selector
policy does not prevent a changed workflow from bypassing these checks. A trusted
required workflow or other external enforcement is not established by this
source. See the [testing flow](../flows/github-actions-testing.md) for details.

The repository credential platform lane proves HTTP, PostgreSQL, Unix control and credential material inside
Kubernetes; compatible fixture lanes prove NetworkPolicy enforcement. The first
runtime startup lane derives the reviewed Codex seccomp profile in an owned k3d
cluster and requires `OCC_TEST_CODEX_SECCOMP_PROFILE`; the second runs no Codex
sandbox, so it needs no cluster.

Full Integration uses the immutable event commit. Lanes require `main` except
`k3d-model` and `openshell`, which accept exact protected-environment branch
rules. The main-only `provider-account` lane needs no per-run approval; other
credentialed environments require approval. `helper-timeout` and standalone
`logging-collector` have no environment gate. Missing inputs fail, and a targeted
run proves only its selected lane.

The `postgres` lane owns migration compatibility; `postgres-application` owns the
revision-worker, IAM barrier, metrics and auth-maintain tests; `postgres-auth` owns sign-in,
session and account authentication; `postgres-platform` owns the connection,
bootstrap, wire-up, platform-state, restart and password sign-in limit tests and the
remaining PostgreSQL files. Each has a disposable PostgreSQL server. The split
follows measured file durations, so add a new file to `postgres-platform` or
`postgres-auth`, keeping the job times close.
Kubernetes fixture files run in `k3d-fixture-configuration`,
`k3d-fixture-state`, and `k3d-fixture-plugins`, each with independent cluster,
database, image, and cleanup state. Each lane runs its audited `parallelFiles` two at a time. The audit requires one owner per file; Full Integration aggregates its selected `full` group or targeted lane.

The `repository-credentials-container` lane builds
`.build/repository-credentials/{service,client}` with Dockerfiles under
`deploy/runtime/repository-credentials/` and records source, `gh` version and
three image IDs, selected through
`REPOSITORY_CREDENTIALS_TEST_IMAGE`, `REPOSITORY_CREDENTIALS_SERVICE_IMAGE` and
`REPOSITORY_CREDENTIALS_CLIENT_IMAGE`; its real Git/gh fixtures also receive
`REPOSITORY_CREDENTIALS_NODE_IMAGE` and the extracted, version-checked
`REPOSITORY_CREDENTIALS_GH_BINARY`. The [credential test guide](repository-credentials.md)
separates detached artifacts, the combined image, rendered Compose, running
container isolation and authorized live proof. Preparation and suite ownership
do not establish a result: inspect executed cases and skips at the tested
commit, including whether a pull-request run tested a merge commit.

Kubernetes fixture lanes load bridge netfilter and enable IPv4 bridge filtering
before cluster creation so K3s enforces NetworkPolicies on bridged Pod traffic.
Setup fails if this cannot be enabled; deny-traffic assertions remain required.

Each Kubernetes fixture lane owns a server/worker cluster with shared test-owned
local-path storage. Preparation registers and verifies the fixture image digest
on both nodes and derives the API server proxy source `/32` from its route to
the worker Pod network. The [plugin status tests](plugins.md#local-and-integration-suites)
use that address to exercise the private status endpoint across nodes with
NetworkPolicy enforcement.

Kubernetes fixture startup logs phase timings and host resource and pressure snapshots. On cluster or readiness failure, preparation collects bounded
node, system Pod, event and redacted node-container diagnostics before cleanup;
k3d rollback is disabled long enough to retain them. Inspect the
`diagnostics-<artifact-prefix>-<lane>` artifact or local
`<state-file>.diagnostics.json`. Failed diagnostic commands are marked unavailable or timed out; collection preserves the original failure. Raw
kubeconfig, environment values and Pod specs are excluded. In k3d lanes the runner
sets `OPENCLAW_CI_CONTAINER_LOG_DIR` for each file; a failed wait that follows a
container log there adds the redacted log under `containerLogs`. After a failed prepared
run, local callers must run `node scripts/ci/cleanup.mjs --state <state-file>`.
Diagnostics explain setup failures without establishing coverage.

The `k3d-model`, `gateway-routing`, `slack`, `openshell`, and `k3d-otel` lanes prepare the controller image and workspace routing for dedicated Harness node enrollment. Supply an immutable Node 24 `NODE_BASE_IMAGE`; gateway-routing, Slack and OpenShell CI use the repository variable `CONTAINER_NODE_BASE_IMAGE`. Preparation supplies the imported controller digest and private routing CA paths; Slack still requires approved runtime images and credentials.

Routing, OpenShell, and logging have CI preparation contracts. Routing installs
pinned Gateway API, cert-manager v1.18.4 and Envoy Gateway v1.6.7 manifests and
generates a private test CA. OpenShell creates an owned K3s v1.36.4 cluster,
installs a matched kubectl, configures and smoke-tests the selected RuntimeClass
with the cluster's `runc` handler, installs CLI/chart and Agent Sandbox assets,
and imports gateway and supervisor images. Only that disposable cluster exempts
the selected RuntimeClass from Pod Security Admission; preparation proves an
ordinary violating Pod is rejected and the same Pod is admitted with that class.
The full OpenShell suite proves provider-owned supervisor filesystem, endpoint/L7
network, and process enforcement while the sidecar policy remains binary-unaware.
Logging preparation owns a real OpenTelemetry Collector backend with JSONL evidence;
`OCC_TEST_OTEL_LOGS_URL` is no longer an external input. The Collector and
Docker-model jobs use [setup-test-docker](../../.github/actions/setup-test-docker/action.yml)
to pin Docker 29.4.0 for the production `fluentd-write-timeout` option. It replaces
the preinstalled daemon and shares `/var/run/docker.sock` across the CLI, Compose,
and Driver; other jobs keep the runner daemon. Full-suite acceptance requires
main-only protected hosted execution of every selected lane. See the
[delivery status](../../specs/plans/19-github-actions-test-coverage/delivery-status.md#delivery-status)
for proof boundaries and live gaps.

Each lane runs whole test files. The runner validates Node case results and required names; skips, TODOs, missing results, zero cases, failures and cleanup errors fail the selected lane. The aggregate checks required job and lane results at the same source commit without repeating case validation. Ordinary `pull_request` jobs may save pnpm-store caches within the PR merge-ref scope; protected jobs use the approved event commit and do not promote PR build artifacts.

Prepare infrastructure only on a disposable host or through reviewed CI helpers.
Each run owns its Compose project, databases, cluster and temp files. CI writes
private cleanup state under `RUNNER_TEMP` and uploads sanitized results and
bootstrap diagnostics; hosted-runner state disappears after the job.
The images-packaging lane attempts to retain sanitized cleanup records for its
prepared controller and runtime tags, but not the separate runtime-images test tag.
A planned record does not prove an image exists; export or upload failure or
runner loss can prevent retention. Missing state or an empty inventory does not
prove cleanup; a tag name is metadata, not authentication or deletion authority.
Results include source commit, case outcomes, cleanup status and available image
digests by role, excluding private registry names and prepared environment values.
Local failures can retain cleanup state while the host and state path exist. On
Docker Desktop or similar VM-backed hosts, run one Kubernetes lane at a time when
measured disk or network pressure has caused instability; the GitHub matrix remains
parallel. Model/service tests require the approved credentials and spend policy in
the [implementation specification](../../specs/plans/19-github-actions-test-coverage/index.md).

See the [execution flow](../flows/github-actions-testing.md) for entrypoints, result accounting, cleanup and failures. Use the [suite-specific guides](README.md#integration-tests) to reproduce runs locally.

Failed browser tests upload
[diagnostics](local.md#browser-failure-diagnostics).

A retry replaces its lane result artifact; other lanes keep theirs. Each attempt's results also remain as `attempt-<run attempt>-<artifact-prefix>-<lane>`, and each failed case's redacted message is in that attempt's job log. The `k3d-fixture-configuration` lane also logs a memory summary about once a minute and uploads its memory samples as `memory-<artifact-prefix>-<lane>-attempt-<run attempt>`; see the [execution flow](../flows/github-actions-testing.md#4-clean-up-and-publish-the-bounded-result). Full-mode reruns require every selected lane and aggregate to pass.

### Select immutable images for local preparation

See [k3d image preparation](ci-k3d-images.md#select-immutable-images-for-local-preparation).

### Integration coverage by trigger

The [CI workflow](../../.github/workflows/ci.yml) runs on pull requests, pushes to `main`, merge groups, and manual dispatch.
[Full Integration](../../.github/workflows/full-integration.yml) runs only by
manual dispatch, using the requested lane or `all`, not on pushes or merges. The
`k3d-model` and `openshell` branch exceptions below do not enable other lanes outside `main`.
`provider-account` remains manual because its configured admin credential cannot
authenticate from the hosted runner.

[Authoritative checked-in dispatcher](../../.github/workflows/clawsweeper-dispatch.yml); [setup/verification/recovery](../flows/clawsweeper-dispatch.md#setup-and-first-run-verification).

### Run protected model tests before merge

An administrator adds the exact branch to `integration-model` for `k3d-model` or
`integration-openshell` for `openshell`, retaining `main`, required reviewers,
and self-review prevention. Wildcards fail preflight. Credentials become
available only after approval.

```sh
gh workflow run full-integration.yml --ref '<approved-branch>' -f lane=k3d-model
gh workflow run full-integration.yml --ref '<approved-branch>' -f lane=openshell
```

The reviewer inspects the commit before approval. Jobs check out immutable
`github.sha`; moving the branch does not change the run. The dispatcher cannot
self-approve. Remove the branch rule after proof completes.
Other lanes, including `all` and `provider-account`, remain main-only. The
`k3d-model` lane runs real Kubernetes topology tests, including embedded
invalid-credential cutover and recovery. The `openshell` lane runs the
first-Agent proof with both Compose and Kubernetes control planes. Each proof
deploys and reuses an Agent, verifies real model responses, and rejects credential
replacement after external changes. Ordinary fixture CI does not run these tests.

### Integration tests outside automatic CI

Some integration files have no automatic workflow entrypoint, so a green `CI Required` check does not establish their coverage. [Integration tests outside automatic CI](ci-manual-integration.md) lists the manual Full Integration lanes and the CLI-only lanes.

#### Manual Full Integration lanes

See [manual Full Integration lanes](ci-manual-integration.md#manual-full-integration-lanes).

#### No GitHub workflow entrypoint

See [no GitHub workflow entrypoint](ci-manual-integration.md#no-github-workflow-entrypoint).

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).

## Production observability lane

`k3d-observability` checks raw metrics and OTLP exports in PR/main CI on Ubuntu
22.04. The [Observability Demo workflow](../../.github/workflows/observability-demo.yml)
runs `k3d-observability-demo` for relevant changes, merge groups, and manual dispatch;
Full Integration includes it with `all`. Both retain strict case counts, image
digests, and cleanup.

Gateway/Codex model-log proof remains in protected `k3d-otel`; ordinary CI does
not establish it. See [local commands, scope, and prerequisites](metrics.md#kubernetes-observability-acceptance).
