# Audit log

OpenClaw Control Plane (OCC) records audit events for resource API requests,
Installation bootstrap, resource changes, authorization denials, and background
work. OCC stores audit events in the controller’s PostgreSQL database.
The [OpenTelemetry Collector](../observability.md) exports operational logs.

## What is recorded

An event identifies its time, Installation, actor, action, resource, and outcome.
It can include a Namespace, request ID, and authorization decision. A denial
names the exact refused permission and resource. For example, an Agent update
can report `operate` denied on its Secret. `AGENT_PRINCIPAL_NOT_AUTHORIZED`
identifies a refused Agent principal and grant. Service key changes record the
caller, principal, and key ID and name, not the credential. A request with a
[service API key](../../reference/authentication/service-api-keys.md#revocation-and-audit)
records that key's ID in `actorServiceKeyId` on the resource event.

### API requests

After bootstrap, Control Plane audit records `openclaw.api.request.admitted`
before a covered handler starts. The handler still checks permission.
OCC records `openclaw.api.request.result` before sending a standard API
response. An invalid or unauthenticated request can have only a result.
[HTTP chat](../../reference/agent-http-chat.md#kubernetes-configuration-and-audit)
queues `openclaw.api.request.received` before authentication. A relayed
response has a separate chat result.

The result hook also covers the registered account, service-key, sign-in,
recovery, and native administration routes. When a resource API request returns
`405`, OCC records a `methodNotAllowed` result. A successful API
bootstrap can record its result after it saves the Installation.

The request ID connects the records. They name the registered operation and
HTTP method. The result also has the HTTP status. For a successful read of one
Namespace, Agent, Agent revision, deployment, Sandbox Policy, Configuration,
Preset, Secret, ServiceAccount, or CredentialSource, the result records the
verified ID and Namespace. Admission, list results, and failed reads identify
the Installation. A resource change has its own event for the resource it
changed. These records omit request bodies, response bodies, and raw URLs.

If OCC cannot save admission, it returns `503` before running the handler.
If it cannot save the result, it keeps the selected response and logs
`http.audit_append_failed` with the request ID. This usually applies if it
cannot save a separate permission-denial record. A device login scope denial
returns `503` if OCC cannot save its required denial record. If OCC cannot
confirm a commit, look for `http.commit_outcome_unknown` and check the current
resource or job state before retrying. Bootstrap and runtime log reads have
their own records for the state change or disclosure. Matched Google and OIDC
sign-in callbacks have their own authentication records. Arbitrary unmatched
paths and native proxy traffic are outside this request audit scope.

Control Plane audit is on by default in PostgreSQL development. Production
requires the [audit setting](../../reference/settings/production.md#control-plane-audit)
for both the API and worker.

### Worker events

With Control Plane audit enabled, PostgreSQL saves jobs from covered API
requests with an `openclaw.controller_work.queued` event. The event links the
work ID to the HTTP request ID. Repository cleanup and maintenance recovery
also save a queue record when they create or reopen follow-up work.
PostgreSQL saves each claim with its `openclaw.controller_work.claimed` event.
If that write fails, the job stays queued and the worker does not start it.

A new attempt ID identifies each claim. The attempt count can repeat when the
worker waits for a dependency. Results link to the claim by attempt ID and
to the job by work ID. The database keeps the lease token in the queue. With
audit enabled, the worker waits up to 15 seconds for a database connection
or query. A shorter configured worker limit still applies.

The `reconcile` event records retry, failure, expired claim, and completion.
The worker can combine repeated waiting states in `reconcile`. When audit is
enabled, it records `openclaw.controller_work.deferred` for each claim whose
waiting state would otherwise repeat. A terminal failure includes `final: true`.
When provisioning succeeds, `openclaw.controller_work.completed` links its
result to the claim. Stop and Delete link a provisioning cancellation to the
caller and job in `openclaw.agents.provision.cancelled`.
If the claim already has an audit record, Stop and Delete save the cancellation
even when collection is off. The cancellation links to that claim.

An explicit retry of failed work can reuse the work ID. Existing authorization
denials and resource lifecycle evidence apply with either audit setting.
If PostgreSQL loses confirmation of a result commit, `worker.error` reports
`COMMIT_OUTCOME_UNKNOWN`. Check the job before requesting a retry.

### Agent runtime activity

Enable [Control Plane audit](../../reference/settings/production.md#control-plane-audit)
with Helm-managed Gateway routing. Each Gateway on the control cluster
gets the `oce-runtime-audit` plugin and a revision credential.
Disabling the plugin prevents setup.

Changing the setting can restart Gateways and dedicated Codex workers. A turn
can fail or use the old setting during restart. If maintenance fails, restore
the original deployer's permission and deploy the Agent.

| Action                                     | What the Gateway observed                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `openclaw.runtime.session.started`         | New session. Empty chats and sessions created by a first message can lack this record.    |
| `openclaw.runtime.session.ended`           | Session deletion.                                                                         |
| `openclaw.runtime.turn.started`            | Start of a turn.                                                                          |
| `openclaw.runtime.turn.completed`          | Final turn result in `details.outcome`.                                                   |
| `openclaw.runtime.model_call.started`      | Start of an embedded OpenClaw or dedicated Codex model call.                              |
| `openclaw.runtime.model_call.completed`    | Embedded OpenClaw result for the same `modelCallId`.                                      |
| `openclaw.runtime.model_attempt.observed`  | Embedded OpenClaw or dedicated Codex HTTP attempt.                                        |
| `openclaw.runtime.model_response.observed` | Dedicated OpenClaw or Codex response. `responseIdHash` identifies the provider response.  |
| `openclaw.runtime.model_error.observed`    | Dedicated OpenClaw worker saved an assistant error. `errorCode` can give the HTTP status. |

Each turn includes `sessionId` and `turnId`, even without a session start.
Recovery can reuse a turn ID. Without a result, the outcome is unknown.
OCE hashes IDs that fail format checks or exceed
256 characters. [Message links](#open-the-message-for-a-turn) require
original session and message IDs but allow hashed turn IDs.

Group HTTP attempts within a revision and turn by `modelCallId`. Each
identifies the `model`, `provider` and a distinct `modelAttemptId`.
`attempt` starts at 1 per call. `httpStatus` comes from response headers.
`failureCode: TRANSPORT_ERROR` means the request failed before headers arrived.
HTTP 200 cannot confirm stream completion. With different call IDs,
the records alone cannot identify a retry.

- Embedded OpenClaw reports OpenAI Responses, Chat Completions and Anthropic
  Messages attempts. The full `traceparent` must match a model call. Background
  session recap calls are not reported. A trace exporter can prevent a match.
- Dedicated OpenClaw reports saved provider responses and errors, but omits request attempts and retries.
- Dedicated Codex requires a managed Pod on the control cluster with a
  direct Gateway connection. An HTTP 503 retry can share the call ID.
  A stream retry starts a new call. Call starts can appear after the request.
  Check Gateway logs for reporting warnings.

Attempts can arrive after the result. WebSockets, failures before sending,
missing traces and ambiguous matches can leave gaps. Restart or overflow
can erase attempts before the [Gateway queues them](../../flows/audit-ledger.md#7-a-gateway-reports-work-for-one-revision).

The Gateway queues events locally and sends them in the background.
Chat continues if PostgreSQL cannot save a runtime event.

For HTTP chat, OCC saves admission records in a
[queue on the API's persistent volume](../agent-http-chat.md#retry-delayed-http-chat-audit-records).
OCC can queue a chat result during a PostgreSQL outage. It still needs
PostgreSQL to check access and the Agent revision.

### Recover delayed runtime events

The Gateway retries network errors and HTTP 408, 429 and 5xx after
15 seconds. HTTP 204 confirms delivery. Other responses hold the event.
The Gateway keeps 256 events per revision, source and endpoint, up to
512 per Agent. Held events count toward both limits. Pod replacement
preserves events. Agent deletion removes them. A full or unavailable
queue can lose new events. The Gateway warns.
A new Gateway can deliver signed records from an older revision to the same endpoint.

To check delivery, set `namespace` and `pod` to the Gateway's Kubernetes
namespace and Pod name. You need permission to run commands in that Pod.

```sh
kubectl exec -n "$namespace" "$pod" -c gateway -- node /app/oce-plugins/oce-runtime-audit/sink.mjs status
```

`pending` counts events awaiting delivery. `held` lists event IDs and HTTP
statuses. `otherScope` counts records for another revision, source or endpoint.
OCC checks the original signature and revision. The old credential remains revoked.
A signature does not prove when the record was signed.
A changed endpoint prevents delivery.

Correct the cause of the refusal. Set `eventId` to the held ID.

```sh
kubectl exec -n "$namespace" "$pod" -c gateway -- node /app/oce-plugins/oce-runtime-audit/sink.mjs retry "$eventId"
```

The Gateway checks every 15 seconds. A retry does not repeat the turn.
Run `status` again. The audit API uses a different event ID.
Find recent turns by revision, session and turn ID.

### Agent runtime logs

Before reading [container logs](agent-logs.md), OCC records
`openclaw.agents.runtime_logs.view` or `openclaw.agents.runtime_logs.download`.
If the write fails, OCC withholds output. Follow polls reuse the view until
the Pod changes. Both `access` events identify the permission (`read_logs`
or `administer`), version, source, Pod, container, previous-instance flag,
line count and view ID. They omit log text.

## Manage audit storage

OCC keeps audit rows when a resource is deleted. The application role can add
rows. It cannot update, delete, or truncate them. Automatic expiry, purge,
archive, and export are outside the current audit workflow. Use approved
database access to inspect raw audit rows.

PostgreSQL limits each Control Plane request, HTTP chat, work, audit disclosure
and runtime activity record to 8 KiB of JSON. At 1 GiB of
allocated space for the `occ.audit_events` table and its indexes, PostgreSQL
refuses new records of these types by default. Other event types can still grow
the table.
Concurrent writes and page allocations can take the table above the threshold.

Check the storage threshold before enabling Control Plane audit and while it runs.
Use an approved PostgreSQL connection and run this query.

```sql
SELECT pg_total_relation_size('occ.audit_events') AS used_bytes,
       occ.control_plane_audit_capacity_available() AS accepts_new_events;
```

If `accepts_new_events` is `false`, the API can block covered requests or
withhold audit results. The [HTTP chat and Gateway queues](#agent-runtime-activity)
can still accept records until they reach their limits.
The control plane worker cannot claim covered jobs or save the
results of audited attempts until space is available. It reports
`worker.error` with code `AUDIT_CAPACITY_EXCEEDED`. Preserve the existing
records. Monitor free disk space separately. Reserve space for other tables,
transaction logs, and backups. A database administrator can provision
more space and increase `occ.control_plane_audit_max_bytes` on the database.
The value is a positive integer in bytes, up to 16 digits. Restart the API and
worker processes so their database connections use the new setting. Run the
query again before retrying the operation.

## Investigate an uncertain Agent edit

If an Agent draft save loses its response, read the Agent and compare the fields
you edited. A matching value tells you what is saved now. Another writer could
have saved the same value.

To trace the edit, give your platform operator the approximate time, caller,
Namespace and Agent IDs, and the original OCC request ID if available. Each
request has its own ID, including the later read. Using approved database access,
the operator can look for a successful `openclaw.agents.update` event for that
actor and Agent. OCC commits the edit and event together. The event records the
request ID. Use the Agent read to check field values. If several requests match,
attribution remains uncertain.

## Investigate an external sign-in

Using approved database access, inspect recent sign-in outcomes:

```sql
SELECT occurred_at, outcome,
       details -> '__occAuditMetadata' ->> 'reasonCode' AS reason,
       details ->> 'provider' AS provider, details ->> 'subject' AS subject,
       details ->> 'attemptId' AS attempt_id
FROM occ.audit_events
WHERE action = 'authentication.login'
  AND details ->> 'provider' IN ('google', 'oidc')
  AND occurred_at > now() - interval '1 hour'
ORDER BY occurred_at DESC;
```

The subject identifies the verified provider identity. Failures before identity
verification have no subject. For a specific attempt, the person can preserve
their browser's network log before signing in and share only `attemptId` from the
`/api/auth/providers/oidc/start` or `/api/auth/providers/google/start` response.
Match it to `attempt_id`; do not share authorization URLs, callbacks, cookies, or
codes. Unmatched callbacks have no audit row. The handle identifies one attempt;
it does not correlate separate attempts to the same person or browser.

## Read an Agent’s audit events

Sign in with a human account. Ask an Installation administrator to
[bind a Namespace Role](../../reference/authorization.md#manage-namespace-policy)
with the `read_audit` permission directly to your Principal and the Agent.
OCC checks the grant each time you request a page.

Send `GET /namespaces/{namespaceId}/agents/{agentId}/audit-events`.
The response lists selected Agent lifecycle records, runtime activity, API
reads, and worker events from a 24-hour period, newest first. The period ends
now by default. For older records, set `end` to a UTC timestamp, such as
`?end=2026-11-20T00:00:00.000Z`. Use `end` only on the first page and do
not select a future time. Lifecycle records show the
saved action, such as Agent creation, deployment admission, or activation.
They include an Agent revision ID when OCC verifies that revision belongs to
the Agent. A work ID connects job records without exposing the internal work key.

Set `limit` to 1–100 records per page. The default is 50. Send `nextCursor` as
`cursor` within 15 minutes of the first page. Use the same session and Agent.
OCC keeps the first page's time window.

OCC saves a disclosure record before it sends each page, including an empty
page. If it cannot confirm the write, it returns `503` and withholds the page.
Give your platform operator the request ID if the error persists.

### Open the message for a turn

Ask a Namespace administrator to grant your human Principal both `read_audit`
and `read_audit_content` directly on the Agent. The same Role can contain
both permissions. The content grant gives you access to linked user messages
from chats with this Agent, including chats that other users started.

1. List the Agent's audit events. Find a turn with `details.messageId`.
2. Copy the event's top-level `id` into the following request.

```http
GET /namespaces/{namespaceId}/agents/{agentId}/audit-events/{auditEventId}/message
```

The [response](../../reference/api.md#get-namespacesnamespaceidagentsagentidauditeventsauditeventidmessage)
contains the turn in `data.event` and the text from chat history in
`data.message.text`. OCC gets the message from the Gateway when you make
this request. PostgreSQL stores the message ID and a record of who opened
the event. The text stays in chat history.

The Gateway can link a browser chat turn to its input in all three runtimes.
For HTTP chat in embedded and dedicated OpenClaw, the link is available when
the request contains one user message and no earlier conversation entries.
You can send the same text twice in the same chat. Each request gets its own
turn and saved message. Codex links an HTTP turn when it identifies the saved
prompt.

If the Gateway saves the message after the turn starts, check the completion
event. A turn that a policy blocks after the save can still link to its input.
The link can be missing if the turn combines inputs, the Gateway skips the
save, or the Gateway loses the ID before it reports the turn. Check for
`details.messageId` before you offer **Open message**.

| Status | What to check                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `403`  | Check both direct grants for this Agent.                                                                                                 |
| `404`  | The event must be from the active revision. Its linked user message must still be visible in chat history and fit within 64 KiB of text. |
| `501`  | Check that the Installation uses Native IAM, PostgreSQL, and Control Plane audit with managed Gateway routing.                           |
| `503`  | OCC could not finish the Gateway lookup or confirm the disclosure record. Try again.                                                     |

## Access and limitations

For other audit events, use your organization's approved database access
procedure. Give your platform operator the approximate time, Namespace,
resource ID, and OCC request ID when available. Console browsing, automatic
retention, and export are outside this workflow.

For metrics and operational troubleshooting, see
[Observability](../observability.md). For the platform’s audit and logging
boundaries, see [Security](../../reference/security.md#operational-log-collection-boundary).
