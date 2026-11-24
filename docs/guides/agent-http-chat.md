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

## Retry delayed HTTP chat audit records

If chat succeeds but an HTTP chat record is missing from the audit log,
check the OCC queue. A delivery retry never sends the chat request again.
For a missing Gateway turn record, use the separate
[Gateway recovery procedure](topics/audit-log.md#recover-delayed-runtime-events).

Each OCC API replica checks the queue at startup and every 15 seconds.
When OCC adds a record, it also starts delivery in the background.
After a failure, the record stays in the queue for another attempt.
After three consecutive failures, that replica pauses delivery for
15 seconds. No user action is required.

An authorized PostgreSQL operator can check the next 20 records with
`psql`. Use the Installation database.

```sql
SELECT id, action, retry_at
FROM occ.http_chat_audit_queue
ORDER BY retry_at, id
LIMIT 20;
```

Correct the cause of the failure. To make one record ready for the next
check, enter its ID at the prompt.

```sql
\prompt 'Queued event ID: ' event_id
UPDATE occ.http_chat_audit_queue
SET retry_at = clock_timestamp()
WHERE id = :'event_id'
RETURNING id;
```

If the update returns no row, OCC may have delivered the record already.
Check the same ID in the audit log.

```sql
SELECT id, action
FROM occ.audit_events
WHERE id = :'event_id';
```

This procedure changes only the retry time. Do not edit the event or
send the message again to recover a record.

## Disable HTTP chat

Set `gateway.http.endpoints.chatCompletions.enabled` to `false` in the Agent's
Configuration and deploy a new revision. Requests then return `503`. The setting
does not modify an already running revision. Docker and SSH Compute do not
support this operation and return `501`.
