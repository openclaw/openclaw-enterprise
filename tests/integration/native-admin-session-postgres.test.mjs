import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { injectJson as inject } from "../helpers/inject-json.ts";
import {
  publicOrigin,
  nativeGatewayApiKey,
  requiresPostgres,
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
import {
  assertSocketAuditCloseReason,
  parentSessionRow,
  registerLeaseDependencyCases,
  registerLeaseIndependentCookieCase,
  registerLeaseParentAndRestrictionCases,
  registerLeaseReplacementAndRevocationCases,
  registerLeaseStopCase,
  waitForAuditActions,
  waitForAuthorizationDenialAudit,
} from "./native-admin-session-lease-cases.ts";

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
    `/native-browser/namespaces/${namespace.id}/agents/${agent.id}/session/socket`,
  );
  assert.equal(upstream.upgrades[0].headers.origin, native.origin);
  assert.equal(upstream.upgrades[0].headers["x-api-key"], nativeGatewayApiKey);
  assert.equal(
    upstream.upgrades[0].headers["x-openclaw-scopes"],
    options.mode === "chat" ? "operator.sessions.write" : "operator.admin",
  );
  assert.equal(upstream.upgrades[0].headers["x-occ-browser-key"], "server-browser-credential");
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
      `/native-browser/namespaces/${namespace.id}/agents/${agent.id}/settings/profile?tab=devices`,
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

/** @satisfies {import("./native-admin-session-lease-cases.ts").LeaseDependencies} */
const leaseDependencies = { openNativeAdminSocketScenario };

registerLeaseParentAndRestrictionCases(leaseDependencies);
registerLeaseDependencyCases(leaseDependencies);
registerLeaseStopCase(leaseDependencies);

registerLeaseReplacementAndRevocationCases(leaseDependencies);

test(
  "PostgreSQL admin downgrade closes the old socket and reconnects only through chat",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "admin-downgrade");
    const nativeSubject = scenario.upstream.upgrades[0].headers["x-occ-identity"];
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
      `/native-browser/namespaces/${scenario.namespace.id}/agents/${scenario.agent.id}/session/socket`,
    );
    const reconnected = scenario.upstream.upgrades.at(-1);
    assert.equal(reconnected.headers["x-openclaw-scopes"], "operator.sessions.write");
    assert.equal(
      reconnected.headers["x-occ-identity"],
      nativeSubject,
      "downgrade changes authority, not the native identity",
    );
  },
);

registerLeaseIndependentCookieCase(leaseDependencies);
