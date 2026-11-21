# Proof results for PR #4024 — external OpenShell gateway with OIDC

Run date: 2026-10-29. Branch head at run time: `d33088e53` plus two
uncommitted working-tree changes (the token-request CA-trust fix, committed
after the run, and a local launcher workaround, see `launcher-workaround.diff`).

## Environment

- `./scripts/dev-up` (Kubernetes control plane, OpenShell sandbox driver) from
  this branch, on a disposable loopback k3d cluster, with the four
  `OCC_DEVELOPMENT_OPENSHELL_*` external-gateway inputs plus the new
  `OCC_DEVELOPMENT_OPENSHELL_CA_FILE` bundle.
- A real Keycloak 26.7.5 (the repository-pinned digest) as the OIDC issuer:
  confidential client for OCC, client-credentials grant, audience
  `openshell-cli`, realm roles `openshell-user`/`openshell-admin` for the
  service account, TLS from the proof CA.
- The real OpenShell v0.1.5 gateway from the approved digest-pinned image,
  run as a container outside the launcher cluster, operating the launcher
  cluster through a kubeconfig (`workspaceMode: operator`, the profile's
  `openshell.ai/openclaw-workspace` namespace label, OIDC issuer = the
  Keycloak realm, advertised gRPC endpoint on its own address).
- A real private OpenAI-compatible endpoint (not named here) provided the
  model credential for the model-turn attempt, fed through
  `OPENAI_API_KEY_FILE`.

Local, unposted-to-PR environment workarounds (not part of this PR):

- The k3d node's DNS resolver pointed at another environment's cluster DNS;
  the run selected `OCC_DEVELOPMENT_K3D_DNS_RESOLVER` explicitly. Launcher
  input, no code change.
- Current Docker refuses a platform-filtered `image save` of locally pulled
  multi-platform indexes, which blocks the launcher's image import. The
  environment ran with a local launcher patch that resolves the platform
  child image from the manifest list and saves that reference:
  `launcher-workaround.diff`. This is a pre-existing launcher bug that other
  PR watchers hit too; it should go upstream as its own change.

## Results

| Scenario | Result | Evidence |
| --- | --- | --- |
| 1. `occ dev up` against an external gateway + real IdP | **Passed with a finding** — platform startup, bootstrap Namespace, workspace creation, and credential registration all completed through the OIDC-authenticated external gateway; agent deployment is blocked by the provider-Harness route gap below | `scenario-1-platform-startup.md`, `scenario-4-model-turn.md` |
| 2. Live NetworkPolicy enforcement for the new egress rules | **Passed** — the policy-selected control-plane pods reach exactly the gateway gRPC port and the issuer, and are refused the same hosts on unadmitted ports | `scenario-2-network-policy.md` |
| 3. Real-IdP client-credentials proof | **Passed** — tokens minted by real Keycloak are validated by the real gateway; wrong client secret is rejected by the issuer; a token without the required role is refused by the gateway | `scenario-3-real-idp.md` |
| 4. Supervisor callbacks + model turn | **Blocked** — the compute driver requires the in-cluster provider Harness network route (`providerHarness`) for SandboxDriver harness endpoints, which the external topology does not provide; a design decision is needed | `scenario-4-model-turn.md` |

## Principal finding (cuts against the PR)

Agent deployment in the external topology fails with
`SandboxDriver Harness endpoint requires an exact provider network route`
(`KUBERNETES_CONFIGURATION_INVALID`), because the compute driver demands the
`compute.network.providerHarness` bridge whenever a SandboxDriver harness
endpoint exists, and this PR omits it for external gateways. The model
credential itself was accepted and registered with the external gateway; the
failure is purely the missing harness route. Options: create a selectorless
bridge Service to the external gateway in the launcher, or teach the compute
driver to route external advertised endpoints directly. Needs a design
decision before the external topology can deploy Agents.

## Not proven live

- No supervisor callback actually traversed the admitted route: supervisors
  appear with a sandbox, and agent deployment is blocked before that point.
  The callback policy is rendered and applied (see the NetworkPolicy capture),
  but its data path was not exercised.
- The Compose control-plane variant was not run.

## Teardown (environment left running for inspection)

```sh
cd <checkout> && env OCC_DEVELOPMENT_STATE_DIRECTORY=/tmp/oc4024/state-parent/state \
  OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell \
  ./scripts/dev-down
docker rm -f oc4024-gateway oc4024-keycloak
docker network rm k3d-occ-dev-oc4024
```
