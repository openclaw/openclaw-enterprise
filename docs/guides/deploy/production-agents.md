# Deploy and verify production Agents

Deploy an Agent into a ready Namespace and verify its active runtime. Complete
[control-plane installation](production-installation.md) and its authenticated
API check first. Run commands from the repository root in the same operator shell,
retaining its credentials and Kubernetes context.

## Prepare each Namespace

### Use a driver-managed Kubernetes namespace

Fresh bootstrap creates a platform Namespace named `default`. Run
`occ namespace list` and select its server-assigned ID as
`NAMESPACE_ID`. The worker creates
the backing Kubernetes namespace and labels it with
`openclaw.dev/namespace=$NAMESPACE_ID`. This is separate from Kubernetes'
built-in `default` namespace. Once the worker has created it, discover and
export its name for the tenant RoleBindings:

```bash
TENANT_NAMESPACE="$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  get namespaces -l "openclaw.dev/namespace=$NAMESPACE_ID" -o json | \
  python3 -c 'import json,sys; items=json.load(sys.stdin)["items"]; assert len(items) == 1, "Expected one backing Namespace; check worker provisioning"; print(items[0]["metadata"]["name"])')" && export TENANT_NAMESPACE
```

If no backing namespace is found, check the worker logs and repeat discovery
after creation. Complete the tenant RoleBindings below, then wait until
`GET /namespaces/$NAMESPACE_ID` reports `ready` before creating Configurations.

### Grant tenant RoleBindings

Grant the chart's worker, Configuration, and Secret ClusterRoles in each tenant
namespace. Replace the `oce-` prefix if the Helm release name differs:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-worker \
  --clusterrole=oce-openclaw-tenant-worker --serviceaccount=openclaw-system:openclaw-enterprise-worker
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-api \
  --clusterrole=oce-openclaw-tenant-configuration --serviceaccount=openclaw-system:openclaw-enterprise-api
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-api-secrets \
  --clusterrole=oce-openclaw-tenant-api --serviceaccount=openclaw-system:openclaw-enterprise-api
```

The Secret RoleBinding grants tenant-local Secret access only to the API. It
does not give the worker Secret API permission or replace OCC IAM grants for
bound Secrets.

## Prepare each Agent

Prepare Agent deployment after the Namespace is ready. The operator shell must
have `OCC_URL`, `OCC_SERVICE_KEY_FILE`, `OCC_NAMESPACE`, `NAMESPACE_ID`,
`TENANT_NAMESPACE`, `KUBECONFIG_FILE`, and `CONTEXT` set. `TENANT_NAMESPACE`
is the Kubernetes namespace created by the driver during
[Namespace preparation](#prepare-each-namespace).

## Configure the Agent runtime

Choose one runtime mode and write the matching Namespace-owned
`kind: "agent"` Configuration. Use `embedded` for built-in OpenClaw:

```bash
export AGENT_EXECUTION_MODE='embedded'
cat > configuration.json <<'JSON'
{"kind":"agent","values":{"gateway":{"mode":"local","bind":"lan","auth":{"mode":"token","token":"${OPENCLAW_GATEWAY_TOKEN}"}},"agents":{"defaults":{"model":"openai/gpt-5.6-sol","skipBootstrap":true,"models":{"openai/gpt-5.6-sol":{"agentRuntime":{"id":"openclaw"}}}}},"models":{"providers":{"openai":{"baseUrl":"https://api.openai.com/v1","api":"openai-responses","models":[{"id":"gpt-5.6-sol","name":"gpt-5.6-sol"}]}}}}}
JSON
```

Or use `dedicated` for the Codex runtime and its app-server placeholders. The
Configuration keeps transport placeholders separate from the model Secret and
does not contain `OPENAI_API_KEY`:

```bash
export AGENT_EXECUTION_MODE='dedicated'
cat > configuration.json <<'JSON'
{
  "kind": "agent",
  "values": {
    "gateway": {"mode": "local", "bind": "lan", "controlUi": {"enabled": false}, "auth": {"mode": "token", "token": "${OPENCLAW_GATEWAY_TOKEN}"}, "http": {"endpoints": {"chatCompletions": {"enabled": true}}}},
    "agents": {"defaults": {"model": "codex/gpt-5.6-sol", "skipBootstrap": true, "models": {"codex/gpt-5.6-sol": {"agentRuntime": {"id": "codex"}}}}},
    "models": {"providers": {"codex": {"baseUrl": "http://127.0.0.1:9", "api": "openai-responses", "models": [{"id": "gpt-5.6-sol", "name": "gpt-5.6-sol"}]}}},
    "plugins": {"allow": ["codex"], "entries": {"codex": {"enabled": true, "config": {"appServer": {
      "mode": "guardian", "approvalPolicy": "on-request", "sandbox": "read-only",
      "transport": "websocket", "url": "${APP_SERVER_URL}", "authToken": "${APP_SERVER_TOKEN}"
    }}}}}
  }
}
JSON
```

When using native model fallbacks, keep them on the primary model provider and
give each model a compatible Harness policy. OCC validates the full selection
and preserves its fallback order; mixed Harnesses are rejected. See
[native runtime selection](../../reference/harness-execution.md#native-runtime-selection).

Post the Configuration and capture the server-generated ID:

```bash
export OCC_NAMESPACE="$NAMESPACE_ID"
CONFIGURATION_RESPONSE="$(occ configuration create --file configuration.json --output json)"
CONFIGURATION_ID="$(printf '%s' "$CONFIGURATION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
export CONFIGURATION_ID
```

Create the Agent with the captured Configuration ID and the matching execution
mode. Mismatched Harness and mode pairs fail before deployment. Optional
`serviceAccountId` must identify a same-Namespace service account the caller can
read.

```bash
: "${AGENT_EXECUTION_MODE:?choose embedded or dedicated above}"
printf '{"name":"production-agent","configurationId":"%s","executionMode":"%s"}\n' \
  "$CONFIGURATION_ID" "$AGENT_EXECUTION_MODE" > agent.json
AGENT_RESPONSE="$(occ agent create --file agent.json --output json)"
AGENT_ID="$(printf '%s' "$AGENT_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
export AGENT_ID
```

For an Agent without any revisions, the console can provision initial transport,
OpenAI API key, and Slack credentials through the exact-Agent API. See
[initial runtime credentials](../../reference/console/create-and-deploy.md#initial-runtime-credentials).
The operator commands below remain available for installations using externally
provisioned inputs. Do not use both paths to replace an existing credential group.

Create the tenant transport Secret using the Agent ID suffix. Token-mode
gateways use `gateway-token`; dedicated Codex also uses `app-server-token`.
For native `gateway.auth.mode: "trusted-proxy"`, omit `gateway.auth.token`.
The Secret may still contain `gateway-token`, but Compute does not project
`OPENCLAW_GATEWAY_TOKEN` for that explicit mode.

```bash
umask 077
AGENT_SUFFIX="$(printf %s "$AGENT_ID" | shasum -a 256 | cut -c1-12)"
SECRET_DIRECTORY="$(mktemp -d)"
openssl rand -hex 32 | tr -d '\n' > "$SECRET_DIRECTORY/app-server-token"
openssl rand -hex 32 | tr -d '\n' > "$SECRET_DIRECTORY/gateway-token"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create secret generic "openclaw-agent-transport-$AGENT_SUFFIX" \
  --from-file=app-server-token="$SECRET_DIRECTORY/app-server-token" \
  --from-file=gateway-token="$SECRET_DIRECTORY/gateway-token"
```

Embedded OpenClaw uses only the gateway token. Dedicated Codex uses both
transport tokens. Model credentials stay in an Agent-owned model Secret or an
immutable service-account credential. They are not installed in controller runtime
environment, fixture output, or shell history. Console provisioning carries the
key transiently through the authorized API write without persisting it in the
controller database or logs.

For native API-key model turns through the native model Secret path, copy the
operator's protected source key into the private input file and require it to be
nonempty:

```bash
: "${OPERATOR_OPENAI_API_KEY_FILE:?set the protected source key path}"
install -m 600 "$OPERATOR_OPENAI_API_KEY_FILE" /secure/occ/openai-api-key
test -s /secure/occ/openai-api-key
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create secret generic "openclaw-agent-model-$AGENT_SUFFIX" \
  --from-file=OPENAI_API_KEY=/secure/occ/openai-api-key
```

Do not store the native API key in Helm values, Installation YAML,
Configurations, shell history, or this repository.

Deploy the Agent and capture the immutable revision ID:

```bash
REVISION_RESPONSE="$(occ agent deploy "$AGENT_ID" --output json)"
REVISION_ID="$(printf '%s' "$REVISION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
export REVISION_ID
printf '%s' "$REVISION_RESPONSE" | python3 -c 'import json,os,sys; data=json.load(sys.stdin); assert data["id"] == os.environ["REVISION_ID"] and data["agentId"] == os.environ["AGENT_ID"] and data["configurationId"] == os.environ["CONFIGURATION_ID"]'
```

`occ` exits unsuccessfully when deployment is rejected and returns the created
AgentRevision for structured output. If `configuration.json` includes OCC
`secretBindings`, the caller and Agent service principal must have `operate` on
every selected Secret before deploy. Binding changes are authorized by OCC IAM;
Kubernetes RoleBindings only allow the API to materialize backing tenant
Secrets.

## Verify production workloads

Wait for `GET /namespaces/$NAMESPACE_ID/agents/$AGENT_ID` to report the
expected `activeRevisionId`, then verify one denied and one allowed gateway
connection for the selected Agent. A Helm release, rendered chart, or ready
controller does not prove tenant runtime, gateway WebSocket authentication, or
a model turn. Use the production TUI proof below when the accepted evidence is
an interactive model-backed session.

## Attach with the OpenClaw TUI

Find the Ready gateway Pod for the active revision by matching the mounted
immutable ConfigMap:

```bash
AGENT_SUFFIX="$(printf %s "$AGENT_ID" | shasum -a 256 | cut -c1-12)"
REVISION_SUFFIX="$(printf %s "$REVISION_ID" | shasum -a 256 | cut -c1-12)"
EXPECTED_CONFIGMAP="gateway-$AGENT_SUFFIX-rev-$REVISION_SUFFIX"
GATEWAY_PODS_JSON="$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" get pods \
  -l "app.kubernetes.io/managed-by=openclaw-enterprise,openclaw.dev/workload-role=gateway,openclaw.dev/namespace=$NAMESPACE_ID,openclaw.dev/agent=$AGENT_ID" \
  -o json)"
GATEWAY_POD="$(printf '%s' "$GATEWAY_PODS_JSON" | python3 -c 'import json,sys; pods=[p for p in json.load(sys.stdin)["items"] if not p["metadata"].get("deletionTimestamp") and p.get("status",{}).get("phase")=="Running" and any(c.get("type")=="Ready" and c.get("status")=="True" for c in p.get("status",{}).get("conditions",[])) and any(v.get("configMap",{}).get("name")==sys.argv[1] for v in p["spec"].get("volumes",[]))]; assert len(pods)==1, f"expected exactly one Ready active gateway Pod, got {len(pods)}"; print(pods[0]["metadata"]["name"])' "$EXPECTED_CONFIGMAP")"
export GATEWAY_POD
```

Attach from the exported `$GATEWAY_POD`:

```bash
E2E_SESSION="production-tui-$(date +%Y%m%d%H%M%S)"
NONCE="$(python3 -c 'import secrets; print("OPENCLAW_TUI_" + secrets.token_hex(8))')"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$TENANT_NAMESPACE" \
  exec -it "$GATEWAY_POD" -c gateway -- env -u OPENAI_API_KEY \
  OPENCLAW_STATE_DIR=/tmp/occ-tui-client node /app/openclaw.mjs tui \
  --session "$E2E_SESSION" --message "Reply exactly: $NONCE"
```

The TUI uses the Pod-local WebSocket listener and injected gateway token. The
extra client process unsets `OPENAI_API_KEY`; model access stays in the serving
gateway path. Ctrl+D exits only the client.

This Pod-local TUI procedure requires token authentication. It does not apply
to gateways configured with the trusted-proxy authentication used by private
workspace-file routing; that mode intentionally has no gateway token. Use the
OCC file API for the supported administration path in that configuration.

## End the operator session

Remove only temporary local delivery copies:

```bash
rm -- "$OCC_SERVICE_KEY_FILE"
test -z "${OCC_SERVICE_KEY_DIRECTORY:-}" || rmdir -- "$OCC_SERVICE_KEY_DIRECTORY"
unset OCC_SERVICE_KEY_FILE OCC_SERVICE_KEY_DIRECTORY
```

This does not revoke the key or remove protected bootstrap storage.

## Related

- [Private routing for workspace files](workspace-routing.md).
- [Stop or remove a production deployment](../deploy.md#stop-or-remove-a-production-deployment).
- [Production TUI flow](../../flows/production-tui.md).
