# Develop and withdraw the protected egress schema

The schema can be exercised with ordinary unprotected development revisions. The
[protected execution cutoff](../../reference/credential-sources/protected-inference.md#execution-admission-cutoff)
remains closed until the installed pair and its release authority are qualified.

## Upgrade an existing development installation

From public migration `0059`, keep your database and plan one control-plane
restart. Migration `0060_credential_proxy` records that existing Agent revisions
ran unprotected, restores their immutability, and validates the constraint.
Reading the same Agent and revision remains supported; old writers must stop before
migration. Allow time for row updates, locks, and validation on a large history.
Migration `0061_openshell_expired_git` adds the retained-launch state used at Git
expiry. Neither migration selects protected execution or requires credential re-enrollment.

- **Default Docker development stack.** Finish work that must not be interrupted.
  In the old checkout run `bin/occ dev down` without `--volumes`, update your
  checkout, then run `bin/occ dev up` with the same project, volumes, and
  environment. Startup migrates the retained database. A new checkout with an
  empty database needs only `bin/occ dev up`.
- **Host development with a retained database.** Quiesce the API, workers, and
  other writers. With the new checkout and the existing dedicated
  `OCC_MIGRATION_DATABASE_URL`, run `pnpm db:migrate --check` (expect
  `preStaticEgress` at `0059`), `pnpm db:migrate`, then `pnpm db:migrate --check`
  (expect `completed`). Restart the API and workers from that checkout.
- **Kubernetes or a custom retained stack.** Follow the
  [upgrade checklist](upgrade-checklist.md). The disposable Kubernetes development
  harness deletes volumes on teardown; the Docker down/up instructions above do
  not apply. A custom retained Compose or k3d stack has no supported in-place
  full-stack upgrade command.

If you ran the public Credential Proxy preview, the migrator checks the actual
receipts, schema, and grants. At preview `0069`, migrate normally: the release
applies the same final SQL. At preview `0070`, the check reports `completed` and
the original receipts stay intact. At preview `0060` through `0068`, this release
stops before changing the database. Keep writers stopped, finish the migration
through `0070` using [the published preview source](https://github.com/openclaw/openclaw-enterprise/commit/78b106f1ddc6aa5f638a49c12954be732ab16982),
then switch to this release and check again. A preview Git route without a
verified retained launch may still require retiring that Agent at Git expiry.

For a divergent history, including experimental `static_egress` at `0057`, keep
the database with its matching release. Never renumber or rewrite applied receipts.
If you need a recovery point, verify that the previous release accepts a quiesced
physical snapshot; a logical restore can reparse constraints and change the catalog.

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
