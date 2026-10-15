# Connect a Compose control plane to Kubernetes Agents

Use this manual procedure for the Compose + k3d profile with
`OCC_DEVELOPMENT_SANDBOX_DRIVER=none`. It supplies the private route and node
enrollment required by Standard Codex while PostgreSQL, OCC and its worker
remain in Compose. Standard OpenClaw uses embedded compute.

The OpenShell Compose profile performs these routing steps during `dev-up`; do
not repeat them manually. This procedure is for one disposable Docker/k3d
installation. Keep its generated files private and retain the same state
directory, project and cluster for cleanup. Do not apply it to a shared cluster.

## Select the owned installation

Run from the checkout that built the installation, with its dependencies installed:

```bash
set -euo pipefail
umask 077
export HYBRID_STATE='/absolute/private/development-state'
export HYBRID_PROJECT='<generated Compose project>'
export HYBRID_CLUSTER='<owned k3d cluster>'
export KUBECONFIG="$HYBRID_STATE/kubeconfig"
export HYBRID_CONTEXT="k3d-$HYBRID_CLUSTER"
```

Check `state.json` for `computeDriver: kubernetes`, `sandboxDriver: none`, and the selected project and cluster. Use explicit `--context "$HYBRID_CONTEXT"` for Kubernetes commands. Preserve the default kubeconfig.

Inspect the owned node and `controller`, `worker-kubernetes`, and `postgres` containers with `docker inspect`. Record their IPv4 addresses on `<project>_development`. The node is `k3d-<cluster>-server-0`; all four must share this private network. Do not publish the routing NodePort on the host. Use the **worker-kubernetes** service when refreshing Kubernetes settings; the `worker` service belongs to the alternative Compose profile.

## Install routing prerequisites

Install cert-manager and Envoy Gateway as described in [private routing prerequisites](workspace-routing.md#requirements). The local launcher pins cert-manager 1.18.4 and Envoy Gateway 1.6.7 in `internal/occdev/gateway_k3d.go`; use those versions for the matching local workflow. Verify their download checksums against that source. Wait for their controller Deployments to become available.

K3s owns its Gateway API CRDs. Wait for `gatewayclasses`, `gateways`, `httproutes` and `referencegrants` under `gateway.networking.k8s.io` to be Established. Remove only those Gateway API CRDs from the Envoy installation manifest before server-side application; retain Envoy's own CRDs. Do not overwrite K3s-owned schemas with an older controller bundle.

Create `oce-system` and a GatewayClass named `eg` with `spec.controllerName: gateway.envoyproxy.io/gatewayclass-controller`. Wait for the GatewayClass's `Accepted` condition. Create the private routing key once:

```bash
test -e "$HYBRID_STATE/gateway-api-key" || \
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' \
  > "$HYBRID_STATE/gateway-api-key"
kubectl --context "$HYBRID_CONTEXT" -n oce-system create secret generic occ-private-gateway-key \
  --from-file=occ="$HYBRID_STATE/gateway-api-key"
```

For an existing Secret, follow [key rotation](workspace-routing.md#rotate-the-service-key-and-certificates) instead of replacing it opportunistically.

## Render only the routing resources

Create protected `routing-values.yaml` with the following shape. Replace every bracketed value with the actual installation value. The chart validates complete control-plane values during rendering, even when `--show-only` selects routing; the bootstrap, API, database and cluster fields below do not install those services in Kubernetes.

```yaml
images:
  controller: "<approved matching controller image>@sha256:<digest>"
auth:
  baseUrl: http://127.0.0.1:3000 # Use the actual published OCC port.
bootstrap:
  adminEmail: "<existing development administrator email>"
  password:
    claimName: bootstrap-password
api:
  clients:
    - namespace: envoy-gateway-system
      podLabels:
        app.kubernetes.io/name: envoy
database:
  cidrs: ["<Compose postgres IP>/32"]
cluster:
  cidrs: ["<k3d node IP>/32"]
  port: 6443
agentNativeAdmin:
  enabled: false
gatewayRouting:
  enabled: true
  gatewayClassName: eg
  gatewayName: openclaw-enterprise-agent-gateways
  hostname: "<k3d node container name>"
  serviceType: NodePort
  apiKeySecretName: occ-private-gateway-key
  remoteNodeCidrs:
    - "<Compose controller IP>/32"
    - "<Compose worker-kubernetes IP>/32"
    - "<k3d node IP>/32"
```

Render and inspect the resource kinds before applying. There must be no OCC Deployment or PostgreSQL workload in this output:

```bash
helm template openclaw-enterprise deploy/helm/openclaw-enterprise \
  --namespace oce-system -f "$HYBRID_STATE/routing-values.yaml" \
  --show-only templates/gateway-routing.yaml > "$HYBRID_STATE/routing.yaml"
kubectl --context "$HYBRID_CONTEXT" apply -f "$HYBRID_STATE/routing.yaml"
kubectl --context "$HYBRID_CONTEXT" -n oce-system wait \
  --for=condition=Programmed gateway/openclaw-enterprise-agent-gateways --timeout=180s
```

Inspect the generated EnvoyProxy's `spec.provider.kubernetes.envoyService.name`, then read that Service in `envoy-gateway-system`. Record the `nodePort` belonging to port 443. Read the generated root Certificate in `oce-system`; copy only its Secret's `tls.crt` to `gateway-ca.crt` in the private state directory. The root Secret name ends in `-root`, not `-root-ca`. Do not copy or expose `tls.key`.

The Docker network resolves the node container name for OCC, and k3d resolves it for native node enrollment. The listener certificate includes that exact hostname. Use the NodePort in OCC's endpoint configuration; keep the Envoy target port at its default 10443. TLS verification stays enabled.

## Connect OCC and provision a Namespace

Back up `installation.yaml` and `compose.yaml` privately. Merge these fields into `drivers.compute.configuration`:

```yaml
gatewayRouting:
  gatewayName: openclaw-enterprise-agent-gateways
  gatewayNamespace: oce-system
  envoyNamespace: envoy-gateway-system
  hostname: "<k3d node container name>"
  endpointPort: <actual HTTPS NodePort>
network:
  gatewayTrustedProxyCidrs: ["<actual node spec.podCIDR>"]
```

Preserve all other network settings, but remove the generated `network.gatewayClients` direct-client selection. Read the actual `spec.podCIDR`; do not assume a Pod subnet. Before configuring this trust, verify allowed and denied direct Pod traffic on the node, including a live control listener for the denied client. Use the [Kubernetes networking boundary](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking) when selecting the allowed client. A refused connection to an unready listener is not proof of enforcement. This is a single-node local trust boundary, not a shared-cluster policy.

Add read-only bind mounts for `gateway-api-key` and `gateway-ca.crt` to **both** Compose services `controller` and `worker-kubernetes`, under `/run/openclaw-development/`. Set these environment variables on both services:

```text
OCC_GATEWAY_API_KEY_PATH=/run/openclaw-development/gateway-api-key
NODE_EXTRA_CA_CERTS=/run/openclaw-development/gateway-ca.crt
```

If the services already need another private CA, use one reviewed combined public CA bundle rather than replacing its trust. Restart only the selected services:

```bash
docker compose -f "$HYBRID_STATE/compose.yaml" -p "$HYBRID_PROJECT" \
  up -d --no-deps --force-recreate controller worker-kubernetes
```

Create a new Namespace through OCC after it recovers. Its normal provisioning installs the routing-aware policies. Do not patch an earlier Namespace's policies by hand and count that as the ordinary workflow. Confirm both standard Presets in the new Namespace, then [create and deploy](../../reference/console/create-and-deploy.md) each Agent. Dedicated Codex must complete native node enrollment and a [real model turn](../operate/model-verification.md); deployment acceptance alone is insufficient.

Recheck the exact `/32` routing peers after container recreation. Update `routing-values.yaml` and reapply the routing template if the Docker addresses changed.

## Add repository and Slack services

For repositories, use the [standalone credential service](../repository-credentials/standalone-service.md) on the owned Compose network. Start ordinary protected-file configuration with `repository-credentials.js --config <path>`; the projected-inputs entrypoint is for Kubernetes Secret projections. Give only the worker its Unix control socket. Mount the immutable public registry and broker CA in the API and worker; keep the App key and TLS key in the broker.

Kubernetes consumers still require the [exact repository-service peer](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking). Expose the Compose broker through a namespace-scoped Service and a TCP relay Pod in `oce-system`. The relay forwards encrypted bytes to the exact broker container IP and port; it receives no keys or bearer material. Use the Service DNS name in the broker certificate and `publicOrigin`. Apply default-deny policies, permit only the selected Agent namespaces to the relay port, and permit the relay only to the broker's `/32` and HTTPS port. Configure `network.repositoryCredentials` with that exact namespace and relay Pod selector. Register the repository Backend and Agent binding through the [normal repository workflow](../repository-credentials.md#create-and-deploy-an-agent).

For Slack, run the bundled `apps/controller/src/slack-proxy.mjs` in a private container on the same owned Docker network, with no host-published port. Set both `runtime.channels.proxyUrl` in the Installation and `OCC_CHANNEL_DIRECTORY_PROXY_URL` on the Compose API to its exact literal IPv4 endpoint. Restart `controller` and `worker-kubernetes`, then deploy the Slack Agent. Follow [both proxy checks](../integrations/slack.md#configure-both-slack-proxies). Embedded OpenClaw does not support external channel credentials in this topology; use dedicated Codex for this supported Slack path.

## Verify and recover

The development console remains at its loopback HTTP URL. This profile does not provide the Kubernetes-only shared-session native-admin browser domain. For native access, use the [optional loopback gateway password](production-tui.md) and a local forward to the exact Agent gateway. A browser needs a trusted local HTTPS endpoint, its exact origin in `gateway.controlUi.allowedOrigins`, and that gateway password. Use a local TLS relay and import only its public CA; do not disable browser certificate verification. In the native connection screen, **Change** opens the credential field, then **Connect** authenticates the optional password.

Clone repositories under the Agent's persistent workspace, not `/tmp`: the runtime's temporary volume is bounded to 64 MiB and exceeding it evicts the Pod. A shallow clone avoids downloading unnecessary history.

If a model/tool workload is `OOMKilled`, raise the Installation's Gateway or Harness memory limit (`resources.gateway` or `resources.agent`) and deploy a new revision; the 3 GiB and 6 GiB defaults are not a guarantee for repository workloads. Preserve the failed revision and actual error. If a persisted owner lease prevents restart after eviction, verify the previous owner has stopped and allow its lease to expire before retrying. The pinned runtime uses a five-minute lease; kubelet restart backoff can add delay. Do not delete lease records to force a pass.

Before cleanup, stop repository-bound Agents and confirm their broker sessions are disposed. Keep the broker and state if any credential cleanup is pending or uncertain. See [local repository cleanup](local-repository-credentials.md). Then use the original profile's `dev down`; remove only additional services and public CA trust entries created for this installation.
