# Restore read-only Git and keep the Agent running

Use this sequence after the last authorized push on a local cluster dedicated to this workflow. It finishes with the same Agent, browser origin and workspace on a new revision. A stopped Agent or an empty draft alone cannot prove that GitHub revoked the old token. If the shell exits during a write session, resume here before doing further work.

1. Load the private operator session. Load the immutable read-only ConfigMap name saved when you [prepared both permission maps](openshell-git-push.md#1-enroll-one-repository-in-the-installation). The following check expects one repository, a finite grant and no standing approval. For a standing approval, [withdraw it using its current generation](../repository-credentials.md#keep-git-access-on-the-same-running-agent) first.

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

4. Reopen **Open Agent UI**, select the original chat, and ask the Agent to read the remote branch. For a public repository, remote visibility alone cannot prove authenticated access. Check the new revision’s proxy receipt for `upload-pack` or `advertise-upload-pack` using the [Git verification queries](openshell-git-renewal.md).

### Renew expired read-only access

A finite repository grant has an absolute deadline. Token renewal during that grant does not extend the deadline. After expiry, an authorized owner can deploy a new version with a fresh **read-only** grant. First check the prior revision and any outstanding retirement through the [Token Service lifecycle](../../reference/repository-credentials.md#token-service-lifecycle). Reconcile unknown outcomes before granting access again.

Load the saved operator session, keep the same repository selection and repeat step 3 with the verified read-only ConfigMap. Wait for the new active revision, then use the read check in step 4. This preserves the workspace and chat. A standing approval changes the duration of access and requires its own explicit authorization.
