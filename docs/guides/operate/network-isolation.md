# Check Agent network isolation

Confirm that your cluster enforces the
[documented network boundaries](../../reference/drivers/kubernetes-compute/networking-and-isolation.md)
for the control plane and tenant Agents. You probe TCP and DNS from inside the
workload Pods and from labeled test Pods, then compare each result with the
expected outcome.

Run this check after you [deploy a production Agent](../deploy/production-agents.md),
after a CNI or NetworkPolicy change, and after an upgrade. Kubernetes combines
every matching policy, so a stale or extra allow policy can open a path that
OCC's own policies deny. Only a probe through the enforcing CNI shows the
combined result. This page covers single-cluster installations.

## Before you begin

You need:

- An enforcing NetworkPolicy implementation.
- Bash, Python 3, and `kubectl` permission to `exec` into Pods, `get pods/proxy`,
  and create and delete Pods and a Namespace.
- `KUBECONFIG_FILE`, `CONTEXT`, `TENANT_NAMESPACE`, `GATEWAY_RUNTIME_NAMESPACE`
  and `AGENT_ID` from the [production Agent guide](../deploy/production-agents.md).
- One running Agent, preferably a test Agent (see
  [Check profile labels](#check-profile-labels)). To check Agent-to-Agent
  isolation you need a second Agent in the same OCC Namespace; to check
  cross-Namespace isolation, an Agent in another OCC Namespace.
- Your Helm values (`helm get values`), which list the extra egress the chart
  grants the control plane.

The probe runs with `node`, which the OCC controller image, the OpenClaw gateway
and the dedicated Codex Harness provide. Harness Pods that a SandboxDriver
such as OpenShell provisions are outside this check: their provider fences
their egress.

## Set up the probe

Define a `kubectl` wrapper and a probe that prints one result per target.
A target is `host:port`, or `dns:name` for a lookup:

```bash
kc() { kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" "$@"; }
PROBE_JS='
const net = require("net"), dns = require("dns");
const one = (t) => new Promise((done) => {
  let s;
  const timer = setTimeout(() => { s?.destroy(); done("TIMEOUT"); }, 3000);
  const end = (v) => { clearTimeout(timer); s?.destroy(); done(v); };
  if (t.startsWith("dns:")) {
    dns.lookup(t.slice(4), (e, a) => end(e ? e.code : "RESOLVED " + a));
    return;
  }
  const i = t.lastIndexOf(":");
  s = net.connect({ host: t.slice(0, i), port: Number(t.slice(i + 1)) });
  s.on("connect", () => end("OPEN"));
  s.on("error", (e) => end(e.code));
});
(async () => {
  for (const t of process.argv.slice(1)) console.log(t.padEnd(48), await one(t));
  process.exit(0);
})();'
probe() { local ns=$1 pod=$2 container=$3; shift 3
  kc -n "$ns" exec "$pod" -c "$container" -- node -e "$PROBE_JS" "$@"; }
```

`OPEN` means the connection was allowed. A denied connection reports
`ECONNREFUSED` on CNIs that reject (kube-router) or `TIMEOUT` on CNIs that drop
packets. A closed port also reports `ECONNREFUSED`. To tell a policy denial from
a closed port, confirm that another source reaches the same target: the control
Pod for dependencies and internet addresses, and the Agent's own gateway for its
Harness ports. A Pod always reaches its own address; ignore that row.

## Collect the targets

For a dedicated Agent, find its gateway Pod in the Gateway runtime namespace and
its Harness Pod in the tenant namespace:

```bash
pod() { kc -n "$1" get pods -l "openclaw.dev/agent=$2,openclaw.dev/workload-role=$3" \
  -o jsonpath='{.items[0].metadata.name}'; }
pod_ip() { kc -n "$1" get pod "$2" -o jsonpath='{.status.podIP}'; }
HARNESS_POD=$(pod "$TENANT_NAMESPACE" "$AGENT_ID" agent) HARNESS_CONTAINER=agent
GATEWAY_POD=$(pod "$GATEWAY_RUNTIME_NAMESPACE" "$AGENT_ID" gateway)
HARNESS_IP=$(pod_ip "$TENANT_NAMESPACE" "$HARNESS_POD")
GATEWAY_IP=$(pod_ip "$GATEWAY_RUNTIME_NAMESPACE" "$GATEWAY_POD")
AGENT_PORTS="$HARNESS_IP:18790 $HARNESS_IP:18791 $GATEWAY_IP:8080"
```

An embedded Agent runs in one gateway Pod in the tenant namespace, with the
gateway port `8080` and the status port `18791`. Use these values instead and
skip the gateway row below:

```bash
HARNESS_POD=$(pod "$TENANT_NAMESPACE" "$AGENT_ID" gateway) HARNESS_CONTAINER=gateway
HARNESS_IP=$(pod_ip "$TENANT_NAMESPACE" "$HARNESS_POD")
AGENT_PORTS="$HARNESS_IP:8080 $HARNESS_IP:18791"
```

Set the shared targets. Replace `openclaw-system` if you installed the
release elsewhere, and omit `ENVOY` without private Agent routing:

```bash
API_SERVICE="$(kc -n default get service kubernetes -o jsonpath='{.spec.clusterIP}'):443"
API_ENDPOINT=$(kc -n default get endpointslice kubernetes \
  -o jsonpath='{.endpoints[0].addresses[0]}:{.ports[0].port}')
ENVOY_NAMESPACE='envoy-gateway-system' # gatewayRouting.envoyNamespace
AGENT_GATEWAY='oce-agent-gateways'     # gatewayRouting.gatewayName, default <release>-agent-gateways
ENVOY="$(kc -n "$ENVOY_NAMESPACE" get pods \
  -l "gateway.envoyproxy.io/owning-gateway-name=$AGENT_GATEWAY" \
  -o jsonpath='{.items[0].status.podIP}'):10443"
DATABASE='db.internal.example:5432'   # your PostgreSQL host:port
PRIVATE_HTTPS='10.0.0.10:443'         # a private address that serves HTTPS, such as an internal load balancer
IMAGE=$(kc -n openclaw-system get deployment openclaw-enterprise-api \
  -o jsonpath='{.spec.template.spec.containers[0].image}')
TARGETS="dns:kubernetes.default.svc.cluster.local $API_SERVICE $API_ENDPOINT $DATABASE \
  1.1.1.1:443 1.1.1.1:80 $PRIVATE_HTTPS $ENVOY $AGENT_PORTS"
```

## Create the control Pod

The control Pod runs in a Namespace without policies, so it shows what each
target answers when nothing denies it:

```bash
test_pod() { # namespace name labels-json
  kc apply -f - <<EOF
{"apiVersion":"v1","kind":"Pod","metadata":{"name":"$2","namespace":"$1","labels":$3},
 "spec":{"automountServiceAccountToken":false,"restartPolicy":"Never",
  "securityContext":{"runAsNonRoot":true,"runAsUser":1000,"seccompProfile":{"type":"RuntimeDefault"}},
  "containers":[{"name":"probe","image":"$IMAGE","command":["node","-e","setInterval(()=>{},1e9)"],
   "resources":{"requests":{"cpu":"10m","memory":"32Mi"},"limits":{"cpu":"200m","memory":"128Mi"}},
   "securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,
    "capabilities":{"drop":["ALL"]}}}]}}
EOF
}
kc create namespace oce-netcheck
kc label namespace oce-netcheck pod-security.kubernetes.io/enforce=restricted
test_pod oce-netcheck control '{"app":"oce-netcheck"}'
kc -n oce-netcheck wait --for=condition=Ready pod/control --timeout=120s
probe oce-netcheck control probe $TARGETS
```

DNS, the Kubernetes API, the database, both `1.1.1.1` ports and `PRIVATE_HTTPS`
must be `OPEN`; skip any target your network blocks for every Pod. `ENVOY` and
the Agent ports deny the control Pod, because their ingress policies admit only
their peers; the API row shows that `ENVOY` listens.

The test Pods use the installed controller image and need the node's own pull
access, as the OCE Pods do; OCE renders no pull Secret. Don't add `imagePullSecrets`
([why](../deploy/private-registry-images.md#configure-node-pull-access)).

## Run the checks

| Source        | Command                                                                   | Expected                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API           | `probe openclaw-system deploy/openclaw-enterprise-api api $TARGETS`       | DNS, both Kubernetes API addresses, the database and `ENVOY` are `OPEN`. The API also reaches the destinations your values grant, including sign-in on TCP/443: an empty GitHub, Google or OIDC `egressCidrs` allows any address except link-local `169.254.0.0/16`, which holds cloud metadata. Without private routing, a gateway client can reach the gateway port. |
| Worker        | `probe openclaw-system deploy/openclaw-enterprise-worker worker $TARGETS` | DNS, both Kubernetes API addresses, the database and `ENVOY` are `OPEN`; no sign-in, model discovery or channel directory egress. With repository credentials, `repositoryCredentials.upstreamCidrs` is open on TCP/443.                                                                                                                                               |
| Agent egress  | `probe $TENANT_NAMESPACE $HARNESS_POD $HARNESS_CONTAINER $TARGETS`        | DNS resolves and `1.1.1.1:443` is `OPEN`. Port 80, `PRIVATE_HTTPS`, the Kubernetes API, the database and the other Agent ports are denied. A dedicated Harness also reaches `ENVOY`; an embedded gateway does not.                                                                                                                                                     |
| Gateway       | `probe $GATEWAY_RUNTIME_NAMESPACE $GATEWAY_POD gateway $TARGETS`          | DNS and its own Harness, `$HARNESS_IP:18790` and `:18791`, are `OPEN`. Everything else is denied: no internet, Kubernetes API or database. With channels enabled, the channel proxy is also open.                                                                                                                                                                      |
| Other Agent   | Add the other Agent's ports to `TARGETS` and repeat both rows             | Denied, for Agents in the same OCC Namespace and across Namespaces. Repeat from the other Agent's Pods to check the reverse direction.                                                                                                                                                                                                                                 |
| Profile label | See [Check profile labels](#check-profile-labels)                         | Everything denied.                                                                                                                                                                                                                                                                                                                                                     |
| Plugin status | See [Check the status port](#check-the-status-port)                       | Reachable from the API server's proxy sources and the Agent's own gateway.                                                                                                                                                                                                                                                                                             |

For another Agent's ports, use `HARNESS_IP:18790` of a dedicated Agent, or
`:8080` and `:18791` of an embedded Agent's gateway.

### Check profile labels

Pods with an Agent's identity labels but an unknown or missing
`openclaw.dev/network-profile` must receive no grant. These two test Pods copy
those labels:

```bash
LABELS=$(kc -n "$TENANT_NAMESPACE" get pod "$HARNESS_POD" -o json | python3 -c '
import json, sys
labels = json.load(sys.stdin)["metadata"]["labels"]
print(json.dumps({k: v for k, v in labels.items() if k.startswith("openclaw.dev/")
                  and k not in ("openclaw.dev/network-profile", "openclaw.dev/service-principal")}))')
UNKNOWN=$(echo "$LABELS" | python3 -c '
import json, sys; l = json.load(sys.stdin); l["openclaw.dev/network-profile"] = "unknown-v1"; print(json.dumps(l))')
test_pod "$TENANT_NAMESPACE" netcheck-profile-missing "$LABELS"
test_pod "$TENANT_NAMESPACE" netcheck-profile-unknown "$UNKNOWN"
kc -n "$TENANT_NAMESPACE" wait --for=condition=Ready \
  pod/netcheck-profile-missing pod/netcheck-profile-unknown --timeout=120s
probe "$TENANT_NAMESPACE" netcheck-profile-missing probe $TARGETS
probe "$TENANT_NAMESPACE" netcheck-profile-unknown probe $TARGETS
kc -n "$TENANT_NAMESPACE" delete pod netcheck-profile-missing netcheck-profile-unknown
```

Every target must be denied, DNS included (`EAI_AGAIN` or `TIMEOUT`). In a
tenant namespace created before network profiles, `allow-dns` still selects
every Pod, so DNS resolves there.

While these Pods exist, OCC counts them as the Agent's Pods: stopping, deleting
or redeploying the Agent waits for them, and its plugin status and runtime logs
are incomplete. Use a test Agent, change nothing on it while they run, and
delete them right after the probes as shown. They count against the
namespace's Pod quota.

### Check the status port

The status port `18791` admits the API server's proxy sources from
`network.pluginStatusProxySourceCidrs`. Through the proxy, the status endpoint
answers; the gateway port does not:

```bash
kc get --raw "/api/v1/namespaces/$TENANT_NAMESPACE/pods/$HARNESS_POD:18791/proxy/openclaw/runtime/status"
echo
kc get --raw "/api/v1/namespaces/$GATEWAY_RUNTIME_NAMESPACE/pods/$GATEWAY_POD:8080/proxy/"
```

For an embedded Agent, use `$TENANT_NAMESPACE/pods/$HARNESS_POD` in both
commands. The first command prints a JSON status report, or an HTTP error from
the status server while the Pod starts. The second fails with
`error trying to reach service` and `502 Bad Gateway`. Some CNIs, such as k3s's
kube-router, always admit traffic from a node to its own Pods: when the API server
runs on the Pod's node, the second command can return the gateway's response, so this
check cannot show the status-port policy there. The control Pod showed
that other Pods cannot connect to the status port directly. Repeat for Agents
on different nodes: the proxy source address can differ per node. Host-network
Pods and node processes that share a proxy source address can also reach the
port.

### Public addresses

Agents reach any public address on TCP/443. A console published on a public
address is reachable from every Agent, as from any internet client; OCC still
requires authentication for every request. A public Kubernetes API endpoint is
reachable the same way, so use a private endpoint or authorized networks. With
both on private addresses, Agent connections to them are denied. This model
egress grant is temporary; see [network security](../../reference/security.md).

## Clean up

Delete the control Namespace and any profile test Pods left by an interrupted run:

```bash
kc delete namespace oce-netcheck
kc -n "$TENANT_NAMESPACE" delete pod netcheck-profile-missing netcheck-profile-unknown --ignore-not-found
```

## If a check fails

- A target that should be denied is `OPEN`: list the NetworkPolicies in the
  source and target namespaces (`kc get networkpolicy -A`) and look for an extra
  allow policy. Kubernetes grants the union of all matching policies. An in-cluster
  model endpoint you opened with your own policy also shows `OPEN`.
- Every probe connects: the CNI does not enforce NetworkPolicy.
- An Agent cannot reach its model: check its
  [network profile](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#explicit-network-profiles)
  and the model egress exclusions.
- The status proxy fails for every Pod: set `network.pluginStatusProxySourceCidrs`
  to the API server's source addresses on each node.
