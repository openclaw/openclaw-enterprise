// Run in the worker on failure. Return only the classified reason for this AgentRevision.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createPostgresPool } from "/app/packages/occ/src/index.ts";

const [namespace, agent, revision, mode, originalReason, tenant, sandbox] = process.argv.slice(2);
const pool = await createPostgresPool(process.env.OCC_DATABASE_URL, { max: 1 });
const client = await pool.connect();
try {
  const { rows } = await client.query(
    `SELECT blocked, write_pending, target->>'workspace' AS workspace, target->>'sandbox' AS sandbox
     FROM occ.credential_deliveries
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
  if (mode === "recovery-target") {
    // Only a recorded terminal cause qualifies. A pending provider write, even
    // on a closed route, needs independent investigation.
    const [route] = rows;
    if (
      rows.length !== 1 ||
      route.write_pending !== null ||
      !["bootstrap_failed", "worker_replaced", "supervisor_replaced"].includes(route.blocked)
    ) {
      process.exitCode = 1;
    } else {
      // Store the target on the private runner before retirement can delete its row.
      assert.ok(route.workspace && route.sandbox);
      console.log(
        JSON.stringify({
          reason: route.blocked,
          workspace: route.workspace,
          sandbox: route.sandbox,
        }),
      );
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
        (r) => r.write_pending !== null || !["withdrawn", originalReason].includes(r.blocked),
      ) ||
      !families.every((f) => f.read_only === true && f.retired === true)
    ) {
      process.exitCode = 1;
    }
  } else if (mode === "sandbox-deleted") {
    assert.equal(originalReason, "supervisor_replaced");
    assert.ok(tenant && sandbox);
    assert.ok(rows.every((r) => r.workspace === tenant && r.sandbox === sandbox));
    await verifySandboxDeleted(tenant, sandbox);
  } else {
    for (const { blocked } of rows) {
      if (reasons.has(blocked)) console.log("Git route:", blocked);
    }
  }
} finally {
  client.release();
  await pool.end();
}

// OpenShell can hide an existing Sandbox with NOT_FOUND. Use the same membership
// check and second authenticated target read as the Sandbox Driver when it stops a revision.
async function verifySandboxDeleted(tenant, sandbox) {
  const { loadYaml } = createRequire("/app/apps/controller/package.json")(
    "@kubernetes/client-node",
  );
  const { OpenShellGateway } = await import("/app/apps/controller/src/backends/openshell.ts");
  const installation = loadYaml(readFileSync(process.env.OCC_CONFIG_PATH, "utf8"));
  const backends = installation.backend.filter(
    (b) => b.type === "openshell" && b.drivers?.sandbox === installation.drivers.sandbox.id,
  );
  assert.equal(backends.length, 1);
  const config = backends[0].configuration;
  assert.ok(["mtls", "mutualTls"].includes(config.auth?.mode) && config.rootCertificatePath);
  const gateway = new OpenShellGateway(config);
  try {
    const client = gateway.clientForNamespace(tenant);
    const signal = AbortSignal.timeout(15_000);
    const read = () => client.getSandbox({ workspace: tenant, name: sandbox }, signal);
    const { confirmSandboxAbsent } =
      await import("/app/apps/controller/src/drivers/sandbox/openshell-gateway-errors.ts");
    const old =
      (await read()) ??
      (await confirmSandboxAbsent(
        client,
        tenant,
        signal,
        (call) => call(),
        () => new Error("Previous Workspace cannot be verified"),
        read,
      ));
    // Do not include a returned Sandbox object in an assertion failure.
    assert.ok(old === undefined, "Previous Sandbox still present");
  } finally {
    gateway.close();
  }
}
