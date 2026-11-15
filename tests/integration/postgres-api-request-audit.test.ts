import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";

import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { jsonLineDestination } from "../helpers/json-lines.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, withPool } from "../helpers/postgres-database.mjs";

const authSecret = "request-audit-postgres-auth-secret-minimum-32";
const migrationUrl = process.env.OCC_TEST_API_REQUEST_AUDIT_MIGRATION_DATABASE_URL;

async function withRejectedAuditRows<T>(migrator: Pool, check: string, run: () => Promise<T>) {
  // NOT VALID leaves earlier observations intact and still rejects new inserts.
  await migrator.query(`ALTER TABLE occ.audit_events
    ADD CONSTRAINT reject_request_audit CHECK (${check}) NOT VALID`);
  try {
    return await run();
  } finally {
    await migrator.query("ALTER TABLE occ.audit_events DROP CONSTRAINT reject_request_audit");
  }
}

test(
  "PostgreSQL records API admission and results and blocks work when admission cannot be saved",
  {
    skip: migrationUrl ? false : "Prepare the dedicated postgres-platform file fixture.",
    timeout: 30_000,
  },
  async (t) => {
    // The test temporarily changes the ledger schema. Require this file's disposable CI database.
    assert.ok(databaseUrl && migrationUrl, "The test needs app and migrator URLs.");
    assert.ok(URL.canParse(databaseUrl) && URL.canParse(migrationUrl), "Invalid fixture URLs.");
    const appTarget = new URL(databaseUrl);
    const migratorTarget = new URL(migrationUrl);
    assert.ok(
      [appTarget, migratorTarget].every(
        (url) =>
          url.protocol === "postgresql:" &&
          url.hostname === "127.0.0.1" &&
          url.port !== "" &&
          /^\/openclaw_ci_postgres_api_request_audit_[a-f0-9]{12}$/.test(url.pathname) &&
          url.search === "" &&
          url.hash === "",
      ) &&
        appTarget.port === migratorTarget.port &&
        appTarget.pathname === migratorTarget.pathname &&
        appTarget.username === "occ_app" &&
        migratorTarget.username === "occ_migrator",
      "Both roles must use the same disposable API request audit database.",
    );

    const admittedAction = "openclaw.api.request.admitted";
    const resultAction = "openclaw.api.request.result";
    const logs: Record<string, unknown>[] = [];
    const { app, pool, state, principal, inject, deployAgent } = await createPostgresAgentApp(t, {
      label: "api-audit",
      authSecret,
      requestAudit: true,
      stateOptions: { auditWriteTimeoutMs: 100 },
      appOptions: {
        logger: createOccLogger({
          component: "occ-api-request-audit-test",
          destination: jsonLineDestination(logs),
        }),
      },
    });

    const created = await inject("POST", "/namespaces", { name: `API audit ${randomUUID()}` });
    assert.equal(created.statusCode, 201, created.body);
    const namespace = created.json().data;
    const read = await inject("GET", `/namespaces/${namespace.id}`);
    assert.equal(read.statusCode, 200, read.body);
    const head = await inject("HEAD", `/namespaces/${namespace.id}`);
    assert.equal(head.statusCode, 200, head.body);
    const invalid = await inject("POST", "/namespaces", {});
    assert.equal(invalid.statusCode, 400, invalid.body);
    const invalidPath = await inject("GET", "/namespaces/invalid-resource-id");
    assert.equal(invalidPath.statusCode, 400, invalidPath.body);
    const refuseAnonymous = () =>
      app.inject({
        method: "GET",
        url: "/namespaces",
        headers: { host: "127.0.0.1", "x-request-id": "caller-selected-id" },
      });
    const refused = await refuseAnonymous();
    assert.equal(refused.statusCode, 401, refused.body);
    const refusedRequestId = refused.headers["x-request-id"];
    assert.ok(typeof refusedRequestId === "string");
    assert.match(refusedRequestId, /^req_[0-9a-f-]+$/);

    const { agent, namespace: agentNamespace, secretRef } = await deployAgent("API audit Agent");
    const agentPath = `/namespaces/${agentNamespace.id}/agents/${agent.id}`;
    const agentRead = await inject("GET", agentPath);
    assert.equal(agentRead.statusCode, 200, agentRead.body);
    assert.equal(agentRead.json().data.id, agent.id);
    const agentHead = await inject("HEAD", agentPath);
    assert.equal(agentHead.statusCode, 200, agentHead.body);
    const secretRead = await inject(
      "GET",
      `/namespaces/${agentNamespace.id}/secrets/${secretRef.id}`,
    );
    assert.equal(secretRead.statusCode, 200, secretRead.body);
    // An existing Agent ID under another Namespace must not identify the audit target.
    const agentInWrongNamespace = await inject(
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
    );
    assert.equal(agentInWrongNamespace.statusCode, 404, agentInWrongNamespace.body);
    await pool.query(
      `INSERT INTO occ.iam_restrictions
        (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'delete', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, agentNamespace.id, agent.id],
    );
    const denied = await inject("DELETE", agentPath);
    assert.equal(denied.statusCode, 403, denied.body);

    const blockedName = `Blocked by audit ${randomUUID()}`;
    const rolledBackName = `Rolled back with audit ${randomUUID()}`;
    const committedName = `Committed before audit result ${randomUUID()}`;
    const { blocked, rolledBack, deniedDuringOutage, refusedDuringOutage, createdDuringOutage } =
      await withPool(migrationUrl, async (migrator: Pool) => {
        const blocked = await withRejectedAuditRows(
          migrator,
          "action <> 'openclaw.api.request.admitted'",
          () => inject("POST", "/namespaces", { name: blockedName }),
        );
        // The Namespace must roll back when its required mutation row fails.
        const rolledBack = await withRejectedAuditRows(
          migrator,
          "action <> 'openclaw.namespaces.create'",
          () => inject("POST", "/namespaces", { name: rolledBackName }),
        );
        const deniedDuringOutage = await withRejectedAuditRows(
          migrator,
          "kind <> 'authorization_denial'",
          () => inject("DELETE", agentPath),
        );
        return withRejectedAuditRows(
          migrator,
          "action <> 'openclaw.api.request.result'",
          async () => ({
            blocked,
            rolledBack,
            deniedDuringOutage,
            refusedDuringOutage: await refuseAnonymous(),
            createdDuringOutage: await inject("POST", "/namespaces", { name: committedName }),
          }),
        );
      });
    assert.equal(blocked.statusCode, 503, blocked.body);
    assert.equal(rolledBack.statusCode, 503, rolledBack.body);
    assert.equal(
      (
        await pool.query("SELECT id FROM occ.namespaces WHERE name IN ($1, $2)", [
          blockedName,
          rolledBackName,
        ])
      ).rowCount,
      0,
    );

    assert.equal(deniedDuringOutage.statusCode, denied.statusCode, deniedDuringOutage.body);
    assert.deepEqual(deniedDuringOutage.json().error, denied.json().error);
    assert.equal(refusedDuringOutage.statusCode, refused.statusCode, refusedDuringOutage.body);
    assert.deepEqual(refusedDuringOutage.json().error, refused.json().error);
    // A failed result write must not tell the caller to retry a committed change.
    assert.equal(createdDuringOutage.statusCode, 201, createdDuringOutage.body);
    const committedNamespace = createdDuringOutage.json().data;
    assert.deepEqual(
      (await pool.query("SELECT id FROM occ.namespaces WHERE name = $1", [committedName])).rows,
      [{ id: committedNamespace.id }],
    );
    const agentAfterDenials = await inject("GET", agentPath);
    assert.equal(agentAfterDenials.statusCode, 200, agentAfterDenials.body);
    assert.deepEqual(agentAfterDenials.json().data, agentRead.json().data);
    // An exact read restriction blocks the lookup before the API verifies the Agent.
    await pool.query(
      `INSERT INTO occ.iam_restrictions
        (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, agentNamespace.id, agent.id],
    );
    const agentReadDenied = await inject("GET", agentPath);
    assert.equal(agentReadDenied.statusCode, 403, agentReadDenied.body);
    assert.deepEqual(
      logs
        .filter(({ event }) => event === "http.audit_append_failed")
        .map(({ requestId, action, operationId }) => ({ requestId, action, operationId })),
      [
        {
          requestId: blocked.headers["x-request-id"],
          action: admittedAction,
          operationId: "createNamespace",
        },
        {
          requestId: rolledBack.headers["x-request-id"],
          action: "openclaw.namespaces.create",
          operationId: "createNamespace",
        },
        {
          requestId: deniedDuringOutage.headers["x-request-id"],
          action: "openclaw.agents.delete",
          operationId: "deleteAgent",
        },
        {
          requestId: refusedDuringOutage.headers["x-request-id"],
          action: resultAction,
          operationId: "listNamespaces",
        },
        {
          requestId: createdDuringOutage.headers["x-request-id"],
          action: resultAction,
          operationId: "createNamespace",
        },
      ],
    );

    const installation = await state.loadInstallation();
    assert.ok(installation);
    const installationResource = { kind: "installation", id: installation.id };
    const agentResource = { kind: "agent", id: agent.id, namespaceId: agentNamespace.id };
    const namespaceResource = { kind: "namespace", id: namespace.id, namespaceId: namespace.id };
    const secretResource = { kind: "secret", id: secretRef.id, namespaceId: agentNamespace.id };
    const records = await state.transact((unit) => unit.audit.list());
    const forRequest = (response: Awaited<ReturnType<typeof inject>>) =>
      records.filter((event) => event.requestId === response.headers["x-request-id"]);
    for (const [
      response,
      operationId,
      method,
      statusCode,
      actorId,
      outcome,
      wasAdmitted,
      resultResource = installationResource,
    ] of [
      [created, "createNamespace", "POST", 201, principal.id, "success", true],
      [read, "getNamespace", "GET", 200, principal.id, "success", true, namespaceResource],
      [head, "getNamespace", "HEAD", 200, principal.id, "success", true, namespaceResource],
      [invalid, "createNamespace", "POST", 400, "unresolved", "failure", false],
      [invalidPath, "getNamespace", "GET", 400, "unresolved", "failure", false],
      [refused, "listNamespaces", "GET", 401, "unresolved", "denied", false],
      [agentRead, "getAgent", "GET", 200, principal.id, "success", true, agentResource],
      [agentHead, "getAgent", "HEAD", 200, principal.id, "success", true, agentResource],
      [secretRead, "getSecret", "GET", 200, principal.id, "success", true, secretResource],
      [agentInWrongNamespace, "getAgent", "GET", 404, principal.id, "failure", true],
      [agentReadDenied, "getAgent", "GET", 403, principal.id, "denied", true],
      [denied, "deleteAgent", "DELETE", 403, principal.id, "denied", true],
      [deniedDuringOutage, "deleteAgent", "DELETE", 403, principal.id, "denied", true],
      [blocked, "createNamespace", "POST", 503, principal.id, "failure", false],
      [rolledBack, "createNamespace", "POST", 503, principal.id, "failure", true],
    ] as const) {
      const requestRecords = forRequest(response).filter((event) => event.kind === "api_request");
      assert.deepEqual(
        requestRecords.map(({ action }) => action).sort(),
        wasAdmitted ? [admittedAction, resultAction] : [resultAction],
        operationId,
      );
      const result = requestRecords.find(({ action }) => action === resultAction);
      assert.ok(result);
      assert.equal(result.actorId, actorId, operationId);
      assert.deepEqual(result.resource, resultResource, operationId);
      assert.equal(result.outcome, outcome, operationId);
      assert.deepEqual(result.details, { operationId, method, statusCode });
      if (wasAdmitted) {
        const admission = requestRecords.find(({ action }) => action === admittedAction);
        assert.ok(admission);
        assert.equal(admission.actorId, actorId, operationId);
        assert.deepEqual(admission.resource, installationResource);
        assert.equal(admission.outcome, "success", operationId);
        assert.deepEqual(admission.details, { operationId, method });
      }
    }
    assert.ok(
      forRequest(created).some(
        (event) =>
          event.action === "openclaw.namespaces.create" && event.resource.id === namespace.id,
      ),
    );
    const committedRecords = forRequest(createdDuringOutage);
    assert.deepEqual(
      committedRecords.filter((event) => event.kind === "api_request").map(({ action }) => action),
      [admittedAction],
    );
    assert.ok(
      committedRecords.some(
        (event) =>
          event.action === "openclaw.namespaces.create" &&
          event.resource.id === committedNamespace.id,
      ),
    );
    assert.ok(
      forRequest(denied).some(
        (event) => event.kind === "authorization_denial" && event.resource.id === agent.id,
      ),
    );
    assert.equal(
      forRequest(deniedDuringOutage).some((event) => event.kind === "authorization_denial"),
      false,
    );
    assert.equal(
      forRequest(refusedDuringOutage).some((event) => event.kind === "api_request"),
      false,
    );

    // This session holds the ledger write lock until the API returns. The API has
    // to time out independently and keep the denial for the unauthenticated call.
    await withPool(migrationUrl, async (migrator: Pool) => {
      const locker = await migrator.connect();
      try {
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE occ.audit_events IN SHARE MODE");
        const refusedWhileLocked = await refuseAnonymous();
        assert.equal(refusedWhileLocked.statusCode, 401, refusedWhileLocked.body);
        const blockedWhileLocked = await inject("POST", "/namespaces", { name: blockedName });
        assert.equal(blockedWhileLocked.statusCode, 503, blockedWhileLocked.body);
      } finally {
        await locker.query("ROLLBACK");
        locker.release();
      }
    });
    assert.equal(
      (await pool.query("SELECT id FROM occ.namespaces WHERE name = $1", [blockedName])).rowCount,
      0,
    );

    // A one-byte budget on a separate pool trips the storage limit without filling the disk.
    const capped = await createPostgresAgentApp(t, {
      label: "api-audit-storage-limit",
      authSecret,
      requestAudit: true,
      poolOptions: { options: "-c occ.control_plane_audit_max_bytes=1" },
      appOptions: {
        logger: createOccLogger({
          component: "occ-api-request-audit-test",
          destination: jsonLineDestination(logs),
        }),
      },
    });
    const auditIdsBeforeCapacity = await capped.pool.query(
      "SELECT id FROM occ.audit_events WHERE action IN ($1, $2) ORDER BY id",
      [admittedAction, resultAction],
    );
    const overCapacityName = `Audit storage exhausted ${randomUUID()}`;
    const overCapacity = await capped.inject("POST", "/namespaces", { name: overCapacityName });
    assert.equal(overCapacity.statusCode, 503, overCapacity.body);
    assert.deepEqual(
      logs
        .filter(
          (entry) =>
            entry.event === "http.audit_append_failed" &&
            entry.requestId === overCapacity.headers["x-request-id"] &&
            entry.code === "AUDIT_CAPACITY_EXCEEDED",
        )
        .map((entry) => entry.action),
      [admittedAction, resultAction],
    );
    assert.deepEqual(
      (await capped.pool.query("SELECT id FROM occ.namespaces WHERE name = $1", [overCapacityName]))
        .rows,
      [],
    );
    assert.deepEqual(
      (
        await capped.pool.query(
          "SELECT id FROM occ.audit_events WHERE action IN ($1, $2) ORDER BY id",
          [admittedAction, resultAction],
        )
      ).rows,
      auditIdsBeforeCapacity.rows,
    );
  },
);
