import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Agent, SecretReference } from "../../packages/contracts/src/index.ts";

export async function grantAgentSecretOperate(
  pool: {
    query(
      text: string,
      values: [
        namespaceId: string,
        agentId: string,
        roleId: string,
        bindingId: string,
        secretId: string,
      ],
    ): Promise<{ rowCount: number | null }>;
  },
  agent: Pick<Agent, "namespaceId" | "id">,
  secretId: SecretReference["id"],
): Promise<void> {
  // Use the persisted ServicePrincipal as the subject and scope operate to the selected Secret.
  const { rowCount } = await pool.query(
    `WITH principal AS (
       SELECT service_principal_id FROM occ.agents WHERE namespace_id = $1 AND id = $2
     ), role AS (
       INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       SELECT $3, $1, 'Harness Secret operate',
              '[{"action":"operate","resourceKind":"secret"}]'::jsonb
       FROM principal RETURNING id
     )
     INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
     SELECT $4, $1, principal.service_principal_id, role.id, 'secret', $5
     FROM principal CROSS JOIN role`,
    [agent.namespaceId, agent.id, `role-${randomUUID()}`, `binding-${randomUUID()}`, secretId],
  );
  assert.equal(rowCount, 1, "the Agent must have a persisted service Principal");
}
