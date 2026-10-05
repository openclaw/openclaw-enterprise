# Install the production control plane

Prepare [Kubernetes](kubernetes.md) or [EKS](eks.md), the
[production prerequisites](../deploy.md#production-prerequisites), and
[workspace routing](workspace-routing.md#requirements), including a GatewayClass.
Keep private routing enabled. Start with the password profile and
[native Agent administration](native-admin.md#requirements); optional
[GitHub](#enable-github-browser-sign-in) or [Google](google-sign-in.md) sign-in requires disabling native administration.

Configure with an [installation profile](#recommended-generate-profile-configuration)
or [manual YAML](#advanced-copy-manual-yaml-examples).

Use a clean checkout matching the image revision. Follow
[private-registry delivery](private-registry-images.md) for provenance, ECR copies,
and chart selection. Retain this shell and protected files for
[Agent deployment](production-agents.md).

## Use published images

Use `ghcr.io/openclaw/openclaw-enterprise-controller:latest` and
`ghcr.io/openclaw/openclaw-enterprise-runtime:latest` through the
[published-image procedure](published-images.md), which sets revision-checked
`CONTROLLER_IMAGE` and `RUNTIME_IMAGE` and selects the matching checkout and
chart. Complete it before generating configuration; then skip the build section.

Public GHCR pulls need no pull Secret. For private registry copies, configure
pull credentials for control-plane and tenant Pods; workstation `docker login`
does not authenticate cluster nodes.

## Build and publish production images

Use the separately approved [publication workflow](../../../.github/containers.md)
or build these images for your registry:

| Image      | Source                                                                                                         | Used by                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Controller | Root [`Dockerfile`](../../../Dockerfile), target `runtime`                                                     | API, worker, migration, and bootstrap       |
| Runtime    | [`deploy/runtime/Dockerfile`](../../../deploy/runtime/Dockerfile), assembling pinned OpenClaw source and Codex | Gateways and Agents (one image serves both) |

With Buildx and push access, set your registry, repository, and node platform.
The base image follows the [runtime recipe](../../../deploy/runtime/README.md).

Authenticate the builder with `docker login <registry-host>` and approved
credentials; for private ECR, follow [ECR authentication](eks.md#authenticate-the-image-builder-to-ecr).

Run this push in a fresh Bash shell; on failure, stop and retain the metadata.
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

Before installation, [check each digest](../../testing/images.md#check-published-images)
on native hosts for every target architecture, without skips. Configure pull credentials only when the selected registry requires
them.

## Configure the Installation

This runbook uses Helm
release `oce` in Namespace `openclaw-system`. Keep configuration and
bootstrap PVC YAML in the protected `OCC_INPUT_DIRECTORY`; Secret inputs stay
under `/secure/occ`.

To reuse profile output or verified YAML from
[local operations](local-operations.md#build-images-for-local-kubernetes), set
`OCC_INPUT_DIRECTORY` to it, skip both generation branches, and continue with the
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
Generation requires Node.js 24+ on the operator host. Manual YAML does not, but
the later Agent transport-provisioning example does; without Node, provision
transports in the console.

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

If rendering fails, stop, fix the input, and rerender; never substitute example
or manual YAML. This keeps `values.yaml`, `installation.yaml`, and
`controlPlane.installationChecksum` paired.

### Advanced: copy manual YAML examples

Use this branch only when deliberately skipping profiles; it refuses to overwrite
existing configuration YAML. The manual example selects the curated Codex PluginDriver catalog,
unlike the `codex` profile's default hosted PAT-backed discovery.

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
[Verify installation image selections](../../testing/images.md#verify-installation-image-selections).

### Shared bootstrap PVC and configuration checks

Create the bootstrap PVC manifest if it is absent:

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
  password claim. Keep native admin enabled for the password profile, and gateway
  routing enabled with the reviewed GatewayClass and Secret names.
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

Run every check below before provisioning the password profile:

```bash
yq e -e '.images.controller | test("@sha256:[a-f0-9]{64}$")' \
  "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null
yq e -e '.auth.baseUrl != "" and .bootstrap.adminEmail != "" and
  (.database.cidrs | length > 0) and (.cluster.cidrs | length > 0) and
  (.controlPlane.nodeSelector | length > 0) and
  (.api.clients | length > 0) and .gatewayRouting.enabled == true and
  .gatewayRouting.gatewayClassName != "" and
  .gatewayRouting.apiKeySecretName != "" and (.agentNativeAdmin.enabled == true or
  .auth.github.enabled == true or .auth.google.enabled == true)' \
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
example mount settings, otherwise `<database.caMountPath>/<database.caKey>`. Start query parameters with `?` and
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

These operator-owned Secrets are not synchronized automatically. The optional CA
Secret mounts read-only in migration, bootstrap, API, and worker containers at
`database.caMountPath`.

### Optional repository credential service

Enable repository credentials only after preparing the
[repository service inputs](../repository-credentials/installation.md#prepare-the-registry-and-protected-inputs),
[network peer](../repository-credentials/installation.md#select-composition-and-network-access),
and [GitHub Backend selection](../../reference/backends.md#github-repository-credentials).
The chart runs one `Recreate` worker Pod with a credential sidecar; confirm its
[mounts and token scope](../repository-credentials/installation.md#install-and-verify).
The worker stays
[trusted per tenant namespace](../../reference/security/runtime-isolation.md#temporary-runtime-credential-exceptions);
registry and session checks enforce exact scope. Startup
rejects `limits.shutdownGraceMs` above `60000` to finish cleanup within the
Pod's 75-second grace. Restart the API and worker together after registry
or service input changes; readiness does not prove token minting or Agent Git
workflows.

### Azure PostgreSQL workload identity

For [Azure workload-identity database authentication](../../reference/settings/operations.md#postgresql-connection-authentication),
use password-free, TLS-verified URLs in the database URL files above. Give each
connecting process (migration, bootstrap, API, and worker) the identity
environment variables and a renewed federation-token projection. Provision
federation and database grants for separate application and migrator
identities, confining migrator privileges to migration. Use
`node scripts/migrate-production.mjs` for this authentication mode.

The chart configures none of these deployment-owned inputs. Its migration and
bootstrap containers share an initialization Pod and service account, so
changing database URL Secrets alone neither configures their distinct identity
inputs nor enables Azure mode.

### Optional operational log export

Prepare optional Collector Secrets, values, and verification through
[Configure platform observability](../observability.md#kubernetes-and-helm).

### Prepare the fresh bootstrap output PVC

Create the claim, then prepare its mounted root with the controller image:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n openclaw-system apply -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"

scripts/prepare-bootstrap-volume --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace openclaw-system --claim "$BOOTSTRAP_CLAIM" --image "$CONTROLLER_IMAGE" \
  --node-selector oce-role=control
```

Replace `--node-selector oce-role=control` with the `controlPlane.nodeSelector`
labels, one option per label, so preparation and initialization share volume
topology.

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

For an explicitly [published chart release](../../../.github/chart-publication.md#pull-and-install)
(created with `publish_chart: true`),
verify its receipt, then use `oci://ghcr.io/openclaw/charts/openclaw-enterprise`
with `--version "$OCE_VERSION"`.

Helm owns migration and bootstrap ordering through its initialization hook.
Readiness covers the API and worker probes, not authenticated API access, Agent
deployment, or a model turn.

## Authenticate to the production API

Retrieve and privately retain `initial-admin-service-key.json` from the
protected bootstrap PVC through approved storage access. This example works on
a session copy:

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

## Enable GitHub browser sign-in

The published controller lacks GitHub sign-in; [build a compatible image](#build-and-publish-production-images).
Follow the [single-controller profile](../../reference/authentication/external-sign-in.md#github-sign-in-for-existing-accounts)
during stopped maintenance, after first installing without GitHub as above.

Activation is one-way: the database refuses older images' sessions and
`auth.github` must stay set. Never `helm rollback` past activation
([rollback](production-upgrade-recovery.md#roll-back-across-human-sign-in));
[stopped maintenance](auth-maintenance.md) deactivates it.

1. Verify password recovery ([replaceable](../../reference/authentication/external-sign-in.md#session-and-recovery-controls)
   later). Register
   the GitHub App callback and protect its **client ID** (not App ID) and secret
   as the [reference](../../reference/authentication/external-sign-in.md#github-sign-in-for-existing-accounts) describes.
   As the recovery administrator, read `data.user.id` from
   `GET /api/auth/session`.
2. Create the Secret, then set `auth.github.enabled: true`, that ID as
   `auth.recoveryUserId`, and `agentNativeAdmin.enabled: false` in protected
   values, keeping workspace routing. Optionally narrow `auth.github.egressCidrs`, set `api.trustedProxy`
   ([settings](../../reference/settings/production.md#github-sign-in-and-trusted-proxies)), or limit
   sign-in to members with `auth.github.allowedOrgs` and `allowedTeams`, after granting the App
   Members: read ([allowlist](../../reference/authentication/external-sign-in.md#organization-and-team-allowlist)).
   Profile installs set [these inputs](installation-profiles.md#external-sign-in-and-trusted-proxies)
   and keep them in every rerender; rerender.

   ```bash
   kubectl -n openclaw-system create secret generic occ-github-login \
     --from-file=client-id=/secure/occ/github-client-id \
     --from-file=client-secret=/secure/occ/github-client-secret
   ```

3. Close ingress. Disable automatic restarts and policy/provisioning writers;
   drain admitted requests.
4. Run `helm upgrade` with the compatible image. The api Deployment uses
   `Recreate`, so the old Pod stops first; startup enrolls qualifying accounts, logs any it skips,
   and invalidates unbound sessions before serving. After a failure, keep ingress closed.
5. Through restricted access, verify password recovery, new session admission,
   the expected Namespaces and existing Agent detail, and rejected stale sessions.
   Reopen ingress only after these checks, retaining one serving controller.

For enrollment, obtain the numeric subject with `gh api user --jq .id` as the
intended GitHub user; verify ownership through your identity process, not
email or usernames. Follow the reference's attachment and unknown-outcome handling.
Once every ordinary account has an identity, set `auth.passwordSignIn: recovery-only`
([recovery-only sign-in](../../reference/authentication/external-sign-in.md#recovery-only-password-sign-in)).
Loopback tests do not qualify production stop/drain, cookies, logging, or GitHub registration.

## Related

Use the [production image upgrade](production-upgrade.md) for an existing release. For failed
initialization, preserve state and follow [bootstrap recovery](../../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap)
and the [production startup flow](../../flows/production-startup.md).

[Connect default metrics and logs](../observability.md) to your collectors. The
[optional demo stack](../observability/demo.md) is not recommended for production.
