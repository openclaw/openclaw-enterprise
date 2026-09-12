# Install the production control plane

Build and install OCC on Kubernetes, then verify authenticated API access.
Complete the [production prerequisites](../deploy.md#production-prerequisites)
first. Run commands from the repository root in one operator shell; retain its
exports and protected files for [Agent deployment](production-agents.md).

## Build and publish production images

Repository maintainers can use the separately approved
[private container publication workflow](../../../.github/containers.md).
The manual operator-controlled registry path below remains available.

Build and push two images to a registry your cluster can access:

| Image      | Source                                                                                                    | Used by                                          |
| ---------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Controller | Root [`Dockerfile`](../../../Dockerfile), target `runtime`                                                | API, worker, migration, and bootstrap            |
| Runtime    | [`deploy/runtime/Dockerfile`](../../../deploy/runtime/Dockerfile), installing OpenClaw and Codex from npm | Gateways and Agents (the same image serves both) |

You need Docker with Buildx and registry push access. Replace the example
registry and repository, and select the platform matching your Kubernetes
nodes. The base image below matches the [runtime recipe](../../../deploy/runtime/README.md),
which also documents package-version overrides.

The runtime must include the channel plugins its Agents enable, with their
runtime dependencies available from a fresh home directory. The standard recipe
packages Slack and Codex. Verify plugin loading and the gateway's supported
Codex app-server version before publishing; use the
[runtime image checks](../../../deploy/runtime/README.md#verify-the-local-image).
Use the same verified runtime image for both slots unless you have separately
verified the gateway/Codex image pair. Runtime package installation at gateway
startup is not part of this deployment procedure.

```bash
export OCC_IMAGE_REPOSITORY='registry.example.com/your-team/openclaw-enterprise'
export OCC_IMAGE_TAG="$(git rev-parse HEAD)"
export OCC_IMAGE_PLATFORM='linux/amd64'
export NODE_BASE_IMAGE='docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584'
docker login registry.example.com

docker buildx build --push --platform "$OCC_IMAGE_PLATFORM" --target runtime \
  --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
  -t "$OCC_IMAGE_REPOSITORY/controller:$OCC_IMAGE_TAG" .
docker buildx build --push --platform "$OCC_IMAGE_PLATFORM" \
  --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
  -f deploy/runtime/Dockerfile \
  -t "$OCC_IMAGE_REPOSITORY/runtime:$OCC_IMAGE_TAG" deploy/runtime

CONTROLLER_DIGEST="$(docker buildx imagetools inspect \
  "$OCC_IMAGE_REPOSITORY/controller:$OCC_IMAGE_TAG" \
  --format '{{json .Manifest}}' | yq -p=json -r '.digest')"
RUNTIME_DIGEST="$(docker buildx imagetools inspect \
  "$OCC_IMAGE_REPOSITORY/runtime:$OCC_IMAGE_TAG" \
  --format '{{json .Manifest}}' | yq -p=json -r '.digest')"
export CONTROLLER_IMAGE="$OCC_IMAGE_REPOSITORY/controller@$CONTROLLER_DIGEST"
export RUNTIME_IMAGE="$OCC_IMAGE_REPOSITORY/runtime@$RUNTIME_DIGEST"
```

Continue only after both builds and digest lookups succeed. Keep these exports
for the YAML configuration below; Kubernetes requires digest references, not
tags. For private registries, configure cluster/node pull credentials for both
control-plane and tenant Pods; `docker login` only authenticates your builder.

## Configure the Installation

Set the production shell inputs before the first Kubernetes command. For a local
Kubernetes trial, [build and import the test images](local-operations.md#build-images-for-local-kubernetes)
to produce YAML copies with real image digests, then set
`OCC_INPUT_DIRECTORY` to that generated directory and keep those files.
For production, use the registry digests from the build-and-publish step above.

```bash
umask 077
export OCC_INPUT_DIRECTORY="${OCC_INPUT_DIRECTORY:-/secure/occ}"
export KUBECONFIG_FILE="$OCC_INPUT_DIRECTORY/kubeconfig"
export CONTEXT='<production-context>'
install -d -m 700 "$OCC_INPUT_DIRECTORY"
install -d -m 700 /secure/occ
test -e "$OCC_INPUT_DIRECTORY/values.yaml" || \
  install -m 600 deploy/examples/production/values.yaml "$OCC_INPUT_DIRECTORY/values.yaml"
test -e "$OCC_INPUT_DIRECTORY/installation.yaml" || \
  install -m 600 deploy/examples/production/installation.yaml "$OCC_INPUT_DIRECTORY/installation.yaml"
test -e "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml" || \
  install -m 600 deploy/examples/production/bootstrap-pvc.yaml "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
chmod 600 "$KUBECONFIG_FILE" "$OCC_INPUT_DIRECTORY/values.yaml" \
  "$OCC_INPUT_DIRECTORY/installation.yaml" "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
```

The default examples use native API-key operation. Helm values own the
controller image, API endpoint, Secret names, bootstrap claim, optional
Collector, and network selectors. Installation YAML owns gateway/Agent images,
Driver selection, projected identity, runtime networking/storage, and the shared
startup logging level.

For `logging.level`, follow [Choose the log level](../observability.md#1-choose-the-log-level),
including when to restart OCC and deploy a new AgentRevision.

If you built the production images above, write their digest references into
the protected copies (skip this block for the local Kubernetes import path):

```bash
: "${CONTROLLER_IMAGE:?Set the controller digest reference}"
: "${RUNTIME_IMAGE:?Set the runtime digest reference}"
yq -i '.images.controller = strenv(CONTROLLER_IMAGE)' "$OCC_INPUT_DIRECTORY/values.yaml"
yq -i '.drivers.compute.configuration.images.gateway = strenv(RUNTIME_IMAGE) |
  .drivers.compute.configuration.images.agent = strenv(RUNTIME_IMAGE)' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
```

Edit the protected YAML copies before provisioning anything:

- `$OCC_INPUT_DIRECTORY/values.yaml`: set `images.controller` to the
  controller digest, `auth.baseUrl` to the production OCC URL,
  `bootstrap.adminEmail` to the first administrator, `database.cidr` to the
  exact PostgreSQL endpoint CIDR, `cluster.cidr` to the Kubernetes API endpoint
  CIDR, `api.clients` to approved client selectors, and
  `bootstrap.password.claimName` to the bootstrap PVC name.
- `$OCC_INPUT_DIRECTORY/installation.yaml`: set `occ.cluster`, `logging.level`,
  both `drivers.compute.configuration.images` digests, the DNS and gateway-client
  selectors, the service-principal token settings, the runtime Secret prefixes,
  and `runtime.gatewayStorageClassName`. Keep
  `drivers.compute.configuration.images.requireImmutableDigest: true`.
  If enabling Agent plugins, set one compatible bundled `drivers.plugin` selector
  and any required Codex catalog-reader configuration. See the
  [PluginDriver reference](../../reference/drivers/plugin.md#selection-and-catalogs).
  For dedicated Codex command execution on nodes whose default syscall policy
  blocks user namespaces, install a reviewed compatibility profile on every
  eligible node and set `runtime.codexSeccompProfile` to its relative kubelet
  profile path. See the [Kubernetes runtime requirements](../../reference/drivers/kubernetes-compute.md#requirements).
- `$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml`: set the bootstrap PVC name,
  namespace, size, and protected `storageClassName` for the cluster.

Validate the configured copies, render the Helm chart, and derive the helper
image from the same Helm values file:

```bash
yq e -e '.images.controller | test("@sha256:[a-f0-9]{64}$")' \
  "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null
yq e -e '.auth.baseUrl != "" and .bootstrap.adminEmail != "" and
  .database.cidr != "" and .cluster.cidr != "" and (.api.clients | length > 0)' \
  "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null
yq e -e '.drivers.compute.configuration.images.requireImmutableDigest == true and
  (.drivers.compute.configuration.images.gateway | test("@sha256:[a-f0-9]{64}$")) and
  (.drivers.compute.configuration.images.agent | test("@sha256:[a-f0-9]{64}$")) and
  .drivers.compute.configuration.runtime.gatewayStorageClassName != ""' \
  "$OCC_INPUT_DIRECTORY/installation.yaml" >/dev/null
yq e -e '.metadata.namespace == "openclaw-system" and .spec.storageClassName != ""' \
  "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml" >/dev/null
helm template oce deploy/helm/openclaw-enterprise \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  >/tmp/oce-rendered.yaml
export CONTROLLER_IMAGE="$(yq e -r '.images.controller' "$OCC_INPUT_DIRECTORY/values.yaml")"
export BOOTSTRAP_CLAIM="$(yq e -r '.bootstrap.password.claimName' "$OCC_INPUT_DIRECTORY/values.yaml")"
test "$BOOTSTRAP_CLAIM" = "$(yq e -r '.metadata.name' "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml")"
```

`$KUBECONFIG_FILE` must select the same cluster as `$CONTEXT`.

Prepare these local files under `/secure/occ`. Their contents become Kubernetes
Secret values in the next step; each file contains one raw value, without quotes
or a variable name such as `OCC_DATABASE_URL=`.

| File                  | Contents and source                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occ-application-url` | PostgreSQL connection URL for the limited application role, used by bootstrap, the API, and the worker. Obtain it from your database administrator or provider. Example shape: `postgresql://occ_app:<url-encoded-password>@<postgres-host>:5432/<database>`.                   |
| `occ-migration-url`   | Connection URL for a separate role allowed to apply schema migrations. It targets the same database. Example shape: `postgresql://occ_migrator:<url-encoded-password>@<postgres-host>:5432/<database>`. Obtain this credential separately; do not give it to the API or worker. |
| `occ-auth-secret`     | A random secret used to sign and verify user sessions. Generate it once for this Installation with the command below, then retain it across redeployments. It is separate from the administrator password, service API key, and model-provider key.                             |

Save the two complete database URLs using your secret manager or a protected
editor, replacing the example placeholders and preserving provider-required TLS
options. Generate the auth secret for a new Installation; this command refuses
to overwrite an existing file:

```bash
(
  umask 077
  set -C
  openssl rand -hex 32 > /secure/occ/occ-auth-secret
)
chmod 600 /secure/occ/occ-application-url /secure/occ/occ-migration-url \
  /secure/occ/occ-auth-secret
test -s /secure/occ/occ-application-url
test -s /secure/occ/occ-migration-url
```

Keep these values out of Helm values, Installation YAML, Configurations, shell
history, and this repository.

## Provision system Secrets and install

Create the namespace and system Secrets from protected files:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" create namespace openclaw-system
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  apply --dry-run=server -f /tmp/oce-rendered.yaml
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  apply --dry-run=server -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-installation-startup --from-file=installation.yaml="$OCC_INPUT_DIRECTORY/installation.yaml"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-database --from-file=application-url=/secure/occ/occ-application-url --from-file=migration-url=/secure/occ/occ-migration-url
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-auth --from-file=secret=/secure/occ/occ-auth-secret
```

These commands provision operator-owned inputs; they are not a recurring Secret
synchronizer.

### Optional operational log export

Before installing the chart, configure the Collector Secrets and Helm values
using [Configure platform observability](../observability.md#kubernetes-and-helm).
That guide also covers reusing an existing cluster Collector, exporter
credentials, and verification. Return here to prepare the bootstrap PVC and
install OCC.

### Prepare the fresh bootstrap output PVC

Create the fresh claim from the native example, then prepare the mounted root
with the same immutable Node-capable image selected for the controller:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n openclaw-system apply -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"

scripts/prepare-bootstrap-volume --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace openclaw-system --claim "$BOOTSTRAP_CLAIM" --image "$CONTROLLER_IMAGE"
```

The helper refuses any nonfresh mounted root except filesystem-owned
`lost+found`, reports `Prepared bootstrap volume claim ... with UID/GID 1000
mode 0700.` on success, and retains a failed Pod for diagnosis. If policy
forbids the preparation Pod, have the storage administrator create the same root
state through the approved storage workflow.

Install the chart with native values:

```bash
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  --wait --timeout 5m
```

Helm owns migration and bootstrap ordering through its initialization hook.
Readiness covers the API and worker probes. It does not prove authenticated API
access, Agent deployment, or a model turn.

## Authenticate to the production API

Retrieve `initial-admin-service-key.json` from the protected bootstrap PVC
through approved storage access, then set:

```bash
export OCC_URL='https://<internal-occ-host>'
export OCC_SERVICE_KEY_FILE='/secure/occ/initial-admin-service-key.json'
scripts/occ-api GET /installation
```

Expect HTTP `200` with `data.id` matching the key file's
`meta.installationId`. A completed initialization Job is not an exec endpoint,
and neither the API nor worker mounts the bootstrap PVC.

After the production API authenticates, continue with Namespace preparation,
Agent deployment, production workload verification, and the production TUI proof.

## Related

Continue with [production Agent deployment](production-agents.md). For failed
initialization, preserve state and follow [bootstrap recovery](service-keys.md#recover-an-incomplete-bootstrap)
and the [production startup flow](../../flows/production-startup.md).
