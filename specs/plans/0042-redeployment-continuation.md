---
status: Draft
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

The RFC is Proposed. No cross-revision implementation has started. The current
revision-scope contract remains authoritative until this change ships.

## Delivery

### 1. Submit the contract

- [ ] Submit RFC-0042 for human review and link the implementation PR.
- [ ] Resolve any specific architectural or security hold before dependent work.

### 2. Persist lifecycle ownership

- [ ] Extend the Agent lifecycle repository and PostgreSQL constraints with the
      server-owned generation/domain pair and immutable revision snapshot.
- [ ] Extend the Compute contract with side-effect-free domain admission.
- [ ] Update `admitAgentDeployment` in `packages/occ/src/index.ts` to retain or
      allocate generations under the existing Agent lock.
- [ ] End the generation in explicit stop/delete transactions. Fence stale
      preparation and activation in the regular worker path.
- [ ] Exercise AC-3 through PostgreSQL transactions and actual worker callers,
      including consecutive deployments after stop before activation.

### 3. Integrate the native runtime

- [ ] Project the admitted snapshot through Kubernetes Compute; preserve
      unsupported topology refusal and existing stop/start ownership.
- [ ] Extend native run ownership persistence and startup recovery so graceful
      markers and crash recovery require the same generation. Reject missing
      generation evidence in managed deployments.
- [ ] Preserve same-occurrence workspace reconnect, current authority checks,
      cancellation, and passive waiting for a surviving Codex turn.
- [ ] Register meaningful native regression tests in the image build, including
      forced-loss recovery after an ended generation.

### 4. Qualify the complete workflow

- [ ] Extend the existing dedicated Agent integration case for AC-1, AC-2, AC-4,
      and AC-5 with real runtime images and models; no second recovery sender.
- [ ] Keep the native-child relay proof aligned with observed protocol history.
      Prove the child performed the command and the Gateway delivered its answer.
- [ ] Update the interrupted-turn reference, Compute contract, persistence
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

RFC-only: no AC-1 through AC-5 proof is claimed. Earlier qualification of native
restart readiness predates this proposed lifecycle contract and cannot establish
cross-generation refusal. Missing cluster or credential prerequisites must leave
the affected acceptance criteria unverified; do not replace them with mocks.

## Manual Notes
