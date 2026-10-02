# Configure Agent plugins

Use the console or OpenClaw Control Plane (OCC) CLI to change an existing Agent's
plugin selections, then deploy a new revision. The CLI example enables the
bundled Diffs plugin on an embedded OpenClaw Agent running on Kubernetes. Dedicated
Codex Agents use a different catalog and approval policy; see
[plugin support](../../reference/agent-plugins.md#current-support).

## Use the console

Open **Agents**, select the Agent, then open **New revision** → **Plugins**.
Use **Configure plugins** to edit saved selections and tool policy. If the
Driver has no catalog, edit **Plugin selections JSON** with a known plugin ID;
the CLI example below shows the Diffs ID. For dedicated Codex browsing, the
curated catalog needs no Secret. Hosted discovery requires a bound Service
Accounts token Secret under **Credentials** and uses it server-side; other
authentication methods cannot browse the hosted catalog. Select **Save plugin selections**, then
**Deploy new revision**. The prior revision keeps its
original selections. On its **Plugins** tab, you can inspect that immutable
snapshot. See the [Agent detail guide](../console/agent-details.md#plugins-tab)
for the controls and [deployment status](../../reference/agents.md#deployment-status)
for the result. Catalog visibility alone does not prove that the plugin is
installed or available to the running Agent. Hosted discovery uses the Agent's
current draft credential, which may differ from its running revision's.

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

## Before you start

- [Connect the OCC CLI](../cli.md#connect-to-your-installation) to your
  Installation. The examples also use Node.js and a protected service-key file.
- Choose an Agent configured for embedded OpenClaw on Kubernetes and an
  Installation that explicitly selects the bundled OpenClaw Plugin Driver
  (`drivers.plugin.id: occ-plugin`); no Plugin Driver is selected by default.
  See [Driver selection](../../reference/drivers/plugin-bundled.md#selection-and-catalogs).
  SSH Compute rejects Agents with plugin selections or an Agent default plugin
  approver policy.
- You need permission to read, update, and deploy the Agent, read its
  Configuration, and read the new Agent revision. Existing
  [model credential requirements](../../reference/agents.md#harness-authentication)
  still apply when deploying.

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

Deploy the Agent and keep the returned revision ID:

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
