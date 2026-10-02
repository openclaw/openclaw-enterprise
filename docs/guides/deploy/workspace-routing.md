# Configure private Agent workspace routing

Private routing lets operators manage embedded and dedicated Agent workspace
files through OCC and the Console. Complete [production installation](production-installation.md),
retaining its protected Helm values, Installation YAML, and Kubernetes context.
On EKS, complete the [strict-mode prerequisites](eks.md#enable-console-workspace-files).

This procedure assumes OCC API and worker Pods run in the same Kubernetes
cluster as the private Envoy Service. For OCC in Compose, use the separate [local hybrid routing procedure](local-compose-kubernetes.md).
Enabling a Helm value alone does not connect a Compose API to the private Service.

Production examples enable routing; the chart defaults to
`gatewayRouting.enabled: false`. Install routing controllers, create the
service-key Secret, and configure Helm and Installation settings.
Console starters omit Driver-owned authentication. Configure the Installation’s
[proxy trust](#configure-native-gateway-authentication) before deploying.

## Runtime prerequisite for separate storage

The current dedicated Codex implementation requires private routing, native node enrollment, and
Gateway and Harness images containing the matching OpenClaw workspace changes.
[Storage integration #76](https://github.com/openclaw/openclaw-enterprise/issues/76)
tracks the current runtime PRs and remaining limits. The Codex plugin must include
the matching attachment changes. Compute rejects dedicated runtime revisions
without routing or an enrollment client before provisioning workloads.

These prerequisites describe the [Kubernetes Codex implementation](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#shared-contracts-and-the-codex-implementation).
They do not establish support for a dedicated OpenClaw remote worker.

Before creating a dedicated Agent, configure the service-key Secret and proxy
trust below. Embedded Harnesses also support direct access.

Build the matching Gateway and Harness images from the repository's pinned
runtime sources; see the [runtime image procedure](../../../deploy/runtime/README.md).
Updating the controller alone does not update installed images. Verify native
node enrollment, workspace access, and a real model turn with your selected
images before accepting the deployment.

## Agent workspace files

OCC supports four files: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`.
Kubernetes Compute provisions each Agent’s HTTPRoute at a shared private hostname:
`wss://<hostname>/namespaces/<namespaceId>/agents/<agentId>`. Adding an Agent
requires neither an endpoint map nor an API restart. See the
[Envoy routing reference](../../reference/gateway-routing.md) for resource
ownership, credentials, and TLS.

### Requirements

You need Kubernetes with enforced NetworkPolicies,
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
TLS Secret.

For custom DNS, set the same `gatewayRouting.hostname` in Helm and Compute and
make it resolve to the Envoy Service. The selected issuer must be able to issue
for that name. A custom hostname can use either the automatic CA or an existing
issuer; it does not change CA ownership.

The chart's `tenantGatewayPort` must match Compute's `network.gatewayPort`.
Remove `network.gatewayClients` when enabling routing. Compute derives the
Envoy peer from `gatewayRouting` and rejects explicit gateway clients in this mode.
Retain the Installation's other Compute settings. Restart the API and worker
when changing their Installation startup configuration. The worker requires tenant-local
HTTPRoute permissions from the chart's worker role; the API needs no route
writes or gateway Pod/exec access.

### Configure native gateway authentication

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

Kubernetes Compute renders native trusted-proxy authentication, its fixed
`x-occ-identity: occ-workspace-files` identity with `operator.admin`, proxy trust,
and real-IP fallback. Agent Configurations and Presets can omit those fields.
Unsupported authentication fields or conflicting tenant trust settings fail
deployment. Matching explicit settings are accepted. See the [gateway authentication contract](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#gateway-authentication).

For optional operator loopback access, set `gateway.auth.password` to the
environment SecretRef
`{ source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" }`.
Do not use a plaintext password. See [Kubernetes gateway credentials](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials)
and [verify a model response](../operate/model-verification.md).

Do not require `x-forwarded-for` in native `requiredHeaders`: the route removes
it. Envoy authenticates the service key, removes it, overwrites the native
identity header, and sets `X-Real-IP` from its direct OCC connection. That
fallback works when OCC and Envoy share a Pod CIDR. Do not fabricate an address
or allow direct workload access to work around an attribution failure.

NetworkPolicy must restrict native gateway ingress to those Envoy Pods. The
chart restricts proxy ingress to OCC API/worker Pods and Harness Pods in attached
tenant namespaces, and permits its required routing
and control-plane traffic. A trusted source CIDR by itself is not sufficient
isolation. Restrict Kubernetes writes to the Gateway, attached HTTPRoutes,
SecurityPolicy, native configuration, and namespace attachment labels to trusted
operators and the scoped worker. Untrusted tenants must not be able to replace
route authentication or attach their own routes.

The chart mounts the service key into the API and worker and sets
`OCC_GATEWAY_API_KEY_PATH`. Automatic CA mode projects only the root Secret's
public `tls.crt` as `ca.crt` and sets `NODE_EXTRA_CA_CERTS`; the signing key is
never mounted into OCC. The Pod waits for that Secret before starting. With an
explicit issuer, both use the optional configured CA bundle instead.
The Harness receives only its node setup code and the public CA bundle.
The service key is an Installation-wide native administrative
credential; do not reuse a Better Auth signing key or model-provider token.
OCC still checks the human caller's exact Agent `read` or `operate` permission.
Routing-enabled workers also require tenant-local Secret get/create/update/delete
for node enrollment. The required OC modules are merged;
matching runtime images and full Enterprise runtime verification are still required.

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
2. For each Agent being routed, request
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

Select the Gateway's physical Kubernetes namespace, distinct from its OCC
Namespace ID: the managed Gateway runtime namespace for dedicated execution,
or the tenant namespace for embedded execution. The commands below use
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

Verify the [OCC workspace-file API](../../reference/agents.md#workspace-files)
and Console with an existing file. Save a harmless temporary change, discard a
separate unsaved editor change, and reload to confirm the saved contents. Use
a fresh native session to check that the Agent reads the saved change. Restore
the exact original contents and compare their hash. The public API cannot
delete a workspace file, so do not create a missing file for this check unless
you have a separate way to restore its absence. Read after an uncertain write
before deciding whether to retry. After cutover, verify the existing PVC
identities, sessions, and any configured channels.

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

| Symptom                                                           | What to check                                                                                                                                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `503 DEPENDENCY_UNAVAILABLE`                                      | Confirm routing and the service key are configured, the Compute Driver supports routing, and Envoy and the native gateway are reachable. The Docker Driver does not support this routing path.           |
| HTTPRoute reports `Accepted=False` with `NotAllowedByListeners`   | Compare the Gateway listener's namespace selector with the labels on the HTTPRoute's physical namespace. Follow [existing Namespace reconciliation](#enable-routing-for-existing-namespaces-and-agents). |
| HTTPRoute is accepted but the backend is unreachable              | Check the Envoy and tenant NetworkPolicies together, including their selectors and translated ports.                                                                                                     |
| `404 NOT_FOUND` and `The requested workspace file was not found.` | The native file is missing. Do not create or overwrite it just to clear the Console notice.                                                                                                              |
| `503 UNKNOWN_OUTCOME` after a write                               | Read the file before deciding whether to repeat the write. OCC does not automatically replay it.                                                                                                         |

After `UNKNOWN_OUTCOME`, read the same file and compare its content with the
intended write. If it matches, do not retry. If you cannot read the file yet,
wait or ask someone with `read` permission on the Agent to check before deciding
whether to retry.

The [Agents reference](../../reference/agents.md#workspace-files) lists file
limits and permissions. The [Kubernetes testing guide](../../testing/kubernetes.md#kubernetes-model-turns-and-secrets)
describes integration evidence.
