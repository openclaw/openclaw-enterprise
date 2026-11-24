import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { createControlledClock } from "../fixtures/repository-credentials/clock.ts";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import {
  credentialSourceDeliveryBinding,
  installationControllerOptions,
} from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import { installTokenServiceDriver } from "../../apps/controller/src/composition/token-service.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OAuthAccountTokens } from "../../apps/controller/src/backends/token-service/oauth-connection.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { refreshCodexOAuthGrant } from "../../apps/controller/src/drivers/token-service/codex-device-authorization.ts";
import {
  readProviderRequestBody,
  redirectProviderFetch,
  startProviderServer,
} from "../helpers/provider-http-transport.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "../helpers/default-users-iam.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { controlDeviceIssuer } from "../helpers/device-token-service.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { gatewayRouting } from "../helpers/kubernetes-routed-options.ts";
import { completeOpenShellGatewayClient } from "../helpers/openshell-gateway-client.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { deviceTestSandbox } from "./device-authorization-api-fixture.ts";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";

test(
  "shared authentication state isolates browser consent from device login across API replicas",
  requiresPostgres,
  async (t) => {
    const clock = createControlledClock();
    const issuer = await startProviderServer(t, (request, response) => {
      void (async () => {
        const body = await readProviderRequestBody(request);
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/accounts/deviceauth/usercode") {
          assert.equal(typeof JSON.parse(body).client_id, "string");
          response.end(
            JSON.stringify({ device_auth_id: randomUUID(), user_code: "CODE-12345", interval: 5 }),
          );
          return;
        }
        if (request.url === "/api/accounts/deviceauth/token") {
          const requestBody = JSON.parse(body);
          assert.equal(requestBody.user_code, "CODE-12345");
          assert.equal(typeof requestBody.device_auth_id, "string");
          response.end(
            JSON.stringify({ authorization_code: randomUUID(), code_verifier: randomUUID() }),
          );
          return;
        }
        if (request.url === "/oauth/token") {
          const form = new URLSearchParams(body);
          assert.equal(form.get("grant_type"), "authorization_code");
          const claims = {
            exp: Math.floor(Date.now() / 1000) + 3600,
            "https://api.openai.com/auth": {
              chatgpt_account_id: "fixture-account",
              chatgpt_plan_type: "plus",
            },
          };
          const jwt = (payload: unknown) =>
            `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`;
          response.end(
            JSON.stringify({
              access_token: jwt(claims),
              token_type: "Bearer",
              id_token: jwt(claims),
              refresh_token: randomUUID(),
            }),
          );
          return;
        }
        response.statusCode = 404;
        response.end("{}");
      })().catch((error) => {
        response.destroy(error);
      });
    });
    redirectProviderFetch(
      t,
      new Set([
        "https://auth.openai.com/api/accounts/deviceauth/usercode",
        "https://auth.openai.com/api/accounts/deviceauth/token",
        "https://auth.openai.com/oauth/token",
      ]),
      `http://127.0.0.1:${issuer.port}`,
    );
    const authSecret = "postgres-device-login-test-signing-secret";
    const secretDriver = createTestSecretDriver();
    const options = {
      label: "device-login",
      sandboxDriver: deviceTestSandbox(),
      secretDriver,
      authSecret,
      controllerOptions: {
        now: () => new Date(clock.wallNow()),
        authenticationStateEncryptionSecret: authSecret,
        iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()),
      },
      appOptions: { publicOrigin: "https://console.oce.localhost" },
    };
    const first = await createPostgresAgentApp(t, options);
    const second = await createPostgresAgentApp(t, options);
    await first.controller.applyIAMConfiguration();
    const storeIdentity = randomUUID();
    await secretDriver.installationSecrets.create(
      {
        installationId: first.controller.installation.id,
        id: `token-service-store-identity:${secretDriver.id}`,
      },
      storeIdentity,
    );
    let instanceId: string | undefined;
    for (const { controller, state } of [first, second]) {
      const current = await controller.activateTokenServiceInstance(
        "device-oauth-owner",
        storeIdentity,
      );
      if (instanceId !== undefined) {
        assert.equal(
          current,
          instanceId,
          "both replicas must select the same TokenService instance",
        );
      }
      instanceId = current;
      const owner = new OCCTokenServiceDriver(
        "device-oauth-owner",
        controller.installation.id,
        secretDriver.installationSecrets,
        current,
        state,
        undefined,
        new OAuthAccountTokens(
          state,
          secretDriver,
          controller.resolveConnectionClient.bind(controller),
          refreshCodexOAuthGrant,
        ),
      );
      controller.registerDriver(owner);
      controller.selectDriver("token_service", owner.id);
    }
    const created = await first.inject("POST", "/namespaces", {
      name: `Device login ${randomUUID()}`,
    });
    assert.equal(created.statusCode, 201, created.body);
    const namespaceId = created.json().data.id;
    await first.controller.handleNamespaceLifecycle(first.principal.id, namespaceId, "ready");
    const path = `/namespaces/${namespaceId}/agents/device-authorizations`;
    const staticTemplate = await first.inject("POST", "/connection-templates", {
      namespaceId,
      displayName: "Static Bearer",
      mode: "static_bearer",
      destinations: [{ method: "POST", host: "api.example.test", port: 443, path: "/v1/**" }],
    });
    assert.equal(staticTemplate.statusCode, 201, staticTemplate.body);
    // The OAuth caller must reject a static template without reserving a source or consent state.
    const refused = await first.inject("POST", `/namespaces/${namespaceId}/connections`, {
      connectionTemplateId: staticTemplate.json().data.id,
    });
    assert.equal(refused.statusCode, 409, refused.body);
    const reservations = await first.pool.query(
      `SELECT (SELECT count(*)::int FROM occ.credential_sources WHERE namespace_id=$1) AS sources,
              (SELECT count(*)::int FROM occ.authentication_states WHERE namespace_id=$1) AS states`,
      [namespaceId],
    );
    assert.deepEqual(reservations.rows, [{ sources: 0, states: 0 }]);
    const removedStatic = await first.inject(
      "DELETE",
      `/connection-templates/${staticTemplate.json().data.id}`,
    );
    assert.equal(removedStatic.statusCode, 204, removedStatic.body);
    const consentIssuer = "https://accounts.example.test";
    const template = await first.inject("POST", "/connection-templates", {
      namespaceId,
      displayName: "Shared state OAuth",
      mode: "manual",
      issuer: consentIssuer,
      authorizationUrl: `${consentIssuer}/authorize`,
      tokenUrl: `${consentIssuer}/token`,
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
      assert.equal(Object.hasOwn(data, "credentialSourceId"), false);
      return {
        id: createHash("sha256").update(state).digest("hex"),
        callback: `/oauth/callback?${new URLSearchParams({ state, error: "access_denied" })}`,
      };
    }
    async function start() {
      const reply = await first.inject("POST", path, { harnessId: "codex" });
      assert.equal(reply.statusCode, 200, reply.body);
      const { session, userCode, verificationUrl, expiresAt } = reply.json().data;
      assert.equal(typeof session.id, "string");
      assert.deepEqual(session, { id: session.id, namespaceId });
      assert.ok(userCode);
      assert.ok(verificationUrl);
      return { id: session.id as string, userCode, verificationUrl, expiresAt };
    }
    async function row(id: string) {
      const result = await first.pool.query(
        "SELECT phase, credential_source_id AS device_source_id, binding ? 'sourceId' AS duplicated_source, private_state, encrypted_challenge, to_jsonb(s)::text AS contents FROM occ.authentication_states s WHERE kind = 'device_authorization' AND namespace_id = $1 AND id = $2",
        [namespaceId, id],
      );
      assert.equal(result.rowCount, 1);
      return result.rows[0];
    }
    const { id, userCode, verificationUrl } = await start();
    const pending = await row(id);
    assert.equal(pending.device_source_id, null, "pending login has no Source result");
    assert.equal(
      (
        await first.pool.query("SELECT 1 FROM occ.credential_sources WHERE namespace_id=$1", [
          namespaceId,
        ])
      ).rowCount,
      0,
      "starting device login creates no Source",
    );
    assert.equal(secretDriver.calls.length, 0, "pending login state never reaches a Secret Driver");
    assert.equal(
      pending.duplicated_source,
      false,
      "the device Source is stored only in its FK column",
    );
    const consent = await startOAuth();
    // Both supported entry points write to the same physical store without sharing private fields.
    const coexisting = await first.pool.query(
      `SELECT kind, credential_source_id AS device_source_id FROM occ.authentication_states
       WHERE namespace_id = $1 AND id IN ($2,$3) ORDER BY kind`,
      [namespaceId, id, consent.id],
    );
    assert.deepEqual(coexisting.rows, [
      {
        kind: "device_authorization",
        device_source_id: pending.device_source_id,
      },
      { kind: "oauth_connection", device_source_id: null },
    ]);
    // The application role can update device progress but cannot rewrite an immutable binding,
    // alter an OAuth attempt, or introduce fields belonging to another workflow.
    await assert.rejects(
      first.pool.query("UPDATE occ.authentication_states SET binding = binding WHERE id = $1", [
        id,
      ]),
      { code: "42501" },
    );
    await assert.rejects(
      first.pool.query(
        "UPDATE occ.authentication_states SET credential_source_id = $2, phase = 'ready' WHERE id = $1",
        [id, `csrc_${randomUUID()}`],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      first.pool.query(
        "UPDATE occ.authentication_states SET expires_at = expires_at WHERE id = $1",
        [consent.id],
      ),
      { code: "55000" },
    );
    await assert.rejects(
      first.pool.query(
        `INSERT INTO occ.authentication_states
         (id,kind,namespace_id,actor_id,expires_at,binding,phase,next_poll_at,encrypted_challenge,private_state,version)
         SELECT $2,kind,namespace_id,actor_id,expires_at,binding || '{"redirectUri":"invalid"}'::jsonb,
                phase,next_poll_at,encrypted_challenge,private_state,version
         FROM occ.authentication_states WHERE id = $1`,
        [id, `sec_${randomUUID()}`],
      ),
      { code: "23514" },
    );
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
        await first.pool.query(
          "SELECT 1 FROM occ.credential_sources WHERE namespace_id=$1 AND type='oauth2-refresh-token'",
          [namespaceId],
        )
      ).rowCount,
      0,
      "denied consent creates no OAuth Source",
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
    const pendingGrants = await first.pool.query(
      "SELECT 1 FROM occ.iam_access_bindings WHERE resource_kind='credential_source' AND namespace_id=$1",
      [namespaceId],
    );
    assert.equal(pendingGrants.rowCount, 0, "pending login creates no Source grant");
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

    // Cancelling an ungranted login erases only temporary login state.
    const closed = await second.inject("DELETE", `${path}/${id}`);
    assert.equal(closed.statusCode, 204, closed.body);
    const cancelled = await row(id);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.private_state, null);
    assert.equal(cancelled.encrypted_challenge, null);
    assert.equal(cancelled.device_source_id, null);
    assert.equal(
      (
        await first.pool.query("SELECT 1 FROM occ.credential_sources WHERE namespace_id=$1", [
          namespaceId,
        ])
      ).rowCount,
      0,
      "cancelling the claimed login prevents Source creation",
    );

    // A completed login keeps its source but discards its encrypted provider handle.
    const next = await start();
    await clock.advance(5000);
    const completed = await second.inject("POST", `${path}/${next.id}/poll`, {});
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().data.status, "ready");
    const ready = await row(next.id);
    assert.equal(ready.private_state, null);
    assert.equal(ready.device_source_id, completed.json().data.source.id);
    const createdSources = await first.pool.query(
      "SELECT id,type,owner_capability,token_service_instance_id,oauth_provenance FROM occ.credential_sources WHERE namespace_id=$1",
      [namespaceId],
    );
    assert.deepEqual(createdSources.rows, [
      {
        id: ready.device_source_id,
        type: "oauth2-refresh-token",
        owner_capability: "token_service",
        token_service_instance_id: instanceId,
        oauth_provenance: "builtin_codex",
      },
    ]);
    const sourcePath = `/namespaces/${namespaceId}/credential-sources`;
    const fetched = await first.inject("GET", `${sourcePath}/${ready.device_source_id}`);
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.equal(fetched.json().data.consent.kind, "builtin_codex");
    assert.equal(fetched.json().data.consent.account.accountId, "fixture-account");
    const listed = await first.inject("GET", sourcePath);
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      listed.json().data.map((source: { id: string }) => source.id),
      [ready.device_source_id],
    );
    assert.equal(fetched.body.includes("refresh_token"), false);
    const creator = await first.pool.query(
      "SELECT resource_kind,resource_id FROM occ.iam_access_bindings WHERE identity_subject_id=$1 AND role_id='role_config_owner' AND resource_id=$2",
      [first.principal.id, ready.device_source_id],
    );
    assert.deepEqual(creator.rows, [
      { resource_kind: "credential_source", resource_id: ready.device_source_id },
    ]);
    async function sourceAudit(sourceId: string) {
      const evidence = await first.pool.query(
        "SELECT actor_id,resource_kind,resource_id,details->>'phase' AS phase,details->>'sourceId' AS source_id FROM occ.audit_events WHERE action='openclaw.agents.device_authorization.poll' AND resource_kind='credential_source' AND resource_id=$1",
        [sourceId],
      );
      assert.deepEqual(evidence.rows, [
        {
          actor_id: first.principal.id,
          resource_kind: "credential_source",
          resource_id: sourceId,
          phase: "source_ready",
          source_id: sourceId,
        },
      ]);
    }
    await sourceAudit(ready.device_source_id);
    await assert.rejects(
      first.pool.query(
        "UPDATE occ.authentication_states SET credential_source_id=NULL WHERE id=$1",
        [next.id],
      ),
      { code: "23514" },
    );
    // An authorized ready replay still returns the original challenge after the provider handle is gone.
    const replay = await first.inject("POST", `${path}/${next.id}/poll`, {});
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().data.status, "ready");
    assert.equal(replay.json().data.userCode, next.userCode);
    assert.equal(replay.json().data.verificationUrl, next.verificationUrl);

    const { id: abandoned, expiresAt: abandonedExpiry } = await start();
    const abandonedConsent = await startOAuth();
    await clock.advance(Date.parse(abandonedExpiry) - clock.wallNow() + 1);
    // Abandon the challenge: the periodic expiry operation must clear private state without a poll.
    await second.controller.expireAuthenticationStates(32);
    const expiredConsent = await first.pool.query(
      "SELECT id FROM occ.authentication_states WHERE kind = 'oauth_connection' AND id = $1",
      [abandonedConsent.id],
    );
    assert.equal(expiredConsent.rowCount, 0);
    const abandonedRow = await row(abandoned);
    assert.equal(abandonedRow.private_state, null);
    assert.equal(abandonedRow.encrypted_challenge, null);
    const expired = await second.inject("POST", `${path}/${abandoned}/poll`, {});
    assert.equal(expired.statusCode, 409, expired.body);
    assert.ok(
      secretDriver.calls.some((call) => call.operation === "create"),
      "successful OAuth grant enters custody",
    );
    assert.equal(
      JSON.stringify(secretDriver.calls).includes("CODE-12345"),
      false,
      "the user challenge does not enter custody",
    );

    // Deleting the new Source retires custody; Namespace finalization removes temporary sessions.
    const namespacePath = `/namespaces/${namespaceId}`;
    const custodyDeletesBefore = secretDriver.calls.filter(
      (call) => call.operation === "delete",
    ).length;
    const deleted = await first.inject(
      "DELETE",
      `${namespacePath}/credential-sources/${ready.device_source_id}`,
    );
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal(
      secretDriver.calls.filter((call) => call.operation === "delete").length,
      custodyDeletesBefore + 1,
      "deleting a new OAuth Source removes its private grant from custody",
    );
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

test(
  "completed Codex login admits the direct Agent model binding and refuses referenced Source deletion",
  requiresPostgres,
  async (t) => {
    const grant = {
      id: "codex-model",
      binary:
        "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex",
      host: "chatgpt.com",
      ports: [{ from: 443, to: 443 }],
    };
    const installation = buildSandboxInstallation();
    Reflect.deleteProperty(installation.drivers, "credential_gateway");
    Reflect.deleteProperty(installation.backend[0]?.drivers ?? {}, "credential_gateway");
    Object.assign(installation.drivers, { token_service: { id: "occ", configuration: {} } });
    Reflect.deleteProperty(installation.drivers.compute.configuration.network, "gatewayClients");
    Object.assign(installation.drivers.compute.configuration, { gatewayRouting });
    const runtime = await loadInstallationFile(t, installation, {
      createOpenShellBackend: (definition) =>
        createOpenShellBackend(definition, {
          // Admission creates no native workspace or Provider. Retirement can confirm that
          // the controlled Gateway has no workspace, without pretending a Provider existed.
          gatewayClient: completeOpenShellGatewayClient({ async getWorkspace() {} }),
        }),
    });
    assert.ok(runtime?.credentialDeliveryRegistration);
    runtime.computeDriver.resolveSandboxNamespace = async (namespace) => ({
      ...namespace,
      name: kubernetesNamespaceName(namespace.id),
    });
    // The production Compute performs admission, with only its Kubernetes transport status
    // supplied by the fixture; no Worker, Sandbox launch, or native Provider is exercised.
    runtime.computeDriver.getAgentRuntimeCredentialStatus = async () => ({
      transportConfigured: true,
    });

    const clock = createControlledClock();
    controlDeviceIssuer(t);
    const secretDriver = createTestSecretDriver();
    const authSecret = "postgres-direct-codex-test-signing-secret";
    const app = await createPostgresAgentApp(t, {
      label: "direct-codex",
      sandboxDriver: deviceTestSandbox(),
      secretDriver,
      authSecret,
      controllerOptions: {
        ...installationControllerOptions(runtime.installation),
        namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
        credentialSourceDelivery: credentialSourceDeliveryBinding(runtime),
        sandboxNetworkPolicyCeiling: [grant],
        now: () => new Date(clock.wallNow()),
        authenticationStateEncryptionSecret: authSecret,
        iamConfiguration: controllerIAMConfiguration(defaultUsersIAM()),
      },
      appOptions: { publicOrigin: "https://console.oce.localhost" },
    });
    await app.controller.applyIAMConfiguration();
    await installTokenServiceDriver(app.controller, { ...runtime, secretDriver }, app.state);
    const createdNamespace = await app.inject("POST", "/namespaces", {
      name: `Direct Codex ${randomUUID()}`,
    });
    assert.equal(createdNamespace.statusCode, 201, createdNamespace.body);
    const namespaceId = createdNamespace.json().data.id;
    await app.controller.handleNamespaceLifecycle(app.principal.id, namespaceId, "ready");
    app.controller.registerDriver(runtime.computeDriver);
    app.controller.selectDriver("compute", runtime.computeDriver.id);
    installSelectedSandboxDrivers(app.controller, runtime);

    const base = `/namespaces/${namespaceId}`;
    const loginPath = `${base}/agents/device-authorizations`;
    const started = await app.inject("POST", loginPath, { harnessId: "codex" });
    assert.equal(started.statusCode, 200, started.body);
    await clock.advance(5000);
    const completed = await app.inject(
      "POST",
      `${loginPath}/${started.json().data.session.id}/poll`,
      {},
    );
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().data.status, "ready");
    const sourceId = completed.json().data.source.id;
    const sourcePath = `${base}/credential-sources/${sourceId}`;
    const configuration = await app.inject("POST", `${base}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("codex", "gpt-5.1"),
    });
    assert.equal(configuration.statusCode, 201, configuration.body);
    const createdAgent = await app.inject("POST", `${base}/agents`, {
      name: `Codex Agent ${randomUUID()}`,
      executionMode: "dedicated",
      configurationId: configuration.json().data.id,
      harnessAuth: { method: "credential_source", sourceId },
      credentialSources: [{ sourceId }],
    });
    assert.equal(createdAgent.statusCode, 201, createdAgent.body);
    const agent = createdAgent.json().data;
    assert.deepEqual(agent.credentialSources, [{ sourceId }]);
    assert.deepEqual(agent.harnessAuth, { method: "credential_source", sourceId });
    const agentPath = `${base}/agents/${agent.id}`;
    const admissionEffects = async () =>
      (
        await app.pool.query(
          `SELECT
             (SELECT count(*)::int FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2) AS revisions,
             (SELECT count(*)::int FROM occ.iam_access_bindings
              WHERE namespace_id=$1 AND identity_subject_id=$3
                AND resource_kind='credential_source' AND resource_id=$4) AS source_grants`,
          [namespaceId, agent.id, agent.servicePrincipalId, sourceId],
        )
      ).rows[0];
    // A refused deployment must not leave either an admitted revision or an Agent-SP grant.
    const refused = await app.inject("POST", `${agentPath}/deploy`, {});
    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(refused.json().error.message, /exact, unambiguous network grant/i);
    assert.deepEqual(await admissionEffects(), { revisions: 0, source_grants: 0 });

    const editing = await app.inject("PATCH", `${agentPath}/sandbox-policy/networking/editing`, {
      enabled: true,
    });
    assert.equal(editing.statusCode, 200, editing.body);
    const policy = await app.inject("PUT", `${agentPath}/sandbox-policy/networking`, {
      expectedVersion: 1,
      additions: [grant],
    });
    assert.equal(policy.statusCode, 200, policy.body);
    const deployed = await app.inject("POST", `${agentPath}/deploy`, {});
    assert.equal(deployed.statusCode, 202, deployed.body);
    assert.deepEqual(await admissionEffects(), { revisions: 1, source_grants: 1 });
    const agentGrant = await app.pool.query(
      `SELECT role.permissions FROM occ.iam_access_bindings AS binding
       JOIN occ.iam_roles AS role ON role.id=binding.role_id
       WHERE binding.namespace_id=$1 AND binding.identity_subject_id=$2
         AND binding.resource_kind='credential_source' AND binding.resource_id=$3`,
      [namespaceId, agent.servicePrincipalId, sourceId],
    );
    assert.deepEqual(agentGrant.rows, [
      { permissions: [{ action: "operate", resourceKind: "credential_source" }] },
    ]);
    const revision = await app.state.read((view) =>
      view.revisions.findRevision(namespaceId, agent.id, deployed.json().data.id),
    );
    assert.ok(revision?.credentialDeployment);
    assert.deepEqual(
      revision.credentialDeployment.bindings.map(({ bindingRef, sourceRef, consumer }) => ({
        bindingRef,
        sourceId: sourceRef.id,
        consumer,
      })),
      [{ bindingRef: "model", sourceId, consumer: { kind: "model", providerId: "codex" } }],
    );
    assert.deepEqual(
      revision.credentialDeployment.injectionPolicies[0]?.allowedRequests.map(
        ({ binary, host, ports, requestPolicy }) => [binary, host, ports, requestPolicy],
      ),
      [
        [
          grant.binary,
          grant.host,
          [{ from: 443, to: 443 }],
          { type: "http", method: "POST", path: "/backend-api/codex/responses" },
        ],
        [
          grant.binary,
          grant.host,
          [{ from: 443, to: 443 }],
          { type: "http", method: "GET", path: "/backend-api/wham/accounts/check" },
        ],
        [
          grant.binary,
          grant.host,
          [{ from: 443, to: 443 }],
          { type: "http", method: "GET", path: "/backend-api/wham/config/bundle" },
        ],
      ],
    );
    const custody = await app.state.read((view) =>
      view.oauthCredentials.findTokenCustody(namespaceId, sourceId),
    );
    assert.ok(custody);
    const blocked = await app.inject("DELETE", sourcePath);
    assert.equal(blocked.statusCode, 409, blocked.body);
    const retained = await app.state.read((view) =>
      view.credentialSources.findCredentialSource(namespaceId, sourceId),
    );
    assert.ok(
      retained?.ownerCapability === "token_service" && retained.type === "oauth2-refresh-token",
    );
    assert.equal(retained.state, "ready");
    assert.equal(retained.consent.revocationRequestedBy, undefined);
    assert.deepEqual(
      await app.state.read((view) => view.oauthCredentials.findTokenCustody(namespaceId, sourceId)),
      custody,
    );
    assert.equal(
      secretDriver.calls.some(
        (call) => call.operation === "delete" && call.secret.id === custody.secret.id,
      ),
      false,
    );

    // This app fixture disables work recording, so the 202 proves admission only. No Worker
    // ran and this revision never became active. Clear the saved draft references
    // before retiring the unbound Source; the Agent and Configuration remain in the disposable
    // CI Namespace because finalizing those resources requires the separate Worker lifecycle.
    const detached = await app.inject("PATCH", agentPath, {
      configurationId: configuration.json().data.id,
      harnessAuth: null,
      credentialSources: [],
    });
    assert.equal(detached.statusCode, 200, detached.body);
    const removed = await app.inject("DELETE", sourcePath);
    assert.equal(removed.statusCode, 204, removed.body);
  },
);
