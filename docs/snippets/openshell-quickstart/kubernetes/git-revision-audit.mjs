// Run inside the selected OCE worker. Return scoped metadata, never sealed values.
import { createPostgresPool } from "/app/packages/occ/src/index.ts";

const [namespace, agent, revision] = process.argv.slice(2);
const pool = await createPostgresPool(process.env.OCC_DATABASE_URL, { max: 1 });
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const attempts = await client.query(
      `SELECT a.material_version, a.custody, a.sealed IS NOT NULL AS sealed_present
       FROM occ.prepared_github_attempts a JOIN occ.prepared_github_families f ON f.source_id=a.source_id
       WHERE f.source #>> '{session,namespaceId}'=$1 AND f.source #>> '{session,agentId}'=$2
         AND f.source #>> '{session,revisionId}'=$3`,
      [namespace, agent, revision],
    );
    const uses = await client.query(
      `SELECT u.exchange_id, u.operation, u.material_version
       FROM occ.prepared_repository_git_uses u JOIN occ.repository_session_attempts s ON s.admission_id=u.admission_id
       WHERE s.namespace_id=$1 AND s.agent_id=$2 AND s.revision_id=$3`,
      [namespace, agent, revision],
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ revision, attempts: attempts.rows, uses: uses.rows }));
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
