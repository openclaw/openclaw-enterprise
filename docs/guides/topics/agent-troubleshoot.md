# Troubleshoot Agents

Give operators the Namespace, Agent/version IDs, time and request ID. Never include
API keys, tokens, or Secret values.

## Codex refuses the required permission profile

For `RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE`, find the revision's
`worker.completed` event. Its `failure` field (`occ.failure` in the Collector) lists
`sandbox-mode-denied`, `named-profile-denied`, or `reviewer-denied`, separated by
underscores. Ask the policy owner to check
[OpenShell's requirements](../../reference/drivers/openshell-sandbox.md#codex-permission-profile).
For `RUNTIME_CODEX_REQUIREMENTS_TOO_LARGE`, ask the policy owner to reduce the reply
to at most 1 MiB, then redeploy.

If a dedicated Codex Agent on OpenShell reports `Codex did not grant the requested :danger-full-access profile`, inspect the error's `comparison` category:

- `sandbox-readOnly` or `sandbox-workspaceWrite`: Codex returned a restricted sandbox. Ask the account administrator to check its managed permission requirements against [OpenShell's requirement](../../reference/drivers/openshell-sandbox.md#codex-permission-profile).
- `sandbox-externalSandbox`: Codex returned a different sandbox mode. Ask the operator to check the selected native profile and runtime compatibility.
- `nonobject-result`, `field-absent`, `field-null`, `field-not-object`, `type-not-string`, or `type-unrecognized`: the response did not provide a recognized sandbox. Check the packaged runtime version and response contract before attributing the failure to account policy.

Login, source readiness, and a model reply under another profile cannot prove compatibility. Use an approved compatible credential or policy change. [Update copied API-key or PAT sources](../../reference/credential-sources.md#update-a-source). For device login, sign in again and replace the Agent binding. Redeploy, then [verify a model response from the Agent](../operate/model-verification.md). Keep the Gateway permission check and OpenShell isolation in place.

## Deploy requires a Sandbox Driver that supports protected Codex artifact admission

OCE stops before creating an Agent version when the selected Sandbox Driver cannot validate artifact access for protected Codex repositories. Ask your Installation administrator to check the `drivers.sandbox` selection and whether the installed Driver version provides [protected Codex artifact admission](../../reference/drivers/sandbox.md#methods). For OpenShell, see [how to configure the artifact rules](../../reference/drivers/openshell-sandbox.md#protected-codex-artifact-rules).

## The configured model is unavailable

Open the failed version in the Agent’s **Deployment** tab. If the startup model check reports an unavailable model, [choose a model ID for the same credential](../operate/model-verification.md#choose-a-model-for-dedicated-codex).

For the dedicated Codex quickstart, open **Configuration** → **Edit current Configuration**. Replace the model ID in three places:

- Set `agents.defaults.model` to `codex/<new-id>`.
- Rename its entry in `agents.defaults.models` to the same prefixed ID. Keep the entry’s Codex runtime settings.
- Set the corresponding `models.providers.codex.models` entry’s `id` and `name` to the new ID without the prefix.

Save the Configuration and select **Deploy new version** on the same Agent. Then send a prompt in **Open Agent UI** to confirm the model replies.

## The Agent or Namespace is missing

Open **Namespaces** and confirm that you selected the intended Namespace. The
console and HTTP API only list resources your identity can read. If the
Namespace is absent, ask your administrator to check your access. If it is
`provisioning` or `failed`, an operator must check its
[provisioning status](../../reference/namespaces.md#lifecycle) before deployment.
Then refresh and confirm the Namespace is `ready`.

<span id="deployment-is-blocked-or-has-no-selected-revision" class="anchor-alias"></span>

## Deployment is blocked or has no selected version

`active` is the Agent lifecycle, not workload health. An Agent can be
`active` without a selected version. If you did not retain the version ID,
inspect the latest deployment you can read:

```bash
occ --namespace NAMESPACE_ID agent deployment-status AGENT_ID --output json
```

Inspect the deployment error before changing credentials. See the
[deployment status reference](../../reference/agents.md#deployment-status).

On Kubernetes, open the Agent's **Open draft** draft, then
**Credentials**. Select **Reload authentication source**, then confirm under
**Harness authentication** that **Authentication source** is the source you
expect, not **None**. Check that the saved model authentication matches the
execution mode. For an OpenAI API key, the person selecting it and the Agent's
own identity both need `operate` on the exact platform Secret. See
[Harness authentication](../../reference/agents.md#harness-authentication).

If the deployment was accepted, use the returned version ID to check its
[deployment status](../../reference/agents.md#deployment-status):

```text
GET /namespaces/:namespaceId/agents/:agentId/deployments/:revisionId
```

| Status      | Next check                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `queued`    | If it stays queued, ask the operator whether a worker is available.                                                            |
| `running`   | A worker started the work. If it stays running, ask the operator to check workload startup, storage, and required credentials. |
| `failed`    | Follow the next step in `error.message`. If it names an administrator or operator, give them the error code and version ID.    |
| `succeeded` | The requested work completed; this does not establish live model availability. Verify a model response separately.             |

For Kubernetes workload problems, operators can use the
[Compute failure checks](../../reference/drivers/kubernetes-compute.md#failure-conditions).
When a Kubernetes deployment fails with `DEPENDENCY_UNAVAILABLE` after its
retries, the worker log's `worker.compute-prepare-failed` events for that
version name the code, preparation step and reason. The log Collector exports
the code but not the step or reason.

`KUBERNETES_OWNERSHIP_CONFLICT` means the Driver could not verify an object’s
ownership or configuration. Leave it in place. Ask the cluster operator to
identify its owner and resolve the conflict with them before deploying again.

For a dedicated Agent, a connected workspace node alone does not establish
enrollment: OCC must record its device through setup handoff. If deployment
stays pending, give the operator the version ID and worker's reason code. Keep
the node's retained identity and workspace intact; repeated restarts do not prove
that handoff completed. Unconfirmed credential possession after setup expiry requires the
[scoped node-Secret recovery](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#harness-storage);
do not delete the node identity or workspace.

A second node runner using the same local profile fails immediately. Keep one
runner per profile. Its lock remains held until clients, runtime shutdown and
pending endpoint writes finish. Recovery requires a definitely dead owner or a
process-start identity mismatch; age alone never permits reclaiming a live or
ambiguous owner. This local runner lock
does not coordinate other hosts or arbitrary credential writers; workload
exclusion remains the execution provider's responsibility.

For an OpenShell `workspace-baseline` failure with `created directory admission
failed` and `insecure-permissions`, ask the operator to check the node-state
directory's owner and mode. Its private root must be `0700`; OCE prepares it at
startup, including on storage that adds setgid. After correcting the startup or
storage problem, deploy the Agent again. Keep its retained state and shared
workspace intact. See [writable runtime state](../../reference/drivers/openshell-sandbox.md#writable-runtime-state).

<span id="the-console-says-serving-status-unavailable"></span>

## Verify runtime health after deployment

The console's **Deployment** tab shows persisted status, with no live gateway-health
or chat view. **Current version** identifies the control plane's selection, even
[after a failed deployment](../../reference/agents/deployment.md#the-active-revision-after-a-failed-deployment):
an embedded replacement can reject its key during the model check after replacing
its predecessor. Selection does not establish credential validity or model responses.
[Verify the Agent's model response](../operate/model-verification.md) or ask an
operator to [verify the workload](../deploy/production-agents.md#verify-production-workloads).
Require an answer from the configured model; a successful file read is insufficient.

## Check workload capacity

For Kubernetes, compare configured requests/limits, admitted Agent Pod limits
and enclosing cgroup constraints with the infrastructure owner. Sandbox-visible host totals
do not establish usable CPU/memory; an unlimited visible cgroup does not rule
out hidden limits. Unreadable outer limits remain unknown until verified through
authorized infrastructure tooling. OCE runtime descriptions and diagnostics do
not measure effective capacity.

<span id="an-embedded-gateway-reports-an-unverifiable-state-owner" class="anchor-alias"></span>

## A Gateway or Harness cannot verify that the state lock holder stopped

After a hard stop, an embedded Gateway in either managed mode can recover locks
from a verified Docker predecessor or the first eligible Kubernetes container in
the same Pod. A replacement Pod cannot verify the former holder. Older images
may lack the original PID 1 start time.

A dedicated Gateway cannot recover a killed container's locks. On Kubernetes,
it stays unready on `gateway-state-lock` and deployment fails with
`RUNTIME_STATE_LOCK_UNVERIFIED`. Check `occ agent logs AGENT_ID --source gateway`
for the holder in `The Gateway cannot start`. When the locks clear, the Gateway
restarts after its next five-minute check.

A dedicated Harness killed during Doctor or native setup can leave its workspace
node state locked. Later deployments can fail with `RUNTIME_STATE_LOCK_UNVERIFIED`.
Read `occ agent logs AGENT_ID --source agent` and find the holder in
`The Harness cannot start` before OCE deletes the failed Pod. The Harness steps
below apply only to Deployments that Kubernetes Compute creates. For an
OpenShell Sandbox or another Harness topology, ask the infrastructure operator
for its recovery procedure.

1. Record the Agent, state volume and original container ID if available. On
   Kubernetes, use `holder N at POD_NAME/pid-ns` from the log to identify each
   holder Pod. It may be an earlier version's Pod. Record its namespace, name,
   UID when available and original node. Save the Gateway Deployment manifest
   for Gateway recovery. For Harness recovery, record the pinned Harness image,
   Pod `securityContext`, and claim and `workspace-node-…` subPath mounted at
   `/home/node/.openclaw-node`. Stopping the Agent deletes the Harness Deployment.

   [Stop the Agent in OCC](../../reference/agents/deployment.md#stop-and-resume).
   On Docker, verify that the exact original container exited. On Kubernetes,
   check the Agent's workload namespaces for any remaining Agent Pods, including
   terminating Pods, and verify that each holder Pod is absent. Pod absence or
   an expired heartbeat cannot prove container shutdown.

   The infrastructure operator must check both runtime inventories on each
   holder Pod's original Kubernetes node.

   ```sh
   crictl pods -o json
   crictl ps -a -o json
   ```

   Match the former Pod by namespace, name and recorded UID when available. Use
   sandbox IDs and Pod labels in the inventories to identify its containers. Keep
   the Agent stopped and all locks intact if identification is uncertain, either
   check fails, the node is unreachable or any Agent Pod, matching sandbox or
   matching container remains.

2. Keep other writers off the volume. For Gateway recovery, use the pinned
   Gateway image, runtime user, state directory and profile. Mount the retained
   volume and, on Docker, its configuration at the original paths. On Kubernetes,
   leave the saved Deployment unchanged. Create a maintenance Pod with the saved
   Pod `securityContext` and `prepare-private-state` init container. Copy only
   the `runtime-state`, `runtime-temporary` and `openclaw-gateway-state` volumes
   if present in the saved manifest. Copy their corresponding mounts and any
   subPaths from `prepare-private-state` to the init container and from `gateway`
   to the maintenance container. Copy `OPENCLAW_STATE_DIR` from `gateway`. Do not
   copy configuration, credential, trust or plugin volumes or mounts. If the
   layout does not match, keep the Agent stopped and ask the infrastructure
   operator for recovery guidance. In the maintenance Pod only, remove the init
   script's configuration file copy and the `chmod` for that file if present.
   Keep all directory preparation and mode changes on private state directories.
   Without the init container, recovery fails with
   `No safe OpenClaw temp root is available`.

   For Harness recovery, use the pinned Harness image and its `runAsUser` and
   `runAsGroup`. Mount only the recorded subPath at `/home/node/.openclaw-node`
   and set `OPENCLAW_STATE_DIR` to that path. A Harness has no profile. Omit
   `fsGroup`, or copy the original Pod's `fsGroup` and `fsGroupChangePolicy`
   together into the maintenance Pod only when the policy is `OnRootMismatch`.
   The default policy can change permissions across the claim and cause
   `Runtime pin store owner is unsafe`.

   Inspect the locks without starting a Gateway or Harness.

   ```sh
   node /app/openclaw.mjs gateway recover-lock --json
   ```

3. Match every reported holder to the stopped workload. Leave all locks intact if
   any holder is unidentified or could still write. Otherwise, repeat the command
   with `--confirm` and the exact `confirmation` fingerprint from the inspection.
   For Harness recovery, run both commands in the same maintenance container.
   If OpenClaw reports a changed record, inspect and verify the holders again.
4. Exit the maintenance container, deploy the Agent again and send a chat message
   to verify it can use its retained state.

If the Kubernetes Compute Harness Deployment already fails with
`Runtime pin store owner is unsafe`, stop the Agent and verify shutdown as in
step 1. Mount only the recorded subPath in a maintenance container without
`fsGroup`, then run `chmod -R go-rwx,g-s /home/node/.openclaw-node` and deploy again.

## A save or deployment lost its response

In the original Namespace, check before retrying.

- **Draft edit.** Compare the edited fields in `occ agent get AGENT_ID --output json`.
  For concurrent edits, check the [audit evidence](audit-log.md#investigate-an-uncertain-agent-edit).
- **Credentials.** Reload **Credentials** and check the saved bindings. Operators
  can inspect generated transport storage through the Agent's runtime-credentials API.
- **Deployment.** Check **Viewing version** and its status. Deploying again creates
  another version. For `deploy-first`, use the printed [read-only recovery command](agent-revisions.md#guarded-first-deployment-and-receipt-recovery).
- **[Workspace file](workspace-files.md).** Reload and compare its contents with your edit.

For partial Agent creation, see [Console recovery](../../reference/console/create-and-deploy.md).

## A plugin does not work after deployment

Look for `PLUGIN_INSTALL_FAILED` or `PLUGIN_AUTH_REQUIRED` in the
[deployment status](../../reference/agents.md#deployment-status). A deployment can
succeed while the affected plugin is disabled for that startup. Inspect the
[plugin configuration](plugins-configure.md#check-the-result) before redeploying;
a successful deployment does not confirm that a third-party connector is usable.

## An OpenShell Agent stops answering

For a dedicated Codex Agent on OpenShell, if the Sandbox is running but replies
time out, ask the operator to check the Agent Gateway's route to OpenShell:
Gateway egress, matching OpenShell ingress
and, for secure WebSocket (WSS) connections, the served certificate's coverage
of the advertised service hostname. A successful control-endpoint check does
not establish that the certificate covers the advertised hostname. Keep
hostname verification enabled; correct the owning network or certificate
configuration, then [verify a model response](../operate/model-verification.md).

On OpenShell, OCE asks the gateway to restart the Harness whenever its process
exits. `occ agent runtime AGENT_ID` shows
`Harness Sandbox: starting (HARNESS_RESTARTING, last exit code N, restart N)` for
the few seconds this takes, then `running`; chat usually answers again within a
minute. A plain `starting`, with no code, is a first start. A Harness that keeps
exiting stays `HARNESS_RESTARTING` with a growing restart number while OpenShell
backs off (up to three minutes between attempts), and the version's diagnostics
lead with a failed `agent` `sandbox` check with that code. Read
[OpenShell sandbox and supervisor logs](#read-openshell-sandbox-and-supervisor-logs)
to investigate repeated exits.

OCE does not replace a Sandbox whose Pod was deleted or evicted, or that a node
restart stopped. The Agent stays `active` while every chat fails. `occ agent get`
and `occ agent runtime` show `Harness Sandbox: lost (CODE)` (`SANDBOX_FAILED`
here, `SANDBOX_STOPPED` after a node restart or supervisor Pod deletion, or
`HARNESS_EXITED` for an older version whose Harness exited), the Console's
**Live serving** shows **Sandbox lost**, and the version's diagnostics lead with
a failed `agent` `sandbox` check carrying the same code. Deploy the Agent again
(`occ agent deploy AGENT_ID`): the new version replaces the old Sandbox.
`unknown (UNAVAILABLE)` means OCC could not read the Sandbox record.

If a controller upgrade changes an older development Sandbox's immutable
command, exact-content adoption can fail; deploy the Agent again.

## Read OpenShell sandbox and supervisor logs

The [Sandbox source](agent-logs.md#sandbox-source) shows what the OpenShell
gateway recorded. For stock OpenShell's two-Pod topology, confirm your current
Kubernetes context, the workload's Kubernetes namespace and its Agent revision ID.
Use Bash and `jq` with `list pods` and
`get pods/log` permissions in that namespace. **These logs bypass OCC redaction.**
Inspect them locally and remove sensitive values before sharing.

```bash
(
  ns='<workload-namespace>'
  revision='<agent-revision-id>'

  one_pod() {
    local pods
    pods=$(kubectl -n "$ns" get pods -l "$1" -o json) || {
      echo "$2 Pod lookup failed" >&2
      return 1
    }
    jq -ce --arg role "$2" '
      .items | if length == 0 then error("No matching \($role) Pod")
               elif length > 1 then error("Multiple matching \($role) Pods")
               else .[0].metadata end' <<<"$pods"
  }

  harness=$(one_pod "openclaw.dev/workload-role=agent,openclaw.dev/revision=$revision" Harness) || exit 1
  pod_name='.name | strings | select(length>0)'
  harness_name=$(jq -er "$pod_name" <<<"$harness") || exit 1
  status=0
  kubectl get --raw "/api/v1/namespaces/$ns/pods/$harness_name/log?container=agent&tailLines=200" || {
    echo 'Harness log read failed' >&2
    status=1
  }

  id=$(jq -er '.annotations["openshell.ai/sandbox-id"] // empty' <<<"$harness") &&
    [[ $id =~ ^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$ ]] || {
      echo 'Missing or invalid Sandbox ID on the Harness Pod' >&2
      exit 1
    }
  supervisor=$(one_pod "openshell.ai/sandbox-id=$id,openshell.ai/boundary-role=supervisor" supervisor) || exit 1
  supervisor_name=$(jq -er "$pod_name" <<<"$supervisor") || exit 1
  kubectl get --raw "/api/v1/namespaces/$ns/pods/$supervisor_name/log?container=supervisor&tailLines=200" || {
    echo 'Supervisor log read failed' >&2
    status=1
  }
  exit "$status"
)
```

Lookup failures leave Pod presence unknown. Check namespace, Agent revision
and [deployment status](../../reference/agents.md#deployment-status). Both reads
require one named Harness Pod. Supervisor logs require a valid Sandbox ID and
one named supervisor Pod.
