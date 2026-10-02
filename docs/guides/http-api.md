# HTTP API quickstart

Use this guide to make your first authenticated requests to OpenClaw Control
Plane (OCC). It uses a service API key for automation. Human users can instead
[sign in with a session](../reference/authentication/service-api-keys.md#sign-in-as-a-human-administrator).
The [API reference](../reference/api.md) lists every exported operation, its
permissions, and its request and response fields.

## Before you start

You need Bash, `curl`, `jq`, the origin of an existing OCC Installation, and an
unexpired [service API key](../reference/authentication/service-api-keys.md). The key should be stored as
the full issuance or bootstrap JSON response in an owner-readable file. Keep
shell tracing disabled; do not print or paste the plaintext key.

The two top-level requests below require an Installation-scoped key. Reading the
Installation also requires `read` on the Installation; the Namespace list shows
only Namespaces the principal can read. If your key is Namespace-scoped, skip
to [Read your Namespace](#read-your-namespace) after defining the helper below.

## Set up the connection

Replace both example values. Use your approved HTTPS origin without a trailing
slash. For a local Installation only, you can use the loopback URL printed by
[Local Setup](quickstart.md).

```bash
set -o pipefail
export OCC_URL='https://occ.example.com'
export OCC_SERVICE_KEY_FILE='/private/path/occ-service-key.json'

occ_get() {
  local _occ_quickstart_service_key response status body
  _occ_quickstart_service_key="$(jq -er '
    .data.key
    | select(type == "string")
    | select(test("\\S") and (test("[\\r\\n]") | not))
  ' "$OCC_SERVICE_KEY_FILE")" || return
  response="$(
    printf 'x-api-key: %s\n' "$_occ_quickstart_service_key" |
      curl --silent --show-error --header @- \
        --write-out '\n%{http_code}' "$OCC_URL$1"
  )" || return
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [[ ! "$status" =~ ^2[0-9][0-9]$ ]]; then
    printf 'OCC returned HTTP %s.\n' "$status" >&2
    jq -se '
      select(length == 1) | .[0] | select(type == "object")
      | select(.error | type == "object") | select(.meta | type == "object")
      | select(.error.code | type == "string")
      | select(.error.message | type == "string")
      | select(.meta.requestId | type == "string")
      | {error: {code: .error.code, message: .error.message},
         meta: {requestId: .meta.requestId}}
    ' <<<"$body" >&2 2>/dev/null || :
    return 1
  fi
  if ! jq -se '
    select(length == 1) | .[0] | select(type == "object" and has("data"))
    | select(.data | type == "object" or type == "array")
    | select(.meta | type == "object")
    | select(.meta.requestId | type == "string")
    | select(.meta.requestId | startswith("req_"))
  ' <<<"$body" 2>/dev/null; then
    printf 'OCC returned HTTP %s without the expected JSON response.\n' "$status" >&2
    return 1
  fi
}
```

The helper passes the key through stdin so it does not appear in `curl`'s
command-line arguments. It accepts only a `2xx` response with the JSON fields
used by these GET operations; redirects and malformed or empty responses fail.
When OCC returns a JSON error, the helper prints its error code, message, and
request ID to stderr. If the Installation uses a private certificate authority, set
`CURL_CA_BUNDLE` to its PEM bundle; do not disable TLS verification.

## Read the Installation and list Namespaces

```bash
occ_get /installation
occ_get /namespaces
```

`GET /installation` returns HTTP `200` with an Installation in `data`, including
its `id`, `name`, and `createdAt`. `GET /namespaces` returns HTTP `200` with an
array in `data`; an empty array means this credential has no readable
Namespaces. Both responses include `meta.requestId`.

Fresh installations create a Namespace named `default`. It starts in
`provisioning`; wait until `status` is `ready` before deploying an Agent. Copy
the returned `id` to read the exact Namespace. Its name is not its ID.

## Read your Namespace

An Installation- or Namespace-scoped key can use this operation if its
principal has `read` on the exact Namespace. A Namespace-scoped key also needs
to match the Namespace in the URL. Replace the example with your Namespace ID:

```bash
export OCC_NAMESPACE='ns_123e4567-e89b-42d3-a456-426614174000'
occ_get "/namespaces/$OCC_NAMESPACE"
```

Expect HTTP `200` and a single Namespace in `data`, including its `id`, `name`,
and `status`. The [API resources index](../reference/api.md#resources) lists
other operations. If you are working on your own local Installation, follow
[Deploy your first Agent locally](first-agent.md). For a shared or production
Kubernetes Installation, follow [Deploy and verify production Agents](deploy/production-agents.md);
operators using trusted-proxy gateways can then [verify a model response](operate/model-verification.md).

## Troubleshoot

- HTTP `401`: The key is missing, expired, revoked, or invalid. Use `x-api-key`;
  the controller API does not accept `Authorization: Bearer`.
- HTTP `403`: Check the credential's scope and the principal's permission for
  the exact operation. A Namespace-scoped key cannot call `/installation` or
  `/namespaces`; use the exact Namespace URL instead.
- HTTP `503`: For the GET requests in this guide, OCC could not reach a required
  dependency; retry after the operator has checked the control plane.
- HTTP `3xx`: The helper rejects redirects, even if the response contains JSON.
  Check the approved OCC origin before retrying; do not forward the key to the
  redirect target.
- HTTP `2xx` without the expected JSON: Check that the URL points to OCC and
  that a proxy did not return its own page.
- TLS errors: Check the approved origin and CA bundle. Do not bypass certificate
  verification.

OCC JSON errors include `error.code`, `error.message`, and `meta.requestId`.
Record the request ID when reporting a failure; do not include the service key.
See the [error reference](../reference/api.md#error-responses) for the complete
envelope and possible codes.
