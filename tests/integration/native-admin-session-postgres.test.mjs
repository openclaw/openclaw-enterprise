import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
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
  createReadOperateSession,
  listen,
  openNativeWebSocket,
  assertNativeWebSocketRejected,
  assertSocketClosesAfterMutation,
} from "../helpers/native-admin-postgres.ts";

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
    assert.equal(details.parentSessionId, scenario.parentSession.id);
    assert.equal(details.revisionId, scenario.revision.id);
    assert.equal(details.host, scenario.native.host);
  }
}

async function parentSessionRow(api) {
  const storedSession = await api.pool.query(
    `SELECT session.id, session.user_id, session.expires_at
       FROM occ.session AS session
       JOIN occ."user" AS account ON account.id = session.user_id
      WHERE account.email = $1
      ORDER BY session.created_at DESC
      LIMIT 1`,
    [adminEmail],
  );
  assert.equal(storedSession.rowCount, 1, "sign-in must persist a parent session row");
  return storedSession.rows[0];
}

async function openNativeAdminSocketScenario(t, label) {
  await ensureBootstrap(t);
  const upstream = await startNativeHttpsUpstream(t);
  trustLocalUpstreamCertificate(t, upstream.cert);
  const [apiA, apiB] = await Promise.all([
    createApi(t, `${label}-a`, upstream.port),
    createApi(t, `${label}-b`, upstream.port),
  ]);
  t.after(() => Promise.allSettled([apiA.app.close(), apiB.app.close()]));
  const session = await signIn(apiA.app);
  const parentSession = await parentSessionRow(apiA);
  const { namespace, agent, revision, native, principal } = await createNativeAgent(
    apiA,
    session,
    upstream,
  );
  const nativeCookie = session.cookie;
  const port = await listen(apiB.app);
  const socket = await openNativeWebSocket(port, native, nativeCookie);
  t.after(() => socket.destroy());
  assert.equal(upstream.upgrades.length, 1);
  assert.equal(
    upstream.upgrades[0].url,
    `/namespaces/${namespace.id}/agents/${agent.id}/session/socket`,
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

    const limited = await createReadOperateSession(
      apiA,
      namespace.id,
      agent.id,
      "native-admin-read-operate",
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
  "PostgreSQL native admin WebSocket lease closes at the next renewal after IAM administer restriction",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "iam-restriction");
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      const restricted = await scenario.apiA.pool.query(
        `INSERT INTO occ.iam_restrictions
           (id, namespace_id, action, resource_kind, resource_id, effect)
         VALUES ($1, $2, 'administer', 'agent', $3, 'deny')`,
        [`restriction-native-admin-${randomUUID()}`, scenario.namespace.id, scenario.agent.id],
      );
      assert.equal(restricted.rowCount, 1);
    });
    t.diagnostic(`IAM administer restriction closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "authorization_denied");
    // Lease renewals check the socket's revision, so their denials record it; the HTTP
    // denial carries none. That keeps a second, overlapping renewal's denial from passing
    // for the HTTP one.
    const leaseDenial = await waitForAuthorizationDenialAudit(
      scenario.apiA.pool,
      scenario.namespace.id,
      scenario.agent.id,
      "openclaw.agents.native_admin.proxy.authorize",
      scenario.principal.id,
      { leaseRenewal: true },
    );
    assert.equal(leaseDenial.details.nativeAdmin.revisionId, scenario.revision.id);
    await assertRevokedHttp(scenario.apiB, scenario.native, scenario.nativeCookie);
    await waitForAuthorizationDenialAudit(
      scenario.apiA.pool,
      scenario.namespace.id,
      scenario.agent.id,
      "openclaw.agents.native_admin.proxy.authorize",
      scenario.principal.id,
      { excludeId: leaseDenial.id, leaseRenewal: false },
    );
  },
);

test(
  "PostgreSQL native admin WebSocket lease closes as a dependency failure during an IAM outage",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "iam-outage");
    // The replica holding the socket loses its IAM Driver at the next lease renewal. An outage
    // is not a revocation: the close names a dependency failure and writes no denial audit.
    const authorize = scenario.apiB.iamDriver.authorize;
    t.after(() => {
      scenario.apiB.iamDriver.authorize = authorize;
    });
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      scenario.apiB.iamDriver.authorize = async () => {
        throw new Error("IAM outage");
      };
    });
    t.diagnostic(`IAM outage closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "dependency_failure");
    const denials = await scenario.apiA.pool.query(
      `SELECT count(*)::int AS count FROM occ.audit_events
        WHERE namespace_id = $1 AND resource_id = $2 AND kind = 'authorization_denial'`,
      [scenario.namespace.id, scenario.agent.id],
    );
    assert.equal(denials.rows[0].count, 0);
  },
);

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
