# Submit work to an Agent over HTTP

Use a deployed Kubernetes Compute Agent and a human session or service API key
with exact-Agent `operate`. Obtain the OCE Agent ID from its API response.
[Create and deploy an Agent](http-api-agent.md) if needed. Browser chat does not
need to be enabled. Configure an external API proxy to accept 20 MiB bodies,
allow at least 660 seconds per request, and relay SSE without response buffering.
Set its idle timeout to at least 660 seconds too: a response carries no bytes
while tools run.

## Send a turn

Store the service-key issuance response in a private file. With shell tracing
disabled, run this Bash example after replacing the origin, key path and Agent ID:

```bash
set -euo pipefail
umask 077
OCC_URL='http://127.0.0.1:3000'
OCC_SERVICE_KEY_FILE='/private/path/occ-service-key.json'
AGENT_ID='agt_00000000-0000-4000-8000-000000000001'
key="$(jq -er '.data.key' "$OCC_SERVICE_KEY_FILE")"
[[ "$key" != *$'\r'* && "$key" != *$'\n'* ]]
printf 'x-api-key: %s\n' "$key" |
  curl --fail-with-body --silent --show-error --no-buffer \
    --header @- --header 'Content-Type: application/json' \
    --data '{"messages":[{"role":"user","content":"Reply with a short greeting."}],"stream":true}' \
    "$OCC_URL/agents/$AGENT_ID/chat"
unset key
```

The response contains SSE events and ends with `data: [DONE]` on success. Omit
`stream` to receive native completion JSON. The response has no OCC `data`
envelope. For a private CA, set `CURL_CA_BUNDLE`; keep certificate verification
enabled. Human clients send their session cookie and trusted console Origin.

## Continue a conversation

Add the same `user` label to each new request, for example
`"user":"incident-42"`. Send only new messages. The label selects history only
for that principal and Agent; rotating its service key preserves that selection.
Omit the label for independent turns.

A turn can execute tools. Disconnects, revoked access and timeouts do not undo
those effects. Check the Agent's state before retrying; the label is not an
idempotency key.

A request ends at its 10-minute deadline, and the turn behind it stops. For
longer work, tell the Agent to record its progress in the workspace, then send
a new request with the same label and a message such as `Continue the task.`
See the [HTTP chat contract](../reference/agent-http-chat.md) for limits, status
codes, conversation boundaries and audit behavior.

## Disable HTTP chat

Set `gateway.http.endpoints.chatCompletions.enabled` to `false` in the Agent's
Configuration and deploy a new revision. Requests then return `503`. The setting
does not modify an already running revision. Docker and SSH Compute do not
support this operation and return `501`.
