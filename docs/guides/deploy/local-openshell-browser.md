# Open a local OpenShell Agent in your browser

Use the private run directory and Bash shell from [local OpenShell setup](local-openshell-setup.md). The HTTPS Console and each Agent use separate hostnames on the same loopback port. The browser signs in to OCE as a user with `administer` permission on this Agent.

## Bind the origin before deployment

After creating the dedicated Agent, bind its exact browser origin to its new Configuration. Run these commands from the matching repository root. The hostname uses the same function as OCC. This example updates a new Configuration owned by this quickstart. For a shared or previously edited Configuration, follow the [per-Agent edit procedure](native-admin.md#configure-each-agent).

```bash
installation=$(request GET "$api/installation" | jq -er .data.id)
origin=$(node --input-type=module - "$state/state.json" "$RUN_DIR/agent" "$installation" <<'JS'
import { readFileSync } from "node:fs";
import { deriveNativeAdminHost } from "./apps/controller/src/gateway/native-admin-host.mjs";
const [stateFile, agentFile, installation] = process.argv.slice(2);
const state = JSON.parse(readFileSync(stateFile));
const { data: agent } = JSON.parse(readFileSync(agentFile));
const url = new URL(state.browserOrigin);
url.hostname = deriveNativeAdminHost(installation, agent, state.nativeAdminDomain);
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

Return to [grant model access and deploy](local-openshell-setup.md#6-grant-model-access-and-deploy). The fresh workspace uses the default bootstrap files. To enable the managed Linear plugin or protected Git, keep the same Agent and follow the [plugin](../integrations/codex-plugins.md) and [repository binding](../repository-credentials/openshell-git-push.md) guides.

## Open the Agent and continue a chat

1. Trust the public `browser-ca.crt` from this installation in your browser. On a remote development host, [forward the printed HTTPS port](../operate/troubleshooting.md#open-the-console-from-another-machine) to the same loopback port on your laptop. Keep the CA private key and service key on the development host.
2. Open the printed HTTPS Console origin at `/console/`. Sign in with the administrator email and password file printed by the launcher. Choose the Agent and its active version, then select **Open Agent UI**. The Agent opens on its own hostname.
3. Start a chat and complete onboarding. Give the Agent its name and one preference to remember. Ask it to save these in its workspace. Use the OCE **Workspace** tab to read the saved identity and user context.
4. Close the Agent tab. From the Console, open the same Agent again and select the existing conversation in chat history. Ask a follow-up about your preference. Opening a new conversation gives you a different chat history.

Keep the cluster, the Agent and its volumes for later sessions. Store the owner-only `session.sh` from the setup guide with the run directory. Use it to operate on the same Namespace and Agent. Use the enrollment guide to retire a temporary write grant and verify revocation before leaving the Agent with read access.

## Restore read-only Git and keep the Agent running

Use this sequence after the last authorized push on a local cluster dedicated to this workflow. It finishes with the same Agent, browser origin and workspace on a new revision. A stopped Agent or an empty draft alone cannot prove that GitHub revoked the old token. If the shell exits during a write session, resume here before doing further work.

1. Load the private operator session. Load the immutable read-only ConfigMap name saved when you [prepared both permission maps](../repository-credentials/openshell-git-push.md#1-enroll-one-repository-in-the-installation). The following check expects one repository, a finite grant and no standing approval. For a standing approval, [withdraw it using its current generation](../repository-credentials.md#keep-git-access-on-the-same-running-agent) first.

```bash
source /path/to/private/run/session.sh
ref=application
READ_REGISTRY=$(cat "$RUN_DIR/read-registry-name")
kubectl --context "$context" -n "$ns" get cm "${READ_REGISTRY:?}" -o json |
  jq -e --arg ns "$namespace" --arg ref "$ref" '
    select(.immutable==true) | .data["registry.json"] | fromjson | .repositories |
    select(length==1) | .[0] | select(.repositoryRef==$ref) | .namespaces |
    select(length==1) | .[0] | .namespaceId==$ns and
    .profiles==["github-repository"] and .permissions=={metadata:"read",contents:"read"}'
request GET "$base/agents/$agent/repository-approvals" | jq -e '.data==[]'
write_revision=$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)
printf '%s\n' "$write_revision" > "$RUN_DIR/last-write-revision"
request POST "$base/agents/$agent/stop" > "$RUN_DIR/git-stop"
```

2. From the retained session, check the stopped state and the write revision’s known attempts. The query uses read-only PostgreSQL on the disposable k3d installation. It checks every attempt for this exact Agent revision, including superseded material. If the result is `f`, repeat only the reads. Investigate unresolved issuance or revocation before re-enabling access.

```bash
request GET "$base/agents/$agent" |
  jq -e '.data | .desiredRuntimeState=="stopped" and .activeRevisionId==null'
database=$(jq -er .databaseName "$state/state.json")
retired=$(kubectl --context "$context" -n "$ns" exec -i statefulset/postgres -- \
  env PGOPTIONS='-c default_transaction_read_only=on' psql -XAt -v ON_ERROR_STOP=1 \
  -U postgres -d "$database" -v ns="$namespace" -v agent="$agent" \
  -v revision="$(cat "$RUN_DIR/last-write-revision")" <<'SQL'
SELECT count(*) FILTER (WHERE a.custody='revoked') > 0
   AND bool_and(a.custody IN ('revoked','not_issued') AND a.sealed IS NULL)
FROM occ.prepared_github_attempts a
JOIN occ.prepared_github_families f ON f.source_id=a.source_id
WHERE f.source #>> '{session,namespaceId}'=:'ns'
  AND f.source #>> '{session,agentId}'=:'agent'
  AND f.source #>> '{session,revisionId}'=:'revision';
SQL
)
test "$retired" = t
```

3. Switch only the registry selection. Keep the App key, custody key, model, plugins and the same repository binding. Check both the running worker mount and the draft before deploying.

```bash
helm --kube-context "$context" -n "$ns" get values openclaw-enterprise -o json |
  jq --arg registry "$READ_REGISTRY" '.repositoryCredentials.registryConfigMapName=$registry' \
    > "$RUN_DIR/helm-git-read.json"
helm --kube-context "$context" -n "$ns" upgrade openclaw-enterprise deploy/helm/openclaw-enterprise \
  -f "$RUN_DIR/helm-git-read.json" --wait
kubectl --context "$context" -n "$ns" rollout status deploy/openclaw-enterprise-worker
kubectl --context "$context" -n "$ns" get pods -l app.kubernetes.io/component=worker -o json |
  jq -e --arg registry "$READ_REGISTRY" '
    [.items[]|select(.metadata.deletionTimestamp==null)] |
    length>0 and all(.[]; any(.status.conditions[]?;.type=="Ready" and .status=="True")
      and any(.spec.volumes[]?;.configMap.name==$registry))'
request GET "$base/agents/$agent" | jq -e --arg ref "$ref" '
  .data.repositoryBindings==[{repositoryRef:$ref,profile:"github-repository"}]'
deploy_and_wait
request GET "$base/agents/$agent" |
  jq -er '.data | select(.desiredRuntimeState=="running") | .activeRevisionId'
```

4. Reopen **Open Agent UI**, select the original chat, and ask the Agent to read the remote branch. For a public repository, remote visibility alone cannot prove authenticated access. Check the new revision’s proxy receipt for `upload-pack` or `advertise-upload-pack` using the [Git verification queries](../repository-credentials/openshell-git-push.md#5-wait-for-renewal-then-push-again).

### Renew expired read-only access

A finite repository grant has an absolute deadline. Token renewal during that grant does not extend the deadline. After expiry, an authorized owner can deploy a new version with a fresh **read-only** grant. First check the prior revision and any outstanding retirement through the [Token Service lifecycle](../../reference/repository-credentials.md#token-service-lifecycle). Reconcile unknown outcomes before granting access again.

Load the saved operator session, keep the same repository selection and repeat step 3 with the verified read-only ConfigMap. Wait for the new active revision, then use the read check in step 4. This preserves the workspace and chat. A standing approval changes the duration of access and requires its own explicit authorization.
