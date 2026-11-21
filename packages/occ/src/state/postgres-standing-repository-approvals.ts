import type { PostgresQueryClient } from "./postgres-work-queue.ts";
import type { RepositoryStandingApproval } from "../ports/repository-sessions.ts";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ResourceStateConflictError,
} from "../errors.ts";
import { isDeepStrictEqual } from "node:util";

const columns = `id, namespace_id AS "namespaceId", agent_id AS "agentId", binding, scope, scope_fingerprint AS "scopeFingerprint", generation,
 approved_by AS "approvedBy", created_at AS "createdAt", revoked_at AS "revokedAt"`;
function row(value: unknown): RepositoryStandingApproval {
  const r = value as Omit<RepositoryStandingApproval, "createdAt" | "revokedAt"> & {
    createdAt: Date;
    revokedAt: Date | null;
  };
  const generation = Number(r.generation);
  if (!Number.isSafeInteger(generation) || generation < 1 || !(r.createdAt instanceof Date)) {
    throw new DependencyUnavailableError("Invalid persisted standing approval.");
  }
  return {
    id: r.id,
    namespaceId: r.namespaceId,
    agentId: r.agentId,
    binding: r.binding,
    scope: r.scope,
    scopeFingerprint: r.scopeFingerprint,
    generation,
    approvedBy: r.approvedBy,
    createdAt: r.createdAt.toISOString(),
    ...(r.revokedAt ? { revokedAt: r.revokedAt.toISOString() } : {}),
  };
}
export function postgresStandingRepositoryApprovals(client: PostgresQueryClient) {
  return {
    async listStandingApprovals(namespaceId: string, agentId: string) {
      const result = await client.query(
        `SELECT ${columns} FROM occ.repository_standing_approvals
       WHERE namespace_id=$1 AND agent_id=$2 ORDER BY repository_ref,generation`,
        [namespaceId, agentId],
      );
      return result.rows.map(row);
    },
    async findStandingApproval(namespaceId: string, agentId: string, repositoryRef: string) {
      const result = await client.query(
        `SELECT ${columns} FROM occ.repository_standing_approvals
       WHERE namespace_id=$1 AND agent_id=$2 AND repository_ref=$3 AND revoked_at IS NULL`,
        [namespaceId, agentId, repositoryRef],
      );
      return result.rows[0] ? row(result.rows[0]) : undefined;
    },
    async approveStanding(input: Omit<RepositoryStandingApproval, "generation" | "revokedAt">) {
      const result = await client.query(
        `INSERT INTO occ.repository_standing_approvals
       (id,namespace_id,agent_id,repository_ref,binding,scope,approved_by,created_at,scope_fingerprint,generation)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce(max(generation),0)+1
       FROM occ.repository_standing_approvals WHERE namespace_id=$2 AND agent_id=$3 AND repository_ref=$4
       ON CONFLICT DO NOTHING RETURNING ${columns}`,
        [
          input.id,
          input.namespaceId,
          input.agentId,
          input.binding.repositoryRef,
          input.binding,
          input.scope,
          input.approvedBy,
          input.createdAt,
          input.scopeFingerprint,
        ],
      );
      if (result.rows[0]) {
        return row(result.rows[0]);
      }
      const existing = await client.query(
        `SELECT ${columns} FROM occ.repository_standing_approvals WHERE id=$1`,
        [input.id],
      );
      const current = existing.rows[0] ? row(existing.rows[0]) : undefined;
      if (
        !current ||
        current.revokedAt ||
        current.namespaceId !== input.namespaceId ||
        current.agentId !== input.agentId ||
        current.scopeFingerprint !== input.scopeFingerprint ||
        current.approvedBy !== input.approvedBy ||
        !isDeepStrictEqual(current.binding, input.binding) ||
        !isDeepStrictEqual(current.scope, input.scope)
      ) {
        throw new ResourceConflictError(
          "Standing approval identity already used or binding already approved.",
        );
      }
      return current;
    },
    async revokeStanding(
      approval: Pick<RepositoryStandingApproval, "namespaceId" | "agentId" | "id" | "generation">,
      at: string,
    ) {
      const result = await client
        .query(
          `UPDATE occ.repository_standing_approvals
         SET revoked_at=greatest(created_at,$5::timestamptz), generation=generation+1
         WHERE namespace_id=$1 AND agent_id=$2 AND id=$3 AND generation=$4 AND revoked_at IS NULL`,
          [approval.namespaceId, approval.agentId, approval.id, approval.generation, at],
        )
        .catch((cause: unknown) => {
          // The exact approval was found. A persistence failure is not evidence of absence.
          const error = new DependencyUnavailableError(
            "Could not persist standing approval removal.",
          );
          Object.defineProperty(error, "cause", { value: cause, configurable: true });
          throw error;
        });
      if (result.rowCount !== 1) {
        throw new ResourceStateConflictError("Standing approval changed.");
      }
    },
  };
}
