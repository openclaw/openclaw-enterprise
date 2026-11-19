# OpenShift deployment for RHOAI

Deployment assets for running OpenClaw Enterprise (OCE) and its OpenClaw
Control Plane (OCC) on Red Hat OpenShift, including the OpenShell gateway, the
OpenShell dashboard with Keycloak login, an authenticated Control UI Route, and
Keycloak-backed team-claw identities for Codex Agents.

These assets are opinionated for OpenShift. The OCE Helm chart, CLI, database
migrations, and upgrade workflow remain the supported installation path; this
directory adapts them with OpenShift admission, networking, routing, and
identity resources.

This is a development deployment profile, not a production qualification. It is
tested on OpenShift 4.22 with two `linux/amd64` workers, `gp3-csi` storage, the
Red Hat cert-manager Operator, and the certified Crunchy Data PostgreSQL
Operator.

## Before you begin

- Cluster administrator access to the target OpenShift cluster. Commands use the
  current kubeconfig context.
- OpenShift 4.22 or later, with at least two ready `amd64` nodes.
- A CNI that enforces NetworkPolicies, and a block-backed RWO storage class.
- The tool versions pinned by the repository's `mise.toml`: Go 1.27.3,
  Node.js 24.22.1, Helm 3.19.2, `kubectl` 1.35.0, and `yq` v4.48.1. Run
  `mise install` to install the pinned tools. `jq`, Git, OpenSSL, `curl`, and
  `envsubst` come from the workstation.
- The OCE workspace dependencies installed in `OCE_CHECKOUT` with
  `pnpm install --frozen-lockfile`.
- A clean OCE checkout for the release you deploy. When you deploy this
  repository's mainline, use this clone.

Create a private input directory outside every checkout. Keep kubeconfigs,
passwords, rendered overlays, and Secrets there.

```bash
umask 077
export OCE_CHECKOUT=/path/to/openclaw-enterprise
export OCC_INPUT_DIRECTORY="$HOME/.local/state/openclaw-enterprise/rhoai"
install -d -m 700 "$OCC_INPUT_DIRECTORY"
oc config view --raw --minify --flatten > "$OCC_INPUT_DIRECTORY/kubeconfig"
export KUBECONFIG="$OCC_INPUT_DIRECTORY/kubeconfig"
oc whoami --show-server
```

## Layout

| Path                      | Purpose                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `manifests/openshift/`    | Kustomize base stages and `test` overlay: operators, PostgreSQL, admission, OpenShell, control plane, routing. |
| `manifests/dashboard/`    | Keycloak, dashboard and gateway OIDC values, and dashboard network access.                                     |
| `manifests/native-admin/` | OCC admin launcher certificate, issuer, ingress, and network policy.                                           |
| `manifests/widgets/`      | Dashboard widget preview Route and certificate.                                                                |
| `manifests/agents/`       | Agent deployment procedure and the custom-model credential-source template.                                    |
| `manifests/presets/`      | Installation-wide team Agent Presets and their API, worker, and Job mount patches.                             |
| `scripts/`                | Build, prepare, resolve, upgrade, validate, and team-login helpers; see [SCRIPTS.md](SCRIPTS.md).              |
| `tests/`                  | Offline tests for the scripts.                                                                                 |

The Kustomize stages are documented in
[manifests/openshift/README.md](manifests/openshift/README.md). The dashboard
and Keycloak procedure is in
[manifests/dashboard/README.md](manifests/dashboard/README.md).

## Deployment order

Complete the sections in order. Create dependencies before the resources that
use them, and wait for readiness between stages.

### 1. Prepare the cluster

Label one worker for the control plane and a different worker for Agent
workloads. The bootstrap Pod, OCC, and Agent runtime all select these labels.

```bash
export CONTROL_NODE='<ready amd64 control node>'
export AGENT_NODE='<different ready amd64 agent node>'
test "$CONTROL_NODE" != "$AGENT_NODE"
oc label node "$CONTROL_NODE" oce-role=control --overwrite
oc label node "$AGENT_NODE" oce-role=agent --overwrite
```

Install cert-manager from the `redhat-operators` catalog and wait for the
certificate API before rendering OCE.

```bash
oc apply -f deploy/rhoai/manifests/openshift/base/operators/cert-manager-operator.yaml
oc -n cert-manager-operator wait \
  --for=jsonpath='{.status.installedCSV}'=cert-manager-operator.v1.20.1 \
  subscription/openshift-cert-manager-operator --timeout=5m
oc wait --for=condition=Established crd/certificates.cert-manager.io --timeout=5m
```

Prepare the private Console Route file with a hostname under the cluster's
ingress domain. Leave the certificate fields empty to use the cluster's default
ingress certificate.

```bash
export CLUSTER_APPS_DOMAIN="$(oc get ingresses.config.openshift.io cluster \
  -o jsonpath='{.spec.domain}')"
export OCC_CONSOLE_HOST="occ.$CLUSTER_APPS_DOMAIN"
install -m 600 deploy/rhoai/manifests/openshift/base/control-plane/console-route.yaml \
  "$OCC_INPUT_DIRECTORY/console-route.yaml"
yq -i '.spec.host = strenv(OCC_CONSOLE_HOST) |
  .spec.tls.termination = "edge" |
  .spec.tls.insecureEdgeTerminationPolicy = "Redirect"' \
  "$OCC_INPUT_DIRECTORY/console-route.yaml"
```

Apply the fixed-UID admission stage. It creates `openclaw-system` and grants
UID/GID 1000 to the Helm ServiceAccounts.

```bash
oc apply -k deploy/rhoai/manifests/openshift/overlays/test/admission
```

### 2. Install OpenShell

Install the pinned Agent Sandbox controller, then the OpenShell gateway chart
with the OpenShift values. The values pin the Red Hat Konflux images published
on `quay.io/opendatahub` and keep the plaintext, single-tenant gateway profile.

```bash
: "${OCC_INPUT_DIRECTORY:?Set the private input directory}"
install -d -m 700 "$OCC_INPUT_DIRECTORY/openshell-charts"

curl -fL https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.2/sandbox.yaml \
  -o "$OCC_INPUT_DIRECTORY/agent-sandbox-v0.5.2.yaml"
printf '%s  %s\n' \
  230ee446d6035f631577e1c6b857f6973a8f09a0a853675d3cc34ebfe47abd6b \
  "$OCC_INPUT_DIRECTORY/agent-sandbox-v0.5.2.yaml" | sha256sum -c
oc apply -f "$OCC_INPUT_DIRECTORY/agent-sandbox-v0.5.2.yaml"
oc -n agent-sandbox-system rollout status \
  deployment/agent-sandbox-controller --timeout=5m

helm pull oci://ghcr.io/nvidia/openshell/helm-chart \
  --version 0.1.6 --destination "$OCC_INPUT_DIRECTORY/openshell-charts"
helm pull oci://ghcr.io/nvidia/openshell/openshell-workspace \
  --version 0.1.6 --destination "$OCC_INPUT_DIRECTORY/openshell-charts"
printf '%s  %s\n' \
  0533ecf84f777954aaf6113a0813fbc9781ed2a5e6574fb807cebe9a818a1bd4 \
  "$OCC_INPUT_DIRECTORY/openshell-charts/helm-chart-0.1.6.tgz" \
  10452d43dcf24ff795239dc5daa0fffd509a16ff57739019f0ec084bb7ca37c5 \
  "$OCC_INPUT_DIRECTORY/openshell-charts/openshell-workspace-0.1.6.tgz" \
  | sha256sum -c

oc create namespace openshell-system --dry-run=client -o yaml | oc apply -f -
oc apply -f deploy/rhoai/manifests/openshift/base/openshell/openshell-gateway-network-policy.yaml
oc apply -f deploy/rhoai/manifests/openshift/base/openshell/control-plane-openshell-egress.yaml
helm upgrade --install openshell-gateway \
  "$OCC_INPUT_DIRECTORY/openshell-charts/helm-chart-0.1.6.tgz" \
  --namespace openshell-system \
  -f deploy/rhoai/manifests/openshift/openshell-gateway-values.yaml \
  --wait --timeout 7m

oc -n openshell-system rollout status statefulset/openshell-gateway --timeout=3m
oc -n openshell-system get pod openshell-gateway-0 \
  -o jsonpath='{.metadata.annotations.openshift\.io/scc}{"\n"}'
oc -n openshell-system get pvc
```

The controller egress policy is required: without it, the OCE chart's
default-deny egress blocks the API and worker from the gateway, and Namespace
provisioning never completes. Expect the SCC annotation `restricted-v2` and a
Bound claim.

The plaintext gateway is for an isolated single-tenant cluster. Its
NetworkPolicy matches namespace and pod labels, which are not an authentication
boundary. Use the `manifests/openshift/openshell-mtls` overlay and the
`scripts/openshell-mtls-post-render` post-renderer on any cluster with users
beyond the OCE control plane.

### 3. Resolve the OCE images

Deploy the published images. The resolver checks the controller's OCE commit is
on `origin/main` and that the runtime's OpenClaw pin matches that commit.

```bash
deploy/rhoai/scripts/resolve-images
source "$OCC_INPUT_DIRECTORY/images.env"
```

The resolver writes `images.env` and `published-images.json`. If the checkout
has moved past the image's OCE commit, confirm the chart and CLI are unchanged
before continuing:

```bash
export OCC_REV="$(jq -er .oceCommit "$OCC_INPUT_DIRECTORY/published-images.json")"
git -C "$OCE_CHECKOUT" diff --stat "$OCC_REV"..HEAD -- \
  deploy/helm apps/controller/src cmd/occ
```

A non-empty diff means the chart or CLI differs from the image build. Deploy
from a clean checkout at `OCC_REV`, and carry these deployment assets into that
checkout.

### 4. Install PostgreSQL and prepare inputs

Install the PostgreSQL Operator and cluster, then wait for the primary Pod and
its data claim:

```bash
oc apply -f deploy/rhoai/manifests/openshift/base/operators/postgres-operator.yaml
oc -n openclaw-postgres wait \
  --for=jsonpath='{.status.installedCSV}'=postgresoperator.v5.8.9 \
  subscription/crunchy-postgres-operator --timeout=5m
oc -n openclaw-postgres wait \
  --for=jsonpath='{.status.phase}'=Succeeded \
  csv/postgresoperator.v5.8.9 --timeout=5m
oc wait --for=condition=Established \
  crd/postgresclusters.postgres-operator.crunchydata.com --timeout=5m
oc apply -f deploy/rhoai/manifests/openshift/base/database/postgres-cluster.yaml
until oc -n openclaw-postgres get pod \
  -l postgres-operator.crunchydata.com/cluster=oce-postgres,postgres-operator.crunchydata.com/role=master \
  -o name | grep -q .; do sleep 3; done
oc -n openclaw-postgres wait --for=condition=Ready pod \
  -l postgres-operator.crunchydata.com/cluster=oce-postgres,postgres-operator.crunchydata.com/role=master \
  --timeout=8m
```

Run the bootstrap SQL once for a fresh database, then write the private
connection files with full TLS verification. Never put these passwords in Helm
values or the Installation YAML.

```bash
openssl rand -hex 24 > "$OCC_INPUT_DIRECTORY/occ-migrator-password"
openssl rand -hex 24 > "$OCC_INPUT_DIRECTORY/occ-application-password"
openssl rand -hex 32 > "$OCC_INPUT_DIRECTORY/occ-auth-secret"
export POSTGRES_POD="$(oc -n openclaw-postgres get pods \
  -l postgres-operator.crunchydata.com/cluster=oce-postgres,postgres-operator.crunchydata.com/role=master \
  -o jsonpath='{.items[0].metadata.name}')"
(
  printf "\\set migrator_password '%s'\n" "$(cat "$OCC_INPUT_DIRECTORY/occ-migrator-password")"
  printf "\\set application_password '%s'\n" "$(cat "$OCC_INPUT_DIRECTORY/occ-application-password")"
  cat deploy/rhoai/manifests/openshift/postgres-bootstrap.sql
) | oc -n openclaw-postgres exec -i "$POSTGRES_POD" -c database -- \
  psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -f -
oc -n openclaw-postgres get secret oce-postgres-cluster-cert \
  -o jsonpath='{.data.ca\.crt}' | base64 --decode > "$OCC_INPUT_DIRECTORY/occ-database-ca.pem"
python3 - "$OCC_INPUT_DIRECTORY" <<'PY'
from pathlib import Path
from urllib.parse import quote
import sys

root = Path(sys.argv[1])
for role, password_file, output_file in (
    ('occ_migrator', 'occ-migrator-password', 'occ-migration-url'),
    ('occ_app', 'occ-application-password', 'occ-application-url'),
):
    password = quote((root / password_file).read_text().strip(), safe='')
    authority = role + ':' + password + '@oce-postgres-primary.openclaw-postgres.svc:5432'
    url = 'postgresql://' + authority + '/openclaw_enterprise?sslmode=verify-full&sslrootcert=/etc/openclaw/database-ca/ca.pem'
    (root / output_file).write_text(url)
PY
```

Prepare the OpenShift inputs and apply the control-plane egress policies:

```bash
source "$OCC_INPUT_DIRECTORY/images.env"
export OCC_ADMIN_EMAIL='occ-admin@example.test'
deploy/rhoai/scripts/prepare-inputs
oc apply -f "$OCC_INPUT_DIRECTORY/control-plane-postgres-egress.yaml"
oc apply -f "$OCC_INPUT_DIRECTORY/control-plane-kube-api-egress.yaml"
```

Review the generated `values.yaml` and `installation.yaml` before continuing.
They assume `gp3-csi`, the `oce-role` labels, and the default OpenShift DNS and
ingress selectors. Adjust them for another profile.

Prepare the bootstrap volume with a temporary SCC, then remove the temporary
grants:

```bash
oc -n openclaw-system apply -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
oc apply -f deploy/rhoai/manifests/openshift/bootstrap-prep-scc.yaml
"$OCE_CHECKOUT/scripts/prepare-bootstrap-volume" --kubeconfig "$KUBECONFIG" \
  --context "$(oc config current-context)" --namespace openclaw-system \
  --claim occ-bootstrap-admin-password --image "$CONTROLLER_IMAGE" \
  --node-selector oce-role=control
oc -n openclaw-system delete rolebinding oce-bootstrap-volume-prep
oc -n openclaw-system delete role oce-bootstrap-volume-prep
oc delete scc oce-bootstrap-volume-prep
```

Render the pinned workspace chart and merge its four resources, the provider
harness address, and the runtime class into the Installation:

```bash
export OPEN_SHELL_CHART="$OCC_INPUT_DIRECTORY/openshell-charts/openshell-workspace-0.1.6.tgz"
helm template openshell-workspace "$OPEN_SHELL_CHART" \
  --namespace openclaw-workspace-template \
  -f deploy/rhoai/manifests/openshift/openshell-workspace-values.yaml \
  > "$OCC_INPUT_DIRECTORY/openshell-workspace-rendered.yaml"
yq eval-all -o=json -I=0 '[.] | del(.[].metadata.namespace)' \
  "$OCC_INPUT_DIRECTORY/openshell-workspace-rendered.yaml" \
  > "$OCC_INPUT_DIRECTORY/openshell-workspace-resources.json"
export OPEN_SHELL_FRAGMENT=deploy/rhoai/manifests/openshift/openshell-installation-fragment.yaml
export OPEN_SHELL_WORKSPACE_RESOURCES="$OCC_INPUT_DIRECTORY/openshell-workspace-resources.json"
yq -i '. *= load(strenv(OPEN_SHELL_FRAGMENT))' "$OCC_INPUT_DIRECTORY/installation.yaml"
export OPENSHELL_SERVICE_IP="$(oc -n openshell-system get service openshell-gateway \
  -o jsonpath='{.spec.clusterIP}')"
yq -i '.drivers.compute.configuration.network.providerHarness.address = strenv(OPENSHELL_SERVICE_IP) |
  .drivers.sandbox.configuration.gateway.operatorWorkspaceResources = load(strenv(OPEN_SHELL_WORKSPACE_RESOURCES))' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
yq -e '.drivers.sandbox.configuration.gateway.operatorWorkspaceResources | length == 4' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
deploy/rhoai/scripts/validate-installation "$OCC_INPUT_DIRECTORY/installation.yaml"
oc apply -f deploy/rhoai/manifests/openshift/base/openshell/openshell-runtimeclass.yaml
oc apply -f deploy/rhoai/manifests/openshift/base/openshell/openshell-workspace-writer-clusterrole.yaml
```

The fragment lists the Sandbox executables that may carry tool sources:

```yaml
drivers:
  credential_gateway:
    configuration:
      toolBinaries:
        - /usr/local/bin/gh
        - /usr/libexec/git-core/git-remote-http
```

Without `toolBinaries`, OpenShell omits the `bearer-token` and OAuth2 tool-source
types from its catalog. Add a path only when the runtime image contains it.

Create the four system Secrets once, then install OCC:

```bash
oc -n openclaw-system create secret generic occ-installation-startup \
  --from-file=installation.yaml="$OCC_INPUT_DIRECTORY/installation.yaml"
oc -n openclaw-system create secret generic occ-database \
  --from-file=application-url="$OCC_INPUT_DIRECTORY/occ-application-url" \
  --from-file=migration-url="$OCC_INPUT_DIRECTORY/occ-migration-url"
oc -n openclaw-system create secret generic occ-database-ca \
  --from-file=ca.pem="$OCC_INPUT_DIRECTORY/occ-database-ca.pem"
oc -n openclaw-system create secret generic occ-auth \
  --from-file=secret="$OCC_INPUT_DIRECTORY/occ-auth-secret"

yq -i '.worker.maxAttempts = 30 | .worker.leaseDurationMs = 30000' \
  "$OCC_INPUT_DIRECTORY/values.yaml"
helm template oce "$OCE_CHECKOUT/deploy/helm/openclaw-enterprise" \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  > "$OCC_INPUT_DIRECTORY/oce-rendered.yaml"
oc apply --dry-run=server -f "$OCC_INPUT_DIRECTORY/oce-rendered.yaml"
helm upgrade --install oce "$OCE_CHECKOUT/deploy/helm/openclaw-enterprise" \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  --wait --timeout 7m
```

Do not scope the dry run with `-n openclaw-system`: the chart renders its own
`oce-installation-secrets-*` Namespace, and a fixed namespace makes `oc apply`
reject those objects.

After the API Service and Pod are ready, apply the Console Route and verify it:

```bash
oc apply -f "$OCC_INPUT_DIRECTORY/console-route.yaml"
curl --fail --silent --show-error "https://$OCC_CONSOLE_HOST/healthz" >/dev/null
curl --fail --silent --show-error "https://$OCC_CONSOLE_HOST/console/login" >/dev/null
```

### 5. Grant tenant access

Bootstrap queues Namespace provisioning immediately. Find the assigned
Namespace and apply the exact worker and API grants without waiting, because a
Namespace that has not converged within 15 minutes is marked `failed`.

```bash
export OCC_NAMESPACE="$(oc get namespaces -l openclaw.dev/namespace -o json |
  jq -er '.items | if length == 1 then .[0].metadata.labels["openclaw.dev/namespace"]
    else error("Select the intended Namespace explicitly") end')"
deploy/rhoai/scripts/grant-tenant-access
```

### 6. Retrieve bootstrap credentials and build the CLI

```bash
install -m 600 deploy/rhoai/manifests/openshift/bootstrap-read-pod.yaml \
  "$OCC_INPUT_DIRECTORY/bootstrap-read-pod.yaml"
yq -i '.spec.containers[0].image = strenv(CONTROLLER_IMAGE)' \
  "$OCC_INPUT_DIRECTORY/bootstrap-read-pod.yaml"
oc apply -f "$OCC_INPUT_DIRECTORY/bootstrap-read-pod.yaml"
oc -n openclaw-system wait --for=condition=Ready pod/occ-bootstrap-read --timeout=90s
oc -n openclaw-system exec pod/occ-bootstrap-read -- \
  cat /bootstrap/initial-admin-service-key.json > "$OCC_INPUT_DIRECTORY/initial-admin-service-key.json"
oc -n openclaw-system exec pod/occ-bootstrap-read -- \
  cat /bootstrap/initial-admin-password > "$OCC_INPUT_DIRECTORY/initial-admin-password"
chmod 600 "$OCC_INPUT_DIRECTORY/initial-admin-service-key.json" \
  "$OCC_INPUT_DIRECTORY/initial-admin-password"
oc -n openclaw-system delete pod occ-bootstrap-read --wait=true

export OCC_URL="https://$OCC_CONSOLE_HOST"
export OCC_SERVICE_KEY_FILE="$OCC_INPUT_DIRECTORY/initial-admin-service-key.json"
deploy/rhoai/scripts/build-occ
deploy/rhoai/bin/occ installation get
deploy/rhoai/bin/occ namespace list
```

The default Namespace must report `ready`. Sign in to
`https://$OCC_CONSOLE_HOST/console/login` with `OCC_ADMIN_EMAIL` and the saved
bootstrap password.

### 7. Deploy the first Agent and the Control UI

Enable private Envoy routing before creating an Agent. Follow
[Enable private Agent routing](manifests/openshift/README.md#enable-private-agent-routing).

Deploy one dedicated Codex Agent as described in
[manifests/agents/README.md](manifests/agents/README.md). It selects the tenant,
attaches it to the private Gateway, registers the model credential, creates the
Configuration and Agent, grants the exact credential source and Gateway SCC, and
verifies the deployment.

After the Agent reports `succeeded`, add its authenticated Control UI Route:
[Control UI Route](manifests/openshift/README.md#control-ui-route). Apply the
OAuth proxy, grant access to the intended OpenShift user, add the Route origin
to the Configuration, redeploy the Agent, and complete a real model turn.

## Optional: OpenShell dashboard and Keycloak

The dashboard adds a separate Keycloak login for inspecting the OpenShell
gateway. OCC and Agent sign-in stay unchanged. Follow
[manifests/dashboard/README.md](manifests/dashboard/README.md) after OCC,
OpenShell, and PostgreSQL are working.

## Optional: team-claw Keycloak login

Run one Codex Agent with individual human profiles and a shared workspace. The
helpers create local Keycloak accounts, an exact OIDC client, a membership
group, and an OAuth2 Proxy Deployment in the Agent's gateway Namespace. They
require an OCE release with explicit human Gateway identities; verify the
release before you start.

Set the Agent identifiers and private paths:

```bash
export OCC_NAMESPACE='<OCC Namespace ID>'
export AGENT_ID='<Agent ID>'
export CONFIGURATION_ID='<Configuration ID>'
export GATEWAY_NAMESPACE='<tenant Kubernetes namespace>'
export GATEWAY_SERVICE='<gateway Service name>'
export KEYCLOAK_URL='https://<keycloak-host>'
export KEYCLOAK_REALM='team-claw'
# REQUIRED for an existing realm; use values that do not exist there yet.
export KEYCLOAK_CLIENT_ID='team-claw-browser'
export KEYCLOAK_GROUP_NAME='team-claw-members'
export TEAM_CLAW_HOST='<new login hostname>'
export TEAM_LOGIN_DIRECTORY="$HOME/.local/state/openclaw-enterprise/team-login"
install -d -m 700 "$TEAM_LOGIN_DIRECTORY"
printf '%s\n' '["alice", "bob"]' > "$TEAM_LOGIN_DIRECTORY/users.json"
printf '%s\n' '["alice"]' > "$TEAM_LOGIN_DIRECTORY/administrators.json"
export TEAM_USERS_FILE="$TEAM_LOGIN_DIRECTORY/users.json"
export TEAM_ADMIN_USERS_FILE="$TEAM_LOGIN_DIRECTORY/administrators.json"
```

Create a new realm with `deploy/rhoai/scripts/create-team-login-realm`. To reuse
an existing application realm, run `deploy/rhoai/scripts/prepare-team-login-users`,
then point `TEAM_USERS_FILE` at the generated `normalized-users.json` and use those
normalized names in `TEAM_ADMIN_USERS_FILE`, then run
`deploy/rhoai/scripts/add-agent-keycloak-client`. This order normalizes usernames
before the client validates administrator membership. Each new account gets its
own temporary password in `initial-passwords.json`; distribute each value to its
owner and delete the file afterwards.

Then prepare and deploy the proxy:

```bash
deploy/rhoai/bin/occ configuration get "$CONFIGURATION_ID" -o json \
  > "$TEAM_LOGIN_DIRECTORY/current-configuration.json"
export CONFIGURATION_FILE="$TEAM_LOGIN_DIRECTORY/current-configuration.json"
deploy/rhoai/scripts/prepare-team-login
deploy/rhoai/scripts/configure-team-login-scopes
oc apply --dry-run=server -f "$TEAM_LOGIN_DIRECTORY/proxy-manifests-private.json"
oc apply -f "$TEAM_LOGIN_DIRECTORY/proxy-manifests-private.json"
```

Deploy the updated Configuration without `gateway.roles`, require deployment
status `succeeded`, then verify two different human logins. Remove the Agent's
previous shared-admin OAuth proxy only after the new proxy works; it bypasses
the per-person identity grants.

## Other profiles

- **OCC admin launcher**: keep `agentNativeAdmin` disabled during bootstrap.
  After private routing is ready, enable it in the private values and
  Installation and apply `manifests/native-admin/` for the HTTPS admin
  endpoint.
- **OpenShell mTLS**: follow
  [openshell-mtls](manifests/openshift/openshell-mtls/README.md) to require
  client certificates, mount OCE's certificate, and keep the post-renderer on
  later gateway upgrades.
- **Slack**: `scripts/prepare-slack` writes the API and gateway proxy inputs.
  Redeploy affected Agents after applying the changed Helm and Installation
  values.
- **Widgets**: `scripts/prepare-widget-preview` prepares the preview inputs;
  apply `manifests/widgets/` for the public Route and its certificate. The Route
  reaches the Envoy sandbox listener, so Compute's method and header filters
  apply.

## Upgrade

Use the selected OCE release's upgrade workflow; do not reapply bootstrap.

```bash
deploy/rhoai/scripts/upgrade --help
```

The wrapper delegates to `$OCE_CHECKOUT/scripts/upgrade-production-images`.
Follow [upgrading OCE on Kubernetes](../../docs/guides/deploy/production-upgrade.md)
and keep the saved `images.env`, Installation Secret, database Secrets, and
signing key across releases. When you use the dashboard or mTLS profile, pass
their values and post-renderer to every gateway upgrade.

**Known issue:** With Helm 4, `scripts/upgrade-production-images` can refuse with `the Helm release changed before submission` after it
stops the API and worker, because Helm 4's `helm status` includes live resources. Affected versions can leave the
Installation Secret switched with the old controller, so the console stays down until restoration. Use a Helm 3 binary first on
`PATH` until openclaw/openclaw-enterprise#6593 lands and is synced here. To recover, first confirm with `helm history` that the release revision is unchanged (no other upgrade ran); then restore the Installation Secret from the run's
evidence directory, then scale the API and worker back up.

## Verification

```bash
python3 -m unittest discover -s deploy/rhoai/tests -v
oc kustomize deploy/rhoai/manifests/openshift/base
oc kustomize deploy/rhoai/manifests/openshift/overlays/test
oc kustomize deploy/rhoai/manifests/openshift/openshell-git
oc kustomize deploy/rhoai/manifests/openshift/openshell-mtls
oc kustomize deploy/rhoai/manifests/widgets
```

The advisory `Check RHOAI deployment assets` workflow runs the script tests,
shell-check, manifest parsing, and Kustomize renders when this directory
changes.

## Limits

- Example hostnames, IP addresses, and `${VARIABLE}` placeholders need private
  deployment overrides. Keep credentials, kubeconfigs, and rendered overlays
  outside this repository.
- The PostgreSQL example runs one instance without backups or replicas. The
  dashboard's Keycloak database inherits those limits.
- The bootstrap SCC and its RoleBinding are temporary. Delete both after
  preparing the bootstrap PVC.
- The plaintext OpenShell gateway is single-tenant. Labels are not an
  authentication boundary; use the mTLS profile otherwise.
- The storage class, node labels, DNS selectors, and router selectors assume
  the profile described above. Adjust the private inputs for another cluster.
- `prepare-inputs` records the router Pod addresses and the PostgreSQL primary
  address as snapshots. Run it once during bootstrap. After a node change,
  router restart, or database failover, run `prepare-inputs refresh` to update
  the discovered addresses and egress inputs without resetting routing,
  approved API clients, the trusted-proxy preset, or admin-launcher settings.
  Then apply the updated values, egress inputs, and Installation Secret.
- The widget preview certificate is a wildcard for the whole apps domain, so
  the private CA can vouch for every host under it. Trust that CA only on the
  clients that use previews.
- The cert-manager and PostgreSQL operator subscriptions approve channel
  upgrades automatically; approve and pin them as the Keycloak operator does if
  unattended operator changes are not acceptable.
