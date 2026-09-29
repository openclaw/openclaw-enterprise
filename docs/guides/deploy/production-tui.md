# Verify an Agent with the OpenClaw TUI

Attach to the requested active revision and ask its model to echo a fresh nonce.
Use this interactive check after [deploying a production Agent](production-agents.md).
For a noninteractive check, use [HTTP model verification](../operate/model-verification.md).

## Before you start

Use Bash, Python 3, the OCC CLI, and kubectl in the same operator shell used for
deployment. Retain `OCC_URL`, `OCC_SERVICE_KEY_FILE`, `OCC_NAMESPACE`,
`NAMESPACE_ID`, `AGENT_ID`, `REVISION_ID`, `AGENT_EXECUTION_MODE`,
`TENANT_NAMESPACE`, `GATEWAY_RUNTIME_NAMESPACE`, `KUBECONFIG_FILE`, and `CONTEXT`.
You need OCC Agent read access and Kubernetes permission to list Pods and exec
into the selected gateway. The Agent needs a valid model credential and the
[optional gateway password](production-agents.md#configure-the-agent-runtime).

## Select and verify the requested revision

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

This Pod-local TUI procedure requires the optional password SecretRef in the
[Agent runtime configuration](production-agents.md#configure-the-agent-runtime).
Trusted-proxy authentication remains active for routed requests. Use the
[HTTP password check](../operate/model-verification.md) for a noninteractive
model response, and the OCC file API for workspace-file administration.

## Finish the session

Exit the TUI with Ctrl+D, then [remove temporary credential copies](production-agents.md#end-the-operator-session)
when you finish the operator session. The Agent keeps running.
