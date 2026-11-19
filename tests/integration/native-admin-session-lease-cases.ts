import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";

import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import type { NativeAdminWebSocketCloseReason } from "../../apps/controller/src/gateway/native-admin-proxy.ts";
import {
  adminEmail,
  assertSocketClosesAfterMutation,
  createAgentPermissionSession,
  createApi,
  nativeGet,
  openNativeWebSocket,
  requiresPostgres,
  type signIn,
  type startNativeHttpsUpstream,
} from "../helpers/native-admin-postgres.ts";
import { injectJson as inject } from "../helpers/inject-json.ts";
import { waitFor, waitUntil } from "../helpers/wait-for.ts";

type NativeApi = Awaited<ReturnType<typeof createApi>>;
type NativeSocket = Awaited<ReturnType<typeof openNativeWebSocket>>;
type Mode = "admin" | "chat";
type NativeApiOptions = NonNullable<Parameters<typeof createApi>[3]>;
type AuditSinkWrapper = NonNullable<NativeApiOptions["auditSink"]>;
type AuditSink = Parameters<AuditSinkWrapper>[0];
type AuditEvent = Parameters<AuditSink["append"]>[0];
type NativePool = NativeApi["pool"];

interface LeaseScenario {
  apiA: NativeApi;
  apiB: NativeApi;
  upstream: Awaited<ReturnType<typeof startNativeHttpsUpstream>>;
  namespace: unknown;
  agent: { id: string };
  revision: { id: string };
  principal: { id: string };
  native: unknown;
  nativeCookie: string;
  session: Awaited<ReturnType<typeof signIn>>;
  mode: Mode;
  parentSession: unknown;
  operator: { roleId: string; account: unknown } | undefined;
  port: number;
  socket: NativeSocket;
}

export interface LeaseDependencies<Scenario extends LeaseScenario = LeaseScenario> {
  openNativeAdminSocketScenario(
    t: TestContext,
    label: string,
    options?: NativeApiOptions & { mode?: Mode },
  ): Promise<Scenario>;
}

const leaseCaseOptions = { ...requiresPostgres, timeout: 30_000 };

function fixtureId(value: unknown, label: string): string {
  assert.ok(
    value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      value.id.length > 0,
    `fixture must provide ${label} ID`,
  );
  return value.id;
}

function nativeTarget(value: unknown) {
  assert.ok(
    value &&
      typeof value === "object" &&
      "origin" in value &&
      typeof value.origin === "string" &&
      value.origin.length > 0,
    "native admin response must include the Agent origin",
  );
  return { origin: value.origin };
}

function replaceDuringCase<T, K extends keyof T>(
  t: TestContext,
  owner: T,
  method: K,
  replacement: NoInfer<T[K]>,
) {
  const original = owner[method];
  t.after(() => {
    owner[method] = original;
  });
  owner[method] = replacement;
}

interface AuditActionRow {
  action: string;
  actor_id: string | null;
  outcome: string;
  details: unknown;
}

interface AuthorizationDenialRow extends AuditActionRow {
  id: string;
  kind: string;
}

interface ParentSessionRow {
  id: string;
  user_id: string;
  expires_at: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function waitForAuditActions(
  pool: NativePool,
  namespaceId: string,
  agentId: string,
  actions: readonly string[],
): Promise<AuditActionRow[]> {
  let remaining = actions;
  let rows: AuditActionRow[] = [];
  await waitUntil(
    () => `audit actions ${remaining.join(", ")}`,
    async () => {
      const result = await pool.query<AuditActionRow>(
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

export async function waitForAuthorizationDenialAudit(
  pool: NativePool,
  namespaceId: string,
  agentId: string,
  action: string,
  actorId?: string,
  options: { excludeId?: string; leaseRenewal?: boolean } = {},
): Promise<AuthorizationDenialRow> {
  const row = await waitFor(
    `${action} authorization-denial audit row`,
    async () => {
      const result = await pool.query<AuthorizationDenialRow>(
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
  const metadata = isRecord(row.details) ? row.details.__occAuditMetadata : undefined;
  assert.equal(isRecord(metadata) ? metadata.reasonCode : undefined, "AUTHORIZATION_DENIED");
  if (actorId !== undefined) {
    assert.equal(row.actor_id, actorId);
  } else {
    assert.ok(row.actor_id, `${action} denial audit must retain the human actor id`);
  }
  return row;
}

function nativeAdminAuditDetails(row: AuditActionRow, action: string): Record<string, unknown> {
  const details = isRecord(row.details) ? row.details.nativeAdmin : undefined;
  assert.equal(typeof details, "object", `${action} audit must include nativeAdmin details`);
  assert.notEqual(details, null, `${action} audit must include nativeAdmin details`);
  assert.ok(isRecord(details), `${action} nativeAdmin audit details must be an object`);
  return details;
}

export async function assertSocketAuditCloseReason(
  scenario: LeaseScenario,
  closureReason: NativeAdminWebSocketCloseReason,
): Promise<void> {
  const namespaceId = fixtureId(scenario.namespace, "Namespace");
  const parentSessionId = fixtureId(scenario.parentSession, "parent session");
  assert.ok(isRecord(scenario.native), "native admin response must be an object");
  const rows = await waitForAuditActions(scenario.apiA.pool, namespaceId, scenario.agent.id, [
    "openclaw.agents.native_admin.websocket.connect",
    "openclaw.agents.native_admin.websocket.close",
  ]);
  const connect = rows.find(
    (row) => row.action === "openclaw.agents.native_admin.websocket.connect",
  );
  const close = rows.find((row) => row.action === "openclaw.agents.native_admin.websocket.close");
  assert.ok(connect, "native admin WebSocket connect audit row must exist");
  assert.ok(close, "native admin WebSocket close audit row must exist");
  const connectDetails = nativeAdminAuditDetails(connect, connect.action);
  const closeDetails = nativeAdminAuditDetails(close, close.action);
  assert.equal(typeof connectDetails.connectionId, "string");
  assert.ok(
    typeof connectDetails.connectionId === "string" && connectDetails.connectionId.length > 0,
  );
  assert.equal(closeDetails.connectionId, connectDetails.connectionId);
  assert.equal(closeDetails.closeReason, closureReason);
  for (const details of [connectDetails, closeDetails]) {
    assert.equal(details.mode, scenario.mode);
    assert.equal(details.parentSessionId, parentSessionId);
    assert.equal(details.revisionId, scenario.revision.id);
    assert.equal(details.host, scenario.native.host);
  }
}

export async function parentSessionRow(
  api: NativeApi,
  email = adminEmail,
): Promise<ParentSessionRow> {
  const storedSession = await api.pool.query<ParentSessionRow>(
    `SELECT session.id, session.user_id, session.expires_at
       FROM occ.session AS session
       JOIN occ."user" AS account ON account.id = session.user_id
      WHERE account.email = $1
      ORDER BY session.created_at DESC
      LIMIT 1`,
    [email],
  );
  assert.equal(storedSession.rowCount, 1, "sign-in must persist a parent session row");
  const [session] = storedSession.rows;
  assert.ok(session, "sign-in must return its persisted parent session row");
  return session;
}

async function assertRevokedHttp(scenario: LeaseScenario): Promise<void> {
  const denied = await nativeGet(
    scenario.apiB,
    nativeTarget(scenario.native),
    scenario.nativeCookie,
    "/after-revocation",
  );
  assert.notEqual(denied.statusCode, 200);
}

function within<T>(promise: Promise<T>, milliseconds: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Keep the real PostgreSQL append; only its timing is controlled. Session and
// NativeIAM decisions still come from the composed controller and database.
function holdLeaseDenialAppend(onEntered: () => void) {
  const entered = Promise.withResolvers<AuditEvent>();
  const gate = Promise.withResolvers<void>();
  const pending: Promise<void>[] = [];
  let attempts = 0;
  let released = false;
  return {
    entered: entered.promise,
    attempts: () => attempts,
    released: () => released,
    wrap(sink: AuditSink): AuditSink {
      return {
        append(event) {
          const nativeAdmin = event.details?.nativeAdmin;
          if (
            event.kind !== "authorization_denial" ||
            event.action !== "openclaw.agents.native_admin.proxy.authorize" ||
            !isRecord(nativeAdmin) ||
            nativeAdmin.revisionId === undefined
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

export function registerLeaseParentAndRestrictionCases<Scenario extends LeaseScenario>({
  openNativeAdminSocketScenario,
}: LeaseDependencies<Scenario>): void {
  test(
    "PostgreSQL native admin WebSocket lease closes at the next renewal after parent logout",
    leaseCaseOptions,
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
      await assertRevokedHttp(scenario);
    },
  );

  test(
    "PostgreSQL native admin WebSocket lease closes at the next renewal after parent session expiry",
    leaseCaseOptions,
    async (t) => {
      const scenario = await openNativeAdminSocketScenario(t, "expiry");
      const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
        const expired = await scenario.apiA.pool.query(
          `UPDATE occ.session
            SET expires_at = statement_timestamp() - interval '1 second',
                updated_at = statement_timestamp()
          WHERE id = $1`,
          [fixtureId(scenario.parentSession, "parent session")],
        );
        assert.equal(expired.rowCount, 1);
      });
      t.diagnostic(`parent session expiry closed native admin WebSocket in ${closedAfterMs}ms`);
      await assertSocketAuditCloseReason(scenario, "session_invalid");
      await assertRevokedHttp(scenario);
    },
  );

  test(
    "PostgreSQL native admin WebSocket lease closes at the next renewal after both browser permissions are restricted",
    leaseCaseOptions,
    async (t) => {
      const startedAt = performance.now();
      const phases: { phase: string; elapsedMs: number }[] = [];
      const mark = (phase: string) =>
        phases.push({ phase, elapsedMs: Math.round(performance.now() - startedAt) });
      const audit = holdLeaseDenialAppend(() => mark("denial_append_pending"));
      t.after(() => audit.release());
      const scenario = await openNativeAdminSocketScenario(t, "iam-restriction", {
        auditSink: audit.wrap,
      });
      const namespaceId = fixtureId(scenario.namespace, "Namespace");
      const peer = scenario.upstream.peers[0];
      assert.ok(peer, "the real HTTPS upstream must own the admitted relay");
      // Closed-stream write callbacks below are the oracle for their expected errors.
      scenario.socket.on("error", () => {});
      peer.on("error", () => {});
      let clientBytes = "";
      let peerBytes = "";
      scenario.socket.on("data", (chunk: Buffer) => {
        clientBytes += chunk.toString();
      });
      peer.on("data", (chunk: Buffer) => {
        peerBytes += chunk.toString();
      });
      const clientClosed = new Promise<void>((resolve) =>
        scenario.socket.once("close", () => resolve()),
      );
      const peerClosed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
      const leaseDenialCount = async () => {
        const result = await scenario.apiA.pool.query<{ count: unknown }>(
          `SELECT count(*)::int AS count FROM occ.audit_events
          WHERE namespace_id = $1 AND resource_id = $2
            AND kind = 'authorization_denial'
            AND action = 'openclaw.agents.native_admin.proxy.authorize'
            AND details->'nativeAdmin'->>'revisionId' = $3`,
          [namespaceId, scenario.agent.id, scenario.revision.id],
        );
        const [row] = result.rows;
        assert.ok(row, "expected the scoped lease-denial count");
        return row.count;
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
          [`restriction-native-admin-${randomUUID()}`, namespaceId, scenario.agent.id],
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
            new Promise<Error | null | undefined>((resolve) =>
              socket.write("after-revocation-message", resolve),
            ),
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
          namespaceId,
          scenario.agent.id,
          "openclaw.agents.native_admin.proxy.authorize",
          scenario.principal.id,
          { leaseRenewal: true },
        );
        assert.equal(
          nativeAdminAuditDetails(leaseDenial, leaseDenial.action).revisionId,
          scenario.revision.id,
        );
        assert.equal(await leaseDenialCount(), 1);
        mark("attributable_lease_denial_persisted_once");
        await assertRevokedHttp(scenario);
        await waitForAuthorizationDenialAudit(
          scenario.apiA.pool,
          namespaceId,
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
}

interface RenewalOutage {
  dependency: string;
  install(t: TestContext, replica: NativeApi, unavailable: () => Promise<never>): void;
}

const renewalOutages: readonly RenewalOutage[] = [
  {
    dependency: "an IAM",
    install: (t, replica, unavailable) =>
      replaceDuringCase(t, replica.iamDriver, "authorize", unavailable),
  },
  {
    dependency: "an identity lookup",
    install: (t, replica, unavailable) =>
      replaceDuringCase(t, replica.iamDriver, "lookupIdentity", unavailable),
  },
  {
    dependency: "a State",
    install: (t, replica, unavailable) => replaceDuringCase(t, replica.state, "read", unavailable),
  },
];

export function registerLeaseDependencyCases<Scenario extends LeaseScenario>({
  openNativeAdminSocketScenario,
}: LeaseDependencies<Scenario>): void {
  for (const { dependency, install } of renewalOutages) {
    test(
      `PostgreSQL native admin WebSocket lease closes as a dependency failure during ${dependency} outage`,
      leaseCaseOptions,
      async (t) => {
        const scenario = await openNativeAdminSocketScenario(t, "iam-outage");
        const namespaceId = fixtureId(scenario.namespace, "Namespace");
        // The socket-serving replica loses a dependency at renewal. The relay
        // must close with the dependency failure reason and write no denial audit.
        const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
          install(t, scenario.apiB, async () => {
            throw new Error(`${dependency} outage`);
          });
        });
        t.diagnostic(`${dependency} outage closed native admin WebSocket in ${closedAfterMs}ms`);
        await assertSocketAuditCloseReason(scenario, "dependency_failure");
        const denials = await scenario.apiA.pool.query<{ count: unknown }>(
          `SELECT count(*)::int AS count FROM occ.audit_events
           WHERE namespace_id = $1 AND resource_id = $2 AND kind = 'authorization_denial'`,
          [namespaceId, scenario.agent.id],
        );
        const [denialCount] = denials.rows;
        assert.ok(denialCount, "expected the scoped denial count");
        assert.equal(denialCount.count, 0);
      },
    );
  }
}

export function registerLeaseStopCase<Scenario extends LeaseScenario>({
  openNativeAdminSocketScenario,
}: LeaseDependencies<Scenario>): void {
  test(
    "PostgreSQL native admin WebSocket lease closes at the next renewal after Agent stop",
    leaseCaseOptions,
    async (t) => {
      const scenario = await openNativeAdminSocketScenario(t, "stop");
      const namespaceId = fixtureId(scenario.namespace, "Namespace");
      const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
        const stopped = await inject(
          scenario.apiA.app,
          "POST",
          `/namespaces/${namespaceId}/agents/${scenario.agent.id}/stop`,
          { session: scenario.session },
        );
        assert.equal(stopped.statusCode, 202, stopped.body);
      });
      t.diagnostic(`Agent stop closed native admin WebSocket in ${closedAfterMs}ms`);
      await assertSocketAuditCloseReason(scenario, "agent_unavailable");
      await assertRevokedHttp(scenario);
    },
  );
}

export function registerLeaseReplacementAndRevocationCases<Scenario extends LeaseScenario>({
  openNativeAdminSocketScenario,
}: LeaseDependencies<Scenario>): void {
  test(
    "PostgreSQL native admin WebSocket lease closes at the next renewal after active revision replacement",
    leaseCaseOptions,
    async (t) => {
      const scenario = await openNativeAdminSocketScenario(t, "revision");
      const namespaceId = fixtureId(scenario.namespace, "Namespace");
      const native = nativeTarget(scenario.native);
      let nextRevisionId: string | undefined;
      const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
        const nextRevision = await scenario.apiA.controller.deployAgent(
          scenario.principal.id,
          { namespaceId, agentId: scenario.agent.id },
          resolveApprovedHarness,
        );
        assert.notEqual(nextRevision.id, scenario.revision.id);
        // Commit the replacement before allowing the renewal to observe it.
        const updated = await scenario.apiA.state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(
            namespaceId,
            scenario.agent.id,
            scenario.revision.id,
            nextRevision.id,
          ),
        );
        assert.equal(updated?.activeRevisionId, nextRevision.id, "successor must become active");
        nextRevisionId = nextRevision.id;
      });
      t.diagnostic(
        `active revision replacement closed native admin WebSocket in ${closedAfterMs}ms`,
      );
      await assertSocketAuditCloseReason(scenario, "revision_changed");
      const successorId = nextRevisionId;
      assert.ok(successorId, "revision replacement must create a successor revision");

      const reconnectedHttp = await nativeGet(
        scenario.apiB,
        native,
        scenario.nativeCookie,
        "/after-revision",
      );
      assert.equal(reconnectedHttp.statusCode, 200, reconnectedHttp.body);
      const reopened = await openNativeWebSocket(
        scenario.port,
        native,
        scenario.nativeCookie,
        "/session/reconnected",
      );
      t.after(() => {
        reopened.destroy();
      });
      const latestConnect = await waitFor(
        "reconnected WebSocket audit on replacement revision",
        async () => {
          const result = await scenario.apiA.pool.query<{ revision_id: unknown }>(
            `SELECT details->'nativeAdmin'->'revisionId' AS revision_id
             FROM occ.audit_events
             WHERE namespace_id = $1
               AND resource_kind = 'agent'
               AND resource_id = $2
               AND action = 'openclaw.agents.native_admin.websocket.connect'
               AND details->'nativeAdmin'->>'revisionId' = $3
             ORDER BY occurred_at DESC, id DESC
             LIMIT 1`,
            [namespaceId, scenario.agent.id, successorId],
          );
          return result.rows[0];
        },
        5_000,
      );
      assert.equal(
        latestConnect.revision_id,
        successorId,
        "shared session reconnect must bind the current active revision",
      );
    },
  );

  test(
    "PostgreSQL native admin WebSocket closes on API shutdown and disabled redeploy denies reuse",
    leaseCaseOptions,
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
      const denied = await nativeGet(
        disabledApi,
        nativeTarget(scenario.native),
        scenario.nativeCookie,
      );
      assert.equal(denied.statusCode, 403, denied.body);
    },
  );

  // These cases exercise real PostgreSQL sessions, IAM and OCC relay admission. The HTTPS
  // peer is a transport fixture; native method/scope enforcement has separate runtime proof.
  for (const change of ["operate-revoked", "account-disabled"]) {
    test(`PostgreSQL chat socket closes when ${change}`, leaseCaseOptions, async (t) => {
      const scenario = await openNativeAdminSocketScenario(t, change, { mode: "chat" });
      const { operator } = scenario;
      assert.ok(operator, "chat setup must provide an operator");
      await assertSocketClosesAfterMutation(scenario.socket, async () => {
        if (change === "operate-revoked") {
          assert.ok(operator.roleId.length > 0, "chat setup must provide the assigned role ID");
          const removed = await scenario.apiA.pool.query<Record<string, unknown>>(
            `DELETE FROM occ.iam_access_bindings WHERE role_id = $1`,
            [operator.roleId],
          );
          assert.equal(removed.rowCount, 1, "revocation must remove the operator's Agent binding");
        } else {
          const accountId = fixtureId(operator.account, "operator account");
          const changed = await scenario.apiA.pool.query<Record<string, unknown>>(
            `UPDATE occ.human_authentication_accounts SET disabled = true, version = version + 1 WHERE user_id = $1`,
            [accountId],
          );
          assert.equal(changed.rowCount, 1, "the guarded account must exist before disabling it");
        }
      });
      await assertSocketAuditCloseReason(
        scenario,
        change === "operate-revoked" ? "authorization_denied" : "session_invalid",
      );
      await assertRevokedHttp(scenario);
    });
  }
}

export function registerLeaseIndependentCookieCase<Scenario extends LeaseScenario>({
  openNativeAdminSocketScenario,
}: LeaseDependencies<Scenario>): void {
  test(
    "PostgreSQL reconnect uses the new cookie while the original chat socket keeps its session",
    leaseCaseOptions,
    async (t) => {
      const scenario = await openNativeAdminSocketScenario(t, "cookie-change", { mode: "chat" });
      const { session: nextSession } = await createAgentPermissionSession(
        scenario.apiA,
        fixtureId(scenario.namespace, "Namespace"),
        scenario.agent.id,
        "new-browser-account",
        ["operate"],
      );
      const socket = await openNativeWebSocket(
        scenario.port,
        nativeTarget(scenario.native),
        nextSession.cookie,
      );
      t.after(() => {
        socket.destroy();
      });
      // Deleting the original session closes only its socket, even after another account connects.
      const parentSessionId = fixtureId(scenario.parentSession, "parent session");
      await assertSocketClosesAfterMutation(scenario.socket, async () => {
        const deleted = await scenario.apiA.pool.query<Record<string, unknown>>(
          `DELETE FROM occ.session WHERE id = $1`,
          [parentSessionId],
        );
        assert.equal(deleted.rowCount, 1, "only the original browser session must be deleted");
      });
      await assertSocketAuditCloseReason(scenario, "session_invalid");
      assert.equal(socket.destroyed, false);
    },
  );
}
