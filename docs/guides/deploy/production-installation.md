# Install the production control plane

For an OpenShell cluster, start with [Kubernetes setup](kubernetes-setup.md) or
[Amazon EKS setup](eks-openshell-setup.md), then [deploy your first Agent](deploy-first-agent.md)
in the same operator shell. Those OpenShell workflows support development and
evaluation; [production qualification remains incomplete](../../reference/drivers/openshell-sandbox.md#remaining-qualification-work).

Use this guide for a custom Helm installation. Choose the [published images](#use-published-images),
[generate the profile configuration](#recommended-generate-profile-configuration), and
prepare the cluster resources below. Then [run `occ installation install`](#install-the-control-plane)
once, [authenticate to the API](#authenticate-to-the-production-api), and
[deploy a production Agent](production-agents.md).

Prepare [Kubernetes](kubernetes.md) or [EKS infrastructure](eks-openshell-setup.md#prepare-aws-infrastructure), the
[prerequisites below](#before-you-start), and
[workspace routing](workspace-routing.md#requirements), including a GatewayClass.
Private routing is enabled by default. The chart does not install Envoy Gateway,
Gateway API or Envoy CRDs, cert-manager, or the GatewayClass. Prepare those
controllers first; create the service-key Secret and match Helm and Installation
settings in [Prepare workspace access](#prepare-workspace-access) before Helm installation.
Start with the password profile and
[native Agent administration](native-admin.md#requirements); optional
[Google](google-sign-in.md) sign-in requires disabling native administration.

Use a clean checkout matching the image source commit. Follow
[private-registry delivery](private-registry-images.md) for provenance, ECR copies,
and chart selection. Retain this shell and protected files for
[Agent deployment](production-agents.md).

## Before you start

<Snippet file="../../snippets/kubernetes-prerequisites.md" />

## Use published images

Before generating configuration, [select the published image pair](published-images.md)
(`stable` or `latest`). Verify the source commit, export `CONTROLLER_IMAGE` and
`RUNTIME_IMAGE`, and use the matching checkout and chart. Skip the build section.

Public GHCR pulls need no pull Secret. For private copies, grant pull access to
every control-plane and tenant node; workstation `docker login` does not authenticate
nodes. See [private registry delivery](private-registry-images.md#configure-node-pull-access).

## Build and publish production images

If building from source, follow [Build and publish production images](production-installation-preparation.md#build-and-publish-production-images).
For a custom Helm installation, continue through configuration and workspace access
in that guide. Otherwise, return to the guide that directed you to build images.

### Build through a package registry mirror

For source builds using a mirror, follow [Build through a package registry mirror](production-installation-preparation.md#build-through-a-package-registry-mirror).

## Configure the Installation

Complete [Configure the Installation](production-installation-preparation.md#configure-the-installation),
using profiles, manual examples, or verified existing YAML as directed there.
Complete the shared checks and workspace access, then return to
[provisioning](#provision-system-secrets-and-install) in the same Bash shell.

### Recommended: generate profile configuration

After the [configuration setup](production-installation-preparation.md#configure-the-installation),
[generate profile configuration](production-installation-preparation.md#recommended-generate-profile-configuration),
then complete the shared checks and workspace access.

### Advanced: copy manual YAML examples

After the [configuration setup](production-installation-preparation.md#configure-the-installation),
use [manual YAML examples](production-installation-preparation.md#advanced-copy-manual-yaml-examples)
only when not using profiles. Continue through the shared checks and workspace access.

### Shared bootstrap PVC and configuration checks

First complete the [configuration setup](production-installation-preparation.md#configure-the-installation)
for the intended protected input directory and prepare or select the YAML as directed there.
In the same Bash shell, run the complete [shared checks](production-installation-preparation.md#shared-bootstrap-pvc-and-configuration-checks),
keep their validated exports, and continue to workspace access.

## Prepare workspace access

Before [workspace access](production-installation-preparation.md#prepare-workspace-access),
complete the [configuration setup](production-installation-preparation.md#configure-the-installation)
and [shared checks](production-installation-preparation.md#shared-bootstrap-pvc-and-configuration-checks).
Use the same Bash shell with its reviewed `KUBECONFIG_FILE` and `CONTEXT` and validated exports.
Render and validate changed inputs before provisioning below.

## Provision system Secrets and install

Run this whole block only if you have not attempted any of the Secret creates
below. If you have already attempted a create, follow the recovery instructions
after the block. Use the Bash shell where validation succeeded and the Secret
inputs were prepared. In a new shell, restore the [input-directory setup](production-installation-preparation.md#configure-the-installation) and rerun
[validation](production-installation-preparation.md#shared-bootstrap-pvc-and-configuration-checks), which also loads `DATABASE_CA_SECRET` and `DATABASE_CA_KEY` from the
intended `values.yaml`. Recheck the prepared protected inputs,
including the CA file when configured. Keep the existing auth secret. Both server
dry runs must succeed before the block creates Secrets.

```bash
(
  if [ -z "${OCC_RENDERED_MANIFEST:-}" ]; then
    printf 'Run validation successfully in this Bash shell before provisioning.\n' >&2
    exit 1
  fi
  if ! kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
    apply --dry-run=server -f "$OCC_RENDERED_MANIFEST" ||
    ! kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
      apply --dry-run=server -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
  then
    printf 'Server dry run failed; correct the error before provisioning Secrets.\n' >&2
    exit 1
  fi
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
    create secret generic occ-installation-startup --from-file=installation.yaml="$OCC_INPUT_DIRECTORY/installation.yaml" || exit 1
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
    create secret generic occ-database --from-file=application-url=/secure/occ/occ-application-url --from-file=migration-url=/secure/occ/occ-migration-url || exit 1
  if [ -n "$DATABASE_CA_SECRET" ]; then
    kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
      create secret generic "$DATABASE_CA_SECRET" \
      --from-file="$DATABASE_CA_KEY=/secure/occ/occ-database-ca.pem" || exit 1
  fi
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
    create secret generic occ-auth --from-file=secret=/secure/occ/occ-auth-secret || exit 1
)
```

If either dry run fails and you have never attempted these Secret creates,
correct the error and rerun the block. If a Secret create fails or its result is
unknown, verify which Secrets exist in `openclaw-system` on the reviewed cluster.
Resolve uncertain writes before resuming. Do not repeat confirmed successful
creates.

If you change any of the three prepared YAML files, rerun validation before
continuing; it reloads the CA settings from the intended `values.yaml`. Do not
reuse the previous CA selection. Recheck the protected inputs, including the CA file when
its settings change. Keep the existing auth secret. Before repeating dry runs or
any remaining creates, verify that previously created Secrets match the intended
inputs and resolve any mismatch within the authorized change scope. When resuming
after a create attempt, run both server dry runs separately from the create
commands. Only after both dry runs succeed, run the create commands confirmed to
be outstanding. Continue only after all required Secrets match the intended inputs.

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

The chart configures none of these inputs. Its migration and bootstrap
containers share an initialization Pod and service account, so changing the
database URL Secrets alone neither configures their distinct identity inputs nor
enables Azure mode.

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
topology. Helm refuses keys and values that helper refuses; values may be
empty, as in `--node-selector node-role.kubernetes.io/infra=`.

The helper refuses nonfresh roots except `lost+found`, schedules before storage
binds, reports `Prepared bootstrap volume claim ... with UID/GID 1000 mode 0700.`,
and retains failed Pods. If policy forbids the Pod, have the storage administrator
prepare the same root state.

### Install the control plane

Exclude competing installs, upgrades and Job replacements. Use the [OCC CLI](../cli.md#connect-to-your-installation)
matching the chart source revision. [Keep the receipt for handoff](production-handoff.md#record-the-initialization-job-for-handoff), then install once:

```bash
INSTALL_RECEIPT_DIRECTORY="$OCC_INPUT_DIRECTORY/install-receipt"
occ installation install --release oce --chart deploy/helm/openclaw-enterprise \
  --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --kube-namespace openclaw-system --values "$OCC_INPUT_DIRECTORY/values.yaml" \
  --receipt "$INSTALL_RECEIPT_DIRECTORY" --wait-timeout 5m
```

After a lost response or refused release name, use the read-only
[`occ installation plan` or `doctor`](production-handoff.md#resume-an-installation-in-progress)
to inspect the original attempt.
Do not retry or switch to upgrade. An unused release name does not prove the database, identity or storage is fresh.

For an explicitly [published chart release](../../release/chart-publication.md#pull-and-install)
(created with `publish_chart: true`),
verify its publication receipt, pull the exact chart version locally, and pass
that local chart archive to `--chart`. The installer freezes local chart files;
it does not resolve a mutable remote chart reference.

Helm owns migration and bootstrap ordering through its initialization hook.
Readiness covers the API and worker probes, not authenticated API access, Agent
deployment, or a model turn.

## Authenticate to the production API

Read the protected bootstrap files before you authenticate. The claim holds
`initial-admin-service-key.json` and `initial-admin-password` as mode 0600 files
in a root directory owned by UID 1000 with mode 0700. A one-use reader Pod must
run as UID 1000 on the claim's control nodes and mount the claim read-only. If
admission refuses UID 1000, have the cluster administrator allow it for this Pod.
Permission to read this claim is privileged.

```bash
export READER_DIRECTORY="${READER_DIRECTORY:-/secure/occ}"
(
  set -euo pipefail
  umask 077
  jq -n --arg image "$CONTROLLER_IMAGE" --arg namespace openclaw-system \
    --arg claim "$BOOTSTRAP_CLAIM" \
    --argjson nodeSelector "$(yq e -o=json -I=0 '.controlPlane.nodeSelector' "$OCC_INPUT_DIRECTORY/values.yaml")" \
    -f docs/snippets/openshell-quickstart/kubernetes/bootstrap-reader.jq |
    kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" create -f -
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
    wait --for=condition=Ready pod/oce-owner-bootstrap-reader --timeout=3m
  for file in initial-admin-password initial-admin-service-key.json; do
    test ! -e "$READER_DIRECTORY/$file"
    kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
      exec oce-owner-bootstrap-reader -- \
      node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))' \
      "/bootstrap/$file" > "$READER_DIRECTORY/$file.tmp"
    test -s "$READER_DIRECTORY/$file.tmp"
    mv "$READER_DIRECTORY/$file.tmp" "$READER_DIRECTORY/$file"
  done
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
    delete pod oce-owner-bootstrap-reader
)
```

The block preserves completed copies, but a failed read can leave an incomplete
`.tmp` file. If either read fails, delete this attempt's reader Pod using the
command above. Keep the retrieved files private and in place; do not use `.tmp`
files as credentials. Select a fresh directory before repeating the block:

```bash
umask 077
READER_DIRECTORY="$(mktemp -d /secure/occ/bootstrap-reader.XXXXXXXX)" && export READER_DIRECTORY
```

Stop if directory creation fails. The retry reads both files from the same PVC
without overwriting the earlier copies or rerunning bootstrap. After it succeeds,
select the newly retrieved key, replacing any earlier path in this shell:

```bash
export OCC_BOOTSTRAP_KEY_FILE="${READER_DIRECTORY:?}/initial-admin-service-key.json"
```

Use the new directory for the credentials below. The files use the default names;
`bootstrap.password.fileName` and `bootstrap.serviceKey.fileName` override them. Sign in to the Console with
`bootstrap.adminEmail` and `initial-admin-password`. The service key file
authenticates the CLI and REST calls below. This example works on a session copy:

```bash
export OCC_URL="${OCC_URL:-https://<internal-occ-host>}"
export OCC_BOOTSTRAP_KEY_FILE="${OCC_BOOTSTRAP_KEY_FILE:-${READER_DIRECTORY:-/secure/occ}/initial-admin-service-key.json}"
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

## Enable external browser sign-in

Use [OIDC setup](oidc-sign-in.md) or [Google setup](google-sign-in.md) to register
the client and prepare the provider's dedicated Secret and Helm settings.
For an installation that uses direct GitHub sign-in, follow the
[OIDC upgrade procedure](oidc-upgrade.md) before installing this release.

1. Verify password sign-in as the recovery administrator. Read `data.user.id`
   from `GET /api/auth/session` and set `auth.recoveryUserId` to that ID.
2. Close general ingress, disable automatic restarts and identity or policy
   writers, drain requests, and [stop all database clients](auth-maintenance.md#stop-every-writer).
   On first activation, [run `activate --recovery-user <userId> --writers-stopped`](auth-maintenance.md#run-the-command).
   Review skipped accounts and verify `status`. Keep ingress closed and old
   API and worker replicas at zero.
3. Upgrade with the selected provider settings and initialization hooks enabled.
   The Job checks the Installation, migrates and bootstraps without reissuing
   credentials for a verified Installation. Confirm one serving controller and
   no old API Pods.
4. Through [restricted access](auth-maintenance.md#close-ingress-and-use-restricted-access),
   verify password recovery, provider sign-in, expected resource access and
   stale-session rejection. Attach each existing user's identity explicitly.
   Enable [OIDC enrollment](../../reference/authentication/team-enrollment.md)
   only with the intended admission rule, initial Role and Groups.
5. Reopen ingress after verification. Before enabling `auth.passwordSignIn:
recovery-only`, confirm that every ordinary account can sign in through its
   attached provider identity.

Activation is one-way during normal operation. Returning to password-only mode
requires [stopped maintenance](auth-maintenance.md#deactivate-external-sign-in).
Restart the API after secret rotation. Client ID or issuer changes require new
identity attachments. Loopback checks do not qualify production ingress,
provider registration or stop-and-drain procedures.

## Related

For existing releases, use [production image upgrade](production-upgrade.md). For failed
initialization, preserve state and follow [bootstrap recovery](../../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap)
and the [startup flow](../../flows/production-startup.md).

Connect [metrics and logs](../observability.md) to your collectors. The
[demo stack](../observability/demo.md) is not recommended for production.
