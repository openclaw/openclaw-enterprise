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
domains, persisted recovery metadata, and runtime scope projection. Use the pinned
OpenClaw restart-scope policy unchanged. Do not add a behavior patch, recovery
token, compatibility shim, or controller loop.

## Motivation

OCE currently allocates a recovery generation during deployment, compares a
Compute compatibility domain, and projects that generation into native recovery.
Stop clears the generation. This duplicates recovery policy across admission,
persistence, workers, and Compute implementations. Native
OpenClaw already owns interruption detection and continuation admission.

## Proposal

Remove `ComputeDriver.restartContinuationDomain`, `RestartContinuation`, and
`AgentRevision.restartContinuation`. Remove the repository methods, Agent columns,
and admitted JSON that store their values. An appended migration removes the
stored data and restores revision immutability in the same transaction.

Remove `OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE` from Kubernetes, Docker, and SSH
launches. Keep pinned OpenClaw's optional scope fields and checks unchanged.
New work created without a scope uses normal native restart recovery, subject to
session identity, current authority, explicit cancellation, retained-state
validity, and Harness support.

A previously recorded nonempty scope does not match an unset startup scope.
Upstream can refuse that unfinished work on the transition, including queued
input and child-completion recovery where applicable. The user accepts this
limit. OCE does not translate native records or patch the scope comparison.
The earlier requirement to continue old-scoped work is superseded.

Keep the Harness-readiness and reconnect bridge from
[PR #6435](https://github.com/openclaw/openclaw-enterprise/pull/6435), including
main's improved expired-wait message. Keep the source pin and unrelated patches.

The existing deploy and stop endpoints, payloads, IAM actions, resource scopes,
and audit attribution stay unchanged. Workers still enforce current desired
state, selected revision, operation lease, and predecessor ownership. Independent
runtime selection and planned-replacement compatibility remain in Compute.

Stop requests workload shutdown. For work created without a scope, it no longer
prevents eligible pre-Stop work from continuing at a later Gateway startup. Deploy currently starts a stopped
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

- OCE recovery-specific interfaces and scope projections are removed. Upstream
  native scope fields and policy remain unchanged, with no OCE policy patch.
- Fresh and populated PostgreSQL databases converge without recovery columns or
  admitted JSON. Revision immutability and limited application grants still hold.
- Supported Agent API workflows continue eligible native work after ordinary
  redeployment and a harmless configuration change for work created without a
  scope, without a new user message. Continuation of old-scoped work is not an
  acceptance criterion; native transition refusal is accepted.
- Explicit cancellation, completed work, revoked native ownership, and active
  remote turn handling remain covered by real runtime checks.
- Stop during deployment, overlapping revisions, and stale lease/revision
  ownership remain covered by real PostgreSQL worker tests.
- Native image checks cover both images on AMD64 and ARM64. Missing runtime,
  credentials, or infrastructure remains an explicit proof gap.

## Current decision

The pin `f8727fdcd3a1f6152b9fdc110f3004a8e58f25e9` already includes upstream's
optional restart-scope machinery. The user explicitly chose to leave that policy
unchanged and remove the inverse patch. This supersedes the earlier proposal to
remove native scope fields and guarantee continuity from previously scoped work.
Only OCE bookkeeping and projection are removed.

## Delivery

This RFC was submitted in PR #6502 before Driver implementation. The user
explicitly approved the revised upstream-unchanged scope. Implement [TASK-0053](../plans/0053-native-restart-recovery.md) while review proceeds
unless a specific hold applies. Preserve RFC-0042 and its completed evidence as
historical records. The implementation updates current references and flows.

## Manual Notes

[keep this for the user to add notes. do not change between edits]
