---
status: Proposed
implementation_status: Partially implemented
author: kevinlin-openai
---

# Proposal: Use native restart recovery without OCE bookkeeping

- **ID:** RFC-0043
- **Created:** 2026-11-18
- **RFC and implementation PR:** [#6502](https://github.com/openclaw/openclaw-enterprise/pull/6502)
- **Implementation plan:** [TASK-0053](../plans/0053-native-restart-recovery.md)
- **Predecessor:** [RFC-0042](0042-redeployment-continuation.md), delivered by [PR #6442](https://github.com/openclaw/openclaw-enterprise/pull/6442).

## Summary

Let native OpenClaw detect and continue eligible interrupted work whenever a
Gateway starts with retained state. Remove OCE recovery generations, compatibility
domains, persisted recovery metadata, runtime scope configuration, and the native
scope patch. Do not replace them with another recovery token or controller loop.

## Motivation

OCE currently allocates a recovery generation during deployment, compares a
Compute compatibility domain, and projects that generation into native recovery.
Stop clears the generation. This duplicates recovery policy across admission,
persistence, workers, Compute implementations, and a native patch. Native
OpenClaw already owns interruption detection and continuation admission.

## Proposal

Remove `ComputeDriver.restartContinuationDomain`, `RestartContinuation`, and
`AgentRevision.restartContinuation`. Remove the repository methods, Agent columns,
and admitted JSON that store their values. An appended migration removes the
stored data and restores revision immutability in the same transaction.

Remove `OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE` from Kubernetes, Docker, and SSH
launches. Remove the former patch's session scope fields and checks from pinned native
source, using the current-base adaptation below. Keep native session identity, current
authority, explicit turn cancellation, and retained-state validity checks.
Keep the Harness-readiness and reconnect bridge from
[PR #6435](https://github.com/openclaw/openclaw-enterprise/pull/6435).

The existing deploy and stop endpoints, payloads, IAM actions, resource scopes,
and audit attribution stay unchanged. Workers still enforce current desired
state, selected revision, operation lease, and predecessor ownership. Independent
runtime selection and planned-replacement compatibility remain in Compute.

Stop requests workload shutdown. It no longer prevents eligible pre-Stop work
from continuing at a later Gateway startup. Deploy currently starts a stopped
Agent; that deployment may resume interrupted work. Preserving stopped state
across deployment is separately tracked by
[issue #6500](https://github.com/openclaw/openclaw-enterprise/issues/6500).
Explicit native `chat.abort` remains a cancellation boundary.

A harmless configuration change no longer causes an OCE compatibility refusal.
A different Harness must still support the retained state. Continuation is a new
input in the retained conversation, not restoration of a process or HTTP
connection. Exclusive replacement remains stop-first, with downtime, no automatic
rollback, and no exactly-once guarantee.

## Alternatives and non-goals

Keeping shared generations preserves the former Stop boundary but retains the
bookkeeping the user requested to remove. Revision scopes have the same policy
problem and prevent continuity across deployment. A replacement epoch, permanent
Agent token, startup scanner, or `chat.send` loop is outside this proposal.
This change does not implement issue #6500 or change production deployment policy.

## Acceptance Criteria

- All recovery-specific interfaces from PR #6442 are removed, including private
  native scope fields, launch projections, and packaging metadata.
- Fresh and populated PostgreSQL databases converge without recovery columns or
  admitted JSON. Revision immutability and limited application grants still hold.
- Supported Agent API workflows continue eligible native work after ordinary
  redeployment and a harmless configuration change, including retained records
  written by the scoped runtime, without a new user message.
- Explicit cancellation, completed work, revoked native ownership, and active
  remote turn handling remain covered by real runtime checks.
- Stop during deployment, overlapping revisions, and stale lease/revision
  ownership remain covered by real PostgreSQL worker tests.
- Native image checks cover both images on AMD64 and ARM64. Missing runtime,
  credentials, or infrastructure remains an explicit proof gap.

## Current-base adaptation

The current pin includes the former scope patch upstream. Removing it requires
an inverse source patch while retaining that pin and its unrelated updates.
This removes the same scope fields and checks; it adds no recovery metadata.

## Delivery

Submit this decision for human review before changing the Driver contract, then
implement [TASK-0053](../plans/0053-native-restart-recovery.md) while review proceeds
unless a specific hold applies. Preserve RFC-0042 and its completed evidence as
historical records. The implementation updates current references and flows.

## Manual Notes

[keep this for the user to add notes. do not change between edits]
