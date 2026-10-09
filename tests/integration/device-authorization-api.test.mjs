import assert from "node:assert/strict";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  createDeviceCredentialDrivers,
  DEVICE_ACCESS_TOKEN,
  DEVICE_ACCOUNT_ID,
} from "../helpers/device-credential-gateway.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { bindRole, grantRole } from "../helpers/iam-grants.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

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

async function createFixture(t, { logger, ...gatewayOptions } = {}) {
  const clock = createControlledClock();
  const auditSink = new InMemoryAuditSink();
  const secretDriver = createTestSecretDriver();
  const { gateway, refresh } = createDeviceCredentialDrivers({
    now: () => clock.wallNow(),
    ...gatewayOptions,
  });
  const fixture = await createConsoleAppFixture(t, {
    auditSink,
    secretDriver,
    credentialGatewayDriver: gateway,
    logger,
    now: () => new Date(clock.wallNow()),
    // The existing Console fixture admits revisions without executing Compute.
    // Selecting a Sandbox satisfies source admission, not runtime injection proof.
    sandboxDriver: {
      id: "device-test-sandbox",
      capability: "sandbox",
      implementation: "test-admission-only",
      facets: ["networking", "filesystem", "process"],
      async cleanup() {},
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Device login", { ready: true });
  fixture.controller.registerDriver(gateway);
  fixture.controller.selectDriver("credential_gateway", gateway.id);
  fixture.controller.registerDriver(refresh);
  fixture.controller.selectDriver("credential_refresh", refresh.id);
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const originalFetch = globalThis.fetch;
  const requests = [];
  // Only the external Gateway service and catalog HTTP are simulated. Fastify,
  // authentication, IAM, OCC, source storage, and the hosted Plugin Driver are real.
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const address = new URL(url);
    if (address.hostname === "127.0.0.1") {
      return originalFetch(url, options);
    }
    requests.push(address.href);
    assert.equal(
      address.origin,
      "https://chatgpt.com",
      "OCC must not exchange or refresh OAuth tokens",
    );
    assert.equal(options.headers.Authorization, `Bearer ${DEVICE_ACCESS_TOKEN}`);
    assert.equal(options.headers["ChatGPT-Account-ID"], DEVICE_ACCOUNT_ID);
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
    gateway,
    refresh,
    auditSink,
    requests,
    responses,
    clock,
    path: `/namespaces/${namespace.id}/agents/device-authorizations`,
    pluginsPath: `/namespaces/${namespace.id}/agents/plugins`,
    sourcesPath: `/namespaces/${namespace.id}/credential-sources`,
    async start(path = this.path, session) {
      const response = await request("POST", path, {
        body: { harnessId: "codex" },
        ...(session === undefined ? {} : { session }),
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.data.status, "pending");
      assert.equal(response.data.source, undefined, "a pending login cannot be bound to an Agent");
      return response.data;
    },
    async poll(login, path = this.path, session) {
      return request("POST", `${path}/${login.session.id}/poll`, {
        body: {},
        ...(session === undefined ? {} : { session }),
      });
    },
    async stored(login) {
      const secret = await fixture.controller.transact((unit) =>
        unit.secrets.findSecret(namespace.id, login.session.id),
      );
      return JSON.parse(secretDriver.valueFor(secret));
    },
  };
}

function assertNoCredentials(fixture) {
  const publicOutput = JSON.stringify([fixture.responses, fixture.auditSink.events]);
  for (const value of [DEVICE_ACCESS_TOKEN, "device-private-handle-"]) {
    assert.equal(
      publicOutput.includes(value),
      false,
      "HTTP responses and audit must not expose private credential material",
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

async function readyLogin(fixture, path) {
  const login = await fixture.start(path);
  await fixture.clock.advance(5000);
  const response = await fixture.poll(login, path);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.data.status, "ready");
  return response.data;
}

test("Gateway device login saves a source-backed Agent and reuses discovery after closing its login", async (t) => {
  let approved = false;
  const fixture = await createFixture(t, { approve: async () => approved });
  const login = await fixture.start();
  assertDeviceAudit(fixture, "start");
  assert.equal(login.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(login.intervalSeconds, 5);
  assert.equal((await fixture.poll(login)).data.status, "pending");
  assert.equal(
    fixture.gateway.calls.some((call) => call.operation === "pollDeviceAuthorization"),
    false,
  );
  const audited = fixture.auditSink.events.length;
  await fixture.clock.advance(5000);
  assert.equal((await fixture.poll(login)).data.status, "pending");
  assert.equal(
    fixture.auditSink.events.length,
    audited,
    "pending polls are not audited transitions",
  );
  approved = true;
  await fixture.clock.advance(5000);
  const ready = (await fixture.poll(login)).data;
  assert.equal(ready.status, "ready");
  assert.equal(ready.source.kind, "credential_source");
  assertDeviceAudit(fixture, "poll");
  const stored = await fixture.stored(login);
  assert.equal(stored.sourceId, ready.source.id);
  assert.equal(stored.version, 2);
  assert.equal(stored.credentialGatewayId, fixture.gateway.id);
  assert.equal(stored.credentialRefreshId, fixture.refresh.id);
  assert.equal(stored.privateState, undefined);
  assert.equal(stored.credential, undefined);
  assert.equal(JSON.stringify(stored).includes(DEVICE_ACCESS_TOKEN), false);

  const list = await fixture.request("POST", fixture.pluginsPath, {
    body: { credentialSource: ready.source, q: "knowledge" },
  });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.data.plugins[0].remoteId, plugin.id);
  const details = await fixture.request("POST", `${fixture.pluginsPath}/details`, {
    body: { credentialSource: ready.source, pluginId: plugin.id },
  });
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.equal(details.data.tools[0].id, "fixture-app/search");

  const harnessAuth = { method: "credential_source", sourceId: ready.source.id };
  const agent = await fixture.createAgent(
    fixture.namespace.id,
    "OAuth Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    { executionMode: "dedicated", harnessAuth, credentialSources: [{ sourceId: ready.source.id }] },
  );
  fixture.policy.identities.push({
    id: agent.servicePrincipalId,
    kind: "service_principal",
    namespaceId: agent.namespaceId,
    agentId: agent.id,
  });
  grantRole(fixture.policy, agent.servicePrincipalId, {
    id: "agent-source",
    namespaceId: fixture.namespace.id,
    permissions: { credential_source: ["operate"] },
    resource: ready.source,
  });
  const plugins = {
    [details.data.id]: { enabled: true, tools: { "fixture-app/search": { enabled: true } } },
  };
  const updated = await fixture.updateAgent(fixture.namespace.id, agent.id, {
    configurationId: agent.configurationId,
    plugins,
  });
  const revision = await fixture.deployAgent(fixture.namespace.id, agent.id);
  assert.deepEqual(updated.harnessAuth, harnessAuth);
  assert.deepEqual(revision.harnessAuth, harnessAuth);
  assert.deepEqual(revision.plugins.plugins, plugins);
  fixture.responses.push(agent, updated, revision);

  // Closing the UI login erases only its opaque handle. The source remains usable
  // by the saved Agent without another login, including after the handle expires.
  const closed = await fixture.request("DELETE", `${fixture.path}/${login.session.id}`);
  assert.equal(closed.status, 204);
  assertDeviceAudit(fixture, "cancel");
  assert.equal((await fixture.poll(login)).status, 409);
  await fixture.clock.advance(24 * 60 * 60 * 1000);
  const saved = await fixture.request(
    "POST",
    `/namespaces/${fixture.namespace.id}/agents/${agent.id}/plugins`,
    { body: { q: "knowledge" } },
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.data.plugins[0].remoteId, plugin.id);
  assert.equal(
    fixture.gateway.calls.filter((call) => call.operation === "startDeviceAuthorization").length,
    1,
  );
  assert.equal(fixture.gateway.sources.get(ready.source.id), "ready");
  assert.equal(
    fixture.gateway.calls.some((call) => call.operation === "removeSource"),
    false,
  );
  const sources = await fixture.request("GET", fixture.sourcesPath);
  assert.equal(sources.data[0].id, ready.source.id);
  assert.deepEqual(sources.data[0].secrets, {});
  assertNoCredentials(fixture);
});

test("login handles are actor and Agent scoped while source discovery uses exact Namespace operate grants", async (t) => {
  const fixture = await createFixture(t);
  const account = await fixture.createAccountWithPolicy("other-actor", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "reader-role",
      namespaceId: fixture.namespace.id,
      permissions: { namespace: ["read"] },
    });
  });
  const otherSession = await fixture.signIn(account.credentials);
  assert.equal(
    (
      await fixture.request("POST", fixture.path, {
        session: otherSession,
        body: { harnessId: "codex" },
      })
    ).status,
    403,
  );
  assert.deepEqual(fixture.gateway.calls, []);
  bindRole(fixture.policy, account.principal.id, {
    id: "other-admin-binding",
    roleId: fixture.policy.roles[0].id,
  });
  const login = await readyLogin(fixture);
  const before = fixture.gateway.calls.length;
  assert.equal((await fixture.poll(login, fixture.path, otherSession)).status, 404);
  assert.equal(
    (
      await fixture.request("DELETE", `${fixture.path}/${login.session.id}`, {
        session: otherSession,
      })
    ).status,
    404,
  );
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
    { executionMode: "dedicated", harnessAuth: null },
  );
  const agentPath = `/namespaces/${fixture.namespace.id}/agents/${agent.id}/device-authorizations`;
  assert.equal((await fixture.poll(login, agentPath)).status, 404);
  const embedded = await fixture.createAgent(
    fixture.namespace.id,
    "Embedded Agent",
    createHarnessConfiguration("openclaw", "gpt-5.1"),
    { executionMode: "embedded", harnessAuth: null },
  );
  assert.equal(
    (
      await fixture.request(
        "POST",
        `/namespaces/${fixture.namespace.id}/agents/${embedded.id}/device-authorizations`,
        { body: { harnessId: "codex" } },
      )
    ).status,
    501,
  );
  assert.equal(
    (await fixture.request("POST", fixture.path, { body: { harnessId: "openclaw" } })).status,
    501,
  );
  assert.equal(
    fixture.gateway.calls.length,
    before,
    "scope refusals must precede external operations",
  );

  // A CredentialSource is independently managed: an authorized second operator
  // may discover with it, but cannot take over the first actor's login handle.
  assert.equal(
    (
      await fixture.request("POST", fixture.pluginsPath, {
        session: otherSession,
        body: { credentialSource: login.source, q: "knowledge" },
      })
    ).status,
    200,
  );
  fixture.policy.bindings = fixture.policy.bindings.filter(
    (binding) => binding.id !== "other-admin-binding",
  );
  grantRole(fixture.policy, account.principal.id, {
    id: "agent-creator",
    namespaceId: fixture.namespace.id,
    permissions: { agent: ["create"] },
  });
  const denied = await fixture.request("POST", fixture.pluginsPath, {
    session: otherSession,
    body: { credentialSource: login.source, q: "knowledge" },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));

  for (const [credentialSource, status] of [
    [{ ...login.source, namespaceId: otherNamespace.id }, 400],
    [{ ...login.source, id: `cs_${crypto.randomUUID()}` }, 409],
  ]) {
    const refused = await fixture.request("POST", fixture.pluginsPath, {
      body: { credentialSource, q: "knowledge" },
    });
    assert.equal(refused.status, status, JSON.stringify(refused.body));
  }
  const savedLogin = await readyLogin(fixture, agentPath);
  assertDeviceAudit(fixture, "start", agent.id);
  assertDeviceAudit(fixture, "poll", agent.id);
  assert.equal((await fixture.poll(savedLogin)).status, 404);
  assert.equal(
    (await fixture.request("DELETE", `${agentPath}/${savedLogin.session.id}`)).status,
    204,
  );
  assertDeviceAudit(fixture, "cancel", agent.id);
  assertNoCredentials(fixture);
});

test("one poll owns Gateway completion and cancellation fences its result without revoking the source", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const fixture = await createFixture(t, {
    beforePoll: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const login = await fixture.start();
  const sourceId = (await fixture.stored(login)).sourceId;
  await fixture.clock.advance(5000);
  const first = fixture.poll(login);
  await Promise.race([
    entered.promise,
    first.then(() => assert.fail("poll must reach the Gateway")),
  ]);
  const second = await fixture.poll(login);
  assert.equal(second.status, 200);
  assert.equal(second.data.status, "pending");
  assert.equal(
    fixture.gateway.calls.filter((call) => call.operation === "pollDeviceAuthorization").length,
    1,
  );
  assert.equal(
    (await fixture.request("DELETE", `${fixture.path}/${login.session.id}`)).status,
    204,
  );
  release.resolve();
  assert.equal((await first).status, 409);
  const stored = await fixture.stored(login);
  assert.equal(stored.phase, "cancelled");
  assert.equal(stored.privateState, undefined);
  assert.equal((await fixture.poll(login)).status, 409);
  assert.equal(
    fixture.gateway.sources.get(sourceId),
    "ready",
    "external completion remains managed after its UI handle is cancelled",
  );
  assert.equal(
    fixture.gateway.calls.some((call) => call.operation === "removeSource"),
    false,
  );
  assert.equal((await fixture.request("GET", fixture.sourcesPath)).data[0].id, sourceId);
  assertNoCredentials(fixture);
});

test("a changed Refresh Driver cannot receive an existing device login handle", async (t) => {
  const fixture = await createFixture(t);
  const login = await fixture.start();
  const original = await fixture.stored(login);
  await fixture.clock.advance(5000);
  // Selecting another owner must fail before forwarding the old owner's opaque handle.
  const replacement = { ...fixture.refresh, id: "replacement-device-refresh" };
  fixture.controller.registerDriver(replacement);
  fixture.controller.selectDriver("credential_refresh", replacement.id);
  const before = [...fixture.gateway.calls];

  const refused = await fixture.poll(login);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.deepEqual(fixture.gateway.calls, before, "owner mismatch must precede external calls");
  const stored = await fixture.stored(login);
  assert.equal(stored.version, 2);
  assert.equal(stored.credentialGatewayId, fixture.gateway.id);
  assert.equal(stored.credentialRefreshId, fixture.refresh.id);
  assert.equal(stored.sourceId, original.sourceId);
  assert.equal(stored.phase, "pending");
  assert.equal(stored.privateState, original.privateState);
  assert.equal((await fixture.request("GET", fixture.sourcesPath)).data[0].id, original.sourceId);
  assertNoCredentials(fixture);
});

test("a Refresh Driver change during polling fences completion without replaying the exchange", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const fixture = await createFixture(t, {
    beforePoll: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const login = await fixture.start();
  const original = await fixture.stored(login);
  await fixture.clock.advance(5000);
  const pending = fixture.poll(login);
  await Promise.race([
    entered.promise,
    pending.then(() => assert.fail("poll must reach the original Refresh Driver")),
  ]);
  // The original owner can finish externally, but a changed selection cannot authorize
  // committing that result to the login session. The separately managed source survives.
  const replacement = { ...fixture.refresh, id: "replacement-device-refresh" };
  fixture.controller.registerDriver(replacement);
  fixture.controller.selectDriver("credential_refresh", replacement.id);
  release.resolve();
  const refused = await pending;
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  const stored = await fixture.stored(login);
  assert.equal(stored.version, 2);
  assert.equal(stored.credentialGatewayId, fixture.gateway.id);
  assert.equal(stored.credentialRefreshId, fixture.refresh.id);
  assert.equal(stored.sourceId, original.sourceId);
  assert.equal(
    stored.phase,
    "polling",
    "an externally completed grant cannot mark this session ready",
  );
  assert.equal(fixture.gateway.sources.get(original.sourceId), "ready");
  assert.equal((await fixture.request("GET", fixture.sourcesPath)).data[0].id, original.sourceId);
  assert.equal(
    fixture.gateway.calls.some(
      ({ operation }) => operation === "removeRefresh" || operation === "removeSource",
    ),
    false,
  );

  // Restoring the original selection still must not re-enter a consumed exchange.
  fixture.controller.selectDriver("credential_refresh", fixture.refresh.id);
  const repeated = await fixture.poll(login);
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.data.status, "pending");
  assert.equal(repeated.data.source, undefined);
  assert.equal(
    fixture.gateway.calls.filter(({ operation }) => operation === "pollDeviceAuthorization").length,
    1,
  );
  assertNoCredentials(fixture);
});

test("expiry closes the login handle without removing the ready source or its discovery", async (t) => {
  const fixture = await createFixture(t);
  const login = await readyLogin(fixture);
  await fixture.clock.advance(24 * 60 * 60 * 1000);
  assert.equal((await fixture.poll(login)).status, 409);
  const stored = await fixture.stored(login);
  assert.equal(stored.phase, "cancelled");
  assert.equal(stored.privateState, undefined);
  const discovery = await fixture.request("POST", fixture.pluginsPath, {
    body: { credentialSource: login.source, q: "knowledge" },
  });
  assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
  // Explicit source deletion, unlike session closure, invokes external removal.
  assert.equal(
    (await fixture.request("DELETE", `${fixture.sourcesPath}/${login.source.id}`)).status,
    204,
  );
  assert.equal(fixture.gateway.sources.has(login.source.id), false);
  assert.equal(
    (
      await fixture.request("POST", fixture.pluginsPath, {
        body: { credentialSource: login.source, q: "knowledge" },
      })
    ).status,
    409,
  );
  assertNoCredentials(fixture);
});

test("missing login-session fencing refuses device authorization before Gateway I/O", async (t) => {
  const fixture = await createFixture(t);
  const login = await fixture.start();
  const before = fixture.gateway.calls.length;
  delete fixture.secretDriver.compareAndSwap;
  assert.equal(
    (await fixture.request("POST", fixture.path, { body: { harnessId: "codex" } })).status,
    501,
  );
  await fixture.clock.advance(5000);
  const poll = await fixture.poll(login);
  assert.equal(poll.status, 501);
  assert.equal(
    poll.body.error.message,
    "Device authorization is unavailable for the Secret Driver.",
  );
  assert.equal(fixture.gateway.calls.length, before);
});

test("a failed Gateway login start retains a manageable source and sanitizes the failure", async (t) => {
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
  const fixture = await createFixture(t, {
    logger,
    startError: new Error(`external service unavailable: ${DEVICE_ACCESS_TOKEN}`),
  });
  const response = await fixture.request("POST", fixture.path, { body: { harnessId: "codex" } });
  assert.equal(response.status, 503, JSON.stringify(response.body));
  assert.equal(response.body.error.code, "DEPENDENCY_UNAVAILABLE");
  const warning = lines.find((line) => line.event === "device_authorization.start_failed");
  assert.equal(warning?.severity, "WARN");
  assert.equal(warning.reason, "unavailable");
  assert.equal(JSON.stringify(lines).includes(DEVICE_ACCESS_TOKEN), false);
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${fixture.namespace.id}/secrets`)).data,
    [],
  );
  const sources = await fixture.request("GET", fixture.sourcesPath);
  assert.equal(
    sources.data.length,
    1,
    "an uncertain external login remains visible for source management",
  );
  // Source deletion fences uncertain external registration before final removal.
  await fixture.clock.advance(71_000);
  assert.equal(
    (await fixture.request("DELETE", `${fixture.sourcesPath}/${sources.data[0].id}`)).status,
    204,
  );
  assert.equal(fixture.gateway.sources.size, 0);
  assertNoCredentials(fixture);
});
