---
created: "2026-09-21"
updated: 2026-11-10
last_updated_session: authoring-run/bc23cb27-0cf1-40d2-9361-93726c5de660
---

# OpenShell Sandbox provisioning flow

## Overview

Kubernetes Compute provisions Codex/OpenClaw through OpenShell.

## Entry Points

- Trigger: worker reconciliation of an Agent revision selecting OpenShell Sandbox
  and Kubernetes Compute.
- Source: `apps/controller/src/drivers/sandbox/openshell.ts:ensureNamespace`
- Source: `apps/controller/src/drivers/sandbox/openshell.ts:provisionHarness`
- Source: `apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision`
- Assumptions: `openshell` Backend; ready operator-mode Gateway; Namespace isolation
  [excludes Gateway authority](../reference/drivers/openshell-sandbox.md#gateway-kubernetes-authority).

## Flow

```mermaid
graph TD
  A["<b>Reconcile Agent revision</b><br/>Worker selects Drivers"] --> B["<b>Prepare Namespace</b><br/>Kubernetes isolation"]
  B --> C{"<b>Workspace mode</b><br/>Installation setting"}
  C -- "managed" --> X["<b>Reject configuration</b><br/>Before mutation"]
  C -- "operator" --> D["<b>Reconcile resources</b><br/>Labels and workspace chart"]
  D --> E["<b>Own Workspace</b><br/>Create or adopt"]
  E --> F["<b>Derive Harness</b><br/>Compute requirements"]
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
  S -- "ready" --> P1["<b>Publish revision</b><br/>Commit active selection"]
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
  O --> P["<b>Delete Namespace</b><br/>Compute cleanup"]

  classDef state fill:#EDF2F7,stroke:#879AB0,color:#25364A,stroke-width:1px
  classDef operation fill:#EBF3F0,stroke:#7F9D93,color:#2B4038,stroke-width:1px
  classDef gate fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  classDef blocked fill:#F3F4F6,stroke:#98A2AE,color:#44505F,stroke-width:1px
  class A,B,F,D1 state
  class D,E,I,Q,W,W1,W2,H,J,K,L,M,N,O,P,P1,R1,T,U operation
  class C,C1,C2,G,S,V,Y,Y0,Z,W0,D2 gate
  class X,R,R0,R2,D3 blocked
  linkStyle default stroke:#8B949E,stroke-width:1px
```

## Execution Trace

### 0. Create the development control plane

`scripts/dev-up`, `internal/occdev/openshell_k3d.go:upK3d`,
`internal/occdev/openshell.go:prepareOpenShell`,
`internal/occdev/kubernetes.go:writeInstallation`

Both `openshell` launchers require Landlock, support Node and x64/ARM64 Codex
independently of launcher architecture, verify 0.1.6 charts and pin
Gateway/supervisor/sandbox images. Importing OCE images first prevents k3s garbage
collection. `writeInstallation` selects curated Codex plugins; the selected
Credential Gateway supplies credentials.

`internal/occdev/openshell_assets.go:downloadVerified` streams archives;
`internal/occdev/routing_manifest.go` and CI's
`scripts/ci/routing.mjs:downloadPinnedArtifact` fetch manifests (32 MiB maximum).
Transient network errors and HTTP 408/429/5xx allow eight 60-second attempts,
starting within 120 seconds. Local downloads honor cancellation. Other errors
are terminal. Archive retries remove failed `0600` files, preserving existing files.

`dev-up` validates Kubernetes/OpenShell before `occ dev up`.
`OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes` selects Kubernetes-only: in-cluster
authentication, `oce-system`, imported PostgreSQL and [per-Agent HTTPS](../guides/deploy/local-setup.md).
The launcher checks port collisions, recording engine, cluster, Namespace, ports
and key path. Compose runs PostgreSQL/OCC with a k3d worker.

On rollout failure, `prepareOpenShell` calls
`internal/occdev/agent_sandbox_rollout_diagnostics.go:captureAgentSandboxRollout`
once, preserving rollback errors. Diagnostics include Deployment,
UID-linked ReplicaSets/Pods and Warning reasons, excluding messages, environment,
full labels and logs. Unavailable, malformed or oversized results are identified.
Limits: 15-second context; three seconds/256 KiB per command; 32 KiB per record.
No retries; 200 ms pipe draining cannot terminate descendants.

`network.providerHarness` records Gateway ClusterIP, Pod selector and TCP/8080.
Agent Gateways alias its hostname, preserving HTTP Host; policy permits only those
Pods/port. Both launchers install private Envoy routing and operator Workspaces.
`docs/snippets/openshell-quickstart/kubernetes/service-policies.py` uses live
selectors to admit API, worker, supervisors and Agent Gateways on TCP/8080.
Supervisor grants accumulate per Namespace; callers must match ownership labels.
Protected Git preserves Gateway DNS/API egress using Service addresses, DNS
selectors/ports and ready API endpoints. Empty discovery warns and removes stale
backend grants; failed reads abort. Policies are recorded before application and
deleted on uninstall. See [local deployment](../guides/deploy/local-kubernetes-development.md)
and the [retired local protected profile](../guides/deploy/local-openshell-images.md#select-the-protected-profile).

`internal/occdev/sandbox_network_policy.go:loadSandboxNetworkPolicies` validates
policies (maximum 1 MiB) before provisioning; persisted rules augment generated
rules. See [startup network policy](../guides/deploy/local-sandbox-network-policy.md).
`internal/occdev/compose_routing.go:prepareComposeRoutingFiles` sets routing-file
container ownership; Installation files remain `0644` in private state.
Cleanup validates ownership, deletes cluster/project/volumes and retains partial-failure state.

### 0.1. Check Harness mode support

`apps/controller/src/drivers/sandbox/openshell.ts:constructor` sets
`supportsHarnessExecutionMode`; `packages/occ/src/index.ts:admitsOpenClawExecutionMode`
checks it, native-worker support and provisioning requirements before Agent writes
transform Configuration. Deployment stores the result in the Agent revision;
status reads return stored work.

### 1. Prepare the Namespace and OpenShell Workspace

`apps/controller/src/drivers/compute/kubernetes/index.ts:ensureNamespace`

Compute establishes quota, limits and baseline NetworkPolicies before
`SandboxDriver.ensureNamespace`. Managed mode rejects before Kubernetes/Gateway
use. Operator mode checks optional local readiness, applies namespace labels,
workspace resources and provider NetworkPolicies, then checks health.
Development uses the central Gateway.

`apps/controller/src/backends/openshell.ts:clientForNamespace` passes raw endpoints,
including bracketed IPv6, unchanged to gRPC. HTTP retains explicit port 80;
HTTPS and nondefault ports retain their behavior.

The Workspace uses Compute's physical name: `oce-` plus a 15-character digest,
within OpenShell's 19-character limit. The Driver creates absent Workspaces and
rereads after `ALREADY_EXISTS`. Adoption requires matching name, OCC Namespace ID,
managed-by labels and active phase; conflicts fail preparation.

### 2. Derive the provider-owned Harness request

`apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision`

`provisionHarness` derives from Compute's Deployment. Initially, it
keeps the Agent Service inactive and Gateway transport fail-closed. Attachments
and provider/Sandbox creation await Gateway readiness and its Agent-owned setup
Secret reference. At deployment, `validateHarnessAuth` rejects dedicated OpenShell
projected identity, naming `servicePrincipalCredentials.mode`: OpenShell cannot
preserve the Agent ServiceAccount/token.

For `credential_source`, Compute renders the catalog login mode without a model
Secret and passes version and `attachForRevision` provider names through `requirements.credentialAttachments`.
For `chatgptAuthTokens`, OpenShell omits static `CODEX_ACCESS_TOKEN` but retains
account metadata. Codex receives only `APP_TOKEN_SHA` from its exact Agent transport
Secret. Compute converts the admitted plugin snapshot to `runtime.json`/`config.toml` workload
files, removing ConfigMap environment paths.

`OpenShellSandboxDriver.configureAgent` sets full access/user review for every login
mode and removes `appServer.networkProxy`.
`deploy/runtime/openclaw-codex-full-access-profile.patch` sends `:danger-full-access`
for threads/turns; constrained threads fail before a turn. First Agent warns that
prior PAT `workspace-write` versions break shell tools; `--replace-key` deploys
current policy. OpenShell blocks nested bubblewrap; model readiness does not prove shell execution.

PAT bootstrap (`prepareHarnessAuth`;
`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:AGENT_RUNTIME_ENTRYPOINT`)
writes an opaque placeholder to private `auth.json`, clears the child override and validates
native login. Scoped [PAT routes](../reference/drivers/openshell-credential-gateway.md#source-type-catalog)
admit bootstrap/model traffic; failure keeps versions inactive.
`requireModelSourceDestination` checks immutable `config.authorized_base_url`
before API-key profiles bind the [shared provider](../reference/drivers/kubernetes-compute/model-provider.md)
URL plus `/**`, preserving `/api/v1` prefixes. `attachForRevision` translates native
OpenClaw configuration and matches selected endpoints to this URL. For Codex,
`apps/controller/src/drivers/compute/plugin-runtime.ts:codexConfigurationToml`
selects a named provider and HTTPS Responses transport.

### 3. Validate and serialize the Sandbox

`apps/controller/src/drivers/sandbox/openshell.ts:provisionHarness`

`sandboxDataMount` validates mounts; `OpenShellGitRuntime.prepare` supplies process-scoped,
mount-specific `safe.directory` and `push.negotiate=true`.

Dedicated Codex/OpenClaw requires Landlock. Kubernetes, filesystem, process and
[binary-scoped network policy](agent-sandbox-policy.md) use pinned `v0.1.6`.
Relocation preserves opaque `OCE_CODEX_CHATGPT_ACCOUNT` JSON.
Unsupported enums, inherited keys, `passthrough` TLS, missing executables or
non-positive/unsafe-integer readiness `timeoutMs` prevent Kubernetes calls.
Duplicate names and `workspace-node-enrollment` prevent construction.
Template Pod labels outside `allowed_pod_labels` fail deployment immediately
with `SANDBOX_POD_LABELS_NOT_PERMITTED`.

`provisionHarness` creates or adopts the provider. Renewal checks its version
and updates only `node_setup_json` through `UpdateProvider`.
`internal/occdev/kubernetes.go:openShellInstallationConfiguration` omits the
development startup delay. Compute rolls the Gateway before checking enrollment;
`harnessStatus` below gates readiness.

Dedicated Codex requires one lowercase `APP_TOKEN_SHA` and two runtime files,
each at most 65,536 bytes. `APP_SERVER_TOKEN` is forbidden. A second model proxy,
malformed files and other Secret-backed environment fail before Gateway mutation.

After login, `agentRuntimeEntrypoint` calls
`apps/controller/src/drivers/compute/kubernetes/codex-plugin-stdio.ts:withCodexPluginStdio`.
Clean exit permits verifier WebSocket startup; failure triggers group TERM/KILL.
Readiness does not attest HMAC plugin status.

`oce-codex-runtime`/`oce-openclaw-runtime` provide read-only setup and Gateway CA.
Only Codex accepts `runtime.json`/`config.toml`. `harnessRuntimeCredentials` reads
the projected Secret; `packages/utils/src/workspace-node-setup.ts:validateWorkspaceNodeSetupSecret`
checks ownership and setup material without further reads. OpenShell keeps provider
output private and maps failures to `OpenShellSandboxConfigurationFailure`.
Validated setup, including `bootstrapToken`, becomes `node-setup.json`. TLS-pinned setup requires `wss://`
at admission and supervisor replacement. WebSocket rewriting is unsupported:
device proofs sign the literal token.
Renewal requires expired stored setup, later live expiry and unchanged endpoint,
TLS fingerprint, runtime and CA. Policy permits that Gateway and `/usr/local/bin/node` only;
foreign ownership/drift prevents creation.

Version state mounts at `/sandbox/.openclaw-runtime`; persistent subpaths mount
below `/sandbox/.openclaw-mounts`. Admitted `/home/node` paths move under
`harnessHome` for native hook credentials. Codex hooks use the provider-file
Gateway CA and node-reachable routing. `OPENCLAW_NODE_STATE_DIR` uses a created
`state` child to avoid root-owned mounts and symlinks.
`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:agentWithNodeEntrypoint`
and `NATIVE_WORKER_ENTRYPOINT` apply `0700` before OpenClaw setup or migration,
clearing inherited setgid. OpenClaw prepares its children on retry; retained state
and workspace permissions stay unchanged. Permission failures stop startup.
Workspace, node identity, sessions and images stay separate. The supervisor probes
`/tmp`; native `TMPDIR` is a private `tmp` child under the runtime home.

`prepareNativeWorkspace` privatizes retained PVC subpaths through a restricted
revision Deployment. Mode/ownership checks precede UID-fenced foreground deletion;
completed preparation exits successfully on SIGTERM with normal termination grace.
Sandbox creation waits for every writer Pod.
Preparation requires `userNamespaces: false`, at most one operator-mode ServiceAccount
and the pinned Gateway's default identity, without model credentials, ServiceAccount
tokens, capabilities, or direct Pod creation. Admission reports these requirements before deployment.

After Sandbox readiness, `initializeWorkspace` validates the setup Secret's
Namespace, Agent and setup identity, then sends initializer/JSON stdin through
authenticated `ExecSandbox`. Workspace `flock` serializes attempts; the Harness
awaits completion. See [document initialization](workspace-files.md#2-deployment-initializes-storage-before-execution),
separate from native subpath preparation.

Credential attachments require OCC `oce-cs-` names without static-provider duplicates.
Model profiles bind access to the selected Codex/Node executable. Production
qualification is incomplete.

### 4. Call the versioned gateway contract

`apps/controller/src/drivers/sandbox/openshell-gateway-client.ts:createSandbox`

The client sends identity/spec, Workspace scope and one of 16 `request_id` values:
the revision UUID, then 15 derived IDs. `REQUEST_OUTCOME_UNCERTAIN`,
`REQUEST_ID_PAYLOAD_MISMATCH` or `REQUEST_REPLAY_UNAVAILABLE` advances only after
`getSandbox` finds nothing. Unresolved IDs never expire; completed records expire
after 24 hours. Names are Workspace-unique. At 1,000 live/unresolved records,
`RESOURCE_EXHAUSTED` becomes `SANDBOX_ADMISSION_LIMIT_REACHED`: preparation waits
without spending attempts until its deadline; Namespace work retries.

Adoption, including `ALREADY_EXISTS`, requires matching Workspace, labels,
annotations/spec and a Sandbox that is neither stopped nor deleting. Workspace `sandbox:write`
permits replacement. Each Harness has one unnamed bearer-passthrough
`APP_SERVER_PORT` exposure; only Codex returns a URL. Native held-failure exposure
ends after confirmed deletion through `withdrawHarnessExposure`, adoption or
recreation with `workspaceNodeEnrolled`.

After HTTP `400` or `404`, `observeHeldRepositoryGitPreview` and `enrollHarness`
require the recorded release acknowledgment and authenticated WebSocket. Other
non-`200` responses stay pending or refuse enrollment without an upgrade.

The Backend reuses clients and retries setup. Cancellation follows
setup/credential preparation; stalled initialization/file reads have no cancellation deadline.
After dispatch it stops local gRPC, but remote mutations may require recovery.

`GetService` separates control/workload addresses. `harnessEndpoint` returns the WebSocket
origin and `sandboxDataMount.mountPath` (default `/sandbox/enterprise`). Native hooks
use `harnessHome` (`0700`). Invalid or changed exposure fails closed.

`apps/controller/src/drivers/sandbox/openshell.ts:harnessStatus` calls
`apps/controller/src/drivers/sandbox/openshell-service-transport.ts:serviceCodexReadinessStatus`
on the exact Harness exposure. After bearer-authenticated initialization it reads
`configRequirements/read`. Denial fails preparation or activation with
`RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE`. The worker records fixed categories in
`worker.completed.failure`, including when candidate stop defers. Missing or malformed
replies stay `starting`. Null requirements mean no managed policy. The requirements
reply has a 1 MiB limit. Other replies and notifications share 16 KiB. Each message
and the exchange have a 1 MiB + 16 KiB cap. Complete, correlated, usable requirements
above 1 MiB yield `RUNTIME_CODEX_REQUIREMENTS_TOO_LARGE` within that cap.

For `credential_source`/`codex_pat`, that connection then sends `getAuthStatus`
with `includeToken:false` and `refreshToken:false`. Serving requires
`personalAccessToken`, null `authToken` and `requiresOpenaiAuth:true`. Other
answers stay `starting`. The Gateway checks grants on real threads. Native
OpenClaw uses the authenticated WebSocket handshake. Unavailable WebSockets permit
held-failure reads. Timeouts yield transient `SANDBOX_GATEWAY_UNAVAILABLE`.

Provider files use reported absolute paths. Gateway failure blocks readiness.
Providers survive uncertain creates; cleanup deletes their Sandbox first.

Both control planes use the Gateway's scoped WSS node route. Envoy rewrites
worker-transfer paths and attributes clients. Policy binds executable/host/port.
On process-group `EPERM`, the supervisor signals the process directly.

### 5. Observe readiness or clean up

`apps/controller/src/drivers/compute/kubernetes/index.ts:prepareRevision`

Compute verifies Namespace, Agent, ServicePrincipal and revision IDs.
Codex `harnessEndpoint` sets `APP_SERVER_URL`, `OPENCLAW_REMOTE_WORKSPACE_ROOT`
and `OPENCLAW_CODEX_PROVIDER_PERMISSION_PROFILE`; owned k3d pins the provider host.
`gatewayConfigurationDocument` maps `/home/node/workspace` to the Sandbox root
without Harness storage mounts. `gatewayNativeHookRelayConfiguration` uses
`harnessHome` and Compute-owned relay URL/auth. Egress permits only the provider
peer/port; the direct Agent Service stays inactive without a Harness route.
For dedicated replacements the worker stops earlier runtimes before preparing the candidate.
`apps/controller/src/worker.ts:finalizeRevision` publishes the active selection before
activation rechecks the Harness. Permanent activation refusal fails deployment without
reverting that selection, replacing the Gateway or retiring the predecessor.
Without `harnessEndpoint`, Codex uses Kubernetes transport and `/home/node/workspace`.
Native OpenClaw enrolls outbound into its admitted workspace.

Activation requires the Harness Pod and enrolled Secret node. Each retry rereads
provider setup, retaining valid values during projection outages. The Codex
supervisor restarts workspace-node one second after every exit until shutdown.

`apps/controller/src/drivers/egress-proxy/openshell-request-hook-preview.ts:previewPolicyAndRecipient`
checks policy, recipient and launcher proof. Strict grants require `PRE_CREDENTIALS`;
legacy preview accepts absent binding fields.

`apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts:observeHeldPreview`
arms one-use denial: `git-write` probes
`/<owner>/<repo>.git/oce-observe-request/<nonce>.git/info/refs`;
installation-shaped providers, including `github-repository`, probe
`/oce-observe-request/<nonce>.git/info/refs`. Both use `service=git-upload-pack`.
The HTTPS launcher sends no credentials. The authority sends every request under either
probe prefix to the denial handler before binding lookup. Only the exact challenge qualifies.
Observation alone cannot release the Harness.

`attachmentStatus`/`GetSandboxProviderStatus` retries pending/missing status;
`failed`, `withheld`, `revoked` or `absent` fails preparation. Version `cleanup`
calls `GetSandbox`, `DeleteSandbox`, then deletes runtime and Git providers/profile.
Absence requires `GetWorkspace` and another `GetSandbox`. `cleanupNativeWorkspace`
retires interrupted preparers without a Sandbox, refusing foreign/replaced resources.

Namespace `cleanup` verifies Workspace ownership, removes owned runtime/Git
providers and profiles, sends idempotent `DeleteWorkspace`, then removes chart
resources/NetworkPolicies in reverse order. Lost responses retry terminating
Workspaces. Compute deletes the Kubernetes namespace only after cleanup succeeds.

### 6. Withdraw Git without retiring the execution

`apps/controller/src/drivers/egress-proxy/openshell-registration.ts:createOpenShellCapabilities`
keeps the transport inside the installed Driver. The Token Service supplies material;
`packages/occ/src/state/credential-deliveries.ts:CredentialDeliveries` stores target, binding,
fence, desired and observed policy, installed and pending material versions. Unknown
writes survive restart. A forward migration preserves receipts and fences former writers.

After OCC withdraws authority,
`apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts:expire`
fences the delivery and commits its reduction intent through
`packages/occ/src/state/credential-delivery-reductions.ts:CredentialDeliveryReductions`.
`apps/controller/src/drivers/egress-proxy/openshell-expired-git.ts:subtractExpiredOpenShellGit`
conditionally detaches Git. It independently verifies the reduced generation, original
process and network, retained providers and model attachment. Applied detaches are observed,
never resent; an unapplied intent repeats its request. A replacement cannot settle it.

This supports one Git binding and separately authorized model access; removing its
last route denies Git without interrupting the conversation. Multiple independent
Git bindings remain unsupported. For generic exchange routes, `withdrawBinding`
returns `retire-runtime`. Compute reports `CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT`
without deleting the Sandbox or claiming detachment. The worker keeps that source
pending and attempts other authorized withdrawals. Runtime retirement remains separate.

## Debugging and verification

See [test prerequisites and proof](../testing/openshell.md). Compose needs the
provider ClusterIP, advertised `ws://*.openshell.localhost:8080/` route, and inactive
direct Service. Native model proof requires Landlock; Console admission and
initialized files are insufficient.

`tests/integration/runtime-image-node-state-permissions.test.ts` checks packaged
setup, retry and restart under setgid parents. It does not prove Kubernetes or
model execution.

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

- 2026-11-10 12:45: Record fixed Codex permission denial categories in worker diagnostics. (authoring-run/bc23cb27-0cf1-40d2-9361-93726c5de660 - 3c5686897dcb09293562aa30d1a2cecaacc71353)

- 2026-11-10 12:22: Clarify Gateway authority. (authoring-run/64da6dd5-9c32-4858-b176-ff11e8c8ae92 - 3c5686897dcb09293562aa30d1a2cecaacc71353)

- 2026-11-10 05:13: Bound complete Codex requirements separately and distinguish post-publication refusal. (authoring-run/7e421486-330f-4f04-b3b8-2b00f30f5647 - 1b3382ad62844cc821c9b004870d86f4814d0b39)

- 2026-11-10 00:45: Check Codex permission requirements before reporting Harness readiness. (authoring-run/2e07121e-8d92-484b-921e-c6c9f179bc00 - c4094c2f34c912b581b9c26d2edea91d3a0ebfd4)

- 2026-11-08 12:06: Bound archive retries. (authoring-run/0ff5cd21-1ead-46fb-bb5f-9f578872634a - 4566d20b8ef66a3268e27bceac946765ecd5d336)

- 2026-11-08 06:54: Trace serving-process PAT readiness. (authoring-run/cc85b8e8-41ee-4b88-9807-456c25e0fa77 - 12582b2da6c58b020cff462d6d8ecfe2bbedde8a)

- 2026-11-05 14:34: Reuse bounded retries for the pinned Agent Sandbox manifest. (authoring-run/33ffb317-d84b-4de5-b946-70b58f35af74 - a383313636fc348a2325c0b1f6e05ae80327fd30)

- 2026-11-05 14:17: Revoke empty API grants. (authoring-run/a85a4857-880b-4f7b-8fe2-d648c86e601e - 2b92aa9b35de6e7633b960dfd7edcf1fd3fd46ea)

- 2026-11-05 12:54: Extract shared setup validation while preserving OpenShell provisioning. (authoring-run/0428fede-167f-4783-a06f-00eb40ffa23c - f1295c81f3ac79f51af2b93b61013e0a8e5c0394)

- 2026-11-05 12:54: Reject projected identity at admission. (authoring-run/root-deployment_docs - 894a5b6698049c41fba27f5c2c0764e86b4c0632)

[OpenShell Sandbox provisioning documentation history](openshell-sandbox-provisioning/history.md) preserves the older dated entries.
