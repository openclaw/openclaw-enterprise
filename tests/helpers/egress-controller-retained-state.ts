import assert from "node:assert/strict";
import { isArray, isRecord } from "./egress-observation-values.ts";
import type { UpgradeDeployment, UpgradeStack } from "./egress-upgrade-contracts.ts";

function aggregate(value: unknown): Record<string, unknown>[] | null {
  if (value === null) {
    return null;
  }
  const rows: unknown[] = isArray(value) ? value : [];
  assert.ok(isArray(value) && rows.every(isRecord), "expected retained PostgreSQL rows");
  return rows;
}

export async function retainedState(stack: UpgradeStack, deployment: UpgradeDeployment) {
  const { pool, namespace } = stack;
  const { agent } = deployment;
  // Read metadata only: Secret values remain in their owning Driver. These real
  // database rows expose generation and owner changes that API projections omit.
  const observed = await pool.query(
    `SELECT jsonb_build_object(
    'sources', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM occ.credential_sources s WHERE namespace_id = $1),
    'secretRefs', (SELECT jsonb_agg(to_jsonb(s) ORDER BY credential_source_id, field) FROM occ.credential_source_secrets s WHERE namespace_id = $1),
    'revisions', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM occ.agent_revisions r WHERE namespace_id = $1 AND agent_id = $2),
    'installations', (SELECT jsonb_agg(to_jsonb(i) ORDER BY sender_id, sandbox_id) FROM occ.egress_installations i WHERE namespace_id = $1 AND agent_id = $2),
    'work', (SELECT jsonb_agg(to_jsonb(w) ORDER BY idempotency_key) FROM occ.controller_work w WHERE namespace_id = $1)
    ) AS state`,
    [namespace.id, agent.id],
  );
  const state = observed.rows[0]?.state;
  assert.ok(isRecord(state), "expected retained PostgreSQL state");
  // PostgreSQL jsonb_agg returns null for empty inputs. Keep complete row JSON
  // and preserve nulls in the equality and digest checkpoints.
  return {
    ...state,
    sources: aggregate(state.sources),
    secretRefs: aggregate(state.secretRefs),
    revisions: aggregate(state.revisions),
    installations: aggregate(state.installations),
    work: aggregate(state.work),
  };
}
