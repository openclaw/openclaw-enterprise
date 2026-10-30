# Add Codex plugins to a local OpenShell Agent

Use the OCE API to discover Linear, enable it on your existing Codex Agent, and run a read through OpenClaw. The same Agent can have native Git access; a repository credential is optional for this procedure.

## Before you start

Complete [Setup OCE on local k3d](../deploy/local-openshell-setup.md), including its successful OpenClaw turn. Continue in its Bash shell or source the private `session.sh` printed at the end of setup. Use the same Agent and model Secret. The service account must already have an authorized Linear connection. Selecting a plugin does not authorize a new connection.

## 1. Discover Linear in the account catalog

Search the account's catalog for an available Linear plugin. Follow the continuation cursor until you find it. Select the plugin with human approval for write actions.

```bash
# POST $base/agents/plugins: use the model Secret reference to search this account.
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
printf 'Linear plugin ID: %s\n' "$plugin"
```

## 2. Enable Linear on the existing Agent

Use the ID from step 1. Add Linear to the current plugin map, then deploy a new Agent revision. Update one Agent draft at a time.

```bash
# GET and PATCH $base/agents/$agent: retain existing plugins and credential sources.
request GET "$base/agents/$agent" |
  jq --arg plugin "$plugin" '.data | {configurationId,
    plugins:((.plugins // {}) + {($plugin):{enabled:true,
      toolDefaults:{enabled:true,approval:"write_actions",reviewer:"human"}}})}' |
  request PATCH "$base/agents/$agent" --data-binary @- > "$RUN_DIR/plugin-agent"

# POST $base/agents/$agent/deploy and wait until this revision becomes active.
deploy_and_wait
```

<a id="verify-a-linear-read-through-openclaw"></a>

## 3. Verify a Linear read through OpenClaw

Send a new OpenClaw turn to the deployed revision. Inspect the team IDs in the tool output and compare them with the final reply.

```bash
# chat.send over wss://<private-gateway-host>/namespaces/$namespace/agents/$agent.
printf '%s\n' 'Use the Linear plugin to list teams with limit 3. Make no changes. Return the tool name and result.' > "$RUN_DIR/linear-prompt"
turn "$RUN_DIR/linear-prompt" > "$RUN_DIR/linear-result"

# Check chat.history for the actual successful tool call, then compare it with the reply.
jq -e '.outcome.status=="ok" and
  any(.history.messages[]; .role=="toolResult" and
      .toolName=="codex_apps.linear.list_teams" and .isError==false)' "$RUN_DIR/linear-result"
jq '.history.messages[]|select(.toolName=="codex_apps.linear.list_teams")|.content' "$RUN_DIR/linear-result"
jq -r '.outcome.terminalReply.text' "$RUN_DIR/linear-result"
```

A successful turn includes `codex_apps.linear.list_teams` and a reply matching its result. If plugin installation fails, check the [plugin installation requirements](../../testing/openshell.md#codex-plugin-installation). If Git is also required, continue with [Add Git support](../repository-credentials/openshell-git-push.md).
