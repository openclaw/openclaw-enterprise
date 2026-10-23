# Kubernetes Compute with managed OpenShell Workspaces

Keep `compute-kubernetes` and select OpenShell managed Workspaces to investigate
a stable OpenShell Sandbox per Agent. This local prototype is not qualified for production. Image builds
and cluster integration are deferred to the user.

The single Kubernetes Compute Driver owns Gateway orchestration. OpenShell owns the
Harness namespace and `/sandbox` storage through managed Workspaces. OCE does
not create, read, mount or delete the Harness PVC. OCE still manages Gateway
storage, transport and setup Secrets, configuration, routing and NetworkPolicies
in its own tenant namespace. The workspace node connects from the Sandbox to
the Agent Gateway; file operations use that authenticated connection.

## Select the prototype

Start with the existing [Kubernetes configuration](kubernetes-compute.md) and
[OpenShell Backend](../backends.md#openshell-gateway). Apply these settings to the
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
      managedOpenShell:
        experimentalSingleWorker: true
        gatewayId: YOUR_OPENSHELL_GATEWAY_ID
  sandbox:
    id: openshell-sandbox
    configuration:
      # Retain the existing process/network policy and Kubernetes runtime class.
      gateway:
        workspaceMode: managed
      kubernetes:
        sandboxDataMount:
          subPath: workspace
          mountPath: /sandbox/oce/workspace
          readOnly: false
```

This is a partial configuration overlay. Keep the selected Sandbox and Credential
Gateway members on the same Backend. Configure that Backend with an explicit
OpenShell endpoint reachable from the OCE namespace. Composition selects an internal managed runtime for Kubernetes Compute with
bundled OpenShell Sandbox in `managed` mode. All Kubernetes modes use
`occ/kubernetes` and keep the configured Compute ID. Operator mode retains its
lifecycle. `managedOpenShell` is required in managed mode and rejected otherwise. Rebuilding
images alone does not change the workspace mode or supply the required settings.

Dedicated OpenClaw does not require `kubernetes.userNamespaces: false` in managed
mode. Its image bootstrap prepares retained directories inside the Sandbox;
the operator-mode workspace preparation restrictions do not apply.

Select the storage mode before deploying Agents. Changing between Kubernetes-owned
and OpenShell-managed storage for an existing Agent is unsupported, even when Driver
IDs stay the same. OCE refuses to prepare, activate, stop or retire a revision under
a different storage mode. Restore the original Installation settings to operate
those Agents; OCE does not move their data between storage owners.

Configure OpenShell itself for managed Workspaces. Set `gatewayId` to its actual
gateway identity: OCE uses this label, the Workspace label and the exact Sandbox
supervisor ID in the Gateway ingress policy. Use one cluster with enforcing
NetworkPolicies and one OCE worker. `experimentalSingleWorker` acknowledges a
limitation; it does not control the worker replica count.

Rebuild the OCE Harness image from this branch. It must contain
`/opt/oce/runtime/openshell-bootstrap.cjs`. Existing runtime images lack this
bootstrap. Keep immutable image references in the Installation configuration.

OpenShell must implement `SandboxUpdates.UpdateSandbox` with resource-version
checks and image, command, environment, labels and annotations updates.
The local RPC definitions match [OpenShell commit `42671c2`](https://github.com/NVIDIA/OpenShell/blob/42671c2dd2c02b744850e0bda72b99d5509969c1/proto/openshell.proto#L863).
Enable sandbox updates in the OpenShell gateway and select a compute driver
that supports the requested changes. The prototype also uses `StopSandbox`,
`StartSandbox` and `ExposeService`. The default OCE development and CI images
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

Provider config updates preserve unchanged empty fields, including an absent
node CA. Before a native OpenClaw replacement starts, OCE restores and verifies
its temporary startup exposure if the previous revision withdrew it. The route
uses bearer-passthrough authorization and is withdrawn again after enrollment.
Codex keeps its exposure as the app-server transport.

The image bootstrap creates retained directories under `/sandbox/oce`. Each
revision gets `revisions/<revision-hash>/home`. An atomic symlink at
`/sandbox/.openclaw-runtime` selects that revision. Home-relative session and
workspace paths link to retained directories. `OPENCLAW_NODE_STATE_DIR` points
directly to its retained `state` directory so atomic writes do not replace a
symlink. Conflicting paths and symlink ancestors fail bootstrap. Old revision
homes remain until Agent deletion; automatic pruning is deferred.

OpenClaw's Node compile cache uses `/sandbox/oce/node-compile-cache` directly.
Node creates the cache before bootstrap runs; placing it beneath the runtime
selector would prevent bootstrap from creating that symlink.

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
- Changing the Harness type, provider set, policy, resource requests or runtime
  class through workload replacement is refused. OpenShell needs further update
  support for those changes. Runtime Provider configuration keys cannot be removed.
- Replacement relies on one OCE worker and OpenShell's serialized lifecycle
  operations. See [stop and replacement ordering](../../flows/openshell-managed-workload.md#stop-and-replacement-ordering)
  for the cancellation argument. Provider credential mutations and exposure
  withdrawal require separate qualification.
- A missing bootstrap fails launch. A mismatched `gatewayId` prevents node
  connection. A workload-update mismatch leaves the Sandbox stopped; inspect the
  server capability and stored specification before retrying.

Local checks cover configuration, outgoing workload and NetworkPolicy contracts,
protobuf transport and real filesystem preparation. They do not prove cluster
RBAC, networking, model execution or stop/update/start durability. The
[test checklist](../../testing/openshell.md#managed-compute-prototype) owns that proof.
