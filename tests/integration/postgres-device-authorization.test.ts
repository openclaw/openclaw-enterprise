import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createControlledClock } from "../fixtures/repository-credentials/clock.ts";
import { createDeviceCredentialDrivers } from "../helpers/device-credential-gateway.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { deviceTestSandbox } from "./device-authorization-api-fixture.ts";

test(
  "device login survives an API replica change, accepts an exact Secret grant and fences a cancelled exchange in PostgreSQL",
  requiresPostgres,
  async (t) => {
    const clock = createControlledClock();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { gateway, refresh } = createDeviceCredentialDrivers({
      now: clock.wallNow,
      beforePoll: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const authSecret = "postgres-device-login-test-signing-secret";
    const secretDriver = createTestSecretDriver();
    const options = {
      label: "device-login",
      sandboxDriver: deviceTestSandbox(),
      secretDriver,
      authSecret,
      controllerOptions: {
        now: () => new Date(clock.wallNow()),
        deviceAuthorizationSecret: authSecret,
      },
    };
    const first = await createPostgresAgentApp(t, options);
    const second = await createPostgresAgentApp(t, options);
    for (const { controller } of [first, second]) {
      controller.registerDriver(gateway);
      controller.selectDriver("credential_gateway", gateway.id);
      controller.registerDriver(refresh);
      controller.selectDriver("credential_refresh", refresh.id);
    }
    const created = await first.inject("POST", "/namespaces", {
      name: `Device login ${randomUUID()}`,
    });
    assert.equal(created.statusCode, 201, created.body);
    const namespaceId = created.json().data.id;
    await first.controller.handleNamespaceLifecycle(first.principal.id, namespaceId, "ready");
    const path = `/namespaces/${namespaceId}/agents/device-authorizations`;
    async function start() {
      const reply = await first.inject("POST", path, { harnessId: "codex" });
      assert.equal(reply.statusCode, 200, reply.body);
      const session = reply.json().data.session;
      assert.equal(typeof session.id, "string");
      assert.deepEqual(session, { id: session.id, namespaceId });
      return session.id as string;
    }
    async function row(id: string) {
      const result = await first.pool.query(
        "SELECT phase, private_state, to_jsonb(s)::text AS contents FROM occ.device_authorizations s WHERE namespace_id = $1 AND id = $2",
        [namespaceId, id],
      );
      assert.equal(result.rowCount, 1);
      return result.rows[0];
    }
    const id = await start();
    const pending = await row(id);
    assert.equal(pending.phase, "pending");
    assert.ok(pending.private_state);
    assert.equal(pending.contents.includes("device-private-handle-"), false);
    // The session has no ordinary Secret row but remains an exact Secret IAM target.
    const secret = await first.inject("GET", `/namespaces/${namespaceId}/secrets/${id}`);
    assert.equal(secret.statusCode, 404, secret.body);
    const policy = `/namespaces/${namespaceId}/iam`;
    const role = await first.inject("POST", `${policy}/roles`, {
      name: "Login operator",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    assert.equal(role.statusCode, 201, role.body);
    const binding = await first.inject("POST", `${policy}/access-bindings`, {
      subjectKind: "identity",
      subjectId: first.principal.id,
      roleId: role.json().data.id,
      resourceKind: "secret",
      resourceId: id,
    });
    assert.equal(binding.statusCode, 201, binding.body);

    await clock.advance(5000);
    // The Refresh Driver verifies that a different API instance decrypted the original handle.
    const poll = second.inject("POST", `${path}/${id}/poll`, {});
    try {
      await Promise.race([
        entered.promise,
        poll.then((reply) =>
          assert.fail(`Poll returned before reaching the Driver: ${reply.body}`),
        ),
      ]);
      const competing = await first.inject("POST", `${path}/${id}/poll`, {});
      assert.equal(competing.statusCode, 200, competing.body);
      assert.equal(competing.json().data.status, "pending");
      assert.equal(
        gateway.operations.filter((operation) => operation === "pollDeviceAuthorization").length,
        1,
      );
      const closed = await first.inject("DELETE", `${path}/${id}`);
      assert.equal(closed.statusCode, 204, closed.body);
    } finally {
      release.resolve();
    }
    assert.equal((await poll).statusCode, 409);
    const cancelled = await row(id);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.private_state, null);

    // A completed login keeps its source but discards its encrypted provider handle.
    const next = await start();
    await clock.advance(5000);
    const completed = await second.inject("POST", `${path}/${next}/poll`, {});
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().data.status, "ready");
    assert.equal((await row(next)).private_state, null);

    const abandoned = await start();
    await clock.advance(15 * 60 * 1000);
    // Abandon the challenge: the periodic expiry operation must clear private state without a poll.
    await second.controller.expireConnectionSessions(32);
    assert.equal((await row(abandoned)).private_state, null);
    const expired = await second.inject("POST", `${path}/${abandoned}/poll`, {});
    assert.equal(expired.statusCode, 409, expired.body);
    assert.deepEqual(secretDriver.calls, [], "login state must never reach a Secret Driver");

    // OCC finalizes Namespace deletion and records the exact grants it removed.
    // The teardown audit must still identify a binding that targeted a login handle.
    const namespacePath = `/namespaces/${namespaceId}`;
    for (const sourceId of gateway.sources.keys()) {
      const deleted = await first.inject(
        "DELETE",
        `${namespacePath}/credential-sources/${sourceId}`,
      );
      assert.equal(deleted.statusCode, 204, deleted.body);
    }
    const deleting = await first.inject("DELETE", namespacePath);
    assert.equal(deleting.statusCode, 202, deleting.body);
    await first.controller.handleNamespaceLifecycle(first.principal.id, namespaceId, "deleted");
    const missing = await first.inject("GET", namespacePath);
    assert.equal(missing.statusCode, 404, missing.body);
    const sessions = await first.pool.query(
      "SELECT id FROM occ.device_authorizations WHERE namespace_id = $1",
      [namespaceId],
    );
    assert.equal(sessions.rowCount, 0);
    const teardown = await first.pool.query(
      `SELECT details->'removedAccessBindings' AS removed FROM occ.audit_events
       WHERE action = 'openclaw.namespaces.lifecycle.delete' AND resource_id = $1 AND outcome = 'success'
       AND details ? 'removedAccessBindings'`,
      [namespaceId],
    );
    assert.deepEqual(teardown.rows, [
      {
        removed: [
          {
            id: binding.json().data.id,
            subjectKind: "identity",
            subjectId: first.principal.id,
            roleId: role.json().data.id,
            resourceKind: "secret",
            resourceId: id,
          },
        ],
      },
    ]);
  },
);
