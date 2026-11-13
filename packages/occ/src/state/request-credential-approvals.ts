import { immutableCopy } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";
import type {
  RequestCredentialApproval,
  RequestCredentialApprovalRepository,
} from "../ports/request-credential-approvals.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

const approvalLeaseMs = 30_000;

export interface StoredRequestCredentialApproval extends RequestCredentialApproval {
  readonly consumed: boolean;
}

export function memoryRequestCredentialApprovals(
  records: Map<string, StoredRequestCredentialApproval>,
): RequestCredentialApprovalRepository {
  return {
    async insert(approval, now, limits) {
      for (const [key, record] of records) {
        if (record.replayUntilAt <= now) {
          records.delete(key);
        }
      }
      const key = JSON.stringify([approval.recipientId, approval.requestId]);
      if (
        records.has(key) ||
        approval.deadlineAt <= now ||
        records.size >= limits.requestIds ||
        [...records.values()].filter((record) => record.recipientId === approval.recipientId)
          .length >= limits.sandboxRequestIds
      ) {
        return false;
      }
      const deadlineAt = new Date(
        Math.min(Date.parse(approval.deadlineAt), Date.parse(now) + approvalLeaseMs),
      ).toISOString();
      records.set(key, immutableCopy({ ...approval, deadlineAt, consumed: false }));
      return true;
    },
    async consume(grant, driver, now) {
      const key = JSON.stringify([grant.recipientId, grant.requestId]);
      const approval = records.get(key);
      if (
        !approval ||
        approval.consumed ||
        approval.bindingId !== grant.bindingId ||
        !isDeepStrictEqual(approval.driver, driver) ||
        approval.deadlineAt <= now
      ) {
        return undefined;
      }
      const remainingLifetimeMs = Math.floor(
        Math.min(Date.parse(approval.deadlineAt), Date.parse(grant.deadlineAt)) - Date.parse(now),
      );
      if (!(remainingLifetimeMs > 0)) {
        return undefined;
      }
      records.set(key, { ...approval, consumed: true });
      return { ...approval, remainingLifetimeMs };
    },
  };
}

export function postgresRequestCredentialApprovals(
  client: PostgresQueryClient,
): RequestCredentialApprovalRepository {
  return {
    async insert(approval, _now, limits) {
      // Never wait for quota capacity while retaining the caller's policy locks.
      // The database clock owns both shared retention and eligibility across replicas.
      // Refuse snapshot isolation: its counts could miss a preceding lock holder's insertion.
      const lock = await client.query(
        "SELECT pg_try_advisory_xact_lock(1868785008, 0) AS acquired",
      );
      if ((lock.rows[0] as { acquired?: boolean } | undefined)?.acquired !== true) {
        return false;
      }
      await client.query(
        "DELETE FROM occ.request_credential_approvals WHERE replay_until_at <= clock_timestamp()",
      );
      const result = await client.query(
        `INSERT INTO occ.request_credential_approvals
          (recipient_id, request_id, binding_id, namespace_id, agent_id, revision_id, policy_digest, driver_ref, expires_at, replay_until_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
           LEAST($9::timestamptz, clock_timestamp() + $13::int * interval '1 millisecond'), $10::timestamptz
         WHERE $9::timestamptz > clock_timestamp()
           AND $10::timestamptz <= clock_timestamp() + interval '1 hour'
           AND current_setting('transaction_isolation') = 'read committed'
           AND (SELECT count(*) FROM occ.request_credential_approvals) < $11
           AND (SELECT count(*) FROM occ.request_credential_approvals WHERE recipient_id = $1) < $12
         ON CONFLICT DO NOTHING`,
        [
          approval.recipientId,
          approval.requestId,
          approval.bindingId,
          approval.execution.namespaceId,
          approval.execution.agentId,
          approval.execution.revisionId,
          approval.policyDigest,
          JSON.stringify(approval.driver),
          approval.deadlineAt,
          approval.replayUntilAt,
          limits.requestIds,
          limits.sandboxRequestIds,
          approvalLeaseMs,
        ],
      );
      return result.rowCount === 1;
    },
    async consume(grant, driver, _now) {
      // Redemption expiry does not remove the authenticated request correlation.
      const { rows } = await client.query(
        `UPDATE occ.request_credential_approvals SET consumed = true
         WHERE recipient_id = $1 AND request_id = $2 AND binding_id = $3 AND NOT consumed AND driver_ref = $4::jsonb AND LEAST(expires_at, $5::timestamptz) > clock_timestamp()
         RETURNING namespace_id, agent_id, revision_id, policy_digest, expires_at, replay_until_at,
           FLOOR(EXTRACT(EPOCH FROM (LEAST(expires_at, $5::timestamptz) - clock_timestamp())) * 1000)::int AS remaining_lifetime_ms`,
        [
          grant.recipientId,
          grant.requestId,
          grant.bindingId,
          JSON.stringify(driver),
          grant.deadlineAt,
        ],
      );
      const row = rows[0] as
        | {
            namespace_id: string;
            agent_id: string;
            revision_id: string;
            policy_digest: string;
            expires_at: Date;
            replay_until_at: Date;
            remaining_lifetime_ms: number;
          }
        | undefined;
      return (
        row && {
          ...grant,
          driver,
          deadlineAt: row.expires_at.toISOString(),
          remainingLifetimeMs: row.remaining_lifetime_ms,
          replayUntilAt: row.replay_until_at.toISOString(),
          execution: {
            namespaceId: row.namespace_id,
            agentId: row.agent_id,
            revisionId: row.revision_id,
          },
          policyDigest: row.policy_digest,
        }
      );
    },
  };
}
