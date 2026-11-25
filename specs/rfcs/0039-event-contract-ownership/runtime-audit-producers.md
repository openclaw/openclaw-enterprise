---
rfc: index.md
---

# Milestone 2 runtime audit

An Installation administrator enables Control Plane audit once. Users deploy
Agent revisions and send messages as usual. An authorized audit reader can
find the session, turn, and model calls for each audited revision.

## Kubernetes Compute Driver

Use the existing Installation audit setting to select runtime audit.
Installation composition supplies the Kubernetes Compute Driver with the
managed audit endpoint, its TLS trust configuration, and access to register
and revoke audit producers. The endpoint is private to the Installation.
Users supply no audit endpoint or credential when they deploy a revision.

Before starting an audited revision, Compute must register its producer with
OpenClaw Control Plane (OCC). Registration identifies the exact Installation,
Namespace, Agent, revision, and producer. Compute provisions a credential for
that registration and gives it to the reporting component. It can retry
preparation for the same revision without creating a second registration.
Compute revokes the registration when it stops or retires the revision.

## Event producers

Use the existing runtime image for each mode. Add a recorder where the
runtime starts a turn or sends a model request. Link each request to the
turn that caused it. Use a new call ID for each attempt.

- Embedded OpenClaw runs the turn and sends model requests inside the Gateway.
- Dedicated OpenClaw runs in a Sandbox. The worker reports each model call on
  its authenticated connection to the Gateway. The Gateway uses its admitted
  turn assignment to attach the session and turn IDs.
- Dedicated Codex sends model requests from the App Server. Its connection
  to the Gateway reports responses but can omit retries.

On a dedicated Codex Pod on the control cluster, propose using the existing
private worker status port for HTTP request attempts. The worker receives
Codex traces on loopback only when audit is on. It extracts request IDs,
the model, time, attempt number and HTTP status. It discards the trace.
The Gateway matches the native turn ID to a saved prompt on that revision.
It must omit ambiguous matches. An HTTP status alone cannot establish
whether the model finished a response.

Use the existing App Server credential to protect this private exchange.
Keep the OCC credential on the Gateway. Neither chat nor a model request
waits for delivery. Pending observations in worker memory can be lost.
Changing the audit setting may restart the worker as well as the Gateway.

Compute gives the credential to the Gateway. The credential identifies one
revision. OCC trusts that revision to report its own activity. Code with the
same operating system identity as a reporter can affect its records. This
includes tools that run under that identity. A compromised revision can
omit or falsify its own observations. OCC must prevent it from writing for
another revision or using the credential to read records.

## Write and read behavior

OCC authenticates each producer and obtains its scope from the saved
registration. It rejects events for another revision and actions outside the
producer's role. OCC uses the existing PostgreSQL audit log.

For [HTTP chat](../0040-agent-chat-completions.md#iam-trusted-proxy-and-audit),
use a SQLite queue on the API's private persistent volume. With Control
Plane audit on, record receipt before checking identity or permission.
If OCC cannot check access, record the failure with the same request ID.
OCC must save the [required admission records](index.md#3-reuse-state-and-postgresql)
before it forwards the message.
If PostgreSQL goes down during a turn, OCC can still queue the result.
OCC must stop the relay if it cannot verify access or the running revision.

OCC sends these records to the PostgreSQL audit log in the background.
Keep each record across API Pod replacement until PostgreSQL confirms the
write. A retry must keep the original event ID and time. OCC must never
repeat the chat request to recover an event.

The Gateway queues runtime events on the Agent's persistent Gateway volume
and sends them to OCC in the background. The turn can start without
confirmation from PostgreSQL. The queue survives Pod replacement.
Deleting the Agent removes the queue.

Keep each event until OCC confirms delivery. Retry temporary failures.
Hold other refusals for an operator to retry. Send an event only for its
original revision, source and endpoint. Limit the queue to 256 events
per revision, source and endpoint and 512 per Agent, including held events.
If the queue is full or
unavailable, chat continues. The Gateway warns that events may be missing.

Report a session start when OpenClaw emits `session_start` for a new session.
An empty chat or a first message can create a session without this event.
Record each observed turn start and result with its session and turn IDs.

Give each execution attempt a new ID. Keep the event ID when retrying
delivery. OCC accepts identical copies as one record and rejects a different
record with the same ID. A missing turn result leaves the outcome unknown.

Return runtime records through the Agent audit API. Keep the exact Agent grant
check and save a disclosure record before returning each page. The payload
contains event metadata. The parent RFC defines the separate work for
protected prompt and response storage.

## Acceptance criteria

1. Enable audit once in a disposable installation. Deploy and chat with an
   embedded OpenClaw Agent, a dedicated OpenClaw Agent, and a dedicated Codex
   Agent. Repeat after deploying a new revision of each Agent.
2. Use the Agent audit API to find the exact revision, session, turn, and each
   model attempt from the normal chat workflow. Confirm the same events in
   PostgreSQL. Confirm that a reader without the Agent grant receives no page.
3. Cancel a real turn and interrupt a producer during delivery. Restart the
   producer and retry a delivery. Confirm that a repeated delivery keeps the
   event ID, a new model attempt has a new ID, and a missing result remains
   unknown.
4. Reject a write for another revision and a write after revocation. Check
   that the credential gives no read access.
5. Temporarily refuse the PostgreSQL write for `openclaw.runtime.turn.started`.
   Confirm that the user receives a reply. Restore writes. Confirm that
   the API returns the original event ID once, with no extra model request.
6. Replace the Gateway Pod with an event held for retry. Confirm that the
   operator can retry delivery for the original revision only. Fill the
   queue and confirm that chat continues with a Gateway warning.
7. Disable audit and repeat the normal deployment and chat workflow. Confirm
   that the workflow succeeds and creates no runtime audit records.
8. Stop PostgreSQL during HTTP chat. Send a second request to the API.
   Confirm that OCC queues the interruption, the second receipt and the
   failed access check. Replace the API Pod and restore PostgreSQL.
   Confirm one record per original event ID and no extra model request.
