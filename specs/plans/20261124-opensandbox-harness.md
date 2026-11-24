---
rfc: ../rfcs/20261124-opensandbox-harness.md
---

# Run a dedicated Codex Agent in OpenSandbox

- **ID:** RFC-20261124-opensandbox-harness
- **Delivery status:** In progress
- **Owner:** Sandbox and Kubernetes Compute contributors
- **Authority:** [OpenSandbox Harness proposal](../rfcs/20261124-opensandbox-harness.md)
- **Source baseline:** `e1d4fb8c81816576a35937a2e2413852bc3a5459`

## Outcome and scope

The goal is to let operators select where the Harness runs while users keep deploying Agents through
the existing API. The first delivery is an opt-in development Driver. A separate milestone puts
OpenClaw Control Plane (OCC) in charge of model and repository access. The pilot results below do
not qualify either path for production.

## Contract and source touchpoints

[Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/harness/runtime.ts) calls
`provisionHarness` and checks the returned resource against the Agent revision and Namespace.
Compute retains the Gateway, Service and workspace claim. The external Driver owns the
`BatchSandbox` and must account for its child Pod during cleanup.

Two admission paths need attention before the installed pair can serve both grants.

- [Staged model admission](../../packages/occ/src/agent-deployment-admission.ts) excludes repository
  credentials. The
  [Installation loader](../../apps/controller/src/composition/installation-config.ts) ties the
  legacy Credential Gateway to OpenShell. Keep new model Sources with TokenService as specified in
  the [credential lifecycle RFC](../rfcs/0023-egress-proxy-credential-lifecycle/index.md).
- [Protected Git admission](../../packages/occ/src/credential-egress-admission.ts) requires
  authorization for the exact send and policy reduction version 2 to share an execution with model
  access. The
  [single-repository profile](../../packages/contracts/src/drivers/credential-proxy/index.ts) can
  confirm online authorization. This lets an authorized request proceed after the decision and does
  not impose the required deadline to start a send.

## Implementation

1. **Qualify the development Driver.** Load the same package in the API and worker. Pin the operator
   and workload images by digest. Use a disposable cluster with enforced NetworkPolicies. Keep the
   example disabled by default. Reject protected inputs it cannot enforce.
2. **Review the combined admission.** Specify a new revision version, required sender capabilities
   and a single release decision for both grants. Verify the recipient and the effective network and
   credential policies before starting the Harness. Refuse a missing or stale binding. Keep the
   legacy Gateway and existing revision versions on their current paths.
3. **Install the trusted sender.** Use the
   [GitHub repository policy](../../apps/controller/src/drivers/repo/github/policy.ts) to select one
   repository by ID with read-only permissions. Bind the sender to the worker's
   [Git authority](../../packages/contracts/src/protected-repository-git.ts). Permit one exact
   request per authorization. Verify TLS, reject redirects and keep provider material out of the
   Gateway, Harness, transcripts and logs. The serving path must work without `pods/exec`. Record
   attributable allow and deny decisions without recording credentials.
4. **Qualify withdrawal and recovery.** Withdraw the first Agent's Git grant through OCC. Verify the
   next request stops before GitHub, the model route stays available, and the second Agent can still
   fetch. Restart the worker after a lost acknowledgment. Observe the original reduction and verify
   that an old startup cannot restore the route. Stop, replace and delete the Agent. Confirm removal
   of its recipient, workload, routes and credentials.
5. **Qualify the installation.** Restrict the operator to the tenant workloads it manages. Use
   admission policy to prevent unauthorized mounts and placement. Verify that the operator cannot
   read unrelated Secrets directly or through a workload it creates. Separate trusted Gateway nodes
   from Harness nodes. Verify digest pins, restricted Pod Security, storage isolation and the
   supported Kubernetes versions. Test the native shell on a node that passes the
   [Codex sandbox checks](../../docs/guides/deploy/codex-sandbox.md). Update the Driver reference,
   deployment guide and runtime flow when the installed path passes.
6. **Qualify VM placement separately.** Match the revision, `BatchSandbox` UID, Pod UID, runtime
   handler and guest. Test an absent or wrong handler, network isolation, credential custody, node
   loss, guest termination and volume reassignment before another writer starts.

## Verification

These were local experiments. The RFC change itself installs no Driver.

- **AC-1. Docker startup passed.** The packaged Codex app-server accepted an authenticated peer.
  Missing or incorrect credentials failed. Cleanup removed the trial workload.
- **AC-2. Agent startup passed on k3d.** The API and PostgreSQL worker deployed a saved Agent. The
  Gateway reached Codex, the workspace node enrolled, and the Agent returned a controlled reply. A
  live listener accepted the control connection and refused the Harness connection. The full set of
  identity and policy refusals remains to be qualified.
- **AC-3. Replacement passed on k3d.** After a lost create reply, the Driver recovered the original
  object. After a lost delete reply, it waited for the previous Pod to disappear. The Agent read its
  file after replacement and again after stop and redeploy. Deletion spared an unrelated sandbox.
- **AC-4. OCC enforced Git withdrawal against a local origin.** In a Docker experiment, Git fetched
  and pushed the allowed ref. Another repository and ref were denied. After withdrawal, OCC refused
  fetch, push and draft creation before the origin received a request. The issuer revoked the test
  token independently. This experiment used a test issuer and sender.
- **AC-4. A host enforced Git withdrawal against GitHub.** Two saved Agents called a read-only Model
  Context Protocol tool. The host used `kubectl exec` to run Git in each calling Harness. Each fetch
  verified the commit in a temporary bare repository and returned the commit ID. After the host
  withdrew one grant, GitHub still accepted the token from the host. The first Agent's next read
  failed, its chat continued, and the second Agent fetched again. Both Gateways were denied. Samples
  from each Harness contained no copy of its GitHub token.
- **AC-4 remains open for the installed pair.** The host owned the grants and used a separate model
  sender. The stock sender rejected the live response. Each Harness held a test bearer. The native
  shell could not start its workspace sandbox on the test node.
- **AC-5 remains open.** No VM-backed runtime was tested.

## Delivery record

The Docker trial used OpenSandbox server `d098823411816e73381cfedc7d10429e55bf5b31` and Codex
0.164.0. The k3d trial used OpenSandbox controller 1.3.0-rc.3 and Kubernetes 1.35.8. The controller
release listed support through Kubernetes 1.34. The trial runtime image predates the source baseline
above.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-24 — Proposed the delivery steps and recorded local pilot results against the interfaces
  at `e1d4fb8c`.
