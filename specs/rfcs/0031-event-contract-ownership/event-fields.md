---
rfc: index.md
---

# Appendix A: event field glossary

This appendix defines the proposed fields in [RFC-0031](index.md). These are
semantic requirements, not a released JSON Schema or TypeScript interface.
The implementing schema must specify types, enumerations, size limits and
required fields for each event type before that producer is enabled.

Receiver-owned values come from authenticated ingestion context. Producers
cannot choose another tenant's scope. Imported actor and execution references
remain provider assertions unless an explicit mapping verifies their OCE
identity. Omit inapplicable fields; represent a missing required observation as
unknown or incomplete, rather than inventing a value.

## Identity, source and time

| Field              | What it captures and who supplies it                                                                                                                                                                                | When it applies                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventId`          | The producer's stable identifier for one observation. Redelivery preserves it; a new observation gets a new identifier. Within an Installation, canonical identity is the pair of `sourceInstanceId` and `eventId`. | Every event. An import adapter uses a qualified deterministic identity when the provider has no stable event ID.                                                                              |
| `eventType`        | The catalog entry that states what happened, such as a turn starting or a policy decision. The validated type selects the permitted producer and payload.                                                           | Every event; unrecognized types cannot enter the validated feed.                                                                                                                              |
| `schemaVersion`    | The version of the canonical contract used to interpret this type and payload. It does not identify the producer binary or provider API version.                                                                    | Every event; the catalog must define compatible envelope and payload versions.                                                                                                                |
| `source`           | The assertion's origin category: OCC, runtime or imported provider. The receiver validates it against the authenticated producer.                                                                                   | Every event; it describes authority, not severity or a storage destination.                                                                                                                   |
| `sourceInstanceId` | The registered producer or external-source identity within the Installation. It survives reconnects and identifies the source of retries.                                                                           | Every event. Distinct configured sources do not share an identity merely because they use the same provider.                                                                                  |
| `producerVersion`  | The implementation version that emitted or normalized the record. For imports this identifies the OCE adapter, not the provider's schema.                                                                           | Every OCE emitter or import adapter; provider-side version data belongs in `providerRef`.                                                                                                     |
| `occurredAt`       | When the source observed the fact. For imported history, retain the provider's event time.                                                                                                                          | Required when the source supplies a trustworthy event time; otherwise record its absence and time uncertainty in the typed payload. Do not substitute fetch time for missing historical time. |
| `ingestedAt`       | When the canonical receiver first durably accepted the record, assigned by that receiver.                                                                                                                           | Every accepted event. Duplicate deliveries retain the original value; delivery attempts have their own observations.                                                                          |

These timestamps support investigation and lag estimates. Clock differences
mean their subtraction does not prove exact latency or causal order. A snapshot
payload also records when it was fetched and any provider-supplied modification
time; neither turns the snapshot into a historical transition.

## Ownership and identity

| Field             | What it captures and who supplies it                                                                                                                                                                      | When it applies                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `installationId`  | The OCE Installation that owns the record, established by the receiver's trusted configuration.                                                                                                           | Every event.                                                                                                                                                     |
| `namespaceId`     | The owning Namespace, established from the authenticated operation or verified source mapping.                                                                                                            | Namespace-scoped events. Installation-wide or unmatched provider records must not receive a fabricated Namespace.                                                |
| `resource`        | The exact operation target, including resource kind, stable identity and applicable scope.                                                                                                                | Events with a known target. An unmatched HTTP route may instead carry a sanitized route classification in its payload.                                           |
| `actor`           | The identity responsible for the action: verified OCE principal, explicitly unresolved caller, or separately qualified provider actor. Includes identity kind and issuer/subject where relevant.          | Action-bearing events. A worker acting without a user records its service identity; the event producer is not automatically the actor.                           |
| `authentication`  | The nonsecret evidence for the actor's authentication: method, result and credential/key reference when available. It must distinguish actor authentication from the ingestion producer's authentication. | Authentication and attributable action events. Never include tokens, cookies or private keys; an authenticated adapter does not authenticate the imported actor. |
| `agentId`         | The OCE Agent whose execution produced the observation, independently of the tool's target resource.                                                                                                      | Agent activity and verified correlations to it. This makes the Agent identity required by the RFC explicit.                                                      |
| `agentRevisionId` | The immutable Agent revision actually used for execution, supplied by the execution owner and checked against its scope.                                                                                  | Execution bound to a revision. Never look up the currently selected revision and assign it retroactively.                                                        |

`actor`, `authentication` and `resource` require typed structures in the delivery
schema. Their descriptions do not authorize arbitrary key/value objects.
Delegation must preserve the initiator and executing identity in typed data.

## Correlation and ordering

| Field            | What it captures                                                                                                 | When it applies                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`      | The execution owner's stable conversation/session identity across turns.                                         | Session-bound activity; provider conversations remain under `providerRef` until verified mapping exists.                              |
| `turnId`         | One admitted unit of Agent work within a session. Multiple model calls and tools can belong to one turn.         | Turn-bound activity. Retries within that turn retain its identity.                                                                    |
| `operationId`    | One logical action across its lifecycle, such as an API operation or model request.                              | Multi-stage actions. A new user action gets a new ID; retrying delivery of its events does not.                                       |
| `invocationId`   | One logical tool invocation, distinct from its parent turn and from nested tool calls.                           | Tool events. Nested calls get separate IDs; retry attempts use `attemptId`.                                                           |
| `attemptId`      | One execution attempt for an operation or invocation. A retry creates another attempt.                           | Retriable execution. Event transport retries retain the original attempt ID.                                                          |
| `parentId`       | The fully qualified identity of the immediate causal parent event, including its source instance when needed.    | Known causal links, such as the event that initiated a nested call. It is not an interchangeable session, operation or invocation ID. |
| `producerEpoch`  | The producer incarnation for which its sequence is valid; changes when sequence continuity cannot be maintained. | Sequenced OCE producers. This names the epoch described in the main RFC.                                                              |
| `sequenceNumber` | The producer-assigned increasing position within one source instance and epoch.                                  | Sequenced OCE producers. Define the stream scope before claiming gaps; provider cursors remain provider data.                         |

Missing sequence values reveal a possible gap within that declared stream.
An external adapter's sequence measures its own output, not completeness of
provider history. Corrections identify the superseded observation in typed
payload data; `parentId` alone does not imply replacement or deletion.

## Action, result and evidence

| Field                  | What it captures                                                                                                                                                                                  | When it applies                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `phase`                | The stage being observed, such as admission, start or settlement. The catalog defines the allowed stages for each type.                                                                           | Lifecycle events; accepting work is not evidence of its successful completion.                                                                               |
| `outcome`              | The result observed at that stage: for example success, denied, failure, cancellation or unknown.                                                                                                 | Result-bearing events. A start may have no result; an unknown external effect must not become success.                                                       |
| `reasonCode`           | A stable machine-readable explanation of a decision or failure.                                                                                                                                   | Decisions and failures with a known classification. It is not raw exception text or user content.                                                            |
| `policyRef`            | The enforcing policy's identity and evaluated immutable version, with rule/decision references when applicable.                                                                                   | Policy events. The actual enforcer supplies it; an Agent cannot assert an authoritative IAM decision.                                                        |
| `providerRef`          | Qualified provider name, configured workspace/organization, native event/object IDs, native type/schema version and adapter mapping version. Also preserves event-versus-snapshot classification. | Imported records and locally observed provider interactions. Distinguish those two assertion sources even if identifiers match.                              |
| `receiptRef`           | A qualified reference to authoritative evidence retained by the operation owner, such as a repository or egress receipt.                                                                          | Operations with a receipt. A reference does not strengthen the receipt's own outcome or grant access to it.                                                  |
| `contentRef`           | An opaque, access-controlled reference to separately stored content. Its typed descriptor identifies content kind and integrity metadata when available.                                          | Captured or previously captured content. It is not an inline payload, public URL or bearer credential.                                                       |
| `capturePolicyVersion` | The effective capture policy version applied when this observation was produced, including resolved Installation/Namespace rules.                                                                 | Content-capable events, including when capture is disabled. Later policy changes do not rewrite this value.                                                  |
| `contentStatus`        | Whether eligible content was disabled, captured, redacted, truncated, expired or unavailable. It accompanies the corresponding content item when there are several.                               | Content-capable events; this names the status required in the main RFC. Later expiry is a separate lifecycle observation, not an edit to the original event. |
| `payload`              | The event-type-specific facts that the envelope cannot express: for example sanitized HTTP classification, token counts, authentication result, or provider collection gap.                       | According to the catalog schema. No unrestricted details bag or prompt/response text in metadata.                                                            |

The payload defines which external state was actually observed. Dispatching a
message, receiving an acknowledgement and confirming an external effect must
remain distinct even when all three report a successful stage.

## Mapping from the current audit schema

The existing [AuditEvent](../../../packages/contracts/src/index.ts) and
[factory](../../../packages/audit/src/index.ts) remain implemented behavior.
The following describes intent, not an implemented conversion. Delivery must
define a versioned mapping before replacing any writer or reader.

| Current field                               | Proposed treatment                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                        | Corresponds to `eventId`, qualified by the registered OCC source instance. Preserve identity when projecting existing evidence.                                  |
| `installationId`, `namespaceId`, `resource` | Preserve existing ownership and target meaning; validate imported scope separately.                                                                              |
| `occurredAt`                                | Preserve original event time. Do not infer historical ingestion time from it.                                                                                    |
| `kind`, `action`                            | Map together to a catalog `eventType` and typed operation data. The coarse `kind` alone cannot identify the event. Preserve the exact IAM action where relevant. |
| `schemaVersion`                             | The factory currently emits version 1. A new canonical contract requires explicit version handling; adding fields does not make old records satisfy it.          |
| `source`                                    | Currently restricted to `occ`. Runtime and provider assertions require the proposed expansion and independent trust rules.                                       |
| `actorId`, `actor`                          | Preserve canonical identity, kind, issuer/subject and unresolved status in the typed actor. Do not discard disagreement or silently merge identities.            |
| `requestId`                                 | Preserve as an HTTP correlation field in the typed payload. Do not assume one HTTP request equals one logical `operationId`.                                     |
| `admissionDecisionId`                       | Preserve as an admission-decision reference in policy data; it does not identify a policy version.                                                               |
| `iamDriverId`, `authorization`              | Preserve the selected IAM Driver and exact authorization request in typed policy data. These are not authentication credentials.                                 |
| `decisionReason`, `reasonCode`              | Keep the stable code; retain only approved, sanitized explanatory text in typed payload data.                                                                    |
| `outcome`                                   | Preserve today's `success`, `denied` and `failure` with their original meaning. New stages and outcomes require explicit catalog definitions.                    |
| `details`                                   | Map approved keys into each type's schema. Do not forward arbitrary content or infer missing execution identifiers.                                              |

Old records may lack ingestion time, producer version, execution references or
capture status. A projection must disclose those limits; it must not fabricate
fields to make historical coverage appear complete.
