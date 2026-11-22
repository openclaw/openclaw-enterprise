import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  AgentRevision,
  AgentRuntimeLogsResponse,
  AgentWire,
  AuditEvent,
  NamespaceWire,
} from "../../packages/contracts/src/index.ts";
import type { PlatformAuditSink, RuntimeLogViewAdmission } from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

interface RuntimeLogAuditRow {
  kind: AuditEvent["kind"];
  actor_id: AuditEvent["actorId"];
  outcome: AuditEvent["outcome"];
  details: { runtimeLogs?: RuntimeLogViewAdmission } | null;
}

const authSecret = "runtime-logs-postgres-auth-secret-minimum-32-bytes";

test(
  "runtime log views and downloads persist audit rows before the read and fail closed without them",
  requiresPostgres,
  async (t) => {
    let failAuditAction = "";
    const { pool, state, computeDriver, principal, inject, deployAgent } =
      await createPostgresAgentApp(t, {
        label: "runtime-logs",
        authSecret,
        // The real PostgreSQL audit sink; access must be durable before any output is read.
        createAuditSink: (persisted: PlatformAuditSink): PlatformAuditSink => ({
          async append(event) {
            if (event.action === failAuditAction) {
              throw new Error("audit store unavailable");
            }
            await persisted.append(event);
          },
        }),
        appOptions: { agentRuntimeLogs: { enabled: true, cursorSecret: authSecret } },
      });
    const {
      namespace,
      agent,
      revision,
    }: {
      namespace: Pick<NamespaceWire, "id">;
      agent: Pick<AgentWire, "id">;
      revision: Pick<AgentRevision, "id">;
    } = await deployAgent("Runtime logs");
    computeDriver.state.lines = [{ time: "2026-09-30T12:00:01.000000001Z", raw: "first line" }];
    const logs = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}/runtime/logs?source=gateway`;
    const viewRows = () =>
      pool.query<RuntimeLogAuditRow & { action: AuditEvent["action"] }>(
        `SELECT kind, actor_id, action, outcome, details
         FROM occ.audit_events
         WHERE action = 'openclaw.agents.runtime_logs.view' AND resource_id = $1
         ORDER BY occurred_at`,
        [agent.id],
      );

    // Audit failure: no row, no Driver read, no content.
    failAuditAction = "openclaw.agents.runtime_logs.view";
    const refused = await inject("GET", logs);
    assertApiError(refused, 503, "RUNTIME_LOGS_AUDIT_UNAVAILABLE");
    assert.equal(refused.body.includes("first line"), false);
    assert.equal(computeDriver.calls.filter(({ operation }) => operation === "read").length, 0);
    assert.equal((await viewRows()).rowCount, 0);
    failAuditAction = "";

    const first = await inject("GET", logs);
    assert.equal(first.statusCode, 200, first.body);
    const rows = await viewRows();
    assert.equal(rows.rowCount, 1);
    const [view] = rows.rows;
    assert.ok(view);
    assert.equal(view.kind, "access");
    assert.equal(view.actor_id, principal.id);
    assert.equal(view.outcome, "success");
    const details = view.details?.runtimeLogs;
    assert.ok(details);
    assert.equal(details.revisionId, revision.id);
    assert.equal(details.source, "gateway");
    assert.equal(details.container, "gateway");
    assert.equal(JSON.stringify(view.details).includes("first line"), false);

    // Cursor polls within the view add no rows.
    computeDriver.state.lines.push({ time: "2026-09-30T12:00:02.000000001Z", raw: "second" });
    const { cursor } = first.json<AgentRuntimeLogsResponse>().data;
    assert.ok(cursor);
    const poll = await inject("GET", `${logs}&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(poll.statusCode, 200, poll.body);
    assert.deepEqual(
      poll
        .json<AgentRuntimeLogsResponse>()
        .data.records.map((record) => (record.type === "line" ? record.message : undefined)),
      ["second"],
    );
    assert.equal((await viewRows()).rowCount, 1);

    // Make the original line fall outside the caller's ten-line tail.
    computeDriver.state.lines.push(
      ...Array.from({ length: 10 }, (_, index) => ({
        time: `2026-09-30T12:00:${String(index + 3).padStart(2, "0")}.000000001Z`,
        raw: `download line ${index + 3}`,
      })),
    );

    // Every download is its own durable row with the forced tail, never the text.
    const downloadRows = () =>
      pool.query<RuntimeLogAuditRow>(
        `SELECT kind, actor_id, outcome, details
         FROM occ.audit_events
         WHERE action = 'openclaw.agents.runtime_logs.download' AND resource_id = $1
         ORDER BY occurred_at`,
        [agent.id],
      );
    // A refused download cannot read the Driver, persist a success row, or return log text.
    const readsBeforeRefusedDownload = computeDriver.calls.filter(
      ({ operation }) => operation === "read",
    ).length;
    failAuditAction = "openclaw.agents.runtime_logs.download";
    const refusedDownload = await inject("GET", `${logs}&tailLines=10&download=true`);
    assertApiError(refusedDownload, 503, "RUNTIME_LOGS_AUDIT_UNAVAILABLE");
    assert.equal(
      computeDriver.calls.filter(({ operation }) => operation === "read").length,
      readsBeforeRefusedDownload,
    );
    assert.equal((await downloadRows()).rowCount, 0);
    assert.equal(
      computeDriver.state.lines.some(({ raw }) => refusedDownload.body.includes(raw)),
      false,
    );
    failAuditAction = "";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const callsBeforeDownload = computeDriver.calls.length;
      const download = await inject("GET", `${logs}&tailLines=10&download=true`);
      assert.equal(download.statusCode, 200, download.body);
      const contentType = download.headers["content-type"];
      assert.ok(typeof contentType === "string");
      assert.match(contentType, /^text\/plain/);
      assert.match(download.body, /first line/);
      assert.deepEqual(
        computeDriver.calls
          .slice(callsBeforeDownload)
          .filter((call) => call.operation === "read")
          .map(({ tailLines }) => tailLines),
        [1000],
      );
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
    const [firstDownload, secondDownload] = downloaded.map(({ details }) => details?.runtimeLogs);
    assert.ok(firstDownload && secondDownload);
    assert.equal(firstDownload.tailLines, 1000);
    assert.notEqual(firstDownload.viewId, secondDownload.viewId);
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

    // The production Fastify route must withhold an entire chunk whose reported
    // instance changed during the read, even when its text passes the classifier.
    const isolated = await deployAgent("Runtime log identity");
    const isolatedLogs = `/namespaces/${isolated.namespace.id}/agents/${isolated.agent.id}/deployments/${isolated.revision.id}/runtime/logs?source=gateway`;
    const marker = "replacement runtime operational output";
    const viewAction = "openclaw.agents.runtime_logs.view";
    const downloadAction = "openclaw.agents.runtime_logs.download";
    const readIsolatedAudits = () =>
      pool.query<
        RuntimeLogAuditRow & {
          id: AuditEvent["id"];
          action: AuditEvent["action"];
          namespace_id: AuditEvent["namespaceId"] | null;
          resource_kind: AuditEvent["resource"]["kind"];
          resource_id: AuditEvent["resource"]["id"];
        }
      >(
        `SELECT id, action, actor_id, namespace_id, resource_kind, resource_id, kind, outcome, details
         FROM occ.audit_events
         WHERE resource_id = $1 AND action IN ($2, $3)`,
        [isolated.agent.id, viewAction, downloadAction],
      );

    // Each request must account for one fresh admission, even when a later read returns 503.
    const auditIds = new Set<AuditEvent["id"]>();
    assert.equal((await readIsolatedAudits()).rowCount, 0);
    const assertNewIsolatedAudit = async (action: typeof viewAction | typeof downloadAction) => {
      const { rows } = await readIsolatedAudits();
      assert.equal(rows.length, auditIds.size + 1, "cumulative audit row count");
      const added = rows.filter(({ id }) => !auditIds.has(id));
      assert.equal(added.length, 1, "new audit row count");
      const [row] = added;
      assert.ok(row);
      assert.equal(row.action, action, "audit action");
      assert.equal(row.actor_id, principal.id, "audit actor");
      assert.equal(row.namespace_id, isolated.namespace.id, "audit Namespace");
      assert.equal(row.resource_kind, "agent", "audit resource kind");
      assert.equal(row.resource_id, isolated.agent.id, "audit Agent");
      assert.equal(row.kind, "access", "audit kind");
      assert.equal(row.outcome, "success", "audit outcome");
      assert.equal(row.details?.runtimeLogs?.revisionId, isolated.revision.id, "audit revision");
      assert.equal(JSON.stringify(row.details).includes(marker), false, "audit contains log text");
      auditIds.add(row.id);
    };

    computeDriver.state.lines = [{ time: "2026-09-30T12:00:03Z", raw: marker }];
    const stable = await inject("GET", isolatedLogs);
    assert.equal(stable.statusCode, 200, stable.body);
    assert.ok(stable.body.includes(marker));
    await assertNewIsolatedAudit(viewAction);
    for (const identity of ["uid", "restart", "unavailable"] as const) {
      delete computeDriver.state.readPodUid;
      delete computeDriver.state.readRestartCount;
      if (identity === "restart") {
        computeDriver.state.readRestartCount = computeDriver.state.restartCount + 1;
      } else {
        computeDriver.state.readPodUid = identity === "uid" ? randomUUID() : "";
      }
      for (const download of [false, true]) {
        const response = await inject("GET", `${isolatedLogs}${download ? "&download=true" : ""}`);
        assert.equal(response.body.includes(marker), false, identity);
        if (identity === "unavailable") {
          assertApiError(response, 503, "RUNTIME_LOGS_UNAVAILABLE");
        } else {
          assert.equal(response.statusCode, 200, response.body);
          assert.ok(response.body.includes("stream_replaced"));
        }
        await assertNewIsolatedAudit(download ? downloadAction : viewAction);
      }
    }
  },
);
