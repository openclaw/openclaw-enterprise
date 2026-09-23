# Verify a production Agent's model response

Verify that a trusted-proxy Kubernetes gateway rejects an unauthenticated
request and returns a real model response. The private OCC workspace proxy
serves workspace administration; this check uses a separate gateway password
over a Kubernetes port-forward bound to your machine's loopback address. For
an interactive check with the same loopback password, use the
[OpenClaw TUI](../deploy/production-agents.md#attach-with-the-openclaw-tui).

## Prepare the Agent

You need a working model credential, the Agent's local gateway password, Bash,
Python 3, and `kubectl` permission to get and list Pods and create
`pods/portforward` requests in the tenant namespace. If you retrieve the generated
password from Kubernetes, you also need read access to that exact Secret. Keep `AGENT_ID`, `NAMESPACE_ID`, `TENANT_NAMESPACE`,
`KUBECONFIG_FILE`, and `CONTEXT` from the [production Agent guide](../deploy/production-agents.md).
Set `REVISION_ID` to the immutable revision you want to verify.

Configure the Agent to serve model requests and use the Kubernetes-managed local
password. Add these fields to the existing native gateway Configuration without
removing the [trusted-proxy settings](../deploy/workspace-routing.md#configure-native-gateway-authentication)
or the Agent's model and Harness settings:

```yaml
gateway:
  auth:
    password:
      source: env
      provider: default
      id: OPENCLAW_GATEWAY_PASSWORD
  http:
    endpoints:
      chatCompletions:
        enabled: true
```

The [transport Secret](../../reference/drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials)
must have a `gateway-password` key. The initial credential API generates one;
external operators can provision one during [Agent deployment](../deploy/production-agents.md#configure-the-agent-runtime).
If these Configuration fields changed, [deploy a new revision](../deploy/production-agents.md#configure-the-agent-runtime)
and capture its new `REVISION_ID`. Wait for OCC to report that exact ID as active.
The password is separate from the model provider's credential.

## Open a local connection

An active revision can still be replacing the previous gateway. In the first
operator shell, run the entire block below. It waits for exactly one Running,
Ready, nonterminating Pod for the requested revision and confirms that it mounts
that revision's immutable ConfigMap. It polls every five seconds for up to 60
attempts. No match, multiple Ready matches, or a Kubernetes error stops the
check without opening a connection to another revision.

```bash
forward_requested_gateway() {
  local expected_configmap pods_json pod selection_code attempt
  if [ -z "${AGENT_ID:-}" ] || [ -z "${REVISION_ID:-}" ] || [ -z "${NAMESPACE_ID:-}" ] ||
     [ -z "${TENANT_NAMESPACE:-}" ] || [ -z "${KUBECONFIG_FILE:-}" ] || [ -z "${CONTEXT:-}" ]; then
    printf '%s\n' 'Set the Agent, revision, OCC and Kubernetes namespaces, kubeconfig, and context first.' >&2
    return 1
  fi
  if ! expected_configmap="$(python3 -c '
import hashlib, sys
def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()[:12]
print(f"gateway-{digest(sys.argv[1])}-rev-{digest(sys.argv[2])}")
' "$AGENT_ID" "$REVISION_ID")"; then
    return 1
  fi
  for ((attempt = 1; attempt <= 60; attempt++)); do
    if ! pods_json="$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
      -n "$TENANT_NAMESPACE" get pods \
      -l "app.kubernetes.io/managed-by=openclaw-enterprise,openclaw.dev/workload-role=gateway,openclaw.dev/namespace=$NAMESPACE_ID,openclaw.dev/agent=$AGENT_ID,openclaw.dev/revision=$REVISION_ID" \
      -o json)"; then
      return 1
    fi
    if pod="$(printf '%s' "$pods_json" | python3 -c '
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
    print(f"Found {len(ready)} Ready Pods for the requested revision; refusing to choose.", file=sys.stderr)
    sys.exit(1)
if not ready:
    sys.exit(3)
print(ready[0]["metadata"]["name"])
' "$expected_configmap")"; then
      printf 'Forwarding to revision %s on Pod %s.\n' "$REVISION_ID" "$pod" >&2
      kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$TENANT_NAMESPACE" \
        port-forward --address 127.0.0.1 "pod/$pod" 18789:http
      return $?
    else
      selection_code=$?
      if [ "$selection_code" -ne 3 ]; then
        return "$selection_code"
      fi
    fi
    if [ "$attempt" -lt 60 ]; then sleep 5; fi
  done
  printf 'No Ready gateway Pod for revision %s; stop and inspect the rollout.\n' "$REVISION_ID" >&2
  return 1
}
forward_requested_gateway
```

Leave the command running after `Forwarding from 127.0.0.1:18789` appears.
If it reports no matching Pod, inspect the requested revision and tenant Pods
before rerunning the block; do not forward to the Agent-wide Service. If the
local port is occupied, change `18789` in both the forward and the verification
example. In another operator shell with the same environment, set
`GATEWAY_PASSWORD_FILE` to a protected file containing the password. If the
credential API created it, you can retrieve it without printing the value:

```bash
umask 077
fetch_gateway_password() {
  local working_directory agent_suffix transport_secret secret_json
  unset GATEWAY_PASSWORD_FILE GATEWAY_PASSWORD_DIRECTORY
  if [ -z "${AGENT_ID:-}" ] || [ -z "${KUBECONFIG_FILE:-}" ] ||
     [ -z "${CONTEXT:-}" ] || [ -z "${TENANT_NAMESPACE:-}" ]; then
    printf '%s\n' 'Set the Agent, kubeconfig, context, and Kubernetes namespace first.' >&2
    return 1
  fi
  if ! working_directory="$(mktemp -d /tmp/occ-gateway-password.XXXXXXXX)"; then
    printf '%s\n' 'Could not create the temporary password directory; stop here.' >&2
    return 1
  fi
  if ! agent_suffix="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$AGENT_ID")"; then
    rmdir -- "$working_directory"
    return 1
  fi
  transport_secret="openclaw-agent-transport-$agent_suffix"
  if ! secret_json="$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$TENANT_NAMESPACE" \
    get secret "$transport_secret" -o json)"; then
    rmdir -- "$working_directory"
    return 1
  fi
  if ! python3 -c '
import base64, json, sys
from pathlib import Path
password = base64.b64decode(json.load(sys.stdin)["data"]["gateway-password"], validate=True)
if not password:
    raise SystemExit("The gateway password is empty.")
Path(sys.argv[1]).write_bytes(password)
' "$working_directory/gateway-password" <<< "$secret_json"; then
    rm -f -- "$working_directory/gateway-password"
    rmdir -- "$working_directory"
    printf '%s\n' 'Could not write the gateway password; stop here.' >&2
    return 1
  fi
  export GATEWAY_PASSWORD_DIRECTORY="$working_directory"
  export GATEWAY_PASSWORD_FILE="$working_directory/gateway-password"
}
fetch_gateway_password
```

Replace `openclaw-agent-transport-` if your Installation sets a different
`runtime.transportSecretPrefix`. Export `GATEWAY_PASSWORD_FILE` if you use your
own protected file.

## Verify rejection and a real response

Run from the second shell while the forward is active:

```bash
python3 - <<'PY'
import json, os, secrets, urllib.error, urllib.request
from pathlib import Path

url = 'http://127.0.0.1:18789/v1/chat/completions'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
password = Path(os.environ['GATEWAY_PASSWORD_FILE']).read_text().strip()
if not password:
    raise SystemExit('The gateway password file is empty.')

def request(payload, password=None):
    headers = {'Content-Type': 'application/json'}
    if password:
        headers['Authorization'] = f'Bearer {password}'
    req = urllib.request.Request(url, json.dumps(payload).encode(), headers=headers)
    return opener.open(req, timeout=180)

try:
    with request({'model': 'openclaw/default', 'messages': []}):
        raise SystemExit('The gateway unexpectedly allowed an unauthenticated request.')
except urllib.error.HTTPError as error:
    if error.code not in (401, 403):
        raise SystemExit(f'Expected 401 or 403 without credentials; received {error.code}.')

nonce = 'OPENCLAW_' + secrets.token_hex(12)
payload = {'model': 'openclaw/default', 'stream': False, 'messages': [
    {'role': 'user', 'content': f'Reply with exactly this nonce and no other text: {nonce}'}]}
with request(payload, password) as response:
    message = json.load(response)['choices'][0]['message']['content']
if nonce not in message:
    raise SystemExit('The response did not contain the requested nonce.')
print(f'Model response verified ({nonce}).')
PY
```

Expect `Model response verified (OPENCLAW_...).` If the denial check fails, stop
and review gateway authentication before exposing the endpoint. If the model
call fails, check that the selected revision is active, its model credential is
valid, and the gateway and Harness are available. Use [platform troubleshooting](troubleshooting.md)
when the control plane or several Agents are affected.

Stop the port-forward with Ctrl+C. This removes the temporary password copy
created above and leaves a password file you supplied yourself untouched:

```bash
case "${GATEWAY_PASSWORD_DIRECTORY:-}" in
  /tmp/occ-gateway-password.[[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]][[:alnum:]])
    if [ ! -L "$GATEWAY_PASSWORD_DIRECTORY" ] &&
       [ "${GATEWAY_PASSWORD_FILE:-}" = "$GATEWAY_PASSWORD_DIRECTORY/gateway-password" ]; then
      rm -- "$GATEWAY_PASSWORD_DIRECTORY/gateway-password" &&
        rmdir -- "$GATEWAY_PASSWORD_DIRECTORY"
    fi ;;
esac
```
