# Run a dedicated OpenShell Agent on EKS

Install OpenClaw Enterprise (OCE) with OpenShell, connect a Codex service account to its managed Linear plugin, and give one Agent access to one GitHub repository through the Credential Proxy. Start in a matching release checkout with access to the target EKS cluster. Keep the records from each step in an owner-only directory.

## 1. Prepare the cluster and images

Follow [Kubernetes setup](../kubernetes-setup.md) and [EKS infrastructure preparation](eks.md#prepare-aws-infrastructure). Select an IPv4 cluster, two private EC2 node groups labeled `oce-role=control` and `oce-role=agents`, strict VPC CNI NetworkPolicy enforcement, encrypted gp3 RWO storage with `WaitForFirstConsumer`, and private PostgreSQL with separate application and migration roles and verified TLS. The validated configuration used EKS 1.36, AL2023, kernel 6.18, VPC CNI 1.22.4, EBS CSI 1.67.2 and PostgreSQL 18.6. Check versions and NAT capacity in your chosen region.

Install cert-manager, Gateway API, Envoy Gateway and the matching Agent Sandbox controller. Under strict CNI, prepare component policies before rollout. Include DNS and API Service VIPs alongside the intended Pod peers and API EndpointSlice addresses. Verify EBS CSI reaches its regional EC2 and STS endpoints. For RDS, authorize the security group of the actual source interface. Verify both database roles with `sslmode=verify-full`. [EKS network and storage](eks.md#configure-network-enforcement-and-storage)

```bash
set -euo pipefail
set +x
umask 077
RUN_DIR=$(mktemp -d)
export KUBECONFIG="$RUN_DIR/kubeconfig"
export PLATFORM_NS=oce-system
export CONTEXT="oce-${EKS_CLUSTER:?Set the target cluster name}"
aws sts get-caller-identity --query '[Account,Arn]'
aws eks update-kubeconfig --name "$EKS_CLUSTER" --region "${AWS_REGION:?}" \
  --alias "$CONTEXT" --kubeconfig "$KUBECONFIG"
kubectl get nodes -L oce-role
kubectl get storageclass encrypted-gp3
```

Confirm the account and role, then test Kubernetes TLS from the operator host. Successive connections through shared NAT can use different public IP addresses. For a public API allowlist change, authorize only the exact stable egress addresses or CIDRs listed for that host in the authoritative NAT inventory. A single observed IP address cannot establish or justify a broader prefix. Preserve existing allowlist entries, public and private endpoint settings, and AWS and Kubernetes authentication.

[Build the controller and runtime](production-installation.md#build-and-publish-production-images) from one release or [copy verified images](private-registry-images.md) into a registry the nodes can pull from. Set `CONTROLLER_IMAGE` and `RUNTIME_IMAGE` to the resulting immutable references. The templates target AMD64 nodes, OpenShell 0.1.6 and Codex 0.164.0. Mirror the stock Gateway, supervisor and Sandbox runtime AMD64 manifests into the repository selected below, retaining their digests. Have the matching stock chart archive, the OCE chart and the qualified Envoy proxy image available. Create the system namespace before its policies and chart jobs. Use an OpenShell-compatible kernel, a restricted workload Namespace and a `runc` RuntimeClass named `openshell-sandbox` pinned to the Agent node group. Check Landlock, seccomp and no-new-privileges on that pool before enrolling credentials.

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
jq -n --arg controller "${CONTROLLER_IMAGE:?}" --arg email "${ADMIN_EMAIL:?}" \
  --arg hostname "$route_host" --argjson databaseCidrs "${DATABASE_CIDRS:?}" \
  --argjson apiCidrs "${API_CIDRS:?}" -f "$assets/values.jq" > "$RUN_DIR/values.json"
```

Use the cluster’s full DNS suffix in the route hostname and serving certificate. A short `.svc` hostname resolved in an ordinary Pod but produced `policy_dns_upstream_nxdomain` in the stock supervisor. Keep operator mTLS enabled and retain the existing OpenShell PKI and JWT signing material through upgrades.

Provision the Secret references in the rendered values. Use distinct OCE authentication and private routing keys, protected RDS connection files and CA, and the OpenShell client TLS Secret. The private routing Secret uses the key `occ`. Create and prepare the bootstrap PVC once with the chart’s expected UID/GID 1000 and directory mode 0700. The stock native runtime uses UID/GID 10001. [System Secrets and bootstrap volume](production-installation.md#provision-system-secrets-and-install)

```bash
kubectl -n "$PLATFORM_NS" create secret generic occ-installation-startup \
  --from-file="installation.yaml=$RUN_DIR/installation.json"
helm install oce "${OCE_CHART:?}" -n "$PLATFORM_NS" -f "$RUN_DIR/values.json" --wait --timeout 5m
kubectl -n "$PLATFORM_NS" rollout status deploy/openclaw-enterprise-api
# Pin the Envoy data plane through its supported resource field.
kubectl -n "$PLATFORM_NS" patch envoyproxy oce-agent-gateways --type=merge \
  -p "$(jq -nc --arg image "${ENVOY_IMAGE:?}" '{spec:{provider:{type:"Kubernetes",kubernetes:{envoyDeployment:{container:{image:$image}}}}}}')"
```

The worker starts at zero. Helm runs the installation check, migration and bootstrap hooks. Read the bootstrap service-key JSON privately from the protected PVC and set `OCC_SERVICE_KEY_FILE` to the owner-only session copy. [Bootstrap authentication](production-installation.md#authenticate-to-the-production-api)

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

Enroll one repository and Namespace under `github-repository` with Contents write and Metadata read. Create immutable read and write registry ConfigMaps. Mount the App signing key and a dedicated persistent 32-byte custody key only in the worker. Add the GitHub Backend owner, its `repo` Driver, `repository.preparedGitHub` and `repository.openShell` to the Installation. Select the Sandbox Driver ID in **both** `drivers.credential_proxy` and the OpenShell Backend’s `drivers.credential_proxy`. A missing owner fails the chart’s installation check. [Registry, Installation and deployment inputs](../repository-credentials/openshell-enrollment.md)

Issue a serving certificate for `openclaw-enterprise-openshell-git.oce-system.svc`. Supply the worker with the Gateway’s public JWT key and key ID. Upgrade OCE first with the versioned Installation Secret, protected listener on 8445 and reviewed GitHub API egress ranges. Check that the Service has a ready worker endpoint. Verify the Envoy image pin after Helm upgrades. Review and apply the service peers before enabling the hook:

```bash
python3 "$assets/service-policies.py" --tenant "$TENANT_NAMESPACE" --namespace-id "$namespace" \
  > "$RUN_DIR/protected-service-peers.json"
kubectl apply -f "$RUN_DIR/protected-service-peers.json"
```

Mount the listener’s public CA on the stock OpenShell Gateway. Register the mandatory `oce-prepared-git` middleware using TLS verification, the audience, allowlist and `http_request_pre_credentials` binding. Retain the Gateway’s existing PKI. Run the documented worker installation GET and require a verified TLS connection, HTTP 200, and matching App and installation IDs before deployment. [Register the protected request-phase service](../../reference/repository-credentials/protected-openshell-git.md#register-the-request-phase-service)

## 5. Verify through the private OpenClaw route

Create a dedicated Gateway-managed Agent using the [Codex configuration](local-openshell-setup.md#5-create-the-configuration-and-agent) and [exact model-source grant](local-openshell-setup.md#6-grant-model-access-and-deploy). Native process and file tools have full access inside OpenShell with approval set to `on-request` and reviewer `user`. Provision transport once. Discover the managed Linear plugin and add it and the approved repository binding to the same draft. [Linear selection](../integrations/codex-plugins.md) · [Git binding](../repository-credentials/openshell-git-push.md#2-bind-the-agent-and-deploy-once)

```bash
# POST once. Poll GET "$base/agents/$agent/deployments/$revision".
revision=$(request POST "$base/agents/$agent/deploy" | jq -er .data.id)
# Once Compute creates this Agent's Gateway Service, resolve its actual VIP.
python3 "$assets/service-policies.py" --tenant "$TENANT_NAMESPACE" \
  --namespace-id "$namespace" --agent-id "$agent" > "$RUN_DIR/agent-service-peers.json"
kubectl apply -f "$RUN_DIR/agent-service-peers.json"
```

Refresh these peers when a replacement Service gets another VIP. The paired Gateway needs egress to OpenShell on 8080 **and** the OpenShell server needs ingress from that exact tenant Gateway on 8080. Missing ingress caused the native WebSocket handshake to time out even after deployment reached `succeeded`. Verify the final revision is active, the native Pod belongs to its Sandbox on the Agent node group, its actual image matches the selected digest, and UID/GID 10001, zero effective capabilities, seccomp and no-new-privileges are enforced.

Use the shipped [OpenClaw chat client](../../assets/openshell-quickstart/chat.mjs) in the API Pod with the selected Namespace, Agent and prompt. For example:

```bash
turn() {
  kubectl -n "$PLATFORM_NS" exec -i deployment/openclaw-enterprise-api -c api -- \
    env OCE_TEST_NAMESPACE_ID="$namespace" OCE_TEST_AGENT_ID="$agent" OCE_TEST_PROMPT="$(cat "$1")" \
    node --input-type=module < docs/assets/openshell-quickstart/chat.mjs
}
printf '%s\n' 'Use the managed Linear plugin to list one team with limit 1. Return its ID, key and name.' > "$RUN_DIR/linear-prompt"
turn "$RUN_DIR/linear-prompt" > "$RUN_DIR/linear-result"
```

Confirm the admitted run, native thread, call ID, successful result and team fact. For Git, ask the same Agent to publish one empty commit on a fresh branch. Fetch the advertised default-branch ref, check the expected parent and negotiate a thin pack. Verify the App bot author, ref, parent, unchanged tree and zero files using an independent GitHub reader. Correlate the scoped `receive-pack` receipt and material version with the same revision. [Git verification commands](../repository-credentials/openshell-git-push.md#4-verify-the-remote-ref)

Stop the Agent with `POST $base/agents/$agent/stop` and verify its active revision cleared. Check that known write material is revoked, settled and no longer sealed. Withdraw any standing approval with its current generation, remove the draft binding and restore the read-only registry with a Helm upgrade. Verify the ready worker’s actual ConfigMap mount and Contents read/Metadata read permissions. Keep the proof branch and sanitized receipts for inspection. EKS, EC2, storage, registry and RDS resources can continue to incur charges after the Agent stops.
