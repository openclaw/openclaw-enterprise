# Scenario 4 — supervisor callbacks and the model turn

**Result: blocked**, by a real gap in the external topology that needs a
design decision. Everything before agent deployment worked, including the
model credential flow through the external gateway.

## What ran

A first-Agent deploy against the running external-gateway profile, using a
real private OpenAI-compatible endpoint (not named here; it serves the
Responses API) as the model provider, with the model credential fed through
`OPENAI_API_KEY_FILE` from a private file. The run used the repository's
`scripts/first-agent.mjs` flow with one local change (the provider's
`baseUrl` read from an environment variable); the changed script was kept
outside the repository.

## What worked

```
Saving the model credential in the local platform Secret...
Registering the model credential with the OpenShell gateway...
Creating Agent oc4024-proof-agent...
Authorizing the Agent to use its exact model CredentialSource...
Deploying the Agent to local Kubernetes...
```

The model credential was accepted and **registered with the external
gateway** — a `GetProviderCredentials`-path RPC over the OIDC-authenticated
connection — and the Agent and its revision were created. The endpoint itself
answered the Responses API (verified directly before the run; no synthetic
provider was involved).

## What failed

The revision reconcile fails in `prepare_revision` with:

```
code: KUBERNETES_CONFIGURATION_INVALID
message: SandboxDriver Harness endpoint requires an exact provider network route.
```

The compute driver requires `compute.network.providerHarness` — the in-cluster
ClusterIP bridge to the gateway's harness endpoints — whenever a SandboxDriver
harness endpoint exists. This PR omits it for external gateways (the PR's
stated position was that an external gateway advertises its own real URLs, so
ordinary routing applies). The compute driver does not support that yet: no
agent gateway can enroll its workspace node, so no sandbox is created, no
supervisor runs, and no model turn happens.

## Consequences for the PR's claims

- Supervisor callbacks: the callback policy is rendered and applied in the
  workspace namespace (Scenario 2), but no supervisor existed to traverse it.
  The supervisor-callback claim is unproven live.
- The model turn did not run. The model endpoint, credential storage, and
  credential registration with the external gateway all worked.

## Options (needs a design decision)

1. The launcher creates a selectorless bridge Service (with Endpoints at the
   external gateway's resolved addresses) in the platform namespace and
   renders `providerHarness` for it, keeping the compute driver unchanged.
2. The compute driver learns to route a SandboxDriver harness endpoint whose
   URL is already directly reachable (an external gateway's advertised
   origin), with NetworkPolicy admission for it.
