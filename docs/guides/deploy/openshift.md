---
tags: [human_verified]
last_verified: "2026-11-18"
---

# Prepare OCE for OpenShift

Use this page for OpenShift-specific networking and routing prerequisites before the shared
[Kubernetes control plane installation](production-installation.md).
Start with [cluster, storage, and network preparation](kubernetes.md).

## Requirements

- The shared [Kubernetes requirements](production-installation.md#requirements).
- The `oc` CLI, an explicitly selected cluster context, and access to inspect DNS Pods and Kubernetes API endpoints.

## Configure DNS and API access

On OpenShift, select the actual DNS backend namespace and Pod labels; the
[Helm DNS grants](../../reference/settings/production.md#required-production-controller-environment)
permit both Service and backend ports. Helm merges `dns.podLabels` into the chart
default `k8s-app: kube-dns`. Profile rendering removes that default for you. In
hand-written values, set `dns.podLabels.k8s-app: null` when the DNS Pods lack that
label.

On OpenShift with OVN-Kubernetes, the CNI applies egress policy after the
`kubernetes` Service translates port 443 to the API server port, usually 6443.
Set Helm `cluster.cidrs` to the API server endpoint IPs and `cluster.port` to
that port so initialization can reach the API. In a profile input, set
`controlPlane.clusterCidrs` and `controlPlane.clusterPort`. API and worker Pods
have unrestricted egress. List the endpoints with
`oc get endpoints kubernetes -n default`.

## Install Envoy Gateway

[Workspace routing](workspace-routing.md#requirements) needs Envoy Gateway. On
OpenShift 4.19 or later, OpenShift owns the Gateway API CRDs. The Envoy chart
cannot apply its own copy: Helm fails with a field conflict with
`ingress-operator`. Envoy Gateway also runs as UID 65532, which `restricted-v2`
refuses. A cluster administrator installs it as follows (chart v1.6.7):

```sh
OC="oc --kubeconfig $KUBECONFIG_FILE --context $CONTEXT"
helm template eg-crds oci://docker.io/envoyproxy/gateway-crds-helm --version v1.6.7 \
  --set crds.gatewayAPI.enabled=false --set crds.envoyGateway.enabled=true \
  | $OC apply --server-side -f -
$OC create namespace envoy-gateway-system
for sa in envoy-gateway eg-gateway-helm-certgen; do
  $OC adm policy add-scc-to-user nonroot-v2 -z "$sa" -n envoy-gateway-system
done
helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.6.7 \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  -n envoy-gateway-system --skip-crds
```

Envoy Gateway also creates a ServiceAccount for the proxy of the OCE Gateway.
Its name is truncated for long Gateway names, so read it from the proxy
Deployment. After the chart creates the Gateway, set `GATEWAY_NAMESPACE` and
`GATEWAY_NAME` to its values and grant `nonroot-v2` to that account:

```sh
PROXY_SA=$($OC get deployment -n envoy-gateway-system \
  -l "gateway.envoyproxy.io/owning-gateway-namespace=$GATEWAY_NAMESPACE,gateway.envoyproxy.io/owning-gateway-name=$GATEWAY_NAME" \
  -o jsonpath='{.items[0].spec.template.spec.serviceAccountName}')
$OC adm policy add-scc-to-user nonroot-v2 -z "$PROXY_SA" -n envoy-gateway-system
```

Without the grant, the proxy Pods are refused, the Gateway stays
`Programmed=False`, and an Agent revision waits at `AGENT_GATEWAY_UNAVAILABLE`.
Each grant lets that account run as any non-root UID. Do not grant it to other
accounts.

## Continue installation

Save the DNS selectors and API endpoint settings in your profile input or
protected Helm values. Continue with [control plane installation](production-installation.md)
in the same operator shell.

If the installation runs an initialization Job, check DNS from its Pod while the
Job runs. Check the API, worker and enabled supporting workloads as they start.
For each workload, verify that DNS resolution works over UDP and TCP. Confirm
that DNS traffic to a Pod outside the configured DNS selectors is denied.
