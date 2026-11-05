# OCE managed plugin packages

The [OCE marketplace index](./marketplace.json) lists packages by name and relative directory.
Each package has a [plugin.json](./oce-google-workspace/plugin.json) at its root. The
`ai.openclaw.oce` extension points to the release that OCE deploys.

- **CLI packages** pin skills and worker executables, such as [Google Workspace](./oce-google-workspace/ai.openclaw.oce/release.json) with its ClawHub skill and Linux `gog` binaries. The release declares the executable’s `runtimeDirectory` and artifact hashes.
- **Hosted MCP packages** declare a remote server, such as [Slack](./oce-slack/mcp.json) with its [Slack MCP endpoint](https://docs.slack.dev/ai/slack-mcp-server/).

To bundle another managed MCP server, add its package to the marketplace index. Its `mcp.json` declares one Streamable HTTP server with a fixed HTTPS endpoint. Its [release](./oce-slack/ai.openclaw.oce/release.json) pins the descriptor hash and declares the credential slot, bearer placeholder, and MCP protocol versions. The controller and runtime images ship the reviewed package together. OCE discovers tools separately with each selected account. The Agent owner selects tools once, and the worker routes each call to the chosen account. The Sandbox translates the selected names into request policy; the bundled OpenShell implementation enforces them before credential injection. Newly discovered tools require selection and deployment before calls are allowed.

The Plugin Driver registers each package by version. Publish changed release bytes under a new version so existing Agent selections continue to identify the reviewed release.

The package’s OCE extension declares `policyScope: "enablement_only"`. The Plugin Driver advertises this scope for the versioned plugin ID so the Console can render the same enable switch as a Codex plugin before catalog discovery completes. OCC refuses tool approvals, reviewers, and per-tool overrides for these packages.

Every declared slot accepts multiple accounts. Google Workspace’s optional `account` slot uses one OpenShell placeholder per selected credential. The request guard checks the
[pinned operation map](./oce-google-workspace/ai.openclaw.oce/operations.json) and the shared destination and operation policy before OpenShell substitutes the selected bearer. Google enforces that account’s OAuth scopes. The Agent can also attach credentials for use
outside the plugin. The [operator guide](../../../docs/guides/credential-proxy.md#enable-google-workspace-requests-from-a-dedicated-worker)
describes registration and verification. See the [operation map generator](../../../scripts/google-operation-map/README.md) for coverage and regeneration.

The package follows the Agent Plugins JSON schema and keeps skills beside the manifest.
For the packaging conventions, see the [OpenAI plugin structure](https://developers.openai.com/plugins/build/plugins#plugin-structure)
and [Anthropic plugin layout](https://code.claude.com/docs/en/plugins-reference#standard-layout).
