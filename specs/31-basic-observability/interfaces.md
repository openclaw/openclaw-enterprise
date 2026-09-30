# Basic observability: interfaces

[Overview](../31-basic-observability.md) · [Architecture](architecture.md) · [Retention](retention.md)

**Status:** The History fact/query shapes and shared policy consumption below are selected proposed contracts. HTTP, State serving joins and expanded views remain proposed. Owner decisions remain explicit.

## Facts and events

This RFC proposes immutable closed lifecycle objects with the following complete structural inventory. `OpaqueId` means an owner-issued nonempty safe identifier, bounded to 512 UTF-8 bytes. Platform IDs retain their nominal prefixed types. Timestamps use canonical UTC date-time strings with milliseconds. The short aliases below name the proposed `AuditHistorySubjectV1`, `AuditHistoryResourceV1`, `AuditHistoryInitiatorV1`, `AuditHistoryExecutorV1`, `AuditHistoryAuthorizationV1`, `AuditHistoryCausationV1` and `AuditHistoryReceiptV1` types. Never truncate authoritative identifiers.

```ts
type Subject = { kind: "agent"; id: AgentId; namespaceId: NamespaceId };
type Resource =
  | Subject
  | {
      kind: "agent_revision";
      id: RevisionId;
      namespaceId: NamespaceId;
    };
type AuthorizationResource =
  | Resource
  | { kind: "configuration"; id: ConfigurationId; namespaceId: NamespaceId }
  | { kind: "service_account"; id: ServiceAccountId; namespaceId: NamespaceId }
  | { kind: "secret"; id: SecretId; namespaceId: NamespaceId }
  | { kind: "agent"; id: NamespaceId; namespaceId: NamespaceId };
type Initiator = { kind: "resolved"; principalId: OpaqueId } | { kind: "unresolved" };
type Executor = { kind: "controller" };
type Authorization =
  | { kind: "unresolved" }
  | {
      kind: "decision";
      decision: "allowed" | "denied";
      principalId: OpaqueId;
      action: "create" | "read" | "update" | "deploy" | "operate";
      resource: AuthorizationResource;
      iamDriverId: OpaqueId;
      admissionDecisionId?: OpaqueId;
    };
type Causation = {
  operationId?: OpaqueId;
  requestId?: RequestId;
  admissionDecisionId?: OpaqueId;
  parentEventId?: AuditId;
  revisionId?: RevisionId;
  workId?: OpaqueId;
  attemptId?: OpaqueId;
  attempt?: number;
};
type Receipt =
  | { kind: "database_receipt"; receivedAt: Timestamp }
  | { kind: "legacy_occurrence"; retentionAnchorAt: Timestamp };
type AuditHistoryFactV1 = {
  schema: "openclaw.audit-history/v1";
  id: AuditId;
  installationId: InstallationId;
  namespaceId: NamespaceId;
  occurredAt: Timestamp;
  subject: Subject;
  resource: Resource;
  source: AuditHistorySource;
  action: AuditHistoryAction;
  phase: AuditHistoryPhase;
  result: AuditHistoryResult;
  reasonCode: AuditHistoryReasonCode;
  initiator: Initiator;
  executor: Executor;
  authorization: Authorization;
  causation: Causation;
};
type AuditHistoryEventV1 = AuditHistoryFactV1 & {
  sequence: string;
  receipt: Receipt;
};
```

State constructs `sequence` and `receipt` from trusted persisted metadata. Producers cannot supply them. `occurredAt` is separate producer observation time. Installation/Namespace and exact historical Agent/resource scope are server-owned. `attempt` is an integer from 1 through `Number.MAX_SAFE_INTEGER`. Sequence is canonical positive decimal PostgreSQL bigint, at most `9223372036854775807`, never a JavaScript number.

The closed vocabulary is:

- Sources: `occ_admission`, `occ_worker`, `occ_legacy`.
- Actions: `openclaw.agents.create`, `.update`, `.deploy`, `.stop`, `.lifecycle.activate`, `.lifecycle.stop`, `.lifecycle.supersede`, where each suffix uses the same `openclaw.agents` prefix.
- Phase/result pairs: `requested` permits `pending/denied/failure`, `accepted` permits `accepted`, `observed` permits `success/denied/failure/superseded`, and `unknown` permits `unknown`.

The proposed lifecycle reasons are listed below. Exception text is never a reason:

```text
REQUESTED ACCEPTED OBSERVED AUTHORIZATION_DENIED ACTOR_REVOKED
DEPENDENCY_UNAVAILABLE UNKNOWN_OUTCOME UNRESOLVED_LEGACY UNCLASSIFIED_FAILURE
INVALID_TARGET INVALID_AGENT_OWNER INVALID_AGENT_PRINCIPAL INVALID_REVISION_OWNER
INVALID_ACTIVE_REVISION INVALID_ADMITTED_REVISION INVALID_DRIVER_OBSERVATION
INVALID_HARNESS_AUTH INVALID_SECRET_BINDINGS HARNESS_AUTH_REQUIRED
HARNESS_AUTH_SOURCE_CHANGED HARNESS_AUTH_SOURCE_UNAVAILABLE HARNESS_DESCRIPTOR_MISMATCH
COMPUTE_BINDING_INCOMPLETE COMPUTE_DRIVER_MISMATCH PROVIDER_UNAVAILABLE
SECRET_BINDING_UNAVAILABLE SECRET_DRIVER_MISMATCH SERVICE_ACCOUNT_PROVIDER_MISMATCH
NAMESPACE_NOT_READY ACTIVE_REVISION_CHANGED AGENT_ALREADY_STOPPED AGENT_STOPPED
REVISION_ACTIVATED REVISION_ALREADY_ACTIVE REVISION_INCOMPLETE
REVISION_FINALIZATION_INCOMPLETE REVISION_MAINTENANCE_SUPERSEDED REVISION_STOPPED
REVISION_SUPERSEDED STOP_SUPERSEDED SUPERSEDED_TARGET CONVERGENCE_DEADLINE_EXCEEDED
```

The proposed parsers must reject unknown fields/versions, unsafe text, depth above 6 and objects exceeding **8,192 encoded UTF-8 bytes**. They snapshot plain data without getters or custom serialization. Cycles, arrays, unexpected prototypes, symbol/nonenumerable keys and objects with more than 32 members are rejected. Safe text excludes controls, credential-shaped values, private-key markers and invalid UTF-8. Scope must agree throughout. A revision resource matches causation, parent-event identity cannot equal self, and denied authorization corresponds to denied result.

Accepted admission requires resolved initiator, allowed original primary permission, request/admission references and matching authorization. Creation targets the Namespace's Agent collection. Accepted deployment affects a revision. Worker facts are observed/unknown, with deploy/stop admission-action facts limited to denial. Activation observes success, lifecycle stop success/failure and supersession superseded, unless unknown. Audit owns these validation rules and their implementation acceptance.

New producer facts cannot claim `occ_legacy`. Legacy projection uses only original trusted provenance and never synthesizes causation. Legacy receipt and source must agree, with its anchor no later than `occurredAt`. Internal `AuditEvent.outcome` remains `success/denied/failure`. One ID denotes one immutable fact and conflicting reuse fails.

**Owner decision required:** Audit/State/authentication freeze expanded event/view membership around actual producers. The lifecycle executor is controller-only. Genuine Agent/revision/ServicePrincipal execution and assurance require accepted runtime exports. Keep initiator, actual authorization principal, Driver, admission and stable operation causation distinct. Missing attribution stays unresolved and uncertain execution unknown. Account/login facts keep their original authentication transaction and subject. Mandatory disclosure and Installation-retention facts remain in the common ledger without fabricated Agent subjects or speculative lifecycle enums. Serialized assurance grants no authority.

Current [plugin startup warnings](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/docs/reference/agent-plugins.md#L49-L77) are closed auxiliary details after safe disabling, not lifecycle failures. The [activation audit](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/apps/controller/src/worker.ts#L1849-L1875) does not copy them into its fact. Do not copy raw deployment `resultData` or add `PLUGIN_*` reasons to History. Expanded safe projection remains the producer/Audit decision above.

## Authorization and policy consumption

| Fixed role                      | Exact action and target                                   |
| ------------------------------- | --------------------------------------------------------- |
| `audit_reader`                  | `read_audit` on one exact Agent or Namespace-wide Agents. |
| `audit_retention_administrator` | Only `manage_audit_retention` on singleton Installation.  |

Add both actions to the common catalog/validator. Ordinary `read/operate/administer` implies neither. Personal/team Agents share the existing resource model. Ownership, membership, participation, deployment rights and known IDs confer no History access. Content remains separately authorized.

Installation `administer` explicitly grants/revokes these roles for existing identities/groups through [common policy administration](https://github.com/openclaw/openclaw-enterprise/pull/245). That proposal's Policy administration section owns the selected Driver overloads: `bindPolicy(IAMPolicyReadTransactionTokenV1): Promise<IAMPolicyReadUnitV1>` and `bindPolicy(IAMPolicyWriteTransactionTokenV1): Promise<IAMPolicyUnitV1>`. OCC separately owns `readPolicy/applyChange/readPolicyOperation`.

The bounded atomic writer validates subjects/targets, owns IDs and commits bindings, policy revision, withdrawal intent, receipt and evidence in original State. Preserve revoked-binding identity while excluding it from current authorization. Preserve the common writer's unknown-COMMIT recovery and last usable local administrator guard. Authentic retained Agent parentage permits grant/revoke/regrant after deletion only for fixed `audit_reader`, retaining exact filters. Caller parentage and ordinary-grant exceptions are forbidden.

Accept/compile exports before composition. Unsupported transactional Drivers fail explicitly without Native fallback, another catalog/writer or remote mutation.

## History query

**Proposed HTTP:** `GET /namespaces/:namespaceId/agents/:agentId/history`. Authenticate each request and require current exact historical-Agent `read_audit`, without requiring a live Agent row. Use indexed `PlatformUnitOfWork.audit.queryAgentHistory`, its lifetime binder and adapters. Never filter unbounded `list()`.

This RFC proposes these complete normalized query shapes. A serving State adapter and HTTP policy require implementation and qualification:

```ts
type AuditHistoryQueryFiltersV1 = {
  operationId?: OpaqueId;
  revisionId?: RevisionId;
  occurredAtFrom?: Timestamp;
  occurredAtBefore?: Timestamp;
  result?: AuditHistoryResult;
};
type AuditHistoryQueryWindowV1 = { upperSequence: string; beforeSequence: string };
type AuditHistoryQueryV1 = {
  installationId: InstallationId;
  subject: Subject;
  limit: number;
  filters: AuditHistoryQueryFiltersV1;
  window?: AuditHistoryQueryWindowV1;
};
type AuditHistoryQueryPageV1 = {
  events: readonly AuditHistoryEventV1[];
  continuation?: AuditHistoryQueryWindowV1;
};
type AuditHistoryPublicPageV1 = {
  events: readonly AuditHistoryEventV1[];
  nextCursor?: string;
};
```

Limit is an integer **1–100**. Time filters are lower-inclusive/upper-exclusive and require `from < before` when both exist. Events strictly descend by decimal-string bigint sequence. A window applies `sequence <= upperSequence` and `sequence < beforeSequence`, with `beforeSequence <= upperSequence`. Every row matches exact scope and filters. Continuation keeps the original upper sequence and last returned sequence, requires a nonempty page with last sequence greater than 1, and is emitted only if another matching row exists. Structural parsing alone cannot prove that row exists.

The public page is the existing envelope's `data` value. Its cursor requires a nonempty page, safe nonempty text and at most 4,096 UTF-8 bytes under the proposed structural validation. API authentication of a bounded versioned cursor binds Installation, current principal, Driver, subject, normalized filters, original upper/last sequence and expiry. Bound validation work. The cursor grants neither authority nor a snapshot, total count or Installation scan. Concurrent commits and retention can change later pages.

**Supplemental proposal:** HTTP default 50, cursor ceiling 4,096 bytes and 15-minute validity remain proposed query policy. The structural ceiling alone supplies neither that HTTP policy nor mutation-recovery validity.

## Disclosure transaction

Every page and exact recovery uses one short **READ COMMITTED State write transaction with IAM read-bound authorization**. Consume the [shared State/policy order](https://github.com/openclaw/openclaw-enterprise/pull/245):

1. Bind intent before resource locks. Acquire Installation authority, sorted required account/session guards, the complete native policy-table barrier/head, protected resources, then retention `FOR SHARE`.
2. Sample database time after locking. Resolve current [account authority](https://github.com/openclaw/openclaw-enterprise/pull/246) and selected-IAM authority, then select eligible evidence.
3. Reauthorize immediately before disclosure append. Release bytes only after acknowledged COMMIT.

No late policy upgrade is permitted. An earlier committed revoke prevents disclosure. Refused/unknown commit or dependency failure returns a sanitized error without a page. Released bytes cannot be recalled. Accept concrete account guard and complete policy-barrier SQL and review all participating writers.

**Owner decision required:** State/Audit/API must settle expiry crossing between the post-lock sample and release for both pages and recovery. Bound transactions and cancellation, failing closed when the selected release rule cannot hold. No silent resampling or eligibility extension is approved.

## Mutation outcomes

Unknown COMMIT for `createAgent/updateAgent/deployAgent/stopAgent` returns **503 `UNKNOWN_OUTCOME`**, safe Namespace/Agent/event/operation IDs and a sealed reference. Observe through `GET /namespaces/:namespaceId/agents/:agentId/mutation-outcomes/:eventId`, supplying that reference in a dedicated header whose name is undecided.

Verify before trusting claims. Match every path and retained identity, original principal and selected Driver. Reauthorize the original primary action/target: Namespace Agent collection for create, exact Agent otherwise. Neither a live row nor `read_audit` is required. Indexed exact-event lookup uses the disclosure/restore gates.

`accepted` returns only bound action, operation/event/Agent and applicable revision IDs, proving local acceptance. Missing, expired, erased, unverifiable or uncertain evidence stays `unknown`, never rollback. Malformed input/denial exposes no facts and dependency errors are sanitized. Observation reveals no other history, configuration or provider data and creates no work. An explicit later mutation is new.

Preparation order is mandatory:

1. After authentication, allocate audit ID and operation UUID before outer State. Carry server request ID through narrow `AgentMutationContext`. Lifecycle owns Agent/revision IDs and deploy/stop work retains context.
2. Bind the accepted event to subject/resource, original primary target/action, initiator, Driver and operation/request. State prepares only from that transaction's appended event.
3. Seal the bounded purpose-specific reference before COMMIT. Preparation/sealing failure aborts. The original transaction owner drains/classifies COMMIT, suppresses unsafe compensation and preserves the prepared reference through uncertainty. A prepared signature proves no commit.

**Proposal, owner decision required:** composition/operators provision a shared purpose-specific key ring and choose bounded envelope/header, concrete finite validity, rotation and verifier retention, including indefinite records. Preserve restart/replica continuity, pre-distribute verifiers before signer rollover, separate cursor purpose and exclude references from logs/telemetry. Never borrow cursor lifetime. Account/policy receipts and durable invocation/reply fences retain independent owners and lifetimes across audit erasure.

## Retention interface index

[Retention](retention.md) owns `days_30` default versus `indefinite`, monotonic revision, database change time, expired-anchor frontier, expected-revision CAS and trusted receipt fields. Configuration requires current `manage_audit_retention`. Sweep returns aggregate progress/sanitized failure only.

Concrete policy/sweeper functions and DTOs, restore checkpoint envelope/custody/import, all-replica activation and guarded current-IAM/purge-role composition remain owner decisions. Required semantics and closure are in [SQL enforcement](retention.md#database-and-runtime-enforcement) and [restore](retention.md#restore-and-copy-ownership). These gaps do not authorize invented routes or defaults.

### Diagnostic configuration

The proposed local diagnostic-file overlay uses `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OCC_DIAGNOSTIC_LOG_USER` (output-owner UID:GID) and `OCC_DIAGNOSTIC_LOG_DIRECTORY` (private absolute directory). Its read-only receiver configuration writes `/out/logs.jsonl`, rotating at 10 MB with three backups and one-day retention. These diagnostic settings do not configure ledger retention. [Architecture](architecture.md#optional-diagnostics) owns custody and sink-failure behavior.

## Console and examples

The direct exact-Agent view needs no configuration-read permission. Use no-store responses, escaped DOM, request-ID errors and cancellation when leaving the view. Handle loading, empty, denied, error, pagination, stale responses and explicit unknown outcomes.

Safe empty-page example using the existing `data/meta` envelope and nominal request ID:

```json
{
  "data": { "events": [] },
  "meta": { "requestId": "req_00000000-0000-4000-8000-000000000001" }
}
```

A denied request returns no event page. A lost mutation acknowledgment reports `UNKNOWN_OUTCOME`, after which only the exact observation route can establish accepted evidence. The recovery envelope remains undecided, so this RFC supplies no fabricated executable recovery response.
