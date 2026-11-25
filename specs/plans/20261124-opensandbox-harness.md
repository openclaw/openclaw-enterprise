---
rfc: ../rfcs/20261124-opensandbox-harness.md
---

# Run a dedicated Codex Harness in OpenSandbox

- **ID:** RFC-20261124-opensandbox-harness
- **Delivery status:** In progress
- **Owner:** Sandbox and Kubernetes Compute contributors
- **Authority:** [OpenSandbox Harness proposal](../rfcs/20261124-opensandbox-harness.md)
- **Source baseline:** The original pilots used `e1d4fb8c81816576a35937a2e2413852bc3a5459` as the
  reference for OCE interfaces. The staging steps below use `454af32efaf499b367f8d435434ce633e8a09ed6`.

## Outcome and scope

First, let an operator select OpenSandbox for a dedicated Codex Harness. Users still deploy Agents
through the existing API. Then qualify one read-only Git repository for that Harness. OpenClaw
Control Plane (OCC) installs the policy. A dedicated agentgateway endpoint enforces it outside the
Pod and any guest VM. The model route stays independent of Git.

## Contract and source touchpoints

[Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/harness/runtime.ts) calls
`provisionHarness` for placement alone. Compute retains the Gateway, Service and workspace claim.
The Driver owns the `BatchSandbox` and must account for its child Pod during cleanup.

The [credential lifecycle RFC](../rfcs/0023-egress-proxy-credential-lifecycle/index.md) owns staged
delivery. At `454af32e`, [admission](https://github.com/openclaw/openclaw-enterprise/blob/454af32efaf499b367f8d435434ce633e8a09ed6/packages/occ/src/agent-deployment-admission.ts#L485-L530)
can save repository and model bindings together using admission version 8. Three checks block this pair.

- [Git recipient admission](https://github.com/openclaw/openclaw-enterprise/blob/454af32efaf499b367f8d435434ce633e8a09ed6/apps/controller/src/composition/installation-config.ts#L257)
  requires a dedicated Codex Harness and a matching OpenShell pair. Qualify the OpenSandbox
  recipient separately. Verify that an unqualified or mismatched recipient receives no credential.
- The [Installation loader](https://github.com/openclaw/openclaw-enterprise/blob/454af32efaf499b367f8d435434ce633e8a09ed6/apps/controller/src/composition/installation-config.ts#L277)
  selects the OpenShell qualifier. Keep that check. Qualification of other pairs is deferred until
  after 1.0. Add a separate check for OpenSandbox only when it can enforce the complete admitted policy.
- [Compute rejects an external proxy route](https://github.com/openclaw/openclaw-enterprise/blob/454af32efaf499b367f8d435434ce633e8a09ed6/apps/controller/src/drivers/compute/kubernetes/index.ts#L7895-L7929)
  until the Sandbox can enforce it. Prove that all allowed Git traffic takes the selected route.
  Omitting the route or relying on a Git environment variable would leave a bypass.

## Implementation

1. **Qualify placement.** Load the same opt-in package in the API and worker. Pin operator and
   workload images by digest. Use a disposable cluster with enforced NetworkPolicies. Keep the
   example disabled by default. Reject protected inputs. Verify the controller UID, child Pod UID,
   authenticated Gateway connection and workspace enrollment through deployment, replacement and stop.
2. **Stage the two bindings.** Select OCC TokenService and a single registration for the Sandbox
   and [Credential Proxy](https://github.com/openclaw/openclaw-enterprise/blob/454af32efaf499b367f8d435434ce633e8a09ed6/packages/contracts/src/drivers/credential-proxy/index.ts#L531-L587).
   Admit one GitHub repository by ID with read-only contents permission, within the Installation
   limit, and a separate model Source. Preserve the existing Source owners. Compute calls
   `deployProxy` and `provisionStagedHarness`. The [worker](https://github.com/openclaw/openclaw-enterprise/blob/454af32efaf499b367f8d435434ce633e8a09ed6/apps/controller/src/worker.ts#L6364-L6409)
   supplies a resolver for each binding to `configureDeployment`. Push a short-lived GitHub App
   installation token to this sandbox's Git endpoint. Install only nonsecret provider placeholders in
   the Harness. Verify network policy and `getDeploymentStatus` before `prepareStagedHarness`
   and `activateStagedHarness`. Block startup if identity, readiness or mandatory routing cannot be verified.
3. **Allow fetches from one repository.** The Sandbox must verify the executable and prevent direct egress.
   Authenticate the sandbox at ingress to agentgateway. Deny another Agent, the OpenClaw Gateway
   and another binary in the same sandbox. Derive the two method and `pathAndQuery` matches in
   the [proposal](../rfcs/20261124-opensandbox-harness.md#keep-provider-credentials-outside-the-agent)
   from the frozen read grant. The [generic request policy](https://github.com/openclaw/openclaw-enterprise/blob/454af32efaf499b367f8d435434ce633e8a09ed6/packages/contracts/src/credential-deployment.ts#L13-L41)
   carries a path. The Proxy must also check the discovery query. Refuse unsupported restrictions.
   Use a fixed HTTPS upstream. Deny redirects, ambiguous requests and credential reflection.
   Record attributable decisions without credentials. Use neither OpenSandbox forward mode nor
   `pods/exec`. A fetch must work without calling OCC.
4. **Rotate and withdraw.** After TokenService commits a renewal, `notifyCredentialUpdated` lets
   the Driver resolve the current version. Verify every serving copy. Test token expiry without OCC,
   policy replacement, an older update arriving last, a failed reload that leaves old policy active,
   and a restart. The [repository grant](https://github.com/openclaw/openclaw-enterprise/blob/454af32efaf499b367f8d435434ce633e8a09ed6/docs/reference/repository-credentials/access-levels.md#L31-L34)
   is independent of token expiry. Require an expiry time for the pushed token. A renewal cannot
   restore a removed binding. Withdraw one Agent's
   Git access through OCC while its token still works. [Compute calls `removeDeployment`](https://github.com/openclaw/openclaw-enterprise/blob/454af32efaf499b367f8d435434ce633e8a09ed6/apps/controller/src/drivers/compute/kubernetes/index.ts#L9310-L9361)
   for the target and its Git binding. Confirm removal on every serving copy before returning
   success. Verify the next fetch fails before reaching the origin, chat continues and another Agent
   can fetch. After a lost acknowledgment, inspect the effective policy. If removal cannot be
   verified, isolate and stop the affected execution. Keep cleanup pending until confirmed.
   Remove the endpoint, delivery copies and routes on retirement, including after failed staging.
5. **Qualify the installation.** Restrict the operator to the tenant workloads it manages. Use
   admission policy to prevent unauthorized mounts and placement. Verify that the operator cannot
   read unrelated Secrets directly or through a workload it creates. Separate trusted Gateway nodes
   from Harness nodes. Verify digest pins, restricted Pod Security, storage isolation and the
   supported Kubernetes versions. Test the native shell on a node that passes the
   [Codex sandbox checks](../../docs/guides/deploy/codex-sandbox.md). Update the Driver reference,
   deployment guide and runtime flow when the installed path passes.
6. **Qualify VM placement separately.** Match the revision, `BatchSandbox` UID, Pod UID, runtime
   handler and guest. Keep the Git endpoint outside the guest. Verify which guest and executable
   can reach it. Test an absent or wrong handler, network isolation, credential custody, node
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
- **AC-4. Earlier online authorization pilot.** In a separate Docker experiment, Git fetched
  and pushed the allowed ref. Another repository and ref were denied. After withdrawal, OCC refused
  fetch, push and draft creation before the origin received a request. The issuer revoked the test
  token independently. This experiment used a test issuer and sender.
- **AC-4. A host enforced Git withdrawal against GitHub.** Two saved Agents called a read-only Model
  Context Protocol tool. The host used `kubectl exec` to run Git in each calling Harness. Each fetch
  verified the commit in a temporary bare repository and returned the commit ID. After the host
  withdrew one grant, GitHub still accepted the token from the host. The first Agent's next read
  failed, its chat continued, and the second Agent fetched again. Both Gateways were denied. Samples
  from each Harness contained no copy of its GitHub token.

- **AC-4. Offline fetch passed on Docker.** OpenSandbox started the OCE runtime image. A client
  invoked a fixed stdio tool through Codex 0.164.0 with `mcpServer/tool/call`. The tool ran Git over
  mutual TLS to [agentgateway 1.7.0](https://github.com/agentgateway/agentgateway/releases/tag/v1.7.0).
  A host preloaded the policy and a synthetic Basic credential. No OCC service or model ran.
  The workload had no default IPv4 route. The Git origin listened on HTTP loopback
  in the proxy's network namespace.
  - Two fresh shallow fetches verified the commit and file content. The origin counted six
    authenticated reads. A real push, a public sibling's `ls-remote`, duplicate service queries,
    caller authorization and the wrong client certificate produced zero origin requests. Direct
    controls proved the sibling was public and the origin accepted push discovery.
  - The HTTP/2-only listener refused an HTTP/1.1 request with `Connection: authorization`.
    [agentgateway removes headers named by Connection](https://github.com/agentgateway/agentgateway/blob/26f5aebe99a36a037fe54f8080a608aca5547e15/crates/agentgateway/src/proxy/httpproxy.rs#L4717).
  - The workload held test client keys and an execution daemon token. The provider secret and its Basic encoding were absent
    from inspected workload inputs, Codex files and protocol streams, Git traces and responses.
    `execd` could not create a bubblewrap namespace in the workload. This trial did not verify executable identity or a model turn.
    A repeat run matched the results. Both trials removed their workloads and networks.
- **AC-4. Local policy updates.** In a separate agentgateway test on one HTTP/2 connection,
  an invalid withdrawal left the old policy active. A `request.startTime` deadline then blocked a
  new request. Renewal installed a different credential. A valid deny rule blocked the next request.
  OCC did not perform these updates.

- **AC-4 remains open for the installed pair.** In the GitHub pilot, the host owned the grants and used a
  separate model sender. The stock sender rejected the live response. Each Harness held a test bearer.
  The native shell could not start its workspace sandbox on the test node.
- **AC-5 remains open.** No VM-backed runtime was tested.

## Delivery record

The original proposal examined [protected Git admission](../../packages/occ/src/credential-egress-admission.ts),
the [single-repository profile](../../packages/contracts/src/drivers/credential-proxy/index.ts),
the [GitHub repository policy](../../apps/controller/src/drivers/repo/github/policy.ts) and the
[Git authority](../../packages/contracts/src/protected-repository-git.ts). Those paths remain
unchanged. The revised proposal uses staged delivery for this pair.

The original Docker trial used OpenSandbox server `d098823411816e73381cfedc7d10429e55bf5b31` and Codex
0.164.0. The k3d trial used OpenSandbox controller 1.3.0-rc.3 and Kubernetes 1.35.8. The controller
release listed support through Kubernetes 1.34. The trial runtime image predates `e1d4fb8c`.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-24 — Proposed the delivery steps and recorded local pilot results against the interfaces
  at `e1d4fb8c`.
- 2026-11-25 — Revised protected Git access to use staged credential delivery at `454af32e`.
