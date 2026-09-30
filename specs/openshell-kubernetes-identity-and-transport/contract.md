# OpenShell projection and endpoint contract

This companion owns the implementer detail for the [proposed dedicated-Codex journey](../openshell-kubernetes-identity-and-transport.md). Source claims use OCE `0c1e0e4324309cb1903175f718b97c8e34dddb1b` and unmerged OpenShell `081e727fd06a76ecc6b5aec7da1092626057e15d`. Proposed extensions below are not deployed contracts.

## Provisioning contract

Compute derives workload requirements from ordinary Deployment rendering and calls the Sandbox Driver inside the controller worker. The base Driver's [optional operation](https://github.com/openclaw/openclaw-enterprise/blob/0c1e0e4324309cb1903175f718b97c8e34dddb1b/packages/contracts/src/index.ts#L1123) is `provisionHarness?(context: SandboxHarnessContext): Promise<SandboxResourceRef>`; the OpenShell adapter implements it. It requires operator-workspace mode, a dedicated Codex or OpenClaw revision and a matching Sandbox Driver selection. This proposal selects Codex.

The [context and requirements](https://github.com/openclaw/openclaw-enterprise/blob/0c1e0e4324309cb1903175f718b97c8e34dddb1b/packages/contracts/src/index.ts#L854-L905) require readonly `namespace: Namespace`, `revision: AgentRevision`, `kubernetes: unknown`, `signal: AbortSignal` and `requirements: HarnessWorkloadRequirements`. Every requirements member is required: `image`, `command`, `loginMode`, `labels`, `credentialAttachments`, `environment`, `serviceAccountName`, `serviceAccountToken` and `workspaceMounts`. Login mode and credential attachments keep their existing definitions; attachments must be consumed in full.

Environment entries contain either literal `value` or `valueFrom.secretKeyRef` with `name` and `key`. The selected app bearer attaches as `APP_SERVER_TOKEN` in `context.requirements.environment`. OCE maps its reference without reading the value; proposed kubelet resolution must reach only the authorized child. The adapter currently rejects Secret references with `SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED`. Unsupported deployed contracts must continue to prevent activation.

The current result requires four strings: `namespaceName`, `resourceName`, `agentId` and `revisionId`. It has no endpoint or initializer. Compute subsequently checks workload/node readiness and credential attachment status. Extend these existing producers and consumers; creating a separate transport service would not close their missing handoff.

### Identity, mounts and integrity

Project the selected per-workload `serviceAccountName` and token with its approved `audience`, `expirationSeconds`, `mountPath`, `path` and `readOnly: true`. Preserve the 600–86400-second expiry range without adding a default. Each approved PVC retains `claimName`, `subPath`, `mountPath` and `readOnly`. Reassess mounts after common-PVC removal.

Upstream supports PVCs but lacks per-workload ServiceAccount selection and [rejects projected workload tokens](https://github.com/NVIDIA/OpenShell/blob/081e727fd06a76ecc6b5aec7da1092626057e15d/crates/openshell-driver-kubernetes/src/driver.rs#L2111-L2131). Accepted resource types, authorization, Pod construction and integrity checks must change together. Authorize the exact same-Namespace Secret, key, recipient and ServiceAccount. Record resource UIDs, disable automount and protect reserved mounts. On reuse, recheck Pod/resource UIDs and immutable revision material. UID equality proves neither unchanged Secret data nor current authorization. Foreign, replaced or widened references must prevent activation.

### Child delivery and node bootstrap

OpenShell's [`boundary_exec`](https://github.com/NVIDIA/OpenShell/blob/081e727fd06a76ecc6b5aec7da1092626057e15d/crates/openshell-sandbox/src/boundary_exec.rs#L154-L186) clears inherited environment, then expands shared values. Kubelet projection alone therefore cannot supply Codex. Upstream launcher owners must approve named-only delivery that resolves kubelet-provided values within the workload, separately covering the initial wrapper/startup and later exec or reconnect recipients. Reject missing, colliding or reserved names and inherit-all behavior. Keep bootstrap values out of unintended Codex and later-exec recipients, including nested serialized values. Never place resolved setup or token values in persisted Sandbox/configuration, logs or shared serialized `OPENSHELL_USER_ENVIRONMENT`.

When node enrollment is selected, deliver the original owner's `OPENCLAW_NODE_SETUP_CODE` Secret/key `setupCode` to `AGENT_WITH_NODE_ENTRYPOINT`; otherwise omit it. Preserve expiry, one-shot use, restart and retirement handling. The wrapper builds explicit `nodeEnv`, removes node setup, state, CA and bootstrap values from `codexEnv`, and retains `APP_SERVER_TOKEN`. Setup enters `node run --pair-if-needed` arguments: environment filtering does not prove `/proc` confidentiality within the shared Pod/process boundary. The newer non-Sandbox setup-file path does not apply.

Compute still refuses `initialize-workspace`. Compute/bootstrap/node and child-launch owners must select a real initializer producer/consumer for affected profiles, preserving private directory creation (`0700`), Agent-scoped identity reuse and cleanup. Endpoint existence does not prove initialization or settle an earlier operation. First launch, restart with retained state, and replacement need their own observed recovery behavior.

## Endpoint and bearer handoff

The Backend supplies the authenticated client. Its complete current operation is [`createSandbox(request: OpenShellSandboxCreateRequest, signal: AbortSignal): Promise<OpenShellSandboxResponse>`](https://github.com/openclaw/openclaw-enterprise/blob/0c1e0e4324309cb1903175f718b97c8e34dddb1b/apps/controller/src/drivers/sandbox/openshell-gateway-client.ts#L669-L728). The [request](https://github.com/openclaw/openclaw-enterprise/blob/0c1e0e4324309cb1903175f718b97c8e34dddb1b/apps/controller/src/drivers/sandbox/openshell-gateway-client.ts#L21-L46) requires `name`, `workspace`, `requestId`, string-map `labels` and `annotations`, `spec: RecordValue`, and `serviceExposures`, whose entries require `service: string` and `targetPort: number`.

The [adapter](https://github.com/openclaw/openclaw-enterprise/blob/0c1e0e4324309cb1903175f718b97c8e34dddb1b/apps/controller/src/drivers/sandbox/openshell.ts#L1127-L1190) derives the resource name, workspace and request ID from admitted Namespace/revision ownership. It supplies revision labels, Namespace/Agent/revision annotations, workload spec and cancellation signal. Codex gets one unnamed exposure, using `harnessPort(requirements)` from its admitted `APP_SERVER_PORT`; native OpenClaw gets none.

The client maps `workspace` to `workspace_scope.workspace`, `requestId` to `request_id`, and `serviceExposures[].targetPort` to `service_exposures[].target_port`, retaining service names, labels, annotations and spec. The proposed change extends this typed request, mapper and vendored protocol together. This single **illustrative, unexecuted** protobuf fragment belongs at `CreateSandboxRequest.service_exposures[0]`, produced by that client and consumed by OpenShell:

```protobuf
service_exposures {
  service: ""
  target_port: <admitted APP_SERVER_PORT>
  authorization_mode: SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH
}
```

The bracketed port is a placeholder, not executable protobuf. Upstream defines [`authorization_mode` as field 3 and passthrough as enum value 2](https://github.com/NVIDIA/OpenShell/blob/081e727fd06a76ecc6b5aec7da1092626057e15d/proto/openshell.proto#L3786-L3804). Omission resolves to stripping Authorization. The intended result is an explicitly configured endpoint for this Codex revision; an older server that ignores the field must fail closed. Verify effective mode or equivalent deployed capability before activation.

The response requires `name`, string-map `labels` and string-map `serviceUrls`; `id`, `workspace` and string-or-number `phase` are optional. The client rejects a missing stable name or, when exposures were requested, a missing URL map. It translates `service_urls` to `serviceUrls`. Sandbox rejects a different returned name, validates `serviceUrls[""]` for Codex, and refuses unexpected services for native OpenClaw. It then discards the URL and returns the four-string resource reference. `ALREADY_EXISTS` becomes an adapter configuration failure; its stale-Sandbox removal advice grants no cleanup authority over uncertain effects.

Contracts, Sandbox, Compute and Gateway owners must choose the smallest result extension and consumer that bind endpoint evidence to the exact Namespace, workspace, Sandbox, Agent and revision. Before releasing a bearer, verify allowed host, port, scheme and TLS identity. Reject unexpected destinations and downgrades. HTTP(S)-to-WS(S) conversion must preserve approved authority. Current normalization checks syntax and rewrites a port; neither establishes destination authority. Compute's separately constructed direct `APP_SERVER_URL` must be replaced for this selected path.

Owners must also select sufficient nonsecret endpoint retention or authenticated reconstruction for restart. Ordinary `GetSandbox` returns no service URLs. Upstream [`GetService`](https://github.com/NVIDIA/OpenShell/blob/081e727fd06a76ecc6b5aec7da1092626057e15d/proto/openshell.proto#L1781-L1853), absent from OCE's vendored API, accepts workspace, Sandbox and service name and returns endpoint metadata, Sandbox identity, target port, effective mode and URL. Evaluate it before proposing new persisted state. It is a possible scoped recovery input, not a selected OCE result shape or proof of original operation settlement. Original State/lifecycle/effect owners retain the [recovery boundary](../openshell-kubernetes-identity-and-transport.md#loss-and-recovery).

### Listener and application authentication

[Exposed service routes](https://github.com/NVIDIA/OpenShell/blob/081e727fd06a76ecc6b5aec7da1092626057e15d/docs/how-it-works/sandboxes/overview.mdx#L564-L650) bypass control-plane RPC authorization and do not use OIDC or CLI login. Shared-listener TLS, any required client certificate and applicable edge policy still apply. Keep control-plane and application issuers/audiences distinct. OpenShell listener/supervisor, OCE Gateway and network owners must establish private routing, endpoint ownership, certificate trust and intended client identity at each actual hop. Routing alone establishes neither encryption nor application authentication.

Passthrough is explicit per trusted application service. It forwards zero or one well-formed bearer unchanged; absent credentials reach the application. Codex must reject absent or wrong credentials before initialization. Upstream rejects duplicate, Basic or malformed headers and continues filtering gateway/edge identity headers, proxy authorization and edge authentication cookies. Keep diagnostics and audit free of credentials and credential-bearing payloads. Forwarding a deliberately reused control token establishes no installed incident; the service must be trusted to receive the application credential.

### Peer status and currentness

For profiles following plugin status, the [existing runtime](https://github.com/openclaw/openclaw-enterprise/blob/0c1e0e4324309cb1903175f718b97c8e34dddb1b/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L841-L900) needs authenticated status bound to revision, Pod UID and startup ID. Its explicit remote endpoint requires HTTPS; its local path derives another port from a direct `ws://` address. An exposed-service URL does not authorize access to another workload port. Runtime/plugin-status, Sandbox, Compute and Gateway owners must connect the actual status producer and consumer; an arbitrary port rewrite is insufficient.

Startup consumes the base `APP_SERVER_TOKEN`; with plugin status it derives a revision/startup bearer, retains it in the environment and supplies its SHA-256 verifier to Codex. Gateway must derive the matching token from the same current startup identity. A static token or upstream's hash-only example cannot replace this contract. Missing, stale or mismatched status prevents activation/reconnect. Main already respawns Gateway on changed peer identity, but may keep its process while waiting through unreadable status. The [closure decision](../openshell-kubernetes-identity-and-transport.md#loss-and-recovery) therefore remains necessary.

### Withdrawal and uncertain effects

Gateway/request, Compute lifecycle and OpenShell relay owners must choose and prove finite authority-renewal, bidirectional cancellation and closure bounds for expiry, revocation, stop, replacement and unavailable peer status. Main can retain a Gateway process while status is unreadable. Readiness withdrawal, endpoint deletion, a revocation record or byte copying does not prove active-stream closure. No timeout is selected here or borrowed from native-admin or ForwardTcp.

## Unselected alternatives

**A — direct route.** Compute supplies `APP_SERVER_URL` only to nonembedded workloads without `nativeRuntime`, including dedicated Codex: same-cluster `ws`, or `executionCluster` `wss`. Native OpenClaw uses its node path. The combined repository path remains single-cluster. Discarding an exposed URL whose route strips headers does not prove A is blocked.

Historical released isolation permits only same-Namespace supervisor-role ingress on the boundary port. Direct app-port ingress needs upstream isolation/network-owner approval. Qualification must inspect revision labels, endpoints, listener, peers, application authentication and all additive NetworkPolicies together. Preserve TLS policy without waivers. This rule is not a passthrough default.

**B — opaque ForwardTcp.** Its first frame requires exact workspace/Sandbox, loopback target, gateway authorization and a Sandbox-bound SSH session token. The token is not port-scoped; a trusted adapter must pin the app port because Codex listens beyond loopback. Real OCE wrappers and an authenticated native Gateway receiver need an owned two-way data, closure and settlement interface. Join cancellation both ways, close idle connections, and terminate on expiry, revocation or lost current authority; a revocation record alone is insufficient.

Released limits are process-local: three connections per token and twenty per Sandbox, separately from 256 queued frames. SSH expiry defaults to 86400 seconds; zero means no expiry. Any future B selection needs a short finite lifetime and closure bounds without token churn. These are not passthrough concurrency, lifetime or closure defaults; none is selected for passthrough here.

## Material owner decisions

The initial credential registration permits plaintext within trusted API, Driver, gateway, provider-store and substitution components. The Agent receives a model placeholder and scoped repository-service bearer, never the model key, GitHub App key or installation token. This weaker boundary does not establish the later protected target's prohibition on plaintext Driver inputs or gateway routes, authenticated per-request authority, or active-traffic closure. Issue #118 owns those mediation, custody and currentness obligations.

The original request retains authority through [State and Work](../../docs/reference/platform-repositories.md#ownership-and-atomicity) and [IAM](../../docs/reference/authorization.md). Separate suppliers provide immutable images, `runtime.json`, `config.toml` and bounded writable home, including profiles without optional plugins. Missing genuine suppliers block positive composition claims; local preparation may continue. Conditional initialization remains required where the profile needs it. The [repository-material carrier](#material-owner-decisions) remains unselected. This proposal adds no console, service or identity issuer.

OpenShell isolation and OCE identity/runtime owners, with human architecture authority, must approve and enforce a narrow exception to capability-free workloads. The selected base/derived bearer and workload identity are capabilities. Resolve exact projection fields, named recipients and trusted-relay custody. Provider keys and OpenShell control-plane, gateway, edge, workspace and supervisor credentials remain outside the Agent. Transport selection grants no exception or risk acceptance.

The requesting user and existing repository/credential, Compute/Sandbox and runtime owners must choose **typed Kubernetes projection or authenticated post-start transfer** for repository material. Bind its recipient to workload/revision/session and preserve custody, currentness, renewal and cleanup. Passthrough chooses neither carrier. Main refuses repository plus Sandbox both in [composition](https://github.com/openclaw/openclaw-enterprise/blob/0c1e0e4324309cb1903175f718b97c8e34dddb1b/apps/controller/src/composition/installation-config.ts#L864-L869) and [Compute](https://github.com/openclaw/openclaw-enterprise/blob/0c1e0e4324309cb1903175f718b97c8e34dddb1b/apps/controller/src/drivers/compute/kubernetes/index.ts#L1985-L2003); its separate repository-port check does not supersede either refusal. Retain both until a genuine approved handoff closes the gap.

Endpoint/result recovery, authenticated peer status, listener trust, conditional initialization and finite stream closure remain decisions at their owning sections above. Owners must approve the concrete producer/consumer contracts and prove them through ordinary positive and negative workflows before claiming the [selected outcome](../openshell-kubernetes-identity-and-transport.md#verification).

## Implementation and qualification

1. OpenShell isolation/Kubernetes/launcher and OCE identity/runtime owners agree on the capability exception, resource projection, named child delivery and integrity changes. Close conditional initialization for affected profiles.
2. Extend OCE's vendored protocol, create-request mapping and existing Sandbox/Compute/Gateway endpoint and peer-status handoffs. Preserve original authority, admission, native authentication and TLS/CA checks. Rejection-only support is not a launch solution.
3. After supplier acceptance, qualify ordinary deployment, mediated work and withdrawal using the accepted images/configuration. Static-token bridges, borrowed supervisor tokens, admission disablement, `pods/proxy` waivers, relaxed authentication/TLS and hidden shared modes are excluded.

If implemented, update the living references for [SandboxDriver](../../docs/reference/drivers/sandbox.md), [OpenShell SandboxDriver](../../docs/reference/drivers/openshell-sandbox.md), [Kubernetes ComputeDriver](../../docs/reference/drivers/kubernetes-compute.md), and [Harness execution](../../docs/reference/harness-execution.md) to describe the resulting behavior.

### Required observations

- Exercise the ordinary caller with explicit mode, unsupported/ignored-mode refusal, exact endpoint binding, real upgrade/two-way frames, missing/wrong-bearer refusal, default stripping, malformed/duplicate-header denial, credential filtering and secret-free diagnostics.
- Verify actual workload-Pod identity rotation/reload, replacement/deletion, mounts and startup/later-exec recipients, including nested serialized values. Deny foreign, replaced or widened references. Prove conditional bootstrap, restart, identity reuse and cleanup.
- In installed Kubernetes, prove private endpoints, sibling isolation, TLS/client identity and the combined effect of all selecting NetworkPolicies. Broad public TCP 443 plus empty egress does not deny GitHub bypass. Prove DNS/IP/443 denial while mediated model traffic works.
- Demonstrate stopped/replaced denial, established-stream closure, current reconnect and original-owner unknown-result recovery. Use real model/GitHub results and independent repository/object verification for each selected outcome in [Scope](../openshell-kubernetes-identity-and-transport.md#scope-and-deliverables).

### Evidence and status

Inspected OCE main is `0c1e0e4324309cb1903175f718b97c8e34dddb1b`; selected upstream source is `081e727fd06a76ecc6b5aec7da1092626057e15d`. Main implements credential attachment/status handling and peer-change Gateway respawn, while projection and endpoint composition remain incomplete. The [documented compatibility path](https://github.com/openclaw/openclaw-enterprise/blob/0c1e0e4324309cb1903175f718b97c8e34dddb1b/docs/flows/openshell-sandbox-provisioning.md#L288-L304) copies tokens through a verification-only Job/PVC path and runs model/tool checks inside the Pod; it proves neither native workload projection nor an authenticated exposed-route model turn.

September 30 [upstream run 36731560050](https://github.com/NVIDIA/OpenShell/actions/runs/36731560050) reports a Docker default-strip timeout before the passthrough assertion and a v1alpha1 gated-Pod timeout; v1beta1 smoke passed. Earlier checks at `af2240e580fb02eabd871e189c1050c9ce862298` comprised ten Go tests, seven Rust tests and a wire check; the WebSocket unit constructed a request. That earlier v1beta1 gated-Pod attempt failed with unknown cause. These are distinct observations, not installed OCE/Codex proof.

The September 30 upstream intake records open/review-required status and unknown mergeability. No P1 or installed incident was established. Source and doubles do not establish installed Kubernetes/OpenShell/Codex behavior, CNI enforcement, genuine runtime, live-provider behavior or release acceptance. Human architecture, implementation, security and release decisions remain separate.

### References

[Current provisioning flow](../../docs/flows/openshell-sandbox-provisioning.md) · [Upstream transport limits](https://github.com/NVIDIA/OpenShell/blob/081e727fd06a76ecc6b5aec7da1092626057e15d/docs/how-it-works/sandboxes/overview.mdx#L545-L650).

Historical sources: [OCE provisioning at `73632989`](https://github.com/openclaw/openclaw-enterprise/blob/73632989f1377f74dc417febf57e2748536a995d/docs/flows/openshell-sandbox-provisioning.md) · [OpenShell v0.1.2 Driver](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/crates/openshell-driver-kubernetes/src/driver.rs) · [ForwardTcp](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/crates/openshell-server/src/grpc/sandbox.rs) · [Child launch](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/crates/openshell-sandbox/src/boundary_exec.rs).
