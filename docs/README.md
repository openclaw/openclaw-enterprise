# OpenClaw Enterprise

OpenClaw Enterprise (OCE) uses the OpenClaw Control Plane (OCC) to deploy and manage Agents. Set up the platform locally or on an existing Kubernetes cluster, then deploy an Agent and verify its model response.

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

For application metrics, see the [OCC metrics contract](reference/metrics.md),
[production scraping](guides/observability/metrics.md), and the
[development dashboard](testing/metrics.md).

For repository access, see the [repository credential setup](guides/repository-credentials.md) and [credential lifecycle reference](reference/repository-credentials.md). Contributors can follow the [Agent repository flow](flows/agent-repository-credentials.md), [credential flow](flows/repository-credentials.md), [configuration flow](flows/repository-credential-configuration.md), and [test guide](testing/repository-credentials.md).

For a screenshot tour of the Agent page, see the
[Console walkthrough](guides/console/agent-details.md).

Trusted operators can use the [Agent native admin UI](reference/agent-native-admin.md) pilot to open the stock OpenClaw UI through OCC.

<a id="platform-developer-guide"></a>
<a id="contribute"></a>
<a id="architecture"></a>
<a id="understand-the-code"></a>
<a id="implementation-history"></a>

Contributors can start with the [repository layout](layout.md), [current architecture](ARCHITECTURE.md), or [runtime flows](contributing/runtime-flows.md). The [platform design](design.md) and [spec archive](../specs/README.md) also cover proposals; use the current documentation to check what is supported. The [Agent native admin UI flow](flows/agent-native-admin.md) traces console access and private gateway proxying.

The [repository credential RFC](../specs/31-repository-credentials.md) and its
[qualification companion](../specs/31-repository-credentials/qualification.md)
record planned authority modes and historical evidence separately from current support.
