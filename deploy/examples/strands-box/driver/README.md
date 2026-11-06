# Strands Box SandboxDriver example

This external Driver connects a dedicated Codex revision to one operator-owned
Strands Box execution. OpenClaw Control Plane selects the Driver. Stock Kubernetes
Compute supplies the command, image, workspace mounts, files, environment and
transport verifier. The host matches those inputs to its independently admitted
execution. A private relay carries the existing Harness WebSocket protocol.

This example supports ordinary execution with a controlled, non-authorizing
inference fixture. It does not register a Credential Proxy or provide protected
Git. Selecting it as a paired protected Driver is refused by the normal loader.
The Driver also refuses protected revision inputs, credential attachments, a
projected workload identity or initial workspace files before starting the Box.

The Driver reports `serving` only after the original Codex server answers the
Driver’s authenticated JSON-RPC `initialize` request. Check the actual Box,
network route, and workspace node before using the installation.

## Build and select

From the repository root with the pinned Node and pnpm and the frozen
dependencies installed:

```sh
node deploy/examples/strands-box/driver/build.ts
pnpm --dir deploy/examples/strands-box/driver pack
```

The archive contains a precompiled ESM entry point and its declarations. Install
the reviewed package at its exact version as a direct production dependency of
the Controller, using the [external Driver installation procedure](../../../../docs/reference/drivers/selection.md).
Use the controller workspace copies of `@openclaw-enterprise/contracts`,
`@openclaw-enterprise/occ` and `@openclaw-enterprise/utils` for its peer
dependencies. API and Worker must load the same selected package and
configuration.

Add the `sandbox` selection to the stock Kubernetes Compute Installation. The
following values illustrate the shape. Replace the certificate, addresses,
digest, Namespace and selectors with the actual operator-owned values.

```yaml
drivers:
  sandbox:
    id: strands-box-demo
    package: "@openclaw-enterprise/example-strands-box-driver"
    configuration:
      namespace: pilot
      controlSocket: /run/strands-box/control.sock
      nativeEndpoint: wss://box-harness.pilot.svc.cluster.local:8443/
      nativeCaBundle: |
        -----BEGIN CERTIFICATE-----
        <public ingress CA certificate>
        -----END CERTIFICATE-----
      workspaceRoot: /home/node/workspace
      workspaceNodeMode: file-only-v1
      relay:
        image: registry.example/strands-box-relay@sha256:<relay image digest>
        hostAddress: 10.0.0.7
        installation: pilot
        workerPeer:
          namespace: occ-system
          podLabels:
            app.kubernetes.io/name: occ-worker
      controlledInference:
        modelBaseUrl: https://model.pilot.svc.cluster.local/v1
```

Create the Agent Namespace through OCE. In its assigned Kubernetes namespace,
create the [private relay Service](../ingress/service.yaml) and read its ClusterIP.
Set Compute's `network.providerHarness` to that namespace, the allocated ClusterIP,
port 8443, and the Service peer labels `app.kubernetes.io/name: box-harness-relay`
and `box.openclaw.dev/installation: pilot`. Install the relay image at the
configured digest and give the Worker access to the protected control socket.
To verify each selected Pod belongs to the relay Deployment, the Worker also needs
permission to read its ReplicaSet. In the Agent's Kubernetes namespace, grant
that permission to the actual Worker ServiceAccount:

```bash
kubectl -n "$AGENT_NAMESPACE" create role box-relay-read-replicaset \
  --verb=get --resource=replicasets.apps
kubectl -n "$AGENT_NAMESPACE" create rolebinding box-relay-read-replicaset \
  --role=box-relay-read-replicaset --serviceaccount="$WORKER_NAMESPACE:$WORKER_SERVICE_ACCOUNT"
```

The socket and its parent directory must be owner-only and share the same
owner. Do not mount the control socket into the relay or the workload.

For a controlled inference fixture, set Compute's model provider to the same
private HTTPS `/v1` endpoint. Save an ordinary API-key binding with the public
marker `openclaw-strands-controlled-inference-v1`. The fixture origin must not
require or authorize any real credential. The Driver checks the exact
revision-owned projection and the admitted runtime manifest, and sends only a
Boolean to the host. It never passes a model key or PAT to Box. Without the
fixture selection it refuses model Secret projections.

## Execution lifecycle

The Worker sends the exact admitted workload and its canonical JSON SHA-256 to
`POST /v1/admission` over the private Unix socket. The host records the pending
workload, then the Worker waits for approval within its normal deployment
deadline. No Secret is read by this Driver while the request is held.

On the host, read `pending.json` in the host's configured `runtimeDir` and
independently match its owner to the selected Installation, Agent and live
pending revision. Set `revision_id` and `requirements_digest` from that verified
receipt. The approval directory is outside the Worker's read-only socket mount
and every Box grant. The Worker cannot write an approval through the socket.

```sh
node deploy/examples/strands-box/host/control.ts approve /absolute/host-installation.json "$revision_id" "$requirements_digest"
```

On the next reconciliation, the same approved workload can proceed. If it
includes a workspace-node pairing Secret, the Driver reads that exact key with
the stock ownership and envelope check, checks the host again, and passes the
one-shot code only to `PUT /v1/execution`. The host rechecks approval, retains
execution intent before launch, and does not return the code or persist it. The
`APP_TOKEN_SHA` supplied by Compute is a verifier. The raw Harness transport
capability stays on the existing authenticated Harness path.

The Driver reads the host execution back before creating the exact Kubernetes
relay Deployment with one replica and observes the relay objects after
creation. The standard Worker creates the Deployment with its existing
permissions. Kubernetes marks the relay Pod ready only when its real probe reaches the original native listener
through the private TLS route. Separately, the Driver compares the live
execution to the provisioned relay and sends `initialize` to Codex over the
verified TLS route using Compute's Harness transport token. The Driver reports
serving only after Codex returns a compatible result for that exact request
within the probe deadline. The host and relay must still name the same execution
afterward. During removal, the Driver
uses Kubernetes deletion preconditions, confirms the relay Pods are gone,
retires the exact host execution and checks for its absence.

For the [ordinary installed example](../ordinary-chat/installed.md), select
`workspaceNodeMode: file-only-v1` alongside `controlledInference`. The Driver
reads the bound workspace claim through its existing namespaced object client.
The host must match that UID and volume name to its own pinned mount before
admission. The host starts the stock file-only node outside Box on a fixed TLS
route to its Agent Gateway. The node keeps its own device state.

After the original Box listener starts, the Driver carries its receipt digest to
Compute and checks that same digest on the authenticated native upgrade.
Compute installs the binding with the ingress CA for that revision. The Gateway
checks the binding before using Box's restricted workspace policy. The ordinary
source and packaging tests do not qualify the installed network or volume.
