# Feature Spec: OCC Gateway Administration and Command Proxy

**Date:** 2026-08-31

**Status:** Completed — historical transport design superseded by the workspace-file API

**Historical note:** This record preserves the original approved remote
native-device enrollment design. It does not describe current gateway access.
Use [Agents](../../../docs/reference/agents.md#workspace-files), the
[workspace-file flow](../../../docs/flows/workspace-files.md), and the later
[private routing specification](../../.archive/20-private-agent-gateway-routing.md).

**Owner:** OCC admission and API; bundled Kubernetes Compute implementation

## Problem and Decision

OCC provisions each Agent's gateway but has no authenticated native gateway client or command proxy. A shared gateway token alone does not establish a remote backend client's administrative scopes. Enroll a dedicated OCC device automatically during gateway bootstrap, then let authorized administrators issue native commands through the Agent's `/gateway/` endpoint.

This records the implementation under the [platform design](../../../docs/design.md). The source baseline is Enterprise `4bf6985ebd3e746999bf270aead8921b4be7d812` and OpenClaw `b9d01e71270e15208d191e4ea4afdef31fbf51ac`; the implementation adds the Enterprise integration described below. Native enrollment is source-backed; the SDK pair is pinned to `@openclaw/gateway-client` `2026.8.1-beta.3` and `@openclaw/gateway-protocol` `2026.8.1-beta.3`, with native runtime `2026.8.1` and the real runtime verification recorded below.

## Scope

- Automatic, exact-device enrollment as native `operator` with `operator.admin`; no human approval for each newly provisioned gateway.
- One authenticated HTTP request and native RPC response for a selected, running Agent, in development and production with the bundled Kubernetes Compute implementation.
- An initial command allowlist covering diagnostics, native workspace files, and chat; the same internal client can support future OCC-owned administration flows.
- Preserve OCC Configuration and immutable AgentRevision ownership, exact-resource IAM, isolated Agent credentials, and mutable native workspace state.
- No browser-to-gateway credentials, WebSocket/SSE tunnel, event subscription, generic destination proxy, durable command queue, automatic command replay, new platform resource, or new public Driver contract. Docker and external Compute implementations return unsupported for this endpoint until separately implemented.
- Direct native configuration mutation, software updates, device administration by proxy callers, offline file editing, platform prompts, and a complete operator console are outside this first slice.

## Contract

### Native identity and automatic enrollment

See [Native identity and automatic enrollment](native-identity-and-enrollment.md#native-identity-and-automatic-enrollment).

### HTTP request and native result

See [HTTP request and native result](request-routing-and-policy.md#http-request-and-native-result).

### Authorization, routing, and command policy

See [Authorization, routing, and command policy](request-routing-and-policy.md#authorization-routing-and-command-policy).

## Implementation

1. **G1 — Bootstrap native access.** Extend bundled Kubernetes preparation and exact Agent credential ownership with the bounded native CLI helper and pinned SDK adapter. Invoke the helper once in the owned gateway container; keep existing runtime startup and private-state cleanup unchanged. Keep public ComputeDriver contracts and SQL resources unchanged. Wire controller-namespace credential RBAC, tenant-scoped worker-only `pods/exec`, and API/worker `pods/proxy` GET in [Helm](../../../deploy/helm/openclaw-enterprise/templates). Document the terminal incomplete-enrollment case and quiesced operator reset/revocation procedure in the deployment guide.
2. **G2 — Admit and proxy a command.** Add strict request/result contracts and the Agent-scoped route in `packages/contracts/src/api/` and `apps/controller/src/index.ts`; expose the internal adapter through controller Installation composition. Implement exact `administer`, cookie CSRF, allowlist, owned routing, bounded first-response handling, and sanitized audit. Update the native bootstrap grant, generated OpenAPI, API reference, relevant gateway execution flow, and existing deployment guide when behavior ships; do not label this draft as current support.
3. **G3 — Prove the complete path.** Use a disposable Kubernetes cluster, PostgreSQL with the limited controller role, and a real digest-pinned OpenClaw image. Exercise actual signed enrollment and HTTP-to-WebSocket commands, then repeat after controller/gateway restart and revision replacement. Cover the retained invariants below; use unit/contract tests for HTTP failure mapping, with real native integration as the acceptance proof. Do not substitute an HTTP fixture or skipped integration case for gateway access.

## Verification

| Required outcome                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new Agent becomes administrable without human pairing       | Real gateway creates a remote pending request and pairs the exact OCC device through exact helper approval, including with `gateway.nodes.pairing.autoApproveLocal=false`; `/gateway/` executes `status` and file get/set through OCC. In the explicit-approval case, a second unrelated pending device remains unapproved.                                                                                                                    |
| Partial enrollment fails closed                               | Fail/kill OCC after native approval but before token persistence. On restart, a key-only record stays unavailable without helper execution, shared-auth reconnect, or identity replacement. Test an uncertain write that actually persisted: read-back recovers only through token authentication. SDK hello must not make readiness true before durable storage.                                                                              |
| Restart and revision changes preserve identity and revocation | Record only public device ID; restart controller and gateway, replace revision with intact PVC state, and repeat proxy access with the same ID. Revoke/remove established OCC access, restart, and prove no automatic approval/fallback restores it. Stopped/unready gateways and lost native state return unavailable; quiesced operator recovery is deliberate.                                                                              |
| Caller boundaries hold                                        | Real IAM cases: unauthorized, `operate`-only, Agent principal, and cross-Namespace callers are denied before native dispatch; explicit `administer` succeeds. Cookie cross-site/missing Origin is denied, same-origin succeeds, and scoped API-key automation succeeds.                                                                                                                                                                        |
| Routing and command ownership hold                            | Inject a target URL/extra outer field and call a stopped Agent: no dial. Mismatched Kubernetes ownership is rejected. An allowed native file operation succeeds; `config.patch`, pairing administration, and unknown methods are denied without changes.                                                                                                                                                                                       |
| Native RPC semantics survive the facade                       | Prove native success and typed rejection, plus `chat.send` accepted acknowledgment without completion claims; retrieve its resulting history. Force a sent-request disconnect/timeout and prove no second dispatch. Oversized input/output and cancellation produce bounded, correctly qualified failures.                                                                                                                                     |
| Credentials and evidence remain isolated                      | Verify the OCC credential Secret is not mounted in workloads or copied into admitted revisions, API payloads, or logs; native token issuance/storage remains gateway-owned. Helper receives only public pin and its existing transport auth. Audit attributes dispatch to the OCC caller without native arguments/results. Verify incompatible auth profile, missing exec permission, wrong Pod ownership, and enrollment timeout fail closed. |

Implementation commit: `27fa96cf22522dfc382ddd9c4f152692783c76f2`. Verification completed on 2026-08-31. TypeScript, build, workspace boundaries, OpenAPI parity, formatting, and flow validation passed. Conformance passed 176 tests with one pre-existing placeholder skip; default integration passed 91 tests with 52 unselected external-runtime skips. All three selected real Kubernetes regression cases passed without skips.

Both required native scenarios passed against the production application/worker composed in-process, limited-role PostgreSQL, and real digest-pinned OpenClaw `2026.8.1` / Codex `0.150.1` Pods: partial-enrollment recovery after token-persistence RBAC failure (135.6 seconds), and the complete command, model-turn, restart, revision-replacement, revocation, credential-loss, and supplemental failure proof (307.2 seconds). The partial scenario's passing result was retained while the positive scenario was rerun after audit/revocation test-helper corrections; production code and the partial scenario were unchanged. The proof does not claim a Helm-installed controller deployment or CI success.

Current behavior is documented in the [Agent reference](../../../docs/reference/agents.md), [Kubernetes reference](../../../docs/reference/drivers/kubernetes-compute.md), [current workspace-file flow](../../../docs/flows/workspace-files.md), and [deployment guide](../../../docs/guides/deploy.md).

## Manual Notes

## Changelog

- 2026-08-31 11:52: Drafted separate OCC native enrollment and Agent gateway command proxy proposal for independent review. (01a04ae1-7ba7-7372-88a4-488e01f690ae — 4bf6985ebd3e746999bf270aead8921b4be7d812)
- 2026-08-31 12:02: Applied approved review direction: defined durable enrollment ordering and terminal recovery, removed duplicate completion state and Agent-deletion scope, retained the diagnostics/files/chat allowlist, and corrected source links. (01a04ae1-7ba7-7372-88a4-488e01f690ae — 4bf6985ebd3e746999bf270aead8921b4be7d812)

- 2026-08-31 15:46: Completed native gateway administration, exact rollout verification, and real Kubernetes/PostgreSQL/native failure proof; current behavior lives in the linked reference and flow documentation. (01a04ae1-7ba7-7372-88a4-488e01f690ae — 27fa96cf22522dfc382ddd9c4f152692783c76f2)
- 2026-09-01 08:38: Marked the completed remote native-device enrollment design as historical after the approved CLI execution simplification moved the current contract to the living reference and flow docs. (cody/01a05d9c-4cb5-7602-8df5-56d7f8309f44 — 7b4a819f02d6950e8cc2a2e08eb29c2f668493ad) (NOT_IN_SPEC)
