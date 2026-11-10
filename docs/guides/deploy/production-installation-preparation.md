# Prepare a production installation

Prepare images, protected configuration, and workspace access before installing
the control plane. Complete the [installation prerequisites](production-installation.md#before-you-start)
first, using a clean checkout matching the selected image source commit.
Keep the same Bash shell and protected files through preparation and installation.

For [published images](production-installation.md#use-published-images), export the
verified image pair and start at [Configure the Installation](#configure-the-installation).
If building from source, complete the build steps below before configuring the Installation.

## Build and publish production images

Use the separately approved [publication workflow](../../release/containers.md)
or build these images for your registry:

| Image      | Source                                                                                                         | Used by                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Controller | Root [`Dockerfile`](../../../Dockerfile), target `runtime`                                                     | API, worker, migration, and bootstrap       |
| Runtime    | [`deploy/runtime/Dockerfile`](../../../deploy/runtime/Dockerfile), assembling pinned OpenClaw source and Codex | Gateways and Agents (one image serves both) |

Select your registry, repository, and platform. Buildx uses the [runtime recipe's](../../../deploy/runtime/README.md) reviewed CI base.

Authenticate the builder with `docker login <registry-host>` and approved
credentials; for private ECR, follow [ECR authentication](eks-openshell-setup.md#authenticate-the-image-builder-to-ecr).

In a fresh Bash shell, [resolve the OpenClaw build arguments](../../../deploy/runtime/README.md#resolve-openclaw-build-arguments).
Stop on failure; retain metadata.
Use the standard Slack/Codex runtime for both slots unless you separately verified
another gateway/Codex pair. Installing packages at gateway
startup is unsupported.

```bash
# Build from a clean checkout.
export OCC_IMAGE_REGISTRY="${OCC_IMAGE_REGISTRY:-registry.example.com}"
export OCC_IMAGE_REPOSITORY="${OCC_IMAGE_REPOSITORY:-$OCC_IMAGE_REGISTRY/your-team/openclaw-enterprise}"
export OCC_IMAGE_PLATFORM="${OCC_IMAGE_PLATFORM:-linux/amd64}"
if unset CONTROLLER_IMAGE RUNTIME_IMAGE OCC_IMAGE_METADATA &&
  NODE_BASE_IMAGE="$(yq -p=json -e -r '.prepare.defaultEnv.NODE_BASE_IMAGE' scripts/ci/test-suites/images-packaging.json)" &&
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
    "${openclaw_build_args[@]}" \
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

If a build fails certificate verification when downloading a package behind an HTTPS proxy or from a private package registry, add `--secret "id=build-ca,src=$CA_BUNDLE"` to both `docker buildx build` commands above. Set `CA_BUNDLE` to a PEM file with the public trust roots and the approved proxy or registry CA certificate. Both Dockerfiles mount this file only during the download steps. Keep TLS verification enabled. Image registry TLS uses the builder's own trust configuration.

Before installation, [check each digest](../../testing/docker.md#check-published-images)
on native hosts for every target architecture, without skips. Configure pull
credentials only when the selected registry requires them.

### Build through a package registry mirror

When building either image from source, Corepack downloads the pinned pnpm
version, then pnpm installs dependencies. Corepack does not read npmrc. To
route both downloads through a mirror, supply the secrets for their respective
steps to each `docker buildx build` command:

```bash
--secret "id=corepack-env,src=$COREPACK_ENV_FILE" \
--secret "id=npmrc,src=$NPMRC_FILE"
```

Keep both files outside the checkout and readable only by their owner. The
Corepack file uses dotenv syntax: set `COREPACK_NPM_REGISTRY` to the mirror's
credential-free HTTPS base URL **without a trailing slash**. When authentication
is required, use `COREPACK_NPM_TOKEN`; Corepack sends this bearer token only to
the configured registry origin. Do not use `COREPACK_NPM_USERNAME` and
`COREPACK_NPM_PASSWORD`: Corepack can send those Basic credentials to a different
archive host named by registry metadata. If the mirror uses a private CA,
supply the `build-ca` bundle described above. Keep Corepack integrity checks enabled.

Configure pnpm's registry and a separate read-only dependency credential in
npmrc. The runtime's permitted dependency lifecycle scripts can read this file.
The build mounts it only during dependency installation and mounts
`corepack-env` only during bootstrap. Omitting `corepack-env` keeps Corepack's
default registry selection.

## Configure the Installation

This runbook uses Helm
release `oce` in Namespace `openclaw-system`. Keep configuration and
bootstrap PVC YAML in the protected `OCC_INPUT_DIRECTORY`; Secret inputs stay
under `/secure/occ`.

To reuse profile output or verified YAML from
[local operations](local-operations.md#build-images-for-local-kubernetes), set
`OCC_INPUT_DIRECTORY` to it, copy the cluster kubeconfig there as `kubeconfig`
with mode `0600`, skip both generation branches, and continue with the
[shared checks](#shared-bootstrap-pvc-and-configuration-checks).

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
Generation requires Node.js satisfying `engines.node` in the selected release checkout's `package.json` on the operator host (and `pnpm install` with
native admin). Without Node.js on the operator host, use the manual YAML examples.

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

If rendering fails, stop, fix the input, and rerender; do not substitute example
or manual YAML. Keep `values.yaml`, `installation.yaml`, and `controlPlane.installationChecksum` paired.

### Advanced: copy manual YAML examples

Without profiles, this branch refuses overwrites and selects curated discovery;
Codex profiles use hosted discovery.

Hosted discovery requires [paired networking](installation-profiles.md#hosted-discovery-egress);
the startup Secret alone grants none.

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

For registry-backed installs, compare selected images with the checked digests:
check the profile input JSON before rendering, or the edited manual YAML with
[Verify installation image selections](../../testing/docker.md#verify-installation-image-selections).

### Shared bootstrap PVC and configuration checks

Create the bootstrap PVC manifest if it is absent:

```bash
test -e "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml" || \
  install -m 600 deploy/examples/production/bootstrap-pvc.yaml "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
chmod 600 "$OCC_INPUT_DIRECTORY/values.yaml" \
  "$OCC_INPUT_DIRECTORY/installation.yaml" \
  "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
```

For profiles, change `$OCC_PROFILE_INPUT` and rerender instead of editing
`values.yaml` or `installation.yaml`. For manual installs, edit the copied YAML
before the checks:

- `values.yaml`: set auth URL, admin email, database and cluster CIDRs,
  control-plane node selector, database CA, DNS, API clients, and bootstrap
  password claim. Keep `bootstrap.password.mountPath` absolute; the bootstrap Job
  refuses relative paths. Keep native admin enabled for the password profile, and gateway
  routing enabled with the reviewed GatewayClass and Secret names. Helm refuses an
  `auth.baseUrl` that breaks the
  [`OCC_AUTH_BASE_URL` rules](../../reference/settings/production.md#required-production-controller-environment)
  (HTTPS is required for browser sessions), even a bare `?` or `#`, Unicode
  spaces or invisible characters (outer ASCII spaces are ignored), or forms the
  API's URL parser refuses, such as full-width `？`.
  IDNA-invalid joiners (U+200C, U+200D) pass Helm but fail the bootstrap Job.
  In shared-cookie mode, Console and Agent hosts must share a non-public DNS
  suffix; OCC derives the cookie domain. OIDC host-only exchange requires
  same-site HTTPS without a shared Console cookie.
- `installation.yaml`: set cluster name, log level, DNS selectors,
  service-principal token settings, Secret prefixes, runtime storage class,
  immutable runtime image digests, and PluginDriver catalog. Set
  `runtime.gatewayNodeSelector` and `runtime.nodeSelector` to
  [disjoint Ready pools](../../reference/drivers/kubernetes-compute.md#images-and-resources);
  Helm does not place runtimes. Omit `network.gatewayClients` with
  [routing](../../reference/gateway-routing.md#routing-configuration) enabled.
  `presets.includeDefaults: false` disables the
  [bundled Presets](../../reference/presets.md#installation-defaults).

Set `bootstrap-pvc.yaml` name, namespace, size, and protected `storageClassName`.

For `logging.level`, see [Choose the log level](../observability.md#1-choose-the-log-level).
[Configure native admin domains](native-admin.md#steps).
For Slack Agents, configure both proxy paths in the
[Slack guide](../integrations/slack.md#configure-both-slack-proxies). For Codex
sandboxing, follow [Codex sandbox setup](codex-sandbox.md).

`images.controller` must be an immutable reference `prepare-bootstrap-volume --image` accepts: a letter or digit, then only letters, digits, `.`, `_`, `:`, `/`, and `-`, and a lowercase `sha256` digest.

Before running this block, confirm that `OCC_INPUT_DIRECTORY` points to the
intended protected directory containing your prepared `values.yaml`,
`installation.yaml`, and `bootstrap-pvc.yaml`. In a new shell, restore that
[setup](#configure-the-installation) first.

Run this block before provisioning the password profile. If it fails, correct the
named check before continuing. After the directory check, each run invalidates
the previous render. Image, claim, database CA, and manifest-path exports are set
only after every check succeeds:

```bash
{
  unset CONTROLLER_IMAGE BOOTSTRAP_CLAIM OCC_RENDERED_MANIFEST
  unset DATABASE_CA_SECRET DATABASE_CA_KEY
  OCC_RENDER_TEMP=
  if
    OCC_VALIDATION_STEP='input directory setup: set OCC_INPUT_DIRECTORY to the intended existing directory with all three prepared YAML files' &&
    test -n "${OCC_INPUT_DIRECTORY:-}" &&
    test -d "$OCC_INPUT_DIRECTORY" &&
    test -f "$OCC_INPUT_DIRECTORY/values.yaml" &&
    test -f "$OCC_INPUT_DIRECTORY/installation.yaml" &&
    test -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml" &&
    OCC_VALIDATION_STEP='previous render invalidation' &&
    rm -f -- "$OCC_INPUT_DIRECTORY/rendered.yaml" &&
    OCC_VALIDATION_STEP='controller image digest' &&
    yq e -e '.images.controller | test("@sha256:[a-f0-9]{64}$")' \
      "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null &&
    OCC_VALIDATION_STEP='control-plane settings' &&
    yq e -e '.auth.baseUrl != "" and .bootstrap.adminEmail != "" and
      (.database.cidrs | length > 0) and (.cluster.cidrs | length > 0) and
      (.controlPlane.nodeSelector | length > 0) and
      (.api.clients | length > 0) and .gatewayRouting.enabled == true and
      .gatewayRouting.gatewayClassName != "" and
      .gatewayRouting.apiKeySecretName != "" and (.agentNativeAdmin.enabled == true or
      .auth.google.enabled == true or
      .auth.oidc.enabled == true)' \
      "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null &&
    OCC_VALIDATION_STEP='runtime settings' &&
    yq e -e '.drivers.compute.configuration.images.requireImmutableDigest == true and
      (.drivers.compute.configuration.images.gateway | test("@sha256:[a-f0-9]{64}$")) and
      (.drivers.compute.configuration.images.agent | test("@sha256:[a-f0-9]{64}$")) and
      .drivers.compute.configuration.runtime.gatewayStorageClassName != "" and
      (.drivers.compute.configuration.runtime.gatewayNodeSelector | length > 0) and
      (.drivers.compute.configuration.runtime.nodeSelector | length > 0)' \
      "$OCC_INPUT_DIRECTORY/installation.yaml" >/dev/null &&
    OCC_VALIDATION_STEP='bootstrap PVC' &&
    yq e -e '.metadata.namespace == "openclaw-system" and .spec.storageClassName != ""' \
      "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml" >/dev/null &&
    OCC_VALIDATION_STEP='render temporary file' &&
    OCC_RENDER_TEMP="$(mktemp "$OCC_INPUT_DIRECTORY/.rendered.XXXXXXXX")" &&
    OCC_VALIDATION_STEP='Helm render' &&
    helm template oce deploy/helm/openclaw-enterprise \
      --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
      >"$OCC_RENDER_TEMP" &&
    OCC_VALIDATION_STEP='controller image extraction' &&
    CONTROLLER_IMAGE="$(yq e -e -r '.images.controller' "$OCC_INPUT_DIRECTORY/values.yaml")" &&
    OCC_VALIDATION_STEP='database CA Secret extraction' &&
    DATABASE_CA_SECRET="$(yq e -r '.database.caSecretName // ""' "$OCC_INPUT_DIRECTORY/values.yaml")" &&
    OCC_VALIDATION_STEP='database CA key extraction' &&
    DATABASE_CA_KEY="$(yq e -r '.database.caKey // "ca.pem"' "$OCC_INPUT_DIRECTORY/values.yaml")" &&
    OCC_VALIDATION_STEP='bootstrap claim extraction' &&
    OCC_BOOTSTRAP_CLAIM_JSON="$(yq e -e -o=json -I=0 '.bootstrap.password.claimName | select(tag == "!!str" and length > 0)' "$OCC_INPUT_DIRECTORY/values.yaml")" &&
    OCC_VALIDATION_STEP='bootstrap claim match' &&
    OCC_EXPECTED_BOOTSTRAP_CLAIM="$(yq e -e -o=json -I=0 '.metadata.name | select(tag == "!!str" and length > 0)' "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml")" &&
    test "$OCC_BOOTSTRAP_CLAIM_JSON" = "$OCC_EXPECTED_BOOTSTRAP_CLAIM" &&
    OCC_VALIDATION_STEP='bootstrap claim export' &&
    BOOTSTRAP_CLAIM="$(yq e -e -r '.bootstrap.password.claimName + "."' "$OCC_INPUT_DIRECTORY/values.yaml")" &&
    BOOTSTRAP_CLAIM="${BOOTSTRAP_CLAIM%.}" &&
    test "$(BOOTSTRAP_CLAIM="$BOOTSTRAP_CLAIM" yq e -n -o=json -I=0 'strenv(BOOTSTRAP_CLAIM)')" = "$OCC_BOOTSTRAP_CLAIM_JSON" &&
    OCC_VALIDATION_STEP='validated render publication' &&
    mv -- "$OCC_RENDER_TEMP" "$OCC_INPUT_DIRECTORY/rendered.yaml"
  then
    OCC_RENDERED_MANIFEST="$OCC_INPUT_DIRECTORY/rendered.yaml"
    export CONTROLLER_IMAGE BOOTSTRAP_CLAIM OCC_RENDERED_MANIFEST
    export DATABASE_CA_SECRET DATABASE_CA_KEY
    unset OCC_VALIDATION_STEP OCC_BOOTSTRAP_CLAIM_JSON OCC_EXPECTED_BOOTSTRAP_CLAIM OCC_RENDER_TEMP
  else
    unset CONTROLLER_IMAGE BOOTSTRAP_CLAIM OCC_RENDERED_MANIFEST
    unset DATABASE_CA_SECRET DATABASE_CA_KEY
    if [ -n "$OCC_RENDER_TEMP" ]; then rm -f -- "$OCC_RENDER_TEMP"; fi
    printf 'Installation check failed: %s; stop before provisioning.\n' "$OCC_VALIDATION_STEP" >&2
    unset OCC_VALIDATION_STEP OCC_BOOTSTRAP_CLAIM_JSON OCC_EXPECTED_BOOTSTRAP_CLAIM OCC_RENDER_TEMP
    false
  fi
}
```

`$KUBECONFIG_FILE` must select the same cluster as `$CONTEXT`.

Prepare these Secret input files under `/secure/occ`, each holding one raw value
without quotes or assignment.

| File                  | Contents and source                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occ-application-url` | PostgreSQL connection URL for the limited application role, used by bootstrap, the API, and the worker. Example shape: `postgresql://occ_app:<url-encoded-password>@<postgres-host>:5432/<database>`.                                     |
| `occ-migration-url`   | URL for a separate schema-migration role on the same database. Example shape: `postgresql://occ_migrator:<url-encoded-password>@<postgres-host>:5432/<database>`. Obtain this credential separately; do not give it to the API or worker. |
| `occ-database-ca.pem` | PostgreSQL root CA bundle for a database root missing from the base image trust store. Required only when `database.caSecretName` is set.                                                                                                 |
| `occ-auth-secret`     | Random session-signing secret, separate from other credentials. Generate it once below and retain it across redeployments.                                                                                                                |

In both database URLs, replace placeholders and preserve required TLS options. For managed PostgreSQL roots supplied through
`database.caSecretName`, set `sslmode=verify-full` and `sslrootcert` to the
mounted CA file in both URLs: `/etc/openclaw/database-ca/ca.pem` with the
example mount settings, otherwise `<database.caMountPath>/<database.caKey>`.
With a CA Secret, Helm requires a path distinct from bootstrap and active
API/worker mounts. Start query parameters with `?` and
join further ones with `&`. Generate the auth secret for a
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
if [ -n "$DATABASE_CA_SECRET" ]; then
  chmod 600 /secure/occ/occ-database-ca.pem
  test -s /secure/occ/occ-database-ca.pem
fi
```

Keep these values out of Helm values, Installation YAML, Configurations, shell
history, and the repository.

## Prepare workspace access

Create the controller Namespace (`--namespace`: DNS-1123 label, maximum 63 characters):

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" create namespace openclaw-system
```

Complete [Configure private routing](workspace-routing.md#configure-private-routing):
create `occ-private-gateway-key` and match the Helm and Installation routing
settings. Validate and render changed inputs. Configure each
Agent's authentication during [Agent deployment](production-agents.md#configure-the-agent-runtime).

With chart-managed routing and Kubernetes Compute, startup checks the Installation's
`drivers.compute.configuration.gatewayRouting` settings. Its `gatewayName`,
`gatewayNamespace`, `envoyNamespace`, and effective `hostname` must match the
chart's private Gateway. A mismatch reports
`CHART_LISTENER_MISMATCH`. Correct the profile input and rerender, or align the
manual Installation and Helm values, before retrying. Leave `hostname` unset in
both files to use the generated Service DNS name.

After completing workspace access and validating any changed inputs, return to
[Provision system Secrets and install](production-installation.md#provision-system-secrets-and-install)
in the same Bash shell. Keep the validated exports and protected files available.
