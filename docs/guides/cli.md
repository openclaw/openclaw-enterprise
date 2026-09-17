# OCC CLI

Build the checkout-local `occ` used by `scripts/dev-up` and `scripts/dev-down` from a trusted OpenClaw
Enterprise checkout:

```bash
pnpm cli:build
```

Install `occ` on `PATH` when using resource commands outside the checkout, select
the OCC endpoint and protected service-key response file, then work with
platform resources through domain commands:

```bash
go install ./cmd/occ
export OCC_URL='http://127.0.0.1:3000'
export OCC_SERVICE_KEY_FILE='/private/path/initial-admin-service-key.json'
occ installation get
occ namespace list
```

The resource command groups are `installation`, `namespace`, `configuration`,
and `agent`. Walk their built-in help when discovering an operation:

```bash
occ --help
occ namespace --help
occ agent deploy --help
```

Configuration and Agent operations use the Namespace selected by
`OCC_NAMESPACE` or `--namespace`. Create and update commands accept a product
JSON document rather than an HTTP body or path:

```bash
export OCC_NAMESPACE='<namespace-id>'
occ configuration create --file configuration.json
occ agent create --file agent.json
occ agent deploy '<agent-id>'
occ agent stop '<agent-id>'
```

Human-readable tables are the default. Use `--output json` or `--output yaml`
for automation. Structured output contains the resource or resource collection
directly; HTTP response envelopes are an internal client detail.

## Manage local development

From the checkout root, start the default Docker Compute profile and use the
cleanup command printed after startup:

```bash
./bin/occ dev up
./bin/occ dev down
```

`./bin/occ dev up` runs the [development quickstart](quickstart.md), including its
container-engine, runtime-image, and readiness checks. The default cleanup
preserves the Docker profile's database and configuration volumes; pass
`--volumes` only to delete the local Installation.

Set `OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes` for the
[local Kubernetes profile](deploy/local-kubernetes-development.md). Its cleanup
deletes the profile's k3d cluster, Compose volumes, and private state. Keep the
printed cleanup command so it selects the same profile and state directory.

## Connection and credential boundaries

Use `--url` and `--service-key-file` instead of the environment variables when
needed. The URL must be an HTTP or HTTPS origin without embedded credentials or
a base path. The CLI constructs resource operations internally, never accepts
an HTTP method or request path, and disables redirects so it cannot send a
service key to a different origin. Requests time out after 30 seconds. Set
`OCC_TIMEOUT_SECONDS` or `--timeout-seconds` to a positive integer to change the
timeout.

For an HTTPS endpoint signed by a private CA, pass its PEM bundle without
disabling verification:

```bash
export OCC_CA_BUNDLE=/private/path/occ-ca.pem
occ installation get
```

The service-key file is the complete JSON response created by bootstrap or key
issuance, not a file containing only the raw key. Keep it owner-readable and
never place the key in command arguments, logs, workloads, or source control.

## Troubleshoot

- `invalid service-key file` means the JSON does not contain a nonempty
  `data.key`, or the key contains a line break.
- `HTTP 401` means OCC rejected the credential. Retrieve or issue the intended
  key; do not weaken authentication.
- `HTTP 403` means the authenticated service principal lacks the exact IAM
  permission or Namespace scope for the operation.
- Certificate errors require the correct `OCC_CA_BUNDLE`; the CLI provides no
  insecure TLS mode.

See the [HTTP API reference](../reference/api.md) for the underlying platform
contracts and permissions. Operators normally do not need its paths or methods
to use `occ`.
