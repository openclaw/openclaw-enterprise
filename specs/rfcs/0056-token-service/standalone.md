---
rfc: index.md
---

# Standalone operator leases

Preserve the [standalone workflow](../../../docs/guides/repository-credentials/standalone-service.md).
`tokenService.mode` defaults to `occ`; `standalone` selects a separate deployment
without OCC, IAM, or an OCC database. Its configured service ID identifies the
instance; no Installation, Namespace, Agent, or revision is fabricated. Standalone
grants omit `namespaces`; OCC grants require them. Grant and Driver IDs are unique
within the service. The modes
reject each other's admission types; standalone is never an OCC fallback.

The operator starts the service with protected configuration, issuer keys, TLS,
and `tokenService.controlSocket`, a private Unix socket. Standalone mode rejects
OCC-only `control`, `state`, and `controlClient` settings; OCC mode rejects
`controlSocket`. To open a lease, the operator selects a configured
grant ID, bounded duration, and new protected output directory. The CLI generates
and prints a nonsecret admission ID before dispatch. Socket access
authorizes the request within configured grants; internal metadata grants are
not selectable. The service fixes owner, grant, deadline, and admission ID in a
process-local record before returning opaque client material once. Its
`leasePolicy.maximumDurationSeconds` still caps session duration: standalone
clients have no Agent lifecycle to govern indefinite access. The CLI writes
it without printing credentials. Clients receive only those files and use the
HTTPS gateway, which cannot admit leases. Status and close use the control socket.

Duplicate admission IDs recover status, not credentials. Admission records and
token custody remain process-local: restart invalidates bearers and loses recovery
state, never proves revocation, and leaves missing cleanup evidence unresolved.
After an ambiguous open response, use the same admission ID for status recovery
and close any recovered lease before explicitly requesting replacement material.
Do not blindly replace uncertain admissions. Managed Agent bearer persistence
and the managed GitHub restart-recovery exception do not apply here. Upstream
credential storage remains memory-only in both modes; scope, deadline, capacity, and cleanup rules still
apply. Startup rejects OCC-only Backend/RepoDriver bindings in standalone
configuration. Mode selection cannot disable OCC's durable nonsecret admission
records for OCC-managed leases.

## Verification

Exercise the emitted operator CLI and real service without OCC: open a configured
grant, use its client files for Git/`gh`, inspect status, and close the lease.
Verify grant and duration rejection, no credential printing, one-time material
delivery, duplicate admission recovery, expiry, and pending cleanup. Restart must
reject old bearers and report uncertainty rather than claim old tokens revoked.
Verify each deployment mode rejects the other's admission type.
