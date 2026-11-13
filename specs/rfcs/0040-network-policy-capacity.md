---
status: Proposed
implementation_status: Implemented
author: russellb
---

# Proposal: Raise network policy capacity to 16,384 rules

- **ID:** RFC-0040
- **Created:** 2026-11-11
- **Last updated:** 2026-11-11
- **RFC PR:** https://github.com/openclaw/openclaw-enterprise/pull/5497
- **Related:** [Sandbox policies](../../docs/reference/sandbox-policies.md)

## Summary

Raise the shared network grant limit from 32 to 16,384 entries for both an
Installation delegation ceiling and an Agent's network policy additions. Retain
a finite limit and the existing authorization, grant validation, and Driver
admission requirements.

## Motivation

Each rule names one executable, hostname, and set of port ranges. An Installation
must delegate destinations needed across multiple Agents and executable versions.
A 32-entry ceiling can fill during ordinary use and force operators to remove
useful exact rules or consider broader wildcards. The same restriction also
limits individual Agents.

## Proposal

Use 16,384 as the shared maximum in the network grant schema. Installation
startup, configuration discovery, policy preview, save and apply, and API responses
must agree on this count. Keep 16 port ranges per rule, existing field lengths,
and the provider's own constraints. The ceiling continues to delegate approval;
it grants no network access by itself.

Give policy preview, update and apply requests a separate finite body budget large
enough for 16,384 ordinary rules. Preserve explicit operator overrides and the
ordinary request limit for unrelated routes. Byte limits remain independent of
entry limits; arbitrary JSON whitespace or escaping does not receive unlimited
space. Policy preview, save and apply share a replica-local per-principal token bucket:
2 requests per second with a burst of 10 across Agents. Exhaustion returns 429
and Retry-After before reading the body. Recommendation batches remain limited
to 32 suggestions. The shared high-body write hook also budgets verified
external identities before IAM lookup (5 requests per second, burst 60), including
Preset and Configuration writes. Its 429 response also carries Retry-After.

Compile the trusted ceiling into an executable/hostname index and combine
adjacent port ranges. Admission must preserve exact executable matching,
single-label wildcards, and union coverage across matching rules. A full-size
Agent policy against a full-size ceiling must complete through regular HTTP
admission without the previous repeated full-ceiling scans.

The count change does not alter policy ownership, persistence format, version checks,
application recovery, protected execution, or authorization. Provider byte and
port limits still apply. No deployed Installation changes merely because this
proposal or its implementation is published.

## Alternatives

Keeping 32 entries requires routine pruning and does not meet the requested
capacity. Removing the count limit permits unbounded input and work. Separate
Installation and Agent limits could be useful later, but both currently need the
same requested capacity and share their validation contract.

## Acceptance Criteria

- Installation startup and Agent policy validation accept 16,384 valid entries
  and reject 16,385.
- The regular HTTP preview, save and apply paths accept a policy beyond the former
  64 KiB request limit and preserve every submitted rule.
- PostgreSQL persists 16,384 additions and atomically rejects 16,385 or invalid grants.
- Invalid grants and grants outside the Installation ceiling remain refused.
- Generated API schemas and the supported reference describe the new maximum.
- Large requests retain a finite byte limit; unrelated routes retain theirs.

## Delivery and verification

Submit this proposal for review before implementation, then include source,
focused admission tests, generated API changes, and documentation in the same PR.
Run the applicable repository checks. Startup and full-size HTTP admission tests
pass locally; installed OpenShell enforcement at this capacity remains unverified. In-memory or PostgreSQL admission tests
establish the boundaries they exercise; they do not establish live OpenShell
network enforcement at maximum capacity.
