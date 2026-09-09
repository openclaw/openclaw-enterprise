# Quickstart

Start [OpenClaw Control Center (OCC)](concepts.md#control-plane-and-tenancy)
locally and read its Installation through an authenticated API request. This
proves the controller is usable; it does not deploy an
[Agent](concepts.md#agents-and-revisions) or make a model call.

You need Docker Engine with Docker Compose, Bash, `curl`, and Python 3. Run
commands from the repository root.

## Start the local stack

Run the helper:

```bash
./scripts/dev-up
```

On the default path, the helper creates a local quickstart runtime image only
when it is needed, validates Docker Compose configuration without logging
expanded credentials, starts PostgreSQL, migration, bootstrap, API, and worker
services, then copies the bootstrap service-key response into a private local
file. Fresh bootstrap also creates the initial platform
[Namespace](concepts.md#control-plane-and-tenancy) named `default`; the worker
provisions its backing infrastructure.

The helper reuses an existing runtime image tag. After changing the runtime
recipe or package versions, [rebuild and verify the image](../../deploy/runtime/README.md#rebuild-an-existing-image)
before running the helper again.

Expected output includes:

- the API URL, normally `http://127.0.0.1:3000`
- the server-assigned Installation ID
- the service-key file path, pointing at an owner-readable JSON file
- a command you can copy to check that the API accepts your service key

## Open the platform console

Open `/console/` on the API URL printed by `dev-up`, normally
`http://127.0.0.1:3000/console/`. Enter the provisioned human account email in
**Username** and its password. An existing database keeps its original password.
No service key is needed for browser login.

The [console](../reference/console.md) lists accessible Agents, Providers, and
Namespaces. It can create an Agent with editable starter Configuration JSON and edit
supported Slack or Microsoft Teams channel settings during creation and on the saved
Configuration draft. On Kubernetes, provision initial OpenAI and Slack credentials
from the saved Agent draft, then select **Deploy saved draft**,
then open **Workspace files** to edit the four supported files once the gateway is ready.
It does not list Configurations, delete Agents, or report
live gateway health. A fresh Installation has a `default` Namespace and no
Agents; provision resources and access through the API procedures in the
deployment guide. Use the bottom **OpenClaw Enterprise** menu to select a
Namespace, open Settings, or log out. The API check below remains useful for
programmatic access.

## Read the Installation with the bootstrap service key

`dev-up` runs this check before it reports success. To run it again, copy the
command under `Check API access again` in the output. It already includes your
API URL and [service-key](concepts.md#identity-and-access) file path. You can also
set them yourself:

```bash
export OCC_URL='http://127.0.0.1:3000'
export OCC_SERVICE_KEY_FILE='/private/path/initial-admin-service-key.json'
scripts/occ-api GET /installation
```

Expect HTTP `200` and JSON containing the Installation `id` and name. The
Installation ID must match `meta.installationId` in the service-key response.
The helper sends the key as `x-api-key` without exposing it in process
arguments or terminal output.

Export `OCC_URL` and `OCC_SERVICE_KEY_FILE` if you are continuing to
[Development end-to-end TUI](deploy.md#development-end-to-end-tui). The OCC key
stays with the operator; it is separate from the Agent
[gateway](concepts.md#gateways-and-harnesses) token and model credential and must
never enter a workload or TUI.

## Find the initial Namespace

```bash
scripts/occ-api GET /namespaces
```

On a fresh Installation, expect one Namespace named `default` with a
server-assigned `id`. Use that ID for Namespace-scoped API paths and wait for
`status: "ready"` before deploying an Agent. Bootstrap success does not imply
that worker provisioning has finished.

## Clean up and stop

If you are stopping after this API check, remove only the temporary local key
copy printed by `dev-up`, then stop Compose. If you exported the variables above:

```bash
rm -- "$OCC_SERVICE_KEY_FILE"
test -z "${OCC_SERVICE_KEY_DIRECTORY:-}" || rmdir -- "$OCC_SERVICE_KEY_DIRECTORY"
unset OCC_SERVICE_KEY_FILE OCC_SERVICE_KEY_DIRECTORY
docker compose down
```

Local cleanup does not revoke the service key. `docker compose down` preserves
the database, [Configuration](concepts.md#configuration-and-secrets), and
bootstrap-key volumes. Use
`docker compose down --volumes` only when intentionally deleting the local
Installation.

For environment configuration, production installation, and optional Agent/TUI
proof, continue to [Deploy OpenClaw Enterprise](deploy.md). For supported
resource operations, see the [feature reference](../reference/README.md).

For startup errors, see
[development verification](deploy.md#verify-development).
