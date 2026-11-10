# Create and deploy an Agent over HTTP

Create an Agent with a dedicated Codex Harness, give its ServicePrincipal access
to a model Secret, and request deployment. Use the [API explorer](../reference/api-explorer.md)
to inspect complete request and response examples for each operation.

## Before you start

Use an existing Installation with Kubernetes Compute and the dedicated Codex
Harness configured. Choose a model your credential can use. You need Bash,
`curl`, `jq`, and an Installation-scoped service API key with permission to
create Namespaces and the resources below. The Agent's ServicePrincipal needs
its own Secret grant; your permission does not transfer to it.

Download the OpenAPI JSON from the API explorer into `occ-api.openapi.json`.
The example model, Driver IDs, and resource IDs are illustrative. Use your
Installation's configured values. See [production Agent setup](deploy/production-agents.md)
for infrastructure prerequisites and supported Harness authentication.

These commands create resources and can start billable model workloads.
Run them in a development Installation. Keep shell tracing disabled.

Save the Bash blocks from **Connect and prepare the files** through **Deploy and
inspect the result**, in order, as `create-agent.sh`. Replace the connection
placeholders, then run `bash create-agent.sh` from the directory containing the
downloaded OpenAPI JSON. Do not source the file or paste these blocks into your
interactive shell. A failed command stops the script without closing your shell.

The script pauses before submitting the Configuration so you can inspect and
edit it. It preserves response files in a private directory for cleanup after
success or failure. Fix a failure and clean up existing resources before
rerunning: creation requests are not automatically resumed.

## Connect and prepare the files

Store the full service-key issuance response in an owner-readable file.
Set your OCC origin and key path, then create a private working directory:

```bash
set -euo pipefail
export OCC_URL='http://127.0.0.1:3000'
export OCC_SERVICE_KEY_FILE='/private/path/occ-service-key.json'
umask 077
work="$(mktemp -d "$PWD/occ-api-example.XXXXXX")"
printf 'Results for cleanup: %s\n' "$work"
trap 'rm -f "$work/secret.json"' EXIT

occ_request() {
  local method="$1" path="$2" input="${3:-}" key status
  local -a args=(--silent --show-error --request "$method")
  key="$(jq -er '.data.key | select(type == "string" and length > 0)' \
    "$OCC_SERVICE_KEY_FILE")" || return
  if [[ "$key" == *$'\r'* || "$key" == *$'\n'* ]]; then
    printf 'Invalid service key.\n' >&2
    return 1
  fi
  if [[ -n "$input" ]]; then
    args+=(--header 'Content-Type: application/json' --data-binary "@$input")
  fi
  status="$(printf 'x-api-key: %s\n' "$key" |
    curl "${args[@]}" --header @- --output "$work/response.json" \
      --write-out '%{http_code}' "$OCC_URL$path")" || return
  if [[ "$status" != 2?? ]]; then
    printf 'OCC returned HTTP %s.\n' "$status" >&2
    jq '{error, meta}' "$work/response.json" >&2
    return 1
  fi
  if [[ "$status" != 204 ]]; then cat "$work/response.json"; fi
}
```

This helper keeps the key out of command arguments and refuses redirects.
For a private CA, set `CURL_CA_BUNDLE`; do not disable certificate verification.

## Create a Namespace and wait for readiness

```bash
printf '%s\n' '{"name":"api-example"}' > "$work/namespace.json"
occ_request POST /namespaces "$work/namespace.json" > "$work/namespace-result.json"
namespace_id="$(jq -er '.data.id' "$work/namespace-result.json")"

ready=false
for attempt in {1..30}; do
  occ_request GET "/namespaces/$namespace_id" > "$work/namespace-result.json" || break
  status="$(jq -r '.data.status' "$work/namespace-result.json")"
  if [[ "$status" == ready ]]; then ready=true; break; fi
  if [[ "$status" == failed || "$status" == deleting ]]; then break; fi
  sleep 2
done
[[ "$ready" == true ]] || { printf 'Namespace is not ready.\n' >&2; exit 1; }
```

Creation returns `201` while the Namespace is `provisioning`. Continue only
after its read response reports `ready`.

## Create a model Secret and Configuration

Read an authorized model key without echoing it. The example response contains
only Secret metadata; a Secret read never returns the value.

```bash
read -rsp 'Model API key: ' model_key
printf '\n'
printf '%s' "$model_key" |
  jq -Rs '{name:"model-api-key",value:.}' > "$work/secret.json"
unset model_key
occ_request POST "/namespaces/$namespace_id/secrets" "$work/secret.json" \
  > "$work/secret-result.json"
rm "$work/secret.json"
secret_id="$(jq -er '.data.id' "$work/secret-result.json")"

jq '.paths["/namespaces/{namespaceId}/configurations"].post.requestBody
    .content["application/json"].examples.example.value' \
  occ-api.openapi.json > "$work/configuration.json"
printf 'Inspect and edit: %s\n' "$work/configuration.json"
read -r -p 'Press Enter after choosing a supported model: '
```

Inspect `configuration.json` and replace its model with a supported selection in
both `agents.defaults` and `models.providers.codex`. Keep the dedicated
Codex transport settings. The loopback port-9 provider URL fails closed;
the Harness uses authenticated WebSocket transport for model execution.

```bash
occ_request POST "/namespaces/$namespace_id/configurations" "$work/configuration.json" \
  > "$work/configuration-result.json"
configuration_id="$(jq -er '.data.id' "$work/configuration-result.json")"

jq -n --arg configuration "$configuration_id" --arg ns "$namespace_id" \
  --arg secret "$secret_id" '{
    name:"Documentation assistant", configurationId:$configuration,
    executionMode:"dedicated",
    harnessAuth:{method:"api_key",source:{kind:"secret",namespaceId:$ns,id:$secret}}
  }' > "$work/agent.json"
occ_request POST "/namespaces/$namespace_id/agents" "$work/agent.json" \
  > "$work/agent-result.json"
agent_id="$(jq -er '.data.id' "$work/agent-result.json")"
principal_id="$(jq -er '.data.servicePrincipalId' "$work/agent-result.json")"
```

Both creates return `201`. Agent creation does not prove that its workload is running.

## Grant the Agent access to its Secret

```bash
printf '%s\n' '{"name":"Model Secret access","permissions":[{"action":"operate","resourceKind":"secret"}]}' \
  > "$work/role.json"
occ_request POST "/namespaces/$namespace_id/iam/roles" "$work/role.json" \
  > "$work/role-result.json"
role_id="$(jq -er '.data.id' "$work/role-result.json")"

jq -n --arg principal "$principal_id" --arg role "$role_id" --arg secret "$secret_id" \
  '{subjectKind:"identity",subjectId:$principal,roleId:$role,
    resourceKind:"secret",resourceId:$secret}' > "$work/binding.json"
occ_request POST "/namespaces/$namespace_id/iam/access-bindings" "$work/binding.json" \
  > "$work/binding-result.json"
```

The binding grants `operate` on this exact Secret. It does not grant access to
other Secrets in the Namespace. See [authorization](../reference/authorization.md).

## Deploy and inspect the result

```bash
occ_request POST "/namespaces/$namespace_id/agents/$agent_id/deploy" \
  > "$work/deployment-result.json"
revision_id="$(jq -er '.data.id' "$work/deployment-result.json")"
deployment="/namespaces/$namespace_id/agents/$agent_id/deployments/$revision_id"

succeeded=false
for attempt in {1..90}; do
  occ_request GET "$deployment" > "$work/deployment-status.json" || break
  status="$(jq -r '.data.status' "$work/deployment-status.json")"
  if [[ "$status" == succeeded ]]; then succeeded=true; break; fi
  if [[ "$status" == failed ]]; then break; fi
  sleep 2
done
[[ "$succeeded" == true ]] || {
  jq '.data | {status,error,progress}' "$work/deployment-status.json" >&2
  exit 1
}
occ_request GET "$deployment/runtime"
```

Deployment returns `202` with an Agent revision. Its `id` is the deployment
identifier used above. Polling `succeeded` proves reconciliation completed,
not that a model answered. Follow [model verification](operate/model-verification.md)
for that separate check.

For failures, read the returned error and request ID. `403` requires correcting
the caller's or Agent's exact grants; `409` requires resolving the conflicting
resource state. Do not blindly retry creation or deployment requests.

## Remove the example resources

Use the response files in the printed results directory to recover resource IDs.
For example, set `work` to that directory and read the Agent ID with
`jq -r '.data.id' "$work/agent-result.json"`. The Namespace, Configuration, Secret,
role, and access binding have their own `*-result.json` files.

Keep those files until cleanup finishes. Stop and delete the Agent, then wait
until its exact read returns `404` before deleting its Configuration and Secret.
A deletion accepted with `202` is still asynchronous.

Use the explorer's delete operations to remove the access binding and role,
then the empty Namespace. If Secret deletion reports a conflict, inspect its
`consumers`; do not delete resources belonging to other users.

Delete the saved results directory only after the resources are gone. The script
removes the temporary model-key request file on exit and keeps the other files.
