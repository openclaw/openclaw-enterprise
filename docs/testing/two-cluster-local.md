# Validate OCE across two local clusters

This experimental profile installs the complete OCE control plane in one cluster
and dedicated Codex Harnesses in another. It uses the production controller image,
PostgreSQL roles, migration/bootstrap Job, API, worker, and normal Agent APIs.
Embedded execution, cloud provisioning, and repository credential delivery are
outside this profile. The repository credential service currently assumes
cluster-local reachability; two-cluster admission rejects it explicitly. Keep the
implementation draft until runtime and failure-path acceptance are complete.
Earlier two-cluster results used the previous runtime and storage behavior; rerun
this profile against the current controller and runtime before claiming acceptance.

## Prepare isolated infrastructure

Use two disposable k3d clusters with Kubernetes 1.35 or later, distinct Pod and
Service CIDRs, enforcing NetworkPolicies, and explicit loopback kubeconfigs.
Keep the default Docker context and kubeconfig unchanged. For example, use
`10.60.0.0/16` and `10.61.0.0/16` in CP, and `10.62.0.0/16` and `10.63.0.0/16`
in DP. A shared Docker network supplies reachable node addresses; it does not
share Kubernetes APIs, storage, credentials, or tenant namespaces.

From the repository root, create fresh clusters on an explicitly selected local
Docker context. The context must already refer to your disposable Linux VM;
these commands do not create a VM or switch your default context. Use unused
cluster/network names and available loopback ports:

```sh
umask 077
export OCE_DOCKER_CONTEXT='your-isolated-local-context'
export OCE_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oce-two-cluster.XXXXXX")"
OCE_DOCKER_SOCKET="$(docker context inspect "$OCE_DOCKER_CONTEXT" \
  --format '{{.Endpoints.docker.Host}}')"
case "$OCE_DOCKER_SOCKET" in unix://*) ;; *) exit 1 ;; esac
k3d_local() {
  env -u DOCKER_CONTEXT DOCKER_HOST="$OCE_DOCKER_SOCKET" k3d "$@"
}
OCE_K3S_IMAGE='rancher/k3s@sha256:59fe491fd3b73204e499e40b325240d85c42c7189c3ae50150d37b78243f3b32'
docker --context "$OCE_DOCKER_CONTEXT" network create oce-two-cluster-local
k3d_local cluster create openclaw-k8s-local-cp \
  --image "$OCE_K3S_IMAGE" --network oce-two-cluster-local \
  --api-port 127.0.0.1:56641 --servers 1 --agents 0 --no-lb \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false \
  --k3s-arg '--disable=traefik@server:*' \
  --k3s-arg '--cluster-cidr=10.70.0.0/16@server:*' \
  --k3s-arg '--service-cidr=10.71.0.0/16@server:*'
k3d_local cluster create openclaw-k8s-local-dp \
  --image "$OCE_K3S_IMAGE" --network oce-two-cluster-local \
  --api-port 127.0.0.1:56642 --servers 1 --agents 0 --no-lb \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false \
  --k3s-arg '--disable=traefik@server:*' \
  --k3s-arg '--cluster-cidr=10.72.0.0/16@server:*' \
  --k3s-arg '--service-cidr=10.73.0.0/16@server:*'
k3d_local kubeconfig get openclaw-k8s-local-cp > "$OCE_TEST_DIR/cp.kubeconfig"
k3d_local kubeconfig get openclaw-k8s-local-dp > "$OCE_TEST_DIR/dp.kubeconfig"
kubectl --kubeconfig "$OCE_TEST_DIR/cp.kubeconfig" label \
  node k3d-openclaw-k8s-local-cp-server-0 oce-role=control-plane
kubectl --kubeconfig "$OCE_TEST_DIR/dp.kubeconfig" label \
  node k3d-openclaw-k8s-local-dp-server-0 oce-role=agents
```

This creates only the infrastructure. Complete the chart, database, TLS,
credentials and bootstrap steps below before running the API/worker test.
Keep the private directory: its administrative kubeconfigs are not workload
credentials and must not enter Git or the runtime image.

On a laptop, give the selected Linux VM sufficient disk capacity for duplicate
containerd imports of real runtime images. An isolated 8-CPU, 16-GiB RAM,
128-GiB-disk VM was used for the first experiment. Inspect available physical
capacity before creating it; do not resize or clean unrelated environments.

Install Envoy Gateway in both clusters and cert-manager in CP. The initial
experiment used Envoy Gateway 1.6.7 and cert-manager 1.18.4. Provide RWO
storage independently in each cluster: a SQLite-compatible private Gateway
StorageClass in CP and an ordinary Harness workspace StorageClass in DP. Gateway
and Harness never share a volume. Harness revision replacement stops the prior
workload before the successor mounts its workspace. Replacement has a downtime
window, including when invalid successor credentials prevent startup.

Keep local DNS settings across node restarts. On each **owned test node only**,
create `coredns.yaml.skip` under `/var/lib/rancher/k3s/server/manifests/` after
CoreDNS has installed. K3s supports [skip files](https://docs.k3s.io/installation/packaged-components)
to stop reapplying an AddOn without deleting its existing resources. This is
disposable k3d fixture preparation, not a production DNS configuration procedure.

Import approved immutable controller/runtime images into their respective
clusters. Install the configured Codex localhost seccomp profile on DP nodes
using the reviewed [sandbox procedure](kubernetes.md). Do not disable AppArmor,
seccomp, or Pod security to make a sandbox probe pass.

The current runtime recipe was built and tested in a stock Debian 13 Lima VM.
The reviewed helper's successful sandbox write, RuntimeDefault denial, and
missing-profile rejection all passed there. The initial Ubuntu VM denied
Bubblewrap network-namespace setup through host AppArmor. Select a compatible
host and run the probes; a running container alone does not qualify the sandbox.

## Configure the network and credentials

All remote traffic uses verified HTTPS. Operators provide reachable DNS names,
certificates, observed source/destination CIDRs, and cluster API access. No
cluster-local `.svc` address crosses the cluster boundary.

| Connection                         | Authentication and endpoint                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| OCC API/worker → DP Kubernetes API | Separate scoped kubeconfig identities with verified API CA                                                 |
| CP Gateway → DP Harness            | `wss://<harness-host>/namespaces/<namespace-id>/agents/<agent-id>`; exact-Agent app-server token           |
| CP Gateway → DP plugin status      | HTTPS on the same Agent route plus `/plugin-status`; revision-scoped HMAC derived from the transport token |
| DP workspace node → CP Gateway     | Existing node-only enrollment and device identity over the CP `/node` route                                |

Create a TLS Secret in the DP system namespace. Install
`deploy/helm/openclaw-execution` with `routing.hostname`, `gatewayClassName`,
`tlsSecretName`, and `controlPlaneCidrs`. For k3d, `serviceType: LoadBalancer`
uses its service load balancer. The chart creates component ServiceAccounts,
namespace-level ClusterRoles and bindings, tenant-role definitions, Gateway API
resources, and the exact Envoy NetworkPolicy. It does not grant tenant access
or issue cluster credentials.

Provision distinct DP API and worker kubeconfigs using these ServiceAccounts.
Store them in separate CP Secrets, each with a `kubeconfig` key. Cluster
administrators own credential issuance, rotation, and exact tenant grants;
neither worker gains RoleBinding-write or impersonation permission.

Add to the Compute configuration in the ordinary Installation startup file:

```yaml
executionCluster:
  authentication:
    mode: kubeconfig
    kubeconfigPath: /etc/openclaw/execution/kubeconfig
    context: execution
  harnessRouting:
    hostname: harness.example.test
    gatewayName: oce-harnesses
    gatewayNamespace: openclaw-system
    envoyNamespace: envoy-gateway-system
  network:
    dns:
      namespace: kube-system
      podLabels: { k8s-app: kube-dns }
    harnessEndpointCidrs: ["<DP ingress destination CIDR>"]
    gatewayEndpointCidrs: ["<CP ingress destination CIDR>"]
    pluginStatusProxySourceCidrs: ["<DP API proxy source CIDR>"]
  caBundle: |
    <public DP certificate authority PEM, if privately issued>
```

The existing `authentication`, `network`, and `gatewayRouting` settings describe
CP. Both route configurations need explicit hostnames. Supply only public CA
certificates in `caBundle`; private keys stay with their ingress owner.

Enable the CP chart's `executionCluster`, supply `apiKubeconfigSecretName`,
`workerKubeconfigSecretName`, `apiCidrs`, and `apiPort`, and configure
`gatewayRouting.remoteNodeCidrs` for the observed DP source addresses. The API
and worker mount different Secrets at the common configured path. Workloads
receive neither kubeconfig. Keep canonical model/channel/transport Secrets in CP;
only selected model and transport material is delivered to revision-owned DP
Secrets. Redeployment refreshes that material.

For local DNS, use the supported `coredns-custom` ConfigMap and a separate
`*.server` zone. k3s manages `NodeHosts` and can remove manual changes there.
Resolve the CP Gateway hostname to its Service IP within CP and to its reachable
ingress address within DP. Preserve the same hostname and certificate identity.
Restart CoreDNS after installing the new custom zone and verify both names from
the actual controller and runtime Pods before creating Agents. An accepted
ConfigMap update does not mean its DNS records are already being served.

## Install and exercise the platform

Follow [production installation](../guides/deploy/production-installation.md) for
PostgreSQL, limited roles, private bootstrap output, and the CP Helm release.
Prepare the bootstrap PVC ownership **before** initialization. If initialization
fails, confirm commit state and follow the documented bootstrap recovery;
do not reset the database or delete protected output automatically.

Use the normal Namespace and Agent APIs. Grant two DP tenant bindings using
`<execution-release>-execution-tenant-worker` and `-execution-tenant-api`; grant
the three CP bindings from [Agent preparation](../guides/deploy/production-agents.md#grant-tenant-rolebindings).
Wait for Namespace `ready`. Deployment status `running` means reconciliation is
in progress; wait for `succeeded` before asserting readiness.

The real integration accepts a private JSON fixture file containing `apiUrl`
(loopback), `serviceKeyFile`, `dockerContext` (an explicit local Unix-socket
context), `agentConfiguration` (the dedicated native
Configuration create body), and `control`/`execution` objects. Each object has
`kubeconfigPath`, `kubernetesContext`, `release`, and `systemNamespace`.
With an authorized model key already in the environment, run:

```sh
OCC_TEST_TWO_CLUSTER_CONFIG=/private/path/two-cluster.json \
  node --test tests/integration/kubernetes-two-cluster-real.test.mjs
```

The selected test fails on missing inputs. It creates its own Namespace, grants
tenant roles, uses normal API credential admission and deployment, verifies
workspace RPC, recreates the exact Harness Pod, replaces a revision, and deletes
both physical targets. Successful runs remove their resources. Failed runs
retain their test Namespace for diagnosis; delete its Agent, Configuration, and
Secret and any seeded Presets through the API before deleting the Namespace.
The outage case stops and restores the selected DP k3d node, so do not run other
tests against that cluster concurrently. It validates the exact container and
cluster identity before stopping it and registers a restoration cleanup.

Earlier API/worker testing passed without skips in 238 seconds:
placement, workspace RPC, Pod reconnect, stop/resume, invalid-key rejection and
correct-key recovery, concurrent candidate grants, revision replacement and
grant cleanup, real model-driven shell execution, a short DP outage, and deletion
of both tenant namespaces. The shell result was independently read from the DP
workspace. The controller production image included the candidate-policy fix,
manifest `sha256:37305bba4beb2d9f8fab4c7088dd4b701e2f47806485a0c64bd29e6753070ac5`.
Initial workspace delivery also passed with OCE's exact defaults identity and
caller-supplied `USER.md` content. A retained second Agent served another model
reply after the earlier outage while its setup code was still valid. The final
outage exposed the expired-code limitation below. Real ingress checks rejected missing/wrong tokens
and stale-revision plugin-status credentials with 401, an unknown tenant route
with 404, and a request without the private CA during TLS verification. With no
plugin selection, authenticated plugin status returns 404; this is not a
successful plugin-installation claim.
The runtime came from the repository Dockerfile's OpenClaw source
`2765f7a3341b8be4835afacbff3d04c6e3c3c79b`, with Codex 0.156.0, manifest
`sha256:2a7a1409f0d84d49d7343ff939ee18389843c377c104df6a5dd4dee715b4d759`.
This is a locally built image, not a published release qualification.

Historical findings and remaining acceptance:

- A longer outage exhausted the existing five-attempt worker budget and left
  an Agent `deleting`. A repeated DELETE does not requeue failed deletion work.
  Current `OceWorker.finalizeAgentDeletion` still fails exhausted work, and
  `OccController.deleteAgent` returns an already-deleting Agent without requeueing.
  The short-outage result does not establish recovery after retry exhaustion.
- The historical runtime above failed to reconnect an already paired workspace
  node after a Pod restart once its setup code expired. Its `node run
--pair-if-needed` decodes the code before consulting saved state and reports
  `Pairing setup code has expired`. The retained Agent's model call then returned
  500 because workspace discovery was unavailable. The 238-second test proves
  outage recovery for deletion, not aged live-Agent reconnection. A normal OCE
  redeploy issues fresh pairing material; it is not automatic reconnect proof.
  Revalidate natural expiry and restart with the selected current runtime;
  this historical failure does not establish its present behavior.
- Remote Codex plugin installation requires a ChatGPT-backed credential;
  an API-key model test does not establish that workflow. The HTTPS plugin-status
  authentication tests are separate evidence.
- Replacement after a model turn also succeeded on that historical pin, including
  another model reply afterward, but took 396 seconds. Startup logs showed the
  prior Gateway owner lease delaying the replacement. Do not promise prompt
  replacement or clear a live lease to shorten the measurement.
- Same-cluster Kubernetes fixture CI passed. It is distinct from a complete
  same-cluster real-model run.

Earlier stop/resume testing exposed concurrent candidates repeatedly replacing
one shared authentication NetworkPolicy. That 238-second result used a
per-revision workaround. Current exclusive RWO replacement stops predecessors
and supersedes their reconciliation before preparing a successor, so this profile
uses the main Driver's Agent-owned policy with an exact-revision Pod selector.
The refreshed test verifies the rejected Harness is gone and the policy selects
only the corrected successor; earlier results do not establish this acceptance.
