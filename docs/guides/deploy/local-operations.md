# Local Kubernetes and development operations

Build images for a disposable Kubernetes cluster, stop a Docker Compute
development stack without deleting its data, or check local Agent access. Run
commands from the repository root. If you are installing the platform for the
first time, start with [Local Setup](../quickstart.md). For Namespace and Agent
setup on an existing installation, use the [production deployment sequence](../deploy.md#production).

## Build images for local Kubernetes

Build the controller from this checkout and one combined OpenClaw/Codex image
for both Installation image slots. The local Kubernetes tests use the same
build and import commands. Local digests vary by build and platform; read them
from the imported images instead of copying a sample digest.

Prerequisites: Docker, k3d, and [yq v4](https://github.com/mikefarah/yq).
Create a disposable single-server cluster without changing your kubeconfig:

```bash
export CLUSTER="occ-images-$(date +%s)"
export OCC_EXAMPLE_DIRECTORY="$(mktemp -d)"
k3d cluster create "$CLUSTER" --image +v1.35 --servers 1 --agents 0 \
  --api-port 127.0.0.1:random \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false
k3d kubeconfig get "$CLUSTER" > "$OCC_EXAMPLE_DIRECTORY/kubeconfig"
chmod 600 "$OCC_EXAMPLE_DIRECTORY/kubeconfig"
export KUBECONFIG_FILE="$OCC_EXAMPLE_DIRECTORY/kubeconfig"
export CONTEXT="k3d-$CLUSTER"
```

Build and import the images:

```bash
docker build --target runtime \
  --build-arg NODE_BASE_IMAGE=docker.io/library/node:24-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0 \
  -t "localhost/$CLUSTER/controller:local" .
docker build -f deploy/runtime/Dockerfile \
  -t "localhost/$CLUSTER/runtime:local" .
k3d image import "localhost/$CLUSTER/controller:local" \
  "localhost/$CLUSTER/runtime:local" -c "$CLUSTER"
```

Register each imported manifest digest in k3s:

```bash
for role in controller runtime; do
  tag="localhost/$CLUSTER/$role:local"
  digest="$(docker exec "k3d-$CLUSTER-server-0" ctr -n k8s.io images list |
    awk -v image="$tag" '$1 == image { print $3 }')"
  printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || exit 1
  reference="localhost/$CLUSTER/$role@$digest"
  docker exec "k3d-$CLUSTER-server-0" ctr -n k8s.io images tag "$tag" "$reference"
  if [ "$role" = controller ]; then
    export CONTROLLER_IMAGE="$reference"
  else
    export RUNTIME_IMAGE="$reference"
  fi
done
```

Populate private YAML copies with those references:

```bash
umask 077
cp deploy/examples/production/{values,installation,bootstrap-pvc}.yaml "$OCC_EXAMPLE_DIRECTORY/"
yq -i '.images.controller = strenv(CONTROLLER_IMAGE)' "$OCC_EXAMPLE_DIRECTORY/values.yaml"
yq -i '.drivers.compute.configuration.images.gateway = strenv(RUNTIME_IMAGE) |
  .drivers.compute.configuration.images.agent = strenv(RUNTIME_IMAGE)' "$OCC_EXAMPLE_DIRECTORY/installation.yaml"
printf 'Image-configured examples: %s\n' "$OCC_EXAMPLE_DIRECTORY"
```

These references work in this cluster and retain `requireImmutableDigest: true`.
Use the generated directory in place of `/secure/occ` in the production commands;
keep its image values and kubeconfig instead of copying the templates again.
Set the remaining database, HTTPS, network, and storage inputs for your trial
(k3d's default StorageClass is `local-path`). The images alone do not configure
those dependencies or prove an Agent model turn. When finished with the trial,
run `KUBECONFIG="$KUBECONFIG_FILE" k3d cluster delete "$CLUSTER"`.

For an already installed, persistent Helm release on k3d, follow
[local k3d image upgrades](local-k3d-image-upgrade.md) to preserve its state.
The disposable cluster cleanup above is not an upgrade procedure.

For missing DNS, denied connections, or unready Kubernetes Agents after a
checkout update, inspect the [ordinary network profile](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#explicit-network-profiles)
on the affected Pod and its workload template, plus all matching NetworkPolicies.
The upgrade restarts nothing: running Pods keep their templates and grants until
Compute next prepares a revision of their Agent. To move an Agent onto the
profile, rebuild the controller and deploy a new revision. Preparing it
re-renders that Agent's grants with the profile, and its new templates carry the
label. A Gateway from an earlier template, embedded or dedicated, keeps serving
until activation replaces it. Re-preparing an active revision, for
example during repository-credential maintenance, rolls its Pods once onto
profiled templates. Namespace-wide `allow-dns`,
`allow-gateway-ingress` and `allow-node-gateway` are narrowed only in namespaces
provisioned after the upgrade; an earlier namespace keeps its previous selectors
until it is recreated. OpenShell Sandboxes need a redeployed revision.
Restarting a Pod from an old template retains the missing label; assigning the
profile to arbitrary Pods grants access and is not a repair.

## Stop development safely

For a Docker Compute stack, run the exact command under `Cleanup` in the
`dev-up` output. For Podman, it uses `occ dev down` with `compose.podman.yaml`
and the Compose options passed at startup. Keep any `CONTAINER_CONNECTION` or `CONTAINER_HOST` selection used for
startup, including macOS machine connections. See the
[cleanup flow](../../flows/docker-compose-development.md#3-clean-up-docker-or-podman-compose)
for how the host connection and worker socket are handled.

This preserves PostgreSQL, Configuration, and bootstrap-key volumes. Use
`--volumes` only to delete the local Installation. First account for any Agent
containers and tenant networks owned by Docker Compute.

A Kubernetes profile's `Cleanup` command instead deletes its k3d cluster,
database, Agents, and volumes; see [stop and clean up](local-kubernetes-development.md#stop-and-clean-up).
To keep that data, run `k3d cluster stop` and later `k3d cluster start` with the
cluster name instead: the `Kubernetes context` from the `dev-up` output without
its `k3d-` prefix ([storage across restarts](local-kubernetes-development.md#preserve-storage-across-restarts)).

## Development end-to-end TUI

Docker and Podman Compose support control-plane startup and Namespace
operations. Their Compute Driver rejects the harness authentication binding
required for Agent deployment. You cannot deploy an Agent or use its TUI through
Compose; exporting `OPENAI_API_KEY` to the worker does not change this.

For a local authenticated Agent and TUI trial, build the Kubernetes images above,
then follow [production Agent deployment](production-agents.md) and
[production TUI verification](production-tui.md) against that disposable cluster.
Complete the same Secret binding, exact IAM grants, and tenant RoleBindings as
for a production installation. Both the TUI and the
[HTTP model response check](../operate/model-verification.md) use an optional
loopback password alongside the gateway's trusted-proxy authentication.
