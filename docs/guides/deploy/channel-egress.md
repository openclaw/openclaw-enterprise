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
probe resources with their observed UIDs. Retain the reported probe name if
cleanup fails. Disabled channel candidates exit without dependency changes.

The local Kubernetes launcher uses the pinned controller setup and enables patch
policies before it creates channel resources. It discovers node Pod CIDRs, cluster
Service CIDRs and node addresses, including public addresses, and writes the same
channel settings into Helm and the external Installation. Incomplete discovery
fails setup. Production operators provide the complete exclusions explicitly;
the worker does not need cluster-wide discovery permissions.

An existing Slack-proxy installation needs [One Off Upgrades](one-off-upgrades.md).
Fresh installation setup does not perform historical Agent transitions.
