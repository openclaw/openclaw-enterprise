# Audit log

OpenClaw Control Plane (OCC) records audit events for resource API requests,
Installation bootstrap, resource changes, authorization denials, and background
work. OCC stores audit events in the controller’s PostgreSQL database.
The [OpenTelemetry Collector](../observability.md) exports operational logs.

## What is recorded

An event records the time, Installation, actor, action, resource, and outcome.
It can include a Namespace, request ID, or authorization decision. The decision
identifies the permission and resource under review. An Agent update can record
a denied `operate` decision on its Secret. `AGENT_PRINCIPAL_NOT_AUTHORIZED`
identifies a refused Agent service principal and grant. Key issue and revocation
record the caller, principal ID, and key ID and name. Resource events for
[service API key calls](../../reference/authentication/service-api-keys.md#revocation-and-audit)
include `actorServiceKeyId`. Audit fields exclude the credential.

### API requests

When Control Plane audit is enabled, OCC records two events for a covered
resource API request that reaches its handler after bootstrap. It saves
`openclaw.api.request.admitted` before the handler starts and
`openclaw.api.request.result` before sending the response. Admission means OCC
accepted the request for processing. The handler still checks
permission for the operation. A request rejected before the handler can have a
result record by itself, for example a `400` for an invalid request or a `401`
for missing credentials.

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

With audit enabled, PostgreSQL saves covered jobs with
`openclaw.controller_work.queued`, linking work and HTTP request IDs. Repository
cleanup and maintenance recovery record created or reopened work. An
`openclaw.controller_work.claimed` write must commit before the worker starts.
A failed claim write leaves the job queued. The worker waits up to 15 seconds
for the database, subject to any shorter worker limit.

Results link to the job and claim by work and attempt ID. The queue stores
the lease token. Waiting can repeat the attempt count. Explicit retries can
reuse the work ID. `reconcile` records
retries, expired claims, failures, and completions. Audited claims with repeated
waiting states record `openclaw.controller_work.deferred`. Terminal failures
include `final: true`.

`openclaw.controller_work.completed` links successful provisioning to its claim.
Stop and Delete record `openclaw.agents.provision.cancelled`, linking the
claim, caller, and job. Already audited claims retain this record with
collection off. If PostgreSQL loses commit
confirmation, `worker.error` reports `COMMIT_OUTCOME_UNKNOWN`. Check the job
before retrying.

### Agent runtime activity

Enable [Control Plane audit](../../reference/settings/production.md#control-plane-audit)
on a Helm installation with managed Gateway routing. Deploy the Agent revision
and send a message as usual. Compute loads the OCE plugin in the Gateway and
gives it a credential for that revision. The Agent audit API returns the
saved records with `event` set to `runtime_activity`. If the Gateway
configuration disables all plugins or denies `oce-runtime-audit`, the Gateway
starts without runtime reporting.

| Action                                     | What the Gateway observed                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `openclaw.runtime.session.started`         | OpenClaw sent a session-start notification. The first HTTP chat can create a session without this notification.       |
| `openclaw.runtime.session.ended`           | OpenClaw reported that it deleted the session.                                                                        |
| `openclaw.runtime.turn.started`            | The Gateway observed the start of a run with an identified session.                                                   |
| `openclaw.runtime.turn.completed`          | The Gateway observed a final result for the run. Read `details.outcome`.                                              |
| `openclaw.runtime.model_call.started`      | Embedded OpenClaw reported that it started a model call.                                                              |
| `openclaw.runtime.model_call.completed`    | Embedded OpenClaw reported the result of the call. The same `modelCallId` links the two records.                      |
| `openclaw.runtime.model_response.observed` | The Codex connection reported a provider response. `responseIdHash` identifies the response without storing its text. |

Use `sessionId` and `turnId` together to find records for a run. The Gateway
supplies the run ID. OpenClaw can reuse it during recovery. A missing result
leaves the outcome unknown. The plugin saves metadata only.
When a turn includes `details.messageId`, you can
[open its saved user message](#open-the-message-for-a-turn).

Dedicated OpenClaw reports turn activity through its Gateway. Embedded
OpenClaw reports each runtime model call. Provider retries can occur within
one call. Codex response records give no retry count.

The Gateway queues up to 256 observations on local disk and retries them
after restart in the same Pod. A full queue drops new observations and logs
a warning. Pod deletion removes pending observations. Covered dispatches
wait for OCC to confirm admission. Replaying observations cannot release work.

#### Tools, approvals, and policy

On a managed OpenClaw revision, [configure Slack search](plugins-configure.md#configure-slack-search)
with **Every action** approval. After an approved search, use the Agent audit
API to follow one `invocationId`. Each action has the `openclaw.runtime.` prefix.

| Action                   | What the record shows                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `tool_call.requested`    | The managed policy received the selected Slack tool call.                          |
| `policy.decided`         | `managed_mcp_policy` required approval.                                            |
| `approval.requested`     | The policy requested review with an audit `approvalId`.                            |
| `approval.resolved`      | The reviewer granted `allow-once` for that ID.                                     |
| `tool_attempt.admitted`  | OCC committed admission before dispatch, linking the `approvalId` and `attemptId`. |
| `tool_attempt.completed` | The policy observed the result for that `attemptId`. Read `details.outcome`.       |

For managed MCP, a denied review ends before admission. A lost response can
leave an unknown outcome. Records omit arguments, results, commands, paths,
and reviewer rationale.

The `boundary` field identifies the source of the evidence.

- `managed_mcp` records the managed policy's actual decision and dispatch.
  Audited OpenClaw routes eligible worker-local MCP tools through the Gateway.
  Events can carry revision scope when the turn is unknown.
- `gateway_hook` admits a covered tool at the Gateway hook. Later native checks
  can still refuse it. This includes Codex calls that reach the native hook relay.
- `runtime` reports observed activity. A Codex result can have no admission
  and gives no count of native retries. Worker-local tools provide limited
  observations. Direct scripts using plugin credentials are outside this path.

#### Network decisions and external sends

The optional [OpenShell security event exporter](openshell-audit.md) reports
supported network decisions after enforcement. OCC links the decision to the
enrolled Sandbox and revision. Exporter outages can leave gaps.

OCC records repository or egress authorization with the existing send receipt.
Use `receiptId` for a repository send or the sender, generation, instance, use,
and attempt IDs for egress. Check the receipt owner for the outcome before
repeating a send whose result is unknown.

### Agent runtime logs

Reading an Agent's container output has a separate access record. Each
[runtime log view](agent-logs.md) records one `openclaw.agents.runtime_logs.view`
event before any output is read, with the version, source, Pod, container,
previous-instance flag, line count and a view ID, never the log text. Follow
polls within the view are not recorded again; a poll that has to read another
Pod, because the view's Pod is gone, records a new view. If the event cannot be written,
no output is returned. Each log download records one
`openclaw.agents.runtime_logs.download` event with the same details, before the
read. Both use the audit event kind `access`, which marks an audited read. The
event names the permission that admitted the reader, `read_logs` or `administer`.

## Manage audit storage

OCC keeps audit rows when a resource is deleted. The application role can add
rows. It cannot update, delete, or truncate them. Automatic expiry, purge,
archive, and export are outside the current audit workflow. Use approved
database access to inspect raw audit rows.

PostgreSQL checks each new Control Plane request, work, audit disclosure, and
runtime activity record against an 8 KiB limit on its JSON row. At 1 GiB of
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

If `accepts_new_events` is `false`, OCC can refuse covered requests, tool
dispatches, and audit reads. Chat can continue when it needs no covered tool.
The Gateway queues observations up to its local limit. The worker cannot claim
covered jobs or save audited results until space is available. It reports
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

This API requires PostgreSQL, the Native IAM Driver, and enabled Control Plane
audit. If you receive `501`, check that audit is enabled and the Installation
uses the Native IAM Driver.

Sign in with a human account. Ask an Installation administrator to
[bind a Namespace Role](../../reference/authorization.md#manage-namespace-policy)
with the `read_audit` permission directly to your Principal and the Agent.
OCC checks the grant each time you request a page.

Send `GET /namespaces/{namespaceId}/agents/{agentId}/audit-events`.
The response lists selected Agent lifecycle records, runtime activity, API
reads, and worker events from the preceding 24 hours, newest first. Lifecycle records show the
saved action, such as Agent creation, deployment admission, or activation.
They include an Agent revision ID when OCC verifies that revision belongs to
the Agent. A work ID connects job records without exposing the internal work key.

The default page contains up to 50 records. Set `limit` to a number from
1 through 100 to change the size. If the response includes a `nextCursor`,
send it as `cursor` on the next request. Use the same session and Agent within
15 minutes of the first page. OCC keeps the first page's time window.

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

The Gateway can link an ordinary browser chat in all three runtimes.
Codex can also link an HTTP chat when it reports the ID of its saved input.
If the ID arrives after the turn starts, check the completion event.
If a policy blocks a turn after the Gateway saves the user message,
the link can still open the original input.

In both OpenClaw modes, `/v1/chat/completions` assigns unrelated IDs to
the turn and its input. These events omit `messageId`. The link can also be
missing if a turn combines inputs, has no saved user message, or ends after
the Gateway loses its pending IDs. Check for `details.messageId` before
you offer **Open message**.

| Status | What to check                                                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403`  | Check both direct grants for this Agent.                                                                                                                       |
| `404`  | The event must be from the active revision and the last 24 hours. Its linked user message must still be visible in chat history and fit within 64 KiB of text. |
| `501`  | Check that the Installation uses Native IAM, PostgreSQL, and Control Plane audit with managed Gateway routing.                                                 |
| `503`  | OCC could not finish the Gateway lookup or confirm the disclosure record. Try again.                                                                           |

## Access and limitations

For other audit events, use your organization's approved database access
procedure. Give your platform operator the approximate time, Namespace,
resource ID, and OCC request ID when available. Console browsing, automatic
retention, and export are outside this workflow.

For metrics and operational troubleshooting, see
[Observability](../observability.md). For the platform’s audit and logging
boundaries, see [Security](../../reference/security.md#operational-log-collection-boundary).
