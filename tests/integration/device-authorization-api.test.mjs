import assert from "node:assert/strict";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const accessToken = "oauth-access-private-fixture";
const refreshToken = "oauth-refresh-private-fixture";
const deviceId = "oauth-device-private-fixture";
const authorizationCode = "oauth-code-private-fixture";
const idToken = [
  "eyJhbGciOiJSUzI1NiJ9",
  Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "workspace-fixture" },
    }),
  ).toString("base64url"),
  "signature-fixture",
].join(".");
const plugin = {
  id: "remote-fixture",
  name: "fixture",
  scope: "GLOBAL",
  status: "ENABLED",
  installation_policy: "AVAILABLE",
  release: {
    display_name: "Fixture",
    description: "Search shared knowledge.",
    interface: {},
    requires_local_executor: false,
    app_ids: ["fixture-app"],
    app_manifest: null,
    skills: [],
    mcp_servers: [],
  },
};

async function createFixture(t, { approve = async () => true, exchange = async () => {} } = {}) {
  const clock = createControlledClock();
  const auditSink = new InMemoryAuditSink();
  const secretDriver = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, {
    auditSink,
    secretDriver,
    now: () => new Date(clock.wallNow()),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Device login", { ready: true });
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const originalFetch = globalThis.fetch;
  const requests = [];
  // Only provider HTTP is simulated. Fastify, session authentication, IAM, OCC,
  // the native device protocol, and the hosted Plugin Driver run unchanged.
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const address = new URL(url);
    if (address.hostname === "127.0.0.1") {
      return originalFetch(url, options);
    }
    requests.push(address.href);
    if (address.href === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
      return Response.json({ device_auth_id: deviceId, user_code: "CODE-12345", interval: "5" });
    }
    if (address.href === "https://auth.openai.com/api/accounts/deviceauth/token") {
      return (await approve())
        ? Response.json({
            authorization_code: authorizationCode,
            code_verifier: "verifier-fixture",
          })
        : new Response(null, { status: 403 });
    }
    if (address.href === "https://auth.openai.com/oauth/token") {
      await exchange();
      return Response.json({
        id_token: idToken,
        access_token: accessToken,
        refresh_token: refreshToken,
      });
    }
    assert.equal(
      address.origin,
      "https://chatgpt.com",
      "unexpected provider operation, including refresh or revocation",
    );
    assert.equal(options.headers.Authorization, `Bearer ${accessToken}`);
    assert.equal(options.headers["ChatGPT-Account-ID"], "workspace-fixture");
    assert.equal(options.headers["OAI-Product-Sku"], "codex");
    if (address.pathname === "/backend-api/ps/plugins/search") {
      assert.equal(address.searchParams.get("q"), "knowledge");
      return Response.json({ plugins: [plugin], pagination: { next_page_token: null } });
    }
    if (address.pathname === "/backend-api/ps/plugins/remote-fixture") {
      return Response.json(plugin);
    }
    assert.equal(address.pathname, "/backend-api/ps/apps/batch");
    return Response.json({
      apps: [
        {
          id: "fixture-app",
          status: "ENABLED",
          tools: [{ name: "search", is_enabled: true, is_read_only: true }],
        },
      ],
    });
  });
  const responses = [];
  const request = async (...args) => {
    const response = await fixture.request(...args);
    responses.push(response.body);
    return response;
  };
  return {
    ...fixture,
    request,
    namespace,
    secretDriver,
    pluginDriver: driver,
    auditSink,
    requests,
    responses,
    clock,
    path: `/namespaces/${namespace.id}/agents/device-authorizations`,
    pluginsPath: `/namespaces/${namespace.id}/agents/plugins`,
    async start(path = this.path, session) {
      const response = await request("POST", path, {
        body: { harnessId: "codex" },
        ...(session === undefined ? {} : { session }),
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.data.status, "pending");
      return response.data;
    },
    async poll(login, path = this.path, session) {
      return request("POST", `${path}/${login.source.id}/poll`, {
        body: {},
        ...(session === undefined ? {} : { session }),
      });
    },
    async stored(login) {
      return fixture.controller.transact((unit) =>
        unit.secrets.findSecret(namespace.id, login.source.id),
      );
    },
  };
}

function assertNoCredentials(fixture) {
  const publicOutput = JSON.stringify([fixture.responses, fixture.auditSink.events]);
  for (const value of [accessToken, refreshToken, idToken, deviceId, authorizationCode]) {
    assert.equal(
      publicOutput.includes(value),
      false,
      "HTTP responses and audit must not expose credential material",
    );
  }
}

function assertDeviceAudit(fixture, operation, agentId) {
  const event = fixture.auditSink.events.findLast(
    (event) => event.action === `openclaw.agents.device_authorization.${operation}`,
  );
  assert.equal(event?.kind, "mutation");
  assert.equal(event.outcome, "success");
  assert.equal(event.authorization.action, agentId === undefined ? "create" : "update");
  assert.deepEqual(event.authorization.resource, {
    kind: "agent",
    id: agentId ?? fixture.namespace.id,
    namespaceId: fixture.namespace.id,
  });
}

test("device login configures plugins and admits its opaque Secret reference in an Agent revision", async (t) => {
  let approved = false;
  const fixture = await createFixture(t, { approve: async () => approved });
  const login = await fixture.start();
  assertDeviceAudit(fixture, "start");
  assert.equal(login.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(login.intervalSeconds, 5);
  const audited = fixture.auditSink.events.length;
  assert.equal((await fixture.poll(login)).data.status, "pending");
  assert.equal(
    fixture.requests.length,
    1,
    "polling before the provider interval must not call upstream",
  );
  await fixture.clock.advance(5000);
  assert.equal((await fixture.poll(login)).data.status, "pending");
  // Pending polls are not state transitions; only the start and the ready result are audited.
  assert.equal(fixture.auditSink.events.length, audited);
  approved = true;
  await fixture.clock.advance(5000);
  const ready = await fixture.poll(login);
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.data.status, "ready");
  assertDeviceAudit(fixture, "poll");
  const secret = await fixture.stored(login);
  const savedSession = JSON.parse(fixture.secretDriver.valueFor(secret));
  const nativeAuth = JSON.parse(savedSession.credential).auth;
  assert.deepEqual(nativeAuth.tokens, {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: "workspace-fixture",
  });

  // The Plugin Driver receives the access token and identity, never the refresh token.
  const discoveryInputs = [];
  for (const method of ["discoverCatalog", "getCatalogPlugin"]) {
    const original = fixture.pluginDriver[method].bind(fixture.pluginDriver);
    t.mock.method(fixture.pluginDriver, method, (input, signal) => {
      discoveryInputs.push(JSON.stringify(input));
      return original(input, signal);
    });
  }
  const list = await fixture.request("POST", fixture.pluginsPath, {
    body: { oauthLogin: login.source, q: "knowledge" },
  });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.data.plugins[0].remoteId, plugin.id);
  const details = await fixture.request("POST", `${fixture.pluginsPath}/details`, {
    body: { oauthLogin: login.source, pluginId: plugin.id },
  });
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.equal(details.data.tools[0].id, "fixture-app/search");
  assert.equal(discoveryInputs.length, 2);
  for (const input of discoveryInputs) {
    assert.equal(input.includes(accessToken), true);
    assert.equal(input.includes(refreshToken), false);
  }

  const agent = await fixture.createAgent(
    fixture.namespace.id,
    "OAuth Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    {
      executionMode: "dedicated",
      harnessAuth: { method: "oauth", source: login.source },
    },
  );
  fixture.grantAgentSecretOperate(agent, login.source);
  const plugins = {
    [details.data.id]: { enabled: true, tools: { "fixture-app/search": { enabled: true } } },
  };
  const updated = await fixture.updateAgent(fixture.namespace.id, agent.id, {
    configurationId: agent.configurationId,
    plugins,
  });
  const revision = await fixture.deployAgent(fixture.namespace.id, agent.id);
  assert.deepEqual(updated.harnessAuth, { method: "oauth", source: login.source });
  assert.deepEqual(revision.harnessAuth, { method: "oauth", source: login.source });
  assert.deepEqual(revision.plugins.plugins, plugins);
  fixture.responses.push(agent, updated, revision);

  // The runtime's consumed tombstone is its external storage result; actual
  // Kubernetes handoff is covered by Compute Driver tests, not this HTTP fixture.
  await fixture.secretDriver.update(
    secret,
    JSON.stringify({
      kind: "harness_device_authorization",
      version: 1,
      harnessId: "codex",
      namespaceId: fixture.namespace.id,
      agentId: agent.id,
      phase: "consumed",
      volumeUid: "volume-fixture",
    }),
  );
  const before = fixture.requests.length;
  const consumed = await fixture.request("POST", fixture.pluginsPath, {
    body: { oauthLogin: login.source, q: "knowledge" },
  });
  assert.equal(consumed.status, 409);
  assert.equal((await fixture.poll(login)).status, 409);
  assert.equal(
    fixture.requests.length,
    before,
    "consumed credentials must fail before provider I/O",
  );
  assertNoCredentials(fixture);
});

test("device login is bound to its initiating actor, Namespace, and exact Agent scope", async (t) => {
  const fixture = await createFixture(t);
  const account = await fixture.createAccountWithPolicy("other-actor", (principal) => {
    fixture.policy.roles.push({
      id: "reader-role",
      namespaceId: fixture.namespace.id,
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    fixture.policy.bindings.push({
      id: "reader-binding",
      namespaceId: fixture.namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "reader-role",
    });
  });
  const otherSession = await fixture.signIn(account.credentials);
  const deniedStart = await fixture.request("POST", fixture.path, {
    session: otherSession,
    body: { harnessId: "codex" },
  });
  assert.equal(deniedStart.status, 403);
  assert.deepEqual(fixture.requests, []);
  // Even another authorized administrator cannot operate the initiating actor's login.
  fixture.policy.bindings.push({
    id: "other-admin-binding",
    subjectKind: "identity",
    subjectId: account.principal.id,
    roleId: fixture.policy.roles[0].id,
  });
  const login = await fixture.start();
  const before = fixture.requests.length;
  assert.equal((await fixture.poll(login, fixture.path, otherSession)).status, 404);
  assert.equal(
    (
      await fixture.request("DELETE", `${fixture.path}/${login.source.id}`, {
        session: otherSession,
      })
    ).status,
    404,
  );
  const deniedDiscovery = await fixture.request("POST", fixture.pluginsPath, {
    session: otherSession,
    body: { oauthLogin: login.source, q: "knowledge" },
  });
  assert.equal(deniedDiscovery.status, 404);
  const otherNamespace = await fixture.createNamespace("Other Namespace", { ready: true });
  assert.equal(
    (await fixture.poll(login, `/namespaces/${otherNamespace.id}/agents/device-authorizations`))
      .status,
    404,
  );
  const agent = await fixture.createAgent(
    fixture.namespace.id,
    "Exact Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    { executionMode: "dedicated" },
  );
  const agentPath = `/namespaces/${fixture.namespace.id}/agents/${agent.id}/device-authorizations`;
  assert.equal((await fixture.poll(login, agentPath)).status, 404);

  // An embedded Agent cannot acquire or use a Codex login even when its operator
  // has full authority and supplies an otherwise valid login Secret reference.
  const embedded = await fixture.createAgent(
    fixture.namespace.id,
    "Embedded Agent",
    createHarnessConfiguration("openclaw", "gpt-5.1"),
    { executionMode: "embedded" },
  );
  const embeddedPath = `/namespaces/${fixture.namespace.id}/agents/${embedded.id}`;
  const unsupportedLogin = await fixture.request("POST", `${embeddedPath}/device-authorizations`, {
    body: { harnessId: "codex" },
  });
  assert.equal(unsupportedLogin.status, 501);
  assert.equal(unsupportedLogin.body.error.message, "Device login requires a dedicated Agent.");
  const unsupportedDiscovery = await fixture.request("POST", `${embeddedPath}/plugins`, {
    body: { oauthLogin: login.source, q: "knowledge" },
  });
  assert.equal(unsupportedDiscovery.status, 501);
  // Another Harness is a permanent refusal, not a retryable provider outage.
  const otherHarness = await fixture.request("POST", fixture.path, {
    body: { harnessId: "openclaw" },
  });
  assert.equal(otherHarness.status, 501);
  assert.equal(
    otherHarness.body.error.message,
    "Device login is available only for the Codex Harness.",
  );
  assert.equal(fixture.requests.length, before);

  const savedLogin = await fixture.start(agentPath);
  assertDeviceAudit(fixture, "start", agent.id);
  assert.equal((await fixture.poll(savedLogin)).status, 404);
  await fixture.clock.advance(5000);
  const ready = await fixture.poll(savedLogin, agentPath);
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.data.status, "ready");
  assertDeviceAudit(fixture, "poll", agent.id);
  const discovery = await fixture.request(
    "POST",
    `/namespaces/${fixture.namespace.id}/agents/${agent.id}/plugins`,
    { body: { oauthLogin: savedLogin.source, q: "knowledge" } },
  );
  assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
  // A login reference in another Namespace is an invalid request; a missing one stays not-found.
  for (const [oauthLogin, status, code, message] of [
    [
      { ...savedLogin.source, namespaceId: `ns_${crypto.randomUUID()}` },
      400,
      "INVALID_REQUEST",
      "Secret references cannot cross Namespaces.",
    ],
    [{ ...savedLogin.source, id: `sec_${crypto.randomUUID()}` }, 404, "NOT_FOUND", undefined],
  ]) {
    const refused = await fixture.request(
      "POST",
      `/namespaces/${fixture.namespace.id}/agents/${agent.id}/plugins`,
      { body: { oauthLogin, q: "knowledge" } },
    );
    const label = JSON.stringify(refused.body);
    assert.equal(refused.status, status, label);
    assert.equal(refused.body.error.code, code, label);
    if (message !== undefined) {
      assert.equal(refused.body.error.message, message, label);
    }
  }
  const discarded = await fixture.rawRequest("DELETE", `${agentPath}/${savedLogin.source.id}`, {
    headers: authenticatedHeaders(await fixture.signIn(), { origin: fixture.origin }),
  });
  assert.equal(discarded.response.status, 204);
  assertDeviceAudit(fixture, "cancel", agent.id);
  assertNoCredentials(fixture);
});

test("one poll owns the exchange and cancellation fences its late completion without upstream revocation", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const fixture = await createFixture(t, {
    exchange: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const login = await fixture.start();
  await fixture.clock.advance(5000);
  const first = fixture.poll(login);
  await Promise.race([
    entered.promise,
    first.then(() => assert.fail("poll must begin its token exchange")),
  ]);
  const second = await fixture.poll(login);
  assert.equal(second.status, 200);
  assert.equal(second.data.status, "pending");
  assert.equal(fixture.requests.filter((url) => url.endsWith("/deviceauth/token")).length, 1);
  assert.equal(fixture.requests.filter((url) => url.endsWith("/oauth/token")).length, 1);

  const discarded = await fixture.rawRequest("DELETE", `${fixture.path}/${login.source.id}`, {
    headers: authenticatedHeaders(await fixture.signIn(), { origin: fixture.origin }),
  });
  assert.equal(discarded.response.status, 204);
  assert.equal(discarded.text, "");
  assertDeviceAudit(fixture, "cancel");
  release.resolve();
  const late = await first;
  assert.equal(late.status, 409);
  const saved = JSON.parse(fixture.secretDriver.valueFor(await fixture.stored(login)));
  assert.equal(saved.phase, "cancelled");
  assert.equal(saved.credential, undefined);
  assert.equal(saved.privateState, undefined);
  assert.equal((await fixture.poll(login)).status, 409);
  const discovery = await fixture.request("POST", fixture.pluginsPath, {
    body: { oauthLogin: login.source, q: "knowledge" },
  });
  assert.equal(discovery.status, 409);
  assert.equal(
    fixture.requests.length,
    3,
    "discarding a login must neither refresh nor revoke its upstream session",
  );
  assertNoCredentials(fixture);
});

test("an expired device login erases its provider material when next touched", async (t) => {
  const fixture = await createFixture(t);
  const login = await fixture.start();
  const sealed = await fixture.start();
  await fixture.clock.advance(5000);
  assert.equal((await fixture.poll(login)).data.status, "ready");
  assert.equal((await fixture.poll(sealed)).data.status, "ready");
  await fixture.clock.advance(24 * 60 * 60 * 1000);

  assert.equal((await fixture.poll(login)).status, 409);
  const erased = JSON.parse(fixture.secretDriver.valueFor(await fixture.stored(login)));
  assert.equal(erased.phase, "cancelled");
  assert.equal(erased.credential, undefined);
  assert.equal(erased.privateState, undefined);
  const discovery = await fixture.request("POST", fixture.pluginsPath, {
    body: { oauthLogin: login.source, q: "knowledge" },
  });
  assert.equal(discovery.status, 409);
  const discarded = await fixture.rawRequest("DELETE", `${fixture.path}/${login.source.id}`, {
    headers: authenticatedHeaders(await fixture.signIn(), { origin: fixture.origin }),
  });
  assert.equal(discarded.response.status, 204);

  // A source the runtime has sealed refuses the swap; it stays unusable and unchanged here.
  const before = fixture.secretDriver.valueFor(await fixture.stored(sealed));
  t.mock.method(fixture.secretDriver, "compareAndSwap", async () => false);
  assert.equal((await fixture.poll(sealed)).status, 409);
  assert.equal(fixture.secretDriver.valueFor(await fixture.stored(sealed)), before);
  assertNoCredentials(fixture);
});

test("device login names the Driver that cannot hold a login session", async (t) => {
  const fixture = await createFixture(t);
  const login = await fixture.start();
  const before = fixture.requests.length;
  // compareAndSwap is optional in the Secret Driver contract (the bundled Kubernetes
  // Driver implements it; another Driver may not). Without it OCC cannot
  // fence a login session, so both start and poll refuse permanently and name which
  // Driver is missing the capability.
  delete fixture.secretDriver.compareAndSwap;
  const start = await fixture.request("POST", fixture.path, { body: { harnessId: "codex" } });
  assert.equal(start.status, 501, JSON.stringify(start.body));
  assert.equal(
    start.body.error.message,
    "Device authorization is unavailable for the selected Drivers.",
  );
  // Past the provider interval, a poll would otherwise call upstream.
  await fixture.clock.advance(5000);
  const poll = await fixture.poll(login);
  assert.equal(poll.status, 501, JSON.stringify(poll.body));
  assert.equal(
    poll.body.error.message,
    "Device authorization is unavailable for the Secret Driver.",
  );
  assert.equal(fixture.requests.length, before, "a refused login must not contact the provider");
});

test("a device login start that cannot reach the sign-in service says so and logs the cause", async (t) => {
  const lines = [];
  const logger = createOccLogger({
    component: "occ-api",
    level: "info",
    destination: {
      write(chunk) {
        lines.push(
          ...String(chunk)
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
        return true;
      },
    },
  });
  const fixture = await createConsoleAppFixture(t, { logger });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Device login egress", { ready: true });
  const originalFetch = globalThis.fetch;
  const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
    code: "ECONNREFUSED",
  });
  // The chart's default network policy: the API Pod cannot connect to the sign-in service.
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (new URL(url).hostname === "127.0.0.1") {
      return originalFetch(url, options);
    }
    throw new TypeError("fetch failed", { cause: refused });
  });
  const response = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/device-authorizations`,
    { body: { harnessId: "codex" } },
  );
  assert.equal(response.status, 503, JSON.stringify(response.body));
  assert.equal(response.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(
    response.body.error.message,
    "OCC could not reach the sign-in service at auth.openai.com. An operator must allow HTTPS egress from the API Pods to it (Helm api.modelDiscoveryCidrs or the cluster's egress policy), then try again.",
  );
  const warning = lines.find((line) => line.event === "device_authorization.start_failed");
  assert.ok(warning, "the API logs why device login could not start");
  assert.equal(warning.severity, "WARN");
  assert.equal(warning.reason, "unreachable");
  assert.equal(warning.failure, "ECONNREFUSED");
  assert.equal(warning.host, "auth.openai.com");
  assert.equal(JSON.stringify(lines).includes("10.0.0.1"), false);
  // Nothing was stored for a login that never started.
  const secrets = await fixture.request("GET", `/namespaces/${namespace.id}/secrets`);
  assert.deepEqual(secrets.data, []);
});
