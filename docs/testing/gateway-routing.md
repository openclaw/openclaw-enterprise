# Private gateway routing tests

Prepare the [Kubernetes runtime environment](kubernetes.md#kubernetes-model-turns-and-secrets) and private `$TEST_ENV_FILE` first. This suite adds Envoy Gateway and cert-manager to that disposable cluster.

## Setup and execution

Workspace-file conformance and Helm rendering are separate from the real
private-routing proof. The focused case requires Envoy Gateway v1.6.7 and
cert-manager controllers/CRDs in the selected disposable cluster, in addition
to the database, native gateway/Codex images, and authorized model credential.
It must use the real Envoy data plane; a hand-built TLS proxy does not exercise
the supported routing or authentication implementation.

The focused proof creates an Agent through production OCC composition, waits
for Compute's automatic HTTPRoute, writes and reads all four supported files,
and asks a fresh native session for the marker supplied only through
`AGENTS.md`. It then replaces the gateway Pod and repeats file reads and fresh
model consumption. Proxy authentication denials, key rotation, and cert-manager
leaf renewal under the same CA are separate required assertions.

For CI-shaped setup, let `prepare.mjs` install the pinned Gateway API,
cert-manager v1.18.4, and Envoy Gateway v1.6.7 controllers, then create the
disposable test CA before `run-tests.mjs` invokes the case:

```sh
node scripts/ci/prepare.mjs \
  --lane gateway-routing \
  --state "$RUNNER_TEMP/state/gateway-routing.json" \
  --github-env "$GITHUB_ENV"
node scripts/ci/run-tests.mjs run gateway-routing \
  --state "$RUNNER_TEMP/state/gateway-routing.json" \
  --results "$RUNNER_TEMP/results/gateway-routing.json"
```

For local manual setup, install the same controllers into the disposable
cluster first. The fixture creates its own GatewayClass, CA Issuer, Gateway,
and service-key Secret. The default controller namespaces are
`envoy-gateway-system` and `cert-manager`; override them with
`OCC_TEST_ENVOY_GATEWAY_NAMESPACE` and `OCC_TEST_CERT_MANAGER_NAMESPACE` when
needed. Helm must be on `PATH` or selected by `OCC_HELM_BIN`.

When preparing the CA manually, create a disposable test CA before starting Node
so its ordinary TLS verifier trusts the cert-manager-issued leaf. Do not use a
production CA signing key:

```sh
umask 077
TEST_GATEWAY_CA_DIR=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
  -subj '/CN=OCC disposable routing test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$TEST_GATEWAY_CA_DIR/key.pem" \
  -out "$TEST_GATEWAY_CA_DIR/cert.pem"
export OCC_TEST_GATEWAY_CA_CERT_PATH="$TEST_GATEWAY_CA_DIR/cert.pem"
export OCC_TEST_GATEWAY_CA_KEY_PATH="$TEST_GATEWAY_CA_DIR/key.pem"
export NODE_EXTRA_CA_CERTS="$TEST_GATEWAY_CA_DIR/cert.pem"

OCC_TEST_GATEWAY_ROUTING_REAL=1 OCC_TEST_SLACK_LIVE=0 \
  node --env-file="$TEST_ENV_FILE" --test \
  tests/integration/harness-topology-k3d-routing-real.test.mjs
```

The focused fixture currently requires Docker Desktop and free local port 443.
Docker publishes that loopback port without running the test process as root.
TCP forwarders carry unchanged TLS bytes through `host.docker.internal` and a
Pod to the real Envoy listener, providing a genuine nonloopback downstream peer.
They do not implement HTTP,
authentication, header rewriting, or native RPC. OCC's production API and
worker run in the Node test process; this is not a Helm-installed controller
proof. The test applies the chart's Gateway policies, rotates the listener key
and API-side key file, and verifies certificate renewal without restarting OCC.
Remove only the newly created test CA directory after the run.

The ordinary [native-runtime suite](kubernetes.md#kubernetes-model-turns-and-secrets) leaves this additional routing case unselected. The earlier Docker manual-proxy proof has been removed because
Docker does not implement automatic private Agent routes.

## Related

- [Kubernetes tests](kubernetes.md).
- [Cleanup and troubleshooting](README.md#results-cleanup-and-troubleshooting).
