# Configure private Agent workspace routing

Manage Agent workspace files through OCC and Console using private routing.
Complete [production installation](production-installation.md), retaining its
protected Helm values, Installation YAML and Kubernetes context. EKS also needs
[strict mode](eks.md#enable-console-workspace-files).

OCC API/worker Pods must share the private Envoy Service's cluster; OCC in
Compose needs [hybrid routing](local-compose-kubernetes.md). Enabling a Helm
value alone does not connect a Compose API to the private Service.
The chart defaults to `gatewayRouting.enabled: false`, unlike production examples.
Install routing controllers, create the service-key Secret, and configure Helm,
Installation settings and [proxy trust](#configure-native-gateway-authentication)
before deploying. Console starters omit Driver-owned authentication.

## Runtime prerequisite for separate storage

Dedicated Codex requires private routing, native node enrollment and matching
OpenClaw workspace changes in Gateway/Harness images, including plugin attachments.
[Storage integration #76](https://github.com/openclaw/openclaw-enterprise/issues/76)
tracks the current runtime PRs and remaining limits. The Codex plugin must include
the matching attachment changes. Compute rejects dedicated runtime versions
without routing or an enrollment client before provisioning workloads.

These prerequisites describe the [Kubernetes Codex implementation](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#shared-contracts-and-the-codex-implementation).
They do not establish support for a dedicated OpenClaw remote worker. Embedded
Harnesses also support direct access.

Build Gateway/Harness images from [pinned runtime sources](../../../deploy/runtime/README.md);
controller updates do not update installed images. Verify enrollment, workspace
access and a real model turn before accepting deployment.

## Agent workspace files

OCC manages `AGENTS.md`, `SOUL.md`, `IDENTITY.md` and `USER.md` at
`wss://<hostname>/namespaces/<namespaceId>/agents/<agentId>`.
Compute creates each HTTPRoute; new Agents need no endpoint map or API restart.
See [routing ownership, credentials and TLS](../../reference/gateway-routing.md).

### Requirements

Provide Kubernetes enforcing NetworkPolicies,
[Envoy Gateway](https://gateway.envoyproxy.io/docs/tasks/quickstart/) (tested v1.6.7),
Gateway API CRDs, [cert-manager](https://cert-manager.io/docs/installation/) and an
Envoy GatewayClass. Operate these controllers separately. The chart defaults create
a namespaced SelfSigned Issuer, root CA Certificate, CA Issuer, shared Gateway,
ClusterIP EnvoyProxy and API-key SecurityPolicy; cert-manager generates certificates.
There is no public listener. Chart operators need infrastructure permissions;
the OCC API does not.

The chart gives Envoy a stable Service name; Pod DNS search resolves its `.svc`
hostname, which the certificate and Compute routes share
([endpoint and route](../../reference/gateway-routing.md#endpoint-and-route)).

### Configure private routing

Use the dedicated kubeconfig and reviewed context from production installation
for every command below:

```sh
export KUBECONFIG="$KUBECONFIG_FILE"
kubectl config use-context "$CONTEXT"
```

Create a dedicated service key with no trailing newline, then create its Secret
in the controller namespace. Keep the key in the protected input directory from
the production installation, outside Git. If the Installation already has a
service-key Secret, reuse it; follow the
[rotation procedure](#rotate-the-service-key-and-certificates) to change a live key:

```sh
umask 077
test -e "$OCC_INPUT_DIRECTORY/gateway-api-key" || \
  python3 -c 'import secrets; print(secrets.token_hex(32), end="")' \
    > "$OCC_INPUT_DIRECTORY/gateway-api-key"
kubectl -n openclaw-system create secret generic occ-private-gateway-key \
  --from-file=occ="$OCC_INPUT_DIRECTORY/gateway-api-key"
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
If you override `gatewayRouting.envoyHttpsTargetPort` (default `10443`),
set the same value in Helm and the Installation Compute configuration.
If the external load balancer exposes HTTPS on a port other than `443`, set
`gatewayRouting.endpointPort` in the Installation Compute configuration and
forward that port to the Gateway HTTPS listener. Helm does not create this
external port mapping.

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
TLS Secret; it may share a Secret with the database and repository CA settings.

For custom DNS, set the same `gatewayRouting.hostname` in Helm and Compute and
make it resolve to Envoy for both OCC and Harness workloads. Use a lowercase DNS hostname without a port
or path, at most 253 characters with labels at most 63; both inputs refuse other
spellings before startup. Shorthand IPv4 is refused. The selected issuer must be able to issue
for that name. A custom hostname can use either the automatic CA or an existing
issuer; it does not change CA ownership.

The chart's `tenantGatewayPort` must match Compute's `network.gatewayPort`.
Remove `network.gatewayClients` when enabling routing. Compute derives the
Envoy peer from `gatewayRouting` and rejects explicit gateway clients in this mode.
Retain the Installation's other Compute settings. The worker requires tenant-local
HTTPRoute permissions from the chart's worker role; the API needs no route
writes or gateway Pod/exec access.

### Configure native gateway authentication

These settings configure OCC's machine-identity route. Separate human identities
require an operator-managed authenticated ingress and network access; see the
[human ingress contract](../../reference/drivers/kubernetes-compute/gateway-authentication.md).
Human traffic must not use the machine-identity route. No OCE user account is
required for the separate ingress.

> **Warning: shared human access is for trusted teammates only.** Review the
> [shared-Agent trust boundary](../../reference/drivers/kubernetes-compute/gateway-authentication.md)
> before adding human identities. Removing login access or changing a role does
> not guarantee that accepted work stops. Whether IdP account disablement or
> group-membership removal blocks new admission depends on your ingress's
> token/session revalidation policy; OCE supplies no revocation deadline.

Set the actual Envoy socket source CIDRs in the trusted Installation YAML:

```yaml
drivers:
  compute:
    configuration:
      network:
        gatewayTrustedProxyCidrs:
          - "<actual-proxy-source-cidr>"
```

Keep the existing network settings alongside this field. Replace the placeholder
with CIDRs verified for your cluster; there is no production default. Restart
the API and worker after changing their startup configuration.

Compute renders trusted-proxy authentication, machine
`x-occ-identity: occ-workspace-files`/`operator.admin`, proxy trust and real-IP
fallback. Configurations/Presets may omit these fields; matching values are accepted.
Unsupported authentication or conflicting tenant trust settings fail deployment.
See the [authentication contract](../../reference/drivers/kubernetes-compute/gateway-authentication.md).

For optional operator loopback access, set `gateway.auth.password` to the
environment SecretRef
`{ source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" }`.
Do not use a plaintext password. See [Kubernetes gateway credentials](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials)
and [verify a model response](../operate/model-verification.md).

Compute refuses native `requiredHeaders` naming `x-forwarded-for` or another header
the route removes. Envoy authenticates the service key, removes it, overwrites the native
identity header, and sets `X-Real-IP` from its direct OCC connection. That
fallback works when OCC and Envoy share a Pod CIDR. Do not fabricate an address
or allow direct workload access to work around an attribution failure.

NetworkPolicy must restrict OCC's native gateway ingress path to those Envoy Pods.
A separate human proxy requires the additional exact-peer policy described in
the [human ingress contract](../../reference/drivers/kubernetes-compute/gateway-authentication.md). The
chart restricts proxy ingress to OCC API/worker Pods and Harness Pods in attached
tenant namespaces, and permits its required routing
and control-plane traffic. A trusted source CIDR by itself is not sufficient
isolation. Restrict Kubernetes writes to the Gateway, attached HTTPRoutes,
SecurityPolicy, native configuration, and namespace attachment labels to trusted
operators and the scoped worker. Untrusted tenants must not be able to replace
route authentication or attach their own routes.

The chart mounts the service key into the API and worker and sets
`OCC_GATEWAY_API_KEY_PATH`; CA trust follows the
[TLS lifecycle](../../reference/gateway-routing.md#tls-and-certificate-lifecycle).
The Harness receives only its node setup code and the public CA bundle.
The service key is an Installation-wide native administrative
credential; do not reuse a Better Auth signing key or model-provider token.
OCC still checks the human caller's exact Agent `read` or `operate` permission.
Routing-enabled workers also require tenant-local Secret get/create/update/delete
for node enrollment.

### Enable routing for existing Namespaces and Agents

Plan a maintenance window for the gateway restart and Namespace-wide ingress
change. Preserve Agent IDs, Configuration IDs, PVC/PV identities, workspace
contents, session IDs, and model/channel credentials. Back up the current native
Configuration, selected version, protected Helm/Installation inputs, and the
namespace resources before changing them. Check whether other Agents share the
Configuration before replacing its values.

1. Apply the matching Helm values and updated Installation startup Secret using
   the [production installation procedure](production-installation.md). Preserve
   the existing auth/database and routing-key Secrets, generated CA Secrets, and
   prepared bootstrap volume; do not rerun fresh-volume preparation. Restart both
   API and worker to load the new startup configuration. Wait for the private Gateway, certificates, and policy.
2. For each Agent being routed, request
   `POST /namespaces/:namespaceId/agents/:agentId/deploy` for the same Agent.
   Retain and poll the returned deployment ID. Do not recreate the Agent or
   retire its current version before successful cutover: its PVCs belong to
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

Select the Gateway's physical Kubernetes namespace, distinct from its OCC
Namespace ID: the Agent's tenant namespace, or for dedicated execution in the
two-cluster profile, its `oce-gateways-<hash>` namespace in the control cluster.
The commands below use
`GATEWAY_NAMESPACE` for that target. This repairs routing on an already placed
Gateway; it does not migrate a Gateway or move its PVC between namespaces. The following uses the same Gateway name/namespace as the examples
above, `jq`, and the protected directory from production installation:

```sh
set -e
export GATEWAY_NAMESPACE='<existing-gateway-kubernetes-namespace>'
export NAMESPACE_ID='<existing-occ-namespace-id>'
ROUTING_BACKUP="$(mktemp -d "$OCC_INPUT_DIRECTORY/workspace-routing.XXXXXX")"
export ROUTING_BACKUP
kubectl get namespace "$GATEWAY_NAMESPACE" -o json > "$ROUTING_BACKUP/namespace.json"
kubectl -n "$GATEWAY_NAMESPACE" get networkpolicy allow-gateway-ingress -o json \
  > "$ROUTING_BACKUP/ingress.json"
kubectl -n openclaw-system get gateway oce-agent-gateways -o json \
  > "$ROUTING_BACKUP/gateway.json"
jq -e --arg id "$NAMESPACE_ID" \
  '(.metadata.labels["openclaw.dev/namespace"] == $id or .metadata.labels["openclaw.dev/gateway-namespace"] == $id) and
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
kubectl -n "$GATEWAY_NAMESPACE" patch networkpolicy allow-gateway-ingress \
  --type=merge --patch-file="$ROUTING_BACKUP/ingress-patch.json"
kubectl patch namespace "$GATEWAY_NAMESPACE" \
  --type=merge --patch-file="$ROUTING_BACKUP/namespace-patch.json"
```

The policy replaces the old direct OCC API peer with the driver's Envoy peer;
it does not add a second ingress path. Require the target selector to remain
`openclaw.dev/workload-role: gateway`. If either patch conflicts, reread and
review both live resources before regenerating it. Keep the backup for recovery;
restore native authentication, Installation routing, and Namespace policy as a
coordinated change rather than mixing old and new authentication paths.

### Verify routing and file access

After applying the Helm and Installation changes, check the resources:

```sh
kubectl -n openclaw-system get gateway oce-agent-gateways -o yaml
kubectl -n openclaw-system get issuer,certificate,securitypolicy
kubectl -n "${GATEWAY_NAMESPACE:?select the Agent Gateway target}" get httproute
```

Wait for the Gateway to report `Accepted` and `Programmed`, the certificate to
report `Ready`, and the security policy and Agent HTTPRoute to report
`Accepted`. Check that a missing or invalid service key and a spoofed identity
header cannot reach native administration.

Verify [workspace API](../../reference/agents.md#workspace-files)/Console access
with an existing file: save a harmless change, discard another unsaved edit and
reload. Confirm the Agent reads the saved change in a fresh native session.
Restore original contents and compare hashes. The API cannot delete files:
create none unless you can restore their absence. After uncertain writes, read
before retrying. Verify existing PVC identities, sessions and channels after cutover.

### Rotate the service key and certificates

For service-key rotation, first add the new key under another client ID in the
Envoy Secret while keeping `occ` unchanged. After Envoy accepts it, move the new
key to `occ` while retaining the previous value under a different client ID.
Wait for the API's mounted Secret to update and verify a new request, then
remove the previous key and verify rejection. OCC reads the file for each
operation; it does not require a restart for key rotation.

The generated root has a ten-year lifetime and reuses its private key on
renewal. The leaf has a 90-day lifetime; cert-manager renews both certificates
30 days before expiry. Leaf renewal needs no OCC restart: new WSS connections
keep normal CA and hostname verification while the issuing CA remains trusted.

Automatic setup does not coordinate CA rollover: preserve the CA Secret, plan
backups, and control trust changes. For a CA key replacement, distribute an
overlapping old/new public trust bundle and restart the API to load it before
switching Envoy's certificate. Remove the old root only after no serving
certificate depends on it, including after a move to an external issuer, which
leaves the generated root Secret behind. Any private root bundle change requires an API
restart because Node reads `NODE_EXTRA_CA_CERTS` only at process startup.
With [private IdP trust](oidc-sign-in.md#trust-a-private-idp-ca), replace the API Pod
to rebuild its combined bundle. This
integration uses API-key authentication over WSS; the pinned native client does
not expose mTLS client-certificate options.

### Troubleshooting

| Symptom                                                           | What to check                                                                                                                                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `503 DEPENDENCY_UNAVAILABLE`                                      | Confirm routing and the service key are configured, the Compute Driver supports routing, and Envoy and the native gateway are reachable. The Docker Driver does not support this routing path.           |
| HTTPRoute reports `Accepted=False` with `NotAllowedByListeners`   | Compare the Gateway listener's namespace selector with the labels on the HTTPRoute's physical namespace. Follow [existing Namespace reconciliation](#enable-routing-for-existing-namespaces-and-agents). |
| HTTPRoute is accepted but the backend is unreachable              | Check the Envoy and tenant NetworkPolicies together, including their selectors and translated ports.                                                                                                     |
| `404 NOT_FOUND` and `The requested workspace file was not found.` | The native file is missing. Do not create or overwrite it just to clear the Console notice.                                                                                                              |
| `503 UNKNOWN_OUTCOME` after a write                               | Read the file and compare it with the intended write; if it matches, do not retry. If you cannot read it yet, wait or ask someone with Agent `read` permission. OCC does not replay the write.           |

The [Agents reference](../../reference/agents.md#workspace-files) lists file
limits and permissions. The [Kubernetes testing guide](../../testing/kubernetes.md#kubernetes-model-turns-and-secrets)
describes integration evidence.
