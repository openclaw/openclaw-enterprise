# OpenShell v0.1.0-pre.5 local experiment handoff

This note records the September 21, 2026 local experiment against
[`v0.1.0-pre.5`](https://github.com/NVIDIA/OpenShell/tree/v0.1.0-pre.5). Use it to
plan the next OpenShell integration change. It is evidence from a disposable
test environment, not a supported setup procedure or proof that OpenShell can
run a production Agent.

## Result

The experiment deployed the exact pre.5 OpenShell gateway, sandbox runtime, and
supervisor images to a disposable k3d cluster. The verification-only
compatibility case passed: **1 passed, 0 failed, 0 skipped** in about three
minutes. OpenShell created a Sandbox custom resource and provider-owned Agent
Pod, and the real Codex app server completed an authenticated model turn over
its Pod-loopback
WebSocket.

The same test verified the staged workload token's identity claims, required
read-only and writable mounts, restricted process privileges, secret
non-exposure, allowed and denied filesystem operations, binary-scoped allowed
and denied network operations, Sandbox replacement, and cleanup. It also
verified that the OCC Agent Service selected the active revision.

This is not production support. Stock pre.5 still cannot receive the native
Secret, projected-token, or plugin-runtime ConfigMap shapes. A Service-routed
app-server WebSocket reset during the experiment, so the model turn used Pod
loopback and does not prove production gateway-to-agent routing.

## Experiment scope

The run used the branch for
[#272](https://github.com/openclaw/openclaw-enterprise/pull/272) on a working
tree based on commit `946f5b52`, model `gpt-5.6-sol`, and the real OpenShell k3d
integration. Mode `0` retains the expected fail-closed case. Mode `1` adds an
explicit test-only compatibility path based on the approach explored in
[#146](https://github.com/openclaw/openclaw-enterprise/pull/146).

The disposable cluster used K3s v1.36.4. It selected these immutable image
references:

| Image                          | Selected digest                                                           |
| ------------------------------ | ------------------------------------------------------------------------- |
| OpenShell gateway              | `sha256:0d58d9bb9fbad1f5bceafaea0f5af2e57e9b520809fef85cfc6d10027f095bba` |
| OpenShell sandbox runtime      | `sha256:6b133b8e97083f6e6218811401b6c1e11d127484c83c3818730f9cd465146c2f` |
| OpenShell supervisor           | `sha256:40febe95703b2a810f264003499a8e094de7c54020328d17c1c0279b4e09e6f9` |
| OpenClaw gateway/Codex runtime | `sha256:d8bcbb159805deddab818b050b6335c3095af9cefcce8770ce59109d68d6f77e` |

The compatibility path makes these test-only adaptations:

- Materialize `APP_SERVER_TOKEN` and `OPENAI_API_KEY` from their exact
  `SecretKeyRef` sources into a private, revision-specific PVC subpath, then
  read them from the Agent startup wrapper.
- Copy the immutable plugin-runtime ConfigMap's `runtime.json` and `config.toml`
  into a read-only revision-specific PVC subpath. This restores the runtime
  files introduced by the Agent-owned plugin configuration change.
- Project the exact audience-bound Agent ServiceAccount token into the bootstrap
  Job, copy it into a private PVC subpath, and verify its claims from the
  provider-owned Harness.
- Split the large inline Node command into arguments below OpenShell's 32 KiB
  argument limit.
- Preserve the `node` executable as the main binary identity and place writable
  Codex state under the shared workspace so UID 10001 can initialize it.
- Remove the unsupported projected-token volume from only the OpenShell gateway
  request after staging the same token through the bootstrap Job.
- Send the executable identities required by pre.5 network policy and use
  uninspected TLS relay for clients that do not trust OpenShell's inspection CA.

These changes form a test compatibility layer. They prove how pre.5 behaves
after an operator supplies the missing projections, but they do not satisfy the
production SandboxDriver contract.

## Observed sequence

| Stage                   | Observation                                                                   | Consequence                                                               |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Stock request           | Pre.5 rejected Secret-backed environment before Sandbox creation.             | Mode `0` preserved the production fail-closed proof.                      |
| Credential bootstrap    | The operator Job staged both exact Secret values with read-only permissions.  | The canonical entrypoint received credentials without env exposure.       |
| Plugin bootstrap        | The Job staged `runtime.json` and `config.toml` from the immutable ConfigMap. | Plugin initialization reached readiness instead of failing with `ENOENT`. |
| Identity bootstrap      | The Job staged the audience-bound Agent token and the Harness read it.        | The test verified identity claims, not native OpenShell token projection. |
| Binary network policy   | Pre.5 received exact curl and Codex executable paths.                         | Allowed destinations succeeded and an unapproved destination failed.      |
| App-server loopback     | The provider-owned Agent completed a real model turn.                         | Pre.5 execution and model access were proved inside the Sandbox.          |
| OCC Service route       | The Service selected the active revision, but its WebSocket reset.            | Production gateway-to-agent transport remains unproved.                   |
| Replacement and cleanup | A suspended Pod was replaced by one new Sandbox and the old Sandbox left.     | Provider lifecycle cleanup completed without duplicate Sandboxes.         |

## Source boundary

Kubernetes Compute creates the plugin runtime artifacts that the dedicated Codex
entrypoint consumes. The entrypoint reads `OPENCLAW_PLUGIN_RUNTIME_MANIFEST` and
writes the Codex configuration under `CODEX_HOME`; see
[`runtime-entrypoints.ts`](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts).

The OpenShell request builder translates approved workspace PVC mounts and the
projected ServiceAccount token. Pre.5 does not support the Secret-backed
environment, projected token, or plugin ConfigMap shapes through its gateway
API; see [`openshell.ts`](../../apps/controller/src/drivers/sandbox/openshell.ts).
The compatibility bootstrap copies those exact inputs without changing the
production Driver's fail-closed behavior.

## Recommended next steps

1. Extend the SandboxDriver workload contract only if a complete, backend-neutral
   projection model is required. Keep OpenShell-specific translation in the
   OpenShell Driver.
2. Require upstream support for exact Secret references, the per-Agent
   ServiceAccount, projected audience-bound token, immutable plugin-runtime
   ConfigMap, and every approved PVC subpath.
3. Resolve the pre.5 Service-routed app-server WebSocket reset before treating
   an OpenShell deployment as production-capable.
4. Remove the operator bootstrap Job when upstream OpenShell accepts the complete
   request. Run the same model, identity, filesystem, egress, replacement, and
   cleanup assertions through that native path.
5. Retain direct negative coverage for malformed verifiers, provider files, and
   bearer authorization so a delivery regression cannot look like success.

## Re-run criteria

Follow the [OpenShell test guide](openshell.md) and use its CI-owned preparation
path. The default Codex case uses provider-file delivery and bearer passthrough;
`OCC_TEST_OPENSHELL_HARNESS=openclaw` selects the remaining native compatibility bridge.
Record:

- exact OpenShell source tag and immutable gateway, sandbox, and supervisor
  image digests;
- immutable OpenClaw gateway and Codex runtime image digests;
- real Sandbox and provider-owned Agent identities;
- canonical app-server listener and authenticated model-turn evidence;
- workload identity and mount assertions;
- filesystem, network, replacement, and cleanup results; and
- test totals with no prerequisite skips.

Do not record credentials, Secret values, temporary kubeconfigs, or local state
paths. The per-test Namespaces were removed. The disposable cluster was retained
for follow-up, and the credential file used for the run was left untouched.

## Related source

- [OpenShell test setup and supported proof](openshell.md)
- [OpenShell SandboxDriver contract and upstream preconditions](../reference/drivers/openshell-sandbox.md)
- [OpenShell provisioning flow](../flows/openshell-sandbox-provisioning.md)
- [Real OpenShell integration](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)
- [OpenShell Kubernetes fixture](../../tests/helpers/openshell-kubernetes-real.mjs)
