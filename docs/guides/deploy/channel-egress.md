# Set up managed channel egress

Prepare Envoy dependencies before installing the OCE chart with channels enabled.
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
read, watch, and delete access for the probe namespace and its NetworkPolicy.
Disabled channel candidates exit without dependency changes.

If NetworkPolicy isolates the existing Envoy controller Pods, work with the
controller's owner before starting the probe:

1. Verify that a policy selecting only Envoy controller Pods allows TCP 18000
   from the permanent channel fleet. Select peer Pods in the Envoy namespace.
   Match their `gateway.envoyproxy.io/owning-gateway-name` to the configured Gateway
   and their `gateway.envoyproxy.io/owning-gateway-namespace` to the release namespace.
2. Reserve an unused probe name with the prefix `oce-channel-probe-` and 12
   random lowercase hexadecimal digits. The script creates the namespace and
   Gateway under that name.
3. Have the owner allow TCP 18000 from the probe in a policy that selects only
   Envoy controller Pods. Match peer Pods in the Envoy namespace with both
   Gateway ownership labels equal to the probe name. Preserve existing access.
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

The local Kubernetes launcher uses the pinned controller setup and enables patch
policies before it creates channel resources. It discovers node Pod CIDRs, cluster
Service CIDRs and node addresses, including public addresses, and writes the same
channel settings into Helm and the external Installation. Incomplete discovery
fails setup. Production operators provide the complete exclusions explicitly;
the worker does not need cluster-wide discovery permissions.

An existing Slack-proxy installation needs [One Off Upgrades](one-off-upgrades.md).
Fresh installation setup does not perform historical Agent transitions.
