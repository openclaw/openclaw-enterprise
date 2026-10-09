# Test experimental OpenShell OAuth

Verify the [experimental Codex OAuth source](../reference/drivers/openshell-credential-gateway.md#experimental-codex-oauth-poc)
with a custom OpenShell gateway and dedicated Codex. Use an owned, disposable
environment; this procedure does not establish production support.

## Prepare the custom images and trust

Build matching OpenShell gateway, supervisor, and static sandbox-launcher images
with the credential-read RPC and JWT-alias support. Select both matching Helm
charts. The [development launcher](openshell.md#start-a-reusable-development-environment)
still imports its stock OpenShell image pins: selecting local charts alone does
not select custom binaries. Import the custom images into the owned cluster and
explicitly set their immutable references through the chart's `gateway.image`,
`supervisor.image`, and `sandboxRuntime.image` values before OAuth verification.

Configure the shared [OpenShell Backend](../reference/backends.md#openshell-gateway)
with its operator token and gateway CA. Its `rootCertificatePath` trusts
**OCC-to-OpenShell gRPC only**. The dedicated Agent Gateway also needs to trust
the private CA for OpenShell's advertised `wss` Harness endpoint.

Build the base OCE image from [the runtime Dockerfile](../../deploy/runtime/Dockerfile)
using its pinned inputs: OpenClaw commit
`11d3d04a1279781a770f6a6aa09e6322b064b80a`, Codex `0.160.0`, and the pinned
Node 24 build/runtime bases. The image requires Node 24.16 or newer; the
verified image ran Node 24.19.0. Keep the frozen lockfile, source checksum, and
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
keys, operator tokens, or OAuth material. `NODE_USE_SYSTEM_CA=1` makes Node use
the augmented system trust store while retaining normal certificate and
hostname verification. A CA change requires rebuilding and selecting the image.

For the Compose control-plane profile, select this local image through
`OCC_KUBERNETES_RUNTIME_IMAGE` before `dev-up`; the launcher imports it and
records an immutable reference. For real-runtime tests, follow the
[Kubernetes image import procedure](kubernetes.md#kubernetes-model-turns-and-secrets)
and set `OCC_TEST_KUBERNETES_GATEWAY_IMAGE` and
`OCC_TEST_KUBERNETES_AGENT_IMAGE` to the imported digest reference.

When OpenShell's operator OIDC issuer uses a private CA, also use a chart that
preserves the gateway image's public roots: `server.oidc.caConfigMapName` selects
the issuer bundle through `SSL_CERT_FILE`, alongside
`SSL_CERT_DIR=/etc/ssl/certs`. An issuer-only file without the public roots can
allow operator login while breaking refresh at a public OAuth token endpoint.
This is separate from the Agent Gateway's trust above; retain TLS verification
on both paths.

## Run the synthetic refresh proof

The manually selected `openshell-oauth` lane runs
[`openshell-oauth-credentials-real.test.mjs`](../../tests/integration/openshell-oauth-credentials-real.test.mjs)
against a real custom gateway and synthetic HTTPS OAuth issuer. It is outside
`ci` and `full`, enables `OCE_OPENSHELL_OAUTH_REAL=1`, and requires these inputs
in a private environment file:

| Variable                                  | Required input                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `OCE_OPENSHELL_OAUTH_GATEWAY_ENDPOINT`    | Custom OpenShell gateway endpoint.                                                    |
| `OCE_OPENSHELL_OAUTH_CA_FILE`             | Public gateway CA file.                                                               |
| `OCE_OPENSHELL_OAUTH_OPERATOR_TOKEN_FILE` | Authorized operator token file.                                                       |
| `OCE_OPENSHELL_OAUTH_DENIED_TOKEN_FILE`   | Token omitting `provider:credentials:read`.                                           |
| `OCE_OPENSHELL_OAUTH_TEST_TOKEN_URL`      | Synthetic issuer's HTTPS token endpoint.                                              |
| `OCE_OPENSHELL_OAUTH_KUBECONFIG`          | Dedicated disposable cluster kubeconfig.                                              |
| `OCE_OPENSHELL_OAUTH_KUBERNETES_CONTEXT`  | `k3d-occ-dev-oce-oauth-poc`; the test enforces this owned context and a loopback API. |
| `OCE_OPENSHELL_OAUTH_WORKSPACE_CHART`     | Matching OpenShell Workspace chart path.                                              |

```sh
node --env-file="$TEST_ENV_FILE" scripts/ci/run-tests.mjs run openshell-oauth \
  --state /tmp/oce-openshell-oauth-state.json \
  --results /tmp/oce-openshell-oauth-results.json
```

Missing prerequisites fail before execution. No real model credential is needed.
The case verifies rotating refresh material and authorized warm reads, not real
ChatGPT login, Harness injection, or model execution. A successful TLS handshake
or ready credential source also does not establish those outcomes.

For real-provider proof, use the Console for fresh device login, select the
resulting source on a dedicated Codex Agent, and verify initial workspace files,
an active deployment, a real model response, and a subsequent revision using
the same source. Select `codex-plugin` with `catalogSource: hosted` to verify
directory discovery. Selected runtime plugins remain unsupported; discovery
does not prove plugin execution. The remaining qualification boundaries are in
[external ChatGPT authentication](openshell.md#external-chatgpt-authentication-boundary).
