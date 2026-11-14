import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { AgentAuditPage } from "@openclaw-enterprise/contracts";

import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, withPool } from "../helpers/postgres-database.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";

const authSecret = "agent-audit-reader-postgres-auth-secret";
const migrationUrl = process.env.OCC_TEST_AGENT_AUDIT_READ_MIGRATION_DATABASE_URL;
const disclosureAction = "openclaw.audit.agent.read";

test(
  "Agent audit pages require an exact current grant and a committed disclosure",
  {
    skip: migrationUrl ? false : "Prepare the dedicated postgres-platform file fixture.",
    timeout: 30_000,
  },
  async (t) => {
    // This test rejects audit writes and interrupts COMMIT on its own disposable database.
    assert.ok(databaseUrl && migrationUrl);
    const appUrl = new URL(databaseUrl);
    const migratorUrl = new URL(migrationUrl);
    assert.ok(
      [appUrl, migratorUrl].every(
        (url) =>
          url.protocol === "postgresql:" &&
          url.hostname === "127.0.0.1" &&
          url.port !== "" &&
          /^\/openclaw_ci_postgres_agent_audit_read_[a-f0-9]{12}$/.test(url.pathname) &&
          url.search === "" &&
          url.hash === "",
      ) &&
        appUrl.port === migratorUrl.port &&
        appUrl.pathname === migratorUrl.pathname &&
        appUrl.username === "occ_app" &&
        migratorUrl.username === "occ_migrator",
    );
    const proxy = await commitAckProxy(databaseUrl, {
      transactionStatement: "SELECT occ.hold_agent_audit_policy($1)",
    });
    const { pool, principal, app, adminAccount, computeDriver, inject, deployAgent } =
      await createPostgresAgentApp(t, {
        label: "agent-audit",
        authSecret,
        requestAudit: true,
        transportDatabaseUrl: proxy.url,
        controllerOptions: { recordOperations: true },
        stateOptions: { workQueue: { controlPlaneAuditEnabled: true } },
        appOptions: { agentAuditCursorSecret: authSecret },
      });
    t.after(() => proxy.close());
    const { agent, namespace, revision } = await deployAgent("Agent Audit Reader");
    const other = await deployAgent("Other Agent");
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const otherPath = `/namespaces/${other.namespace.id}/agents/${other.agent.id}`;
    const auditPath = `${agentPath}/audit-events`;
    const otherAuditPath = `${otherPath}/audit-events`;
    const iamPath = `/namespaces/${namespace.id}/iam`;

    const unsigned = await app.inject({ method: "GET", url: auditPath });
    assert.equal(unsigned.statusCode, 401, unsigned.body);
    const denied = await inject("GET", auditPath);
    assert.equal(denied.statusCode, 403, denied.body);
    const readOne = await inject("GET", agentPath);
    assert.equal(readOne.statusCode, 200, readOne.body);
    const readOther = await inject("GET", otherPath);
    assert.equal(readOther.statusCode, 200, readOther.body);
    const readTwo = await inject("GET", agentPath);
    assert.equal(readTwo.statusCode, 200, readTwo.body);

    const role = await inject("POST", `${iamPath}/roles`, {
      permissions: [{ action: "read_audit", resourceKind: "agent" }],
    });
    assert.equal(role.statusCode, 201, role.body);
    const binding = {
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: role.json().data.id,
      resourceKind: "agent",
      resourceId: agent.id,
    };
    const grant = await inject("POST", `${iamPath}/access-bindings`, binding);
    assert.equal(grant.statusCode, 201, grant.body);
    assert.equal((await inject("GET", otherAuditPath)).statusCode, 403);

    const first = await inject("GET", `${auditPath}?limit=1`);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.headers["cache-control"], "no-store");
    const firstPage: AgentAuditPage = first.json().data;
    assert.equal(firstPage.events.length, 1);
    assert.equal(firstPage.events[0]?.operationId, "getAgent");
    assert.equal(firstPage.events[0]?.requestId, readTwo.json().meta.requestId);
    assert.equal(firstPage.events[0]?.actorId, principal.id);
    assert.ok(firstPage.nextCursor);
    assert.ok(!first.body.includes(revision.id));

    const disclosure = async (requestId: string) =>
      (
        await pool.query(
          `SELECT namespace_id, resource_id, details FROM occ.audit_events
         WHERE kind = 'access' AND action = $1 AND details->'__occAuditMetadata'->>'requestId' = $2`,
          [disclosureAction, requestId],
        )
      ).rows;
    const stored = await disclosure(first.json().meta.requestId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].resource_id, agent.id);
    assert.equal(stored[0].namespace_id, namespace.id);
    assert.equal(stored[0].details.returnedCount, 1);
    assert.equal(stored[0].details.windowStart, firstPage.window.start);
    assert.equal(stored[0].details.windowEnd, firstPage.window.end);
    assert.deepEqual(await disclosure(denied.json().meta.requestId), []);

    const second = await inject("GET", `${auditPath}?cursor=${firstPage.nextCursor}`);
    assert.equal(second.statusCode, 200, second.body);
    const secondPage: AgentAuditPage = second.json().data;
    assert.deepEqual(secondPage.window, firstPage.window);
    assert.equal(secondPage.events[0]?.requestId, readOne.json().meta.requestId);
    assert.equal(
      (await inject("GET", `${otherAuditPath}?cursor=${firstPage.nextCursor}`)).statusCode,
      400,
    );
    const corruptCursor =
      (firstPage.nextCursor[0] === "A" ? "B" : "A") + firstPage.nextCursor.slice(1);
    assert.equal((await inject("GET", `${auditPath}?cursor=${corruptCursor}`)).statusCode, 400);

    // A fresh session for the same human cannot reuse the previous session's cursor.
    const secondSession = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { host: "127.0.0.1" },
      payload: adminAccount,
    });
    assert.equal(secondSession.statusCode, 200, secondSession.body);
    const cookies = secondSession.headers["set-cookie"];
    assert.ok(cookies);
    const otherSession = await app.inject({
      method: "GET",
      url: `${auditPath}?cursor=${firstPage.nextCursor}`,
      headers: {
        host: "127.0.0.1",
        cookie: cookieHeaderFromSetCookie(Array.isArray(cookies) ? cookies : [cookies]),
      },
    });
    assert.equal(otherSession.statusCode, 400, otherSession.body);

    // Revocation takes effect on every page, even when the client already holds a cursor.
    const revoked = await inject("DELETE", `${iamPath}/access-bindings/${grant.json().data.id}`);
    assert.equal(revoked.statusCode, 204, revoked.body);
    const oldPage = await inject("GET", `${auditPath}?cursor=${firstPage.nextCursor}`);
    assert.equal(oldPage.statusCode, 403, oldPage.body);
    assert.deepEqual(await disclosure(oldPage.json().meta.requestId), []);

    const grantedAgain = await inject("POST", `${iamPath}/access-bindings`, binding);
    assert.equal(grantedAgain.statusCode, 201, grantedAgain.body);
    await withPool(migrationUrl, async (migrator: pg.Pool) => {
      await migrator.query(`ALTER TABLE occ.audit_events ADD CONSTRAINT reject_agent_disclosure
        CHECK (action <> 'openclaw.audit.agent.read') NOT VALID`);
      try {
        const blocked = await inject("GET", auditPath);
        assert.equal(blocked.statusCode, 503, blocked.body);
        assert.equal(blocked.json().data, undefined);
        assert.deepEqual(await disclosure(blocked.json().meta.requestId), []);
      } finally {
        await migrator.query(
          "ALTER TABLE occ.audit_events DROP CONSTRAINT reject_agent_disclosure",
        );
      }
    });

    // PostgreSQL commits the disclosure but the controller loses the acknowledgement.
    // The API withholds the page because it cannot verify the write completed.
    proxy.arm();
    const unknown = await inject("GET", auditPath);
    assert.equal(unknown.statusCode, 503, unknown.body);
    assert.equal(unknown.json().data, undefined);
    assert.ok(proxy.observedCommit);
    const unknownRequestId = unknown.json().meta.requestId as string;
    assert.equal((await disclosure(unknownRequestId)).length, 1);
    const unknownResult = await pool.query(
      `SELECT outcome, details->'statusCode' AS "statusCode",
              details->'__occAuditMetadata'->>'reasonCode' AS "reasonCode"
       FROM occ.audit_events WHERE action = 'openclaw.api.request.result'
         AND details->'__occAuditMetadata'->>'requestId' = $1`,
      [unknownRequestId],
    );
    assert.deepEqual(unknownResult.rows, [
      { outcome: "failure", statusCode: 503, reasonCode: "COMMIT_OUTCOME_UNKNOWN" },
    ]);

    // Deploy through HTTP, then let the worker attempt it with its Compute fixture.
    // This worker has no matching Secret Driver, so the deployment fails before Compute.
    const deploy = await inject("POST", `${agentPath}/deploy`);
    assert.equal(deploy.statusCode, 202, deploy.body);
    const deploymentId = deploy.json().data.id as string;
    const workKey = `agent_revision:${deploymentId}:reconcile`;
    const worker = createControllerWorker({
      pool: new pg.Pool({ connectionString: databaseUrl }),
      pollIntervalMs: 20,
      mode: "development",
      controlPlaneAuditEnabled: true,
      computeDriver,
      emit() {},
    });
    await worker.start();
    try {
      await waitUntil("the deployed revision to finish", async () => {
        const result = await pool.query(
          "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
          [workKey],
        );
        return result.rows[0]?.state === "failed_permanent";
      });
      const response = await inject("GET", auditPath);
      assert.equal(response.statusCode, 200, response.body);
      const page: AgentAuditPage = response.json().data;
      const queued = page.events.find(
        (entry) =>
          entry.event === "work_queued" && entry.requestId === deploy.json().meta.requestId,
      );
      assert.ok(queued?.workId);
      const claimed = page.events.find(
        (entry) => entry.event === "work_claimed" && entry.workId === queued.workId,
      );
      const completed = page.events.find(
        (entry) => entry.event === "work_result" && entry.workId === queued.workId,
      );
      assert.equal(claimed?.workState, "claimed");
      assert.equal(claimed?.attemptId, claimed?.id);
      assert.equal(completed?.workState, "failed_permanent");
      assert.equal(completed?.outcome, "failure");
      assert.equal(completed?.attemptId, claimed?.attemptId);
      assert.ok(!response.body.includes(deploymentId));
      assert.ok(!response.body.includes(workKey));
      assert.ok(!response.body.includes("SECRET_DRIVER_MISMATCH"));
      assert.ok(!response.body.includes(readOther.json().meta.requestId));
    } finally {
      await worker.stop();
    }
  },
);
