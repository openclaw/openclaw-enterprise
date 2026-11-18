---
status: In progress
rfc: ../rfcs/0043-native-restart-recovery.md
---

# Implementation plan: Use native restart recovery without OCE recovery bookkeeping

- **ID:** TASK-0053
- **Delivery status:** In progress
- **Owner:** kevinlin-openai
- **Authority:** User-requested simplification of [RFC-0042](../rfcs/0042-redeployment-continuation.md); its completed delivery remains historical. [RFC-0043](../rfcs/0043-native-restart-recovery.md) submits the successor Driver decision.
- **Source baseline:** `f682e612c26c6384fab2e0ec5f66074dd560fcc9`; OpenClaw `b58996d69286d55d1bbbd9b5c03b4ad837baac45`.
- **Implementation base:** `c51d6138ef7abbb637848e7f81b206ce6195d4eb`.

## Outcome and scope

Whenever a Gateway starts with retained state, let native OpenClaw detect and
continue eligible interrupted work. Remove OCE's recovery generations,
compatibility domains, persisted recovery metadata, and native scope patch.
Do not replace them with a stop epoch, constant Agent token, startup scanner,
or `chat.send` loop.

OpenClaw retains ownership of interruption detection, current authority checks,
session identity, explicit turn cancellation, and continuation admission. A
continuation is a new input in the retained conversation, not a restored process.
Keep the Harness-readiness bridge: workspace reconnection and a finite surviving
Codex turn can otherwise prevent native recovery.

An OCE Stop continues to request workload shutdown. This change makes no promise
that work from before Stop remains cancelled after a later Gateway startup.
Today, deploying a stopped Agent starts it again; that deployment may therefore
resume eligible interrupted work. [Issue #6500](https://github.com/openclaw/openclaw-enterprise/issues/6500)
separately tracks preserving stopped state across deployment. It is not a
prerequisite for this simplification. Native `chat.abort` remains distinct from
stopping the Agent workload.

Configuration changes no longer cause an OCE compatibility-based recovery refusal.
Native policy, authorization, retained-state validity, and Harness support still
apply. Changing to a Harness that cannot use the saved state does not acquire
continuity merely because OCE removed its filter. Exclusive replacement remains
stop-first, with downtime, no automatic rollback, and no exactly-once guarantee.

## Interface removal checklist

Every recovery addition in the [PR #6442 diff](https://github.com/openclaw/openclaw-enterprise/compare/7a26281407d8a1416ceab0acb2e00bbf2c2eb1c5...e81afe226ffbcf0560bb270a9b7ab6930f209ab2)
must be removed. Native continuation across redeployments remains the outcome.

| Interface                                                            | Required result                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment: `POST /namespaces/{namespaceId}/agents/{agentId}/deploy` | Remove generation allocation/reuse and domain matching. Keep the existing request, response, and running-state transition; #6500 owns stopped-Agent activation.                                                                 |
| Stop: `POST /namespaces/{namespaceId}/agents/{agentId}/stop`         | Remove transactional generation clearing and the guarantee against pre-Stop recovery after a later startup. Keep the stopped-state transition and workload shutdown.                                                            |
| HTTP wire contract                                                   | #6442 added no endpoint, request field, or public revision response field. Remove none and add no resume endpoint or recovery parameter.                                                                                        |
| IAM                                                                  | Keep exact-Agent `deploy`/`operate`, configuration `read`, native current-authority checks, and audit attribution. #6442 added no IAM surface. SQL column grants are separate.                                                  |
| Public resource types                                                | Remove exported `RestartContinuation`, its `generation`/`domain`, and optional `AgentRevision.restartContinuation` from `packages/contracts/src/index.ts`.                                                                      |
| Compute Driver                                                       | Remove `restartContinuationDomain` and required generation enforcement from the interface, implementations, documentation, and fixtures. Remove unsupported-Driver revision-scope fallback.                                     |
| Internal repositories                                                | Remove `findRestartContinuation` and `setRestartContinuation`, read-view/unit-of-work bindings, both adapters, the in-memory snapshot map, and recovery validators.                                                             |
| `occ.agents`                                                         | Drop `restart_generation`, `restart_domain`, `agents_restart_continuation_valid`, recovery-column grants, schema declarations, queries, and lifecycle writes.                                                                   |
| `occ.agent_revisions.admitted_spec`                                  | Remove `restart_continuation` with nested `generation`/`domain` from stored JSON, codecs, and allowed-key/type constraints. Preserve all other fields and immutability.                                                         |
| Runtime configuration                                                | Remove `OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE`, its shared constant, Kubernetes `restartResumeScope`, and Kubernetes/Docker/SSH launch wiring. No replacement setting.                                                          |
| Native private session contract                                      | Remove patch-added `lifecycleRestartScope`, `resumeAfterRestart.scope`, read/write/projection preservation, and scope-specific graceful/crash/queued-input/child-custody checks. Preserve native identity and authority checks. |
| Worker failure contract                                              | Remove `RestartContinuationEndedError`, `RESTART_CONTINUATION_ENDED`, and generation refusal branches. Keep desired-state, selected-revision, lease, and predecessor checks.                                                    |

Remove scope-patch build selectors, provenance, and checksums. Owners are
[PostgreSQL state](../../packages/occ/src/state/postgres-state.ts),
[schema](../../packages/occ/src/state/postgres-schema.ts),
[admission](../../packages/occ/src/index.ts), and
[worker](../../apps/controller/src/worker.ts).

Keep `compute.runtimeInputs`, `snapshotRuntimeInputs`, and compatibility in
[replacement-runtime.ts](../../apps/controller/src/drivers/compute/kubernetes/replacement-runtime.ts):
they predate #6442 and support independent runtime selection/planned replacement.
Remove only the recovery caller and `restartContinuation` exclusion. Keep #6435's
Harness-readiness bridge. No replacement recovery interface is planned.

## Implementation

1. **Submit the Driver decision before implementation.** Submit the short
   successor RFC for human review, linking this plan and the removed Stop
   guarantee. Preserve RFC-0042, merged #6442, and their evidence. Code and review
   may proceed in parallel after submission unless a specific hold applies.
2. **Remove application bookkeeping through the Agent workflow.** Delete the
   listed fields, methods, allocation, storage, and worker checks. Keep the
   worker's `desiredRuntimeState !== "running"` refusal when removing the shared
   generation branch. Verify revision and lease checks independently.
3. **Remove persisted data.** Append a removal migration; do not edit applied
   0081 or its checksum. Drop both columns, pair constraint, and update grants.
   Remove `restart_continuation` from every stored revision and allowed-key
   constraint. Use the migrator-owned transaction pattern from
   [0060](../../migrations/0060_credential_proxy_admission.sql), restoring
   immutability after the rewrite. Update journal/catalog evidence and schema.
   Fresh and populated databases must converge, without dual-read formats or shims.
4. **Use unscoped native recovery on every launch path.** Remove the runtime
   constant and all environment projections, including SSH systemd. Remove the
   entire scope patch, its checksums, provenance and scope-only selectors from
   the Dockerfile and [asset builder](../../scripts/build-runtime-assets.ts).
   Check remaining patches apply to pinned native source independently. Verify
   reading existing scoped retained records without an OCE translator. Native
   process restart and Kubernetes replacement mechanisms remain unchanged.
5. **Replace obsolete assertions with behavior proof.** Remove generation/domain
   cases from [PostgreSQL replacement coverage](../../tests/integration/postgres-worker-agent-revision-replacement.test.ts)
   and scope-only launch/build assertions. Keep Stop, concurrency, stale revision,
   and authorization coverage. In the [real helper](../../tests/helpers/harness-topology-k3d-real.mjs),
   prove continuation after harmless configuration change on the same Harness.
   Replace Stop→Deploy refusal with native continuation; keep explicit
   `chat.abort`, completed-session, revoked-owner, and active-remote-turn controls.
   Register changed names in existing CI manifests and QA selection.
6. **Update current docs.** Revise the
   [interrupted-turn contract](../../docs/reference/agents/interrupted-turns.md),
   Compute/SSH references, [recovery flow](../../docs/flows/harness-restart-recovery.md),
   affected topology flow, [proof guide](../../docs/testing/harness-restart-recovery.md),
   and [database cheat sheet](../../docs/reference/cheatsheets/database-entities.md).
   State Stop→Deploy behavior and link #6500. Preserve historical migrations and
   RFCs. No architecture-overview rewrite is needed. Image publication requires
   separate authorization and the normal verification workflow.

## Verification

Documentation preparation runs documentation checks only. Implementation requires:

- [ ] Complete every interface row; compare declarations and HTTP/IAM contracts
      against the pre-#6442 base. Add no replacement flags or permissive decoders.
- [ ] Search active source, schemas, generated declarations, tests, launch wiring,
      and build metadata. Historical RFCs and applied migrations may retain names.
- [ ] Typecheck consumers and verify unchanged HTTP schemas with `pnpm openapi:check`.

| Required outcome             | Real check and prerequisites                                                                                                                                       | Remaining proof |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| No recovery persistence      | Fresh install and populated upgrade in `postgres-migration-compatibility.test.mjs`; inspect actual columns/JSON, immutability and limited-role permissions         | Not run         |
| Stop and revision ownership  | PostgreSQL worker replacement suite, Stop during deployment and overlapping revisions without generation fixtures                                                  | Not run         |
| Unscoped native continuation | `harness-topology-k3d-real.test.mjs` through Agent API, including retained data from previous scoped runtime; same session and final result without new user input | Not run         |
| Configuration change         | Same real suite: ordinary redeploy and harmless configuration-generation change with valid authority/storage                                                       | Not run         |
| Negative controls            | Explicit cancellation, completed work, revoked owner, active-remote-turn refusal/wait                                                                              | Not run         |
| Packaging and launch paths   | Native AMD64/ARM64 images, remaining patch application/startup, Kubernetes/Docker/SSH conformance; not live proof on every topology                                | Not run         |

Real proof requires an enforcing disposable k3d cluster, migrated PostgreSQL
with a limited application role, digest-pinned native images, and authorized
model credentials. Keep the `k3d-model` lane and QA-matrix registration. Missing
prerequisites remain a proof gap; fixtures cannot replace real execution. Run
normal typecheck, lint, workspace, CI-selection, and documentation checks.

## Current-base adaptation

PR #6491 moved the former scope patch into the pinned OpenClaw source
`f8727fdcd3a1f6152b9fdc110f3004a8e58f25e9`. The implementation therefore applies a
removal patch to that source. It removes the upstream scope checks and fields;
it introduces no replacement recovery policy or state. Existing readiness and
unrelated source updates remain in place.

## Delivery record

RFC-0043 was submitted in [PR #6502](https://github.com/openclaw/openclaw-enterprise/pull/6502)
at `11cef2cb9` before Driver implementation. The follow-up implementation removes
the interfaces in the checklist and updates the current references and flows.

Source verification: consumer typecheck, workspace isolation, unchanged generated
OpenAPI, CI selection audit, and 448 selected Kubernetes/Docker/SSH, startup, and
runtime-asset tests passed with no skips. The real PostgreSQL fresh/populated
removal test passed all four checks; the complete compatibility suite is being
rerun after preserving the historical admitted-snapshot constraint and measuring
real dump/restore catalogs. The worker suite is being rerun after replacing its
obsolete generation assertion with Stop-during-preparation behavior.

Native unit checks and final image qualification are pending. No real model or
cluster recovery result is claimed. In particular, an old scoped-runtime-to-new
runtime transition still needs live proof. No merge, image publication, or
production deployment is part of this delivery.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-18: Materialized the authorized TASK-0053 plan and complete interface inventory against `c51d6138ef7abbb637848e7f81b206ce6195d4eb`; linked successor RFC-0043. The original plan was prepared against `f682e612c26c6384fab2e0ec5f66074dd560fcc9`.
