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

## Before you start

- [Connect the OCC CLI](../cli.md#connect-to-your-installation) to your
  Installation. The examples also use Node.js and a protected service-key file.
- Choose an Agent configured for embedded OpenClaw on Kubernetes and an
  Installation that explicitly selects the bundled OpenClaw Plugin Driver
  (`drivers.plugin.id: occ-plugin`); no Plugin Driver is selected by default.
  See [Driver selection](../../reference/drivers/plugin-bundled.md#selection-and-catalogs).
  SSH Compute rejects Agents with plugin selections.
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
  "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "native" } },
};
writeFileSync("agent-plugin-update.json",
  JSON.stringify({ configurationId: agent.configurationId, plugins }, null, 2) + "\n");
JS

occ agent update "$AGENT_ID" --file agent-plugin-update.json --output json
```

The returned `plugins` map should contain `occ-plugin:diffs` with `enabled: true`.
The `native` policy uses Diffs' existing execution behavior, without an added
approval step. The Agent's authorization and sandbox restrictions still apply. The running
Agent has not changed yet.

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
`PLUGIN_AUTH_REQUIRED` when a selected app still needs authentication.

To verify that Diffs actually ran, use an Agent client that displays native
tool results. An operator can [attach with the OpenClaw TUI](../deploy/production-agents.md#attach-with-the-openclaw-tui)
using the gateway's optional loopback password. Ask the deployed Agent to compare two
harmless lines:

```text
Call the Diffs tool with before: "old line", after: "new line",
path: "example.txt", and mode: "view".
```

In the client's tool activity, check that `diffs` returns
`Diff viewer ready.` A model reply alone does not prove it called the tool.
The [Chat Completions check](../operate/model-verification.md) reads only
assistant text; it cannot verify that Diffs ran. The OCC console has no chat.
Use the TUI's tool activity for this verification.

For `failed`, use the returned error and the
[deployment status reference](../../reference/agents.md#deployment-status). Check
the plugin ID and supported [approval policies](../../reference/agent-plugins.md#approval-policy)
before deploying a corrected update.

## Disable or remove a plugin

Read the Agent again before editing its map. Set Diffs to `enabled: false` to
keep the selection but block it, or remove its key to clear the selection.
To clear every selection, set `plugins` to `{}`. Save and deploy as above.
These changes do not interrupt an active turn or immediately revoke a tool;
they apply on the next successful deployment.
