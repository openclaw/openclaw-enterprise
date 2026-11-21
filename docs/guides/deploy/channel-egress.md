# Set up managed channel egress

Prepare Envoy dependencies before installing the OCE chart with channels enabled.
Install Bash, Python 3, Helm, kubectl, jq, and **yq v4** on the operator host before running
the setup command. Use the [local tools procedure](local-kubernetes-tools.md)
for a Linux development host.
Use the protected values from the [installation profile](installation-profiles.md)
and the same explicit kubeconfig and context as the controller release.
Set `channelEgress.enabled: false` when channels are disabled. The runtime and
chart settings must match the [channel reference](../../reference/drivers/kubernetes-compute/channel-egress.md).

The production chart does not own the Envoy controller or its CRDs. The following
command installs the checksum-pinned Envoy Gateway v1.6.7 manifest when the
controller namespace is absent, enables patch policies, and creates the selected
GatewayClass if absent. Existing Gateway API CRDs retain their owner. Existing
Envoy resources are checked; the command does not adopt or alter them. A partial
installation or incompatible existing controller needs its owner's repair.

```sh
scripts/setup-channel-egress install \
  --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace "$NAMESPACE" \
  --values "$INPUT_DIRECTORY/values.yaml"
```

Use `check` instead of `install` to require preexisting dependencies. Both check that supplied exclusions cover discovered Pod, Service and node ranges.
If discovery is unavailable or incomplete, the operator must verify the explicit
list independently. Both verify CRD establishment, controller readiness and version, patch-policy configuration,
GatewayClass acceptance, and actual Envoy patch delivery. The temporary probe
uses a unique namespace and private ClusterIP routing. Cleanup deletes only the
probe resources with their observed UIDs. Retain the reported probe name if
cleanup fails. Disabled channel candidates exit without dependency changes.

## Enable channels in the Kubernetes and EKS quickstarts

The [Kubernetes](kubernetes-setup.md) and [Amazon EKS](eks-openshell-setup.md)
quickstart templates explicitly set `channelEgress.enabled: false`. After
generating `$RUN_DIR/values.json` and `$RUN_DIR/installation.json`, and before
installing OCC, configure channels in those protected files.

Set `CHANNEL_EXCLUDED_CIDRS` to a JSON array from your operator's network
inventory: include every Pod range, Service range, and node address (as `/32`),
including public node addresses. Do not copy example ranges. In the same
protected Bash session, run this from the matching release checkout:

```bash
set -euo pipefail
: "${CHANNEL_EXCLUDED_CIDRS:?Set the actual Pod, Service, and node CIDRs as a JSON array}"
channel_stage=$(mktemp -d "$RUN_DIR/channel-egress.XXXXXXXX")
yq -o=json '.channelEgress' deploy/helm/openclaw-enterprise/values.yaml \
  > "$channel_stage/defaults.json"
jq --slurpfile defaults "$channel_stage/defaults.json" \
  --argjson cidrs "$CHANNEL_EXCLUDED_CIDRS" '
  if ($cidrs | type == "array" and length > 0 and all(.[]; type == "string"))
  then .channelEgress = ($defaults[0] * (.channelEgress // {}) *
    {enabled:true, gatewayClassName:"eg", excludedCidrs:$cidrs})
  else error("Supply the complete CIDR array") end
' "$RUN_DIR/values.json" > "$channel_stage/values.json"
jq --slurpfile values "$channel_stage/values.json" --arg namespace "$PLATFORM_NS" '
  .drivers.compute.configuration.runtime.channelEgress =
    ($values[0].channelEgress | {
      gatewayName, envoyNamespace, serviceName, listenerPortStart,
      listenerPortEnd, occListenerPort, inspectionPort, excludedCidrs
    } + {gatewayNamespace:$namespace})
' "$RUN_DIR/installation.json" > "$channel_stage/installation.json"
scripts/setup-channel-egress check \
  --kubeconfig "$KUBECONFIG" --context "$CONTEXT" \
  --namespace "$PLATFORM_NS" --values "$channel_stage/values.json"
# Replace the inputs only after both render and the dependency check succeeds.
install -m 600 "$channel_stage/values.json" "$RUN_DIR/values.json"
install -m 600 "$channel_stage/installation.json" "$RUN_DIR/installation.json"
```

This preserves unrelated Helm and Installation fields and existing channel
customizations, then enables the fleet and sets its class and exclusions.
The runtime receives the same names, ports, and exclusions. The chart's qualified
channel image stays separate from `ENVOY_IMAGE`, which selects workspace ingress.
Retain the staged files if the check fails; repair dependencies before retrying.

The quickstarts already require an Envoy controller for workspace routing. If
the check reports disabled patch policies or incompatible dependencies, have
that controller's owner repair them before continuing. This command does not
alter existing dependencies. Continue installation only after the check passes.

For an existing installation, prepare the matching settings through the
[installation change procedure](production-installation-changes.md). Saving an
Agent's Slack settings cannot enable installation-level egress.

## Configure upstream proxy endpoints

An Installation administrator must configure each reachable proxy before an
Agent can select it. Use the existing Installation change procedure. For a
managed profile, set `channels.upstreamProxies` to the endpoint URL and its
actual IPv4 `/32` addresses. For a private CA, set `channels.proxyTrust` to a
public CA Secret and key in the Envoy namespace. The bundle must include every
public and private root that Envoy must trust. The renderer writes matching
Helm and Compute inputs. For manual inputs, use the
[upstream proxy configuration reference](../../reference/drivers/kubernetes-compute/channel-egress.md#upstream-proxy-configuration).

Keep Pod, Service, node, metadata, and other private exclusions in place.
Grant only the configured endpoint addresses and port. If DNS returns an
address outside that scope, admission fails. Repair the Installation input;
do not widen global egress to make deployment pass.

## Select an Agent proxy

1. Open the Agent's **Configuration** draft. You need exact Agent update
   permission and `operate` on any proxy credential Secret.
2. Under **Gateway channel proxy**, enter **Network proxy URL** without URL
   credentials. If the proxy requires Basic authentication, select an existing
   same-Namespace Secret containing `Basic <base64(username:password)>`.
3. Select **Save Network proxy for next deployment**, then **Deploy new version**.
   Inspect the new revision summary. The serving revision keeps its prior
   selection until the deployment replaces it.
4. To remove the route, select **Clear proxy for next deployment** and deploy
   again. After rotating the credential Secret, deploy a new revision. A retry
   cannot change an existing binding's credential version.

Proxy outage, certificate failure, or authentication refusal has no direct
fallback. OCC Slack credential validation and directory lookup use their
existing separate route; a failure there does not prove the Agent proxy failed.
An Agent without enabled channels creates no proxy binding or egress grant.

## Local development

The local Kubernetes launcher uses the pinned controller setup and enables patch
policies before it creates channel resources. It discovers node Pod CIDRs, cluster
Service CIDRs and node addresses, including public addresses, and writes the same
channel settings into Helm and the external Installation. Incomplete discovery
fails setup. Production operators provide the complete exclusions explicitly;
the worker does not need cluster-wide discovery permissions.

An existing Slack-proxy installation needs [One Off Upgrades](one-off-upgrades.md).
Fresh installation setup does not perform historical Agent transitions.
