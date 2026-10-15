---
rfc: index.md
---

# Repository credentials: restart qualification and follow-up

[Repository credentials RFC](index.md)

This companion to the [qualification contract](qualification.md#recovery-and-acceptance-record) records the current ephemeral service's limits and the work needed for stronger recovery. It proposes acceptance criteria, not acceptance of the implementation or authorization to build the successors.

## Current boundary and tradeoffs

The worker persists admission/session correlation and the original deadline; the credential process owns live sessions and provider custody. Worker replacement can retain access when that process and delivered material survive. Credential-service replacement instead loses its inventory: old gateway sessions are absent, fresh authorized admission stays within the original deadline, and a new material generation replaces the Agent Pod. See the [Agent recovery flow](../../../docs/flows/agent-repository-credentials.md).

Selecting this narrow model means accepting interruption of Agent work, lost provider cleanup inventory, and outstanding provider credentials that may survive until expiry. Per-process capacity limits do not bound all still-valid credentials across repeated crashes. Session invalidation proves neither provider revocation nor disposal. Uncertain upstream effects remain unknown; recovery must not automatically replay the original write. Explicitly record these tradeoffs and which durable-recovery requirements are deferred before declaring scope accepted.

## Validation required before claiming crash qualification

The inspected source at `06d441b7` has two distinct proofs: the [abrupt-restart case](../../../tests/integration/repository-credentials-restart.test.mjs) opens a session without acquiring a GitHub token; the [platform case](../../../tests/integration/repository-credentials-platform.test.mjs) uses a helper that drains credentials before replacing the service. Neither establishes recovery after abrupt loss of an outstanding GitHub credential.

**RV-1 — Core and platform qualification owners:** exercise the production GitHub adapter, service/control listeners, worker and material delivery across abrupt service loss after issuance, during uncertain issuance and during a possibly accepted write. Verify old gateway authentication fails; replacement preserves owner, repository, grant and original deadline; material replacement and interrupted work are observable; and the original write is not replayed. Distinguish provider expiry or uncertain cleanup from confirmed revocation. Keep lost-control-response recovery while the service survives as a separate case. Require source-bound results before closing this evidence gap; controlled-provider, installed and live-GitHub receipts remain distinct.

## Follow-up work and completion criteria

**RR-1 — Credential custody and State owners: restart-safe accounting.** Extend existing protected storage and lifecycle ownership to retain original issuance intent, captured credential references, expiry bounds and unresolved outcomes across restart. Fence predecessor owners and reconcile before new issuance. Keep credential values outside Agents and public status; do not introduce a parallel broker. Close only after repeated-crash evidence preserves aggregate outstanding obligations, resumes supported cleanup and blocks unsafe remint/replay. A lost issuance response can still leave an unknown outcome: persistence alone cannot guarantee token recovery, immediate revocation or exactly-once provider effects.

**RC-1 — Worker, Compute and Harness owners: runtime continuity.** Select a safe material-refresh or explicit resume mechanism so recovery need not silently discard ongoing work. Preserve workspace ownership and observe predecessor termination before admitting a replacement writer. Close only after ordinary-Agent model/tool and real-Git evidence demonstrates the selected resume behavior without stale credentials, concurrent writers or replay of uncertain effects. Seamless continuation is not promised by the current Pod-replacement path.

Keep these successors separate from current validation. Record owner, selected scope, exact source, passing evidence and residual limitations for each closure; documentation and green aggregate CI alone close none of them. Update the existing reference, operator recovery guide and flows when behavior changes.
