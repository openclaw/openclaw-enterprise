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

Use an existing ready OCE Agent Namespace. On a fresh control plane,
complete [normal Namespace provisioning](../../../../docs/guides/deploy/production-agents.md#prepare-each-namespace)
without the Box control mount or an Agent deployment. Return the Worker to
zero before the checks below. In the assigned Kubernetes namespace, create the [private relay Service](../ingress/service.yaml) and read its ClusterIP.
Set Compute's `network.providerHarness` to that namespace, the allocated ClusterIP,
port 8443, and the Service peer labels `app.kubernetes.io/name: box-harness-relay`
and `box.openclaw.dev/installation: pilot`. Install the relay image at the
configured digest. Use the [verified Worker control mount](#mount-the-empty-control-directory).
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

### Before enabling the Worker control claim

For the experimental same-cluster installation, use a dedicated local
filesystem PVC in the trusted Helm release namespace. Prebind it to the
original Box node and to the canonical `runtimeDir/worker-control` directory.
Never use the whole runtime directory. Keep Agent and other workload Pods out
of the release namespace. Leave `worker.replicaCount: 0` and
`worker.strandsBoxControlClaimName: ""` until the following checks pass.

1. From the trusted Kubernetes context, compare the live Namespace, Node,
   PVC and PV with their original owner-recorded names and UIDs. Require the
   original hostname label to select exactly one Node. Check that the
   filesystem PVC is Bound, that its `spec.volumeName` is the original PV, and
   that the PV's `claimRef` names the same Namespace, claim and claim UID. The
   local PV must name exactly the canonical export path and require only the
   original hostname. A named claim or a matching label alone does not prove
   identity. For example, with `kubectl` and `jq`, set the variables below
   from the original owner records; do not substitute IDs from the objects
   being checked.

   ```bash
   set -euo pipefail
   : "${namespace:?}" "${namespace_uid:?}" "${box_node:?}" "${node_uid:?}"
   : "${box_hostname:?}" "${claim:?}" "${claim_uid:?}" "${volume:?}" "${volume_uid:?}"
   : "${control_dir:?}"
   k() { kubectl --kubeconfig "${kubeconfig:?}" --context "${context:?}" "$@"; }
   test "$(k get ns "$namespace" -o jsonpath='{.metadata.uid}')" = "$namespace_uid"
   k get nodes -l "kubernetes.io/hostname=$box_hostname" -o json |
     jq -e --arg node "$box_node" --arg uid "$node_uid" '
       [.items[] | {name: .metadata.name, uid: .metadata.uid}] ==
       [{name: $node, uid: $uid}]
     ' >/dev/null
   k -n "$namespace" get pvc "$claim" -o json |
     jq -e --arg uid "$claim_uid" --arg pv "$volume" --arg ns "$namespace" --arg name "$claim" '
       .metadata.uid == $uid and .metadata.namespace == $ns and .metadata.name == $name and
       .status.phase == "Bound" and
       .spec.volumeMode == "Filesystem" and .spec.volumeName == $pv
     ' >/dev/null
   k get pv "$volume" -o json |
     jq -e --arg uid "$volume_uid" --arg ns "$namespace" --arg name "$claim" \
       --arg claim_uid "$claim_uid" --arg path "$control_dir" --arg host "$box_hostname" \
       --arg pv "$volume" '
       .metadata.uid == $uid and .metadata.name == $pv and .status.phase == "Bound" and
       .spec.volumeMode == "Filesystem" and .spec.local.path == $path and
       (.spec.claimRef | .namespace == $ns and .name == $name and .uid == $claim_uid) and
       (.spec.nodeAffinity.required.nodeSelectorTerms as $terms |
         ($terms | length) == 1 and ($terms[0].matchFields // []) == [] and
         $terms[0].matchExpressions ==
           [{key: "kubernetes.io/hostname", operator: "In", values: [$host]}])
     ' >/dev/null
   ```

2. With the Worker still at zero, verify that its Deployment template has no
   reference to the claim, that no Worker Pod remains, and that no Pod or
   other controller in the release namespace references this PVC. Check the
   original host's mount inventory too: the export must have no other bind
   mount or consumer. Include any independently managed workload or mount
   namespace that can reach the host directory; the PVC object does not
   describe those consumers. A basic Pod and Worker check, alongside the
   operator's controller and host inventory, is:

   ```bash
   set -euo pipefail
   : "${namespace:?}" "${claim:?}"
   k -n "$namespace" get deployment openclaw-enterprise-worker -o json |
     jq -e --arg claim "$claim" '
       .spec.replicas == 0 and (.status.replicas // 0) == 0 and
       all(.spec.template.spec.volumes[]?; .persistentVolumeClaim.claimName != $claim)
     ' >/dev/null
   k -n "$namespace" get pods -o json |
     jq -e --arg claim "$claim" '
       all(.items[];
         .metadata.labels["app.kubernetes.io/component"] != "worker" and
         all(.spec.volumes[]?; .persistentVolumeClaim.claimName != $claim))
     ' >/dev/null
   k -n "$namespace" get deploy,sts,ds,rs,job,cronjob,rc -o json |
     jq -e --arg claim "$claim" '
       all(.items[]; all(.. | objects | .persistentVolumeClaim?.claimName?; . != $claim))
     ' >/dev/null
   ```

3. On the original Node's host, create a fresh mode-`0700` `runtimeDir`
   and its empty mode-`0700` `worker-control` child as the nonroot Box owner.
   Use that child for the local PV. It must be a dedicated directory, with
   no symlink, bind-mount alias, other consumer, or overlap with host state
   or any Box grant. The Box owner and the normal Worker's mapped UID must
   match. Record the directory's identity with
   `stat -c '%F:%u:%a:%d:%i' -- "$control_dir"` when the owner creates it.
   Set `control_dir_id` from that record and keep it for both later checks.
   Run this before mounting the child. No listener or socket is expected yet.

   ```bash
   set -euo pipefail
   : "${control_dir:?}" "${control_dir_id:?}" "${box_uid:?}"
   export_dir="${runtime_dir:?}/worker-control"
   test "$export_dir" = "$control_dir"
   test "$(realpath -e -- "$export_dir")" = "$export_dir"
   test -d "$export_dir"
   test ! -L "$export_dir"
   test "$(stat -c '%u:%a' -- "$export_dir")" = "$box_uid:700"
   test "$(stat -c '%F:%u:%a:%d:%i' -- "$export_dir")" = "$control_dir_id"
   entries=$(find "$export_dir" -mindepth 1 -maxdepth 1 -printf x -quit)
   test -z "$entries"
   ```

### Mount the empty control directory

Stop if a check is missing or an identity differs. Only after the checks
above pass, set `worker.strandsBoxControlClaimName` to the verified claim,
set `controlPlane.nodeSelector["kubernetes.io/hostname"]` to that hostname,
and start one Worker through the normal chart procedure. Mount only the
verified empty child. Keep the runtime parent and approval directory on the
host. The Driver's `controlSocket` is `/run/strands-box/control.sock`.

Verify that this is the only Worker Pod, it runs on the original Node, and
both the PVC source and the Worker mount are read-only. Set `worker_pod` and
`worker_pod_uid` from the actual rollout. Use the same trusted context and
original `control_dir_id`. This check does not require a socket.

```bash
set -euo pipefail
: "${worker_pod:?}" "${worker_pod_uid:?}" "${control_dir_id:?}"
k -n "$namespace" get pods -l app.kubernetes.io/component=worker -o json |
  jq -e --arg pod "$worker_pod" --arg uid "$worker_pod_uid" '
    [.items[] | {name: .metadata.name, uid: .metadata.uid}] ==
    [{name: $pod, uid: $uid}]
  ' >/dev/null
k -n "$namespace" get pod "$worker_pod" -o json |
  jq -e --arg node "$box_node" --arg uid "$worker_pod_uid" --arg claim "$claim" '
    .metadata.uid == $uid and .spec.nodeName == $node and
    [.spec.volumes[] | select(.persistentVolumeClaim.claimName == $claim)] ==
      [{name: "strands-box-control", persistentVolumeClaim: {claimName: $claim, readOnly: true}}] and
    [.spec.containers[], .spec.initContainers[]?, .spec.ephemeralContainers[]? |
      .name as $container | .volumeMounts[]? |
      select(.name == "strands-box-control") | {container: $container, mount: .}] ==
      [{container: "worker", mount: {name: "strands-box-control",
        mountPath: "/run/strands-box", readOnly: true}}]
  ' >/dev/null
worker() { k -n "$namespace" exec "$worker_pod" -c worker -- "$@"; }
test "$(worker stat -c '%F:%u:%a:%d:%i' /run/strands-box)" = "$control_dir_id"
worker awk '$5 == "/run/strands-box" && $6 ~ /(^|,)ro(,|$)/ { ok++ }
  END { exit ok != 1 }' /proc/self/mountinfo
```

Continue with the [first Agent deployment](../ordinary-chat/installed.md#prepare-the-original-volume).
The empty directory check is for this first rollout. A later restart or
replacement requires fresh readback of the Namespace, Node, PVC, PV,
directory, Worker mount and listener. Stop if any identity is missing or
changes; reconcile the original revision before starting another operation.

### Verify the live Worker control mount

After the operator starts the [held host](../ordinary-chat/installed.md#start-the-held-host-and-approve),
run these checks before approval. Use the original host owner's live listener
PID for `box_pid`. The export must contain only `control.sock`, owned by the
same numeric UID as the directory and Worker. `GET /v1/execution` returning 404
means no current execution. A pending admission can already exist and must
remain held while these checks run.

```bash
set -euo pipefail
: "${control_dir:?}" "${control_dir_id:?}" "${box_uid:?}" "${box_pid:?}"
export_dir="${runtime_dir:?}/worker-control"
socket="$export_dir/control.sock"
test "$export_dir" = "$control_dir"
test "$(realpath -e -- "$export_dir")" = "$export_dir"
test "$(stat -c '%F:%u:%a:%d:%i' -- "$export_dir")" = "$control_dir_id"
test -S "$socket"
test ! -L "$socket"
test "$(stat -c '%u:%a' -- "$socket")" = "$box_uid:600"
unexpected=$(find "$export_dir" -mindepth 1 -maxdepth 1 ! -name control.sock -printf x -quit)
test -z "$unexpected"
ss -xlnpH | awk -v path="$socket" -v pid="$box_pid" '
  $5 == path && index($0, "pid=" pid ",") { matches++ }
  END { exit matches != 1 }
'
socket_id=$(stat -c '%F:%u:%a:%d:%i' -- "$socket")
status=$(curl -sS --noproxy '*' --max-time 5 --unix-socket "$socket" \
  -o /dev/null -w '%{http_code}' http://localhost/v1/execution)
test "$status" = 404
test "$(stat -c '%F:%u:%a:%d:%i' -- "$socket")" = "$socket_id"
```

Recheck the original bindings and that only this Worker uses the export.
Repeat the Worker Pod and read-only mount checks above. Carry the direct host
`socket_id` into the same trusted Worker shell.

```bash
set -euo pipefail
: "${worker_pod:?}" "${worker_pod_uid:?}" "${socket_id:?}"
test "$(worker stat -c '%F:%u:%a:%d:%i' /run/strands-box/control.sock)" = "$socket_id"
status=$(worker node --input-type=module-typescript -e '
  import { request } from "node:http";
  const req = request({ socketPath: "/run/strands-box/control.sock",
    path: "/v1/execution", method: "GET", signal: AbortSignal.timeout(5000) }, (response) => {
    response.on("error", () => { process.exitCode = 1; });
    response.on("end", () => console.log(response.statusCode));
    response.resume();
  });
  req.on("error", () => { process.exitCode = 1; });
  req.end();
')
test "$status" = 404
test "$(k -n "$namespace" get pod "$worker_pod" -o jsonpath='{.metadata.uid}')" = "$worker_pod_uid"
test "$(worker stat -c '%F:%u:%a:%d:%i' /run/strands-box/control.sock)" = "$socket_id"
```

Keep the request held until the exact live socket and Worker mount match the
original readback. Keep private configuration and response bodies off the
terminal and out of reports. Use the normal Worker's identity and mount flags.

## Execution lifecycle

The Worker sends the exact admitted workload and its canonical JSON SHA-256 to
`POST /v1/admission` over the private Unix socket. The host records the pending
workload, then the Worker waits for approval within its normal deployment
deadline. No Secret is read by this Driver while the request is held.

On the host, read `pending.json` in the host's configured `runtimeDir` and
independently match its owner to the selected Installation, Agent and live
pending revision. The approval directory is outside the Worker's read-only
socket mount and every Box grant. The Worker cannot write an approval through
the socket. Follow [the held approval procedure](../ordinary-chat/installed.md#start-the-held-host-and-approve)
after the live mount check.

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
