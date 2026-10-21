# Develop and withdraw the protected egress schema

The schema can be exercised with ordinary unprotected development revisions. The
[protected execution cutoff](../../reference/credential-sources/protected-inference.md#execution-admission-cutoff)
remains closed until the installed pair and its release authority are qualified.

## Upgrade an existing development installation

Keep your database. From public migration `0068`, plan one control-plane interruption to
apply `0069_repository_git_online_authorization` and restart the API and workers together.
The migration preserves existing receipts, grants, approvals and records of possible use.
Once the migration is complete and the API and workers are back, stop here and resume ordinary
unprotected development. Leave your Installation and Helm configuration as they are, and keep new
[protected Git admissions](../../reference/repository-credentials/protected-openshell-git.md)
closed until the installed sender and release are qualified.

Stop admitting work and finish work you cannot interrupt. If you already use protected Git
but cannot verify its sender, stop new use. Keep the original worker, sender, receipt owner
and keys available to [settle issuance, possible use and retirement](../repository-credentials/installation.md#select-composition-and-network-access).
Closing a session does not prove disposal or restore a possibly spent draft allowance. A preview
Agent whose launch cannot be verified may still need to be retired at Git expiry.
Fence old writers before starting their replacements.

Use the migrator to identify your history. It checks receipt hashes and timestamps, the
schema and effective grants. A migration number or receipt count alone cannot select a path.

| Database you have                                                         | What the first check means                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public `0068`                                                             | `preRepositoryGitOnlineAuthorization`: one migration remains (`0069`).                                                                                                                                                                                    |
| Public `0067`                                                             | `preCredentialProxyGitHubInstallation`: two migrations remain.                                                                                                                                                                                            |
| Public `0066`                                                             | `preProtectedRepositoryGitRecipients`: three migrations remain.                                                                                                                                                                                           |
| Public `0063`                                                             | `preProtectedDriverRegistration`: six migrations remain (`0064`–`0069`).                                                                                                                                                                                  |
| Public `0059`                                                             | `preStaticEgress`: ten migrations remain (`0060`–`0069`), including recording that existing Agent revisions ran unprotected.                                                                                                                              |
| Published Credential Proxy preview, through `0069` or later               | Preview `0069` corresponds to public `0060` (nine migrations remain); preview `0070` corresponds to public `0061` (eight remain). Keep the original receipts: this path finishes with 78, the public path with 69.                                        |
| Partial preview `0060`–`0068`                                             | Migration stops before changing the database. With writers stopped, finish through `0070` using [the published preview](https://github.com/openclaw/openclaw-enterprise/commit/78b106f1ddc6aa5f638a49c12954be732ab16982), then migrate with this release. |
| Private or divergent history, including experimental `0057_static_egress` | Keep that database with its matching release. Get an upgrade for that exact history from its owner, or start this release with a separate, empty database. Never renumber or rewrite applied receipts.                                                    |

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

For a future qualified release, upgrade every controller, worker and the paired Sandbox and
Credential Proxy Driver before admitting a revision with online authorization (v5). Older
controllers cannot read that admission.
An existing v4 admission still requires its sender to start sending by the recorded deadline.
Nothing converts it to v5, which requires authorization before each new request. In v5 the
deadline is for the authorization reply, and a request already allowed can finish after withdrawal.
Neither execution authority nor credential approval expands with this upgrade.

There is no in-place downgrade. If you need a recovery point, verify that the old
release accepts a physical snapshot taken with writers stopped; a logical restore
can reparse constraints and change the catalog. If migration fails, verify the old
history before resuming. After a successful migration but before admitting work,
you can restore that snapshot and its matching binaries together. After a new
admission or possible provider send, stop writers and reconcile the effects first.
Never delete a dispatch receipt or replay an operation whose outcome is unknown.

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
