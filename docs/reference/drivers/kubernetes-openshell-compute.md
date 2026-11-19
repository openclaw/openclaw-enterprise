# Kubernetes Compute with OpenShell service integration

OpenShell service integration keeps one Sandbox per Agent across revisions.
OpenShell owns the Harness and its persistent storage. Kubernetes Compute
manages the Agent Gateway, routing, Secrets and network policies in the OCE
tenant namespace. The workspace node connects through the Gateway for file
operations. This prototype remains subject to RFC review and cluster qualification.

## Select the prototype

Start with the [Kubernetes configuration](kubernetes-compute.md) and
[OpenShell Backend](../backends.md#openshell-gateway). Apply this overlay to the
Installation file read by both API and worker:

```yaml
drivers:
  compute:
    id: compute-kubernetes
    configuration:
      # Retain the existing Kubernetes authentication, image, network,
      # resource and runtime settings.
      servicePrincipalCredentials:
        mode: disabled
  sandbox:
    id: openshell-sandbox
    configuration:
      # Retain the existing process and network policy.
      integrationMode: service
      gateway: {}
      kubernetes:
        sandboxDataMount:
          subPath: workspace
          mountPath: /sandbox/oce/workspace
          readOnly: false
```

Keep the Sandbox and Credential Gateway members on the same Backend and set an
OpenShell endpoint reachable from the OCE namespace. `legacy` is the default.
Both modes keep the configured Compute Driver ID and use `occ/kubernetes`.
The Compute schema rejects the removed `managedOpenShell` block.

Select the storage owner before deploying Agents. Preparation, activation, stop
and retirement require the same storage owner that Compute saved for the
revision. Restore the original Installation settings if they differ.

Use one cluster with enforcing NetworkPolicies, OpenShell-owned persistent
Sandbox storage and one OCE worker replica. Configure the replica count on the
deployment. Configure the OpenShell gateway's workspace mode independently.
The workspace node uses the [Envoy route](../gateway-routing.md#native-node-endpoint).
The Gateway admits the Envoy Pods, and activation removes obsolete direct
workspace-node policies. Separate-cluster connectivity remains unqualified.

Protected Git verifies execution ownership and readiness through OpenShell's API.
The worker does not need Kubernetes Pod-read access in OpenShell-managed namespaces.
OpenShell owns the workload identities and reports them through its authenticated
supervisor and Provider status. See the
[Git execution trust boundary](../repository-credentials/protected-openshell-git.md#execution-identity).

Build a Harness image containing `/opt/oce/runtime/openshell-bootstrap.cjs` and
select it by immutable reference. OCE development and CI pin OpenShell v0.1.8.
For the prototype, verify that the OpenShell gateway enables
`SandboxUpdates.UpdateSandbox` and that its Compute Driver applies updates to
image, command, environment, labels and annotations with resource-version checks.
The [wire fixture's upstream commit](https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/proto/openshell.proto#L863)
defines the RPC. The gateway also needs `StopSandbox`, `StartSandbox`,
`ExposeService`, `AttachSandboxProvider`, `DetachSandboxProvider` and
`UpdateConfig`. Policy updates require workspace-admin authority. Combined
Provider and policy replacement requires a gateway that validates attachments
against the latest stored policy, including credential inspection rules.

## Lifecycle and retained files

The Sandbox and runtime Provider names derive from the Agent ID. Stop and
revision retirement retain the Sandbox and its storage. Replacement updates
runtime material, policy and workload while stopped. Each update checks the
resource version and verifies the result. OCE starts the Sandbox after readback
matches and reports it ready after OpenShell loads the latest policy.
Final Agent deletion removes the Sandbox and runtime Provider.

A revision can replace Credential Source Providers and change network rules.
OCE clears base rules before changing attachments, detaches obsolete Providers,
attaches replacements, then installs the final policy. Detachment preserves
shared Providers and other Agents' access. If a step fails, the Sandbox stays
stopped and the next attempt reconciles stored policy and attachments.
Runtime Provider updates delete obsolete keys and preserve unchanged empty
fields. A changed field must have a nonempty value because OpenShell treats an
empty update as deletion.

The bootstrap keeps private runtime state under `/opt/oce/managed/home` and the
Node compile cache beside it on the workload filesystem. A replacement starts
with a fresh home and links the workspace, generated images and Codex sessions
to `/sandbox/oce`. `OPENCLAW_NODE_STATE_DIR` points directly to retained node
state for atomic writes. The bootstrap refuses symlink ancestors, conflicting
links and private homes left on the volume by earlier builds.

Dedicated OpenClaw uses the bootstrap to prepare its storage and can keep
`kubernetes.userNamespaces` enabled. Every real ancestor of its node state
directory must pass the worker's permissions check. Group- or world-writable
ancestors require sticky protection. Before restart, OCE restores any missing
startup exposure, checks its port and bearer-passthrough authorization, and
withdraws it after enrollment. Codex keeps its app-server exposure.

OCE delivers initial workspace files from an Agent-owned setup Secret over
authenticated `ExecSandbox` stdin. See the
[provisioning flow](../../flows/openshell-managed-workload.md) for ordering and
failure handling.

## Limits and diagnosis

- Dedicated native OpenClaw and Codex only. Embedded execution, an external
  execution cluster, operator workspace resources and explicit PVC selection
  are refused. Bootstrap requires writable `/sandbox`; read-only policy paths
  within that root are refused. The inherited `sandboxDataMount` fields describe a logical
  workspace path; no mount using them is submitted to OpenShell.
- Changing the Harness type, static policy, non-Git middleware bindings, or resource requests
  through workload replacement is refused.
- Agents can enable or disable Git and change repository selections and resolved
  permissions between revisions. Cleanup closes the old authorization and removes
  its Provider and middleware before preparing the successor. Enabling Git requires
  a stopped predecessor with no remaining Git authority and a durable route store.
  Disabling Git removes its launch environment and enrollment configuration; files
  already fetched remain in the workspace. Profile changes that alter static
  filesystem policy, restart policy or non-Git middleware remain unsupported.
  Revoke any standing approval before changing its bound repository.
  [Live Git replacement verification](../../testing/openshell-git-replacement.md)
  requires configured GitHub access and records the tested scope.
- Replacement relies on one OCE worker and OpenShell's serialized lifecycle
  operations. See [stop and replacement ordering](../../flows/openshell-managed-workload.md#stop-and-replacement-ordering)
  for the cancellation argument. Provider credential mutations and exposure
  withdrawal require separate qualification.
- A missing bootstrap fails launch. An unreachable Envoy endpoint prevents node
  connection. A workload-update mismatch leaves the Sandbox stopped; inspect the
  server capability and stored specification before retrying.

Use the [managed OpenShell test checklist](../../testing/openshell-managed.md)
to verify cluster permissions, networking, model execution and replacement.
