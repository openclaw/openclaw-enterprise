import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import pg from "pg";

import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { injectJson as inject } from "../helpers/inject-json.mjs";
import { waitFor, waitUntil } from "../helpers/wait-for.mjs";
import {
  publicOrigin,
  nativeGatewayApiKey,
  requiresPostgres,
  adminEmail,
  ensureBootstrap,
  startNativeHttpsUpstream,
  trustLocalUpstreamCertificate,
  createApi,
  signIn,
  createNativeAgent,
  nativeGet,
  createAgentPermissionSession,
  listen,
  openNativeWebSocket,
  assertNativeWebSocketRejected,
  assertSocketClosesAfterMutation,
} from "../helpers/native-admin-postgres.ts";

// Drive the real bridge protocol without claiming browser cookie or popup behavior.
// The browser integration separately exercises those mechanics with trusted HTTPS.
async function launchNativeBrowserSession(api, session, target, previousCookie) {
  const path = `/namespaces/${target.namespace.id}/agents/${target.agent.id}/native-admin`;
  const headers = {
    origin: api.origin,
    cookie: session.cookie,
    "x-occ-session-key": session.sessionKey,
  };
  const launch = await api.app.inject({
    method: "POST",
    url: `${path}/launch`,
    headers,
    payload: {},
  });
  assert.equal(launch.statusCode, 200, launch.body);
  const { intentId, landingUrl } = launch.json().data;
  const landing = new URL(landingUrl);
  const bound = await api.app.inject({
    method: "GET",
    url: landing.pathname + landing.search,
    headers: { host: landing.host, ...(previousCookie ? { cookie: previousCookie } : {}) },
  });
  assert.equal(bound.statusCode, 200, bound.body);
  const challengeCookie = cookieHeaderFromSetCookie(bound.headers["set-cookie"]);
  const challenge = challengeCookie.split("=")[1];
  const confirm = await api.app.inject({
    method: "POST",
    url: `${path}/confirm`,
    headers,
    payload: { intentId, challenge },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const { exchange, redeemUrl } = confirm.json().data;
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

async function waitForAuditActions(pool, namespaceId, agentId, actions) {
  let remaining = actions;
  let rows = [];
  await waitUntil(
    () => `audit actions ${remaining.join(", ")}`,
    async () => {
      const result = await pool.query(
        `SELECT action, actor_id, outcome, details
         FROM occ.audit_events
        WHERE namespace_id = $1
          AND resource_kind = 'agent'
          AND resource_id = $2
          AND action = ANY($3::text[])
        ORDER BY occurred_at, id`,
        [namespaceId, agentId, actions],
      );
      rows = result.rows;
      remaining = actions.filter((action) => !rows.some((row) => row.action === action));
      return remaining.length === 0;
    },
    { timeoutMs: 5_000, intervalMs: 50 },
  );
  for (const action of actions) {
    const row = rows.find((candidate) => candidate.action === action);
    assert.ok(row, `${action} audit row must exist`);
    assert.equal(row.outcome, "success", `${action} audit outcome`);
    assert.ok(row.actor_id, `${action} audit must retain the human actor id`);
  }
  return rows;
}

async function waitForAuthorizationDenialAudit(
  pool,
  namespaceId,
  agentId,
  action,
  actorId,
  options = {},
) {
  const row = await waitFor(
    `${action} authorization-denial audit row`,
    async () => {
      const result = await pool.query(
        `SELECT id, kind, action, actor_id, outcome, details
         FROM occ.audit_events
        WHERE namespace_id = $1
          AND resource_kind = 'agent'
          AND resource_id = $2
          AND kind = 'authorization_denial'
          AND action = $3
          AND ($4::text IS NULL OR actor_id = $4)
          AND ($5::text IS NULL OR id <> $5)
          AND ($6::boolean IS NULL OR (details->'nativeAdmin' ? 'revisionId') = $6)
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`,
        [
          namespaceId,
          agentId,
          action,
          actorId ?? null,
          options.excludeId ?? null,
          options.leaseRenewal ?? null,
        ],
      );
      return result.rows[0];
    },
    { timeoutMs: 5_000, intervalMs: 50 },
  );
  assert.equal(row.kind, "authorization_denial");
  assert.equal(row.outcome, "denied");
  assert.equal(row.details?.__occAuditMetadata?.reasonCode, "AUTHORIZATION_DENIED");
  if (actorId !== undefined) {
    assert.equal(row.actor_id, actorId);
  } else {
    assert.ok(row.actor_id, `${action} denial audit must retain the human actor id`);
  }
  return row;
}

function nativeAdminAuditDetails(row, action) {
  const details = row.details?.nativeAdmin;
  assert.equal(typeof details, "object", `${action} audit must include nativeAdmin details`);
  assert.notEqual(details, null, `${action} audit must include nativeAdmin details`);
  return details;
}

async function assertSocketAuditCloseReason(scenario, closureReason) {
  const rows = await waitForAuditActions(
    scenario.apiA.pool,
    scenario.namespace.id,
    scenario.agent.id,
    [
      "openclaw.agents.native_admin.websocket.connect",
      "openclaw.agents.native_admin.websocket.close",
    ],
  );
  const connect = rows.find(
    (row) => row.action === "openclaw.agents.native_admin.websocket.connect",
  );
  const close = rows.find((row) => row.action === "openclaw.agents.native_admin.websocket.close");
  assert.ok(connect, "native admin WebSocket connect audit row must exist");
  assert.ok(close, "native admin WebSocket close audit row must exist");
  const connectDetails = nativeAdminAuditDetails(connect, connect.action);
  const closeDetails = nativeAdminAuditDetails(close, close.action);
  assert.equal(typeof connectDetails.connectionId, "string");
  assert.ok(connectDetails.connectionId.length > 0);
  assert.equal(closeDetails.connectionId, connectDetails.connectionId);
  assert.equal(closeDetails.closeReason, closureReason);
  for (const details of [connectDetails, closeDetails]) {
    assert.equal(details.mode, scenario.mode);
    assert.equal(details.parentSessionId, scenario.parentSession.id);
    assert.equal(details.revisionId, scenario.revision.id);
    assert.equal(details.host, scenario.native.host);
  }
}

async function parentSessionRow(api, email = adminEmail) {
  const storedSession = await api.pool.query(
    `SELECT session.id, session.user_id, session.expires_at
       FROM occ.session AS session
       JOIN occ."user" AS account ON account.id = session.user_id
      WHERE account.email = $1
      ORDER BY session.created_at DESC
      LIMIT 1`,
    [email],
  );
  assert.equal(storedSession.rowCount, 1, "sign-in must persist a parent session row");
  return storedSession.rows[0];
}

async function openNativeAdminSocketScenario(t, label, options = {}) {
  await ensureBootstrap(t);
  const upstream = await startNativeHttpsUpstream(t);
  trustLocalUpstreamCertificate(t, upstream.cert);
  const [apiA, apiB] = await Promise.all([
    createApi(t, `${label}-a`, upstream.port),
    createApi(t, `${label}-b`, upstream.port, options),
  ]);
  t.after(() => Promise.allSettled([apiA.app.close(), apiB.app.close()]));
  let session = await signIn(apiA.app);
  let parentSession = await parentSessionRow(apiA);
  let { namespace, agent, revision, native, principal } = await createNativeAgent(
    apiA,
    session,
    upstream,
  );
  let operator;
  if (options.mode === "chat") {
    operator = await createAgentPermissionSession(apiA, namespace.id, agent.id, label, ["operate"]);
    session = operator.session;
    principal = operator.principal;
    parentSession = await parentSessionRow(apiA, operator.credentials.email);
  }
  const nativeCookie = session.cookie;
  const port = await listen(apiB.app);
  const socket = await openNativeWebSocket(port, native, nativeCookie);
  t.after(() => socket.destroy());
  assert.equal(upstream.upgrades.length, 1);
  assert.equal(
    upstream.upgrades[0].url,
    `${options.mode === "chat" ? "/native-chat" : ""}/namespaces/${namespace.id}/agents/${agent.id}/session/socket`,
  );
  assert.equal(upstream.upgrades[0].headers.origin, native.origin);
  assert.equal(upstream.upgrades[0].headers["x-api-key"], nativeGatewayApiKey);
  await waitForAuditActions(apiA.pool, namespace.id, agent.id, [
    "openclaw.agents.native_admin.websocket.connect",
  ]);
  return {
    upstream,
    apiA,
    apiB,
    session,
    parentSession,
    namespace,
    agent,
    revision,
    native,
    nativeCookie,
    operator,
    mode: options.mode ?? "admin",
    principal,
    port,
    socket,
  };
}

async function assertRevokedHttp(api, native, nativeCookie) {
  const denied = await nativeGet(api, native, nativeCookie, "/after-revocation");
  assert.notEqual(denied.statusCode, 200);
  return denied;
}

function within(promise, milliseconds, description) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Keep the real PostgreSQL append; only its timing is controlled. Session and
// NativeIAM decisions still come from the composed controller and database.
function holdLeaseDenialAppend(onEntered) {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const pending = [];
  let attempts = 0;
  let released = false;
  return {
    entered: entered.promise,
    attempts: () => attempts,
    released: () => released,
    wrap(sink) {
      return {
        append(event) {
          if (
            event.kind !== "authorization_denial" ||
            event.action !== "openclaw.agents.native_admin.proxy.authorize" ||
            event.details?.nativeAdmin?.revisionId === undefined
          ) {
            return sink.append(event);
          }
          attempts += 1;
          onEntered();
          entered.resolve(event);
          const append = gate.promise.then(() => sink.append(event));
          pending.push(append);
          return append;
        },
      };
    },
    async release() {
      released = true;
      gate.resolve();
      await within(Promise.all(pending), 5_000, "the retained denial append did not settle");
    },
  };
}

test(
  "PostgreSQL native admin shared session and HTTP proxy work across two OCC API replicas",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    await ensureBootstrap(t);
    const upstream = await startNativeHttpsUpstream(t);
    trustLocalUpstreamCertificate(t, upstream.cert);
    const [apiA, apiB] = await Promise.all([
      createApi(t, "a", upstream.port),
      createApi(t, "b", upstream.port),
    ]);
    t.after(() => Promise.allSettled([apiA.app.close(), apiB.app.close()]));
    const session = await signIn(apiA.app);
    const { namespace, agent, revision, native } = await createNativeAgent(apiA, session, upstream);
    assert.equal(native.activeRevisionId, revision.id);
    assert.equal(new URL(native.url).origin, native.origin);
    assert.equal(native.bootstrapUrl, undefined);
    const nativeCookie = session.cookie;
    const proxied = await nativeGet(apiB, native, nativeCookie);
    assert.equal(proxied.statusCode, 200, proxied.body);
    assert.equal(proxied.headers["x-native-upstream"], "reached");
    assert.equal(proxied.headers["set-cookie"], undefined);
    assert.equal(upstream.requests.length, 1);
    assert.equal(
      upstream.requests[0].url,
      `/namespaces/${namespace.id}/agents/${agent.id}/settings/profile?tab=devices`,
    );
    assert.equal(upstream.requests[0].headers.origin, native.origin);
    assert.equal(upstream.requests[0].headers["x-api-key"], nativeGatewayApiKey);
    assert.equal(upstream.requests[0].headers.cookie, undefined);

    const keyOnly = await inject(apiB.app, "GET", "/", {
      headers: {
        host: new URL(native.origin).host,
        origin: native.origin,
        "x-api-key": "occ_not-a-human-session",
      },
    });
    assert.equal(keyOnly.statusCode, 403, keyOnly.body);

    const port = await listen(apiB.app);
    const upgradesBeforeOriginChecks = upstream.upgrades.length;
    await assertNativeWebSocketRejected(port, native, nativeCookie, { origin: undefined });
    await assertNativeWebSocketRejected(port, native, nativeCookie, { origin: "null" });
    await assertNativeWebSocketRejected(port, native, nativeCookie, { origin: publicOrigin });
    assert.equal(upstream.upgrades.length, upgradesBeforeOriginChecks);

    const limited = await createAgentPermissionSession(
      apiA,
      namespace.id,
      agent.id,
      "native-admin-read-only",
    );
    const deniedStatus = await inject(
      apiA.app,
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
      { session: limited.session },
    );
    assert.equal(deniedStatus.statusCode, 403, deniedStatus.body);
    await waitForAuthorizationDenialAudit(
      apiA.pool,
      namespace.id,
      agent.id,
      "openclaw.agents.native_admin.read",
      limited.principal.id,
    );
  },
);

test(
  "PostgreSQL native admin WebSocket lease closes at the next renewal after parent logout",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "logout");
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      const signOut = await inject(scenario.apiA.app, "POST", "/api/auth/sign-out", {
        session: scenario.session,
      });
      assert.equal(signOut.statusCode, 200, signOut.body);
    });
    t.diagnostic(`parent logout closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "session_invalid");
    await assertRevokedHttp(scenario.apiB, scenario.native, scenario.nativeCookie);
  },
);

test(
  "PostgreSQL native admin WebSocket lease closes at the next renewal after parent session expiry",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "expiry");
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      const expired = await scenario.apiA.pool.query(
        `UPDATE occ.session
            SET expires_at = statement_timestamp() - interval '1 second',
                updated_at = statement_timestamp()
          WHERE id = $1`,
        [scenario.parentSession.id],
      );
      assert.equal(expired.rowCount, 1);
    });
    t.diagnostic(`parent session expiry closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "session_invalid");
    await assertRevokedHttp(scenario.apiB, scenario.native, scenario.nativeCookie);
  },
);

test(
  "PostgreSQL native admin WebSocket lease closes at the next renewal after both browser permissions are restricted",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const startedAt = performance.now();
    const phases = [];
    const mark = (phase) =>
      phases.push({ phase, elapsedMs: Math.round(performance.now() - startedAt) });
    const audit = holdLeaseDenialAppend(() => mark("denial_append_pending"));
    t.after(() => audit.release());
    const scenario = await openNativeAdminSocketScenario(t, "iam-restriction", {
      auditSink: audit.wrap,
    });
    const peer = scenario.upstream.peers[0];
    assert.ok(peer, "the real HTTPS upstream must own the admitted relay");
    // Closed-stream write callbacks below are the oracle for their expected errors.
    scenario.socket.on("error", () => {});
    peer.on("error", () => {});
    let clientBytes = "";
    let peerBytes = "";
    scenario.socket.on("data", (chunk) => {
      clientBytes += chunk.toString();
    });
    peer.on("data", (chunk) => {
      peerBytes += chunk.toString();
    });
    const clientClosed = new Promise((resolve) => scenario.socket.once("close", resolve));
    const peerClosed = new Promise((resolve) => peer.once("close", resolve));
    const leaseDenialCount = async () => {
      const result = await scenario.apiA.pool.query(
        `SELECT count(*)::int AS count FROM occ.audit_events
          WHERE namespace_id = $1 AND resource_id = $2
            AND kind = 'authorization_denial'
            AND action = 'openclaw.agents.native_admin.proxy.authorize'
            AND details->'nativeAdmin'->>'revisionId' = $3`,
        [scenario.namespace.id, scenario.agent.id, scenario.revision.id],
      );
      return result.rows[0].count;
    };
    try {
      scenario.socket.write("allowed-client-message");
      peer.write("allowed-upstream-message");
      await waitFor(
        "allowed application bytes across both relay directions",
        () =>
          clientBytes.includes("allowed-upstream-message") &&
          peerBytes.includes("allowed-client-message"),
        2_000,
      );
      mark("allowed_bidirectional_relay");
      assert.equal(await leaseDenialCount(), 0);
      const closure = within(
        Promise.all([clientClosed, peerClosed]),
        3_500,
        "both relay ends must close before the five-second fallback and audit release",
      );
      // Attach a rejection observer while the actual database restriction commits.
      void closure.catch(() => {});
      const restricted = await scenario.apiA.pool.query(
        `INSERT INTO occ.iam_restrictions
           (id, namespace_id, action, resource_kind, resource_id, effect)
         VALUES ($1, $2, 'administer', 'agent', $3, 'deny'),
                ($1 || '-operate', $2, 'operate', 'agent', $3, 'deny')`,
        [`restriction-native-admin-${randomUUID()}`, scenario.namespace.id, scenario.agent.id],
      );
      assert.equal(restricted.rowCount, 2);
      mark("restriction_commit_acknowledged");
      await within(audit.entered, 3_000, "the real denied renewal must reach its audit append");
      await closure;
      mark("both_transport_ends_closed");
      assert.equal(audit.released(), false);
      assert.equal(audit.attempts(), 1);
      assert.equal(await leaseDenialCount(), 0, "denial persistence must still be pending");
      await assertSocketAuditCloseReason(scenario, "authorization_denied");
      assert.equal(scenario.socket.destroyed, true);
      assert.equal(peer.destroyed, true);

      const before = { clientBytes, peerBytes };
      // Check actual writes after close, without a sleep or teardown closing the sockets.
      for (const socket of [scenario.socket, peer]) {
        const error = await within(
          new Promise((resolve) => socket.write("after-revocation-message", resolve)),
          1_000,
          "a post-revocation write must complete with failure",
        );
        assert.ok(error, "a closed relay must refuse later application bytes");
      }
      assert.deepEqual({ clientBytes, peerBytes }, before);
      mark("later_application_bytes_refused");
      assert.equal(audit.released(), false);
      mark("audit_gate_released");
      await audit.release();

      // The lease denial names its revision; the later HTTP denial does not.
      const leaseDenial = await waitForAuthorizationDenialAudit(
        scenario.apiA.pool,
        scenario.namespace.id,
        scenario.agent.id,
        "openclaw.agents.native_admin.proxy.authorize",
        scenario.principal.id,
        { leaseRenewal: true },
      );
      assert.equal(leaseDenial.details.nativeAdmin.revisionId, scenario.revision.id);
      assert.equal(await leaseDenialCount(), 1);
      mark("attributable_lease_denial_persisted_once");
      await assertRevokedHttp(scenario.apiB, scenario.native, scenario.nativeCookie);
      await waitForAuthorizationDenialAudit(
        scenario.apiA.pool,
        scenario.namespace.id,
        scenario.agent.id,
        "openclaw.agents.native_admin.proxy.authorize",
        scenario.principal.id,
        { excludeId: leaseDenial.id, leaseRenewal: false },
      );
      assert.equal(await leaseDenialCount(), 1);
      assert.equal(audit.attempts(), 1);
    } finally {
      t.diagnostic(`Composed native-admin revocation phases: ${JSON.stringify(phases)}`);
      try {
        await audit.release();
      } finally {
        scenario.socket.destroy();
        peer.destroy();
        const closed = await Promise.allSettled([
          scenario.apiA.app.close(),
          scenario.apiB.app.close(),
        ]);
        for (const result of closed) {
          assert.equal(result.status, "fulfilled", "both owned API replicas must close");
        }
      }
    }
  },
);

for (const { dependency, owner, method } of [
  { dependency: "an IAM", owner: "iamDriver", method: "authorize" },
  { dependency: "an identity lookup", owner: "iamDriver", method: "lookupIdentity" },
  { dependency: "a State", owner: "state", method: "read" },
]) {
  test(
    `PostgreSQL native admin WebSocket lease closes as a dependency failure during ${dependency} outage`,
    { ...requiresPostgres, timeout: 30_000 },
    async (t) => {
      const scenario = await openNativeAdminSocketScenario(t, "iam-outage");
      // The replica holding the socket loses a dependency at the next lease renewal. An outage
      // is not a revocation: the close names a dependency failure and writes no denial audit.
      const target = scenario.apiB[owner];
      const original = target[method];
      t.after(() => {
        target[method] = original;
      });
      const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
        target[method] = async () => {
          throw new Error(`${dependency} outage`);
        };
      });
      t.diagnostic(`${dependency} outage closed native admin WebSocket in ${closedAfterMs}ms`);
      await assertSocketAuditCloseReason(scenario, "dependency_failure");
      const denials = await scenario.apiA.pool.query(
        `SELECT count(*)::int AS count FROM occ.audit_events
        WHERE namespace_id = $1 AND resource_id = $2 AND kind = 'authorization_denial'`,
        [scenario.namespace.id, scenario.agent.id],
      );
      assert.equal(denials.rows[0].count, 0);
    },
  );
}

test(
  "PostgreSQL native admin WebSocket lease closes at the next renewal after Agent stop",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "stop");
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      const stopped = await inject(
        scenario.apiA.app,
        "POST",
        `/namespaces/${scenario.namespace.id}/agents/${scenario.agent.id}/stop`,
        { session: scenario.session },
      );
      assert.equal(stopped.statusCode, 202, stopped.body);
    });
    t.diagnostic(`Agent stop closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "agent_unavailable");
    await assertRevokedHttp(scenario.apiB, scenario.native, scenario.nativeCookie);
  },
);

test(
  "PostgreSQL native admin WebSocket lease closes at the next renewal after active revision replacement",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "revision");
    let nextRevision;
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      nextRevision = await scenario.apiA.controller.deployAgent(
        scenario.principal.id,
        { namespaceId: scenario.namespace.id, agentId: scenario.agent.id },
        resolveApprovedHarness,
      );
      assert.notEqual(nextRevision.id, scenario.revision.id);
      await scenario.apiA.state.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(
          scenario.namespace.id,
          scenario.agent.id,
          scenario.revision.id,
          nextRevision.id,
        ),
      );
    });
    t.diagnostic(`active revision replacement closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "revision_changed");
    assert.ok(nextRevision, "revision replacement must create a successor revision");

    const reconnectedHttp = await nativeGet(
      scenario.apiB,
      scenario.native,
      scenario.nativeCookie,
      "/after-revision",
    );
    assert.equal(reconnectedHttp.statusCode, 200, reconnectedHttp.body);
    const reopened = await openNativeWebSocket(
      scenario.port,
      scenario.native,
      scenario.nativeCookie,
      "/session/reconnected",
    );
    t.after(() => reopened.destroy());
    const latestConnect = await waitFor(
      "reconnected WebSocket audit on replacement revision",
      async () => {
        const result = await scenario.apiA.pool.query(
          `SELECT details
           FROM occ.audit_events
          WHERE namespace_id = $1
            AND resource_kind = 'agent'
            AND resource_id = $2
            AND action = 'openclaw.agents.native_admin.websocket.connect'
            AND details->'nativeAdmin'->>'revisionId' = $3
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1`,
          [scenario.namespace.id, scenario.agent.id, nextRevision.id],
        );
        return result.rows[0];
      },
      5_000,
    );
    assert.equal(
      latestConnect.details.nativeAdmin.revisionId,
      nextRevision.id,
      "shared session reconnect must bind the current active revision",
    );
  },
);

test(
  "PostgreSQL native admin WebSocket closes on API shutdown and disabled redeploy denies reuse",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "shutdown-disabled");
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      await scenario.apiB.app.close();
    });
    t.diagnostic(`API shutdown closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "shutdown");

    const disabledApi = await createApi(t, "shutdown-disabled-off", scenario.upstream.port, {
      nativeAdminEnabled: false,
    });
    t.after(() => disabledApi.app.close());
    const denied = await nativeGet(disabledApi, scenario.native, scenario.nativeCookie);
    assert.equal(denied.statusCode, 403, denied.body);
  },
);

// These cases exercise real PostgreSQL sessions, IAM and OCC relay admission. The HTTPS
// peer is a transport fixture; native method/scope enforcement has separate runtime proof.
for (const change of ["operate-revoked", "account-disabled"]) {
  test(
    `PostgreSQL chat socket closes when ${change}`,
    { ...requiresPostgres, timeout: 30_000 },
    async (t) => {
      const scenario = await openNativeAdminSocketScenario(t, change, { mode: "chat" });
      await assertSocketClosesAfterMutation(scenario.socket, async () => {
        if (change === "operate-revoked") {
          await scenario.apiA.pool.query(`DELETE FROM occ.iam_access_bindings WHERE role_id = $1`, [
            scenario.operator.roleId,
          ]);
        } else {
          const changed = await scenario.apiA.pool.query(
            `UPDATE occ.human_authentication_accounts SET disabled = true, version = version + 1 WHERE user_id = $1`,
            [scenario.operator.account.id],
          );
          assert.equal(changed.rowCount, 1, "the guarded account must exist before disabling it");
        }
      });
      await assertSocketAuditCloseReason(
        scenario,
        change === "operate-revoked" ? "authorization_denied" : "session_invalid",
      );
      await assertRevokedHttp(scenario.apiB, scenario.native, scenario.nativeCookie);
    },
  );
}

test(
  "PostgreSQL admin downgrade closes the old socket and reconnects only through chat",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "admin-downgrade");
    await assertSocketClosesAfterMutation(scenario.socket, () =>
      scenario.apiA.pool.query(
        `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect)
     VALUES ($1, $2, 'administer', 'agent', $3, 'deny')`,
        [`restriction-${randomUUID()}`, scenario.namespace.id, scenario.agent.id],
      ),
    );
    await assertSocketAuditCloseReason(scenario, "authorization_denied");
    const socket = await openNativeWebSocket(scenario.port, scenario.native, scenario.nativeCookie);
    t.after(() => socket.destroy());
    assert.equal(
      scenario.upstream.upgrades.at(-1).url,
      `/native-chat/namespaces/${scenario.namespace.id}/agents/${scenario.agent.id}/session/socket`,
    );
  },
);

test(
  "PostgreSQL reconnect uses the new cookie while the original chat socket keeps its session",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "cookie-change", { mode: "chat" });
    const next = await createAgentPermissionSession(
      scenario.apiA,
      scenario.namespace.id,
      scenario.agent.id,
      "new-browser-account",
      ["operate"],
    );
    const socket = await openNativeWebSocket(scenario.port, scenario.native, next.session.cookie);
    t.after(() => socket.destroy());
    // Deleting the original session closes only its socket, even after another account connects.
    await assertSocketClosesAfterMutation(scenario.socket, () =>
      scenario.apiA.pool.query(`DELETE FROM occ.session WHERE id = $1`, [
        scenario.parentSession.id,
      ]),
    );
    await assertSocketAuditCloseReason(scenario, "session_invalid");
    assert.equal(socket.destroyed, false);
  },
);

test(
  "PostgreSQL native browser launch and Agent creation share a consistent authority lock order",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    await ensureBootstrap(t);
    const upstream = await startNativeHttpsUpstream(t);
    const api = await createApi(t, "launch-lock-order", upstream.port, { exchange: true });
    t.after(() => api.app.close());
    const session = await signIn(api.app);
    const { namespace, agent } = await createNativeAgent(api, session, upstream);
    const parent = await parentSessionRow(api);
    const observer = new pg.Pool({ connectionString: process.env.OCC_TEST_DATABASE_URL, max: 2 });
    t.after(() => observer.end());
    const holder = await observer.connect();
    let creating;
    let launching;
    try {
      await holder.query("BEGIN");
      const lock = await holder.query(
        "SELECT pg_backend_pid() AS pid FROM occ.session WHERE id = $1 FOR UPDATE",
        [parent.id],
      );
      assert.equal(lock.rowCount, 1);
      // The API write holds user SHARE before its session fence. Delay that fence
      // so the real launch can reach the same user's conflicting authority lock.
      creating = inject(api.app, "POST", `/namespaces/${namespace.id}/agents`, {
        session,
        body: {
          name: `Concurrent native launch ${randomUUID()}`,
          configurationId: agent.configurationId,
          harnessAuth: agent.harnessAuth,
          gatewayManagedMode: false,
        },
      }).then((response) => response);
      const creatorPid = await waitForLockWaiter(
        observer,
        lock.rows[0].pid,
        "Agent creation waiting on the parent session fence",
        { queryLike: "%UPDATE occ.session%", timeoutMs: 5_000 },
      );
      launching = inject(
        api.app,
        "POST",
        `/namespaces/${namespace.id}/agents/${agent.id}/native-admin/launch`,
        { session, body: {}, headers: { "x-occ-session-key": session.sessionKey } },
      ).then((response) => response);
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
        10_000,
        "concurrent Agent creation and native launch did not settle",
      );
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(launched.statusCode, 200, launched.body);
      const retained = await observer.query(
        `SELECT
          (SELECT count(*)::int FROM occ.agents WHERE namespace_id = $1 AND id = $2) AS agents,
          (SELECT count(*)::int FROM occ.native_browser_intents
            WHERE id = $3 AND agent_id = $4 AND parent_session_id = $5) AS intents,
          (SELECT count(*)::int FROM occ.audit_events WHERE resource_id = $4
            AND action = 'authentication.native.launch' AND outcome = 'success') AS audits`,
        [namespace.id, created.json().data.id, launched.json().data.intentId, agent.id, parent.id],
      );
      assert.deepEqual(retained.rows[0], { agents: 1, intents: 1, audits: 1 });
      assert.equal(upstream.requests.length, 0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled([creating, launching]);
    }
  },
);

test(
  "PostgreSQL native browser launch rechecks parent expiry after waiting for the Namespace",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    await ensureBootstrap(t);
    const upstream = await startNativeHttpsUpstream(t);
    const api = await createApi(t, "launch-expiry-wait", upstream.port, { exchange: true });
    t.after(() => api.app.close());
    const session = await signIn(api.app);
    const { namespace, agent } = await createNativeAgent(api, session, upstream);
    const parent = await parentSessionRow(api);
    const observer = new pg.Pool({ connectionString: process.env.OCC_TEST_DATABASE_URL, max: 2 });
    t.after(() => observer.end());
    const holder = await observer.connect();
    let launching;
    try {
      await holder.query("BEGIN");
      const lock = await holder.query(
        "SELECT pg_backend_pid() AS pid FROM occ.namespaces WHERE id = $1 FOR UPDATE",
        [namespace.id],
      );
      assert.equal(lock.rowCount, 1);
      await observer.query(
        "UPDATE occ.session SET expires_at = clock_timestamp() + interval '5 seconds' WHERE id = $1",
        [parent.id],
      );
      launching = inject(
        api.app,
        "POST",
        `/namespaces/${namespace.id}/agents/${agent.id}/native-admin/launch`,
        { session, body: {}, headers: { "x-occ-session-key": session.sessionKey } },
      ).then((response) => response);
      // The parent was current when launch took its authority locks. Real elapsed
      // database time can expire it while the resource lock is still unavailable.
      await waitForLockWaiter(observer, lock.rows[0].pid, "native launch waiting on Namespace", {
        queryLike: "%FROM occ.namespaces%FOR SHARE%",
        timeoutMs: 5_000,
      });
      await waitUntil(
        "the held parent session to expire on the database clock",
        async () =>
          (
            await observer.query(
              "SELECT expires_at <= clock_timestamp() AS expired FROM occ.session WHERE id = $1",
              [parent.id],
            )
          ).rows[0].expired,
        { timeoutMs: 10_000, intervalMs: 25 },
      );
      await holder.query("COMMIT");
      const response = await within(launching, 5_000, "expired native launch did not settle");
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.json().data, undefined, "expired launch must not return a landing URL");
      const retained = await observer.query(
        `SELECT
          (SELECT count(*)::int FROM occ.native_browser_intents WHERE agent_id = $1) AS intents,
          (SELECT count(*)::int FROM occ.audit_events WHERE resource_id = $1
            AND action = 'authentication.native.launch' AND outcome = 'success') AS audits`,
        [agent.id],
      );
      assert.deepEqual(retained.rows[0], { intents: 0, audits: 0 });
      assert.equal(upstream.requests.length, 0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled([launching]);
    }
  },
);

test(
  "PostgreSQL native browser shutdown drains an in-flight launch without returning access",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    await ensureBootstrap(t);
    const upstream = await startNativeHttpsUpstream(t);
    const api = await createApi(t, "launch-shutdown", upstream.port, { exchange: true });
    t.after(() => api.app.close());
    const session = await signIn(api.app);
    const { namespace, agent } = await createNativeAgent(api, session, upstream);
    const observer = new pg.Pool({ connectionString: process.env.OCC_TEST_DATABASE_URL, max: 2 });
    t.after(() => observer.end());
    const holder = await observer.connect();
    let pending;
    let closing;
    try {
      await holder.query("BEGIN");
      // Hold the store's real serialization lock. Authorization still runs through
      // the composed API; only the PostgreSQL launch transaction is delayed.
      const lock = await holder.query(
        "SELECT pg_backend_pid() AS pid, pg_advisory_xact_lock(1868785007, hashtext($1))",
        [api.controller.installation.id],
      );
      pending = api.app
        .inject({
          method: "POST",
          url: `/namespaces/${namespace.id}/agents/${agent.id}/native-admin/launch`,
          headers: {
            origin: publicOrigin,
            cookie: session.cookie,
            "x-occ-session-key": session.sessionKey,
          },
          payload: {},
        })
        .then((response) => response);
      await waitForLockWaiter(observer, lock.rows[0].pid, "the native launch transaction", {
        queryLike: "%pg_advisory_xact_lock%",
        timeoutMs: 5_000,
      });
      closing = api.app.close();
      // Allow Fastify's preClose hooks to begin before releasing the database.
      // The 503 and committed audit below, rather than elapsed time, are the oracle.
      await setImmediate();
      await holder.query("COMMIT");
      const response = await within(pending, 5_000, "the launch did not settle during shutdown");
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().data, undefined, "shutdown must not return a landing URL");
      await within(closing, 5_000, "API shutdown did not drain the launch transaction");

      // Work already admitted can commit, but its intent and attributable audit must
      // settle before the API pool closes; it must never mint an Agent access handle.
      const retained = await observer.query(
        `SELECT
          (SELECT count(*)::int FROM occ.native_browser_intents WHERE agent_id = $1) AS intents,
          (SELECT count(*)::int FROM occ.audit_events WHERE resource_id = $1
            AND action = 'authentication.native.launch' AND outcome = 'success') AS audits,
          (SELECT count(*)::int FROM occ.native_browser_handles WHERE agent_id = $1) AS handles`,
        [agent.id],
      );
      assert.deepEqual(retained.rows[0], { intents: 1, audits: 1, handles: 0 });
      assert.equal(upstream.requests.length, 0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled([pending, closing]);
    }
  },
);

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
    const target = await createNativeAgent(api, parent, upstream);
    const other = await createNativeAgent(api, parent, upstream);
    const port = await listen(api.app);
    const cookie = await launchNativeBrowserSession(api, parent, target);
    const socket = await openNativeWebSocket(port, target.native, cookie);
    t.after(() => socket.destroy());

    // Reopening the same Agent must leave a previously admitted tab connected.
    // Carry the actual cookie returned by the first exchange through redemption.
    const reopened = await launchNativeBrowserSession(api, parent, target, cookie);

    let received = "";
    socket.on("data", (chunk) => {
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

      upstream.peers[0].write("still-connected-after-relaunch");
      await waitFor(
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
    const revisedCookie = await launchNativeBrowserSession(api, parent, target, cookie);
    assert.notEqual(revisedCookie, cookie, "a new revision cannot reuse the previous handle");
    const revisedSocket = await openNativeWebSocket(port, target.native, revisedCookie);
    t.after(() => revisedSocket.destroy());

    // A new parent session for the same account must not inherit the old handle.
    const newParent = await signIn(api.app);
    assert.notEqual(newParent.sessionKey, parent.sessionKey);
    let newCookie;
    await assertSocketClosesAfterMutation(revisedSocket, async () => {
      newCookie = await launchNativeBrowserSession(api, newParent, target, revisedCookie);
      assert.notEqual(newCookie, revisedCookie);
    });
    const newSocket = await openNativeWebSocket(port, target.native, newCookie);
    t.after(() => newSocket.destroy());
    await assertSocketClosesAfterMutation(newSocket, async () => {
      const signedOut = await inject(api.app, "POST", "/api/auth/sign-out", { session: newParent });
      assert.equal(signedOut.statusCode, 200, signedOut.body);
    });
    assert.equal((await nativeGet(api, target.native, newCookie)).statusCode, 403);
    assert.ok(upstream.upgrades.every((upgrade) => upgrade.headers.cookie === undefined));
  },
);
