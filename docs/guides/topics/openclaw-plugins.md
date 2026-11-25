---
tags: [human_verified]
last_verified: "2026-11-06"
---

# Get started with managed OpenClaw plugins

Add a reviewed Plugin to a dedicated OpenClaw Agent, select its account and tools, then deploy a new Agent revision.

## Before you start

- Use dedicated OpenClaw with Kubernetes Compute and the `occ-plugin` Plugin Driver. See [Driver selection](../../reference/drivers/plugin-bundled.md#selection-and-catalogs).
- Have Agent `read`, `update`, and `deploy` permission. To select an account, you also need `credential_source:operate` on its Source. Source `read` controls which accounts appear in the picker.
- Configure the selected Credential Proxy and Sandbox for native HTTP or MCP delivery. The OCE API must also reach the MCP server for tool discovery.
- Prepare a compatible approved Connection Template and OAuth client, or a ready static Source associated with that Template. See [credential sources](../../reference/credential-sources.md) and [register a static Source](../../reference/credential-sources/managed-static.md#register-a-source).

## Select a Plugin and account

1. Open the Agent in Console and choose **Create new version** → **Plugins** → **Configure plugins**. The same picker is available when creating an Agent.
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

Deploy the Agent draft to apply the account and tool selection to a new revision. Edits to the draft do not change the running Agent. Follow [verify an Agent with the OpenClaw TUI](../deploy/production-tui.md) to start a real model turn.

For Google Workspace, ask the Agent to run `gog --version`, then request a read permitted by the account's granted scopes, such as listing primary-calendar events. The version check proves CLI installation; a successful API result proves credentialed access.

For Slack, ask the Agent to search a harmless term using a selected search tool. Check the actual MCP tool result. To verify enforcement, attempt an unselected tool through a direct script and inspect the Sandbox or Credential Proxy denial. Proving that the upstream received no request requires a controlled MCP server.

## Related documentation

- [Configure Agent plugins](plugins-configure.md)
- [Agent plugin reference](../../reference/agent-plugins.md)
- [Credential Proxy](../credential-proxy.md)
- [Add Codex plugins](../integrations/codex-plugins.md)
