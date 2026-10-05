# Create an Agent from a Preset

Use a Preset to reuse Agent settings across a Namespace. An operator creates the
Preset through the HTTP API or [Installation-linked JSON files](../../reference/presets.md#installation-defaults); users select it in the console and fill its
variables. Each saved Agent gets its own Configuration and identity.

For a dedicated Codex starting point with an explicit network allowlist and
cached search, [install the standard Codex Preset](standard-codex-preset.md).

## Create a Preset

You need a ready Namespace and `preset:create` on its Preset collection. The
unchanged built-in Installation administrator Role receives Preset permissions
on upgrade. If your Role was customized, ask its IAM policy owner for access;
see [upgrade eligibility and permissions](../../reference/presets.md#crud-and-permissions).
Set up authentication using the [HTTP API quickstart](../http-api.md), including
`OCC_URL` and `OCC_SERVICE_KEY_FILE`. Keep shell tracing disabled. Replace the
Namespace ID below, then save this request as `preset.json`:

```json
{
  "name": "embedded-agent",
  "template": {
    "variables": {
      "name": { "type": "string", "description": "Name for the new Agent" }
    },
    "agent": { "name": "{{ vars.name }}", "executionMode": "embedded" }
  }
}
```

Run in Bash with `curl` and `jq` installed:

```bash
OCC_PRESET_NAMESPACE_ID='ns_REPLACE_WITH_YOUR_NAMESPACE_ID'
jq -er '.data.key | select(type == "string")
  | select(test("\\S") and (test("[\\r\\n]") | not))
  | "x-api-key: " + .' \
  "$OCC_SERVICE_KEY_FILE" |
  curl --fail-with-body --silent --show-error --header @- \
    --header 'content-type: application/json' --data-binary @preset.json \
    "$OCC_URL/namespaces/$OCC_PRESET_NAMESPACE_ID/presets"
```

Success returns HTTP `201` with the Preset in `data`, including its `pre_` ID.
The example supplies a name and execution mode. It leaves model, credentials,
and native Configuration at the console's normal defaults for review.
To reuse more settings, add fields from the [Preset contract](../../reference/presets.md#contents).

## Use the Slack team example

The [Slack team Preset](../../../deploy/examples/slack-team-preset.json) supplies
settings for an OpenClaw gateway, dedicated Codex execution, and a mention-only
Slack channel.
It targets an Installation with Kubernetes Compute and Namespace Secrets. From
the repository root, use `--data-binary @deploy/examples/slack-team-preset.json`
in the creation request above. Then choose **slack-team** in the console.

Fill the Preset variables with:

- A unique Agent name and the current Namespace ID.
- A model supported by your installed Codex runtime and model credential,
  without a provider prefix; the template adds `codex/`.
- Existing Secret IDs for the model API key, Slack app token, and Slack bot
  token. All three Secrets must belong to that Namespace. Enter their IDs,
  never credential values.
- The owner's Slack user ID, a channel ID where the bot is already invited,
  and an IANA timezone. The timezone defaults to `UTC`.

Configure the Installation's [Slack channel proxy](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking)
and use compatible gateway, Codex plugin, and Codex app-server images before deployment.

The owner is initially the only allowed channel user. DMs and bot messages are
disabled, and channel messages require a mention. Review the copied Configuration
to admit other users. Codex starts with the console's read-only sandbox and
on-request approval policy. Model credentials go only to Codex; Slack credentials
go only to the gateway.

**Create Agent** starts first-time provisioning on supported Dedicated runtimes,
including transport credentials and access to the selected Secrets. If the console
saves an ordinary draft instead, complete [transport credentials and deployment](../../reference/console/create-and-deploy.md#initial-runtime-credentials)
and grant the Agent access through
[Namespace IAM](../../reference/authorization.md#manage-namespace-policy).
Kubernetes Compute supplies trusted-proxy authentication from the Installation
settings. The template references its generated gateway password through
`OPENCLAW_GATEWAY_PASSWORD`; it does not supply credential values.
The Preset does not create Secrets, Slack apps, infrastructure, or account
enrollment. It relies on OCE's workspace routing and leaves additional plugins,
embedding-backed memory, and scheduling configuration to the operator.

Local template rendering passes, but this example has no live deployment or Slack
acceptance result. Verify an actual reply and workspace access on your
selected runtime before relying on it.

## Use it in the console

1. Sign in, select the same Namespace, and open **Agents → Create Agent**.
   You need `read` on the Preset and the normal Agent/Configuration creation
   permissions. An administrator can grant exact Preset access through
   [Namespace IAM](../../reference/authorization.md#manage-namespace-policy).
2. Choose your Preset in **Preset template**, fill its variables,
   and select **Use Preset**. The chooser closes and the Agent form opens with
   the rendered copy. To load the installed `default-codex` copy, select **Start with default Preset**.
   To create an Agent without a saved setup, select **Start without Preset** instead.
3. Review the model, execution mode, native Configuration JSON, authentication,
   plugin selections, and workspace files under Advanced settings. Configure Slack
   Secrets in its channel drawer. Edit any copied setting and fill
   missing values. Enter credentials only in password variables or credential
   fields; never in ordinary variables or native JSON.
4. Select **Create Agent**. Supported Dedicated runtimes start first-time
   provisioning and deployment. For an ordinary draft, follow
   [credentials and deployment](../../reference/console/create-and-deploy.md#initial-runtime-credentials)
   for that saved Agent; saving a draft alone does not start a workload.

Variables with defaults are prefilled and can be changed. A model password
variable offers **Create new Secret** or **Use existing Secret** in the same
Namespace. Enter a token only in new mode; it is stored when you create the Agent.
Existing mode reuses the selected reference without reading credential bytes.

Variables are used once to fill the form. Edit the resulting fields directly.
You can navigate away and return to your [unsaved Console draft](../../reference/console/create-and-deploy.md#create-an-agent); reenter any new credentials.
Before saving, to choose another Preset or supply different variables, select **Start over**
and confirm that the unsaved draft can be discarded. A supplied
`configuration.values` replaces the entire native JSON editor.

Saving a Preset does not validate every launch setting. Review the draft before
creating it; an invalid execution mode can fail when opening the form, while
an invalid plugin policy can fail when saving the Agent.

## Change or delete the template

Use `PATCH /namespaces/:namespaceId/presets/:presetId` to rename a Preset or
replace its complete `template`, and `DELETE` on the same path, or
`occ preset delete ID`, to remove it. `occ preset list` shows the IDs.
You need the corresponding permission on the exact Preset. These operations
affect future selections only. Already selected copies, saved Agents, and
running revisions stay unchanged. See [CRUD and permissions](../../reference/presets.md#crud-and-permissions).

If a Preset is missing from the selector, check the current Namespace and your
exact Preset `read` grant. If applying fails, check the named variable and its
type. If saving fails after a Configuration was created, use the displayed
Configuration ID and [partial-save recovery](../../reference/console/create-and-deploy.md#create-an-agent).
