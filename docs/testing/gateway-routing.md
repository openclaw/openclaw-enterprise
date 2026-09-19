# Private gateway routing tests

Use the local k3d launcher or the CI `gateway-routing` lane to prepare this
suite. Both paths add Envoy Gateway and cert-manager to an owned disposable
cluster.

## Setup and execution

Workspace-file conformance and Helm rendering are separate from the real
private-routing proof. The focused case requires Envoy Gateway v1.6.7 and
cert-manager controllers/CRDs in the selected disposable cluster, in addition
to the database, native gateway/Codex images, and authorized model credential.
It must use the real Envoy data plane; a hand-built TLS proxy does not exercise
the supported routing or authentication implementation.

The focused proof runs the production OCC API as a Kubernetes Deployment,
creates an Agent through production OCC composition, waits for Compute's
automatic HTTPRoute, writes and reads all four supported files,
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

For local execution, provide an authorized `OPENAI_API_KEY` in the environment
and run:

```sh
./scripts/k3d test
```

The launcher prepares the current controller and runtime images, owned k3d
cluster, isolated PostgreSQL database, controllers, and disposable CA before it
runs the focused case. Run `./scripts/k3d down` to remove those resources.

The k3d preparation keeps the Gateway API CRDs bundled with k3s and removes the
duplicate `gateway.networking.k8s.io` CRDs from Envoy Gateway's installation
manifest before applying its controller and Envoy-specific CRDs. This preserves
k3s storage-version ownership instead of attempting an unsafe CRD downgrade.

The focused fixture requires a supported local container engine. Preparation
builds and imports the current controller image, then the fixture runs the
production OCC API inside the disposable cluster. The API uses Compute's
standard Envoy Service DNS URL and HTTPS port; no test-only endpoint port or
host publisher is involved. A loopback port-forward exposes only the API to the
local OCC console and test coordinator. The worker remains in the Node test
process, so this is not a Helm-installed controller proof. The test applies the
chart's Gateway policies, rotates the listener key and API-side projected key,
and verifies certificate renewal without restarting OCC.

The ordinary [native-runtime suite](kubernetes.md#kubernetes-model-turns-and-secrets) leaves this additional routing case unselected. The earlier Docker manual-proxy proof has been removed because
Docker does not implement automatic private Agent routes.

## Related

- [Kubernetes tests](kubernetes.md).
- [Cleanup and troubleshooting](README.md#results-cleanup-and-troubleshooting).
