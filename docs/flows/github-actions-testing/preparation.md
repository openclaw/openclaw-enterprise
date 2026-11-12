# CI resource preparation

[Parent flow](../github-actions-testing.md).

## Execution trace

### 2. Prepare resources under the job owner

`scripts/ci/prepare.mjs:prepareFile`, `scripts/ci/prepare.mjs:ensureK3dCluster`

Static Checks restores the documentation pnpm store and alone saves it after
Pagefind builds; installation can omit its optional native package.
`run-ci-lane` restores that store for baseline part 1 and browser part 1.
Keys include OS, architecture, Node.js, pnpm and lockfile hash. Prefix fallbacks
can restore other lockfiles; frozen installation acquires missing packages.

First Agent Smoke and `run-ci-lane` use `setup-ci-tools` to restore yq and k3d
downloads outside `PATH`. On Linux, `scripts/ci/setup-tools.sh` selects the
checked-in platform checksum. `scripts/ci/download-pinned.sh` verifies installed
or cached bytes in private staging before atomic publication with mode 0755.
Missing or corrupt entries use pinned downloads; cache outages do not fail setup. Hits preserve cached bytes.
PostgreSQL, image and Kubernetes profiles share OS-, architecture- and
installer-source-keyed caches. Direct callers can reuse verified installed bytes.

For packaging and shared-runtime artifact consumers using `run-ci-lane`,
`scripts/ci/setup-registry-transport.sh:verify_skopeo` reuses working `PATH` tools;
packaging requires version 1.13.3. Missing, broken or mismatched tools trigger
APT update and installation from configured repositories with signature checks.
Version probes allow 10 seconds plus 5 seconds before forced termination;
each APT command allows 120 plus 10 seconds, three acquisition retries and
20-second HTTP/HTTPS timeouts. Sudo is non-interactive. Failed updates prevent
installation. APT output and failure status are preserved.
The final probe must pass.

`scripts/ci/image-pull.ts:pullImage` logs each failed pull attempt before deciding
whether to retry, including the final attempt. It reports elapsed time, timeout status and up to eight layer states from captured output tails.
The summary includes only known Docker phases and hexadecimal layer IDs;
it omits unmatched output and leading partial lines at the tail cutoff.
The First Agent smoke adapter forwards both captured streams to this parser.
Diagnostic emission is best effort and cannot replace the terminal pull error.
Docker suppresses numeric progress on non-terminal
output, so these states provide partial evidence, not the current transfer phase. If no progress matches, the
summary says so. Diagnostics change no timeouts, backoff, concurrency or digest verification, and establish neither registry health nor stall causes.

The PR advisory OpenShell job uses Ubuntu 24.04 for Landlock and selects packaged Google Chrome through `OCC_TEST_BROWSER_EXECUTABLE`. The OpenShell manifest lists this optional input so test children receive it. Before image builds, `scripts/ci/setup-tools.sh:install_browser_dependencies` checks a headless sandboxed renderer and logs its version; errors fail setup. The browser inherits only `PATH`, with private `HOME` and `TMPDIR`. Ubuntu’s existing AppArmor profile permits its user namespaces. Without an override, Playwright uses its default headless shell.

For lanes declaring both optional immutable image inputs,
`scripts/ci/prepare.mjs:validateLaneInputsBeforeSideEffects` rejects partial
Gateway/Agent pairs before creating state. `prepareK3dRuntimeImages` imports the
selected artifact or builds source when both are absent; selected pairs retain their immutable references.
Controller build selection is independent.

`scripts/ci/prepare.mjs:imageBuildArgs` restores read-only caches, including
`k3d-otel`. `prepareLane` primes selected `sourceBuildFiles`;
each OpenShell lane builds its stack. Tests inherit builder and epoch,
not cache credentials; installers still build source.
`openshell-build-inputs` resolves the `integration-main` controller base for
`all`/`openshell` builds, including Local Setup. `openshell-image-cache` requires
caller-source exports and successful cleanup before admission. Strict export
errors propagate after sibling settlement; standalone exports remain best effort.
Queued writers remain unordered by commit; mutable caches permit misses.
`imageCacheObservation` counts steps/imports for Gateway Routing, Slack Live,
Production TUI, `k3d-otel` and OpenShell, including alternate sources.
It deduplicates step IDs; import lines do not prove hits. Loads may reuse probes.

Image lanes, First Agent Smoke, Docker Model Runtime, Gateway Routing and
Production TUI fetch artifacts by repository/run/artifact IDs with `actions: read`.

Docker Model Runtime requires an artifact ID on producer success. Failure or
skip selects standalone builds. Local import cancels three minutes before the
lane deadline. Gateway Routing and default
Production TUI share that deadline. Full and focused runs wait for the producer
before controller preparation and runtime import. `integration-main` snapshots
the Gateway/Agent pair; consumers reject incomplete mode, pair or artifact ID
before setup. Focused explicit pairs skip the producer. Artifacts cannot accompany
Gateway inputs or TUI upgrade candidates; conflicts fail before allocation.

`loadRuntimeArtifact` verifies archive, source/run/attempt, platform, OCI
index/manifest/config digests and loaded image. Docker image IDs can equal config digests. `buildRuntimeImages` records ownership before import, rejects
alternate sources and import fallback, and sets aliases. Startup skips Buildx;
packaging/source builds retain it. Envoy and seccomp stay separate.

First Agent Smoke's `prepareRuntimeArtifactLayout` verifies compressed and
uncompressed layer digests; Buildx builds its trust layer from the verified
platform manifest digest.

Before tagging or import, the CLI records image ownership in private
`RUNNER_TEMP` state, excluded from uploads. Database tests use the limited
application role and fresh migrated databases; Agent revision worker tests use
migrated template copies (`prepareFile({ template })`). Failure and Kubernetes
database names satisfy admission guards.

Ordinary lanes select loopback k3d contexts and digest-pinned Kubernetes 1.35 K3s;
readiness rejects other server versions. OpenShell keeps its separate K3s pin.
External images use approved registry digests and the selected platform. All
images receive run-owned references at their imported platform manifest digests.
Preparation pins OCI or Docker manifests against kubelet garbage collection.
Every node must report the expected containerd digest and an exact CRI
digest-list entry with boolean `pinned: true`. Manual imports are excluded.

TUI upgrades require both candidate and baseline controller/runtime digests
before allocation. Preparation imports all four, rejects candidates resolving to
their baselines, and records source and imported identities. File preparation
checks that selection and passes imported references to tests. Otherwise,
preparation builds the controller and imports the selected runtime artifact or
builds source. Failures enter cleanup, which checks k3d inventory before and after
deletion, then matching Docker containers, networks and volumes. Invalid inventory
or possible survivors retain state.

The retired CLI-only installed repository lane is absent from the manifest:
`assertLane` rejects it before allocation; its preparation below is unreachable.

`scripts/ci/prepare.mjs:retainRuntimeProvenance` compares platform-selected host
and CRI config digests. `scripts/ci/runtime-provenance.ts:readImageCodexProvenance`
reads bounded metadata; results and diagnostics retain only their preparation's evidence.
Missing metadata records `unavailable`; image policy is unchanged.
Extraction journals IDs before removal. Cleanup removes containers and anonymous volumes. Journal and cleanup errors fail preparation; unresolved resources retain receipts.

`scripts/ci/prepare.mjs:ensurePostgresServer` journals exclusive bootstrap-directory
and SQL-copy ownership. It refuses existing paths and retires failed directory
records. Its container-readable `migrations/init-local.sql` copy is selected by
`OPENCLAW_CI_POSTGRES_INIT_SQL`.

Docker assigns the loopback port. Preparation rejects missing, non-loopback and
`55432` mappings before connecting. Failed discovery retains pending `0` and
prevents database preparation. Mixed fixture lanes start PostgreSQL before k3d.
Model lanes start k3d first and attach PostgreSQL before port discovery: Docker
can reassign automatic ports on attachment. Tests retain that attachment;
reverse-order cleanup removes PostgreSQL first.

`scripts/ci/cleanup.ts:cleanupComposePostgres` validates the directory against state.
Unconfirmed ownership preserves contents/state. Directory confirmation alone permits
empty-directory removal; confirmed SQL is removed after Compose teardown. Unexpected
contents or teardown failure retain state. Subnet exhaustion preserves the original
error and planned resource and prints [owned cleanup](../../testing/postgresql.md#subnet-pool-exhaustion).

`prepareFile` registers child identities.
`prepareLane` atomically publishes complete journals without replacement. Cleanup opens regular files,
verifying identity, lane and path. Tests require fresh registered children.
Worker death remains recoverable; mismatches, symlinks and failures preserve
journals and parent references.

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
expected durations. Both commands respect the remaining lane deadline less
the test reserve, recalculated before each command. Without a valid lane deadline,
the finite command limits still apply. Unsupported timer values are rejected.
An exhausted budget reports the stage that could not start. On POSIX, timeouts
terminate the command's owned process group, including local descendants. The
shared `scripts/ci/cleanup-command.ts` supervisor anchors the group ID through
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

The runtime image recipe pins compatible OpenClaw, Codex-plugin and Slack-plugin releases together with the Codex app-server version required by the plugin. Image startup smoke verifies fresh-home plugin loading, actual app-server initialization, and nested Codex home ownership for generated images and credential files before credentialed tests. Routing additionally requires the Gateway identity-scope contract; embedded continuity requires outgoing media to remain visible through history and artifact APIs across Pod replacement. Image builds alone prove none of these outcomes.

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

Routing preparation installs pinned Gateway API, cert-manager v1.18.4, and Envoy Gateway v1.6.7 controllers and creates a private test CA. It builds and imports immutable controller and runtime references so the routing proof can run OCC inside Kubernetes and reach Envoy through the normal ClusterIP Service. OpenShell preparation uses the digest-pinned K3s v1.36.4 image with its `runc` handler, installs a matched kubectl, verifies the selected RuntimeClass with a smoke Pod, installs Agent Sandbox resources, acquires the OpenShell CLI/chart, and imports gateway, sandbox, and supervisor images. The RuntimeClass smoke proves runtime availability; the full OpenShell lane must prove the separate supervisor enforces approved filesystem access, process privileges, and binary-scoped endpoint/L7 network policy. The Harness and supervisor receive neither `SYS_PTRACE` nor `DAC_READ_SEARCH`. Before creating the OpenShell cluster, preparation writes a private admission config under the owned cluster directory and mounts that exact file read-only into its server. Only the selected RuntimeClass is exempt; namespace and username exemptions remain empty. The API server must reject a violating ordinary Pod in a restricted namespace and admit the same Pod with the selected class before the RuntimeClass availability smoke runs. Logging preparation starts an owned OpenTelemetry Collector backend and passes JSONL evidence to selected tests. The Collector and Docker-model jobs use the shared [setup-test-docker action](../../../.github/actions/setup-test-docker/action.yml) to pin Docker 29.9.2, which supports the production `fluentd-write-timeout` logging option. The action stops the ephemeral runner’s preinstalled daemon, installs that version through the SHA-pinned official Docker setup action, and points `/var/run/docker.sock` at the action socket so the CLI, production Compose, and Driver use one daemon. Other jobs keep the runner Docker daemon. Full-suite acceptance remains incomplete until main-only protected hosted execution records every selected lane. The [delivery status](../../../specs/plans/19-github-actions-test-coverage/delivery-status.md#delivery-status) owns current proof boundaries and live gaps.

The OpenShell test owns management port-forwards throughout the test. Teardown stops the worker, drains forwards, then attempts app, database, namespace and directory cleanup even after an earlier failure. Forward shutdown allows two seconds after `SIGTERM`, then sends `SIGKILL` if necessary and waits two more seconds. Cleanup errors fail the test.

## Related

- [Return to the parent flow](../github-actions-testing.md).
