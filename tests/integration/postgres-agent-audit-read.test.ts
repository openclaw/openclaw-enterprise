import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";

import {
  loadRuntimeAuditAdmission,
  startGatewayRuntimeAuditListener,
  type OpenShellRuntimeAuditAdmission,
} from "../../apps/controller/src/http/runtime-audit.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { RUNTIME_AUDIT_ACTIONS, type AgentAuditPage } from "../../packages/contracts/src/index.ts";
import { ResourceConflictError, ScopeViolationError } from "../../packages/occ/src/index.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { privateBootstrapDirectory } from "../helpers/bootstrap-installation.mjs";
import { selfSigned } from "../helpers/certificates.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, withPool } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter } from "../helpers/postgres-locks.ts";
import { waitUntil } from "../helpers/wait-for.ts";

const authSecret = "agent-audit-reader-postgres-auth-secret";
const migrationUrl = process.env.OCC_TEST_AGENT_AUDIT_READ_MIGRATION_DATABASE_URL;
const disclosureAction = "openclaw.audit.agent.read";

// Encode the standard OTLP wire fields independently of the production decoder.
function varint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 127) {
    bytes.push((value & 127) | 128);
    value >>>= 7;
  }
  return Buffer.from([...bytes, value]);
}

function wireMessage(field: number, ...parts: Buffer[]): Buffer {
  const message = Buffer.concat(parts);
  return Buffer.concat([varint(field * 8 + 2), varint(message.length), message]);
}

function otlpAttributes(field: number, attributes: Record<string, string | number>): Buffer[] {
  return Object.entries(attributes).map(([key, value]) =>
    wireMessage(
      field,
      wireMessage(1, Buffer.from(key)),
      wireMessage(
        2,
        typeof value === "number"
          ? Buffer.concat([varint(3 * 8), varint(value)])
          : wireMessage(1, Buffer.from(value)),
      ),
    ),
  );
}

function openShellOtlp(
  sandboxId: string,
  eventId: string,
  body: Record<string, unknown>,
  { service = "openshell-supervisor", scope = "openshell.ocsf" } = {},
): Buffer {
  return wireMessage(
    1,
    wireMessage(
      1,
      ...otlpAttributes(1, { "service.name": service, "openshell.sandbox.id": sandboxId }),
    ),
    wireMessage(
      2,
      wireMessage(1, wireMessage(1, Buffer.from(scope))),
      wireMessage(
        2,
        wireMessage(5, wireMessage(1, Buffer.from(JSON.stringify(body)))),
        ...otlpAttributes(6, {
          "openshell.sandbox.id": sandboxId,
          "ocsf.metadata.uid": eventId,
          "ocsf.class_uid": 4001,
        }),
      ),
    ),
  );
}

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
    const openShellAudit: { admit?: OpenShellRuntimeAuditAdmission } = {};
    const { pool, state, principal, app, adminAccount, computeDriver, inject, deployAgent } =
      await createPostgresAgentApp(t, {
        label: "agent-audit",
        authSecret,
        requestAudit: true,
        transportDatabaseUrl: proxy.url,
        controllerOptions: { recordOperations: true },
        stateOptions: { workQueue: { controlPlaneAuditEnabled: true } },
        appOptions: {
          agentAuditCursorSecret: authSecret,
          runtimeAudit: {
            admitOpenShell: (authorization: string | undefined) =>
              openShellAudit.admit?.(authorization),
          },
        },
      });
    t.after(() => proxy.close());
    const { agent, namespace, revision } = await deployAgent("Agent Audit Reader", {
      dedicated: true,
    });
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
      await waitUntil("the deployment result to enter the audit page window", async () => {
        // The worker records microseconds, while the first page captures a millisecond end.
        const result = await pool.query<{ ready: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM occ.controller_work AS work
             JOIN occ.audit_events AS audit ON audit.details->>'workId' = work.idempotency_key
               AND audit.details->>'workState' = work.state
             WHERE work.idempotency_key = $1 AND work.state = 'failed_permanent'
               AND audit.occurred_at <= $2::timestamptz
           ) AS ready`,
          [workKey, new Date().toISOString()],
        );
        return result.rows[0]?.ready === true;
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

    // Reader evidence uses persisted rows so the projection and grant are tested independently
    // from producer admission. Include storage fields outside this action's projection.
    const installation = await state.loadInstallation();
    assert.ok(installation);
    const runtimeEvent = {
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: namespace.id,
      occurredAt: new Date().toISOString(),
      kind: "runtime_activity",
      action: RUNTIME_AUDIT_ACTIONS.reviewDecision,
      actorId: "unresolved",
      outcome: "denied",
      resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
      details: {
        agentRevisionId: revision.id,
        runtimeSource: "openclaw",
        sessionId: "runtime-session",
        turnId: "runtime-turn",
        reviewId: "runtime-review",
        decision: "denied",
      },
    } as const;
    await state.auditSink.append({
      ...runtimeEvent,
      source: "openclaw",
      details: { ...runtimeEvent.details, toolInput: "runtime-tool-input-must-not-be-disclosed" },
    });
    const otherRuntimeId = `aud_${randomUUID()}`;
    await state.auditSink.append({
      ...runtimeEvent,
      id: otherRuntimeId,
      namespaceId: other.namespace.id,
      resource: { kind: "agent", id: other.agent.id, namespaceId: other.namespace.id },
      details: { ...runtimeEvent.details, agentRevisionId: other.revision.id },
    });

    const harnessToken = randomBytes(32).toString("base64url");
    const harnessGrant = {
      tokenDigest: createHash("sha256").update(harnessToken).digest("hex"),
      namespaceId: namespace.id,
      agentId: agent.id,
      agentRevisionId: revision.id,
      runtimeSource: "codex",
    } as const;
    const reviewWithRationale = {
      action: RUNTIME_AUDIT_ACTIONS.reviewDecision,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      sessionId: "safe-session",
      decision: "denied",
      rationale: `Bearer a ${"Z".repeat(241)}`,
    } as const;
    const postRuntimeAudit = (payload: unknown, token?: string, source = "codex") =>
      app.inject({
        method: "POST",
        url: "/internal/runtime-audit",
        headers: {
          host: "127.0.0.1",
          "content-type": "application/json",
          "x-openclaw-runtime-audit-source": source,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        payload: JSON.stringify(payload),
      });
    assert.equal((await postRuntimeAudit(reviewWithRationale)).statusCode, 401);
    assert.equal((await postRuntimeAudit(reviewWithRationale, harnessToken)).statusCode, 401);
    assert.equal(await state.hasGatewayRuntimeGrant(harnessGrant), false);
    // The saved harness determines eligibility. Replaying an identical registration can
    // recover an interrupted worker without replacing a different credential.
    await assert.rejects(
      state.registerGatewayRuntimeGrant({ ...harnessGrant, runtimeSource: "openclaw" }),
      ScopeViolationError,
    );
    await Promise.all([
      state.registerGatewayRuntimeGrant(harnessGrant),
      state.registerGatewayRuntimeGrant(harnessGrant),
    ]);
    assert.equal(await state.hasGatewayRuntimeGrant(harnessGrant), true);
    assert.equal(
      await state.hasGatewayRuntimeGrant({ ...harnessGrant, runtimeSource: "openclaw" }),
      false,
    );
    await assert.rejects(
      state.registerGatewayRuntimeGrant({
        ...harnessGrant,
        tokenDigest: randomBytes(32).toString("hex"),
      }),
      ResourceConflictError,
    );
    assert.equal(
      (await postRuntimeAudit(reviewWithRationale, harnessToken, "openclaw")).statusCode,
      403,
    );
    assert.equal(
      (
        await postRuntimeAudit(
          { ...reviewWithRationale, action: RUNTIME_AUDIT_ACTIONS.networkDecision },
          harnessToken,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await postRuntimeAudit(
          { ...reviewWithRationale, agentRevisionId: other.revision.id },
          harnessToken,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await postRuntimeAudit(
          { ...reviewWithRationale, sessionId: "poisoned\u0001identifier" },
          harnessToken,
        )
      ).statusCode,
      400,
    );
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const admitted = await postRuntimeAudit(reviewWithRationale, harnessToken);
      assert.equal(admitted.statusCode, 204, admitted.body);
    }

    // An API process already serving this Agent must see a new revision's grant and later
    // changes to that grant in PostgreSQL without loading a new file or restarting.
    const replacement = await inject("POST", `${agentPath}/deploy`);
    assert.equal(replacement.statusCode, 202, replacement.body);
    const replacementId = replacement.json().data.id as string;
    assert.notEqual(replacementId, revision.id);
    const replacementToken = randomBytes(32).toString("base64url");
    const replacementGrant = {
      ...harnessGrant,
      tokenDigest: createHash("sha256").update(replacementToken).digest("hex"),
      agentRevisionId: replacementId,
    };
    const replacementReview = {
      ...reviewWithRationale,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      sessionId: "replacement-session",
    };
    assert.equal((await postRuntimeAudit(replacementReview, replacementToken)).statusCode, 401);
    await state.transact((unit) => unit.audit.registerGatewayRuntimeGrant(replacementGrant));
    await state.transact((unit) =>
      unit.audit.removeGatewayRuntimeGrant({ ...harnessGrant, agentRevisionId: replacementId }),
    );
    assert.equal((await postRuntimeAudit(reviewWithRationale, harnessToken)).statusCode, 204);
    const lastReview = { ...reviewWithRationale, eventId: randomUUID(), sessionId: "last-review" };
    await withPool(migrationUrl, async (migratorPool) => {
      const holder = await migratorPool.connect();
      let admitted: ReturnType<typeof postRuntimeAudit> | undefined;
      let revoked: Promise<void> | undefined;
      try {
        // Stall the real API after grant lookup and before ledger insertion. Revocation
        // must wait for that admitted append to finish before it can remove the grant.
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE occ.audit_events IN SHARE MODE");
        const pid = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        assert.ok(pid.rows[0]);
        admitted = postRuntimeAudit(lastReview, harnessToken);
        const appendPid = await waitForLockWaiter(pool, pid.rows[0].pid, "runtime audit append", {
          queryLike: "INSERT INTO occ.audit_events%",
        });
        revoked = state.removeGatewayRuntimeGrant(harnessGrant);
        void revoked.catch(() => {});
        await waitForLockWaiter(pool, appendPid, "Gateway grant revocation", {
          queryLike: "DELETE FROM occ.gateway_runtime_audit_grants%",
        });
      } finally {
        await holder.query("ROLLBACK").finally(() => holder.release());
        await Promise.allSettled([admitted, revoked]);
      }
      assert.equal((await admitted)?.statusCode, 204);
      await revoked;
    });
    assert.equal((await postRuntimeAudit(reviewWithRationale, harnessToken)).statusCode, 401);
    assert.equal(await state.hasGatewayRuntimeGrant(harnessGrant), false);

    // The private wire listener must authenticate TLS before accepting the Gateway's
    // bearer credential, and expose no ordinary Console or Agent API routes.
    const material = await selfSigned(
      await privateBootstrapDirectory(t, "private-runtime-audit-tls-"),
      { subjectAltName: "IP:127.0.0.1" },
    );
    const tls = { key: Buffer.from(material.key), cert: Buffer.from(material.cert) };
    const listener = await startGatewayRuntimeAuditListener(app, {
      host: "127.0.0.1",
      port: 0,
      loadTls: async () => tls,
      onTlsReloadError: () => assert.fail("Private listener TLS reload failed."),
    });
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = listener.address();
    assert.ok(address !== null && typeof address !== "string");
    const requestPrivate = (
      method: "GET" | "POST",
      path: string,
      ca: Buffer | undefined,
      token?: string,
    ) =>
      new Promise<number | undefined>((resolve, reject) => {
        const request = httpsRequest(
          {
            host: address.address,
            port: address.port,
            agent: false,
            method,
            path,
            ca,
            headers: {
              "content-type": "application/json",
              "x-openclaw-runtime-audit-source": "codex",
              ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
            response.once("error", reject);
          },
        );
        request.once("error", reject);
        request.end(method === "POST" ? JSON.stringify(replacementReview) : undefined);
      });
    const privatePath = "/internal/runtime-audit";
    await assert.rejects(requestPrivate("POST", privatePath, undefined), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
    assert.equal(await requestPrivate("GET", auditPath, tls.cert), 404);
    assert.equal(await requestPrivate("POST", privatePath, tls.cert), 401);
    assert.equal(await requestPrivate("POST", privatePath, tls.cert, replacementToken), 204);

    // The Gateway requests above use no grants file. Only the OpenShell exporter uses one.
    const exporterToken = randomBytes(32).toString("base64url");
    const sandboxId = randomUUID();
    const grantFile = join(
      await privateBootstrapDirectory(t, "runtime-audit-grants-"),
      "grants.json",
    );
    await writeFile(
      grantFile,
      JSON.stringify([
        {
          tokenDigest: createHash("sha256").update(exporterToken).digest("hex"),
          namespaceId: namespace.id,
          agentId: agent.id,
          agentRevisionId: revision.id,
          runtimeSource: "openshell",
          openshellSandboxId: sandboxId,
        },
      ]),
      { mode: 0o600 },
    );
    openShellAudit.admit = await loadRuntimeAuditAdmission(grantFile);
    assert.equal((await postRuntimeAudit(reviewWithRationale, exporterToken)).statusCode, 401);

    // Stock OTLP envelope with typed native OCSF, restricted to a distinct exporter credential.
    const ocsfId = randomUUID();
    const ocsf = {
      class_uid: 4001,
      action_id: 2,
      disposition_id: 2,
      time: Date.now(),
      metadata: {
        version: "1.8.0",
        uid: ocsfId,
        product: { name: "OpenShell Sandbox Supervisor" },
      },
      device: { container: { uid: sandboxId } },
      dst_endpoint: { domain: "blocked.invalid", port: 8443, ip: "198.18.0.2" },
      unmapped: { reason: "unprojected-private-provider-content" },
    };
    const ocsfPayload = openShellOtlp(sandboxId, ocsfId, ocsf);
    const postOtlp = (
      payload: Buffer,
      token = exporterToken,
      mediaType = "application/x-protobuf",
    ) =>
      app.inject({
        method: "POST",
        url: "/internal/runtime-audit/openshell/v1/logs",
        headers: {
          host: "127.0.0.1",
          authorization: `Bearer ${token}`,
          "content-type": mediaType,
        },
        payload,
      });
    assert.equal((await postOtlp(ocsfPayload, harnessToken)).statusCode, 401);
    assert.equal((await postOtlp(ocsfPayload, exporterToken, "application/json")).statusCode, 415);
    assert.equal((await postOtlp(Buffer.from([0xff]))).statusCode, 400);
    assert.equal(
      (
        await postOtlp(
          openShellOtlp(sandboxId, ocsfId, {
            ...ocsf,
            device: { container: { uid: randomUUID() } },
          }),
        )
      ).statusCode,
      400,
    );
    const skipped = [
      openShellOtlp(randomUUID(), ocsfId, ocsf),
      openShellOtlp(sandboxId, ocsfId, ocsf, { service: "openshell-gateway" }),
      openShellOtlp(sandboxId, ocsfId, ocsf, { scope: "generic-workload" }),
      openShellOtlp(sandboxId, ocsfId, { ...ocsf, action_id: 1, disposition_id: 1 }),
    ];
    for (const payload of skipped) {
      const ignored = await postOtlp(payload);
      assert.equal(ignored.statusCode, 200, ignored.body);
    }
    const fullBatch = Buffer.concat(Array.from({ length: 101 }, () => skipped[0]!));
    assert.equal((await postOtlp(fullBatch)).statusCode, 200);
    assert.equal((await postOtlp(Buffer.concat([fullBatch, skipped[0]!]))).statusCode, 400);
    const beforeDenial = await pool.query<{ count: string }>(
      "SELECT count(*) FROM occ.audit_events WHERE resource_id = $1 AND action = $2",
      [agent.id, RUNTIME_AUDIT_ACTIONS.networkDecision],
    );
    assert.equal(beforeDenial.rows[0]?.count, "0");
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const admitted = await postOtlp(ocsfPayload);
      assert.equal(admitted.statusCode, 200, admitted.body);
      assert.equal(admitted.headers["content-type"], "application/x-protobuf");
      assert.equal(admitted.rawPayload.length, 0);
    }

    assert.equal((await inject("GET", otherAuditPath)).statusCode, 403);
    const runtimeRead = await inject("GET", `${auditPath}?limit=100`);
    assert.equal(runtimeRead.statusCode, 200, runtimeRead.body);
    const runtimePage: AgentAuditPage = runtimeRead.json().data;
    assert.equal(runtimePage.projectionVersion, 2);
    const networkDecisions = runtimePage.events.filter(
      (entry) =>
        entry.event === "runtime_activity" &&
        entry.action === RUNTIME_AUDIT_ACTIONS.networkDecision,
    );
    assert.equal(networkDecisions.length, 1);
    assert.deepEqual(
      networkDecisions.find((entry) => entry.details.host === "blocked.invalid")?.details,
      {
        agentRevisionId: revision.id,
        runtimeSource: "openshell",
        decision: "denied",
        enforcement: "blocked",
        host: "blocked.invalid",
        port: 8443,
      },
    );
    assert.ok(networkDecisions.every((entry) => entry.outcome === "denied"));
    assert.ok(!runtimeRead.body.includes("unprojected-private-provider-content"));
    const persistedReviews = runtimePage.events.filter(
      (entry) =>
        entry.event === "runtime_activity" &&
        entry.action === reviewWithRationale.action &&
        "sessionId" in entry.details &&
        entry.details.sessionId === "safe-session",
    );
    assert.equal(persistedReviews.length, 1);
    const [persistedReview] = persistedReviews;
    assert.equal(persistedReview?.event, "runtime_activity");
    assert.deepEqual(persistedReview.details, {
      agentRevisionId: revision.id,
      runtimeSource: "codex",
      sessionId: "safe-session",
      decision: "denied",
      rationale: `[REDACTED] ${"Z".repeat(239)}`,
    });
    assert.equal(
      runtimePage.events.filter(
        (entry) =>
          entry.event === "runtime_activity" &&
          entry.action === lastReview.action &&
          "sessionId" in entry.details &&
          entry.details.sessionId === lastReview.sessionId,
      ).length,
      1,
    );
    assert.deepEqual(
      runtimePage.events.flatMap((entry) =>
        entry.event === "runtime_activity" &&
        entry.action === replacementReview.action &&
        "sessionId" in entry.details &&
        entry.details.sessionId === replacementReview.sessionId
          ? [entry.details.agentRevisionId]
          : [],
      ),
      [replacementId],
    );
    assert.deepEqual(
      runtimePage.events.filter(
        (entry) => entry.event === "runtime_activity" && entry.id === runtimeEvent.id,
      ),
      [
        {
          id: runtimeEvent.id,
          occurredAt: runtimeEvent.occurredAt.replace(/Z$/, "000Z"),
          event: "runtime_activity",
          action: runtimeEvent.action,
          outcome: runtimeEvent.outcome,
          details: runtimeEvent.details,
        },
      ],
    );
    assert.ok(!runtimeRead.body.includes(otherRuntimeId));
    assert.ok(!runtimeRead.body.includes("runtime-tool-input-must-not-be-disclosed"));

    const firstRuntimeRead = await inject("GET", `${auditPath}?limit=1`);
    assert.equal(firstRuntimeRead.statusCode, 200, firstRuntimeRead.body);
    const firstRuntimePage: AgentAuditPage = firstRuntimeRead.json().data;
    assert.deepEqual(firstRuntimePage.events, runtimePage.events.slice(0, 1));
    assert.ok(firstRuntimePage.nextCursor);
    const nextRuntimeRead = await inject(
      "GET",
      `${auditPath}?cursor=${firstRuntimePage.nextCursor}`,
    );
    assert.equal(nextRuntimeRead.statusCode, 200, nextRuntimeRead.body);
    const nextRuntimePage: AgentAuditPage = nextRuntimeRead.json().data;
    assert.deepEqual(nextRuntimePage.events, runtimePage.events.slice(1, 2));
  },
);
