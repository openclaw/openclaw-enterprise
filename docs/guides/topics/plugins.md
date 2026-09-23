# Agent plugins

Plugins give an Agent extra tools or access to an integration. Select them per
Agent: two Agents can share a Configuration without sharing plugins. New Agents
start with no user-selected plugins. An Installation operator must select a
compatible Plugin Driver before an Agent can deploy with plugins.

## Choose a supported plugin

- **Embedded OpenClaw** supports the bundled Diffs plugin on Kubernetes. Diffs
  lets an Agent show the difference between two pieces of text. Start with
  [Configure Agent plugins](plugins-configure.md).
- **Dedicated Codex** can use selected apps from its curated catalog when the
  runtime supports their approval policy. See [supported plugins and approval
  policies](../../reference/agent-plugins.md#current-support).
- **SSH Compute** supports Agents without user-selected plugins only.

## Know when a change takes effect

Saving a selection does not change the running Agent. Deploy a new revision to
apply it. A deployment can succeed with a plugin disabled if installation fails
or, for Codex, the app still needs authentication.
[Check the deployment warnings](plugins-configure.md#check-the-result), then
ask the deployed Agent to use the plugin and inspect its tool result. The
documented TUI tool check needs the optional gateway loopback password; the
HTTP model check shows only the assistant's reply. Disabling or removing a plugin
also requires a new deployment and does not interrupt an active turn.

Plugin approval does not grant filesystem access or override the Agent's
authorization, network, or sandbox restrictions. See the
[Agent plugin reference](../../reference/agent-plugins.md) for approval modes,
request fields, and failure behavior.
