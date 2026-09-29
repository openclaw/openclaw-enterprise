# OpenClaw Enterprise

OpenClaw Enterprise (OCE) is the open source, vendor neutral platform for managing agents. Think of it as Kubernetes for agents.

The OpenClaw Control Plane (OCC) adds multi-tenancy, governance, and hard security boundaries to OpenClaw agent deployments.

<a id="user-guide"></a>
<a id="start-and-deploy"></a>

## Getting started

Choose where to install:

- [Local Setup](guides/quickstart.md): run the platform on your machine, then [deploy your first Agent](guides/first-agent.md). You need an OpenAI API key for that walkthrough.
- [Kubernetes Setup](guides/kubernetes-setup.md): install the control plane on a cluster you already operate, then [deploy and verify an Agent on that installation](guides/deploy/production-agents.md).

If you are still learning the product, start with [Concepts](guides/concepts.md).

<a id="reference"></a>

## Explore the docs

| Section                                       | Use it to                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| [Topics](guides/topics/README.md)             | Understand Agents, access and security, plugins, and configuration.      |
| [Integrations](guides/integrations/README.md) | Choose and configure Drivers, experimental Backends, and channels.       |
| [Operate](guides/operate/README.md)           | Install and run the platform, manage credentials, and diagnose failures. |
| [Reference](reference/README.md)              | Look up OCC CLI commands and HTTP API operations.                        |
| [Contribute](contributing/README.md)          | Set up a development environment and change the platform or its docs.    |

<a id="platform-developer-guide"></a>
<a id="contribute"></a>
<a id="architecture"></a>
<a id="understand-the-code"></a>
<a id="implementation-history"></a>

Contributors can start with [Contribute](contributing/README.md), which links
the [platform architecture](design.md), remaining design work, runtime flows, and
historical specifications.
