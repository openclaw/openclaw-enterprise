# Local Kubernetes development

Configure or troubleshoot the local Kubernetes development profile. The
OpenClaw Control Plane (OCC) API and worker run in Compose; the
Kubernetes Compute Driver provisions workloads in a disposable, loopback-only
k3d cluster. If this is your first setup, start with the [local Kubernetes
quickstart](../quickstart.md).

## Start the profile

You need Docker Engine with Docker Compose, or Podman with `podman-compose`,
plus k3d and kubectl. Build the checkout-local [OCC CLI](../cli.md) with the
Go version in `go.mod`, Node.js 24 or newer, and the repository-pinned pnpm.
Compose runs PostgreSQL, migration, bootstrap, controller, and worker processes.

From the repository root, build the CLI and select Kubernetes Compute:

```bash
pnpm cli:build
OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes ./bin/occ dev up
```

Without `OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes`, the CLI uses the Docker
Compute Driver; set it explicitly for both startup and cleanup. The helper
uses Docker Engine to host the Kubernetes profile when both container engines
are usable. Set `OCC_DEVELOPMENT_CONTAINER_ENGINE=docker` or `podman` to select
the engine explicitly.
Kubernetes startup accepts `-- --env-file PATH` for environment inputs and
`-- -f PATH` for a Compose override applied after the profile files. Overrides
must keep networks and volumes owned by the selected project and cannot use
external resources or fixed container names. The project directory must remain
this checkout. Use `OCC_DEVELOPMENT_COMPOSE_PROJECT` to select a different
project name.

Kubernetes mode creates the dedicated
`openclaw-enterprise-development-kubernetes` Compose project, runs migration
and bootstrap, creates an `occ-dev-*` k3d cluster attached to the Compose
network, imports the local runtime image, and starts the controller and worker
containers. It prints the API URL, service-key path, kubeconfig, and Kubernetes
context after authenticated readiness succeeds.

The Kubernetes worker runs as UID/GID `1000:1000`. It mounts the generated
Installation configuration and kubeconfig read-only; it neither mounts the
container-engine socket nor disables SELinux labeling. The container engine is
used to host the Compose services and to import the runtime image into k3d.
The selected engine must expose a local Unix socket. Startup records that
endpoint so cleanup addresses the same engine even if your active Docker
context changes.

The k3d API is published on `127.0.0.1:6443` by default. Override conflicts
with `OCC_DEVELOPMENT_KUBERNETES_API_PORT`. The disposable cluster lowers
kubelet's local disk-pressure threshold to 5% so imported development images
remain schedulable on constrained workstations. Set
`OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT` to an integer from 1
through 20 to override it; production Kubernetes settings are unaffected.

The default runtime image is built from `deploy/runtime/Dockerfile`. Set
`OCC_KUBERNETES_RUNTIME_IMAGE` to an existing local image reference to use it
instead; startup fails if that explicit image is missing. The helper imports
that image into k3d and records its resolved digest in the generated Installation
configuration.

State and credentials are written to the private
`/tmp/openclaw-development` directory by default. Set the absolute
`OCC_DEVELOPMENT_STATE_DIRECTORY` before both startup and cleanup to use
another location. Startup refuses an existing state directory, cluster, or
Compose project. To pick up source changes, [rebuild the running services](#rebuild-after-a-source-edit);
cleanup is for discarding the Installation. The state directory remains mode
`0700`; the generated files
mounted into the non-root controller and worker are container-readable but
remain inaccessible to other host users through that private directory. The
helper does not modify the default kubeconfig or current kubectl context.

For separate stacks, select distinct state directories, Compose projects,
cluster names, and published API ports. Set an unused, non-overlapping
`OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` and a distinct `OCC_POSTGRES_PORT` for each
stack. Startup derives the development bridge gateway from the rendered subnet
unless Compose explicitly supplies one. Generated runtime workloads have a
2 GiB memory limit each; size the local engine VM for OCC plus the Agents you run.
Keep each stack's resources under the helper's lifecycle until cleanup;
do not reuse its names for unrelated resources.

Podman delegates Compose to `podman-compose`. On rootless Linux, its
Docker-compatible API socket must be running so k3d can create the cluster.
Startup resolves the reported socket and supplies it to k3d; it must be
reachable from the host.

## Verify the local boundary

Use the URL, service-key path, kubeconfig, and context printed by startup.
With the default API port and state directory:

```bash
export OCC_URL=http://127.0.0.1:3000
export OCC_SERVICE_KEY_FILE=/tmp/openclaw-development/initial-admin-service-key.json
./bin/occ installation get
kubectl --kubeconfig /tmp/openclaw-development/kubeconfig \
  --context <context-printed-by-startup> get namespaces
```

Expect the Installation output to show an ID and `kubectl` to list namespaces.
These checks confirm access to the control plane and cluster; they do not
deploy an Agent or run a model. The API and worker use the same generated
Installation configuration, so Agent deployments use Kubernetes Compute. To
deploy your own Agent and get a model response, continue with [Deploy your
first Agent](../first-agent.md).

## Configure workspace storage on single-node k3d

Dedicated Agents use a `40Gi` RWO workspace claim. Stock k3d `local-path`
storage supports this mode without a shared-filesystem ConfigMap patch. Gateway
state uses a separate RWO claim. The worker stops the previous revision before
starting its replacement; expect a downtime window during deployment.
See [storage ownership and recovery](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#harness-storage).

Use the kubeconfig and context printed by startup to check the Agent namespace:

```bash
kubectl --kubeconfig '<profile-kubeconfig>' --context '<profile-context>' \
  -n '<agent-kubernetes-namespace>' get pvc,pods
```

Expect the workspace to become `Bound` with access mode `RWO`, followed by a
running Harness Pod. With `WaitForFirstConsumer`, a pending claim before Pod
creation is normal. Existing owned RWX claims are retained; do not delete a claim
or change its access mode to adopt the new default.

### Preserve storage across restarts

Keep the node's `/var/lib/rancher/k3s` volume, which contains workspace files and
K3s state. Normal container restarts retain that volume; cluster deletion, volume
deletion, and profile cleanup can destroy the data. Local-path storage is bound
to its node; adding another node does not replicate existing workspace data.
Use a portable StorageClass if workloads must move between nodes.

The `local-path` StorageClass uses reclaim policy `Delete`, so deleting a claim
also permits deletion of its backing directory. PostgreSQL's Compose volume
stores control-plane records separately; retaining it does not back up workspaces.
Use a durable private state directory instead of `/tmp` for a long-lived demo.

## Rebuild after a source edit

The development image copies the checkout at build time; the running services
do not watch source files. After the profile is running, open Bash in the
checkout root and define these functions once. Set the state directory to the
value in the startup output; the path below is the usual Linux default. The
functions use the recorded engine, socket, project, and resolved Compose file.
Changing your container context will not switch them to another profile.

```bash
export OCC_DEVELOPMENT_STATE_DIRECTORY=/tmp/openclaw-development

dev_state() {
  node -e '
    const fs = require("node:fs");
    const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = state[process.argv[2]];
    if (typeof value !== "string" || !value) process.exit(1);
    process.stdout.write(value);
  ' "$OCC_DEVELOPMENT_STATE_DIRECTORY/state.json" "$1"
}

dev_compose() (
  local engine endpoint project checkout provider
  engine=$(dev_state containerEngine) || exit 1
  endpoint=$(dev_state dockerHost) || exit 1
  project=$(dev_state composeProject) || exit 1
  checkout=$(dev_state repository) || exit 1
  unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
  export DOCKER_HOST="$endpoint"
  if [ "$engine" = podman ]; then
    provider=$(command -v podman-compose) || exit 1
    export PODMAN_COMPOSE_PROVIDER="$provider"
    export CONTAINER_HOST="$endpoint" CONTAINER_CONNECTION=
  fi
  "$engine" compose --project-directory "$checkout" --project-name "$project" \
    -f "$OCC_DEVELOPMENT_STATE_DIRECTORY/compose.yaml" "$@"
)
```

Save your edit, then choose the affected service. These commands rebuild and
recreate only the selected service so it starts from the updated image:

| Change                                                     | Rebuild and reload                                                                  | Where to check                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Controller/API or console (`apps/controller/src/console/`) | `dev_compose up --build -d --no-deps --force-recreate controller`                   | Retry `./bin/occ installation get`, or refresh `$OCC_URL/console/` in your browser. |
| Worker                                                     | `dev_compose up --build -d --no-deps --force-recreate worker-kubernetes`            | Check worker readiness and logs below, then repeat the operation your edit affects. |
| Shared code used by both                                   | `dev_compose up --build -d --no-deps --force-recreate controller worker-kubernetes` | Check both services below.                                                          |

Use the API URL and service-key file printed at startup, as in
[Verify the local boundary](#verify-the-local-boundary). To inspect the running
services:

```bash
dev_compose ps controller worker-kubernetes
./bin/occ installation get
dev_compose exec -T worker-kubernetes node scripts/production-healthcheck.mjs worker ready
dev_compose logs --tail 100 -f controller worker-kubernetes
```

The Installation command returns the existing ID; worker readiness succeeds
without output after it can observe PostgreSQL. Retry both after a restart if
they fail initially. Press Ctrl+C to stop following logs; this does not stop
the services. For console changes, browser developer tools show client errors;
controller logs cover requests handled by the API.

These rebuilds leave PostgreSQL, its named volumes, and k3d running, preserving
the Installation, service keys, Namespaces, Agents, and audit history. They
temporarily interrupt the services you rebuild. They do not rerun migrations
or rebuild Agent runtime images, and the recorded Compose file does not pick up
profile configuration edits. If you need to keep this Installation while changing
migrations, the Agent runtime image, or Compose settings, [start a separate profile](#start-the-profile).
See the [PostgreSQL](../../testing/postgresql.md) and [Kubernetes](../../testing/kubernetes.md)
guides for checks. Do not run `occ dev down` to reload application code: it deletes the profile's state.

## Stop and clean up

Run the exact `Cleanup` command printed by startup. It selects Kubernetes Compute
and the recorded state directory explicitly. For the default state directory:

```bash
OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes ./bin/occ dev down
```

`./bin/occ dev down` defaults to Docker Compute even when Kubernetes state exists.
For explicitly selected Kubernetes mode, it reads the private recorded state
and removes only the named `occ-dev-*` cluster and its Compose project, deletes
profile volumes, then removes the state directory. This permanently deletes the
development Installation, service keys, Namespaces, Agents, audit history, and
queued work stored by this profile. Incomplete cleanup preserves the state for
recovery; restore access to the recorded engine and rerun the same command.
A failed startup attempts the same cleanup and preserves state if it fails.
A key written outside the state directory with `--key-output` remains
operator-owned; remove that local copy separately.

## Limits

Development startup readiness does not prove Agent deployment, model execution,
provider authentication, or dedicated Codex WebSocket execution. Those checks
require the real-cluster procedures, approved digest-pinned runtime images, and
existing authorized credentials described in the
[Kubernetes testing guide](../../testing/kubernetes.md).

## Gateway placement boundary

Dedicated Gateways use a managed Gateway runtime namespace, separate from the
Harness namespace. The local development profile selects its single k3d server
for Gateway scheduling. This exercises namespace separation on one disposable
node; it does not prove production node isolation. Production must configure
`runtime.gatewayNodeSelector` and `runtime.nodeSelector` for disjoint trusted and
data-plane pools. See [production Namespace preparation](production-agents.md#prepare-each-namespace)
for both scoped RoleBindings.
