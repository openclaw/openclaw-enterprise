# Deploy and verify production Agents

Deploy an Agent into a ready Namespace and verify model execution. Complete
[control-plane installation](production-installation.md) and its authenticated
API check. Run commands from the repository root, retaining credentials and
Kubernetes context. See [credential grants at deployment](../../reference/authorization/default-users.md#grant-an-agent-its-credentials-at-deployment).

Use Bash, Python 3, kubectl, and the OCC CLI for the commands below. For browser
deployment, prepare the Namespace and follow the
[console deployment workflow](../../reference/console/create-and-deploy.md).

## Prepare each Namespace

### Use a driver-managed Kubernetes namespace

Fresh bootstrap creates an OCC Namespace named `default`. Use it or create
another Namespace with `occ namespace create NAME`. Creation can return while
the worker is still provisioning. Run `occ namespace list` and export the
server-assigned ID of the Namespace you selected.

```bash
occ namespace list
export NAMESPACE_ID='<ID of the selected Namespace>'
```

If you lose the reply to `occ namespace create`, do not resend it. Use the same
connection options to run `occ namespace list` and `occ namespace get ID`.
The request may still commit, or permissions may hide the Namespace. If the
outcome is unclear, ask an Installation administrator to check the audit log.
Retry only after confirming the original request ended without creating a Namespace.

The worker creates a separate Kubernetes namespace labeled
`openclaw.dev/namespace=$NAMESPACE_ID`. As soon as that namespace exists, record
its name and grant the tenant RoleBindings below before waiting for the OCC
Namespace to report `ready`.

```bash
TENANT_NAMESPACE="$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  get namespaces -l "openclaw.dev/namespace=$NAMESPACE_ID" -o json | \
  python3 -c 'import json,sys; items=json.load(sys.stdin)["items"]; print(items[0]["metadata"]["name"]) if len(items)==1 else sys.exit("Expected one backing Namespace; check worker provisioning")')" && export TENANT_NAMESPACE
```

If discovery finds no backing namespace, check the worker logs and run
discovery again after the worker creates it.

### Grant tenant RoleBindings

Single-cluster Compute uses the same tenant namespace for runtime roles and
canonical storage. Use the Helm release and Kubernetes namespace from the
control-plane install. The chart prefixes the three tenant ClusterRoles with
the release name and creates fixed-name ServiceAccounts in the install namespace.

```bash
# Control-plane installation example
RELEASE=oce
CONTROL_PLANE_NAMESPACE=openclaw-system
# For a different install, use its values. Example:
# RELEASE=openclaw-enterprise
# CONTROL_PLANE_NAMESPACE=oce-system

tenant_kubectl() {
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$TENANT_NAMESPACE" "$@"
}
WORKER_SA="$CONTROL_PLANE_NAMESPACE:openclaw-enterprise-worker"
API_SA="$CONTROL_PLANE_NAMESPACE:openclaw-enterprise-api"
```

For OpenShell Sandbox, first create and bind the tenant-local workspace
provisioner Role. Use the Role and its RoleBinding from
[OpenShell Namespace preparation](eks-openshell-installation.md#3-authenticate-and-prepare-the-namespace)
with the worker ServiceAccount above.

Grant the API credential and configuration roles, then the worker runtime role.

```bash
tenant_kubectl create rolebinding openclaw-enterprise-api-secrets \
  --clusterrole="$RELEASE-openclaw-tenant-api" --serviceaccount="$API_SA"
tenant_kubectl create rolebinding openclaw-enterprise-api-configuration \
  --clusterrole="$RELEASE-openclaw-tenant-configuration" --serviceaccount="$API_SA"
tenant_kubectl create rolebinding openclaw-enterprise-worker \
  --clusterrole="$RELEASE-openclaw-tenant-worker" --serviceaccount="$WORKER_SA"
```

The Secret role also grants Deployment list access for credential preflight and
Pod read/proxy access for diagnostics. With `agentRuntimeLogs.enabled` (default),
it grants `pods/log get` and `events get,list` for [Agent logs](../topics/agent-logs.md).
Custom roles need the same rules; missing log grants return `503 RUNTIME_LOGS_CLUSTER_RBAC`.
Missing credential grants return `503 RUNTIME_CREDENTIALS_CLUSTER_RBAC`; API logs
`agent_runtime_credentials.cluster_denied` identify the denied call and namespace.
OCC IAM grants remain required. Workload ServiceAccounts receive no Secret API
access. Namespace workload managers are trusted for both roles. Use disjoint
trusted Gateway and Harness node pools. For the experimental two-cluster
profile, grant these storage roles in the separately discovered control target
and worker/observer roles in the execution target. See [two-cluster testing](../../testing/kubernetes.md#two-cluster-validation).

### Confirm the Namespace is ready

Run `occ namespace get "$NAMESPACE_ID"` after applying the bindings. Wait for
`STATUS` to report `ready` before creating Configurations or Agents.

If the status stays `provisioning`, check the worker's `namespace.ensure` logs.
The [`KUBERNETES_TENANT_ACCESS_DENIED` hint](../../reference/drivers/kubernetes-compute.md#failure-conditions)
indicates a Kubernetes permission denial. Verify the RoleBindings in the
backing namespace and their ServiceAccounts and roles. After correcting the
grants, check the same OCC Namespace ID again. If the status is `failed`,
inspect audit evidence and worker logs for
[exhausted lease recovery](../../reference/controller/reconciliation.md#deferred-namespace-and-agent-convergence).

## Prepare each Agent

Prepare Agent deployment after the Namespace is ready. The operator shell must
have `OCC_URL`, `OCC_SERVICE_KEY_FILE`, `OCC_NAMESPACE`, `NAMESPACE_ID`,
`TENANT_NAMESPACE`, `KUBECONFIG_FILE`, and `CONTEXT` set. `TENANT_NAMESPACE`
is the Kubernetes namespace created by the driver during
[Namespace preparation](#prepare-each-namespace).

## Configure the Agent runtime

Both examples enable Control UI. Their explicit loopback origins allow the first
version to start without trusting an arbitrary browser host. After deployment,
[finish Control UI access](#open-control-ui) by adding this Agent's exact HTTPS
origin. Loopback origins alone do not enable the OCE native admin link.

Complete [private routing](workspace-routing.md#configure-private-routing) first.
Configure verified Envoy source CIDRs in the trusted Installation YAML before
deploying either example. Kubernetes Compute renders native trusted-proxy
authentication for Console workspace access; the examples omit Driver-owned
settings. Follow the [native authentication requirements](workspace-routing.md#configure-native-gateway-authentication)
for proxy identity and NetworkPolicy isolation; do not trust arbitrary client
addresses.
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

If you customize `configuration.json` and plan to verify a local model reply,
check these settings before saving it. The [OpenClaw TUI](#attach-with-the-openclaw-tui) uses the
`values.gateway.auth.password` SecretRef shown in both examples. The
loopback HTTP check also needs
`values.gateway.http.endpoints.chatCompletions.enabled` set to boolean `true`.
Agents using neither check can omit these settings.

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
unset AGENT_ID
: "${AGENT_EXECUTION_MODE:?choose embedded or dedicated above}"
: "${HARNESS_SECRET_ID:?set the OCC Secret ID containing the credential}"
export HARNESS_SECRET_ID
export HARNESS_AUTH_METHOD='api_key' # Or codex_pat for Dedicated Codex.
printf '{"name":"production-agent","configurationId":"%s","executionMode":"%s","harnessAuth":{"method":"%s","source":{"kind":"secret","namespaceId":"%s","id":"%s"}}}\n' \
  "$CONFIGURATION_ID" "$AGENT_EXECUTION_MODE" "$HARNESS_AUTH_METHOD" "$NAMESPACE_ID" "$HARNESS_SECRET_ID" > agent.json &&
AGENT_RESPONSE="$(occ agent create --file agent.json --output json)" &&
AGENT_ID="$(printf '%s' "$AGENT_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')" &&
export AGENT_ID
```

### Check saved settings for local model verification

For a local check with a reused or customized Configuration, check the saved
settings before deployment or a manual grant. Otherwise, [deploy](#prepare-transport-credentials-and-deploy).
The caller needs `read` on the Agent and its Namespace Configuration. Set
`AGENT_ID` to the saved Agent's ID and pass `tui` or `http`.

```bash
OCC_NAMESPACE="${NAMESPACE_ID:?}" python3 - "${AGENT_ID:?}" tui <<'PYTHON'
import json, subprocess, sys

agent_id, route = sys.argv[1:]
if route not in ("tui", "http"):
    sys.exit("Choose tui or http.")

def read(kind, resource_id):
    return json.loads(subprocess.check_output(
        ["occ", kind, "get", resource_id, "--output", "json"],
        stderr=subprocess.DEVNULL,
    ))

try:
    configuration_id = read("agent", agent_id)["configurationId"]
    if not isinstance(configuration_id, str) or not configuration_id:
        sys.exit("The saved Agent has no readable Configuration ID.")
    configuration = read("configuration", configuration_id)
except (OSError, subprocess.CalledProcessError, KeyError, TypeError, ValueError):
    sys.exit("Could not read the saved settings. Check the CLI setup, IDs, and read access.")

try:
    gateway = configuration["values"]["gateway"]
    password = {"source": "env", "provider": "default", "id": "OPENCLAW_GATEWAY_PASSWORD"}
    if configuration["kind"] != "agent" or gateway["auth"]["password"] != password:
        sys.exit("Use the kind and gateway password SecretRef from the example.")
    if route == "http" and gateway["http"]["endpoints"]["chatCompletions"]["enabled"] is not True:
        sys.exit("Enable chat completions for the HTTP check.")
except (KeyError, TypeError):
    sys.exit("Add the missing settings for the chosen check.")
print("Saved Configuration matches the chosen check.")
PYTHON
```

After a match, [deploy](#prepare-transport-credentials-and-deploy) and
[verify a model reply](#verify-production-workloads).

### Grant the Agent access to its model Secret

With transactional native IAM, [deploy](#prepare-transport-credentials-and-deploy)
to grant access. A refused deployment writes no grant. If the IAM Driver manages
policy outside OCC, grant the Agent `operate` on the exact Secret before deployment. Check [policy-write support](../../reference/drivers/iam.md#namespace-policy-operations).

For a manual native IAM grant, you need Installation `administer` and `read`
on the Namespace, Agent, and exact Secret. The bootstrap service key has these grants unless a
Restriction denies access. Otherwise, give `NAMESPACE_ID`, `AGENT_ID`, and
`HARNESS_SECRET_ID` to an Installation administrator. Kubernetes RoleBindings
do not grant OCC access.

Find a Role with exactly this permission.

```bash
unset IAM_ROLE_ID
export OCC_NAMESPACE="${NAMESPACE_ID:?}" &&
occ iam role list --output json
```

On error, stop. Export a matching Role ID as `IAM_ROLE_ID`, or create one.

```bash
unset IAM_ROLE_ID
export OCC_NAMESPACE="${NAMESPACE_ID:?}" &&
cat > model-secret-role.json <<'JSON' &&
{"name":"Use a model Secret","permissions":[{"action":"operate","resourceKind":"secret"}]}
JSON
IAM_ROLE_RESPONSE="$(occ iam role create --file model-secret-role.json --output json)" &&
IAM_ROLE_ID="$(printf '%s' "$IAM_ROLE_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')" &&
export IAM_ROLE_ID
```

Put `occ` on `PATH`. Python cannot use Bash aliases or functions.

```bash
(
export OCC_NAMESPACE="${NAMESPACE_ID:?}" &&
python3 - "${AGENT_ID:?}" "${IAM_ROLE_ID:?}" "${HARNESS_SECRET_ID:?}" <<'PYTHON'
import json, os, subprocess, sys, tempfile

agent_id, role_id, secret_id = sys.argv[1:]
namespace = os.environ["OCC_NAMESPACE"]

def occ(*args):
    return json.loads(subprocess.check_output(["occ", *args, "--output", "json"]))

agent = occ("agent", "get", agent_id)
principal = agent["servicePrincipalId"]
if (agent["id"] != agent_id or agent["namespaceId"] != namespace
        or not isinstance(principal, str) or not principal.strip()):
    sys.exit("Check the Agent ID, Namespace and service principal.")
harness_auth = agent.get("harnessAuth")
secret = {"kind": "secret", "namespaceId": namespace, "id": secret_id}
if not isinstance(harness_auth, dict) or harness_auth.get("source") != secret:
    sys.exit("The Agent does not name this model Secret.")

role = occ("iam", "role", "get", role_id)
if (role["id"] != role_id or role["namespaceId"] != namespace
        or role["permissions"] != [{"action": "operate", "resourceKind": "secret"}]):
    sys.exit("Check the Role ID, Namespace and permissions.")

expected = {
    "subjectKind": "identity",
    "subjectId": principal,
    "roleId": role_id,
    "resourceKind": "secret",
    "resourceId": secret_id,
}
with tempfile.TemporaryDirectory() as directory:
    request_path = os.path.join(directory, "model-secret-binding.json")
    with open(request_path, "w") as request:
        json.dump(expected, request)
    binding_id = occ("iam", "access-binding", "create", "--file", request_path)["id"]
if not isinstance(binding_id, str) or not binding_id.strip():
    sys.exit("Missing binding ID.")
binding = occ("iam", "access-binding", "get", binding_id)
expected.update(id=binding_id, namespaceId=namespace)
if any(binding.get(key) != value for key, value in expected.items()):
    sys.exit("Binding does not match this Agent and Secret.")
print("Exact Agent Secret binding is stored")
PYTHON
)
```

Continue only after confirmation. Before retrying, check `occ iam role list` and
`occ iam access-binding list` for this Agent service principal, Role and Secret.
Duplicates can coexist; Restrictions still apply. See [Namespace IAM policy](../../reference/authorization.md#manage-namespace-policy).

### Prepare transport credentials and deploy

Use a separate operator shell with the production `OCC_URL`, Namespace,
resource IDs, and Kubernetes context. Set
`OCC_SERVICE_KEY_FILE` to the private [service API key response file](../../reference/authentication/service-api-keys.md#issue-a-service-key)
for a non-Agent service principal in this Namespace. An Installation
administrator who covers its grants can issue the key, which uses the
principal's current permissions. Leave the bootstrap copy in the Installation
shell for [cleanup](#end-the-operator-session).

Kubernetes Compute creates missing transport credentials during the first
deployment. The caller needs `read` and `operate` on this Agent for that step.
See [initial runtime credentials](../../reference/console/create-and-deploy.md#initial-runtime-credentials)
to provision credentials separately or investigate a conflict.

Model authentication comes from the saved `harnessAuth` binding and is projected
only into the model-executing workload. Slack tokens use separate Namespace
Secrets; follow [Slack setup](../integrations/slack.md). Keep credential values
out of Helm values, Installation YAML, Configurations, shell history, and this
repository.

To deploy, you need `deploy` on the exact Agent, `read` on its saved
Configuration, and `operate` on the model Secret and each Configuration
`secretBindings` Secret. The Agent's service principal needs `operate` on those
Secrets. See [Agent credential grants](../../reference/authorization/default-users.md#grant-an-agent-its-credentials-at-deployment).

For this new, stopped Agent, review the saved Configuration and note its
`generation`. Keep the caller identity, Namespace ID, Agent ID, Configuration ID,
generation, and nonsecret request key in your private operator record.

```bash
occ configuration get "$CONFIGURATION_ID" --output json
read -r -p 'Reviewed Configuration generation: ' CONFIGURATION_GENERATION
FIRST_DEPLOYMENT_KEY=production-agent-first
```

Submit the guarded first deployment once. OCC checks that the Agent has no
revision history and still uses the Configuration and generation you reviewed.

```bash
REVISION_RESPONSE="$(occ agent deploy-first "$AGENT_ID" --configuration "$CONFIGURATION_ID" \
  --generation "$CONFIGURATION_GENERATION" --key "$FIRST_DEPLOYMENT_KEY" --output json)" &&
REVISION_ID="$(printf '%s' "$REVISION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["revisionId"])')" &&
export REVISION_ID &&
occ agent deployment-status "$AGENT_ID" "$REVISION_ID"
```

If the reply is lost, [recover the original first-deployment receipt](../topics/agent-revisions.md#guarded-first-deployment-and-receipt-recovery)
with the same caller and recorded inputs. A missing receipt leaves the outcome
unknown. Do not submit another deployment.

Poll the receipt's `revisionId` until status is `succeeded` or
[`failed`](../../reference/agents.md#deployment-status). On failure, follow
`error.message`. If it requires a new deployment, use [Update and deploy](../topics/agent-revisions.md#update-and-deploy)
and set `REVISION_ID` to the `id` from `occ agent deploy` before checking status.
If denied, ask an Installation administrator for `read` on that
`agent_revision`. After success, verify workspace access and a model reply.

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
Next, verify a model response from the same version.

## Verify production workloads

Wait for `GET /namespaces/$NAMESPACE_ID/agents/$AGENT_ID` to report the
expected `activeRevisionId`, then require a real model response from that
Agent. Use its optional loopback password to [attach with the OpenClaw
TUI](#attach-with-the-openclaw-tui), or [verify rejection of an unauthenticated
request and a real model response](../operate/model-verification.md) over an
operator's local Kubernetes connection.

If model access fails, check the Pod's
[network profile](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#explicit-network-profiles):
model egress requires an explicit grant. See [what each check establishes](../operate/model-verification.md#what-each-check-establishes).

Then [check Agent network isolation](../operate/network-isolation.md) by probing
from inside the workload Pods.

## Attach with the OpenClaw TUI

Follow [TUI verification](production-tui.md) to select exactly one Ready gateway
Pod for `REVISION_ID`, send a fresh nonce, and verify its reply. Keep the same
operator environment and return here to clean up temporary credentials.

## End the operator session

For HTTP verification, stop the port-forward in its shell with Ctrl+C. Clean up
any fetched [password copy](../operate/model-verification.md#verify-rejection-and-a-real-response)
in the shell that fetched it, even after an early stop. Keep supplied files.

In the **deployment operator shell**, unset `OCC_SERVICE_KEY_FILE`.

```bash
unset OCC_SERVICE_KEY_FILE
```

In the **original Installation shell**, remove the temporary bootstrap copy below.
Keep its path variables set and preserve the original key.

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
```

This does not revoke the service key or delete the Kubernetes Secrets. Keep
the original in protected bootstrap storage; bootstrap will not reissue it.

## Open Control UI

After model verification, optionally [enable native admin access](native-admin.md)
and [configure this Agent's exact origin](native-admin.md#configure-each-agent).
You need a browser session with exact-Agent `administer` permission. Add the
returned origin to `gateway.controlUi.allowedOrigins`, [deploy again](../topics/agent-revisions.md#update-and-deploy),
and verify **Native admin UI** loads.

## Related

- [Private routing for workspace files](workspace-routing.md).
- [Troubleshoot the platform](../operate/troubleshooting.md).
- [Stop or remove a production deployment](../deploy.md#stop-or-remove-a-production-deployment).
- [Production TUI flow](../../flows/production-tui.md).
