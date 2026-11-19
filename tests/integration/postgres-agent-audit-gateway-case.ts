import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { TestContext } from "node:test";
import { createSecureContext } from "node:tls";
import type { AgentAuditPage, AgentRevision } from "@openclaw-enterprise/contracts";
import type pg from "pg";

import { startGatewayRuntimeAuditListener } from "../../apps/controller/src/http/runtime-audit.ts";
import {
  ResourceConflictError,
  ScopeViolationError,
  type PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { privateBootstrapDirectory } from "../helpers/bootstrap-installation.mjs";
import { selfSigned } from "../helpers/certificates.ts";
import { withPool } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter } from "../helpers/postgres-locks.ts";
import { checkSandboxAudit } from "./postgres-agent-audit-sandbox-case.ts";

type App = Parameters<typeof startGatewayRuntimeAuditListener>[0];
const route = "/internal/runtime-audit";

async function startListener(t: TestContext, app: App) {
  const material = await selfSigned(await privateBootstrapDirectory(t, "private-runtime-audit-"), {
    subjectAltName: "IP:127.0.0.1",
  });
  const tls = { key: Buffer.from(material.key), cert: Buffer.from(material.cert) };
  const listener = await startGatewayRuntimeAuditListener(app, {
    host: "127.0.0.1",
    port: 0,
    loadTls: async () => tls,
    onTlsReloadError: () => assert.fail("Cannot reload the certificate."),
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const agent = new HttpsAgent({ secureContext: createSecureContext({ ca: tls.cert }) });
  t.after(() => agent.destroy());
  return (event: unknown, token: string, source = "openclaw", path = route) =>
    new Promise<number | undefined>((resolve, reject) => {
      const request = httpsRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          path,
          agent,
          method: "POST",
          headers: {
            "content-type": Buffer.isBuffer(event) ? "application/x-protobuf" : "application/json",
            "x-openclaw-runtime-audit-source": source,
            authorization: `Bearer ${token}`,
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
          response.once("error", reject);
        },
      );
      request.once("error", reject);
      request.end(Buffer.isBuffer(event) ? event : JSON.stringify(event));
    });
}

function credential(revision: AgentRevision) {
  const token = randomBytes(32).toString("base64url");
  const grant = {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    agentRevisionId: revision.id,
    runtimeSource: "openclaw",
    tokenDigest: createHash("sha256").update(token).digest("hex"),
  } as const;
  return { token, grant };
}

export async function checkGatewayAudit(
  t: TestContext,
  input: {
    app: App;
    pool: pg.Pool;
    state: PostgresPlatformState;
    migrationUrl: string;
    revision: AgentRevision;
    other: AgentRevision;
    replacementId: string;
    readPage: () => Promise<AgentAuditPage>;
  },
) {
  const { app, state, pool, migrationUrl, revision, replacementId } = input;
  const post = await startListener(t, app);
  const { grant, token } = credential(revision);
  const replacement = credential({ ...revision, id: replacementId });
  const other = credential(input.other);
  const session = { sessionId: randomUUID() };
  const turn = { ...session, turnId: randomUUID(), messageId: randomUUID() };
  const attempt = { ...turn, modelCallId: randomUUID(), provider: "openai", model: "gpt-4.1" };
  const envelope = () => ({ eventId: randomUUID(), occurredAt: new Date().toISOString() });
  const admitted = { ...envelope(), action: "openclaw.runtime.turn.admitted", ...turn };

  // A retry after worker restart can reuse the credential for this revision only.
  assert.equal(await post(admitted, token), 401);
  await assert.rejects(
    state.registerGatewayRuntimeGrant({ ...grant, runtimeSource: "codex" }),
    ScopeViolationError,
  );
  await Promise.all([
    state.registerGatewayRuntimeGrant(grant),
    state.registerGatewayRuntimeGrant(grant),
  ]);
  await assert.rejects(
    state.registerGatewayRuntimeGrant(credential(revision).grant),
    ResourceConflictError,
  );
  await state.registerGatewayRuntimeGrant(replacement.grant);
  await state.registerGatewayRuntimeGrant(other.grant);
  assert.equal(await post(admitted, token, "codex"), 403);

  // Keep the private write endpoint and the public read endpoint separate.
  const auditPath = `/namespaces/${revision.namespaceId}/agents/${revision.agentId}/audit-events`;
  const headers = {
    authorization: `Bearer ${token}`,
    "x-openclaw-runtime-audit-source": "openclaw",
  };
  assert.equal(
    (await app.inject({ method: "POST", url: route, headers, payload: admitted })).statusCode,
    404,
  );
  assert.equal((await app.inject({ method: "GET", url: auditPath, headers })).statusCode, 401);
  assert.equal(await post(admitted, token, "openclaw", auditPath), 404);
  assert.equal(await post({ ...admitted, agentRevisionId: replacementId }, token), 400);
  assert.equal(await post({ ...admitted, prompt: "private input" }, token), 400);
  assert.equal(await post({ ...admitted, action: "openclaw.agents.create" }, token), 400);
  assert.equal(
    await post(
      { ...admitted, ...attempt, turnId: undefined, action: "openclaw.runtime.model_call.started" },
      token,
    ),
    400,
  );

  // A failed admission write is retryable. Concurrent copies create exactly one record.
  await withPool(migrationUrl, async (migrator) => {
    await migrator.query(`ALTER TABLE occ.audit_events ADD CONSTRAINT reject_runtime_audit
      CHECK (kind <> 'runtime_activity') NOT VALID`);
    try {
      assert.equal(await post(admitted, token), 503);
    } finally {
      await migrator.query("ALTER TABLE occ.audit_events DROP CONSTRAINT reject_runtime_audit");
    }
  });
  assert.deepEqual(await Promise.all([post(admitted, token), post(admitted, token)]), [204, 204]);
  assert.equal(await post({ ...admitted, turnId: randomUUID() }, token), 409);
  assert.equal(await post(admitted, other.token), 204);
  const completed = {
    ...envelope(),
    action: "openclaw.runtime.model_call.completed",
    ...attempt,
    outcome: "cancelled",
  };

  // A revocation waits for an append that has already authenticated on this credential.
  await withPool(migrationUrl, async (migrator) => {
    const holder = await migrator.connect();
    let pending: ReturnType<typeof post> | undefined;
    let revoked: Promise<void> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE occ.audit_events IN SHARE MODE");
      const pid = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      pending = post(completed, token);
      void pending.catch(() => {});
      const appendPid = await waitForLockWaiter(pool, pid.rows[0]!.pid, "runtime audit append", {
        queryLike: "INSERT INTO occ.audit_events%",
      });
      revoked = state.removeGatewayRuntimeGrant(grant);
      void revoked.catch(() => {});
      await waitForLockWaiter(pool, appendPid, "Gateway credential revocation", {
        queryLike: "DELETE FROM occ.gateway_runtime_audit_grants%",
      });
    } finally {
      await holder.query("ROLLBACK").finally(() => holder.release());
      await Promise.allSettled([pending, revoked]);
    }
    assert.equal(await pending, 204);
    await revoked;
  });
  assert.equal(await post(admitted, token), 401);
  assert.equal(await state.hasGatewayRuntimeGrant(grant), false);
  assert.equal(
    await post(
      { ...envelope(), ...session, action: "openclaw.runtime.session.started" },
      replacement.token,
    ),
    204,
  );

  // The reader can trace both revisions of this Agent. The peer's event is private.
  const page = await input.readPage();
  const events = page.events.filter((entry) => entry.event === "runtime_activity");
  assert.deepEqual(
    events.map((entry) => [entry.action, entry.details]),
    [
      [
        "openclaw.runtime.session.started",
        { ...session, agentRevisionId: replacementId, runtimeSource: "openclaw" },
      ],
      [
        "openclaw.runtime.model_call.completed",
        {
          ...attempt,
          outcome: "cancelled",
          agentRevisionId: revision.id,
          runtimeSource: "openclaw",
        },
      ],
      [
        "openclaw.runtime.turn.admitted",
        { ...turn, agentRevisionId: revision.id, runtimeSource: "openclaw" },
      ],
    ],
  );
  const persisted = await pool.query<{ id: string }>(
    "SELECT id FROM occ.audit_events WHERE kind = 'runtime_activity' AND resource_id = $1 ORDER BY occurred_at DESC, id DESC",
    [revision.agentId],
  );
  assert.deepEqual(
    persisted.rows.map((row) => row.id),
    events.map((entry) => entry.id),
  );

  // Two calls to the same tool in one turn. The first received approval, but
  // its sender lost the result. The second was denied before dispatch.
  const call = { ...turn, toolName: "slack_send_message", invocationId: randomUUID() };
  const approval = { ...call, approvalId: randomUUID() };
  const execution = { ...call, attemptId: randomUUID() };
  const denied = { ...call, invocationId: randomUUID() };
  const records = [
    ["tool_call.requested", call, "success"],
    [
      "policy.decided",
      { ...call, policy: "managed_mcp_policy", decision: "require_approval" },
      "success",
    ],
    ["approval.requested", approval, "success"],
    ["approval.resolved", { ...approval, decision: "allow-once" }, "success"],
    ["tool_attempt.admitted", { ...execution, approvalId: approval.approvalId }, "success"],
    ["tool_attempt.completed", { ...execution, outcome: "unknown" }, "failure"],
    ["tool_call.requested", denied, "success"],
    ["policy.decided", { ...denied, policy: "managed_mcp_policy", decision: "deny" }, "denied"],
  ] as const;
  const send = (event: unknown) => post(event, replacement.token);
  for (const [action, fields] of records) {
    const observation = { ...envelope(), action: `openclaw.runtime.${action}`, ...fields };
    assert.equal(await send(observation), 204);
    if (action === "tool_attempt.completed") {
      assert.equal(await send(observation), 204);
      assert.equal(await send({ ...observation, outcome: "succeeded" }), 409);
      assert.equal(await send({ ...observation, ...envelope(), output: "private output" }), 400);
      assert.equal(await send({ ...observation, ...envelope(), attemptId: undefined }), 400);
    }
    if (action === "policy.decided") {
      assert.equal(await send({ ...observation, ...envelope(), rationale: "private input" }), 400);
      assert.equal(await send({ ...observation, ...envelope(), policy: "network_policy" }), 400);
      assert.equal(await send({ ...observation, ...envelope(), policy: "codex_guardian" }), 403);
      assert.equal(
        await send({
          ...envelope(),
          action: observation.action,
          policy: "repository_send",
          decision: "allow",
          receiptId: randomUUID(),
        }),
        400,
      );
    }
  }
  const toolPage = (await input.readPage()).events.filter(
    (row) => row.event === "runtime_activity" && "invocationId" in row.details,
  );
  const stored = await pool.query(
    "SELECT id, action, outcome, details - '__occAuditMetadata' AS details FROM occ.audit_events WHERE resource_id = $1 AND details ? 'invocationId'",
    [revision.agentId],
  );
  assert.equal(toolPage.length, records.length);
  assert.equal(stored.rowCount, records.length);
  for (const [suffix, fields, outcome] of records) {
    const action = `openclaw.runtime.${suffix}`;
    const row = stored.rows.find(
      (r) => r.action === action && r.details.invocationId === fields.invocationId,
    );
    assert.ok(row, suffix);
    const details = { ...fields, agentRevisionId: replacementId, runtimeSource: "openclaw" };
    assert.deepEqual(row.details, details);
    assert.equal(row.outcome, outcome);
    const entry = toolPage.find(({ id }) => id === row.id);
    assert.ok(entry?.event === "runtime_activity");
    assert.deepEqual([entry.action, entry.outcome, entry.details], [action, outcome, details]);
  }
  await checkSandboxAudit(
    state,
    { ...revision, id: replacementId },
    replacement,
    post,
    input.readPage,
  );
}
