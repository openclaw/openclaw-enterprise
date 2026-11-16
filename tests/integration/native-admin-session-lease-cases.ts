import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import type { NativeAdminWebSocketCloseReason } from "../../apps/controller/src/gateway/native-admin-proxy.ts";
import {
  assertSocketClosesAfterMutation,
  createAgentPermissionSession,
  createApi,
  nativeGet,
  openNativeWebSocket,
  requiresPostgres,
} from "../helpers/native-admin-postgres.ts";
import { waitFor } from "../helpers/wait-for.ts";

type NativeApi = Awaited<ReturnType<typeof createApi>>;
type NativeSocket = Awaited<ReturnType<typeof openNativeWebSocket>>;
type Mode = "admin" | "chat";

interface LeaseScenario {
  apiA: NativeApi;
  apiB: NativeApi;
  upstream: { port: number };
  namespace: unknown;
  agent: { id: string };
  revision: { id: string };
  principal: { id: string };
  native: unknown;
  nativeCookie: string;
  parentSession: unknown;
  operator: { roleId: string; account: unknown } | undefined;
  port: number;
  socket: NativeSocket;
}

export interface LeaseDependencies<Scenario extends LeaseScenario = LeaseScenario> {
  openNativeAdminSocketScenario(
    t: TestContext,
    label: string,
    options?: { mode: Mode },
  ): Promise<Scenario>;
  assertSocketAuditCloseReason(
    scenario: Scenario,
    reason: NativeAdminWebSocketCloseReason,
  ): Promise<void>;
  assertRevokedHttp(scenario: Scenario): Promise<void>;
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
  assertSocketAuditCloseReason,
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

export function registerLeaseReplacementAndRevocationCases<Scenario extends LeaseScenario>({
  openNativeAdminSocketScenario,
  assertSocketAuditCloseReason,
  assertRevokedHttp,
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
  assertSocketAuditCloseReason,
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
