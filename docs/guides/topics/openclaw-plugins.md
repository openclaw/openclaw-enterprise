---
tags: [human_verified]
last_verified: "2026-11-06"
---

# Get started with managed OpenClaw plugins

Configure a managed Plugin on a dedicated OpenClaw Agent. Use TokenService and the native OpenShell Credential Proxy for a static Slack MCP credential. Install Google Workspace without an account to check the bundled CLI. Google Workspace OAuth delivery is deferred. [Plugin OAuth follow-up #4673](https://github.com/openclaw/openclaw-enterprise/pull/4673)

Dedicated Codex Agents use their own catalog and approval policy. [Add Codex apps](../integrations/codex-plugins.md)

<a id="use-a-pre-cutover-release"></a>

For a release that uses Credential Gateway, use the [pre-cutover Plugin runbook](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/guides/topics/openclaw-plugins.md).

<a id="evaluate-plugin-credentials-in-the-cutover-candidate"></a>

## Before you start

- Use a dedicated OpenClaw Agent on Kubernetes. Select the bundled OpenClaw Plugin Driver, OCC TokenService, and the OpenShell Sandbox that supplies native Credential Proxy delivery. [Driver selections](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/drivers/selection.md#supported-selections)
- Verify the Agent's [managed model Source configuration](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/credential-sources/managed-static.md#deploy-an-agent-with-the-source). To edit and deploy a Plugin selection you need read, update, and deploy access to the Agent, plus `credential_source:operate` on the selected Source.
- For Slack, ensure that the OCC API can reach `mcp.slack.com:443` for tool discovery. The Agent's Sandbox applies separate policy to runtime requests.

<a id="2-add-a-hosted-mcp-plugin-slack"></a>

## 1. Add a hosted MCP plugin (Slack)

Slack uses the fixed endpoint `https://mcp.slack.com/mcp`. Live Slack MCP tool execution through the cutover's native Proxy remains unqualified. The steps below cover Source setup and admission. [Plugin binding rules](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/credential-sources.md#bind-a-source-to-an-agent)

<a id="installation-prerequisites"></a>

### Set up the credential source

1. In **Credentials → Connection templates**, create a **Static Bearer** Template available in the Agent's Namespace. Add the exact destination `POST`, host `mcp.slack.com`, port `443`, path `/mcp`. Record the Template ID. [Create a Template](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/connection-templates.md#create-a-template)
2. Register the Slack token as a managed static Source in the ready Namespace. Set `NAMESPACE_ID` and `TEMPLATE_ID` to the exact IDs, and `TOKEN_FILE` to the path of your private token file. The command prints the new Source ID. [Static Source registration](https://github.com/openclaw/openclaw-enterprise/blob/a009380c8f3a0ae4cf410e5850993aa6a7567bfe/docs/reference/credential-sources/managed-static.md#register-a-source)

   ```bash
   (
     set -euo pipefail
     umask 077
     source_request=$(mktemp)
     trap 'rm -f "$source_request"' EXIT
     jq -n --arg template "$TEMPLATE_ID" --rawfile token "$TOKEN_FILE" \
       '{name:"slack-mcp",type:"static",connectionTemplateId:$template,secret:($token|rtrimstr("\n"))}' \
       > "$source_request"
     occ credential-source create --namespace "$NAMESPACE_ID" \
       --file "$source_request" --output json | jq -er .id
   )
   ```

3. Grant `credential_source:operate` on the exact Source to the deploying operator and Agent service principal. With OCC-managed Native IAM, saving an eligible Plugin selection can grant the Agent access as part of the same transaction.

### Load and select MCP tools

1. Open the Agent draft's **Plugins** tab, select **Configure plugins**, and add **Slack**.
2. Select the static Source in the credential slot. The slot supplies the Source at admission.
3. Select **Load tools** and choose the exact tools the Agent may call. An empty selection leaves the server disabled.
4. Select **Save plugin selections**. The selection applies when you deploy a new revision.

<a id="1-add-a-cli-plugin-google-workspace"></a>

## 2. Add a CLI plugin (Google Workspace)

<a id="account-and-request-guard-prerequisites"></a>
<a id="configure-the-plugin-in-the-console"></a>
<a id="configure-via-cli"></a>

The Google Workspace package (`occ-plugin:google@1.0.0`) includes the `gog` command. Under **Plugins → Configure plugins**, add **Google Workspace**, choose **Install without an account**, and save the selection. This checks CLI startup without making Google API calls.

## 3. Deploy the new revision

Before replacing a running managed-credential deployment, use **Stop** and wait for it to finish. Deploy the saved draft from the Console or from an [authenticated OCC CLI session](../cli.md#connect-to-your-installation):

```bash
occ agent deploy "$AGENT_ID" --output json > deployment.json
DEPLOYMENT_ID="$(jq -er .id deployment.json)"
occ agent deployment-status "$AGENT_ID" "$DEPLOYMENT_ID" --output json
```

Wait for `succeeded` and check that the Agent's `activeRevisionId` matches `DEPLOYMENT_ID`. This checks activation. For Slack, a successful tool discovery or deployment does not establish a working runtime call.

## 4. Verify tool calls with the OpenClaw TUI

<a id="attach-to-the-agent"></a>
<a id="verify-google-workspace-cli"></a>

Follow the [OpenClaw TUI procedure](../deploy/production-tui.md) to attach to the Ready Agent Gateway. Ask the Agent to run `gog --version`. The tool output should report the installed CLI version.

<a id="verify-slack-mcp"></a>

For a Slack evaluation, check that the intended tool is advertised. A live verification requires a tool call from the running Agent and a successful upstream tool result. It also requires a denied call for an ungranted tool to establish policy enforcement.

## Open implementation boundaries

- [Plugin OAuth delivery](https://github.com/openclaw/openclaw-enterprise/pull/4673)
- [Multi-account Plugin slots](https://github.com/openclaw/openclaw-enterprise/issues/4815)
- [Custom Namespace plugins](https://github.com/openclaw/openclaw-enterprise/issues/4816)

## Related documentation

- [Configure Agent plugins](plugins-configure.md)
- [Agent plugin reference](../../reference/agent-plugins.md)
