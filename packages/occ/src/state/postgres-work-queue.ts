import { isNonEmptyString, isPositiveSafeInteger } from "@openclaw-enterprise/utils";
import { createHash, randomUUID } from "node:crypto";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import {
  CREDENTIAL_WITHDRAWAL_TARGET,
  nonempty,
  safeFailureCode,
  validateFailureData,
  validateSuccessResultData,
  type ClaimedWork,
  type ControllerWork,
  type ControllerWorkAttempt,
  type ControllerWorkKind,
  type ControllerWorkState,
  type DeferredWork,
  type EnqueueWork,
  type PermanentFailure,
  type RetryableFailure,
  type WorkClaim,
  type WorkResult,
} from "./controller-work.ts";

export type {
  ClaimedWork,
  ControllerWork,
  ControllerWorkState,
  EnqueueWork,
  PermanentFailure,
  RetryableFailure,
  WorkClaim,
  WorkResult,
} from "./controller-work.ts";
import type { RepositoryRevisionOwner } from "../ports/repository-sessions.ts";

export interface PostgresQueryClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface ClaimRequest {
  readonly claimToken?: string;
}

export interface RecoveryRequest {
  readonly limit?: number;
}

export interface RecoverySummary {
  readonly recovered: number;
  readonly requeued: number;
  readonly failedPermanent: number;
  readonly exhaustedQueued: number;
  /** The work this pass failed permanently, for follow-up the worker owns. */
  readonly failed: readonly ControllerWork[];
}

export interface PostgresWorkQueueOptions {
  readonly maxAttempts?: number;
  readonly leaseDurationMs?: number;
  readonly claimRaceRetries?: number;
  readonly random?: () => number;
  readonly workKind?: "all" | "namespace";
}

interface WorkRow {
  readonly work_kind: ControllerWorkKind | null;
  readonly idempotency_key: string;
  readonly namespace_id: string;
  readonly agent_id: string | null;
  readonly revision_id: string | null;
  readonly actor_id: string;
  readonly namespace_target: "ready" | "deleted" | null;
  readonly agent_target:
    "stopped" | "deleted" | "provisioned" | typeof CREDENTIAL_WITHDRAWAL_TARGET | null;
  readonly state: ControllerWorkState;
  readonly available_at: Date | string;
  readonly attempt_count: number;
  readonly claim_token: string | null;
  readonly lease_expires_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly reason_code: string | null;
  readonly result_data: Record<string, unknown> | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const MAX_BACKOFF_MS = 300_000;
export const PENDING_WORK_PREDICATE = "state IN ('queued', 'claimed')";
const INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_RECOVERY_LIMIT = 100;
const MAX_RECOVERY_LIMIT = 1_000;
const CLAIM_RACE_CODES = new Set(["23505", "40001", "40P01"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_ID_PATTERN =
  "rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const REPOSITORY_CLEANUP_KEY = new RegExp(
  `^agent_revision:(${REVISION_ID_PATTERN}):repository_cleanup:(retire:)?[0-9a-f]{64}$`,
);
const MAINTENANCE_KEY = new RegExp(
  `^agent_revision:(${REVISION_ID_PATTERN}):maintenance:(0|[1-9][0-9]*)$`,
);
const REVISION_RECONCILE_KEY = new RegExp(`^agent_revision:${REVISION_ID_PATTERN}:reconcile$`);
/** Recovery evidence that a published deployment got its one extra attempt. */
const ACTIVE_REVISION_RECOVERY = "ACTIVE_REVISION_RECOVERY";

/** Cleanup dispatch and retry exemption require an exact immutable revision target. */
export function repositoryCleanupRevisionId(
  work: Pick<ControllerWork, "idempotencyKey" | "namespaceTarget" | "agentTarget">,
): string | undefined {
  if (work.namespaceTarget !== undefined || work.agentTarget !== undefined) {
    return undefined;
  }
  const key = REPOSITORY_CLEANUP_KEY.exec(work.idempotencyKey);
  return key?.[0] === work.idempotencyKey ? key[1] : undefined;
}

export function isRepositoryCleanupWork(
  work: Pick<
    ControllerWork,
    "idempotencyKey" | "agentId" | "revisionId" | "namespaceTarget" | "agentTarget"
  >,
): boolean {
  const revisionId = repositoryCleanupRevisionId(work);
  return (
    revisionId !== undefined &&
    ((work.revisionId === revisionId && isNonEmptyString(work.agentId)) ||
      (work.revisionId === undefined && work.agentId === undefined))
  );
}

/** Runtime retirement is distinct from session-only repair and rotation cleanup. */
export function isRepositoryRuntimeRetirementWork(
  work: Parameters<typeof isRepositoryCleanupWork>[0],
): boolean {
  return (
    isRepositoryCleanupWork(work) &&
    REPOSITORY_CLEANUP_KEY.exec(work.idempotencyKey)?.[2] === "retire:"
  );
}

function repositoryCleanupSql(alias: string): string {
  return `(${alias}.namespace_target IS NULL AND ${alias}.agent_target IS NULL
    AND (
      (${alias}.agent_id IS NOT NULL
        AND ${alias}.revision_id IS NOT NULL
        AND ${alias}.revision_id ~ '^${REVISION_ID_PATTERN}$'
        AND ${alias}.idempotency_key ~
          ('^agent_revision:' || ${alias}.revision_id || ':repository_cleanup:(retire:)?[0-9a-f]{64}$'))
      OR (${alias}.agent_id IS NULL
        AND ${alias}.revision_id IS NULL
        AND ${alias}.idempotency_key ~
          '^agent_revision:${REVISION_ID_PATTERN}:repository_cleanup:(retire:)?[0-9a-f]{64}$')
    ))`;
}

// Keep the creating source actor for audit attribution. Only lifecycle columns
// are writable by occ_app; an owner collision must roll back the transfer.
const CLEANUP_CONFLICT_SQL = `
  ON CONFLICT (idempotency_key) DO UPDATE
  SET attempt_count = CASE
        WHEN controller_work.namespace_id = EXCLUDED.namespace_id
          AND controller_work.agent_id = EXCLUDED.agent_id
          AND controller_work.revision_id = EXCLUDED.revision_id
          AND controller_work.namespace_target IS NULL
          AND controller_work.agent_target IS NULL
          AND controller_work.state <> 'failed_permanent'
        THEN controller_work.attempt_count ELSE -1
      END,
      state = CASE WHEN controller_work.state = 'succeeded' THEN 'queued'
        ELSE controller_work.state END,
      completed_at = CASE WHEN controller_work.state = 'succeeded' THEN NULL
        ELSE controller_work.completed_at END,
      reason_code = CASE WHEN controller_work.state = 'succeeded' THEN NULL
        ELSE controller_work.reason_code END,
      result_data = CASE WHEN controller_work.state = 'succeeded' THEN NULL
        ELSE controller_work.result_data END,
      available_at = CASE WHEN controller_work.state = 'succeeded' THEN clock_timestamp()
        ELSE controller_work.available_at END,
      updated_at = clock_timestamp()`;

function transferRepositoryCleanupSql(continuingRevision = "false"): string {
  return `
    cleanup_sources AS MATERIALIZED (
      SELECT * FROM transitioned AS source
      WHERE source.state = 'failed_permanent'
        AND NOT ${repositoryCleanupSql("source")}
        AND NOT (${continuingRevision})
    ), cleanup_namespaces AS MATERIALIZED (
      SELECT namespace.id, namespace.status
      FROM occ.namespaces AS namespace
      WHERE EXISTS (
        SELECT 1 FROM cleanup_sources AS source WHERE source.namespace_id = namespace.id
      )
      ORDER BY namespace.id
      FOR UPDATE OF namespace
    ), cleanup_agents AS MATERIALIZED (
      SELECT agent.namespace_id, agent.id, agent.status, agent.desired_runtime_state
      FROM occ.agents AS agent
      JOIN cleanup_namespaces AS namespace ON namespace.id = agent.namespace_id
      WHERE EXISTS (
        SELECT 1 FROM cleanup_sources AS source
        WHERE source.namespace_id = agent.namespace_id
          AND (source.agent_id = agent.id OR source.namespace_target = 'deleted')
      )
      ORDER BY agent.namespace_id, agent.id
      FOR UPDATE OF agent
    ), cleanup_revisions AS MATERIALIZED (
      SELECT source.idempotency_key AS source_key, source.actor_id,
        revision.namespace_id, revision.agent_id, revision.id AS revision_id,
        (source.revision_id = revision.id
          AND revision.admitted_spec->'repository_credentials' IS NOT NULL) AS retire_runtime,
        (source.revision_id IS NOT NULL OR
          (source.agent_target = 'stopped' AND agent.desired_runtime_state = 'stopped') OR
          (source.agent_target = 'deleted' AND agent.status = 'deleting'
            AND agent.desired_runtime_state = 'stopped'))
          AS close_live
      FROM cleanup_sources AS source
      JOIN occ.agent_revisions AS revision ON revision.namespace_id = source.namespace_id
      JOIN cleanup_agents AS agent
        ON agent.namespace_id = revision.namespace_id AND agent.id = revision.agent_id
      JOIN cleanup_namespaces AS namespace ON namespace.id = source.namespace_id
      -- Credential withdrawal work (agent_target = 'credentials_withdrawn', see
      -- CREDENTIAL_WITHDRAWAL_TARGET) leaves its active revision running, so it owns no cleanup.
      WHERE (source.revision_id = revision.id AND source.agent_id = revision.agent_id
          AND source.agent_target IS NULL)
        OR (source.agent_target = 'stopped' AND source.revision_id IS NULL
          AND source.agent_id = revision.agent_id AND revision.admitted_at <= source.created_at)
        OR (source.agent_target = 'deleted' AND source.revision_id IS NULL
          AND source.agent_id = revision.agent_id AND agent.status = 'deleting'
          AND agent.desired_runtime_state = 'stopped' AND revision.admitted_at <= source.created_at)
        OR (source.namespace_target = 'deleted' AND source.agent_id IS NULL
          AND source.revision_id IS NULL AND namespace.status = 'deleting'
          AND revision.admitted_at <= source.created_at)
    ), locked_attempts AS MATERIALIZED (
      SELECT attempt.admission_id
      FROM occ.repository_session_attempts AS attempt
      WHERE EXISTS (
        SELECT 1 FROM cleanup_revisions AS revision
        WHERE attempt.namespace_id = revision.namespace_id
          AND attempt.agent_id = revision.agent_id AND attempt.revision_id = revision.revision_id
      )
      ORDER BY attempt.namespace_id, attempt.agent_id, attempt.revision_id, attempt.admission_id
      FOR UPDATE OF attempt
    ), closing_attempts AS (
      UPDATE occ.repository_session_attempts AS attempt
      SET phase = 'closing', updated_at = GREATEST(clock_timestamp(), attempt.updated_at)
      FROM cleanup_revisions AS revision
      WHERE revision.close_live
        AND attempt.namespace_id = revision.namespace_id
        AND attempt.agent_id = revision.agent_id AND attempt.revision_id = revision.revision_id
        AND attempt.admission_id IN (SELECT admission_id FROM locked_attempts)
        AND attempt.phase IN ('opening', 'open')
      RETURNING attempt.namespace_id, attempt.agent_id, attempt.revision_id
    ), cleanup_obligations AS (
      SELECT namespace_id, agent_id, revision_id FROM closing_attempts
      UNION
      SELECT attempt.namespace_id, attempt.agent_id, attempt.revision_id
      FROM occ.repository_session_attempts AS attempt
      JOIN cleanup_revisions AS revision
        ON attempt.namespace_id = revision.namespace_id AND attempt.agent_id = revision.agent_id
        AND attempt.revision_id = revision.revision_id
      WHERE attempt.phase IN ('closing', 'invalidated')
    ), cleanup_inserted AS (
      INSERT INTO occ.controller_work (
        idempotency_key, namespace_id, agent_id, revision_id, actor_id,
        namespace_target, agent_target, state, available_at, attempt_count, created_at, updated_at
      )
      SELECT DISTINCT ON (revision.namespace_id, revision.agent_id, revision.revision_id,
        COALESCE(revision.retire_runtime, false))
        'agent_revision:' || revision.revision_id || ':repository_cleanup:' ||
          CASE WHEN revision.retire_runtime THEN 'retire:' ELSE '' END ||
          encode(sha256(convert_to(revision.revision_id, 'UTF8')), 'hex'),
        revision.namespace_id, revision.agent_id, revision.revision_id, revision.actor_id,
        NULL, NULL, 'queued', statement_timestamp(), 0, statement_timestamp(), statement_timestamp()
      FROM cleanup_revisions AS revision
      LEFT JOIN cleanup_obligations AS obligation
        ON obligation.namespace_id = revision.namespace_id AND obligation.agent_id = revision.agent_id
        AND obligation.revision_id = revision.revision_id
      WHERE revision.retire_runtime OR obligation.revision_id IS NOT NULL
      ORDER BY revision.namespace_id, revision.agent_id, revision.revision_id,
        COALESCE(revision.retire_runtime, false), revision.source_key
      ${CLEANUP_CONFLICT_SQL}
      RETURNING idempotency_key
    ),`;
}

// Recovery counterpart of fail(..., { continuingRevision: true }): an exhausted
// maintenance item of the active running revision whose worker lost its lease
// (crash or restart) must not retire that runtime or end its maintenance
// chain. The same holds for the revision's own deployment (`:reconcile`) when its
// worker lost the lease after publishing the active pointer: see
// RECOVERING_ACTIVATIONS_SQL. `candidates` holds locked work keys; `$2` is
// maxAttempts. Locks follow the cleanup transfer's order (Namespace, then Agent).
function continuingMaintenanceSql(candidates: string): string {
  return `
    continuing_sources AS MATERIALIZED (
      SELECT work.idempotency_key, work.namespace_id, work.agent_id, work.revision_id
      FROM occ.controller_work AS work
      JOIN ${candidates} AS candidate ON candidate.idempotency_key = work.idempotency_key
      WHERE work.attempt_count >= $2::integer
        AND work.namespace_target IS NULL AND work.agent_target IS NULL
        AND work.agent_id IS NOT NULL AND work.revision_id IS NOT NULL
        AND (work.idempotency_key ~
            ('^agent_revision:' || work.revision_id || ':maintenance:(0|[1-9][0-9]*)$')
          OR work.idempotency_key = 'agent_revision:' || work.revision_id || ':reconcile')
    ), continuing_namespaces AS MATERIALIZED (
      SELECT namespace.id, namespace.status, namespace.deleted_at
      FROM occ.namespaces AS namespace
      WHERE namespace.id IN (SELECT namespace_id FROM continuing_sources)
      ORDER BY namespace.id
      FOR UPDATE OF namespace
    ), continuing_agents AS MATERIALIZED (
      SELECT agent.namespace_id, agent.id, agent.active_revision_id, agent.desired_runtime_state
      FROM occ.agents AS agent
      WHERE (agent.namespace_id, agent.id) IN (
        SELECT namespace_id, agent_id FROM continuing_sources
      )
      ORDER BY agent.namespace_id, agent.id
      FOR UPDATE OF agent
    ), continuing_maintenance AS MATERIALIZED (
      SELECT source.idempotency_key
      FROM continuing_sources AS source
      JOIN continuing_agents AS agent
        ON agent.namespace_id = source.namespace_id AND agent.id = source.agent_id
        AND agent.active_revision_id = source.revision_id
      JOIN occ.agent_revisions AS revision
        ON revision.namespace_id = agent.namespace_id AND revision.agent_id = agent.id
        AND revision.id = agent.active_revision_id
      JOIN continuing_namespaces AS namespace ON namespace.id = agent.namespace_id
      WHERE agent.desired_runtime_state = 'running'
        AND namespace.status = 'ready' AND namespace.deleted_at IS NULL
        AND (revision.admitted_spec->'repository_credentials' IS NULL OR
          (revision.admitted_spec #>> '{repository_credentials,deadlineWallMs}')::bigint >
            EXTRACT(EPOCH FROM clock_timestamp()) * 1000)
    ),`;
}

// Enqueue the next maintenance bucket for each continued item, deferred by the
// maximum retry backoff (`delayParameter`, in milliseconds). The worker derives
// later buckets from this key, so the chain stays strictly increasing.
function continueMaintenanceSql(delayParameter: string): string {
  return `
    continued_maintenance AS (
      INSERT INTO occ.controller_work (
        idempotency_key, namespace_id, agent_id, revision_id, actor_id,
        namespace_target, agent_target, state, available_at, attempt_count, created_at, updated_at
      )
      SELECT 'agent_revision:' || source.revision_id || ':maintenance:' ||
          (substring(source.idempotency_key from ':maintenance:([0-9]+)$')::numeric + 1)::text,
        source.namespace_id, source.agent_id, source.revision_id, source.actor_id,
        NULL, NULL, 'queued',
        clock_timestamp() + ${delayParameter}::double precision * interval '1 millisecond',
        0, clock_timestamp(), clock_timestamp()
      FROM transitioned AS source
      WHERE source.state = 'failed_permanent'
        AND source.idempotency_key ~ ':maintenance:(0|[1-9][0-9]*)$'
        AND source.idempotency_key IN (SELECT idempotency_key FROM continuing_maintenance)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key
    ),`;
}

const CONTINUING_MAINTENANCE_SOURCE_SQL =
  "source.idempotency_key IN (SELECT idempotency_key FROM continuing_maintenance)";

// A deployment whose worker lost its lease on the last counted attempt after publishing the
// active pointer has an active, running revision but has not activated it, retired its
// predecessors, or completed. Failing it would report a failed deployment for the active
// revision. Recovery instead requeues it once with one more attempt, so a worker finishes it
// through the already-active path; ACTIVE_REVISION_RECOVERY evidence bounds this to once per
// deployment, after which an expired claim fails without retiring the active runtime.
// Requires continuingMaintenanceSql; the evidence lookup matches audit_events_work_attempt_idx.
const RECOVERING_ACTIVATIONS_SQL = `
    recovering_activations AS MATERIALIZED (
      SELECT work.idempotency_key
      FROM occ.controller_work AS work
      JOIN continuing_maintenance AS continuing
        ON continuing.idempotency_key = work.idempotency_key
      WHERE work.idempotency_key = 'agent_revision:' || work.revision_id || ':reconcile'
        AND NOT EXISTS (
          SELECT 1 FROM occ.audit_events AS prior
          WHERE prior.kind = 'mutation' AND prior.action = 'reconcile'
            AND prior.resource_kind = 'agent_revision'
            AND prior.details->>'workId' = work.idempotency_key
            AND prior.namespace_id = work.namespace_id
            AND prior.occurred_at >= work.created_at
            AND prior.details->>'reasonCode' = '${ACTIVE_REVISION_RECOVERY}'
        )
    ),`;

// A deployment that waits to stop its refused candidate (REFUSED_CANDIDATE_STOP_PENDING) has no
// deadline or attempt limit, since the candidate may still serve. A claim lost during that wait,
// typically a controller restart while the stop blocks, refunds its attempt like the wait's own
// deferrals, so restarts cannot end the work LEASE_EXPIRED with the candidate running and the
// refusal unrecorded (finding 1010). The recovery evidence keeps the refusal, so later losses
// still match. An active revision is excluded: its refused stop never runs.
// Requires RECOVERING_ACTIVATIONS_SQL; the lookup matches audit_events_work_attempt_idx.
const RECOVERING_REFUSED_STOPS_SQL = `
    recovering_refused_stops AS MATERIALIZED (
      SELECT work.idempotency_key, latest.refusal
      FROM occ.controller_work AS work
      JOIN candidates AS candidate ON candidate.idempotency_key = work.idempotency_key
      CROSS JOIN LATERAL (
        SELECT prior.details->>'reasonCode' AS reason_code, prior.details->>'refusal' AS refusal
        FROM occ.audit_events AS prior
        WHERE prior.kind = 'mutation' AND prior.action = 'reconcile'
          AND prior.resource_kind = 'agent_revision'
          AND prior.details->>'workId' = work.idempotency_key
          AND prior.namespace_id = work.namespace_id
          AND prior.actor_id = work.actor_id
          AND prior.occurred_at >= work.created_at
        ORDER BY prior.occurred_at DESC, prior.id DESC
        LIMIT 1
      ) AS latest
      WHERE work.namespace_target IS NULL AND work.agent_target IS NULL
        AND work.agent_id IS NOT NULL AND work.revision_id IS NOT NULL
        AND work.idempotency_key = 'agent_revision:' || work.revision_id || ':reconcile'
        AND latest.reason_code IN ('REFUSED_CANDIDATE_STOP_PENDING', 'LEASE_EXPIRED')
        AND latest.refusal IS NOT NULL
        AND work.idempotency_key NOT IN (SELECT idempotency_key FROM recovering_activations)
        AND NOT EXISTS (
          SELECT 1 FROM occ.agents AS agent
          WHERE agent.namespace_id = work.namespace_id AND agent.id = work.agent_id
            AND agent.active_revision_id = work.revision_id
        )
    ),`;

export class WorkClaimLostError extends Error {
  constructor() {
    super("The controller work claim is missing, expired, or owned by another worker.");
    this.name = "WorkClaimLostError";
  }
}

function positiveInteger(value: number, name: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new ScopeViolationError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ScopeViolationError("The controller work contains an invalid timestamp.");
  }
  return date;
}

function asRow(value: unknown): WorkRow {
  if (typeof value !== "object" || value === null) {
    throw new ScopeViolationError("PostgreSQL returned an invalid controller work row.");
  }
  return value as WorkRow;
}

export function asWork(value: unknown): ControllerWork {
  const row = asRow(value);
  return Object.freeze({
    kind: row.work_kind ?? "lifecycle",
    idempotencyKey: row.idempotency_key,
    namespaceId: row.namespace_id,
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    ...(row.revision_id === null ? {} : { revisionId: row.revision_id }),
    actorId: row.actor_id,
    ...(row.namespace_target === null ? {} : { namespaceTarget: row.namespace_target }),
    ...(row.agent_target === null || row.agent_target === undefined
      ? {}
      : { agentTarget: row.agent_target }),
    state: row.state,
    availableAt: asDate(row.available_at),
    attemptCount: row.attempt_count,
    ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: asDate(row.lease_expires_at) }),
    ...(row.completed_at === null ? {} : { completedAt: asDate(row.completed_at) }),
    ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
    ...(row.result_data === null ? {} : { resultData: Object.freeze({ ...row.result_data }) }),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  });
}

function asClaimedWork(value: unknown): ClaimedWork {
  const work = asWork(value);
  if (
    work.state !== "claimed" ||
    work.claimToken === undefined ||
    work.leaseExpiresAt === undefined
  ) {
    throw new ScopeViolationError("PostgreSQL returned an invalid claimed controller work row.");
  }
  return Object.freeze({
    ...work,
    state: "claimed" as const,
    claimToken: work.claimToken,
    leaseExpiresAt: work.leaseExpiresAt,
  });
}

function validateClaim(claim: WorkClaim): void {
  nonempty(claim.idempotencyKey, "Controller work idempotency key");
  if (!UUID_V4.test(claim.claimToken)) {
    throw new ScopeViolationError("The controller work claim token must be a version 4 UUID.");
  }
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

// Recovery has no worker finalization step; publish provisioning failure in
// the same statement as terminal work and its attributable audit evidence.
const FAIL_EXHAUSTED_NAMESPACES_SQL = `
  failed_namespaces AS (
    UPDATE occ.namespaces AS namespace
    SET status = 'failed'
    FROM transitioned
    WHERE namespace.id = transitioned.namespace_id
      AND namespace.status = 'provisioning'
      AND namespace.deleted_at IS NULL
      AND transitioned.namespace_target = 'ready'
      AND transitioned.state = 'failed_permanent'
    RETURNING namespace.id
  )`;

/**
 * Queue transitions append `reconcile` evidence in the same statement. `filter` narrows which
 * transitioned rows get a row; it is appended to the evidence SELECT's WHERE clause. A failure
 * that ends the work item (`failed_permanent`) also carries `final: true`, so it differs from a
 * retry with the same reason code.
 * `reasonCode` and `details` are raw SQL expressions: pass parameters or constants, never input.
 * `details` (a jsonb expression) adds fields to the evidence details.
 */
const insertEvidenceCteSql = (filter = "", reasonCode = "$4::text", details = "'{}'::jsonb") => `
  evidence_targets AS (
    SELECT transitioned.*,
      CASE WHEN ${repositoryCleanupSql("transitioned")} THEN
        substring(
          transitioned.idempotency_key
          from '^agent_revision:(${REVISION_ID_PATTERN}):repository_cleanup:(retire:)?[0-9a-f]{64}$'
        )
      END AS repository_cleanup_revision_id
    FROM transitioned
  ), evidence AS (
    INSERT INTO occ.audit_events (
      id, occurred_at, kind, actor_id, action, namespace_id,
      resource_kind, resource_id, outcome, details
    )
    SELECT
      'aud_' || gen_random_uuid()::text,
      clock_timestamp(),
      'mutation',
      transitioned.actor_id,
      'reconcile',
      transitioned.namespace_id,
      CASE
        WHEN transitioned.revision_id IS NOT NULL
          OR transitioned.repository_cleanup_revision_id IS NOT NULL THEN 'agent_revision'
        WHEN transitioned.agent_id IS NOT NULL THEN 'agent'
        ELSE 'namespace'
      END,
      COALESCE(
        transitioned.revision_id,
        transitioned.repository_cleanup_revision_id,
        transitioned.agent_id,
        transitioned.namespace_id
      ),
      $3::text,
      jsonb_build_object('reasonCode', ${reasonCode}, 'attemptCount', transitioned.attempt_count,
        'workId', transitioned.idempotency_key)
        || CASE WHEN transitioned.state = 'failed_permanent'
             THEN jsonb_build_object('final', true) ELSE '{}'::jsonb END
        || ${details}
    FROM evidence_targets AS transitioned
    WHERE true ${filter}
    RETURNING id
  )`;
const INSERT_EVIDENCE_CTE_SQL = insertEvidenceCteSql();
const INSERT_EVIDENCE_SQL = `${INSERT_EVIDENCE_CTE_SQL}
  SELECT transitioned.* FROM transitioned`;
/**
 * A deployment waiting for its runtime defers every few seconds with the same code. Only a
 * change is recorded: a deferral whose outcome and reason code match the latest evidence for the
 * same revision work item adds no row. Retries, failures, and completions are always recorded.
 * The lookup matches the `audit_events_work_attempt_idx` partial index, which covers revision
 * work only; other callers that know a deferral repeats one already recorded pass `$9` false.
 * `$11` true records a repeat too, so its time shows the work is still retrying; `$10` names the
 * refusal a refused-candidate stop waits to publish, and `$12` marks a stop that yielded.
 */
const INSERT_DEFER_EVIDENCE_SQL = `${insertEvidenceCteSql(
  `
      AND $9::boolean
      AND ($11::boolean OR NOT EXISTS (
        SELECT 1 FROM (
          SELECT prior.outcome, prior.details->>'reasonCode' AS reason_code
          FROM occ.audit_events AS prior
          WHERE prior.kind = 'mutation' AND prior.action = 'reconcile'
            AND prior.resource_kind = 'agent_revision'
            AND prior.details->>'workId' = transitioned.idempotency_key
            AND prior.namespace_id = transitioned.namespace_id
            AND prior.actor_id = transitioned.actor_id
            AND prior.occurred_at >= transitioned.created_at
          ORDER BY prior.occurred_at DESC, prior.id DESC
          LIMIT 1
        ) AS latest
        WHERE latest.outcome = $3::text AND latest.reason_code = $4::text
      ))`,
  "$4::text",
  `CASE WHEN $10::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('refusal', $10::text) END
     || CASE WHEN $12::boolean THEN jsonb_build_object('stopYielded', true) ELSE '{}'::jsonb END`,
)}
  SELECT transitioned.* FROM transitioned`;
const SETTLE_PROVISIONING_FAILURE_SQL = `
  settled_provisioning_failures AS (
    UPDATE occ.agent_provisioning_work AS provisioning
    SET status = 'failed',
        updated_at = clock_timestamp()
    FROM transitioned
    WHERE provisioning.work_id = transitioned.idempotency_key
      AND transitioned.work_kind = 'provisioning'
      AND transitioned.state = 'failed_permanent'
      AND provisioning.status NOT IN ('failed', 'succeeded', 'cancelled')
    RETURNING provisioning.work_id
  ),`;

/**
 * A repository is scoped to one query client. Supplying an already checked-out
 * transaction client lets enqueue join its resource/audit unit of work. Queue
 * lifecycle transitions emit attributable evidence in the same SQL statement,
 * so standalone pool queries remain atomic without holding a transaction open.
 */
export class PostgresWorkQueue {
  private readonly client: PostgresQueryClient;
  private readonly maxAttempts: number;
  private readonly leaseDurationMs: number;
  private readonly claimRaceRetries: number;
  private readonly random: () => number;
  private readonly workKind: "all" | "namespace";

  constructor(client: PostgresQueryClient, options: PostgresWorkQueueOptions = {}) {
    this.client = client;
    this.maxAttempts = positiveInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "Maximum controller work attempts",
    );
    this.leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "Controller work lease duration",
    );
    this.claimRaceRetries = positiveInteger(
      options.claimRaceRetries ?? 3,
      "Maximum controller work claim races",
    );
    this.random = options.random ?? Math.random;
    this.workKind = options.workKind ?? "all";
    if (this.workKind !== "all" && this.workKind !== "namespace") {
      throw new ScopeViolationError("The controller work kind must be all or namespace.");
    }
  }

  async enqueue(input: EnqueueWork): Promise<ControllerWork> {
    const idempotencyKey = nonempty(input.idempotencyKey, "Controller work idempotency key");
    const kind = input.kind ?? "lifecycle";
    if (kind !== "lifecycle" && kind !== "provisioning") {
      throw new ScopeViolationError("Controller work requires a supported kind.");
    }
    if (idempotencyKey.length > 512) {
      throw new ScopeViolationError("The controller work idempotency key exceeds 512 characters.");
    }
    if (/^agent_revision:.*:repository_cleanup(?::|$)/.test(idempotencyKey)) {
      throw new ScopeViolationError("Repository cleanup work requires an owned cleanup transfer.");
    }
    const namespaceId = nonempty(input.namespaceId, "Controller work Namespace ID");
    const actorId = nonempty(input.actorId, "Controller work actor ID");
    const agentId =
      input.agentId === undefined ? null : nonempty(input.agentId, "Controller work Agent ID");
    const revisionId =
      input.revisionId === undefined
        ? null
        : nonempty(input.revisionId, "Controller work revision ID");
    // A revision still requires its owning Agent, but the converse no longer
    // holds: Agent teardown is Agent-scoped and names no single revision.
    if (revisionId !== null && agentId === null) {
      throw new ScopeViolationError(
        "Controller work revisions require both their exact owning Agent and revision.",
      );
    }
    const namespaceTarget = input.namespaceTarget ?? null;
    const agentTarget = input.agentTarget ?? null;
    if (
      kind === "lifecycle" &&
      ((agentId === null &&
        (revisionId !== null ||
          (namespaceTarget !== "ready" && namespaceTarget !== "deleted") ||
          agentTarget !== null)) ||
        (agentId !== null &&
          revisionId === null &&
          (namespaceTarget !== null || (agentTarget !== "stopped" && agentTarget !== "deleted"))) ||
        (revisionId !== null &&
          (namespaceTarget !== null ||
            (agentTarget !== null && agentTarget !== CREDENTIAL_WITHDRAWAL_TARGET))))
    ) {
      throw new ScopeViolationError(
        "Controller work requires one exact Namespace, Agent, or revision target shape.",
      );
    }
    if (
      kind === "provisioning" &&
      (agentId !== null || revisionId !== null || namespaceTarget !== null || agentTarget !== null)
    ) {
      throw new ScopeViolationError("Provisioning work requires one exact Namespace target.");
    }
    const availableAt = input.availableAt === undefined ? null : asDate(input.availableAt);

    const inserted = await this.client.query(
      `INSERT INTO occ.controller_work (
         work_kind, idempotency_key, namespace_id, agent_id, revision_id, actor_id, namespace_target,
         agent_target,
         state, available_at, attempt_count, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         'queued', COALESCE($9::timestamptz, clock_timestamp()), 0,
         clock_timestamp(), clock_timestamp()
       )
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        kind,
        idempotencyKey,
        namespaceId,
        agentId,
        revisionId,
        actorId,
        namespaceTarget,
        agentTarget,
        availableAt,
      ],
    );

    if (inserted.rows[0] !== undefined) {
      return asWork(inserted.rows[0]);
    }

    const existing = await this.client.query(
      `SELECT *,
          namespace_id IS DISTINCT FROM $2::text
          OR agent_id IS DISTINCT FROM $3::text
          OR revision_id IS DISTINCT FROM $4::text
          OR actor_id IS DISTINCT FROM $5::text
          OR work_kind IS DISTINCT FROM $6::text AS owner_conflict,
          namespace_target IS DISTINCT FROM $7::text
          OR agent_target IS DISTINCT FROM $8::text AS target_conflict
       FROM occ.controller_work
       WHERE idempotency_key = $1`,
      [
        idempotencyKey,
        namespaceId,
        agentId,
        revisionId,
        actorId,
        kind,
        namespaceTarget,
        agentTarget,
      ],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      throw new ResourceConflictError("The existing controller work could not be verified.");
    }
    if (
      (row as WorkRow & { owner_conflict: boolean; target_conflict: boolean }).owner_conflict ||
      (row as WorkRow & { owner_conflict: boolean; target_conflict: boolean }).target_conflict
    ) {
      throw new ResourceConflictError(
        "The controller work idempotency key already belongs to another owner or actor.",
      );
    }
    return asWork(row);
  }

  async enqueueRepositoryCleanup(
    claim: WorkClaim,
    owner: RepositoryRevisionOwner,
    purpose: "sessions" | "terminal-runtime" = "sessions",
  ): Promise<ControllerWork | undefined> {
    validateClaim(claim);
    const revisionId = nonempty(owner.revisionId, "Repository cleanup revision ID");
    if (revisionId.length !== 40 || !new RegExp(`^${REVISION_ID_PATTERN}$`).test(revisionId)) {
      throw new ScopeViolationError("Repository cleanup requires an exact revision ID.");
    }
    if (purpose !== "sessions" && purpose !== "terminal-runtime") {
      throw new ScopeViolationError("Repository cleanup requires a supported purpose.");
    }
    const retireRuntime = purpose === "terminal-runtime";
    const key = `agent_revision:${revisionId}:repository_cleanup:${retireRuntime ? "retire:" : ""}${createHash(
      "sha256",
    )
      .update(revisionId, "utf8")
      .digest("hex")}`;
    const result = await this.client.query(
      `WITH source AS MATERIALIZED (
         SELECT * FROM occ.controller_work AS work
         WHERE work.idempotency_key = $1 AND work.claim_token = $2::uuid
           AND work.state = 'claimed' AND work.lease_expires_at > clock_timestamp()
         FOR UPDATE OF work
       ), namespace_owner AS MATERIALIZED (
         SELECT namespace.id, namespace.status
         FROM occ.namespaces AS namespace JOIN source ON source.namespace_id = namespace.id
         FOR UPDATE OF namespace
       ), agent_owner AS MATERIALIZED (
         SELECT agent.* FROM occ.agents AS agent
         JOIN namespace_owner AS namespace ON namespace.id = agent.namespace_id
         WHERE agent.namespace_id = $3 AND agent.id = $4
         FOR UPDATE OF agent
       ), owner AS MATERIALIZED (
         SELECT revision.namespace_id, revision.agent_id, revision.id AS revision_id
         FROM occ.agent_revisions AS revision
         JOIN agent_owner AS agent
           ON agent.namespace_id = revision.namespace_id AND agent.id = revision.agent_id
         JOIN namespace_owner AS namespace ON namespace.id = revision.namespace_id
         JOIN source ON source.namespace_id = revision.namespace_id
         LEFT JOIN occ.agent_revisions AS source_revision
           ON source_revision.namespace_id = source.namespace_id
           AND source_revision.agent_id = source.agent_id AND source_revision.id = source.revision_id
         WHERE revision.namespace_id = $3 AND revision.agent_id = $4 AND revision.id = $5
           AND NOT ${repositoryCleanupSql("source")}
           AND (NOT $7::boolean OR (source.revision_id = revision.id
             AND revision.admitted_spec->'repository_credentials' IS NOT NULL))
           AND (
             (source.agent_id = revision.agent_id AND source.revision_id IS NOT NULL
               -- Excludes credential withdrawal work; see CREDENTIAL_WITHDRAWAL_TARGET.
               AND source.agent_target IS NULL
               AND revision.revision_number <= source_revision.revision_number)
             OR (source.agent_target = 'stopped' AND source.revision_id IS NULL
               AND source.agent_id = revision.agent_id AND revision.admitted_at <= source.created_at)
             OR (source.agent_target = 'deleted' AND source.revision_id IS NULL
               AND source.agent_id = revision.agent_id AND agent.status = 'deleting'
               AND agent.desired_runtime_state = 'stopped' AND revision.admitted_at <= source.created_at)
             OR (source.namespace_target = 'deleted' AND source.agent_id IS NULL
               AND source.revision_id IS NULL AND namespace.status = 'deleting'
               AND revision.admitted_at <= source.created_at)
           )
       ), registered AS (
         INSERT INTO occ.controller_work (
           idempotency_key, namespace_id, agent_id, revision_id, actor_id,
           namespace_target, agent_target, state, available_at, attempt_count, created_at, updated_at
         )
         SELECT $6, owner.namespace_id, owner.agent_id, owner.revision_id, source.actor_id,
           NULL, NULL, 'queued', clock_timestamp(), 0, clock_timestamp(), clock_timestamp()
         FROM owner CROSS JOIN source
         WHERE source.lease_expires_at > clock_timestamp() AND ($7::boolean OR EXISTS (
           SELECT 1 FROM occ.repository_session_attempts AS attempt
           WHERE attempt.namespace_id = owner.namespace_id AND attempt.agent_id = owner.agent_id
             AND attempt.revision_id = owner.revision_id AND attempt.phase IN ('closing', 'invalidated')
         ))
         ${CLEANUP_CONFLICT_SQL}
         RETURNING *
       )
       SELECT EXISTS (SELECT 1 FROM source) AS claim_current,
         EXISTS (SELECT 1 FROM owner) AS owner_allowed,
         (SELECT row_to_json(registered) FROM registered) AS work`,
      [
        claim.idempotencyKey,
        claim.claimToken,
        nonempty(owner.namespaceId, "Repository cleanup Namespace ID"),
        nonempty(owner.agentId, "Repository cleanup Agent ID"),
        revisionId,
        key,
        retireRuntime,
      ],
    );
    const row = result.rows[0] as
      { claim_current: boolean; owner_allowed: boolean; work: unknown | null } | undefined;
    if (row?.claim_current !== true) {
      throw new WorkClaimLostError();
    }
    if (!row.owner_allowed) {
      throw new ScopeViolationError("The current work does not own this repository cleanup.");
    }
    return row.work === null ? undefined : asWork(row.work);
  }

  async claim(input: ClaimRequest = {}): Promise<ClaimedWork | undefined> {
    const claimToken = input.claimToken ?? randomUUID();
    if (!UUID_V4.test(claimToken)) {
      throw new ScopeViolationError("The controller work claim token must be a version 4 UUID.");
    }

    for (let attempt = 0; attempt < this.claimRaceRetries; attempt += 1) {
      try {
        const claimed = await this.client.query(
          `WITH candidate AS (
             SELECT work.idempotency_key
             FROM occ.controller_work AS work
             WHERE ${this.claimablePredicate("$2")}
             ORDER BY work.available_at, work.created_at, work.idempotency_key
             FOR UPDATE OF work SKIP LOCKED
             LIMIT 1
           )
           UPDATE occ.controller_work AS work
           SET state = 'claimed',
               attempt_count = CASE WHEN ${repositoryCleanupSql("work")}
                 THEN LEAST(work.attempt_count::bigint + 1, $2::integer)::integer
                 ELSE work.attempt_count + 1 END,
               claim_token = $1::uuid,
               lease_expires_at = clock_timestamp() + $3::double precision * interval '1 millisecond',
               updated_at = clock_timestamp()
           FROM candidate
           WHERE work.idempotency_key = candidate.idempotency_key
           RETURNING work.*`,
          [claimToken, this.maxAttempts, this.leaseDurationMs],
        );
        return claimed.rows[0] === undefined ? undefined : asClaimedWork(claimed.rows[0]);
      } catch (error) {
        const state = sqlState(error);
        if (state === undefined || !CLAIM_RACE_CODES.has(state)) {
          throw error;
        }
        if (attempt === this.claimRaceRetries - 1) {
          throw error;
        }
      }
    }
    return undefined;
  }

  async heartbeat(claim: WorkClaim): Promise<ClaimedWork | undefined> {
    validateClaim(claim);
    const renewed = await this.client.query(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() + $3::double precision * interval '1 millisecond',
           updated_at = clock_timestamp()
       WHERE idempotency_key = $1
         AND state = 'claimed'
         AND claim_token = $2::uuid
         AND lease_expires_at > clock_timestamp()
       RETURNING *`,
      [claim.idempotencyKey, claim.claimToken, this.leaseDurationMs],
    );
    return renewed.rows[0] === undefined ? undefined : asClaimedWork(renewed.rows[0]);
  }

  /**
   * Whether some Work could be claimed now. Work for an Agent or Namespace that
   * already has a claim (the caller's own included) does not count: no worker
   * could take it.
   */
  async claimableWorkWaiting(): Promise<boolean> {
    const waiting = await this.client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM occ.controller_work AS work
         WHERE ${this.claimablePredicate("$1")}
       ) AS waiting`,
      [this.maxAttempts],
    );
    const value = (waiting.rows[0] as { waiting?: unknown } | undefined)?.waiting;
    if (typeof value !== "boolean") {
      throw new ScopeViolationError("The controller work backlog returned an invalid answer.");
    }
    return value;
  }

  async pending(): Promise<number> {
    const pending = await this.client.query(
      `SELECT count(*)::integer AS count
       FROM occ.controller_work
       WHERE ${PENDING_WORK_PREDICATE}
         ${this.namespaceFilter()}`,
    );
    const count = (pending.rows[0] as { count?: unknown } | undefined)?.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new ScopeViolationError("The controller work backlog contains an invalid count.");
    }
    return count;
  }

  async findWork(idempotencyKey: string): Promise<ControllerWork | undefined> {
    const found = await this.client.query(
      `SELECT * FROM occ.controller_work WHERE idempotency_key = $1`,
      [nonempty(idempotencyKey, "Controller work idempotency key")],
    );
    return found.rows[0] === undefined ? undefined : asWork(found.rows[0]);
  }

  /** The latest evidence bound to this work item, or the latest with `code` when given. */
  async findWorkAttempt(
    idempotencyKey: string,
    code?: string,
  ): Promise<ControllerWorkAttempt | undefined> {
    // A revision can also have maintenance and cleanup work. Only evidence bound
    // to this exact work item can explain its progress; unbound history is unknown.
    const found = await this.client.query(
      `SELECT event.occurred_at, event.details->>'reasonCode' AS reason_code,
         event.details->>'refusal' AS refusal
       FROM occ.controller_work AS work
       JOIN occ.audit_events AS event
         ON event.namespace_id = work.namespace_id AND event.actor_id = work.actor_id
         AND event.resource_kind = 'agent_revision' AND event.resource_id = work.revision_id
         AND event.kind = 'mutation' AND event.action = 'reconcile'
         AND event.details->>'workId' = work.idempotency_key
         AND event.occurred_at >= work.created_at
         AND ($2::text IS NULL OR event.details->>'reasonCode' = $2::text)
       WHERE work.idempotency_key = $1
       ORDER BY event.occurred_at DESC, event.id DESC LIMIT 1`,
      [
        nonempty(idempotencyKey, "Controller work idempotency key"),
        code === undefined ? null : nonempty(code, "Controller work attempt code"),
      ],
    );
    const row = found.rows[0] as
      { occurred_at: Date | string; reason_code: string; refusal: string | null } | undefined;
    return row === undefined
      ? undefined
      : Object.freeze({
          at: asDate(row.occurred_at),
          code: row.reason_code,
          ...(row.refusal === null ? {} : { refusal: row.refusal }),
        });
  }

  /**
   * How many `REFUSED_CANDIDATE_STOP_PENDING` deferrals for a failed stop this work item recorded
   * since its latest evidence without a refusal, reading its latest 64 evidence rows. A stop that
   * yielded to other Work (`stopYielded`) and a recovered lost claim (`LEASE_EXPIRED` with a
   * refusal) continue that run without adding to it.
   */
  async countRefusedStopWaits(idempotencyKey: string): Promise<number> {
    // The same work-bound evidence as findWorkAttempt, newest first.
    const found = await this.client.query(
      `SELECT event.details->>'reasonCode' AS reason_code,
         event.details->>'refusal' AS refusal,
         event.details->>'stopYielded' AS stop_yielded
       FROM occ.controller_work AS work
       JOIN occ.audit_events AS event
         ON event.namespace_id = work.namespace_id AND event.actor_id = work.actor_id
         AND event.resource_kind = 'agent_revision' AND event.resource_id = work.revision_id
         AND event.kind = 'mutation' AND event.action = 'reconcile'
         AND event.details->>'workId' = work.idempotency_key
         AND event.occurred_at >= work.created_at
       WHERE work.idempotency_key = $1
       ORDER BY event.occurred_at DESC, event.id DESC LIMIT 64`,
      [nonempty(idempotencyKey, "Controller work idempotency key")],
    );
    let waits = 0;
    for (const row of found.rows as {
      reason_code: string | null;
      refusal: string | null;
      stop_yielded: string | null;
    }[]) {
      if (row.refusal === null) {
        break;
      }
      if (row.reason_code === "REFUSED_CANDIDATE_STOP_PENDING" && row.stop_yielded === null) {
        waits += 1;
      }
    }
    return waits;
  }

  async complete(claim: WorkClaim, result: WorkResult = {}): Promise<void> {
    validateClaim(claim);
    const reasonCode = safeFailureCode(result.code ?? "RECONCILE_SUCCEEDED");
    const resultData = validateSuccessResultData(result.resultData);
    const completed = await this.client.query(
      `WITH transitioned AS (
         UPDATE occ.controller_work
         SET state = 'succeeded',
             claim_token = NULL,
             lease_expires_at = NULL,
             completed_at = clock_timestamp(),
             reason_code = $5::text,
             result_data = $6::jsonb,
             updated_at = clock_timestamp()
         WHERE idempotency_key = $1
           AND state = 'claimed'
           AND claim_token = $2::uuid
           AND lease_expires_at > clock_timestamp()
         RETURNING *
       ), ${INSERT_EVIDENCE_SQL}`,
      [
        claim.idempotencyKey,
        claim.claimToken,
        "success",
        reasonCode,
        reasonCode,
        resultData === undefined ? null : JSON.stringify(resultData),
      ],
    );
    if (completed.rows.length === 0) {
      throw new WorkClaimLostError();
    }
  }

  async completeAgentDeletion(
    claim: WorkClaim,
    namespaceId: string,
    agentId: string,
  ): Promise<"completed" | "cleanup-pending"> {
    validateClaim(claim);
    nonempty(namespaceId, "Agent deletion Namespace ID");
    nonempty(agentId, "Agent deletion Agent ID");
    const completed = await this.client.query(
      "SELECT occ.finalize_agent_deletion($1::text, $2::text, $3::text, $4::uuid) AS completed",
      [namespaceId, agentId, claim.idempotencyKey, claim.claimToken],
    );
    const outcome = (completed.rows[0] as { completed?: unknown } | undefined)?.completed;
    if (outcome === null) {
      return "cleanup-pending";
    }
    if (outcome !== true) {
      throw new WorkClaimLostError();
    }
    return "completed";
  }

  /**
   * `recordEvidence: false` is for a caller that knows this deferral repeats the waiting state it
   * already recorded for the same work item (the evidence lookup covers revision work only).
   * `repeatEvidence: true` records a deferral even when it repeats the latest evidence, for a
   * wait whose deferrals are minutes apart and whose readers need to see it is still retrying.
   */
  async defer(
    claim: WorkClaim,
    pending: DeferredWork,
    options: {
      readonly delayMs?: number;
      readonly recordEvidence?: boolean;
      readonly repeatEvidence?: boolean;
    } = {},
  ): Promise<void> {
    validateClaim(claim);
    if (options.delayMs !== undefined && !isPositiveSafeInteger(options.delayMs)) {
      throw new ScopeViolationError("The deferred Work delay is invalid.");
    }
    if (
      (options.recordEvidence !== undefined && typeof options.recordEvidence !== "boolean") ||
      (options.repeatEvidence !== undefined && typeof options.repeatEvidence !== "boolean")
    ) {
      throw new ScopeViolationError("The deferred Work evidence option is invalid.");
    }
    const deferred = await this.client.query(
      `WITH transitioned AS (
         UPDATE occ.controller_work
         SET state = 'queued',
             attempt_count = GREATEST(attempt_count - 1, 0),
             available_at = clock_timestamp() +
               COALESCE($8::double precision,
                 LEAST($5::double precision,
                   $6::double precision * POWER(2::double precision,
                     LEAST(GREATEST(attempt_count - 1, 0), 30))) *
                   $7::double precision) * interval '1 millisecond',
             claim_token = NULL,
             lease_expires_at = NULL,
             updated_at = clock_timestamp()
         WHERE idempotency_key = $1
           AND state = 'claimed'
           AND claim_token = $2::uuid
           AND lease_expires_at > clock_timestamp()
         RETURNING *
       ), ${INSERT_DEFER_EVIDENCE_SQL}`,
      [
        claim.idempotencyKey,
        claim.claimToken,
        "success",
        safeFailureCode(pending.code),
        MAX_BACKOFF_MS,
        INITIAL_BACKOFF_MS,
        this.nextRandom(),
        options.delayMs ?? null,
        options.recordEvidence ?? true,
        pending.refusal === undefined ? null : safeFailureCode(pending.refusal),
        options.repeatEvidence ?? false,
        pending.refusal !== undefined && pending.stopYielded === true,
      ],
    );
    if (deferred.rows.length === 0) {
      throw new WorkClaimLostError();
    }
  }

  async retry(claim: WorkClaim, failure: RetryableFailure): Promise<void> {
    validateClaim(claim);
    const failureCode = safeFailureCode(failure.code);
    const jitter = this.nextRandom();
    const exhausted = `(attempt_count >= $5::integer AND NOT ${repositoryCleanupSql("work")})`;
    const retried = await this.client.query(
      `WITH transitioned AS (
         UPDATE occ.controller_work AS work
         SET state = CASE
               WHEN ${exhausted} THEN 'failed_permanent'
               ELSE 'queued'
             END,
             available_at = CASE
               WHEN ${exhausted} THEN available_at
               ELSE clock_timestamp() +
                 LEAST($6::double precision,
                   $7::double precision * POWER(2::double precision,
                     LEAST(GREATEST(attempt_count - 1, 0), 30))) *
                   $8::double precision * interval '1 millisecond'
             END,
             claim_token = NULL,
             lease_expires_at = NULL,
             completed_at = CASE
               WHEN ${exhausted} THEN clock_timestamp()
               ELSE NULL
             END,
             reason_code = CASE
               WHEN ${exhausted} THEN $4::text
               ELSE NULL
             END,
             result_data = NULL,
             updated_at = clock_timestamp()
         WHERE idempotency_key = $1
           AND state = 'claimed'
           AND claim_token = $2::uuid
           AND lease_expires_at > clock_timestamp()
         RETURNING *
       ), ${transferRepositoryCleanupSql()} ${SETTLE_PROVISIONING_FAILURE_SQL}
       ${INSERT_EVIDENCE_SQL}`,
      [
        claim.idempotencyKey,
        claim.claimToken,
        "failure",
        failureCode,
        this.maxAttempts,
        MAX_BACKOFF_MS,
        INITIAL_BACKOFF_MS,
        jitter,
      ],
    );
    if (retried.rows.length === 0) {
      throw new WorkClaimLostError();
    }
  }

  async fail(
    claim: WorkClaim,
    failure: PermanentFailure,
    options: { readonly continuingRevision?: true } = {},
  ): Promise<void> {
    validateClaim(claim);
    const failureCode = safeFailureCode(failure.code);
    const data = validateFailureData(failureCode, failure.data);
    const continuingRevision = options.continuingRevision === true;
    const maintenanceKey = MAINTENANCE_KEY.exec(claim.idempotencyKey);
    if (
      continuingRevision &&
      (maintenanceKey === null || maintenanceKey[0] !== claim.idempotencyKey) &&
      !REVISION_RECONCILE_KEY.test(claim.idempotencyKey)
    ) {
      throw new ScopeViolationError(
        "Only an active revision's deployment or maintenance can continue after failure.",
      );
    }
    // continuing_agent locks the Agent without its Namespace. Callers that continue a
    // revision must already hold the Namespace (then the Agent) in this transaction, as
    // the worker does, or this deadlocks with admission's Namespace-then-Agent order.
    const failed = await this.client.query(
      `WITH source AS MATERIALIZED (
         SELECT * FROM occ.controller_work AS work
         WHERE work.idempotency_key = $1 AND work.state = 'claimed'
           AND work.claim_token = $2::uuid AND work.lease_expires_at > clock_timestamp()
         FOR UPDATE OF work
       ), continuing_agent AS MATERIALIZED (
         SELECT agent.namespace_id, agent.id, agent.active_revision_id, agent.desired_runtime_state
         FROM occ.agents AS agent
         JOIN source ON source.namespace_id = agent.namespace_id AND source.agent_id = agent.id
         WHERE $7::boolean
         FOR UPDATE OF agent
       ), eligible AS (
         SELECT source.* FROM source
         WHERE NOT ${repositoryCleanupSql("source")}
           AND (NOT $7::boolean OR EXISTS (
             SELECT 1 FROM continuing_agent AS agent
             JOIN occ.agent_revisions AS revision
               ON revision.namespace_id = agent.namespace_id AND revision.agent_id = agent.id
               AND revision.id = agent.active_revision_id
             JOIN occ.namespaces AS namespace ON namespace.id = agent.namespace_id
             WHERE source.revision_id = revision.id AND source.namespace_target IS NULL
               AND source.agent_target IS NULL AND agent.desired_runtime_state = 'running'
               AND namespace.status = 'ready' AND namespace.deleted_at IS NULL
               AND (source.idempotency_key ~
                 ('^agent_revision:' || revision.id || ':maintenance:(0|[1-9][0-9]*)$')
                 OR source.idempotency_key = 'agent_revision:' || revision.id || ':reconcile')
               AND (revision.admitted_spec->'repository_credentials' IS NULL OR
                 (revision.admitted_spec #>> '{repository_credentials,deadlineWallMs}')::bigint >
                   EXTRACT(EPOCH FROM clock_timestamp()) * 1000)
           ))
       ), transitioned AS (
         UPDATE occ.controller_work AS work
         SET state = 'failed_permanent',
             claim_token = NULL,
             lease_expires_at = NULL,
             completed_at = clock_timestamp(),
             reason_code = $5::text,
             result_data = $6::jsonb,
             updated_at = clock_timestamp()
         FROM eligible
         WHERE work.idempotency_key = eligible.idempotency_key
           AND work.lease_expires_at > clock_timestamp()
         RETURNING work.*
       ), ${transferRepositoryCleanupSql("$7::boolean")} ${SETTLE_PROVISIONING_FAILURE_SQL}
       ${INSERT_EVIDENCE_CTE_SQL}
       SELECT EXISTS (SELECT 1 FROM source) AS claim_current,
         EXISTS (SELECT 1 FROM transitioned) AS failed`,
      [
        claim.idempotencyKey,
        claim.claimToken,
        "failure",
        failureCode,
        failureCode,
        data === undefined ? null : JSON.stringify(data),
        continuingRevision,
      ],
    );
    const result = failed.rows[0] as { claim_current: boolean; failed: boolean } | undefined;
    if (result?.claim_current !== true) {
      throw new WorkClaimLostError();
    }
    if (!result.failed) {
      throw new ScopeViolationError(
        "Cleanup cannot be abandoned, and maintenance continuation requires a current active revision.",
      );
    }
  }

  async recoverStale(input: RecoveryRequest = {}): Promise<RecoverySummary> {
    const requestedLimit = positiveInteger(input.limit ?? DEFAULT_RECOVERY_LIMIT, "Recovery limit");
    if (requestedLimit > MAX_RECOVERY_LIMIT) {
      throw new ScopeViolationError(`Recovery limit cannot exceed ${MAX_RECOVERY_LIMIT}.`);
    }
    const recovering =
      "work.idempotency_key IN (SELECT idempotency_key FROM recovering_activations)";
    const refusedStop =
      "work.idempotency_key IN (SELECT idempotency_key FROM recovering_refused_stops)";
    const exhaustedClaim = `(work.attempt_count >= $2::integer AND NOT ${repositoryCleanupSql("work")} AND NOT ${recovering} AND NOT ${refusedStop})`;
    const stale = await this.client.query(
      `WITH candidates AS (
         SELECT idempotency_key
         FROM occ.controller_work
         WHERE state = 'claimed'
           AND lease_expires_at <= clock_timestamp()
           ${this.namespaceFilter()}
         ORDER BY lease_expires_at, idempotency_key
         FOR UPDATE SKIP LOCKED
         LIMIT $1::integer
       ), ${continuingMaintenanceSql("candidates")} ${RECOVERING_ACTIVATIONS_SQL}
       ${RECOVERING_REFUSED_STOPS_SQL} transitioned AS (
         UPDATE occ.controller_work AS work
         SET state = CASE
               WHEN ${exhaustedClaim} THEN 'failed_permanent'
               ELSE 'queued'
             END,
             attempt_count = CASE
               WHEN ${recovering} THEN GREATEST($2::integer - 1, 0)
               WHEN ${refusedStop} THEN GREATEST(work.attempt_count - 1, 0)
               ELSE work.attempt_count
             END,
             available_at = CASE
               WHEN ${exhaustedClaim} THEN work.available_at
               -- The runtime already runs: nothing to back off from.
               WHEN ${recovering} THEN clock_timestamp() +
                 $6::double precision * $7::double precision * interval '1 millisecond'
               ELSE clock_timestamp() +
                 LEAST($5::double precision,
                   $6::double precision * POWER(2::double precision,
                     LEAST(GREATEST(work.attempt_count - 1, 0), 30))) *
                   $7::double precision * interval '1 millisecond'
             END,
             claim_token = NULL,
             lease_expires_at = NULL,
             completed_at = CASE
               WHEN ${exhaustedClaim} THEN clock_timestamp()
               ELSE NULL
             END,
             reason_code = CASE
               WHEN ${exhaustedClaim} THEN $4::text
               ELSE NULL
             END,
             result_data = NULL,
             updated_at = clock_timestamp()
         FROM candidates
         WHERE work.idempotency_key = candidates.idempotency_key
         RETURNING work.*
       ), ${continueMaintenanceSql("$5")} ${FAIL_EXHAUSTED_NAMESPACES_SQL},
       ${transferRepositoryCleanupSql(CONTINUING_MAINTENANCE_SOURCE_SQL)}
       ${SETTLE_PROVISIONING_FAILURE_SQL}
       ${insertEvidenceCteSql(
         "",
         `CASE WHEN transitioned.idempotency_key IN (SELECT idempotency_key FROM recovering_activations)
            THEN '${ACTIVE_REVISION_RECOVERY}' ELSE $4::text END`,
         `COALESCE((SELECT jsonb_build_object('refusal', stop.refusal)
            FROM recovering_refused_stops AS stop
            WHERE stop.idempotency_key = transitioned.idempotency_key), '{}'::jsonb)`,
       )}
       SELECT transitioned.* FROM transitioned`,
      [
        requestedLimit,
        this.maxAttempts,
        "failure",
        "LEASE_EXPIRED",
        MAX_BACKOFF_MS,
        INITIAL_BACKOFF_MS,
        this.nextRandom(),
      ],
    );

    const exhausted = await this.client.query(
      `WITH candidates AS (
         SELECT idempotency_key
         FROM occ.controller_work AS work
         WHERE state = 'queued'
           AND attempt_count >= $2::integer
           AND NOT ${repositoryCleanupSql("work")}
           ${this.namespaceFilter()}
         ORDER BY available_at, created_at, idempotency_key
         FOR UPDATE SKIP LOCKED
         LIMIT $1::integer
       ), ${continuingMaintenanceSql("candidates")} transitioned AS (
         UPDATE occ.controller_work AS work
         SET state = 'failed_permanent',
             completed_at = clock_timestamp(),
             reason_code = $4::text,
             result_data = NULL,
             updated_at = clock_timestamp()
         FROM candidates
         WHERE work.idempotency_key = candidates.idempotency_key
         RETURNING work.*
       ), ${continueMaintenanceSql("$5")} ${FAIL_EXHAUSTED_NAMESPACES_SQL},
       ${transferRepositoryCleanupSql(CONTINUING_MAINTENANCE_SOURCE_SQL)}
       ${SETTLE_PROVISIONING_FAILURE_SQL}
       ${INSERT_EVIDENCE_SQL}`,
      [requestedLimit, this.maxAttempts, "failure", "MAX_ATTEMPTS_EXHAUSTED", MAX_BACKOFF_MS],
    );

    const recovered = stale.rows.map(asWork);
    const failed = [
      ...recovered.filter(({ state }) => state === "failed_permanent"),
      ...exhausted.rows.map(asWork),
    ];
    return Object.freeze({
      recovered: recovered.length,
      requeued: recovered.filter(({ state }) => state === "queued").length,
      failedPermanent: failed.length,
      exhaustedQueued: exhausted.rows.length,
      failed: Object.freeze(failed),
    });
  }

  private nextRandom(): number {
    const value = this.random();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
      throw new ScopeViolationError("Controller work retry jitter must be in the range [0, 1).");
    }
    return value;
  }

  // Queued Work a worker may claim now; `maxAttempts` names the bound parameter.
  private claimablePredicate(maxAttempts: string): string {
    return `work.state = 'queued'
               AND work.available_at <= clock_timestamp()
               AND (work.attempt_count < ${maxAttempts}::integer OR ${repositoryCleanupSql("work")})
               ${this.namespaceFilter("work")}
               AND NOT EXISTS (
                 SELECT 1
                 FROM occ.controller_work AS in_flight
                 WHERE in_flight.state = 'claimed'
                   AND COALESCE(in_flight.agent_id, in_flight.namespace_id) =
                       COALESCE(work.agent_id, work.namespace_id)
               )`;
  }

  private namespaceFilter(alias?: string): string {
    if (this.workKind === "all") {
      return "";
    }
    const prefix = alias === undefined ? "" : `${alias}.`;
    return `AND ${prefix}namespace_target IS NOT NULL
            AND ${prefix}agent_id IS NULL
            AND ${prefix}revision_id IS NULL`;
  }
}
