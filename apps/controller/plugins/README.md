# OCE managed plugin packages

The [OCE marketplace index](./marketplace.json) lists packages by name and relative directory.
Each package has a [plugin.json](./oce-google-workspace/plugin.json) at its root. The
`ai.openclaw.oce` extension points to the release that OCE deploys.

- [Google Workspace](./oce-google-workspace/ai.openclaw.oce/release.json) pins the ClawHub skill and Linux `gog` binaries.
- [Slack](./oce-slack/mcp.json) declares Slack’s hosted MCP server. The [release](./oce-slack/ai.openclaw.oce/release.json) pins the descriptor and names the public-channel search tool. The worker stages the server with `enabled: false` until OCE supports binding a Slack user connection. See [Slack MCP](https://docs.slack.dev/ai/slack-mcp-server/).

Slack’s account slot pins the OAuth issuer and protected resource that the connection template must match. During setup, the connection service would discover these from the MCP endpoint’s `WWW-Authenticate` challenge, request only `search:read.public`, and send the resource in both the authorization and token requests. Slack requires a preregistered OAuth client. Its authorization and token endpoints are on `slack.com`, while its issuer and protected resource are `https://mcp.slack.com`. [Slack resource metadata](https://mcp.slack.com/.well-known/oauth-protected-resource) · [Slack authorization server metadata](https://mcp.slack.com/.well-known/oauth-authorization-server)

The Plugin Driver registers each package by version. Publish changed release bytes under a new version so existing Agent selections continue to identify the reviewed release.

The package’s OCE extension declares `policyScope: "enablement_only"`. The Plugin Driver advertises this scope for the versioned plugin ID so the Console can render the same enable switch as a Codex plugin before catalog discovery completes. OCC refuses tool approvals, reviewers, and per-tool overrides for these packages.

Each release declares the `account` credential slot for a future binding. It names
the worker placeholder and declares which HTTP requests or MCP tools may use it.
Google’s public discovery request takes no credential. The installer reads the
package without binding this slot. A binding implementation must give the Harness
an opaque placeholder and check its request against the release before substituting
a bearer at egress. An absent binding grants no credentialed route.

The package follows the Agent Plugins JSON schema and keeps skills beside the manifest.
For the packaging conventions, see the [OpenAI plugin structure](https://developers.openai.com/plugins/build/plugins#plugin-structure)
and [Anthropic plugin layout](https://code.claude.com/docs/en/plugins-reference#standard-layout).
