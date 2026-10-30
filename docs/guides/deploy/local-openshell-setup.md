# Set up OCE locally with OpenShell and Codex

Install OpenClaw Enterprise (OCE) in a private k3d cluster. Then create a dedicated Codex Agent through the OCE API and send it a message through OpenClaw. Start here once before [adding Git support](../repository-credentials/openshell-git-push.md) or [adding Codex plugins](../integrations/codex-plugins.md). You can do either add-on first.

## Before you start

- Install the [local Kubernetes tools on Linux](local-kubernetes-tools.md). Use Bash, curl and jq.
- Ask the credential owner to transfer the **raw Codex personal access token (PAT)** for the approved ChatGPT service account through your secret manager or approved private-file handoff. Set `CODEX_TOKEN_FILE` to the owner-only file containing the token bytes. The [OCE-managed ChatGPT account APIs](../integrations/chatgpt.md) return credential metadata and do not export that token. Set `MODEL` to a native model ID the account can use.
- Use the generated OCE service key for REST and the [private Gateway routing key and CA](workspace-routing.md) for WebSocket access. Keep credential files outside the checkout with owner-only permissions.
- The operator needs permission to create Namespace Secrets, CredentialSources, Configurations, Agents, roles and bindings, and to update and operate the Agent.

Set the two inputs in your Bash shell before you start. Replace the example path and model with the ones assigned to this run.

```bash
# Use the file containing the raw token, not the token itself.
export CODEX_TOKEN_FILE=/secure/oce/codex-token
export MODEL=gpt-5.4
test -r "$CODEX_TOKEN_FILE" && test -s "$CODEX_TOKEN_FILE"
```

## 1. Prepare the quickstart files and select the stable release

Start in Bash at the root of the checkout containing **this guide**. Copy the examples below before switching to the source commit for the stable images.

| Example                                                                             | Purpose                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [Network policy](../../assets/openshell-quickstart/plugin-network-policy.yaml)      | Permit read-only plugin downloads from the approved hosts. |
| [Installation editor](../../assets/openshell-quickstart/configure-installation.mjs) | Configure Git and select the curated plugin catalog.       |
| [Codex configuration](../../assets/openshell-quickstart/codex-configuration.jq)     | Build the Agent's configuration using your chosen model.   |
| [Chat client](../../assets/openshell-quickstart/chat.mjs)                           | Send a turn through OpenClaw and return its history.       |

```bash
set -euo pipefail
umask 077

# Keep this run's files, credentials and kubeconfig separate from earlier installations.
RUN_DIR=$(mktemp -d)
install -m 600 docs/assets/openshell-quickstart/plugin-network-policy.yaml "$RUN_DIR/artifacts.yaml"
install -m 600 docs/assets/openshell-quickstart/configure-installation.mjs "$RUN_DIR/configure-installation.mjs"
install -m 600 docs/assets/openshell-quickstart/codex-configuration.jq "$RUN_DIR/codex-configuration.jq"
install -m 600 docs/assets/openshell-quickstart/chat.mjs "$RUN_DIR/chat.mjs"

# Pull the published OCE images for both components.
export OCE_IMAGE_CHANNEL=stable
docker pull ghcr.io/openclaw/openclaw-enterprise-controller:stable
docker pull ghcr.io/openclaw/openclaw-enterprise-runtime:stable
```

Complete [published image selection](published-images.md) in this shell. Check the publication receipt, export `CONTROLLER_IMAGE` and `RUNTIME_IMAGE`, and switch to the matching release checkout. Continue reading the guide from its original commit. For a different release, confirm the Codex binary paths and package hosts in the network policy.

## 2. Start a new k3d installation

Choose unused local ports for the OCE API and Kubernetes API. The launcher creates `k3d-state` under the new run directory. To repeat the exercise on a host with a previous disposable installation, first [remove only that installation](#remove-a-previous-quickstart).

```bash
# Select an isolated state directory and the Kubernetes-only OpenShell profile.
export OCC_DEVELOPMENT_STATE_DIRECTORY="$RUN_DIR/k3d-state"
export OPENCLAW_DEV_PORT=3012 OCC_DEVELOPMENT_KUBERNETES_API_PORT=6455
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
export OCC_DEVELOPMENT_CONTROLLER_IMAGE="${CONTROLLER_IMAGE:?}"
export OCC_KUBERNETES_RUNTIME_IMAGE="${RUNTIME_IMAGE:?}"

# Build the CLI from the matching source and wait for k3d bootstrap.
pnpm install --frozen-lockfile
go build -trimpath -o bin/occ ./cmd/occ
./bin/occ dev up --sandbox-network-policy-file "$RUN_DIR/artifacts.yaml"
```

Wait for `OpenClaw Enterprise development stack is ready`. Record the API URL, Kubernetes context and cleanup command printed by the launcher. With the example ports the REST base is `http://127.0.0.1:3012`. For browser sign-in, open the exact `Browser console` or `Console` URL printed by the launcher (path `/console/`); the Agents page is at `/console/agents` on that origin. For a printed HTTPS origin, [trust its browser CA and forward its browser port](../operate/troubleshooting.md#open-the-console-from-another-machine). The separate loopback REST endpoint uses the service key file.

## 3. Enable the credential and plugin settings

Run this from the matching release checkout. The editor removes the generated `source-control` rule that gives Git uninspected access to `github.com:443`. It keeps the other rules, adds `/usr/bin/git` to the Credential Gateway tool binaries and selects the curated Codex plugin catalog. Each Agent still needs an explicit Git source or plugin selection.

```bash
# Edit the fresh installation.yaml once, before provisioning Agents.
node "$RUN_DIR/configure-installation.mjs"
```

Reload the edited file through Helm. Use a new Secret name for each change. Helm rolls the API and worker when the referenced name changes. Wait for both deployments before provisioning the Agent.

```bash
# Verify the generated kubeconfig targets this run before changing the release.
state=$OCC_DEVELOPMENT_STATE_DIRECTORY
export KUBECONFIG="$state/kubeconfig"
context="k3d-$(jq -er .cluster "$state/state.json")"
ns=$(jq -er .platformNamespace "$state/state.json")
test "$(kubectl config current-context)" = "$context"

# Point Helm at a new, versioned Secret so that the API and worker reload the changes.
secret="oce-openshell-codex-$(date +%s)"
kubectl --context "$context" -n "$ns" create secret generic "$secret" \
  --from-file="installation.yaml=$state/installation.yaml"
helm --kube-context "$context" upgrade openclaw-enterprise deploy/helm/openclaw-enterprise \
  -n "$ns" -f "$state/helm-values.json" --set-string installation.secretName="$secret" --wait
```

If your network intercepts HTTPS, [install its approved public CA in the OpenShell supervisor](local-openshell-images.md#trust-an-upstream-ca-on-local-k3d). That section also covers a blocked Agent Sandbox image pull. If system Pods remain Pending, check the node logs and [local startup troubleshooting](../operate/troubleshooting.md#local-startup-stalls-on-cert-manager) before changing any host settings.

## 4. Connect to the API and register the model credential

The examples use `$api` for the loopback REST origin and `$base` for the full Namespace URL, `$api/namespaces/$namespace`. For example, the Namespace list is `GET http://127.0.0.1:3012/namespaces` with the ports in step 2.

Run the setup blocks in the same Bash shell and keep the private `RUN_DIR` for the optional guides. Set `CODEX_TOKEN_FILE` to your private service-account PAT file and `MODEL` to its native model ID. Keep shell tracing off. If a mutation times out, read back its result before retrying.

```bash
# Read the REST base URL and save the service key in a private curl header file.
api="http://127.0.0.1:$(jq -er .apiPort "$state/state.json")"
jq -er '"x-api-key: "+.data.key' "$(jq -er .keyPath "$state/state.json")" > "$RUN_DIR/headers"

# request METHOD URL [curl options] authenticates REST calls. Bodyless POSTs omit Content-Type.
request() {
  local method=$1 url=$2
  shift 2
  local headers=(-H @"$RUN_DIR/headers")
  if (( $# )); then headers+=(-H 'Content-Type: application/json'); fi
  curl --silent --show-error --fail-with-body -X "$method" "${headers[@]}" "$url" "$@"
}

# GET /namespaces: select the ready default Namespace.
namespace=$(request GET "$api/namespaces" | jq -er '.data[]|select(.name=="default" and .status=="ready")|.id')
base="$api/namespaces/$namespace"
printf 'Namespace API: %s\n' "$base"
```

Keep the token with the Credential Gateway. First store the PAT in a Namespace Secret. Then register a `codex-pat` source using the Secret reference.

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

Register the model with a fail-closed loopback URL. The Gateway uses authenticated WebSocket transport to the dedicated Codex Harness, which runs inside OpenShell. Give the Agent's own principal `operate` on its exact model source.

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

## 6. Grant model access and deploy

Create one role scoped to credential sources. Bind that role to this Agent's principal for the model source only. The Git guide will reuse the same helper with its own source ID.

```bash
# POST $base/iam/roles: allow the operate action on CredentialSources.
role=$(jq -n --arg name "$name-sources" \
  '{name:$name,permissions:[{action:"operate",resourceKind:"credential_source"}]}' |
  request POST "$base/iam/roles" --data-binary @- | jq -er .data.id)

# POST $base/iam/access-bindings: grant access to one exact source.
grant_source() {
  local source=$1
  jq -n --arg p "$principal" --arg r "$role" --arg s "$source" \
    '{subjectKind:"identity",subjectId:$p,roleId:$r,resourceKind:"credential_source",resourceId:$s}' |
    request POST "$base/iam/access-bindings" --data-binary @- > "$RUN_DIR/binding-$source"
}
grant_source "$modelSource"

# Provision transport once, before the first revision.
request POST "$base/agents/$agent/runtime-credentials" --data '{}' > "$RUN_DIR/transport"

# POST $base/agents/$agent/deploy starts a revision. Poll GET $base/agents/$agent/deployments/$revision.
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
  printf 'Deployment %s: %s\n' "$revision" "$status"
  test "$status" = succeeded
  test "$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)" = "$revision"
}
deploy_and_wait
```

Continue when the deployment reports `succeeded` and the Agent's `activeRevisionId` matches the new revision.

## 7. Verify a turn through OpenClaw

The operator client from step 1 opens `wss://<private-gateway-host>/namespaces/$namespace/agents/$agent`. Its HTTP upgrade sends the installation routing key in `x-api-key`. The client runs in the OCE API Pod, which already has the private route, key and trusted CA. The Agent executes the turn.

```bash
# Send one chat.send request, wait for its run ID, then read chat.history.
turn() {
  kubectl --context "$context" -n "$ns" exec -i deployment/openclaw-enterprise-api -c api -- \
    env OCE_TEST_NAMESPACE_ID="$namespace" OCE_TEST_AGENT_ID="$agent" OCE_TEST_PROMPT="$(cat "$1")" \
    node --input-type=module < "$RUN_DIR/chat.mjs"
}

# A successful response must include the requested text.
printf '%s\n' 'Reply with OCE_READY.' > "$RUN_DIR/setup-prompt"
turn "$RUN_DIR/setup-prompt" > "$RUN_DIR/setup-result"
jq -e '.outcome.status=="ok" and (.outcome.terminalReply.text|contains("OCE_READY"))' "$RUN_DIR/setup-result"
```

Save the operator session for the add-on guides. This file contains resource IDs, local paths and helper functions. The REST key stays in the private header file. Keep the directory and its files owner-only.

```bash
{
  printf '%s\n' 'set -euo pipefail' 'umask 077'
  declare -p RUN_DIR OCC_DEVELOPMENT_STATE_DIRECTORY KUBECONFIG context ns namespace base name agent principal role
  declare -f request grant_source deploy_and_wait turn
} > "$RUN_DIR/session.sh"
printf 'Operator session: %s/session.sh\n' "$RUN_DIR"
```

Keep this shell open or run `source /path/from/the/previous/command/session.sh` in Bash with the same tools on `PATH`. The file restores the full Namespace API URL (`$base`), the Agent ID and the authenticated REST and WebSocket helpers.

- [Add Git support](../repository-credentials/openshell-git-push.md) to push a new branch with a repository-scoped credential.
- [Add Codex plugins](../integrations/codex-plugins.md) to select Linear and verify a read through OpenClaw.

## Remove a previous quickstart

Use this section only when retiring the previous disposable installation. This deletes its k3d cluster, database, Agents and generated Kubernetes credentials. Before deletion, withdraw or confirm expiry of its external GitHub installation tokens. Keep the service-account PAT under its credential owner's control; deleting the cluster does not revoke external credentials.

Use the previous launcher's printed cleanup command. For the OpenShell profile, the equivalent below requires the **old** state directory and the cluster name from its installation record. Run it from the matching release checkout, using the CLI that created the installation.

```bash
# Set OLD_STATE to the previous installation's state directory and OLD_CLUSTER to its recorded k3d name.
: "${OLD_STATE:?Set the old state directory}" "${OLD_CLUSTER:?Set the old cluster name}"
(
  set -euo pipefail
  # Check both records before deleting. A mismatch stops this block before dev down.
  test "$(jq -er .cluster "$OLD_STATE/state.json")" = "$OLD_CLUSTER"
  test "$(kubectl --kubeconfig "$OLD_STATE/kubeconfig" config current-context)" = "k3d-$OLD_CLUSTER"
  printf 'Removing previous test installation %s (%s)\n' "$OLD_CLUSTER" "$OLD_STATE"
  env OCC_DEVELOPMENT_STATE_DIRECTORY="$OLD_STATE" OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes \
    OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell ./bin/occ dev down
  test ! -e "$OLD_STATE"
)
```

Expect `Stopped Kubernetes development stack <old-cluster>`. On failure, use the retained state and [cleanup guidance](local-kubernetes-development.md#stop-and-clean-up). Remove only private token or header copies owned by the retired run. For a fresh install, use a new `RUN_DIR` and let the launcher create a new state directory.

## Next steps

- [Install locally without OpenShell](../quickstart.md) for a separate k3d installation using Kubernetes Compute alone.
- [Verify local network isolation](local-kubernetes-development.md#verify-the-local-boundary) or [stop the disposable cluster](local-kubernetes-development.md#stop-and-clean-up) when you finish.
- Browse the [product guides](../README.md) for the CLI, Agent management and observability.
