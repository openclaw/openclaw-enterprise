---
published: false
---

## 2. Install OpenShell and bootstrap OCC

Staged policies require release `oce`, OpenShell release `openshell-gateway`, namespace `oce-system`, GatewayClass `eg`, and Envoy namespace `envoy-gateway-system`.

Exclude concurrent install, upgrade, and Job writers. Use a local chart with its matching CLI.
Retain `$RUN_DIR/install-receipt` for [read-only handoff](production-handoff.md#resume-an-installation-in-progress);
after interruption, reconcile it before writing again.

Set and confirm `CLUSTER_DOMAIN` from CoreDNS below or your administrator.

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
```

On default-deny clusters, apply OpenShell NetworkPolicies in `$PLATFORM_NS`
before Helm. Render the chart with `$RUN_DIR/openshell.json` to check Pod labels
and ports. For stock OpenShell v0.1.9, both Pod templates have
`app.kubernetes.io/instance=openshell-gateway`. The certificate Job has
`app.kubernetes.io/name=openshell-certgen` and
`app.kubernetes.io/component=certgen`. The Gateway has
`app.kubernetes.io/name=openshell`.

Allow the certificate Job and Gateway to reach the API destinations in
`API_CIDRS` on their API ports (TCP 443 on EKS). Allow DNS to the cluster DNS
Service IP and its Pods on TCP and UDP 53. Allow the OCC API and worker Pods
to reach the Gateway on TCP 8080. The certificate Job is a Helm pre-install hook. Policies selecting only Gateway Pods block it.

```bash
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

Templates disable channels. For Slack, [enable managed channel egress and verify
its dependencies](channel-egress.md#enable-channels-in-the-kubernetes-and-eks-quickstarts)
in the generated files **before** continuing.

<a id="set-the-production-browser-origins-before-installing-occ"></a>

**Before** the first Helm install, check browser values. Keep port 18443 in the Console origin and laptop forward; use separate browser and private Envoy hostnames. Existing HTTPS ingress must meet [Console and wildcard Agent requirements](native-admin.md#production-requirements).

```bash
jq -e --arg d "$CLUSTER_NAME.oce.localhost" '
  .auth.baseUrl==("https://console."+$d+":18443") and .agentNativeAdmin.enabled
  and .agentNativeAdmin.domain==("agents."+$d)' "$RUN_DIR/values.json"
```

Templates use `CLUSTER_DOMAIN` for route and certificate names. The browser listener uses namespace-relative Service DNS. Preserve mTLS, OpenShell PKI and JWT signing material through upgrades.

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

Each connection must return the target database, login and `t`.

Set `OCC_SECRET_DIR` to a private directory outside the checkout. Put both database
URL files (one raw URL each) and the approved PostgreSQL CA bundle
(`database-ca.pem`) there. For this fresh install, generate separate random 32-byte
values for `auth-secret` (OCC sessions) and `routing-key` (private routing).
Store each value as 64 hexadecimal characters without a trailing newline.
Keep files mode 0600 and retain the keys for redeployment.

Use the matching release checkout, jq, yq v4, and Node.js matching `engines.node`
in `package.json`. Installation generates bootstrap credentials and their Secret.
Before creating OCC inputs, check that the OpenShell PKI job’s
`openshell-client-tls` Secret exists.

```bash
: "${OCC_SECRET_DIR:?Set OCC_SECRET_DIR to the protected input directory}"
for input in application-url migration-url database-ca.pem auth-secret routing-key; do
  path="$OCC_SECRET_DIR/$input"
  if [[ ! -f "$path" || ! -r "$path" || ! -s "$path" ]]; then
    printf 'Missing, unreadable or empty input: %s\n' "$input" >&2
    exit 1
  fi
done

if ! routing_key_bytes=$(wc -c < "$OCC_SECRET_DIR/routing-key") ||
  [[ "$routing_key_bytes" -ne 64 ]] ||
  ! LC_ALL=C grep -aqEx '[0-9A-Fa-f]{64}' < "$OCC_SECRET_DIR/routing-key"; then
  printf 'routing-key must contain exactly 64 hexadecimal characters with no trailing newline.\n' >&2
  exit 1
fi

platform_kube=(kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" -n "$PLATFORM_NS")
"${platform_kube[@]}" get secret openshell-client-tls -o name
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

Before the pre-install hook, the installer creates the bootstrap Secret and
prints the protected recovery directory. It never overwrites Secrets; use
[existing-Secret mode](production-installation-preparation.md#optional-supply-bootstrap-credentials)
for deliberately preprovisioned inputs. Only bootstrap receives its read-only
projection, during installation only. Retain local inputs outside the checkout.
The service key expires 30 days after registration; Secret changes do not rotate it.
After failed or uncertain creation or installation, stop and
[reconcile the attempt](../../reference/authentication/service-api-keys.md#recover-an-incomplete-bootstrap)
before continuing. Do not regenerate credentials or repeat confirmed creates.

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

Helm bootstraps OCC with zero workers. Reuse the session directory and kubeconfig.

<Snippet file="./cluster-browser-access.md" />

## 3. Authenticate and prepare the Namespace

Initialize the operator session. Its REST helper runs via Kubernetes exec in the API Pod.

For a Gateway in another namespace, set `OPENSHELL_NAMESPACE` first.

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
kube -n "${OPENSHELL_NAMESPACE:-$PLATFORM_NS}" get service openshell-gateway -o json |
  jq -e --arg ns "$PLATFORM_NS" --arg release "$RELEASE" '
    .metadata.namespace as $gatewayNs | .spec as $svc | select($svc.type=="ClusterIP" and ($svc.selector|length)>0
      and ($svc.clusterIP|test("^[0-9]+(\\.[0-9]+){3}$"))) |
    [$svc.ports[] | select(.protocol=="TCP" and .port==8080)] | select(length==1) | first as $port |
    {apiVersion:"networking.k8s.io/v1", kind:"NetworkPolicy",
     metadata:{namespace:$ns,name:"oce-controller-openshell-management"},
     spec:{podSelector:{matchLabels:{"app.kubernetes.io/name":"openclaw-enterprise",
       "app.kubernetes.io/instance":$release},matchExpressions:[
       {key:"app.kubernetes.io/component",operator:"In",values:["api","worker"]}]},
       policyTypes:["Egress"],egress:[
         {to:[{ipBlock:{cidr:($svc.clusterIP+"/32")}}],ports:[{protocol:"TCP",port:8080}]},
         {to:[{namespaceSelector:{matchLabels:{"kubernetes.io/metadata.name":$gatewayNs}},
           podSelector:{matchLabels:$svc.selector}}],ports:[{protocol:"TCP",port:$port.targetPort}]}
       ]}}' > "$RUN_DIR/management-policy.json"
kube create -f "$RUN_DIR/management-policy.json"
cp "$RUN_DIR/installation-with-peers.json" "$INSTALLATION_FILE"
cp "$RUN_DIR/worker.json" "$VALUES_FILE"
save_session
upgrade_installation
```

Agent deployment pairs these egress rules with management ingress for the API, worker, selected tenant’s supervisors and Agent Gateway on TCP 8080. Keep both directions. Tenant callers must match the backing namespace name and its current `openclaw.dev/namespace` label. Supervisor grants apply per tenant and Gateway grants per Agent. To verify ownership-based withdrawal, inspect every grant for that namespace. For a live Agent in its verified namespace, stage the current platform helper and renderer and run `deployment_network` in its saved session to replace a name-only grant.

If namespace ownership has changed or the Agent’s Gateway Service is gone, withdraw the obsolete grant directly. Check that its source namespace, Pod selector and management selector match the recorded owner: `kube -n "${OPENSHELL_NAMESPACE:-$PLATFORM_NS}" get networkpolicy "$policy" -o yaml`. Confirm another restrictive ingress policy still selects the management Pods, so they stay isolated. Then delete it: `kube -n "${OPENSHELL_NAMESPACE:-$PLATFORM_NS}" delete networkpolicy "$policy"`. Preserve grants for other tenants and callers.

After Compute creates the backing namespace, apply the [tenant bindings](production-agents.md#prepare-each-namespace). Verify restricted Pod Security and grant the ordinary worker role last.

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

Register credentials only after `request GET "$base"` reports `status: ready`. Initially select OpenShell Sandbox and Credential Gateway as credential owners. Defer the repository Credential Proxy.
