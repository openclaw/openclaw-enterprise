# Kubernetes Compute with OpenShell service integration

Keep `compute-kubernetes` and select OpenShell service integration to investigate
a stable OpenShell Sandbox per Agent. This local prototype is not qualified for production. Image builds
and cluster integration are deferred to the user.

The single Kubernetes Compute Driver owns Gateway orchestration. OpenShell owns the
Harness resources and `/sandbox` storage. OCE does
not create, read, mount or delete the Harness PVC. OCE still manages Gateway
storage, transport and setup Secrets, configuration, routing and NetworkPolicies
in its own tenant namespace. The workspace node connects from the Sandbox to
the Agent Gateway; file operations use that authenticated connection.

## Select the prototype

Start with the existing [Kubernetes configuration](kubernetes-compute.md) and
[OpenShell Backend](../backends.md#openshell-gateway). Select the mode with
`drivers.sandbox.configuration.integrationMode: service` in the Installation
file read by both API and worker. There is no separate Compute mode flag.
The following overlay also shows the existing prerequisites:

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

This is a partial configuration overlay. Keep the selected Sandbox and Credential
Gateway members on the same Backend. Configure that Backend with an explicit
OpenShell endpoint reachable from the OCE namespace. Composition selects an internal managed runtime for Kubernetes Compute with
bundled OpenShell Sandbox in `service` mode. All Kubernetes modes use
`occ/kubernetes` and keep the configured Compute ID. `legacy` is the default and retains the existing
lifecycle. The Compute schema rejects the removed `managedOpenShell` block.
Rebuilding images alone does not change the integration mode. Runtime, storage-path
and policy prerequisites still apply; selecting a mode does not rewrite them.

Dedicated OpenClaw does not require `kubernetes.userNamespaces: false` in service
mode. Its image bootstrap prepares retained directories inside the Sandbox;
the legacy workspace preparation restrictions do not apply.

Select the storage mode before deploying Agents. Changing between Kubernetes-owned
and OpenShell-managed storage for an existing Agent is unsupported, even when Driver
IDs stay the same. OCE refuses to prepare, activate, stop or retire a revision under
a different storage mode. Restore the original Installation settings to operate
those Agents; OCE does not move their data between storage owners.

OpenShell must supply persistent Sandbox storage; its gateway workspace mode is
configured independently. Workspace nodes connect through
the existing [Envoy node route](../gateway-routing.md#native-node-endpoint).
OCE admits its Envoy proxy to the Agent Gateway; service mode does not select
OpenShell namespace or Pod labels or create a direct Sandbox ingress allowance.
Activation removes previous Agent-owned direct workspace-node policies through
normal policy cleanup. Use one cluster with enforcing NetworkPolicies and one OCE
worker. Mode selection does not enforce the worker replica count; configure it in
the deployment. Separate-cluster connectivity remains unqualified.

Protected Git verifies execution ownership and readiness through OpenShell's API.
The worker does not need Kubernetes Pod-read access in OpenShell-managed namespaces.
OpenShell owns the workload identities and reports them through its authenticated
supervisor and Provider status. See the
[Git execution trust boundary](../repository-credentials/protected-openshell-git.md#execution-identity).

Rebuild the OCE Harness image from this branch. It must contain
`/opt/oce/runtime/openshell-bootstrap.cjs`. Existing runtime images lack this
bootstrap. Keep immutable image references in the Installation configuration.

OpenShell must implement `SandboxUpdates.UpdateSandbox` with resource-version
checks and image, command, environment, labels and annotations updates.
The local RPC definitions match [OpenShell commit `42671c2`](https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/proto/openshell.proto#L863).
Enable sandbox updates in the OpenShell gateway and select a compute driver
that supports the requested changes. The prototype also uses `StopSandbox`,
`StartSandbox`, `ExposeService`, `AttachSandboxProvider`, `DetachSandboxProvider`
and `UpdateConfig`. Policy updates require workspace-admin authority.
Provider attachment validation must use the latest stored policy, including for
credential inspection. A gateway that validates against the creation-time policy
can reject valid replacements or accept conflicting attachments. The combined
replacement path requires the OpenShell fix for that behavior.
The default OCE development and CI images
remain pinned to OpenShell v0.1.5; updating the RPC definitions does not update
those images or establish live compatibility.

## Lifecycle and retained files

Compute builds a shared Harness launch description before selecting storage.
It names retained directories and their environment bindings. Kubernetes maps
those directories to PVC subpaths; managed OpenShell maps them to `/sandbox/oce`
bootstrap paths. The managed path does not construct a Harness Deployment or
operator PVC configuration. The experimental contract remains subject to RFC review.

The Sandbox and runtime Provider names derive from the Agent ID. Stop and
revision retirement stop the workload and retain its storage. A successor
replaces runtime material while stopped, updates the workload with its observed
resource version, reads back the complete specification, then starts it. An
older server that ignores new update fields fails verification before start.
Final Agent deletion deletes the Sandbox and runtime Provider through OpenShell.

Replacement can add, remove or switch Credential Source Providers and change
network rules in the same revision. When attachments differ, OCE clears the base
network rules while stopped, detaches obsolete Providers, attaches replacements,
then installs the final policy. Each mutation uses a resource-version check and
readback. Detachment preserves shared Providers and other Agents' access.

An interrupted attempt leaves the Sandbox stopped; retry reconciles its stored
policy and attachments. A rejected final policy leaves the changed attachments
in place for retry without starting the workload. OCE starts only after policy
and workload readbacks match, and reports the Harness ready only after the latest
policy is loaded. With unchanged attachments, it updates the policy directly.
Protected enrollment checks OpenShell's active and returned policy versions
against each other, independently of the new OCE plan's generation. It still
requires the expected policy and current execution evidence.
Static policy and non-Git middleware bindings must remain unchanged. Provider profile
and policy conflicts fail replacement before start.

Runtime Provider config replacement removes keys absent from the successor's
configuration and preserves unchanged empty fields, including an absent node CA.
OpenShell must accept the resulting config under the Provider profile; rejection
or a readback mismatch prevents restart. Changing a field to an empty value is
unsupported because OpenShell interprets that update as deletion.
Before a native OpenClaw replacement starts, OCE restores and verifies
its temporary startup exposure if the previous revision withdrew it. The route
uses bearer-passthrough authorization and is withdrawn again after enrollment.
Codex keeps its exposure as the app-server transport.

The image bootstrap uses `/opt/oce/managed/home` on the workload filesystem for
credentials, configuration, and other private runtime state. Replacing the workload
starts with a fresh home. The bootstrap links workspace files, generated images,
and Codex sessions to their retained directories in `/sandbox/oce`. It points
`OPENCLAW_NODE_STATE_DIR` directly to the retained state directory so atomic writes
keep working. The bootstrap refuses conflicting paths, symlink ancestors, and
retained private homes from earlier builds. OpenClaw's Node compile cache lives
on the workload filesystem outside the home because Node initializes it before
bootstrap runs.

The dedicated OpenClaw worker also checks the real ancestry of its retained node
state. Its PVC mount must meet OpenClaw's state-directory permissions, including
the check for a group- or world-writable ancestor without sticky protection.

Private initial-file delivery still uses authenticated `ExecSandbox` stdin.
The initializer reads its Agent-owned setup Secret in OCE's namespace and writes
to `/sandbox/oce/workspace` without requiring a PVC mount. Later revisions verify
the completed setup against the retained workspace.
See the [provisioning flow](../../flows/openshell-managed-workload.md).

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

Local checks cover configuration, outgoing workload and NetworkPolicy contracts,
protobuf transport and real filesystem preparation. They do not prove cluster
RBAC, networking, model execution or stop/update/start durability. The
[test checklist](../../testing/openshell.md#managed-compute-prototype) owns that proof.
