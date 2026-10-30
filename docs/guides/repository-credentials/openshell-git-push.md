# Push a Git branch from an OpenShell Agent

Use a dedicated Codex Agent on local k3d to make one empty commit and push it to a new GitHub branch. The OpenClaw Gateway receives the chat request. Inside the OpenShell Sandbox, native Git sends a placeholder to the OpenShell supervisor, which substitutes the repository credential on the inspected HTTPS request. The GitHub App token determines which repository the Agent can write. This procedure uses the static Credential Gateway with no repository binding, Credential Proxy, or GitHub plugin.

## Before you start

Complete [Setup OCE on local k3d](../deploy/local-openshell-setup.md), including its successful OpenClaw turn. Continue in its Bash shell or source the private `session.sh` printed at the end of setup. Use the same running Agent. This guide uses native Git and needs no Codex app plugin.

[Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) and [install it](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) on the test repository. This exercise needs **Contents write** and **Metadata read**. Keep the App ID, installation ID, repository ID and signing key with the operator. [Issue a short-lived installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) with `repository_ids: [<numeric repository ID>]` and those two permissions. Verify that `GET /installation/repositories` lists only the intended repository. Stage the write token in `GITHUB_TOKEN_FILE` just before creating the Git source. To keep the Agent running after the push, obtain a second installation token for the same repository with only **Contents read** and **Metadata read**, and stage it in `GITHUB_READ_TOKEN_FILE` before withdrawing write access. Verify the issuance permissions and repository selection for both. GitHub rules still apply. This credential permits writes across that repository.

## Bind the repository credential

Use the repository approved for the exercise in place of the example below. Add one Git CredentialSource to the existing Agent's source list and leave its currently selected plugins in place. Run the mutation while you have exclusive control of this Agent's draft.

```bash
repo=openclaw/openclaw-enterprise
jq -n --arg name "$name-git" --rawfile token "${GITHUB_TOKEN_FILE:?}" \
  '{name:$name,value:($token|rtrimstr("\n"))}' |
  request POST "$base/secrets" --data-binary @- > "$RUN_DIR/git-secret"
jq --arg name "$name-git" --arg path "/$repo.git/**" \
  '{name:$name,type:"bearer-token",config:{host:"github.com",port:"443",path:$path,env_var:"GITHUB_TOKEN"},
    secrets:{token:.data.ref}}' "$RUN_DIR/git-secret" |
  request POST "$base/credential-sources" --data-binary @- > "$RUN_DIR/git-source"
gitSource=$(jq -er '.data|select(.state=="ready")|.id' "$RUN_DIR/git-source")
grant_source "$gitSource"
request GET "$base/agents/$agent" |
  jq --arg git "$gitSource" '.data | {configurationId,
    credentialSources:((.credentialSources // []) + [{sourceId:$git}])}' |
  request PATCH "$base/agents/$agent" --data-binary @- > "$RUN_DIR/git-agent"
deploy_and_wait
```

## Push through OpenClaw

Prepare the exact branch, base and committer before asking the Agent to run Git. Set `BOT_NAME` and `BOT_EMAIL` to your verified App bot identity. The quoted heredoc leaves the token placeholder expression for expansion inside the Sandbox.

```bash
branch="codex/oce-git-push-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 5)"
base_sha=$(gh api "repos/$repo/commits/HEAD" --jq .sha)
{
  printf 'Use native execution in a non-login Bash shell. Run the following once. Preserve hooks, approvals, TLS verification and other refs. Stop on errors. Report the branch and SHAs. Never print credentials.\n'
  printf 'repo=%q\nbranch=%q\nbase_sha=%q\nbot=%q\nemail=%q\n' \
    "$repo" "$branch" "$base_sha" "${BOT_NAME:?}" "${BOT_EMAIL:?}"
  cat <<'SCRIPT'
set -euo pipefail
[[ $GITHUB_TOKEN == openshell:resolve:env:* ]]
url="https://github.com/$repo.git"
authgit() {
  GIT_AUTH_HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)" \
    GIT_TERMINAL_PROMPT=0 git --config-env=http.extraHeader=GIT_AUTH_HEADER "$@"
}
mkdir "${branch##*/}"
cd "${branch##*/}"
git init
authgit fetch --no-tags --depth=1 "$url" "$base_sha"
test "$(git rev-parse FETCH_HEAD)" = "$base_sha"
git checkout --detach FETCH_HEAD
git -c user.name="$bot" -c user.email="$email" commit --allow-empty -m "Verify OpenShell push $branch"
if authgit ls-remote --exit-code --heads "$url" "refs/heads/$branch"; then exit 1; else test "$?" = 2; fi
authgit push --porcelain "$url" "HEAD:refs/heads/$branch"
local_sha=$(git rev-parse HEAD)
remote_sha=$(authgit ls-remote --exit-code --heads "$url" "refs/heads/$branch" | cut -f1)
test "$local_sha" = "$remote_sha"
printf 'BRANCH=%s LOCAL_SHA=%s REMOTE_SHA=%s\n' "$branch" "$local_sha" "$remote_sha"
SCRIPT
} > "$RUN_DIR/push-prompt"
turn "$RUN_DIR/push-prompt" > "$RUN_DIR/push-result"
```

GitHub Git accepts HTTP Basic with `x-access-token` as the username. OpenShell resolves the opaque placeholder inside the encoded header. Check the native tool result for `[new branch]` and matching SHAs. If a push result is uncertain, inspect the remote ref before any retry.

## Verify the GitHub ref

Set `LOCAL_SHA` to the SHA reported by the Agent. Read GitHub from the operator workstation. Require the exact branch, parent, unchanged tree and zero changed files.

```bash
test "$(gh api "repos/$repo/git/ref/heads/$branch" --jq .object.sha)" = "${LOCAL_SHA:?}"
tree=$(gh api "repos/$repo/git/commits/$base_sha" --jq .tree.sha)
gh api "repos/$repo/commits/$LOCAL_SHA" | jq -e --arg base "$base_sha" --arg tree "$tree" \
  '.parents[0].sha==$base and .commit.tree.sha==$tree and (.files|length)==0'
```

## Withdraw write access and restore read access

Run this block even if a turn failed. It attempts both GitHub token revocation and a bodyless OCE stop. HTTP 204 confirms revocation. A 401 can mean the token has already expired; verify the issuer's expiry record before continuing. A failed or unknown result from either operation requires separate reconciliation. Keep the Agent stopped until withdrawal is confirmed.

```bash
withdraw_write() {
  local rc=0 http
  if http=$(jq -ner --rawfile token "$GITHUB_TOKEN_FILE" \
      '"Authorization: Bearer "+($token|rtrimstr("\n"))' |
      curl --silent --show-error -o /dev/null -w '%{http_code}' --max-time 30 -H @- \
        -X DELETE https://api.github.com/installation/token) && [[ $http == 204 ]]; then
    echo "GitHub revoked the write token."
  else
    echo "Write token revocation unconfirmed (HTTP ${http:-unknown})." >&2
    rc=1
  fi
  if request POST "$base/agents/$agent/stop" |
      jq -e '.data.desiredRuntimeState=="stopped"' >/dev/null; then
    echo "OCE accepted the stop request."
  else
    echo "Agent stop unconfirmed. Inspect GET $base/agents/$agent." >&2
    rc=1
  fi
  return "$rc"
}
withdraw_write
```

**Keep the Agent:** replace the write Secret on the same Git CredentialSource and deploy the same Agent. The source still restricts the host, port, repository path and Git binary. Changing a Secret alone does not refresh the Gateway's copy. After stop succeeds, OCC clears `activeRevisionId`. The deployment provisions a new Agent revision.

```bash
for ((attempt=0; attempt<60; attempt++)); do
  result=$(request GET "$base/agents/$agent")
  if jq -e '.data.desiredRuntimeState=="stopped" and .data.activeRevisionId==null' <<<"$result" >/dev/null; then break; fi
  sleep 3
done
jq -e '.data.desiredRuntimeState=="stopped" and .data.activeRevisionId==null' <<<"$result" >/dev/null
jq -n --arg name "$name-read" --rawfile token "${GITHUB_READ_TOKEN_FILE:?}" \
  '{name:$name,value:($token|rtrimstr("\n"))}' |
  request POST "$base/secrets" --data-binary @- > "$RUN_DIR/read-secret"
jq '{secrets:{token:.data.ref}}' "$RUN_DIR/read-secret" |
  request PATCH "$base/credential-sources/$gitSource" --data-binary @- > "$RUN_DIR/read-source"
request GET "$base/credential-sources/$gitSource" |
  jq -e --slurpfile secret "$RUN_DIR/read-secret" \
    '.data.state=="ready" and .data.secrets.token==$secret[0].data.ref'
request DELETE "$base/secrets/$(jq -er .data.id "$RUN_DIR/git-secret")" > /dev/null
deploy_and_wait
```

Send a fresh OpenClaw turn that reads the pushed ref with native Git and check the hash against the independent GitHub read above.

```bash
{
  printf 'Run this script in a non-login Bash shell using native Git. Never print the credential. Report the fetched ref and SHA.\n'
  printf 'repo=%q\nbranch=%q\n' "$repo" "$branch"
  cat <<'SCRIPT'
set -euo pipefail
[[ $GITHUB_TOKEN == openshell:resolve:env:* ]]
GIT_AUTH_HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)" \
  GIT_TERMINAL_PROMPT=0 git --config-env=http.extraHeader=GIT_AUTH_HEADER \
    ls-remote --exit-code --heads "https://github.com/$repo.git" "refs/heads/$branch"
SCRIPT
} > "$RUN_DIR/read-prompt"
turn "$RUN_DIR/read-prompt" > "$RUN_DIR/read-result"
jq -e --arg sha "$LOCAL_SHA" --arg ref "refs/heads/$branch" \
  '.outcome.status=="ok" and any(.history.messages[];
    .role=="toolResult" and (.toolName=="bash" or .toolName=="exec") and .isError==false and
    (.content|tostring|contains($sha) and contains($ref)))' \
  "$RUN_DIR/read-result"
```

Keep the read token's expiration with the deployment record. Repeat [static source rotation](../deploy/openshell-credential-sources.md#rotate-the-key) before it expires. If you finish the exercise instead of reusing the Agent, stop it and [remove the Agent and its unreferenced resources](../deploy/openshell-credential-sources.md#clean-up). Revoke any remaining installation token and remove private request files. Keep the branch for inspection or have its owner remove it.

On the stable [publication for `54bfa7f`](https://github.com/openclaw/openclaw-enterprise/actions/runs/40986763739), the Linux AMD64 Agent pushed [this empty commit](https://github.com/openclaw/openclaw-enterprise/commit/772fbf8671bbae2fa23b8a3ba8c85ba25e4cb643). GitHub returned the same SHA, parent and tree as the local Git operation. The same Agent revision completed the Linear team lookup. The installation used a separately configured OpenShell supervisor with the network's approved CA.

To enable Linear, follow [Add Codex plugins](../integrations/codex-plugins.md). If Linear is already enabled, [repeat its OpenClaw read](../integrations/codex-plugins.md#verify-a-linear-read-through-openclaw) on the new revision.
