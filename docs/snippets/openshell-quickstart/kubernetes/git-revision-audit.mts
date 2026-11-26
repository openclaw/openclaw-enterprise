// Run inside the selected OCE worker. Return scoped metadata, never sealed values.
import assert from "node:assert/strict";
import { createPostgresPool } from "/app/packages/occ/src/index.ts";

interface AttemptEvidence {
  material_version: string | null;
  custody: string;
  sealed_present: boolean;
}

interface UseEvidence {
  exchange_id: string;
  operation: string;
  material_version: string;
}

const [namespace, agent, revision] = process.argv.slice(2);
const scope: [
  namespace: string | undefined,
  agent: string | undefined,
  revision: string | undefined,
] = [namespace, agent, revision];
const databaseUrl = process.env.OCC_DATABASE_URL;
assert.ok(databaseUrl !== undefined, "The worker must supply OCC_DATABASE_URL.");
const pool = await createPostgresPool(databaseUrl, { max: 1 });
try {
  const client = await pool.connect();
  try {
    await client.query<never, []>("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const attempts = await client.query<AttemptEvidence, typeof scope>(
      `SELECT a.material_version, a.custody, a.sealed IS NOT NULL AS sealed_present
       FROM occ.prepared_github_attempts a JOIN occ.prepared_github_families f ON f.source_id=a.source_id
       WHERE f.source #>> '{session,namespaceId}'=$1 AND f.source #>> '{session,agentId}'=$2
         AND f.source #>> '{session,revisionId}'=$3`,
      scope,
    );
    const uses = await client.query<UseEvidence, typeof scope>(
      `SELECT u.exchange_id, u.operation, u.material_version
       FROM occ.prepared_repository_git_uses u JOIN occ.repository_session_attempts s ON s.admission_id=u.admission_id
       WHERE s.namespace_id=$1 AND s.agent_id=$2 AND s.revision_id=$3`,
      scope,
    );
    await client.query<never, []>("COMMIT");
    console.log(JSON.stringify({ revision, attempts: attempts.rows, uses: uses.rows }));
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
