# Run a dedicated OpenShell Agent on EKS

Install OpenClaw Enterprise (OCE) with OpenShell, connect a Codex service account to its managed Linear plugin, and give one Agent access to one GitHub repository through the Credential Proxy. Start on the owner’s laptop in a checkout containing this guide and its assets. Select images, chart and installation schema from compatible recorded source revisions. Keep the records from each step in an owner-only directory.

## 1. Prepare the cluster and images

Follow [Kubernetes setup](../kubernetes-setup.md) and [EKS infrastructure preparation](eks.md#prepare-aws-infrastructure). Select an IPv4 cluster, two private EC2 node groups labeled `oce-role=control` and `oce-role=agents`, strict VPC CNI NetworkPolicy enforcement, encrypted gp3 RWO storage with `WaitForFirstConsumer`, and private PostgreSQL with separate application and migration roles and verified TLS. The validated configuration used EKS 1.36, AL2023, kernel 6.18, VPC CNI 1.22.4, EBS CSI 1.67.2 and PostgreSQL 18.6. Check versions and NAT capacity in your chosen region.

Install cert-manager, Gateway API, Envoy Gateway and the matching Agent Sandbox controller. Under strict CNI, prepare component policies before rollout. Include DNS and API Service VIPs alongside the intended Pod peers and API EndpointSlice addresses. Verify EBS CSI reaches its regional EC2 and STS endpoints. For RDS, authorize the security group of the actual source interface. Verify both database roles with `sslmode=verify-full`. [EKS network and storage](eks.md#configure-network-enforcement-and-storage)

```bash
set -euo pipefail
set +x
umask 077
run_root=${XDG_STATE_HOME:-$HOME/.local/state}/oce
install -d -m 700 "$run_root"
RUN_DIR=$(mktemp -d "$run_root/eks.XXXXXXXX")
printf 'Keep this session directory: %s\n' "$RUN_DIR"
export KUBECONFIG="$RUN_DIR/kubeconfig"
export PLATFORM_NS=oce-system
export CONTEXT="oce-${EKS_CLUSTER:?Set the target cluster name}"
[[ $EKS_CLUSTER =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || { echo "Use a lowercase DNS-label cluster name" >&2; exit 1; }
aws sts get-caller-identity --query '[Account,Arn]'
aws eks update-kubeconfig --name "$EKS_CLUSTER" --region "${AWS_REGION:?}" \
  --alias "$CONTEXT" --kubeconfig "$KUBECONFIG"
kubectl get nodes -L oce-role
kubectl get storageclass encrypted-gp3
```

Confirm the account and role, then test Kubernetes TLS from the operator host. Successive connections through shared NAT can use different public IP addresses. For a public API allowlist change, authorize only the exact stable egress addresses or CIDRs listed for that host in the authoritative NAT inventory. A single observed IP address cannot establish or justify a broader prefix. Preserve existing allowlist entries, public and private endpoint settings, and AWS and Kubernetes authentication.

[Build the controller and runtime](production-installation.md#build-and-publish-production-images) from one release or [copy verified images](private-registry-images.md) into a registry the nodes can pull from. Set `CONTROLLER_IMAGE` and `RUNTIME_IMAGE` to the resulting immutable references. The templates target AMD64 nodes, OpenShell 0.1.6 and Codex 0.164.0. Mirror the stock Gateway, supervisor and Sandbox runtime AMD64 manifests into the repository selected below, retaining their digests. Have the matching stock chart archive, the OCE chart and the qualified Envoy proxy image available. Create the system namespace before its policies and chart jobs. Use the source commit and image digests in the build or publication receipt. A documentation branch head alone does not identify the images. Use an OpenShell-compatible kernel, a restricted workload Namespace and a `runc` RuntimeClass named `openshell-sandbox` pinned to the Agent node group. Check Landlock, seccomp and no-new-privileges on that pool before enrolling credentials.

## 2. Install OpenShell and bootstrap OCC

These templates select the `oce` OCE release, the `openshell-gateway` OpenShell release, the `oce-system` namespace, the `eg` GatewayClass and the `envoy-gateway-system` namespace. They include the stock workspace resources, dedicated Codex settings and binary-scoped plugin artifact rules used for verification. [Manual Installation configuration](production-installation.md#advanced-copy-manual-yaml-examples)

```bash
assets=docs/assets/eks-openshell
jq -n --arg registry "${SANDBOX_REGISTRY:?}" \
  --arg repository "${SANDBOX_REPOSITORY:?}" -f "$assets/openshell-values.jq" \
  > "$RUN_DIR/openshell.json"
helm upgrade --install openshell-gateway "${OPENSHELL_CHART:?}" \
  -n "$PLATFORM_NS" -f "$RUN_DIR/openshell.json" --wait
os_ip=$(kubectl -n "$PLATFORM_NS" get svc openshell-gateway -o jsonpath='{.spec.clusterIP}')
route_host=occ-gateway-362888b35fce.envoy-gateway-system.svc.cluster.local

# Supply JSON arrays of approved CIDRs. Include the API Service and endpoint /32s.
jq -n --arg cluster "$EKS_CLUSTER" --arg runtime "${RUNTIME_IMAGE:?}" \
  --arg hostname "$route_host" --arg openshellIP "$os_ip" \
  --argjson proxyCidrs "${TRUSTED_PROXY_CIDRS:?}" -f "$assets/installation.jq" \
  > "$RUN_DIR/installation.json"
jq -n --arg cluster "$EKS_CLUSTER" --arg controller "${CONTROLLER_IMAGE:?}" --arg email "${ADMIN_EMAIL:?}" \
  --arg hostname "$route_host" --argjson databaseCidrs "${DATABASE_CIDRS:?}" \
  --argjson apiCidrs "${API_CIDRS:?}" -f "$assets/values.jq" > "$RUN_DIR/values.json"
```

Check the browser values **before** the first Helm install. These origins, including port 18443, are distinct from the private Envoy hostname.

```bash
jq -e --arg d "$EKS_CLUSTER.oce.localhost" '
  .auth.baseUrl==("https://console."+$d+":18443") and .agentNativeAdmin.enabled
  and .agentNativeAdmin.domain==("agents."+$d) and .agentNativeAdmin.sharedCookieDomain==$d' "$RUN_DIR/values.json"
```

Use the cluster’s full DNS suffix in the route hostname and serving certificate. A short `.svc` hostname resolved in an ordinary Pod but produced `policy_dns_upstream_nxdomain` in the stock supervisor. Keep operator mTLS enabled and retain the existing OpenShell PKI and JWT signing material through upgrades.

Use a fresh application database on private RDS. Provision separate login roles `occ_migrator` and `occ_app` using deployment-managed passwords. Neither role needs superuser, role creation, database creation, replication or row-security bypass. As the database administrator, prepare the following in the **application database**. The migrator needs database CREATE for its migration schema; the application connects with the permissions assigned by the migrations.

```sql
-- Run in psql connected to the fresh database as an administrator allowed to assign these owners.
SELECT current_database() AS database_name \gset
GRANT CONNECT ON DATABASE :"database_name" TO occ_migrator, occ_app;
GRANT CREATE ON DATABASE :"database_name" TO occ_migrator;
CREATE SCHEMA occ AUTHORIZATION occ_migrator;
CREATE SCHEMA drizzle AUTHORIZATION occ_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Configure `occ-database` with separate protected `migration-url` and `application-url` files for that same RDS endpoint and database. Both URLs use `sslmode=verify-full&sslrootcert=/etc/openclaw/database-ca/ca.pem`. Mount the RDS CA as `occ-rds-ca` with key `ca.pem`. Migrations use the migrator; bootstrap, API and worker use the application login. Before Helm installation, connect as each login from the approved RDS network and check the database, role and TLS result. With two protected libpq service entries that use the laptop or verifier host’s CA path:

```bash
for role in occ_migrator occ_app; do
  psql "service=$role" -XAt -v ON_ERROR_STOP=1 \
    -c 'SELECT current_database(),current_user,ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'
done
```

Expect the target database, the named login and `t` for both connections. Keep the administrator connection outside the controller.

Provision the other Secret references in the rendered values. Use distinct OCE authentication and private routing keys, protected RDS connection files and CA, and the OpenShell client TLS Secret. The private routing Secret uses the key `occ`. Create and prepare the bootstrap PVC once with the chart’s expected UID/GID 1000 and directory mode 0700. The stock native runtime uses UID/GID 10001. [System Secrets and bootstrap volume](production-installation.md#provision-system-secrets-and-install)

```bash
kubectl -n "$PLATFORM_NS" create secret generic occ-installation-startup \
  --from-file="installation.yaml=$RUN_DIR/installation.json"
helm install oce "${OCE_CHART:?}" -n "$PLATFORM_NS" -f "$RUN_DIR/values.json" --wait --timeout 5m
kubectl -n "$PLATFORM_NS" rollout status deploy/openclaw-enterprise-api
# Pin the Envoy data plane through its supported resource field.
kubectl -n "$PLATFORM_NS" patch envoyproxy oce-agent-gateways --type=merge \
  -p "$(jq -nc --arg image "${ENVOY_IMAGE:?}" '{spec:{provider:{type:"Kubernetes",kubernetes:{envoyDeployment:{container:{image:$image}}}}}}')"
```

The worker starts at zero. Helm runs the installation check, migration and bootstrap hooks. [Read the owner password and service key from the protected claim](eks-openshell-browser.md#read-the-protected-initial-owner-files), then [install the private TLS listener and start the laptop forward](eks-openshell-browser.md#install-the-loopback-tls-listener). Keep the same session directory and kubeconfig.

## 3. Authenticate and prepare the Namespace

Use the installation’s private API endpoint. If direct port forwarding returns a connection refusal on Pod loopback while the API readiness probe passes, the following Bash helper calls the same authenticated REST routes at the API Pod IP. Kubernetes carries the request over its TLS exec stream. The helper takes bodyless calls, `--data '{}'`, or `--data-binary @-` for JSON from stdin.

```bash
request() {
  local method=$1 path=$2 pod ip
  shift 2
  if (( $# == 0 )); then printf 'null' > "$RUN_DIR/body.json"
  elif [[ $1 == --data-binary && $2 == @- ]]; then cat > "$RUN_DIR/body.json"
  elif [[ $1 == --data && $2 == '{}' ]]; then printf '{}' > "$RUN_DIR/body.json"
  else return 2
  fi
  read -r pod ip < <(kubectl -n "$PLATFORM_NS" get pods \
    -l 'app.kubernetes.io/instance=oce,app.kubernetes.io/component=api' -o json |
    jq -er '[.items[]|select(.metadata.deletionTimestamp==null and any(.status.containerStatuses[]?;.ready))]|first|[.metadata.name,.status.podIP]|@tsv')
  jq -nc --arg m "$method" --arg p "$path" --arg ip "$ip" \
    --slurpfile k "$OCC_SERVICE_KEY_FILE" --slurpfile b "$RUN_DIR/body.json" \
    '{method:$m,path:$p,ip:$ip,key:$k[0].data.key} + (if $b[0]==null then {} else {body:$b[0]} end)' |
    kubectl -n "$PLATFORM_NS" exec -i "$pod" -c api -- \
      node --input-type=module -e "$(cat "$assets/request.mjs")"
}
namespace=$(request GET /namespaces | jq -er '.data[]|select(.name=="default")|.id')
base="/namespaces/$namespace"
jq '.worker.replicaCount=1' "$RUN_DIR/values.json" > "$RUN_DIR/worker.json"
helm upgrade oce "$OCE_CHART" -n "$PLATFORM_NS" -f "$RUN_DIR/worker.json" --wait
```

Wait for Compute to create the backing Namespace. Discover it with `kubectl get ns -l "openclaw.dev/namespace=$namespace"` and set `TENANT_NAMESPACE` to its name. Verify restricted Pod Security. Grant the worker Role/RoleBinding CRUD there and restrict Role `bind` and `escalate` to `openshell-workspace-sandbox`. Bind the API’s Secret and Configuration ClusterRoles next, then bind the ordinary tenant-worker ClusterRole last. Require `request GET "$base"` to report `ready`. [Tenant binding commands](production-agents.md#prepare-each-namespace)

```bash
TENANT_NAMESPACE=$(kubectl get ns -l "openclaw.dev/namespace=$namespace" -o json |
  jq -er '.items|select(length==1)|first.metadata.name')
worker_sa="$PLATFORM_NS:openclaw-enterprise-worker"
api_sa="$PLATFORM_NS:openclaw-enterprise-api"
kubectl -n "$TENANT_NAMESPACE" create role oce-workspace-provisioner \
  --verb=get,list,watch,create,update,patch,delete --resource=roles,rolebindings \
  --dry-run=client -o json |
  jq '.rules += [{apiGroups:["rbac.authorization.k8s.io"],resources:["roles"],
    resourceNames:["openshell-workspace-sandbox"],verbs:["bind","escalate"]}]' | kubectl create -f -
kubectl -n "$TENANT_NAMESPACE" create rolebinding oce-workspace-provisioner \
  --role=oce-workspace-provisioner --serviceaccount="$worker_sa"
kubectl -n "$TENANT_NAMESPACE" create rolebinding oce-api-secrets \
  --clusterrole=oce-openclaw-tenant-api --serviceaccount="$api_sa"
kubectl -n "$TENANT_NAMESPACE" create rolebinding oce-api-configuration \
  --clusterrole=oce-openclaw-tenant-configuration --serviceaccount="$api_sa"
kubectl -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-worker \
  --clusterrole=oce-openclaw-tenant-worker --serviceaccount="$worker_sa"
```

## 4. Enroll Linear and protected Git

Keep the EKS `request` function, `base` and `RUN_DIR` from step 3. Use the model Secret and CredentialSource registration commands in [local OpenShell setup](local-openshell-setup.md#4-connect-to-the-api-and-register-the-model-credential). Supply a private PAT file for a service account with an authorized Linear connection. Verify the source is `ready`, type `codex-pat`, and owned by `credential_gateway` before enabling the repository Credential Proxy.

Enroll one repository and Namespace under `github-repository`. Prepare [two immutable registry ConfigMaps](../repository-credentials/openshell-git-push.md#1-enroll-one-repository-in-the-installation) for this same repository ID and Namespace. Mount the Contents read/Metadata read map first. Reserve Contents write/Metadata read for the single push. Set `READ_REGISTRY` and `WRITE_REGISTRY` to the two ConfigMap names. Mount the App signing key and a dedicated persistent 32-byte custody key only in the worker. Add the GitHub Backend owner, its `repo` Driver, `repository.preparedGitHub` and `repository.openShell` to the Installation. Select the Sandbox Driver ID in **both** `drivers.credential_proxy` and the OpenShell Backend’s `drivers.credential_proxy`. A missing owner fails the chart’s installation check. [Registry, Installation and deployment inputs](../repository-credentials/openshell-enrollment.md)

Issue a serving certificate for `openclaw-enterprise-openshell-git.oce-system.svc`. Supply the worker with the Gateway’s public JWT key and key ID. Upgrade OCE first with the versioned Installation Secret, protected listener on 8445 and reviewed GitHub API egress ranges. Check that the Service has a ready worker endpoint. Verify the Envoy image pin after Helm upgrades. Review and apply the service peers before enabling the hook:

```bash
python3 "$assets/service-policies.py" --tenant "$TENANT_NAMESPACE" --namespace-id "$namespace" \
  > "$RUN_DIR/protected-service-peers.json"
kubectl apply -f "$RUN_DIR/protected-service-peers.json"
```

Mount the listener’s public CA on the stock OpenShell Gateway. Register the mandatory `oce-prepared-git` middleware using TLS verification, the audience, allowlist and `http_request_pre_credentials` binding. Retain the Gateway’s existing PKI. Run the documented worker installation GET and require a verified TLS connection, HTTP 200, and matching App and installation IDs before deployment. [Register the protected request-phase service](../../reference/repository-credentials/protected-openshell-git.md#register-the-request-phase-service)

## 5. Deploy and open the owner’s Agent

Create a dedicated Gateway-managed Agent using the [Codex configuration](local-openshell-setup.md#5-create-the-configuration-and-agent) and [exact model-source grant](local-openshell-setup.md#6-grant-model-access-and-deploy). Native process and file tools have full access inside OpenShell with approval set to `on-request` and reviewer `user`. Provision transport once. Discover the managed Linear plugin and add it and the approved repository binding to the same draft. [Linear selection](../integrations/codex-plugins.md) · [Git binding](../repository-credentials/openshell-git-push.md#2-bind-the-agent-and-deploy-once)

Bind the exact Agent hostname before deployment. Use the shared host derivation and configuration patch from the [browser onboarding guide](local-openshell-browser.md#bind-the-origin-before-deployment) with the following EKS inputs. Run only that guide’s origin and Configuration commands. Keep the EKS REST helper and use its exact `GET /installation`.

```bash
api=''   # EKS request takes a path relative to the API root.
state="$RUN_DIR/browser-state"
mkdir -m 700 "$state"
jq '{browserOrigin:.auth.baseUrl,nativeAdminDomain:.agentNativeAdmin.domain}' \
  "$RUN_DIR/values.json" > "$state/state.json"
```

The patch checks `expectedGeneration`, preserves the Gateway password SecretRef, and enables the native UI for this Agent’s exact origin. The device policy grants `operator.read` and `operator.write`. OCC supplies the authorized `occ-workspace-files` identity. Keep `skipBootstrap` unset in a new workspace.

```bash
deploy_owner_revision() {
  local revision result phase i
  revision=$(request POST "$base/agents/$agent/deploy" | jq -er .data.id) || return 1
  printf '%s\n' "$revision" > "$RUN_DIR/requested-revision"
  # The Agent Service can be recreated with a new VIP. Re-read its selectors and ports.
  for ((i=0;i<120;i++)); do
    if python3 "$assets/service-policies.py" --tenant "$TENANT_NAMESPACE" \
      --namespace-id "$namespace" --agent-id "$agent" > "$RUN_DIR/agent-service-peers.json"; then
      kubectl apply -f "$RUN_DIR/agent-service-peers.json" || return 1
      break
    fi
    sleep 3
  done
  (( i < 120 )) || return 1
  for ((i=0;i<120;i++)); do
    result=$(request GET "$base/agents/$agent/deployments/$revision") || return 1
    phase=$(jq -er .data.status <<<"$result") || return 1
    case "$phase" in
      failed|cancelled) return 1 ;;
      succeeded) if [[ $(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId) == "$revision" ]]; then return 0; fi ;;
    esac
    sleep 5
  done
  return 1
}
deploy_owner_revision
```

If a call times out, inspect the saved revision and current state before repeating a mutation. Validate the actual Gateway and native Pod images and the Sandbox’s runtime identity. Use the [owner’s browser verification and return to read-only Git](eks-openshell-owner-session.md) to finish. Keep the Agent running and retain its volumes for the next owner session.
