# Develop and withdraw the protected egress schema

The schema can be exercised with ordinary unprotected development revisions. The
[protected execution cutoff](../../reference/credential-sources/protected-inference.md#execution-admission-cutoff)
remains closed until the installed pair and its release authority are qualified.

## Upgrade or withdraw a development installation

Start with a disposable database on the public migration history through
`0057_canonical_harness_auth`. Migrations 0058 through 0065 add protected egress,
credential custody and prepared repository access. Migration checks compare the
receipt ledger, catalog and effective grants. They do not enable protected execution.

If a private database already recorded `static_egress` at 0057 or an earlier slot,
its history conflicts with the public sequence. Keep its writers on their matching
release until you can quiesce and retire that installation; start this version on a
fresh database. Never renumber an applied migration or rewrite its receipt.

Use this order when keeping a development database:

1. **Settle executions on their owning release.** Pause new admissions. Before stopping
   writers or taking the cutover snapshot, stop or withdraw executions admitted by that release,
   including any running anonymous reader. Retire predecessors and verify that no revision is
   active and no cleanup remains. If you cannot settle the work, stay on that release.
   If you need to deploy under that Agent identity again, stay on its owning release. Stopping an
   Agent preserves its revisions; there is no in-place conversion of revision admissions made before migration 0058.
2. **Quiesce writers and verify a physical snapshot.** Stop admission, workers and maintenance
   writers. On PostgreSQL 18.6, `CREATE DATABASE ... TEMPLATE ... STRATEGY FILE_COPY` with the
   same database-level access preserved the catalog and receipt history. A logical restore can
   reparse CHECK expressions and fail the exact catalog check despite reporting success.
   Verify that the previous migration command accepts the restored catalog; keep its matching
   controller, runtime, supplier and configuration revisions.
3. **Migrate once; retain the old Agent for inspection.** Start the matching API and workers
   with `credential_proxy` unselected. The revision list preserves the old identity; revision detail
   reports `SAVED_CONFIGURATION_UNREADABLE` because those revisions recorded no execution admission.
   Deployment reads _all_ revisions so it can stop or retire them; on this Agent it returns 503
   without creating a revision or queuing work. Do not delete the history or invent an
   `execution_admission`. The saved peer admission and credential-source reference are history,
   not authority for the new controller to release that execution.
4. **Resume development on a new, independently authorized Agent.** Use an Agent with no
   pre-cutover revisions, or a fresh disposable installation. In the same Namespace, create a
   new Agent with its own Configuration and service principal; confirm revision 1 is explicitly
   `unprotected`. Nothing adopts the old source, copies a credential or grants access. Do not
   carry forward mounts, helpers or sessions, or arrange delayed reattachment.

Execution authority and material approval are independent. Withhold a new binding unless durable
evidence shows equivalent authority or an authorized binder explicitly admits the broader access.
Permission to update the source is not that consent.

If the migration transaction fails, verify the previous history before resuming
the old installation. After a successful migration, switching binaries alone
does not restore the old writer contract. Before admitting any work, withdrawal
can restore the quiesced snapshot and its matching binaries as a unit. After
new admissions or a possible provider send, stop writers and reconcile those
effects first. Never delete a dispatch receipt or replay an uncertain operation to
make a rollback appear clean.

## Select fresh whole-execution protection

This selection requires explicit whole-execution authority and the current paired
Compute release and OpenShell custody profiles. An earlier executable-scoped
selection cannot authorize this principal. Keep its existing restrictions until
an authorized binder admits the broader access.

Keep the existing [OpenShell Backend and Sandbox configuration](../../reference/drivers/openshell-credential-gateway.md).
Add the same egress Driver ID to `backend[].drivers.credential_proxy` and select:

```yaml
drivers:
  credential_proxy:
    id: openshell-egress
    configuration:
      middlewareName: oce-authority
      authorityScope: execution
      authority:
        host: 127.0.0.1
        port: 9444
        certificatePath: /etc/openclaw/egress/tls/tls.crt
        privateKeyPath: /etc/openclaw/egress/tls/tls.key
        issuerPublicKeyPath: /etc/openclaw/egress/issuer/issuer.pub
        issuer: openshell-gateway:openshell-gateway
        audience: oce-egress
        keyId: current
```

The API owns this TLS listener; the worker does not open another listener.
Development requires loopback. Production requires an explicitly configured
reachable host and operator-provided TLS and issuer trust. The existing Backend
must use explicit HTTPS and [bearer-file or mTLS authentication](../../reference/backends.md#openshell-gateway).
All phases of an operation must reach
the same authority process; outstanding handles are local and restart fails
closed. It allows at most 1,024 pending or outstanding operations, reserving
capacity before authentication or storage awaits, and 4,096 replay reservations.
Excess traffic refuses. Protected request IDs are canonical UUIDv7 values whose
embedded creation time fixes the replay horizon at creation plus 30 seconds,
independent of JWT expiry or a shorter submitted deadline. Creation may be at most
one second ahead of the authority clock; the deadline must be future and within
that fixed horizon. Reusing an ID cannot extend it. A new ID does not authorize
automatic retry after possible effects. Shared state for replicated authority
processes is not implemented.

The operator registers the authority as `[[openshell.supervisor.middleware]]`
with `grpc_endpoint`, `audience`, `tls_ca_cert_path`, and a 4 MiB payload
bound. Gateway signing uses `[openshell.gateway.gateway_jwt]`. Insecure transport
is unsupported. Both peers must negotiate
`openshell.supervisor-middleware.http-credential-access.v1`.

### Helm packaging

The OCE chart's `egressAuthority.enabled` defaults to `false`. When enabled, set
`port` to the authority listener port, `tlsSecretName` to a Secret with `tls.crt`
and `tls.key`, and `issuerSecretName` to a Secret with `public.pem`. The chart
mounts these at the example paths above on the API only. It exposes a ClusterIP
Service named `openclaw-enterprise-egress-authority`, with a NetworkPolicy limited
to `clients`: each entry must contain an explicit `namespaceSelector` and
`podSelector.matchLabels`. Select only the Gateway and trusted supervisors.
The Installation's production listener host must accept that Service traffic;
use its exact DNS name in the server certificate and middleware endpoint.

For native mTLS, `backend.openshell.clientSecretName` projects `ca.crt`, `tls.crt`
and `tls.key` under `/etc/openclaw/openshell` into the API and worker. It does not
project those credentials to Agents or bootstrap/migration Jobs. The issuer's
private signing key is never selected by the authority volume. The supervisor
receives public authority trust through the supplier's middleware registration.

The [protected local launch profile](../../guides/deploy/local-openshell-images.md#select-the-protected-profile)
creates these bindings and TLS inputs, uses native OpenShell PKI, and installs
the authority before waiting for Gateway readiness. Neither chart configuration
nor successful startup qualifies connected enforcement; follow the
[verification boundary](../../testing/static-egress.md#protected-launch-packaging).
