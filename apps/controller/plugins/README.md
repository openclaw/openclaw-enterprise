# OCE managed plugin packages

The [OCE marketplace index](./marketplace.json) lists packages by name and relative directory.
Each package has a [plugin.json](./oce-google-workspace/plugin.json) at its root. The
`ai.openclaw.oce` extension points to the release that OCE deploys.

- [Google Workspace](./oce-google-workspace/ai.openclaw.oce/release.json) pins the ClawHub skill and Linux `gog` binaries.
- [Slack](./oce-slack/mcp.json) declares Slack’s hosted MCP server. The [release](./oce-slack/ai.openclaw.oce/release.json) pins the descriptor. Once connected, OpenClaw discovers the tools Slack publishes through MCP `tools/list`. The worker stages the server with `enabled: false` until OCE supports binding a Slack user connection. See [Slack MCP](https://docs.slack.dev/ai/slack-mcp-server/).

Slack’s release reserves an `account` slot for a future worker binding. Installing the package does not attach a credential or enable the MCP server.

The Plugin Driver registers each package by version. Publish changed release bytes under a new version so existing Agent selections continue to identify the reviewed release.

The package’s OCE extension declares `policyScope: "enablement_only"`. The Plugin Driver advertises this scope for the versioned plugin ID so the Console can render the same enable switch as a Codex plugin before catalog discovery completes. OCC refuses tool approvals, reviewers, and per-tool overrides for these packages.

Google Workspace’s optional `account` slot refers to a credential attached to the Agent.
OpenShell supplies the worker with a placeholder. The request guard checks the
[pinned operation map](./oce-google-workspace/ai.openclaw.oce/operations.json) and the source’s host, path and scope limits before
OpenShell substitutes the bearer. The Agent can also attach credentials for use
outside the plugin. The [operator guide](../../../docs/guides/credential-proxy.md#enable-google-workspace-requests-from-a-dedicated-worker)
describes registration and verification. See the [operation map generator](../../../scripts/google-operation-map/README.md) for coverage and regeneration.

The package follows the Agent Plugins JSON schema and keeps skills beside the manifest.
For the packaging conventions, see the [OpenAI plugin structure](https://developers.openai.com/plugins/build/plugins#plugin-structure)
and [Anthropic plugin layout](https://code.claude.com/docs/en/plugins-reference#standard-layout).
