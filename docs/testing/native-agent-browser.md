# Native Agent browser tests

Use the `gateway-routing` lane to check browser chat through OCC, Kubernetes
routing, and the real OpenClaw runtime. The `oidc-agent-chat` QA scenario adds
Keycloak sign-in and signed admission claims to that path. It uses manually
created Default users with explicitly attached identities; automatic account
creation is covered separately by the PostgreSQL enrollment integration.

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

## What the test exercises

The browser signs in at the real Keycloak server, returns through the OCC
callback, verifies the original account ID, and opens an Agent with the resulting
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
Helm-installed production deployment or a proof of automatic enrollment, Git,
or OpenShell. A selected case that skips, lacks prerequisites, or cannot finish
a model turn is not a pass. Inspect the test result and captured browser/runtime
evidence before reporting success.

Cleanup removes the test namespaces and its temporary network attachments.
It preserves attachments that existed before the test; lane cleanup owns the
prepared server and cluster resources.
