# Develop and withdraw the protected egress schema

The schema can be exercised with ordinary unprotected development revisions. The
[protected execution cutoff](../../reference/credential-sources/protected-inference.md#execution-admission-cutoff)
remains closed until the installed pair and its release authority are qualified.

## Upgrade an existing development installation

Stop the API, workers and other writers before updating. Run `pnpm db:migrate --check`
with the existing dedicated `OCC_MIGRATION_DATABASE_URL`. The unchanged main schema
through `0059` reports `preCredentialProxy`: 59 receipts. Run `pnpm db:migrate`, then
`pnpm db:migrate --check` again. Expect `completed` with 62 receipts before restarting
the updated API and workers. Older writers cannot supply the required source owner
or execution admission; mixed-version operation is unsupported.

The update retains Gateway ownership of existing sources and records pre-proxy
Agent revisions as unprotected. It does not grant new repository access, create
standing approvals or claim that any delivery occurred. Protecting a new revision
still requires the [qualified execution path](../../reference/credential-sources/protected-inference.md#execution-admission-cutoff).

Intermediate pre-merge preview histories are refused before mutation. Keep their
matching release and database available. Use a fresh preview or deliberately reset
and reseed a disposable preview. Never delete or relabel migration receipts. If an
old worker might have issued, installed, detached or sent material, fence that
worker and its recipient and reconcile under the pinned release. Otherwise leave
the operation unresolved and use a distinct disposable execution. An unknown
result does not authorize another send.

## Select fresh whole-execution protection

The configuration below is for a future qualified release. It requires explicit whole-execution
authority and the current paired Compute release and OpenShell custody profiles. An earlier executable-scoped
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
