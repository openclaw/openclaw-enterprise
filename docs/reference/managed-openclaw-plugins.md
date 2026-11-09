# Managed OpenClaw plugin support

On a dedicated OpenClaw Agent on Kubernetes, the `occ-plugin` catalog offers
Google Workspace and Slack. An Agent can use both packages. OpenClaw Enterprise
(OCE) ships reviewed releases in its controller and runtime images. Choose the
packages and credential sources in the Agent’s Plugins tab, then deploy a new
version. An Installation can also offer the Codex catalog to Agents using the
Codex Harness. See [Configure Agent plugins](../guides/topics/plugins-configure.md).

Credentialed calls use the [OpenShell Sandbox](drivers/openshell-sandbox.md)
development configuration. Its experimental APIs await production qualification.

## Available now

| Plugin           | What runs                                                                                             | Credential and request policy                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Google Workspace | The Gateway loads a skill. The Harness runs the pinned [gog](https://github.com/openclaw/gogcli) CLI. | Attach a compatible OpenShell `oauth2-refresh-token` source for API access. Its host, path, and OAuth scopes limit the operations available through `gog`. A shared request guard checks the operation before OpenShell injects the bearer. [Register a source](credential-sources.md#register-a-source) and [configure the Google request guard](../guides/credential-proxy.md#enable-google-workspace-requests-from-a-dedicated-worker). |
| Slack            | The Harness runs the MCP client. Slack hosts the server.                                              | Attach an OpenShell `bearer-token` source with a usable access token for the package’s fixed HTTPS endpoint. Load tools using that account, then select the upstream tool names to allow. [Hosted MCP setup](../guides/topics/plugins-configure.md#configure-a-hosted-mcp-plugin).                                                                                                                                                         |

For Model Context Protocol (MCP), the worker advertises selected tools and the
Gateway controls which ones the model can call. OpenShell also checks each
credentialed `tools/call` against the saved tool names before injection. The
same check applies to direct requests from scripts using an admitted
executable. Enabling a tool requires a new deployment. Removing a plugin from
the next version keeps independently attached credentials. To stop an existing
version from using one, [withdraw the source](credential-sources/withdrawal.md).

Embedded OpenClaw on Kubernetes has a separate bundled Diffs integration. See
[Agent plugin support](agent-plugins.md#current-support) for its policy controls.

Installation administrators can register OAuth clients and set up connection templates under
**Credentials**. A signed-in user with permission to create a credential in the
Namespace can start consent through the connections API. After the provider
returns a refresh grant, Token Service stores and renews the saved account.
[Connect an account](connection-templates.md#connect-an-account).

## Pending support

- **Use a saved OAuth account from a plugin.** Granting an Agent access to
  that account, selecting it in the Plugins tab, and using its renewed token
  for discovery or tool calls are in development. Use the attached source
  types above today.
- **Import plugins and add custom MCP endpoints.** The dedicated catalog uses
  the bundled releases and their reviewed endpoints. Importing packages,
  selecting a custom server, and browsing or installing releases from ClawHub
  are pending.
- **Choose Google products or actions in Plugins.** This picker is planned.
  Today the attached source and the reviewed Google operation map determine
  which requests `gog` can make.
- **Extend request policy.** The bundled OpenShell paths use Credential Gateway
  sources. Plugin delivery through the protected Credential Proxy, MCP argument
  restrictions, and invocation approvals for these managed plugins are pending.

See the [deployment flow](../flows/agent-plugins.md) for how OCE turns an Agent’s
selection into worker configuration, Gateway tool policy, and Sandbox policy.
