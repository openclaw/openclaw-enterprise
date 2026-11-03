# Product guides

<span id="user-guide"></span>

Use OpenClaw Enterprise to create and run Agents. If you are changing the
platform itself, start with [Contribute](../contributing/README.md).

## Get started

Read [Concepts](concepts.md) for Namespaces, Agents, versions, and Secrets. Then choose a setup:

- [Local k3d](deploy/local-setup.md)
- [Kubernetes](deploy/kubernetes-setup.md)
- [Amazon EKS](deploy/eks-openshell-setup.md)

All three paths install OpenShell and finish with an onboarded, running Codex Agent. Use the same saved session for [Add Git](repository-credentials/openshell-git-push.md), [Add Plugin](integrations/codex-plugins.md), and [Delete Agent](deploy/quickstart-delete-agent.md), then clean up the selected installation.

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
