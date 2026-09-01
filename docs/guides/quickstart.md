# Quickstart

Start OpenClaw Control Center (OCC) locally and read its Installation through
an authenticated API request. This proves the controller is usable; it does not
deploy an Agent or make a model call.

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
file.

Expected output includes:

- the API URL, normally `http://127.0.0.1:3000`
- the server-assigned Installation ID
- the service-key file path, pointing at an owner-readable JSON file
- a command you can copy to check that the API accepts your service key

## Read the Installation with the bootstrap service key

`dev-up` runs this check before it reports success. To run it again, copy the
command under `Check API access again` in the output. It already includes your
API URL and service-key file path. You can also set them yourself:

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
stays with the operator; it is separate from the Agent gateway token and model
credential and must never enter a workload or TUI.

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
the database, Configuration, and bootstrap-key volumes. Use
`docker compose down --volumes` only when intentionally deleting the local
Installation.

For environment configuration, production installation, and optional Agent/TUI
proof, continue to [Deploy OpenClaw Enterprise](deploy.md). For supported
resource operations, see the [feature reference](../reference/README.md).

For startup errors, see
[development verification](deploy.md#verify-development).
