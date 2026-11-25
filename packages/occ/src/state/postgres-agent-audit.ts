import { createHash } from "node:crypto";
import type { AgentAuditEntry } from "@openclaw-enterprise/contracts";

export const SELECT_AGENT_AUDIT = `
  SELECT id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
         action, outcome, actor_id AS "actorId",
         details->'__occAuditMetadata'->>'requestId' AS "requestId",
         details->>'operationId' AS "operationId",
         details->>'workId' AS "workId", details->>'attemptId' AS "attemptId",
         details->>'workState' AS "workState"
  FROM occ.audit_events
  WHERE namespace_id = $1
    AND (CASE WHEN resource_kind = 'agent' THEN resource_id ELSE details->>'agentId' END) = $2
    AND occurred_at >= $3::timestamptz AND occurred_at <= $4::timestamptz
    AND ($5::timestamptz IS NULL OR (occurred_at, id) < ($5::timestamptz, $6::text))
    AND ((resource_kind = 'agent' AND kind = 'api_request'
        AND action = 'openclaw.api.request.result' AND outcome = 'success')
      OR (resource_kind IN ('agent','agent_revision') AND kind = 'mutation'
        AND details->>'agentId' IS NOT NULL
        AND (action IN ('openclaw.controller_work.queued','openclaw.controller_work.claimed')
          OR (action IN ('reconcile','openclaw.controller_work.deferred','openclaw.controller_work.completed')
            AND details->>'attemptId' IS NOT NULL))))
  ORDER BY occurred_at DESC, id DESC
  LIMIT $7
`;

const events = new Map<string, AgentAuditEntry["event"]>([
  ["openclaw.api.request.result", "api_request"],
  ["openclaw.controller_work.queued", "work_queued"],
  ["openclaw.controller_work.claimed", "work_claimed"],
  ["openclaw.controller_work.deferred", "work_deferred"],
  ["openclaw.controller_work.completed", "work_completed"],
  ["reconcile", "work_result"],
]);
const allowedWorkStates = new Set<unknown>([
  "queued",
  "claimed",
  "succeeded",
  "failed_permanent",
  "superseded",
]);

const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const actorIdPattern = new RegExp(`^(prn|spn)_${UUID_V4}$`);
const requestIdPattern = new RegExp(`^req_${UUID_V4}$`);
const auditIdPattern = new RegExp(`^aud_${UUID_V4}$`);
// Controller-owned keys only. A digest lets readers join a job's records without exposing
// a key that embeds Revision identity, an operation reference, or a provisioning key.
const workIdPattern =
  /^(?:agent-provisioning|agent|agent_revision):[A-Za-z0-9:_-]{1,180}(?![\s\S])/;

export function projectAgentAuditRow(row: Record<string, unknown>): AgentAuditEntry {
  const event = events.get(row.action as string)!;
  const common = {
    id: row.id as string,
    occurredAt: row.occurredAt as string,
    outcome: row.outcome as AgentAuditEntry["outcome"],
    ...(typeof row.actorId === "string" && actorIdPattern.test(row.actorId)
      ? { actorId: row.actorId }
      : {}),
    ...(typeof row.requestId === "string" && requestIdPattern.test(row.requestId)
      ? { requestId: row.requestId }
      : {}),
  };
  if (event === "api_request") {
    return {
      ...common,
      event,
      ...(row.operationId === "getAgent" ? { operationId: row.operationId } : {}),
    };
  }
  return {
    ...common,
    event,
    ...(typeof row.workId === "string" && workIdPattern.test(row.workId)
      ? { workId: `work_${createHash("sha256").update(row.workId).digest("hex")}` }
      : {}),
    ...(typeof row.attemptId === "string" && auditIdPattern.test(row.attemptId)
      ? { attemptId: row.attemptId }
      : {}),
    ...(allowedWorkStates.has(row.workState)
      ? { workState: row.workState as AgentAuditEntry["workState"] & string }
      : {}),
  };
}
