---
published: false
---

Use one model source for this Agent. If the connected service account already has a ready Credential Gateway source, select it by its registered name and continue to step 5:

```bash
name="openshell-codex-$(date +%s)"
modelSource=$(request GET "$base/credential-sources" |
  jq -er --arg n "${MODEL_SOURCE_NAME:?Set the registered source name}" '[.data[]|select(.name==$n and .type=="codex-pat" and .state=="ready" and .ownerCapability=="credential_gateway")]|select(length==1)|first.id')
```

For a new source, store the PAT in a Namespace Secret and register its reference before enabling the repository Credential Proxy.

```bash
# POST $base/secrets: stream the raw PAT from its private file.
name="openshell-codex-$(date +%s)"
jq -n --arg name "$name-model" --rawfile token "${CODEX_TOKEN_FILE:?}" \
  '{name:$name,value:($token|rtrimstr("\n"))}' |
  request POST "$base/secrets" --data-binary @- > "$RUN_DIR/model-secret"

# POST $base/credential-sources: return the source ID only if registration reached ready.
jq --arg name "$name-model" '{name:$name,type:"codex-pat",secrets:{access_token:.data.ref}}' \
  "$RUN_DIR/model-secret" | request POST "$base/credential-sources" --data-binary @- > "$RUN_DIR/model-source"
modelSource=$(jq -er '.data|select(.state=="ready")|.id' "$RUN_DIR/model-source")
```

## 5. Create the Configuration and Agent

Register the model with a fail-closed loopback URL. The Gateway uses authenticated WebSocket transport to the dedicated Codex Harness inside OpenShell.

Render the [Codex configuration template](../../snippets/openshell-quickstart/codex-configuration.jq) with `MODEL` and post its JSON to OCE.

<Snippet file="./codex-configuration.jq" lang="jq" />

```bash
# POST $base/configurations: save the model, sandbox and Gateway settings.
jq -n --arg model "${MODEL:?Set the service account model ID}" -f "$RUN_DIR/codex-configuration.jq" |
  request POST "$base/configurations" --data-binary @- > "$RUN_DIR/configuration"

# POST $base/agents: bind the model source to one dedicated Agent.
jq -n --arg name "$name" --arg cfg "$(jq -er .data.id "$RUN_DIR/configuration")" \
  --arg m "$modelSource" '{
    name:$name,configurationId:$cfg,executionMode:"dedicated",gatewayManagedMode:true,
    harnessAuth:{method:"credential_source",sourceId:$m},credentialSources:[{sourceId:$m}]}' |
  request POST "$base/agents" --data-binary @- > "$RUN_DIR/agent"
agent=$(jq -er .data.id "$RUN_DIR/agent")
principal=$(jq -er .data.servicePrincipalId "$RUN_DIR/agent")
printf 'Agent: %s\nPrincipal: %s\n' "$agent" "$principal"
```

### Bind the origin before deployment

After creating the dedicated Agent, bind its exact browser origin to its new Configuration. Run these commands from the matching repository root. The hostname uses the same function as OCC. This example updates a new Configuration owned by this quickstart. For a shared or previously edited Configuration, follow the [per-Agent edit procedure](native-admin.md#configure-each-agent).

```bash
installation=$(request GET "/installation" | jq -er .data.id)
origin=$(node --input-type=module - "$CONSOLE_ORIGIN" "$NATIVE_ADMIN_DOMAIN" "$RUN_DIR/agent" "$installation" <<'JS'
import { readFileSync } from "node:fs";
import { deriveNativeAdminHost } from "./apps/controller/src/gateway/native-admin-host.mjs";
const [consoleOrigin, nativeAdminDomain, agentFile, installation] = process.argv.slice(2);
const { data: agent } = JSON.parse(readFileSync(agentFile));
const url = new URL(consoleOrigin);
url.hostname = deriveNativeAdminHost(installation, agent, nativeAdminDomain);
console.log(url.origin);
JS
)
cfg=$(jq -er .data.id "$RUN_DIR/configuration")
request GET "$base/configurations/$cfg" |
  jq -e --arg origin "$origin" '.data | select(.generation==1) | {expectedGeneration:.generation,values} |
    .values.gateway += {publicOrigin:$origin,controlUi:{enabled:true,allowedOrigins:[$origin]}} |
    .values.gateway.auth += {mode:"trusted-proxy",
      trustedProxy:{userHeader:"x-occ-identity",allowUsers:["occ-workspace-files"],
        deviceAutoApprove:{enabled:true,scopes:["operator.read","operator.write"]}},
      identityScopes:{"occ-workspace-files":["operator.admin"]}}' |
  request PATCH "$base/configurations/$cfg" --data-binary @- > "$RUN_DIR/browser-configuration"
```

## 6. Grant model access and deploy

Create one role scoped to credential sources. Bind that role to this Agent's principal for the model source only.

```bash
# POST $base/iam/roles: allow the operate action on CredentialSources.
role=$(jq -n --arg name "$name-sources" \
  '{name:$name,permissions:[{action:"operate",resourceKind:"credential_source"}]}' |
  request POST "$base/iam/roles" --data-binary @- | jq -er .data.id)

# POST $base/iam/access-bindings: grant access to one exact source.
jq -n --arg p "$principal" --arg r "$role" --arg s "$modelSource" \
  '{subjectKind:"identity",subjectId:$p,roleId:$r,resourceKind:"credential_source",resourceId:$s}' |
  request POST "$base/iam/access-bindings" --data-binary @- > "$RUN_DIR/model-binding"

# Provision transport once, before the first revision.
request POST "$base/agents/$agent/runtime-credentials" --data '{}' > "$RUN_DIR/transport"

```

<AccordionGroup>
<Accordion title="Console">

Open `$CONSOLE_ORIGIN/console/` and sign in with the administrator account from installation setup. Keep any required private browser port-forward running.

Run `deployment_preflight` in the operator shell, then use **Deploy an existing Agent’s saved draft** below for the Agent created in step 5. Do not create another Agent. After clicking deploy, run:

```bash
revision='<deployment ID from the Console URL revision parameter>'
wait_deployment "$revision"
```

<Snippet file="./console-deployment-actions.md" />

</Accordion>
<Accordion title="CLI">

Use the API helper defined above:

```bash
deploy_and_wait
```

</Accordion>
</AccordionGroup>

Continue when the deployment reports `succeeded` and the Agent's `activeRevisionId` matches the new revision.

<a id="7-verify-a-turn-through-openclaw"></a>

## 7. Complete onboarding in the Control UI

Before sending the first prompt, use the operator shell to check the bootstrap file in this Agent's workspace. This check needs permission to list Pods and execute a command in the tenant namespace.

```bash
revision=$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)
agent_pod=$(kube -n "${TENANT_NAMESPACE:?}" get pods \
  -l "openclaw.dev/agent=$agent,openclaw.dev/revision=${revision:?}" -o json |
  jq -er '[.items[] | select(.metadata.deletionTimestamp == null and
    any(.status.containerStatuses[]?; .name == "agent" and .ready))] |
    select(length == 1) | first.metadata.name')
workspace_check() {
  kube -n "$TENANT_NAMESPACE" exec "$agent_pod" -c agent -- sh -c \
    'cd /sandbox/enterprise && test -x . && test "$@"' sh "$@"
}
workspace_check -f BOOTSTRAP.md
```

Use **Open Agent UI** for the same Agent. Give it a name and one unique preference to remember. Ask it to complete onboarding and save them in its workspace. In the Console **Workspace** tab, open `IDENTITY.md` and `USER.md` and verify the saved values. Back in the operator shell, confirm the Agent removed the bootstrap file:

```bash
workspace_check ! -e BOOTSTRAP.md
```

Send `Reply with OCE_READY.` and confirm the reply. Close the Agent tab, reopen **Open Agent UI**, and select the **same conversation** in chat history. Ask for the saved preference without including its value in the prompt. Check the response against the original value. Retain the conversation's browser path with the private session record.

The shared `turn` helper starts a new conversation on each call. A terminal model reply does not replace this browser onboarding and continuity check.

<a id="keep-the-session-for-the-next-stage"></a>

## Resume the operator session

```bash
save_session
```

Run the two commands printed by `save_session` to resume in a fresh Bash shell. The private session saves IDs and paths; the service key stays in its protected file. Keep this Agent running. Git and plugins are optional: add either first, then the other to this same Agent.
