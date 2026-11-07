---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Shared event contract and ownership

- **ID:** RFC-0031
- **Created:** 2026-11-06
- **Last updated:** 2026-11-06
- **RFC PR:** [#4974](https://github.com/openclaw/openclaw-enterprise/pull/4974)
- **Related:** [Platform audit](../0013-platform-audit/index.md), [production observability](../0012-production-observability.md), [platform design](../../../docs/design.md#implementation-status).

## Summary

Adopt a shared event contract for OpenClaw Enterprise (OCE), with explicit
producer ownership, correlation, capture policy and delivery requirements.
Separate diagnostic logs, durable execution events, audit evidence and optional
content. Apply the same provenance rules to external sources such as the OpenAI
Compliance API. This is milestone **M0: event contract and ownership**; it defines
the contract for later implementation without enabling new collection or access.

## Motivation

An operator must be able to follow an API request or channel message through an
Agent turn, tool invocation, policy decision and external outcome. Today,
[OpenClaw Control Plane (OCC) audit](../../../docs/guides/topics/audit-log.md) records selected administrative
facts in PostgreSQL. [Operational logging](../../../docs/guides/observability.md)
exports selected diagnostics through an optional Collector. Neither establishes
a complete execution history.

The current [AuditEvent](../../../packages/contracts/src/index.ts) is scoped to OCC;
the [Collector](../../../deploy/logging/collector.yaml) filters runtime payloads and
replaces bodies with approved text. The [audit repository](../../../docs/flows/audit-ledger.md)
has no public search boundary. Broadening these independently would produce
inconsistent identities, retention and claims about completeness.

Google's [audit categories](https://docs.cloud.google.com/logging/docs/audit) and
separate [Agent tracing controls](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/runtime/tracing)
illustrate distinct metadata and content policies. The
[ChatGPT Compliance Platform](https://help.openai.com/en/articles/9261474-openai-compliance-platform-for-enterprise-and-edu-customers)
distinguishes append-only events from current-state queries and separately
authorizes conversation access. OCE should adopt these separations while owning
its own evidence and delivery guarantees.

## Goals and scope

- Define which component can assert each fact and which component persists it.
- Account for API access, turns, model calls, tools, policy decisions and channel
  activity without making content capture mandatory.
- Preserve uncertainty, external provenance and observable collection gaps.
- Give each later milestone a testable contract and an explicit access boundary.

M0 does not add endpoints, database tables, Driver methods, workloads, collectors,
provider credentials or Console pages. It does not select a new storage product
or weaken the existing Collector filters. It does not supersede RFC-0013's narrow
administrative view, its human access restrictions, or the History decisions it
references. New access and retention contracts must be reviewed in their owning
delivery proposals; an event envelope grants no access.

## Proposal

### Classes and authoritative storage

| Class            | Meaning                                                                       | Storage contract for later delivery                                                                                 |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Diagnostic log   | Explanation of component behavior, potentially sampled or suppressed by level | Existing process output and optional Collector/backend; best-effort.                                                |
| Execution event  | A typed observation of a lifecycle transition or action                       | Durable metadata through State; use PostgreSQL initially, with capacity and retention qualification before rollout. |
| Audit evidence   | An event type whose catalog entry requires attributable, durable evidence     | Preserve the existing audit ledger and transactional guarantees; diagnostic level cannot disable it.                |
| Captured content | Permitted prompt, response, tool payload or channel attachment                | Separate protected content storage referenced by an event; backend and lifecycle are a later decision.              |

Audit is a catalog-defined obligation, not an arbitrary producer flag or a second
copy of every execution event. Each fact has one authoritative record. Existing
repository/egress receipts remain authoritative for their operation; a published
event references that receipt. Search indexes, trace views and exports are
derived projections and cannot establish a stronger outcome than their source.

### Event catalog and owners

The contract owner maintains a versioned catalog. Each event type declares its
schema, producer, observation boundary, required identifiers, assertion strength,
durability, retention class, permitted content and access policy. Unknown types
or incompatible schemas cannot enter the canonical feed as validated events.

The following is the initial family inventory, not a claim of implemented coverage.
“Audit policy” means a separately authorized metadata view; “activity policy”
means a view scoped to the recorded Agent. Content access is always separate.

| Family                                | Producer and boundary                                                      | Destination / access / retention class                               | Required scenario                                                            |
| ------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| API and authentication                | OCC request admission and response lifecycle, including unresolved callers | Durable audit metadata / audit policy / audit                        | Read, write, invalid input, denial, abort and unknown completion.            |
| Resource and credential lifecycle     | OCC operation owner; State transaction where applicable                    | Existing ledger / audit policy / audit                               | Change commits with evidence; rollback releases neither.                     |
| Worker lifecycle                      | Worker and State work transition                                           | Existing ledger / audit policy / audit                               | Retry, terminal failure, cancellation and expired claim.                     |
| Session, turn and model call          | Selected Harness adapter at actual execution                               | Durable event metadata / activity policy / activity                  | Both Harnesses: success, retry, cancellation and interrupted stream.         |
| Tool invocation                       | Actual tool executor, including nested calls                               | Durable event metadata / activity policy / activity                  | Request, start, result, refusal and unknown external effect.                 |
| Policy and approval                   | IAM, Sandbox or selected enforcement owner                                 | Durable audit metadata / owning audit policy / audit                 | Rule/version, decision, approver where applicable, and enforced disposition. |
| Channel activity                      | Runtime channel receive/send boundary                                      | Durable event metadata / activity policy / activity                  | Receive, send, acknowledgement, failure, edit and delete.                    |
| Evidence disclosure and configuration | Authorized query/export or configuration owner                             | Audit ledger / audit policy / audit                                  | Read/export denied; permitted disclosure recorded before release.            |
| External source collection            | Provider adapter and shared ingestion owner                                | Durable metadata / source-scoped policy / source operations          | Fetch failure, replay, checkpoint and gap.                                   |
| Imported provider record              | Provider assertion, validated by its adapter                               | Durable imported metadata / source-scoped policy / imported evidence | Event and current-state snapshot remain distinguishable.                     |

Every route/listener, Harness, tool and configured integration must eventually
map to catalog entries and report implemented, unverified or unsupported
coverage. API coverage begins when the serving listener observes a request;
malformed transport and upstream rejections need their own declared observation
boundary. An uninstrumented path cannot inherit a completeness claim.

### Envelope and correlation

Use one logical envelope, with typed payloads rather than arbitrary log fields.
These names describe the proposed contract, not an existing public wire format.

[Appendix A: event field glossary](event-fields.md) defines each field, its
producer, applicability and relationship to the current `AuditEvent`. It also
names the revision, ordering, payload and content-status fields required by the
rules below. The appendix is part of this proposal.

Execution events also identify the Agent revision used, so later configuration
changes do not change the recorded context. Required fields vary by type: an anonymous malformed request has no fabricated
Agent or actor; a tool invocation requires its invocation and parent execution
references. A receiver must reject contradictory scope or identity and record
the ingestion problem without copying the rejected payload into diagnostics.
Field limits and payload ceilings belong to each versioned schema and must be
specified before its producer is enabled. Never truncate identity fields.

OCE producer sequences include an instance/epoch and expose missing records.
Provider sequence numbers or cursors retain their native meaning; a collector
sequence cannot prove completeness at the provider. Sequences do not establish
order across producers. Retried identical records are
idempotent; reusing the same source/event identity with different content is an
integrity failure. Corrections and late settlement append references to earlier
events instead of rewriting them. In particular, admission, dispatch, provider
response and confirmed external effect are separate assertions.

### Trust, ingestion and failure behavior

`packages/contracts` owns types; `packages/audit` owns audit construction and
sanitization; State owns persistence and transactional append. OCC composes
ingestion, queries and export work. Runtime and provider-specific behavior stays
in the selected Harness, Driver or Backend. No vendor-specific polling belongs
in platform core, and no new Driver capability is introduced by this RFC.

Runtime records require authenticated, execution-bound producer identity. Pod
labels or user-supplied event fields are insufficient to authorize a write or
assert an IAM decision. General workload authentication remains
[pending architecture work](../../../docs/design.md#remaining-design-work); M2 must
resolve that dependency before enabling runtime ingestion. A runtime may report
its observations, but only the enforcement owner can assert its policy result.

| Boundary                              | Required behavior                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| OCC state mutation                    | Commit the change and required evidence together. Preserve ambiguous COMMIT outcomes; do not replay effects automatically.                   |
| Runtime admission requiring evidence  | Receive durable acknowledgement before allowing the action. A local buffer qualifies only after its custody and failure domain are reviewed. |
| Runtime termination                   | Append success, failure, cancellation or unknown. Crash recovery identifies incomplete operations; absence of a completion is not success.   |
| Durable storage unavailable/full      | Stop new actions that require evidence. Continue refusing unauthorized access; expose audit failure through independent health signals.      |
| Export unavailable                    | Retain durable source records and retry. Export failure alone does not block actions while required storage capacity remains available.      |
| Duplicate, oversized or invalid input | Enforce schema, size and quota limits; report refusal/gaps. Do not silently label discarded input as ingested.                               |

No protocol can atomically commit an arbitrary provider effect with OCE's ledger.
Persist intent before dispatch and preserve unknown outcomes until evidence
settles them. Anonymous floods, disconnects and lost producers can exceed the
observation boundary; report capacity and gaps instead of promising zero loss.

### Capture, access and retention

Mandatory metadata is independent of diagnostic verbosity and content capture.
Content capture defaults off. An Installation policy defines what Namespace
overrides may enable; record the effective policy version. Credentials remain
excluded. Content status distinguishes disabled, captured, redacted, truncated,
expired and unavailable; metadata must not smuggle content through free text.

IAM owns exact-resource access and reauthorization for queries and exports.
Neither ordinary Agent access nor an administrative role implicitly grants
conversation access. Source-wide provider records need a source-scoped grant;
an adapter cannot assign them to a Namespace merely to make them visible.

Retention classes above are independent policy selectors, not durations or
indefinite-retention promises. Before any new producer ships, its delivery plan
must select retention duration, capacity, deletion/hold behavior, backup/restore
handling and content-reference cleanup. State owns enforcement; exporters own
destination acknowledgements. A restore must not silently restore access to
expired/deleted content. This RFC changes no existing append-only ledger rule.

### External API sources

A configured source binds a provider workspace/organization, permitted categories
and OCE ownership. The adapter uses protected, scoped credentials; shared
ingestion validates metadata/content and commits a collection checkpoint only
after the corresponding records are durable. Provider-specific pagination,
replay windows and rate limits belong to that adapter.

Preserve original event IDs/types, provider scope and schema/mapping version.
Separate collector health events from imported evidence. A provider snapshot is
an observation at fetch time, not an invented historical transition. Correlate
actors/conversations with OCE only through explicit verified mappings; keep
unmatched records and conflicting observations distinct. A provider log does
not prove that an OCE-local tool ran.

Checkpoints must not skip late arrivals or concurrently committed records.
Adapters without stable event IDs must define and qualify a deduplication key
and disclose its limits before enablement. Unknown categories leave coverage
incomplete. Source permission changes require revalidation without advancing
past records that were not ingested. This contract covers OpenAI Compliance and
Google sources without claiming their schemas, availability or retention are equal.

## Delivery and verification

M0 is complete when reviewers agree on this contract and every requested event
family has a producer, destination, access policy, retention class and acceptance
scenario. Its family inventory above records those assignments; concrete values
remain delivery gates. Acceptance must be recorded through the RFC process. M0
does not satisfy the runtime gates below. After review, create a separate implementation plan; fill each
concrete event schema and access/retention policy before enabling its producer.

| Later milestone          | Required connected proof                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| M1: control-plane audit  | Real API and PostgreSQL: reads, changes, denial, abort, failed append and unknown commit; authorized paginated disclosure.         |
| M2: Agent activity       | Real OpenClaw and Codex turns: authenticated scope, retries, restart, cancellation, duplicate ingestion and incomplete operations. |
| M3: tools and policies   | Actual executor/enforcer: allowed and denied calls, approvals, timeouts and receipt correlation.                                   |
| M4: integrations/content | Slack messages and MCP, Google Workspace, GitHub; content on/off, separate access, edits/deletes and delivery failure.             |
| M5: operations           | Export outage/replay, retention/deletion/restore, revoked access, capacity and collection gaps.                                    |
| M6: provider feeds       | Authorized provider APIs: interrupted pagination, late/duplicate records, credential revocation and unmatched identities.          |

Use the regular Agent workflow: channel message → turn → tool → policy decision
→ external result → reply. Extend supported integration coverage, with actual
dependencies, rather than testing a synthetic producer as proof of the runtime.
UI verification remains separate from backend durability proof. This RFC was
grounded in source at `fb2f145f538654135677fbb669d38ccb64ac6b11`; no runtime or
provider qualification is claimed.

## Rationale and alternatives

- **Expand raw Collector export:** simpler transport, but lacks authoritative
  producers, transactional evidence and controlled content access. Retain it for
  diagnostics.
- **Independent formats per integration:** preserves native detail but makes
  correlation and policy inconsistent. Keep typed native details behind a common
  envelope and explicit mappings.
- **One table for logs, content and audit:** simplifies initial queries but
  couples verbosity, volume, access and deletion. Share identity and query
  contracts while separating authoritative stores and policies.
- **New event platform immediately:** may improve throughput but adds unmeasured
  operational cost. Start durable metadata in reviewed PostgreSQL persistence;
  qualify capacity before selecting additional infrastructure.

## Unresolved delivery decisions

The reviewers must agree on the catalog ownership, trust and failure rules in
this RFC. State/IAM owners must select concrete retention and disclosure policies
for M1. Runtime/Compute owners must resolve authenticated producer transport and
buffer durability for M2. State/content owners must select content storage and
deletion semantics for M4. Backend owners must qualify provider schemas and
checkpoint behavior for M6. These decisions block the affected enablement, not
unrelated documentation work; none may relax M0's attribution or gap reporting.
