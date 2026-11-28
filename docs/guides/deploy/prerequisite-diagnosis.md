# Diagnose Kubernetes installation prerequisites

Before installing OCE, run the read-only prerequisite check from a matching
checkout on a host with Unix sockets, Node.js satisfying `engines.node` in the
release checkout's `package.json`, `kubectl`, and your trusted kubeconfig. Prepare the target
namespace and prerequisite controllers through your infrastructure workflow first.
The command does not create resources, update policies, change your current
context, or run commands inside Pods.

## Keep the credential plugin policy in force

If your organization restricts which programs kubectl can run for credentials,
use `--require-kuberc` for both diagnosis and EKS address collection. Use this
mode only when the credential owner approves a policy-only JSON file as the
authoritative policy for this run. Do not convert a managed YAML file or
copy selected rules into a weaker policy.

Set `KUBERC` to the absolute path the owner supplies. Leave
`KUBECTL_KUBERC` unset or set to `true`. For example, to run a prepared plan:

```bash
KUBERC=/secure/occ/operator-policy.json TMPDIR="$RUN_DIR" \
  node scripts/diagnose-kubernetes-prerequisites.ts --require-kuberc \
  --config "$RUN_DIR/prerequisites.json"
```

Use the stock Linux amd64 build of kubectl v1.35.0, v1.36.2, or v1.36.4.
This mode rejects other builds based on the version and platform the client
reports. Verify the binary yourself and use a trusted kubeconfig, PATH, and
credential program.

The policy must be a regular file of at most 64 KiB, without a final symlink.
It must contain a single `kubectl.config.k8s.io/v1beta1` `Preference`. Only
`DenyAll` or `Allowlist` with a nonempty list of executable names or absolute
paths is supported. Each allowlist entry must use the `name` field. This
mode rejects the `command` field because v1.35.0 does not support it.
Use unescaped ASCII letters, digits, dots, underscores,
plus signs or hyphens in each path component. Do not use `.` or `..` as
components. Do not set aliases, command defaults or other options.

For example, the native JSON structure for an EKS policy that permits only the
`aws` plugin is shown below. Use the policy your credential owner supplies.

```json
{
  "apiVersion": "kubectl.config.k8s.io/v1beta1",
  "kind": "Preference",
  "credentialPluginPolicy": "Allowlist",
  "credentialPluginAllowlist": [{ "name": "aws" }]
}
```

A plugin policy controls which program kubectl runs. It does not approve the
program’s arguments or restrict other programs such as direct AWS CLI calls.

The command rechecks the original policy and its private copy before each read,
including isolated certificate checks.
If either changes, stop and verify the policy before starting again. A change
cannot revoke a request already in progress. `DenyAll` blocks credential plugins.
A context using only a token or client certificate can still authenticate.
A context combining an exec plugin and another credential is rejected.
If the result is unknown, check with the policy owner that the selected plugin
is allowed. A connection failure can produce the same result.

If your policy needs other settings, a managed YAML file or immediate revocation,
use the infrastructure owner's inventory. Never disable a required policy to
work around a refusal.

## Collect EKS addresses

Use the cluster ARN from your infrastructure outputs and the intended kubeconfig
and context. This works before the OCE namespace and prerequisite controllers
exist. You need AWS CLI access to call `sts get-caller-identity`,
`eks describe-cluster`, and `ec2 describe-network-interfaces`. The Kubernetes
identity needs to read the `default/kubernetes` Service and list its EndpointSlices.

Address collection pins the verified server and CA in a private temporary
kubeconfig. Set `TMPDIR` to an existing private directory. In the example below,
use `KUBECTL_KUBERC=false` only with the credential owner's permission to disable
all kubectl preferences. If policy is required, replace that prefix with the
owner's absolute `KUBERC` path and add [`--require-kuberc`](#keep-the-credential-plugin-policy-in-force).

```bash
KUBECTL_KUBERC=false TMPDIR=/secure/occ/prerequisite-run node scripts/diagnose-kubernetes-prerequisites.ts \
  --inventory-eks "$EKS_CLUSTER_ARN" --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT"
```

Success prints JSON with `apiCidrs` for API egress and `eks.webhookCidrs` for
webhook ingress. Each address is IPv4 with a `/32` prefix. API address
collection omits IPv6 and requires an IPv4 Service address and at least one
IPv4 endpoint. It refuses malformed or incomplete replies. Review the addresses
against the infrastructure policies and use the reviewed values in the plan
below. The reads take place in sequence. Repeat them if the infrastructure
changes.
A failed or incomplete read exits with status 2 and leaves stdout empty. It
writes the reason and any available `Next:` guidance to stderr.

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

The chart grants API and worker Pods unrestricted egress. That policy fails
this check even when the Service is reachable.

Ask the Service owner which Secret in the Service namespace supplies the
serving certificate. Set `tls.secretName` to that name and `serverName` to the
DNS name the client verifies. Ask the certificate owner to correct a mismatch.
The check cannot tell which certificate the Service presents.

Omit `tls` for a policy check alone. Kubernetes `get` on the named Secret
authorizes reading the entire object, including `tls.key`. Use an identity
already authorized to read that Secret or ask the certificate owner to run the
TLS check. It uses Secret identity, deletion state, and the public `tls.crt`
field for the diagnosis. It checks the first certificate's
validity window and matches `serverName` against its DNS subject alternative
names. The report contains no certificate or private key bytes. Verify the
actual served leaf, trust chain, and policy enforcement separately from the
caller's network.

To check one workload's client certificate, add a `clientCertificate` object
to the plan:

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

For [OpenShell Backend](../../reference/backends.md#openshell-gateway) mTLS,
use `auth.certificatePath`. After Helm creates both Deployments, select the
release namespace. Check the API as shown, then check `worker` in
`openclaw-enterprise-worker`. Compare each reported Secret name with
`backend.openshell.clientSecretName`. The certificate and key can grant OpenShell
administrator access.

Select one Deployment or StatefulSet and a regular or restartable init container.
Use an absolute POSIX path of at most 1,024 bytes without redundant separators
or dot segments. One direct Secret mount must map `tls.crt` to this file.
Renamed files are supported. Overlapping mounts at this file, StatefulSet
claims that replace the volume, subpaths and projected volumes fail.

Required volumes need every mapped key. Optional volumes may omit other keys.
For present keys, item paths cannot exceed 4,096 UTF-8 bytes or 255 bytes per
component before normalization. A path cannot serve as both file and directory.

The live template selects the Secret. Use an identity already authorized to read the
workload with Secret `get` limited to the expected name. The subprocess receives
whole objects, checks the public leaf and required keys, and reports resource
UIDs and versions. A denied read or a change in workload UID or resource version
across the Secret read yields `unknown`. A missing workload on the first read
or a missing Secret with an unchanged workload fails.

A passing check establishes that the observed public leaf is current and its
extended key usage permits client authentication. An absent or unreadable
extension yields `unknown`. Verify the mounted bytes, active process
credentials, gateway client-CA policy, peer identity, and mTLS RPC separately.

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

Select the exact EKS HTTPS endpoint or a tunnel at `127.0.0.1` or `[::1]`
with an explicit port from 1 through 65535 and the EKS hostname in
`tls-server-name`. Omit the tunnel path or use `/`. Both require the EKS CA.

Use a kubeconfig with an explicit `https://` server URL, server verification
and a configured credential.
The tool resolves the selected context into a private temporary copy before
its first Kubernetes request. Each read uses a short-lived kubectl proxy on a
private Unix socket. The command sends a GET for the selected API path and
reports redirects as unknown without following them. For EKS, the tool also
verifies the copy's endpoint, TLS name and CA against the intended
cluster. The copy includes any configured CA and file-backed client certificate
and key. Without a configured CA, ordinary HTTPS uses system trust.
Keep referenced token files and credential plugins available. They can supply
refreshed credentials for the verified endpoint.
Use an exec plugin, token or client certificate in place of a built-in
kubeconfig `auth-provider`. The command refuses built-in providers before
making requests because their refresh can replace credentials in a kubeconfig.

By default, diagnosis disables kubectl preferences so command defaults cannot
change the target. An approved token or client certificate needs no plugin.
For an exec plugin, [keep the required policy in force](#keep-the-credential-plugin-policy-in-force).
Only prefix the command with `KUBECTL_KUBERC=false` if the credential owner
permits disabling preferences, including the plugin policy. Check inherited
`KUBECTL_KUBERC=false` or `KUBERC=off` before running the command.

The operator needs named reads of the GatewayClass, Deployments,
CRDs, namespace and `default/kubernetes` Service, and list access to that
Service's EndpointSlices and the namespace's ResourceQuotas. The tool uses your
configured credential plugin when applicable. The optional Service dependency
check needs named `get` access to the resources it selects.

## Run and interpret the checks

Set `RUN_DIR` to an existing private directory that contains `prerequisites.json`.
Use the command-local `KUBECTL_KUBERC=false` prefix when approved for an exec plugin.

```bash
RUN_DIR=/secure/occ/prerequisite-run
TMPDIR="$RUN_DIR" node scripts/diagnose-kubernetes-prerequisites.ts \
  --config "$RUN_DIR/prerequisites.json"
```

To save a machine-readable report, add `--json` to the command and redirect
its stdout to `"$RUN_DIR/prerequisite-result.json"`.

For both modes, use a private `TMPDIR` with a path short enough for Unix sockets.
Linux with procfs also supports longer paths. The command creates a private
`oce-prerequisites-*` child directory under `TMPDIR` and removes it before
writing its result. After a forced termination or cleanup error, check `TMPDIR`
for that run's child directory. It can contain a credential-bearing
`kubeconfig.json`. Once the process has stopped, remove that exact directory
and keep its contents private during removal.

Each result is `passed`, `failed`, or `unknown`, with a next action for failed or
unknown checks. Exit status is `0` when all requested checks passed, `1` when any
failed, and `2` when none failed but evidence is incomplete, or the plan is invalid.
A failed check can coexist with unknown checks; inspect the complete report.
A check reports a resource absent when Kubernetes returns `NotFound` with
HTTP `404`. Invalid responses leave the check unknown.

| Check                              | What it establishes                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes API                     | The operator can read the selected Kubernetes API Service with its configured TLS and credentials.                                                               |
| GatewayClass                       | Its owner matches and `Accepted=True` refers to its current generation.                                                                                          |
| Required CRDs                      | Each selected CRD is Established, has NamesAccepted, and serves the requested API version.                                                                       |
| Controllers                        | Every selected Deployment has its intended nonzero replica count updated and available for its observed generation.                                              |
| API addresses                      | The expected `/32` set matches the current Service and IPv4 EndpointSlice inventory.                                                                             |
| ResourceQuotas                     | Each Job and ReplicaSet object limit fits reported usage plus the planned peak. A complete list can establish that neither limit exists.                         |
| Service dependency                 | The named policy grants both required TCP edges. With `tls`, the selected public leaf has a current validity window and a matching DNS subject alternative name. |
| Workload client certificate        | The workload template and Secret map a currently valid public leaf with client-authentication usage to the selected path.                                        |
| EKS identity and webhook addresses | The account, ARN, TLS endpoint and CA identify the intended EKS cluster, and expected webhook `/32`s match the filtered control-plane interface inventory.       |

For `api-addresses` and `webhook-addresses`, `missing` lists observed `/32` addresses
absent from the plan. `stale` lists planned `/32` addresses absent from the current
inventory. An incomplete or unreadable inventory yields `unknown`.

For `service-egress`, `missing` lists required grants absent from the named
NetworkPolicy. An `ExternalName` Service is a DNS alias without a ClusterIP.
The check reports `failed` for that Service even when it declares ports.
For a missing or unreadable dependency, verify the selected resource and
read access before changing a NetworkPolicy or serving certificate.

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

Collection has a 120-second deadline. Kubernetes reads have up to 15 seconds
each. A subprocess that checks a workload or certificate has up to 45 seconds
for its reads. Other commands have up to 20 seconds. Output is limited to 2 MiB. A timeout, denial, unreadable response, or missing tool yields unknown
without copying provider error output into the report. Recheck the selected
identity and prerequisite resources directly, then rerun after resolving the
cause. Continue with [production installation](production-installation.md) only
after the report and the remaining deployment checks are understood.
