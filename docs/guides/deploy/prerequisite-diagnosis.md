# Diagnose Kubernetes installation prerequisites

Before installing OCE, run the read-only prerequisite check from a matching
checkout with Node.js satisfying `engines.node` in the selected release checkout's `package.json`, `kubectl`, and your trusted kubeconfig. Prepare the target
namespace and prerequisite controllers through your infrastructure workflow first.
The command does not create resources, update policies, change your current
context, or run commands inside Pods.

## Select the resources and expected addresses

Save a JSON plan outside the checkout. Use the names of your installed controller
Deployments, the intended GatewayClass owner, and the exact IPv4 `/32` addresses
in your reviewed network configuration:

```json
{
  "kubeconfig": "/path/to/private/kubeconfig",
  "context": "selected-cluster",
  "namespace": "oce-system",
  "peakAdditional": { "jobs": 1, "replicaSets": 2 },
  "gatewayClass": {
    "name": "eg",
    "controllerName": "gateway.envoyproxy.io/gatewayclass-controller"
  },
  "controllers": [
    { "namespace": "cert-manager", "name": "cert-manager" },
    { "namespace": "cert-manager", "name": "cert-manager-webhook" },
    { "namespace": "cert-manager", "name": "cert-manager-cainjector" },
    { "namespace": "envoy-gateway-system", "name": "envoy-gateway" }
  ],
  "crds": [
    { "name": "gatewayclasses.gateway.networking.k8s.io", "version": "v1" },
    { "name": "gateways.gateway.networking.k8s.io", "version": "v1" },
    { "name": "httproutes.gateway.networking.k8s.io", "version": "v1" },
    { "name": "certificates.cert-manager.io", "version": "v1" }
  ],
  "apiCidrs": ["10.100.0.1/32", "10.0.1.10/32"]
}
```

Select every Deployment and CRD your installation needs, including its Agent Sandbox
controller, Sandbox CRDs, and Envoy security policies. Use your installed names.
For `apiCidrs`, supply the reviewed policy addresses for the IPv4 Kubernetes
Service IP and all IPv4 API EndpointSlice addresses.

Run a plan for each namespace that will receive Jobs or ReplicaSets. Replace the
example `peakAdditional` counts with the largest number of **additional** Jobs
and ReplicaSets that can coexist there. Include retained Jobs and concurrent
rollouts. Use zero when the candidate creates none of that object. See
[Job and ReplicaSet capacity](upgrade-checklist.md#check-job-object-capacity).
If you omit these counts, a matching quota yields `unknown`.

For EKS, add `eks` with the intended cluster ARN and expected webhook caller
addresses. AWS CLI must already have authorized credentials:

```json
{
  "clusterArn": "arn:aws:eks:us-west-2:123456789012:cluster/selected-cluster",
  "webhookCidrs": ["10.0.1.10/32", "10.0.2.10/32"]
}
```

Use this object as the value of the plan's `eks` field. Compare the authenticated
account and the cluster named by the ARN with your intended target. Use the
[reviewed EKS address inventory](eks-openshell-setup.md#refresh-api-network-policies-after-the-node-groups-join)
for webhook ingress. The adapter reads STS caller identity, EKS cluster details,
and EC2 network interfaces filtered by VPC, cluster security group and cluster description.

Select the exact EKS HTTPS endpoint or an IP loopback tunnel with an explicit
port and the EKS hostname in `tls-server-name`. Both require the EKS CA. The
tool pins the verified endpoint, TLS name and CA for subsequent reads. Keep the
trusted kubeconfig, context and credentials stable during collection.

Use an HTTPS kubeconfig with server verification and a configured credential.
The operator needs API discovery, named reads of the GatewayClass, Deployments,
CRDs, namespace and `default/kubernetes` Service, and list access to that
Service's EndpointSlices and the namespace's ResourceQuotas. The tool uses your
configured credential plugin when applicable. It does not request Kubernetes Secrets.

## Run and interpret the checks

```bash
node scripts/diagnose-kubernetes-prerequisites.mjs --config "$RUN_DIR/prerequisites.json"
# Save machine-readable evidence privately when needed.
node scripts/diagnose-kubernetes-prerequisites.mjs \
  --config "$RUN_DIR/prerequisites.json" --json > "$RUN_DIR/prerequisite-result.json"
```

Each result is `passed`, `failed`, or `unknown`, with a next action for failed or
unknown checks. Exit status is `0` when all requested checks passed, `1` when any
failed, and `2` when none failed but evidence is incomplete, or the plan is invalid.
A failed check can coexist with unknown checks; inspect the complete report.

| Check                              | What it establishes                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes API                     | The operator can read the selected Kubernetes API Service with its configured TLS and credentials.                                                         |
| GatewayClass                       | Its owner matches and `Accepted=True` refers to its current generation.                                                                                    |
| Required CRDs                      | Each selected CRD is Established, has NamesAccepted, and serves the requested API version.                                                                 |
| Controllers                        | Every selected Deployment has its intended nonzero replica count updated and available for its observed generation.                                        |
| API addresses                      | The expected `/32` set matches the current Service and IPv4 EndpointSlice inventory.                                                                       |
| ResourceQuotas                     | Each Job and ReplicaSet object limit fits reported usage plus the planned peak. A complete list can establish that neither limit exists.                   |
| EKS identity and webhook addresses | The account, ARN, TLS endpoint and CA identify the intended EKS cluster, and expected webhook `/32`s match the filtered control-plane interface inventory. |

`missing` addresses are observed but absent from the plan; `stale` addresses occur
only in the plan. Reconcile drift through your infrastructure workflow and review
the actual policies before changing the plan. Copying observed addresses into the
plan alone does not repair deployed rules.

The report is a sequence of observations, not an atomic snapshot or an installation
approval. API access from the operator does not establish access from Pods.
Address equality does not verify NetworkPolicy enforcement, certificate admission,
or webhook connectivity. A missing namespace, unreadable list, scoped object
limit, or missing or inconsistent quota status leaves capacity unknown. A known
shortfall still fails the check. Quota usage can lag and other admission limits apply. Node capacity,
storage, images, credentials, database connectivity, and actual allowed/denied
network paths require their existing deployment checks.

Each command has 20 seconds and a 2 MiB combined output limit. The collection
has 120 seconds. A timeout, denial, unreadable response, or missing tool yields unknown
without copying provider error output into the report. Recheck the selected
identity and prerequisite resources directly, then rerun after resolving the
cause. Continue with [production installation](production-installation.md) only
after the report and the remaining deployment checks are understood.
