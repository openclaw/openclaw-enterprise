import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import type {
  AgentRevision,
  HarnessAuthBinding,
  NamespaceStatus,
} from "@openclaw-enterprise/contracts";
import type {
  EnqueueWork,
  PostgresWorkQueue,
  PostgresWorkQueueOptions,
} from "../../packages/occ/src/state/postgres-work-queue.ts";
import { databaseUrl } from "../helpers/postgres-database.mjs";

export async function dependencies(context: TestContext, options: PostgresWorkQueueOptions = {}) {
  const [{ Pool }, queueModule] = await Promise.all([
    import("pg"),
    import("../../packages/occ/src/state/postgres-work-queue.ts"),
  ]);
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  context.after(() => pool.end());
  const queue = new queueModule.PostgresWorkQueue(pool, {
    claimRaceRetries: 16,
    random: () => 0,
    ...options,
  });
  return { pool, queue, ...queueModule };
}

export async function createNamespace(pool: Pool, status: NamespaceStatus = "ready") {
  const namespaceId = `ns_${randomUUID()}`;
  await pool.query<never>(
    `INSERT INTO occ.namespaces (id, name, status, created_at)
     VALUES ($1, $2, $3, clock_timestamp())`,
    [namespaceId, `Queue integration ${randomUUID()}`, status],
  );
  return namespaceId;
}

export async function createResources(pool: Pool, agentCount = 1) {
  const client = await pool.connect();
  const namespaceId = `ns_${randomUUID()}`;
  const agents: string[] = [];
  try {
    await client.query<never>("BEGIN");
    await client.query<never>(
      `INSERT INTO occ.namespaces (id, name, status, created_at)
       VALUES ($1, $2, 'ready', clock_timestamp())`,
      [namespaceId, `Queue integration ${randomUUID()}`],
    );
    for (let index = 0; index < agentCount; index += 1) {
      const agentId = `agt_${randomUUID()}`;
      const configurationId = `cfg_${randomUUID()}`;
      const identityId = `service-agent-${randomUUID()}`;
      const secretId = `sec_${randomUUID()}`;
      const harnessAuth: Extract<HarnessAuthBinding, { method: "api_key" }> = {
        method: "api_key",
        source: { kind: "secret", namespaceId, id: secretId },
      };
      await client.query<never>(
        `INSERT INTO occ.configurations (id, namespace_id, kind, generation, created_at)
         VALUES ($1, $2, 'agent', 1, clock_timestamp())`,
        [configurationId, namespaceId],
      );
      await client.query<never>(
        `INSERT INTO occ.secrets
           (id, namespace_id, name, driver_id, backend_namespace_name, backend_name,
            backend_key, backend_uid, created_at)
         VALUES ($1, $2, $1, 'secret-queue', 'queue-recovery', $3, 'value', $4, clock_timestamp())`,
        [secretId, namespaceId, `harness-${randomUUID()}`, randomUUID()],
      );
      await client.query<never>(
        `INSERT INTO occ.agents
           (id, namespace_id, name, configuration_id, backend_id, execution_mode, service_principal_id,
            harness_auth, created_at)
         VALUES ($1, $2, $3, $4, NULL, 'embedded', $5, $6::jsonb, clock_timestamp())`,
        [
          agentId,
          namespaceId,
          `Queue agent ${randomUUID()}`,
          configurationId,
          identityId,
          JSON.stringify(harnessAuth),
        ],
      );
      await client.query<never>(
        `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind)
         VALUES ($1, $2, $3, 'service_principal')`,
        [identityId, namespaceId, agentId],
      );
      agents.push(agentId);
    }
    await client.query<never>("COMMIT");
    return { namespaceId, agents };
  } catch (error) {
    await client.query<never>("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createQueueRevision(
  pool: Pool,
  namespaceId: string,
  agentId: string,
  revisionNumber = 1,
  repositoryCredentials?: AgentRevision["repositoryCredentials"],
) {
  const revisionId = `rev_${randomUUID()}`;
  const configuration = await pool.query<{
    configuration_id: string;
    harness_auth: Extract<HarnessAuthBinding, { method: "api_key" }>;
    driver_id: string;
  }>(
    `SELECT agent.configuration_id, agent.harness_auth, secret.driver_id
     FROM occ.agents agent
     JOIN occ.secrets secret
       ON secret.namespace_id = agent.namespace_id AND secret.id = agent.harness_auth_secret_id
     WHERE agent.namespace_id = $1 AND agent.id = $2`,
    [namespaceId, agentId],
  );
  assert.equal(configuration.rowCount, 1, "queued revisions require an exact same-Namespace Agent");
  const [agent] = configuration.rows;
  assert.ok(agent);
  const admittedSpec = {
    draft_spec: {},
    harness_auth: {
      ...agent.harness_auth,
      secretDriverId: agent.driver_id,
    },
    configuration_id: agent.configuration_id,
    configuration_kind: "agent",
    configuration_generation: 1,
    harness: {
      id: "openclaw",
      version: "1.0.0",
      mode: "embedded",
      overrides: {},
      configuration: {},
    },
    compute: { id: "compute-queue", implementation: "deterministic-queue" },
    execution_admission: { version: 2, mode: "unprotected" },
    ...(repositoryCredentials === undefined
      ? {}
      : { repository_credentials: repositoryCredentials }),
  };
  await pool.query<never>(
    `INSERT INTO occ.agent_revisions
       (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp())`,
    [revisionId, namespaceId, agentId, revisionNumber, JSON.stringify(admittedSpec)],
  );
  return revisionId;
}

export function namespaceWork(
  namespaceId: string,
  idempotencyKey: string,
  availableAt = new Date(0),
  namespaceTarget: NonNullable<EnqueueWork["namespaceTarget"]> = "ready",
) {
  return {
    idempotencyKey,
    namespaceId,
    namespaceTarget,
    actorId: "principal-queue-integration",
    availableAt,
  } satisfies EnqueueWork;
}

export function revisionWork(
  namespaceId: string,
  idempotencyKey: string,
  agentId: string,
  revisionId: string,
  availableAt = new Date(0),
) {
  return {
    idempotencyKey,
    namespaceId,
    agentId,
    revisionId,
    actorId: "principal-queue-integration",
    availableAt,
  } satisfies EnqueueWork;
}

export async function claimExpected(queue: PostgresWorkQueue, idempotencyKey: string) {
  for (let index = 0; index < 200; index += 1) {
    const claim = await queue.claim();
    if (!claim) {
      break;
    }
    if (claim.idempotencyKey === idempotencyKey) {
      return claim;
    }
    await queue.complete(claim);
  }
  assert.fail(`The durable queue did not expose expected work ${idempotencyKey}.`);
}
