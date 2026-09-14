# Local Kubernetes development

Run the OpenClaw Control Plane (OCC) API and worker in Compose while the
Kubernetes Compute Driver provisions workloads in a disposable, loopback-only
k3d cluster. The same `dev-up` and `dev-down` entry points manage both the
Docker and Kubernetes development profiles.

## Start the profile

You need Docker Engine with Docker Compose, or Podman with `podman-compose`,
plus k3d, kubectl, Bash, `curl`, Python 3, and `realpath`. No Node.js process
runs on the host: Compose runs PostgreSQL, migration, bootstrap, controller,
and worker processes.

From the repository root, select Kubernetes Compute:

```bash
OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes ./scripts/dev-up
```

The default `OCC_DEVELOPMENT_COMPUTE_DRIVER=docker` retains the ordinary
[quickstart](../quickstart.md). The helper selects Docker first when both
container engines are usable. Set
`OCC_DEVELOPMENT_CONTAINER_ENGINE=docker` or `podman` to select one explicitly.

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

The k3d API is published on `127.0.0.1:6443` by default. Override conflicts
with `OCC_DEVELOPMENT_KUBERNETES_API_PORT`. The disposable cluster lowers
kubelet's local disk-pressure threshold to 5% so imported development images
remain schedulable on constrained workstations. Set
`OCC_DEVELOPMENT_KUBERNETES_DISK_THRESHOLD_PERCENT` to an integer from 1
through 20 to override it; production Kubernetes settings are unaffected.

The default runtime image is built from `deploy/runtime/Dockerfile`. Set
`OCC_KUBERNETES_RUNTIME_IMAGE` to an existing local image reference to use it
instead. The helper imports that image into k3d and records its resolved digest
in the generated Installation configuration.

State and credentials are written to the private
`/tmp/openclaw-development` directory by default. Set the absolute
`OCC_DEVELOPMENT_STATE_DIRECTORY` before both startup and cleanup to use
another location. The state directory remains mode `0700`; the generated files
mounted into the non-root controller and worker are container-readable but
remain inaccessible to other host users through that private directory. The
helper does not modify the default kubeconfig or current kubectl context.

Podman delegates Compose to `podman-compose`. On rootless Linux, its
Docker-compatible API socket must be running so k3d can create the cluster.
Set `DOCKER_HOST` when k3d cannot discover that socket automatically.

## Verify the local boundary

Use the paths printed by `dev-up` to inspect OCC and the cluster:

```bash
export OCC_URL=http://127.0.0.1:3000
export OCC_SERVICE_KEY_FILE=/tmp/openclaw-development/initial-admin-service-key.json
scripts/occ-api GET /installation
kubectl --kubeconfig /tmp/openclaw-development/kubeconfig \
  --context <context-printed-by-dev-up> get namespaces
```

The API and worker use the same generated Installation configuration. Agent
deployments therefore exercise Kubernetes Compute rather than the Docker
development Driver.

## Stop and clean up

Run the same cleanup entry point used by Docker Compute:

```bash
./scripts/dev-down
```

For Kubernetes mode, `dev-down` reads the private recorded state, removes only
the named `occ-dev-*` cluster and its Compose project, deletes profile volumes,
then removes the state directory. This permanently deletes the development
Installation, service keys, Namespaces, Agents, audit history, and queued work
stored by this profile. Incomplete cleanup preserves the state for recovery; a
failed startup rolls back resources it already created.

## Limits

Development startup readiness does not prove Agent deployment, model execution,
provider authentication, or dedicated Codex WebSocket execution. Those checks
require the real-cluster procedures, approved digest-pinned runtime images, and
existing authorized credentials described in the
[Kubernetes testing guide](../../testing/kubernetes.md).
