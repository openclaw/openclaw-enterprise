# Install the production control plane

Install the OpenClaw Control Plane (OCC) on Kubernetes, then verify
authenticated API access. Prepare [standard Kubernetes](kubernetes.md) or
[Amazon EKS](eks.md) and complete the [production prerequisites](../deploy.md#production-prerequisites)
first. Workspace access is required: install the
[routing prerequisites](workspace-routing.md#requirements), provide a GatewayClass,
and keep private routing enabled. Control UI is enabled in the
production values; complete [native admin prerequisites](native-admin.md#requirements).

Configure with an [installation profile](#recommended-generate-profile-configuration)
or, for advanced customization, [manual YAML](#advanced-copy-manual-yaml-examples).

Run from a clean checkout at the image source revision so the chart, examples,
and helpers match. See [Deliver images to a private registry](private-registry-images.md)
for provenance, copying verified images to ECR, and chart selection. Retain this
shell and protected files for [Agent deployment](production-agents.md).

## Use published images

Select a verified release or custom controller image built for this chart. It
must support native admin, private routing, the selected PluginDriver catalog or
hosted discovery, and any managed proxy or repository wiring you enable. Select a
compatible runtime image. Export their immutable digests as `CONTROLLER_IMAGE`
and `RUNTIME_IMAGE`, or [build and publish images](#build-and-publish-production-images)
from this checkout.

The published controller below supports the curated catalog but predates the
origin check and profile-generated configuration. Use it only for image tests or
workflows targeting its source revision.

Both images from source `97b1d7421931c9e1c6b14b869f6bb2eb0ddb6ecc` passed
matching-architecture startup and remote digest checks in
[publication run 36366875910](https://github.com/openclaw/openclaw-enterprise/actions/runs/36366875910).
Their multi-platform indexes select the host or node variant; publication does
not establish production readiness.

Both GHCR packages require read access; at publication, they inherited access
from `openclaw/openclaw-enterprise`. Authenticate with a GitHub personal access
token **(classic)** with `read:packages` and organization SSO if required.
Replace the username and enter the token at Docker's password prompt, not in the
command. See
[GitHub's registry authentication instructions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry).

```bash
docker login ghcr.io --username '<your-github-username>'
```

For historical [image tests](../../testing/images.md#check-published-images), export:

```bash
export HISTORICAL_CONTROLLER_IMAGE='ghcr.io/openclaw/openclaw-enterprise-controller@sha256:37a76b3c5bb54a81b106b948af4678bf4b6af9a7aad5f6b9e56385236444424c'
export HISTORICAL_RUNTIME_IMAGE='ghcr.io/openclaw/openclaw-enterprise-runtime@sha256:f17a66a18de9d4231c9579faf90573d80bef1278aaaf63135b6c6ce0b71a23b3'
```

Configure approved pull credentials for **control-plane and tenant Pods**;
`docker login` does not authenticate nodes. Install with the verified current
pair at [Configure the Installation](#configure-the-installation).

## Build and publish production images

Repository maintainers can use the separately approved
[private container publication workflow](../../../.github/containers.md).
Build these images for a registry your cluster can access:

| Image      | Source                                                                                                         | Used by                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Controller | Root [`Dockerfile`](../../../Dockerfile), target `runtime`                                                     | API, worker, migration, and bootstrap            |
| Runtime    | [`deploy/runtime/Dockerfile`](../../../deploy/runtime/Dockerfile), assembling pinned OpenClaw source and Codex | Gateways and Agents (the same image serves both) |

With Docker Buildx and registry push access, replace the example registry and
repository and select your nodes’ platform. The base image matches the
[runtime recipe](../../../deploy/runtime/README.md).

Authenticate the builder before running the build block. For a standard registry,
run `docker login <registry-host>` using your approved credentials; for private
ECR, follow [ECR authentication](eks.md#authenticate-the-image-builder-to-ecr).
Keep any registry and platform exports from that step.

These commands push candidate images. Run the block alone in a fresh Bash shell,
stop on failure, and retain the metadata. Verify the images before installation.
The standard runtime packages Slack and Codex; use it for both slots unless you
have separately verified a gateway/Codex pair. Installing packages at gateway
startup is unsupported.

```bash
# Build from a clean checkout.
export OCC_IMAGE_REGISTRY="${OCC_IMAGE_REGISTRY:-registry.example.com}"
export OCC_IMAGE_REPOSITORY="${OCC_IMAGE_REPOSITORY:-$OCC_IMAGE_REGISTRY/your-team/openclaw-enterprise}"
export OCC_IMAGE_PLATFORM="${OCC_IMAGE_PLATFORM:-linux/amd64}"
export NODE_BASE_IMAGE='docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584'
if unset CONTROLLER_IMAGE RUNTIME_IMAGE OCC_IMAGE_METADATA &&
  OCC_IMAGE_TAG="$(git rev-parse HEAD)" &&
  OCC_IMAGE_METADATA="$(mktemp -d)" &&
  export OCC_IMAGE_TAG &&
  docker buildx build --push --platform "$OCC_IMAGE_PLATFORM" --target runtime \
    --metadata-file "$OCC_IMAGE_METADATA/controller.json" \
    --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
    --build-arg OCC_BUILD_REVISION="$OCC_IMAGE_TAG" \
    --label "org.opencontainers.image.revision=$OCC_IMAGE_TAG" \
    -t "$OCC_IMAGE_REPOSITORY/controller:$OCC_IMAGE_TAG" . &&
  docker buildx build --push --platform "$OCC_IMAGE_PLATFORM" \
    --metadata-file "$OCC_IMAGE_METADATA/runtime.json" \
    --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
    --build-arg OCC_BUILD_REVISION="$OCC_IMAGE_TAG" \
    -f deploy/runtime/Dockerfile \
    -t "$OCC_IMAGE_REPOSITORY/runtime:$OCC_IMAGE_TAG" . &&
  CONTROLLER_DIGEST="$(yq -p=json -e -r '."containerimage.digest" | select(test("^sha256:[a-f0-9]{64}$"))' "$OCC_IMAGE_METADATA/controller.json")" &&
  RUNTIME_DIGEST="$(yq -p=json -e -r '."containerimage.digest" | select(test("^sha256:[a-f0-9]{64}$"))' "$OCC_IMAGE_METADATA/runtime.json")" &&
  [[ "$CONTROLLER_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] &&
  [[ "$RUNTIME_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  export CONTROLLER_IMAGE="$OCC_IMAGE_REPOSITORY/controller@$CONTROLLER_DIGEST"
  export RUNTIME_IMAGE="$OCC_IMAGE_REPOSITORY/runtime@$RUNTIME_DIGEST"
else
  printf 'Build or digest extraction failed; stop. Metadata: %s\n' "${OCC_IMAGE_METADATA:-unavailable}" >&2
  false
fi
```

Before installation, run the [image checks](../../testing/images.md#check-published-images)
against these exact digests on a native host for each target architecture; all checks must pass
without skips. Use these digests in YAML. Configure private registry pull
credentials for control-plane and tenant Pods; builder login does not authenticate nodes.

## Configure the Installation

Set the production shell before the first Kubernetes command. This runbook
uses Helm release `oce` in Namespace `openclaw-system`. Keep configuration and
bootstrap PVC YAML in the protected `OCC_INPUT_DIRECTORY`; Secret input files
always stay under `/secure/occ`.

To reuse profile output or verified YAML from
[local operations](local-operations.md#build-images-for-local-kubernetes), set
`OCC_INPUT_DIRECTORY` to that directory first. Then skip both generation branches
and continue with the [shared checks](#shared-bootstrap-pvc-and-configuration-checks).

```bash
umask 077
export OCC_INPUT_DIRECTORY="${OCC_INPUT_DIRECTORY:-/secure/occ}"
export KUBECONFIG_FILE="$OCC_INPUT_DIRECTORY/kubeconfig"
: "${CONTEXT:?Set the reviewed Kubernetes context from your cluster guide}"
install -d -m 700 /secure/occ "$OCC_INPUT_DIRECTORY"
chmod 600 "$KUBECONFIG_FILE"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" version
```

Kubernetes older than 1.35 is unsupported; the API and worker emit
`compute.preflight-warning`.

### Recommended: generate profile configuration

Choose `openclaw` or `codex` from the [profile options](installation-profiles.md#choose-a-profile).
Generation requires Node.js 24 or newer on the operator host; manual YAML does not.

Create `$OCC_INPUT_DIRECTORY/profile-input.json` from the schema in
[Render installation profiles](installation-profiles.md#prepare-inputs). Set
`controlPlane.releaseName` to `oce`, `controlPlane.namespace` to
`openclaw-system`, `controlPlane.controllerImage` to `$CONTROLLER_IMAGE`, and
`runtime.image` to `$RUNTIME_IMAGE`. Keep credentials and tokens out of the
input JSON. Keep it separate from `values.yaml`, `installation.yaml`, and
`preflight.json`, which each render clears.

```bash
export OCC_PROFILE="${OCC_PROFILE:-codex}"
export OCC_PROFILE_INPUT="${OCC_PROFILE_INPUT:-$OCC_INPUT_DIRECTORY/profile-input.json}"
(
  set -e
  : "${CONTROLLER_IMAGE:?Set the controller digest reference}"
  : "${RUNTIME_IMAGE:?Set the runtime digest reference}"
  test -s "$OCC_PROFILE_INPUT"
  yq -e '.controlPlane.releaseName == "oce" and .controlPlane.namespace == "openclaw-system"' \
    "$OCC_PROFILE_INPUT" >/dev/null
  node scripts/render-installation-profile.mjs \
    --profile "$OCC_PROFILE" \
    --input "$OCC_PROFILE_INPUT" \
    --out-dir "$OCC_INPUT_DIRECTORY"
  test -s "$OCC_INPUT_DIRECTORY/values.yaml"
  test -s "$OCC_INPUT_DIRECTORY/installation.yaml"
)
```

If rendering fails, fix the input and rerender. Do not fall back to example YAML
or copy manual files over failed output; `values.yaml`, `installation.yaml`, and
`controlPlane.installationChecksum` must come from one successful render.

### Advanced: copy manual YAML examples

Use this branch only when not using an installation profile. The block refuses
to overwrite existing configuration YAML. The manual example differs from the `codex` profile: it selects the curated Codex PluginDriver
catalog, while the profile defaults to hosted PAT-backed discovery.

```bash
(
  set -e
  test ! -e "$OCC_INPUT_DIRECTORY/values.yaml"
  test ! -e "$OCC_INPUT_DIRECTORY/installation.yaml"
  install -m 600 deploy/examples/production/values.yaml "$OCC_INPUT_DIRECTORY/values.yaml"
  install -m 600 deploy/examples/production/installation.yaml "$OCC_INPUT_DIRECTORY/installation.yaml"
  : "${CONTROLLER_IMAGE:?Set the controller digest reference}"
  : "${RUNTIME_IMAGE:?Set the runtime digest reference}"
  yq -i '.images.controller = strenv(CONTROLLER_IMAGE)' "$OCC_INPUT_DIRECTORY/values.yaml"
  yq -i '.drivers.compute.configuration.images.gateway = strenv(RUNTIME_IMAGE) |
    .drivers.compute.configuration.images.agent = strenv(RUNTIME_IMAGE)' \
    "$OCC_INPUT_DIRECTORY/installation.yaml"
)
```

For registry-backed installs, confirm the selected images match the checked
digests. For profiles, check the input JSON image fields before rendering. For
manual YAML, follow [Verify installation image selections](../../testing/images.md#verify-installation-image-selections).

### Shared bootstrap PVC and configuration checks

Create the bootstrap PVC manifest if it is not already in the handoff directory:

```bash
test -e "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml" || \
  install -m 600 deploy/examples/production/bootstrap-pvc.yaml "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
chmod 600 "$OCC_INPUT_DIRECTORY/values.yaml" \
  "$OCC_INPUT_DIRECTORY/installation.yaml" \
  "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
```

For profile installs, change `$OCC_PROFILE_INPUT` and rerender instead of editing
`values.yaml` or `installation.yaml`. For manual installs, edit the copied YAML
before running the checks:

- `values.yaml`: set auth URL, admin email, database and cluster CIDRs,
  control-plane node selector, database CA, DNS, API clients, and bootstrap
  password claim. Keep native admin and gateway routing enabled with the reviewed
  GatewayClass and Secret names.
- `installation.yaml`: set cluster name, log level, DNS selectors,
  service-principal token settings, Secret prefixes, runtime storage class,
  immutable runtime image digests, and PluginDriver catalog. Set
  `runtime.gatewayNodeSelector` and `runtime.nodeSelector` to
  [disjoint Ready pools](../../reference/drivers/kubernetes-compute.md#images-and-resources);
  Helm does not place runtimes. Omit `network.gatewayClients` with
  [routing](../../reference/gateway-routing.md#routing-configuration) enabled.
  `presets.includeDefaults: false` disables the
  [bundled Presets](../../reference/presets.md#installation-defaults).

For every install, set `bootstrap-pvc.yaml` name, namespace, size, and
protected `storageClassName`.

For `logging.level`, see [Choose the log level](../observability.md#1-choose-the-log-level).
Configure native admin domains through [native admin setup](native-admin.md#steps).
For Slack Agents, configure both proxy paths in the
[Slack guide](../integrations/slack.md#configure-both-slack-proxies). For Codex
sandboxing, follow [Codex sandbox setup](codex-sandbox.md).

Run every check below before provisioning:

```bash
yq e -e '.images.controller | test("@sha256:[a-f0-9]{64}$")' \
  "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null
yq e -e '.auth.baseUrl != "" and .bootstrap.adminEmail != "" and
  (.database.cidrs | length > 0) and (.cluster.cidrs | length > 0) and
  (.controlPlane.nodeSelector | length > 0) and
  (.api.clients | length > 0) and .gatewayRouting.enabled == true and
  .gatewayRouting.gatewayClassName != "" and
  .gatewayRouting.apiKeySecretName != "" and .agentNativeAdmin.enabled == true' \
  "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null
yq e -e '.drivers.compute.configuration.images.requireImmutableDigest == true and
  (.drivers.compute.configuration.images.gateway | test("@sha256:[a-f0-9]{64}$")) and
  (.drivers.compute.configuration.images.agent | test("@sha256:[a-f0-9]{64}$")) and
  .drivers.compute.configuration.runtime.gatewayStorageClassName != "" and
  (.drivers.compute.configuration.runtime.gatewayNodeSelector | length > 0) and
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
| `occ-database-ca.pem` | Optional PostgreSQL root CA bundle when the database root is not in the base image trust store. Required only when `database.caSecretName` is set.                                                                                                                              |
| `occ-auth-secret`     | Random secret that signs and verifies user sessions. Generate it once with the command below and keep it across redeployments. It is separate from the administrator password, service API key, and model-provider key.                                                         |

Save both database URLs in protected files, replacing placeholders and preserving
required TLS options. For managed PostgreSQL roots supplied through
`database.caSecretName`, set `sslmode=verify-full` and `sslrootcert` to the
mounted CA file in both URLs. With the example mount settings, the path is
`/etc/openclaw/database-ca/ca.pem`; if you change them, use
`<database.caMountPath>/<database.caKey>`. Introduce URL query parameters with
`?`, or join them to existing parameters with `&`. Generate the auth secret for a
new Installation; this command refuses to overwrite an existing file:

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
history, and the repository.

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

Create system Secrets from protected files:

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

These commands provision operator-owned inputs, not recurring Secret synchronization. When `database.caSecretName` is set, the chart mounts that Secret
read-only into migration, bootstrap, API, and worker containers at
`database.caMountPath`; the PostgreSQL URLs still own `sslrootcert` selection.

### Optional repository credential service

Enable repository credentials only after preparing the
[repository service inputs](../repository-credentials/installation.md) and
[GitHub Backend selection](../../reference/backends.md#github-repository-credentials):
the immutable service image, registry ConfigMap, private service configuration,
App key, internal-Service TLS Secret, and public CA Secret. Mount one registry
version into the API, worker, and
service. The Compute network peer must select the worker Pod on port `8443`; the
Service serves HTTPS on `443`.

The chart runs one `Recreate` worker Pod with a credential sidecar. Only the
sidecar mounts the App and TLS private inputs, and it has no Kubernetes API token;
only the worker container's token has tenant Secret access, and the worker stays
[trusted per tenant namespace](../../reference/security/runtime-isolation.md#temporary-runtime-credential-exceptions).
NetworkPolicies let managed gateways reach the service and the worker reach
approved provider CIDRs; registry and session checks enforce exact scope. Startup
rejects `limits.shutdownGraceMs` above `60000` to finish cleanup within the
Pod's 75-second grace. Restart the API and worker together after registry
or service input changes; readiness does not prove token minting or Agent Git
workflows.

### Azure PostgreSQL workload identity

For [Azure workload-identity database authentication](../../reference/settings/operations.md#postgresql-connection-authentication),
use password-free URLs with verified TLS in the database URL files above.
Prepare identity environment variables and a renewed federation-token projection
for each connecting process: migration, bootstrap, API, and worker.
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
credentials, and verification.

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

The helper refuses any nonfresh mounted root except `lost+found`, schedules with
the supplied node selector before storage binds, reports `Prepared bootstrap
volume claim ... with UID/GID 1000 mode 0700.`, and retains failed Pods for
diagnosis. If policy forbids the preparation Pod, have the storage administrator
create the same root state.

Install the chart with native values:

```bash
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  --wait --timeout 5m
```

For the [published chart](../../../.github/chart-publication.md#pull-and-install),
authenticate Helm, verify its receipt, then use
`oci://ghcr.io/openclaw/charts/openclaw-enterprise` with `--version "$OCE_VERSION"`.

Helm owns migration and bootstrap ordering through its initialization hook.
Readiness covers the API and worker probes, not authenticated API access, Agent
deployment, or a model turn.

## Authenticate to the production API

Retrieve `initial-admin-service-key.json` from the protected bootstrap PVC
through approved storage access and retain it privately. This example preserves
existing shell values and creates a separate session copy:

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
`meta.installationId`. Before the first image update, use that ID to
[bind upgrades to this Kubernetes Installation](production-upgrade.md#bind-the-installation-once).
API and worker cannot read the bootstrap PVC. Keep the protected source because
initialization does not reissue a lost key. The
[operator cleanup](production-agents.md#end-the-operator-session) removes the
session copy.

After authentication, follow [Namespace and Agent deployment](production-agents.md),
including its [model-response check](production-agents.md#verify-production-workloads).

For later releases, follow the
[production image upgrade](production-upgrade.md).

## Related

Continue with [production Agent deployment](production-agents.md), or use the
[production image upgrade](production-upgrade.md) for an existing release. For failed
initialization, preserve state and follow [bootstrap recovery](../../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap)
and the [production startup flow](../../flows/production-startup.md).

[Connect default metrics and logs](../observability.md) to your collectors. The
[optional demo stack](../observability/demo.md) is not recommended for production.
