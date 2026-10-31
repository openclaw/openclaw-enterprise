# Native owner recovery

OCC can clear a previous Native Gateway's custody only after it has observed that
owner inside a protected Gateway and retained proof that the exact container
terminated. Pod disappearance, RWO storage, or an old lock alone do not prove the
owner stopped.

The path requires the internal constructor input
`trustedGatewayToolBoundary: "oce-gateway-tools/v1"`, a dedicated Gateway, and the
existing private status route. Driver JSON cannot enable it. The ordinary factory
leaves it disabled; trusted deployment wiring and Native-runtime qualification
remain required.

OCC records private origin only in the creation request for a new Agent state PVC.
An existing PVC keeps its data and requires operator recovery. OCC removes the
origin before embedded or unprotected reuse, before publishing unsupported
sources, or when the wrapper reports unqualified sources. A later clean
configuration does not certify that retained state again.

The first source contract admits reviewed fields from the default and Standard
presets and OCE's own configuration writers. It supports the normal dedicated OC Harness, enabled
bundled/image plugins, OCE's remote WebSocket Codex settings, and its file-transfer
settings. Unknown roots or fields, browser helper overrides, configured channels,
custom OpenClaw plugin package installs into mutable state,
retained global `.env`, includes, custom hooks, Gateway-native MCP servers, Native `env`/Secret-provider
overrides, and other custom plugin settings require operator recovery. These
features remain available. OCC Secret bindings delivered as environment variables
are unchanged; Codex MCP/plugin selections run in the Harness.

The wrapper reads `system.info.stateOwner` from its checked local Native child and
writes that identity and its wrapper instance into the kubelet-managed termination
file before advertising them. OCC saves the owner, Pod UID, container ID and PVC
UID on the owned PVC with UID and resource-version write preconditions.

After termination, OCC requires that exact container's note to match the saved
observation. Kubernetes allocates a
[separate termination file for each container instance](https://github.com/kubernetes/kubernetes/blob/v1.34.1/pkg/kubelet/kuberuntime/kuberuntime_container.go#L435-L484),
which prevents stale Pod status from assigning a replacement wrapper to its
predecessor. OCC saves the termination proof before delivering a current-wrapper
intent through a Gateway-only read-only Downward API mount. The wrapper compares
every Native holder with the saved owner, then uses the existing Native CLI
confirmation and live-holder checks. This plugin-free recovery step can precede
full source inventory; a new live-owner binding always requires that inventory.

Missing or truncated notes, force deletion without retained termination proof,
lost nodes, changed PVCs and incomplete or mixed Native holders require operator
recovery. An unready replacement preserves the older binding. The recovery path
adds no Harness intent mount or Kubernetes permissions.
