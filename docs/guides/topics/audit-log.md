# Audit log

OpenClaw Control Plane (OCC) records audit events for Installation bootstrap,
successful resource changes, authorization denials, and lifecycle completion,
such as activating an Agent revision. Audit events are stored in the
controller’s PostgreSQL database. Routine operational logs and the OpenTelemetry
Collector do not export or replace this record.

## What is recorded

An event identifies when it occurred, the Installation, actor, action, affected
resource, and outcome. It can also include a Namespace, request ID, or
authorization decision when available. For example, service API key issuance and
revocation record the administrator and the non-secret key and principal IDs,
not the credential. The audit event contract does not represent a general log of
all successful reads, Agent prompts, or model responses.

New rows also have a database receipt time and allocation sequence, with retained
resource ownership where the database can establish it. The sequence does not
establish commit order or prove that Agent execution occurred. Earlier records
keep unknown receipt and historical ownership; the system does not reconstruct
missing initiation or execution facts. This metadata does not capture transcripts.

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
