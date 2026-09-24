# Compose development startup

Trace host preflight, database initialization, and API/worker startup. See the [parent flow](../docker-compose-development.md) for its context and overall sequence.

## Execution trace

### 1. scripts/dev-up: host preflight and runtime image selection

`scripts/dev-up:require_command`, `internal/occdev/compose.go:AnalyzeCompose`,
`deploy/runtime/Dockerfile`

The helper runs from the checkout root and requires the executable OCC CLI at
`bin/occ`, as produced by `pnpm cli:build`; it does not resolve `occ` from
`PATH`. It accepts an optional `--key-output` destination and forwards arguments
after `--` to the selected Compose
implementation, so native project names, profiles, and override files keep
their normal precedence. This trace covers the default
`OCC_DEVELOPMENT_COMPUTE_DRIVER=docker` path. Selecting `kubernetes` dispatches
to the [local Kubernetes development profile](../../guides/deploy/local-kubernetes-development.md),
which keeps OCC in Compose and uses k3d for Compute.

The Docker Compute path first probes a running Docker Engine and the JSON
configuration capability required from Docker Compose. If that probe fails, it
selects `podman` directly; a `docker` compatibility alias is neither required
nor treated as Docker merely because of its name. Podman requires the standalone
`podman-compose` provider and `yq` v4; the helper pins that provider so status
and stopped one-shot container behavior stay consistent.

Docker Compose supplies resolved JSON directly. Podman Compose supplies YAML,
which `dev-up` converts to JSON inside its private temporary directory before
passing it to `./bin/occ dev analyze-compose`. The shared Go analyzer enforces
loopback controller and database publications and resolves the Docker runtime
image selection. The helper appends
`compose.podman.yaml` last so the worker receives Podman's reported API socket
at `/var/run/docker.sock`. The base Docker Compute worker disables SELinux
process labeling because relabeling a host engine socket is unsafe; other
services retain SELinux confinement.
The override also gives migration, bootstrap, API, and worker one shared
development image. Because podman-compose otherwise rebuilds that identical
target once per service, `dev-up` builds it once through the migration service
and starts the stack with `--no-build`. Docker keeps its native `up --build`
path. Expanded configuration and credentials are never printed.

On macOS, run `podman` as your normal host user, without `sudo`. The k3d
workflow requires a rootful Podman machine; rootful describes the VM, not
running `podman` as root on the host.

If neither a shared runtime image nor separate gateway/Agent images are set,
the helper selects `openclaw-enterprise-runtime:quickstart` for this invocation.
It builds that default image from `deploy/runtime` only when the image is
missing. Custom image references must already exist; an incomplete custom
selection fails before startup is reported successful.

Existing tags are reused even after the runtime recipe changes. Operators
[rebuild and verify the image](../../../deploy/runtime/README.md#rebuild-an-existing-image)
explicitly to pick up package changes. The runtime recipe owns packaged channel
plugins and gateway/Codex compatibility checks; `dev-up` does not install
missing plugins or verify a model turn.

### 2. compose.yaml:services.postgres and services.migrate

`compose.yaml:services.postgres`, `compose.yaml:services.migrate`

Compose starts PostgreSQL first and keeps its data in the local
`occ_postgres_data` volume. Compose also declares `occ_configuration_data`, but
mounts it only into the controller for development Configuration documents. The
PostgreSQL service uses local-only administrator credentials to initialize the
database and the checked-in local SQL to create the less-privileged
`occ_migrator` and `occ_app` roles.

The migration service waits for PostgreSQL, connects with
`OCC_MIGRATION_DATABASE_URL`, and applies Drizzle migrations. The API and
worker never use the migrator or PostgreSQL administrator URL. `dev-up` invokes
this through Compose; it does not run migration directly.

### 3. Initialize before starting the API or worker

`compose.yaml:services.bootstrap`, `scripts/bootstrap-installation.mjs`

After migration exits `0`, Compose runs the shared initializer with development
inputs. Fresh bootstrap creates the development human administrator, the
non-Agent service administrator, the singleton Installation, native IAM seed,
audit evidence, and the initial service-key response. It also creates the
initial `default` Namespace in `provisioning` state and queues worker
reconciliation; the worker later provisions its backing Docker boundary.
Existing Installations retain their Namespaces, accounts, keys, IAM policy,
configuration, and revision history. Missing, expired, or revoked keys do not
trigger another bootstrap issue.

Only the initializer mounts `occ_bootstrap_data`; the API and worker load
committed state after initializer success. The
[bootstrap flow](../local-password-authentication.md) owns credentials, concurrent
attempts, and failure recovery.

### 4. The API admits only local development traffic

`apps/controller/src/server.mjs:start`,
`apps/controller/src/composition/development-postgres.ts:createDevelopmentConfigurationDriver`,
`apps/controller/src/drivers/configuration/filesystem/index.ts:FilesystemConfigurationDriver`

The API starts in `NODE_ENV=development`, binds inside the Compose network, and
publishes its host port only on `127.0.0.1`. `OCC_AUTH_SECRET` signs user
sessions and `OCC_AUTH_BASE_URL` fixes the cookie origin.

Development accepts the explicitly configured Compose bridge CIDR as local
control-plane traffic, while non-loopback clients, forwarded headers,
caller-supplied identity headers, bearer credentials, and trusted-proxy claims
remain rejected. The API uses the application-role PostgreSQL URL and never
receives the container-engine socket.

After the controller health check passes, `dev-up` waits for the worker
readiness probe before copying the initializer-owned service-key JSON from the
stopped bootstrap container. Docker Compose performs the Docker copy. Because
`podman-compose` has no `cp` command, the helper identifies exactly one scoped
bootstrap container from Compose status labels and invokes `podman cp` by ID.
`--key-output` must name an absent destination in a private operator-owned
directory; otherwise the helper creates a private temporary directory. The
helper never overwrites an existing local file, never prints `data.key`, and
never reruns bootstrap to replace a missing key.

`dev-up` then reads the Installation with `./bin/occ installation get` and the
copied service-key response. `apps/controller/src/auth/index.ts:ControllerAdmissionVerifier.verify`
validates the `x-api-key` and maps it to the Installation-scoped service
administrator; current IAM policy still authorizes each resource operation. The
startup proof succeeds only when the returned resource ID matches the copied
key response's `meta.installationId`. An invalid, expired,
or revoked key fails with `401` without cookie fallback. The
[service-key flow](../service-api-keys.md) owns admission details.

When `OCC_CONFIG_PATH` is absent, PostgreSQL-backed development selects the
filesystem Configuration Driver from `OCC_DEVELOPMENT_CONFIGURATION_ROOT`.
Compose sets that root to `/app/.development/configurations` and backs it with
the `occ_configuration_data` named volume. PostgreSQL remains the OCC metadata
system of record; native Configuration documents live in that driver-owned
volume.

### 5. The worker selects Docker compute and claims durable work

`apps/controller/src/worker.mjs:configuration`

The worker starts after the controller is healthy with the same
application-role `OCC_DATABASE_URL`. When `OCC_CONFIG_PATH` is absent in
development, it selects `compute-docker-development` with implementation
`docker-local`. Setting `OCC_CONFIG_PATH` explicitly selects the trusted Driver
set described by that file instead.

The worker loads the singleton Installation, validates persisted IAM policy,
and polls the PostgreSQL work queue. Startup readiness means the worker can
claim durable work; it does not mean an Agent, AgentRevision, or TUI exists.
Every claimed operation reauthorizes the original actor before calling Compute.
The worker is the only Compose service with Docker-compatible engine access. It
does not mount the configuration volume.

### 12. Select Kubernetes development and preserve cleanup ownership

`internal/occdev/command.go:selectEngine`,
`internal/occdev/command.go:pinEndpoint`,
`internal/occdev/up.go:Up`.

The Kubernetes lifecycle selects Docker or Podman and resolves the selected
local Unix socket. `internal/occdev/claims.go:claimsFor` derives separate project
and cluster claims from that endpoint. The private, per-user claim registry is
shared across state directories and retains each claim until disposal. Startup
acquires both claims before checking resources. Version-4 state records their
random owner, endpoint, project, and cluster. Cleanup verifies the claims and
reuses that endpoint; changing the active Docker context cannot redirect it.

Startup refuses existing cluster or project resources, validates the resolved
Compose publications through `internal/occdev/compose.go:AnalyzeCompose`, and
rejects external or unscoped networks and volumes through
`internal/occdev/up.go:validateResourceOwnership`. It then claims the state directory with an exclusive `0700` creation. It writes the
rendered Compose snapshot privately before creating resources. Startup and
cleanup both use that snapshot, so later `.env` edits cannot change the saved
project configuration. `internal/occdev/state.go:beginLifecycle` writes
`subprocess-outcome-uncertain` before the first resource-mutating helper. The
file survives abrupt CLI death even when the state lock is released.

### 13. Bootstrap OCC, create k3d, and prepare runtime configuration

`internal/occdev/up.go:Up`, `internal/occdev/up.go:waitCompleted`,
`internal/occdev/kubernetes.go:writeKubeconfigs`,
`internal/occdev/kubernetes.go:importRuntime`,
`internal/occdev/kubernetes.go:writeInstallation`.

Compose starts PostgreSQL, migration, and bootstrap. The lifecycle waits for
successful migration and bootstrap exits before creating the dedicated k3d
cluster on the Compose network. Before creation, state records the attempt.
The helper creates k3d's image volume with the recorded native owner label
and verifies that ownership before invoking k3d. k3d receives the same owner
label for all configured nodes, including its load balancer. Its automatic
rollback is disabled so only OCC's ownership-checked cleanup can remove
resources after a failed create.
k3d resolves the latest K3s patch in the 1.35
family, which matches the supported Kubernetes minimum. The cluster API binds
host loopback; creation leaves the default kubeconfig and current context
unchanged.

The host kubeconfig remains owner-readable. The container kubeconfig uses the
cluster's internal load-balancer hostname with TLS verification. The lifecycle
imports the selected local runtime image, resolves its in-cluster digest, and
writes Installation configuration selecting Kubernetes Compute, Configuration,
and Secret Drivers with native IAM. Its runtime section configures the transport
Secret prefix and gateway storage class accepted by the current Compute Driver
schema. The container configuration and kubeconfig are individually readable by
non-root containers, behind the private host directory, and mounted read-only
into the API and Kubernetes worker. Neither service receives the engine socket.

### 14. Prove readiness and clean up the owned Kubernetes profile

`internal/occdev/up.go:waitReady`, `internal/occdev/up.go:copyAndVerifyKey`,
`internal/occdev/down.go:Down`, `internal/occdev/down.go:cleanup`,
`internal/occdev/state.go:readState`.

The lifecycle starts the API and Kubernetes worker, waits for API health and
worker readiness, copies bootstrap output to a private temporary file, and
uses `occclient` to read the Installation. Its ID must match the bootstrap
response before the final key file is written exclusively and readiness is
reported. This hands an initialized profile to the operator; it does not prove
Agent deployment or a model turn.

On a settled failure, startup attempts resource cleanup. Explicit Kubernetes
shutdown validates the state, snapshot, and resource claims, refuses an existing
lifecycle marker, and writes its own marker before cleanup. Cleanup stops reconcilers,
then checks the engine's cluster containers, cluster-labelled volumes, and
conventional image-volume name. Configured nodes and volumes must carry the
recorded native owner label.
k3d's unlabeled tools node additionally requires a live owned server, its native
cluster membership and role, the owned image-volume mount, and the recorded
Compose network. Cleanup removes auxiliary containers by immutable ID first,
stopping on any failure before deleting the server that supplies that ownership
witness. It checks the remaining scope again before letting k3d delete the last
server. If the last node has disappeared, cleanup verifies and removes the surviving volumes directly because k3d cannot
discover a cluster without nodes. Each retry checks current resources again;
a prior deletion attempt cannot authorize a same-name replacement or foreign
sibling. Cleanup continues after settled errors and retains state and claims
until resources are gone.

`internal/occdev/command.go:capturedOutput` observes captured-output EOF separately
from the process exit, with a bounded wait. `recordCommandOutcome` requires a
successful mutating command; a failed started mutation remains uncertain even
when it exits normally. Read-only probes may exit nonzero if they exit normally
and their output has drained. Preflight failures do not affect a later lifecycle.
Signals, cancellation, and unsettled output trigger cancellation of the owned
Unix process group. An escaped descendant or engine-side operation can remain
active; the lifecycle stops further cleanup and keeps its marker. A later
invocation requires the operator to settle surviving helpers and explicitly
remove the marker before retrying. A successful startup or a settled cleanup
attempt clears the marker. Complete cleanup removes
private state, its helper-owned key, and the resource claims. An external
`--key-output` file remains operator-owned.

## Related

- [Return to the parent flow](../docker-compose-development.md).
