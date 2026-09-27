# Deploy and verify production Agents

Deploy an Agent into a ready Namespace and verify model execution. Complete
[control-plane installation](production-installation.md) and its authenticated
API check. Run commands from the repository root, retaining credentials and
Kubernetes context. For Secret-backed authentication, you or an Installation
administrator must [grant the Agent access to the model Secret](#grant-the-agent-access-to-its-model-secret)
before deployment.

## Prepare each Namespace

### Use a driver-managed Kubernetes namespace

Fresh bootstrap creates a platform Namespace named `default`. Run
`occ namespace list` and export its server-assigned ID:

```bash
occ namespace list
export NAMESPACE_ID='<ID shown for default>'
```

The worker creates a Kubernetes namespace labeled
`openclaw.dev/namespace=$NAMESPACE_ID`, separate from Kubernetes' built-in
`default` namespace. Discover and export its name for tenant RoleBindings:

```bash
TENANT_NAMESPACE="$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  get namespaces -l "openclaw.dev/namespace=$NAMESPACE_ID" -o json | \
  python3 -c 'import json,sys; items=json.load(sys.stdin)["items"]; print(items[0]["metadata"]["name"]) if len(items)==1 else sys.exit("Expected one backing Namespace; check worker provisioning")')" && export TENANT_NAMESPACE
```

If no backing namespace is found, check the worker logs and repeat discovery
after creation. Complete the tenant RoleBindings below, then wait until
`GET /namespaces/$NAMESPACE_ID` reports `ready` before creating Configurations.
If it reports `failed`, inspect audit evidence and worker logs.
[Exhausted lease recovery](../../reference/controller/reconciliation.md#deferred-namespace-and-agent-convergence)
stops provisioning permanently.

### Grant tenant RoleBindings

Grant the worker runtime role in the data plane. The API lists Deployments for
credential preflight and reads Pods through the proxy for on-demand diagnostics.
Replace the `oce-` prefix if the Helm release name differs:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-worker \
  --clusterrole=oce-openclaw-tenant-worker --serviceaccount=openclaw-system:openclaw-enterprise-worker
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-api-observer \
  --clusterrole=oce-openclaw-gateway-observer --serviceaccount=openclaw-system:openclaw-enterprise-api
```

After the data-plane grant, the worker creates a second namespace. Discover it
and grant worker runtime permissions plus API canonical Configuration/Secret
storage and Deployment preflight access:

```bash
GATEWAY_RUNTIME_NAMESPACE="$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  get namespaces -l "openclaw.dev/gateway-namespace=$NAMESPACE_ID" -o json | \
  python3 -c 'import json,sys; items=json.load(sys.stdin)["items"]; print(items[0]["metadata"]["name"]) if len(items)==1 else sys.exit("Expected one Gateway runtime namespace; retry after worker creation")')" && export GATEWAY_RUNTIME_NAMESPACE
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$GATEWAY_RUNTIME_NAMESPACE" create rolebinding openclaw-enterprise-worker \
  --clusterrole=oce-openclaw-tenant-worker --serviceaccount=openclaw-system:openclaw-enterprise-worker
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$GATEWAY_RUNTIME_NAMESPACE" create rolebinding openclaw-enterprise-api-secrets \
  --clusterrole=oce-openclaw-tenant-api --serviceaccount=openclaw-system:openclaw-enterprise-api
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$GATEWAY_RUNTIME_NAMESPACE" create rolebinding openclaw-enterprise-api-configuration \
  --clusterrole=oce-openclaw-tenant-configuration --serviceaccount=openclaw-system:openclaw-enterprise-api
```

The Secret RoleBinding grants Secret access, Deployment list access for preflight,
and Pod read/proxy access for Gateway diagnostics. The data-plane observer grants
Deployment list and Pod read/proxy access for Agent diagnostics. OCC IAM grants
remain required. Worker permissions in both targets allow credential delivery.
Workload ServiceAccounts receive no Secret API access. Embedded execution also
needs the tenant-api role in the data plane for its combined transport bundle.
Wait for Namespace `ready` only after granting both targets.

## Prepare each Agent

Prepare Agent deployment after the Namespace is ready. The operator shell must
have `OCC_URL`, `OCC_SERVICE_KEY_FILE`, `OCC_NAMESPACE`, `NAMESPACE_ID`,
`TENANT_NAMESPACE`, `KUBECONFIG_FILE`, and `CONTEXT` set. `TENANT_NAMESPACE`
is the Kubernetes namespace created by the driver during
[Namespace preparation](#prepare-each-namespace).

## Configure the Agent runtime

Both examples enable Control UI. Their explicit loopback origins allow the first
revision to start without trusting an arbitrary browser host. After deployment,
[finish Control UI access](#open-control-ui) by adding this Agent's exact HTTPS
origin. Loopback origins alone do not enable the OCE native admin link.

Complete [private routing](workspace-routing.md#configure-private-routing) first.
Configure verified Envoy source CIDRs in the trusted Installation YAML before
deploying either example. Kubernetes Compute renders native trusted-proxy
authentication for Console workspace access; the examples omit Driver-owned
settings. Follow the [native authentication requirements](workspace-routing.md#configure-native-gateway-authentication)
for proxy identity and NetworkPolicy isolation; do not trust arbitrary client
addresses. The gateway password SecretRef enables the separate local model check.
Dedicated Codex also requires the [matching runtime images](workspace-routing.md#runtime-prerequisite-for-separate-storage).

Choose one runtime mode and write the matching Namespace-owned
`kind: "agent"` Configuration. Use `embedded` for built-in OpenClaw:

```bash
export AGENT_EXECUTION_MODE='embedded'
cat > configuration.json <<'JSON'
{
  "kind": "agent",
  "values": {
    "gateway": {
      "mode": "local",
      "bind": "lan",
      "controlUi": {
        "enabled": true,
        "allowedOrigins": [
          "http://127.0.0.1:18789",
          "http://localhost:18789"
        ]
      },
      "auth": {
        "password": {
          "source": "env",
          "provider": "default",
          "id": "OPENCLAW_GATEWAY_PASSWORD"
        }
      },
      "http": {
        "endpoints": {
          "chatCompletions": {
            "enabled": true
          }
        }
      }
    },
    "agents": {
      "defaults": {
        "model": "openai/gpt-6-astra",
        "skipBootstrap": true,
        "models": {
          "openai/gpt-6-astra": {
            "agentRuntime": {
              "id": "openclaw"
            }
          }
        }
      }
    },
    "models": {
      "providers": {
        "openai": {
          "baseUrl": "https://api.openai.com/v1",
          "api": "openai-responses",
          "models": [
            {
              "id": "gpt-6-astra",
              "name": "gpt-6-astra"
            }
          ]
        }
      }
    }
  }
}
JSON
```

Or use `dedicated` for the Codex runtime and its app-server placeholders. The
Configuration keeps transport placeholders separate from harness authentication and
does not contain `OPENAI_API_KEY`:

```bash
export AGENT_EXECUTION_MODE='dedicated'
cat > configuration.json <<'JSON'
{
  "kind": "agent",
  "values": {
    "gateway": {
      "mode": "local",
      "bind": "lan",
      "controlUi": {
        "enabled": true,
        "allowedOrigins": [
          "http://127.0.0.1:18789",
          "http://localhost:18789"
        ]
      },
      "auth": {
        "password": {
          "source": "env",
          "provider": "default",
          "id": "OPENCLAW_GATEWAY_PASSWORD"
        }
      },
      "http": {
        "endpoints": {
          "chatCompletions": {
            "enabled": true
          }
        }
      }
    },
    "agents": {
      "defaults": {
        "model": "codex/gpt-6-astra",
        "skipBootstrap": true,
        "models": {
          "codex/gpt-6-astra": {
            "agentRuntime": {
              "id": "codex"
            }
          }
        }
      }
    },
    "models": {
      "providers": {
        "codex": {
          "baseUrl": "http://127.0.0.1:9",
          "api": "openai-responses",
          "models": [
            {
              "id": "gpt-6-astra",
              "name": "gpt-6-astra"
            }
          ]
        }
      }
    },
    "plugins": {
      "allow": [
        "codex"
      ],
      "entries": {
        "codex": {
          "enabled": true,
          "config": {
            "appServer": {
              "mode": "guardian",
              "approvalPolicy": "on-request",
              "sandbox": "read-only",
              "transport": "websocket",
              "url": "${APP_SERVER_URL}",
              "authToken": "${APP_SERVER_TOKEN}"
            }
          }
        }
      }
    }
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
CONFIGURATION_RESPONSE="$(occ configuration create --file configuration.json --output json)" &&
CONFIGURATION_ID="$(printf '%s' "$CONFIGURATION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')" &&
export CONFIGURATION_ID
```

Create the Agent with the captured Configuration ID and the matching execution
mode. Mismatched Harness and mode pairs fail before deployment. Create a
[Namespace-owned OCC Secret](../../reference/drivers/kubernetes-secret.md#create-a-namespace-owned-secret)
containing the credential; set `HARNESS_SECRET_ID` to its `data.id`. Choose
`api_key`, or `codex_pat` for Dedicated Codex with an externally issued
[Codex service-account token](../../reference/console/create-and-deploy.md#create-an-agent).
Neither requires a Backend. The caller needs exact Secret `operate`.
For OCE-managed accounts, use the account/Backend binding in
[Harness authentication](../../reference/agents.md#harness-authentication).

```bash
: "${AGENT_EXECUTION_MODE:?choose embedded or dedicated above}"
: "${HARNESS_SECRET_ID:?set the OCC Secret ID containing the credential}"
export HARNESS_SECRET_ID
export HARNESS_AUTH_METHOD='api_key' # Or codex_pat for Dedicated Codex.
printf '{"name":"production-agent","configurationId":"%s","executionMode":"%s","harnessAuth":{"method":"%s","source":{"kind":"secret","namespaceId":"%s","id":"%s"}}}\n' \
  "$CONFIGURATION_ID" "$AGENT_EXECUTION_MODE" "$HARNESS_AUTH_METHOD" "$NAMESPACE_ID" "$HARNESS_SECRET_ID" > agent.json
AGENT_RESPONSE="$(occ agent create --file agent.json --output json)" &&
AGENT_ID="$(printf '%s' "$AGENT_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')" &&
AGENT_SERVICE_PRINCIPAL_ID="$(printf '%s' "$AGENT_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["servicePrincipalId"])')" &&
export AGENT_ID AGENT_SERVICE_PRINCIPAL_ID
```

### Grant the Agent access to its model Secret

The deploying caller and the Agent's service principal both need `operate` on
the exact Secret. To grant the Agent access, use a credential with Installation
`administer`, `read` on this Namespace, and `read` on the exact Secret. The fresh
bootstrap service key has these permissions with native IAM unless a Restriction
denies access. If you use a more limited credential, give `NAMESPACE_ID`,
`AGENT_ID`, and `HARNESS_SECRET_ID` to an Installation administrator. They can
look up the service principal and then run the commands below. Kubernetes
RoleBindings do not grant OCC access.

```bash
export NAMESPACE_ID AGENT_ID HARNESS_SECRET_ID
export OCC_NAMESPACE="$NAMESPACE_ID"
AGENT_LOOKUP="$(occ agent get "$AGENT_ID" --output json)" &&
AGENT_SERVICE_PRINCIPAL_ID="$(printf '%s' "$AGENT_LOOKUP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["servicePrincipalId"])')" &&
export AGENT_SERVICE_PRINCIPAL_ID
```

Create the Role once per Namespace, or use `occ iam role list --output json` to
find a Role with exactly the permission shown and export its ID as `IAM_ROLE_ID`:

```bash
cat > model-secret-role.json <<'JSON'
{"name":"Use a model Secret","permissions":[{"action":"operate","resourceKind":"secret"}]}
JSON
IAM_ROLE_RESPONSE="$(occ iam role create --file model-secret-role.json --output json)" &&
IAM_ROLE_ID="$(printf '%s' "$IAM_ROLE_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')" &&
export IAM_ROLE_ID
```

Bind the Role to this Agent and this Secret, then read the stored binding:

```bash
: "${NAMESPACE_ID:?}" "${AGENT_SERVICE_PRINCIPAL_ID:?}" "${IAM_ROLE_ID:?}" "${HARNESS_SECRET_ID:?}"
python3 -c 'import json,os; print(json.dumps({"subjectKind":"identity","subjectId":os.environ["AGENT_SERVICE_PRINCIPAL_ID"],"roleId":os.environ["IAM_ROLE_ID"],"resourceKind":"secret","resourceId":os.environ["HARNESS_SECRET_ID"]}))' > model-secret-binding.json &&
IAM_BINDING_RESPONSE="$(occ iam access-binding create --file model-secret-binding.json --output json)" &&
IAM_BINDING_ID="$(printf '%s' "$IAM_BINDING_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')" &&
export IAM_BINDING_ID

IAM_BINDING="$(occ iam access-binding get "${IAM_BINDING_ID:?}" --output json)" &&
printf '%s' "$IAM_BINDING" | python3 -c '
import json, os, sys
binding = json.load(sys.stdin)
expected = {
    "namespaceId": os.environ["NAMESPACE_ID"],
    "subjectKind": "identity",
    "subjectId": os.environ["AGENT_SERVICE_PRINCIPAL_ID"],
    "roleId": os.environ["IAM_ROLE_ID"],
    "resourceKind": "secret",
    "resourceId": os.environ["HARNESS_SECRET_ID"],
}
if any(binding.get(key) != value for key, value in expected.items()):
    sys.exit("Binding does not match this Agent and Secret.")
print("Exact Agent Secret binding is stored")
'
```

Continue only after the confirmation. If a create response is lost, inspect
`occ iam role list --output json` or `occ iam access-binding list --output json`
before retrying; duplicate bindings can coexist. The stored binding does not
override a matching Restriction. See [Namespace IAM policy](../../reference/authorization.md#manage-namespace-policy).

### Prepare transport credentials and deploy

For a draft Agent, **Deploy new revision** generates missing transport
credentials before its first revision. API clients may call the endpoint below
first. Keep `OCC_URL` and
`OCC_SERVICE_KEY_FILE` from Installation bootstrap. The API derives the correct
Secret placement for the Agent's execution mode and never returns credential
values. It never rotates credentials.

```bash
node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";
const { OCC_URL, OCC_SERVICE_KEY_FILE, NAMESPACE_ID, AGENT_ID } = process.env;
if (![OCC_URL, OCC_SERVICE_KEY_FILE, NAMESPACE_ID, AGENT_ID].every(Boolean)) {
  throw new Error("Set OCC_URL, OCC_SERVICE_KEY_FILE, NAMESPACE_ID, and AGENT_ID.");
}
const { data: { key } } = JSON.parse(await readFile(OCC_SERVICE_KEY_FILE, "utf8"));
const response = await fetch(new URL(
  `/namespaces/${encodeURIComponent(NAMESPACE_ID)}/agents/${encodeURIComponent(AGENT_ID)}/runtime-credentials`,
  OCC_URL,
), {
  method: "POST",
  redirect: "error",
  headers: { "x-api-key": key, "content-type": "application/json" },
  body: "{}",
});
if (!response.ok) throw new Error(`Credential provisioning failed: HTTP ${response.status}`);
const { data } = await response.json();
if (data.transportConfigured !== true) throw new Error("Transport credentials are not configured.");
console.log("Agent transport credentials are configured.");
NODE
```

If the request fails after creating a Secret, inspect the Agent's credential
status before retrying; the API reuses complete, owned credential groups.
See [initial runtime credentials](../../reference/console/create-and-deploy.md#initial-runtime-credentials)
for permissions and conflicts. Dedicated Agents keep the canonical transport
token and Gateway password in separate CP Secrets. Compute projects only the
app-server token to the Harness. Embedded Agents use their tenant-local bundle.

Kubernetes gateways use trusted-proxy authentication. For direct operator
loopback checks, explicitly select the generated Gateway password and native HTTP
endpoint as described in [Model response verification](../operate/model-verification.md).
Model authentication comes from the saved `harnessAuth` binding and is projected
only into the model-executing workload. Slack tokens use separate Namespace
Secrets; follow [Slack setup](../integrations/slack.md). Keep credential values
out of Helm values, Installation YAML, Configurations, shell history, and this
repository.

Deploy the Agent and capture the immutable revision ID:

```bash
REVISION_RESPONSE="$(occ agent deploy "$AGENT_ID" --output json)" &&
REVISION_ID="$(printf '%s' "$REVISION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')" &&
export REVISION_ID &&
printf '%s' "$REVISION_RESPONSE" | python3 -c 'import json,os,sys; data=json.load(sys.stdin); expected={"id":os.environ["REVISION_ID"],"agentId":os.environ["AGENT_ID"],"configurationId":os.environ["CONFIGURATION_ID"]}; sys.exit("Revision does not match this Agent and Configuration." if any(data.get(k)!=v for k,v in expected.items()) else 0)'
```

`occ` exits unsuccessfully when deployment is rejected and returns the created
AgentRevision for structured output. If `configuration.json` includes OCC
`secretBindings`, the caller and Agent service principal must have `operate` on
every selected Secret before deploy. Binding changes are authorized by OCC IAM;
Kubernetes RoleBindings only allow the API to materialize backing tenant
Secrets. Wait for this revision's [deployment status](../../reference/agents.md#deployment-status)
to become `succeeded` before the checks below; admission and an active revision
alone do not prove workspace connectivity.

## Verify workspace access

After deployment, complete [Verify routing and file access](workspace-routing.md#verify-routing-and-file-access):
require the Gateway and Agent HTTPRoute to be accepted, TLS certificates ready,
and a successful read through the OCC workspace-file API. In the Console, open
the Agent and select **Reload AGENTS.md**. An existing file should load without
**Workspace access is unavailable**. The caller needs exact-Agent `read`
permission; saving also requires `operate`.

An empty editor after an error is not evidence of an empty workspace. A missing
file is a separate result: the file API can create or replace a file, but cannot
delete it. Verify access before creating a missing file. See [workspace-file errors](../../reference/agents.md#workspace-files).
Do not treat this setup as complete merely because a revision is active or
credentials are stored. Keep model verification as a separate check below.

## Open Control UI

Complete [native admin setup](native-admin.md#steps) for the Installation, then
[configure this Agent's origin](native-admin.md#configure-each-agent) using an
OCE browser session with exact Agent `administer` permission. The first active
revision makes its stable origin discoverable; copy that origin into
`gateway.controlUi.allowedOrigins`, save the Configuration, and deploy a new
revision. Do not use a wildcard, the Console origin, or host-header fallback.

On the Agent detail page, select **Refresh access** in **Native admin UI**.
Expect **available**, open **Open native admin UI**, and verify the native
Control UI loads on the returned Agent HTTPS host. Model verification below is
separate from this browser-access check.

## Verify production workloads

Wait for `GET /namespaces/$NAMESPACE_ID/agents/$AGENT_ID` to report the
expected `activeRevisionId`, then require a real model response from that
Agent. Use its optional loopback password to [attach with the OpenClaw
TUI](#attach-with-the-openclaw-tui), or [verify rejection of an unauthenticated
request and a real model response](../operate/model-verification.md) over an
operator's local Kubernetes connection.

A Helm release, ready controller, or active revision does not show that the
Agent can reach its model.

## Attach with the OpenClaw TUI

Use the requested `REVISION_ID`. This Bash function waits up to five minutes
for OCC to select it and for exactly one Ready gateway Pod to mount its
immutable ConfigMap. A previous revision cannot satisfy both checks:

```bash
# Embedded stays in the tenant target; dedicated uses the prepared Gateway target.
GATEWAY_NAMESPACE="$TENANT_NAMESPACE"
if [ "${AGENT_EXECUTION_MODE:?}" = dedicated ]; then
  GATEWAY_NAMESPACE="${GATEWAY_RUNTIME_NAMESPACE:?}"
fi
export GATEWAY_NAMESPACE
find_gateway_for_revision() {
  local agent agent_suffix revision_suffix expected_configmap pods pod status attempt
  if [ "${OCC_NAMESPACE:?}" != "${NAMESPACE_ID:?}" ]; then
    printf '%s\n' 'OCC_NAMESPACE must match NAMESPACE_ID.' >&2
    return 1
  fi
  agent_suffix="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "${AGENT_ID:?}")" || return 1
  revision_suffix="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "${REVISION_ID:?}")" || return 1
  expected_configmap="gateway-$agent_suffix-rev-$revision_suffix"
  for ((attempt = 1; attempt <= 60; attempt++)); do
    agent="$(occ agent get "$AGENT_ID" --output json)" || return 1
    if printf '%s' "$agent" | python3 -c '
import json, sys
agent = json.load(sys.stdin)
if agent.get("activeRevisionId") != sys.argv[1]:
    sys.exit(3)
' "$REVISION_ID"; then
      pods="$(kubectl --kubeconfig "${KUBECONFIG_FILE:?}" --context "${CONTEXT:?}" \
        -n "${GATEWAY_NAMESPACE:?}" get pods \
        -l "app.kubernetes.io/managed-by=openclaw-enterprise,openclaw.dev/workload-role=gateway,openclaw.dev/namespace=$NAMESPACE_ID,openclaw.dev/agent=$AGENT_ID,openclaw.dev/revision=$REVISION_ID" \
        -o json)" || return 1
      if pod="$(printf '%s' "$pods" | python3 -c '
import json, sys
expected = sys.argv[1]
ready = [
    pod for pod in json.load(sys.stdin)["items"]
    if not pod["metadata"].get("deletionTimestamp")
    and pod.get("status", {}).get("phase") == "Running"
    and any(c.get("type") == "Ready" and c.get("status") == "True"
            for c in pod.get("status", {}).get("conditions", []))
    and any(v.get("configMap", {}).get("name") == expected
            for v in pod["spec"].get("volumes", []))
]
if len(ready) > 1:
    sys.exit("Multiple Ready Pods match the requested revision; refusing to choose.")
if not ready:
    sys.exit(3)
print(ready[0]["metadata"]["name"])
' "$expected_configmap")"; then
        printf '%s\n' "$pod"
        return 0
      else
        status=$?
        if [ "$status" -ne 3 ]; then return "$status"; fi
      fi
    else
      status=$?
      if [ "$status" -ne 3 ]; then return "$status"; fi
    fi
    if [ "$attempt" -lt 60 ]; then sleep 5; fi
  done
  printf '%s\n' 'No unique Ready gateway Pod for the requested active revision.' >&2
  return 1
}
```

Attach only after the lookup succeeds. If it times out, check [deployment
status](../../reference/agents.md#deployment-status) and retry; do not use a
previous Pod or the Agent-wide Service.

```bash
if GATEWAY_POD="$(find_gateway_for_revision)"; then
  TUI_SESSION="production-tui-$(date +%Y%m%d%H%M%S)" &&
  NONCE="$(python3 -c 'import secrets; print("OPENCLAW_TUI_" + secrets.token_hex(8))')" &&
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$GATEWAY_NAMESPACE" \
    exec -it "$GATEWAY_POD" -c gateway -- env -u OPENAI_API_KEY \
    OPENCLAW_STATE_DIR=/tmp/occ-tui-client node /app/openclaw.mjs tui \
    --session "$TUI_SESSION" --message "Reply exactly: $NONCE"
else
  false
fi
```

Confirm the model replies with the exact nonce. The TUI uses the Pod-local
WebSocket listener and configured gateway password. The extra client process unsets
`OPENAI_API_KEY`; model access stays in the serving gateway path. Ctrl+D exits
only the client.

This Pod-local TUI procedure requires the optional password SecretRef shown
above. Trusted-proxy authentication remains active for routed requests. Use the
[HTTP password check](../operate/model-verification.md) for a noninteractive
model response, and the OCC file API for workspace-file administration.

## End the operator session

After model verification, remove only temporary delivery copies created by
these guides. The command leaves a caller-supplied `OCC_SERVICE_KEY_FILE` and
the protected original `OCC_BOOTSTRAP_KEY_FILE` untouched:

```bash
case "${OCC_SERVICE_KEY_DIRECTORY:-}" in
  /tmp/occ-service-key.[[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]])
    if [ -n "${OCC_BOOTSTRAP_KEY_FILE:-}" ] &&
       [ "${OCC_SERVICE_KEY_FILE:-}" = "$OCC_SERVICE_KEY_DIRECTORY/occ-service-key.json" ] &&
       [ "$OCC_SERVICE_KEY_FILE" != "$OCC_BOOTSTRAP_KEY_FILE" ] &&
       [ -d "$OCC_SERVICE_KEY_DIRECTORY" ] && [ ! -L "$OCC_SERVICE_KEY_DIRECTORY" ]; then
      rm -f -- "$OCC_SERVICE_KEY_FILE" && rmdir -- "$OCC_SERVICE_KEY_DIRECTORY"
    else
      printf '%s\n' 'Service-key path was not the documented temporary copy; nothing was deleted.' >&2
    fi ;;
  '') ;;
  *) printf '%s\n' 'Service-key directory was not created by this guide; nothing was deleted.' >&2 ;;
esac
unset OCC_SERVICE_KEY_FILE OCC_SERVICE_KEY_DIRECTORY

case "${SECRET_DIRECTORY:-}" in
  /tmp/occ-agent-transport.[[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]])
    if [ -d "$SECRET_DIRECTORY" ] && [ ! -L "$SECRET_DIRECTORY" ]; then
      rm -f -- "$SECRET_DIRECTORY/app-server-token" "$SECRET_DIRECTORY/gateway-password" &&
      rmdir -- "$SECRET_DIRECTORY"
    fi ;;
  '') ;;
  *) printf '%s\n' 'Transport directory was not created by this guide; nothing was deleted.' >&2 ;;
esac
unset SECRET_DIRECTORY
```

This does not revoke the service key or delete the Kubernetes Secrets. Keep
the original in protected bootstrap storage; bootstrap will not reissue it.

## Related

- [Private routing for workspace files](workspace-routing.md).
- [Troubleshoot the platform](../operate/troubleshooting.md).
- [Stop or remove a production deployment](../deploy.md#stop-or-remove-a-production-deployment).
- [Production TUI flow](../../flows/production-tui.md).
