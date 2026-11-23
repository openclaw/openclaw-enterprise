---
status: Proposed
implementation_status: Implemented
author: kevinlin-openai
---

# Proposal: Continue interrupted sessions across compatible redeployments

- **ID:** RFC-0042
- **Created:** 2026-11-17
- **Last updated:** 2026-11-17
- **Implementation plan:** [RFC-0042 delivery](../plans/0042-redeployment-continuation.md)
- **Related:** [Interrupted turns](../../docs/reference/agents/interrupted-turns.md), [PR #6407](https://github.com/openclaw/openclaw-enterprise/pull/6407), [bounded planned replacement](0036-bounded-planned-replacement.md)

## Summary

Automatically continue eligible interrupted sessions after a compatible Agent
redeployment, without reviving work after an explicit stop. Replace revision ID
as the continuation boundary with a server-owned recovery generation that can
span compatible revisions. Keep OpenClaw's existing interruption detector and
continuation admission; do not add an OCC scanner or `chat.send` loop.

This changes the Compute Driver contract and the behavior introduced by PR #6407.
It is a proposal, not current supported behavior.

## Motivation

The [current contract](../../docs/reference/agents/interrupted-turns.md) deliberately
ends interrupted work at every deployment. That prevents a stopped task from
running again, but also prevents an unattended Agent from continuing after an
ordinary redeployment. Retained conversation and workspace state alone do not
complete the task.

The lifecycle must distinguish an operator who replaces a running Agent from an
operator who stops it. A deployment can also change policy, credentials, Harness,
or storage, so neither the Agent ID nor a previous revision ID alone establishes
that continuation is allowed.

## Goals

- Continue eligible root work across compatible redeployments through the normal
  Agent deployment API and native recovery path.
- Keep explicitly stopped, cancelled, completed, and deleted work stopped.
- Revalidate current session authority and execution policy before continuing.
- Make retries and concurrent stop/deploy operations preserve the same decision.

## Non-goals

Restoring an OS process, tool handle, or execution stack; exactly-once external
effects; forced takeover of a live executor; recovering a hung executor; removing
exclusive replacement downtime; or adding rollback. Planned completion waiting
under RFC-0036 remains complementary. This proposal does not automatically resume
an explicitly paused Goal.

## Proposal

### State and ownership

The Agent lifecycle owns an optional recovery generation and compatibility domain
in PostgreSQL. Both are server-owned, not deployment request parameters. Store
them atomically, with a database constraint requiring both or neither. An immutable
AgentRevision snapshots both values for supported continuation. Generation values
are opaque identifiers, not bearer credentials or a substitute for authorization.

Deployment admission computes the domain through the selected Compute Driver
after resolving the candidate Harness and storage settings. Add this optional,
side-effect-free contract:

```ts
restartContinuationDomain?(revision: Readonly<AgentRevision>): string | undefined;
```

A returned domain certifies that the Driver can preserve the session store,
enforce the supplied generation, and prevent overlapping writers for that
execution configuration. It identifies the exact Installation, Namespace, Agent,
retained storage, and compatible Harness execution environment. Equal strings
mean continuity is supported; endpoint equality alone is insufficient. The Driver
must return no domain for unsupported topologies or incompatible state formats.
The platform compares domains without knowing provider-specific identifiers.

The first implementation qualifies Kubernetes dedicated Codex. Other Drivers and
Harnesses keep their existing revision boundary until their implementation and
real-runtime evidence satisfy this contract. No domain means no cross-revision
continuation; it must not silently select a broader Agent-wide scope.

### Lifecycle decisions

Perform each decision under the existing Agent lock in the same transaction that
admits a revision or changes desired runtime state:

| Operation                                               | Recovery generation                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| First deployment or deployment after an explicit stop   | Allocate a new generation for a supported domain.                           |
| Redeploy a running Agent into the same supported domain | Retain its current generation and snapshot it into the new revision.        |
| Change domain or select unsupported continuation        | End the old generation; allocate a new one only for a supported new domain. |
| Explicit stop or deletion                               | End the generation before recording lifecycle work.                         |
| Retry reconciliation of an admitted revision            | Use its immutable snapshot; do not allocate another generation.             |

The mutable Agent record is necessary: deriving continuity from `activeRevisionId`
can resurrect an old generation when stop is followed by multiple deployments
before the first replacement becomes active. Worker preparation and activation
must reject a candidate whose generation is no longer current, in addition to
existing revision and desired-state checks. A stop that commits after deployment
admission invalidates that deployment's continuation permission.

### Runtime admission and authority

The Compute Driver projects the admitted generation into
`OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE`. It must not reconstruct the value from a
revision ID, endpoint, or current mutable configuration. Exclusive replacement and
retained-volume ownership remain unchanged.

Extend native recovery scoping to both graceful shutdown markers and persisted
run ownership used for crash recovery. The current bridge scopes only graceful
markers. A managed Gateway must refuse old, missing, or mismatched generation
evidence before continuation or replay of queued input. Otherwise a forced stop
could evade the generation boundary. Ordinary same-generation process recovery
continues to use recorded Gateway lifetimes and exact session/run identity.

The generation establishes lifecycle continuity only. Native admission must still
check the original session target, current session-owner authority, cancellation,
and the replacement's policy. Credential changes do not transfer the previous
caller's authority. Revoked permission or incompatible state produces a visible
refusal; no fresh thread, second sender, or broader credential fallback is allowed.

When a remote Codex turn survives a Gateway restart, recovery may wait for it to
finish before normal adoption. It must not interrupt or concurrently adopt that
turn. The continuation inspects saved work before repeating an uncertain effect.

### Failure and recovery

A failed candidate does not restart its predecessor or roll back filesystem
writes. Another compatible deployment may retain the still-current generation,
but can continue only work that native retained evidence still marks eligible.
An explicit stop ends that permission even if workload teardown fails. The next
deployment cannot recover the ended generation through either markers or crash
history. Existing lock-owner refusals remain binding.

## Acceptance Criteria

All runtime criteria require an authorized operator using the supported Agent
API, PostgreSQL, an isolated enforcing Kubernetes cluster, digest-pinned native
images, and authorized model credentials.

- **AC-1 — Redeployment:** While a dedicated Codex task has made a retained
  workspace effect and is still active, deploy a compatible replacement through
  the Agent API. Observe new Gateway and Harness identities, the same session,
  one native continuation and final result, and no repeated effect. Send no
  additional input to that session.
- **AC-2 — Explicit stop:** Stop active work, then deploy one or more revisions.
  Prove a fresh turn works while the stopped session and queued input remain
  stopped. Include teardown failure or forced process loss so crash recovery
  cannot bypass the generation boundary.
- **AC-3 — Lifecycle races:** Exercise stop/deploy and overlapping deploy
  transactions with PostgreSQL and the real worker. A stale generation must not
  prepare or activate, including before a newer candidate becomes active.
- **AC-4 — Authority and compatibility:** Revoke the session owner's access before
  continuation and verify refusal. Change the compatibility domain and verify
  that prior work does not resume. Unsupported Drivers must not claim support.
- **AC-5 — Existing recovery:** Qualify Gateway-only and both-Pod replacement
  within one generation, finite surviving Codex work, and completed/cancelled
  negative controls. Preserve the active-thread ownership refusal.

## Delivery and verification

The [implementation plan](../plans/0042-redeployment-continuation.md) owns delivery
steps and evidence. Submit this contract for human review before implementation.
Code and RFC review may then proceed together under the contribution policy.
No acceptance criterion is complete from source inspection or the RFC alone.

## Rationale and alternatives

Keeping revision scoping is safe for explicit stops but fails the unattended
redeployment requirement. A permanent Agent-wide scope would resume intentionally
stopped work. Clearing markers through a best-effort pre-stop RPC cannot enforce
the boundary when the Gateway is unavailable or termination is forced.

A durable generation separates stop intent from replacement identity while
retaining native detection, current authorization, and existing Driver ownership.
It adds lifecycle state and native crash scoping; those costs are required before
claiming continuation across redeployments.
