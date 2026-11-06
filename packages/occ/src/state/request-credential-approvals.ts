import { immutableCopy } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";
import type {
  RequestCredentialApproval,
  RequestCredentialApprovalRepository,
} from "../ports/request-credential-approvals.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

export interface StoredRequestCredentialApproval extends RequestCredentialApproval {
  readonly consumed: boolean;
}

export function memoryRequestCredentialApprovals(
  records: Map<string, StoredRequestCredentialApproval>,
): RequestCredentialApprovalRepository {
  return {
    async insert(approval, now) {
      for (const [key, record] of records) {
        if (record.deadlineAt <= now) {
          records.delete(key);
        }
      }
      const key = JSON.stringify([approval.recipientId, approval.requestId]);
      if (records.has(key) || approval.deadlineAt <= now) {
        return false;
      }
      records.set(key, immutableCopy({ ...approval, consumed: false }));
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
      records.set(key, { ...approval, consumed: true });
      return approval;
    },
  };
}

export function postgresRequestCredentialApprovals(
  client: PostgresQueryClient,
): RequestCredentialApprovalRepository {
  return {
    async insert(approval, now) {
      await client.query("DELETE FROM occ.request_credential_approvals WHERE expires_at <= $1", [
        now,
      ]);
      const result = await client.query(
        `INSERT INTO occ.request_credential_approvals
          (recipient_id, request_id, binding_id, namespace_id, agent_id, revision_id, policy_digest, driver_ref, expires_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz WHERE $9::timestamptz > $10::timestamptz
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
          now,
        ],
      );
      return result.rowCount === 1;
    },
    async consume(grant, driver, now) {
      // Keep the used key until expiry: a repeat policy call cannot re-open a redeemed grant.
      const { rows } = await client.query(
        `UPDATE occ.request_credential_approvals SET consumed = true
         WHERE recipient_id = $1 AND request_id = $2 AND binding_id = $3 AND NOT consumed AND driver_ref = $4::jsonb AND expires_at > $5
         RETURNING namespace_id, agent_id, revision_id, policy_digest, expires_at`,
        [grant.recipientId, grant.requestId, grant.bindingId, JSON.stringify(driver), now],
      );
      const row = rows[0] as
        | {
            namespace_id: string;
            agent_id: string;
            revision_id: string;
            policy_digest: string;
            expires_at: Date;
          }
        | undefined;
      return (
        row && {
          ...grant,
          driver,
          deadlineAt: row.expires_at.toISOString(),
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
