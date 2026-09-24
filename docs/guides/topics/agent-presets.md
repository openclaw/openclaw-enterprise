# Create an Agent from a Preset

Use a Preset to reuse Agent settings across a Namespace. An operator creates the
Preset through the HTTP API; users select it in the console and fill its
variables. Each saved Agent gets its own Configuration and identity.

For a dedicated Codex starting point with an empty tool-network allowlist and
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

## Use it in the console

1. Sign in, select the same Namespace, and open **Agents → Create Agent**.
   You need `read` on the Preset and the normal Agent/Configuration creation
   permissions. An administrator can grant exact Preset access through
   [Namespace IAM](../../reference/authorization.md#manage-namespace-policy).
2. Choose **embedded-agent** in **Preset template**, enter the `name` variable,
   and select **Use Preset**. The chooser closes and the Agent form opens with
   the rendered copy. To use standard defaults, select **Start without Preset**.
3. Review the model, execution mode, native Configuration JSON, authentication,
   plugin selections, and Secret bindings. Edit any copied setting and fill
   missing values. Enter credentials only in password variables or credential
   fields; never in ordinary variables or native JSON.
4. Select **Create Agent**. Then follow [credentials and deployment](../../reference/console/create-and-deploy.md#initial-runtime-credentials)
   for that saved Agent. Creating the draft does not start a workload.

Variables are used once to fill the form. Edit the resulting fields directly.
Before saving, to choose another Preset or supply different variables, select **Start over**
and confirm that the unsaved draft can be discarded. A supplied
`configuration.values` replaces the entire native JSON editor.

Saving a Preset does not validate every launch setting. Review the draft before
creating it; an invalid execution mode can fail when opening the form, while
an invalid plugin policy can fail when saving the Agent.

## Change or delete the template

Use `PATCH /namespaces/:namespaceId/presets/:presetId` to rename a Preset or
replace its complete `template`, and `DELETE` on the same path to remove it.
You need the corresponding permission on the exact Preset. These operations
affect future selections only. Already selected copies, saved Agents, and
running revisions stay unchanged. See [CRUD and permissions](../../reference/presets.md#crud-and-permissions).

If a Preset is missing from the selector, check the current Namespace and your
exact Preset `read` grant. If applying fails, check the named variable and its
type. If saving fails after a Configuration was created, use the displayed
Configuration ID and [partial-save recovery](../../reference/console/create-and-deploy.md#create-an-agent).
