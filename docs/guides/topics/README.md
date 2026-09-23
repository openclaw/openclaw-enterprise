# Topics

Use these guides to understand how Agents run, control what they can access,
and decide which changes require a new deployment. If you are new to OpenClaw
Enterprise, start with [Concepts](../concepts.md) or
[deploy your first Agent](../first-agent.md).

## Agent

- [Agent overview](agent.md): identity, supported operations,
  and what happens when you deploy or stop an Agent.
- [Presets](agent-presets.md): reuse launch settings and fill variables when creating an Agent.
- [Compute](agent-compute.md): where Agents run and which execution modes each
  bundled Driver supports.
- [Harness](../../reference/harness-execution.md): how OpenClaw or Codex runs
  the model and authenticates to it.
- [Workspace files](workspace-files.md): edit an active Agent's instruction and
  identity files.
- [Console walkthrough](../console/agent-details.md): understand each Agent detail
  control, status, and editing surface.
- [Troubleshoot](agent-troubleshoot.md): follow a failed deployment, check model
  access, or recover after an uncertain request.

## Security

- [IAM](iam.md): who can sign in and which resources they can use. For
  sign-in methods and sessions, see [authentication](../../reference/authentication.md).
- [Namespaces](../../reference/namespaces.md): how Agents and configuration
  belong to teams or tenants.
- [Sandbox](sandbox.md): what isolates a workload and where the current limits
  are.
- [Secrets](secrets.md): how to use credentials without putting their values in
  configuration.
- [Audit Log](audit-log.md): which security and management actions are recorded
  and who can access those records.

## Capabilities and configuration

- [Plugins](plugins.md): which curated tools an Agent may
  use and how approval rules work. Follow [Configure](plugins-configure.md) to
  change an Agent's selections.
- [Configuration](../../reference/configuration.md): what belongs to an
  installation, a Namespace, or an Agent draft.
- [Agent Revisions](agent-revisions.md): change a draft, deploy it, and inspect
  the snapshot the Agent runs.

For setup instructions for a specific vendor or Driver, use
[Integrations](../integrations/README.md). For installation-wide work, use
[Operate](../operate/README.md).
