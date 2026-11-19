---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Strands Box protected execution

**Human review and manual human merge required.**

- **ID:** RFC-20261118-strands-box
- **Created:** 2026-11-18
- **RFC PR:** [#6505](https://github.com/openclaw/openclaw-enterprise/pull/6505)
- **Implementation plan:** [TASK-0053](../../plans/0053-strands-box-convergence.md)
- **Related:** [RFC-0023: Credential Proxy and credential lifecycle](../0023-egress-proxy-credential-lifecycle/index.md)

## Decision

Qualify Strands Box as an opt-in Sandbox for protected Codex execution. A trusted Box parent
starts the contained child and holds it until Compute verifies the launch and current credential
delivery. An isolated pilot lets processes in one authenticated Agent Sandbox share an admitted
route and credential binding when the operator explicitly selects Agent-wide policy.

## Contracts

- [Held startup and CredentialProxy selection](strands-box-held-launch.md) defines how an
  Installation selects the paired Drivers and how Compute observes, releases, and activates a
  held startup. It also records launch provenance and containment requirements.
- [Agent-wide Box policy](strands-box-agent-policy.md) defines the pilot principal, refusal rules,
  and independent controls for Box Policy and credential use. RFC-0023 defines the applicable
  protection levels.

## Acceptance Criteria

Exercise the [startup and containment checks](strands-box-held-launch.md#acceptance-criteria)
and the [Agent-wide policy checks](strands-box-agent-policy.md#acceptance-criteria) through the
normal Agent deployment. The [implementation plan](../../plans/0053-strands-box-convergence.md)
defines the clean ARM64 Helm journey and provider readback.
