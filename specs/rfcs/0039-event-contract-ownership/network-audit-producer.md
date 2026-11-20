---
rfc: index.md
---

# Network decisions from OpenShell

An Agent audit reader needs to know when a Sandbox blocked a connection.
Use the security events from the OpenShell supervisor that enforces the
network policy. Record each supported decision as
`openclaw.runtime.policy.decided` with `policy: network_policy`.

## Enroll the Sandbox

Use the `legacy` Sandbox integration, which creates one Sandbox per Agent
revision. With the `service` integration, the Sandbox ID survives a revision
change. Its delayed exports need a workload identifier before OCC can
attribute them to a revision.

The Installation administrator enables Control Plane audit and configures the
OpenShell security event exporter. The OpenShell Sandbox Driver obtains the
provider's Sandbox ID when it creates or verifies a Sandbox for an Agent
revision. It registers the ID with the OpenClaw Control Plane (OCC). A retry
for the same Sandbox and revision preserves the registration. Cleanup or
replacement withdraws the previous ID. OCC also requires an active audit
registration for the revision at the time of the write.

## Authenticate the exporter

The administrator gives a dedicated credential to the OpenShell Gateway for
its OCSF exporter and to the OCC API that validates exports. OpenShell 0.1.8
passes the exporter credential to its supervisors. The credential authenticates
the OpenShell service for the Installation. Its Gateway and supervisors form
one trust boundary. A compromised supervisor with this credential could forge
records for another enrolled Sandbox served by the same Installation. The
Agent workload and its Gateway must never receive this credential.

Accept an authenticated OTLP batch on the private HTTPS listener. Require
matching Sandbox IDs in the resource, record and OCSF body. Derive Agent and
revision from the saved registration. Only this exporter can report network
decisions. Drop unrelated records and events for unenrolled Sandboxes.

## Save the decision

Keep the event identity, source timestamp, decision, Sandbox ID and revision
scope. The supervisor may know only the Sandbox that opened the connection.
Leave turn and invocation IDs absent in this case. Exclude addresses, request
content and free text. Return records through the existing Agent audit API
with its exact grant and disclosure check.

OpenShell exports observations after enforcement. Acknowledgement follows the
PostgreSQL commit. Identical retries return one record. A source outage or a
full exporter queue can cause loss.

## Verification

Check a managed Sandbox through normal deployment, an actual network decision
and its record in the authorized Agent audit API. Check redelivery, conflicting
event IDs, mismatched Sandbox IDs, cleanup and credential separation. Verify
that the Agent's audit credential cannot report a network decision.
