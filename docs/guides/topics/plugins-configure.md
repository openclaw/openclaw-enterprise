# Configure Agent plugins

Use the console or OpenClaw Control Plane (OCC) CLI to change an existing Agent's
plugin selections, then deploy a new version. The CLI example enables the
bundled Diffs plugin on an embedded OpenClaw Agent running on Kubernetes. Dedicated
Codex Agents use a different catalog and approval policy; see
[plugin support](../../reference/agent-plugins.md#current-support).

If an existing selection belongs to a different or unknown Driver, save an empty
plugin map first. Then select the plugins offered for the Agent's Harness and
deploy a new version. This also lets you correct an older embedded OpenClaw Agent
whose selections belonged to the Codex Driver.

## Use the console

Open **Agents**, select the Agent, then open **Create new version** → **Plugins**.
Use **Configure plugins** to edit saved selections and tool policy. On a dedicated
OpenClaw Agent on Kubernetes with the bundled OpenClaw Plugin Driver, add
**Google Workspace** with **Install without an account** to check `gog --version`.
Google OAuth delivery is deferred to [#4673](https://github.com/openclaw/openclaw-enterprise/pull/4673).
For a credentialed static MCP integration, select a compatible TokenService
Source in its slot and load the tools. See [managed OpenClaw plugins](openclaw-plugins.md).
The operator and Agent need Source `operate` permission. Clearing a slot or
removing a Plugin applies on the next deployment; to end access sooner,
[withdraw the binding](../../reference/credential-sources/withdrawal.md).

Dedicated Codex Agents with a supported login can browse their app catalog.
For other Agents, use **Plugin selections JSON** to enter a known plugin ID.
The CLI example below uses Diffs.
For dedicated Codex browsing, the curated catalog needs no account credential.
Hosted discovery uses a ready Codex account Source through TokenService; see
[Codex Apps](../integrations/codex-plugins.md). Select **Save plugin selections**, then
follow [Deploy the change](#deploy-the-change). The prior version keeps its
original selections. On its **Plugins** tab, you can inspect that immutable
snapshot. See the [Plugins tab guide](../console/configuration-plugins-and-files.md#plugins-tab)
for the controls and [deployment status](../../reference/agents.md#deployment-status)
for the result. Catalog visibility alone does not prove that the plugin is
installed or available to the running Agent. Hosted discovery uses the Agent's
current draft credential, which may differ from its running version's.

For an unavailable plugin, use the information button beside its row to open the
reason and any setup link. Press Escape or click outside to dismiss the popover.
Selecting the row also shows this guidance in the detail pane; **Add** stays
disabled.

The default approval menu follows the selected Driver's capabilities. Codex
offers all four choices; embedded OpenClaw disables `all_actions` and
`write_actions`. The API rejects those unsupported values as well.

For a selected Codex app, choose `write_actions` as its default approval and
`human` as its default reviewer to request operator approval for actions Codex
does not mark read-only. New app actions inherit that default. Deploy, then
check the effective policy and a normal Agent turn; a saved selection alone does
not prove approval routing. See the [approval policy](../../reference/agent-plugins.md#approval-policy)
and [runtime proof limits](../../reference/drivers/plugin-bundled.md#native-mappings-and-limits).

<a id="configure-slack-search"></a>

## Configure a hosted MCP plugin

A hosted MCP package pins its server endpoint and declares a credential slot.
For static HTTP or MCP credentials, register a TokenService Source using a
Static Bearer Connection Template restricted to the endpoint and method. Select
that Source in the Plugin slot, grant the operator and Agent service principal
`credential_source:operate`, and deploy with the paired Credential Proxy and
Sandbox. The worker advertises selected tools; the Sandbox enforces the selection
for worker and script calls. Follow [managed OpenClaw plugins](openclaw-plugins.md)
for the commands. See the [support limits](../../reference/agent-plugins.md#current-support).
Plugin OAuth serving remains deferred to [#4673](https://github.com/openclaw/openclaw-enterprise/pull/4673).

For **Load tools**, verify that the OCC API can resolve and reach the MCP
endpoint. The chart permits API egress. Runtime tool calls use the Agent's
Sandbox policy.

Open **Plugins**, add the plugin, choose the Source, and choose **Load tools**.
Choose the tools to enable, then save and [deploy the change](#deploy-the-change). Loading tools again refreshes the inventory and preserves your selection.
Changing the Source clears the tools and their approval overrides. Choose and
configure tools again before you deploy. An empty selection leaves the server disabled.
For an enabled tool, open **Tool policy** and set **Require approval for** to
**Every action** to require human approval for each native call. Select
**No additional approval** to run without a prompt. The request names the server and tool;
it does not show arguments. Save and [deploy the change](#deploy-the-change). A direct
script using the same credential can call that enabled tool without Gateway approval.
If the Slack channel is enabled, remove native Slack per-plugin approver overrides before deploying a managed MCP approval policy.
Removing the plugin keeps its independently attached
credential; [withdraw the source](../../reference/credential-sources/withdrawal.md)
to revoke a running version's credential access.

For Slack MCP, restrict the Template to `POST https://mcp.slack.com/mcp` and select
`slack_search_public` if the account advertises it. Inspect the worker server and
tool filter:

```sh
OPENCLAW_CONFIG_PATH="$OPENCLAW_NODE_STATE_DIR/openclaw.json" openclaw config get nodeHost.mcp.servers.oce_mcp_slack --json
```

These checks verify configuration and admission. A real Slack MCP tool call with
this static Source has not been qualified.

## Before you start

- [Connect the OCC CLI](../cli.md#connect-to-your-installation) to your
  Installation. The examples also use Node.js and a protected service-key file.
- Choose an Agent configured for embedded OpenClaw on Kubernetes and an
  Installation that explicitly selects the bundled OpenClaw Plugin Driver
  (an `occ-plugin` entry under `drivers.plugin`); no Plugin Driver is selected by default.
  See [Driver selection](../../reference/drivers/plugin-bundled.md#selection-and-catalogs).
  SSH Compute rejects Agents with plugin selections or an Agent default plugin
  approver policy.
- You need permission to read, update, and deploy the Agent, read its
  Configuration, and read the new Agent revision. Every Agent update, including
  a plugin-only change, also needs `operate` on the Agent's Harness
  authentication Secret or credential source and on each Secret its
  Configuration binds; without them the update returns `403`. Agent revision `read` is
  [bound per AgentRevision](../../reference/authorization.md#manage-namespace-policy), so a member with
  only exact grants cannot read the status of an Agent revision that did not exist
  when the grants were made; an administrator can check it or grant `read` on
  that Agent revision. Existing
  [model credential requirements](../../reference/agents.md#harness-authentication)
  still apply when deploying.
- Check the Agent Configuration's tool policy. Selecting Diffs adds it to the
  [tool allowlist](../../reference/drivers/plugin-bundled.md#native-mappings-and-limits).
  If the Configuration's `tools.deny` blocks every Diffs tool, for example with
  `"*"`, `"diffs"` or `"group:plugins"`, Agent create, update, provisioning
  and deployment return `400` naming `tools.deny` and the plugin. A deny-all list
  would leave no callable tool, so every turn would fail. Remove the matching
  deny item before selecting Diffs. Create Agent checks the pair before it saves
  anything, so after this refusal every field stays editable, the Configuration
  included. If Agent create refuses after the console saved the Configuration,
  the console names the fix it allows: deselect the plugin and create the Agent, then fix the setting
  on the Agent's Configuration tab and select the plugin again. With one Agent under `agents.entries`, its
  own `tools.deny` counts too, and the error names it. With several, the error
  names an Agent whose `tools.deny` denies all tools with `"*"`, because all of
  its turns would fail once a plugin is selected. To keep a tool-less Agent,
  move it to a Configuration without plugins. Denying only Diffs to some
  Agents is allowed. The `deny` list under `tools.byProvider.<provider>` for
  the primary model's provider counts the same way, at the top level and under
  an Agent entry. A `tools.byProvider` object that also has a
  `<provider>/<model>` key for that provider is not checked, because OpenClaw
  may rewrite the model ID it matches.
- Check the Configuration's plugin settings. With Diffs enabled, the Gateway
  does not start when `plugins.enabled` is `false`, `plugins.deny` lists
  `diffs`, or a non-empty `plugins.allow` leaves it out. Configuration save
  refuses an item in either list that is not text, such as `1`. OCE writes the
  `plugins.entries.diffs` entry from the selection. The Configuration can hold
  only an exact copy: `{"enabled": true}` with Diffs enabled, or
  `{"enabled": false}` with it disabled. With an HTTPS `gateway.publicOrigin` listed in
  `gateway.controlUi.allowedOrigins` and Diffs enabled, it must not hold one.
  Agent create, update, provisioning and deployment return `400` naming the
  setting.
- With one Agent under `agents.entries` and a `minimal`, `coding` or
  `messaging` tool profile, the Agent's own `tools.alsoAllow` replaces the
  top-level list that grants Diffs, so the request returns `400` unless that
  list names Diffs, for example `"diffs"`.

Set the Namespace and Agent IDs from your Installation:

```bash
export OCC_NAMESPACE='<namespace-id>'
export AGENT_ID='<agent-id>'
```

## Select Diffs

Read the Agent's current selections and create an update that keeps them.
The API requires `configurationId` on every Agent update and replaces the whole
plugin map; sending only Diffs would remove any other saved selections.

```bash
occ agent get "$AGENT_ID" --output json > agent-before-plugins.json

node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const agent = JSON.parse(readFileSync("agent-before-plugins.json", "utf8"));
const plugins = {
  ...agent.plugins,
  "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "provider_default" } },
};
writeFileSync("agent-plugin-update.json",
  JSON.stringify({ configurationId: agent.configurationId, plugins }, null, 2) + "\n");
JS

occ agent update "$AGENT_ID" --file agent-plugin-update.json --output json
```

The returned `plugins` map should contain `occ-plugin:diffs` with `enabled: true`.
The `provider_default` policy uses Diffs' existing execution behavior without an
added approval step. Agent authorization and sandbox restrictions still apply.
The running Agent has not changed yet.

If other people are updating the same Agent, coordinate before submitting:
a newer plugin map can be overwritten by the one you read.

## Deploy the change

If the Agent is running and either its active revision or its draft uses managed
credential delivery, stop it and wait until its desired runtime state is
`stopped` and `activeRevisionId` is empty. OCC rejects replacement from
or to managed delivery over an active revision with `409`.

Deploy the Agent and keep the returned version ID:

```bash
occ agent deploy "$AGENT_ID" --output json > agent-plugin-revision.json
DEPLOYMENT_ID="$(node -p "require('./agent-plugin-revision.json').id")"
export DEPLOYMENT_ID
```

## Check the result

Use the same protected CLI connection to read the durable deployment result:

```bash
occ agent deployment-status "$AGENT_ID" "$DEPLOYMENT_ID" --output json
```

Repeat the status lookup while the result is `queued` or `running`. A
`succeeded` deployment with no warning for Diffs means startup did not report
disabling it. It does not prove the plugin is still healthy or that an Agent
has used it. A `PLUGIN_INSTALL_FAILED` warning means that selection was disabled
for this startup even if the Agent deployed. Dedicated Codex can also report
`PLUGIN_AUTH_REQUIRED` when a selected app still needs authentication, and
for every selected plugin when the Agent authenticates with an API key: Codex
plugins need a ChatGPT login, so the Console does not offer plugin browsing
for API-key Agents.

To verify that Diffs actually ran, use an Agent client that displays native
tool results. An operator can [attach with the OpenClaw TUI](../deploy/production-tui.md)
using the gateway's optional loopback password. Ask the deployed Agent to compare two
harmless lines:

```text
Call the Diffs tool with before: "old line", after: "new line",
path: "example.txt", and mode: "view".
```

In the client's tool activity, check the actual `diffs` call and a successful
result for the requested file and view mode. Runtime versions may return a
structured result rather than `Diff viewer ready.` A model reply alone does
not prove it called the tool.
In `view` mode, Diffs returns a viewer link. It opens in a browser only when the
Agent uses [native admin access](../deploy/native-admin.md) with
`gateway.publicOrigin` set to the Agent's native admin origin; otherwise the link
points at the Gateway's private loopback address. Use `mode: "file"` when you
need the rendered diff without a link.
The [Chat Completions check](../operate/model-verification.md) reads only
assistant text; it cannot verify that Diffs ran. The OCC console has no chat.
Use the TUI's tool activity for this verification.

For `failed`, use the returned error and the
[deployment status reference](../../reference/agents.md#deployment-status). Check
the plugin ID and supported [approval policies](../../reference/agent-plugins.md#approval-policy)
before deploying a corrected update.

## Verify Linear and approval behavior

For dedicated Codex with the curated Linear app enabled, verify a direct issue
read and a separate search/list call through the Agent's actual plugin tools.
Use an authorized issue and do not modify it. Record the discovered tool name,
arguments, native result and any error code for each call. A successful direct
lookup or `linear_list_issues` call does not establish that an advertised
`linear_search` tool works.

Distinguish missing authentication, missing tool discovery, invalid arguments
and backend dispatch errors. For example, `Tool search not found` with
`INVALID_ARGUMENT` and JSON-RPC `-32602` is a failed search dispatch; do not
summarize it as no Linear access when another authenticated Linear call succeeds.
Do not substitute another API and label the advertised tool successful.

To check write approval, use a uniquely named disposable issue with
`toolDefaults.approval: write_actions` and `reviewer: human`. Confirm the native
UI presents the request, select **Deny**, and verify the native result records
that denial. Do not retry the mutation through another tool. In contrast,
`toolDefaults.enabled: false` disables the plugin's tools; it blocks the write
without offering an approval prompt. These are distinct policies, as defined
in [Agent plugin approval](../../reference/agent-plugins.md#approval-policy).

## Disable or remove a plugin

Read the Agent again before editing its map. Set Diffs to `enabled: false` to
keep the selection but block it, or remove its key to clear the selection.
To clear every selection, set `plugins` to `{}`. Save and deploy as above.
These changes do not interrupt an active turn or immediately revoke a tool;
they apply on the next successful deployment.
