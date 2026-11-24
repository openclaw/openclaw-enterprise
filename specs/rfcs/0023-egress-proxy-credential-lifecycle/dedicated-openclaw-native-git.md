---
rfc: index.md
---

# Dedicated OpenClaw with native Git

This amendment proposes new support for an Agent that uses a dedicated OpenClaw Harness and native Git with the selected TokenService, OpenShell Sandbox, and Credential Proxy. Kubernetes Compute currently refuses Repository credentials for dedicated OpenClaw. The [Repository network-policy placement RFC](../20261119-repository-network-policy.md) explicitly qualifies dedicated Codex. This amendment extends that placement behavior to qualified dedicated OpenClaw; it does not claim this combination worked previously.

## Deployment and trust

The existing [`ComputeDriver.validateRepositoryCredentials(harness, sandboxDriverId)`](../../../packages/contracts/src/drivers/compute/index.ts) must accept dedicated OpenClaw only when the selected Compute and Sandbox can enforce the Repository policy on that Harness. Compute must place the Harness in the exact Sandbox for the Agent revision, using the existing `agent` workload role. Kubernetes Compute currently selects `images.gateway` for that OpenClaw Harness; the image setting's name does not make the separate Gateway workload a credential recipient. Qualify the actual immutable image and the native Git executable and HTTPS helper it contains before enabling support.

The existing inspected Workspace Gateway profile supports dedicated Codex and rejects the OpenClaw native worker profile. OpenClaw needs its own authenticated Agent node routes: `/node`, `/node/__openclaw__/worker`, `/node/__openclaw__/worker-bundle/v1/`, and `/node/__openclaw__/worker-transfer/v1/`, each under the exact Namespace and Agent route. Compute and Sandbox must qualify each required method, protocol, port, TLS identity, and recipient; permission to reach the whole Gateway origin is insufficient. OCC and Worker must recognize the exact qualified stored OpenClaw revision before choosing direct staged Repository delivery. A stale or mismatched recipient must fail without falling through to a legacy session.

The OpenClaw worker connects as an enrolled node and hosts Agent runs in its Sandbox. Qualification must establish that an ordinary OpenClaw Agent exec tool invocation runs native Git and its HTTPS helper inside that same Sandbox. Neither admission nor a generated manifest proves this command route. The Repository owner selects the trusted executable and helper from the qualified runtime; an Agent's network grant can restrict their requests but cannot choose or enlarge the credential recipient. Do not grant the Gateway, OpenClaw node process, `curl`, or a shell broad Repository network or credential authority.

The OpenClaw Control Plane (OCC) admits Repository bindings and Agent grants through the existing Repository owner. That owner derives the exact executable, destination, HTTPS Git discovery `service` query, and upload-pack or receive-pack rules, as specified by the [shared GitHub App policy](github-app-template-policy.md). Credential Proxy configures injection for those admitted requests; Sandbox enforces containment and the network policy. The Repository decision remains independent of Plugin Connection Templates. Existing stronger Repository and pull-request restrictions remain in force.

Use the staged Repository policy branch for this combination. The Repository owner's staged edit and deployment admission must qualify the selected Compute, Sandbox, Proxy, and Harness and freeze the full model, Plugin, and Git policy on the revision. The selected Sandbox and native compiler must enforce and observe that full policy before activation. This is distinct from the older version-9 protected Codex route: its Repository policy validator and Codex artifact-admission operation remain Codex-specific and must not be reused or widened for OpenClaw. If staged qualification fails, refuse the combination instead of falling back to those legacy operations.

Reuse the [staged credential deployment](worker-credential-configuration.md#amendment-activate-a-fresh-harness): the Agent revision records the Repository consumer, Source reference, binding reference, and projection. Compute prepares an idle target. Worker configures Credential Proxy for that target through Compute's callback and receives the Repository projection. Once network and injection policy are ready, Compute prepares the fresh launch inputs with that projection. Worker authorizes the Agent and its active Sources, then Sandbox starts a fresh Harness at activation. Compute publishes Agent routes after normal Harness and node readiness. Unsupported placement, an unverified image or command route, missing Source authority, or unready enforcement must refuse admission or prevent activation. Embedded OpenClaw and two-cluster execution are outside this proposal.

## Interface changes

### APIs

No changes.

### IAM

No changes.

### Database entities

No changes.

### Driver contracts

Change the required behavior of the existing `ComputeDriver.validateRepositoryCredentials` operation for the qualified dedicated OpenClaw combination. Its signature stays the same. No new public Driver member is proposed. Whether current private Compute/Harness composition can supply the trusted executable and image identity remains to be verified; if it cannot, submit the necessary public contract change for review before implementing it.

The selected Sandbox continues to use its existing staged prepare, policy apply/observe, activation, and withdrawal operations. Its legacy protected Codex Repository validator and artifact-admission contract are unchanged. B6 owns the complete staged Repository policy and native Git compiler support; this amendment changes the supported Compute/Harness placement.

## Simplifications

Reuse the existing Agent revision, Repository admission, staged projection and activation, and selective Source withdrawal. Do not introduce another image role, credential recipient, or parallel Git grant store.

## Acceptance criteria

1. Through the production Fastify API and PostgreSQL, enroll authorized model, Slack Plugin, and Repository Sources, save one dedicated OpenClaw Agent, and deploy it through the real Worker and Kubernetes Compute branch. Include a Google Plugin Source when that integration is selected. Inspect the generated Sandbox manifest and configured policies: the `agent` workload uses the qualified immutable image, every binding targets the same Agent revision and Sandbox, the authenticated OpenClaw node routes admit only the required scoped traffic, and Git injection matches the exact admitted executable, helper, method, path, and discovery query. A mismatched Sandbox or unsupported recipient prevents activation.
2. Withdraw the Slack Plugin Source through the normal Agent API and Worker. Verify that its route and injection are removed while the Agent revision and Harness identity stay unchanged and the model, Git, and any separately selected Google Plugin bindings retain their authorized routes and injection. Do not stop or redeploy the Agent to make withdrawal pass. This integration proof establishes retained configuration; use the live qualification below to claim actual tool or model usability.
3. Separately qualify the actual immutable image and running OpenClaw Agent. Complete a real model turn that invokes native Git through the ordinary exec tool, demonstrate one granted Repository operation, and show an ungranted request denied before its origin. Record the image digest, Sandbox and process identity, actual Git/helper paths, request, and result. A PostgreSQL or manifest fixture does not establish this live outcome.
