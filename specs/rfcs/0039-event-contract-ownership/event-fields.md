---
rfc: index.md
---

# Appendix A: event field glossary

[RFC-0039](index.md) extends the existing
[`AuditEvent`](../../../packages/contracts/src/index.ts). This appendix defines
intent, not a released wire schema. Preserve current field names; delivery must
specify typed variants, required fields and size limits before enabling new
producers. Omit inapplicable context and disclose unknown observations instead of
inventing identities or results.

## Existing common fields

| Field            | What it captures                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | One observation's stable identity within the Installation. Retries preserve it. Imported IDs must include their source identity to avoid collisions with other providers or sources.                                                                            |
| `schemaVersion`  | The contract version used to interpret the record. The current factory emits version 1; extensions require an explicit version decision.                                                                                                                        |
| `occurredAt`     | When the source observed the fact. Preserve provider event time; do not substitute fetch time for missing historical time. A variant without known event time must represent that absence explicitly.                                                           |
| `installationId` | The owning Installation, established from trusted ingestion configuration.                                                                                                                                                                                      |
| `namespaceId`    | The owning Namespace when applicable. Do not assign source-wide provider records to a Namespace merely to expose them.                                                                                                                                          |
| `source`         | Who emitted the record. Today this is restricted to `occ`; extend it to identify an authenticated registered runtime or provider source. The precise structure belongs to the delivery schema. It must distinguish local observations from imported assertions. |
| `actorId`        | The stable OCE actor identifier, or the established unresolved representation. An authenticated emitter is not automatically the actor. Keep unmatched provider identities in provider details.                                                                 |
| `actor`          | Structured identity evidence, currently including principal/id, identity kind, issuer, subject and unresolved status. Preserve verified attribution and delegation; reject contradictions with `actorId`.                                                       |
| `kind`           | The broad audit category. Existing values are bootstrap, mutation, access and authorization denial. New families require reviewed values, not a second category system.                                                                                         |
| `action`         | The specific observed operation or lifecycle transition. It selects the allowed producer and typed details together with `kind`. A start and a completion are separate actions.                                                                                 |
| `resource`       | The exact target: kind, identity and applicable scope. It is distinct from the Agent performing the work. New variants must explicitly handle observations with no known target, such as unmatched requests.                                                    |
| `outcome`        | The result of this observation's action. Current values are success, denied and failure. A successful start does not mean successful completion; cancellation and unknown results need defined variants.                                                        |
| `details`        | Action-specific facts such as sanitized HTTP classification, token counts or collection failures. Replace unrestricted use with typed allowed fields; never use metadata to bypass content policy.                                                              |

## Existing contextual fields

These stay optional where they do not apply. They are not reasons to require
HTTP or IAM concepts on every runtime event.

| Field                 | What it captures                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId`           | The HTTP request correlation identifier. One request is not necessarily one logical operation.                                         |
| `admissionDecisionId` | The admission decision associated with the action. It is not the version of the policy evaluated.                                      |
| `iamDriverId`         | The selected IAM Driver responsible for authorization.                                                                                 |
| `authorization`       | The exact authorization request evaluated, including its principal, action and target. It does not contain authentication credentials. |
| `decisionReason`      | Approved, sanitized explanatory text for a decision. Never raw exceptions, credentials or conversation content.                        |
| `reasonCode`          | A stable machine-readable reason for a decision or failure.                                                                            |

## Proposed optional context

Add `context` only for event families that need execution correlation. Its
members have the following meanings; their exact required combinations belong
to each action's schema. Producers must not choose another Agent's scope.

| Field                     | What it captures                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `context.agentId`         | The OCE Agent performing the work, independently of the action's target resource.                                               |
| `context.agentRevisionId` | The immutable Agent revision actually used. Never infer it from the Agent's current configuration after the event.              |
| `context.sessionId`       | The execution session containing related turns. Provider conversation IDs remain provider data until a verified mapping exists. |
| `context.turnId`          | One admitted unit of Agent work; it may contain several model calls and tool invocations.                                       |
| `context.operationId`     | One logical operation across lifecycle events and execution retries.                                                            |
| `context.invocationId`    | One logical tool invocation. Nested calls receive separate identities.                                                          |
| `context.attemptId`       | One execution attempt. A new execution attempt gets a new ID; redelivery of its event does not.                                 |
| `context.parentId`        | The causal parent event's identity, scoped to the Installation. It does not replace the session or operation identity.          |

## Proposed optional content reference

A content-capable event may carry `content`, a typed list of descriptors. This
keeps multiple payloads attached to one observation without placing them in
metadata. Each descriptor contains:

| Field                  | What it captures                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ref`                  | An opaque reference to separately protected content, if captured. It is not a public URL or bearer credential and grants no access by itself.             |
| `kind`                 | The payload category, such as prompt, response, tool input/output or channel attachment.                                                                  |
| `status`               | Captured, disabled, redacted, truncated, expired or unavailable. Delivery must define valid combinations; absence is not proof that capture was disabled. |
| `capturePolicyVersion` | The effective policy applied to this payload, including resolved Installation/Namespace rules. Record it even when capture is disabled.                   |

Later expiry or deletion is a new lifecycle observation; it does not rewrite the
original event. M4 defines storage, integrity metadata and reference cleanup.

## Keep specialized data out of the common record

- **Ingestion time:** State records first durable acceptance separately from source
  time. Duplicate delivery preserves it; historical imports cannot invent it.
- **Producer versions, sequence numbers and epochs:** transport metadata where
  required for diagnosis and gap detection, not universal event fields.
- **Policy versions and receipt references:** typed details on enforcement and
  effect events. Preserve authoritative policy/receipt identity and qualify
  references to their owning source.
- **Provider identifiers, schema versions and snapshot times:** typed provider
  details. Collection checkpoints belong to the adapter's durable state.

There is no parallel `eventId`/`eventType`/`payload` envelope or mechanical rename
of `id`/`kind`/`action`/`details`. Existing records keep their recorded meaning;
missing context cannot be fabricated to imply complete historical coverage.
