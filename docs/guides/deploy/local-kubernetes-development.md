# Local Kubernetes development

Run the OpenClaw Control Plane (OCC) API and worker in Compose while the
Kubernetes Compute Driver provisions workloads in a disposable, loopback-only
k3d cluster. The `./bin/occ dev up` and `./bin/occ dev down` commands manage both the Docker and
Kubernetes development profiles; `scripts/dev-up` and `scripts/dev-down`
provide checkout-local entry points.

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

The default `OCC_DEVELOPMENT_COMPUTE_DRIVER=docker` retains the ordinary
[quickstart](../quickstart.md). The helper selects Docker first when both
container engines are usable. Set
`OCC_DEVELOPMENT_CONTAINER_ENGINE=docker` or `podman` to select one explicitly.
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
Compose project; run the recorded cleanup command before restarting. The state
directory remains mode `0700`; the generated files
mounted into the non-root controller and worker are container-readable but
remain inaccessible to other host users through that private directory. The
helper does not modify the default kubeconfig or current kubectl context.

For separate stacks, select distinct state directories, Compose projects,
cluster names, and published API ports. Set an unused, non-overlapping
`OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR` and a distinct `OCC_POSTGRES_PORT` for each
stack. Keep each stack's resources under the helper's lifecycle until cleanup;
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

The API and worker use the same generated Installation configuration. Agent
deployments therefore exercise Kubernetes Compute rather than the Docker
development Driver.

## Stop and clean up

Run the exact `Cleanup` command printed by startup. It selects Kubernetes Compute
and the recorded state directory explicitly. For the default state directory:

```bash
OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes ./bin/occ dev down
```

`./bin/occ dev down` defaults to Docker Compute even when Kubernetes state exists.
For explicitly selected Kubernetes mode, it reads the private recorded state
and removes only the named `occ-dev-*` cluster and its Compose project, deletes
profile volumes, then removes the state directory. This permanently deletes the development
Installation, service keys, Namespaces, Agents, audit history, and queued work
stored by this profile. Incomplete cleanup preserves the state for recovery;
restore access to the recorded engine and rerun the same cleanup command. A failed startup attempts
the same resource cleanup and preserves state if that attempt fails. A key
written outside the state directory with `--key-output` remains operator-owned;
remove that local copy separately.

## Limits

Development startup readiness does not prove Agent deployment, model execution,
provider authentication, or dedicated Codex WebSocket execution. Those checks
require the real-cluster procedures, approved digest-pinned runtime images, and
existing authorized credentials described in the
[Kubernetes testing guide](../../testing/kubernetes.md).
