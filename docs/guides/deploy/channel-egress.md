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
probe resources with their observed UIDs. It waits for the namespace and its
Envoy Pods to disappear before removing the NetworkPolicy. If the script
loses a create response, it can recover that object's UID
when its annotation matches the create attempt. The operator needs create,
read, watch, and delete access for the probe namespace and for the probe's
NetworkPolicy in the Envoy namespace.
Disabled channel candidates exit without dependency changes.

The setup command creates the probe's egress policy. It does not grant
ingress to the Envoy controller. If the controller Pods are isolated, work
with their owner before starting the probe.

1. Verify that a policy selecting only Envoy controller Pods allows TCP 18000
   from the permanent channel fleet. Select peer Pods in the Envoy namespace.
   Match their `gateway.envoyproxy.io/owning-gateway-name` to the configured Gateway
   and their `gateway.envoyproxy.io/owning-gateway-namespace` to the release namespace.
2. Set `PROBE_NAME` to `oce-channel-probe-` followed by 12 random lowercase
   hexadecimal digits. Choose an unused name. The script uses it for the probe
   namespace and Gateway. It creates an egress policy with the same name in
   the Envoy namespace.
3. Have the owner allow TCP 18000 from the probe in a policy that selects only
   Envoy controller Pods. Match peer Pods in the Envoy namespace with both
   Gateway ownership labels equal to the probe name. Use a different name for
   the ingress policy. Preserve existing access.
4. Add `--probe-name "$PROBE_NAME"` to the dependency command. The script refuses
   an existing probe namespace. Keep the temporary ingress rule through all
   checks and cleanup. Then have its owner remove that rule and retain the
   permanent fleet rule.

A successful probe verifies patch delivery for its own Gateway. Check the
permanent fleet rule before starting an upgrade. If the script reports an
unsettled create or cleanup, retain the probe name and the reported create attempts.
Confirm that the command has stopped, then reconcile the create or delete with
the Kubernetes operator. Inspect the reserved namespace and the NetworkPolicy
with the same name in the Envoy namespace. Verify ownership before removing
either resource. Reuse the name after both operations have settled and both
resources are absent.

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

## Local development

The local Kubernetes launcher uses the pinned controller setup and enables patch
policies before it creates channel resources. It discovers node Pod CIDRs, cluster
Service CIDRs and node addresses, including public addresses, and writes the same
channel settings into Helm and the external Installation. Incomplete discovery
fails setup. Production operators provide the complete exclusions explicitly;
the worker does not need cluster-wide discovery permissions.

An existing Slack-proxy installation needs [One Off Upgrades](one-off-upgrades.md).
Fresh installation setup does not perform historical Agent transitions.
