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
/namespaces/:namespaceId/iam/service-principals`). A new principal can
  receive a key before it has any grants. To grant access, bind a Role to
  the principal through the [Namespace IAM API](../authorization.md#manage-namespace-policy).
  To issue or revoke its key, you must hold every grant the principal currently has.
- A private directory for credentials. Keep shell tracing disabled, do not print
  keys, and run the examples from the repository root. CLI examples assume the
  [`occ` executable](../../guides/cli.md) is installed and on `PATH`.

## Issue a service key

For the cookie and session key used below, [sign in](#sign-in-as-a-human-administrator)
or use an [existing service administrator](#manage-keys-with-a-service-administrator).
The sample issues a 30-day Namespace key into an owner-readable file. Omit
`namespaceId` only for an Installation-scoped principal.

```bash
umask 077
export OCC_SERVICE_KEY_DIRECTORY='/secure/occ/service-keys'
install -d -m 700 "$OCC_SERVICE_KEY_DIRECTORY"
export OCC_SERVICE_KEY_FILE="$(mktemp "$OCC_SERVICE_KEY_DIRECTORY/key.XXXXXX")"
curl -q --fail-with-body --silent --show-error --cookie "${OCC_SESSION_COOKIE_JAR:?}" \
  -H @- <<<"x-occ-session-key: ${OCC_SESSION_KEY:?}" \
  "$OCC_URL/api/auth/service-keys" -H "Origin: $OCC_ORIGIN" -H 'Content-Type: application/json' \
  --data '{"servicePrincipalId":"<service-principal-id>","namespaceId":"<namespace-id>","name":"nightly-reader","expiresIn":2592000}' \
  --output "$OCC_SERVICE_KEY_FILE"
```

`occ service-key create --service-principal ID --name NAME --out FILE`, with
`--namespace` for a Namespace principal, makes the same request and writes the
response to a new `0600` file without printing the key. The name is 1 to 32
characters, counted as Unicode code points rather than bytes, and must contain
a non-whitespace character, the same rule as the API. The CLI refuses any
other name before it creates the key file or sends the request. For an
Installation principal, unset `OCC_NAMESPACE`, which the CLI also sends as
`namespaceId`.

Success returns HTTP `201`. The response contains the credential exactly once in
`data.key` and a non-secret `data.id` needed to revoke it. Record the key and
principal IDs separately for recovery; there is no plaintext retrieval endpoint.
If issuance fails, keep any output file private. Even an interrupted transfer
can leave part or all of the credential. Do not print the file or give it to
a client. [Resolve an uncertain outcome](#recover-a-lost-or-exposed-service-key)
before deleting the file or issuing another key.

If the CLI cannot write or close the file after receiving a key ID, it
reports that ID and attempts revocation and file removal. Either step can
fail. If printing the summary fails after the save, the file remains.

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

Confirm the Installation, principal and non-secret key ID. Use the target's
`serviceKeyId` from an audit event or the unsaved key ID from a CLI error.
`actorServiceKeyId` identifies the caller. If you have the complete issuance
file for that key, you can read just `data.id` from it. Never print the file
or use `data.key` as the ID.

Replace the placeholder with the confirmed ID. This command uses the
administrator session and encodes the ID as one URL path segment.

```bash
OCC_SERVICE_KEY_ID='<confirmed-key-id>'
key_path=$(python3 -c '
import sys
from urllib.parse import quote
key_id = sys.argv[1]
if key_id == "<confirmed-key-id>" or not key_id.strip(".") or "/" in key_id:
    raise SystemExit("Enter the confirmed key ID")
print(quote(key_id, safe=""))
' "$OCC_SERVICE_KEY_ID") &&
  curl -q --globoff --fail-with-body --silent --show-error \
    --cookie "${OCC_SESSION_COOKIE_JAR:?}" -H "Origin: $OCC_ORIGIN" \
    -H @- <<<"x-occ-session-key: ${OCC_SESSION_KEY:?}" \
    --write-out '\nHTTP %{http_code}\n' \
    --request DELETE "$OCC_URL/api/auth/service-keys/$key_path"
```

With an authorized Installation service key, use `occ service-key revoke ID`.
For the HTTP request, check for `200`, a matching `data.id` and
`data.revoked: true`. Subsequent use of the revoked key returns `401`. To rotate without interrupting clients, issue a replacement to a
new private file, switch the clients, verify access, then revoke the old key by
its recorded ID. OCC does not rotate keys automatically.

## Sign in as a human administrator

For production, obtain the administrator’s password from protected bootstrap
storage. Set `OCC_URL` and [`OCC_ORIGIN`](#requirements). Without the matching
origin, sign-out returns `403` and the session stays live.

For a local HTTPS console, use its printed origin
(`https://console.<cluster>.oce.localhost:<port>`, without `/console/`).
Export `CURL_CA_BUNDLE` with the printed CA certificate path. Unset it when
finished. Curl can’t send the console’s Secure cookie to `http://127.0.0.1`.
Without it the session check returns `200` with `data: null`.

Start a fresh Bash shell with jq. Use the stored lowercase email and a private
password file. Stop on errors. Keep the jar exclusive to this login.
Password-only sign-in can omit the binding until the first session check.

```bash
set +x
set -o pipefail
umask 077
export OCC_ADMIN_EMAIL='<first-admin@example.com>'
export OCC_ADMIN_PASSWORD_FILE='/secure/occ/admin-password'

auth_request() {
  local status
  status=$(curl -q --silent --show-error --output "$OCC_SESSION_DIRECTORY/reply" \
    --write-out '%{http_code}' "$@") && [[ $status == 200 ]]
}

sign_in() {
  [[ -z ${OCC_SESSION_DIRECTORY:-} ]] || return 1
  unset OCC_SESSION_KEY
  : "${OCC_URL:?}" "${OCC_ORIGIN:?}"
  OCC_SESSION_DIRECTORY=$(mktemp -d) || return 1
  export OCC_SESSION_COOKIE_JAR="$OCC_SESSION_DIRECTORY/cookies"
  jq -cn --rawfile p "$OCC_ADMIN_PASSWORD_FILE" \
    '{email: env.OCC_ADMIN_EMAIL, password: ($p | sub("\r?\n$"; ""))}' |
    auth_request --cookie-jar "$OCC_SESSION_COOKIE_JAR" -H 'Content-Type: application/json' \
      --data-binary @- "$OCC_URL/api/auth/sign-in/email" || return 1
  mv -- "$OCC_SESSION_DIRECTORY/reply" "$OCC_SESSION_DIRECTORY/login" || return 1
  verify_session
}

verify_session() {
  local key
  local -a binding=()
  [[ -z ${OCC_SESSION_KEY:-} && -s ${OCC_SESSION_COOKIE_JAR:?} ]] || return 1
  key=$(jq -ers 'select(length == 1) | .[0].data | select(.authenticated == true) |
    if has("sessionKey") then .sessionKey | strings | select(test("^[A-Za-z0-9_-]{43}$") and length == 43)
    else "" end' "$OCC_SESSION_DIRECTORY/login") || return 1
  if [[ -n $key ]]; then binding=(-H @-); fi
  auth_request --cookie "$OCC_SESSION_COOKIE_JAR" "${binding[@]}" \
    "$OCC_URL/api/auth/session" <<<"x-occ-session-key: $key" || return 1
  OCC_SESSION_KEY=$(jq -ers --slurpfile login "$OCC_SESSION_DIRECTORY/login" '
    select(length == 1) | .[0].data |
    select(.authenticated == true and .user.email == env.OCC_ADMIN_EMAIL) |
    .sessionKey | strings | select(length == 43 and test("^[A-Za-z0-9_-]{43}$")) |
    select(. == ($login[0].data.sessionKey // .))' "$OCC_SESSION_DIRECTORY/reply")
}
sign_in
```

If the first session read fails transiently, retry only `verify_session` with
the original files. If verification remains uncertain, preserve them privately
and contact the [account administrator](../../guides/deploy/credential-lifecycle.md#choose-the-credential-owner).
Account-wide revocation ends other sessions too.

When finished, confirm sign-out and check the unchanged cookie before cleanup.
A missing or unsent cookie also yields `data: null`. That alone cannot prove
revocation.

```bash
check_session() {
  auth_request --cookie "${OCC_SESSION_COOKIE_JAR:?}" -H @- \
    "${OCC_URL:?}/api/auth/session" <<<"x-occ-session-key: ${OCC_SESSION_KEY:?}"
}

auth_request --cookie "${OCC_SESSION_COOKIE_JAR:?}" -H @- -H "Origin: ${OCC_ORIGIN:?}" \
  --request POST "${OCC_URL:?}/api/auth/sign-out" <<<"x-occ-session-key: ${OCC_SESSION_KEY:?}" &&
  jq -es 'length == 1 and .[0].data.success == true' "$OCC_SESSION_DIRECTORY/reply" >/dev/null &&
  check_session &&
  jq -es 'length == 1 and (.[0] | has("data") and .data == null)' "$OCC_SESSION_DIRECTORY/reply" >/dev/null &&
  unset OCC_SESSION_KEY &&
  rm -- "$OCC_SESSION_COOKIE_JAR" "$OCC_SESSION_DIRECTORY/login" "$OCC_SESSION_DIRECTORY/reply" &&
  rmdir -- "$OCC_SESSION_DIRECTORY" &&
  unset OCC_SESSION_COOKIE_JAR OCC_SESSION_DIRECTORY
```

If revocation is uncertain, keep the files private. Run `check_session` and
inspect `$OCC_SESSION_DIRECTORY/reply` privately after HTTP `200`. Retry only if the original session is still active.
Never drop the binding or adopt a replacement key. If only file removal failed,
finish local cleanup.

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

Fresh bootstrap registers the operator-supplied key for the Installation service
administrator. It expires 30 days after registration. Bootstrap does not return
or write credentials. Use your retained source file or approved access to the
source Kubernetes Secret. Reading that Secret grants access to both administrator
identities; do not print its contents. See the [bootstrap input contract](../authentication.md#installation-and-account-ownership).

For a local stack started with `occ dev up` or `scripts/dev-up`, use the
`Service key file` path it prints. The setup tool prepares that file before
bootstrap; no container extraction is needed.

With automatic `occ installation install`, use `bootstrap-client-key.json` in
the recovery directory recorded by `bootstrap-secret.json` in the installation
receipt. The file contains prepared material; authenticate it before treating
installation access as verified. See [production sign-in](../../guides/deploy/production-installation.md#authenticate-to-the-production-api).

For a manual install, wrap the retained raw key in the CLI's `data.key` envelope.
This example uses the default production input filename and refuses overwrites:

```bash
umask 077
export OCC_SERVICE_KEY_FILE=/secure/occ/initial-admin-service-key.json
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const key = readFileSync('/secure/occ/admin-service-key', 'utf8').replace(/\r?\n$/, '');
writeFileSync(process.env.OCC_SERVICE_KEY_FILE, JSON.stringify({ data: { key } }), { mode: 0o600, flag: 'wx' });
JS
occ installation get --output json
```

The local JSON contains no key ID, expiry, or Installation ID. Obtain the
server-owned Installation ID from `id` in CLI JSON output (`data.id` in the
HTTP response envelope).
Preparing a key file does not prove that installation succeeded. Ordinary key
issuance still returns its complete response with metadata and a generated key.

## Recover an incomplete bootstrap

Fresh bootstrap reads and validates both input files before creating credentials.
A rejected input does not establish an empty database: migration may already
have run. Correct invalid files only after checking the original attempt's state.

Bootstrap makes one attempt. Better Auth writes and the Installation/IAM commit
are separate. On failure, preserve logs, non-secret attempt IDs, and protected
inputs. Confirm database commit state before changing anything. If the attempt
did not commit, remove only proven orphan accounts or keys under an authorized
reconciliation procedure. If it committed, retain the credentials and use normal
account or key recovery. Do not reset the database, generate replacements, or
rerun bootstrap as an automatic fallback. A verified existing Installation reads
neither input and does not reset passwords, import a new key, renew expiry, or
restore grants. Editing the source Secret is not rotation. See
[bootstrap behavior](../authentication.md#installation-and-account-ownership).

## Recover a lost or exposed service key

If you know the key and principal IDs, have an authorized administrator
[revoke that key](#revoke-or-rotate-a-service-key), then
[issue a replacement](#issue-a-service-key).

A lost response or `503` during issuance can leave a usable key even if you
received no ID and find no issuance audit event. OCC has no public key-list
endpoint. Installation administration alone grants no database access.

Without a confirmed ID, ask a database operator with approved read-only
access to the affected Installation to check non-secret service-key metadata.
Supply the principal ID, scope, name, approximate issuance time and any
request ID. Compare the key ID, principal reference, Installation, optional
Namespace, name and creation time with IAM bindings and available audit
records. A name alone cannot identify the key.

If access is unavailable or the evidence cannot identify one record, keep
any output file private and stop before issuing another key. Have an
authorized administrator revoke only a confirmed match through OCC.
Do not export key values, password hashes, sessions or full table dumps.

A `503` during revocation can occur before or after deletion. A `404` means
OCC found no eligible record for that ID in this Installation. Neither status
alone proves that the original request deleted the key. Verify the Installation,
key ID and available records before deciding whether to retry.

## Issuance

`POST /api/auth/service-keys` requires current IAM `administer` on the singleton
Installation, even for a Namespace key. Native IAM checks that the caller covers every current grant of the
target principal at the same or a broader scope. Missing coverage returns
`403` when the denial audit succeeds. Agent `administer` covers Agent
`read_logs` because both allow log reads.

An administrator bound only to the exact Installation can issue a key for a
Namespace principal with no grants. That binding alone cannot cover grants
on Namespace resources or the bootstrap service administrator's unscoped grants.

The body names an existing
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
finish. See [recovery](#recover-a-lost-or-exposed-service-key) for `404` or `503`. Revoking an issuer’s key does
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
| No eligible key for this ID in this Installation at revocation                                             | `404 NOT_FOUND`.                                                      |
| Required authentication, IAM, or audit dependency unavailable                                              | `503 DEPENDENCY_UNAVAILABLE`; do not retry with a broader credential. |
