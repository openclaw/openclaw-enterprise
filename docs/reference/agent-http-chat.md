# Agent HTTP chat

`POST /agents/:agentId/chat` submits a turn to the Agent's OpenClaw HTTP Chat
Completions endpoint. The turn can execute tools through the selected Harness.
Human sessions and service API keys need exact-Agent `operate`; session requests
also require the normal CSRF checks. Namespace ownership comes from stored Agent
state. The operation does not require browser chat or a browser launch.

## Request and response

Send `application/json` with a `messages` array. `stream: true` selects SSE;
otherwise the response is native Chat Completions JSON. Supported native
completion parameters, including nested values, pass through unchanged. The
runtime validates their semantics. OCC does not add its usual success envelope.

`model` may be omitted or set to `openclaw`. OCC replaces it with the exact native
Agent target supplied by Compute. Other values, unknown query parameters and
caller-supplied `x-openclaw-*` headers are rejected. Caller credentials, cookies,
forwarding headers and `x-occ-*` claims are not forwarded. OCC does not follow
upstream redirects. Responses relay content type and selected rate-limit headers,
never cookies or upstream authority headers.

## Conversations and execution

Omit `user` for a fresh conversation. To continue a conversation, send the same
opaque `user` label, containing 1–128 UTF-8 bytes, and only the new messages. OCC
hashes a versioned tuple of Installation, Namespace, Agent, principal kind,
principal ID and label before forwarding it. Session changes and service-key
rotation preserve continuation for the same principal. Another principal or
Agent cannot use the label to select that conversation.

The label separates conversations; it is not an access boundary. Each HTTP chat
conversation is a session of the Agent's Gateway, like its browser chat
sessions. Every user with browser access to the Agent, including chat-only
users with `operate`, can see it in the Agent UI's session list and read its
prompts and replies. When a transcript must not be shared with those users, use
a dedicated Agent whose browser access is limited to the people allowed to read
it.

The Gateway owns history. This operation adds no transcript store, cross-revision
history transfer, ordering guarantee, turn queue or idempotency key. Shared Agent
workspace and tool permissions still apply. A retry can execute tools again.
OCC never repeats a chat request automatically.

## Availability and failures

After authentication, lookup and exact-Agent authorization, OCC first checks for
the optional Compute capability. If it is absent, OCC returns `501`, including
for Docker and SSH Compute. Otherwise a stopped or deleting Agent, missing
running revision, or mismatched Compute owner returns `503` before endpoint
resolution. Compute maps `unsupported` to `501`, and `disabled` or `unavailable`
to `503`. Only `available` permits forwarding.

Kubernetes Compute supports the private route for single-cluster runtime
configurations. It rejects unsupported authority or topology before checking
opt-out, then checks route availability. Resolution is not a readiness probe:
connection failure returns `502`; an OCC deadline returns `504`. Authentication
fails with `401`. Hidden or missing Agents return `404`; a visible Agent without
`operate` returns `403`. Native application errors retain their native status
and body.

Requests are limited to 20 MiB and 60 seconds to receive the body (`413` and
`408`). Upstream connection establishment has a 10-second deadline; the admitted
request has a 10-minute deadline. A stricter native limit still applies. SSE
uses backpressure. After response headers are sent, an interruption closes the
connection rather than replacing it with an OCC error body.

The deadline aborts the upstream connection. The pinned runtime then ends the
turn within seconds; a command that is already running can finish in the
background. A response carries no bytes while tools run. A proxy or load
balancer in front of OCC whose idle timeout is shorter than such a silent
interval closes the connection first: the caller gets a connection reset,
not `504`.

OCC rechecks credential validity, principal status, permission and the selected
revision every 25 seconds and before final delivery, with a 5-second deadline. Revocation, dependency
failure, stop, deletion, replacement or client disconnect aborts the upstream
connection. Aborting does not prove execution stopped or undo tool effects. A
request that waits behind a turn when its Gateway ends is not kept. Silence or
a connection error does not tell you whether the turn started. Before you retry
or continue, follow the [HTTP chat recovery steps](agents/interrupted-turns.md#http-chat-callers).

## Kubernetes configuration and audit

New Kubernetes Agent revisions default
`gateway.http.endpoints.chatCompletions.enabled` to `true`. Explicit `false`
disables this operation. The default applies when a revision starts; running
revisions are not modified. Authentication defaults to `trusted-proxy`.
Incompatible explicit modes or trusted-proxy settings fail before deployment.
The private proxy supplies identity and `operator.sessions.write`; required
headers and network isolation enforce that boundary. Its completion route
matches only the exact POST. Model-list, embedding and Responses routes are not
exposed by OCC chat.

A native SSE error can arrive after HTTP `200` and still end with `[DONE]`.
Clients must inspect error events; the terminator alone does not prove success.
Dedicated Codex streaming remains subject to the
[current qualification limit](../testing/agent-http-chat.md#current-pinned-runtime-qualification-limit).

OCC saves pending HTTP chat audit records in a SQLite file on the API's
private persistent volume. The queue holds up to 4,096 records. Each
record can use up to 8 KiB of UTF-8 JSON.

| Record                                                                                                | When OCC queues it                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `openclaw.api.request.received`                                                                       | After initial size checks, before identity or permission checks. Control Plane audit must be on.            |
| `openclaw.api.request.admitted`                                                                       | After authentication, before the handler starts. Control Plane audit must be on.                            |
| `openclaw.api.request.result`                                                                         | If Control Plane audit is on and OCC prepares an API response, such as a refusal before forwarding.         |
| `openclaw.agents.chat.admitted`                                                                       | After OCC checks permission and selects the revision, before forwarding. This applies with audit on or off. |
| `openclaw.agents.chat.completed`, `openclaw.agents.chat.failed` or `openclaw.agents.chat.interrupted` | When the relay ends. This applies with audit on or off.                                                     |

The receipt shows that the request reached the API. The caller is still
unknown. At 3,072 pending records, OCC reserves the last 1,024 spaces
for records with a verified caller. New receipts and results for unknown
callers can be missing. If OCC cannot queue the receipt, it logs the
error and continues the access checks.

OCC saves the required admission records before it forwards the message.
If the queue is full or OCC cannot save these records, it returns `503`
without forwarding the message.

The API writes queued records to `occ.audit_events` in the background.
If PostgreSQL goes down, the API can still queue a chat result. When
PostgreSQL recovers, the API retries with the original event ID and time.
It removes the queued record only after PostgreSQL confirms the write.
Queued records survive API Pod replacement if the volume stays intact.

Chat can continue if only writes to the audit log fail. If OCC cannot
check access or the running revision, it refuses new requests and
interrupts open requests at the next check.

For example, a request reaches the running API while PostgreSQL is
down. With Control Plane audit on, OCC queues the receipt. If OCC
cannot check access, it returns `503` without forwarding the message.
It queues a result with outcome `failure` and reason code
`PERMISSION_CHECK_UNAVAILABLE`. The request ID links the records.
If Kubernetes stops routing requests to the API, OCC cannot record them.

This reason code means OCC could not check credentials, identity or
Agent permission. A permission denial has outcome `denied`. If the
access check becomes unavailable during a turn, the interruption
record can show the same reason code.

`openclaw.agents.chat.*` records identify the request, caller, Agent, revision,
time, streaming mode, result, and number of submitted `messages` entries. Older
records can lack the count. A result can include `completionIdHash`, a SHA-256
hash of the completion ID returned by the Gateway. These records exclude message text, response text, credentials,
and raw conversation labels. OCC logs a failure to queue the result; it cannot
undo the turn.

The [Agent audit API](../guides/topics/audit-log.md#read-an-agents-audit-events)
returns these records as `http_chat`. Their request ID connects admission and
result. The API adds `turnId` only when the hash matches one recorded session
and turn for the same Agent and revision during the request. Missing or ambiguous
evidence leaves the link absent. Delayed runtime records can delay the link.

### Queue storage

Helm mounts the `openclaw-enterprise-http-chat-audit` volume only in
the API Pod, even when Control Plane audit is off. The file is
`/var/lib/occ/http-chat-audit/pending/events.sqlite`. The single API
Pod uses the same volume after replacement. Helm retains the claim
on uninstall. Deleting the claim or its namespace can lose pending
records. A PostgreSQL backup excludes records still in the queue.

With PostgreSQL in development, the API uses
`.development/http-chat-audit/<installation-directory>/events.sqlite`.
Compose keeps that directory on a named volume. To use the
[recovery commands](../guides/agent-http-chat.md#retry-delayed-http-chat-audit-records)
in development, add the directory that contains the file as the last
argument. OCC checks the Installation ID and creation time before
delivery. A new Installation cannot receive the old records.

See the [operator procedure](../guides/agent-http-chat.md),
[Compute contract](drivers/compute.md), [source flow](../flows/agent-http-chat.md)
and [runtime verification requirements](../testing/ci/qa-advisory.md).
Implementation alone is not evidence that a deployment passes those runtime checks.
