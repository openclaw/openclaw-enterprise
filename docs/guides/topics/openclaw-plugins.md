---
tags: [human_verified]
last_verified: "2026-11-06"
---

# Get started with managed OpenClaw plugins

Add a reviewed Plugin to a dedicated OpenClaw Agent, select its account and tools, then deploy a new Agent revision.

<a id="use-a-pre-cutover-release"></a>
<a id="evaluate-plugin-credentials-in-the-cutover-candidate"></a>

## Before you start

- Use dedicated OpenClaw with Kubernetes Compute and the `occ-plugin` Plugin Driver. See [Driver selection](../../reference/drivers/plugin-bundled.md#selection-and-catalogs).
- Have Agent `read`, `update`, and `deploy` permission. To select an account, you also need `credential_source:operate` on its Source. Source `read` controls which accounts appear in the picker.
- To connect a new OAuth account, have Namespace `credential_source:create`. To create an Agent, have Namespace `agent:create`.
- Configure the selected Credential Proxy and Sandbox for native HTTP or MCP delivery. The OCE API must also reach the MCP server for tool discovery.
- Prepare a compatible approved Connection Template and OAuth client, or a ready static Source associated with that Template. See [credential sources](../../reference/credential-sources.md) and [register a static Source](../../reference/credential-sources/managed-static.md#register-a-source).

<a id="2-add-a-hosted-mcp-plugin-slack"></a>
<a id="installation-prerequisites"></a>

## Set up a static Slack credential source

For static Slack MCP access, ask an Installation administrator to create a
**Static Bearer** Connection Template available in the Agent's Namespace. Allow
only `POST mcp.slack.com:443/mcp`. Obtain a valid Slack MCP OAuth user token
for an eligible registered Slack app with the
[scopes required by the selected tools](https://docs.slack.dev/ai/slack-mcp-server/#oauth-scopes-needed-on-user-token-for-different-tools).
With Namespace `credential_source:create`, open **Credentials** → **Create Source**.
Enter a Source name, select the approved Slack Static Bearer Template under
**Credential purpose**, enter the token as **Credential value**, and select
**Create Source**. For API or CLI enrollment, see [register a static Source](../../reference/credential-sources/managed-static.md#register-a-source).

Give the selecting operator exact Source `read` and `operate`. The deployer
and Agent service principal need exact Source `operate`; Native IAM can grant
the Agent access transactionally when saving an eligible selection.

<a id="1-add-a-cli-plugin-google-workspace"></a>
<a id="account-and-request-guard-prerequisites"></a>
<a id="configure-the-plugin-in-the-console"></a>
<a id="configure-via-cli"></a>

## Select a Plugin and account

1. Open the Agent in Console and choose **Open draft** → **Plugins** → **Configure plugins**. The same picker is available when creating an Agent.
2. Add **Google Workspace** for the worker's pinned `gog` CLI, or **Slack** for a hosted MCP server.
3. Select a compatible account in the Plugin's credential slot. For OAuth, choose **Connect account**, select the Connection Template and OAuth client, and complete provider consent. Console returns the created Source to the Plugin editor. For a static bearer, select an existing compatible Source.
4. Save the Plugin selection. Selecting the Source in the slot contributes it to deployment admission; do not create a separate Agent credential attachment for the Plugin.

Google Workspace executes `gog` on the dedicated worker. Slack connects to its reviewed MCP endpoint. Neither Plugin needs its account's real token in Gateway configuration.

## Select MCP tools

1. In the Slack Plugin, select **Load tools**. OCE authenticates to the reviewed MCP server using the selected Source.
2. Select the upstream tools the Agent may use. The picker omits names that the reviewed Plugin cannot deploy. Tools are not selected automatically.
3. Save the Plugin selection. An empty selection leaves the hosted MCP server disabled.

The worker advertises the selected names. With a compatible Credential Proxy and Sandbox, the deployed MCP policy also rejects unselected direct requests from scripts. See [managed MCP support](../../reference/agent-plugins.md#current-support) for implementation limits.

## Deploy and verify

If an active revision exists and either it or the saved draft uses managed credential delivery, Stop the Agent and wait until it has no active revision. Deploy the draft to apply the account and tool selection. Edits to the draft do not change the running Agent. Follow
[verify an Agent with the OpenClaw TUI](../deploy/production-tui.md) to start a real model turn.

<a id="attach-to-the-agent"></a>
<a id="verify-google-workspace-cli"></a>

For Google Workspace, ask the Agent to run `gog --version`, then list one Gmail message ID with the reviewed `gmail.users.messages.list` operation:

```sh
gog --json --no-input api call gmail v1 gmail.users.messages.list --params '{"userId":"me","maxResults":1}'
```

The version check proves CLI installation; a successful API result proves credentialed access. The Source must permit the Gmail messages-list endpoint and have a compatible Gmail scope.

<a id="verify-slack-mcp"></a>

For Slack, ask the Agent to search a harmless term using a selected search tool.
Check the actual MCP tool result. To verify enforcement, attempt an unselected
tool through a direct script and inspect the Sandbox or Credential Proxy denial.
Live [Slack OAuth qualification](https://github.com/openclaw/openclaw-enterprise/pull/4673)
covered a successful selected search and an OpenShell denial for an unselected
tool; it did not provide an upstream request counter. Static Slack MCP and
Google OAuth live execution remain separately unverified.

## Related documentation

- [Configure Agent plugins](plugins-configure.md)
- [Agent plugin reference](../../reference/agent-plugins.md)
- [Credential Proxy](../credential-proxy.md)
- [Add Codex plugins](../integrations/codex-plugins.md)
