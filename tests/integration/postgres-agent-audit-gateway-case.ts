import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { TestContext } from "node:test";
import { createSecureContext } from "node:tls";
import type { AgentAuditPage, AgentRevision } from "@openclaw-enterprise/contracts";
import type pg from "pg";

import { startGatewayRuntimeAuditListener } from "../../apps/controller/src/http/runtime-audit.ts";
import { recordDedicatedModel } from "../../deploy/runtime/managed-runtime-audit/dedicated.mjs";
import {
  ResourceConflictError,
  ScopeViolationError,
  type PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { privateBootstrapDirectory } from "../helpers/bootstrap-installation.mjs";
import { selfSigned } from "../helpers/certificates.ts";
import { withPool } from "../helpers/postgres-database.mjs";
import { waitForLockWaiter } from "../helpers/postgres-locks.ts";

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
            "content-type": "application/json",
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
      request.end(JSON.stringify(event));
    });
}

function credential(revision: AgentRevision, runtimeSource: "openclaw" | "codex" = "openclaw") {
  const token = randomBytes(32).toString("base64url");
  const grant = {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    agentRevisionId: revision.id,
    runtimeSource,
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
    codex: AgentRevision;
    replacementId: string;
    readPage: (agentId: string) => Promise<AgentAuditPage>;
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
  const envelope = (): { eventId: string; occurredAt: string } => ({
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
  });
  const started = { ...envelope(), action: "openclaw.runtime.turn.started", ...turn };

  // A retry after worker restart can reuse the credential for this revision only.
  assert.equal(await post(started, token), 401);
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
  assert.equal(await post(started, token, "codex"), 403);

  // Keep the private write endpoint and the public read endpoint separate.
  const auditPath = `/namespaces/${revision.namespaceId}/agents/${revision.agentId}/audit-events`;
  const headers = {
    authorization: `Bearer ${token}`,
    "x-openclaw-runtime-audit-source": "openclaw",
  };
  assert.equal(
    (await app.inject({ method: "POST", url: route, headers, payload: started })).statusCode,
    404,
  );
  assert.equal((await app.inject({ method: "GET", url: auditPath, headers })).statusCode, 401);
  assert.equal(await post(started, token, "openclaw", auditPath), 404);
  assert.equal(await post({ ...started, agentRevisionId: replacementId }, token), 400);
  assert.equal(await post({ ...started, prompt: "private input" }, token), 400);
  assert.equal(await post({ ...started, action: "openclaw.agents.create" }, token), 400);
  assert.equal(
    await post(
      { ...started, ...attempt, turnId: undefined, action: "openclaw.runtime.model_call.started" },
      token,
    ),
    400,
  );

  // A failed observation write is retryable. Concurrent copies create exactly one record.
  await withPool(migrationUrl, async (migrator) => {
    await migrator.query(`ALTER TABLE occ.audit_events ADD CONSTRAINT reject_runtime_audit
      CHECK (kind <> 'runtime_activity') NOT VALID`);
    try {
      assert.equal(await post(started, token), 503);
    } finally {
      await migrator.query("ALTER TABLE occ.audit_events DROP CONSTRAINT reject_runtime_audit");
    }
  });
  assert.deepEqual(await Promise.all([post(started, token), post(started, token)]), [204, 204]);
  assert.equal(await post({ ...started, turnId: randomUUID() }, token), 409);
  assert.equal(await post(started, other.token), 204);
  const completed = {
    ...envelope(),
    action: "openclaw.runtime.model_call.completed",
    ...attempt,
    outcome: "cancelled",
  };

  // Each grant can report only the model events its runtime observes.
  const codex = credential(input.codex, "codex");
  await state.registerGatewayRuntimeGrant(codex.grant);
  const model = {
    sessionId: randomUUID(),
    turnId: randomUUID(),
    provider: "codex",
    model: "gpt-4.1",
  };
  const codexCallDetails = { ...model, modelCallId: randomBytes(32).toString("hex") };
  const codexCallStarted = {
    ...envelope(),
    action: "openclaw.runtime.model_call.started",
    ...codexCallDetails,
  };
  assert.equal(await post(codexCallStarted, token), 403);
  assert.equal(await post({ ...codexCallStarted, provider: "openai" }, codex.token, "codex"), 403);
  assert.equal(await post(codexCallStarted, codex.token, "codex"), 204);
  const attemptDetails = {
    ...codexCallDetails,
    modelAttemptId: randomBytes(32).toString("hex"),
    attempt: 1,
    httpStatus: 503,
  };
  const codexAttempt = {
    ...envelope(),
    action: "openclaw.runtime.model_attempt.observed",
    ...attemptDetails,
  };
  assert.equal(await post(codexAttempt, token), 403);
  // A shared event name must not let a Codex revision report an OpenClaw request.
  assert.equal(await post({ ...codexAttempt, provider: "openai" }, codex.token, "codex"), 403);
  assert.equal(await post(codexAttempt, codex.token, "codex"), 204);
  // A Gateway restart can queue the same provider attempt with a new delivery ID.
  // Both deliveries must succeed and the audit page must show just one attempt.
  assert.equal(await post({ ...codexAttempt, eventId: randomUUID() }, codex.token, "codex"), 204);
  const details = { ...model, responseIdHash: "sha256:4ee3d95d9f2d7b7b" };
  const observed = {
    ...envelope(),
    action: "openclaw.runtime.model_response.observed",
    ...details,
  };
  assert.equal(await post(completed, codex.token, "codex"), 403);
  assert.equal(await post(observed, token), 403);
  assert.equal(await post(observed, codex.token, "codex"), 204);
  const openclawModel = {
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    provider: "custom+proxy",
    model: "team/claude:4.5",
  };
  const responseId = "response-fixture";
  const openclawResponseDetails = {
    ...openclawModel,
    responseIdHash: "sha256:" + createHash("sha256").update(responseId).digest("hex").slice(0, 16),
  };
  const openclawResponse = {
    ...envelope(),
    action: "openclaw.runtime.model_response.observed",
    ...openclawResponseDetails,
  };
  // A valid model ID can contain slashes and colons. Exercise the real
  // committed-worker recorder before sending its result to the audit API.
  const recorded: Record<string, unknown>[] = [];
  const timestamp = Date.now();
  recordDedicatedModel((event: Record<string, unknown>) => recorded.push(event), {
    target: { sessionId: turn.sessionId },
    messageId: randomUUID(),
    runId: turn.turnId,
    message: {
      role: "assistant",
      idempotencyKey: "worker-commit-" + randomBytes(32).toString("base64url"),
      __openclaw: { runId: turn.turnId },
      provider: openclawModel.provider,
      model: openclawModel.model,
      responseId,
      timestamp,
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(recorded.length, 1);
  openclawResponse.eventId = String(recorded[0]!.eventId);
  openclawResponse.occurredAt = new Date(timestamp).toISOString();
  assert.deepEqual(recorded[0], openclawResponse);
  const openclawErrorDetails = { ...openclawModel, errorCode: "503" };
  const openclawError = {
    ...envelope(),
    action: "openclaw.runtime.model_error.observed",
    ...openclawErrorDetails,
  };
  const transportDetails = {
    ...openclawModel,
    modelCallId: randomUUID(),
    modelAttemptId: randomBytes(32).toString("hex"),
    attempt: 1,
    failureCode: "TRANSPORT_ERROR",
  };
  const transport = {
    ...envelope(),
    action: "openclaw.runtime.model_attempt.observed",
    ...transportDetails,
  };
  // A saved worker response can be reported only by its OpenClaw revision.
  // Repeated transcript notifications use one delivery ID and create one row.
  assert.equal(await post(openclawResponse, codex.token, "codex"), 403);
  assert.equal(await post(openclawError, codex.token, "codex"), 403);
  assert.equal(await post({ ...openclawError, provider: "codex" }, token), 403);
  assert.equal(await post({ ...openclawError, errorCode: "private error text" }, token), 400);
  assert.equal(await post({ ...openclawError, errorMessage: "private error text" }, token), 400);
  // A model request has either response headers or a transport failure, not both.
  assert.equal(await post({ ...transport, failureCode: undefined }, token), 400);
  assert.equal(await post({ ...transport, httpStatus: 200 }, token), 400);
  assert.deepEqual(
    await Promise.all([post(openclawResponse, token), post(openclawResponse, token)]),
    [204, 204],
  );
  assert.equal(await post(openclawError, token), 204);
  assert.equal(await post(transport, token), 204);
  // A later response in this turn must not hide the earlier HTTP failure.
  const codexPage = await input.readPage(input.codex.agentId);
  assert.deepEqual(
    codexPage.events
      .filter((entry) => entry.event === "runtime_activity")
      .map((entry) => [entry.action, entry.outcome, entry.details]),
    [
      [
        observed.action,
        "success",
        { ...details, agentRevisionId: input.codex.id, runtimeSource: "codex" },
      ],
      [
        codexAttempt.action,
        "failure",
        { ...attemptDetails, agentRevisionId: input.codex.id, runtimeSource: "codex" },
      ],
      [
        codexCallStarted.action,
        "success",
        { ...codexCallDetails, agentRevisionId: input.codex.id, runtimeSource: "codex" },
      ],
    ],
  );

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
  assert.equal(await post(started, token), 401);
  assert.equal(await state.hasGatewayRuntimeGrant(grant), false);
  assert.equal(
    await post(
      { ...envelope(), ...session, action: "openclaw.runtime.session.started" },
      replacement.token,
    ),
    204,
  );

  // The reader can trace both revisions of this Agent. The peer's event is private.
  const page = await input.readPage(revision.agentId);
  const events = page.events.filter((entry) => entry.event === "runtime_activity");
  const addedActions = new Set([openclawResponse.action, openclawError.action, transport.action]);
  const observations = events.filter((entry) => addedActions.has(entry.action));
  assert.equal(observations.length, 3);
  assert.deepEqual(
    observations.map((entry) => [entry.action, entry.outcome, entry.details]).sort(),
    [
      [
        openclawResponse.action,
        "success",
        { ...openclawResponseDetails, agentRevisionId: revision.id, runtimeSource: "openclaw" },
      ],
      [
        openclawError.action,
        "failure",
        { ...openclawErrorDetails, agentRevisionId: revision.id, runtimeSource: "openclaw" },
      ],
      [
        transport.action,
        "failure",
        { ...transportDetails, agentRevisionId: revision.id, runtimeSource: "openclaw" },
      ],
    ].sort(),
  );
  assert.deepEqual(
    events
      .filter((entry) => !addedActions.has(entry.action))
      .map((entry) => [entry.action, entry.details]),
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
        "openclaw.runtime.turn.started",
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
}
