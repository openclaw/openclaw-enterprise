import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

const authSecret = "runtime-logs-postgres-auth-secret-minimum-32-bytes";

test(
  "runtime log views and downloads persist audit rows before the read and fail closed without them",
  requiresPostgres,
  async (t) => {
    let failAudit = false;
    const { pool, state, computeDriver, principal, inject, deployAgent } =
      await createPostgresAgentApp(t, {
        label: "runtime-logs",
        authSecret,
        // The real PostgreSQL audit sink; a view must be durable before any output is read.
        createAuditSink: (persisted) => ({
          async append(event) {
            if (failAudit && event.action === "openclaw.agents.runtime_logs.view") {
              throw new Error("audit store unavailable");
            }
            await persisted.append(event);
          },
        }),
        appOptions: { agentRuntimeLogs: { enabled: true, cursorSecret: authSecret } },
      });
    const { namespace, agent, revision } = await deployAgent("Runtime logs");
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
    const refused = await inject("GET", logs);
    assert.equal(refused.statusCode, 503, refused.body);
    assert.equal(refused.json().error.code, "RUNTIME_LOGS_AUDIT_UNAVAILABLE");
    assert.equal(refused.body.includes("first line"), false);
    assert.equal(computeDriver.calls.filter(({ operation }) => operation === "read").length, 0);
    assert.equal((await viewRows()).rowCount, 0);
    failAudit = false;

    const first = await inject("GET", logs);
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
      const download = await inject("GET", `${logs}&tailLines=10&download=true`);
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
    const restricted = await inject("GET", logs);
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
