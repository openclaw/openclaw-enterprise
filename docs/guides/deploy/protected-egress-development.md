# Develop and withdraw the protected egress schema

The schema can be exercised with ordinary unprotected development revisions. The
[protected execution cutoff](../../reference/credential-sources/protected-inference.md#execution-admission-cutoff)
remains closed until the installed pair and its release authority are qualified.

## Upgrade an existing development installation

Keep your database. For a developer on public migration `0063`, this is one
planned control-plane interruption and three forward migrations (`0064`–`0066`).
You do not need to reset volumes or enroll credentials again. The interruption
includes stopping writers, migrating, and restarting the API and workers together.
Allow time for locks and validation, especially if upgrading from `0059`, where
the migration also records that existing Agent revisions ran unprotected.

Stop admitting new work, then finish work you cannot interrupt. If Git is active,
keep the old worker and receipt owner available to settle outstanding issuance,
withdrawal, or possible use before stopping them. A closed session alone does not
prove disposal; follow the [repository custody and recovery procedure](../repository-credentials/installation.md#select-composition-and-network-access)
if the outcome is uncertain. Preserve any spent or possibly spent draft allowance.
The migration does not move a running Agent onto protected Git, enable protected
execution, or turn a finite grant into standing approval. An older controller
cannot read a new [protected Git admission](../../reference/repository-credentials/protected-openshell-git.md).
A preview Agent whose launch cannot be verified may still need to be retired at
Git expiry. Keep execution authority and credential approval separate; broadening
either requires equivalent recorded authority or explicit approval from an authorized binder.

| Database you have                                                         | What to expect                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public `0063`                                                             | Three migrations add protected Driver registration, repository sessions for the Credential Proxy, and a record of each possible draft use. The initial check reports `preProtectedDriverRegistration`.                                                       |
| Public `0059`                                                             | Seven migrations, `0060`–`0066`. The initial check reports `preStaticEgress`.                                                                                                                                                                                |
| Public Credential Proxy preview `0069` or later                           | Keep the original receipts. Preview `0069` corresponds to public `0060` (six migrations remain); preview `0070` corresponds to public `0061` (five remain). The completed history has 75 receipts on this path, 66 on the public path.                       |
| Partial preview `0060`–`0068`                                             | This release stops before changing the database. With writers stopped, finish through `0070` using [the published preview](https://github.com/openclaw/openclaw-enterprise/commit/78b106f1ddc6aa5f638a49c12954be732ab16982), then migrate with this release. |
| Private or divergent history, including experimental `0057_static_egress` | Keep that database and its matching release. Use an upgrade supplied by its owner for that exact history, or start this release with a separate, empty database. Never renumber or rewrite applied receipts.                                                 |

The migrator checks receipt hashes and timestamps, the schema, and effective grants.
A matching count alone is insufficient. Once prior work is settled:

- **Default Docker development stack.** In the old checkout run `bin/occ dev down`
  without `--volumes`. Update the checkout, then run `bin/occ dev up` with the same
  project, volumes, and environment. Startup migrates the retained database.
- **Host development with a retained database.** Stop the API, workers, and other
  writers. From the new checkout, use the existing dedicated
  `OCC_MIGRATION_DATABASE_URL`. Run `pnpm db:migrate --check`, `pnpm db:migrate`,
  then `pnpm db:migrate --check` again. Expect `completed` before starting the
  updated API and workers.
- **Kubernetes or a custom retained stack.** Use the [upgrade checklist](upgrade-checklist.md).
  The disposable Kubernetes development harness deletes volumes on teardown. A
  custom retained Compose or k3d stack has no supported full-stack upgrade command.

There is no in-place downgrade. If you need a recovery point, verify that the old
release accepts a physical snapshot taken with writers stopped; a logical restore
can reparse constraints and change the catalog. If migration fails, verify the old
history before resuming. After a successful migration but before admitting work,
you can restore that snapshot and its matching binaries together. After a new
admission or possible provider send, stop writers and reconcile the effects first.
Never delete a dispatch receipt or replay an operation whose outcome is unknown.

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
