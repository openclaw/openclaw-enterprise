# Basic Agent observability: contract

[Overview](../31-basic-observability.md) · [Retention](retention.md) · [Repository read](repository-read.md)

**Status:** Proposed. Serving, owner acceptance and qualification remain pending.

## Components and placement

OpenClaw Control Plane (OCC) admission and its lifecycle worker produce their own facts. Audit and the selected IAM Driver are in-process contracts or libraries, not new services. Audit validates facts, authentication checks account and session, IAM authorizes, and original State owns transactions and queries the common PostgreSQL ledger. OCC HTTP exposes results and the console presents them.

In the [current Kubernetes topology](https://github.com/openclaw/openclaw-enterprise/blob/e4a807e785e1a242e27200c8e8396f58136cbbc6/docs/reference/repository-credentials.md), the worker prepares Agent material. The separate credential process/container retains App keys, JWTs and installation tokens. The Agent receives gateway bearer, client files and CA trust. RepoDriver exposes a provider-neutral consumer contract to core. Its Backend and credential service own provider behavior and custody. The History-to-runtime join remains proposed.

[Pinned main](https://github.com/openclaw/openclaw-enterprise/blob/e4a807e785e1a242e27200c8e8396f58136cbbc6/packages/occ/src/state/platform-state.ts#L483-L486) exposes `PlatformAuditRepository.append(event: AuditEvent): Promise<void>` and unbounded `list(): Promise<readonly Readonly<AuditEvent>[]>`. Direct work-queue SQL bypasses append. The proposed query, lifetime binder and retention enforcement must cover both adapters and every writer. This is not a qualified reader.

Local mutation, mandatory evidence and accepted controller work commit in the original State transaction. Work carries original cause across claims, retries, supersession, completion and failure. Queue completion establishes only worker facts, not physical stop or provider success.

## Facts and events

These proposed lifecycle objects are immutable and closed. `OpaqueId` is an owner-issued, nonempty safe identifier of at most 512 UTF-8 bytes. Platform IDs keep nominal prefixes. Timestamps use canonical UTC milliseconds. The aliases name `AuditHistorySubjectV1`, `AuditHistoryResourceV1`, `AuditHistoryInitiatorV1`, `AuditHistoryExecutorV1`, `AuditHistoryAuthorizationV1`, `AuditHistoryCausationV1` and `AuditHistoryReceiptV1`. Never truncate authoritative identifiers.

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

State constructs `sequence` and `receipt` from trusted persisted metadata. `occurredAt` is separate producer observation time. Installation/Namespace and exact historical Agent/resource scope are server-owned. `attempt` is an integer from 1 through `Number.MAX_SAFE_INTEGER`. Sequence is canonical positive decimal PostgreSQL bigint, at most `9223372036854775807`, never a JavaScript number.

Closed vocabulary:

- Sources: `occ_admission`, `occ_worker`, `occ_legacy`.
- Actions: `openclaw.agents.create`, `.update`, `.deploy`, `.stop`, `.lifecycle.activate`, `.lifecycle.stop`, `.lifecycle.supersede`, where each suffix uses the same `openclaw.agents` prefix.
- Phase/result pairs: `requested` permits `pending/denied/failure`, `accepted` permits `accepted`, `observed` permits `success/denied/failure/superseded`, and `unknown` permits `unknown`.

Closed reasons exclude exception text:

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

Parsers reject unknown fields/versions, unsafe text, depth above 6 and objects exceeding **8,192 encoded UTF-8 bytes**. They snapshot plain data without getters or custom serialization. Reject cycles, arrays, unexpected prototypes, symbol/nonenumerable keys and more than 32 members. Safe text excludes controls, credential-shaped values, private-key markers and invalid UTF-8. Scope must agree. Revision resource and causation match. Parent-event identity cannot equal self. Denied authorization requires a denied result.

Accepted admission requires a resolved initiator, allowed original primary permission, request/admission references and matching authorization. Creation targets the Namespace Agent collection. Deployment affects a revision. Worker facts are observed/unknown, with deploy/stop admission-action facts limited to denial. Activation observes success, lifecycle stop success/failure and supersession superseded, unless unknown. Audit owns validation and implementation acceptance.

New facts exclude `occ_legacy`. Legacy projection uses trusted provenance and never synthesizes causation. Receipt and source agree, with the legacy anchor no later than `occurredAt`. Internal `AuditEvent.outcome` remains `success/denied/failure`. Conflicting reuse of an immutable event ID fails.

**Owner decision required:** Audit, State and authentication freeze expanded membership against actual producers. Lifecycle executor is controller-only. Agent/revision/ServicePrincipal execution and assurance need accepted runtime exports. Keep initiator, authorization principal, Driver, admission and operation causation distinct. Missing attribution is unresolved, uncertain execution unknown. Account/login facts keep their authentication transaction and subject. Disclosure and Installation-retention facts remain in the ledger without invented Agent subjects or lifecycle enums.

Exclude raw `resultData` and `PLUGIN_*` reasons. Audit and producers decide expansion.

## Authorization and policy

| Fixed role                      | Exact action and target                                   |
| ------------------------------- | --------------------------------------------------------- |
| `audit_reader`                  | `read_audit` on one exact Agent or Namespace-wide Agents. |
| `audit_retention_administrator` | Only `manage_audit_retention` on singleton Installation.  |

Add both actions to the common catalog/validator. Ordinary `read/operate/administer` implies neither. Personal/team Agents share the existing resource model. Ownership, membership, participation, deployment rights and known IDs confer no History access. Content remains separately authorized.

Installation `administer` grants/revokes these roles for existing identities/groups through [common policy administration](https://github.com/openclaw/openclaw-enterprise/pull/245). That proposal owns the selected Driver overloads: `bindPolicy(IAMPolicyReadTransactionTokenV1): Promise<IAMPolicyReadUnitV1>` and `bindPolicy(IAMPolicyWriteTransactionTokenV1): Promise<IAMPolicyUnitV1>`. OCC owns `readPolicy/applyChange/readPolicyOperation`.

The bounded atomic writer validates subjects/targets, owns IDs and commits bindings, policy revision, withdrawal intent, receipt and evidence in original State. Retain revoked-binding identity but exclude it from current authorization. Preserve the common writer's unknown-COMMIT recovery and last usable local administrator guard. Authentic retained Agent parentage permits grant/revoke/regrant after deletion only for fixed `audit_reader`, retaining exact filters. Caller parentage and ordinary-grant exceptions are forbidden.

Accept exports before composition and compile them. Unsupported transactional Drivers fail explicitly without Native fallback, another catalog/writer or remote mutation. Remote policy changes require a later IAM durable-intent and recovery contract with grant ceilings. A general access-management UI remains out of scope.

## History query and disclosure

![Proposed lifecycle from local acceptance through authorized History disclosure](request-lifecycle.svg)

Proposed lifecycle: time flows downward, solid arrows request, dashed arrows reply. [Mermaid source](request-lifecycle.mmd).

**Proposed HTTP:** `GET /namespaces/:namespaceId/agents/:agentId/history`. Authenticate each request and require current exact historical-Agent `read_audit`, without a live row. Use indexed `PlatformUnitOfWork.audit.queryAgentHistory`, its lifetime binder and adapters. Never filter unbounded `list()`.

Unexecuted illustration: reader C supplies one Namespace and Agent, optional filters and a limit after deployment. HTTP consumes the State query and returns a safe page only after disclosure commits. A revoked reader gets no page.

Proposed shapes require a serving adapter and HTTP policy:

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

Limit is an integer **1–100**. Time filters are lower-inclusive/upper-exclusive and require `from < before` when both exist. Events strictly descend by decimal-string bigint sequence. A window applies `sequence <= upperSequence` and `sequence < beforeSequence`, with `beforeSequence <= upperSequence`. Rows match scope and filters. Continuation keeps the original upper and last returned sequences, requires a nonempty page with last sequence greater than 1, and appears only if another matching row exists. Structural parsing cannot prove that row exists.

The public page is envelope `data`. A cursor requires a nonempty page and safe nonempty text of at most 4,096 UTF-8 bytes under proposed structural validation. API authentication binds the bounded versioned cursor to Installation, current principal, Driver, subject, normalized filters, original upper/last sequence and expiry. Bound validation work. It grants neither authority nor a snapshot, total count or Installation scan. Concurrent commits and retention can change later pages.

**Supplemental proposal:** HTTP default 50, cursor ceiling 4,096 bytes and 15-minute validity remain proposed query policy. Structural validation alone supplies neither that HTTP policy nor mutation-recovery validity.

### Disclosure transaction

Every page and exact recovery uses a short **READ COMMITTED State write transaction with IAM read-bound authorization**. Consume the [shared State/policy order](https://github.com/openclaw/openclaw-enterprise/pull/245):

1. Bind intent before resource locks. Acquire Installation authority, sorted required account/session guards, the complete native policy-table barrier/head, protected resources, then retention `FOR SHARE`.
2. Sample database time after locking. Resolve current [account authority](https://github.com/openclaw/openclaw-enterprise/pull/246) and selected-IAM authority, then select eligible evidence.
3. Reauthorize immediately before disclosure append. Release bytes only after acknowledged COMMIT.

No late policy upgrade. An earlier committed revoke prevents disclosure. Refused/unknown commit or dependency failure returns a sanitized error without a page. Released bytes cannot be recalled. Accept account guard and complete policy-barrier SQL, reviewing all participating writers.

**Owner decision required:** State/Audit/API must settle expiry crossing between post-lock sample and release for pages and recovery. Bound transactions and cancellation. Fail closed when the release rule cannot hold. Silent resampling and eligibility extension are not approved.

### Console and example

The view needs no configuration-read permission. A later CLI reuses this API. Use no-store responses, escaped DOM, request-ID errors and exit cancellation. Handle loading, empty, denied, error, pagination, stale responses and explicit unknown outcomes.

Safe empty page using the existing `data/meta` envelope and nominal request ID:

```json
{
  "data": { "events": [] },
  "meta": { "requestId": "req_00000000-0000-4000-8000-000000000001" }
}
```

Denial returns no event page. After `UNKNOWN_OUTCOME`, only exact observation can establish accepted evidence. Recovery envelope remains undecided.

## Mutation outcome recovery

Unknown COMMIT for `createAgent/updateAgent/deployAgent/stopAgent` returns **503 `UNKNOWN_OUTCOME`**, safe Namespace/Agent/event/operation IDs and a sealed reference. Observe through `GET /namespaces/:namespaceId/agents/:agentId/mutation-outcomes/:eventId`, supplying the reference in a dedicated header whose name is undecided.

Verify claims against every path and retained identity, original principal and selected Driver. Reauthorize the original primary action/target: Namespace Agent collection for create, exact Agent otherwise. Neither a live row nor `read_audit` is required. Indexed exact-event lookup uses the disclosure/restore gates.

`accepted` returns only bound action, operation/event/Agent and applicable revision IDs, proving local acceptance. Missing, expired, erased, unverifiable or uncertain evidence stays `unknown`, never rollback. Malformed input/denial exposes no facts and dependency errors are sanitized. Observation reveals no other history, configuration or provider data and creates no work. An explicit later mutation is new.

Required order:

1. After authentication, allocate audit ID and operation UUID before outer State. Carry server request ID through `AgentMutationContext`. Lifecycle owns Agent/revision IDs and deploy/stop work retains context.
2. Bind the accepted event to subject/resource, original primary target/action, initiator, Driver and operation/request. State prepares only from that transaction's appended event.
3. Seal the bounded purpose-specific reference before COMMIT. Preparation/sealing failure aborts. The original transaction owner drains/classifies COMMIT, suppresses unsafe compensation and preserves the reference through uncertainty. A signature proves no commit. If the entire response is lost before the caller receives the reference, this contract cannot recover it or authorize replay.

**Proposal, owner decision required:** composition/operators provision a shared purpose-specific key ring and choose the bounded envelope/header, finite validity, rotation and verifier retention, including indefinite records. Preserve restart/replica continuity, pre-distribute verifiers before signer rollover, separate cursor purpose and exclude references from logs/telemetry. Never borrow cursor lifetime. Account/policy receipts and durable invocation/reply fences retain independent owners and lifetimes across audit erasure.

## Security and failure

Protect historical facts, identities, authorization and recovery references, and retention metadata. References are not authority. Browser, Agent, model/tool, headers, provider and network cannot assert an owner's facts. Exclude raw details, credentials, custody handles, identity labels, issuer/subject claims, requests, plans, URLs, headers, commands, paths, prompts, responses, provider bodies and exceptions. A revision ID proves no Agent execution. Serialized assurance grants no authority.

New authority, privileged mutation, credential dispatch, retention changes and History disclosure require established local evidence before effects or bytes. New restrictive intent shares its original transaction. Already durably accepted protective work may continue during remote-delivery failure. Audit failure must not block safe refusal or closure. Such work cannot claim a new durable stop or revoke without local commit. Report append refusal, unknown COMMIT, storage pressure and overdue erasure through sanitized health without protected content or high-cardinality labels. Required operations fail closed if audit cannot commit.

Ordinary application roles cannot alter accepted facts. Local integrity provides no independent witnessing or protection against trusted producer, database or host administrator compromise. Live-ledger erasure does not certify independent copies. Search, client idempotency, replay, compensation, an operation journal and transaction-status API require a later selected use case with pre-response identity, deduplication and unknown-outcome proof. Future export needs acknowledgment, replay, custody and loss verification.

## Diagnostics

The optional file checkpoint uses an operator-owned OTLP receiver behind the filtered Collector, a pinned image, read-only configuration and mounted output. Development needs no Collector. Authentication, exact selected-IAM authorization, secret filtering and mandatory PostgreSQL audit stay in force. Add no log API, global logging mode or Agent file mount. Trusted Drivers retain `runtimeLogging: "driver"` pipelines.

Operators own file access, rotation, disk bounds, copies, cleanup and sink-failure handling. This best-effort sink cannot change API or audit outcomes. Logs are not History, trusted receipts, complete attribution, verified execution, retention guarantees or independent integrity. History cannot promote old logs to evidence.

### Diagnostic configuration

The overlay proposes `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OCC_DIAGNOSTIC_LOG_USER` (output-owner UID:GID) and `OCC_DIAGNOSTIC_LOG_DIRECTORY` (private absolute directory). Read-only receiver configuration writes `/out/logs.jsonl`, rotating at 10 MB with three backups and one-day retention. These settings do not set ledger retention.

## Verification and delivery

Each cumulative cut must build and pass applicable checks. Original owners deliver facts, State persistence/query, grants/currentness, lifecycle/recovery, retention/restore, API and console. Source slices may remain non-serving. Stretch requires accepted invocation/runtime and credential exports. Review supplier ancestry and final-tree equality. After writers stop, complete contract, documentation, SQL, security and independent integrated reviews of the final tree. Repeat reviews after repairs. Update references, generated API, guides and flows when behavior ships.

[Serving prerequisites](../31-basic-observability.md#implementation-and-verification) remain binding.

Prove create/update/deploy/stop, retry, supersession, rollback, unknown COMMIT, denial, revocation, pagination and secret exclusion across the connected lifecycle. Exercise personal and team grants, cross-scope denial and real account, Group and Restriction changes racing access and revocation. Verify privacy through real producers, storage, HTTP, diagnostics and health surfaces. Use limited-role concurrent PostgreSQL for post-deletion grant/revoke/regrant, lock order, expiry, restricted purge and restore without resurrection. Exercise API and browser disclosure only after acknowledged COMMIT. Verify installed restart, replicas, keys, sweeper and owned backup cleanup. Connected MVP acceptance also needs real model/GitHub and eligible content capture/read. The [stretch](repository-read.md#acceptance-and-delivery) adds A/B/C ordinary-Agent proof.

Record revisions, environment, results, refusals, cleanup and gaps for source/database, composed, installed, live-provider and release evidence. Draft [PR #424](https://github.com/openclaw/openclaw-enterprise/pull/424) is a non-serving Platform projection, not a qualified reader. Missing qualification does not imply implementation is absent. Checks remain future work.

## Session content boundary

Non-incognito session capture and backfill are selected connected MVP work. The content owner must provide a separate contract with OpenClaw/session, runtime/Compute, State, IAM and authentication. Audit or deploy permission does not grant content access. Native session-sharing restrictions apply by default. The configurable alternative awaits those owners' decisions on permission, account/session currentness, revocation, native deletion and copy/restore effects. Unsupported or unknown authority fails closed. Incognito is excluded.

Audit and eligible transcripts have independently configurable 90-day defaults and separate policy, custody, deletion and restore. The content contract must define stable source/store identity, eligible bounded reads, atomic batch and checkpoint, acknowledgment-loss reconciliation, producer retention, reset and gaps, restart/restore and authorized disclosure. State what survives a crash or producer deletion, what is irretrievably lost and who acts next. Do not reconstruct missing content or invent a source API. Acceptance exercises actual capture/backfill and reader crash, gaps, eligibility, current access and replay-safe recovery or explicit unresolved state.

## References

[Platform design](https://github.com/openclaw/openclaw-enterprise/blob/e4a807e785e1a242e27200c8e8396f58136cbbc6/docs/design.md) · [Common IAM proposal](https://github.com/openclaw/openclaw-enterprise/pull/245) · [Account authority proposal](https://github.com/openclaw/openclaw-enterprise/pull/246) · [Retention contract](retention.md)
