import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ControllerWorkKind,
  ControllerWorkState,
} from "../../packages/occ/src/controller-work.ts";
import type { RepositorySessionPhase } from "../../packages/occ/src/ports/repository-sessions.ts";
import type {
  EnqueueWork,
  PostgresWorkQueue,
} from "../../packages/occ/src/state/postgres-work-queue.ts";
import { claimExpected, createQueueRevision } from "./postgres-queue-recovery-fixture.ts";

type CleanupPurpose = "sessions" | "terminal-runtime";

interface RepositoryAttemptRow {
  readonly namespace_id: string;
  readonly agent_id: string;
  readonly revision_id: string;
  readonly repository_ref: string;
  readonly admission_id: string;
  readonly duration_seconds: number;
  readonly deadline_wall_ms: string;
  readonly phase: RepositorySessionPhase;
  readonly session_id: string | null;
  readonly created_at: Date;
}

interface QueueRow {
  readonly work_kind: ControllerWorkKind;
  readonly idempotency_key: string;
  readonly namespace_id: string;
  readonly agent_id: string | null;
  readonly revision_id: string | null;
  readonly actor_id: string;
  readonly namespace_target: NonNullable<EnqueueWork["namespaceTarget"]> | null;
  readonly agent_target: NonNullable<EnqueueWork["agentTarget"]> | null;
  readonly state: ControllerWorkState;
  readonly available_at: Date | number;
  readonly attempt_count: number;
  readonly claim_token: string | null;
  readonly audit_attempt_id: string | null;
  readonly lease_expires_at: Date | null;
  readonly completed_at: Date | null;
  readonly reason_code: string | null;
  readonly result_data: Record<string, unknown> | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

// Repository cleanup authority is decided in SQL: a claim that may not register or abandon
// cleanup is refused with these exact scope violations.
export const cleanupNotOwned = {
  name: "ScopeViolationError",
  message: "The current work does not own this repository cleanup.",
};
export const cleanupNotAbandonable = {
  name: "ScopeViolationError",
  message:
    "Cleanup cannot be abandoned, and maintenance continuation requires a current active revision.",
};

// Encode the expected key independently of the queue, using the revision rather than the source Work.
export function repositoryCleanupKey(
  revisionId: string,
  _sourceKey: string,
  purpose: CleanupPurpose = "sessions",
) {
  const purposeKey = purpose === "terminal-runtime" ? "retire:" : "";
  return `agent_revision:${revisionId}:repository_cleanup:${purposeKey}${createHash("sha256").update(revisionId, "utf8").digest("hex")}`;
}

export async function createRepositoryRevision(
  pool: Pool,
  namespaceId: string,
  agentId: string,
  phases: readonly (RepositorySessionPhase | undefined)[] = ["open"],
  revisionNumber = 1,
  deadlineWallMs = Date.now() + 3_600_000,
) {
  const bindings = phases.map((_, index) => ({
    repositoryRef: `repository-${index}`,
    profile: "read",
    backendId: "queue-provider",
    grant: {
      providerInstanceId: "queue-provider-instance",
      repositoryId: `repository-${index}`,
      grantId: `grant-${index}`,
    },
  }));
  const revisionId = await createQueueRevision(pool, namespaceId, agentId, revisionNumber, {
    driver: { id: "repository-queue", implementation: "queue-integration" },
    deadlineWallMs,
    bindings,
  });
  const owner = { namespaceId, agentId, revisionId };
  const admissionIds: string[] = [];
  // Session admission requires a live running owner; terminal scenarios stop it afterwards.
  await pool.query<never>(
    "UPDATE occ.agents SET desired_runtime_state = 'running' WHERE namespace_id = $1 AND id = $2",
    [namespaceId, agentId],
  );
  for (const [index, phase] of phases.entries()) {
    // An admitted binding can fail before its first session attempt is recorded.
    if (phase === undefined) {
      continue;
    }
    const binding = bindings[index];
    assert.ok(binding, "Every session attempt requires an admitted binding");
    const admissionId = `admission-${randomUUID()}`;
    admissionIds.push(admissionId);
    await pool.query<never>(
      `INSERT INTO occ.repository_session_attempts
         (namespace_id, agent_id, revision_id, repository_ref, admission_id,
          duration_seconds, deadline_wall_ms, phase, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 3600, $6, 'opening', clock_timestamp(), clock_timestamp())`,
      [namespaceId, agentId, revisionId, binding.repositoryRef, admissionId, deadlineWallMs],
    );
    if (phase !== "opening") {
      await pool.query<never>(
        `UPDATE occ.repository_session_attempts
         SET phase = 'open', session_id = $2, updated_at = clock_timestamp()
         WHERE admission_id = $1`,
        [admissionId, `session-${randomUUID()}`],
      );
      if (phase !== "open") {
        await pool.query<never>(
          `UPDATE occ.repository_session_attempts SET phase = 'closing', updated_at = clock_timestamp()
           WHERE admission_id = $1`,
          [admissionId],
        );
        if (phase !== "closing") {
          await pool.query<never>(
            `UPDATE occ.repository_session_attempts SET phase = $2, updated_at = clock_timestamp()
             WHERE admission_id = $1`,
            [admissionId, phase],
          );
        }
      }
    }
  }
  return { ...owner, admissionIds };
}

export async function readRepositoryAttempts(pool: Pool, revisionId: string) {
  return (
    await pool.query<RepositoryAttemptRow>(
      `SELECT namespace_id, agent_id, revision_id, repository_ref, admission_id,
              duration_seconds, deadline_wall_ms, phase, session_id, created_at
       FROM occ.repository_session_attempts WHERE revision_id = $1 ORDER BY repository_ref`,
      [revisionId],
    )
  ).rows;
}

export async function readQueueRow(
  client: Pool | PoolClient,
  idempotencyKey: string,
): Promise<QueueRow | undefined> {
  return (
    await client.query<QueueRow>("SELECT * FROM occ.controller_work WHERE idempotency_key = $1", [
      idempotencyKey,
    ])
  ).rows[0];
}

export async function insertRawQueueWork(pool: Pool, input: EnqueueWork, attemptCount = 0) {
  await pool.query<never>(
    `INSERT INTO occ.controller_work
       (idempotency_key, namespace_id, agent_id, revision_id, actor_id, namespace_target,
        agent_target, state, available_at, attempt_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', to_timestamp(0), $8,
             clock_timestamp(), clock_timestamp())`,
    [
      input.idempotencyKey,
      input.namespaceId,
      input.agentId ?? null,
      input.revisionId ?? null,
      input.actorId,
      input.namespaceTarget ?? null,
      input.agentTarget ?? null,
      attemptCount,
    ],
  );
}

export async function completeCleanupWork(
  queue: PostgresWorkQueue,
  revisionId: string,
  sourceKey: string,
  purpose: CleanupPurpose = "sessions",
) {
  await queue.complete(
    await claimExpected(queue, repositoryCleanupKey(revisionId, sourceKey, purpose)),
  );
}
