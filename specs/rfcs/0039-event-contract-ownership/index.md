---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Shared event contract and ownership

- **ID:** RFC-0039
- **Created:** 2026-11-06
- **Last updated:** 2026-11-12
- **RFC PR:** [#4974](https://github.com/openclaw/openclaw-enterprise/pull/4974)
- **Related:** [Platform audit](../0013-platform-audit/index.md), [production observability](../0012-production-observability.md), [platform design](../../../docs/design.md#implementation-status).

## Summary

Extend OpenClaw Enterprise's (OCE) existing `AuditEvent` to record required
control-plane and Agent activity. Keep diagnostic logs separate, persist event
metadata through State in PostgreSQL, and reference optional protected content.
This is **M0: event contract and ownership**. It proposes four decisions; it does
not implement collection, grant access or introduce infrastructure.

## Motivation

An operator needs to follow an API request or channel message through an Agent
turn, tool call, policy decision and result. Today, the
[OpenClaw Control Plane (OCC) audit ledger](../../../docs/flows/audit-ledger.md)
records selected administrative facts. The
[Collector](../../../deploy/logging/collector.yaml) exports selected diagnostics
and excludes conversation content. Neither supplies complete execution history.

Use the existing audit foundation instead of introducing another universal event
model. This retains the useful separation between operational diagnostics,
activity evidence and content found in Google audit/tracing and ChatGPT
compliance APIs, without copying their infrastructure or schemas.

## Proposal

### 1. Separate logs from required events

Diagnostic logs explain component behavior. Their level, sampling and external
backend remain configurable. Required events record facts durably and cannot be
disabled by log level or sampled away. Keep the Collector's content filters.

The event's registered `kind` and `action` determine its schema, producer,
required fields and access policy. Producers cannot choose whether a required
record counts as audit evidence. `packages/contracts` owns these definitions;
`packages/audit` owns construction and sanitization. No catalog service is needed.

### 2. Extend the current event contract

Preserve the names and meanings in
[`AuditEvent`](../../../packages/contracts/src/index.ts): `id`, `occurredAt`,
scope, actor, `kind`, `action`, `resource` and `outcome`. Extend its trusted source
identity, add optional typed execution context and content references, and give
`details` an action-specific schema. [Appendix A](event-fields.md) defines the
fields and explains what stays outside the common record.

Use action names to distinguish lifecycle observations. A successful
`turn.started` means the turn started, not that it completed. Add outcome or kind
values only where required by an implemented event family; define their meaning
before enabling its producer. Missing completion is unknown, never success.

| Required facts                                                                                       | Authoritative producer                                      | First delivery       |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------- |
| API admission and result, including reads, invalid requests and denials; resource and worker changes | OCC request/operation owner and State                       | M1                   |
| Sessions, turns and model calls                                                                      | Selected Harness at actual execution                        | M2                   |
| Tool attempts and results; policy decisions and approvals                                            | Actual executor; actual enforcement owner                   | M3                   |
| Channel receive/send, acknowledgement, failure, edit and delete                                      | Runtime channel integration                                 | M4                   |
| Evidence access/export and capture-policy changes                                                    | Authorized query/export/configuration owner                 | With that capability |
| Imported records and collection failures                                                             | Provider assertion; adapter for its own collection activity | M6                   |

Each fact has one authoritative record. Link existing repository and egress
receipts rather than creating a competing account of their effects. Correlation
identifies related observations; it does not confer authority. Only an enforcer
can assert its policy result.

### 3. Reuse State and PostgreSQL

State owns durable metadata and transactional append. OCC composes the producers
and authorized readers. Use the existing PostgreSQL deployment initially; select
tables, indexes and capacity limits in delivery plans. M0 adds no broker, storage
product or Driver method.

Preserve these requirements:

- Commit OCC state changes and required evidence in the same transaction.
- Require authenticated, execution-bound runtime producers. Establish scope at
  ingestion; payload fields and Pod labels are not authentication.
- Persist required admission evidence before executing an action. Stop admitting
  such actions when durable recording is unavailable. Continue denying
  unauthorized access and report the audit outage independently.
- Preserve an event's identity across delivery retries. Identical duplicates are
  harmless; conflicting reuse of an identity is rejected. Append later outcomes
  and corrections rather than rewriting recorded facts.
- Record intent before external effects. A timeout or uncertain commit cannot
  prove success or justify automatic repetition of the effect.
- Declare observation boundaries and expose missing evidence. Define limits and
  recovery before enablement; “every request” does not include traffic the
  instrumented listener never observes.

External log/export outages must not stop locally durable recording while its
capacity remains available. State and export owners must settle retention versus
pending delivery in M5; this is not an unlimited-backlog guarantee.

### 4. Protect content separately

Prompts, responses, tool payloads and channel content are optional protected
content, referenced from events. Capture defaults off. Installation policy
controls permitted Namespace overrides; record the effective policy. Credentials
remain excluded, including from free-text metadata.

IAM owns exact-resource metadata, content and export permissions. Administrative
or ordinary Agent access does not implicitly grant conversation access. Audit
authorized disclosure before releasing evidence. This RFC does not broaden
RFC-0013's administrative view or supersede its History/access restrictions.

Every storing milestone must define basic retention, capacity, deletion and
access rules before enablement. State owns enforcement; content storage and
cross-store lifecycle decisions belong to M4. Operational export, archive and
restore behavior belong to M5. Restoring data must not silently restore access to
deleted or expired content.

## External API sources

Imported records, including OpenAI Compliance records, retain their provider
scope and native identity. They remain provider assertions, not proof that an
OCE action ran. A fetched snapshot is not an invented historical transition.
Map provider actors and conversations to OCE only through verified mappings;
retain unmatched records under separately authorized source scope.

Collection mechanics belong to M5/M6: credentials, API entitlements, pagination,
checkpoints, replay, late arrivals, deduplication and schema mappings. Collectors
must distinguish their own failures from imported activity. Provider-specific
fields do not become requirements for every OCC or runtime event.

## Delivery and verification

M0 is complete when reviewers accept these four decisions and producer
assignments. The separate delivery plan must resolve each producer's exact
schema, permissions, retention, limits and failure proof before enablement.
Acceptance of M0 is not a claim that comprehensive audit exists.

| Milestone | Remaining delivery and proof                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| M1        | Complete covered API/worker audit and authorized retrieval; real PostgreSQL commit, denial, abort and failed-append cases.  |
| M2        | Authenticated OpenClaw and Codex activity; real turns, retries, cancellation, restart and duplicate delivery.               |
| M3        | Tool/enforcement evidence; allowed, denied, failed and uncertain effects with receipt correlation.                          |
| M4        | Integration coverage and content storage; capture on/off, separate permissions and content lifecycle.                       |
| M5        | Export and collection framework; outage recovery, retention, deletion, archive/restore and gap reporting.                   |
| M6        | Provider adapters; authorized API collection, late records, interrupted pagination, revocation and verified reconciliation. |

Use the regular Agent workflow for proof: message → turn → policy decision →
tool execution → result → reply. Missing runtime, provider or infrastructure
proof remains an explicit gap. This document changes no runtime behavior.

## Rationale and alternatives

Extending the existing contract reuses its producers, ownership and persistence.
A new universal envelope would add translations before there is a second working
pipeline. Raw Collector export cannot replace transactional evidence or trusted
attribution. Keep specialized fields with the event families that need them and
choose additional infrastructure only after measuring the delivered workload.
