# Strands Box Worker control claim

These checks belong to the [example Driver](README.md) and its
[ordinary installed example](../ordinary-chat/installed.md). Run them before
the Worker mounts the host's control directory.

## Before enabling the Worker control claim

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

## Mount the empty control directory

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

## Verify the live Worker control mount

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
