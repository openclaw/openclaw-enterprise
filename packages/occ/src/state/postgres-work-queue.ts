import { isPositiveSafeInteger } from "@openclaw-enterprise/utils";
import { randomUUID } from "node:crypto";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import {
  nonempty,
  safeFailureCode,
  validateFailureData,
  validateSuccessResultData,
  type ClaimedWork,
  type ControllerWork,
  type ControllerWorkState,
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
}

export interface PostgresWorkQueueOptions {
  readonly maxAttempts?: number;
  readonly leaseDurationMs?: number;
  readonly claimRaceRetries?: number;
  readonly random?: () => number;
  readonly workKind?: "all" | "namespace";
}

interface WorkRow {
  readonly idempotency_key: string;
  readonly namespace_id: string;
  readonly agent_id: string | null;
  readonly revision_id: string | null;
  readonly actor_id: string;
  readonly namespace_target: "ready" | "deleted" | null;
  readonly agent_target: "stopped" | null;
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
const INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_RECOVERY_LIMIT = 100;
const MAX_RECOVERY_LIMIT = 1_000;
const CLAIM_RACE_CODES = new Set(["23505", "40001", "40P01"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function asWork(value: unknown): ControllerWork {
  const row = asRow(value);
  return Object.freeze({
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

const INSERT_EVIDENCE_SQL = `
  evidence AS (
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
        WHEN transitioned.revision_id IS NOT NULL THEN 'agent_revision'
        WHEN transitioned.agent_id IS NOT NULL THEN 'agent'
        ELSE 'namespace'
      END,
      COALESCE(transitioned.revision_id, transitioned.agent_id, transitioned.namespace_id),
      $3::text,
      jsonb_build_object('reasonCode', $4::text, 'attemptCount', transitioned.attempt_count)
    FROM transitioned
    RETURNING id
  )
  SELECT transitioned.* FROM transitioned`;

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
    if (idempotencyKey.length > 512) {
      throw new ScopeViolationError("The controller work idempotency key exceeds 512 characters.");
    }
    const namespaceId = nonempty(input.namespaceId, "Controller work Namespace ID");
    const actorId = nonempty(input.actorId, "Controller work actor ID");
    const agentId =
      input.agentId === undefined ? null : nonempty(input.agentId, "Controller work Agent ID");
    const revisionId =
      input.revisionId === undefined
        ? null
        : nonempty(input.revisionId, "Controller work revision ID");
    if (revisionId !== null && agentId === null) {
      throw new ScopeViolationError(
        "Controller work revisions require both their exact owning Agent and revision.",
      );
    }
    const namespaceTarget = input.namespaceTarget ?? null;
    const agentTarget = input.agentTarget ?? null;
    if (
      (agentId === null &&
        (revisionId !== null ||
          (namespaceTarget !== "ready" && namespaceTarget !== "deleted") ||
          agentTarget !== null)) ||
      (agentId !== null &&
        revisionId === null &&
        (namespaceTarget !== null || agentTarget !== "stopped")) ||
      (revisionId !== null && (namespaceTarget !== null || agentTarget !== null))
    ) {
      throw new ScopeViolationError(
        "Controller work requires one exact Namespace, Agent, or revision target shape.",
      );
    }
    const availableAt = input.availableAt === undefined ? null : asDate(input.availableAt);

    const inserted = await this.client.query(
      `INSERT INTO occ.controller_work (
         idempotency_key, namespace_id, agent_id, revision_id, actor_id, namespace_target,
         agent_target,
         state, available_at, attempt_count, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         'queued', COALESCE($8::timestamptz, clock_timestamp()), 0,
         clock_timestamp(), clock_timestamp()
       )
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
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
          OR actor_id IS DISTINCT FROM $5::text AS owner_conflict,
          namespace_target IS DISTINCT FROM $6::text
          OR agent_target IS DISTINCT FROM $7::text AS target_conflict
       FROM occ.controller_work
       WHERE idempotency_key = $1`,
      [idempotencyKey, namespaceId, agentId, revisionId, actorId, namespaceTarget, agentTarget],
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
             WHERE work.state = 'queued'
               AND work.available_at <= clock_timestamp()
               AND work.attempt_count < $2::integer
               ${this.namespaceFilter("work")}
               AND NOT EXISTS (
                 SELECT 1
                 FROM occ.controller_work AS in_flight
                 WHERE in_flight.state = 'claimed'
                   AND COALESCE(in_flight.agent_id, in_flight.namespace_id) =
                       COALESCE(work.agent_id, work.namespace_id)
               )
             ORDER BY work.available_at, work.created_at, work.idempotency_key
             FOR UPDATE OF work SKIP LOCKED
             LIMIT 1
           )
           UPDATE occ.controller_work AS work
           SET state = 'claimed',
               attempt_count = work.attempt_count + 1,
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

  async pending(): Promise<number> {
    const pending = await this.client.query(
      `SELECT count(*)::integer AS count
       FROM occ.controller_work
       WHERE state IN ('queued', 'claimed')
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

  async defer(claim: WorkClaim, pending: RetryableFailure): Promise<void> {
    validateClaim(claim);
    const deferred = await this.client.query(
      `WITH transitioned AS (
         UPDATE occ.controller_work
         SET state = 'queued',
             attempt_count = GREATEST(attempt_count - 1, 0),
             available_at = clock_timestamp() +
               LEAST($5::double precision,
                 $6::double precision * POWER(2::double precision,
                   LEAST(GREATEST(attempt_count - 1, 0), 30))) *
                 $7::double precision * interval '1 millisecond',
             claim_token = NULL,
             lease_expires_at = NULL,
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
        safeFailureCode(pending.code),
        MAX_BACKOFF_MS,
        INITIAL_BACKOFF_MS,
        this.nextRandom(),
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
    const retried = await this.client.query(
      `WITH transitioned AS (
         UPDATE occ.controller_work
         SET state = CASE
               WHEN attempt_count >= $5::integer THEN 'failed_permanent'
               ELSE 'queued'
             END,
             available_at = CASE
               WHEN attempt_count >= $5::integer THEN available_at
               ELSE clock_timestamp() +
                 LEAST($6::double precision,
                   $7::double precision * POWER(2::double precision,
                     LEAST(GREATEST(attempt_count - 1, 0), 30))) *
                   $8::double precision * interval '1 millisecond'
             END,
             claim_token = NULL,
             lease_expires_at = NULL,
             completed_at = CASE
               WHEN attempt_count >= $5::integer THEN clock_timestamp()
               ELSE NULL
             END,
             reason_code = CASE
               WHEN attempt_count >= $5::integer THEN $4::text
               ELSE NULL
             END,
             result_data = NULL,
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

  async fail(claim: WorkClaim, failure: PermanentFailure): Promise<void> {
    validateClaim(claim);
    const failureCode = safeFailureCode(failure.code);
    const data = validateFailureData(failureCode, failure.data);
    const failed = await this.client.query(
      `WITH transitioned AS (
         UPDATE occ.controller_work
         SET state = 'failed_permanent',
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
        "failure",
        failureCode,
        failureCode,
        data === undefined ? null : JSON.stringify(data),
      ],
    );
    if (failed.rows.length === 0) {
      throw new WorkClaimLostError();
    }
  }

  async recoverStale(input: RecoveryRequest = {}): Promise<RecoverySummary> {
    const requestedLimit = positiveInteger(input.limit ?? DEFAULT_RECOVERY_LIMIT, "Recovery limit");
    if (requestedLimit > MAX_RECOVERY_LIMIT) {
      throw new ScopeViolationError(`Recovery limit cannot exceed ${MAX_RECOVERY_LIMIT}.`);
    }
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
       ), transitioned AS (
         UPDATE occ.controller_work AS work
         SET state = CASE
               WHEN work.attempt_count >= $2::integer THEN 'failed_permanent'
               ELSE 'queued'
             END,
             available_at = CASE
               WHEN work.attempt_count >= $2::integer THEN work.available_at
               ELSE clock_timestamp() +
                 LEAST($5::double precision,
                   $6::double precision * POWER(2::double precision,
                     LEAST(GREATEST(work.attempt_count - 1, 0), 30))) *
                   $7::double precision * interval '1 millisecond'
             END,
             claim_token = NULL,
             lease_expires_at = NULL,
             completed_at = CASE
               WHEN work.attempt_count >= $2::integer THEN clock_timestamp()
               ELSE NULL
             END,
             reason_code = CASE
               WHEN work.attempt_count >= $2::integer THEN $4::text
               ELSE NULL
             END,
             result_data = NULL,
             updated_at = clock_timestamp()
         FROM candidates
         WHERE work.idempotency_key = candidates.idempotency_key
         RETURNING work.*
       ), ${INSERT_EVIDENCE_SQL}`,
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
         FROM occ.controller_work
         WHERE state = 'queued'
           AND attempt_count >= $2::integer
           ${this.namespaceFilter()}
         ORDER BY available_at, created_at, idempotency_key
         FOR UPDATE SKIP LOCKED
         LIMIT $1::integer
       ), transitioned AS (
         UPDATE occ.controller_work AS work
         SET state = 'failed_permanent',
             completed_at = clock_timestamp(),
             reason_code = $4::text,
             result_data = NULL,
             updated_at = clock_timestamp()
         FROM candidates
         WHERE work.idempotency_key = candidates.idempotency_key
         RETURNING work.*
       ), ${INSERT_EVIDENCE_SQL}`,
      [requestedLimit, this.maxAttempts, "failure", "MAX_ATTEMPTS_EXHAUSTED"],
    );

    let requeued = 0;
    let failedPermanent = exhausted.rows.length;
    for (const row of stale.rows) {
      if (asRow(row).state === "queued") {
        requeued += 1;
      } else {
        failedPermanent += 1;
      }
    }
    return Object.freeze({
      recovered: stale.rows.length,
      requeued,
      failedPermanent,
      exhaustedQueued: exhausted.rows.length,
    });
  }

  private nextRandom(): number {
    const value = this.random();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
      throw new ScopeViolationError("Controller work retry jitter must be in the range [0, 1).");
    }
    return value;
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
