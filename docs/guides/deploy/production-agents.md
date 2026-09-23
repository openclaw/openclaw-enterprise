# Deploy and verify production Agents

Deploy an Agent into a ready Namespace and verify that its model answers. Complete
[control-plane installation](production-installation.md) and its authenticated
API check first. Run commands from the repository root in the same operator shell,
retaining its credentials and Kubernetes context. For an OpenAI API key, you or
an Installation administrator must also [grant the Agent access to the model
Secret](#grant-the-agent-access-to-its-model-secret) before deployment.

## Prepare each Namespace

### Use a driver-managed Kubernetes namespace

Fresh bootstrap creates a platform Namespace named `default`. Run
`occ namespace list` and export its server-assigned ID:

```bash
occ namespace list
export NAMESPACE_ID='<ID shown for default>'
```

The worker creates
the backing Kubernetes namespace and labels it with
`openclaw.dev/namespace=$NAMESPACE_ID`. This is separate from Kubernetes'
built-in `default` namespace. Once the worker has created it, discover and
export its name for the tenant RoleBindings:

```bash
TENANT_NAMESPACE="$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  get namespaces -l "openclaw.dev/namespace=$NAMESPACE_ID" -o json | \
  python3 -c 'import json,sys; items=json.load(sys.stdin)["items"]; print(items[0]["metadata"]["name"]) if len(items)==1 else sys.exit("Expected one backing Namespace; check worker provisioning")')" && export TENANT_NAMESPACE
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

The Secret RoleBinding grants tenant-local Secret access and list-only
Deployment access to the API. The API lists Deployments to check for existing
Agent workloads before provisioning initial runtime credentials. This binding
does not give the worker Secret API permission or replace OCC IAM grants for
bound Secrets.

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
containing the protected OpenAI key first, then set `HARNESS_SECRET_ID` to its
returned `data.id`. That example uses this shell's `OCC_URL` and protected
`OCC_SERVICE_KEY_FILE`. The caller needs exact Secret `operate` to bind it.
For the alternative ChatGPT method, select an already issued same-Namespace
account and matching Provider as described in [Agent harness authentication](../../reference/agents.md#harness-authentication).

```bash
: "${AGENT_EXECUTION_MODE:?choose embedded or dedicated above}"
: "${HARNESS_SECRET_ID:?set the OCC Secret ID containing the key}"
export HARNESS_SECRET_ID
printf '{"name":"production-agent","configurationId":"%s","executionMode":"%s","harnessAuth":{"method":"api_key","source":{"kind":"secret","namespaceId":"%s","id":"%s"}}}\n' \
  "$CONFIGURATION_ID" "$AGENT_EXECUTION_MODE" "$NAMESPACE_ID" "$HARNESS_SECRET_ID" > agent.json
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

For an Agent without any revisions, the console can generate initial transport
credentials through the exact-Agent API. It stores Slack tokens separately as
Namespace Secrets and binds them to the Agent; see [initial runtime
credentials](../../reference/console/create-and-deploy.md#initial-runtime-credentials)
and the [Slack setup guide](../integrations/slack.md). The operator commands
below can supply transport credentials externally. Do not use both paths to
replace an existing transport bundle.

Create the tenant transport Secret using the Agent ID suffix. Kubernetes
gateways use trusted-proxy authentication; dedicated Codex separately requires
`app-server-token`. Compute renders the gateway authentication from trusted
Installation settings. To verify model responses through an
operator's local Kubernetes connection, configure the `gateway-password` Secret
reference and enable the native HTTP endpoint as described in
[Model response verification](../operate/model-verification.md). The initial
credential API generates this password too; it never returns it in an API response.

```bash
umask 077
AGENT_SUFFIX="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "${AGENT_ID:?}")" &&
SECRET_DIRECTORY="$(mktemp -d /tmp/occ-agent-transport.XXXXXXXX)" &&
python3 -c 'import secrets,sys; sys.stdout.write(secrets.token_hex(32))' > "$SECRET_DIRECTORY/app-server-token" &&
python3 -c 'import secrets,sys; sys.stdout.write(secrets.token_hex(32))' > "$SECRET_DIRECTORY/gateway-password" &&
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create secret generic "openclaw-agent-transport-$AGENT_SUFFIX" \
  --from-file=app-server-token="$SECRET_DIRECTORY/app-server-token" \
  --from-file=gateway-password="$SECRET_DIRECTORY/gateway-password"
```

The gateway password enables the optional direct loopback checks below; the
app-server token authenticates dedicated Codex transport. Model authentication comes
from the saved `harnessAuth` binding.
Kubernetes projects its source only into the model-executing workload; initial
transport/channel provisioning does not accept model keys. Keep credential values
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
Secrets.

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
        -n "${TENANT_NAMESPACE:?}" get pods \
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
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$TENANT_NAMESPACE" \
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
