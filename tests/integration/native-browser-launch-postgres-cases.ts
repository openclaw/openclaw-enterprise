import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import pg from "pg";
import { Check } from "typebox/value";

import { AgentResponse, AgentSchema, NamespaceSchema } from "../../packages/contracts/src/index.ts";
import {
  asRecord,
  isNonEmptyString,
  isPositiveSafeInteger,
} from "../../packages/utils/src/index.ts";
import {
  createApi,
  createNativeAgent,
  ensureBootstrap,
  signIn,
  startNativeHttpsUpstream,
} from "../helpers/native-admin-postgres.ts";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { waitUntil, within } from "../helpers/wait-for.mjs";

type NativeApi = Awaited<ReturnType<typeof createApi>>;
type NativeSession = Awaited<ReturnType<typeof signIn>>;
type InjectResponse = Awaited<ReturnType<NativeApi["app"]["inject"]>>;
type ReadParentSession = (api: NativeApi) => Promise<unknown>;

async function prepareLaunch(t: TestContext, label: string) {
  await ensureBootstrap(t);
  const upstream = await startNativeHttpsUpstream(t);
  const api = await createApi(t, label, upstream.port, { exchange: true });
  t.after(() => api.app.close());
  const session = await signIn(api.app);
  const fixture = await createNativeAgent(api, session, upstream);
  const agent: unknown = fixture.agent;
  const namespace: unknown = fixture.namespace;
  assert.ok(Check(AgentSchema, agent), "the fixture must create an Agent");
  assert.ok(Check(NamespaceSchema, namespace), "the fixture must create a Namespace");

  const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
  assert.ok(databaseUrl, "the launch cases require a prepared PostgreSQL database");
  const observer = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  t.after(() => observer.end());
  return { upstream, api, session, observer, agent, namespace, principal: fixture.principal };
}

async function parentSessionId(api: NativeApi, readParentSession: ReadParentSession) {
  const id = asRecord(await readParentSession(api))?.id;
  assert.ok(isNonEmptyString(id), "sign-in must persist a parent session ID");
  return id;
}

function backendPid(result: pg.QueryResult<{ pid: unknown }>): number {
  assert.equal(result.rowCount, 1, "the fence query must return one backend");
  const pid = result.rows[0]?.pid;
  assert.ok(isPositiveSafeInteger(pid), "the fence query must return a PostgreSQL backend PID");
  return pid;
}

function startRequest<T>(request: Promise<T>): Promise<T> {
  // Fastify injection can be thenable. Start it before observing the lock graph
  // and keep an early rejection handled while the case waits on PostgreSQL.
  const pending = Promise.resolve(request);
  void pending.catch(() => undefined);
  return pending;
}

function launchBrowser(
  api: NativeApi,
  session: NativeSession,
  namespaceId: string,
  agentId: string,
  headers?: { host: string; "content-type": string },
) {
  return startRequest(
    api.app.inject({
      method: "POST",
      url: `/namespaces/${namespaceId}/agents/${agentId}/native-admin/launch`,
      headers: {
        ...headers,
        origin: session.origin,
        cookie: session.cookie,
        "x-occ-session-key": session.sessionKey,
      },
      payload: {},
    }),
  );
}

const injectedJsonHeaders = { host: "127.0.0.1", "content-type": "application/json" };

async function releaseFence(
  holder: pg.PoolClient,
  requests: readonly (Promise<unknown> | undefined)[],
) {
  let rolledBack = false;
  try {
    await holder.query("ROLLBACK");
    rolledBack = true;
  } finally {
    holder.release(!rolledBack);
    await Promise.allSettled(requests);
  }
}

export async function assertNativeBrowserLaunchAuthorityLockOrder(
  t: TestContext,
  readParentSession: ReadParentSession,
) {
  const { upstream, api, session, observer, agent, namespace, principal } = await prepareLaunch(
    t,
    "launch-lock-order",
  );
  const parentId = await parentSessionId(api, readParentSession);
  const holder = await observer.connect();
  let creating: Promise<InjectResponse> | undefined;
  let launching: Promise<InjectResponse> | undefined;
  try {
    await holder.query("BEGIN");
    const lock = await holder.query<{ pid: unknown }>(
      "SELECT pg_backend_pid() AS pid FROM occ.session WHERE id = $1 FOR UPDATE",
      [parentId],
    );
    const holderPid = backendPid(lock);
    // The API write holds user SHARE before its session fence. Delay that fence
    // so the real launch can reach the same user's conflicting authority lock.
    creating = startRequest(
      api.app.inject({
        method: "POST",
        url: `/namespaces/${namespace.id}/agents`,
        headers: {
          ...injectedJsonHeaders,
          origin: session.origin,
          cookie: session.cookie,
        },
        payload: {
          name: `Concurrent native launch ${randomUUID()}`,
          configurationId: agent.configurationId,
          harnessAuth: agent.harnessAuth,
          gatewayManagedMode: false,
        },
      }),
    );
    const creatorPid: unknown = await waitForLockWaiter(
      observer,
      holderPid,
      "Agent creation waiting on the parent session fence",
      { queryLike: "%UPDATE occ.session%", timeoutMs: 5_000 },
    );
    assert.ok(isPositiveSafeInteger(creatorPid), "Agent creation must have a waiting backend PID");
    launching = launchBrowser(api, session, namespace.id, agent.id, injectedJsonHeaders);
    await waitForLockWaiter(observer, creatorPid, "native launch waiting on user authority", {
      queryLike: '%FROM occ."user"%FOR UPDATE%',
      timeoutMs: 5_000,
    });
    // With resource-first launch locking, it already holds Namespace SHARE:
    // releasing this fence then deadlocks the API's Namespace UPDATE against
    // the launch's user UPDATE. Both supported requests must instead complete.
    await holder.query("COMMIT");
    const [created, launched] = await within(
      Promise.all([creating, launching]),
      "concurrent Agent creation and native launch did not settle",
      10_000,
    );
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(launched.statusCode, 200, launched.body);
    const createdBody = created.json<unknown>();
    assert.ok(Check(AgentResponse, createdBody), "creation must return an Agent response");
    const intentId = asRecord(asRecord(launched.json<unknown>())?.data)?.intentId;
    assert.ok(isNonEmptyString(intentId), "launch must return an intent ID");
    const retained = await observer.query<{
      agents: unknown;
      intents: unknown;
      audits: unknown;
      audit_actor: unknown;
    }>(
      `SELECT
        (SELECT count(*)::int FROM occ.agents WHERE namespace_id = $1 AND id = $2) AS agents,
        (SELECT count(*)::int FROM occ.native_browser_intents
          WHERE id = $3 AND agent_id = $4 AND parent_session_id = $5) AS intents,
        count(*)::int AS audits,
        min(actor_id) AS audit_actor
       FROM occ.audit_events
       WHERE resource_id = $4 AND action = 'authentication.native.launch' AND outcome = 'success'`,
      [namespace.id, createdBody.data.id, intentId, agent.id, parentId],
    );
    assert.deepEqual(retained.rows[0], {
      agents: 1,
      intents: 1,
      audits: 1,
      audit_actor: principal.id,
    });
    assert.equal(upstream.requests.length, 0);
  } finally {
    await releaseFence(holder, [creating, launching]);
  }
}

export async function assertNativeBrowserLaunchRechecksParentExpiry(
  t: TestContext,
  readParentSession: ReadParentSession,
) {
  const { upstream, api, session, observer, agent, namespace } = await prepareLaunch(
    t,
    "launch-expiry-wait",
  );
  const parentId = await parentSessionId(api, readParentSession);
  const holder = await observer.connect();
  let launching: Promise<InjectResponse> | undefined;
  try {
    await holder.query("BEGIN");
    const lock = await holder.query<{ pid: unknown }>(
      "SELECT pg_backend_pid() AS pid FROM occ.namespaces WHERE id = $1 FOR UPDATE",
      [namespace.id],
    );
    const holderPid = backendPid(lock);
    await observer.query(
      "UPDATE occ.session SET expires_at = clock_timestamp() + interval '5 seconds' WHERE id = $1",
      [parentId],
    );
    launching = launchBrowser(api, session, namespace.id, agent.id, injectedJsonHeaders);
    // The parent was current when launch took its authority locks. Real elapsed
    // database time can expire it while the resource lock is still unavailable.
    await waitForLockWaiter(observer, holderPid, "native launch waiting on Namespace", {
      queryLike: "%FROM occ.namespaces%FOR SHARE%",
      timeoutMs: 5_000,
    });
    await waitUntil(
      "the held parent session to expire on the database clock",
      async () => {
        const result = await observer.query<{ expired: unknown }>(
          "SELECT expires_at <= clock_timestamp() AS expired FROM occ.session WHERE id = $1",
          [parentId],
        );
        const expired = result.rows[0]?.expired;
        assert.equal(typeof expired, "boolean", "the parent session must have an expiry state");
        return expired === true;
      },
      { timeoutMs: 10_000, intervalMs: 25 },
    );
    await holder.query("COMMIT");
    const response = await within(launching, "expired native launch did not settle", 5_000);
    assert.equal(response.statusCode, 404, response.body);
    const body = asRecord(response.json<unknown>());
    assert.ok(body, "expiry must return an error envelope");
    assert.equal(body.data, undefined, "expired launch must not return a landing URL");
    const retained = await observer.query<{ intents: unknown; audits: unknown }>(
      `SELECT
        (SELECT count(*)::int FROM occ.native_browser_intents WHERE agent_id = $1) AS intents,
        (SELECT count(*)::int FROM occ.audit_events WHERE resource_id = $1
          AND action = 'authentication.native.launch' AND outcome = 'success') AS audits`,
      [agent.id],
    );
    assert.deepEqual(retained.rows[0], { intents: 0, audits: 0 });
    assert.equal(upstream.requests.length, 0);
  } finally {
    await releaseFence(holder, [launching]);
  }
}

export async function assertNativeBrowserShutdownDrainsLaunch(t: TestContext) {
  const { upstream, api, session, observer, agent, namespace, principal } = await prepareLaunch(
    t,
    "launch-shutdown",
  );
  const holder = await observer.connect();
  let pending: Promise<InjectResponse> | undefined;
  let closing: Promise<void> | undefined;
  try {
    await holder.query("BEGIN");
    // Hold the store's real serialization lock. Authorization still runs through
    // the composed API; only the PostgreSQL launch transaction is delayed.
    const lock = await holder.query<{ pid: unknown }>(
      "SELECT pg_backend_pid() AS pid, pg_advisory_xact_lock(1868785007, hashtext($1))",
      [api.controller.installation.id],
    );
    const holderPid = backendPid(lock);
    pending = launchBrowser(api, session, namespace.id, agent.id);
    await waitForLockWaiter(observer, holderPid, "the native launch transaction", {
      queryLike: "%pg_advisory_xact_lock%",
      timeoutMs: 5_000,
    });
    closing = startRequest(api.app.close());
    // Allow Fastify's preClose hooks to begin before releasing the database.
    // The 503 and committed audit below are the oracle.
    await setImmediate();
    await holder.query("COMMIT");
    const response = await within(pending, "the launch did not settle during shutdown", 5_000);
    assert.equal(response.statusCode, 503, response.body);
    const body = asRecord(response.json<unknown>());
    assert.ok(body, "shutdown must return an error envelope");
    assert.equal(body.data, undefined, "shutdown must not return a landing URL");
    await within(closing, "API shutdown did not drain the launch transaction", 5_000);

    // Work already admitted can commit, but its intent and attributable audit must
    // settle before the API pool closes; it must never mint an Agent access handle.
    const retained = await observer.query<{
      intents: unknown;
      audits: unknown;
      audit_actor: unknown;
      handles: unknown;
    }>(
      `SELECT
        (SELECT count(*)::int FROM occ.native_browser_intents WHERE agent_id = $1) AS intents,
        count(*)::int AS audits,
        min(actor_id) AS audit_actor,
        (SELECT count(*)::int FROM occ.native_browser_handles WHERE agent_id = $1) AS handles
       FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'authentication.native.launch' AND outcome = 'success'`,
      [agent.id],
    );
    assert.deepEqual(retained.rows[0], {
      intents: 1,
      audits: 1,
      audit_actor: principal.id,
      handles: 0,
    });
    assert.equal(upstream.requests.length, 0);
  } finally {
    await releaseFence(holder, [pending, closing]);
  }
}
