# OpenShell tests

Verify provider-owned Codex execution and OpenShell filesystem and network
enforcement. Prepare [credentials](README.md#requirements-and-credentials)
and use the suite-specific infrastructure below.

## Start a reusable development environment

Use the [local Kubernetes OpenShell profile](../guides/deploy/local-kubernetes-development.md#start-the-openshell-fail-closed-profile)
for an ordinary OpenClaw Enterprise development stack. That profile starts the
real control plane, Gateway, and operator Workspaces. It prepares the supported
fail-closed Agent path but does not create an Agent.

Create the private Kubernetes-only OpenShell `v0.1.3-pre.2` environment from the
repository root:

```sh
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell
./scripts/dev-up
```

The launcher uses Docker or Podman only to host k3d and build or import images.
PostgreSQL, the OCE API and worker, and OpenShell Gateway run inside the cluster.
It leaves the environment running and does not change the default kubeconfig or
context. The generated OpenShell Backend uses a 30-second request deadline so a
loaded local cluster can complete create-time mutations without an avoidable
unknown outcome. Its disposable kubelet retains the imported immutable
OpenShell images until teardown because later revisions cannot pull them. No
model credential is needed for environment startup.

Stop the reusable environment before proving the setup and cleanup lifecycle in
a separate fresh cluster:

```sh
./scripts/dev-down
OCC_TEST_DEV_UP_OPENSHELL_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

The command verifies control-plane Pods, Workspace reconciliation, and cleanup;
it does not use the compatibility bridge or perform a model turn. The reusable
environment's startup output prints its API URL, kubeconfig, context, and
service-key file without printing credential contents.

Select the alternate proof when PostgreSQL, the OCE API, and the worker must
remain in Compose:

```sh
OCC_TEST_DEV_UP_OPENSHELL_COMPOSE_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

This case verifies the real Compose-backed control plane, the private Envoy
NodePort and trust projection, the OpenShell Gateway NodePort, operator
Workspace, and combined Compose and cluster cleanup. It uses the same
disposable-cluster and no-model-turn boundary as the Kubernetes-only case.

The OpenShell CI lane runs this lifecycle through `scripts/dev-up` and
`scripts/dev-down` before its credentialed Sandbox case.

Remove the owned environment when finished:

```sh
./scripts/dev-down
```

Cleanup permanently deletes this helper's cluster and in-cluster database. A
partial setup remains recorded for safe cleanup; run `down` before retrying. Set
the absolute `OCC_DEVELOPMENT_STATE_DIRECTORY` before every command to keep
multiple checkouts separate. Set `OCC_DEVELOPMENT_CONTAINER_ENGINE=docker` or
`podman` when automatic engine selection is ambiguous.

This launcher does not start a supported production Installation or an
interactive OCC Agent. The credentialed compatibility experiment remains the
separate real Sandbox suite below.

## OpenShell Sandbox

This suite needs the owned OpenShell CI recipe: a disposable K3s v1.36.4 k3d
cluster, matched kubectl, the selected RuntimeClass bound to the cluster's
`runc` handler, a successful RuntimeClass smoke Pod, Agent Sandbox
CRDs/controller, Helm, the OpenShell chart source, imported immutable OpenShell
gateway, sandbox runtime, and supervisor images, real gateway/Codex images, the
Kubernetes test database, `openssl`, and `OPENAI_API_KEY`. The standard k3d recipe alone is
insufficient because it does not install the CI-owned admission config,
RuntimeClass, Agent Sandbox, or OpenShell assets.

For CI-shaped setup, let `prepare.mjs` create the pinned K3s cluster, install
OpenShell prerequisites, and export the lane environment before
`run-tests.mjs` invokes the case:

```sh
node scripts/ci/prepare.mjs \
  --lane openshell \
  --state "$RUNNER_TEMP/state/openshell.json" \
  --github-env "$GITHUB_ENV"
node scripts/ci/run-tests.mjs run openshell \
  --state "$RUNNER_TEMP/state/openshell.json" \
  --results "$RUNNER_TEMP/results/openshell.json"
```

Hosted CI runs the default Codex case. To run the native case the same way,
also export `OCC_TEST_OPENSHELL_HARNESS=openclaw`.

For manual setup, prepare these inputs using the
[OpenShell test settings](#openshell-test-environment) and
[OpenShell requirements](../reference/drivers/openshell-sandbox.md#kubernetes-and-admission-requirements),
then run the exact file:

```sh
OCC_TEST_OPENSHELL_K3D_REAL=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/sandbox-driver-openshell-k3d-real.test.mjs
```

Both modes compose the `openshell` Backend with the Sandbox and Credential
Gateway Drivers. They register an `openai` credential source through the
production API from an OCC Secret holding `OPENAI_API_KEY`, check its live
`ready` status, and bind the Agent with `credential_source`. The Agent service
principal receives `operate` on the source only, not on the Secret.

The default Codex scenario uses the production Driver path. Compute sends only
`APP_TOKEN_SHA`; OpenShell supplies `runtime.json`, `config.toml`, and the
one-shot node setup credential through a revision-owned provider. The test
checks that the raw app-server token and model key are absent from Pod specs and
nonsecret provider data. It then verifies missing, incorrect, and correct bearer
requests through the exposed route and runs the real model and tool turns from
the Agent Gateway. Exact workload identity, approved mounts and privileges,
source withdrawal, denied egress, replacement, and cleanup remain required.
Missing prerequisites fail rather than skip.

The Codex scenario then updates the source through the API, withdraws it from
the running Agent, waits for `revoked`, and expects the next model turn in the
same process to fail. It accepts any turn failure, so it does not yet tell a
credential rejection from a transport error or a restarted process. Full
integration lanes run only from `main`, so this proof runs after a withdrawal
change lands, not on its pull request.

`OCC_TEST_OPENSHELL_HARNESS` defaults to `codex`. Select `openclaw` to verify
that the native Harness requests no inbound OpenShell service exposure and
completes a real model turn through its outbound enrolled-worker connection.
The selected network policy permits provider egress from the Codex executable
for Codex or from the Node executable for native OpenClaw. The native verification
fixture explicitly admits enrollment egress for the Node executable and the
Workspace Gateway's exact host and configured port, including the
high loopback port allocated by the Docker Desktop or Podman Machine verification
relay on macOS. The real fixture
also gives the delegated Sandbox the same 2 GiB Harness memory limit as
Kubernetes Compute; the cluster's 1 GiB container default is insufficient while
the native worker installs its Gateway bundle.

Use an OCE runtime image built from the OpenClaw source commit pinned by
`deploy/runtime/Dockerfile`. The native proof requires the environment-managed
`connect --ephemeral` path; OCE supplies its one-use enrollment target through a
private file instead of a process argument. The Codex workspace-node proof still
requires the `node run --pair-if-needed` and `--commands` CLI options. The test
configures the private Gateway with its fully qualified `.svc.cluster.local`
hostname so OpenShell policy DNS, the listener certificate, the HTTPRoute, and
node pairing use the same name.

### Native OpenClaw with k3d

The [k3d helper](kubernetes.md#develop-with-local-containers-and-k3d) selects
the native case with `--harness openclaw`:

```sh
./scripts/k3d test --harness openclaw
./scripts/k3d demo --harness openclaw
```

`test` and `demo` use the same verification-only compatibility bridge; it does
not promote that bridge into a supported production path.

This selection prepares the pinned OpenShell lane, builds the sibling
`../openclaw` checkout, and records its commit with the prepared environment.
Set `OCC_K3D_OPENCLAW_SOURCE` to another absolute source checkout. Codex and
native OpenClaw use separate helper-owned state. `demo` keeps the proven topology
running after its real turn, opens the Control UI's new-session flow and the OCC
console on loopback, and prints its isolated integration username instead of
using the development login. It leaves the dedicated worker slot free, so the
first browser session uses the dedicated-native profile without the Gateway
receiving the Harness's model credential.

Without `--harness`, `copy` selects the one active demo and `down` removes both
helper-owned Harness environments; pass `--harness codex` or
`--harness openclaw` to select one.

### Gateway prerequisite and native test bridge

The integration uses an operator-owned Helm wrapper to install the OpenShell
gateway before delegating to the Driver. The bundled Driver does not install
that gateway. The Codex path avoids unsupported Kubernetes projection: Compute
supplies the app-server verifier, the Driver uses provider-managed runtime files,
and the OpenShell development profile disables projected workload identity.
Explicitly requesting that identity fails before provisioning.

The fixture gives that gateway its own scoped DNS/API access. Ordinary Harness
DNS comes from Compute. Workspace-node policies select the OpenShell supervisor
label (`openshell.ai/boundary-role=supervisor`) and the tenant's Agent Gateway
Service in both directions, because the supervisor originates the proxied call.
The test requires the provider Harness Pod to carry `provider-fenced-v1`; it
receives no ordinary Compute model or authentication egress. Older fixtures
may retain broad policies or Sandbox templates without the profile. Inspect
their ownership and replacement routes before removing stale policies, or
recreate the disposable fixture. Reusing a Sandbox by name does not update its
template.

The Codex case now uses the production Driver path. The Agent Pod receives the
app-server token verifier, provider-file paths, an OpenShell model-key
placeholder, and a workspace-node bootstrap placeholder, but no raw credential.
Its writable home and temporary state live below
`/sandbox/.openclaw-runtime`, which is a revision-scoped subpath of the Agent
PVC. Persistent workspace, node, session, and image state remains on separate
exact subpaths mounted below `/sandbox/.openclaw-mounts`. Node state is addressed
through a process-created `state` child of its real mount because atomic
replacement rejects symlink parents and cannot tighten the root-owned mount
root; bootstrap links the remaining runtime paths. The real test confirms that the Sandbox process
identity can write the runtime home. The exposed route uses bearer
passthrough: correct Gateway authentication upgrades, while missing and
incorrect credentials fail. The real turn begins in the Gateway and executes in
the OpenShell-owned Harness. The OpenShell lane also runs the protected local
first-Agent test with `--harness codex` twice, against its own Compose-plus-k3d
stack and against its own Kubernetes-only stack.
It checks that the Gateway uses the advertised WebSocket origin, maps its exact
hostname to the installed OpenShell Gateway Service, and leaves the direct Agent
Service inactive.

The Codex case also proves OAuth2 refresh sources. It starts a disposable
Keycloak that serves HTTPS with a private CA, mounts a bundle of Node's public
roots plus that CA over the Namespace gateway's `SSL_CERT_FILE` through the
chart's extra-volume values, and admits only the gateway Pod to the issuer. An in-cluster echo service verifies each delivered token's
Keycloak signature, so tokens never reach test output. The case covers
background re-minting in a running Harness, forced rotation, reauthorization
after revoking the user's sessions, and deletion.

For the exact Compose-plus-k3d startup, repeatable first-Agent command, current
checkpoint, and symptom-based recovery notes, see
[Resume the OpenShell first-Agent proof](openshell-first-agent.md).

The native OpenClaw selector retains its verification-only bootstrap Job and
PVC bridge. It is a separate containment experiment, not a supported
first-Agent path. The pinned Kubernetes driver chooses workload identity independently
of `policy.process`: this k3d fixture uses its default UID/GID `10001:10001`.
The bridge prepares private storage for that identity and verifies the resulting
workload Pod identity. Preparing it for the image or policy UID `1000` leaves
foreign-owned ancestors that fs-safe rejects, even when Kubernetes grants group
write access. The supervisor launches with `TMPDIR=/tmp`; the bridge switches the
native worker to its private temporary mount before running its entrypoint.
It places bootstrap code inside the compressed program, preserving the Driver's
fixed-loader contract. Readiness retries reuse the completed bootstrap Job because
deleting its Pod invalidates the copied ServiceAccount token. The Job remains until
the token's admitted lifetime ends or the test cleans it up. See the
[qualification contract](../reference/drivers/openshell-sandbox.md#qualification-contract)
and the [pre.5 experiment handoff](openshell-pre5-local-experiment.md).

Local `sandbox-driver-startup`, `controller-lifecycle`, and
`postgres-platform-state` integration tests cover driver selection and Backend
membership, revision lifecycle, and persistence. The
`credential-source-occ`, `openshell-gateway-wire`, and `kubernetes-compute`
conformance tests cover credential source admission, provider RPC encoding, and
Compute's credential-source rendering. None of these exercises the real
OpenShell tools.

### Development profile

The opt-in development-profile integration installs PostgreSQL and OCE with
Helm in the owned k3d cluster, installs the checksum-pinned OpenShell assets,
and verifies the bootstrap Namespace, RuntimeClass, Agent Sandbox API,
deployment Gateway, operator label, workspace ServiceAccount, and actual
matching Workspace through the Gateway API. It then creates another
OCC Namespace and verifies that the Driver applies the same ServiceAccount and
creates its matching Workspace without another Helm release. In that
Namespace it uses the checkout-local `occ` CLI to register a synthetic `openai`
credential source, reads its live `ready` status, finds the matching provider in
the Namespace's OpenShell Workspace, creates a `credential_source` IAM Role, and
deletes the source, which removes the provider:

```sh
OCC_TEST_DEV_UP_OPENSHELL_REAL=1 \
  node --test tests/integration/dev-up-openshell-k3d-real.test.mjs
```

The Driver, rather than a per-Namespace Helm release, applies the rendered
workspace-chart resources before creating the Workspace. The case requires an
executable checkout-local `bin/occ`, Docker or Podman, k3d, kubectl, Helm, and
network access to the pinned sources and images. Set
`OCC_TEST_DEV_UP_CONTAINER_ENGINE=podman` to select a prepared Podman engine.
It creates unique cluster, state, API, and Kubernetes port names and removes
only those resources. Missing selected prerequisites fail.

This case proves development orchestration, the two real charts, Driver-owned
operator resource reconciliation, Gateway Workspace creation, and the
credential-source CLI and API path. The synthetic key proves no model
authentication. It does not create an Agent or Sandbox; for the manual Agent
walkthrough, see [Use a credential source on the local OpenShell profile](../guides/deploy/openshell-credential-sources.md). The
The real Sandbox Driver case is the Agent-level proof for the ordinary
plugin-free dedicated Codex workflow.

## OpenShell test environment

[`sandbox-driver-openshell-k3d-real.test.mjs`](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)
is selected by `OCC_TEST_OPENSHELL_K3D_REAL=1` or by setting any Kubernetes,
image, database, or OpenShell-specific prerequisite. If any of those variables
is present while the flag is not `1`, prerequisite validation still fails; use a
scoped environment file for this suite.

| Variable                                  | Requirement or default                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_OPENSHELL_K3D_REAL`             | Set to `1` to explicitly opt into the real OpenShell integration.                                                                                   |
| `OPENAI_API_KEY`                          | Existing authorized provider credential, registered as a credential source for the required real model turn.                                        |
| `OCC_TEST_OPENSHELL_HARNESS`              | `codex` (default) selects the app-server proof; `openclaw` selects the dedicated native worker without an inbound Harness exposure.                 |
| `OCC_TEST_OPENAI_MODEL`                   | Authorized provider model; defaults to `gpt-6-astra`.                                                                                               |
| `OCC_TEST_KUBERNETES_KUBECONFIG`          | Absolute kubeconfig path for the dedicated disposable k3d cluster.                                                                                  |
| `OCC_TEST_KUBERNETES_CONTEXT`             | Explicit `k3d-*` context with a verified loopback HTTPS API.                                                                                        |
| `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`       | Imported immutable real OpenClaw gateway image; `OCC_TEST_KUBERNETES_RUNTIME_IMAGE` is accepted as a fallback.                                      |
| `OCC_TEST_KUBERNETES_AGENT_IMAGE`         | Imported immutable Harness image; Codex and runtime-image fallbacks are accepted. The native selector uses the OpenClaw source image.               |
| `OCC_TEST_DATABASE_URL`                   | Migrated disposable loopback PostgreSQL database named `openclaw_k8s_*`.                                                                            |
| `OCC_TEST_OPENSHELL_HELM`                 | Helm binary used to install the namespace-scoped OpenShell gateway.                                                                                 |
| `OCC_TEST_OPENSHELL_HELM_CHART`           | OpenShell Helm chart path or chart archive.                                                                                                         |
| `OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART` | OpenShell workspace Helm chart path or chart archive used for operator-mode namespace RBAC.                                                         |
| `OCC_TEST_OPENSHELL_GATEWAY_IMAGE`        | Imported immutable OpenShell gateway image pinned by SHA-256 digest.                                                                                |
| `OCC_TEST_OPENSHELL_SANDBOX_IMAGE`        | Imported immutable OpenShell sandbox runtime image pinned by SHA-256 digest.                                                                        |
| `OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE`     | Imported immutable OpenShell supervisor image pinned by SHA-256 digest.                                                                             |
| `OCC_TEST_OPENSHELL_CHART_VERSION`        | Optional OpenShell chart version; defaults to `0.1.3-pre.2`.                                                                                        |
| `OCC_TEST_KEYCLOAK_IMAGE`                 | Optional digest-pinned Keycloak image for the OAuth2 refresh proof; defaults to `tests/fixtures/keycloak/image.json`. CI imports it into k3d.       |
| `OCC_TEST_OPENSHELL_RUNTIME_CLASS`        | Existing RuntimeClass used by Agent Sandbox Pods; CI creates the selected RuntimeClass, defaulting to `openshell-sandbox`, with the `runc` handler. |

The selected cluster must already expose the Agent Sandbox CRD and a ready Agent
Sandbox controller. See the
[OpenShell SandboxDriver testing guide](#openshell-sandbox) for
the required cluster, image, database, RuntimeClass, and chart setup.

The CI bootstrap verifies the `v0.1.3-pre.2` source archive checksum, packages
the chart from that tag, and imports gateway, sandbox runtime, and supervisor
images published under the tag's commit SHA. It does not depend on prerelease
GitHub Release assets or a semver-tagged chart.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
