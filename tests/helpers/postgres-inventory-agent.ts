import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { createPostgresAgentApp } from "./postgres-agent-app.mjs";

// An active Agent whose only revision is reconciled, with a helper that appends retained
// lifecycle work for further revisions.
export async function seedInventoryAgent(t: TestContext, label: string) {
  const { deployAgent, inject, pool, principal, state } = await createPostgresAgentApp(t, {
    label,
    authSecret: "synthetic-deployment-inventory-auth-secret",
    controllerOptions: { recordOperations: true },
  });
  const { namespace, agent, revision } = await deployAgent("Inventory Agent");
  const completed = await pool.query(
    `UPDATE occ.controller_work
     SET state = 'succeeded', attempt_count = 1, completed_at = now(), updated_at = now(),
         reason_code = 'REVISION_ACTIVATED'
     WHERE idempotency_key = $1`,
    [`agent_revision:${revision.id}:reconcile`],
  );
  assert.equal(completed.rowCount, 1);
  await state.transact(async ({ agents, operations }) => {
    assert.ok(
      await agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id),
    );
    // Outstanding credential withdrawal on the active revision does not block inventory.
    await operations.append({
      kind: "agent_revision",
      action: "reconcile",
      target: "credentials_withdrawn",
      operationId: "inventory-withdrawal",
      namespaceId: namespace.id,
      resourceId: revision.id,
      actorId: principal.id,
    });
  });

  const appendHistory = async (
    offset: number,
    count: number,
    workState: "queued" | "failed_permanent",
    keySuffix = "reconcile",
    actorId = principal.id,
  ) => {
    const inserted = await pool.query(
      `WITH history AS (
         INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec,
            gateway_managed_mode, admitted_at)
         SELECT 'rev_' || gen_random_uuid(), namespace_id, agent_id, revision_number + n,
                backend_id, admitted_spec, gateway_managed_mode, now()
         FROM occ.agent_revisions, generate_series($2::int, $2::int + $3::int - 1) AS n
         WHERE id = $1
         RETURNING id, namespace_id, agent_id
       )
       INSERT INTO occ.controller_work
         (idempotency_key, namespace_id, agent_id, revision_id, actor_id, state, available_at,
          attempt_count, completed_at, reason_code, created_at, updated_at)
       SELECT 'agent_revision:' || id || ':' || $6, namespace_id, agent_id, id, $4, $5, now(),
              CASE WHEN $5 = 'queued' THEN 0 ELSE 1 END,
              CASE WHEN $5 = 'queued' THEN NULL ELSE now() END,
              CASE WHEN $5 = 'queued' THEN NULL ELSE 'CONVERGENCE_DEADLINE_EXCEEDED' END,
              now(), now()
       FROM history`,
      [revision.id, offset, count, actorId, workState, keySuffix],
    );
    assert.equal(inserted.rowCount, count);
  };
  return { agent, appendHistory, inject, namespace, pool, revision };
}
