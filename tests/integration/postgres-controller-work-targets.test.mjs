import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "PostgreSQL controller work requires exactly one complete target shape",
  requiresPostgres,
  async (context) => {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    context.after(async () => {
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    });
    await client.query("BEGIN");

    const namespaceId = `ns_${randomUUID()}`;
    const agentId = `agt_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    const revisionId = `rev_${randomUUID()}`;
    const secretId = `sec_${randomUUID()}`;
    const harnessAuth = {
      method: "api_key",
      source: { kind: "secret", namespaceId, id: secretId },
    };
    // Real owners and an admitted revision ensure failures reach the target CHECK,
    // rather than a foreign-key or snapshot constraint. All fixtures roll back.
    await client.query(
      `INSERT INTO occ.installation (id, name, created_at)
       VALUES ($1, 'Queue target integration', now()) ON CONFLICT DO NOTHING`,
      [`ins_${randomUUID()}`],
    );
    await client.query(
      `INSERT INTO occ.namespaces (id, name, status, created_at)
       VALUES ($1, $1, 'ready', now())`,
      [namespaceId],
    );
    await client.query(
      `INSERT INTO occ.configurations (id, namespace_id, kind, generation, created_at)
       VALUES ($1, $2, 'agent', 1, now())`,
      [configurationId, namespaceId],
    );
    await client.query(
      `INSERT INTO occ.secrets
         (id, namespace_id, name, driver_id, backend_namespace_name, backend_name,
          backend_key, backend_uid, created_at)
       VALUES ($1, $2, $1, 'secret-queue', 'queue-target', 'harness-key', 'value', $3, now())`,
      [secretId, namespaceId, randomUUID()],
    );
    await client.query(
      `INSERT INTO occ.agents
         (id, namespace_id, name, configuration_id, execution_mode, service_principal_id, harness_auth, created_at)
       VALUES ($1, $2, $1, $3, 'embedded', $4, $5::jsonb, now())`,
      [
        agentId,
        namespaceId,
        configurationId,
        `service-agent-${agentId}`,
        JSON.stringify(harnessAuth),
      ],
    );
    await client.query(
      `INSERT INTO occ.agent_revisions
         (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
       VALUES ($1, $2, $3, 1, $4, now())`,
      [
        revisionId,
        namespaceId,
        agentId,
        {
          configuration_id: configurationId,
          configuration_kind: "agent",
          configuration_generation: 1,
          draft_spec: {},
          harness_auth: { ...harnessAuth, secretDriverId: "secret-queue" },
          harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
          compute: {
            id: "compute-local-development",
            implementation: "deterministic-local-development",
          },
        },
      ],
    );

    const cases = [
      { name: "Namespace ready", target: [null, null, "ready", null], valid: true },
      { name: "Namespace deleted", target: [null, null, "deleted", null], valid: true },
      { name: "Agent stop", target: [agentId, null, null, "stopped"], valid: true },
      { name: "Agent deleted", target: [agentId, null, null, "deleted"], valid: true },
      { name: "Agent revision", target: [agentId, revisionId, null, null], valid: true },
      { name: "all-null target", target: [null, null, null, null], valid: false },
      { name: "Agent without target", target: [agentId, null, null, null], valid: false },
      { name: "stop without Agent", target: [null, null, null, "stopped"], valid: false },
      { name: "delete without Agent", target: [null, null, null, "deleted"], valid: false },
      { name: "Namespace target with Agent", target: [agentId, null, "ready", null], valid: false },
      {
        name: "Namespace and stop targets",
        target: [agentId, null, "ready", "stopped"],
        valid: false,
      },
      {
        name: "revision and stop targets",
        target: [agentId, revisionId, null, "stopped"],
        valid: false,
      },
      {
        name: "revision and Namespace targets",
        target: [agentId, revisionId, "ready", null],
        valid: false,
      },
    ];
    for (const { name, target, valid } of cases) {
      await context.test(name, async () => {
        await client.query("SAVEPOINT target_case");
        try {
          const insert = client.query(
            `INSERT INTO occ.controller_work
               (idempotency_key, namespace_id, actor_id, agent_id, revision_id,
                namespace_target, agent_target, available_at, created_at, updated_at)
             VALUES ($1, $2, 'target-shape-test', $3, $4, $5, $6, now(), now(), now())
             RETURNING agent_id, revision_id, namespace_target, agent_target`,
            [randomUUID(), namespaceId, ...target],
          );
          if (valid) {
            const { rows } = await insert;
            assert.deepEqual(rows, [
              {
                agent_id: target[0],
                revision_id: target[1],
                namespace_target: target[2],
                agent_target: target[3],
              },
            ]);
          } else {
            // SQL CHECK accepts UNKNOWN, so missing targets must produce FALSE.
            await assert.rejects(insert, {
              code: "23514",
              constraint: "controller_work_namespace_target_valid",
            });
          }
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT target_case");
          await client.query("RELEASE SAVEPOINT target_case");
        }
      });
    }
  },
);
