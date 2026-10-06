# Troubleshoot Agents

Start with the symptom you can observe. When asking an operator for help, give
them the Namespace, Agent ID, revision ID, approximate time, and any request ID
the console shows. Never include API keys, tokens, or Secret values.

## The Agent or Namespace is missing

Open **Namespaces** and confirm that you selected the intended Namespace. The
console and HTTP API only list resources your identity can read. If the
Namespace is absent, ask your administrator to check your access. If it is
`provisioning` or `failed`, an operator must check its
[provisioning status](../../reference/namespaces.md#lifecycle) before deployment.
Once access is fixed, refresh and confirm the Namespace is `ready`.

## Deployment is blocked or has no selected revision

On Kubernetes, open the Agent's **Create new version** draft, then
**Credentials**. Select **Reload authentication source**, then confirm under
**Harness authentication** that **Authentication source** is the source you
expect, not **None**. Check that the saved model authentication matches the
execution mode. For an OpenAI API key, the person selecting it and the Agent's
own identity both need `operate` on the exact platform Secret. See
[Harness authentication](../../reference/agents.md#harness-authentication).

If the deployment was accepted, use the returned revision ID to check its
[deployment status](../../reference/agents.md#deployment-status):

```text
GET /namespaces/:namespaceId/agents/:agentId/deployments/:revisionId
```

| Status      | Next check                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `queued`    | If it stays queued, ask the operator whether a worker is available.                                                          |
| `running`   | A worker holds the work. If it stays running, ask the operator to check workload startup, storage, and required credentials. |
| `failed`    | Give the returned error code and revision ID to the operator. Correct the reported cause before requesting a new deployment. |
| `succeeded` | The requested work completed; this does not establish live model availability. Verify a model response separately.           |

For Kubernetes workload problems, operators can use the
[Compute failure checks](../../reference/drivers/kubernetes-compute.md#failure-conditions).
When a Kubernetes deployment fails with `DEPENDENCY_UNAVAILABLE` after its
retries, the worker log's `worker.compute-prepare-failed` events for that
revision name the code, preparation step and reason. The log Collector exports
the code but not the step or reason. `KUBERNETES_OWNERSHIP_CONFLICT` means the
driver refused an object it does not own, such as a Deployment with the Agent's
workload name but no OCE ownership labels. The driver never adopts such an
object. Delete it, then deploy again.

<span id="the-console-says-serving-status-unavailable"></span>

## Verify runtime health after deployment

The console's **Deployment activity** shows persisted status; it has no live
gateway-health or chat view. **Current version** means the control plane selected
that revision. It can be a version whose deployment failed, for example when an
embedded replacement's model check rejected its key after it replaced the
previous version; see
[the active revision after a failed deployment](../../reference/agents/deployment.md#the-active-revision-after-a-failed-deployment).
That selection cannot tell you whether the model still accepts
the credential or can answer. Use [Deploy your first Agent](../first-agent.md)
to verify your local setup or ask an operator to
[verify a production workload](../deploy/production-agents.md#verify-production-workloads).
Check for an actual answer from the configured model, not just an active
revision or successful file read.

## A save or deployment lost its response

The operation may have succeeded. Before retrying:

- For model and channel credentials, reload the Agent's Credentials tab and check
  its saved bindings. An operator can inspect generated transport storage through
  the exact Agent runtime-credentials API.
- For deployment, inspect the Agent's **Versions** list and the status for the
  revision already admitted; a second deployment creates another revision.
- For a workspace file, reload that file and compare its content with your
  intended edit before saving again.

See [console recovery](../../reference/console/create-and-deploy.md) for partial
Agent creation and [workspace files](workspace-files.md) for editing limits.

## A plugin does not work after deployment

Look for `PLUGIN_INSTALL_FAILED` or `PLUGIN_AUTH_REQUIRED` in the
[deployment status](../../reference/agents.md#deployment-status). A deployment can
succeed while the affected plugin is disabled for that startup. Inspect the
[plugin configuration](plugins-configure.md#check-the-result) before redeploying;
a successful revision does not confirm that a third-party connector is usable.

## Read OpenShell sandbox and supervisor logs

The [Sandbox source](agent-logs.md#sandbox-source) shows only what the OpenShell
gateway recorded. An operator with `pods/log` access to the Agent's Kubernetes
namespace can read the Harness output and the supervisor's own log. Each
revision's Sandbox has two Pods that share an `openshell.ai/sandbox-id`: the
Harness Pod, which keeps OCC's `openclaw.dev/revision` label, and the
supervisor Pod, labeled `openshell.ai/boundary-role=supervisor`:

```bash
REVISION_ID=<revision-id>
HARNESS_SELECTOR="openclaw.dev/workload-role=agent,openclaw.dev/revision=$REVISION_ID"
NS="$(kubectl get pod -A -l "$HARNESS_SELECTOR" \
  -o jsonpath='{.items[*].metadata.namespace}' | cut -d' ' -f1)"
SANDBOX_ID="$(kubectl -n "${NS:?no Harness Pod for this revision}" get pod -l "$HARNESS_SELECTOR" \
  -o jsonpath='{.items[*].metadata.annotations.openshell\.ai/sandbox-id}' | cut -d' ' -f1)"
kubectl -n "$NS" logs --all-containers --tail=200 -l "$HARNESS_SELECTOR"
kubectl -n "$NS" logs --all-containers --tail=200 \
  -l "openshell.ai/sandbox-id=${SANDBOX_ID:?no Sandbox ID on the Harness Pod},openshell.ai/boundary-role=supervisor"
```

The first command finds the Agent's Kubernetes namespace from its Harness Pod.
`no Harness Pod for this revision` means the revision never started a Sandbox or
its Pods are gone; read the
[deployment status](../../reference/agents.md#deployment-status) instead.

`kubectl -n "$NS" get sandbox,pod -l "openshell.ai/sandbox-id=$SANDBOX_ID"`
shows the Sandbox and its supervisor Pod. This output bypasses OCC's log
redaction, so handle it as sensitive.
