# Agents

An Agent is an AI workload that you create and deploy inside a
[Namespace](../../reference/namespaces.md). It has its own identity and, once
deployed, its own gateway. Its [Harness](../../reference/harness-execution.md)
calls the model and runs tools. If you are new to OpenClaw Enterprise,
[set up an OpenShell Codex Agent](../deploy/local-setup.md) and verify that it can answer.

## How an Agent runs

1. **Create a draft.** Give the Agent a name, select an execution mode, and
   choose a Configuration and model credential. Saving a draft alone does not
   start the Agent. If the Console says it will provision and deploy the Agent,
   **Create Agent** requests the first deployment. Continue to step 3.
2. **Deploy only if creation saved a draft without requesting deployment.**
   Deploy snapshots the saved draft as a new revision and queues work to start
   it. If the outcome is uncertain, [reconcile the request](agent-revisions.md#update-and-deploy).
   Later draft edits take effect on the next deployment.
3. **Check the result.** A selected version means deployment progressed. The
   console's **Logs** tab shows Pod status, restarts, Events and container
   output. On Kubernetes, **Run diagnostics for this version** checks Slack
   and can report startup failures and Harness Sandbox status. To test the model, use a
   configured channel or, when available, **Open chat** or **Open Agent UI**.
   Send a message and check that the model replies.
4. **Stop when needed.** Stopping ends execution and routing but preserves
   version history, credentials, and persistent state. Deploying again starts
   a new version. To remove the Agent and its versions,
   [delete it](../../reference/agents.md#deletion). There is no rollback endpoint.

## Work with an Agent

- [Compute](agent-compute.md): choose embedded OpenClaw or dedicated Codex and
  see which infrastructures support them.
- [Agent revisions](agent-revisions.md): update configuration, deploy, and
  inspect what changed.
- [Workspace files](workspace-files.md): edit the running Agent's instructions
  and identity files.
- [Plugins](plugins.md): add selected tools and decide which actions require
  approval.
- [Troubleshoot](agent-troubleshoot.md): investigate deployment, model access,
  and uncertain requests.

For exact permissions, API behavior, and credential rules, use the
[Agent reference](../../reference/agents.md).
