# Agents

An Agent is an AI workload that you create and deploy inside a
[Namespace](../../reference/namespaces.md). It has its own identity and, once
deployed, its own gateway. Its [Harness](../../reference/harness-execution.md)
calls the model and runs tools. If you are new to OpenClaw Enterprise,
[deploy your first Agent](../first-agent.md) and verify that it can answer.

## How an Agent runs

1. **Create a draft.** Give the Agent a name, select an execution mode, and
   choose a Configuration and model credential. Creation saves the draft; it
   does not start anything.
2. **Deploy the draft.** The control plane saves an immutable revision and a
   worker starts it. Editing a draft later does not change the running Agent;
   deploy again to apply the new settings.
3. **Check the result.** A selected revision means deployment progressed. The
   console's **Logs** tab shows Pod status, restarts, Events and container
   output. On Kubernetes, **Run diagnostics for this version** checks only the
   Slack channel. Neither tests the model, and OCE has no browser chat. Check an
   actual model response before treating a new deployment as working.
4. **Stop when needed.** Stopping ends execution and routing but preserves
   revision history, credentials, and persistent state. Deploying again starts
   a new revision. To remove the Agent and its revisions,
   [delete it](../../reference/agents.md#deletion). There is no rollback endpoint.

## Work with an Agent

- [Compute](agent-compute.md): choose embedded OpenClaw or dedicated Codex and
  see which infrastructures support them.
- [Agent Revisions](agent-revisions.md): update configuration, deploy, and
  inspect what changed.
- [Workspace files](workspace-files.md): edit the running Agent's instructions
  and identity files.
- [Plugins](plugins.md): add selected tools and decide which actions require
  approval.
- [Troubleshoot](agent-troubleshoot.md): investigate deployment, model access,
  and uncertain requests.

For exact permissions, API behavior, and credential rules, use the
[Agent reference](../../reference/agents.md).
