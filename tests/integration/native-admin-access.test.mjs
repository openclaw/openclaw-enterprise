import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { once } from "node:events";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import test from "node:test";

import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import {
  callerDenied,
  GENERIC_DENIAL,
  NATIVE_ADMIN_DENIED,
  nativeAdminOffDenied,
} from "../helpers/refusal-text.mjs";
import { createControllerAuth } from "../helpers/password-hasher.mjs";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import {
  InMemoryPlatformState,
  NoActiveAgentRevisionError,
  OpenClawController,
  ResourceConflictError,
} from "../../packages/occ/src/index.ts";
import { signInToControllerApp } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { sharedRsaPrivateKeyPem } from "../fixtures/repository-credentials/shared-keys.mjs";
import { selfSigned } from "../helpers/certificates.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const cookieDomain = "oce.example.test";
const nativeDomain = `agents.${cookieDomain}`;
const publicOrigin = `https://console.${cookieDomain}`;
const authBaseURL = `https://console.${cookieDomain}`;
const nativeGatewayApiKey = `native-gateway-private-key-${randomUUID()}`;

function nativeOriginForAgent(
  installationId,
  namespaceId,
  agentId,
  domain = nativeDomain,
  origin = publicOrigin,
) {
  const publicUrl = new URL(origin);
  publicUrl.hostname = deriveNativeAdminHost(installationId, { namespaceId, id: agentId }, domain);
  return `${publicUrl.protocol}//${publicUrl.host}`;
}

function nativeAdminHarnessConfiguration(nativeOrigin) {
  const configuration = createHarnessConfiguration("openclaw", "gpt-4.1");
  return {
    ...configuration,
    gateway: {
      ...configuration.gateway,
      controlUi: { enabled: true, allowedOrigins: [nativeOrigin] },
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-occ-identity",
          allowUsers: ["occ-workspace-files"],
          deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
        },
        identityScopes: { "occ-workspace-files": ["operator.admin"] },
      },
    },
  };
}

function nativeComputeDriver(upstreamPort, { exclusiveReplacement = false } = {}) {
  return {
    // Kubernetes dedicated revisions stop their predecessors before they start.
    ...(exclusiveReplacement ? { requiresStoppedPredecessors: () => true } : {}),
    id: "native-admin-compute",
    capability: "compute",
    implementation: "native-admin-test-upstream",
    validateHarnessAuth() {},
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async retireRevision() {},
    getGatewayEndpoint(revision) {
      return `wss://localhost:${upstreamPort}/namespaces/${revision.namespaceId}/agents/${revision.agentId}/`;
    },
  };
}

async function startNativeHttpsUpstream(t) {
  const directory = await temporaryDirectory(t, "openclaw-native-admin-upstream-");
  const { key, cert } = await selfSigned(directory, {
    keyPem: sharedRsaPrivateKeyPem("native-admin-upstream"),
    days: 2,
  });

  const requests = [];
  const server = createServer({ key, cert }, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    requests.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (request.url?.includes("/upstream-unavailable")) {
      // OpenClaw's answer when a Gravatar fallback cannot be fetched.
      response.writeHead(502, { "content-type": "application/json" });
      response.end('{"ok":false,"error":{"type":"avatar_upstream_unavailable"}}');
      return;
    }
    if (request.url?.endsWith("/redirect-root")) {
      response.writeHead(302, {
        "content-security-policy": "default-src 'self'",
        location: "/settings/profile?from=redirect",
      });
      response.end();
      return;
    }
    if (request.url?.endsWith("/redirect-external")) {
      response.writeHead(302, {
        location: "https://attacker.example.test/settings",
      });
      response.end();
      return;
    }
    if (request.url?.endsWith("/redirect-reserved")) {
      response.writeHead(302, {
        location: "/__occ/native-admin/bootstrap",
      });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-security-policy": "default-src 'self'",
      "content-type": "text/plain; charset=utf-8",
      "set-cookie": "native_session=must-not-leak; Path=/",
      "x-native-upstream": "reached",
    });
    response.end("native admin upstream\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return { port: address.port, requests, cert };
}

async function createNativeAdminFixture(t, options = {}) {
  const upstream = await startNativeHttpsUpstream(t);
  const fixture = await createConsoleAppFixture(t, {
    ...(options.state === undefined ? {} : { state: options.state }),
    publicOrigin: options.publicOrigin ?? publicOrigin,
    authBaseURL: options.authBaseURL ?? authBaseURL,
    authCookieDomain: options.cookieDomain ?? cookieDomain,
    authSecureCookies: options.authSecureCookies ?? true,
    development: options.development ?? { enabled: false },
    auditSink: options.auditSink,
    ...(options.recordOperations === undefined
      ? {}
      : { recordOperations: options.recordOperations }),
    nativeAdmin: {
      enabled: options.nativeAdminEnabled ?? true,
      domain: options.nativeDomain ?? nativeDomain,
      sharedCookieDomain: options.cookieDomain ?? cookieDomain,
    },
    nativeAdminGatewayApiKey: async () => nativeGatewayApiKey,
    computeDriver: nativeComputeDriver(upstream.port, {
      exclusiveReplacement: options.exclusiveReplacement,
    }),
  });
  await fixture.bootstrap("Native admin access test");
  const namespace = await fixture.createNamespace("Native admin", {
    ready: true,
  });
  const agent = await fixture.createAgent(
    namespace.id,
    "Native admin Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const nativeOrigin = nativeOriginForAgent(
    fixture.controller.installation.id,
    namespace.id,
    agent.id,
    options.nativeDomain ?? nativeDomain,
    options.publicOrigin ?? publicOrigin,
  );
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeAdminHarnessConfiguration(nativeOrigin),
  );
  const revision = await fixture.controller.deployAgent(
    adminPrincipal(fixture).id,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedHarness,
  );
  await fixture.activateRevision(namespace.id, agent.id, revision.id, undefined);
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.desiredRuntimeState, "running");
  const session = await fixture.signIn();
  return {
    fixture,
    upstream,
    namespace,
    agent: current.data,
    revision,
    session,
  };
}

function adminPrincipal(fixture) {
  const principal = fixture.policy.identities.find((identity) => identity.kind === "principal");
  assert.ok(principal, "fixture IAM policy must contain the signed-in administrator");
  return principal;
}

async function nativeStatus({ fixture, namespace, agent }, options = {}) {
  return fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
    options,
  );
}

async function injectJson(fixture, method, url, { headers = {}, body } = {}) {
  return fixture.app.inject({
    method,
    url,
    headers: {
      ...Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function nativeAuthority(native) {
  return new URL(native.origin).host;
}

function sessionCookieName(cookieHeader) {
  const [name] = cookieHeader.split("=", 1);
  assert.ok(name.length > 0, "session cookie header must start with a cookie name");
  return name;
}

async function createAgentPermissionSession(context, label, permissions, bindingScope = {}) {
  const limited = await context.fixture.createAccountWithPolicy(label, (principal) => {
    const roleId = `role-${label}-${randomUUID()}`;
    context.fixture.policy.roles.push({
      id: roleId,
      namespaceId: context.namespace.id,
      permissions,
    });
    context.fixture.policy.bindings.push({
      id: `binding-${label}-${randomUUID()}`,
      namespaceId: context.namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId,
      ...bindingScope,
    });
  });
  return context.fixture.signIn(limited.credentials);
}

async function createReadOperateSession(context, label = "native-admin-read-operate") {
  return createAgentPermissionSession(context, label, [
    { action: "read", resourceKind: "agent" },
    { action: "operate", resourceKind: "agent" },
  ]);
}

async function createExactAgentAdministerSession(context, label = "native-admin-exact-administer") {
  return createAgentPermissionSession(
    context,
    label,
    [{ action: "administer", resourceKind: "agent" }],
    { resourceKind: "agent", resourceId: context.agent.id },
  );
}

function trustLocalUpstreamCertificate(t, cert) {
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, cert]);
  t.after(() => setDefaultCACertificates(previous));
}

test("native admin status requires exact Agent administer and reports lifecycle availability", async (t) => {
  const context = await createNativeAdminFixture(t);

  const available = await nativeStatus(context);
  assert.equal(available.status, 200);
  assert.equal(available.data.status, "available");
  assert.equal(available.data.activeRevisionId, context.revision.id);
  assert.match(available.data.host, new RegExp(`\\.${nativeDomain.replaceAll(".", "\\.")}$`));
  assert.equal(new URL(available.data.url).hostname, available.data.host);
  assert.equal(new URL(available.data.url).pathname, "/");
  assert.equal(available.data.bootstrapUrl, undefined);

  const exactAdministerOnlySession = await createExactAgentAdministerSession(
    context,
    "native-admin-status-exact-administer",
  );
  const exactAvailable = await nativeStatus(context, { session: exactAdministerOnlySession });
  assert.equal(exactAvailable.status, 200);
  assert.equal(exactAvailable.data.status, "available");

  // An IAM outage is a dependency failure, never an Agent lifecycle state: the console must
  // not read it as "unavailable" (deploying) for an Agent the caller may not even administer.
  const authorize = context.fixture.iamDriver.authorize;
  context.fixture.iamDriver.authorize = async () => {
    throw new Error("IAM outage");
  };
  let iamOutage;
  try {
    iamOutage = await nativeStatus(context);
  } finally {
    context.fixture.iamDriver.authorize = authorize;
  }
  assert.equal(iamOutage.status, 503);
  assert.equal(iamOutage.body.error.code, "DEPENDENCY_UNAVAILABLE");

  const limitedSession = await createReadOperateSession(context, "native-admin-reader");
  const denied = await nativeStatus(context, { session: limitedSession });
  assertApiError(denied, 403, "FORBIDDEN");
  // With native admin on, the grant is all the caller lacks.
  assert.equal(
    denied.body.error.message,
    callerDenied("Agent administer", `Agent ${context.agent.id}`),
  );

  const missingStatus = await context.fixture.request(
    "GET",
    `/namespaces/${context.namespace.id}/agents/agt_${randomUUID()}/native-admin`,
  );
  assert.equal(missingStatus.status, 404);
  assert.equal(missingStatus.body.error.code, "NOT_FOUND");

  const stopped = await context.fixture.request(
    "POST",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  const stoppedStatus = await nativeStatus(context);
  assert.equal(stoppedStatus.status, 200);
  assert.equal(stoppedStatus.data.status, "stopped");
  assert.equal(stoppedStatus.data.host, available.data.host);

  // Completed stop reconciliation clears the selected revision but retains historical revisions.
  const cleared = await context.fixture.controller.transact((state) =>
    state.agents.compareAndClearActiveRevision(
      context.namespace.id,
      context.agent.id,
      context.revision.id,
    ),
  );
  assert.equal(cleared.desiredRuntimeState, "stopped");
  assert.equal(cleared.activeRevisionId, undefined);
  const controllerStatus = () =>
    context.fixture.controller.getAdministerableActiveAgentRevision(
      adminPrincipal(context.fixture).id,
      context.namespace.id,
      context.agent.id,
    );
  await assert.rejects(controllerStatus, ResourceConflictError);
  const fullyStopped = await nativeStatus(context, { session: exactAdministerOnlySession });
  assert.equal(fullyStopped.status, 200);
  assert.deepEqual(fullyStopped.data, { status: "stopped" });
  const stillDenied = await nativeStatus(context, { session: limitedSession });
  assertApiError(stillDenied, 403, "FORBIDDEN");
  const serviceKey = await issueServiceKeyForNativeAgent(context);
  const serviceDenied = await injectJson(
    context.fixture,
    "GET",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/native-admin`,
    { headers: { "x-api-key": serviceKey } },
  );
  assert.equal(serviceDenied.statusCode, 403);
  assert.equal(serviceDenied.json().error.code, "FORBIDDEN");
  // The denial tells key holders what to use instead; it names no Agent state.
  assert.equal(
    serviceDenied.json().error.message,
    "Native admin UI requires a signed-in console session; service API keys cannot open it.",
  );

  // Redeployment makes the Agent desired-running before a worker selects the new revision.
  const pending = await context.fixture.deployAgent(context.namespace.id, context.agent.id);
  await assert.rejects(controllerStatus, NoActiveAgentRevisionError);
  const unavailable = await nativeStatus(context, { session: exactAdministerOnlySession });
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.data, { status: "unavailable" });
  await context.fixture.activateRevision(context.namespace.id, context.agent.id, pending.id);
  const restored = await nativeStatus(context, { session: exactAdministerOnlySession });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.status, "available");
  assert.equal(restored.data.activeRevisionId, pending.id);
});

test("native admin status is unavailable while a newer revision replaces the active workload", async (t) => {
  // Without exclusive replacement the active revision keeps serving during a redeploy.
  const shared = await createNativeAdminFixture(t);
  await shared.fixture.deployAgent(shared.namespace.id, shared.agent.id);
  const stillServing = await nativeStatus(shared);
  assert.equal(stillServing.status, 200);
  assert.equal(stillServing.data.status, "available");
  assert.equal(stillServing.data.activeRevisionId, shared.revision.id);

  const context = await createNativeAdminFixture(t, { exclusiveReplacement: true });
  const available = await nativeStatus(context);
  assert.equal(available.data.status, "available");
  // The worker stops the active revision before the newer one starts; if that one fails,
  // the old revision stays recorded as active with nothing serving.
  const replacement = await context.fixture.deployAgent(context.namespace.id, context.agent.id);
  const replacing = await nativeStatus(context);
  assert.equal(replacing.status, 200);
  assert.deepEqual(replacing.data, { status: "unavailable" });
  const agent = await context.fixture.request(
    "GET",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}`,
  );
  assert.equal(agent.data.activeRevisionId, context.revision.id);

  await context.fixture.activateRevision(
    context.namespace.id,
    context.agent.id,
    replacement.id,
    context.revision.id,
  );
  const restored = await nativeStatus(context);
  assert.equal(restored.data.status, "available");
  assert.equal(restored.data.activeRevisionId, replacement.id);
});

test("native admin disabled status still requires exact Agent administer", async (t) => {
  const context = await createNativeAdminFixture(t, { nativeAdminEnabled: false });

  const disabled = await nativeStatus(context);
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.status, "disabled");

  const administerOnlySession = await createExactAgentAdministerSession(
    context,
    "native-admin-disabled-exact-administer",
  );
  const administerOnlyDisabled = await nativeStatus(context, { session: administerOnlySession });
  assert.equal(administerOnlyDisabled.status, 200);
  assert.equal(administerOnlyDisabled.data.status, "disabled");

  const limitedSession = await createReadOperateSession(context, "native-admin-disabled-reader");
  const denied = await nativeStatus(context, { session: limitedSession });
  assertApiError(denied, 403, "FORBIDDEN");
  // With native admin off, the denial also says the grant alone would not open it (finding D762).
  assert.equal(denied.body.error.message, nativeAdminOffDenied(`Agent ${context.agent.id}`));

  const missingStatus = await context.fixture.request(
    "GET",
    `/namespaces/${context.namespace.id}/agents/agt_${randomUUID()}/native-admin`,
  );
  assert.equal(missingStatus.status, 404);
  assert.equal(missingStatus.body.error.code, "NOT_FOUND");
});

async function issueServiceKeyForNativeAgent(context) {
  const principal = {
    id: `native-admin-service-${randomUUID()}`,
    kind: "service_principal",
    namespaceId: context.namespace.id,
  };
  const roleId = `native-admin-service-role-${randomUUID()}`;
  context.fixture.policy.identities.push(principal);
  context.fixture.policy.roles.push({
    id: roleId,
    namespaceId: context.namespace.id,
    permissions: [{ action: "administer", resourceKind: "agent" }],
  });
  context.fixture.policy.bindings.push({
    id: `native-admin-service-binding-${randomUUID()}`,
    namespaceId: context.namespace.id,
    subjectKind: "identity",
    subjectId: principal.id,
    roleId,
    resourceKind: "agent",
    resourceId: context.agent.id,
  });
  const issued = await context.fixture.request("POST", "/api/auth/service-keys", {
    body: {
      servicePrincipalId: principal.id,
      namespaceId: context.namespace.id,
      name: "native-admin-service-key",
    },
  });
  assert.equal(issued.status, 201);
  assert.match(issued.data.key, /^occ_/);
  return issued.data.key;
}

test("native admin shared session configuration validates cookie scope and rejects keys", async (t) => {
  const context = await createNativeAdminFixture(t);
  const status = await nativeStatus(context);
  const cookie = context.session.setCookie.join("\n");
  assert.match(cookie, /(?:__Secure-)?openclaw_occ_shared\.session_token=/);
  assert.match(cookie, /Domain=oce\.example\.test/i);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.doesNotMatch(cookie, /__Host-occ_native_admin=/);

  const serviceKey = await issueServiceKeyForNativeAgent(context);
  for (const deniedHeaders of [
    { "x-api-key": serviceKey },
    { cookie: context.session.cookie, "x-api-key": serviceKey },
  ]) {
    const denied = await injectJson(context.fixture, "GET", "/", {
      headers: {
        host: nativeAuthority(status.data),
        origin: status.data.origin,
        ...deniedHeaders,
      },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.headers["set-cookie"], undefined);
  }

  for (const invalid of [
    {
      label: "public suffix",
      options: {
        publicOrigin: "https://console.example.com",
        nativeDomain: "agents.example.com",
        cookieDomain: "com",
      },
    },
    {
      label: "suffix without DNS-label boundary",
      options: {
        publicOrigin: "https://console.oce.example.test",
        nativeDomain: "agents.oce.example.test",
        cookieDomain: "ce.example.test",
      },
    },
    {
      label: "Agent suffix outside shared cookie domain",
      options: {
        publicOrigin: "https://console.oce.example.test",
        nativeDomain: "agents.other.example.test",
        cookieDomain: "oce.example.test",
      },
    },
  ]) {
    await assert.rejects(
      createNativeAdminFixture(t, invalid.options),
      /COOKIE_DOMAIN|cookie domain|public suffix|Native admin/i,
      `${invalid.label} must fail closed at startup`,
    );
  }
});

test("a copied Agent chat link redirects an activated browser navigation to the configured console without granting access", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const context = await createNativeAdminFixture(t, { auditSink });
  const status = await nativeStatus(context);
  const host = nativeAuthority(status.data);
  const navigation = {
    host,
    accept: "text/html,application/xhtml+xml",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };
  const page = await injectJson(context.fixture, "GET", "/chat/main", {
    headers: { ...navigation, "x-forwarded-host": "attacker.example.test" },
  });
  const key = status.data.host.match(/^agent-([a-f0-9]{32})\./)[1];
  const destination = `${publicOrigin}/console/#native-agent=${key}`;
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, destination);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.ok(page.headers["x-request-id"]);
  assert.equal(page.headers["set-cookie"], undefined);
  // The console opens the native root, not only copied chat links.
  const rootPage = await injectJson(context.fixture, "GET", "/?return=https://attacker.example", {
    headers: navigation,
  });
  assert.equal(rootPage.statusCode, 302);
  assert.equal(rootPage.headers.location, destination);
  const sessionSuffix = "a".repeat(32);
  const sessionPage = await injectJson(
    context.fixture,
    "GET",
    `/chat/main/${sessionSuffix}?private=omitted`,
    { headers: navigation },
  );
  assert.equal(sessionPage.statusCode, 302);
  assert.equal(sessionPage.headers.location, destination);
  const inventedKey = "f".repeat(32);
  const invented = await injectJson(context.fixture, "GET", "/chat/main", {
    headers: {
      ...navigation,
      host: `agent-${inventedKey}.${nativeDomain}`,
      "x-forwarded-host": "attacker.example.test",
    },
  });
  assert.equal(invented.statusCode, 302);
  assert.equal(invented.headers.location, destination.replace(key, inventedKey));

  for (const [method, path, headers] of [
    ["GET", "/chat/main", { host, accept: "application/json" }],
    ["GET", "/chat/main", { host, accept: "text/html", "user-agent": "Slackbot-LinkExpanding" }],
    ["GET", "/chat/main", { ...navigation, "sec-fetch-user": undefined }],
    ["GET", "/chat/main", { ...navigation, host: `agent-${key}.other.${nativeDomain}` }],
    ["GET", "/chat/main", { ...navigation, "sec-fetch-dest": "iframe" }],
    ["GET", "/chat/main", { ...navigation, "sec-fetch-mode": "cors" }],
    ["GET", "/chat/main", { ...navigation, accept: "text/html;q=0,application/json" }],
    ["GET", "/chat/main/not-a-session", navigation],
    ["GET", "/settings", navigation],
    ["GET", "/", { ...navigation, "sec-fetch-mode": "cors" }],
    ["GET", "/", { ...navigation, "sec-fetch-dest": "iframe" }],
    ["GET", "/api/status", navigation],
    ["GET", "/auth/callback", navigation],
    ["GET", "//attacker.example/", navigation],
    ["POST", "/chat/main", navigation],
  ]) {
    const denied = await injectJson(context.fixture, method, path, { headers });
    assert.equal(denied.statusCode, 403, `${method} ${path}`);
    assert.equal(denied.headers.location, undefined);
    assert.match(denied.headers["content-type"], /^application\/json/);
    assert.equal(denied.json().error.code, "FORBIDDEN");
  }
  const limited = await createReadOperateSession(context);
  for (const path of ["/", "/chat/main"]) {
    const unauthorized = await injectJson(context.fixture, "GET", path, {
      headers: { ...navigation, cookie: limited.cookie },
    });
    assert.equal(unauthorized.statusCode, 403);
    assert.equal(unauthorized.headers.location, undefined);
    assert.match(unauthorized.headers["content-type"], /^text\/html/);
    assert.match(unauthorized.body, /Go to your Agents/);
    assert.equal(unauthorized.body.includes(context.agent.id), false);
  }
  const endpoint = `/native-admin/return/${key}`;
  const found = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
  });
  assert.equal(found.statusCode, 200, found.body);
  assert.deepEqual(found.json().data, {
    namespaceId: context.namespace.id,
    agentId: context.agent.id,
  });
  assert.equal(found.headers["cache-control"], "no-store");
  const unknown = await injectJson(
    context.fixture,
    "GET",
    `/native-admin/return/${"f".repeat(32)}`,
    {
      headers: { host: new URL(publicOrigin).host, cookie: limited.cookie },
    },
  );
  const forbidden = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host, cookie: limited.cookie },
  });
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.equal(forbidden.statusCode, 404, forbidden.body);
  assert.deepEqual(unknown.json().error, forbidden.json().error);
  assert.ok(
    auditSink.events.some(
      (event) =>
        event.action === "openclaw.agents.native_admin.return.authorize" &&
        event.requestId === forbidden.json().meta.requestId &&
        event.outcome === "denied",
    ),
  );
  const anonymous = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host },
  });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  const invalid = await injectJson(context.fixture, "GET", "/native-admin/return/not-a-key", {
    headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  const forwarded = await injectJson(context.fixture, "GET", endpoint, {
    headers: {
      host: new URL(publicOrigin).host,
      cookie: context.session.cookie,
      "x-forwarded-host": "attacker.example.test",
    },
  });
  assert.equal(forwarded.statusCode, 403);

  // The detail page is the recovery destination even when no revision is serving.
  const stopped = await context.fixture.request(
    "POST",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  await context.fixture.controller.transact((state) =>
    state.agents.compareAndClearActiveRevision(
      context.namespace.id,
      context.agent.id,
      context.revision.id,
    ),
  );
  const stoppedReturn = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
  });
  assert.equal(stoppedReturn.statusCode, 200, stoppedReturn.body);
  assert.deepEqual(stoppedReturn.json().data, found.json().data);

  // Changing the key must not buy more lookups; another administrator keeps their own budget.
  const burst = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      injectJson(
        context.fixture,
        "GET",
        endpoint.replace(key, index.toString(16).padStart(32, "0")),
        {
          headers: { host: new URL(publicOrigin).host, cookie: limited.cookie },
        },
      ),
    ),
  );
  const throttled = burst.find((response) => response.statusCode === 429);
  assert.ok(
    throttled,
    "expected repeated return lookups to be limited; got " +
      burst.map((response) => response.statusCode).join(", "),
  );
  assert.equal(throttled.json().error.code, "NATIVE_ADMIN_RETURN_RATE_LIMITED");
  assert.ok(Number(throttled.headers["retry-after"]) > 0);
  const independent = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
  });
  assert.equal(independent.statusCode, 200, independent.body);
  assert.equal(context.upstream.requests.length, 0);

  // Expiry of a previously issued cookie takes the same safe route as a missing cookie.
  for (const session of context.fixture.memoryDatabase.session) {
    session.expiresAt = new Date(Date.now() - 1000);
  }
  const expired = await injectJson(context.fixture, "GET", "/", {
    headers: { ...navigation, cookie: context.session.cookie },
  });
  assert.equal(expired.statusCode, 302);
  assert.equal(expired.headers.location, destination);
  const expiredApi = await injectJson(context.fixture, "POST", "/", {
    headers: { ...navigation, cookie: context.session.cookie },
  });
  assert.equal(expiredApi.statusCode, 403);
  assert.equal(expiredApi.headers.location, undefined);

  const renewed = await context.fixture.signIn();
  const resumed = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host, cookie: renewed.cookie },
  });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.deepEqual(resumed.json().data, found.json().data);
});

test("native admin proxy strips browser credentials and preserves the Agent gateway base path", async (t) => {
  const context = await createNativeAdminFixture(t);
  const status = await nativeStatus(context);
  const administerOnlySession = await createExactAgentAdministerSession(
    context,
    "native-admin-proxy-exact-administer",
  );
  const nativeCookie = administerOnlySession.cookie;
  const nativeSessionKey = (
    await injectJson(context.fixture, "GET", "/api/auth/session", {
      headers: { cookie: nativeCookie },
    })
  ).json().data.sessionKey;
  assert.match(nativeSessionKey, /^[A-Za-z0-9_-]{43}$/);

  trustLocalUpstreamCertificate(t, context.upstream.cert);

  const proxied = await injectJson(context.fixture, "GET", "/settings/profile?tab=devices", {
    headers: {
      host: nativeAuthority(status.data),
      origin: status.data.origin,
      cookie: nativeCookie,
      "x-forwarded-for": "203.0.113.1",
      "x-occ-identity": "must-not-forward",
      "x-openclaw-scopes": "must-not-forward",
      "x-safe-client-header": "preserved",
      "x-occ-session-key": nativeSessionKey,
    },
  });
  assert.equal(proxied.statusCode, 200, proxied.body);
  assert.equal(proxied.headers["x-native-upstream"], "reached");
  assert.equal(proxied.headers["set-cookie"], undefined);
  assert.match(String(proxied.headers["content-security-policy"]), /default-src 'self'/);
  assert.match(String(proxied.headers["content-security-policy"]), /worker-src 'none'/);

  assert.equal(context.upstream.requests.length, 1);
  const observed = context.upstream.requests[0];
  assert.equal(
    observed.url,
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/settings/profile?tab=devices`,
  );
  assert.equal(observed.headers.origin, status.data.origin);
  assert.equal(observed.headers["x-safe-client-header"], "preserved");
  assert.equal(observed.headers["x-api-key"], nativeGatewayApiKey);
  for (const header of [
    "authorization",
    "cookie",
    "x-forwarded-for",
    "x-occ-identity",
    "x-occ-session-key",
    "x-openclaw-scopes",
  ]) {
    assert.equal(observed.headers[header], undefined, `${header} must not reach native upstream`);
  }

  const nativeHeaders = {
    host: nativeAuthority(status.data),
    origin: status.data.origin,
    cookie: nativeCookie,
  };
  const nativeCookieName = sessionCookieName(nativeCookie);
  const deniedRequests = [
    { url: "/", headers: { origin: "https://untrusted.example.test" } },
    { url: "/", headers: { origin: "null" } },
    { url: "/", headers: { authorization: "Bearer must-not-forward" } },
    { url: "/", headers: { host: `sibling.${nativeDomain}:9443` } },
    { url: "/", headers: { host: `${status.data.host}:9444` } },
    { url: "/api/auth/get-session", headers: { cookie: "" } },
    { url: "/api/auth/get-session", headers: { cookie: "openclaw_occ.session_token=legacy" } },
    {
      url: "/api/auth/get-session",
      headers: { cookie: `${nativeCookieName}=legacy; ${nativeCookie}` },
    },
    {
      url: "/api/auth/get-session",
      headers: { cookie: `${nativeCookie}; ${nativeCookieName}=legacy` },
    },
    // A session key narrows the shared cookie; a foreign or malformed key is refused.
    { url: "/", headers: { "x-occ-session-key": "A".repeat(43) } },
    { url: "/", headers: { "x-occ-session-key": "malformed" } },
    { url: "/__occ/native-admin/unknown" },
    { url: "/assets/%2e%2e%2fother-agent" },
    { url: "/assets/%252e%252e%252fother-agent" },
    { url: "/assets/%5cother-agent" },
    { url: "/settings", method: "POST", headers: { origin: undefined } },
    { url: "/sw.js", headers: { "service-worker": "script" } },
  ];
  for (const deniedRequest of deniedRequests) {
    const denied = await injectJson(
      context.fixture,
      deniedRequest.method ?? "GET",
      deniedRequest.url,
      {
        headers: { ...nativeHeaders, ...deniedRequest.headers },
      },
    );
    assert.equal(denied.statusCode, 403, `${deniedRequest.url}: ${denied.body}`);
    assert.equal(denied.headers["set-cookie"], undefined);
  }
  assert.equal(
    context.upstream.requests.length,
    1,
    "rejected requests must not reach native gateway",
  );

  // A native-host path that happens to match an OCC route still goes to native.
  const collision = await injectJson(context.fixture, "GET", "/api/auth/get-session", {
    headers: nativeHeaders,
  });
  assert.equal(collision.statusCode, 200);
  assert.equal(collision.body, "native admin upstream\n");
  assert.equal(context.upstream.requests.length, 2);

  // A user photo the Gateway cannot fetch is a missing photo, not a Gateway failure.
  const avatar = await injectJson(
    context.fixture,
    "GET",
    "/api/users/upstream-unavailable/avatar?v=1",
    { headers: nativeHeaders },
  );
  assert.equal(avatar.statusCode, 404, avatar.body);
  assert.equal(avatar.body, "");
  assert.equal(avatar.headers["cache-control"], "no-store");
  assert.equal(context.upstream.requests.length, 3);
  const otherFailure = await injectJson(context.fixture, "GET", "/upstream-unavailable", {
    headers: nativeHeaders,
  });
  assert.equal(otherFailure.statusCode, 502, otherFailure.body);
  assert.match(otherFailure.body, /avatar_upstream_unavailable/);
  assert.equal(context.upstream.requests.length, 4);

  const rootRedirect = await injectJson(context.fixture, "GET", "/redirect-root", {
    headers: nativeHeaders,
  });
  assert.equal(rootRedirect.statusCode, 302, rootRedirect.body);
  assert.equal(
    rootRedirect.headers.location,
    `${status.data.origin}/settings/profile?from=redirect`,
  );
  assert.match(String(rootRedirect.headers["content-security-policy"]), /default-src 'self'/);
  assert.match(String(rootRedirect.headers["content-security-policy"]), /worker-src 'none'/);
  assert.equal(context.upstream.requests.length, 5);

  const externalRedirect = await injectJson(context.fixture, "GET", "/redirect-external", {
    headers: nativeHeaders,
  });
  assert.equal(externalRedirect.statusCode, 502, externalRedirect.body);
  assert.equal(externalRedirect.headers.location, undefined);
  assert.equal(context.upstream.requests.length, 6);

  const reservedRedirect = await injectJson(context.fixture, "GET", "/redirect-reserved", {
    headers: nativeHeaders,
  });
  assert.equal(reservedRedirect.statusCode, 502, reservedRedirect.body);
  assert.equal(reservedRedirect.headers.location, undefined);
  assert.equal(context.upstream.requests.length, 7);

  context.fixture.policy.restrictions.push({
    id: `restriction-native-admin-proxy-${randomUUID()}`,
    namespaceId: context.namespace.id,
    action: "administer",
    resourceKind: "agent",
    resourceId: context.agent.id,
    effect: "deny",
  });
  const iamDenied = await injectJson(context.fixture, "GET", "/settings/profile?after=iam", {
    headers: nativeHeaders,
  });
  assert.equal(iamDenied.statusCode, 403, iamDenied.body);
  // A Restriction reads the same as a missing grant.
  assert.equal(iamDenied.json().error.message, NATIVE_ADMIN_DENIED);
  assert.equal(iamDenied.headers["set-cookie"], undefined);
  assert.equal(
    context.upstream.requests.length,
    7,
    "authorization-denied proxy requests must not reach native gateway",
  );

  // A signed-in person with no platform identity had no grant checked: the refusal names none
  // (finding 2589), and it is decided before the host, so it tells nothing about the Agent.
  const identities = context.fixture.policy.identities;
  const principal = adminPrincipal(context.fixture);
  identities.splice(identities.indexOf(principal), 1);
  const unprovisioned = await injectJson(context.fixture, "GET", "/settings/profile", {
    headers: nativeHeaders,
  });
  assert.equal(unprovisioned.statusCode, 403, unprovisioned.body);
  assert.deepEqual(unprovisioned.json().error, { code: "FORBIDDEN", message: GENERIC_DENIAL });
  identities.push(principal);
  assert.equal(context.upstream.requests.length, 7);
});
test("native admin proxy resolves a host only to the live Agent it names", async (t) => {
  const state = new InMemoryPlatformState();
  const context = await createNativeAdminFixture(t, { state, recordOperations: true });
  const { fixture, namespace, agent, upstream } = context;
  trustLocalUpstreamCertificate(t, upstream.cert);
  const installationId = fixture.controller.installation.id;
  // The installation administrator's session administers every Agent, so each refusal below
  // comes from host resolution, not from IAM.
  const proxied = (namespaceId, agentId) => {
    const origin = nativeOriginForAgent(installationId, namespaceId, agentId);
    return injectJson(fixture, "GET", "/settings/profile", {
      headers: { host: new URL(origin).host, origin, cookie: context.session.cookie },
    });
  };

  const own = await proxied(namespace.id, agent.id);
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(upstream.requests.length, 1);

  const other = await fixture.createNamespace("Native admin other", { ready: true });
  const otherAgent = await fixture.createAgent(
    other.id,
    "Native admin other Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  for (const [label, namespaceId, agentId] of [
    ["an Agent that does not exist", namespace.id, `agt_${randomUUID()}`],
    ["this Agent under another Namespace", other.id, agent.id],
    ["another Namespace's Agent under this Namespace", namespace.id, otherAgent.id],
  ]) {
    const denied = await proxied(namespaceId, agentId);
    assert.equal(denied.statusCode, 403, `${label}: ${denied.body}`);
    // The same text as a caller denied on a live Agent, so a host reveals no Agent.
    assert.deepEqual(denied.json().error, { code: "FORBIDDEN", message: NATIVE_ADMIN_DENIED });
  }
  // Another Namespace's Agent resolves to itself alone; it has no active revision to serve.
  const otherHost = await proxied(other.id, otherAgent.id);
  assert.notEqual(otherHost.statusCode, 200, otherHost.body);
  assert.equal(upstream.requests.length, 1, "no refused host may reach a native gateway");

  // A deleted Agent's host names nothing.
  const deleted = await fixture.request("DELETE", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(deleted.status, 202);
  assert.equal(await state.completeAgentDeletion(namespace.id, agent.id), true);
  const afterDeletion = await proxied(namespace.id, agent.id);
  assert.equal(afterDeletion.statusCode, 403, afterDeletion.body);
  assert.equal(upstream.requests.length, 1);
});

test("native admin status decodes only the revisions it uses", async (t) => {
  // bughunt-69: status and proxy admission decoded every revision of the Agent to find the
  // newest. Seed 64 later revisions of about 0.9 MB each; the newest is the only one read.
  const state = new InMemoryPlatformState();
  const context = await createNativeAdminFixture(t, { state });
  const active = await state.read((view) =>
    view.revisions.findRevision(context.namespace.id, context.agent.id, context.revision.id),
  );
  const large = Object.fromEntries(Array.from({ length: 70_000 }, (_, i) => [`k${i}`, "v"]));
  await state.transact(async (transaction) => {
    for (let number = 2; number <= 65; number += 1) {
      await transaction.revisions.createRevision({
        ...active,
        id: `rev_${randomUUID()}`,
        revision: number,
        configuration: { ...active.configuration, env: { vars: large } },
      });
    }
  });
  const timings = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    const status = await nativeStatus(context);
    timings.push(performance.now() - started);
    assert.equal(status.status, 200);
    assert.equal(status.data.status, "available");
    assert.equal(status.data.activeRevisionId, context.revision.id);
  }
  // Decoding all 65 took about 2.5 s on two CPUs; decoding two takes well under a second.
  const fastest = Math.min(...timings);
  assert.ok(fastest < 1_000, `native admin status took ${Math.round(fastest)} ms`);
});

test("native Agent requests retain their own origin boundary", async (t) => {
  const context = await createNativeAdminFixture(t);
  const status = await nativeStatus(context);
  trustLocalUpstreamCertificate(t, context.upstream.cert);
  const response = await injectJson(context.fixture, "POST", "/settings", {
    headers: {
      host: nativeAuthority(status.data),
      origin: status.data.origin,
      cookie: context.session.cookie,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(context.upstream.requests.length, 1);
});

test("session mutations reject sibling origins before changing Agent or audit state", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const context = await createNativeAdminFixture(t, { auditSink });
  const native = (await nativeStatus(context)).data;
  const agentPath = `/namespaces/${context.namespace.id}/agents/${context.agent.id}`;
  const cookie = context.session.cookie;
  const before = auditSink.events.length;

  // A sibling can submit a bodyless request with the shared cookie without reading it.
  const noCookie = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
    headers: { origin: native.origin, "sec-fetch-site": "same-site" },
  });
  assert.equal(noCookie.statusCode, 401);
  const badOrigins = [
    { origin: native.origin, "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" },
    { origin: "https://other.oce.example.test", "sec-fetch-site": "same-site" },
    {},
    { origin: "null" },
    { origin: `${publicOrigin}/path` },
    { origin: publicOrigin, "sec-fetch-site": "cross-site" },
    { origin: publicOrigin, "sec-fetch-site": "same-site" },
    { origin: publicOrigin, "sec-fetch-site": "invalid" },
  ];
  for (const headers of badOrigins) {
    const response = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
      headers: { cookie, ...headers },
    });
    assert.equal(response.statusCode, 403, `${JSON.stringify(headers)}: ${response.body}`);
    // The refusal says what is missing instead of a generic admission boundary.
    assert.match(response.json().error.message, /^A trusted browser origin is required: /);
  }
  // Reads need no Origin to be admitted; the account route then names the same requirement.
  const accountRead = await injectJson(context.fixture, "GET", "/api/auth/accounts/any-account", {
    headers: { cookie },
  });
  assert.equal(accountRead.statusCode, 403, accountRead.body);
  assert.equal(
    accountRead.json().error.message,
    "A current human session and trusted browser origin are required.",
  );
  for (const path of [
    `${agentPath}/deploy`,
    "/api/auth/accounts",
    "/api/auth/service-keys",
    `/namespaces/${context.namespace.id}/iam/roles`,
  ]) {
    const response = await injectJson(context.fixture, "POST", path, {
      headers: { cookie, origin: native.origin, "sec-fetch-site": "same-site" },
    });
    assert.equal(response.statusCode, 403, `${path}: ${response.body}`);
  }
  assert.equal(auditSink.events.length, before);
  const unchanged = await context.fixture.request("GET", agentPath);
  assert.equal(unchanged.data.desiredRuntimeState, "running");
  const safeRead = await injectJson(context.fixture, "GET", agentPath, { headers: { cookie } });
  assert.equal(safeRead.statusCode, 200);

  const key = await issueServiceKeyForNativeAgent(context);
  const role = context.fixture.policy.roles.find((item) =>
    item.id.startsWith("native-admin-service-role-"),
  );
  role.permissions.push({ action: "operate", resourceKind: "agent" });
  const badKey = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
    headers: { cookie, "x-api-key": "invalid", origin: publicOrigin },
  });
  assert.equal(badKey.statusCode, 401);
  const keyStop = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
    headers: { "x-api-key": key },
  });
  assert.equal(keyStop.statusCode, 202, keyStop.body);
  const deployed = await injectJson(context.fixture, "POST", `${agentPath}/deploy`, {
    headers: { cookie, origin: publicOrigin, "sec-fetch-site": "same-origin" },
  });
  assert.equal(deployed.statusCode, 202, deployed.body);
  const keyFromSibling = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
    headers: { cookie, "x-api-key": key, origin: native.origin, "sec-fetch-site": "same-site" },
  });
  assert.equal(keyFromSibling.statusCode, 202, keyFromSibling.body);
  const stopped = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
    headers: { cookie, origin: publicOrigin },
  });
  assert.equal(stopped.statusCode, 202, stopped.body);
});

test("sign-out requires the console origin for session requests", async (t) => {
  const context = await createNativeAdminFixture(t);
  for (const headers of [
    {},
    { origin: "https://other.oce.example.test" },
    { origin: publicOrigin, "sec-fetch-site": "cross-site" },
  ]) {
    const denied = await injectJson(context.fixture, "POST", "/api/auth/sign-out", {
      headers: { cookie: context.session.cookie, ...headers },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    const session = await injectJson(context.fixture, "GET", "/api/auth/session", {
      headers: { cookie: context.session.cookie },
    });
    assert.equal(session.json().data.authenticated, true);
  }
  const allowed = await injectJson(context.fixture, "POST", "/api/auth/sign-out", {
    headers: {
      cookie: context.session.cookie,
      origin: publicOrigin,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
});

for (const changedField of [undefined, "id", "implementation"]) {
  test(`native admin retains the revision Compute owner after restart: ${changedField ?? "matching"}`, async (t) => {
    const state = new InMemoryPlatformState();
    const context = await createNativeAdminFixture(t, { state });
    const { fixture, upstream, namespace, agent, revision } = context;
    trustLocalUpstreamCertificate(t, upstream.cert);
    const originalCompute = fixture.controller.selectedDriver("compute");
    assert.deepEqual(revision.compute, {
      id: originalCompute.id,
      implementation: originalCompute.implementation,
    });

    // Reopen the same committed revision with a fresh registry, as on controller restart.
    // In particular, changing only implementation must not mutate a registered Driver.
    const controller = new OpenClawController(fixture.controller.installation, {
      state,
      recordOperations: false,
    });
    controller.registerDriver(fixture.iamDriver);
    controller.selectDriver("iam", fixture.iamDriver.id);
    const calls = { endpoint: 0, key: 0 };
    const compute = {
      ...nativeComputeDriver(upstream.port),
      ...(changedField === undefined ? {} : { [changedField]: `replacement-${changedField}` }),
      getGatewayEndpoint(selectedRevision) {
        calls.endpoint += 1;
        assert.equal(selectedRevision.id, revision.id);
        return originalCompute.getGatewayEndpoint(selectedRevision);
      },
    };
    controller.registerDriver(compute);
    controller.selectDriver("compute", compute.id);
    const auth = createControllerAuth({
      installationId: controller.installation.id,
      mode: "development",
      baseURL: authBaseURL,
      secret: `native-restart-test-${randomUUID()}-${randomUUID()}`,
      memoryDatabase: fixture.memoryDatabase,
      sharedCookieDomain: cookieDomain,
      secureCookies: true,
    });
    const logLines = [];
    const app = createFastifyApp({
      controller,
      iamDriver: fixture.iamDriver,
      auth,
      logger: createOccLogger({
        component: "native-admin-test",
        level: "info",
        destination: {
          write(chunk) {
            logLines.push(...String(chunk).split("\n").filter(Boolean));
            return true;
          },
        },
      }),
      auditSink: new InMemoryAuditSink(),
      development: { enabled: false },
      resolveHarness: resolveApprovedHarness,
      publicOrigin,
      nativeAdmin: { enabled: true, domain: nativeDomain, sharedCookieDomain: cookieDomain },
      nativeAdminGatewayApiKey: async () => {
        calls.key += 1;
        return nativeGatewayApiKey;
      },
    });
    t.after(() => app.close());
    const session = await signInToControllerApp(app, fixture.credentials);
    const headers = { cookie: session.cookie, origin: publicOrigin };
    const status = await injectJson(
      { app },
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
      { headers },
    );
    const host = new URL(nativeOriginForAgent(controller.installation.id, namespace.id, agent.id))
      .host;
    const proxy = await injectJson({ app }, "GET", "/", {
      headers: { ...headers, host, origin: `https://${host}` },
    });
    // A console poll repeats the status read; the mismatch is still warned only once.
    const repeated = await injectJson(
      { app },
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
      { headers },
    );
    assert.equal(repeated.statusCode, status.statusCode);
    const mismatchLogs = logLines
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "native_admin.compute_owner_mismatch");
    if (changedField === undefined) {
      assert.deepEqual(mismatchLogs, []);
      assert.equal(status.statusCode, 200);
      assert.equal(status.json().data.status, "available");
      assert.equal(proxy.statusCode, 200);
      assert.equal(proxy.body, "native admin upstream\n");
      assert.equal(calls.endpoint, 3);
      assert.equal(calls.key, 1);
      assert.equal(upstream.requests.length, 1);
    } else {
      assert.equal(status.statusCode, 503);
      assert.equal(status.json().error.code, "DEPENDENCY_UNAVAILABLE");
      // Agent-host admission retains its existing non-disclosing refusal envelope.
      assert.equal(proxy.statusCode, 403);
      assert.deepEqual(calls, { endpoint: 0, key: 0 });
      assert.equal(upstream.requests.length, 0);
      // One operator line names both owners and the recovery; no endpoint or key.
      assert.equal(mismatchLogs.length, 1, logLines.join("\n"));
      const [logged] = mismatchLogs;
      assert.equal(logged.severity, "WARN");
      assert.deepEqual(
        {
          namespaceId: logged.namespaceId,
          agentId: logged.agentId,
          revisionId: logged.revisionId,
          revisionCompute: logged.revisionCompute,
          selectedCompute: logged.selectedCompute,
        },
        {
          namespaceId: namespace.id,
          agentId: agent.id,
          revisionId: revision.id,
          revisionCompute: revision.compute,
          selectedCompute: { id: compute.id, implementation: compute.implementation },
        },
      );
      assert.match(logged.message, /Select that Compute Driver again/);
      const text = logLines.join("\n");
      assert.ok(!text.includes(nativeGatewayApiKey), "the gateway key must not be logged");
      assert.ok(
        !text.includes(originalCompute.getGatewayEndpoint(revision)),
        "the private gateway endpoint must not be logged",
      );
    }
    const persisted = await state.read((view) =>
      view.revisions.findRevision(namespace.id, agent.id, revision.id),
    );
    assert.deepEqual(persisted, revision, "selection changes must not rewrite the active revision");
  });
}

test("a browser Back to a denied Agent gateway stays 403 and links to the console", async (t) => {
  const context = await createNativeAdminFixture(t);
  const status = await nativeStatus(context);
  const host = nativeAuthority(status.data);
  const limited = await createReadOperateSession(context);
  const navigation = {
    host,
    accept: "text/html,application/xhtml+xml",
    cookie: limited.cookie,
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };
  const page = await injectJson(context.fixture, "GET", "/", { headers: navigation });
  assert.equal(page.statusCode, 403);
  assert.equal(page.headers.location, undefined);
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["set-cookie"], undefined);
  assert.match(page.body, /Go to your Agents/);
  assert.match(page.body, new RegExp(`href="${publicOrigin}/console/agents"`));
  assert.equal(page.body.includes(context.agent.id), false);
  assert.equal(page.body.includes(status.data.host), false);

  const api = await injectJson(context.fixture, "GET", "/", {
    headers: { host, accept: "application/json", cookie: limited.cookie },
  });
  assert.equal(api.statusCode, 403);
  assert.match(api.headers["content-type"], /^application\/json/);
  // The JSON refusal names the grant but not the Agent, which the host named, not the caller.
  assert.deepEqual(api.json().error, { code: "FORBIDDEN", message: NATIVE_ADMIN_DENIED });
});
