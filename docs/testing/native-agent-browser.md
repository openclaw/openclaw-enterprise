# Native Agent browser tests

Use the `gateway-routing` lane to check browser chat through OCC, Kubernetes
routing, and the real OpenClaw runtime. The `oidc-agent-chat` QA scenario adds
Keycloak sign-in and signed admission claims to that path. It creates Default users through first-login enrollment and verifies that
returning login reuses the account. The real Keycloak tests own the admission and
email-policy matrix. PostgreSQL enrollment tests cover policy changes, returning
identities, initial grants, concurrency, and transaction rollback.

## Run the combined OIDC journey

Prepare the [Kubernetes runtime prerequisites](kubernetes.md#kubernetes-model-turns-and-secrets)
and the [Keycloak host prerequisites](kubernetes.md#run-the-keycloak-lane).
Use a disposable k3d cluster and a dedicated database. The lane requires an
existing authorized model credential, digest-pinned runtime images, Chromium,
and a free `127.0.0.1:443` for Keycloak. Keep credentials in the
[private test environment](README.md#requirements-and-credentials).

From the repository root:

```sh
state="$PWD/.ci-state/oidc-agent-chat.json"
file="tests/integration/oidc-agent-chat-k3d-real.test.ts"
node scripts/ci/run-tests.mjs check-selection gateway-routing --file "$file"
node scripts/ci/prepare.mjs --lane gateway-routing --selected-file "$file" --state "$state"
node scripts/ci/run-tests.mjs run gateway-routing --file "$file" --state "$state" \
  --results "$PWD/.ci-state/oidc-agent-chat-results.json"
node scripts/ci/cleanup.mjs --state "$state"
```

Run cleanup after a preparation or test failure too. Preserve the private state
file until cleanup completes. Do not run another Keycloak lane on the same host.

The focused wrapper runs the same `oidc-agent-chat` scenario as the QA matrix.
Lane preparation attaches PostgreSQL to the disposable cluster before it
discovers and publishes the host port. Test files preserve that attachment;
lane cleanup removes PostgreSQL before the cluster network. Set
`OCC_TEST_BROWSER_EXECUTABLE` to use an installed Chromium browser; the lane passes
this optional selection to its browser tests. CI also installs Playwright's
FFmpeg binary for video recording when using an installed browser.
Its preparation omits the dedicated Codex sandbox probe because this journey
deploys only embedded OpenClaw Agents with `RuntimeDefault` seccomp. Preparing
the full `gateway-routing` lane still requires the Codex probe for its dedicated
execution cases. The hosted OIDC job retains a browser recording and screenshot
of the real model exchange; recording starts after sign-in.
To reuse an already prepared local environment through the QA entrypoint, keep its
Kubernetes, database, routing, and Keycloak variables, then run:

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_SCENARIOS=oidc-agent-chat \
  OCC_TEST_QA_PRESET=OpenClaw OCC_TEST_QA_INSTALLATION=kubernetes \
  node --test tests/integration/qa-matrix-real.test.mjs
```

`OPENCLAW_ENTERPRISE_CI_STATE` must identify the prepared cluster and database.
When Keycloak belongs to a separate prepared state, also set
`OCC_TEST_KEYCLOAK_STATE` to that private JSON file. Keep both states until their
owners finish using the resources. The shared-lane setup needs no separate
Keycloak state variable.

## Check an acknowledged chat turn across API replacement

Select `native-api-continuity` explicitly through the QA matrix. It invokes the
native-admin browser helper with dedicated Codex and Kubernetes; it is excluded
from `all` and cannot be combined with other scenarios. There is no new hosted
job, and the existing `gateway-routing` selection is unchanged.

On a Linux host, prepare an exclusive disposable loopback k3d cluster with enforcing NetworkPolicies,
Envoy Gateway and cert-manager, plus the [dedicated PostgreSQL database](postgresql.md#other-postgresql-suites).
Keep the limited application connection in `OCC_TEST_DATABASE_URL` and select the
cluster with `OCC_TEST_KUBERNETES_KUBECONFIG` and `OCC_TEST_KUBERNETES_CONTEXT`.
Set `OPENCLAW_ENTERPRISE_CI_STATE` to its prepared owner state; the selected
cluster and local Docker daemon must match that state and remain exclusively
reserved for this run.
Set these immutable image references and test CA paths using the
[Kubernetes runtime setup](kubernetes.md#kubernetes-model-turns-and-secrets):

- `OCC_TEST_PRODUCTION_CONTROLLER_IMAGE`
- `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`
- `OCC_TEST_KUBERNETES_AGENT_IMAGE`
- `OCC_TEST_GATEWAY_CA_CERT_PATH` and `OCC_TEST_GATEWAY_CA_KEY_PATH`

The stock images must already be available in host Docker; import the controller
and Gateway images into the selected cluster as required by that setup. The
fixture uses the local `/var/run/docker.sock`, creates a CA-only derivative of
the Agent image, and owns an internal provider network and temporary cluster DNS
entry. Do not share the cluster while it runs. It generates a synthetic model key
and provisions it through the ordinary Secret API; no live model key or PAT is
required. This fixture does not exercise an external model provider or OpenShell.

Install Playwright Chromium and OpenSSL. `OCC_TEST_BROWSER_EXECUTABLE` may select
an existing Chromium binary; `OCC_TEST_NATIVE_ADMIN_DOMAIN` and
`OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE` retain the native-browser and dedicated
Codex fixture settings. From the repository root, with the prepared inputs:

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_SCENARIOS=native-api-continuity \
  OCC_TEST_QA_PRESET=Codex OCC_TEST_QA_INSTALLATION=kubernetes \
  node --test tests/integration/qa-matrix-real.test.mjs
```

After a seed reply, the test waits for a successful `chat.send` acknowledgement
and an independently held provider response before replacing only the API Pod.
The original tab must reconnect without navigation or resending the accepted
turn, show one reply after the provider releases it, and complete a second turn.
The held reply contains a nonce supplied only to the provider. A fresh process
checks stored transcript entries separately from live Gateway history; final
browser counts and worker, Agent, Gateway and revision identities must agree.
The close-to-authenticated-reconnect interval includes API and local port-forward
replacement. This is a continuity assertion across a socket interruption,
not an uninterrupted connection or successful worker-transfer guarantee.

The helper prints its private artifact directory and writes `continuity.json`
after the assertions pass. The QA stage records assertions and cleanup separately;
overall success requires both to finish successfully. Fixture cleanup owns its temporary resources; retain
the result and cleanup outcome, and use the prepared environment's cleanup owner
for the database and cluster even after failure. Unresolved mutations or remaining
consumers retain the provider and its private journal for reconciliation. The
state lock covers the stage and its teardown, not an indefinite reservation after
failure: keep the cluster exclusive until retained resources are reconciled.
Registration or a skipped case
is not installed acceptance; this new case still needs an actual qualified run.

## What the test exercises

The browser signs in at the real Keycloak server, returns through the OCC
callback, creates the account, verifies that a returning login reuses its ID, and opens an Agent with the resulting
shared session. A disposable IdP Group supplies the signed admission claim. The journey
checks chat with `agent:operate`, administration denial, and a real model
response. Related native browser cases cover administrator access, Agent
boundaries, permission withdrawal, and session expiry.

The existing topology starts production controller and worker entrypoints in
Kubernetes. Its test ingress terminates local browser TLS. The API reaches the
same Keycloak issuer through a namespace-local Service and a scoped container
network attachment. Only the API receives the provider secret, combined
Keycloak/Gateway CA bundle, and provider egress rule. The provider secret is not
mounted in workers or Agents; model credentials remain Agent-owned.

This is real in-cluster API, provider, browser, and runtime proof. It is not a
Helm-installed production deployment or a proof of Git or OpenShell. A selected case that skips, lacks prerequisites, or cannot finish
a model turn is not a pass. Inspect the test result and captured browser/runtime
evidence before reporting success.

Cleanup removes the test namespaces and its temporary network attachments.
It preserves attachments that existed before the test; lane cleanup owns the
prepared server and cluster resources.
