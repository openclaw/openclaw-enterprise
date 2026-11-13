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

## Alternatives and delivery

A provider can adapt its ordinary endpoint/status methods to read retained launch context without changing those signatures. Alone it supplies neither Compute's durable first-choice generation pin nor pre-release consumer acknowledgment.

A provider-selected directory plus matching image digest is insufficient: the image may ignore that directory and remain ordinary. An independent compatibility registry could prevent that, but adds authority and configuration absent from this task. Choose the fixed generic sink and narrow Gateway derivative instead.

After submission, implement this capability and current Compute caller as one coherent change, then qualify the exact provider/Gateway pair. Reuse existing persistence, enrollment, private-status and cleanup owners. Update the owning RFC/index, Sandbox reference/flow and installed QA registration. The installed checks remain required before delivery.

The [implementation plan](../../plans/0051-protected-workspace-endpoint.md) tracks source changes, supported transitions and remaining proof.
