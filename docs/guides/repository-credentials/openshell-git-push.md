---
tags: [human_verified]
# Backfilled from the verification tag recorded in e22f558c0.
last_verified: "2026-11-02"
---

# Push a Git branch from an OpenShell Agent

Give an existing dedicated Codex Agent access to one GitHub repository. The OCE worker holds the GitHub App signing key and mints short-lived installation tokens. OpenShell authorizes Git requests through the repository Credential Proxy and injects a scoped token. Credential Gateway continues to supply the Agent's model credential.

This walkthrough makes one empty commit on a new test branch and verifies it on GitHub. GitHub branch rules still apply. The optional [renewal verification](openshell-git-renewal.md) adds a second push.

## Before you start

- **Supervisor trust and network:** Verify approved Supervisor outbound TCP 443 to the Git origin and its public CA trust for that TLS path. Worker GitHub API reachability is a separate prerequisite. A successful model turn does not prove either path. If the network uses a private CA, complete the Supervisor CA configuration in your installation setup before deployment. A failed held request closes that revision; correct trust and deploy a new revision without replaying its challenge.
- **OCE and OpenShell:** Use a controller, runtime, CLI and Helm chart from the same release supporting the `github-repository` profile, with matching OpenShell 0.1.6 Gateway, supervisor and charts. Select compatible images before starting your selected installation setup. If your published channel lacks the feature, [build the matching image pair](../deploy/production-installation.md#build-and-publish-production-images). Check that the matching checkout includes `deploy/examples/repository-credentials/openshell.registry.json`. See the [enrollment guide](openshell-enrollment.md) for the required release files. Verify the selected source and publication receipt; a channel name alone does not prove support.
- **GitHub App:** [Install the App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) on the test repository with **Contents write** and **Metadata read**. Obtain its App ID, installation ID, numeric repository ID and RSA signing key. The worker calls [GitHub's installation token endpoint](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app); the operator does not stage a token file.
- **Operator:** Use an approved Kubernetes context, access to the Installation's Helm releases, and the [GitHub CLI](https://cli.github.com/). Check that `gh auth status` shows your approved reader account.
- **Agent:** Use the operator session from [Deploy your first Agent](../deploy/deploy-first-agent.md), or source its private `session.sh`. The Agent needs a ready Gateway-owned `openai` or `codex-pat` source and provisioned runtime credentials. Register that source **before** enabling the repository Credential Proxy. Plugins require `codex-pat` but are optional for Git; preserve existing plugin selections.

## 1. Enroll one repository in the Installation

Use the existing isolated installation and the [shared operator session](../deploy/quickstart-session.md). Do not create another installation or Agent. Prepare the inputs below in `INSTALLATION_FILE` and `VALUES_FILE`; perform the rollout after creating the registry ConfigMaps. Changing a shared installation's credential owner can affect existing Agents. Use the [matching installation fragment and registry instructions](openshell-enrollment.md#configure-authorized-repositories) from the **release checkout**. Keep its private Gateway routing and authenticated OpenShell management connection.

1. Enroll one repository and one OCE Namespace. Replace the example IDs and repository name with your verified values. The registry structure is shown here as YAML; the commands below write the required `registry.json` file.

   ```yaml
   version: 1
   backendId: repository-backend
   providerInstanceId: github-team
   appId: "123456"
   githubInstallationId: "789012"
   maximumDurationSeconds: 86400
   repositories:
     - repositoryRef: application
       repositoryId: "345678"
       repository: example/project
       namespaces:
         - namespaceId: replace-with-occ-namespace-id
           profiles:
             - github-repository
           permissions:
             contents: write
             metadata: read
   ```

   `profiles` selects the allowed access mode; `permissions` sets its GitHub capabilities. See [registry profiles](../../reference/repository-credentials/access-levels.md#registry-profiles). The `github-repository` profile delegates ref restrictions to GitHub.

2. Mount the immutable registry ConfigMap in the controller and worker. Mount the App signing key and a persistent 32-byte custody key **only in the worker**. Merge this fragment into the OCE Helm values, replacing the ConfigMap and Secret names. Set `upstreamCidrs` to the [worker GitHub API ranges](openshell-enrollment.md#allow-the-worker-to-reach-github).

   ```yaml
   repositoryCredentials:
     enabled: false
     authority: prepared-git
     backendId: repository-backend
     registryConfigMapName: replace-with-registry-configmap-name
     appKeySecretName: replace-with-app-key-secret-name
     preparedCustodySecretName: replace-with-custody-secret-name
     upstreamCidrs:
       - replace-with-approved-issuer-cidr
   ```

3. Merge the [release Installation fragment](../../../deploy/examples/repository-credentials/openshell.fragment.yaml) into the existing Installation, preserving its Credential Gateway selection for model authentication. The following fields select the session duration and worker key paths:

   ```yaml
   repository:
     id: repository-credentials
     configuration:
       sessionDurationSeconds: 86400
     preparedGitHub:
       custodyKeyPath: /etc/openclaw/prepared-repository/custody.key
       privateKeyPath: /etc/openclaw/prepared-repository/private-key.pem
     openShell:
       registrationName: oce-prepared-git
       # Keep the authority settings from the release fragment.
   drivers:
     credential_proxy:
       id: openshell-sandbox
       configuration: {}
   ```

   Choose a session duration long enough for the Git exercise and no greater than the registry's `maximumDurationSeconds`. Replace `openshell-sandbox` with the existing Sandbox Driver ID, and set the existing OpenShell Backend's `drivers.credential_proxy` to that same ID. Omit `repository.nativeSender` and Compute's broker configuration.

4. [Configure the request-phase service](../../reference/repository-credentials/protected-openshell-git.md#prepare-the-request-phase-service) with its serving certificate, Gateway JWT public key and exact trusted-client network policies. Merge these settings into the OCE Helm values alongside the trusted-client selectors from that procedure. Replace the Secret and ConfigMap names with the resources you created.

   ```yaml
   openshellGit:
     enabled: true
     mode: protected
     port: 8445
     tlsSecretName: openshell-git-tls
     issuerPublicKeyConfigMapName: openshell-gateway-public
     # Add clients from the request-phase service procedure.
   ```

   Start the worker before restarting the OpenShell Gateway.

5. [Register the middleware](../../reference/repository-credentials/protected-openshell-git.md#register-the-request-phase-service) with TLS and the correct JWT issuer and audience. The Gateway uses TOML; its middleware entry must include:

   ```toml
   name = "oce-prepared-git"
   binding_policy = "allowlist"
   bindings = ["http_request_pre_credentials"]
   ```

   Keep the endpoint, CA path, audience and timeout from the registration procedure. Remove the generated uninspected `source-control` rule. The repository route must be the sole route to GitHub. Do not bind a separate Git token CredentialSource.

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
WRITE_REGISTRY="$registry"
kubectl --context "$CONTEXT" -n "$PLATFORM_NS" create configmap "$registry" \
  --from-file="registry.json=$RUN_DIR/registry.json" --dry-run=client -o json |
  jq '.immutable=true' | kubectl --context "$CONTEXT" create -f -

# Keep a separate immutable read-only map for the owner session after the push.
READ_REGISTRY="$registry-read"
jq '.repositories[0].namespaces[0].permissions={metadata:"read",contents:"read"}' \
  "$RUN_DIR/registry.json" > "$RUN_DIR/registry-read.json"
kubectl --context "$CONTEXT" -n "$PLATFORM_NS" create configmap "$READ_REGISTRY" \
  --from-file="registry.json=$RUN_DIR/registry-read.json" --dry-run=client -o json |
  jq '.immutable=true' | kubectl --context "$CONTEXT" create -f -
printf '%s\n' "$READ_REGISTRY" > "$RUN_DIR/read-registry-name"
```

Set `repositoryCredentials.registryConfigMapName` in `VALUES_FILE` to `$WRITE_REGISTRY`. Keep all other values, including the pinned Envoy image, verified proxy peers, browser settings and model Credential Gateway. Stop this Agent before changing its Installation's credential owner:

```bash
request POST "$base/agents/$agent/stop" > "$RUN_DIR/git-stop.json"
request GET "$base/agents/$agent" |
  jq -e '.data.desiredRuntimeState=="stopped" and .data.activeRevisionId==null'
```

If it is still stopping, repeat only the GET. Then apply the prepared Installation and Helm values:

```bash
upgrade_installation
deployment_preflight
repository_network
save_session
```

Complete the Gateway middleware rollout and authenticated worker installation check from steps 5–6 before proceeding. Use `$CONTEXT`, `$PLATFORM_NS` and `$namespace` in those commands. Replace the reference example’s `openclaw-system` in certificate SANs, middleware endpoints and commands with `$PLATFORM_NS`. The Supervisor namespace is `$TENANT_NAMESPACE`. Select the ready worker for the authenticated check:

```bash
WORKER_POD=$(kube -n "$PLATFORM_NS" get pods \
  -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=worker" -o json |
  jq -er '[.items[]|select(.metadata.deletionTimestamp==null and
    any(.status.containerStatuses[]?;.name=="worker" and .ready))]|select(length==1)|first.metadata.name')
```

After the worker and Gateway rollouts succeed, verify the authorized registry option:

```bash
# GET $base/agents/$agent/repository-options: check that the Namespace allows this reference.
ref=application
request GET "$base/agents/$agent/repository-options" |
  jq -e --arg ref "$ref" 'any(.data[]; .repositoryRef==$ref and (.allowedProfiles|index("github-repository"))!=null)'
```

## 2. Bind the Agent and deploy once

For a persistent Agent, keep the read-only registry ConfigMap from enrollment. After the authorized push, [retire the write grant and leave the Agent running](openshell-read-only.md). Set `GIT_SESSION_MODE=disposable` only for a test Agent that should stop when the shell exits.

Use the same dedicated Agent from the deployment guide, with no prior repository binding or static Git source. Fetch its current draft first. Keep its Configuration, Codex authentication and plugin selections. The API changes the repository binding when you deploy the updated draft.

```bash
# Run in a dedicated Bash shell with the private session.sh loaded.
# The disposable proof stops on exit. The owner workflow restores read access.
stop_git_test() {
  local rc=${1:-0}
  trap - EXIT
  if ! request POST "$base/agents/$agent/stop" > "$RUN_DIR/git-stop"; then
    printf 'Stop unconfirmed for %s. Restore session.sh and check the Agent state.\n' "$agent" >&2
    if (( rc == 0 )); then rc=1; fi
  fi
  return "$rc"
}
if [[ ${GIT_SESSION_MODE:-owner} == disposable ]]; then
  trap 'stop_git_test "$?"; exit $?' EXIT
fi

# PATCH $base/agents/$agent: replace the test Agent's empty binding list.
request GET "$base/agents/$agent" |
  jq -e --arg ref "$ref" '.data | select((.repositoryBindings // [] | length)==0) |
    {configurationId,repositoryBindings:[{repositoryRef:$ref,profile:"github-repository"}]}' |
  request PATCH "$base/agents/$agent" --data-binary @- > "$RUN_DIR/git-agent"
```

<AccordionGroup>
<Accordion title="Console">

Run `deployment_preflight`, then open this same Agent’s draft. Review the saved changes and select **Deploy new version**. Copy the `revision` ID from its Console URL and run `wait_deployment <deployment-id>` in the operator shell; this prepares the selected cluster’s network rules and waits for that revision. Repository enrollment and binding use the terminal; the Console deploys that saved draft.

</Accordion>
<Accordion title="CLI">

```bash
deploy_and_wait
```

</Accordion>
</AccordionGroup>

Record the deployed revision for verification:

```bash
# Keep this revision for the optional renewal proof.
revision=$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)
printf 'Agent %s, active revision %s\n' "$agent" "$revision"
```

A ready Agent alone does not prove Git access. Under a finite grant the worker can renew **tokens** only while the grant remains active. For continuing access beyond the session, consult [standing approval](../repository-credentials.md#keep-git-access-on-the-same-running-agent).

## 3. Push the first empty commit through OpenClaw

Keep `repo` as the exact enrolled repository. Resolve `BOT_NAME` and `BOT_EMAIL` from that registry’s App ID below. Use the OpenClaw session's `turn` function. The operator's GitHub reader selects and verifies SHAs; native Git inside the Agent performs each push. The managed Git credential helper supplies authentication.

```bash
# Keep repo and repo_id from the enrolled registry; resolve this App's bot identity.
app_id=$(kube -n "$PLATFORM_NS" get cm "$WRITE_REGISTRY" -o json |
  jq -er '.data["registry.json"]|fromjson|.appId|tostring')
BOT_NAME=$(gh api "apps/${APP_SLUG:?Set the verified App slug}" |
  jq -er --arg id "$app_id" 'select((.id|tostring)==$id)|.slug+"[bot]"')
bot_id=$(gh api "users/$(jq -rn --arg login "$BOT_NAME" '$login|@uri')" |
  jq -er --arg login "$BOT_NAME" 'select(.type=="Bot" and .login==$login)|.id|numbers')
BOT_EMAIL="${bot_id}+${BOT_NAME}@users.noreply.github.com"
branch="codex/oce-git-renew-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 5)"
default_branch=$(gh api "repos/$repo" --jq .default_branch)
base_sha=$(gh api "repos/$repo/git/ref/heads/$default_branch" --jq .object.sha)
push_turn() {
  local phase=$1 parent=$2
  {
    printf 'Use native execution in the same assigned workspace. Run the following in non-login Bash. Stop on any error or approval. Do not print credentials, change Git or TLS policy, touch other refs or repeat an uncertain push.\n'
    printf 'repo=%q\nbranch=%q\nparent=%q\ndefault_branch=%q\nphase=%q\nbot=%q\nemail=%q\n' \
      "$repo" "$branch" "$parent" "$default_branch" "$phase" "${BOT_NAME:?}" "${BOT_EMAIL:?}"
    cat <<'SCRIPT'
set -euo pipefail
url="https://github.com/$repo.git"
mkdir "${branch##*/}-$phase"
cd "${branch##*/}-$phase"
git init
git remote add origin "$url"
source_branch=$default_branch
if [[ $phase == second ]]; then source_branch=$branch; fi
git fetch --no-tags --depth=1 origin "refs/heads/$source_branch:refs/remotes/origin/$source_branch"
test "$(git rev-parse FETCH_HEAD)" = "$parent"
git checkout --detach FETCH_HEAD
git -c user.name="$bot" -c user.email="$email" commit --allow-empty -m "OpenShell Git renewal $phase"
if [[ $phase == first ]]; then
  if git ls-remote --exit-code --heads "$url" "refs/heads/$branch"; then exit 1; else test "$?" = 2; fi
else
  test "$(git ls-remote --exit-code --heads "$url" "refs/heads/$branch" | cut -f1)" = "$parent"
fi
# The remote must still advertise the parent before the empty commit is sent.
# Current Sandbox environments enable negotiation; keep it explicit for older revisions.
test "$(git ls-remote --exit-code origin "refs/heads/$source_branch" | cut -f1)" = "$parent"
git -c push.negotiate=true push --thin --porcelain origin "HEAD:refs/heads/$branch"
local_sha=$(git rev-parse HEAD)
remote_sha=$(git ls-remote --exit-code --heads "$url" "refs/heads/$branch" | cut -f1)
test "$remote_sha" = "$local_sha"
printf 'LOCAL_SHA=%s REMOTE_SHA=%s\n' "$local_sha" "$remote_sha"
SCRIPT
  } > "$RUN_DIR/$phase-prompt"
  if [[ ${GIT_TURN_INTERFACE:-cli} == cli ]]; then
    turn "$RUN_DIR/$phase-prompt" > "$RUN_DIR/$phase-result"
  fi
}
```

<AccordionGroup>
<Accordion title="Console">

Generate the exact prompt without sending it:

```bash
GIT_TURN_INTERFACE=console push_turn first "$base_sha"
cat "$RUN_DIR/first-prompt"
```

Open this Agent with **Open Agent UI** and paste the generated prompt once. Confirm successful native Git tool output and record its `LOCAL_SHA`. Do not resend an uncertain push.

</Accordion>
<Accordion title="CLI">

```bash
push_turn first "$base_sha"
```

</Accordion>
</AccordionGroup>

## 4. Verify the remote ref

<AccordionGroup>
<Accordion title="Console">

Open the repository in GitHub. Select the generated branch, inspect the commit, and confirm its SHA matches `LOCAL_SHA` from the successful tool output. Confirm its parent is `base_sha`, it changes no files, and both author and committer match the verified App bot name and email. A chat reply alone does not prove a push. Use the CLI path for the optional renewal proof.

</Accordion>
<Accordion title="CLI">

```bash
verify_push() {
  local phase=$1 parent=$2 sha tree remote_sha commit
  # Read the commit ID from successful native tool output, not from an inferred reply.
  sha=$(jq -er 'select(.outcome.status=="ok") | [.history.messages[] |
    select(.role=="toolResult" and .isError==false and (.toolName=="bash" or .toolName=="exec")) |
    .content[]?.text? | strings | capture("LOCAL_SHA=(?<sha>[0-9a-f]{40})").sha] |
    unique | select(length==1) | first' "$RUN_DIR/$phase-result") || return 1
  remote_sha=$(gh api "repos/$repo/git/ref/heads/$branch" --jq .object.sha) || return 1
  test "$remote_sha" = "$sha" || return 1
  tree=$(gh api "repos/$repo/git/commits/$parent" --jq .tree.sha) || return 1
  commit=$(gh api "repos/$repo/commits/$sha") || return 1
  jq -e --arg p "$parent" --arg t "$tree" --arg bot "$BOT_NAME" --arg email "$BOT_EMAIL" \
    '(.parents|length)==1 and .parents[0].sha==$p and .commit.tree.sha==$t and (.files|length)==0 and
      .author.login==$bot and .committer.login==$bot and
      all(.commit.author,.commit.committer; .name==$bot and .email==$email)' \
    <<<"$commit" >/dev/null || return 1
  printf '%s\n' "$sha"
}
first_sha=$(verify_push first "$base_sha")
printf 'First commit: https://github.com/%s/commit/%s\n' "$repo" "$first_sha"
```

</Accordion>
</AccordionGroup>

## 5. Restore read-only access

Save the verified branch and session values before leaving this shell. For Console verification, set `first_sha` to the independently verified commit first:

```bash
save_session
```

After verifying the push, [restore read-only Git access](openshell-read-only.md) on this same Agent. This is the shared procedure for local k3d, Kubernetes and EKS. Keep the original browser conversation and workspace. Then continue to [Add Plugin](../integrations/codex-plugins.md), or [delete the Agent](../deploy/quickstart-delete-agent.md) when finished.
