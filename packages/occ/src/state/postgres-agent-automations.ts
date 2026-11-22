import type {
  AgentAutomationOwnership,
  AgentAutomationToolGrant,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";

import type { AgentAutomationRepository } from "../ports/agent-automations.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";

type Row = {
  id: string;
  namespace_id: string;
  agent_id: string;
  creator_principal_id: string;
  native_agent_id: string;
  native_job_id: string | null;
  tool_grant: AgentAutomationToolGrant;
  retired_at: Date | null;
  created_at: Date;
};

function fromRow(row: Row): Readonly<AgentAutomationOwnership> {
  return immutableCopy({
    id: row.id,
    namespaceId: row.namespace_id,
    agentId: row.agent_id,
    creatorPrincipalId: row.creator_principal_id,
    nativeAgentId: row.native_agent_id,
    nativeJobId: row.native_job_id,
    toolGrant: row.tool_grant,
    retiredAt: row.retired_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  });
}

export function postgresAgentAutomations(client: PostgresQueryClient): AgentAutomationRepository {
  return {
    async discardUnbound(namespaceId, agentId, id, creatorPrincipalId) {
      const result = await client.query(
        "SELECT occ.discard_unbound_agent_automation($1,$2,$3,$4) AS discarded",
        [namespaceId, agentId, id, creatorPrincipalId],
      );
      return (result.rows[0] as { discarded: boolean } | undefined)?.discarded === true;
    },
    async find(namespaceId, agentId, id) {
      const result = await client.query(
        "SELECT * FROM occ.agent_automations WHERE namespace_id=$1 AND agent_id=$2 AND id=$3",
        [namespaceId, agentId, id],
      );
      return result.rows[0] ? fromRow(result.rows[0] as Row) : undefined;
    },
    async list(namespaceId, agentId, creatorPrincipalId) {
      const result = await client.query(
        `SELECT * FROM occ.agent_automations WHERE namespace_id=$1 AND agent_id=$2
         AND ($3::text IS NULL OR creator_principal_id=$3) ORDER BY id`,
        [namespaceId, agentId, creatorPrincipalId ?? null],
      );
      return Object.freeze(result.rows.map((row) => fromRow(row as Row)));
    },
    async bind(namespaceId, agentId, id, nativeJobId) {
      const changed = await client.query(
        "UPDATE occ.agent_automations SET native_job_id=$4 WHERE namespace_id=$1 AND agent_id=$2 AND id=$3 AND native_job_id IS NULL RETURNING *",
        [namespaceId, agentId, id, nativeJobId],
      );
      if (changed.rows[0]) {
        return { record: fromRow(changed.rows[0] as Row), changed: true };
      }
      const found = await client.query(
        "SELECT * FROM occ.agent_automations WHERE namespace_id=$1 AND agent_id=$2 AND id=$3 AND native_job_id=$4",
        [namespaceId, agentId, id, nativeJobId],
      );
      return found.rows[0] ? { record: fromRow(found.rows[0] as Row), changed: false } : undefined;
    },
    async retire(namespaceId, agentId, id, retiredAt) {
      const changed = await client.query(
        "UPDATE occ.agent_automations SET retired_at=$4 WHERE namespace_id=$1 AND agent_id=$2 AND id=$3 AND native_job_id IS NOT NULL AND retired_at IS NULL RETURNING *",
        [namespaceId, agentId, id, retiredAt],
      );
      if (changed.rows[0]) {
        return fromRow(changed.rows[0] as Row);
      }
      const found = await client.query(
        "SELECT * FROM occ.agent_automations WHERE namespace_id=$1 AND agent_id=$2 AND id=$3 AND retired_at IS NOT NULL",
        [namespaceId, agentId, id],
      );
      return found.rows[0] ? fromRow(found.rows[0] as Row) : undefined;
    },
    async create(record) {
      const result = await client.query(
        `INSERT INTO occ.agent_automations
         (id,namespace_id,agent_id,creator_principal_id,native_agent_id,tool_grant,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          record.id,
          record.namespaceId,
          record.agentId,
          record.creatorPrincipalId,
          record.nativeAgentId,
          record.toolGrant,
          record.createdAt,
        ],
      );
      return fromRow(result.rows[0] as Row);
    },
  };
}
