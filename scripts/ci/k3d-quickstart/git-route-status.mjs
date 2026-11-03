// Run in the worker on failure. Return only the classified reason for this AgentRevision.
import { createPostgresPool } from "/app/packages/occ/src/index.ts";

const [namespace, agent, revision, mode] = process.argv.slice(2);
const pool = await createPostgresPool(process.env.OCC_DATABASE_URL, { max: 1 });
const client = await pool.connect();
try {
  const { rows } = await client.query(
    `SELECT blocked, write_pending FROM occ.credential_deliveries
     WHERE namespace_id=$1 AND agent_id=$2 AND revision_id=$3
       AND settlement='snapshot' AND target->>'transport'='openshell-repository-git/v1'`,
    [namespace, agent, revision],
  );
  const reasons = new Set([
    "bootstrap_failed",
    "execution_replaced",
    "gateway_unauthorized",
    "grant_changed",
    "material_mismatch",
    "preview_install_unverified",
    "preview_release_unconfirmed",
    "provider_missing",
    "provider_overlap",
    "repository_expired",
    "sandbox_mismatch",
    "supervisor_replaced",
    "withdrawn",
    "worker_replaced",
    "write_refused",
    "write_unknown",
  ]);
  if (mode === "recovery-reason") {
    // Only a recorded terminal cause qualifies. A pending provider write, even
    // on a closed route, needs independent investigation.
    const [route] = rows;
    if (
      rows.length !== 1 ||
      route.write_pending !== null ||
      !["bootstrap_failed", "worker_replaced"].includes(route.blocked)
    ) {
      process.exitCode = 1;
    } else {
      console.log(route.blocked);
    }
  } else if (mode === "retired") {
    // Check the immutable admitted grant and every attempt. A quarantined
    // attempt is disqualifying even if custody now reads not_issued.
    const { rows: families } = await client.query(
      `SELECT
        f.source #> '{grant,permissions}' = '{"metadata":"read","contents":"read"}'::jsonb
        AND f.source #> '{grant,repositories}' = '[{"repositoryId":"1412618387","repository":"oce-test/oce-app-test"}]'::jsonb AS read_only,
        NOT EXISTS (SELECT 1 FROM occ.prepared_github_attempts a WHERE a.source_id=f.source_id
          AND (a.state<>'committed' OR a.custody NOT IN ('revoked','expired') OR a.sealed IS NOT NULL)) AS retired
       FROM occ.prepared_github_families f WHERE f.source #>> '{session,namespaceId}'=$1
       AND f.source #>> '{session,agentId}'=$2 AND f.source #>> '{session,revisionId}'=$3`,
      [namespace, agent, revision],
    );
    if (
      rows.some(
        (r) =>
          r.write_pending !== null ||
          !["withdrawn", "bootstrap_failed", "worker_replaced"].includes(r.blocked),
      ) ||
      !families.every((f) => f.read_only === true && f.retired === true)
    )
      process.exitCode = 1;
  } else {
    for (const { blocked } of rows) {
      if (reasons.has(blocked)) console.log("Git route:", blocked);
    }
  }
} finally {
  client.release();
  await pool.end();
}
