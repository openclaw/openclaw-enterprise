# Audit log

OpenClaw Control Plane (OCC) records audit events for resource API requests,
Installation bootstrap, resource changes, authorization denials, and background
work. OCC stores audit events in the controller’s PostgreSQL database.
The [OpenTelemetry Collector](../observability.md) exports operational logs.

## What is recorded

An event identifies when it occurred, the Installation, actor, action, affected
resource, and outcome. It can also include a Namespace, request ID, or
authorization decision when available. A denial's decision names the exact
permission and resource that was refused, which can differ from the action. An
Agent update refused for a missing `operate` on the Agent's Secret records
`openclaw.agents.update` with a decision for `operate` on that Secret. When the
Agent's own service principal is refused, the event has reason code
`AGENT_PRINCIPAL_NOT_AUTHORIZED` and its details name that principal and the
refused grant. Service API key issuance and revocation record the caller, the
principal ID, and the key's ID and name, not the credential. An API route's
event for a request made with a
[service API key](../../reference/authentication/service-api-keys.md#revocation-and-audit)
records that key's ID in `actorServiceKeyId` on the resource event.

### API requests

When Control Plane audit is enabled, OCC records two events for a covered
resource API request that reaches its handler after bootstrap. It saves
`openclaw.api.request.admitted` before the handler starts and
`openclaw.api.request.result` before sending the response. Admission means OCC
accepted the request for processing. The handler still checks
permission for the operation. A request rejected before the handler can have a
result record by itself, for example a `400` for an invalid request or a `401`
for missing credentials.

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
resource or job state before retrying. Bootstrap and runtime log reads use
their own audit paths. Authentication callbacks, native proxy traffic, and
unmatched routes are outside these request records.

Control Plane audit is on by default in PostgreSQL development. Production
requires the [audit setting](../../reference/settings/production.md#control-plane-audit)
for both the API and worker.

### Worker events

With Control Plane audit enabled, PostgreSQL saves jobs from covered API
requests with an `openclaw.controller_work.queued` event. The event links the
work ID to the HTTP request ID. Internal repair transfers and maintenance
continuation can have claim and result records without a queued record.
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

PostgreSQL checks each new Control Plane request, work, or audit disclosure event
against an 8 KiB limit on its JSON row. At 1 GiB of allocated space for the
`occ.audit_events` table and its indexes, PostgreSQL refuses new Control Plane
audit events by default. Existing event types can still grow the table.
Concurrent writes and page allocations can take the table above the threshold.

Check the storage threshold before enabling Control Plane audit and while it runs.
Use an approved PostgreSQL connection and run this query.

```sql
SELECT pg_total_relation_size('occ.audit_events') AS used_bytes,
       occ.control_plane_audit_capacity_available() AS accepts_new_events;
```

If `accepts_new_events` is `false`, the API can block covered requests or
withhold audit results. The worker cannot claim covered jobs or save the
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

This API requires PostgreSQL, the Native IAM Driver, and enabled Control Plane
audit. If you receive `501`, check that audit is enabled and the Installation
uses the Native IAM Driver.

Sign in with a human account. Ask an Installation administrator to
[bind a Namespace Role](../../reference/authorization.md#manage-namespace-policy)
with the `read_audit` permission directly to your Principal and the Agent.
OCC checks the grant each time you request a page.

Send `GET /namespaces/{namespaceId}/agents/{agentId}/audit-events`.
The response lists selected API reads and worker events from the preceding
24 hours, newest first. A work ID in the response connects events for the
same job. OCC gives it a separate format to keep internal work keys and
Agent revision IDs private.

The default page contains up to 50 records. Set `limit` to a number from
1 through 100 to change the size. If the response includes a `nextCursor`,
send it as `cursor` on the next request. Use the same session and Agent within
15 minutes of the first page. OCC keeps the first page's time window.

OCC saves a disclosure record before it sends each page, including an empty
page. If it cannot confirm the write, it returns `503` and withholds the page.
Give your platform operator the request ID if the error persists.

## Access and limitations

For other audit events, use your organization's approved database access
procedure. Give your platform operator the approximate time, Namespace,
resource ID, and OCC request ID when available. Console browsing, automatic
retention, and export are outside this workflow.

For metrics and operational troubleshooting, see
[Observability](../observability.md). For the platform’s audit and logging
boundaries, see [Security](../../reference/security.md#operational-log-collection-boundary).
