# Restore read-only Git and keep the Agent running

Use this sequence after the last authorized push on the isolated installation. It is the same procedure for local k3d, Kubernetes and EKS. Keep the same Agent, Configuration, model source, plugins, browser origin and workspace. The worker-based audit uses its configured database connection; no local PostgreSQL Pod or operator database password is required.

## 1. Resume the existing session

```bash
source /path/to/private/run/session.sh
READ_REGISTRY=$(cat "$RUN_DIR/read-registry-name")
```

The saved `repo`, `repo_id` and `ref` must identify the repository used for the push. The immutable read-only map must select the same App, installation, repository ID, `github-repository` profile and OCE Namespace as the write map, with Contents read and Metadata read. `select_registry` checks the repository and Namespace before reloading it.

## 2. Stop and retire the write grant

This permission-change procedure requires a finite grant and no standing repository approval. If you explicitly created a standing approval, [withdraw it with its current generation](../repository-credentials.md#keep-git-access-on-the-same-running-agent) first. This retirement check is not required merely to delete the Agent.

```bash
write_revision=$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)
printf '%s\n' "$write_revision" > "$RUN_DIR/last-write-revision"
stop_and_retire "$write_revision"
```

The helper requires the Agent to be stopped and checks all known attempts for this exact revision, including superseded material. At least one issued attempt must have recorded `revoked` or `expired` custody. Every attempt must be revoked, expired or not issued, with no sealed material. Live and uncertain attempts fail the check. It reads only scoped custody metadata through the worker and saves it privately in `RUN_DIR`.

If interrupted, inspect the saved revision and `git_audit <revision>` before another mutation. Reconcile uncertain issuance or revocation through the [Token Service lifecycle](../../reference/repository-credentials.md#token-service-lifecycle); do not infer retirement from an empty draft or a stopped Pod.

## 3. Select read access and redeploy

```bash
select_registry "$READ_REGISTRY" read
request GET "$base/agents/$agent" | jq -e --arg ref "$ref" '
  .data.repositoryBindings==[{repositoryRef:$ref,profile:"github-repository"}]'
deploy_and_wait
read_revision=$(cat "$RUN_DIR/requested-revision")
request GET "$base/agents/$agent" | jq -e --arg revision "$read_revision" '
  .data.desiredRuntimeState=="running" and .data.activeRevisionId==$revision'
save_session
```

The upgrade preserves the App key, custody key and other Installation settings. It verifies the running worker's registry mount. On existing clusters, the deployment helper also verifies the pinned Envoy peers and updates the Agent's Service network rules.

## 4. Verify an authenticated read

Reopen **Open Agent UI**, select the original conversation, and ask the Agent to recall the saved preference and read the test branch. Match the returned branch SHA with the independently verified GitHub commit. For a public repository, remote visibility alone does not prove authenticated access. Require a read receipt on the restored revision and no push receipts:

```bash
git_audit "$read_revision" > "$RUN_DIR/read-uses.json"
jq -e 'any(.uses[];.operation=="upload-pack" or .operation=="advertise-upload-pack") and
  all(.uses[];.operation!="receive-pack")' "$RUN_DIR/read-uses.json"
```

A receipt proves authorization; the independent SHA comparison proves the result. Leave this Agent and its workspace running for [Add Plugin](../integrations/codex-plugins.md).

### Renew expired read-only access

A finite grant has an absolute deadline. Token renewal does not extend it. After expiry, inspect the prior revision and any unresolved custody before granting access again. Keep the verified read-only ConfigMap and repeat steps 3–4 to create a fresh read-only revision. This preserves the same workspace and conversation. Standing approval changes the duration of access and requires separate authorization.
