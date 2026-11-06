# Connect GitHub, Microsoft 365 Work IQ, or Notion to an OpenClaw Agent

On a dedicated OpenClaw Agent on Kubernetes, open **Create new version → Plugins → Configure plugins** and add the plugin. Choose the account or token for the provider below. The Agent can use the tools you select after you deploy the new version.

## GitHub

Create a fine-grained GitHub personal access token. Select the repositories the Agent needs and grant the permissions for the tools you intend to enable. For example, give the token read access to issues to look up an issue in a selected repository. The GitHub plugin uses GitHub.com's hosted MCP server at `https://api.githubcopilot.com/mcp/`, including the trailing slash. [GitHub's remote MCP setup](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/set-up-the-github-mcp-server#remote-mcp-server-configuration-with-pat)

Under **GitHub account**, [register the token](#register-a-token-and-deploy) or select an existing compatible source. To verify read access, enable `issue_read` if the account offers it, deploy, and ask the Agent for the title of a known issue.

## Microsoft 365 Work IQ

Have your tenant administrator enable Work IQ and consent to the delegated permissions your workflow needs. Obtain an access token for the signed-in user from their home Microsoft Entra tenant, with Work IQ as the resource. For a read workflow, request `api://workiq.svc.cloud.microsoft/WorkIQ.Read`. The plugin sends the token to `https://workiq.svc.cloud.microsoft/mcp`. [Tenant setup](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/enable-work-iq) · [Work IQ permissions](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions)

Under **Work IQ delegated access token**, [register the token](#register-a-token-and-deploy) or select an existing compatible source. Choose tools according to the access you intend to grant. For example, `fetch` can read Outlook messages, calendar events, and other Microsoft 365 resource paths the user and tenant permit. Selecting `fetch` enables that tool across those paths. After deployment, ask the Agent to fetch a known event the user can read. [Work IQ tool reference](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/tool-reference)

When the access token expires, obtain another delegated token, replace the value in its Secret, [update the source](../../reference/credential-sources.md#update-a-source), and redeploy the Agent.

## Notion

The Notion plugin uses `https://mcp.notion.com/mcp`. Choose how the Agent will connect:

- **Workspace MCP token.** A Notion workspace owner on a Business or Enterprise plan chooses **New MCP token** in the Notion Developer portal. Under **Notion account** in OCE, [register the token](#register-a-token-and-deploy) or select an existing compatible source. [Notion MCP token requirements](https://developers.notion.com/guides/mcp/get-started-with-mcp#faqs)
- **User OAuth account.** An Installation admin creates a [connection template](../../reference/connection-templates.md#register-a-client) using **Discover from an MCP server URL** and the Notion endpoint. If the template has no client, register the OCE callback with Notion and enter the issued client ID. Under **Notion account**, select a saved account and choose **Save plugin selections**. To connect a new one, save the enabled plugin first, choose **Connect with OAuth** or **Choose a connection template**, select the Notion template and `default` scope, then choose **Connect and attach**. Approve access in Notion. Deployment with OAuth requires a [sender that supports saved accounts](../../reference/drivers/credential-proxy.md#saved-oauth-accounts).

Enable `notion-search` if the account offers it, deploy, and ask the Agent to find a page visible to that account. Check that the result identifies the expected page.

## Register a token and deploy

1. On an Installation using the OpenShell Credential Gateway without a selected Credential Proxy, an Installation admin chooses **Add MCP token** in the plugin. Enter a token name, select or create the **Token Secret**, and choose **Register token**. The plugin supplies the destination and placeholder for the source. Choose **Save plugin selections** to grant this Agent access.
2. Choose **Load tools**. Select the tool names the Agent may call, save the selections, and choose **Deploy new version**. The OCE API needs network access to the service for discovery. The worker needs the deployed Sandbox policy for calls. [Hosted MCP network setup](plugins-configure.md#configure-a-hosted-mcp-plugin)
