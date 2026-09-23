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

On Kubernetes, open the Agent's **New revision → Credentials** and confirm that
**Transport** shows **Stored**. Check that the saved model authentication matches
the execution mode. For an OpenAI API key, the person selecting it and the
Agent's own identity both need `operate` on the exact platform Secret. See
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

<span id="the-console-says-serving-status-unavailable"></span>

## Verify runtime health after deployment

The console displays persisted deployment status; it has no live gateway-health
or chat view. **Selected revision** means the control plane selected that revision. It
cannot tell you whether the model still accepts the credential or can answer.
Use [Deploy your first Agent](../first-agent.md) to verify your local setup or
ask an operator to [verify a production workload](../deploy/production-agents.md#verify-production-workloads).
Check for an actual answer from the configured model, not just an active
revision or successful file read.

## A save or deployment lost its response

The operation may have succeeded. Before retrying:

- For credentials, select **Refresh status** and check what is already stored.
- For deployment, inspect the Agent's revision history and the status for the
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
