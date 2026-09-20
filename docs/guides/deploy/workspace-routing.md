# Configure private Agent workspace routing

Enable private Kubernetes routing so operators can read and replace Agent
workspace files through OCC. Start with the [production installation](production-installation.md)
and keep its protected Helm values, Installation YAML, and Kubernetes context.
For EKS, also prepare the [strict-mode routing prerequisites](eks.md#enable-console-workspace-files).

## Agent workspace files

The [Envoy routing reference](../../reference/gateway-routing.md) describes endpoints,
resource ownership, service keys, TLS, and failure behavior.

Enable private Agent routing to read and replace `AGENTS.md`, `SOUL.md`,
`IDENTITY.md`, and `USER.md` through OCC. Compute creates each Agent's HTTPRoute
when it provisions the gateway. One shared private hostname serves URLs of the
form `wss://<hostname>/namespaces/<namespaceId>/agents/<agentId>`; there is no
per-Agent endpoint map or API restart after provisioning.

### Requirements

This integration requires Kubernetes with enforced NetworkPolicies,
[Envoy Gateway v1.9](https://gateway.envoyproxy.io/docs/tasks/quickstart/),
Gateway API CRDs, and [cert-manager](https://cert-manager.io/docs/installation/).
Install and operate those controllers separately from this chart and provide
an existing Envoy GatewayClass. By default, the chart creates a namespaced
SelfSigned Issuer, a root CA Certificate, and a CA Issuer; cert-manager generates
the CA and Envoy's listener certificate. It also creates the shared Gateway,
ClusterIP EnvoyProxy, and API-key SecurityPolicy. No public listener is created.
The operator installing the chart needs permission for these infrastructure
resources; the OCC API does not.

The chart gives Envoy a stable Service name and derives its `.svc` hostname.
Normal Linux Pod DNS search resolves that name without a separate DNS record
or a fixed cluster DNS suffix. The certificate and Compute routes use the same
hostname. TLS verification remains enabled.

### Configure private routing

Use the dedicated kubeconfig and reviewed context from production installation
for every command below:

```sh
export KUBECONFIG="$KUBECONFIG_FILE"
kubectl config use-context "$CONTEXT"
```

Create a dedicated high-entropy service key with no trailing newline, then
create its Secret in the controller namespace. Keep key files outside Git.
For an existing installation, reuse its Secret; use the
[rotation procedure](#rotate-the-service-key-and-certificates) to change a live key:

```sh
umask 077
python3 -c 'import secrets; print(secrets.token_hex(32), end="")' > /secure/operator/gateway-api-key
kubectl -n openclaw-system create secret generic occ-private-gateway-key \
  --from-file=occ=/secure/operator/gateway-api-key
```

Add the following to the existing Helm values. This example uses release
`oce` in `openclaw-system`; no hostname, issuer, or CA Secret is required:

```yaml
gatewayRouting:
  enabled: true
  gatewayClassName: eg
  apiKeySecretName: occ-private-gateway-key
```

The default Gateway name is `<release>-agent-gateways`, in the Helm release
namespace. Add matching routing settings to `drivers.compute.configuration`
in the Installation startup YAML:

```yaml
gatewayRouting:
  gatewayName: oce-agent-gateways
  gatewayNamespace: openclaw-system
  envoyNamespace: envoy-gateway-system
network:
  gatewayPort: 8080
  # Preserve the existing DNS namespace and Pod labels here.
```

Helm and Compute derive the hostname independently from these same settings;
Helm does not rewrite the Installation Secret. The
[Compute reference](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#private-agent-gateway-routes)
defines the naming rule. It does not require an existing Agent gateway.

To use an existing issuer instead of creating a CA, set
`gatewayRouting.issuerRef.name`, with `kind` (default `ClusterIssuer`) and
`group` (default `cert-manager.io`). If OCC needs additional trust for that
issuer, create a Secret containing only the public CA bundle and set both
`gatewayRouting.caSecretName` and `caSecretKey`. Leave both empty when Node
already trusts the issuing CA. Explicit CA trust requires an explicit issuer;
it cannot replace the chart's generated CA bundle in automatic mode.
Root and leaf certificate outputs must use different Secrets, separate from
Installation, database, auth, provider, and service-key Secrets. An external
CA trust bundle must also remain separate from those credentials and the leaf
TLS Secret.

For custom DNS, set the same `gatewayRouting.hostname` in Helm and Compute and
make it resolve to the Envoy Service. The selected issuer must be able to issue
for that name. A custom hostname can use either the automatic CA or an existing
issuer; it does not change CA ownership.

The chart's `tenantGatewayPort` must match Compute's `network.gatewayPort`.
Remove `network.gatewayClients` when enabling routing. Compute derives the
Envoy peer from `gatewayRouting` and rejects explicit gateway clients in this mode.
Retain the Installation's other Compute settings. Restart the API and worker
when changing their Installation startup configuration. New Agent creation
thereafter needs no configuration update. The worker requires tenant-local
HTTPRoute permissions from the chart's worker role; the API needs no route
writes or gateway Pod/exec access.

### Configure native gateway authentication

Each Agent's native Configuration must explicitly select trusted-proxy auth.
This fragment shows only the relevant native fields; preserve the model,
Harness, and other existing configuration:

```yaml
gateway:
  trustedProxies:
    - <actual-proxy-source-cidr>
  allowRealIpFallback: true
  auth:
    mode: trusted-proxy
    trustedProxy:
      userHeader: x-occ-identity
      allowUsers:
        - occ-workspace-files
    identityScopes:
      occ-workspace-files:
        - operator.admin
```

Compute validates the fixed identity header, allowed identity, administrative
grant, and real-IP fallback, and requires a nonempty `trustedProxies` entry. It
does not verify that those addresses belong to Envoy. Operators must validate
the actual proxy source CIDRs and exclude untrusted sources.
Omit `gateway.auth.token`; native OpenClaw rejects a simultaneous token
in this mode, and Compute omits automatic gateway-token projection. Do not require an
`x-forwarded-for` header in native `requiredHeaders`: the route removes it.
Envoy authenticates the service key, strips it, overwrites the fixed native
identity, and supplies `X-Real-IP` from its direct OCC connection. This supported
fallback works when OCC and Envoy share a Pod CIDR. Never fabricate an address
or admit direct workload access to compensate for native attribution failures.

NetworkPolicy must restrict native gateway ingress to those Envoy Pods. The
chart restricts proxy ingress to the OCC API and permits its required routing
and control-plane traffic. A trusted source CIDR by itself is not sufficient
isolation. Restrict Kubernetes writes to the Gateway, attached HTTPRoutes,
SecurityPolicy, native configuration, and namespace attachment labels to trusted
operators and the scoped worker. Untrusted tenants must not be able to replace
route authentication or attach their own routes.

The chart mounts the service key only into the API and sets
`OCC_GATEWAY_API_KEY_PATH`. Automatic CA mode projects only the root Secret's
public `tls.crt` as `ca.crt` and sets `NODE_EXTRA_CA_CERTS`; the signing key is
never mounted into OCC. The Pod waits for that Secret before starting. With an
explicit issuer, the API uses the optional configured CA bundle instead.
No credential or endpoint map is mounted into the worker,
Agent, or gateway. The key is an Installation-wide native administrative
credential; do not reuse a Better Auth signing key or model-provider token.
OCC still checks the human caller's exact Agent `read` or `operate` permission.

### Enable routing for existing Namespaces and Agents

Plan a maintenance window for the gateway restart and Namespace-wide ingress
change. Preserve Agent IDs, Configuration IDs, PVC/PV identities, workspace
contents, session IDs, and model/channel credentials. Back up the current native
Configuration, active revision, protected Helm/Installation inputs, and the
namespace resources before changing them. Check whether other Agents share the
Configuration before replacing its values.

1. Apply the matching Helm values and updated Installation startup Secret using
   the [production installation procedure](production-installation.md). Preserve
   the existing auth/database and routing-key Secrets, generated CA Secrets, and
   prepared bootstrap volume; do not rerun fresh-volume preparation. Restart both
   API and worker to load the new startup configuration. Wait for the private Gateway, certificates, and policy.
2. For each existing Agent being routed, update its existing native
   Configuration with the authentication fragment above, preserving other
   values and omitting token/password fields. PATCH the full preserved `values`
   through the [Configuration API](../../reference/configuration.md#create-read-update-and-delete), then
   `POST /namespaces/:namespaceId/agents/:agentId/deploy` for the same Agent.
   Retain and poll the returned deployment ID. Do not recreate the Agent or
   retire its current revision before successful cutover: its PVCs belong to
   that Agent and must survive the gateway replacement.
3. Reconcile existing ready Namespaces as described below. Agent activation
   alone is not proof that its HTTPRoute is accepted or files are accessible.

Namespace provisioning creates the routing attachment label and
`allow-gateway-ingress` policy. A ready Namespace is skipped by Namespace
lifecycle reconciliation; deploying another Agent revision does not rewrite
those resources. There is no public Namespace repair endpoint. A cluster
operator must reconcile these two fields for existing ready Namespaces.
This changes ingress for **every gateway in that Namespace**; coordinate the
cutover with its other Agents and preserve unrelated policies and labels.

Select the existing tenant Kubernetes namespace, distinct from its OCC
Namespace ID. The following uses the same Gateway name/namespace as the examples
above, `jq`, and the protected directory from production installation:

```sh
set -e
export TENANT_NAMESPACE='<existing-tenant-kubernetes-namespace>'
export NAMESPACE_ID='<existing-occ-namespace-id>'
ROUTING_BACKUP="$(mktemp -d "$OCC_INPUT_DIRECTORY/workspace-routing.XXXXXX")"
export ROUTING_BACKUP
kubectl get namespace "$TENANT_NAMESPACE" -o json > "$ROUTING_BACKUP/namespace.json"
kubectl -n "$TENANT_NAMESPACE" get networkpolicy allow-gateway-ingress -o json \
  > "$ROUTING_BACKUP/ingress.json"
kubectl -n openclaw-system get gateway oce-agent-gateways -o json \
  > "$ROUTING_BACKUP/gateway.json"
jq -e --arg id "$NAMESPACE_ID" \
  '.metadata.labels["openclaw.dev/namespace"] == $id and
   .metadata.annotations["openclaw.dev/namespace-id"] == $id' \
  "$ROUTING_BACKUP/namespace.json"
jq -e --arg id "$NAMESPACE_ID" \
  '.metadata.labels["openclaw.dev/namespace"] == $id and
   .metadata.annotations["openclaw.dev/namespace-id"] == $id and
   .metadata.labels["app.kubernetes.io/managed-by"] == "openclaw-enterprise" and
   .spec.podSelector.matchLabels["openclaw.dev/workload-role"] == "gateway"' \
  "$ROUTING_BACKUP/ingress.json"
ROUTING_LABEL="$(jq -er '.spec.listeners[] | select(.name == "https") |
  .allowedRoutes.namespaces.selector.matchLabels["openclaw-enterprise.io/gateway"]' \
  "$ROUTING_BACKUP/gateway.json")"
export ROUTING_LABEL
```

Continue only if the ownership and gateway selector checks succeed. Inspect
all additive NetworkPolicies; stop if another policy would still admit untrusted callers.
Generate patches that preserve other fields and reject concurrent resource
changes. Match the port to Compute `network.gatewayPort` if it differs from
`8080`, and adjust the Gateway names/namespaces together if customized:

```sh
jq '{metadata: {resourceVersion: .metadata.resourceVersion}, spec: {ingress: [{
  from: [{namespaceSelector: {matchLabels: {
    "kubernetes.io/metadata.name": "envoy-gateway-system"
  }}, podSelector: {matchLabels: {
    "gateway.envoyproxy.io/owning-gateway-namespace": "openclaw-system",
    "gateway.envoyproxy.io/owning-gateway-name": "oce-agent-gateways"
  }}}], ports: [{protocol: "TCP", port: 8080}]
}]}}' "$ROUTING_BACKUP/ingress.json" > "$ROUTING_BACKUP/ingress-patch.json"
jq --arg label "$ROUTING_LABEL" '{metadata: {
  resourceVersion: .metadata.resourceVersion,
  labels: {"openclaw-enterprise.io/gateway": $label}
}}' "$ROUTING_BACKUP/namespace.json" > "$ROUTING_BACKUP/namespace-patch.json"
kubectl -n "$TENANT_NAMESPACE" patch networkpolicy allow-gateway-ingress \
  --type=merge --patch-file="$ROUTING_BACKUP/ingress-patch.json"
kubectl patch namespace "$TENANT_NAMESPACE" \
  --type=merge --patch-file="$ROUTING_BACKUP/namespace-patch.json"
```

The policy replaces the old direct OCC API peer with the driver's Envoy peer;
it does not add a second ingress path. Require the target selector to remain
`openclaw.dev/workload-role: gateway`. If either patch conflicts, reread and
review both live resources before regenerating it. Keep the backup for recovery;
restore native authentication, Installation routing, and Namespace policy as a
coordinated change rather than mixing old and new authentication paths.

### Verify routing and file access

After applying the Helm and Installation changes, verify the actual resources:

```sh
kubectl -n openclaw-system get gateway oce-agent-gateways -o yaml
kubectl -n openclaw-system get issuer,certificate,securitypolicy
kubectl -n "$TENANT_NAMESPACE" get httproute
```

Require accepted/programmed routing, a ready certificate, and accepted security
policy before testing native access. Verify missing/invalid service keys and
spoofed identity headers cannot reach native administration. Then use OCC's
four-file GET/PUT routes and a fresh native session to prove consumption; a
ready proxy alone is insufficient. In the Console, save a harmless temporary
change, discard an unsaved editor change, and reload to confirm persisted
contents. Restore the exact original file and compare its hash. If the file
was absent, remove only your newly created proof file after checking its exact
contents, then verify `NOT_FOUND` again. Read after an uncertain write outcome
before deciding whether to retry. Verify existing PVC identities, sessions,
and configured channel health after cutover.

### Rotate the service key and certificates

For service-key rotation, first add the new key under another client ID in the
Envoy Secret while keeping `occ` unchanged. After Envoy accepts it, move the new
key to `occ` while retaining the previous value under a different client ID.
Wait for the API's mounted Secret to update and verify a new request, then
remove the previous key and verify rejection. OCC reads the file for each
operation; it does not require a restart for key rotation.

The generated root has a ten-year lifetime and reuses its private key on
renewal. The leaf has a 90-day lifetime; cert-manager renews both certificates
30 days before expiry. Automatic setup does not coordinate CA rollover:
preserve the CA Secret, plan backups, and control trust changes. For a CA key
replacement, distribute an overlapping old/new public trust bundle before
switching Envoy's certificate, restart the API to load that bundle, and remove
the old root only after no serving certificate depends on it.

cert-manager renews the server leaf certificate automatically. New WSS
connections continue using normal CA and hostname verification without an OCC
restart while the issuing CA remains trusted. Replacing a private root bundle
requires restarting the API because Node reads `NODE_EXTRA_CA_CERTS` at process
startup. This integration uses API-key authentication over WSS; the pinned
native client does not expose mTLS client-certificate options.

### Troubleshooting

Without routing/key configuration, with an unsupported Driver, or when the
proxy/native gateway is unavailable, file requests return
`503 DEPENDENCY_UNAVAILABLE`. For `HTTPRoute Accepted=False` with `NotAllowedByListeners`, compare the
Gateway listener's namespace selector with the tenant Namespace labels and
follow [existing Namespace reconciliation](#enable-routing-for-existing-namespaces-and-agents).
An accepted route with unreachable backends requires checking the Envoy and
tenant policies together, including their selectors and translated ports.
A genuine missing native file returns `404 NOT_FOUND`; it does not establish
that gateway access failed. Do not overwrite a file merely to clear a Console
missing-file notice. Docker does not implement this automatic routing path. The [Agents reference](../../reference/agents.md#workspace-files) owns file
limits and authorization behavior; [testing](../../testing/README.md) distinguishes live
integration evidence from rendering and conformance checks.
