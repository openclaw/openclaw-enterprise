# Configure Agent plugins

Use the OpenClaw Control Plane (OCC) CLI to select a plugin for an existing
Agent, deploy the change, and check the result. This example enables the bundled
Diffs plugin on an embedded OpenClaw Agent running on Kubernetes. Dedicated
Codex Agents use a different catalog and approval policy; see
[plugin support](../../reference/agent-plugins.md#current-support).

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

The CLI has no deployment-status command. Use the service-key file from your
CLI setup to query the status API. For a private certificate authority, set
`NODE_EXTRA_CA_CERTS` to its PEM bundle before running Node.

```bash
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
const { data: { key } } = JSON.parse(
  readFileSync(process.env.OCC_SERVICE_KEY_FILE, "utf8"));
const ids = [process.env.OCC_NAMESPACE, process.env.AGENT_ID, process.env.DEPLOYMENT_ID]
  .map(encodeURIComponent);
const path = `/namespaces/${ids[0]}/agents/${ids[1]}/deployments/${ids[2]}`;
const response = await fetch(new URL(path, process.env.OCC_URL), {
  headers: { "x-api-key": key }, redirect: "error",
});
if (!response.ok) throw new Error(`Deployment lookup returned HTTP ${response.status}`);
const { data } = await response.json();
console.log(JSON.stringify({
  status: data.status, warnings: data.warnings, error: data.error,
}, null, 2));
JS
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
