---
published: false
---

## 2. Install OpenShell and bootstrap OCC

The templates use release `oce`, OpenShell release `openshell-gateway`, namespace `oce-system`, GatewayClass `eg`, and Envoy namespace `envoy-gateway-system`. Keep these names; they match the staged policies.

Exclude other install, upgrade and Job writers. Use a local chart and the matching CLI. Keep the new
`$RUN_DIR/install-receipt` directory for [read-only handoff](production-handoff.md#resume-an-installation-in-progress).
After an interrupted install, reconcile that receipt before any further writes.

For CoreDNS, read the Kubernetes DNS zone below. For other DNS servers, get `CLUSTER_DOMAIN` from your cluster administrator. Confirm this DNS suffix before continuing.

```bash
CLUSTER_DOMAIN=$(kubectl -n kube-system get configmap coredns -o json |
  jq -er '.data.Corefile | capture("(?m)^\\s*kubernetes\\s+(?<domain>[^\\s{]+)").domain')
export CLUSTER_DOMAIN
printf 'Cluster DNS domain: %s\n' "$CLUSTER_DOMAIN"
```

```bash
assets="$RUN_DIR/kubernetes"
jq -n --arg registry "${SANDBOX_REGISTRY:?}" \
  --arg storageClass "${STORAGE_CLASS:?}" \
  --arg clusterDomain "${CLUSTER_DOMAIN:?}" \
  --arg repository "${SANDBOX_REPOSITORY:?}" -f "$assets/openshell-values.jq" \
  > "$RUN_DIR/openshell.json"
helm upgrade --install openshell-gateway "${OPENSHELL_CHART:?}" \
  -n "$PLATFORM_NS" -f "$RUN_DIR/openshell.json" --wait
os_ip=$(kubectl -n "$PLATFORM_NS" get svc openshell-gateway -o jsonpath='{.spec.clusterIP}')
route_host="occ-gateway-362888b35fce.envoy-gateway-system.svc.${CLUSTER_DOMAIN:?}"

# Bootstrap has no Agents. Replace the loopback placeholder with the exact Envoy peers before deployment.
# API_CIDRS includes the API Service and endpoint /32s.
jq -n --arg cluster "$CLUSTER_NAME" --arg runtime "${RUNTIME_IMAGE:?}" --arg storageClass "${STORAGE_CLASS:?}" \
  --arg hostname "$route_host" --arg openshellIP "$os_ip" \
  --argjson proxyCidrs '["127.0.0.1/32"]' -f "$assets/installation.jq" \
  > "$RUN_DIR/installation.json"
jq -n --arg cluster "$CLUSTER_NAME" --arg controller "${CONTROLLER_IMAGE:?}" --arg email "${ADMIN_EMAIL:?}" \
  --arg hostname "$route_host" --argjson databaseCidrs "${DATABASE_CIDRS:?}" \
  --argjson apiCidrs "${API_CIDRS:?}" -f "$assets/values.jq" > "$RUN_DIR/values.json"
```

<a id="set-the-production-browser-origins-before-installing-occ"></a>

Check the browser values **before** the first Helm install. Keep port 18443 in the Console origin and laptop forward. These browser origins are distinct from the private Envoy hostname. For an existing HTTPS ingress, use the [native-admin ingress requirements](native-admin.md#production-requirements) for its Console and wildcard Agent hosts.

```bash
jq -e --arg d "$CLUSTER_NAME.oce.localhost" '
  .auth.baseUrl==("https://console."+$d+":18443") and .agentNativeAdmin.enabled
  and .agentNativeAdmin.domain==("agents."+$d) and .agentNativeAdmin.sharedCookieDomain==$d' "$RUN_DIR/values.json"
```

The templates use `CLUSTER_DOMAIN` for route and certificate names; the browser listener uses namespace-relative Service DNS. Preserve mTLS, OpenShell PKI and JWT signing material through upgrades.

Create `occ_migrator` and `occ_app` logins without superuser, role/database creation, replication or row-security bypass. As administrator, prepare the fresh **application database**:

```sql
-- Run in psql connected to the fresh database as an administrator allowed to assign these owners.
SELECT current_database() AS database_name \gset
GRANT CONNECT ON DATABASE :"database_name" TO occ_migrator, occ_app;
GRANT CREATE ON DATABASE :"database_name" TO occ_migrator;
CREATE SCHEMA occ AUTHORIZATION occ_migrator;
CREATE SCHEMA drizzle AUTHORIZATION occ_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Prepare protected `migration-url` and `application-url` files for the same database. Use `sslmode=verify-full&sslrootcert=/etc/openclaw/database-ca/ca.pem` in both URLs. Bootstrap, API and worker use the application login. Verify both roles from the approved network, using protected libpq service entries with the verifier host’s CA path:

```bash
for role in occ_migrator occ_app; do
  psql "service=$role" -XAt -v ON_ERROR_STOP=1 \
    -c 'SELECT current_database(),current_user,ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'
done
```

Expect the target database, login and `t` for each connection.

Set `OCC_SECRET_DIR` to a private directory outside the checkout. Put the two
database URL files and the approved PostgreSQL CA bundle (`database-ca.pem`) there.
Use one raw URL per file. For this fresh installation, generate separate random
32-byte secrets in hex for `auth-secret` (OCC sessions) and `routing-key`
(private routing). Store each value without a trailing newline. Keep the files
mode 0600 and retain the keys for redeployment.

Create the bootstrap claim and Secrets from the matching checkout with jq, yq v4,
and Node.js satisfying `engines.node` in the selected release checkout's `package.json`. The OpenShell chart’s PKI job supplies
`openshell-client-tls`. Check that it exists before creating the OCC inputs.

```bash
: "${OCC_SECRET_DIR:?Set OCC_SECRET_DIR to the protected input directory}"
for input in application-url migration-url database-ca.pem auth-secret routing-key; do
  path="$OCC_SECRET_DIR/$input"
  if [[ ! -f "$path" || ! -r "$path" || ! -s "$path" ]]; then
    printf 'Missing, unreadable or empty input: %s\n' "$input" >&2
    exit 1
  fi
done

platform_kube=(kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" -n "$PLATFORM_NS")
"${platform_kube[@]}" get secret openshell-client-tls -o name
bootstrap_claim=$(jq -er '.bootstrap.password.claimName' "$RUN_DIR/values.json")
bootstrap_image=$(jq -er '.images.controller' "$RUN_DIR/values.json")
BOOTSTRAP_CLAIM="$bootstrap_claim" yq e '
  .metadata.namespace = strenv(PLATFORM_NS) |
  .metadata.name = strenv(BOOTSTRAP_CLAIM) |
  .spec.storageClassName = strenv(STORAGE_CLASS)
' deploy/examples/production/bootstrap-pvc.yaml > "$RUN_DIR/bootstrap-pvc.yaml"
"${platform_kube[@]}" create -f "$RUN_DIR/bootstrap-pvc.yaml"
"${platform_kube[@]}" create secret generic occ-database \
  --from-file="application-url=$OCC_SECRET_DIR/application-url" \
  --from-file="migration-url=$OCC_SECRET_DIR/migration-url"
"${platform_kube[@]}" create secret generic occ-database-ca \
  --from-file="ca.pem=$OCC_SECRET_DIR/database-ca.pem"
"${platform_kube[@]}" create secret generic occ-auth \
  --from-file="secret=$OCC_SECRET_DIR/auth-secret"
"${platform_kube[@]}" create secret generic occ-private-gateway-key \
  --from-file="occ=$OCC_SECRET_DIR/routing-key"
```

Prepare the fresh claim on the `oce-role=control` pool, where the OCC
initialization Job runs. If cluster policy forbids the preparation Pod or you
cannot verify its network isolation, skip the helper. Have the storage
administrator set the root of the same fresh volume to UID/GID 1000 and mode 0700.

```bash
scripts/prepare-bootstrap-volume --kubeconfig "$KUBECONFIG" --context "$CONTEXT" \
  --namespace "$PLATFORM_NS" --claim "$bootstrap_claim" --image "$bootstrap_image" \
  --node-selector oce-role=control
```

Continue after the helper reports the claim prepared or the storage
administrator confirms the root is ready.

```bash
# Allow the initialization hook to reach the DNS Service VIP.
dns_ip=$(kubectl -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}')
jq -n --arg ns "$PLATFORM_NS" --arg ip "$dns_ip" '{
  apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicy",
  metadata:{namespace:$ns,name:"oce-initialization-dns-vip"},
  spec:{podSelector:{matchLabels:{"app.kubernetes.io/name":"openclaw-enterprise","app.kubernetes.io/instance":"oce","app.kubernetes.io/component":"initialization"}},
    policyTypes:["Egress"],egress:[{to:[{ipBlock:{cidr:($ip+"/32")}}],
      ports:[{protocol:"UDP",port:53},{protocol:"TCP",port:53}]}]}}' |
  kubectl --context "$CONTEXT" create -f -
kubectl -n "$PLATFORM_NS" create secret generic occ-installation-startup \
  --from-file="installation.yaml=$RUN_DIR/installation.json"
occ installation install --release oce --chart "${OCE_CHART:?}" \
  --kubeconfig "${KUBECONFIG:?}" --context "$CONTEXT" \
  --kube-namespace "$PLATFORM_NS" --values "$RUN_DIR/values.json" \
  --receipt "$RUN_DIR/install-receipt" --wait-timeout 5m
kubectl -n "$PLATFORM_NS" rollout status deploy/openclaw-enterprise-api
# Pin the Envoy data plane through its supported resource field.
kubectl -n "$PLATFORM_NS" patch envoyproxy oce-agent-gateways --type=merge \
  -p "$(jq -nc --arg image "${ENVOY_IMAGE:?}" '{spec:{provider:{type:"Kubernetes",kubernetes:{envoyDeployment:{container:{image:$image}}}}}}')"
kubectl -n "$PLATFORM_NS" wait gateway/oce-agent-gateways --for=condition=Programmed --timeout=5m
kubectl -n envoy-gateway-system wait --for=create service/occ-gateway-362888b35fce --timeout=3m
kubectl -n envoy-gateway-system get svc occ-gateway-362888b35fce -o json |
  jq -e '.spec.type=="ClusterIP" and (.spec.clusterIP|test("^[0-9]+(\\.[0-9]+){3}$")) and any(.spec.ports[];.port==443 and .protocol=="TCP") and
    .metadata.labels["gateway.envoyproxy.io/owning-gateway-name"]=="oce-agent-gateways" and
    .metadata.labels["gateway.envoyproxy.io/owning-gateway-namespace"]=="oce-system"'
```

Helm bootstraps OCC with zero workers. Keep the same session directory and kubeconfig.

<Snippet file="./cluster-browser-access.md" />

## 3. Authenticate and prepare the Namespace

Initialize the operator session. Its REST helper uses Kubernetes exec into the API Pod.

```bash
INSTALLATION_FILE="$RUN_DIR/installation.yaml"
install -m 600 "$RUN_DIR/installation.json" "$INSTALLATION_FILE"
VALUES_FILE="$RUN_DIR/values.json"
CONSOLE_ORIGIN=$(jq -er .auth.baseUrl "$VALUES_FILE")
NATIVE_ADMIN_DOMAIN=$(jq -er .agentNativeAdmin.domain "$VALUES_FILE")
source "$RUN_DIR/operator-session.sh"
source "$RUN_DIR/platform.sh"
namespace=$(request GET /namespaces | jq -er '[.data[]|select(.name=="default")]|select(length==1)|first.id')
base="/namespaces/$namespace"
export ENVOY_IMAGE
bash "$assets/trusted-envoy-peers.sh" "$RUN_DIR/kubeconfig" > "$RUN_DIR/trusted-peers.json"
jq --slurpfile peers "$RUN_DIR/trusted-peers.json" \
  '.drivers.compute.configuration.network.gatewayTrustedProxyCidrs=$peers[0]' \
  "$RUN_DIR/installation.json" > "$RUN_DIR/installation-with-peers.json"
jq '.worker.replicaCount=1' \
  "$RUN_DIR/values.json" > "$RUN_DIR/worker.json"
# The API registers model credentials and the worker manages workspaces through OpenShell.
kube -n "$PLATFORM_NS" get service openshell-gateway -o json |
  jq -e --arg ns "$PLATFORM_NS" --arg release "$RELEASE" '
    .spec as $svc | select($svc.type=="ClusterIP" and ($svc.selector|length)>0
      and ($svc.clusterIP|test("^[0-9]+(\\.[0-9]+){3}$"))) |
    [$svc.ports[] | select(.protocol=="TCP" and .port==8080)] | select(length==1) | first as $port |
    {apiVersion:"networking.k8s.io/v1", kind:"NetworkPolicy",
     metadata:{namespace:$ns,name:"oce-controller-openshell-management"},
     spec:{podSelector:{matchLabels:{"app.kubernetes.io/name":"openclaw-enterprise",
       "app.kubernetes.io/instance":$release},matchExpressions:[
       {key:"app.kubernetes.io/component",operator:"In",values:["api","worker"]}]},
       policyTypes:["Egress"],egress:[
         {to:[{ipBlock:{cidr:($svc.clusterIP+"/32")}}],ports:[{protocol:"TCP",port:8080}]},
         {to:[{podSelector:{matchLabels:$svc.selector}}],ports:[{protocol:"TCP",port:$port.targetPort}]}
       ]}}' > "$RUN_DIR/management-policy.json"
kube create -f "$RUN_DIR/management-policy.json"
cp "$RUN_DIR/installation-with-peers.json" "$INSTALLATION_FILE"
cp "$RUN_DIR/worker.json" "$VALUES_FILE"
save_session
upgrade_installation
```

Agent deployment pairs these egress rules with management ingress for the API, worker, selected tenant’s supervisors and Agent Gateway on TCP 8080. Keep both directions. Tenant callers must match the backing namespace name and its current `openclaw.dev/namespace` label. Supervisor grants apply per tenant and Gateway grants per Agent. To verify ownership-based withdrawal, inspect every grant for that namespace. For a live Agent in its verified namespace, stage the current platform helper and renderer and run `deployment_network` in its saved session to replace a name-only grant.

If namespace ownership has changed or the Agent’s Gateway Service is gone, withdraw the obsolete grant directly. Inspect its source namespace, Agent or supervisor Pod selector, and destination management selector with `kube -n "$PLATFORM_NS" get networkpolicy "$policy" -o yaml`. Match them to the recorded owner. Confirm a separate restrictive ingress policy still selects the management Pods so deleting the grant keeps them isolated. Then run `kube -n "$PLATFORM_NS" delete networkpolicy "$policy"` with the verified policy name. Preserve grants for other tenants and callers.

Wait for Compute to create the backing namespace, then apply these [tenant bindings](production-agents.md#prepare-each-namespace). Verify restricted Pod Security; grant the ordinary worker role last.

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

Wait for `request GET "$base"` to report `status: ready` before registering credentials. Keep the initial credential owner selection: OpenShell Sandbox and Credential Gateway, with no repository Credential Proxy yet.
