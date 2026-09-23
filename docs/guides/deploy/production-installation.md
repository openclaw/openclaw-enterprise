# Install the production control plane

Install the OpenClaw Control Plane (OCC) on Kubernetes, then verify
authenticated API access. Prepare [standard Kubernetes](kubernetes.md) or
[Amazon EKS](eks.md) and complete the [production prerequisites](../deploy.md#production-prerequisites)
first. Workspace access is required: install the
[routing prerequisites](workspace-routing.md#requirements), provide a GatewayClass,
and keep routing enabled in both example files.

Run the commands from the repository root in one shell; retain its
exports and protected files for [Agent deployment](production-agents.md).

## Use published images

For an authorized trial on `linux/amd64` or `linux/arm64`, use the private images
below instead of building them. Both were built from source
`e3b28515f30523eede3cd905e589c1ab9063dbda`, passed image startup checks, and had
their remote digests verified in [publication run 35680912119](https://github.com/openclaw/openclaw-enterprise/actions/runs/35680912119).
Both digest references select multi-platform indexes; Docker and Kubernetes
pull the variant matching the host or node. Startup checks passed for both
architectures, with ARM64 checked under QEMU. Publication does not establish
production deployment readiness. To change the image contents,
[build your own images](#build-and-publish-production-images).

You need read access to both GHCR packages. At publication, they inherited access
from `openclaw/openclaw-enterprise`. Authenticate locally with a GitHub personal
access token **(classic)** with `read:packages`; authorize it for organization
SSO if required. Replace the username below and enter the token at Docker's
password prompt. Do not paste the token into the command itself. See
[GitHub's registry authentication instructions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry).

```bash
docker login ghcr.io --username '<your-github-username>'

export CONTROLLER_IMAGE='ghcr.io/openclaw/openclaw-enterprise-controller@sha256:9aa430eb19553a35ccafd5dafff58984ec1264e7c77b1440f56a893cf8e993e1'
export RUNTIME_IMAGE='ghcr.io/openclaw/openclaw-enterprise-runtime@sha256:792f0ffe88ec9f935b55c36f41ee646a828e3d83df21427cf7955a5beef52460'
```

The controller image serves the API, worker, migration, and bootstrap. Use the
same runtime image for both gateways and Agents. These digest references select
the tested bytes; do not substitute `latest` or a bootstrap marker tag.

For Kubernetes, configure approved cluster/node pull credentials for **both
control-plane and tenant Pods**. Local `docker login` does not authenticate
cluster nodes. Both images support amd64 and arm64 nodes. Continue at [Configure the Installation](#configure-the-installation)
with these exports; skip the build-and-publish block below. Local quickstart and
image-test readers should return to their calling guide after authentication
and exporting the image references.

## Build and publish production images

Repository maintainers can use the separately approved
[private container publication workflow](../../../.github/containers.md).
The commands below publish to your own registry.

Build and push two images to a registry your cluster can access:

| Image      | Source                                                                                                    | Used by                                          |
| ---------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Controller | Root [`Dockerfile`](../../../Dockerfile), target `runtime`                                                | API, worker, migration, and bootstrap            |
| Runtime    | [`deploy/runtime/Dockerfile`](../../../deploy/runtime/Dockerfile), installing OpenClaw and Codex from npm | Gateways and Agents (the same image serves both) |

You need Docker with Buildx and registry push access. Replace the example
registry and repository, and select the platform matching your Kubernetes
nodes. The base image below matches the [runtime recipe](../../../deploy/runtime/README.md),
which also documents package-version overrides.

Authenticate the builder before running the build block. For a standard registry,
run `docker login <registry-host>` using your approved credentials; for private
ECR, follow [ECR authentication](eks.md#authenticate-the-image-builder-to-ecr).
Keep any registry and platform exports from that step.

The runtime must include the channel plugins its Agents enable, with their
runtime dependencies available from a fresh home directory. The standard recipe
packages Slack and Codex. Verify plugin loading and the gateway's supported
Codex app-server version before publishing; use the
[runtime image checks](../../../deploy/runtime/README.md#verify-the-local-image).
Use the same verified runtime image for both slots unless you have separately
verified the gateway/Codex image pair. Runtime package installation at gateway
startup is not part of this deployment procedure.

```bash
export OCC_IMAGE_REGISTRY="${OCC_IMAGE_REGISTRY:-registry.example.com}"
export OCC_IMAGE_REPOSITORY="${OCC_IMAGE_REPOSITORY:-$OCC_IMAGE_REGISTRY/your-team/openclaw-enterprise}"
export OCC_IMAGE_TAG="$(git rev-parse HEAD)"
export OCC_IMAGE_PLATFORM="${OCC_IMAGE_PLATFORM:-linux/amd64}"
export NODE_BASE_IMAGE='docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584'

docker buildx build --push --platform "$OCC_IMAGE_PLATFORM" --target runtime \
  --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
  -t "$OCC_IMAGE_REPOSITORY/controller:$OCC_IMAGE_TAG" .
docker buildx build --push --platform "$OCC_IMAGE_PLATFORM" \
  --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
  -f deploy/runtime/Dockerfile \
  -t "$OCC_IMAGE_REPOSITORY/runtime:$OCC_IMAGE_TAG" .

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
For a registry-backed installation, keep the digest exports from either
[Use published images](#use-published-images) or
[Build and publish production images](#build-and-publish-production-images).

```bash
umask 077
export OCC_INPUT_DIRECTORY="${OCC_INPUT_DIRECTORY:-/secure/occ}"
export KUBECONFIG_FILE="$OCC_INPUT_DIRECTORY/kubeconfig"
: "${CONTEXT:?Set the reviewed Kubernetes context from your cluster guide}"
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

Verify Kubernetes 1.35+:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" version
```

Older servers continue but remain unsupported; API and worker emit
`compute.preflight-warning`.

The examples use native API keys. Helm values configure OCC; Installation YAML
configures Drivers, runtime images, identity, networking, storage, and logging.

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

- `$OCC_INPUT_DIRECTORY/values.yaml`: set `images.controller`,
  `auth.baseUrl`, `bootstrap.adminEmail`, `database.cidrs`, `cluster.cidrs`,
  `controlPlane.nodeSelector`, `database.caSecretName`, `dns`, `api.clients`, and
  `bootstrap.password.claimName`. Keep `gatewayRouting.enabled: true`, set
  `gatewayRouting.gatewayClassName` to your GatewayClass, and retain the example
  Secret names and keys; otherwise update the Secret creation commands below.
- `$OCC_INPUT_DIRECTORY/installation.yaml`: set `occ.cluster`, `logging.level`,
  `drivers.compute.configuration.images` digests, DNS selectors, matching
  `gatewayRouting` settings, service-principal token settings, runtime selector, Secret
  prefixes, and `runtime.gatewayStorageClassName`. Keep
  `drivers.compute.configuration.images.requireImmutableDigest: true`.
  Do not set `network.gatewayClients` with routing enabled; Compute derives the
  Envoy peer from `gatewayRouting`.
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
  (.database.cidrs | length > 0) and (.cluster.cidrs | length > 0) and
  (.controlPlane.nodeSelector | length > 0) and
  (.api.clients | length > 0) and .gatewayRouting.enabled == true and
  .gatewayRouting.gatewayClassName != "" and
  .gatewayRouting.apiKeySecretName != ""' \
  "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null
yq e -e '.drivers.compute.configuration.images.requireImmutableDigest == true and
  (.drivers.compute.configuration.images.gateway | test("@sha256:[a-f0-9]{64}$")) and
  (.drivers.compute.configuration.images.agent | test("@sha256:[a-f0-9]{64}$")) and
  .drivers.compute.configuration.runtime.gatewayStorageClassName != "" and
  (.drivers.compute.configuration.runtime.nodeSelector | length > 0)' \
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

Prepare these Secret inputs under `/secure/occ`, each containing one raw value
without quotes or a variable assignment.

| File                  | Contents and source                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occ-application-url` | PostgreSQL connection URL for the limited application role, used by bootstrap, the API, and the worker. Obtain it from your database administrator or provider. Example shape: `postgresql://occ_app:<url-encoded-password>@<postgres-host>:5432/<database>`.                   |
| `occ-migration-url`   | Connection URL for a separate role allowed to apply schema migrations. It targets the same database. Example shape: `postgresql://occ_migrator:<url-encoded-password>@<postgres-host>:5432/<database>`. Obtain this credential separately; do not give it to the API or worker. |
| `occ-database-ca.pem` | Optional PostgreSQL root CA bundle when the database root is not in the base image trust store. Required only when `database.caSecretName` is set; the example mount path is `/etc/openclaw/database-ca/ca.pem`.                                                                |
| `occ-auth-secret`     | A random secret used to sign and verify user sessions. Generate it once for this Installation with the command below, then retain it across redeployments. It is separate from the administrator password, service API key, and model-provider key.                             |

Save both database URLs in protected files, replacing placeholders and preserving
required TLS options. For managed PostgreSQL roots supplied through `database.caSecretName`,
set `sslmode=verify-full` and `sslrootcert` to the mounted CA file in both URLs.
With the example mount settings, the path is `/etc/openclaw/database-ca/ca.pem`;
if you change them, use `<database.caMountPath>/<database.caKey>`. Introduce URL
query parameters with `?`, or join them to existing parameters with `&`. Generate the auth secret for a new Installation; this command refuses
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
export DATABASE_CA_SECRET="$(yq e -r '.database.caSecretName // ""' "$OCC_INPUT_DIRECTORY/values.yaml")"
export DATABASE_CA_KEY="$(yq e -r '.database.caKey // "ca.pem"' "$OCC_INPUT_DIRECTORY/values.yaml")"
if [ -n "$DATABASE_CA_SECRET" ]; then
  chmod 600 /secure/occ/occ-database-ca.pem
  test -s /secure/occ/occ-database-ca.pem
fi
```

Keep these values out of Helm values, Installation YAML, Configurations, shell
history, and this repository.

## Prepare workspace access

Create the controller namespace:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" create namespace openclaw-system
```

Complete [Configure private routing](workspace-routing.md#configure-private-routing):
create `occ-private-gateway-key` and match the Helm and Installation routing
settings. Rerun validation and rendering above if inputs change. Configure each
Agent's authentication during [Agent deployment](production-agents.md#configure-the-agent-runtime).

## Provision system Secrets and install

Create the remaining system Secrets from protected files:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  apply --dry-run=server -f /tmp/oce-rendered.yaml
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  apply --dry-run=server -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-installation-startup --from-file=installation.yaml="$OCC_INPUT_DIRECTORY/installation.yaml"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-database --from-file=application-url=/secure/occ/occ-application-url --from-file=migration-url=/secure/occ/occ-migration-url
if [ -n "$DATABASE_CA_SECRET" ]; then
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
    create secret generic "$DATABASE_CA_SECRET" \
    --from-file="$DATABASE_CA_KEY=/secure/occ/occ-database-ca.pem"
fi
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-auth --from-file=secret=/secure/occ/occ-auth-secret
```

These commands provision operator-owned inputs; they are not a recurring Secret
synchronizer. When `database.caSecretName` is set, the chart mounts that Secret
read-only into migration, bootstrap, API, and worker containers at
`database.caMountPath`; the PostgreSQL URLs still own `sslrootcert` selection.

### Optional repository credential service

Enable repository credentials only after preparing the
[repository service inputs](../repository-credentials/installation.md) and the matching
[GitHub Provider selection](../../reference/providers.md#github-repository-credentials).
The feature defaults disabled. It requires a separately built, immutable service
image, an immutable registry ConfigMap, private service configuration, App key,
TLS certificate/key for the exact internal Service hostname, and a separate
public-CA Secret. Mount the same registry version into API, worker, and service.
The Installation's Compute network peer must select this release's worker Pod on
port `8443`; the Service exposes HTTPS port `443`.

When enabled, the chart keeps one worker Pod with `Recreate` and a credential
sidecar. The sidecar alone mounts App and TLS private inputs and copies them into
private regular files before loading them. It receives no Kubernetes API token;
the worker's token is explicitly projected only into the worker container. API
and worker receive the registry and public CA. Only worker and service share the
private Unix control socket.

The service's `limits.shutdownGraceMs` must be at most `60000` (the default).
Projected startup rejects longer drains so the service can report unresolved
cleanup before the Pod's fixed 75-second termination grace expires.

Tenant-worker RoleBindings grant Secret `get/list/create/delete` for owned
runtime material. Kubernetes RBAC does not restrict those verbs by the labels
used by Compute, so the worker remains trusted within each bound tenant
namespace. Agent service accounts receive no Secret API permission.
NetworkPolicies allow managed Agent gateways to reach the service and allow
the worker Pod to reach approved provider CIDRs. These policies apply to the
whole Pod; registry/session checks enforce exact Namespace and repository scope.

Restart API and worker together after replacing a registry version or service
inputs. Readiness checks private control availability but does not prove token
minting, provider reachability, or an Agent's Git workflow.

### Azure PostgreSQL workload identity

For [Azure workload-identity database authentication](../../reference/settings/operations.md#postgresql-connection-authentication),
use password-free URLs with verified TLS in the database URL files above.
Prepare the identity environment variables and a renewed federation-token
projection for each connecting process: migration, bootstrap, API, and worker.
Provision federation and database grants for separate application and migrator
identities; keep the migrator privileges confined to migration. Use
`node scripts/migrate-production.mjs` for this authentication mode.

These are deployment-owned inputs. The supplied chart does not configure Azure
identities, federation, grants, identity environment variables, or token
projection for OCC. Its migration and bootstrap containers share an
initialization Pod and service account; changing database URL Secrets alone
does not configure their distinct identity inputs or enable Azure mode.

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
  --namespace openclaw-system --claim "$BOOTSTRAP_CLAIM" --image "$CONTROLLER_IMAGE" \
  --node-selector oce-role=control
```

Replace `--node-selector oce-role=control` with the same labels selected by
`controlPlane.nodeSelector`; repeat the option for multiple labels so preparation
and initialization can use the same volume topology.

The helper refuses any nonfresh mounted root except filesystem-owned
`lost+found`, schedules the preparation Pod with any supplied `--node-selector`
labels before storage binds, reports `Prepared bootstrap volume claim ... with
UID/GID 1000 mode 0700.` on success, and retains a failed Pod for diagnosis. If policy
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
through approved storage access and retain it in protected storage. The example
uses `/secure/occ/initial-admin-service-key.json` as the retained copy and
creates a separate, private copy for this operator session. It preserves values
already set in your shell. Otherwise, replace the sample hostname with your
production HTTPS origin before running and set a different retained path if needed:

```bash
export OCC_URL="${OCC_URL:-https://<internal-occ-host>}"
export OCC_BOOTSTRAP_KEY_FILE="${OCC_BOOTSTRAP_KEY_FILE:-/secure/occ/initial-admin-service-key.json}"
umask 077
prepare_occ_service_key() {
  local working_directory
  unset OCC_SERVICE_KEY_FILE OCC_SERVICE_KEY_DIRECTORY
  if [ -z "${OCC_BOOTSTRAP_KEY_FILE:-}" ] || [ -z "${OCC_URL:-}" ]; then
    printf '%s\n' 'Set the production URL and retained bootstrap key first.' >&2
    return 1
  fi
  if ! working_directory="$(mktemp -d /tmp/occ-service-key.XXXXXXXX)"; then
    printf '%s\n' 'Could not create the working key directory; stop here.' >&2
    return 1
  fi
  if ! install -m 600 "$OCC_BOOTSTRAP_KEY_FILE" "$working_directory/occ-service-key.json"; then
    rm -f -- "$working_directory/occ-service-key.json"
    rmdir -- "$working_directory"
    printf '%s\n' 'Could not create the working key copy; stop here.' >&2
    return 1
  fi
  if ! OCC_SERVICE_KEY_FILE="$working_directory/occ-service-key.json" occ installation get; then
    rm -f -- "$working_directory/occ-service-key.json"
    rmdir -- "$working_directory"
    printf '%s\n' 'Could not authenticate; the temporary key copy was removed. Stop here.' >&2
    return 1
  fi
  export OCC_SERVICE_KEY_DIRECTORY="$working_directory"
  export OCC_SERVICE_KEY_FILE="$working_directory/occ-service-key.json"
}
prepare_occ_service_key
```

Expect the displayed `ID` to match the key file's
`meta.installationId`. A completed initialization Job is not an exec endpoint,
and neither the API nor worker mounts the bootstrap PVC. Keep the protected
source after ending the session; initialization does not reissue a lost key.
The [operator cleanup](production-agents.md#end-the-operator-session) removes
only the disposable copy created above.

After the production API authenticates, continue with Namespace preparation,
Agent deployment, and a [real model-response check](production-agents.md#verify-production-workloads)
that matches the Agent's native gateway authentication mode.

## Related

Continue with [production Agent deployment](production-agents.md). For failed
initialization, preserve state and follow [bootstrap recovery](../../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap)
and the [production startup flow](../../flows/production-startup.md).
