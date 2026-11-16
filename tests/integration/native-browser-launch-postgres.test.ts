import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import pg from "pg";
import { Check } from "typebox/value";

import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { AgentResponse, AgentSchema, NamespaceSchema } from "../../packages/contracts/src/index.ts";
import {
  asRecord,
  cookieHeaderFromSetCookie,
  isNonEmptyString,
  isPositiveSafeInteger,
} from "../../packages/utils/src/index.ts";
import {
  adminEmail,
  assertSocketClosesAfterMutation,
  createApi,
  createNativeAgent,
  ensureBootstrap,
  listen,
  nativeGet,
  openNativeWebSocket,
  requiresPostgres,
  signIn,
  startNativeHttpsUpstream,
  trustLocalUpstreamCertificate,
} from "../helpers/native-admin-postgres.ts";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { waitUntil, within } from "../helpers/wait-for.mjs";

type NativeApi = Awaited<ReturnType<typeof createApi>>;
type NativeSession = Awaited<ReturnType<typeof signIn>>;
type InjectResponse = Awaited<ReturnType<NativeApi["app"]["inject"]>>;

type RawLaunchTarget = Pick<
  Awaited<ReturnType<typeof createNativeAgent>>,
  "principal" | "revision"
> & {
  agent: unknown;
  namespace: unknown;
  native: unknown;
};

async function createLaunchTarget(
  api: NativeApi,
  session: NativeSession,
  upstream: Awaited<ReturnType<typeof startNativeHttpsUpstream>>,
) {
  const {
    agent,
    namespace,
    native: access,
    principal,
    revision,
  }: RawLaunchTarget = await createNativeAgent(api, session, upstream);
  const native = asRecord(access);
  assert.ok(Check(AgentSchema, agent), "the fixture must create an Agent");
  assert.ok(Check(NamespaceSchema, namespace), "the fixture must create a Namespace");
  assert.ok(native && isNonEmptyString(native.origin), "native access must return an origin");
  return {
    agent,
    namespace,
    native: { origin: native.origin },
    principal,
    revision,
  };
}

async function prepareLaunch(t: TestContext, label: string) {
  await ensureBootstrap(t);
  const upstream = await startNativeHttpsUpstream(t);
  const api = await createApi(t, label, upstream.port, { exchange: true });
  t.after(() => api.app.close());
  const session = await signIn(api.app);
  const target = await createLaunchTarget(api, session, upstream);

  const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
  assert.ok(databaseUrl, "the launch cases require a prepared PostgreSQL database");
  const observer = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  t.after(() => observer.end());
  return { upstream, api, session, observer, ...target };
}

async function parentSessionId(api: NativeApi) {
  const result = await api.pool.query<{ id: unknown }>(
    `SELECT session.id
       FROM occ.session AS session
       JOIN occ."user" AS account ON account.id = session.user_id
      WHERE account.email = $1
      ORDER BY session.created_at DESC
      LIMIT 1`,
    [adminEmail],
  );
  assert.equal(result.rowCount, 1, "sign-in must persist a parent session row");
  const id = result.rows[0]?.id;
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

test(
  "PostgreSQL native browser launch and Agent creation share a consistent authority lock order",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const { upstream, api, session, observer, agent, namespace, principal } = await prepareLaunch(
      t,
      "launch-lock-order",
    );
    const parentId = await parentSessionId(api);
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
      assert.ok(
        isPositiveSafeInteger(creatorPid),
        "Agent creation must have a waiting backend PID",
      );
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
  },
);

test(
  "PostgreSQL native browser launch rechecks parent expiry after waiting for the Namespace",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const { upstream, api, session, observer, agent, namespace } = await prepareLaunch(
      t,
      "launch-expiry-wait",
    );
    const parentId = await parentSessionId(api);
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
  },
);

test(
  "PostgreSQL native browser shutdown drains an in-flight launch without returning access",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
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
  },
);

// Drive the real bridge protocol without claiming browser cookie or popup behavior.
// The browser integration separately exercises those mechanics with trusted HTTPS.
async function launchNativeBrowserSession(
  api: NativeApi,
  session: NativeSession,
  target: Awaited<ReturnType<typeof createLaunchTarget>>,
  previousCookie?: string,
) {
  const path = `/namespaces/${target.namespace.id}/agents/${target.agent.id}/native-admin`;
  const headers = {
    origin: api.origin,
    cookie: session.cookie,
    "x-occ-session-key": session.sessionKey,
  };
  const launch = await launchBrowser(api, session, target.namespace.id, target.agent.id);
  assert.equal(launch.statusCode, 200, launch.body);
  const launchData = asRecord(asRecord(launch.json<unknown>())?.data);
  assert.ok(launchData, "launch must return a data envelope");
  const { intentId, landingUrl } = launchData;
  assert.ok(isNonEmptyString(intentId), "launch must return an intent ID");
  assert.ok(isNonEmptyString(landingUrl), "launch must return a landing URL");
  const landing = new URL(landingUrl);
  const bound = await api.app.inject({
    method: "GET",
    url: landing.pathname + landing.search,
    headers: { host: landing.host, ...(previousCookie ? { cookie: previousCookie } : {}) },
  });
  assert.equal(bound.statusCode, 200, bound.body);
  const challengeCookie = cookieHeaderFromSetCookie(bound.headers["set-cookie"]);
  const challenge = challengeCookie.split("=")[1];
  assert.ok(isNonEmptyString(challenge), "the landing page must issue a challenge cookie");
  const confirm = await api.app.inject({
    method: "POST",
    url: `${path}/confirm`,
    headers,
    payload: { intentId, challenge },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const confirmation = asRecord(asRecord(confirm.json<unknown>())?.data);
  assert.ok(confirmation, "confirmation must return a data envelope");
  const { exchange, redeemUrl } = confirmation;
  assert.ok(isNonEmptyString(exchange), "confirmation must return an exchange code");
  assert.ok(isNonEmptyString(redeemUrl), "confirmation must return a redemption URL");
  const redeem = new URL(redeemUrl);
  const issued = await api.app.inject({
    method: "POST",
    url: redeem.pathname,
    headers: {
      host: redeem.host,
      origin: api.origin,
      cookie: [challengeCookie, previousCookie].filter(Boolean).join("; "),
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams({ intentId, exchange }).toString(),
  });
  assert.equal(issued.statusCode, 200, issued.body);
  const cookie = cookieHeaderFromSetCookie(issued.headers["set-cookie"])
    .split("; ")
    .find((value) => value.startsWith("__Host-occ_agent_access="));
  assert.ok(cookie, "successful redemption must return a host-only Agent handle");
  return cookie;
}

test(
  "PostgreSQL host-only relaunch preserves an existing socket only for the same parent and revision",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    await ensureBootstrap(t);
    const upstream = await startNativeHttpsUpstream(t);
    trustLocalUpstreamCertificate(t, upstream.cert);
    const api = await createApi(t, "relaunch", upstream.port, { exchange: true });
    t.after(() => api.app.close());
    const parent = await signIn(api.app);
    const target = await createLaunchTarget(api, parent, upstream);
    const other = await createLaunchTarget(api, parent, upstream);
    const port = await listen(api.app);
    const cookie = await launchNativeBrowserSession(api, parent, target);
    const socket = await openNativeWebSocket(port, target.native, cookie);
    t.after(() => {
      socket.destroy();
    });

    // Reopening the same Agent must leave a previously admitted tab connected.
    // Carry the actual cookie returned by the first exchange through redemption.
    const reopened = await launchNativeBrowserSession(api, parent, target, cookie);

    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    await assertSocketClosesAfterMutation(socket, async () => {
      // The helper first waits through multiple real lease renewals. Prove bytes
      // still cross the old relay, then replace the revision through its owner.
      assert.equal(
        reopened,
        cookie,
        "same-parent, same-revision relaunch must reuse the live handle",
      );
      const otherCookie = await launchNativeBrowserSession(api, parent, other, cookie);
      assert.notEqual(otherCookie, cookie, "a different Agent must receive its own handle");
      assert.equal((await nativeGet(api, target.native, otherCookie)).statusCode, 403);
      assert.equal((await nativeGet(api, target.native, cookie)).statusCode, 200);

      const peer = upstream.peers[0];
      assert.ok(peer, "the original relay must have an upstream peer");
      peer.write("still-connected-after-relaunch");
      await waitUntil(
        "the original relay after relaunch",
        () => received.includes("still-connected-after-relaunch"),
        2_000,
      );
      const revision = await api.controller.deployAgent(
        target.principal.id,
        { namespaceId: target.namespace.id, agentId: target.agent.id },
        resolveApprovedHarness,
      );
      await api.state.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(
          target.namespace.id,
          target.agent.id,
          target.revision.id,
          revision.id,
        ),
      );
    });
    assert.equal((await nativeGet(api, target.native, cookie)).statusCode, 403);
    // A deployment invalidates this handle without logging the person out. Refreshing
    // a named chat page must explain how to reopen, never silently adopt the new version.
    const agentUrl = new URL(target.native.origin);
    const host = agentUrl.host;
    const key = agentUrl.hostname.match(/^agent-([a-f0-9]{32})\./)?.[1];
    assert.ok(key, "the Agent host must encode its Console return key");
    const requestsBeforeRefresh = upstream.requests.length;
    for (const activation of [{}, { "sec-fetch-user": "?1" }]) {
      const stalePage = await api.app.inject({
        method: "GET",
        url: `/chat/main/simple-test-session-${"a".repeat(32)}`,
        headers: {
          host,
          cookie,
          accept: "text/html",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          ...activation,
        },
      });
      assert.equal(stalePage.statusCode, 403);
      const contentType = stalePage.headers["content-type"];
      assert.ok(typeof contentType === "string");
      assert.match(contentType, /^text\/html/);
      assert.match(stalePage.body, /Agent version changed/);
      assert.ok(
        stalePage.body.includes(
          `<a href="${api.origin}/console/#native-agent=${key}">Return to console</a>`,
        ),
        "the recovery destination must be a clickable link",
      );
      assert.equal(stalePage.headers.location, undefined);
      assert.equal(stalePage.headers["set-cookie"], undefined);
      assert.equal(stalePage.headers["cache-control"], "no-store");
      assert.ok(stalePage.headers["x-request-id"]);
      assert.equal(upstream.requests.length, requestsBeforeRefresh);
    }
    const staleApi = await nativeGet(api, target.native, cookie, "/api/status");
    assert.equal(staleApi.statusCode, 403);
    const contentType = staleApi.headers["content-type"];
    assert.ok(typeof contentType === "string");
    assert.match(contentType, /^application\/json/);
    const revisedCookie = await launchNativeBrowserSession(api, parent, target, cookie);
    assert.notEqual(revisedCookie, cookie, "a new revision cannot reuse the previous handle");
    const revisedSocket = await openNativeWebSocket(port, target.native, revisedCookie);
    t.after(() => {
      revisedSocket.destroy();
    });

    // A new parent session for the same account must not inherit the old handle.
    const newParent = await signIn(api.app);
    assert.notEqual(newParent.sessionKey, parent.sessionKey);
    let newCookie: string | undefined;
    await assertSocketClosesAfterMutation(revisedSocket, async () => {
      newCookie = await launchNativeBrowserSession(api, newParent, target, revisedCookie);
      assert.notEqual(newCookie, revisedCookie);
    });
    assert.ok(newCookie, "the new session must receive its own handle");
    const newSocket = await openNativeWebSocket(port, target.native, newCookie);
    t.after(() => {
      newSocket.destroy();
    });
    await assertSocketClosesAfterMutation(newSocket, async () => {
      const signedOut = await api.app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        headers: {
          host: injectedJsonHeaders.host,
          cookie: newParent.cookie,
          origin: newParent.origin,
        },
      });
      assert.equal(signedOut.statusCode, 200, signedOut.body);
    });
    assert.equal((await nativeGet(api, target.native, newCookie)).statusCode, 403);
    assert.ok(upstream.upgrades.every((upgrade) => upgrade.headers.cookie === undefined));
  },
);
