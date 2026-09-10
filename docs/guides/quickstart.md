# Quickstart

Start [OpenClaw Control Plane (OCC)](concepts.md#control-plane)
locally, sign in to the console, and read the Installation through an
authenticated API request. This proves controller access; it does not deploy an
[Agent](concepts.md#agents-and-revisions) or make a model call.

You need either Docker Engine with Docker Compose, or Podman with
`podman-compose` and `yq` v4. Bash, `curl`, and Python 3 are also required.
Podman needs no `docker` alias. Run commands from the repository root.

## Start the local stack

```bash
./scripts/dev-up
```

The helper selects a usable Docker Engine or falls back to Podman, validates the
resolved Compose configuration without logging expanded credentials, starts
PostgreSQL, migration, bootstrap, API, and worker services, then copies the
bootstrap service-key response into a private local file. Fresh bootstrap also
creates the initial platform
[Namespace](concepts.md#tenancy) named `default`.

The helper reuses the local quickstart runtime image tag. After changing the
runtime recipe or package versions, [rebuild and verify the image](../../deploy/runtime/README.md#rebuild-an-existing-image)
before rerunning it.

Expected output includes:

- `OpenClaw Enterprise development stack is ready.`
- the selected container engine
- the API URL, usually `http://127.0.0.1:3000`
- the Installation ID
- the owner-readable service-key file path
- a copy-paste API check

## Open the platform console

Open `/console/` on the API URL printed by `dev-up`, normally
`http://127.0.0.1:3000/console/`. For a fresh database with default settings, use
`admin@openclaw.local` as **Username** and `openclaw-development-password` as the
password. If you set `OPENCLAW_DEV_EMAIL` or `OPENCLAW_DEV_PASSWORD` in `.env` or
the environment, use those values; see [development settings](../reference/settings/development.md#required-development-controller-environment).
An existing database keeps its original password. Browser login uses the human
session path, not service keys.

A fresh Installation has a `default` Namespace and no Agents. Use the
[console reference](../reference/console.md) for supported pages, Agent creation,
credential provisioning, deployment, workspace files, and limits.

## Read the Installation with the bootstrap service key

`dev-up` already checks API access. To repeat the check and run the remaining
commands, export the URL and service-key path printed by the helper:

```bash
export OCC_URL='http://127.0.0.1:3000'
export OCC_SERVICE_KEY_FILE='/private/path/initial-admin-service-key.json'
scripts/occ-api GET /installation
```

Expect HTTP `200` and JSON containing the Installation `id` and name. The
Installation ID must match `meta.installationId` in the service-key response.
The helper sends the [service key](concepts.md#identity-and-access) as
`x-api-key` without exposing it in process arguments or terminal output.

Keep these variables for the
[development TUI procedure](deploy/local-operations.md#development-end-to-end-tui). The OCC key
stays with the operator. It is separate from the Agent
[gateway](concepts.md#gateways-and-harnesses) token and model credential and
must never enter a workload or TUI.

## Find the initial Namespace

```bash
scripts/occ-api GET /namespaces
```

On a fresh Installation, expect one Namespace named `default` with a server-assigned `id`. Use that ID
for Namespace-scoped API paths and wait for `status: "ready"` before deploying
an Agent.

## Clean up and stop

If you are stopping after this API check, remove only the temporary local key
copy printed by `dev-up`, then run the exact command under `Cleanup` in its
output. That command includes the Podman socket and override when Podman was
selected:

```bash
rm -- "$OCC_SERVICE_KEY_FILE"
test -z "${OCC_SERVICE_KEY_DIRECTORY:-}" || rmdir -- "$OCC_SERVICE_KEY_DIRECTORY"
unset OCC_SERVICE_KEY_FILE OCC_SERVICE_KEY_DIRECTORY
# Run the Cleanup command printed by dev-up.
```

Local cleanup does not revoke the service key. Compose `down` preserves the
database, [Configuration](concepts.md#configuration-and-secrets), and
bootstrap-key volumes. Add `--volumes` to the printed cleanup command only when
intentionally deleting the local Installation.

Next, use [Deploy OpenClaw Enterprise](deploy.md) for production installation,
customization, Agent/TUI proof, and startup-error diagnosis. For supported
resource operations, see the [feature reference](../reference/README.md).
