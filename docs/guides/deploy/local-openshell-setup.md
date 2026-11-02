# Set up OCE locally with OpenShell and Codex

Install OpenClaw Enterprise (OCE) in a private k3d cluster. Then create a dedicated Codex Agent through the OCE API and send it a message through OpenClaw. Start here once before [adding Git support](../repository-credentials/openshell-git-push.md) or [adding Codex plugins](../integrations/codex-plugins.md). For managed Git, check the [repository-binding release prerequisites](../repository-credentials/openshell-git-push.md#before-you-start) before choosing images. Keep Credential Gateway for the Codex service account and its authorized Linear connection.

To verify a repository binding, follow [Push a Git branch from an OpenShell Agent](../repository-credentials/openshell-git-push.md). It checks two remote commits and their credential versions across normal renewal.

## Before you start

- Install the [local Kubernetes tools on Linux](local-kubernetes-tools.md). Use Bash, curl and jq.
- [Create a ChatGPT workspace service account and generate its Codex access token](https://learn.chatgpt.com/docs/enterprise/service-accounts).
- Use the generated OCE service key for REST and the [private Gateway routing key and CA](workspace-routing.md) for WebSocket access. Keep credential files outside the checkout with owner-only permissions.
- The operator needs permission to create Namespace Secrets, CredentialSources, Configurations, Agents, roles and bindings, and to update and operate the Agent.

Set the two inputs in your Bash shell before you start. Replace the example path and model with the ones assigned to this run.

```bash
# Use the file containing the raw token, not the token itself.
export CODEX_TOKEN_FILE=/secure/oce/codex-token
export MODEL=gpt-5.4
test -r "$CODEX_TOKEN_FILE" && test -s "$CODEX_TOKEN_FILE"
```

## 1. Prepare the quickstart files and select a matching release

Start in Bash at the root of the checkout containing this guide. Copy the files to a private directory before switching to the matching release checkout. The policy, editor and configuration are shown inline at the steps that use them. The [WebSocket chat client](../../assets/openshell-quickstart/chat.mjs) sends the verification turn in step 7.

```bash
set -euo pipefail
umask 077

# Keep this run's files, credentials and kubeconfig separate from earlier installations.
run_root=${XDG_STATE_HOME:-$HOME/.local/state}/oce
install -d -m 700 "$run_root"
RUN_DIR=$(mktemp -d "$run_root/openshell.XXXXXXXX")
printf 'Private session directory: %s\n' "$RUN_DIR"

# Stage the network policy for cluster startup and the editor for the Helm reload.
install -m 600 docs/assets/openshell-quickstart/plugin-network-policy.yaml "$RUN_DIR/artifacts.yaml"
install -m 600 docs/assets/openshell-quickstart/configure-installation.mjs "$RUN_DIR/configure-installation.mjs"

# Stage the Agent configuration template and the client used to verify a turn.
install -m 600 docs/assets/openshell-quickstart/codex-configuration.jq "$RUN_DIR/codex-configuration.jq"
install -m 600 docs/assets/openshell-quickstart/chat.mjs "$RUN_DIR/chat.mjs"
```

For published images, select a matching channel pair:

```bash
export OCE_IMAGE_CHANNEL=stable
docker pull ghcr.io/openclaw/openclaw-enterprise-controller:stable
docker pull ghcr.io/openclaw/openclaw-enterprise-runtime:stable
```

For repository bindings, verify that the pair's publication receipt identifies source with `deploy/examples/repository-credentials/openshell.registry.json` and OpenShell 0.1.6. A channel tag alone does not prove support. For a source build, use the [matched image build procedure](production-installation.md#build-and-publish-production-images) and supply both immutable references.

For published images, complete [published image selection](published-images.md), export `CONTROLLER_IMAGE` and `RUNTIME_IMAGE`, and switch to the matching source. For local source development, leave both variables and both image selectors unset; the launcher builds the pair from the checkout. Retain its imported digests and source commit. Check the pinned Codex paths and package hosts for the selected release.

## 2. Start a new k3d installation

Choose unused local ports for the OCE API, HTTPS Console and Kubernetes API. The launcher creates `k3d-state` under the new run directory. To repeat the exercise on a host with a previous disposable installation, first [remove only that installation](#remove-a-previous-quickstart).

The [plugin network policy](../../assets/openshell-quickstart/plugin-network-policy.yaml), copied to `$RUN_DIR/artifacts.yaml`, grants the two pinned Codex binaries read-only HTTPS access to the listed package hosts.

<Snippet file="../../assets/openshell-quickstart/plugin-network-policy.yaml" lang="yaml" />

```bash
# Select an isolated state directory and the Kubernetes-only OpenShell profile.
export OCC_DEVELOPMENT_STATE_DIRECTORY="$RUN_DIR/k3d-state"
export OPENCLAW_DEV_PORT=3012 OCC_DEVELOPMENT_BROWSER_PORT=8443 OCC_DEVELOPMENT_KUBERNETES_API_PORT=6455
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
export OCC_DEVELOPMENT_PROTECTED_EGRESS=1
# Select both published images, or let the launcher build both from source.
if [[ -n ${CONTROLLER_IMAGE:-} || -n ${RUNTIME_IMAGE:-} ]]; then
  export OCC_DEVELOPMENT_CONTROLLER_IMAGE="${CONTROLLER_IMAGE:?}"
  export OCC_KUBERNETES_RUNTIME_IMAGE="${RUNTIME_IMAGE:?}"
else
  unset OCC_DEVELOPMENT_CONTROLLER_IMAGE OCC_KUBERNETES_RUNTIME_IMAGE
fi

# Build the CLI from the matching source and wait for k3d bootstrap.
pnpm install --frozen-lockfile
go build -trimpath -o bin/occ ./cmd/occ
./bin/occ dev up --sandbox-network-policy-file "$RUN_DIR/artifacts.yaml"
```

While the fresh installation waits, complete [Gateway-only bootstrap](../repository-credentials/openshell-enrollment.md#prepare-an-authenticated-local-gateway) in a second terminal. Then wait for `OpenClaw Enterprise development stack is ready`. Record the printed API URL, Kubernetes context and cleanup command. With the example ports the REST base is `http://127.0.0.1:3012`. Open the printed Console origin at `/console/`; its Agents page is `/console/agents`. For HTTPS, [trust its browser CA and forward its port](../operate/troubleshooting.md#open-the-console-from-another-machine).

## 3. Enable the credential and plugin settings

Run this from the matching release checkout. The editor removes the generated `source-control` rule that gives Git uninspected access to `github.com:443`. It keeps the other rules and selects the curated Codex plugin catalog. Git access requires an explicit repository binding and its authorized installation profile.

Skip this section if Gateway-only bootstrap already applied these settings.

The [Installation editor](../../assets/openshell-quickstart/configure-installation.mjs) checks that the generated rule matches the expected settings before changing it.

<Snippet file="../../assets/openshell-quickstart/configure-installation.mjs" lang="javascript" />

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

Register the model with a fail-closed loopback URL. The Gateway uses authenticated WebSocket transport to the dedicated Codex Harness, which runs inside OpenShell. Give the Agent's own principal `operate` on its exact model source.

The [Codex configuration template](../../assets/openshell-quickstart/codex-configuration.jq) takes the model ID from `MODEL`. The command below renders the template as JSON and posts it to OCE.

<Snippet file="../../assets/openshell-quickstart/codex-configuration.jq" lang="jq" />

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

For browser onboarding, [bind this Agent’s Control UI origin](local-openshell-browser.md#bind-the-origin-before-deployment) before deploying it.

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

# POST $base/agents/$agent/deploy starts a revision. Poll GET $base/agents/$agent/deployments/$revision.
deploy_and_wait() {
  local revision result status attempt
  revision=$(request POST "$base/agents/$agent/deploy" | jq -er .data.id)
  for ((attempt=0; attempt<100; attempt++)); do
    result=$(request GET "$base/agents/$agent/deployments/$revision")
    status=$(jq -er .data.status <<<"$result")
    case "$status" in
      succeeded) break ;;
      failed|cancelled)
        printf '%s' "$result" > "$RUN_DIR/failed-deployment.json"
        jq -c '.data|{status,code:(.error.code // "unavailable")}' <<<"$result"
        return 1 ;;
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

For a new browser workspace, [sign in and complete onboarding](local-openshell-browser.md#open-the-agent-and-continue-a-chat) before sending any verification prompt. Use the saved session below for the Git and plugin add-ons.

The operator client from step 1 opens `wss://<private-gateway-host>/namespaces/$namespace/agents/$agent`. Its HTTP upgrade sends the installation routing key in `x-api-key`. The client runs in the OCE API Pod, which already has the private route, key and trusted CA. The Agent executes the turn.

```bash
# Send one chat.send request, wait for its run ID, then read chat.history.
turn() {
  kubectl --kubeconfig "$state/kubeconfig" --context "$context" -n "$ns" exec -i deployment/openclaw-enterprise-api -c api -- \
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
  declare -p RUN_DIR OCC_DEVELOPMENT_STATE_DIRECTORY KUBECONFIG state context ns namespace base name agent principal role modelSource
  declare -f request deploy_and_wait turn
} > "$RUN_DIR/session.sh"
printf 'Operator session: %s/session.sh\n' "$RUN_DIR"
```

Keep this shell open or run `source /path/from/the/previous/command/session.sh` in Bash with the same tools on `PATH`. The file restores the full Namespace API URL (`$base`), the Agent ID and the authenticated REST and WebSocket helpers.

- [Add Git support](../repository-credentials/openshell-git-push.md) to push a new branch with a repository binding and worker-minted GitHub App credentials.
- [Add Codex plugins](../integrations/codex-plugins.md) to select Linear and verify a read through OpenClaw.

## Remove a previous quickstart

Use this section only when retiring the previous disposable installation. This deletes its k3d cluster, database, Agents and generated Kubernetes credentials. Before deletion, withdraw repository access and confirm retirement or expiry of any GitHub installation tokens. Keep the service-account PAT under its credential owner's control; deleting the cluster does not revoke external credentials.

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
