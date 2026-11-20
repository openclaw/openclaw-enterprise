import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentAuditPage } from "@openclaw-enterprise/contracts";
import type pg from "pg";

import { privateBootstrapDirectory } from "../helpers/bootstrap-installation.mjs";
import { withPool } from "../helpers/postgres-database.mjs";

const runtime = new URL("../../deploy/runtime/", import.meta.url);
const prefix = "openclaw.runtime.";
const admission = prefix + "tool_attempt.admitted";
const completion = prefix + "tool_attempt.completed";

// Exercise both packaged OCE plugins, real delivery over private HTTPS, the
// ledger and its authorized reader. Only the reviewer and node are fixtures.
export async function checkManagedMcpAudit(
  t: TestContext,
  {
    url,
    ca,
    pool,
    migrationUrl,
    token,
    agentId,
    revisionId,
    readPage,
  }: {
    url: string;
    ca: Buffer;
    pool: pg.Pool;
    migrationUrl: string;
    token: string;
    agentId: string;
    revisionId: string;
    readPage: () => Promise<AgentAuditPage>;
  },
) {
  const { createAuditDelivery } = await import(
    new URL("managed-runtime-audit/sink.mjs", runtime).href
  );
  const { registerManagedMcpAudit } = await import(
    new URL("managed-runtime-audit/managed-mcp.mjs", runtime).href
  );
  const { default: plugin } = await import(new URL("managed-mcp-policy/index.mjs", runtime).href);
  const directory = await privateBootstrapDirectory(t, "mcp-audit-");
  const sink = createAuditDelivery({ url, source: "openclaw" }, ca, token, directory);
  // An invocation without a host run identity may only be attributed to the revision.
  const release = registerManagedMcpAudit(
    sink,
    () => undefined,
    () => undefined,
  );
  t.after(() => {
    release();
    sink.close();
  });
  let handle!: (input: object) => Promise<{ ok: boolean }>;
  plugin.register({
    registerNodeInvokePolicy: (policy: { handle: typeof handle }) => {
      handle = policy.handle;
    },
  });
  const rows = async () =>
    (
      await pool.query(
        "SELECT id, action, outcome, details - '__occAuditMetadata' AS details FROM occ.audit_events WHERE resource_id=$1 AND details->>'boundary'='managed_mcp'",
        [agentId],
      )
    ).rows;
  const server = "oce_mcp_slack";
  const tool = "slack_send_message";
  const nodeId = "paired";
  let sends = 0;
  const call = (decision: string) =>
    handle({
      nodeId,
      params: { server, tool, arguments: { text: "private slack text" } },
      idempotencyKey: "private fake scope",
      pluginConfig: { nodeId, servers: { [server]: { [tool]: "ask" } } },
      approvals: { request: async () => ({ decision }) },
      async invokeNode() {
        sends++;
        // A second connection can already see the admission when the node is called.
        assert.equal((await rows()).filter((row) => row.action === admission).length, 1);
        return { ok: false, message: "private lost response" };
      },
    });

  await call("allow-once");
  assert.equal(sends, 1);
  const deadline = Date.now() + 5000;
  let stored = await rows();
  while (!stored.some((row) => row.action === completion) && Date.now() < deadline) {
    await delay(20);
    stored = await rows();
  }
  assert.equal(stored.length, 6);
  const byAction = new Map(stored.map((row) => [row.action, row]));
  const { approvalId, attemptId, invocationId } = byAction.get(admission).details;
  assert.ok(approvalId && attemptId && invocationId);
  const expected = [
    ["tool_call.requested", {}],
    ["policy.decided", { policy: "managed_mcp_policy", decision: "require_approval" }],
    ["approval.requested", { approvalId }],
    ["approval.resolved", { approvalId, decision: "allow-once" }],
    ["tool_attempt.admitted", { approvalId, attemptId }],
    ["tool_attempt.completed", { attemptId, outcome: "unknown" }],
  ] as const;
  const { events } = await readPage();
  for (const [suffix, fields] of expected) {
    const row = byAction.get(prefix + suffix);
    const entry = events.find(({ id }) => id === row.id);
    assert.ok(entry?.event === "runtime_activity");
    const details = {
      toolName: `${server}_${tool}`,
      invocationId,
      agentRevisionId: revisionId,
      runtimeSource: "openclaw",
      boundary: "managed_mcp",
      ...fields,
    };
    assert.deepEqual(row.details, details);
    assert.equal(row.outcome, row.action === completion ? "failure" : "success");
    assert.deepEqual(
      [entry.action, entry.outcome, entry.details],
      [row.action, row.outcome, details],
    );
  }

  // Neither human refusal nor an unavailable admission may release the node.
  assert.equal((await call("deny")).ok, false);
  await withPool(migrationUrl, async (migrator) => {
    await migrator.query(`ALTER TABLE occ.audit_events ADD CONSTRAINT reject_tool_admission
      CHECK (action <> 'openclaw.runtime.tool_attempt.admitted') NOT VALID`);
    try {
      await assert.rejects(call("allow-once"), /could not record/);
    } finally {
      await migrator.query("ALTER TABLE occ.audit_events DROP CONSTRAINT reject_tool_admission");
    }
  });
  assert.equal(sends, 1);
}
