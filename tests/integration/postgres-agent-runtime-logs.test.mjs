import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import {
  ensureDevelopmentBootstrap,
  privateBootstrapDirectory,
} from "../helpers/bootstrap-installation.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantAgentSecretOperate } from "../helpers/postgres-harness-auth.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "postgres-admin@openclaw.local";
const adminPassword = "postgres-development-password";
const authSecret = "runtime-logs-postgres-auth-secret-minimum-32-bytes";

async function ensureBootstrap(t) {
  const observer = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  t.after(() => observer.end());
  if ((await new PostgresPlatformState(observer).loadInstallation()) !== undefined) {
    return;
  }
  await ensureDevelopmentBootstrap(t, {
    databaseUrl,
    directory: await privateBootstrapDirectory(t, "openclaw-runtime-logs-pg-bootstrap-"),
    email: adminEmail,
    password: adminPassword,
    authSecret,
    authBaseURL: "http://127.0.0.1",
    installationName: "Runtime logs PostgreSQL test",
  });
}

test(
  "runtime log views and downloads persist audit rows before the read and fail closed without them",
  requiresPostgres,
  async (t) => {
    await ensureBootstrap(t);
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    t.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    assert.ok(installation);
    const auth = await createPostgresControllerAuth({
      mode: "development",
      installationId: installation.id,
      baseURL: "http://127.0.0.1",
      secret: authSecret,
      pool,
    });
    const iamDriver = new NativeIAMDriver(state, { id: "runtime-logs-pg-iam" });
    const computeDriver = createRuntimeLogComputeDriver({ id: "runtime-logs-pg-compute" });
    const configurationDriver = createTestConfigurationDriver({ id: "runtime-logs-pg-config" });
    const secretDriver = createTestSecretDriver({ id: "runtime-logs-pg-secret" });
    const controller = new OpenClawController(installation, { state, recordOperations: false });
    for (const driver of [iamDriver, computeDriver, configurationDriver, secretDriver]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    // The real PostgreSQL audit sink; a view must be durable before any output is read.
    let failAudit = false;
    const auditSink = {
      async append(event) {
        if (failAudit && event.action === "openclaw.agents.runtime_logs.view") {
          throw new Error("audit store unavailable");
        }
        await state.auditSink.append(event);
      },
    };
    const app = createFastifyApp({
      controller,
      iamDriver,
      computeDriver,
      configurationDriver,
      secretDriver,
      resolveHarness: resolveApprovedHarness,
      auditSink,
      auth,
      development: { enabled: false },
      agentRuntimeLogs: { enabled: true, cursorSecret: authSecret },
    });
    t.after(() => app.close());
    const inject = (method, url, session, body) =>
      app.inject({
        method,
        url,
        headers: {
          host: "127.0.0.1",
          ...authenticatedHeaders(session),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });
    assert.equal(signIn.statusCode, 200, signIn.body);
    const setCookie = signIn.headers["set-cookie"];
    const session = {
      origin: "http://127.0.0.1",
      cookie: cookieHeaderFromSetCookie(Array.isArray(setCookie) ? setCookie : [setCookie]),
    };
    const account = await pool.query(`SELECT id FROM occ."user" WHERE email = $1`, [adminEmail]);
    const principal = (await state.loadNativeIAMState()).identities.find(
      (identity) => identity.kind === "principal" && identity.subject === account.rows[0].id,
    );
    assert.ok(principal);

    const created = await inject("POST", "/namespaces", session, {
      name: `Runtime logs ${randomUUID()}`,
    });
    assert.equal(created.statusCode, 201, created.body);
    const namespace = created.json().data;
    await controller.handleNamespaceLifecycle(principal.id, namespace.id, "ready");
    const configuration = (
      await inject("POST", `/namespaces/${namespace.id}/configurations`, session, {
        kind: "agent",
        values: createHarnessConfiguration("openclaw", "gpt-4.1"),
      })
    ).json().data;
    const secret = (
      await inject("POST", `/namespaces/${namespace.id}/secrets`, session, {
        name: `Runtime logs key ${randomUUID()}`,
        value: `test-key-${randomUUID()}`,
      })
    ).json().data;
    const agent = (
      await inject("POST", `/namespaces/${namespace.id}/agents`, session, {
        name: `Runtime logs Agent ${randomUUID()}`,
        configurationId: configuration.id,
        harnessAuth: { method: "api_key", source: secret.ref },
      })
    ).json().data;
    await grantAgentSecretOperate(pool, agent, secret.ref.id);
    const revision = await controller.deployAgent(
      principal.id,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedHarness,
    );
    computeDriver.state.lines = [{ time: "2026-09-30T12:00:01.000000001Z", raw: "first line" }];
    const logs = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}/runtime/logs?source=gateway`;
    const viewRows = () =>
      pool.query(
        `SELECT kind, actor_id, action, outcome, details
         FROM occ.audit_events
         WHERE action = 'openclaw.agents.runtime_logs.view' AND resource_id = $1
         ORDER BY occurred_at`,
        [agent.id],
      );

    // Audit failure: no row, no Driver read, no content.
    failAudit = true;
    const refused = await inject("GET", logs, session);
    assert.equal(refused.statusCode, 503, refused.body);
    assert.equal(refused.json().error.code, "RUNTIME_LOGS_AUDIT_UNAVAILABLE");
    assert.equal(refused.body.includes("first line"), false);
    assert.equal(computeDriver.calls.filter(({ operation }) => operation === "read").length, 0);
    assert.equal((await viewRows()).rowCount, 0);
    failAudit = false;

    const first = await inject("GET", logs, session);
    assert.equal(first.statusCode, 200, first.body);
    const rows = await viewRows();
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].kind, "access");
    assert.equal(rows.rows[0].actor_id, principal.id);
    assert.equal(rows.rows[0].outcome, "success");
    const details = rows.rows[0].details.runtimeLogs;
    assert.equal(details.revisionId, revision.id);
    assert.equal(details.source, "gateway");
    assert.equal(details.container, "gateway");
    assert.equal(JSON.stringify(rows.rows[0].details).includes("first line"), false);

    // Cursor polls within the view add no rows.
    computeDriver.state.lines.push({ time: "2026-09-30T12:00:02.000000001Z", raw: "second" });
    const poll = await inject(
      "GET",
      `${logs}&cursor=${encodeURIComponent(first.json().data.cursor)}`,
      session,
    );
    assert.equal(poll.statusCode, 200, poll.body);
    assert.deepEqual(
      poll.json().data.records.map(({ message }) => message),
      ["second"],
    );
    assert.equal((await viewRows()).rowCount, 1);

    // Every download is its own durable row with the forced tail, never the text.
    const downloadRows = () =>
      pool.query(
        `SELECT kind, actor_id, outcome, details
         FROM occ.audit_events
         WHERE action = 'openclaw.agents.runtime_logs.download' AND resource_id = $1
         ORDER BY occurred_at`,
        [agent.id],
      );
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const download = await inject("GET", `${logs}&tailLines=10&download=true`, session);
      assert.equal(download.statusCode, 200, download.body);
      assert.match(download.headers["content-type"], /^text\/plain/);
      assert.match(download.body, /first line/);
      assert.equal((await downloadRows()).rowCount, attempt);
    }
    const downloaded = (await downloadRows()).rows;
    assert.deepEqual(
      downloaded.map(({ kind, actor_id: actorId, outcome }) => ({ kind, actorId, outcome })),
      [
        { kind: "access", actorId: principal.id, outcome: "success" },
        { kind: "access", actorId: principal.id, outcome: "success" },
      ],
    );
    assert.equal(downloaded[0].details.runtimeLogs.tailLines, 1000);
    assert.notEqual(
      downloaded[0].details.runtimeLogs.viewId,
      downloaded[1].details.runtimeLogs.viewId,
    );
    assert.equal(JSON.stringify(downloaded).includes("first line"), false);
    assert.equal((await viewRows()).rowCount, 1, "downloads are not views");

    // The access kind reads back through the State audit reader, naming the grant that
    // admitted the administrator (administer: the fresh bootstrap Role has no read_logs).
    const persisted = (await state.transact((unit) => unit.audit.list())).filter(
      (event) =>
        event.resource.id === agent.id && event.action.startsWith("openclaw.agents.runtime_logs."),
    );
    assert.deepEqual(
      persisted.map((event) => [event.kind, event.action, event.authorization?.action]),
      [
        ["access", "openclaw.agents.runtime_logs.view", "administer"],
        ["access", "openclaw.agents.runtime_logs.download", "administer"],
        ["access", "openclaw.agents.runtime_logs.download", "administer"],
      ],
    );

    // A persisted read_logs Restriction denies log text outright; administer cannot bypass it.
    await pool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read_logs', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, namespace.id, agent.id],
    );
    const reads = computeDriver.calls.filter(({ operation }) => operation === "read").length;
    const restricted = await inject("GET", logs, session);
    assert.equal(restricted.statusCode, 403, restricted.body);
    assert.equal(restricted.body.includes("first line"), false);
    assert.equal(computeDriver.calls.filter(({ operation }) => operation === "read").length, reads);
    assert.deepEqual(
      (await viewRows()).rows.map(({ kind, outcome }) => [kind, outcome]),
      [
        ["access", "success"],
        ["authorization_denial", "denied"],
      ],
    );
  },
);
