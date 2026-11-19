# Diagnose Kubernetes installation prerequisites

Before installing OCE, run the read-only prerequisite check from a matching
checkout with Node.js satisfying `engines.node` in the selected release checkout's `package.json`, `kubectl`, and your trusted kubeconfig. Prepare the target
namespace and prerequisite controllers through your infrastructure workflow first.
The command does not create resources, update policies, change your current
context, or run commands inside Pods.

## Select the resources and expected addresses

Save a JSON plan outside the checkout. Use the names of your installed controller
Deployments, the intended GatewayClass owner, and the exact IPv4 `/32` addresses
in your reviewed network configuration. Unknown top-level plan fields stop the
command before it reads Kubernetes or AWS resources.

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

To check one Service dependency, add a `serviceDependency` object to the plan:

```json
{
  "service": { "namespace": "middleware", "name": "gateway", "port": 443 },
  "policy": { "namespace": "oce-system", "name": "gateway-egress" },
  "tls": { "secretName": "gateway-tls", "serverName": "gateway.middleware.svc" }
}
```

The command reads the named Service and the source NetworkPolicy. It checks for
two TCP grants in that policy. One must pair the current IPv4 ClusterIP `/32`
with the selected Service port. The other must pair one peer containing both the
Service namespace and its Pod labels with the target port, including a named
target port. A broad address grant or split selectors do not establish those
exact grants. Verify that the policy's source `spec.podSelector` selects the
intended calling Pods in the policy's namespace. The check observes destination
grants in the named policy. It does not check for obsolete or additional grants.
The report records the observed resource UIDs and resource versions.

Use the DNS name from the intended client's reviewed TLS configuration for
`serverName`. Ask the certificate owner to repair a mismatch for that name.

Omit `tls` for a policy check alone. Kubernetes `get` on the named Secret
authorizes reading the entire object, including `tls.key`. Use an identity
already authorized to read that Secret or ask the certificate owner to run the
TLS check. The command projects only Secret identity, deletion state, and the
public `tls.crt` field from `kubectl`. It checks the first certificate's
validity window and matches `serverName` against its DNS subject alternative
names. The report contains no certificate or private key bytes. Verify the
actual served leaf, trust chain, and policy enforcement separately from the
caller's network.

To check one workload's client certificate, add `clientCertificate` to the plan:

```json
{
  "workload": {
    "kind": "Deployment",
    "namespace": "oce-system",
    "name": "openclaw-enterprise-api"
  },
  "container": "api",
  "certificatePath": "/etc/openclaw/openshell/tls.crt"
}
```

For the OpenShell administrator connection, copy `auth.certificatePath` from
the configured [OpenShell Backend](../../reference/backends.md#openshell-gateway).
Run a separate check for each selected Deployment or StatefulSet and container.
The path must resolve through one direct Secret volume mount in that container
or restartable init container to the public `tls.crt` key. Secret item mappings
may give the file a different name. For a required Secret volume, every mapped
key must exist. An optional volume can omit other mapped keys, but the selected
`tls.crt` must still exist. The check rejects overlapping item paths at the
selected file and StatefulSet claims that replace its volume. Subpath mounts
and mixed projected volumes are outside the supported check.

Use named `get` access to the selected workload and its mounted Secret.
This permission grants access to the whole object. The command collects only
the workload identity and relevant mount fields, plus rollout fields if you
also select the Deployment as a controller. For the Secret, the command reads
its identity and public `tls.crt`. It checks that each required mapping key
exists. The report records the resource UIDs and resource versions. A missing
workload or Secret fails the check. If a read fails, the check reports `unknown`.
Verify that the resource exists and the selected identity has named `get` access.
The check validates the public leaf's dates and reads its extended key usage
for TLS client authentication. An absent or unreadable extension yields
`unknown` because the check cannot establish client suitability. Confirm
client authentication with the operator who owns the mTLS connection.

This is static evidence from the current Pod template and Secret. Verify the
mounted bytes, active process credentials, gateway issuer and client-CA policy,
peer identity, and the actual mTLS RPC separately.

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
configured credential plugin when applicable. The optional Service dependency
check needs named `get` access to the resources it selects.

## Run and interpret the checks

```bash
node scripts/diagnose-kubernetes-prerequisites.ts --config "$RUN_DIR/prerequisites.json"
# Save machine-readable evidence privately when needed.
node scripts/diagnose-kubernetes-prerequisites.ts \
  --config "$RUN_DIR/prerequisites.json" --json > "$RUN_DIR/prerequisite-result.json"
```

Each result is `passed`, `failed`, or `unknown`, with a next action for failed or
unknown checks. Exit status is `0` when all requested checks passed, `1` when any
failed, and `2` when none failed but evidence is incomplete, or the plan is invalid.
A failed check can coexist with unknown checks; inspect the complete report.

| Check                              | What it establishes                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes API                     | The operator can read the selected Kubernetes API Service with its configured TLS and credentials.                                                               |
| GatewayClass                       | Its owner matches and `Accepted=True` refers to its current generation.                                                                                          |
| Required CRDs                      | Each selected CRD is Established, has NamesAccepted, and serves the requested API version.                                                                       |
| Controllers                        | Every selected Deployment has its intended nonzero replica count updated and available for its observed generation.                                              |
| API addresses                      | The expected `/32` set matches the current Service and IPv4 EndpointSlice inventory.                                                                             |
| ResourceQuotas                     | Each Job and ReplicaSet object limit fits reported usage plus the planned peak. A complete list can establish that neither limit exists.                         |
| Service dependency                 | The named policy grants both required TCP edges. With `tls`, the selected public leaf has a current validity window and a matching DNS subject alternative name. |
| Workload client certificate        | The selected container's Secret mount supplies a currently valid public leaf whose extended key usage allows client authentication.                              |
| EKS identity and webhook addresses | The account, ARN, TLS endpoint and CA identify the intended EKS cluster, and expected webhook `/32`s match the filtered control-plane interface inventory.       |

For `api-addresses` and `webhook-addresses`, `missing` lists observed `/32` addresses
absent from the plan. `stale` lists planned `/32` addresses absent from the current
inventory. An incomplete or unreadable inventory yields `unknown`.

For `service-egress`, `missing` lists required grants absent from the named
NetworkPolicy. An `ExternalName` Service is a DNS alias without a ClusterIP.
The check reports `failed` for that Service even when it declares ports.

Reconcile address drift and missing grants through your infrastructure workflow.
Review the deployed policies before changing the plan.

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
