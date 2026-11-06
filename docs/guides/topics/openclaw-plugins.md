---
tags: [human_verified]
last_verified: "2026-11-06"
---

# Get started with managed OpenClaw plugins

Add managed plugins to a dedicated OpenClaw Agent on Kubernetes, deploy the revision, and verify tool execution in chat.

This guide walks through two managed plugin types:
- **CLI plugins** using **Google Workspace** (`occ-plugin:google`), which runs the pinned `gog` command on the worker.
- **Hosted MCP plugins** using **Slack** (`occ-plugin:slack`), which connects to a streamable Model Context Protocol endpoint.

> [!NOTE]
> Dedicated Codex Agents use a separate curated app catalog and approval model. If you use Codex, see [Add Codex plugins to an OpenShell Agent](../integrations/codex-plugins.md).

## Before you start

Before you add plugins to an Agent, make sure your environment meets these requirements:

1. **Dedicated OpenClaw on Kubernetes**: The Agent must use the dedicated OpenClaw Harness on Kubernetes Compute. Embedded OpenClaw supports only the bundled Diffs plugin.
2. **Plugin Driver enabled**: The Installation profile must select the bundled OpenClaw Plugin Driver (`occ-plugin` under `drivers.plugin`). See [Driver selection](../../reference/drivers/plugin-bundled.md#selection-and-catalogs).
3. **Operator permissions**: You need `agent:read`, `agent:update`, and `agent:deploy` on the target Agent, plus `credential_source:operate` on any attached account source.
4. **Network connectivity**: For hosted MCP discovery, the OCC API must be able to reach the MCP HTTPS endpoint on port 443. Configure `api.pluginDiscoveryCidrs` in your Helm values to allow egress to the server IP addresses.

---

## 1. Add a CLI plugin (Google Workspace)

The Google Workspace plugin bundles the `gog` CLI tool on the dedicated worker.

### Configure the plugin in the console

1. Open the OCC console and navigate to **Agents**.
2. Select your dedicated OpenClaw Agent, then select **Create new version** → **Plugins**.
3. Select **Configure plugins**.
4. In the catalog list, find **Google Workspace** and select **Add**.
5. Choose your account mode:
   - **Install without an account**: Verifies that the worker image and CLI binary run without injecting external credentials. You can test tool startup by asking the Agent to run `gog --version`.
   - **Connected account**: Select an attached Google account credential source. The worker receives an OpenShell placeholder for that account, and the Gateway enables the Google Workspace skill.
6. Select **Save plugin selections**.

### Configure via CLI

You can also update the Agent draft using the OCC CLI:

```bash
occ agent get "$AGENT_ID" --output json > agent-draft.json

node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const agent = JSON.parse(readFileSync("agent-draft.json", "utf8"));
const plugins = {
  ...agent.plugins,
  "occ-plugin:google": {
    enabled: true,
    toolDefaults: { approval: "provider_default" },
  },
};
writeFileSync("agent-plugin-update.json",
  JSON.stringify({ configurationId: agent.configurationId, plugins }, null, 2) + "\n");
JS

occ agent update "$AGENT_ID" --file agent-plugin-update.json --output json
```

---

## 2. Add a hosted MCP plugin (Slack)

Hosted MCP packages declare a fixed remote HTTPS server endpoint and an authentication placeholder. The Slack plugin connects to `https://mcp.slack.com/mcp`.

### Set up the credential source

Hosted MCP plugins require a registered bearer token credential source:

1. In the console, navigate to **Credentials** → **Register Source**.
2. Create a source with:
   - **Type**: `bearer-token`
   - **Protocol**: `mcp`
   - **Host**: `mcp.slack.com`
   - **Port**: `443`
   - **Path**: `/mcp`
   - **Environment Variable**: `SLACK_MCP_TOKEN`
3. Attach the credential source to your Agent draft.

### Load and select MCP tools

1. Under **Plugins** → **Configure plugins**, select **Slack**.
2. In the **Credential Slot**, select your attached Slack credential source.
3. Select **Load tools**. The OCC API connects to the MCP server endpoint and fetches the advertised tool descriptors.
4. Select the explicit tools you want the Agent to access (for example, `slack_search_public`).
5. Select **Save plugin selections**.

> [!IMPORTANT]
> The worker only advertises tools explicitly selected in the tool filter. An empty tool selection leaves the MCP server disabled.

---

## 3. Deploy the new revision

Saving plugin selections updates the Agent draft. You must deploy a new revision to apply the changes to the running worker:

```bash
occ agent deploy "$AGENT_ID" --output json > deployment.json
DEPLOYMENT_ID="$(node -p "require('./deployment.json').id")"
export DEPLOYMENT_ID
```

Check the deployment status until it reaches `succeeded`:

```bash
occ agent deployment-status "$AGENT_ID" "$DEPLOYMENT_ID" --output json
```

If the deployment reports a warning such as `PLUGIN_INSTALL_FAILED`, review the deployment events and verify that the plugin package matches the worker's runtime version.

---

## 4. Verify tool calls in chat

Once the deployment succeeds, start a conversation with the Agent to confirm that the plugin executes correctly.

### Verify Google Workspace (CLI)

Ask the Agent to inspect its Google Workspace CLI:

```text
Run gog --version and report the installed version.
```

When an account is connected, ask the Agent to list files or calendar events:

```text
Use Google Workspace to list the first 3 events from my primary calendar.
```

**What to look for in the response:**
- The Agent turn executes `gog` inside the dedicated worker container.
- The tool result displays structured command output or JSON from Google APIs.
- The model cites the returned calendar events or file names in its reply.

### Verify Slack (MCP)

Ask the Agent to search public channels:

```text
Search public Slack messages for "release notes" with limit 3.
```

**What to look for in the response:**
- In the client's activity timeline, confirm a tool call event for `slack_search_public`.
- The MCP request routes through the OpenShell sandbox with the `SLACK_MCP_TOKEN` placeholder injected securely.
- The Agent returns the matching message excerpts from the MCP server response.

You can inspect the effective node-level MCP configuration on the dedicated worker:

```bash
OPENCLAW_CONFIG_PATH="$OPENCLAW_NODE_STATE_DIR/openclaw.json" \
  openclaw config get nodeHost.mcp.servers.oce_mcp_slack --json
```

---

## Open implementation boundaries

Certain advanced account management capabilities are currently tracked in active milestone PRs:

- **Saved OAuth account refresh**: Background renewal of Namespace OAuth credentials through the shared Token Service is implemented in [PR #4671](https://github.com/openclaw/openclaw-enterprise/pull/4671).
- **Direct in-slot consent**: Granting Agents access to saved accounts and launching fresh browser consent directly from a plugin slot is tracked in [PR #4673](https://github.com/openclaw/openclaw-enterprise/pull/4673).
- **Multi-account plugin slots**: Selecting between multiple connected accounts for the same provider on an Agent is tracked in [Issue #4815](https://github.com/openclaw/openclaw-enterprise/issues/4815) ([PR #4732](https://github.com/openclaw/openclaw-enterprise/pull/4732)).
- **Custom namespace plugins**: Importing custom skills and remote MCP descriptors beyond bundled packages is tracked in [Issue #4816](https://github.com/openclaw/openclaw-enterprise/issues/4816) ([PR #4734](https://github.com/openclaw/openclaw-enterprise/pull/4734)).

---

## Related documentation

- [Agent plugins overview](plugins.md)
- [Configure Agent plugins](plugins-configure.md)
- [Add Codex plugins to an OpenShell Agent](../integrations/codex-plugins.md)
- [Agent plugin reference](../../reference/agent-plugins.md)
- [OpenShell Credential Gateway reference](../../reference/drivers/openshell-credential-gateway.md)
