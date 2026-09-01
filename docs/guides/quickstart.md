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
- a `Next authenticated check` command with `OCC_URL` and
  `OCC_SERVICE_KEY_FILE` set for one request

The default administrator is `admin@openclaw.local` with password
`openclaw-development-password`. These credentials are for loopback development
only. Set `OPENCLAW_DEV_EMAIL`, `OPENCLAW_DEV_PASSWORD`, `OPENCLAW_DEV_PORT`, or
runtime image variables before first startup when you need a nondefault local
stack. Reusing an existing database preserves its original accounts and
passwords.

## Read the Installation with the bootstrap service key

`dev-up` runs this check before it reports success. To repeat it, run the
printed `Next authenticated check` command, or export both values and call the
helper:

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

## Sign in and read the Installation

Use this optional human sign-in for key recovery, key issuance with human
authority, or account-only APIs. The startup and TUI path above uses the
bootstrap service key. After the controller is healthy, enter the original
configured development credentials at the prompts below. Python JSON-encodes
them and pipes them directly to curl; the password is hidden during entry. The
session cookie stays in a unique private directory.

```bash
set -o pipefail
umask 077
export OCC_URL="http://$(docker compose port controller 3000)"
OCC_SESSION_DIRECTORY="$(mktemp -d)"
export OCC_SESSION_COOKIE_JAR="$OCC_SESSION_DIRECTORY/cookies"
python3 -c 'import getpass, json, sys; print("Administrator email: ", end="", file=sys.stderr, flush=True); email=sys.stdin.readline().strip(); password=getpass.getpass("Administrator password: "); print(json.dumps({"email": email, "password": password}))' |
  curl --fail-with-body --silent --show-error --cookie-jar "$OCC_SESSION_COOKIE_JAR" "$OCC_URL/api/auth/sign-in/email" -H 'Content-Type: application/json' --data-binary @- --output /dev/null
curl --fail-with-body --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" "$OCC_URL/installation"
```

Expect HTTP `200` and JSON containing the Installation's server-assigned `id`
and name. Use `--cookie "$OCC_SESSION_COOKIE_JAR"` only for the protected
requests that need this human session. If sign-in fails after a password change,
the database still expects the original bootstrapped account password.

### Sign out and stop

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
  --request POST "$OCC_URL/api/auth/sign-out" --output /dev/null
rm -- "$OCC_SESSION_COOKIE_JAR"
rmdir -- "$OCC_SESSION_DIRECTORY"
docker compose down
```

Stopping Compose preserves the database, Configuration, and bootstrap-key
volumes. For startup errors, see
[development verification](deploy.md#verify-development).
