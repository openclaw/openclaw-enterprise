---
status: In progress
rfc: ../rfcs/0042-redeployment-continuation.md
---

# Continue sessions across compatible Agent redeployments

- **ID:** RFC-0042 implementation plan
- **Created:** 2026-11-17
- **Decision:** [RFC-0042](../rfcs/0042-redeployment-continuation.md)

## Outcome and boundary

Deliver RFC-0042 through ordinary Agent deployment, stop, worker reconciliation,
and native OpenClaw recovery. Kubernetes dedicated Codex is the first qualified
topology. Preserve explicit stop, current authority, retained-state ownership,
and the refusal to take over active remote execution.

The RFC was submitted for human review before implementation and merged in [PR #6434](https://github.com/openclaw/openclaw-enterprise/pull/6434). [Implementation PR #6442](https://github.com/openclaw/openclaw-enterprise/pull/6442) contains the lifecycle and native recovery changes. Final live qualification, native image checks, and publication remain pending. The RFC decision status remains Proposed.

## Delivery

### 1. Submit the contract

- [x] Submit RFC-0042 for human review in PR #6434.
- [x] Link the implementation PR #6442.
- [ ] Resolve any specific architectural or security hold before dependent work.

### 2. Persist lifecycle ownership

- [x] Extend the Agent lifecycle repository and PostgreSQL constraints with the
      server-owned generation/domain pair and immutable revision snapshot.
- [x] Extend the Compute contract with side-effect-free domain admission.
- [x] Update `admitAgentDeployment` in `packages/occ/src/index.ts` to retain or
      allocate generations under the existing Agent lock.
- [x] End the generation in explicit stop/delete transactions. Fence stale
      preparation and activation in the regular worker path.
- [x] Exercise AC-3 through PostgreSQL transactions and actual worker callers,
      including consecutive deployments after stop before activation.

### 3. Integrate the native runtime

- [x] Project the admitted snapshot through Kubernetes Compute; preserve
      unsupported topology refusal and existing stop/start ownership.
- [x] Extend native run ownership persistence and startup recovery so graceful
      markers and crash recovery require the same generation. Reject missing
      generation evidence in managed deployments.
- [x] Preserve same-occurrence workspace reconnect, current authority checks,
      cancellation, and passive waiting for a surviving Codex turn.
- [x] Register meaningful native regression tests in the image build, including
      forced-loss recovery after an ended generation.

### 4. Qualify the complete workflow

- [x] Extend the existing dedicated Agent integration case for AC-1, AC-2, AC-4,
      and AC-5 with real runtime images and models; no second recovery sender.
- [x] Keep the native-child relay proof aligned with observed protocol history.
      Prove the child performed the command and the Gateway delivered its answer.
- [x] Update the interrupted-turn reference, Compute contract, persistence
      inventory, lifecycle flow, and operator procedures together.
- [ ] Run proportional source checks, independent review, and native controller
      and runtime checks on AMD64 and ARM64 at the final branch head.

### 5. Publish

- [ ] Resolve substantive review findings and merge the RFC and implementation
      in dependency order.
- [ ] Wait for successful CI on the selected main source, then run the authorized
      image publication workflow. Verify both remote digests against its receipt.
- [ ] Record source, image identities, qualification evidence, and remaining
      limits. Passing branch checks does not mean published or deployed.

## Verification status

Source audit at `6ce8147ce28e2636304e215bd20b11e55d3fb586` confirms the lifecycle,
Compute, worker, and native recovery implementation. The
[interrupted-turn reference](../../docs/reference/agents/interrupted-turns.md)
owns current behavior and the [recovery test guide](../../docs/testing/harness-restart-recovery.md)
owns the live proof and its limits.

Native generation filtering and private-state preservation: 14 selected cases
pass. All 43 PostgreSQL replacement cases pass, including generation and
stale-worker races (AC-3). All 236 PostgreSQL migration cases pass, including
populated historical upgrades and dump/restore. Native core, configuration, and
Gateway type checks pass. [Required CI at the audited commit](https://github.com/openclaw/openclaw-enterprise/actions/runs/44253949158)
passes. Independent review found no P0 issues in its selected scope; it did not
review lower priorities.

AC-1, AC-2, AC-4, and AC-5 full real-runtime qualification remains in progress.
Partial runs proved compatible redeployment and native restart recovery. The
native-profile refusal fixture must observe refusal before restoring the shared
OCC service profile; this is not per-user OCC identity propagation. Provider
startup failures remain failed runs. The implementation PR records final-head
proof and publication evidence. Missing prerequisites or partial passes do not
complete an acceptance criterion.

## Manual Notes
