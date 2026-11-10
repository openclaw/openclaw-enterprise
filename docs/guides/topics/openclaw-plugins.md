---
tags: [human_verified]
last_verified: "2026-11-06"
---

# Get started with managed OpenClaw plugins

Add managed plugins to a dedicated OpenClaw Agent on Kubernetes, deploy the revision, and verify tool execution through the OpenClaw terminal interface.

This guide walks through two managed plugin types:

- **CLI plugins** using **Google Workspace** (`occ-plugin:google@1.0.0`), which runs the pinned `gog` command on the worker.
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

The Google Workspace plugin (`occ-plugin:google@1.0.0`) bundles the `gog` CLI tool on the dedicated worker.

### Account and request guard prerequisites

Credentialed Google Workspace calls require two setup steps before deployment:

1. **OAuth refresh source**: Register an OpenShell-owned OAuth refresh credential source attached to your Agent draft. The source specifies the Google token endpoint, client placeholder, authorized scopes (such as `https://www.googleapis.com/auth/calendar.readonly`), and allowed destinations (`www.googleapis.com` for Calendar or `gmail.googleapis.com` for Gmail). See [Bind a credential source to an Agent](../../reference/credential-sources.md#bind-a-source-to-an-agent).
2. **Google request guard**: Install and register the shared request guard on your OpenShell Gateway. For each request, the OpenShell supervisor verifies the call against the release's operation map locally through this guard before sending approved requests upstream. Follow [Enable Google Workspace requests from a dedicated worker](../credential-proxy.md#enable-google-workspace-requests-from-a-dedicated-worker).

> [!NOTE]
> Saved Namespace OAuth accounts from [PR #4671](https://github.com/openclaw/openclaw-enterprise/pull/4671) will support direct in-slot connection once [PR #4673](https://github.com/openclaw/openclaw-enterprise/pull/4673) lands. Until then, use an attached OpenShell credential source.

### Configure the plugin in the console

1. Open the OCC console and navigate to **Agents**.
2. Select your dedicated OpenClaw Agent, then select **Create new version** → **Plugins**.
3. Select **Configure plugins**.
4. In the catalog list, find **Google Workspace** and select **Add**.
5. Choose your account mode:
   - **Install without an account**: Verifies that the worker image and CLI binary run without injecting external credentials. You can test tool startup by asking the Agent to run `gog --version`.
   - **Connected account**: Select your attached Google account credential source. The worker receives an OpenShell placeholder for that account, and the Gateway enables the Google Workspace skill.
6. Select **Save plugin selections**.

### Configure via CLI

Managed packages use the catalog's versioned identifier (`occ-plugin:google@1.0.0`) and accept an enablement-only policy (`enabled: true`):

```bash
occ agent get "$AGENT_ID" --output json > agent-draft.json

node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const agent = JSON.parse(readFileSync("agent-draft.json", "utf8"));
const plugins = {
  ...agent.plugins,
  "occ-plugin:google@1.0.0": {
    enabled: true,
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

### Installation prerequisites

Managed MCP plugins require the worker Node executable to be allowed in the Credential Gateway configuration:

- In your Helm values under `drivers.credential_gateway.configuration`, add `/usr/local/bin/node` to `toolBinaries`. Without this entry, bearer-token registration is rejected with `409 RESOURCE_CONFLICT`. See [OpenShell Credential Gateway configuration](../../reference/drivers/openshell-credential-gateway.md#configure-the-driver).

### Set up the credential source

If the Agent already has the intended Slack source, skip registration. Otherwise, the person registering it needs permission to create Secrets and credential sources in the ready Namespace and to operate the referenced Secret. The Agent service principal does not need those creation permissions.

1. Follow [Create a Namespace-owned Secret](../../reference/drivers/kubernetes-secret.md#create-a-namespace-owned-secret) with the Slack token in a protected file. Choose a descriptive name such as `slack-mcp-token`. Save the successful HTTP 201 response as `slack-secret-created.json` in a private operator directory. The response contains metadata only. Use its `data.ref`; the display name is not a Secret ID. Keep the token itself out of command arguments.

2. With `jq` installed and `NAMESPACE_ID` set to the Agent's Namespace, build the registration document from that response and register the source:

   ```bash
   jq -e --arg ns "$NAMESPACE_ID" '
     .data.ref
     | select(.kind == "secret" and .namespaceId == $ns and (.id | strings | startswith("sec_")))
     | {kind, namespaceId, id}
     | {name: "slack-mcp", type: "bearer-token",
        config: {protocol: "mcp", host: "mcp.slack.com", port: "443",
                 path: "/mcp", env_var: "SLACK_MCP_TOKEN"},
        secrets: {token: .}}
   ' slack-secret-created.json > slack-source.json &&
     occ credential-source create --namespace "$NAMESPACE_ID" --file slack-source.json --output json
   ```

   Keep the returned source ID for the attachment. If the reference does not match the Namespace, stop and check the Secret receipt.

3. Attach the credential source to your Agent draft and grant both your operator identity and the Agent service principal `credential_source:operate` permission on it. See [Bind a source to an Agent](../../reference/credential-sources.md#bind-a-source-to-an-agent).

### Load and select MCP tools

1. In the console under **Plugins** → **Configure plugins**, select **Slack**.
2. In the **Credential Slot**, select your attached Slack credential source.
3. Select **Load tools**. The OCC API connects to `https://mcp.slack.com/mcp` and fetches the advertised tool descriptors.
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

## 4. Verify tool calls with the OpenClaw TUI

The OCC Console provides administrative controls rather than an interactive chat interface, and HTTP model verification checks raw model connectivity without emitting tool call events. To interact with the deployed Agent and observe live tool execution, attach using the **OpenClaw TUI**.

### Attach to the Agent

1. **Authentication prerequisite**: Ensure your Agent runtime configuration specifies the optional gateway password SecretRef. See [Configure the Agent runtime](../deploy/production-agents.md#configure-the-agent-runtime).
2. Connect to the Ready gateway Pod following the [OpenClaw TUI verification procedure](../deploy/production-tui.md):

   ```bash
   SESSION_ID="plugin-verify-$(date +%s)"
   OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
     node /app/openclaw.mjs tui --session "$SESSION_ID"
   ```

### Verify Google Workspace (CLI)

In your TUI session, ask the Agent to inspect its Google Workspace CLI:

```text
Run gog --version and report the installed version.
```

When a connected account is attached, ask the Agent to list calendar events:

```text
Use Google Workspace to list the first 3 events from my primary calendar.
```

**What to look for in the response:**

- The Agent turn executes `gog` inside the dedicated worker container.
- The tool result displays structured command output from Google APIs.
- The model cites the returned calendar events in its final reply.

### Verify Slack (MCP)

Ask the Agent to search public channels:

```text
Search public Slack messages for "release notes" with limit 3.
```

**What to look for in the response:**

- In the TUI activity timeline, confirm a tool call event for `slack_search_public`.
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
- [Verify an Agent with the OpenClaw TUI](../deploy/production-tui.md)
- [Enable Google Workspace requests](../credential-proxy.md#enable-google-workspace-requests-from-a-dedicated-worker)
