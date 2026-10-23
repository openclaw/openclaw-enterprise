# Run the native repository sender

Production GitHub App issuance belongs to the worker Token Service. The standalone
native process cannot sign or issue tokens. Configure its prepared registry and
worker socket through the [Kubernetes installation](installation.md), or select
an [installed protected sender](../../reference/drivers/selection.md#select-a-protected-sender).

<a id="build-and-validate"></a>
<a id="open-and-use-a-session"></a>
<a id="recover-an-admission"></a>
<a id="container-images"></a>
<a id="inspect-and-close"></a>

For local, independent clients, use the explicit
[development token procedure](../../reference/repository-credentials/development-token.md).
Both `developmentOnly: true` and `--development-authority` are required. This
profile is not available through production Kubernetes projections.

Build and validate a prepared configuration from the repository root:

```sh
pnpm credentials:build
pnpm credentials:check-config /absolute/path/service.json
```

The check reads protected configuration, registry and TLS files without opening
a listener or contacting GitHub. The native package excludes signing and issuance
modules. The [configuration reference](../../reference/repository-credentials.md#standalone-service-inputs)
defines file ownership and policy requirements.

## Drain an existing signing gateway

Old `github-app` and `github-app-registry` inputs fail startup. An empty installation
can select prepared delivery directly. If an existing owner has accepted work:

1. Stop new repository admissions and retire the affected Agents through their normal
   lifecycle. Keep the original owner running with its existing protected inputs.
2. For each recorded session ID, inspect and close the session through that owner's
   private socket. Use the operator client from the same release as the owner:

   ```sh
   pnpm credentials:operator status --socket /path/to/original/control.sock --session SESSION_ID
   pnpm credentials:operator close --socket /path/to/original/control.sock --session SESSION_ID
   pnpm credentials:operator status --socket /path/to/original/control.sock --session SESSION_ID
   ```

3. Require each known session's cleanup to reach `DISPOSED` with no pending, uncertain
   or active use. Reconcile retained admission and cleanup records through their original
   owner. A missing session, unavailable owner, or lost acknowledgment is not proof of
   cleanup. Keep that owner and its inputs until an authorized operator resolves the
   outstanding work; do not transfer the key or replay an uncertain issuance or PR creation.
4. When no accepted work remains, replace the original owner and select prepared delivery.
   Preserve any unresolved operation's identity and evidence for its original owner.
