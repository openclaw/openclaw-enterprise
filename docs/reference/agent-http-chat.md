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

The Gateway owns history. This operation adds no transcript store, cross-revision
history transfer, ordering guarantee, queue or idempotency key. Shared Agent
workspace and tool permissions still apply. A retry can execute tools again.
OCC never retries automatically.

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

OCC rechecks credential validity, principal status, permission and the selected
revision every 25 seconds, with a 5-second deadline. Revocation, dependency
failure, stop, deletion, replacement or client disconnect aborts the upstream
connection. Aborting does not prove execution stopped or undo tool effects.

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

Admission audit must succeed before forwarding. Terminal records identify the
request, principal, authentication method, Agent, Namespace, revision, timing,
streaming mode and result. They exclude prompts, responses, credentials and raw
conversation labels. A terminal audit failure is reported separately because
execution cannot be undone.

See the [operator procedure](../guides/agent-http-chat.md),
[Compute contract](drivers/compute.md), [source flow](../flows/agent-http-chat.md)
and [runtime verification requirements](../testing/ci/qa-advisory.md).
Implementation alone is not evidence that a deployment passes those runtime checks.
