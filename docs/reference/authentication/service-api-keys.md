# Service API keys

Use a service API key to authenticate non-Agent automation to OpenClaw Control
Plane (OCC). The key represents an existing IAM ServicePrincipal, not the
administrator who issues it. Issuing a key does not create an account or grant
permissions. These keys cannot authenticate Agents and are separate from the
upstream credentials managed by [Service accounts](../service-accounts.md).

## Requirements

- A working OCC Installation and a loopback development URL or approved
  production HTTPS endpoint, assigned to `OCC_URL`. Set `OCC_ORIGIN` to the
  matching origin of `OCC_AUTH_BASE_URL` (scheme, host, and optional port only).
- A human administrator session, or an Installation-scoped service principal
  with current `administer` on the singleton Installation.
- An existing non-Agent service principal and its exact Namespace, if it has
  one. Fresh bootstrap creates an Installation service administrator. For
  Namespace automation or a member's CLI, create a Namespace service principal
  with `occ iam service-principal create` (`POST
/namespaces/:namespaceId/iam/service-principals`) and grant it a Role with an
  AccessBinding; both use the [Namespace IAM API](../authorization.md#manage-namespace-policy).
  A new service principal holds no grant. You must already hold every grant of
  the principal whose key you issue or revoke.
- A private directory for credentials. Keep shell tracing disabled, do not print
  keys, and run the examples from the repository root. CLI examples assume the
  [`occ` executable](../../guides/cli.md) is installed and on `PATH`.

## Issue a service key

If you do not have a human session cookie, [sign in](#sign-in-as-a-human-administrator)
or use an [existing service administrator](#manage-keys-with-a-service-administrator).
The sample issues a 30-day Namespace key into an owner-readable file. Omit
`namespaceId` only for an Installation-scoped principal.

```bash
umask 077
export OCC_SERVICE_KEY_DIRECTORY='/secure/occ/service-keys'
install -d -m 700 "$OCC_SERVICE_KEY_DIRECTORY"
export OCC_SERVICE_KEY_FILE="$(mktemp "$OCC_SERVICE_KEY_DIRECTORY/key.XXXXXX")"
curl --fail-with-body --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" \
  "$OCC_URL/api/auth/service-keys" -H "Origin: $OCC_ORIGIN" -H 'Content-Type: application/json' \
  --data '{"servicePrincipalId":"<service-principal-id>","namespaceId":"<namespace-id>","name":"nightly-reader","expiresIn":2592000}' \
  --output "$OCC_SERVICE_KEY_FILE"
```

`occ service-key create --service-principal ID --name NAME --out FILE`, with
`--namespace` for a Namespace principal, makes the same request and writes the
response to a new `0600` file without printing the key. For an Installation
principal, unset `OCC_NAMESPACE`, which the CLI also sends as `namespaceId`.

Success returns HTTP `201`. The response contains the credential exactly once in
`data.key` and a non-secret `data.id` needed to revoke it. Record the key and
principal IDs separately for recovery; there is no plaintext retrieval endpoint.
If the request fails, read and then delete the file (it holds the error
response, or nothing); never give it to an automation client.

## Use a service key

The CLI reads the key from the response file selected by `OCC_SERVICE_KEY_FILE`:

```bash
export OCC_NAMESPACE='<namespace-id>'
occ namespace get "$OCC_NAMESPACE"
```

An authorized request returns the Namespace. Invalid, expired, or revoked keys
produce HTTP `401`; missing exact IAM permission produces `403`. For HTTP clients,
send the credential in `x-api-key`, not `Authorization: Bearer`. A supplied
`x-api-key` takes precedence over a session cookie; an invalid key cannot fall
back to the cookie.

## Revoke or rotate a service key

To revoke the key in `OCC_SERVICE_KEY_FILE` with the administrator session:

```bash
OCC_SERVICE_KEY_ID="$(python3 -c 'import json, os, pathlib; print(json.loads(pathlib.Path(os.environ["OCC_SERVICE_KEY_FILE"]).read_text())["data"]["id"])')"
curl --fail-with-body --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" \
  -H "Origin: $OCC_ORIGIN" \
  --request DELETE "$OCC_URL/api/auth/service-keys/$OCC_SERVICE_KEY_ID"
```

`occ service-key revoke ID` makes the same request with a service-key file.
Success returns HTTP `200` and `data.revoked: true`; subsequent use of the key
returns `401`. To rotate without interrupting clients, issue a replacement to a
new private file, switch the clients, verify access, then revoke the old key by
its recorded ID. OCC does not rotate keys automatically.

## Sign in as a human administrator

Use a human session for recovery, human-issued keys, and account-only APIs. For
production, obtain the first administrator’s password through the protected
bootstrap storage procedure. The following sends it from a file and keeps the
session cookie in a private directory. Set `OCC_URL` to the approved HTTPS
endpoint and `OCC_ORIGIN` as in [Requirements](#requirements); without it,
sign-out returns `403` and the session stays live.

When local startup printed an HTTPS browser console URL, set `OCC_URL` to its
origin (`https://console.<cluster>.oce.localhost:<port>`, without `/console/`)
and export `CURL_CA_BUNDLE` as the printed browser CA certificate file; unset it
when finished. Do not use the loopback API URL there: sign-in returns `200`, but
the session cookie is `Secure` and scoped to the console's domain, so curl never
sends it to `http://127.0.0.1` and the next request returns `401`.

```bash
set -o pipefail
umask 077
: "${OCC_URL:?Set OCC_URL to the approved HTTPS endpoint or local console origin}"
: "${OCC_ORIGIN:?Set OCC_ORIGIN to the console origin; see Requirements}"
export OCC_ADMIN_EMAIL='<first-admin@example.com>'
export OCC_ADMIN_PASSWORD_FILE='/secure/occ/initial-admin-password'
OCC_SESSION_DIRECTORY="$(mktemp -d)"
export OCC_SESSION_COOKIE_JAR="$OCC_SESSION_DIRECTORY/cookies"
python3 -c 'import json, os, pathlib, sys; json.dump({"email": os.environ["OCC_ADMIN_EMAIL"], "password": pathlib.Path(os.environ["OCC_ADMIN_PASSWORD_FILE"]).read_text().rstrip("\n")}, sys.stdout)' |
  curl --fail-with-body --silent --show-error --cookie-jar "$OCC_SESSION_COOKIE_JAR" "$OCC_URL/api/auth/sign-in/email" -H 'Content-Type: application/json' --data-binary @- --output /dev/null
curl --fail-with-body --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" "$OCC_URL/installation"
```

For local development, use the configured administrator credentials. Once
finished, revoke the session and remove its file:

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
  -H "Origin: $OCC_ORIGIN" \
  --request POST "$OCC_URL/api/auth/sign-out" --output /dev/null
rm -- "$OCC_SESSION_COOKIE_JAR"
rmdir -- "$OCC_SESSION_DIRECTORY"
```

## Manage keys with a service administrator

An Installation-scoped non-Agent service principal with `administer` can issue
or revoke keys without a human cookie. It can issue keys only for principals
whose grants it already holds, as described in [issuance](#issuance). Set `OCC_ADMIN_SERVICE_KEY_FILE` to its
protected key-response file and `OCC_SERVICE_KEY_FILE` to a new, private output
file as in [issuance](#issue-a-service-key). Send the admin key through stdin so
it does not appear in process arguments:

```bash
set -o pipefail
python3 -c 'import json, os, pathlib, sys; key=json.loads(pathlib.Path(os.environ["OCC_ADMIN_SERVICE_KEY_FILE"]).read_text())["data"]["key"]; sys.stdout.write("x-api-key: " + key + "\n")' |
  curl --fail-with-body --silent --show-error --header @- "$OCC_URL/api/auth/service-keys" \
  -H 'Content-Type: application/json' \
  --data '{"servicePrincipalId":"<service-principal-id>","namespaceId":"<namespace-id>","name":"nightly-reader","expiresIn":2592000}' \
  --output "$OCC_SERVICE_KEY_FILE"
```

Use the same protected header pattern with `DELETE /api/auth/service-keys/:keyId`
to revoke a key. Revocation needs the same coverage as issuance: a caller that
does not hold every grant of the key's principal gets `403`. Namespace-scoped keys cannot manage service keys. Account
creation and bootstrap still require human sessions.

## Retrieve the bootstrap service key

Fresh bootstrap writes a 30-day key for the Installation service administrator.
In production, retrieve `initial-admin-service-key.json` from the protected
bootstrap PVC through approved storage access. Save it to a private path and
set `OCC_SERVICE_KEY_FILE`. See the [bootstrap storage settings](../settings/production.md#production-installation-bootstrap-environment)
if the file was given a different name.

For a local stack started with `dev-up`, use the `Service key file` path it
prints. To copy the key from a Compose stack by hand, create a fresh directory:

```bash
umask 077
export OCC_SERVICE_KEY_DIRECTORY="$(mktemp -d)"
export OCC_SERVICE_KEY_FILE="$OCC_SERVICE_KEY_DIRECTORY/initial-admin-service-key.json"
docker compose cp bootstrap:/var/lib/openclaw/bootstrap/initial-admin-service-key.json \
  "$OCC_SERVICE_KEY_FILE"
chmod 600 "$OCC_SERVICE_KEY_FILE"
```

Validate it with `occ installation get`; the displayed ID should match
`meta.installationId` in the protected response file. Never print the whole
file to obtain the ID.

## Recover an incomplete bootstrap

Bootstrap makes one attempt. On failure, preserve logs, non-secret IDs, and
protected output. Confirm database commit state before deleting anything. If the
attempt did not commit, remove only proven orphan accounts or keys and
quarantine only that attempt's output. If it did commit, retain the credentials
and use normal key recovery. Do not delete output, reset the database, or rerun
bootstrap as an automatic fallback. See [bootstrap behavior](../authentication.md#installation-and-account-ownership).

## Recover a lost or exposed service key

If you retained the key and principal IDs, sign in as a human administrator,
revoke the old key, then [issue a replacement](#issue-a-service-key). Otherwise,
have an authorized administrator inspect only non-secret key metadata and IAM
bindings to identify the key; OCC has no public key-list endpoint. Do not
export key values, password hashes, sessions, or full table dumps.

## Issuance

`POST /api/auth/service-keys` requires current IAM `administer` on the singleton
Installation, even for a Namespace key. A key carries every grant of its
principal, so the caller must also already hold each of that principal's grants
at the same or a broader scope; otherwise issuance returns `403`. Agent
`administer` counts for a delegated Agent `read_logs` grant, since both admit log
reads. An administrator bound only to the exact Installation cannot issue a key for the
unscoped bootstrap service administrator or for a Namespace principal. The body names an existing
`servicePrincipalId`, its exact `namespaceId` when scoped, and a nonblank `name`
of 1–32 characters. Optional `expiresIn` is an integer from 86,400 to
31,536,000 seconds (1–365 days); omission gives 30 days. Other fields are
rejected. The `201` response includes `id`, `servicePrincipalId`, optional
`namespaceId`, `name`, `expiresAt`, and one-time `key`. See the
[HTTP API reference](../api.md) for the complete schema.

## Request admission and scope

The key's Installation and optional Namespace are fixed at issuance. A Namespace
key cannot access another Namespace or Installation-level endpoints. An
Installation key still requires each exact IAM permission. It does not inherit
its issuer's rights; changes to current IAM policy apply to subsequent requests.
If the principal changes scope, obtain a new key. Keys are verified from storage
on each request and cannot create a human session through `GET /api/auth/session`.

The controller stores key hashes through Better Auth and does not enable its
per-key rate limits. OCC exposes the issue and revoke endpoints above, not Better
Auth’s own key-management API. There is no endpoint for updating a key’s name or
lifetime; issue a replacement. Routine issuance needs no additional controller
settings; initial delivery uses the [bootstrap settings](../settings/production.md#production-installation-bootstrap-environment).

## Revocation and audit

`DELETE /api/auth/service-keys/:keyId` requires the same authority as issuance.
It returns `200` with `data: {"id":"<key-id>","revoked":true}`. Subsequent
requests fail across controller instances; a request already authorized can
finish. An unknown or removed key returns `404`. Revoking an issuer’s key does
not revoke other keys issued through it or delete a principal or its bindings.

HTTP issuance and revocation emit [audit events](../../guides/topics/audit-log.md)
with the caller, the principal ID, and the key's ID (`serviceKeyId`) and name
(`serviceKeyName`). Every API route's audit event (change, audited read, or
denial) for a request made with a service key, including these, names that key
in `actorServiceKeyId`, so you can tell which of a principal's keys acted.
Events OCC writes for the work itself, such as `openclaw.agents.provision` and
worker `reconcile` events, name only the principal. If issuance audit
persistence fails, OCC returns `503` without disclosing the key and attempts to
remove it; this cleanup is best effort. A failed revocation audit returns `503`
but does not restore the deleted key.

## Service-key failures

| Condition                                                                                                  | Result                                                                |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Missing, invalid, expired, or revoked credential; key used for account creation or bootstrap               | `401 UNAUTHENTICATED`.                                                |
| Missing identity or exact grant, changed principal scope, cross-Namespace request, or matching Restriction | `403 FORBIDDEN`.                                                      |
| Unknown, Agent-owned, or incorrectly scoped principal at issuance; invalid name, lifetime, or fields       | `400 INVALID_REQUEST`.                                                |
| Unknown or removed key at revocation                                                                       | `404 NOT_FOUND`.                                                      |
| Required authentication, IAM, or audit dependency unavailable                                              | `503 DEPENDENCY_UNAVAILABLE`; do not retry with a broader credential. |
