# Push a Git branch from an OpenShell Agent

Give an existing dedicated Codex Agent access to one GitHub repository. The OCE worker holds the GitHub App signing key and mints short-lived installation tokens. OpenShell authorizes Git requests through the repository Credential Proxy and injects a scoped token. Credential Gateway continues to supply the Codex service-account credential, including the account's authorized Linear connection.

This walkthrough makes two empty commits on one new test branch. Use the same Agent revision for both pushes and verify that the second push used newly minted material. GitHub branch rules still apply.

**Token renewal testing is pending.** The same-Agent, same-revision two-push test below has not completed. Earlier successful Git pushes used a manually supplied static token and do not verify this managed repository-binding procedure.

## Before you start

- **Supervisor trust and network:** Verify approved Supervisor outbound TCP 443 to the Git origin and its public CA trust for that TLS path. Worker GitHub API reachability is a separate prerequisite. A successful model turn does not prove either path. If the network uses a private CA, complete [upstream CA setup](../deploy/local-openshell-images.md#trust-an-upstream-ca-on-local-k3d) before deployment. A failed held request closes that revision; correct trust and deploy a new revision without replaying its challenge.
- **OCE and OpenShell:** Use a controller, runtime, CLI and Helm chart from the same release supporting the `github-repository` profile, with matching OpenShell 0.1.6 Gateway, supervisor and charts. Select compatible images before starting [Local Setup OCE](../deploy/local-openshell-setup.md). If your published channel lacks the feature, [build the matching image pair](../deploy/production-installation.md#build-and-publish-production-images). The [enrollment guide](openshell-enrollment.md) identifies the required release files. Verify the selected source and publication receipt; a channel name alone does not prove support.
- **GitHub App:** [Install the App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) on the test repository with **Contents write** and **Metadata read**. Obtain its App ID, installation ID, numeric repository ID and RSA signing key. The worker calls [GitHub's installation token endpoint](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app); the operator does not stage a token file.
- **Operator:** Use an approved Kubernetes context, access to the Installation's Helm releases, and an authorized GitHub reader (`gh`). For renewal verification, arrange read-only access to the OCE PostgreSQL metadata described in step 5.
- **Agent:** Use the same Bash session as Setup OCE, or source its private `session.sh`. The Agent needs a ready Gateway-owned `codex-pat` source and provisioned runtime credentials. On a fresh installation, register that model source **before** enabling the repository Credential Proxy. Select [Linear](../integrations/codex-plugins.md) before the Git verification or include its existing selection when you deploy the bound revision.

## 1. Enroll one repository in the Installation

Prepare an isolated installation for this procedure. Changing a shared installation's credential owner can affect existing Agents. Use the [matching installation fragment and registry instructions](openshell-enrollment.md#configure-authorized-repositories) from the **release checkout**. Keep its private Gateway routing and authenticated OpenShell management connection.

1. Set one registry reference (here, `application`), one repository ID, one Namespace ID and `profiles: ["github-repository"]`. Give it `permissions: {"contents":"write","metadata":"read"}`. Choose a session duration longer than the token renewal exercise and within the registry maximum. This profile delegates ref restrictions to GitHub.
2. Mount the immutable registry ConfigMap in the controller and worker. Mount the App signing key and a persistent 32-byte custody key **only in the worker**. Restrict worker egress to the approved GitHub issuer destinations.
3. Keep the existing Credential Gateway selection for model authentication. Add `repository.preparedGitHub` and `repository.openShell` from the release fragment. Select the same OpenShell Driver ID for the Sandbox and Credential Proxy. Omit `repository.nativeSender` and Compute's broker configuration.
4. [Configure the request-phase service](../../reference/repository-credentials/protected-openshell-git.md#prepare-the-request-phase-service) with its serving certificate, Gateway JWT public key and exact trusted-client network policies. Set Helm `openshellGit.enabled: true`, `openshellGit.mode: protected`, `repositoryCredentials.authority: prepared-git` and `repositoryCredentials.enabled: false`. Start the worker before restarting the OpenShell Gateway.
5. [Register the middleware](../../reference/repository-credentials/protected-openshell-git.md#register-the-request-phase-service) under `oce-prepared-git` using TLS, the correct JWT issuer/audience, `binding_policy = "allowlist"` and `bindings = ["http_request_pre_credentials"]`. Remove the generated uninspected `source-control` rule. The repository route must be the sole route to GitHub. Do not bind a separate Git token CredentialSource.
6. Before deployment can start background issuance, complete the [authenticated worker installation check](openshell-enrollment.md#select-repositories-and-deploy). Require verified TLS, HTTP 200 and matching App and installation IDs. Keep the Agent stopped on failure; a later successful read does not settle an earlier uncertain issuance.

For the single-repository registry in step 1, set `APP_ID` and `INSTALLATION_ID` from the App settings. Use a unique, versioned ConfigMap name and keep the registry with the deployment record. Run these commands in the same operator shell:

```bash
repo=openclaw/openclaw-enterprise
ref=application
repo_id=$(gh api "repos/$repo" --jq '.id | tostring')

# Scope issuance to exactly this Namespace, repository ID and permission map.
jq -n --arg app "${APP_ID:?}" --arg installation "${INSTALLATION_ID:?}" \
  --arg id "$repo_id" --arg repo "$repo" --arg ref "$ref" --arg ns "$namespace" '{
    version:1,backendId:"repository-backend",providerInstanceId:"github-team",
    appId:$app,githubInstallationId:$installation,maximumDurationSeconds:86400,
    repositories:[{repositoryRef:$ref,repositoryId:$id,repository:$repo,
      namespaces:[{namespaceId:$ns,profiles:["github-repository"],
        permissions:{metadata:"read",contents:"write"}}]}]}' > "$RUN_DIR/registry.json"
registry="oce-git-registry-$(date +%s)"
kubectl --context "$context" -n "$ns" create configmap "$registry" \
  --from-file="registry.json=$RUN_DIR/registry.json" --dry-run=client -o json |
  jq '.immutable=true' | kubectl --context "$context" create -f -
```

After the worker and Gateway rollouts succeed, the OCE REST API exposes the authorized registry options for the Agent:

```bash
# GET $base/agents/$agent/repository-options: check that the Namespace allows this reference.
ref=application
request GET "$base/agents/$agent/repository-options" |
  jq -e --arg ref "$ref" 'any(.data[]; .repositoryRef==$ref and (.allowedProfiles|index("github-repository"))!=null)'
```

## 2. Bind the Agent and deploy once

Use a dedicated test Agent with no prior repository binding or static Git source. Fetch its current draft first. Keep its Configuration, Codex authentication and plugin selections. The API changes the repository binding when you deploy the updated draft.

```bash
# PATCH $base/agents/$agent: replace the test Agent's empty binding list.
request GET "$base/agents/$agent" |
  jq -e --arg ref "$ref" '.data | select((.repositoryBindings // [] | length)==0) |
    {configurationId,repositoryBindings:[{repositoryRef:$ref,profile:"github-repository"}]}' |
  request PATCH "$base/agents/$agent" --data-binary @- > "$RUN_DIR/git-agent"
deploy_and_wait

# Record the active revision for both turns. Do not deploy or change grants between pushes.
revision=$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)
printf 'Agent %s, active revision %s\n' "$agent" "$revision"
```

A ready Agent alone does not prove Git access. Under a finite grant the worker can renew **tokens** only while the grant remains active. For continuing access beyond the session, consult [standing approval](../repository-credentials.md#keep-git-access-on-the-same-running-agent).

## 3. Push the first empty commit through OpenClaw

Set `repo` to the exact repository in the registry and `BOT_NAME` and `BOT_EMAIL` to the App's verified bot identity. Use the OpenClaw session's `turn` function. The operator's GitHub reader selects and verifies SHAs; native Git inside the Agent performs each push. The managed Git credential helper supplies authentication.

```bash
repo=openclaw/openclaw-enterprise
branch="codex/oce-git-renew-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 5)"
base_sha=$(gh api "repos/$repo/commits/HEAD" --jq .sha)
push_turn() {
  local phase=$1 parent=$2
  {
    printf 'Use native execution in the same assigned workspace. Run the following in non-login Bash. Stop on any error or approval. Do not print credentials, change Git or TLS policy, touch other refs or repeat an uncertain push.\n'
    printf 'repo=%q\nbranch=%q\nparent=%q\nphase=%q\nbot=%q\nemail=%q\n' \
      "$repo" "$branch" "$parent" "$phase" "${BOT_NAME:?}" "${BOT_EMAIL:?}"
    cat <<'SCRIPT'
set -euo pipefail
url="https://github.com/$repo.git"
mkdir "${branch##*/}-$phase"
cd "${branch##*/}-$phase"
git init
git fetch --no-tags --depth=1 "$url" "$parent"
test "$(git rev-parse FETCH_HEAD)" = "$parent"
git checkout --detach FETCH_HEAD
git -c user.name="$bot" -c user.email="$email" commit --allow-empty -m "OpenShell Git renewal $phase"
if [[ $phase == first ]]; then
  if git ls-remote --exit-code --heads "$url" "refs/heads/$branch"; then exit 1; else test "$?" = 2; fi
else
  test "$(git ls-remote --exit-code --heads "$url" "refs/heads/$branch" | cut -f1)" = "$parent"
fi
git push --porcelain "$url" "HEAD:refs/heads/$branch"
local_sha=$(git rev-parse HEAD)
remote_sha=$(git ls-remote --exit-code --heads "$url" "refs/heads/$branch" | cut -f1)
test "$remote_sha" = "$local_sha"
printf 'LOCAL_SHA=%s REMOTE_SHA=%s\n' "$local_sha" "$remote_sha"
SCRIPT
  } > "$RUN_DIR/$phase-prompt"
  turn "$RUN_DIR/$phase-prompt" > "$RUN_DIR/$phase-result"
}
push_turn first "$base_sha"
```

## 4. Verify the remote ref

```bash
verify_push() {
  local phase=$1 parent=$2 sha tree
  # Read the commit ID from successful native tool output, not from an inferred reply.
  sha=$(jq -er 'select(.outcome.status=="ok") | [.history.messages[] |
    select(.role=="toolResult" and .isError==false and (.toolName=="bash" or .toolName=="exec")) |
    .content[]?.text? | strings | capture("LOCAL_SHA=(?<sha>[0-9a-f]{40})").sha] |
    unique | select(length==1) | first' "$RUN_DIR/$phase-result")
  test "$(gh api "repos/$repo/git/ref/heads/$branch" --jq .object.sha)" = "$sha"
  tree=$(gh api "repos/$repo/git/commits/$parent" --jq .tree.sha)
  gh api "repos/$repo/commits/$sha" | jq -e --arg p "$parent" --arg t "$tree" \
    '(.parents|length)==1 and .parents[0].sha==$p and .commit.tree.sha==$t and (.files|length)==0' >/dev/null
  printf '%s\n' "$sha"
}
first_sha=$(verify_push first "$base_sha")
printf 'First commit: https://github.com/%s/commit/%s\n' "$repo" "$first_sha"
```

## 5. Wait for renewal, then push again

GitHub issues short-lived tokens. The worker prepares a replacement before expiry. Record the first push's Git authorization receipt using an approved read-only PostgreSQL connection. Set the psql variable `revision` to the active revision from step 2. These queries return identifiers and expiry only.

```sql
-- Run after each push. Save the result before performing the next push.
SELECT u.exchange_id, u.material_version, a.provider_expires_at
FROM occ.prepared_repository_git_uses u
JOIN occ.repository_session_attempts s ON s.admission_id = u.admission_id
JOIN occ.prepared_github_attempts a ON a.id = u.attempt_id
WHERE s.revision_id = :'revision' AND u.operation = 'receive-pack';

-- Poll until this revision has a committed current version different from the first receipt.
SELECT a.material_version, a.provider_expires_at
FROM occ.prepared_github_attempts a
JOIN occ.prepared_github_families f ON f.source_id = a.source_id
WHERE f.source #>> '{session,revisionId}' = :'revision'
  AND a.state = 'committed' AND a.custody = 'current';
```

Wait for normal worker renewal. The reference implementation starts renewal roughly ten minutes before the usable cutoff for an hour-long token. Do not rotate a key, edit the database, restart the worker or redeploy to force the transition. Confirm the same revision is active, then make one fast-forward push whose parent is the first commit:

```bash
test "$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)" = "$revision"
push_turn second "$first_sha"
second_sha=$(verify_push second "$first_sha")
test "$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)" = "$revision"
printf 'Second commit: https://github.com/%s/commit/%s\n' "$repo" "$second_sha"
```

Require a second `receive-pack` receipt using the replacement material version, plus both verified GitHub commits. Two pushes with one token do not prove renewal. If Linear is enabled, [repeat the Linear read](../integrations/codex-plugins.md#verify-a-linear-read-through-openclaw) on this revision. If the second push has an uncertain outcome, inspect the remote ref before any retry.

## Withdraw access after the exercise

Stop the test Agent with bodyless `POST $base/agents/$agent/stop` and wait for its active revision to clear. Remove any standing approval through its generation-checked removal API. Clear the draft's repository bindings with `PATCH $base/agents/$agent` and its current `configurationId`. Check retirement through the [Token Service lifecycle](../../reference/repository-credentials.md#token-service-lifecycle). A stopped workload alone does not confirm external revocation. Keep the test branch for inspection unless its owner requests removal.
