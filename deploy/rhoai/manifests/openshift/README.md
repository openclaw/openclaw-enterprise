# OpenShift Kustomize stages

Supporting Kubernetes resources for the OpenShift deployment, grouped by
deployment stage. Follow the [deployment guide](../../README.md) for the ordered
procedure, private inputs, and Helm releases; this page owns the Kustomize
inventory and the stage reference.

```text
deploy/rhoai/manifests/openshift/
├── base/                          Resource manifests grouped by deployment stage
│   ├── kustomization.yaml         All base resources for inspection
│   ├── operators/, database/, admission/, openshell/, control-plane/, routing/
│   └── control-ui/, control-ui-access/
├── overlays/test/                 Test profile, with a Kustomization for each stage
├── openshell-git/                 Optional service-CA resources for protected Git
├── openshell-mtls/                mTLS gateway profile and dashboard values
└── ../../scripts/                 prepare-kustomize, verify-images, resolve-images, grant-tenant-access
```

Render the complete example inventory:

```bash
oc kustomize deploy/rhoai/manifests/openshift/overlays/test
```

Render one stage directly:

```bash
oc kustomize deploy/rhoai/manifests/openshift/overlays/test/operators
```

## Stage reference

| Stage               | Resources                                                                                 | Prerequisite                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `operators`         | PostgreSQL and cert-manager Namespaces, OperatorGroups, Subscriptions                     | Verify the pinned catalog entries.                                               |
| `database`          | PostgreSQL cluster                                                                        | Wait for the PostgreSQL Operator and CRD.                                        |
| `admission`         | Control-plane Namespace, fixed-UID SCC, and exact grants                                  | Review the SCC and its exact ServiceAccount grants.                              |
| `openshell`         | OpenShell Namespace, RuntimeClass, workspace role, ingress and controller egress policies | Apply admission first; verify node labels and OpenShell pins.                    |
| `control-plane`     | PostgreSQL/API egress, Console Route                                                      | Run `prepare-inputs`; prepare `console-route.yaml` with this cluster's hostname. |
| `routing`           | Envoy Namespace, exact controller SCC grants, GatewayClass                                | Verify Gateway API compatibility and select the Helm chart version.              |
| `control-ui`        | Protected OAuth-proxy configuration                                                       | Complete the Control UI hostname and credential inputs.                          |
| `control-ui-access` | Exact Gateway Service read role and user binding                                          | Render the grant for an existing OpenShift username.                             |

Apply dependent stages in this order, with readiness checks between them. Apply
the OpenShell ingress policy before its Helm release. The routing stage supplies
the controller SCC grants before Envoy starts; its GatewayClass becomes accepted
after Envoy is running. Builds, Helm releases, SQL initialization, and endpoint
discovery stay in the deployment guide and the OCE installation documentation.

## Prepare and apply a stage

`prepare-kustomize` copies the selected checked-in base and overlay into the
private input directory and adds the deployment overrides. It needs `oc`, `yq`,
and `python3`. For `control-plane`, `control-ui`, and `control-ui-access`, it
turns the prepared private inputs into explicit JSON patches that replace one
complete resource each.

```bash
: "${OCC_INPUT_DIRECTORY:?Set the existing private input directory}"
deploy/rhoai/scripts/prepare-kustomize operators
oc kustomize "$OCC_INPUT_DIRECTORY/kustomize/overlays/test/operators"
oc apply --dry-run=server -k "$OCC_INPUT_DIRECTORY/kustomize/overlays/test/operators"
oc apply -k "$OCC_INPUT_DIRECTORY/kustomize/overlays/test/operators"
```

Inspect the patches and `rendered.yaml` before the server dry run. The helper
does not query or change the cluster, read Secrets, or change the active
context. Regenerate a private overlay after changing its source or inputs.

Example hostnames, network addresses, and `${VARIABLE}` values need private
deployment overrides. Review the storage class and operator pins against the
target cluster. Private stage directories use mode `0700` and their files mode
`0600`; do not commit private patches or rendered credentials.

## Enable private Agent routing

Dedicated Codex storage needs private Envoy routing; OCC rejects a revision while
routing is disabled. Run this after the OCC installation and before creating an
Agent. Check the OpenShift-managed Gateway API bundle first, keep its CRDs under
OpenShift management, and install only Envoy's CRDs with the exact controller
SCC grants.

```bash
export ENVOY_CHARTS="$OCC_INPUT_DIRECTORY/envoy-charts"
install -d -m 700 "$ENVOY_CHARTS"
helm pull oci://docker.io/envoyproxy/gateway-crds-helm --version v1.7.5 \
  --destination "$ENVOY_CHARTS" >"$ENVOY_CHARTS/gateway-crds.pull" 2>&1
test "$(sed -n 's/^Digest: //p' "$ENVOY_CHARTS/gateway-crds.pull")" = \
  sha256:f952368c9543948a9637178ddf37d0f90fda2560e4e0f54b3489b700a7b817fd
helm pull oci://docker.io/envoyproxy/gateway-helm --version v1.7.5 \
  --destination "$ENVOY_CHARTS" >"$ENVOY_CHARTS/gateway.pull" 2>&1
test "$(sed -n 's/^Digest: //p' "$ENVOY_CHARTS/gateway.pull")" = \
  sha256:94a3efa254e19731a0e8093f563221c98f34d102b8fcfaf5cc37dd2f3e52739d
oc get crd gateways.gateway.networking.k8s.io \
  -o go-template='{{ index .metadata.annotations "gateway.networking.k8s.io/bundle-version" }}{{ "\n" }}'
oc create namespace envoy-gateway-system --dry-run=client -o yaml | oc apply -f -
oc apply -f deploy/rhoai/manifests/openshift/base/routing/envoy-controller-scc-rbac.yaml
helm template eg-crds "$ENVOY_CHARTS/gateway-crds-helm-v1.7.5.tgz" \
  --set crds.gatewayAPI.enabled=false \
  --set crds.envoyGateway.enabled=true \
  > "$OCC_INPUT_DIRECTORY/envoy-gateway-crds.yaml"
oc apply --server-side -f "$OCC_INPUT_DIRECTORY/envoy-gateway-crds.yaml"
helm upgrade --install eg "$ENVOY_CHARTS/gateway-helm-v1.7.5.tgz" \
  -n envoy-gateway-system --skip-crds --wait --timeout 7m
oc apply -f deploy/rhoai/manifests/openshift/base/routing/envoy-gateway-class.yaml
oc get gatewayclass eg
```

The digests pin the v1.7.5 chart artifacts. Change a digest only together with
its version, and refresh both from a trusted registry pull.

Expect the GatewayClass `Accepted` condition to be `True`. Then create a private
routing key, enable routing, and use the full cluster DNS name for the private
Gateway; OpenShell's policy resolver cannot use the short `.svc` name.

```bash
test -e "$OCC_INPUT_DIRECTORY/gateway-api-key" || \
  (umask 077; python3 -c 'import secrets; print(secrets.token_hex(32), end="")' \
    > "$OCC_INPUT_DIRECTORY/gateway-api-key")
oc -n openclaw-system create secret generic occ-private-gateway-key \
  --from-file=occ="$OCC_INPUT_DIRECTORY/gateway-api-key"
export CLUSTER_DNS_DOMAIN="$(oc -n openclaw-system exec deployment/openclaw-enterprise-api -- \
  cat /etc/resolv.conf | awk '/^search / { for (i = 2; i <= NF; i++) if ($i ~ /^svc[.]/) { sub(/^svc[.]/, "", $i); print $i; exit } }')"
export ENVOY_SERVICE="occ-gateway-$(printf '%s' 'openclaw-system/oce-agent-gateways' | \
  sha256sum | cut -c1-12)"
export PRIVATE_GATEWAY_HOST="$ENVOY_SERVICE.envoy-gateway-system.svc.$CLUSTER_DNS_DOMAIN"
yq -i '.gatewayRouting.enabled = true |
  .gatewayRouting.gatewayClassName = "eg" |
  .gatewayRouting.apiKeySecretName = "occ-private-gateway-key" |
  .gatewayRouting.hostname = strenv(PRIVATE_GATEWAY_HOST)' \
  "$OCC_INPUT_DIRECTORY/values.yaml"
helm upgrade --install oce "$OCE_CHECKOUT/deploy/helm/openclaw-enterprise" \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  --wait --timeout 7m
```

Grant `nonroot-v2` only to the generated Envoy data-plane ServiceAccount, then
verify the data plane and Gateway:

```bash
export ENVOY_DEPLOY="$(oc -n envoy-gateway-system get deployments \
  -l gateway.envoyproxy.io/owning-gateway-namespace=openclaw-system,gateway.envoyproxy.io/owning-gateway-name=oce-agent-gateways \
  -o jsonpath='{.items[0].metadata.name}')"
export ENVOY_SA="$(oc -n envoy-gateway-system get deployment "$ENVOY_DEPLOY" \
  -o jsonpath='{.spec.template.spec.serviceAccountName}')"
oc -n envoy-gateway-system create rolebinding eg-private-dataplane-nonroot \
  --role=eg-nonroot-v2 --serviceaccount="envoy-gateway-system:$ENVOY_SA"
oc -n envoy-gateway-system rollout status deployment/"$ENVOY_DEPLOY" --timeout=3m
oc -n envoy-gateway-system get service "$ENVOY_SERVICE"
oc -n openclaw-system get gateway oce-agent-gateways
```

Update the Installation with Compute `gatewayRouting`, remove the direct
`gatewayClients` entry, set the pod network CIDR, replace the startup Secret,
and restart OCC:

```bash
export POD_NETWORK_CIDR="$(oc get network.config.openshift.io cluster \
  -o jsonpath='{.spec.clusterNetwork[0].cidr}')"
yq -i '.drivers.compute.configuration.gatewayRouting = {
  "gatewayName":"oce-agent-gateways","gatewayNamespace":"openclaw-system",
  "envoyNamespace":"envoy-gateway-system","hostname":strenv(PRIVATE_GATEWAY_HOST)} |
  del(.drivers.compute.configuration.network.gatewayClients) |
  .drivers.compute.configuration.network.gatewayTrustedProxyCidrs = [strenv(POD_NETWORK_CIDR)]' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
deploy/rhoai/scripts/validate-installation "$OCC_INPUT_DIRECTORY/installation.yaml"
oc -n openclaw-system create secret generic occ-installation-startup \
  --from-file=installation.yaml="$OCC_INPUT_DIRECTORY/installation.yaml" \
  --dry-run=client -o json | jq '{data:.data}' | \
  oc -n openclaw-system patch secret occ-installation-startup \
    --type=merge --patch-file=/dev/stdin
oc -n openclaw-system rollout restart \
  deployment/openclaw-enterprise-api deployment/openclaw-enterprise-worker
oc -n openclaw-system rollout status deployment/openclaw-enterprise-api --timeout=4m
oc -n openclaw-system rollout status deployment/openclaw-enterprise-worker --timeout=4m
```

Then complete
[Enable routing for existing Namespaces and Agents](../../../../docs/guides/deploy/workspace-routing.md#enable-routing-for-existing-namespaces-and-agents),
skipping the existing-Agent redeployment steps when there is no Agent yet. Finish
with ready API and worker Deployments and `Programmed=True` on the Gateway.

## Control UI Route

Run this after the Agent deployment reports `succeeded`. The OAuth proxy
protects a public Route to one Agent Gateway. After OpenShift OAuth checks `get`
on the exact Gateway Service, a loopback Envoy proxy strips browser credentials
and supplies the Gateway's trusted identity.

Use the Agent identifiers from the Agent procedure and discover the images,
hostname, and Service check:

```bash
export GATEWAY_SERVICE="gateway-${AGENT_SA#agent-}"
export OAUTH_PROXY_IMAGE="$(oc -n openshift get imagestreamtag oauth-proxy:v4.4 \
  -o jsonpath='{.image.dockerImageReference}')"
export CONTROL_UI_ENVOY_IMAGE="$(oc -n envoy-gateway-system get deployments \
  -o json | jq -er '[.items[].spec.template.spec.containers[] |
    select(.name == "envoy") | .image] |
    if length == 1 then .[0] else error("expected one Envoy data plane image") end')"
export CONTROL_UI_HOST="oc-ui-${AGENT_SA#agent-}.$(oc get \
  ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}')"
export OAUTH_HOST="$(oc -n openshift-authentication get route oauth-openshift \
  -o jsonpath='{.spec.host}')"
export OAUTH_SAR="$(jq -nc --arg namespace "$GATEWAY_NAMESPACE" \
  --arg service "$GATEWAY_SERVICE" \
  '{namespace:$namespace,resource:"services",resourceName:$service,verb:"get"}')"
test -n "$OAUTH_PROXY_IMAGE" && test -n "$CONTROL_UI_ENVOY_IMAGE" &&
  test -n "$CONTROL_UI_HOST" && test -n "$OAUTH_HOST"
oc auth can-i get "service/$GATEWAY_SERVICE" -n "$GATEWAY_NAMESPACE"
```

The permission check must return `yes` for each person who opens the Route.
Create the cookie Secret and render the proxy inputs:

```bash
test -e "$OCC_INPUT_DIRECTORY/control-ui-oauth-cookie" ||
  (umask 077; openssl rand -hex 16 > "$OCC_INPUT_DIRECTORY/control-ui-oauth-cookie")
oc -n "$GATEWAY_NAMESPACE" create secret generic \
  oce-agent-control-ui-oauth-cookie \
  --from-file=session_secret="$OCC_INPUT_DIRECTORY/control-ui-oauth-cookie" \
  --dry-run=client -o yaml | oc apply -f -

export DNS_CIDR_0="$(oc -n openshift-dns get svc dns-default \
  -o jsonpath='{.spec.clusterIP}')/32"
export ROUTER_IP="$(oc -n openshift-ingress get svc router-default \
  -o jsonpath='{.spec.clusterIP}')"
export ROUTER_CIDR="$ROUTER_IP/32"
test -n "$ROUTER_IP"
export API_SERVICE_CIDR="$(oc -n default get svc kubernetes \
  -o jsonpath='{.spec.clusterIP}')/32"
export API_ENDPOINT_CIDRS="$OCC_INPUT_DIRECTORY/api-cidrs.json"
oc -n openshift-dns get pods \
  -l dns.operator.openshift.io/daemonset-dns=default -o json | \
  jq -e '[.items[].status.podIP] | unique |
    if length > 0 and all(type == "string" and (contains(":") | not))
    then map({ipBlock:{cidr:(. + "/32")}})
    else error("expected IPv4 DNS Pod addresses") end' \
  > "$OCC_INPUT_DIRECTORY/dns-peers.json"
export DNS_PEERS_FILE="$OCC_INPUT_DIRECTORY/dns-peers.json"
envsubst '${GATEWAY_NAMESPACE} ${GATEWAY_SERVICE} ${OAUTH_PROXY_IMAGE} ${CONTROL_UI_ENVOY_IMAGE} ${OAUTH_SAR} ${CONTROL_UI_HOST} ${OAUTH_HOST} ${DNS_CIDR_0} ${ROUTER_IP} ${ROUTER_CIDR} ${API_SERVICE_CIDR}' \
  < deploy/rhoai/manifests/openshift/base/control-ui/control-ui-oauth-proxy.yaml \
  > "$OCC_INPUT_DIRECTORY/control-ui-oauth-proxy.yaml"
yq -i '(select(.kind == "NetworkPolicy").spec.egress[] |
  select(.ports[].port == 53).to) += load(strenv(DNS_PEERS_FILE))' \
  "$OCC_INPUT_DIRECTORY/control-ui-oauth-proxy.yaml"
yq -i '(select(.kind == "NetworkPolicy").spec.egress[] |
  select(.ports[].port == 6443).to) +=
    (load(strenv(API_ENDPOINT_CIDRS)) | map({"ipBlock":{"cidr":.}}))' \
  "$OCC_INPUT_DIRECTORY/control-ui-oauth-proxy.yaml"
```

The Deployment maps `$OAUTH_HOST` to the router Service ClusterIP. The OAuth
proxy keeps the public hostname and TLS validation for its token exchange while
the request stays on the allowed internal ingress path.

Apply the proxy and wait for the Route:

```bash
oc apply --dry-run=server -f "$OCC_INPUT_DIRECTORY/control-ui-oauth-proxy.yaml"
oc apply -f "$OCC_INPUT_DIRECTORY/control-ui-oauth-proxy.yaml"
oc -n "$GATEWAY_NAMESPACE" rollout status \
  deployment/oce-agent-control-ui-oauth --timeout=3m
oc -n "$GATEWAY_NAMESPACE" get route oce-agent-control-ui-oauth \
  -o jsonpath='{.spec.host}{"\n"}{.status.ingress[0].conditions[?(@.type=="Admitted")].status}{"\n"}'
```

Expect the selected host and `True`. To let a non-admin user open the Route,
grant `get` on this exact Gateway Service and check it:

```bash
export CONTROL_UI_USER='<existing OpenShift username>'
envsubst '${GATEWAY_NAMESPACE} ${GATEWAY_SERVICE} ${CONTROL_UI_USER}' \
  < deploy/rhoai/manifests/openshift/base/control-ui-access/control-ui-user-rbac.yaml \
  > "$OCC_INPUT_DIRECTORY/control-ui-access.yaml"
oc apply --dry-run=server -f "$OCC_INPUT_DIRECTORY/control-ui-access.yaml"
oc apply -f "$OCC_INPUT_DIRECTORY/control-ui-access.yaml"
oc auth can-i get "service/$GATEWAY_SERVICE" \
  -n "$GATEWAY_NAMESPACE" --as="$CONTROL_UI_USER" \
  --as-group=system:authenticated --as-group=system:authenticated:oauth
```

Expect `yes`. Finally, add the exact HTTPS origin to the Configuration and
deploy a new revision:

```bash
export CONTROL_UI_ORIGIN="https://$(oc -n "$GATEWAY_NAMESPACE" get route \
  oce-agent-control-ui-oauth -o jsonpath='{.spec.host}')"
deploy/rhoai/bin/occ configuration get "$CONFIGURATION_ID" -o json |
  jq --arg origin "$CONTROL_UI_ORIGIN" \
    '{values:(.values | .gateway.controlUi.enabled = true |
      .gateway.controlUi.allowedOrigins =
        ((.gateway.controlUi.allowedOrigins // []) + [$origin] | unique) |
      .gateway.auth.trustedProxy.deviceAutoApprove =
        {enabled:true,scopes:["operator.admin"]})}' \
    > "$OCC_INPUT_DIRECTORY/control-ui-configuration.json"
deploy/rhoai/bin/occ configuration update "$CONFIGURATION_ID" \
  --file "$OCC_INPUT_DIRECTORY/control-ui-configuration.json"
deploy/rhoai/bin/occ agent deploy "$AGENT_ID"
```

Record the returned revision, wait for `succeeded`, then open
`$CONTROL_UI_ORIGIN/new` and complete a model turn. On a fresh Gateway,
`/chat/main` may show **Conversation unavailable**; start at `/new`.

`deviceAutoApprove` approves `operator.admin` devices automatically for every
login that passes the Route's Service check. Enable it only when every permitted
OpenShift user is a trusted operator for this Agent. Otherwise remove that line
and approve devices explicitly. The proxy maps each authorized login to the
Agent's admin identity; the Route's exact Service grant is the access boundary.

Without `deviceAutoApprove`, the first browser login stays pending and the
Control UI prints the request ID. Approve it in the Agent Gateway container:

```bash
oc -n "$GATEWAY_NAMESPACE" exec deployment/"gateway-${AGENT_SA#agent-}" \
  -c gateway -- /app/node_modules/.bin/openclaw devices approve <request-id>
```

List pending requests with `openclaw devices list` in the same container. The
pinned runtime ships the CLI at `/app/node_modules/.bin/openclaw`. Approve one
device for each browser.

## Optional OpenShell Git resources

The optional `openshell-git/` resources prepare OpenShift service-CA objects for
protected Git access. Their Helm fragments and supervisor egress rule need
private inputs and an explicit rollout after the mTLS cutover.
