import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { TokenService } from "../../apps/controller/src/backends/token-service/service.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.ts";
import { createDeviceCredentialDrivers } from "../helpers/device-credential-gateway.mjs";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { deviceTestSandbox } from "./device-authorization-api-fixture.ts";

test(
  "shared authentication state isolates browser consent from device login across API replicas",
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
    const preparedTokens = new TokenService();
    const options = {
      label: "device-login",
      sandboxDriver: deviceTestSandbox(),
      secretDriver,
      authSecret,
      controllerOptions: {
        now: () => new Date(clock.wallNow()),
        authenticationStateEncryptionSecret: authSecret,
        preparedTokens,
        iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()),
      },
      appOptions: { publicOrigin: "https://console.oce.localhost" },
    };
    const first = await createPostgresAgentApp(t, options);
    const second = await createPostgresAgentApp(t, options);
    preparedTokens.registerIssuer(
      new OAuthAccountTokens(
        first.state,
        secretDriver,
        first.controller.resolveConnectionClient.bind(first.controller),
      ),
    );
    await first.controller.applyIAMConfiguration();
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
    const issuer = "https://accounts.example.test";
    const template = await first.inject("POST", "/connection-templates", {
      namespaceId,
      displayName: "Shared state OAuth",
      mode: "manual",
      issuer,
      authorizationUrl: `${issuer}/authorize`,
      tokenUrl: `${issuer}/token`,
      scopes: [],
      destinations: [{ host: "api.example.test", path: "/v1/**" }],
    });
    assert.equal(template.statusCode, 201, template.body);
    const client = await first.inject("POST", "/oauth-clients", {
      connectionTemplateId: template.json().data.id,
      connectionTemplateVersion: template.json().data.current.version,
      displayName: "Public test client",
      clientId: randomUUID(),
      tokenEndpointAuthMethod: "none",
    });
    assert.equal(client.statusCode, 201, client.body);
    async function startOAuth() {
      const response = await first.inject("POST", `/namespaces/${namespaceId}/connections`, {
        connectionTemplateId: template.json().data.id,
      });
      assert.equal(response.statusCode, 201, response.body);
      const data = response.json().data;
      const state = new URL(data.authorizationUrl).searchParams.get("state");
      assert.ok(state);
      return {
        sourceId: data.credentialSourceId as string,
        callback: `/oauth/callback?${new URLSearchParams({ state, error: "access_denied" })}`,
      };
    }
    async function start() {
      const reply = await first.inject("POST", path, { harnessId: "codex" });
      assert.equal(reply.statusCode, 200, reply.body);
      const { session, userCode, verificationUrl } = reply.json().data;
      assert.equal(typeof session.id, "string");
      assert.deepEqual(session, { id: session.id, namespaceId });
      assert.ok(userCode);
      assert.ok(verificationUrl);
      return { id: session.id as string, userCode, verificationUrl };
    }
    async function row(id: string) {
      const result = await first.pool.query(
        "SELECT phase, device_source_id, private_state, encrypted_challenge, to_jsonb(s)::text AS contents FROM occ.authentication_states s WHERE kind = 'device_authorization' AND namespace_id = $1 AND id = $2",
        [namespaceId, id],
      );
      assert.equal(result.rowCount, 1);
      return result.rows[0];
    }
    const { id, userCode, verificationUrl } = await start();
    const pending = await row(id);
    const consent = await startOAuth();
    // Both supported entry points write to the same physical store without sharing private fields.
    const coexisting = await first.pool.query(
      `SELECT kind, credential_source_id, device_source_id FROM occ.authentication_states
       WHERE namespace_id = $1 AND (id = $2 OR credential_source_id = $3) ORDER BY kind`,
      [namespaceId, id, consent.sourceId],
    );
    assert.deepEqual(coexisting.rows, [
      {
        kind: "device_authorization",
        credential_source_id: null,
        device_source_id: pending.device_source_id,
      },
      { kind: "oauth_connection", credential_source_id: consent.sourceId, device_source_id: null },
    ]);
    // A different browser session cannot consume the owner's attempt. Concurrent owner callbacks
    // then race on the same database row: exactly one consumes it before classifying the refusal.
    const stolen = await second.inject("GET", consent.callback);
    assert.match(String(stolen.headers.location), /reason=unknown_session/);
    const callbacks = await Promise.all([
      first.inject("GET", consent.callback),
      first.inject("GET", consent.callback),
    ]);
    assert.deepEqual(
      callbacks
        .map((reply) =>
          new URL(String(reply.headers.location), "https://console.oce.localhost").searchParams.get(
            "reason",
          ),
        )
        .sort(),
      ["consent_denied", "unknown_session"],
    );
    assert.equal(
      (
        await first.inject(
          "GET",
          `/namespaces/${namespaceId}/credential-sources/${consent.sourceId}`,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await row(id)).phase,
      "pending",
      "OAuth consumption must not change the device login",
    );
    assert.equal(pending.phase, "pending");
    assert.ok(pending.private_state);
    assert.ok(pending.encrypted_challenge);
    assert.equal(pending.contents.includes(userCode), false);
    assert.equal(pending.contents.includes(verificationUrl), false);
    assert.equal(pending.contents.includes("device-private-handle-"), false);
    // A login is actor-owned transient state, not a Secret or an IAM grant target.
    const authority = await first.pool.query(
      `SELECT EXISTS (SELECT 1 FROM occ.secrets WHERE namespace_id = $1 AND id = $2) AS has_secret,
              EXISTS (SELECT 1 FROM occ.iam_access_bindings WHERE resource_kind = 'secret' AND resource_id = $2) AS has_binding`,
      [namespaceId, id],
    );
    assert.deepEqual(authority.rows, [{ has_secret: false, has_binding: false }]);
    const ownedSource = await first.pool.query(
      `SELECT resource_kind, resource_id FROM occ.iam_access_bindings
       WHERE identity_subject_id = $1 AND role_id = 'role_config_owner' AND resource_id = $2`,
      [first.principal.id, pending.device_source_id],
    );
    assert.deepEqual(ownedSource.rows, [
      { resource_kind: "credential_source", resource_id: pending.device_source_id },
    ]);
    const policy = `/namespaces/${namespaceId}/iam`;
    const role = await first.inject("POST", `${policy}/roles`, {
      name: "Secret operator",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    assert.equal(role.statusCode, 201, role.body);
    const deniedBinding = await first.inject("POST", `${policy}/access-bindings`, {
      subjectKind: "identity",
      subjectId: first.principal.id,
      roleId: role.json().data.id,
      resourceKind: "secret",
      resourceId: id,
    });
    assert.equal(deniedBinding.statusCode, 400, deniedBinding.body);
    assert.deepEqual(deniedBinding.json().error.details, [
      { path: "/resourceId", code: "INVALID_VALUE" },
    ]);

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
      assert.equal(competing.json().data.userCode, userCode);
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
    assert.equal(cancelled.encrypted_challenge, null);

    // A completed login keeps its source but discards its encrypted provider handle.
    const next = await start();
    await clock.advance(5000);
    const completed = await second.inject("POST", `${path}/${next.id}/poll`, {});
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().data.status, "ready");
    assert.equal((await row(next.id)).private_state, null);
    // An authorized ready replay still returns the original challenge after the provider handle is gone.
    const replay = await first.inject("POST", `${path}/${next.id}/poll`, {});
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().data.status, "ready");
    assert.equal(replay.json().data.userCode, next.userCode);
    assert.equal(replay.json().data.verificationUrl, next.verificationUrl);

    const { id: abandoned } = await start();
    const abandonedConsent = await startOAuth();
    await clock.advance(15 * 60 * 1000);
    // Abandon the challenge: the periodic expiry operation must clear private state without a poll.
    await second.controller.expireAuthenticationStates(32);
    assert.equal(
      (
        await first.inject(
          "GET",
          `/namespaces/${namespaceId}/credential-sources/${abandonedConsent.sourceId}`,
        )
      ).statusCode,
      404,
      "expiry removes the unfinished OAuth credential source",
    );
    const expiredConsent = await first.pool.query(
      "SELECT id FROM occ.authentication_states WHERE kind = 'oauth_connection' AND credential_source_id = $1",
      [abandonedConsent.sourceId],
    );
    assert.equal(expiredConsent.rowCount, 0);
    const abandonedRow = await row(abandoned);
    assert.equal(abandonedRow.private_state, null);
    assert.equal(abandonedRow.encrypted_challenge, null);
    const expired = await second.inject("POST", `${path}/${abandoned}/poll`, {});
    assert.equal(expired.statusCode, 409, expired.body);
    assert.deepEqual(secretDriver.calls, [], "login state must never reach a Secret Driver");

    // Namespace finalization removes its transient login rows.
    const namespacePath = `/namespaces/${namespaceId}`;
    for (const sourceId of gateway.sources.keys()) {
      const deleted = await first.inject(
        "DELETE",
        `${namespacePath}/credential-sources/${sourceId}`,
      );
      assert.equal(deleted.statusCode, 204, deleted.body);
    }
    const removedTemplate = await first.inject(
      "DELETE",
      `/connection-templates/${template.json().data.id}`,
    );
    assert.equal(removedTemplate.statusCode, 204, removedTemplate.body);
    const removedClient = await first.inject("DELETE", `/oauth-clients/${client.json().data.id}`);
    assert.equal(removedClient.statusCode, 204, removedClient.body);
    const deleting = await first.inject("DELETE", namespacePath);
    assert.equal(deleting.statusCode, 202, deleting.body);
    await first.controller.handleNamespaceLifecycle(first.principal.id, namespaceId, "deleted");
    const missing = await first.inject("GET", namespacePath);
    assert.equal(missing.statusCode, 404, missing.body);
    const sessions = await first.pool.query(
      "SELECT id FROM occ.authentication_states WHERE kind = 'device_authorization' AND namespace_id = $1",
      [namespaceId],
    );
    assert.equal(sessions.rowCount, 0);
  },
);
