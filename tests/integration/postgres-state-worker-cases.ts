import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { TestContext } from "node:test";
import { Check } from "typebox/value";

import { NamespaceResponse, type NamespaceStatus } from "../../packages/contracts/src/index.ts";
import type { ControllerWorkState } from "../../packages/occ/src/controller-work.ts";
import {
  adminEmail,
  adminPassword,
  databaseUrl,
  parseJsonLines,
  pollUntil,
  request,
  startController,
} from "../helpers/postgres-platform-state.ts";
import { waitUntil, within } from "../helpers/wait-for.mjs";

export async function recheckNamespaceRestriction(context: TestContext) {
  const [{ Pool }, { createControllerWorker }, { createDevelopmentComputeDriver }] =
    await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
      import("../helpers/development.ts"),
    ]);
  const pool = new Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  const api = await startController(context);

  const installation = await request(api, "GET", "/installation");
  assert.equal(installation.status, 200);
  const actor = await pool.query<{ id: string }>(
    `SELECT identity.id
     FROM occ.iam_identities AS identity
     JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
     WHERE auth_user.email = $1`,
    [adminEmail],
  );
  assert.equal(actor.rowCount, 1);
  const principal = actor.rows[0];
  assert.ok(principal);

  const namespace = await request(api, "POST", "/namespaces", {
    name: `revoked-before-dispatch-${randomUUID()}`,
  });
  assert.equal(namespace.status, 201);
  assert.ok(Check(NamespaceResponse.properties.data, namespace.data));
  const authorizedNamespace = await request(api, "POST", "/namespaces", {
    name: `authorized-positive-control-${randomUUID()}`,
  });
  assert.equal(authorizedNamespace.status, 201);
  assert.ok(Check(NamespaceResponse.properties.data, authorizedNamespace.data));
  const revokedId = namespace.data.id;
  const authorizedId = authorizedNamespace.data.id;

  // Revoke the exact Namespace after its request queues work and before the worker starts.
  const restrictionId = `restriction-worker-${randomUUID()}`;
  await pool.query(
    `INSERT INTO occ.iam_restrictions
     (id, namespace_id, action, resource_kind, resource_id, effect)
     VALUES ($1, $2, 'create', 'namespace', $2, 'deny')`,
    [restrictionId, revokedId],
  );

  const observedComputeEffects: string[] = [];
  const developmentCompute = createDevelopmentComputeDriver();
  const worker = createControllerWorker({
    pool: new Pool({ connectionString: databaseUrl }),
    pollIntervalMs: 20,
    computeDriver: {
      ...developmentCompute,
      async ensureNamespace(candidate) {
        observedComputeEffects.push(candidate.id);
        return developmentCompute.ensureNamespace(candidate);
      },
    },
    emit() {},
  });
  context.after(() => worker.stop());
  await worker.start();

  const rejected = await pollUntil(
    `revoked provisioning for Namespace ${revokedId} to reach a terminal state`,
    async () => {
      const rows = await pool.query<{ state: ControllerWorkState; attempt_count: number }>(
        `SELECT state, attempt_count FROM occ.controller_work
         WHERE namespace_id = $1 AND namespace_target = 'ready'`,
        [revokedId],
      );
      assert.equal(rows.rowCount, 1);
      const work = rows.rows[0];
      assert.ok(work);
      return work.state === "failed_permanent" || work.state === "succeeded" ? work : undefined;
    },
  );

  await pollUntil(
    `authorized positive-control Namespace ${authorizedId} to become ready`,
    async () => {
      const rows = await pool.query<{ status: NamespaceStatus }>(
        "SELECT status FROM occ.namespaces WHERE id = $1",
        [authorizedId],
      );
      assert.equal(rows.rowCount, 1);
      return rows.rows[0]?.status === "ready" ? true : undefined;
    },
  );
  assert.ok(
    observedComputeEffects.includes(authorizedId),
    "the positive-control Namespace must invoke the injected ComputeDriver",
  );
  assert.ok(
    !observedComputeEffects.includes(revokedId),
    "denied provisioning must not invoke the injected ComputeDriver",
  );
  assert.equal(rejected.state, "failed_permanent");
  assert.equal(rejected.attempt_count, 1);

  const persistedNamespace = await pool.query(
    "SELECT status, deleted_at FROM occ.namespaces WHERE id = $1",
    [revokedId],
  );
  assert.deepEqual(persistedNamespace.rows, [{ status: "failed", deleted_at: null }]);

  const lifecycleEffects = await pool.query(
    `SELECT action, outcome, actor_id FROM occ.audit_events
     WHERE resource_id = $1 AND action = 'openclaw.namespaces.lifecycle.ensure'
       AND outcome = 'success'`,
    [revokedId],
  );
  assert.equal(lifecycleEffects.rowCount, 0);

  const denial = await pool.query(
    `SELECT actor_id, outcome, details FROM occ.audit_events
     WHERE resource_id = $1 AND actor_id = $2 AND outcome IN ('denied', 'failure')`,
    [revokedId, principal.id],
  );
  assert.ok(
    denial.rowCount !== null && denial.rowCount > 0,
    "revocation must produce attributable durable failure evidence",
  );
}

export async function drainApiOnSigterm(context: TestContext) {
  const api = await startController(context);
  const agent = new Agent({ keepAlive: true });
  context.after(() => agent.destroy());
  const body = JSON.stringify({ email: adminEmail, password: adminPassword });
  // `expect: 100-continue` makes the server answer as it admits the request, before the
  // body. The request is then in flight on a keep-alive socket when shutdown begins.
  const signIn = httpRequest(`${api.origin}/api/auth/sign-in/email`, {
    method: "POST",
    agent,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      expect: "100-continue",
    },
  });
  const responded = new Promise<IncomingMessage>((resolve, reject) => {
    signIn.once("response", resolve).once("error", reject);
  });
  context.after(() => {
    signIn.destroy();
  });
  const admission = Promise.race([
    once(signIn, "continue").then(() => true),
    responded.then(() => false),
  ]);
  signIn.flushHeaders();
  const admitted = await within(admission, "the API must admit the request", 5_000);
  assert.ok(admitted, "the API must admit the request before its body arrives");

  // "close" also waits for stdio to end, so the last log lines are read before parsing.
  const exited: Promise<unknown[]> = once(api.child, "close");
  assert.ok(api.child.kill("SIGTERM"), "the API must receive SIGTERM");
  // Finish the request only after the listener has closed, so it completes during the drain.
  const { hostname, port } = new URL(api.origin);
  await waitUntil(
    "the API to stop accepting new connections",
    () =>
      new Promise<boolean>((resolve, reject) => {
        const probe = connect({
          host: hostname,
          port: Number(port),
          signal: AbortSignal.timeout(1_000),
        });
        probe.once("connect", () => {
          probe.destroy();
          resolve(false);
        });
        probe.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNREFUSED") {
            resolve(true);
          } else {
            reject(error);
          }
        });
      }),
    { timeoutMs: 5_000 },
  );
  signIn.end(body);

  // Admitted work still completes during the drain.
  const finished = responded.then(async (response) => {
    assert.equal(response.statusCode, 200);
    const end = once(response, "end");
    response.resume();
    await end;
  });

  // The drained response's socket must not hold shutdown open until the keep-alive
  // timeout (about 72 s), past the API Pod's 30 s default termination grace.
  const [[code, signal]] = await within(
    Promise.all([exited, finished]),
    "the API to finish the admitted response and exit",
    10_000,
  );
  assert.deepEqual({ code, signal }, { code: 0, signal: null });

  // The log must show the request completing after SIGTERM and before all onClose hooks finish.
  const output = api.output();
  const records: unknown[] = parseJsonLines(output, { lenient: true });
  const events = records.filter(
    (record): record is Record<string, unknown> =>
      typeof record === "object" && record !== null && !Array.isArray(record),
  );
  const started = events.findIndex(({ event }) => event === "shutdown.started");
  const completed = events.findIndex(({ event }) => event === "shutdown.completed");
  // startController's readiness sign-in logs first; the drained request is the last one.
  const drained = events.findLastIndex(
    ({ event, route }) => event === "http.completed" && route === "/api/auth/sign-in/email",
  );
  const startEvent = events[started];
  const completionEvent = events[completed];
  assert.ok(startEvent, `no shutdown.started event:\n${output}`);
  assert.ok(completionEvent, `no shutdown.completed event:\n${output}`);
  assert.ok(started < drained && drained < completed, "the drained request logs between them");
  assert.equal(startEvent.severity, "INFO");
  assert.equal(startEvent.signal, "SIGTERM");
  assert.equal(completionEvent.severity, "INFO");
  assert.equal(typeof completionEvent.durationMs, "number");

  // The listening line times the boot from process start and names each phase.
  const listening = events.find(({ event }) => event === "listening");
  assert.ok(listening && Number.isSafeInteger(listening.startupMs), `no startup time:\n${output}`);
  assert.ok(typeof listening.phasesMs === "object" && listening.phasesMs !== null);
  assert.deepEqual(Object.keys(listening.phasesMs), [
    "modules",
    "configuration",
    "composition",
    "ready",
    "listen",
  ]);
}
