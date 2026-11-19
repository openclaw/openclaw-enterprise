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
- Dedicated OpenClaw runs model requests in a worker. The worker sends its
  observations to the Gateway over the existing authenticated connection.
- Dedicated Codex sends model requests from the App Server. It reports each
  observed attempt to the Gateway over the App Server connection.

Only the Gateway needs the credential for OCC. The credential identifies
one revision. OCC trusts that runtime to report its own activity. Code with
the same operating system identity as the Gateway can affect its records.
This includes tools in an embedded runtime. A compromised revision can
omit or falsify its own observations. OCC must prevent it from writing for
another revision or using the credential to read records.

## Write and read behavior

OCC authenticates each producer and obtains its scope from the saved
registration. It rejects events for another revision and actions outside the
producer's role. OCC uses the existing PostgreSQL audit log.

The producer saves required admission evidence before it starts covered work.
If it cannot save that evidence, it stops admission and reports the failure.
It gives each new execution attempt a new ID. It keeps an event's ID when it
retries delivery. OCC accepts identical copies as one record and rejects a
different record with the same event ID. If the producer stops before it
observes the result, the result remains unknown.

Return the records through the Agent audit API. Keep the exact Agent grant
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
   that the credential gives no read access. Reject a
   required admission write and confirm that execution does not start.
5. Disable audit and repeat the normal deployment and chat workflow. Confirm
   that the workflow succeeds and creates no runtime audit records.
