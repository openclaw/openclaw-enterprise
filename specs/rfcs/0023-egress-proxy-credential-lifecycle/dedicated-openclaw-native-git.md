---
rfc: index.md
---

# Dedicated OpenClaw with native Git

This amendment proposes native Git support for a dedicated OpenClaw Agent using TokenService, OpenShell Sandbox, and Credential Proxy. The existing [Repository placement RFC](../20261119-repository-network-policy.md) qualifies dedicated Codex; Kubernetes Compute currently refuses Repository credentials for dedicated OpenClaw.

## Deployment and trust

Compute may admit this combination only when the selected Compute and Sandbox can enforce its Repository policy. It places OpenClaw, native Git, and Git's HTTPS helper in the same Agent Sandbox, using the existing `agent` workload role. Kubernetes currently uses `images.gateway` for the OpenClaw worker; the separate Gateway workload does not receive the Repository credential. Qualify the immutable image and actual Git/helper executable paths before enabling the placement.

OpenClaw also needs authenticated Workspace node traffic under the exact Namespace and Agent route:

- `/node`
- `/node/__openclaw__/worker`
- `/node/__openclaw__/worker-bundle/v1/`
- `/node/__openclaw__/worker-transfer/v1/`

Compute and Sandbox must qualify each route's method, protocol, port, TLS identity, and recipient. Access to the whole Gateway origin is insufficient. The Repository owner derives the trusted Git/helper recipient and exact HTTPS destination, discovery `service` query, upload-pack and receive-pack rules from the saved Agent grant. See the [GitHub App policy](github-app-template-policy.md). Network grants can restrict these requests but cannot choose the recipient. Keep existing Repository and pull-request restrictions; do not give the Gateway, OpenClaw node process, `curl`, or a shell broad Repository or credential access. Plugin Connection Templates do not grant Repository access.

Use the existing [fresh-Harness staged deployment](worker-credential-configuration.md#amendment-activate-a-fresh-harness):

1. OCC admits the selected Compute, Sandbox, Proxy, and Harness, then freezes model, Plugin, and Repository bindings and policy in the Agent revision. The Repository binding records its Source, binding reference, consumer, and projection.
2. Compute prepares an idle Sandbox target. Worker configures Credential Proxy through Compute's callback and receives the Repository projection.
3. Compute verifies effective network and injection policy readiness, then prepares launch inputs using the projection.
4. Worker authorizes the Agent and its active Sources. Sandbox starts a fresh Harness; Compute publishes Agent routes after Harness and node readiness.

Refuse an unsupported or mismatched stored revision, image, recipient, Source, or policy. Do not fall back to the protected version-9 Codex route or widen its Codex-specific Repository validator and artifact admission. Embedded OpenClaw and two-cluster execution are outside this proposal.

## Interface changes

### API

No changes.

### IAM

No changes.

### Database entities

No changes.

### Driver contract

Extend the behavior of `ComputeDriver.validateRepositoryCredentials(harness, sandboxDriverId)` to accept qualified dedicated OpenClaw. Keep its signature and existing Sandbox staged operations. If private Compute/Harness composition cannot supply the trusted executable and image identity, submit the necessary public Driver contract change before implementing it.

## Simplifications

Reuse the Agent revision, Repository owner, `agent` workload role, staged projection, activation, and selective Source withdrawal. No parallel grant store or credential recipient is needed.

## Acceptance criteria

- Through production Fastify, PostgreSQL, Worker, and Kubernetes Compute, deploy one dedicated OpenClaw Agent with model, Slack Plugin, and Repository Sources; include Google when selected. Verify the immutable `agent` image, same revision and Sandbox, scoped node routes, and exact Git executable, helper, method, path, and discovery query. Refuse mismatched placement or recipients.
- Withdraw Slack through the normal Agent API and Worker without stopping or redeploying. Verify Slack delivery is removed while the revision, Harness identity, model, Git, and separately selected Google delivery remain intact.
- On the qualified running image, complete a real model turn that invokes native Git through OpenClaw's ordinary exec tool. Show a granted Repository operation and a denied request that does not reach its origin. Record the image digest, Sandbox and process identity, executable paths, request, and result. A manifest or PostgreSQL fixture does not prove this outcome.
