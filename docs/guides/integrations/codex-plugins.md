# Add Codex plugins to a local OpenShell Agent

Use the OCE API to discover Linear, enable it on your existing Codex Agent, and run a read through OpenClaw. The same Agent can have native Git access; a repository credential is optional for this procedure.

## Before you start

Complete [Setup OCE on local k3d](../deploy/local-openshell-setup.md), including its successful OpenClaw turn. Continue in its Bash shell or source the private `session.sh` printed at the end of setup. Use the same Agent and model Secret. The service account must already have an authorized Linear connection. Selecting a plugin does not authorize a new connection.

## Discover and select Linear

Search the account's catalog for an available Linear plugin. Follow the continuation cursor until you find it. Select the plugin with human approval for write actions.

```bash
cursor=""
while true; do
  jq --arg cursor "$cursor" '{secretRef:.data.ref,q:"linear"} +
    (if $cursor=="" then {} else {cursor:$cursor} end)' "$RUN_DIR/model-secret" |
    request POST "$base/agents/plugins" --data-binary @- > "$RUN_DIR/plugins"
  plugin=$(jq -r 'first(.data.plugins[]|select((.name|ascii_downcase)=="linear" and .available!=false)|.id) // empty' "$RUN_DIR/plugins")
  if [[ -n $plugin ]]; then break; fi
  cursor=$(jq -r '.data.nextCursor // empty' "$RUN_DIR/plugins")
  if [[ -z $cursor ]]; then echo 'Linear is unavailable for this account.' >&2; exit 1; fi
done
request GET "$base/agents/$agent" |
  jq --arg plugin "$plugin" '.data | {configurationId,
    plugins:((.plugins // {}) + {($plugin):{enabled:true,
      toolDefaults:{enabled:true,approval:"write_actions",reviewer:"human"}}})}' |
  request PATCH "$base/agents/$agent" --data-binary @- > "$RUN_DIR/plugin-agent"
deploy_and_wait
```

The update includes the Agent's other selected plugins because the API replaces the plugin map. Leave the credential source list out of this PATCH to preserve the Agent's existing Git and model bindings. Update one Agent draft at a time.

## Verify a Linear read through OpenClaw

Send a new OpenClaw turn to the deployed revision. Inspect the team IDs in the tool output and compare them with the final reply.

```bash
printf '%s\n' 'Use the Linear plugin to list teams with limit 3. Make no changes. Return the tool name and result.' > "$RUN_DIR/linear-prompt"
turn "$RUN_DIR/linear-prompt" > "$RUN_DIR/linear-result"
jq -e '.outcome.status=="ok" and
  any(.history.messages[]; .role=="toolResult" and
      .toolName=="codex_apps.linear.list_teams" and .isError==false)' "$RUN_DIR/linear-result"
jq '.history.messages[]|select(.toolName=="codex_apps.linear.list_teams")|.content' "$RUN_DIR/linear-result"
jq -r '.outcome.terminalReply.text' "$RUN_DIR/linear-result"
```

A successful turn includes `codex_apps.linear.list_teams` and a reply matching its result. If plugin installation fails, check the [plugin installation requirements](../../testing/openshell.md#codex-plugin-installation). If Git is also required, continue with [Add Git support](../repository-credentials/openshell-git-push.md).
