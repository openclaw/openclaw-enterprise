# Push a Git branch from an OpenShell Agent

Use a dedicated Codex Agent on local k3d to make one empty commit and push it to a new GitHub branch. The OpenClaw Gateway receives the chat request. Inside the OpenShell Sandbox, native Git sends a placeholder to the OpenShell supervisor, which substitutes the repository credential on the inspected HTTPS request. The GitHub App token determines which repository the Agent can write. This procedure uses the static Credential Gateway with no repository binding, Credential Proxy, or GitHub plugin.

## Before you start

- Install the [local Kubernetes tools on Linux](../deploy/local-kubernetes-tools.md). Use Bash, curl, jq, and an independent GitHub reader (`gh`) to verify the branch.
- Ask the credential owner to transfer the **raw Codex personal access token (PAT)** for the approved ChatGPT service account through your secret manager or approved private-file handoff. Set `CODEX_TOKEN_FILE` to the owner-only file containing the token bytes. The [OCE-managed ChatGPT account APIs](../integrations/chatgpt.md) return credential metadata and do not export that token. Use a model and an existing Linear connection authorized for this account.
- [Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) and [install it](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) on the test repository. This exercise needs **Contents write** and **Metadata read**. Keep the App ID, installation ID, repository ID and signing key with the operator. [Issue a short-lived installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) with `repository_ids: [<numeric repository ID>]` and those two permissions. Verify that `GET /installation/repositories` lists only the intended repository. Stage the write token in `GITHUB_TOKEN_FILE` just before step 2. To keep the Agent running after the push, obtain a second installation token for the same repository with only **Contents read** and **Metadata read**, and stage it in `GITHUB_READ_TOKEN_FILE` before step 6. Verify the issuance permissions and repository selection for both. GitHub rules still apply. This credential permits writes across that repository.
- Use the generated OCE service key for REST and the [private Gateway routing key and CA](../deploy/workspace-routing.md) for WebSocket access. Keep the GitHub App signing key, external tokens and service key out of the checkout and shell history. The operator needs Namespace permissions to create Secrets, CredentialSources, Configurations, Agents, roles and bindings, and operate the Agent.

## 1. Install the stable pair

Run in one Bash shell from the checkout root. Pull both literal images and follow [published image selection](../deploy/published-images.md) to verify the receipt, export the immutable references and switch to their source checkout.

```bash
export OCE_IMAGE_CHANNEL=stable
docker pull ghcr.io/openclaw/openclaw-enterprise-controller:stable
docker pull ghcr.io/openclaw/openclaw-enterprise-runtime:stable
```

Run from the matching release checkout while keeping this guide open. Use unused loopback ports; substitute two free ports if either example port is occupied. The launcher creates the state directory itself. For Linear, the native Codex executable needs read-only HTTPS access to its plugin package hosts. Save this policy for the published Codex 0.163.0-alpha.2 runtime. Check the binary paths when changing releases.

```bash
set -euo pipefail
umask 077
RUN_DIR=$(mktemp -d)
cat > "$RUN_DIR/artifacts.yaml" <<'YAML'
networkPolicies:
  - name: codex-plugin-artifacts
    binaries:
      - path: /app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.163.0-alpha.2-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex
      - path: /app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.163.0-alpha.2-linux-arm64/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/bin/codex
    endpoints:
      - {host: sdmntprsouthcentralus.oaiusercontent.com, ports: [443], protocol: rest, enforcement: enforce, access: read_only}
      - {host: sdmntprwestcentralus.oaiusercontent.com, ports: [443], protocol: rest, enforcement: enforce, access: read_only}
      - {host: sdmntprcentralus.oaiusercontent.com, ports: [443], protocol: rest, enforcement: enforce, access: read_only}
      - {host: sdmntprwestus.oaiusercontent.com, ports: [443], protocol: rest, enforcement: enforce, access: read_only}
      - {host: sdmntprbrazilsouth.oaiusercontent.com, ports: [443], protocol: rest, enforcement: enforce, access: read_only}
      - {host: sdmntprwestus2.oaiusercontent.com, ports: [443], protocol: rest, enforcement: enforce, access: read_only}
YAML
export OCC_DEVELOPMENT_STATE_DIRECTORY="$RUN_DIR/k3d-state"
export OPENCLAW_DEV_PORT=3012 OCC_DEVELOPMENT_KUBERNETES_API_PORT=6455
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
export OCC_DEVELOPMENT_CONTROLLER_IMAGE="${CONTROLLER_IMAGE:?}"
export OCC_KUBERNETES_RUNTIME_IMAGE="${RUNTIME_IMAGE:?}"
pnpm install --frozen-lockfile
go build -trimpath -o bin/occ ./cmd/occ
./bin/occ dev up --sandbox-network-policy-file "$RUN_DIR/artifacts.yaml"
```

In the generated `installation.yaml`, add `/usr/bin/git` to `drivers.credential_gateway.configuration.toolBinaries`, keep the existing Codex `binaries`, and set `drivers.plugin.configuration.catalogSource` to `openai-curated`. Under `drivers.sandbox.configuration.policy.networkPolicies`, remove the generated rule named `source-control` that grants `/usr/bin/git` access to `github.com:443` with `tls: skip`. The Git CredentialSource supplies an inspected rule scoped to the repository. Keep the remaining rules.

Apply those edits to the freshly generated file from the release checkout:

```bash
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/apps/controller/package.json");
const { loadYaml, dumpYaml } = require("@kubernetes/client-node");
const file = process.env.OCC_DEVELOPMENT_STATE_DIRECTORY + "/installation.yaml";
const config = loadYaml(readFileSync(file, "utf8"));
const drivers = config.drivers;
assert.ok(!drivers.credential_proxy);
const policy = drivers.sandbox.configuration.policy;
const rule = policy.networkPolicies.find(r => r.name === "source-control");
assert.deepEqual(rule, { name: "source-control", binaries: [{path: "/usr/bin/git"}],
  endpoints: [{host: "github.com", ports: [443], tls: "skip"}] });
policy.networkPolicies = policy.networkPolicies.filter(r => r !== rule);
const gateway = drivers.credential_gateway.configuration;
gateway.toolBinaries = [...new Set([...(gateway.toolBinaries ?? []), "/usr/bin/git"])];
drivers.plugin.configuration.catalogSource = "openai-curated";
writeFileSync(file, dumpYaml(config), {mode: 0o600});
JS
```

Reload the edited file through Helm. Use a new Secret name for each change. Helm rolls the API and worker when the referenced name changes. Wait for both deployments before provisioning the Agent.

```bash
state=$OCC_DEVELOPMENT_STATE_DIRECTORY
export KUBECONFIG="$state/kubeconfig"
context="k3d-$(jq -er .cluster "$state/state.json")"
ns=$(jq -er .platformNamespace "$state/state.json")
test "$(kubectl config current-context)" = "$context"
secret="oce-openshell-git-$(date +%s)"
kubectl --context "$context" -n "$ns" create secret generic "$secret" \
  --from-file="installation.yaml=$state/installation.yaml"
helm --kube-context "$context" upgrade openclaw-enterprise deploy/helm/openclaw-enterprise \
  -n "$ns" -f "$state/helm-values.json" --set-string installation.secretName="$secret" --wait
```

If your network intercepts HTTPS, [install its approved public CA in the OpenShell supervisor](../deploy/local-openshell-images.md#trust-an-upstream-ca-on-local-k3d). That section also covers a blocked Agent Sandbox image pull. If system Pods remain Pending, check the node logs and [local startup troubleshooting](../operate/troubleshooting.md#local-startup-stalls-on-cert-manager) before changing any host settings.

## 2. Create model and Git sources through REST

Keep shell tracing off. If a REST mutation times out, reconcile its result before retrying. Set `CODEX_TOKEN_FILE` and `GITHUB_TOKEN_FILE` to the private token files. Set `MODEL` to the account's native model ID (for example, `gpt-5.4` if enabled). This example uses `openclaw/openclaw-enterprise`. Substitute your approved repository everywhere if it differs.

```bash
api="http://127.0.0.1:$(jq -er .apiPort "$state/state.json")"
jq -er '"x-api-key: "+.data.key' "$(jq -er .keyPath "$state/state.json")" > "$RUN_DIR/headers"
request() {
  local method=$1 url=$2
  shift 2
  local headers=(-H @"$RUN_DIR/headers")
  if (( $# )); then headers+=(-H 'Content-Type: application/json'); fi
  curl --silent --show-error --fail-with-body -X "$method" "${headers[@]}" "$url" "$@"
}
namespace=$(request GET "$api/namespaces" | jq -er '.data[]|select(.name=="default" and .status=="ready")|.id')
base="$api/namespaces/$namespace"
name="git-push-$(date +%s)"
repo=openclaw/openclaw-enterprise
for kind in model git; do
  file=$CODEX_TOKEN_FILE
  if [[ $kind == git ]]; then file=$GITHUB_TOKEN_FILE; fi
  jq -n --arg name "$name-$kind" --rawfile token "$file" \
    '{name:$name,value:($token|rtrimstr("\n"))}' |
    request POST "$base/secrets" --data-binary @- > "$RUN_DIR/$kind-secret"
done
jq --arg name "$name-model" '{name:$name,type:"codex-pat",secrets:{access_token:.data.ref}}' \
  "$RUN_DIR/model-secret" | request POST "$base/credential-sources" --data-binary @- > "$RUN_DIR/model-source"
jq --arg name "$name-git" --arg path "/$repo.git/**" \
  '{name:$name,type:"bearer-token",config:{host:"github.com",port:"443",path:$path,env_var:"GITHUB_TOKEN"},
    secrets:{token:.data.ref}}' "$RUN_DIR/git-secret" |
  request POST "$base/credential-sources" --data-binary @- > "$RUN_DIR/git-source"
modelSource=$(jq -er '.data|select(.state=="ready")|.id' "$RUN_DIR/model-source")
gitSource=$(jq -er '.data|select(.state=="ready")|.id' "$RUN_DIR/git-source")
```

## 3. Create and deploy the Agent

Discover Linear with the model Secret. If the catalog returns a continuation cursor before the match, repeat the request with that cursor. Keep the selected plugin's write actions subject to human approval.

```bash
jq '{secretRef:.data.ref,q:"linear"}' "$RUN_DIR/model-secret" |
  request POST "$base/agents/plugins" --data-binary @- > "$RUN_DIR/plugins"
plugin=$(jq -er '.data.plugins[]|select((.name|ascii_downcase)=="linear" and .available!=false)|.id' "$RUN_DIR/plugins")
jq -n --arg model "${MODEL:?Set the service account model ID}" '{
  kind:"agent",values:{
    gateway:{mode:"local",bind:"lan",auth:{password:{source:"env",provider:"default",id:"OPENCLAW_GATEWAY_PASSWORD"}}},
    agents:{defaults:{model:("codex/"+$model),skipBootstrap:true,
      models:{("codex/"+$model):{agentRuntime:{id:"codex"}}}}},
    models:{providers:{codex:{api:"openai-responses",baseUrl:"http://127.0.0.1:9",models:[{id:$model,name:$model}]}}},
    tools:{gatewayPolicy:{allow:[],actions:{}},elevated:{enabled:false}},
    plugins:{allow:["codex"],entries:{codex:{enabled:true,config:{appServer:{
      mode:"guardian",transport:"websocket",url:"${APP_SERVER_URL}",authToken:"${APP_SERVER_TOKEN}",
      approvalPolicy:"on-request",approvalsReviewer:"user",sandbox:"danger-full-access"}}}}}
  }}' | request POST "$base/configurations" --data-binary @- > "$RUN_DIR/configuration"
jq -n --arg name "$name" --arg cfg "$(jq -er .data.id "$RUN_DIR/configuration")" \
  --arg m "$modelSource" --arg g "$gitSource" --arg p "$plugin" '{
    name:$name,configurationId:$cfg,executionMode:"dedicated",gatewayManagedMode:true,
    harnessAuth:{method:"credential_source",sourceId:$m},credentialSources:[{sourceId:$m},{sourceId:$g}],
    plugins:{($p):{enabled:true,toolDefaults:{enabled:true,approval:"write_actions",reviewer:"human"}}}}' |
  request POST "$base/agents" --data-binary @- > "$RUN_DIR/agent"
agent=$(jq -er .data.id "$RUN_DIR/agent")
principal=$(jq -er .data.servicePrincipalId "$RUN_DIR/agent")
role=$(jq -n --arg name "$name-sources" \
  '{name:$name,permissions:[{action:"operate",resourceKind:"credential_source"}]}' |
  request POST "$base/iam/roles" --data-binary @- | jq -er .data.id)
for source in "$modelSource" "$gitSource"; do
  jq -n --arg p "$principal" --arg r "$role" --arg s "$source" \
    '{subjectKind:"identity",subjectId:$p,roleId:$r,resourceKind:"credential_source",resourceId:$s}' |
    request POST "$base/iam/access-bindings" --data-binary @- > "$RUN_DIR/binding-$source"
done
request POST "$base/agents/$agent/runtime-credentials" --data '{}' > "$RUN_DIR/transport"
deploy_and_wait() {
  local revision result status attempt
  revision=$(request POST "$base/agents/$agent/deploy" | jq -er .data.id)
  for ((attempt=0; attempt<100; attempt++)); do
    result=$(request GET "$base/agents/$agent/deployments/$revision")
    status=$(jq -er .data.status <<<"$result")
    case "$status" in
      succeeded) break ;;
      failed|cancelled) jq .data.error <<<"$result"; return 1 ;;
    esac
    sleep 6
  done
  test "$status" = succeeded
  test "$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)" = "$revision"
}
deploy_and_wait
```

Provision transport once, before the first deployment. OpenShell enforces the outer sandbox while Codex runs native tools. The loopback provider URL keeps model requests on the authenticated WebSocket transport.

## 4. Push through OpenClaw

Save this operator client as `$RUN_DIR/chat.mjs`. It connects to the Agent's private WebSocket route using the installation routing key. It sends one `chat.send`, waits for the run, and reads its history. Run it in the API Pod, which already has the permitted route and CA.

```javascript
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire("/app/apps/controller/package.json");
const { GatewayClient } = await import(require.resolve("@openclaw/gateway-client"));
const { loadYaml } = require("@kubernetes/client-node");
const config = loadYaml(readFileSync(process.env.OCC_CONFIG_PATH, "utf8"));
const route = config.drivers.compute.configuration.gatewayRouting;
const port = route.endpointPort ?? 443;
const host = route.hostname + (port === 443 ? "" : `:${port}`);
const namespace = process.env.OCE_TEST_NAMESPACE_ID;
const agent = process.env.OCE_TEST_AGENT_ID;
const connected = Promise.withResolvers();
const sessionKey = `agent:main:api-check-${randomUUID()}`;
const client = new GatewayClient({
  url: `wss://${host}/namespaces/${namespace}/agents/${agent}`,
  edgeAuthHeaders: {
    "x-api-key": readFileSync(process.env.OCC_GATEWAY_API_KEY_PATH, "utf8").trim(),
  },
  clientName: "gateway-client",
  mode: "backend",
  role: "operator",
  scopes: [],
  deviceIdentity: null,
  minProtocol: 4,
  maxProtocol: 4,
  onHelloOk: connected.resolve,
  onConnectError: connected.reject,
});
const timer = setTimeout(() => connected.reject(new Error("Hello timeout")), 20000);
try {
  client.start();
  await connected.promise;
  clearTimeout(timer);
  const signal = AbortSignal.timeout(600000);
  const call = (method, params) =>
    client.request(method, params, {
      signal,
      timeoutMs: 30000,
    });
  const sent = await call("chat.send", {
    sessionKey,
    idempotencyKey: randomUUID(),
    message: process.env.OCE_TEST_PROMPT,
  });
  let outcome;
  do {
    outcome = await call("agent.wait", { runId: sent.runId, timeoutMs: 3000 });
  } while (!["ok", "error"].includes(outcome.status));
  const history = await call("chat.history", { sessionKey, limit: 200 });
  console.log(JSON.stringify({ runId: sent.runId, outcome, history }));
  if (outcome.status !== "ok") process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.stopAndWait({ timeoutMs: 1000 });
}
```

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
turn() {
  kubectl --context "$context" -n "$ns" exec -i deployment/openclaw-enterprise-api -c api -- \
    env OCE_TEST_NAMESPACE_ID="$namespace" OCE_TEST_AGENT_ID="$agent" OCE_TEST_PROMPT="$(cat "$1")" \
    node --input-type=module < "$RUN_DIR/chat.mjs"
}
turn "$RUN_DIR/push-prompt" > "$RUN_DIR/push-result"
```

GitHub Git accepts HTTP Basic with `x-access-token` as the username. OpenShell resolves the opaque placeholder inside the encoded header. Check the native tool result for `[new branch]` and matching SHAs. If a push result is uncertain, inspect the remote ref before any retry.

## 5. Verify the GitHub ref and the Linear result

Set `LOCAL_SHA` to the SHA reported by the Agent. Read GitHub from the operator workstation. Require the exact branch, parent, unchanged tree and zero changed files.

```bash
test "$(gh api "repos/$repo/git/ref/heads/$branch" --jq .object.sha)" = "${LOCAL_SHA:?}"
tree=$(gh api "repos/$repo/git/commits/$base_sha" --jq .tree.sha)
gh api "repos/$repo/commits/$LOCAL_SHA" | jq -e --arg base "$base_sha" --arg tree "$tree" \
  '.parents[0].sha==$base and .commit.tree.sha==$tree and (.files|length)==0'
```

For a separate Linear read, run the same OpenClaw client on the same Agent revision. Inspect the team IDs in the tool output and compare them with the final reply.

```bash
printf '%s\n' 'Use the Linear plugin to list teams with limit 3. Make no changes. Return the tool name and result.' > "$RUN_DIR/linear-prompt"
turn "$RUN_DIR/linear-prompt" > "$RUN_DIR/linear-result"
jq -e '.outcome.status=="ok" and
  any(.history.messages[]; .role=="toolResult" and
      .toolName=="codex_apps.linear.list_teams" and .isError==false)' "$RUN_DIR/linear-result"
jq '.history.messages[]|select(.toolName=="codex_apps.linear.list_teams")|.content' "$RUN_DIR/linear-result"
jq -r '.outcome.terminalReply.text' "$RUN_DIR/linear-result"
```

## 6. Withdraw write access and restore read access

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

Send a fresh OpenClaw turn that reads the pushed ref with native Git, then repeat the Linear read on this revision. Check the hash against the independent GitHub read from step 5.

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
turn "$RUN_DIR/linear-prompt" > "$RUN_DIR/linear-result"
jq -e '.outcome.status=="ok" and any(.history.messages[];
  .role=="toolResult" and .toolName=="codex_apps.linear.list_teams" and .isError==false)' "$RUN_DIR/linear-result"
```

Keep the read token's expiration with the deployment record. Repeat [static source rotation](../deploy/openshell-credential-sources.md#rotate-the-key) before it expires. If you finish the exercise instead of reusing the Agent, stop it and [remove the Agent and its unreferenced resources](../deploy/openshell-credential-sources.md#clean-up). Revoke any remaining installation token and remove private request files. Keep the branch for inspection or have its owner remove it.

On the stable [publication for `54bfa7f`](https://github.com/openclaw/openclaw-enterprise/actions/runs/40986763739), the Linux AMD64 Agent pushed [this empty commit](https://github.com/openclaw/openclaw-enterprise/commit/772fbf8671bbae2fa23b8a3ba8c85ba25e4cb643). GitHub returned the same SHA, parent and tree as the local Git operation. The same Agent revision completed the Linear team lookup. The installation used a separately configured OpenShell supervisor with the network's approved CA.
