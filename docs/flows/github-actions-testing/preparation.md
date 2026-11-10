# CI resource preparation

Prepare the resources for the selected source commit and test lane. See the [parent flow](../github-actions-testing.md) for its context and overall sequence.

## Execution trace

### 2. Prepare resources under the job owner

`scripts/ci/prepare.mjs:prepareFile`, `scripts/ci/prepare.mjs:ensureK3dCluster`

The static-checks job in `.github/workflows/ci.yml` also restores the pnpm store
using `scripts/docs-site/pnpm-lock.yaml`. It alone saves that documentation key,
after `docs:build` successfully runs Pagefind; installation can succeed even when
Pagefind's optional native package is missing. `run-ci-lane` restores the same key
before installing documentation dependencies for baseline part 1 and browser part 1.
The shared setup action keys each store by OS, architecture, Node.js, pnpm version,
and lockfile hash. Its existing prefix fallbacks can restore another lockfile's
store; frozen installation still acquires any missing packages. Root workspace
cache saves are unchanged.

First Agent Smoke and `run-ci-lane` both use `setup-ci-tools` to restore only yq and k3d downloads outside `PATH`. On Linux,
`scripts/ci/setup-tools.sh` selects the checked-in platform checksum before any
execution. `scripts/ci/download-pinned.sh` copies an installed PATH candidate or
cached bytes to private staging,
verifies that checksum, then atomically publishes the executable with mode 0755. Missing or corrupt entries
use the existing pinned downloader; unavailable cache storage or service does not
fail setup; verified cache hits do not rewrite the cache. PostgreSQL, image and
Kubernetes profiles share the cache. Keys include OS, architecture and installer
source. Direct callers can reuse verified installed bytes without a cache.

`scripts/ci/image-pull.ts:pullImage` logs each failed pull attempt before deciding
whether to retry, including the final attempt. It reports elapsed time, whether
the command timed out, and up to eight layer states from the captured output tails.
Only known Docker phases and hexadecimal layer IDs enter this progress summary;
unmatched output and a leading partial line at the tail cutoff are omitted.
The First Agent smoke adapter forwards both captured streams to this parser.
Diagnostic emission is best effort and cannot replace the terminal pull error.
Docker suppresses numeric progress on non-terminal
output, so these states provide partial evidence, not the current transfer phase. If no progress matches, the
summary says so. These diagnostics retain reported download and extraction
activity without changing timeouts, backoff, concurrency, or digest verification.
They do not establish registry health or explain why an attempt stalled.

The PR advisory OpenShell job uses Ubuntu 24.04 for Landlock and selects packaged Google Chrome through `OCC_TEST_BROWSER_EXECUTABLE`. The OpenShell manifest lists this optional input so test children receive it. Before image builds, `scripts/ci/setup-tools.sh:install_browser_dependencies` checks a headless sandboxed renderer and logs its version; errors fail setup. The browser inherits only `PATH`, with private `HOME` and `TMPDIR`. Ubuntu’s existing AppArmor profile permits its user namespaces. Without an override, Playwright uses its default headless shell.

`scripts/ci/prepare.mjs:validateLaneInputsBeforeSideEffects` requires the optional
Gateway and Agent image overrides together for lanes that declare both inputs.
It rejects a partial pair before creating state, so
`prepareK3dRuntimeImages` cannot replace an explicitly selected image with a local
build. Omitting both keeps the source-build path; supplying both keeps their
selected immutable references.

For the four ordinary image lanes, `scripts/ci/runtime-artifact.mjs` verifies the
selected same-workflow OCI artifact before `scripts/ci/prepare.mjs:buildRuntimeImages`
loads it under a run-owned tag. The artifact's index, platform manifest and config
have distinct digests; Docker's image ID is not assumed to be the config digest.
The loader checks archive integrity, source commit, workflow run and platform,
then verifies the loaded image. Preparation records the tag before loading so
failure cleanup can remove it. A selected artifact cannot be combined with an
alternate OpenClaw source checkout, and loading failure does not fall back to a
build. The existing runtime environment aliases refer to that tag; packaging's
controller build and each lane's Envoy or seccomp preparation remain separate.
The three runtime startup lanes omit Buildx setup when they select this artifact.
Packaging retains its builder for the controller and image tests; source builds
without an artifact retain their existing builder.

The preparation CLI records run-owned resources in a private state file before creating them. GitHub Actions passes that file under `RUNNER_TEMP`; it is available to later steps in the same job and is not uploaded as an artifact. Database tests receive a fresh migrated database per file and use the limited application role; the Agent revision worker suite also gives each test a copy of a migrated template (`prepareFile({ template })`). Failure and Kubernetes database names satisfy the existing test admission guards. An ordinary cluster lane selects an explicit loopback k3d context and asks the pinned k3d binary to resolve its current `v1.35` K3s image. After node readiness, preparation reads the real server version and rejects a cluster outside the Kubernetes 1.35 family. OpenShell retains its separately pinned K3s image. External images are pulled by their approved registry digest and exported for the selected platform; built and external images receive a run-owned reference at the imported platform manifest digest. Preparation records the original source image and checks Kubernetes CRI resolution before passing the immutable runtime reference to tests. The CLI-only installed repository lane is temporarily refused in `validateLaneInputsBeforeSideEffects`, before its input checks and before any state or resource is created, until its remote cleanup is safe; its image and seccomp preparation below is unreachable in this source version. When either production TUI upgrade candidate is selected, preparation requires both candidate and baseline controller/runtime digests before allocating resources. It imports the four supplied sources, rejects a candidate resolving to the same local image as its baseline, and records their source and imported identities in private state. Per-file preparation checks the same selection against that state and passes the imported references to the test. Without candidate images, the lane builds the current source as before. Preparation failures still enter job cleanup. Cluster cleanup reads k3d inventory before and after deletion, then checks for matching Docker containers, networks, and volumes. An invalid inventory or possible surviving resource retains cleanup state.

Before creating the bootstrap directory beside the state file,
`scripts/ci/prepare.mjs:ensurePostgresServer` records its absolute path. It refuses
an existing directory and retires the planned record if directory creation fails.
It confirms directory creation, then exclusively creates a private copy of
`migrations/init-local.sql` and confirms its creation in state. It makes the public
SQL readable by the container user and passes it to Compose as
`OPENCLAW_CI_POSTGRES_INIT_SQL`. The checkout is unchanged.

`scripts/ci/cleanup.mjs:cleanupComposePostgres` checks the exact directory path
against the opened state file. Without directory confirmation, it preserves any
directory at that path and retains state. Without SQL confirmation, it removes
only an empty confirmed directory. After Compose teardown, it removes the
confirmed SQL file and its empty directory. Unexpected contents or failed
teardown retain cleanup state.

If Docker exhausts its subnet pools during Compose startup, preparation preserves
the error, adds the command to clean up the recorded project, and leaves the
planned resource for caller cleanup. See [subnet pool recovery](../../testing/postgresql.md#subnet-pool-exhaustion).

For hosted repository QA, `scripts/ci/qa-matrix-credentials.mjs` reads the selected
reviewed registry file only when a repository scenario is selected. It copies
that metadata, the selected private App key and approved endpoint CIDRs into one
private input directory under `RUNNER_TEMP`. Both fixtures pass that directory to
the repository consumer and independent App-backed observer. The observer mints
short-lived tokens for the selected repository; its credentials stay outside
Agents. It checks run ownership before closing a pull request or deleting a branch
with an exact-SHA lease. Invalid file input or an isolated target mismatch fails
before the runner receives credential paths.

For hosted `qa-matrix` jobs, `scripts/ci/lane-images.ts:imageInventory`
records tagged or digest-pinned image references and their IDs in private
`lane-images` state before tests. If the inventory fails, preparation warns and
records no baseline. Workstation runs record none. During cleanup,
`restoreLaneImages` attempts to restore changed or missing baseline tags matching
the QA launcher patterns and remove newly observed matching tags. Cleanup does
not target other references. A successful final inventory reports added, changed,
and missing references. If the first cleanup inventory fails, cleanup warns and
skips both restoration and removal. If the final inventory fails, cleanup warns
and reports `added`, `changed`, and `missing` as `null`: the final store
state is unknown. Tag and inventory failures warn rather than fail the job.
A returned resource is removed from state; invalid state or ownership still
fails cleanup. These results do not prove
the runner accepted a shared-store commit.

For each Kubernetes fixture lane, `scripts/ci/prepare.mjs` creates one server and one worker with a shared task-owned local-path mount. It reads the worker Pod CIDR and the server route to that network, validates the route source, and exports its single-address `/32` as `OCC_TEST_KUBERNETES_PLUGIN_STATUS_PROXY_CIDRS`. Image preparation registers and checks the imported digest alias on both nodes. A minimal DaemonSet keeps that local-only image active on each node for the lane so kubelet image garbage collection cannot remove it between fixture tests. The DaemonSet exposes no Service and is removed with the disposable cluster. The status suite schedules the runtime on the worker so a node-local bypass cannot conceal a missing proxy ingress rule.

`scripts/ci/prepare.mjs:buildFixtureImage` reports separate engine-version and
fixture-build stages. The engine probe uses the existing image-command
limit (30 seconds by default); the fixture build has a 30-minute cap to allow slow builds. These are execution limits, not
expected durations. Both commands also respect the remaining lane deadline less
the test reserve, recalculated before each command. Without a valid lane deadline,
the finite command limits still apply. Unsupported timer values are rejected.
An exhausted budget reports the stage that could not start. On POSIX, timeouts
terminate the command's owned process group, including local descendants. The
shared `scripts/ci/cleanup-command.mjs` supervisor anchors the group ID through
its last signal, including when preparation receives SIGINT cancellation; after
it exits, preparation sends no further group signals. Windows retains direct-child
termination. A failed build reports up to eight numbered FROM, RUN or COPY steps
and their reported completion states from the last 32,768 characters of each captured stream.
The step summary omits arguments, container output and arbitrary error text. This partial
summary identifies steps in the fixture Dockerfile; it does not establish the
current build phase or cause of a stall. The timeout keeps its concise stage error
and original cause. The owned image tag is recorded before
building and becomes ready only after success, so failed preparation remains
available to cleanup.

Preparation checks the storage controller before fixture setup, then restarts it
after image registration and requires the replacement to become ready before
publishing test inputs. Per-file cleanup repeats the health check while preserving
database cleanup. Failures report the last 30 lines of storage-controller logs, Pod scheduling
conditions, and node pressure/taints outside the sanitized test reporter; they do
not include tenant workloads or complete Pod specifications.

The runtime image recipe pins compatible OpenClaw, Codex-plugin and Slack-plugin releases together with the Codex app-server version required by the plugin. Image startup smoke verifies fresh-home plugin loading, actual app-server initialization, and nested Codex home ownership for generated images and credential files before credentialed tests. Routing additionally requires the Gateway identity-scope contract; embedded continuity requires outgoing media to remain visible through history and artifact APIs across Pod replacement. A successful image build alone establishes none of those live outcomes.

`scripts/ci/prepare.mjs:reuseEngineImage` asks BuildKit whether the restored cache
resolves to an image already in the engine; a cache miss builds it. In CI, the
probe and subsequent build share the remaining `CI_RUNNER_DEADLINE_MS` budget,
reserving three minutes for preparation and tests. Exhaustion reports `Image
build out of lane time`, starts no further build, and leaves owned-tag removal to
job cleanup. Local runs and main's cache warmer have no lane deadline. The warmer
gives the OpenClaw build and final runtime assembly one shared 180-minute budget;
controller builds retain 20 minutes. Each export has a separate 20-minute limit
within the 210-minute job. These are cancellation limits, not expected durations;
cold Node compilation exceeded the former 20-minute build limit.

For dedicated Codex preparation (and installed repository-credential preparation, once that lane is available again), each owned node supplies its actual `RuntimeDefault` syscall profile from a restricted probe Pod. In the same command path, preparation first verifies that `RuntimeDefault` denies the pinned Codex Bubblewrap sandbox, then preserves that baseline, adds the version-pinned Bubblewrap calls, installs the resulting Localhost profile, verifies its hash and effective OCI policy, and requires actual sandbox execution through the profile. A missing profile must prevent container creation. The selected relative profile path is passed to the live fixture as `runtime.codexSeccompProfile`; only the dedicated Codex container uses it. Node profile files belong to the disposable cluster, and temporary probe resources are cleaned before model tests. The live fixture checks the effective configured model before paid model turns. OpenShell continues to own containment for its provider-created Harness.

The suite map owns fixed selection flags, required input names, and the resources each lane needs. Preparation consumes those descriptors instead of maintaining parallel lane lists. External model, ChatGPT and Slack credentials come only from the selected protected environment. Missing selected inputs fail rather than turning the lane into a skipped success.

Current setup contract: routing preparation installs pinned Gateway API, cert-manager v1.18.4, and Envoy Gateway v1.6.7 controllers and creates a private test CA. It builds and imports immutable controller and runtime references so the routing proof can run OCC inside Kubernetes and reach Envoy through the normal ClusterIP Service. OpenShell preparation uses the digest-pinned K3s v1.36.4 image with its `runc` handler, installs a matched kubectl, verifies the selected RuntimeClass with a smoke Pod, installs Agent Sandbox resources, acquires the OpenShell CLI/chart, and imports gateway, sandbox, and supervisor images. The RuntimeClass smoke proves runtime availability; the full OpenShell lane must prove the separate supervisor enforces approved filesystem access, process privileges, and binary-scoped endpoint/L7 network policy. The Harness and supervisor receive neither `SYS_PTRACE` nor `DAC_READ_SEARCH`. Before creating the OpenShell cluster, preparation writes a private admission config under the owned cluster directory and mounts that exact file read-only into its server. Only the selected RuntimeClass is exempt; namespace and username exemptions remain empty. The API server must reject a violating ordinary Pod in a restricted namespace and admit the same Pod with the selected class before the RuntimeClass availability smoke runs. Logging preparation starts an owned OpenTelemetry Collector backend and passes JSONL evidence to selected tests. The Collector and Docker-model jobs use the shared [setup-test-docker action](../../../.github/actions/setup-test-docker/action.yml) to pin Docker 29.9.2, which supports the production `fluentd-write-timeout` logging option. The action stops the preinstalled daemon on the ephemeral runner, installs Docker 29.9.2 through the SHA-pinned official Docker setup action, and points `/var/run/docker.sock` at the action socket so the CLI, production Compose, and Driver use one daemon. Other jobs keep the runner Docker daemon. Full-suite acceptance remains incomplete until main-only protected hosted execution records every selected lane. The [delivery status](../../../specs/plans/19-github-actions-test-coverage/delivery-status.md#delivery-status) owns current proof boundaries and live gaps.

The OpenShell test owns its management port-forwards for the full test lifetime. Teardown stops the worker before draining those forwards, then attempts the remaining app, database, namespace, and directory cleanup even if an earlier step fails. Forward shutdown sends `SIGTERM` and waits two seconds for child exit. It then sends `SIGKILL` if necessary and waits two more seconds. A cleanup error fails the test.

## Related

- [Return to the parent flow](../github-actions-testing.md).
