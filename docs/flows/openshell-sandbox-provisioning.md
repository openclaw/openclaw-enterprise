---
created: "2026-09-21"
updated: "2026-11-20"
last_updated_session: "authoring-run/9ffe10b9-01b3-4689-b43a-dfd5b7d2a83b"
---

# OpenShell Sandbox provisioning flow

## Overview

Legacy provisioning uses an operator-mode Gateway. For service integration, see
[managed provisioning](openshell-managed-workload.md).

## Entry Points

- Trigger: worker reconciliation with OpenShell Sandbox and Kubernetes Compute.
- Source: `apps/controller/src/drivers/sandbox/openshell.ts:ensureNamespace`
- Source: `apps/controller/src/drivers/sandbox/openshell.ts:provisionHarness`
- Source: `apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision`
- Assumptions: `openshell` Backend; ready operator-mode Gateway; Namespace isolation
  [excludes Gateway authority](../reference/drivers/openshell-sandbox.md#gateway-kubernetes-authority).

## Flow

```mermaid
graph TD
  %%{init: {"flowchart": {"htmlLabels": true}}}%%
  A["<b>Reconcile Namespace</b><br/>Worker selects Drivers"] --> B["<b>Prepare Namespace</b><br/>Kubernetes isolation"]
  B --> C{"<b>Integration mode</b><br/>Installation setting"}
  C -- "service" --> X["<b>Reject legacy configuration</b><br/>Before mutation"]
  C -- "legacy" --> D["<b>Reconcile resources</b><br/>Labels and workspace chart"]
  D --> G0["<b>Ensure configured gateway</b><br/>Owned resources and health"]
  G0 --> E["<b>Own Workspace</b><br/>Create or adopt"]
  E --> A0["<b>Namespace ready</b><br/>Deployment permitted"]
  A0 --> F["<b>Derive Harness</b><br/>Compute requirements"]
  F --> K0["<b>Start Agent Gateway</b><br/>Fail-closed transport"]
  K0 --> Y0{"<b>Node setup</b><br/>Material exists?"}
  Y0 -- "no" --> R0["<b>Retry preparation</b><br/>No provider or Sandbox"]
  Y0 -- "yes" --> Q["<b>Attach model source</b><br/>Credential provider"]
  Q --> G{"<b>Harness inputs valid?</b><br/>Provider files"}
  G -- "no" --> R["<b>Reject provisioning</b><br/>Candidate stays inactive"]
  G -- "yes" --> W["<b>Reconcile runtime provider</b><br/>Files and literal setup"]
  W --> W0{"<b>Native OpenClaw?</b>"}
  W0 -- "yes" --> W1["<b>Prepare writable subpaths</b><br/>Private ownership; retain entries"]
  W1 --> W2["<b>Stop preparer</b><br/>Deployment and Pods gone"]
  W2 --> H["<b>Create Sandbox</b><br/>Providers and exposure"]
  W0 -- "no" --> H
  H --> I["<b>Initialize workspace</b><br/>Private ExecSandbox stdin"]
  I --> V{"<b>Harness</b>"}
  V -- "Codex" --> J["<b>Resolve exposure</b><br/>Advertised WebSocket origin"]
  J --> K["<b>Prepare Gateway route</b><br/>When no predecessor owns it"]
  K --> C1{"<b>Read Codex requirements</b><br/>Harness readiness"}
  C1 -- "refused" --> R
  C1 -- "compatible" --> M["<b>Wait for Harness</b><br/>Compute readiness"]
  V -- "OpenClaw" --> T["<b>Sandbox ready</b><br/>No inbound exposure"]
  T --> M
  M --> Y{"<b>Workspace node</b><br/>Connected?"}
  Y -- "no" --> R1["<b>Retry node</b><br/>Relaunch after process exit"]
  R1 --> Y
  Y -- "yes" --> S{"<b>Attachment status</b><br/>All ready?"}
  S -- "failed, withheld, revoked" --> R
  S -- "ready" --> NG{"<b>Native OpenClaw?</b>"}
  NG -- "yes" --> NR["<b>Confirm Gateway</b><br/>Node binding and rollout"]
  NG -- "no" --> P1["<b>Publish revision</b><br/>Commit active selection"]
  NR --> P1
  P1 --> Z{"<b>Activate Harness</b>"}
  Z -- "Codex" --> C2{"<b>Recheck Codex readiness</b><br/>Before replacing Gateway"}
  C2 -- "refused" --> R2["<b>Fail deployment</b><br/>Published selection retained"]
  C2 -- "serving" --> L["<b>Run model turn</b><br/>Gateway to Codex"]
  Z -- "OpenClaw" --> U["<b>Run native turn</b>"]
  L -- "Git withdrawn" --> D1["<b>Fence delivery</b><br/>OCC commits intent"]
  D1 --> D2{"<b>Verify reduction</b><br/>Exact execution"}
  D2 -- "pending" --> D2
  D2 -- "withdrawn" --> L
  D2 -- "cannot prove" --> D3["<b>Request retirement</b><br/>Caller decides"]
  L --> N["<b>Delete Sandbox</b><br/>Version cleanup"]
  U --> N
  N --> O["<b>Delete Workspace</b><br/>Namespace cleanup"]
  O --> P0["<b>Delete owned gateway</b><br/>Operator resources retained"]
  P0 --> P["<b>Delete Namespace</b><br/>Compute cleanup"]

  classDef state fill:#EDF2F7,stroke:#879AB0,color:#25364A,stroke-width:1px
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  classDef gate fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  classDef blocked fill:#F3F4F6,stroke:#98A2AE,color:#44505F,stroke-width:1px
  class A,B,F,D1 state
  class D,E,I,Q,W,W1,W2,H,J,K,L,M,N,O,P,P1,R1,T,U,NR operation
  class C,C1,C2,G,S,V,Y,Y0,Z,W0,D2,NG gate
  class X,R,R0,R2,D3 blocked
  linkStyle default stroke:#8B949E,stroke-width:1px
```

## Execution Trace

### 0. Create the development control plane

`scripts/dev-up`, `internal/occdev/openshell_k3d.go:upK3d`,
`internal/occdev/openshell.go:prepareOpenShell`,
`internal/occdev/kubernetes.go:writeInstallation`

[downloadVerified](../../internal/occdev/openshell_assets.go) streams archives; [launcher](../../internal/occdev/routing_manifest.go) and [CI](../../scripts/ci/routing.ts)
cap manifests at 32 MiB. Network/HTTP 408/429/5xx failures permit eight cancelable 60-second
attempts starting within 120 seconds; retries remove partial `0600` archives and preserve existing files.

Before apply (`Never`), `prepareOpenShell`/[installAgentSandbox](../../scripts/ci/openshell.ts) verify
native manifest/config/CRI identity, retry CRI misses and retain overrides.
[`importOpenShellImage`](../../internal/occdev/openshell_image.go) journals staging-tag/engine-ID intent before creation.
`imageCommand` accepts Podman 6 exit `125` only with complete requested-image absence diagnostics
and empty/`[]` stdout. Return, rollback and `dev down` reconcile without clusters/Compose;
incomplete inspection or uncertain/replaced tags retain state.

[first-agent](../../scripts/first-agent.ts) and [operator check](../../internal/occdev/check.go) share diagnostics.

[captureAgentSandboxRollout](../../internal/occdev/agent_sandbox_rollout_diagnostics.go) reports Deployment,
UID-linked ReplicaSets/Pods and Warning reasons once, preserving rollback errors. It excludes messages,
environment, full labels and logs, and marks unavailable/malformed/oversized results. Limits: 15 seconds total,
three seconds/256 KiB per command, 32 KiB per record; no retries. The 200 ms drain cannot terminate descendants.

`network.providerHarness` identifies Gateway ClusterIP/Pod selector; Agent Gateways retain HTTP Host and reach only selected Pods.
`docs/snippets/openshell-quickstart/kubernetes/service-policies.py` grants API, worker, supervisors and Agent
Gateways TCP/8080 by live ownership labels. Supervisor grants accumulate per Namespace; protected Git retains
DNS/API egress through ready endpoints. Empty discovery warns/removes stale rules; failure aborts. Uninstall removes recorded policies.

`internal/occdev/sandbox_network_policy.go:loadSandboxNetworkPolicies` validates persisted policies
(maximum 1 MiB) before generating rules. Cleanup verifies ownership before deleting cluster, project or volumes.
See [startup network policy](../guides/deploy/local-sandbox-network-policy.md).

### 0.1. Check Harness mode support

Before Agent writes transform Configuration, `packages/occ/src/index.ts:admitsOpenClawExecutionMode`
checks `supportsHarnessExecutionMode` from `apps/controller/src/drivers/sandbox/openshell.ts:constructor`,
native-worker support and provisioning requirements. Status reads the deployed revision's result.

### 1. Prepare the Namespace and OpenShell Workspace

`packages/occ/src/namespace-lifecycle.ts:reconcileNamespaceLifecycle`,
`apps/controller/src/composition/namespace-lifecycle.ts:sandboxNamespaceLifecycleBinding`

After isolation, OCC invokes Sandbox with placement/cancellation. `openshell-namespace-gateway.ts:reconcileNamespaceGateway`
prepares configured gateways; operator mode checks health and owns the Workspace.

`apps/controller/src/backends/openshell.ts:clientForNamespace` preserves raw gRPC endpoints, bracketed IPv6,
explicit HTTP port 80, HTTPS and nondefault ports.

Workspaces use `oce-` plus a 15-character digest. Creation rereads on `ALREADY_EXISTS`;
adoption requires matching name, OCC Namespace ID, managed-by labels and active phase. Conflicts fail preparation.

### 2. Derive the provider-owned Harness request

`apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision`

`harnessLaunch` prepares Harness inputs; `sandboxRequirements` adds operator-mode PVC mounts.
For provider-owned storage, Compute uses retained directories and Sandbox API observation without a Harness
workspace PVC; Gateway private storage remains Kubernetes-owned.
The Agent Service stays inactive; Gateway transport fails closed. Gateway readiness and the Agent-owned
setup Secret precede attachments, providers and Sandbox creation. `validateHarnessAuth` rejects projected
identity at `servicePrincipalCredentials.mode`: OpenShell cannot preserve the Agent ServiceAccount/token.

For `credential_source`, Compute selects catalog login without a model Secret; `requirements.credentialAttachments`
carries the version and `attachForRevision` provider names. `chatgptAuthTokens` retains account metadata without
static `CODEX_ACCESS_TOKEN`. Codex receives only `APP_TOKEN_SHA` from its Agent transport Secret. Compute renders
`runtime.json`/`config.toml` from the admitted plugin snapshot and removes their ConfigMap environment paths.

`configureAgent` selects full access/user review and removes `appServer.networkProxy`.
`deploy/runtime/openclaw-codex-full-access-profile.patch` sends `:danger-full-access` for threads/turns;
constrained threads fail before a turn.
First Agent warns about PAT `workspace-write` failures; `--replace-key` deploys current policy.
OpenShell blocks nested bubblewrap; model readiness does not prove shell execution.

`admitRevision` saves launch selection; `codexLaunchEntrypoint` selects by revision, authentication, protection
and workspace node. Existing encoding persists; new PAT/workspace setup children pack lazily.

For a [PAT source](../reference/drivers/openshell-credential-gateway.md#source-type-catalog),
`prepareHarnessAuth` selects native login, verified at startup with a private `auth.json` placeholder.
`openShellPatRecovery` requires exact upgrade refusals, same-thread HTTPS fallback,
a nonempty answer and tool-free completion. Terminal HTTPS 401/403 leaves the Harness unready with `AUTHENTICATION_FAILED`. Before binding the [shared provider](../reference/drivers/kubernetes-compute/model-provider.md)
URL plus `/**`, `requireModelSourceDestination` checks immutable `config.authorized_base_url`,
preserving `/api/v1` prefixes. `attachForRevision` translates native OpenClaw configuration and
matches endpoints. For explicit Codex endpoints, `apps/controller/src/drivers/compute/plugin-runtime.ts:codexConfigurationToml`
selects the named HTTPS Responses provider.

### 3. Validate and serialize the Sandbox

`apps/controller/src/drivers/sandbox/openshell.ts:provisionHarness`

`apps/controller/src/drivers/compute/kubernetes/index.ts:admitRevision` freezes
[scratch](../reference/drivers/kubernetes-compute/configuration.md#scratch-volumes).
The claim survives Agent cleanup; `verifyScratchVolume` checks after shutdown.
`workspaceVolumeMounts` preserves writable `/sandbox/scratch`.

`sandboxDataMount` rejects scratch selection and overlapping paths.
`OpenShellGitRuntime.prepare` sets process-scoped `safe.directory` for the mount
and enables `push.negotiate`.

Dedicated Harnesses require Landlock. Before Kubernetes calls, the Driver checks filesystem, process and
[binary-scoped network policy](agent-sandbox-policy.md).
Labels outside `allowed_pod_labels` fail with `SANDBOX_POD_LABELS_NOT_PERMITTED`.

`provisionHarness` creates or adopts providers; renewal checks the version and updates only
`node_setup_json`. `sandboxCommand` adds workspace links, setup wait and account bootstrap.
OpenShell caps arguments at 32 KiB each and 256 KiB total.
`filesystemPolicy` grants `/opt/devtools` read/execute by default. `verifyExistingSandbox` compares
the full spec, including command and filesystem policy; drift requires
[revision recovery](../guides/topics/agent-troubleshoot.md#an-openshell-agent-stops-answering).
Compute rolls the Gateway before checking enrollment; `harnessStatus` gates readiness.

Dedicated Codex requires one lowercase `APP_TOKEN_SHA` and two runtime files (maximum 65,536 bytes each).
`APP_SERVER_TOKEN` is forbidden. A second model proxy, malformed files or other Secret-backed environment
fails before Gateway mutation.

After login, `agentRuntimeEntrypoint` calls
`apps/controller/src/drivers/compute/kubernetes/codex-plugin-stdio.ts:withCodexPluginStdio`.
Clean exit permits verifier WebSocket startup; failure triggers group TERM/KILL. Readiness does not attest HMAC plugin status.

`oce-codex-runtime`/`oce-openclaw-runtime` supply read-only setup and Gateway CA; only Codex accepts
`runtime.json`/`config.toml`. `harnessRuntimeCredentials` reads the projected Secret once.
`packages/utils/src/workspace-node-setup.ts:validateWorkspaceNodeSetupSecret` checks ownership and
`node-setup.json`, including `bootstrapToken`. Output stays private; failures raise `OpenShellSandboxConfigurationFailure`.
TLS-pinned setup requires `wss://` at admission/replacement; device proofs sign the literal token. Renewal requires expired stored setup,
later live expiry and matching endpoint/TLS fingerprint/runtime/CA. Policy binds Gateway to `/usr/local/bin/node`;
foreign ownership or drift blocks creation.

State uses `/sandbox/.openclaw-runtime`; subpaths use `/sandbox/.openclaw-mounts`.
Hooks relocate admitted `/home/node` paths to `harnessHome`; Codex uses provider-file Gateway CA and node-reachable routing.
`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:agentWithNodeEntrypoint`
and `NATIVE_WORKER_ENTRYPOINT` set `0700` and clear setgid before setup/migration;
permission failures stop startup. [Writable runtime state](../reference/drivers/openshell-sandbox.md#writable-runtime-state)
owns state-child isolation, retained permissions and temporary paths.

`prepareNativeWorkspace` creates scratch directories or verifies process ownership and `0700`.
Other subpaths use a restricted revision Deployment with ownership/mode checks and UID-fenced foreground deletion.
Completed preparation exits successfully on SIGTERM; Sandbox creation waits for all writer Pods. Admission requires
`userNamespaces: false`, at most one operator-mode ServiceAccount and pinned Gateway default identity. Preparation has no
model credentials, ServiceAccount tokens, capabilities or direct Pod creation.

After readiness, `initializeWorkspace` validates the setup Secret's Namespace, Agent and setup identity.
Authenticated `ExecSandbox` sends the initializer and JSON stdin. Each attempt has 270 seconds to lock/initialize;
below 250 seconds remaining, it can only verify the completion marker. The worker retries without a marker. See
[document initialization](workspace-files.md#2-deployment-initializes-storage-before-execution).

### 4. Call the versioned gateway contract

`apps/controller/src/drivers/sandbox/openshell-gateway-client.ts:createSandbox`

Send Workspace-scoped identity/spec, unique name and `request_id` (revision UUID, then 15 derived IDs).
After `REQUEST_OUTCOME_UNCERTAIN`, `REQUEST_ID_PAYLOAD_MISMATCH` or `REQUEST_REPLAY_UNAVAILABLE`,
advance only after `getSandbox` confirms absence. At 1,000 live/unresolved records, `RESOURCE_EXHAUSTED`
([`SANDBOX_ADMISSION_LIMIT_REACHED`](../reference/drivers/openshell-sandbox.md#troubleshooting)) defers until the deadline without spending attempts.
For [Sandbox startup refusals](../reference/drivers/openshell-sandbox/harness-providers.md#sandbox-startup-refusals),
`describePrepareRevisionFailure` passes code/stage to `worker.compute-prepare-failed`.

Provisioning reads [sizing](../reference/drivers/openshell-sandbox.md#configuration); Sandbox and preparation
omit RuntimeClass and PSA exemptions. Adoption, including `ALREADY_EXISTS`, requires matching Workspace,
labels and annotations/spec; the Sandbox cannot be stopped or deleting. Workspace `sandbox:write`
permits replacement. Each Harness has one unnamed bearer-passthrough `APP_SERVER_PORT` exposure;
only Codex returns a URL. Native held-failure exposure ends after confirmed deletion through
`withdrawHarnessExposure`, adoption or recreation with `workspaceNodeEnrolled`.

After HTTP `400` or `404`, `observeHeldRepositoryGitPreview` and `enrollHarness`
require the recorded release acknowledgment and authenticated WebSocket. Other
non-`200` responses stay pending or refuse enrollment without an upgrade.

The Backend reuses clients, retries setup and cancels after setup/credential preparation.
Stalled initialization/file reads have no cancellation deadline. After dispatch, local gRPC stops;
remote mutations may need recovery.

`GetService` separates control/workload addresses. `harnessEndpoint` returns the WebSocket
origin and `sandboxDataMount.mountPath` (default `/sandbox/enterprise`). Native hooks
use `harnessHome` (`0700`). Invalid or changed exposure fails closed.

`apps/controller/src/drivers/sandbox/openshell.ts:harnessStatus` calls
`apps/controller/src/drivers/sandbox/openshell-service-transport.ts:serviceCodexReadinessStatus`
on the exact exposure. After bearer-authenticated initialization, `configRequirements/read` denial fails preparation or
activation with `RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE`. `worker.completed.failure` records fixed
categories even if candidate stop defers. Missing/malformed replies stay `starting`; null means no managed policy.
Requirements allow 1 MiB; other replies/notifications share 16 KiB. Messages/exchanges cap at 1 MiB + 16 KiB;
within that cap, complete correlated usable requirements over 1 MiB yield `RUNTIME_CODEX_REQUIREMENTS_TOO_LARGE`.

For `credential_source`/`codex_pat`, the same connection sends `getAuthStatus` with
`includeToken:false` and `refreshToken:false`. Only `personalAccessToken`, null `authToken` and
`requiresOpenaiAuth:true` permit serving; other replies stay `starting`. The Gateway checks thread grants; native OpenClaw uses an authenticated WebSocket handshake. Unavailable WebSockets permit
held-failure reads; timeouts yield transient `SANDBOX_GATEWAY_UNAVAILABLE`.

Providers use reported absolute paths and survive uncertain creates.

Both control planes use Gateway-scoped WSS node routing. Envoy rewrites worker-transfer paths and attributes clients;
policy binds executable/host/port. On group `EPERM`, the supervisor signals the process directly.

### 5. Observe readiness or clean up

`apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision` verifies Namespace/Agent/ServicePrincipal/revision IDs.
Codex `harnessEndpoint` supplies `APP_SERVER_URL`, `OPENCLAW_REMOTE_WORKSPACE_ROOT` and
`OPENCLAW_CODEX_PROVIDER_PERMISSION_PROFILE`. `gatewayConfigurationDocument` maps `/home/node/workspace` to
Sandbox root without Harness mounts; `gatewayNativeHookRelayConfiguration` uses `harnessHome` and Compute-owned
relay URL/auth. Egress permits only the provider peer/port; direct Agent Service requires a Harness route.
Dedicated replacements stop prior runtimes. Without `harnessEndpoint`, Codex uses Kubernetes transport and
`/home/node/workspace`; native OpenClaw enrolls outbound into the admitted workspace.

For a provider Harness endpoint, `reconcileHarnessTrust` saves its CA and any execution-cluster CA
in an immutable, revision-owned ConfigMap even while a predecessor owns the Gateway.
Without an endpoint, preparation skips trust. System-root endpoints need no ConfigMap but cannot discard
existing private trust. Preparation rejects changed or omitted CA data while the record exists.

`apps/controller/src/worker.ts:finalizeRevision` publishes selection before activation. Before authenticated
Harness status or Gateway replacement, read-only `verifyPreparedHarnessTrust` checks ownership, immutability,
exact combined CA bytes and absence of binary data. It refuses missing private trust or foreign, changed or unexpected trust
without repair. Refusal does not roll back selection or guarantee predecessor service.

Eligible preparation can restore the same revision's missing trust only if independent evidence confirms the
original combined bundle, including any execution-cluster CA, matches the current declaration.
Preparation cannot prove the lost record's contents. Changed or unknown bytes require a new Agent revision;
a missing record and omitted CA do not prove private trust was never used.

Activation requires selected Harness readiness and workspace-node enrollment. Retries reread setup and retain valid provider
values during projection outages. Codex restarts workspace-node 1s after exit until shutdown.

`apps/controller/src/drivers/egress-proxy/openshell-request-hook-preview.ts:previewPolicyAndRecipient`
checks policy/recipient/launcher proof. Strict grants require `PRE_CREDENTIALS`; legacy permits absent binding fields.
`apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts:observeHeldPreview` arms one-use denial:
`git-write` probes `/<owner>/<repo>.git/oce-observe-request/<nonce>.git/info/refs`; installation-shaped providers,
including `github-repository`, probe `/oce-observe-request/<nonce>.git/info/refs`. Both use `service=git-upload-pack`
without HTTPS credentials. Authority denies prefix requests before binding lookup; only the exact challenge qualifies.
Observation cannot release the Harness.

`attachmentStatus`/`GetSandboxProviderStatus` retries pending/missing status; `failed`, `withheld`,
`revoked` or `absent` fails preparation. Version `cleanup` calls `GetSandbox`, `DeleteSandbox`, then deletes
runtime/Git providers/profiles; absence requires `GetWorkspace` and another `GetSandbox`.
`cleanupNativeWorkspace` retires interrupted preparers without Sandbox and refuses foreign/replaced resources.
Namespace `cleanup` verifies Workspace ownership, removes owned providers/profiles, calls idempotent
`DeleteWorkspace`, then removes chart resources/NetworkPolicies in reverse. Lost responses retry terminating
Workspaces. Missing managed Gateway Pod/transport does not block owned cleanup; provider/authorization refusals do.
Compute deletes the Kubernetes namespace only after successful cleanup.

### 6. Withdraw Git without retiring the execution

`apps/controller/src/drivers/egress-proxy/openshell-registration.ts:createOpenShellCapabilities` keeps transport
inside the Driver. The Token Service supplies material; `packages/occ/src/state/credential-deliveries.ts:CredentialDeliveries`
stores target, binding, fence, desired/observed policy and installed/pending material versions. Unknown writes survive restart;
migration preserves receipts and fences former writers.

On withdrawal, `apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts:expire` fences delivery
and commits intent through `packages/occ/src/state/credential-delivery-reductions.ts:CredentialDeliveryReductions`.
`apps/controller/src/drivers/egress-proxy/openshell-expired-git.ts:subtractExpiredOpenShellGit` conditionally detaches
Git and independently verifies reduced generation, original process/network, retained providers and model attachment.
Applied detaches require observation; only unapplied intent repeats. Replacement cannot settle it.

Removing the sole Git route preserves the conversation when model authorization is separate.
Multiple independent Git bindings are unsupported. Generic `withdrawBinding` returns `retire-runtime`;
Compute reports `CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT` without deleting the Sandbox or claiming detachment.
The worker retains it, attempts other authorized withdrawals and handles retirement separately.

## Debugging and verification

The [quickstart chat probe](../snippets/openshell-quickstart/chat.mts) sends once from the ready API Pod,
waits for its `chat.send` ID and reads history; malformed replies fail and close the WebSocket.

See [test prerequisites](../testing/openshell.md). Compose requires provider ClusterIP,
`ws://*.openshell.localhost:8080/` route and inactive direct Service; native model proof requires Landlock.
`tests/integration/runtime-image-node-state-permissions.test.ts` covers packaged setup/retry/restart under setgid
parents, excluding Kubernetes/model execution.

## Related docs

- [Agent Sandbox policy admission and live application](agent-sandbox-policy.md)

- [OpenShell Sandbox Driver](../reference/drivers/openshell-sandbox.md) and [OpenShell Credential Gateway](../reference/drivers/openshell-credential-gateway.md)
- [Credential source lifecycle](credential-source-lifecycle.md)
- [OpenShell tests](../testing/openshell.md)
- [Kubernetes Compute Driver](../reference/drivers/kubernetes-compute.md)
- [Harness execution topology](harness-execution-topology.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-20 02:57: Clarify provisioning. (authoring-run/9ffe10b9-01b3-4689-b43a-dfd5b7d2a83b - 4cad65cfda8630a19050810722dfe5e18a2c35cd)

- 2026-11-20 02:43: Compose current Harness provisioning and prepared trust. (authoring-run/4fab20f2-6a82-43c4-9915-3e9afe6ae804 - abb8906a6cf91e50ac1f6007a025c91d297d6d61)

- 2026-11-19 18:05: Trust. (authoring-run/ef34d03a-a5ac-42de-817b-c59c88ec98fb - b63dda0b529b4bf73f5591be89886f66133b3dc9)

- 2026-11-19 10:42: Trace Sandbox startup refusal diagnostics. (authoring-run/3c318cd8-e481-47d2-9b58-d22f1fd3b01e - 6ff25175b2158ca12e49137cb980295af001a98c)

- 2026-11-19 09:27: Trace the packaged tool grant and exact Sandbox adoption. (authoring-run/8bccbe00-7528-4259-ac29-fa076bc32b2a - ec602263727fa848a921a86d755cb38293bfab76)

- 2026-11-18 14:08: Accept Podman cache misses. (authoring-run/cfd6b388-34b4-46c3-8b54-88867893a604 - f07a2b05a8db5e88142ca1a2c9fd90f0ec812284)

- 2026-11-16 13:04: Remove RuntimeClass selection. (01a1e535-91ca-7273-913f-aaacfd69c1c2 - edbe5ec43)

- 2026-11-16 13:30: Trace Gateway reply checks in the operator turn helper. (authoring-run/e9ccbf5f-ad37-4b03-80d1-9af4109c533d - 7a8e52f38b378151c8c08ef1b6dd466ab24834bb)

- 2026-11-14 14:53: Explain workspace lock and retry timing. (authoring-run/e22da2ae-8be7-42d3-876f-6355fa901e9f - 8a15b18175c508fe54672fc12ea0ff5a0847967d)

- 2026-11-11 21:41: Bind controller preload to node identity. (authoring-run/6d4239da-0b3c-4a1d-baaf-cd0d1b4646a6 - 7a2f352a44c42459a3a33c784199a47d11d98e1e)

- 2026-11-11 21:12: Preload Agent Sandbox locally. (authoring-run/6d4239da-0b3c-4a1d-baaf-cd0d1b4646a6 - dfbdd7bfa6ccfba7d3d2e6b28f2770988c0cfc0d)

- 2026-11-11 16:37: Check the managed controller before local Agent deployment. (authoring-run/8dc2b49c-caf2-4594-9d69-06d1826b336e - 98da01c910)

- 2026-11-11 06:13: Trace attachment refusals. (authoring-run/04448580-0c4a-4965-8c27-7f586386c885 - fef779767c622b30bab45c7a0a94f16fc04f70ab)

- 2026-11-11 05:33: Record lazy packing and PAT evidence. (authoring-run/1354aaee-dc47-423c-864d-41dfc9608912 - f633bf27c890)

- 2026-11-11 05:03: Explain revision-bound command selection and PAT startup refusal. (authoring-run/d486197b-c9d9-437a-8a99-f54368ab9e69 - a7d8e6a5d2b0)

- 2026-11-10 21:21: Guard scratch storage. (authoring-run/77c6dd8e-42d7-4688-9561-cf468610374c - 011cd43b9c88d4123b19f12bd5d7bd0938e905d2)

- 2026-11-10 21:04: Trace scratch PVC admission and mounts. (authoring-run/0029d37a-209b-4105-8242-a8c48c959c81 - 8b0d0518cb8786253d9632ae4beb8a75758a2e61)

- 2026-11-10 20:33: Wait for the native Gateway node binding and rollout before readiness. (authoring-run/01a1b316-df53-7fc0-b967-6e23527300dc - 5b7ee9438050)

- 2026-11-10 16:32: Preserve safe partial Namespace teardown. (authoring-run/cc94d782-dafd-44ca-bc46-6d902f4ae4d1 - dde53dee8)

[OpenShell Sandbox provisioning documentation history](openshell-sandbox-provisioning/history.md) preserves the older dated entries.
