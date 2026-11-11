---
status: Proposed
implementation_status: Not implemented
author: russellb
---

# Proposal: Raise network policy capacity to 16,384 rules

- **ID:** RFC-0037
- **Created:** 2026-11-11
- **Last updated:** 2026-11-11
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
startup, configuration discovery, policy preview and save, and API responses
must agree on this count. Keep 16 port ranges per rule, existing field lengths,
and the provider's own constraints. The ceiling continues to delegate approval;
it grants no network access by itself.

Give policy preview and update requests a separate finite body budget large
enough for 16,384 ordinary rules. Preserve explicit operator overrides and the
ordinary request limit for unrelated routes. Byte limits remain independent of
entry limits; arbitrary JSON whitespace or escaping does not receive unlimited
space. Recommendation batches remain limited to 32 suggestions.

The count change does not alter policy ownership, persistence, version checks,
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
- The regular HTTP preview and save paths accept a policy beyond the former
  64 KiB request limit and preserve every submitted rule.
- Invalid grants and grants outside the Installation ceiling remain refused.
- Generated API schemas and the supported reference describe the new maximum.
- Large requests retain a finite byte limit; unrelated routes retain theirs.

## Delivery and verification

Submit this proposal for review before implementation, then include source,
focused admission tests, generated API changes, and documentation in the same PR.
Run the applicable repository checks. In-memory or PostgreSQL admission tests
establish the boundaries they exercise; they do not establish live OpenShell
network enforcement at maximum capacity.
