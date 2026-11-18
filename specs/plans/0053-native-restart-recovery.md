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
compatibility domains, persisted recovery metadata, and scope projection.
Leave pinned OpenClaw's optional restart-scope policy unchanged. Do not add a
behavior patch, stop epoch, constant Agent token, compatibility shim, startup
scanner, or `chat.send` loop.

The user's revised instruction supersedes removal of upstream scope machinery
and guaranteed continuation of old-scoped work. New work created without a scope
uses normal native eligibility. Previously scoped unfinished work may be refused
when a Gateway starts without a scope, including queued input and completion
custody where applicable. OCE does not translate native session data.

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

The OCE recovery additions in the [PR #6442 diff](https://github.com/openclaw/openclaw-enterprise/compare/7a26281407d8a1416ceab0acb2e00bbf2c2eb1c5...e81afe226ffbcf0560bb270a9b7ab6930f209ab2)
must be removed. The upstream-native row is explicitly retained under the revised
decision. Eligible new unscoped work can continue across redeployments.

| Interface                                                            | Required result                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment: `POST /namespaces/{namespaceId}/agents/{agentId}/deploy` | Remove generation allocation/reuse and domain matching. Keep the existing request, response, and running-state transition; #6500 owns stopped-Agent activation.                                                                         |
| Stop: `POST /namespaces/{namespaceId}/agents/{agentId}/stop`         | Remove transactional generation clearing and the guarantee against pre-Stop recovery after a later startup. Keep the stopped-state transition and workload shutdown.                                                                    |
| HTTP wire contract                                                   | #6442 added no endpoint, request field, or public revision response field. Remove none and add no resume endpoint or recovery parameter.                                                                                                |
| IAM                                                                  | Keep exact-Agent `deploy`/`operate`, configuration `read`, native current-authority checks, and audit attribution. #6442 added no IAM surface. SQL column grants are separate.                                                          |
| Public resource types                                                | Remove exported `RestartContinuation`, its `generation`/`domain`, and optional `AgentRevision.restartContinuation` from `packages/contracts/src/index.ts`.                                                                              |
| Compute Driver                                                       | Remove `restartContinuationDomain` and required generation enforcement from the interface, implementations, documentation, and fixtures. Remove unsupported-Driver revision-scope fallback.                                             |
| Internal repositories                                                | Remove `findRestartContinuation` and `setRestartContinuation`, read-view/unit-of-work bindings, both adapters, the in-memory snapshot map, and recovery validators.                                                                     |
| `occ.agents`                                                         | Drop `restart_generation`, `restart_domain`, `agents_restart_continuation_valid`, recovery-column grants, schema declarations, queries, and lifecycle writes.                                                                           |
| `occ.agent_revisions.admitted_spec`                                  | Remove `restart_continuation` with nested `generation`/`domain` from stored JSON, codecs, and allowed-key/type constraints. Preserve all other fields and immutability.                                                                 |
| Runtime configuration                                                | Remove OCE projection of `OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE`, its OCE constant, Kubernetes `restartResumeScope`, and Kubernetes/Docker/SSH launch wiring. Upstream still supports its optional setting. No replacement OCE setting. |
| Native private session contract                                      | Keep upstream `lifecycleRestartScope`, `resumeAfterRestart.scope`, and graceful/crash/queued-input/child-custody policy unchanged. OCE supplies no scope and promises no old-scoped continuation.                                       |
| Worker failure contract                                              | Remove `RestartContinuationEndedError`, `RESTART_CONTINUATION_ENDED`, and generation refusal branches. Keep desired-state, selected-revision, lease, and predecessor checks.                                                            |

Delete the inverse patch and its build wiring, provenance/checksum entries, and
unique test selector. Keep upstream tests and all unrelated patches. Owners are
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
4. **Leave upstream policy unchanged.** Keep all OCE scope projections removed,
   including SSH systemd. Delete the inverse patch, Docker COPY/apply/checksum
   wiring, asset provenance, expected packaging checksum, and unique test selector.
   Keep the source pin and other patches, especially the Harness-readiness bridge
   and improved expired-wait message. Select upstream's existing scope, recovery,
   custody, and session-entry tests. Do not add a smaller behavior patch or native
   state translator. Scope mismatch refusal is an accepted transition outcome.
5. **Replace obsolete assertions with behavior proof.** Remove generation/domain
   cases from [PostgreSQL replacement coverage](../../tests/integration/postgres-worker-agent-revision-replacement.test.ts)
   and scope-only launch/build assertions. Keep Stop, concurrency, stale revision,
   and authorization coverage. In the [real helper](../../tests/helpers/harness-topology-k3d-real.mjs),
   prove continuation for new unscoped work after a harmless configuration change
   on the same Harness.
   Replace Stop→Deploy refusal with native continuation; keep explicit
   `chat.abort`, completed-session, revoked-owner, and active-remote-turn controls.
   Register changed names in existing CI manifests and QA selection.
6. **Update current docs.** Revise the
   [interrupted-turn contract](../../docs/reference/agents/interrupted-turns.md),
   Compute/SSH references, [recovery flow](../../docs/flows/harness-restart-recovery.md),
   affected topology flow, [proof guide](../../docs/testing/harness-restart-recovery.md),
   and [database cheat sheet](../../docs/reference/cheatsheets/database-entities.md).
   State new-unscoped-work recovery, the accepted old-scope transition limit,
   and Stop→Deploy behavior; link #6500. Preserve historical migrations and
   RFCs. No architecture-overview rewrite is needed. Image publication requires
   separate authorization and the normal verification workflow.

## Verification

Documentation preparation runs documentation checks only. Implementation requires:

- [x] Complete every interface row; compare declarations and HTTP/IAM contracts
      against the pre-#6442 base. Add no replacement flags or permissive decoders.
- [x] Search active source, schemas, generated declarations, tests, launch wiring,
      and build metadata. Historical RFCs and applied migrations may retain names.
- [x] Typecheck consumers and verify unchanged HTTP schemas with `pnpm openapi:check`.

| Required outcome             | Check                                                                                                         | Current evidence                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| No OCE recovery persistence  | PostgreSQL fresh/populated removal, immutability and limited-role grants                                      | Earlier candidate: 252 checks passed; implementation unchanged in this revision |
| Stop and revision ownership  | PostgreSQL replacement workflow, Stop during preparation, overlapping revisions                               | Earlier candidate: 42 tests passed; implementation unchanged in this revision   |
| Ordinary native continuation | Real Agent API workflow for new unscoped work through restart, redeploy, configuration change and Stop→Deploy | Blocked by the local native sandbox probe; final-policy model proof pending     |
| Native limits and authority  | Upstream scope/refusal tests; cancellation, completion, revoked owner and active-remote-turn controls         | 64 upstream source tests passed; real-model controls remain blocked             |
| Packaging                    | Remaining patches apply; strict asset/provenance tests; both images on native AMD64/ARM64                     | Final-head qualification required; earlier inverse-patch images do not qualify  |

Real proof requires an enforcing disposable k3d cluster, migrated PostgreSQL
with a limited application role, digest-pinned native images, and authorized
model credentials. Keep the `k3d-model` lane and QA-matrix registration. Missing
prerequisites remain a proof gap; fixtures cannot replace real execution. Run
normal typecheck, lint, workspace, CI-selection, and documentation checks.

## Revised decision and delivery record

RFC-0043 was submitted in [PR #6502](https://github.com/openclaw/openclaw-enterprise/pull/6502)
at `11cef2cb9` before Driver implementation. The user has now explicitly approved
using upstream restart-scope policy unchanged. The pin remains
`f8727fdcd3a1f6152b9fdc110f3004a8e58f25e9`. Its optional scope comparison, fields,
and queued/custody behavior remain native responsibilities.

The earlier candidate removed those native checks and had patch-specific tests
for old-scoped continuation. That design and its native results are superseded;
they are not verification of this final policy. Previously scoped unfinished work
may be refused on transition. No successful old-image continuation is promised or
required. The existing readiness bridge and unrelated runtime integrations remain.

The OCE removals and append-only migration are retained. The earlier candidate
passed 252 PostgreSQL migration checks, 42 worker tests, 448 selected conformance,
startup and asset tests, and 127 QA fixture checks. Those are recorded evidence
for that candidate, not a replacement for final-tree CI and image qualification.
Required CI passed on `3f273a16a` in
[run 44402421814](https://github.com/openclaw/openclaw-enterprise/actions/runs/44402421814)
before this policy revision. The updated head must pass required CI again.

Local validation of the revised policy passed: **64 upstream tests across five
files**, including unscoped restart recovery and scoped-to-unset refusal;
**3 runtime-asset tests**; native production and four affected test typecheck
graphs; OCE typecheck, lint, formatting, workspace isolation, unchanged OpenAPI,
CI selection, documentation links/spec metadata/length, and both flow validators.
The native scope-policy module matches the pinned archive byte-for-byte, and the
remaining 10 patch checksums match the build recipe. These are source and
packaging checks, not real-model proof. Final-head CI and image qualification
are recorded in PR #6502.

Local real-runtime preparation previously built the candidate images, then failed
the stock Codex sandbox probe with
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`.
No model-recovery case ran. Sandbox enforcement was not relaxed; owned cluster,
PostgreSQL and image-tag resources were cleaned up. Removing the scope-policy
patch does not change that sandbox. Real-model proof remains blocked until the
reviewed probe passes on a supported host. This is not an integration-test waiver.

Independent implementation review previously failed to initialize in its isolated
Codex process because of a read-only filesystem. It remains unverified. New image
qualification must use the updated head; older runs cannot establish the revised
scope policy. No PR merge, image publication or production deployment is authorized.
Issue #6500 remains separate.

Main `d2710fed4` was incorporated with a normal merge, preserving published
history and its improved readiness-wait message. Keep that integration unchanged.
Other open RFCs propose 0043; recheck the number against main before merge.
Current behavior belongs to [interrupted turns](../../docs/reference/agents/interrupted-turns.md),
[deployment](../../docs/reference/agents/deployment.md), and the
[recovery flow](../../docs/flows/harness-restart-recovery.md).

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-18: Apply the explicit user decision to leave upstream restart-scope policy unchanged, delete the inverse patch, and accept old-scope transition refusal. Earlier patch-specific native proof is superseded. (`3f273a16a`)

- 2026-11-18: Materialized the authorized TASK-0053 plan and complete interface inventory against `c51d6138ef7abbb637848e7f81b206ce6195d4eb`; linked successor RFC-0043. The original plan was prepared against `f682e612c26c6384fab2e0ec5f66074dd560fcc9`.
