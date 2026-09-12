# Service API keys for automation

Use service keys for operator automation after startup has succeeded. Set
`OCC_URL` to the loopback development URL or approved production HTTPS endpoint.
Run commands from the repository root. Keep shell tracing and curl verbose output disabled.

## Retrieve the bootstrap service key

Development `dev-up` prints the private local key path after it copies the key.
For a manual copy, create a fresh private directory:

```bash
umask 077
export OCC_SERVICE_KEY_DIRECTORY="$(mktemp -d)"
export OCC_SERVICE_KEY_FILE="$OCC_SERVICE_KEY_DIRECTORY/initial-admin-service-key.json"
docker compose cp bootstrap:/var/lib/openclaw/bootstrap/initial-admin-service-key.json \
  "$OCC_SERVICE_KEY_FILE"
chmod 600 "$OCC_SERVICE_KEY_FILE"
```

For production, retrieve the same basename from the protected bootstrap PVC
through approved storage access and store it in `$OCC_SERVICE_KEY_FILE`.
Validate it immediately:

```bash
scripts/occ-api GET /installation
```

Expect HTTP `200` with response `data.id` matching `meta.installationId`. The
initial service key expires after 30 days.

## Recover an incomplete bootstrap

Bootstrap makes one attempt. On failure, preserve logs, non-secret IDs, and
protected output. Confirm database commit state before deleting anything. If the
attempt did not commit, remove only proven orphan accounts/keys and quarantine
only that attempt's output. If it did commit, retain the credentials and use
normal key recovery. Never delete output, reset the database, or rerun bootstrap
as an automatic fallback.

## Recover a lost or exposed service key

With retained key/principal IDs, sign in as the human administrator, revoke the
old key, then [issue a replacement](#issue-a-service-key). Without retained IDs,
inspect only non-secret key metadata and IAM bindings to identify the exact key.
Do not export secret key values, password hashes, sessions, or full table dumps.

## Sign in as a human administrator

Use human sign-in for key recovery, human-issued keys, or account-only APIs:

```bash
set -o pipefail
umask 077
export OCC_URL='https://<internal-occ-host>'
export OCC_ADMIN_EMAIL='<first-admin@example.com>'
export OCC_ADMIN_PASSWORD_FILE='/secure/occ/initial-admin-password'
OCC_SESSION_DIRECTORY="$(mktemp -d)"
export OCC_SESSION_COOKIE_JAR="$OCC_SESSION_DIRECTORY/cookies"
python3 -c 'import json, os, pathlib, sys; json.dump({"email": os.environ["OCC_ADMIN_EMAIL"], "password": pathlib.Path(os.environ["OCC_ADMIN_PASSWORD_FILE"]).read_text().rstrip("\n")}, sys.stdout)' |
  curl --fail-with-body --silent --show-error --cookie-jar "$OCC_SESSION_COOKIE_JAR" "$OCC_URL/api/auth/sign-in/email" -H 'Content-Type: application/json' --data-binary @- --output /dev/null
curl --fail-with-body --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" "$OCC_URL/installation"
```

Development may use `OCC_URL="http://$(docker compose port controller 3000)"`
with the configured development administrator credentials. Sign out when done:

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
  --request POST "$OCC_URL/api/auth/sign-out" --output /dev/null
rm -- "$OCC_SESSION_COOKIE_JAR"
rmdir -- "$OCC_SESSION_DIRECTORY"
```

## Issue a service key

Issue into an owner-readable file. Omit `namespaceId` only for an
Installation-scoped principal:

```bash
umask 077
export OCC_SERVICE_KEY_DIRECTORY='/secure/occ/service-keys'
install -d -m 700 "$OCC_SERVICE_KEY_DIRECTORY"
export OCC_SERVICE_KEY_FILE="$(mktemp "$OCC_SERVICE_KEY_DIRECTORY/key.XXXXXX")"
curl --fail --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" \
  "$OCC_URL/api/auth/service-keys" -H 'Content-Type: application/json' \
  --data '{"servicePrincipalId":"<service-principal-id>","namespaceId":"<namespace-id>","name":"nightly-reader","expiresIn":2592000}' \
  --output "$OCC_SERVICE_KEY_FILE"
```

Expect HTTP `201`. The response contains the one-time `data.key` and non-secret
`data.id` for revocation.

## Use a service key

```bash
export OCC_NAMESPACE_ID='<namespace-id>'
scripts/occ-api GET "/namespaces/$OCC_NAMESPACE_ID"
```

Expect HTTP `200` for an authorized Namespace, `401` for invalid/expired keys,
and `403` for authenticated principals missing exact IAM permission.

## Revoke or rotate a service key

```bash
OCC_SERVICE_KEY_ID="$(python3 -c 'import json, os, pathlib; print(json.loads(pathlib.Path(os.environ["OCC_SERVICE_KEY_FILE"]).read_text())["data"]["id"])')"
curl --fail --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" \
  --request DELETE "$OCC_URL/api/auth/service-keys/$OCC_SERVICE_KEY_ID"
```

Expect HTTP `200` and `data.revoked: true`; the old key should then return
`401`. To rotate, issue a replacement, switch the client, verify access, then
revoke the old key.

## Manage keys with a service administrator

An Installation-scoped non-Agent ServicePrincipal with current `administer`
authority can issue and revoke keys without a human cookie. Send its protected
key through stdin as a header file:

```bash
python3 -c 'import json, os, pathlib, sys; key=json.loads(pathlib.Path(os.environ["OCC_ADMIN_SERVICE_KEY_FILE"]).read_text())["data"]["key"]; sys.stdout.write("x-api-key: " + key + "\n")' |
  curl --fail --silent --show-error --header @- "$OCC_URL/api/auth/service-keys" \
  -H 'Content-Type: application/json' \
  --data '{"servicePrincipalId":"<service-principal-id>","namespaceId":"<namespace-id>","name":"nightly-reader","expiresIn":2592000}' \
  --output "$OCC_SERVICE_KEY_FILE"
```

Namespace-scoped keys cannot manage other keys. Missing current grants return
`403`; invalid, expired, or revoked credentials return `401`.
