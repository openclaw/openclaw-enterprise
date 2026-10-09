import assert from "node:assert/strict";
import test from "node:test";
import { createOpenShellBackend } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { OpenShellCredentialRefreshDriver } from "../../apps/controller/src/drivers/credential-refresh/openshell.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

function jwt(payload) {
  return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
}

test("Console device login completes through the paired OpenShell Refresh Driver without exposing its grant", async (t) => {
  const clock = createControlledClock();
  const providers = new Map();
  const operations = [];
  const expirationTime = new Date(Date.now() + 3_600_000).toISOString();
  const initialAccess = jwt({ exp: Math.floor(Date.parse(expirationTime) / 1000) });
  const initialRefresh = "synthetic-device-refresh-private";
  const managedAccess = "synthetic-managed-access-private";
  let status;
  // Only issuer HTTP and OpenShell transport are simulated. Fastify, IAM, OCC,
  // both production Drivers, response parsing, handoff, and session fencing are real.
  // This checks orchestration/custody; the real-gateway lane proves actual minting.
  const client = {
    async getProviderProfile() {},
    async importProviderProfile() {},
    async createProvider(input) {
      operations.push("register");
      assert.deepEqual(input.credentials, {});
      providers.set(input.name, { ...input, config: {}, resourceVersion: "1" });
    },
    async getProvider(_workspace, name) {
      return providers.get(name);
    },
    async configureProviderRefresh(input) {
      operations.push("configure");
      assert.equal(input.credentialKey, "CODEX_ACCESS_TOKEN");
      assert.deepEqual(input.material, {
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        refresh_token: initialRefresh,
      });
      assert.match(input.requestId, /^[0-9a-f-]{36}$/);
      status = { status: "configured" };
      return status;
    },
    async updateProviderCredentials() {
      assert.fail("the device exchange token must not be seeded through the Credential Gateway");
    },
    async updateProviderConfig(_workspace, name, config) {
      operations.push("metadata");
      const provider = { ...providers.get(name), config, resourceVersion: "2" };
      providers.set(name, provider);
      return provider;
    },
    async getProviderRefreshStatus() {
      return status;
    },
    async rotateProviderCredential(_workspace, _name, key, requestId) {
      operations.push("rotate");
      assert.equal(key, "CODEX_ACCESS_TOKEN");
      assert.match(requestId, /^[0-9a-f-]{36}$/);
      status = { status: "refreshed", expirationTime };
      return status;
    },
    async getProviderCredential() {
      operations.push("retrieve");
      return { value: managedAccess, expirationTime };
    },
    close() {},
  };
  const backend = createOpenShellBackend(
    {
      id: "openshell",
      implementation: "openshell",
      configuration: { endpoint: "https://fixture.invalid:443" },
      drivers: {
        sandbox: "openshell-sandbox",
        credential_gateway: "credential-gateway-openshell",
        credential_refresh: "credential-refresh-openshell",
      },
    },
    { gatewayClient: client },
  );
  const gateway = new OpenShellCredentialGatewayDriver(
    { binaries: ["/usr/local/bin/codex"] },
    { backend },
  );
  const refresh = new OpenShellCredentialRefreshDriver({}, { backend });
  const compute = createTestKubernetesComputeDriver("openshell-device-api-compute");
  Object.assign(compute, {
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async resolveSandboxNamespace(namespace) {
      return { ...namespace, name: "oauth-api-fixture" };
    },
  });
  const secrets = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, {
    computeDriver: compute,
    secretDriver: secrets,
    now: () => new Date(clock.wallNow()),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("OAuth API proof", { ready: true });
  for (const driver of [gateway, refresh]) {
    fixture.controller.registerDriver(driver);
    fixture.controller.selectDriver(driver.capability, driver.id);
  }
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  let polls = 0;
  let loseExchangeResponse = false;
  const pollFailures = [
    new Response(null, { status: 429 }),
    new Response(null, { status: 503 }),
    new TypeError("synthetic polling connection failure"),
  ];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(url).hostname === "127.0.0.1") {
      return originalFetch(url, init);
    }
    assert.equal(init.method, "POST");
    if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
      return Response.json({
        device_auth_id: "synthetic-device-handle",
        user_code: "TEST-CODE",
        interval: "5",
      });
    }
    if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
      polls += 1;
      const failure = pollFailures.shift();
      if (failure instanceof Error) {
        throw failure;
      }
      if (failure !== undefined) {
        return failure;
      }
      return Response.json({
        authorization_code: "synthetic-code",
        code_verifier: "synthetic-verifier",
      });
    }
    assert.equal(url, "https://auth.openai.com/oauth/token");
    assert.equal(new URLSearchParams(init.body).get("grant_type"), "authorization_code");
    exchanges += 1;
    if (loseExchangeResponse) {
      // The issuer may already have consumed its code; this result must not be replayed.
      throw new TypeError("synthetic lost token-exchange response");
    }
    return Response.json({
      access_token: initialAccess,
      refresh_token: initialRefresh,
      id_token: jwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "synthetic-account",
          chatgpt_plan_type: "plus",
        },
      }),
    });
  });
  const path = `/namespaces/${namespace.id}/agents/device-authorizations`;
  const started = await fixture.request("POST", path, { body: { harnessId: "codex" } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.data.status, "pending");
  assert.deepEqual(
    operations,
    ["register"],
    "a device source has no refresh grant at registration",
  );
  assert.equal(exchanges, 0);
  const pendingSources = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/credential-sources`,
  );
  const pendingSource = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/credential-sources/${pendingSources.data[0].id}`,
  );
  assert.equal(pendingSource.status, 200, JSON.stringify(pendingSource.body));
  assert.equal(pendingSource.data.status.refresh.state, "pending");
  assert.equal(pendingSource.data.status.refresh.recoveryAction, undefined);
  assert.deepEqual(operations, ["register"], "reading a pending source must not configure or mint");
  const pollPath = `${path}/${started.data.session.id}/poll`;
  // These failures precede authorization-code acquisition. Preserve the same login and
  // source, with OCC's existing interval fence, until the issuer can answer.
  const failedPolls = pollFailures.length;
  for (let attempt = 0; attempt < failedPolls; attempt += 1) {
    await clock.advance(5000);
    const pending = await fixture.request("POST", pollPath, { body: {} });
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.data.status, "pending");
    assert.equal(pending.data.session.id, started.data.session.id);
    assert.equal(polls, attempt + 1);
    assert.equal(exchanges, 0, "retryable polling must not redeem an authorization code");
    assert.deepEqual(operations, ["register"], "polling must not configure or mint");
    const observedPolls = polls;
    assert.equal((await fixture.request("POST", pollPath, { body: {} })).data.status, "pending");
    assert.equal(polls, observedPolls, "OCC still throttles repeated polls");
  }
  await clock.advance(5000);
  const completed = await fixture.request("POST", pollPath, { body: {} });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.data.status, "ready");
  assert.equal(exchanges, 1);
  assert.equal(operations.filter((operation) => operation === "configure").length, 1);
  assert.equal(operations.filter((operation) => operation === "rotate").length, 1);
  const settled = [...operations];
  assert.equal((await fixture.request("POST", pollPath, { body: {} })).data.status, "ready");
  assert.deepEqual(operations, settled, "re-polling a completed session must not reseed or mint");
  const source = completed.data.source;
  const sources = await fixture.request("GET", `/namespaces/${namespace.id}/credential-sources`);
  assert.equal(sources.data.length, 1);
  assert.equal(sources.data[0].id, source.id);
  const agent = await fixture.createAgent(
    namespace.id,
    "OAuth Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    {
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    },
  );
  assert.equal(agent.harnessAuth.sourceId, source.id);
  const updated = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/credential-sources/${source.id}`,
    { body: {} },
  );
  assert.equal(updated.status, 409, JSON.stringify(updated.body));
  assert.deepEqual(operations, settled);
  const sessionRecord = await fixture.controller.transact((unit) =>
    unit.secrets.findSecret(namespace.id, started.data.session.id),
  );
  const session = JSON.parse(secrets.valueFor(sessionRecord));
  assert.equal(session.credentialGatewayId, gateway.id);
  assert.equal(session.credentialRefreshId, refresh.id);
  assert.equal(session.privateState, undefined);
  const publicAndStored = JSON.stringify([
    started.body,
    completed.body,
    sources.body,
    agent,
    session,
  ]);
  // A transport failure after the token POST is a different boundary: cancel the
  // new login, erase its private state, and never redeem its code a second time.
  loseExchangeResponse = true;
  const interrupted = await fixture.request("POST", path, { body: { harnessId: "codex" } });
  assert.equal(interrupted.status, 200);
  await clock.advance(5000);
  const interruptedPath = `${path}/${interrupted.data.session.id}/poll`;
  const failed = await fixture.request("POST", interruptedPath, { body: {} });
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(exchanges, 2);
  const failedRecord = await fixture.controller.transact((unit) =>
    unit.secrets.findSecret(namespace.id, interrupted.data.session.id),
  );
  const failedSession = JSON.parse(secrets.valueFor(failedRecord));
  assert.equal(failedSession.phase, "cancelled");
  assert.equal(failedSession.privateState, undefined);
  assert.equal((await fixture.request("POST", interruptedPath, { body: {} })).status, 409);
  assert.equal(exchanges, 2, "an uncertain token exchange is never replayed");
  for (const credential of [
    initialAccess,
    initialRefresh,
    managedAccess,
    "synthetic-device-handle",
  ]) {
    assert.equal(
      publicAndStored.includes(credential),
      false,
      "responses and session storage must contain no credential material",
    );
  }
});
