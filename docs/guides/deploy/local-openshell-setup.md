# Set up OCE locally with OpenShell and Codex

Install OpenClaw Enterprise (OCE) in a private k3d cluster. Then create a dedicated Codex Agent through the OCE API and send it a message through OpenClaw. Start here once before [adding Git support](../repository-credentials/openshell-git-push.md) or [adding Codex plugins](../integrations/codex-plugins.md). You can do either add-on first.

## Before you start

- Install the [local Kubernetes tools on Linux](local-kubernetes-tools.md). Use Bash, curl and jq.
- Ask the credential owner to transfer the **raw Codex personal access token (PAT)** for the approved ChatGPT service account through your secret manager or approved private-file handoff. Set `CODEX_TOKEN_FILE` to the owner-only file containing the token bytes. The [OCE-managed ChatGPT account APIs](../integrations/chatgpt.md) return credential metadata and do not export that token. Select a model the account can use.
- Use the generated OCE service key for REST and the [private Gateway routing key and CA](workspace-routing.md) for WebSocket access. Keep credential files outside the checkout with owner-only permissions.
- The operator needs permission to create Namespace Secrets, CredentialSources, Configurations, Agents, roles and bindings, and to update and operate the Agent.

## 1. Install the stable pair

Run in one Bash shell from the checkout root. Pull both literal images and follow [published image selection](published-images.md) to verify the receipt, export the immutable references and switch to their source checkout.

```bash
export OCE_IMAGE_CHANNEL=stable
docker pull ghcr.io/openclaw/openclaw-enterprise-controller:stable
docker pull ghcr.io/openclaw/openclaw-enterprise-runtime:stable
```

Run from the matching release checkout while keeping this guide open. Choose two unused loopback ports for the OCE and Kubernetes APIs. The launcher creates the state directory itself. The optional Linear plugin needs read-only HTTPS access to its plugin package hosts. Save this policy for the published Codex 0.163.0-alpha.2 runtime. Check the binary paths when changing releases.

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

The next edit prepares the Installation for either add-on. The Agent receives repository access only when you bind its Git source; it receives Linear only when you select the plugin.

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
secret="oce-openshell-codex-$(date +%s)"
kubectl --context "$context" -n "$ns" create secret generic "$secret" \
  --from-file="installation.yaml=$state/installation.yaml"
helm --kube-context "$context" upgrade openclaw-enterprise deploy/helm/openclaw-enterprise \
  -n "$ns" -f "$state/helm-values.json" --set-string installation.secretName="$secret" --wait
```

If your network intercepts HTTPS, [install its approved public CA in the OpenShell supervisor](local-openshell-images.md#trust-an-upstream-ca-on-local-k3d). That section also covers a blocked Agent Sandbox image pull. If system Pods remain Pending, check the node logs and [local startup troubleshooting](../operate/troubleshooting.md#local-startup-stalls-on-cert-manager) before changing any host settings.

## 2. Connect to OCE and register the model credential

Run the setup blocks in the same Bash shell and keep the private `RUN_DIR` for the optional guides. Set `CODEX_TOKEN_FILE` to your private service-account PAT file and `MODEL` to its native model ID. Keep shell tracing off. If a mutation times out, read back its result before retrying.

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
name="openshell-codex-$(date +%s)"
jq -n --arg name "$name-model" --rawfile token "${CODEX_TOKEN_FILE:?}" \
  '{name:$name,value:($token|rtrimstr("\n"))}' |
  request POST "$base/secrets" --data-binary @- > "$RUN_DIR/model-secret"
jq --arg name "$name-model" '{name:$name,type:"codex-pat",secrets:{access_token:.data.ref}}' \
  "$RUN_DIR/model-secret" | request POST "$base/credential-sources" --data-binary @- > "$RUN_DIR/model-source"
modelSource=$(jq -er '.data|select(.state=="ready")|.id' "$RUN_DIR/model-source")
```

## 3. Deploy the baseline Agent

Register the model with a fail-closed loopback URL. The Gateway uses authenticated WebSocket transport to the dedicated Codex Harness, which runs inside OpenShell. Give the Agent's own principal `operate` on its exact model source.

```bash
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
  --arg m "$modelSource" '{
    name:$name,configurationId:$cfg,executionMode:"dedicated",gatewayManagedMode:true,
    harnessAuth:{method:"credential_source",sourceId:$m},credentialSources:[{sourceId:$m}]}' |
  request POST "$base/agents" --data-binary @- > "$RUN_DIR/agent"
agent=$(jq -er .data.id "$RUN_DIR/agent")
principal=$(jq -er .data.servicePrincipalId "$RUN_DIR/agent")
role=$(jq -n --arg name "$name-sources" \
  '{name:$name,permissions:[{action:"operate",resourceKind:"credential_source"}]}' |
  request POST "$base/iam/roles" --data-binary @- | jq -er .data.id)
grant_source() {
  local source=$1
  jq -n --arg p "$principal" --arg r "$role" --arg s "$source" \
    '{subjectKind:"identity",subjectId:$p,roleId:$r,resourceKind:"credential_source",resourceId:$s}' |
    request POST "$base/iam/access-bindings" --data-binary @- > "$RUN_DIR/binding-$source"
}
grant_source "$modelSource"
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

## 4. Verify a turn through OpenClaw

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

```bash
turn() {
  kubectl --context "$context" -n "$ns" exec -i deployment/openclaw-enterprise-api -c api -- \
    env OCE_TEST_NAMESPACE_ID="$namespace" OCE_TEST_AGENT_ID="$agent" OCE_TEST_PROMPT="$(cat "$1")" \
    node --input-type=module < "$RUN_DIR/chat.mjs"
}
printf '%s\n' 'Reply with OCE_READY.' > "$RUN_DIR/setup-prompt"
turn "$RUN_DIR/setup-prompt" > "$RUN_DIR/setup-result"
jq -e '.outcome.status=="ok" and (.outcome.terminalReply.text|contains("OCE_READY"))' "$RUN_DIR/setup-result"
```

Save the operator session for the add-on guides. This file contains resource IDs, local paths and helper functions. The REST key stays in the private header file. Keep the directory and its files owner-only.

```bash
{
  printf '%s\n' 'set -euo pipefail' 'umask 077'
  declare -p RUN_DIR KUBECONFIG context ns namespace base name agent principal role
  declare -f request grant_source deploy_and_wait turn
} > "$RUN_DIR/session.sh"
printf 'Operator session: %s/session.sh\n' "$RUN_DIR"
```

Continue in this shell or, in a new Bash shell with the local tools on `PATH`, source the printed session file:

- [Add Git support](../repository-credentials/openshell-git-push.md) to push a new branch with a repository-scoped credential.
- [Add Codex plugins](../integrations/codex-plugins.md) to select Linear and verify a read through OpenClaw.

## Next steps

- [Install locally without OpenShell](../quickstart.md) for a separate k3d installation using Kubernetes Compute alone.
- [Verify local network isolation](local-kubernetes-development.md#verify-the-local-boundary) or [stop the disposable cluster](local-kubernetes-development.md#stop-and-clean-up) when you finish.
- Browse the [product guides](../README.md) for the CLI, Agent management and observability.
