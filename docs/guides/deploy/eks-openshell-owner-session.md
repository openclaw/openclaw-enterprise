# Verify an EKS owner session and leave the Agent running

Start with the running, read-only Agent from [OpenShell on EKS](eks-openshell-setup.md#5-deploy-and-open-the-owners-agent). Keep the laptop's port-forward running. Use the same shell, private session directory, Agent and Namespace throughout. Record each deployment ID and browser chat path there. A fresh EKS replay of this browser procedure is pending.

## Complete onboarding in the browser

1. Open `https://console.<cluster>.oce.localhost:18443/console/`. Sign in using the bootstrap owner email and the protected `$RUN_DIR/initial-admin-password` file. Select the Agent’s active version and **Open Agent UI**. Check that its HTTPS origin equals the one in the version’s Configuration.
2. In a fresh workspace, wait for startup to create `BOOTSTRAP.md`. Confirm it exists **before sending a prompt**. In the first browser chat, ask the Agent to complete onboarding, give it a new name and a unique preference to save. Use the Console **Workspace** tab to confirm the actual `IDENTITY.md` and `USER.md` files changed. Check that onboarding removed `BOOTSTRAP.md`. This command checks file presence on the revision’s native Pod without displaying contents:

```bash
bootstrap_state() {
  local revision pod
  revision=$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId) || return 1
  pod=$(kubectl -n "$TENANT_NAMESPACE" get pods \
    -l "openclaw.dev/agent=$agent,openclaw.dev/revision=$revision" -o json |
    jq -er '[.items[]|select(.metadata.deletionTimestamp==null and
      any(.status.containerStatuses[]?;.name=="agent" and .ready))] | select(length==1)|first.metadata.name') || return 1
  kubectl -n "$TENANT_NAMESPACE" exec "$pod" -c agent -- sh -c \
    'test -d /sandbox/enterprise || exit 1; if test -f /sandbox/enterprise/BOOTSTRAP.md; then echo present; else echo absent; fi'
}
bootstrap_state
```

3. Close the Agent tab. Reopen **Open Agent UI**, select the **same conversation** in chat history, and ask for the preference without including it in the new prompt. Match the reply against the original value.
4. In that conversation ask the Agent to use the managed Linear plugin to list one accessible team and return its ID, key and name. Inspect the actual successful tool call and result. Keep the run ID and matched team fact privately.

## Temporarily grant one push

Use a dedicated installation and one enrolled repository. The two registry ConfigMaps must select the same GitHub App, installation, repository ID, profile and OCE Namespace. Their only permission difference is Contents read versus Contents write. The `github-repository` profile authorizes the repository; GitHub branch protection and App permissions still apply. Limit the task to **one empty commit on one new branch**.

The following helpers operate on release `oce` and the selected Agent. They require a finite grant with no standing approval. If the Agent has a standing approval, remove it with its current generation through the [approval API](../repository-credentials.md#keep-git-access-on-the-same-running-agent) first.

```bash
git_audit() {
  kubectl -n "$PLATFORM_NS" exec -i deployment/openclaw-enterprise-worker -c worker -- \
    node --input-type=module - "$namespace" "$agent" "$1" < "$assets/git-revision-audit.mjs"
}
stop_and_retire() {
  local revision=$1 i
  request GET "$base/agents/$agent/repository-approvals" | jq -e '.data==[]' >/dev/null || return 1
  request GET "$base/agents/$agent" | jq -e --arg r "$revision" '.data.activeRevisionId==$r' >/dev/null || return 1
  request POST "$base/agents/$agent/stop" > "$RUN_DIR/stop-$revision.json" || return 1
  for ((i=0;i<100;i++)); do
    git_audit "$revision" > "$RUN_DIR/retirement-$revision.json" || return 1
    if jq -e 'any(.attempts[];.custody=="revoked") and
      all(.attempts[];(.custody=="revoked" or .custody=="not_issued") and (.sealed_present|not))' \
      "$RUN_DIR/retirement-$revision.json" >/dev/null && request GET "$base/agents/$agent" |
      jq -e '.data.desiredRuntimeState=="stopped" and .data.activeRevisionId==null' >/dev/null; then return 0; fi
    sleep 3
  done
  return 1
}
select_registry() {
  local registry=$1 permission=$2
  kubectl -n "$PLATFORM_NS" get cm "$registry" -o json |
    jq -e --arg ns "$namespace" --arg p "$permission" --arg ref "$ref" --arg repo "$repo" --arg id "$repo_id" '
      select(.immutable==true)|.data["registry.json"]|fromjson|.repositories|select(length==1)|first|
      select(.repositoryRef==$ref and .repository==$repo and (.repositoryId|tostring)==$id)|
      .namespaces|select(length==1)|first|.namespaceId==$ns and .profiles==["github-repository"] and
      .permissions=={metadata:"read",contents:$p}' >/dev/null || return 1
  helm -n "$PLATFORM_NS" get values oce -o json |
    jq --arg r "$registry" '.repositoryCredentials.registryConfigMapName=$r' > "$RUN_DIR/selected-registry.json" || return 1
  helm -n "$PLATFORM_NS" upgrade oce "$OCE_CHART" -f "$RUN_DIR/selected-registry.json" --wait || return 1
  kubectl -n "$PLATFORM_NS" rollout status deployment/openclaw-enterprise-worker || return 1
  [[ $(kubectl -n "$PLATFORM_NS" get envoyproxy oce-agent-gateways \
    -o jsonpath='{.spec.provider.kubernetes.envoyDeployment.container.image}') == "$ENVOY_IMAGE" ]] || return 1
  kubectl -n "$PLATFORM_NS" get pods -l 'app.kubernetes.io/instance=oce,app.kubernetes.io/component=worker' -o json |
    jq -e --arg r "$registry" '[.items[]|select(.metadata.deletionTimestamp==null)]|
      length>0 and all(.[];any(.status.conditions[]?;.type=="Ready" and .status=="True") and
        any(.spec.volumes[]?;.configMap.name==$r))'
}
```

Choose an approved base branch on the intended repository. Record its **advertised** SHA and an unused destination before granting write access. Run the commands with an independent GitHub reader.

```bash
repo=${GITHUB_REPOSITORY:?Set the enrolled owner/repository}
ref=application
repo_id=$(gh api "repos/$repo" --jq '.id|tostring')
base_branch=${GIT_BASE_BRANCH:?Set the approved remote base branch}
base_sha=$(git ls-remote --exit-code "https://github.com/$repo.git" "refs/heads/$base_branch" | cut -f1)
branch="codex/eks-browser-$(openssl rand -hex 8)"
existing=$(git ls-remote "https://github.com/$repo.git" "refs/heads/$branch")
test -z "$existing"
read_revision=$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)
stop_and_retire "$read_revision"
select_registry "${WRITE_REGISTRY:?}" write
deploy_owner_revision
write_revision=$(cat "$RUN_DIR/requested-revision")
printf '%s\n' "$write_revision" > "$RUN_DIR/write-revision"
```

Reopen the original chat through **Open Agent UI**. Ask it to publish one empty commit on `$branch` from `$base_sha`, fetching the named `$base_branch` and preserving the existing Git credential helper. Stop on an unexpected remote ref or an uncertain write. Record the reported new commit. Independently check the ref and commit:

```bash
sha=$(git ls-remote --exit-code "https://github.com/$repo.git" "refs/heads/$branch" | cut -f1)
parent_tree=$(gh api "repos/$repo/git/commits/$base_sha" --jq .tree.sha)
gh api "repos/$repo/commits/$sha" | jq -e --arg p "$base_sha" --arg t "$parent_tree" \
  --arg bot "${APP_BOT_LOGIN:?Expected GitHub App bot login}" \
  '(.parents|map(.sha))==[$p] and .commit.tree.sha==$t and .files==[] and .author.login==$bot'
git_audit "$write_revision" > "$RUN_DIR/write-uses.json"
jq -e '[.uses[]|select(.operation=="receive-pack")]|length==1' "$RUN_DIR/write-uses.json"
```

## Restore read-only access

After the one push, stop the write revision and require its known attempts to be retired and unsealed. If the browser, shell or provider response was interrupted, inspect the remote ref, current Agent state and saved revision before another mutation. Reconcile uncertain issuance or revocation before redeploying.

```bash
stop_and_retire "$(cat "$RUN_DIR/write-revision")"
select_registry "${READ_REGISTRY:?}" read
deploy_owner_revision
final_revision=$(cat "$RUN_DIR/requested-revision")
```

Reopen the same chat on the final running version. Ask it to recall the preference and use Git to read the test branch. Match its SHA against the independently verified commit. Verify an authenticated read and keep the Agent, persistent volumes and listener available:

```bash
git_audit "$final_revision" | jq -e '
  any(.uses[];.operation=="upload-pack" or .operation=="advertise-upload-pack") and
  all(.uses[];.operation!="receive-pack")'
request GET "$base/agents/$agent" | jq -e --arg r "$final_revision" \
  '.data.desiredRuntimeState=="running" and .data.activeRevisionId==$r'
```

Git access follows the final grant’s deadline. Closing the laptop port-forward disconnects the browser; reopen the same forward to reconnect. Provisioned EKS, EC2, EBS, ECR and RDS resources can continue to incur charges.
