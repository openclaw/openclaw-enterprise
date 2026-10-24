# Product guides

<span id="user-guide"></span>

Use OpenClaw Enterprise to create and run Agents. If you are changing the
platform itself, start with [Contribute](../contributing/README.md).

## Get started

Read [Concepts](concepts.md) for Namespaces, Agents, versions, and Secrets. Then choose a setup:

- [Local Setup](quickstart.md): run the platform on your machine and [deploy your first Agent](first-agent.md).
- [Kubernetes Setup](kubernetes-setup.md): install the control plane on an existing cluster, then [deploy and verify an Agent on it](deploy/production-agents.md).

## Work with Agents

- Use the [console](../reference/console.md) to manage Agents, Configuration,
  and workspace files.
- Read about [deployments and versions](../reference/agents/deployment.md)
  or [Agent plugins](../reference/agent-plugins.md).
- Use the [OCC CLI](cli.md) or [HTTP API](../reference/api.md) for automation.

## Administer an installation

Start with [access control](../reference/authorization.md),
[credential renewal and revocation](deploy/credential-lifecycle.md),
[observability](observability.md), or
[production handoff and recovery](deploy/production-handoff.md).
