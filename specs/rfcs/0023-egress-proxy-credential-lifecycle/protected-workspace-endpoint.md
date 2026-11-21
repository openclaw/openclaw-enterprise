---
rfc: index.md
---

# Observe and pin a protected workspace before release

This proposed amendment to [RFC-0023](index.md) defines how Compute binds a protected Harness endpoint to its Gateway before release. Acceptance and installed qualification remain separate.

## Problem and decision

A protected Harness can reserve its endpoint while startup remains held. Compute must bind the Agent Gateway to that original endpoint before signed release, then confirm the same original is serving. Current activation reconstructs reduced Harness requirements. A provider that requires its complete retained launch cannot safely treat that input as a new launch. The ordinary endpoint contract also lacks an original-generation identity and startup acknowledgment; Compute pins the CA alone.

Add one optional `protectedWorkspace` capability to Sandbox. Its observers use the current Namespace, revision, Kubernetes client and cancellation signal; the provider retains the complete original launch. Compute owns the durable first-choice pin and release ordering. Use a fixed generic trust directory in a qualified Gateway derivative, with a real consumer acknowledgment before release. Select this behavior through the admitted capability and preserve existing Compute checks.

The first supported caller is the normal protected dedicated Codex deployment. This proposal grants no model, Git, credential or release authority and changes no source-admission or manual approval rule.

## Public boundary

Export the proposed types through the existing contracts entry point:

```ts
interface ProtectedWorkspaceCapability {
  readonly version: 1;
  readEndpoint(
    context: SandboxHarnessWithdrawalContext,
  ): Promise<ProtectedWorkspaceEndpoint | undefined>;
  readStatus(
    context: SandboxHarnessWithdrawalContext & {
      readonly transportToken: string;
    },
  ): Promise<SandboxHarnessStatus>;
}

interface ProtectedWorkspaceEndpoint {
  readonly url: string;
  readonly tls: { readonly caBundle: string };
  readonly workspaceRoot: string;
  readonly original: {
    readonly generationSha256: string;
  } & (
    | { readonly state: "reserved" }
    | { readonly state: "release-acknowledged"; readonly startupSha256: string }
  );
}
// Optional member of SandboxDriver:
// readonly protectedWorkspace?: ProtectedWorkspaceCapability;
```

The capability/version identifies this purpose; ordinary endpoint objects cannot satisfy it. Reject extra or missing endpoint fields. URL is a canonical credential-free WSS origin with pathname `/`, accepted by the existing provider network policy. Workspace root is an absolute canonical non-root path. CA contains public certificate bytes only. Digests are lowercase SHA-256 values, not independent authorization evidence.

Sandbox verifies the current owner, execution, retained launch, route and mounting generation on every observation. It rejects a replaced original and an acknowledged startup that regresses or changes. `undefined` means no stable observation yet; Compute remains pending. Invalid state, ownership conflict and I/O failure preserve their typed cause. Do not reuse a private adapter that catches every error and returns absence or `starting`. Status authenticates the original transport; only `serving` can satisfy readiness.

Selection requires existing `provisionHarness` and `enrollHarness` plus both observers. Compute uses the capability observers for that revision; ordinary endpoint methods remain for other revisions. It verifies the same full selected Driver registration and capability object before and after each asynchronous read. Every capability selection records `protected-workspace-endpoint:v1:<selection-hash>:<prior-admission>` in the existing Compute admission string. The selection hash binds the full Sandbox registration, protocol version and complete immutable Gateway image reference (`repository@sha256:digest`); the prior admission remains available for existing runtime checks. This marker requires a fresh revision. A missing or changed capability, unsupported version or incompatible image refuses that revision instead of falling back to ordinary endpoint methods.

Use the distinct built-in Compute implementation identity `occ/kubernetes-protected-workspace-v1` for this capability. Normal composition selects it only after loading a complete protected-workspace Sandbox, and uses the same frozen identity in both the Compute instance and Installation metadata. A legacy identity cannot enable the capability. The ordinary implementation remains unchanged.

This path requires a fresh Installation. Do not relabel an existing Installation or adopt its revisions; their original Compute owner retains cleanup. An older Worker must reject the new implementation at its identity check before material reads, attachment, provisioning or release. Qualify that actual early refusal: the admission marker alone is insufficient because an older validator can ignore it until preparation. Unsupported old Workers must not consume this Installation's queue; even a safe refusal would otherwise fail new work.

## Fixed Gateway binding and acknowledgment

Compute mounts only root-owned, read-only `binding.json` and `ca.pem` at `/etc/openclaw-protected-workspace`, under verified nonwritable ancestry, for the normal unprivileged Gateway. Reject collisions with actual rendered parent, child or duplicate mounts. The format is fixed; neither provider nor Agent chooses a path or supplies arbitrary volume contents.

`binding.json` is canonical JSON with exactly `{format: "protected-workspace-v1", url, workspaceRoot, generationSha256}`. `ca.pem` contains the pinned public CA bytes. Compute selects mandatory protected-workspace mode for this revision. The qualified Gateway rejects an absent or invalid required binding, mismatched effective URL/root/token selection, changed files or peer generation, and TLS failure. Preserve existing connection and RPC restrictions.

The actual loaded Gateway consumer reports this additional field through the existing authenticated private status channel:

```ts
protectedWorkspaceBinding: {
  version: 1;
  bindingSha256: string;
  generationSha256: string;
}
```

The fingerprint is SHA-256 of UTF-8 `JSON.stringify({format, url, workspaceRoot, generationSha256, caBundle})` in that field order, with the exact pinned values and CA bytes. The consumer emits it only after loading the binding, enabling mandatory checks and matching its effective connection configuration. A wrapper that merely reads the files cannot emit this acknowledgment on the consumer's behalf. It need not contact or release the held Harness to acknowledge its configuration. Each live observation rechecks binding currentness in the loaded consumer. A Gateway or plugin restart/reload invalidates the acknowledgment, even when the Pod and container identity stay the same; only the newly loaded consumer can acknowledge again.

Compute checks the fingerprint and generation together with the existing revision, actual Pod UID and container identity. Missing acknowledgment stays pending; mismatched acknowledgment fails. Require it before signed release and again before readiness. Normal configuration pins the complete qualified Gateway image reference. An older image that ignores a new environment field cannot satisfy the acknowledgment.

## Compute ordering and persistence

1. Use the normal admitted revision and existing protected installation checks. The first Gateway provides authenticated workspace-node setup before Sandbox can reserve the original. Record this `bootstrap` phase on the existing immutable configuration anchor. Its exact owned template has no usable model endpoint or local inference fallback. Preserve the Agent's existing node identity and authenticated setup; do not mint replacement setup to bypass a missing or expired prerequisite. Then provision the held original through Sandbox.
2. Read a stable reserved endpoint. Before signed enrollment, atomically change the original anchor from `bootstrap` to `bound` and record its first choice with a resource-version-checked update. Require the same revision's exact bootstrap template; no other Gateway can authorize this transition. Then create the immutable revision-owned binding/CA ConfigMap. Pin the selection, URL, root, generation and CA bytes. Concurrent attempts may confirm identical bytes only.
3. Read back anchor identity, owner and exact immutable pin. Replace the same revision's bootstrap template with mandatory binding and wait for its genuine consumer acknowledgment. Node connection can converge after release; neither rendering nor this acknowledgment proves workspace readiness. An uncertain write, missing pin after first choice, changed anchor or conflict cannot authorize another original or a second first pin. A bound anchor cannot return to bootstrap, including after Gateway deletion or controller restart.
4. Invoke existing `enrollHarness` through Compute's current installation and signed-release checks. The observers cannot sign or repeat release. Require an acknowledged endpoint matching the pin, then read status between two equal acknowledged observations, including the startup digest.
5. At activation and later checks use the narrow observers with the current signal, never reconstructed launch requirements. Require real node enrollment, the same node identity, matching Gateway revision/Pod/node acknowledgment and workspace readiness. Cleanup remains with the original owner; remove pins only after its workloads terminate. Uncertain cleanup remains unresolved.

Sandbox retains the first acknowledged startup identity; a restarted provider cannot manufacture continuity. Compute re-reads the durable pin after its own restart. Equal endpoint text cannot authorize adoption of a replacement owner.

## Native Service route extension

This route extension is proposed; implementation and installed qualification
remain pending.

Let Kubernetes Compute observe a provider's native, in-cluster Harness Service instead of requiring the static `network.providerHarness` bridge. Current preparation requires that bridge before `provisionHarness`, although a native provider creates its Service during provisioning. Skipping that check alone is insufficient: endpoint validation and Gateway rendering also require the static route.

The first profile covers a fresh protected dedicated Codex revision, one cluster, one IPv4 ClusterIP Service and one Harness Pod. Select it explicitly with `network.providerHarness: { mode: "owned-service-v1" }`. This closed variant accepts no other fields and is incompatible with the existing static namespace/labels/address/port object. Omission retains the original missing-route refusal. Existing ordinary routes and the local OpenShell bridge keep their behavior. External endpoints, cross-cluster placement and ambiguous routes cannot fall back to another profile.

Use the existing selected endpoint, Namespace-scoped Kubernetes client, `SandboxResourceRef` and Compute-generated workload labels; add no Sandbox method or return field. The existing Installation configuration identity and saved route pin bind the profile. Older schemas require the four static fields and reject the new variant; qualify that refusal through the actual loader and constructor before material delivery or provisioning. No additional implementation identity is needed for this configuration rejection.

### Observe before granting reach

During model-disabled bootstrap, preserve the existing DNS and authenticated node-setup paths but grant no Gateway-to-Harness egress. An unavailable route produces an empty egress rule list, never an empty destination selector. Do not change a serving predecessor's grants to prepare this fresh-deployment profile.

After the selected Sandbox provisions, Compute checks its returned resource against the Namespace, Agent and revision. It then observes the endpoint's canonical, namespace-qualified Service hostname through the selected cluster's Kubernetes API. Before installing the route, require:

- A nondeleting ClusterIP Service in that Namespace, with an assigned IPv4 address and no external name, external addresses, load balancer or NodePort exposure. Its sole TCP port matches the WSS URL and resolves to the declared port on the Harness Pod.
- A nondeleting Pod matching the returned resource name and every Compute-required workload label. The Service's nonempty selector includes the Namespace, Agent, revision and workload-profile labels and selects only that Pod. Its controller owner reference identifies that Pod's UID. Provider-added labels are permitted; labels alone do not establish ownership.
- One complete EndpointSlice observation owned by that Service UID, with one endpoint targeting the same Namespace, Pod name, UID and observed Pod IP. Its address family and TCP port agree with the Service and Pod. Reject pagination, extra targets and terminating endpoints. A provider may publish its held transport before Pod readiness; this observation grants no serving or release claim.

Read the Service and Pod around the EndpointSlice observation and reject inconsistent relevant fields. Preserve the existing canonical WSS, public CA, workspace-root and hook-directory guards. Use cluster DNS, without a synthetic host alias. Grant Gateway egress only to the verified Namespace and Pod selector on the observed TCP port; retain the provider's existing egress fence. A workspace-node peer declaration alone cannot authorize this reverse connection.

### Pin and revalidate the route

Extend Compute's durable first-choice binding with the route profile, Service name/UID/address/port/selector, Pod name/UID/IP and EndpointSlice UID/target/port. Resource versions establish a consistent read, not permission to replace that binding. Bind it to the same selected Driver, Agent revision, original generation and existing anchor; reuse the current atomic first-choice transition and uncertain-write rules.

Revalidate the route before installing its policy and bound Gateway, accepting the consumer acknowledgment, signing release, and activation/readiness. A missing route before first choice stays pending. Malformed data, ownership mismatch, replacement or loss after first choice retains its typed failure and cannot select another route. On observed invalidation, remove the affected revision's grant without expanding another policy; uncertain revocation remains a cleanup failure. Preserve the first cause and the original owner's termination and pin-cleanup obligations. Route validation neither emits the consumer acknowledgment nor replaces authenticated transport checks.

## Acceptance Criteria

All outcomes remain unverified until the stated caller runs.

| ID   | Real caller and required proof                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-1 | Normal authenticated Agent deployment with a qualified Sandbox: model-disabled bootstrap and existing node setup → provision → reserved pin → genuine Gateway binding acknowledgment → existing signed enrollment → equal acknowledged endpoint/status → real node acknowledgment → readiness. Activation uses retained original observers despite reduced ordinary requirements.                            |
| AC-2 | Real Kubernetes pin writes: concurrent identical first choice converges. Different URL/root/generation/CA/selection, lost write reply, missing pin, changed anchor UID and Compute restart cannot select a second original. Preserve the original failure and cleanup obligation.                                                                                                                            |
| AC-3 | Authenticated provider observations: wrong revision/owner, changed route or mounts, missing/changed acknowledgment and replacement transport remain unready. Conflict/I/O exceptions retain their cause. Endpoint presence alone cannot prove serving.                                                                                                                                                       |
| AC-4 | Qualified Gateway as normal UID with read-only root/private scratch: correct binding enables the actual checks. Absent/altered files, wrong CA/URL/root/generation, forbidden RPC, configuration override and false/stale consumer acknowledgment and same-Pod consumer restart block release or use until the current consumer acknowledges. Older images and workers cannot fall back to an ordinary path. |
| AC-5 | Real existing node identity and volume survive the transition. Missing/expired setup, replacement node or wrong Gateway Pod/node acknowledgment fail without inventing identity. After readiness the same Agent reads a workspace marker and completes an authenticated controlled model turn. Report repository operations separately.                                                                      |

Extend existing real Compute/Kubernetes and installed QA workflows. Controlled providers can replace external services, not the binding consumer, pin persistence or release behavior under test. Pure validators and recording callbacks cannot establish AC-1–5. Cover capability absence and unchanged ordinary revisions too.

The native Service extension additionally requires:

- **AC-6:** The real preparation caller grants no Harness route during bootstrap, then observes the provisioned Service and installs only its exact peer/port before binding and release. Test wrong Namespace, labels, owner UID, address, port and EndpointSlice target; retain ordinary and static-bridge regressions.
- **AC-7:** Real Kubernetes persistence and reconciliation reject replacement, partial observations, lost-write ambiguity and stale pins across Compute restart. Route invalidation closes the grant; cleanup failure stays visible. An older Worker rejects the explicit configuration variant before effects.
- **AC-8:** A connected installed Agent uses the real Gateway consumer and enforced NetworkPolicy to reach its selected Harness while an unrelated Pod is denied. Confirm the same revision, node and mounted workspace through release and a controlled model turn. A native renderer or controlled API check establishes only its exercised boundary; installed qualification remains open until this caller passes.

## Alternatives and delivery

A provider can adapt its ordinary endpoint/status methods to read retained launch context without changing those signatures. Alone it supplies neither Compute's durable first-choice generation pin nor pre-release consumer acknowledgment.

A provider-selected directory plus matching image digest is insufficient: the image may ignore that directory and remain ordinary. An independent compatibility registry could prevent that, but adds authority and configuration absent from this task. Choose the fixed generic sink and narrow Gateway derivative instead.

After submission, implement this capability and current Compute caller as one coherent change, then qualify the exact provider/Gateway pair. Reuse existing persistence, enrollment, private-status and cleanup owners. Update the owning RFC/index, Sandbox reference/flow and installed QA registration. The installed checks remain required before delivery.

The [implementation plan](../../plans/0051-protected-workspace-endpoint.md) tracks source changes, supported transitions and remaining proof.
