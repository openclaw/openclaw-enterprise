# Test experimental OpenShell OAuth

Verify the [experimental Codex OAuth source](../reference/drivers/openshell-credential-gateway.md#experimental-codex-oauth-poc)
with an upstream OpenShell gateway, an alias-enabled supervisor, and dedicated Codex. Use an owned, disposable
environment; this procedure does not establish production support.

## Prepare the custom images and trust

Use an OpenShell gateway implementing upstream `GetProviderCredentials`, added
in revision `4c1b16a4a104581fb0afe8675feff34f00cc2ca8`. The official gateway image
for that revision supplies this RPC. Full Harness proof also needs a supervisor
with [JWT-placeholder alias support](https://github.com/stevenlee-oai/OpenShell/pull/1)
and its matching static sandbox launcher. Select the gateway and Workspace Helm
charts for the chosen gateway revision. The
[development launcher](openshell.md#start-a-reusable-development-environment)
still imports its stock OpenShell image pins: selecting local charts alone does
not select those binaries. Import the selected images into the owned cluster and
set their immutable references through `gateway.image`, `supervisor.image`, and
`sandboxRuntime.image` before verification.

Configure the shared [OpenShell Backend](../reference/backends.md#openshell-gateway)
with its selected `credential_refresh` member, ordinary bearer authentication,
the gateway CA, and separate `operatorTls`
certificate/key paths. Enable the gateway's default-off operator authentication
in its Helm values:

```yaml
gatewayConfig:
  openshell.gateway.mtls_auth:
    operator_enabled: true
```

Issue the client certificate from its trusted client CA with exact
`OU=operator`; use a direct TLS endpoint without termination or forwarded identity.
The ordinary bearer keeps its Workspace/provider permissions. Credential export
uses only the operator certificate. Do not put both identities on one request.

`rootCertificatePath` trusts **OCC-to-OpenShell gRPC only**. The dedicated Agent
Gateway also needs to trust the private CA for OpenShell's advertised `wss`
Harness endpoint.

Build the base OCE image from [the runtime Dockerfile](../../deploy/runtime/Dockerfile)
using its pinned inputs: OpenClaw commit
`90d30a1178a79dddd92e6190b66b95d89dfb3ca8`, Codex `0.160.0`, and the pinned
Node 24 build/runtime bases. Keep the frozen lockfile, source checksum, and
native filesystem checks. See the [runtime recipe](../../deploy/runtime/README.md).

Set `BASE_RUNTIME_IMAGE` to that locally available immutable image reference and
`OPENSHELL_PUBLIC_CA` to the gateway's public PEM CA certificate. Build a
deployment-specific derivative in a separate directory:

```bash
export RUNTIME_CONTEXT="$(mktemp -d)"
cp "$OPENSHELL_PUBLIC_CA" "$RUNTIME_CONTEXT/openshell-ca.crt"
cat > "$RUNTIME_CONTEXT/Dockerfile" <<'DOCKERFILE'
ARG BASE_RUNTIME_IMAGE
FROM ${BASE_RUNTIME_IMAGE}
USER root
COPY openshell-ca.crt /usr/local/share/ca-certificates/openshell.crt
RUN chmod 0644 /usr/local/share/ca-certificates/openshell.crt && update-ca-certificates
ENV NODE_USE_SYSTEM_CA=1
USER node
DOCKERFILE
docker build --build-arg BASE_RUNTIME_IMAGE="$BASE_RUNTIME_IMAGE" \
  --tag openclaw-enterprise-runtime:openshell-oauth "$RUNTIME_CONTEXT"
```

Include only the public certificate in this build context, never CA signing
keys, operator credentials, or OAuth material. `NODE_USE_SYSTEM_CA=1` makes Node use
the augmented system trust store while retaining normal certificate and
hostname verification. A CA change requires rebuilding and selecting the image.

For the Compose control-plane profile, select this local image through
`OCC_KUBERNETES_RUNTIME_IMAGE` before `dev-up`; the launcher imports it and
records an immutable reference. For real-runtime tests, follow the
[Kubernetes image import procedure](kubernetes.md#kubernetes-model-turns-and-secrets)
and set `OCC_TEST_KUBERNETES_GATEWAY_IMAGE` and
`OCC_TEST_KUBERNETES_AGENT_IMAGE` to the imported digest reference.

When OpenShell's ordinary OIDC issuer uses a private CA, also use a chart that
preserves the gateway image's public roots: `server.oidc.caConfigMapName` selects
the issuer bundle through `SSL_CERT_FILE`, alongside
`SSL_CERT_DIR=/etc/ssl/certs`. An issuer-only file without the public roots can
allow OIDC login while breaking refresh at a public OAuth token endpoint.
This is separate from the Agent Gateway's trust above; retain TLS verification
on both paths.

## Run the synthetic refresh proof

The manually selected `openshell-oauth` lane runs
[`openshell-oauth-credentials-real.test.mjs`](../../tests/integration/openshell-oauth-credentials-real.test.mjs)
against the real upstream gateway and a synthetic HTTPS OAuth issuer. It is outside
`ci` and `full`, enables `OCE_OPENSHELL_OAUTH_REAL=1`, and requires these inputs
in a private environment file:

| Variable                                 | Required input                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `OCE_OPENSHELL_OAUTH_GATEWAY_ENDPOINT`   | Direct HTTPS gateway endpoint with operator authentication enabled.             |
| `OCE_OPENSHELL_OAUTH_CA_FILE`            | Public gateway CA file.                                                         |
| `OCE_OPENSHELL_OAUTH_ADMIN_TOKEN_FILE`   | Ordinary OIDC admin token for Workspace/provider operations.                    |
| `OCE_OPENSHELL_OAUTH_OPERATOR_CERT_FILE` | Trusted client certificate with exact `OU=operator`.                            |
| `OCE_OPENSHELL_OAUTH_OPERATOR_KEY_FILE`  | Matching private key file, readable only by the test process.                   |
| `OCE_OPENSHELL_OAUTH_DENIED_TOKEN_FILE`  | Ordinary OIDC admin token without an operator certificate.                      |
| `OCE_OPENSHELL_OAUTH_TEST_TOKEN_URL`     | Synthetic issuer's HTTPS token endpoint.                                        |
| `OCE_OPENSHELL_OAUTH_KUBECONFIG`         | Dedicated disposable cluster kubeconfig.                                        |
| `OCE_OPENSHELL_OAUTH_KUBERNETES_CONTEXT` | `k3d-occ-dev-oce-oauth-poc`; the test enforces this context and a loopback API. |
| `OCE_OPENSHELL_OAUTH_WORKSPACE_CHART`    | Matching OpenShell Workspace chart path.                                        |

The synthetic issuer must accept unique `oauth-poc-refresh-initial-<UUID>` grants,
return a new access token and rotating refresh token with a one-hour lifetime,
and reject reused refresh tokens. Use fresh fixture identities and state;
never point this lane at an existing user's deployment.

```sh
node --env-file="$TEST_ENV_FILE" scripts/ci/run-tests.mjs run openshell-oauth \
  --state /tmp/oce-openshell-oauth-state.json \
  --results /tmp/oce-openshell-oauth-results.json
```

Missing prerequisites fail before execution. No real model credential is needed.
The case uses the real Backend's ordinary and operator channels. A seeded token
has four minutes remaining, below upstream's five-minute retrieval requirement;
the fixture's shorter background-refresh margin puts scheduled refresh beyond
the operation deadline. Retrieval must refresh it, a subsequent read must reuse
it, and another explicit rotation must use the stored successor refresh token.
The case also checks unchanged attachments and rejects ordinary bearer export
and refresh-material export. It proves neither real ChatGPT login nor Harness
injection/model execution. A TLS handshake or ready source does not prove those
outcomes either.

For real-provider proof, use the Console for fresh device login, select the
resulting source on a dedicated Codex Agent, and verify initial workspace files,
an active deployment, a real model response, and a subsequent revision using
the same source. Select `codex-plugin` with `catalogSource: hosted` to verify
directory discovery. Selected runtime plugins remain unsupported; discovery
does not prove plugin execution. The remaining qualification boundaries are below.

## Receiver fixtures and full-stack qualification

`tests/integration/device-authorization-api.test.mjs` exercises real Fastify,
OCC, IAM and credential-source storage through login, Agent creation/revision
admission and plugin discovery. The external credential services and provider HTTP
are simulated. It verifies session fencing, source grants, configuration discovery after
session closure/expiry, and rejection of credential leakage. The Console OAuth
browser case exercises those routes through the actual controls; Storybook is
separate simulated UI evidence. Neither proves external token refresh or injection.

`tests/conformance/kubernetes-compute.test.mjs` exercises the real Compute
preparation path with Driver transport fixtures. It checks source matching,
Harness-only placeholder/metadata delivery, and refusal before provisioning on
invalid attachments. `tests/integration/codex-model-probe.test.mjs` runs the
emitted launcher in Docker with a substituted Codex executable, checking the
generated auth file at both the probe and app-server boundaries. Select its
immutable Node image with `OCC_TEST_CODEX_PROBE_IMAGE`.

The [external ChatGPT receiving contract](../reference/drivers/credential-gateway.md#external-chatgpt-authentication)
does not establish OAuth injection or refresh through OpenShell. The bundled
real-runtime suite uses an API-key source. Qualifying an OAuth source requires
the external Token Service and paired gateway: verify native Codex startup,
inference and hosted app/MCP requests, access-token rotation without a Harness
restart, restart, and refusal after source withdrawal. Receiver fixtures alone
cannot prove those provider and gateway behaviors or native account checks
that require real access-token claims.
