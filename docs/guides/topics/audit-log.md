# Audit log

OpenClaw Control Plane (OCC) records audit events for Installation bootstrap,
successful resource changes, authorization denials, and lifecycle completion,
such as activating an Agent revision. Audit events are stored in the
controller’s PostgreSQL database. Routine operational logs and the OpenTelemetry
Collector do not export or replace this record.

## What is recorded

An event identifies when it occurred, the Installation, actor, action, affected
resource, and outcome. It can also include a Namespace, request ID, or
authorization decision when available. A denial's decision names the exact
permission and resource that was refused, which can differ from the action. An
Agent update refused for a missing `operate` on the Agent's Secret records
`openclaw.agents.update` with a decision for `operate` on that Secret. When the
Agent's own service principal is refused, the event has reason code
`AGENT_PRINCIPAL_NOT_AUTHORIZED` and its details name that principal and the
refused grant. Other refusals record nothing, such as `401` for a missing
credential or `400` for an invalid request, even after authorization passed. For
example, service API key issuance and revocation record the caller, the
principal ID, and the key's ID and name, not the credential. An API route's
event for a request made with a
[service API key](../../reference/authentication/service-api-keys.md#revocation-and-audit)
records that key's ID in `actorServiceKeyId`. The audit event contract does not
represent a general log of all successful reads, Agent prompts, or model
responses.

The controller worker records a `reconcile` event when queued work changes
state: each retry, permanent failure, expired claim, and completion. A pass that
leaves work waiting, such as a deployment whose runtime is still starting, is
recorded only when its result differs from the work item's previous one, so a
deployment that waits for minutes writes one waiting event, not one per check.
Each event's details carry `workId`, `reasonCode` and `attemptCount`. A `failure`
event after which the worker stops trying also carries `final: true`: a permanent
error, or a failure with no attempts left (5 by default), including a claim that
expired on its last attempt (`LEASE_EXPIRED`) and queued work with none left
(`MAX_ATTEMPTS_EXHAUSTED`). A failure the worker will retry has no `final` field.
Retrying failed work, such as an Agent or Namespace deletion, is its own audited
action, and the same `workId` can then record more events. When Stop or Delete
cancels an Agent's queued, running or failed provisioning work, the cancellation
itself records no `reconcile` event; only the Stop or Delete work's own events
are recorded, and the provisioning status shows `PROVISIONING_CANCELLED`.
Authorization denials and lifecycle events such as revision activation are
always recorded. An external sign-in callback that matches no pending attempt is
not: anyone can send one, so the API counts it in a
[metric](../../reference/metrics.md#application-families) instead.

Reading an Agent's container output is the exception among reads. Each
[runtime log view](agent-logs.md) records one `openclaw.agents.runtime_logs.view`
event before any output is read, with the version, source, Pod, container,
previous-instance flag, line count and a view ID, never the log text. Follow
polls within the view are not recorded again; a poll that has to read another
Pod, because the view's Pod is gone, records a new view. If the event cannot be written,
no output is returned. Each log download records one
`openclaw.agents.runtime_logs.download` event with the same details, before the
read. Both use the audit event kind `access`, which marks an audited read; other
events use `bootstrap`, `mutation` or `authorization_denial`. The event names
the permission that admitted the reader, `read_logs` or `administer`. Runtime
status reads are not audited.

## Access and limitations

OCC does not currently provide a console view or public HTTP API to browse or
export audit events. Configurable audit retention and export integrations are
also not implemented. If you need to investigate an event, give your platform
operator the approximate time, Namespace, resource ID, and OCC request ID if
available. Use your organization’s approved database access procedure; there is
no self-service retrieval workflow in OCC.

For metrics and operational troubleshooting, see
[Observability](../observability.md). For the platform’s audit and logging
boundaries, see [Security](../../reference/security.md#operational-log-collection-boundary).
