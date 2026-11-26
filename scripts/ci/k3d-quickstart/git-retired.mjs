// Run inside the worker. Reuse the actual push's authorization inputs; no GitHub token
// or supervisor JWT is needed at the pre-send decision boundary.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import { createPostgresPool } from "/app/packages/occ/src/index.ts";
import { startPreparedGitHubGitOwner } from "/app/apps/controller/src/backends/repository-credentials/prepared-git-owner.ts";
import { loadInstallationConfiguration } from "/app/apps/controller/src/composition/installation-config.ts";
import { repositoryGitAuthority } from "/app/apps/controller/src/composition/repository-credentials/custody-selection.ts";
import { protectedOpenShellGitOwner } from "/app/apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";

const [mode, namespace, agent, revision] = process.argv.slice(1);
const pool = await createPostgresPool(process.env.OCC_DATABASE_URL, { max: 1 });
let owner;
try {
  if (mode === "capture") {
    // Take the exact observation while it exists. Retirement can delete the live route.
    const { rows } = await pool.query(
      `SELECT s.session_id AS "sessionId", f.source #>> '{session,binding,grant,providerInstanceId}' AS "providerInstanceId",
           f.source #>> '{grant,id}' AS "grantId", f.source #>> '{grant,installationId}' AS "installationId",
           f.source #> '{grant,repositories}' AS repositories, u.request_digest_sha256 AS "requestDigestSha256",
           u.attempt_id AS "preparationAttemptId", u.material_version AS "materialVersion",
           r.fence, r.observed
       FROM occ.prepared_repository_git_uses u
       JOIN occ.repository_session_attempts s USING (admission_id)
       JOIN occ.prepared_github_families f ON f.source_id='repository-git:' || s.admission_id
       JOIN occ.credential_deliveries r ON (r.namespace_id,r.agent_id,r.revision_id)=(s.namespace_id,s.agent_id,s.revision_id)
       WHERE (s.namespace_id,s.agent_id,s.revision_id)=($1,$2,$3)
         AND u.operation='receive-pack' AND u.authorization_reply_by IS NOT NULL
         AND r.settlement='snapshot' AND r.target->>'transport'='openshell-repository-git/v1'
         AND r.blocked IS NULL AND r.write_pending IS NULL
         AND (r.fence,r.preparation_attempt_id,r.material_version)=(u.recipient_fence,u.attempt_id,u.material_version)
       ORDER BY u.authorization_reply_by DESC LIMIT 1`,
      [namespace, agent, revision],
    );
    assert.equal(rows.length, 1);
    const { fence, observed, preparationAttemptId, materialVersion, ...use } = rows[0];
    assert.equal(observed.executionId, revision);
    assert.deepEqual(use.repositories, [
      { repositoryId: "1412618387", repository: "oce-test/oce-app-test" },
    ]);
    const installed = {
      preparationAttemptId,
      materialVersion,
      route: { revisionId: revision, fence: Number(fence), observed },
    };
    console.log(JSON.stringify({ installed, use }));
  } else {
    assert.equal(mode, "denied");
    const { use, installed } = JSON.parse(readFileSync(0, "utf8"));
    assert.equal(installed.route.revisionId, revision);
    const drivers = await loadInstallationConfiguration({ mode: process.env.NODE_ENV });
    const selection = repositoryGitAuthority(drivers);
    assert.equal(selection.repositoryGitCustody.kind, "selected");
    assert.ok(
      drivers.repositoryTransport && drivers.preparedRepositoryGit && drivers.repositoryOwner,
    );
    assert.ok(
      !drivers.repositoryOwner.controlSocket && !drivers.preparedRepositoryGit.issuerCaPath,
    );
    // Instantiate only the same authorization port as the running worker. No listener,
    // maintenance, credential delivery, or Git sender runs in this probe.
    owner = await startPreparedGitHubGitOwner({
      ...drivers.repositoryOwner,
      ...drivers.preparedRepositoryGit,
      ...selection,
      pool,
      registry: drivers.repositoryRegistry,
      startWorker: false,
    });
    const proxy = protectedOpenShellGitOwner(owner.protectedGit);
    const exchangeId = randomUUID();
    const request = {
      ...use,
      scope: "github-repository",
      operation: "receive-pack",
      exchangeId,
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
    };
    await pool.query("SELECT 1"); // The decision must use the existing DB connection.
    const observers = [
      "net.client.socket",
      "http.client.request.start",
      "undici:request:create",
    ].map(channel);
    let networkCalls = 0;
    const count = () => {
      networkCalls += 1;
    };
    for (const observer of observers) {
      observer.subscribe(count);
    }
    let result;
    try {
      result = await proxy.authorizeOnlineRequest(request, installed, AbortSignal.timeout(15_000));
    } finally {
      for (const observer of observers) {
        observer.unsubscribe(count);
      }
    }
    assert.deepEqual(result, { kind: "denied", reason: "access_withdrawn" });
    assert.equal(networkCalls, 0);
    const receipt = await pool.query(
      "SELECT 1 FROM occ.prepared_repository_git_uses WHERE exchange_id=$1",
      [exchangeId],
    );
    assert.equal(receipt.rowCount, 0);
    console.log(
      JSON.stringify({
        revision,
        exchangeId,
        operation: request.operation,
        reason: result.reason,
        boundary: "openshell-online-authorization",
        newNetworkCalls: networkCalls,
        useReceipts: receipt.rowCount,
      }),
    );
  }
} finally {
  try {
    await owner?.close();
  } finally {
    await pool.end();
  }
}
