# Validate OCE across two local clusters

This experimental profile installs the complete OCE control plane in one cluster
and dedicated Codex Harnesses in another. It uses the production controller image,
PostgreSQL roles, migration/bootstrap Job, API, worker, and normal Agent APIs.
Embedded execution, cloud provisioning, and repository credential delivery are
outside this profile. The repository credential service currently assumes
cluster-local reachability; two-cluster admission rejects it explicitly. Keep the
implementation draft until runtime and failure-path acceptance are complete.

## Prepare isolated infrastructure

Use two disposable k3d clusters with Kubernetes 1.35 or later, distinct Pod and
Service CIDRs, enforcing NetworkPolicies, and explicit loopback kubeconfigs.
Keep the default Docker context and kubeconfig unchanged. For example, use
`10.60.0.0/16` and `10.61.0.0/16` in CP, and `10.62.0.0/16` and `10.63.0.0/16`
in DP. A shared Docker network supplies reachable node addresses; it does not
share Kubernetes APIs, storage, credentials, or tenant namespaces.

On a laptop, give the selected Linux VM sufficient disk capacity for duplicate
containerd imports of real runtime images. An isolated 8-CPU, 16-GiB RAM,
128-GiB-disk VM was used for the first experiment. Inspect available physical
capacity before creating it; do not resize or clean unrelated environments.

Install Envoy Gateway in both clusters and cert-manager in CP. The initial
experiment used Envoy Gateway 1.6.7 and cert-manager 1.18.4. Provide a private
CP RWO StorageClass and DP RWX workspace storage. The existing
`configureExistingK3dLocalPathSharedFileSystem` test helper configures a disposable
single-node k3d local-path provisioner for the latter. This is a local fixture,
not shared storage between clusters or a production RWX recommendation.

Import approved immutable controller/runtime images into their respective
clusters. Install the configured Codex localhost seccomp profile on DP nodes
using the reviewed [sandbox procedure](kubernetes.md). Do not disable AppArmor,
seccomp, or Pod security to make a sandbox probe pass.

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
(loopback), `serviceKeyFile`, `agentConfiguration` (the dedicated native
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

The real API/worker integration passed the lifecycle above without skips.
Separate manual checks proved model responses, token rejection, and workspace
read/write before and after a Harness Pod restart. A model response also succeeded
after revision replacement. Complete acceptance still
needs the sandbox probe, compatible runtime pin, plugin-enabled transport,
partial-cluster failure recovery, and same-cluster regression. The initial
runtime also exhibited a Gateway owner-lease delay: replacement after a model
turn took approximately six to seven minutes before OCE reported success.
Do not mistake eventual success for prompt replacement.
