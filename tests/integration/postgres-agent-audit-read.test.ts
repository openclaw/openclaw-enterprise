import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { AgentAuditPage } from "@openclaw-enterprise/contracts";

import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, withPool } from "../helpers/postgres-database.mjs";
import { grantAgentSecretOperate } from "../helpers/postgres-harness-auth.ts";
import { waitUntil } from "../helpers/wait-for.ts";
import { checkGatewayAudit } from "./postgres-agent-audit-gateway-case.ts";
import { openShellAuditHeaders } from "./postgres-agent-audit-sandbox-case.ts";

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
    const { pool, state, principal, app, adminAccount, computeDriver, inject, deployAgent } =
      await createPostgresAgentApp(t, {
        label: "agent-audit",
        authSecret,
        requestAudit: true,
        openShellAuditHeaders,
        transportDatabaseUrl: proxy.url,
        controllerOptions: { recordOperations: true },
        stateOptions: { workQueue: { controlPlaneAuditEnabled: true } },
        appOptions: { agentAuditCursorSecret: authSecret },
      });
    t.after(() => proxy.close());
    const { agent, namespace, revision, secretRef, createRequestId } =
      await deployAgent("Agent Audit Reader");
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
    const firstEvent = firstPage.events[0];
    assert.equal(firstEvent?.event, "api_request");
    assert.equal(firstEvent.operationId, "getAgent");
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
    assert.notEqual(deploymentId, revision.id);

    // A reader's exact Agent grant excludes a peer in the same Namespace,
    // including the peer's revision records.
    const configuration = await inject("POST", `/namespaces/${namespace.id}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("codex", "gpt-4.1"),
    });
    assert.equal(configuration.statusCode, 201, configuration.body);
    const peer = await inject("POST", `/namespaces/${namespace.id}/agents`, {
      name: "Audit peer",
      configurationId: configuration.json().data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "api_key", source: secretRef },
    });
    assert.equal(peer.statusCode, 201, peer.body);
    const peerAgent = peer.json().data;
    const peerPath = `/namespaces/${namespace.id}/agents/${peerAgent.id}`;
    await grantAgentSecretOperate(pool, peerAgent, secretRef.id);
    const peerDeployment = await inject("POST", `${peerPath}/deploy`);
    assert.equal(peerDeployment.statusCode, 202, peerDeployment.body);
    assert.equal((await inject("GET", `${peerPath}/audit-events`)).statusCode, 403);

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
      const lifecycle = page.events.filter((entry) => entry.event === "agent_lifecycle");
      const created = lifecycle.find((entry) => entry.requestId === createRequestId);
      assert.equal(created?.action, "openclaw.agents.create");
      assert.equal(created.actorId, principal.id);
      assert.equal(created.agentRevisionId, undefined);
      const admitted = lifecycle.find(
        (entry) =>
          entry.action === "openclaw.agents.deploy" && entry.agentRevisionId === deploymentId,
      );
      assert.equal(admitted?.outcome, "success");
      assert.equal(admitted.actorId, principal.id);
      assert.equal(admitted.requestId, deploy.json().meta.requestId);
      const peerRequestIds = [peer.json().meta.requestId, peerDeployment.json().meta.requestId];
      assert.ok(page.events.every((entry) => !peerRequestIds.includes(entry.requestId)));
      const queued = page.events.find(
        (entry) =>
          entry.event === "work_queued" && entry.requestId === deploy.json().meta.requestId,
      );
      assert.ok(queued?.event === "work_queued" && queued.workId);
      const claimed = page.events.find(
        (entry) => entry.event === "work_claimed" && entry.workId === queued.workId,
      );
      const completed = page.events.find(
        (entry) => entry.event === "work_result" && entry.workId === queued.workId,
      );
      assert.ok(claimed?.event === "work_claimed");
      assert.ok(completed?.event === "work_result");
      assert.equal(claimed?.workState, "claimed");
      assert.equal(claimed?.attemptId, claimed?.id);
      assert.equal(completed?.workState, "failed_permanent");
      assert.equal(completed?.outcome, "failure");
      assert.equal(completed?.attemptId, claimed?.attemptId);
      assert.ok(!JSON.stringify([queued, claimed, completed]).includes(deploymentId));
      assert.ok(!response.body.includes(workKey));
      assert.ok(!response.body.includes("SECRET_DRIVER_MISMATCH"));
      assert.ok(!response.body.includes(readOther.json().meta.requestId));
    } finally {
      await worker.stop();
    }

    await t.test("the Gateway can write only for its registered Agent revision", async (child) => {
      const peerGrant = await inject("POST", `${iamPath}/access-bindings`, {
        ...binding,
        resourceId: peerAgent.id,
      });
      assert.equal(peerGrant.statusCode, 201, peerGrant.body);
      await checkGatewayAudit(child, {
        app,
        pool,
        state,
        migrationUrl,
        revision,
        other: other.revision,
        codex: peerDeployment.json().data,
        replacementId: deploymentId,
        readPage: async (agentId) => {
          const response = await inject(
            "GET",
            `/namespaces/${namespace.id}/agents/${agentId}/audit-events`,
          );
          assert.equal(response.statusCode, 200, response.body);
          return response.json().data;
        },
      });
    });

    await t.test(
      "an analyst needs both direct grants before looking up a turn message",
      async () => {
        const page = await inject("GET", auditPath);
        assert.equal(page.statusCode, 200, page.body);
        const events: AgentAuditPage["events"] = page.json().data.events;
        const turn = events.find(
          (event) =>
            event.event === "runtime_activity" && event.action === "openclaw.runtime.turn.started",
        );
        assert.ok(turn);
        const path = `${auditPath}/${turn.id}/message`;
        const read = () => inject("GET", path);
        assert.equal((await app.inject({ method: "GET", url: path })).statusCode, 401);
        assert.equal((await read()).statusCode, 403);
        const permission = { action: "read_audit_content", resourceKind: "agent" };
        const contentRole = await inject("POST", `${iamPath}/roles`, { permissions: [permission] });
        assert.equal(contentRole.statusCode, 201, contentRole.body);
        const subject = {
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: contentRole.json().data.id,
        };
        const bind = async (resourceId: string) => {
          const response = await inject("POST", `${iamPath}/access-bindings`, {
            ...subject,
            resourceKind: "agent",
            resourceId,
          });
          assert.equal(response.statusCode, 201, response.body);
        };
        // A peer grant gives no access to this chat, even when the caller knows the event ID.
        await bind(peerAgent.id);
        assert.equal((await read()).statusCode, 403);
        const peerRead = await inject("GET", `${peerPath}/audit-events/${turn.id}/message`);
        assert.equal(peerRead.statusCode, 404, peerRead.body);

        // Both exact grants allow the lookup. This turn has no live link to open.
        await bind(agent.id);
        const missing = await read();
        assert.equal(missing.statusCode, 404, missing.body);
        assert.equal(missing.json().data, undefined);
        assert.equal((await inject("GET", `${path}?messageId=other`)).statusCode, 400);
        const removed = await inject(
          "DELETE",
          `${iamPath}/access-bindings/${grantedAgain.json().data.id}`,
        );
        assert.equal(removed.statusCode, 204, removed.body);
        assert.equal((await read()).statusCode, 403);
      },
    );
  },
);
