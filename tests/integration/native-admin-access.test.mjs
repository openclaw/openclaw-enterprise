import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import test from "node:test";

import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { DependencyUnavailableError, ResourceConflictError } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

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

function nativeComputeDriver(upstreamPort) {
  return {
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
  const directory = await mkdtemp(join(tmpdir(), "openclaw-native-admin-upstream-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "tls.key");
  const certPath = join(directory, "tls.crt");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);

  const requests = [];
  const cert = await readFile(certPath, "utf8");
  const server = createServer({ key: await readFile(keyPath), cert }, async (request, response) => {
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
    publicOrigin: options.publicOrigin ?? publicOrigin,
    authBaseURL: options.authBaseURL ?? authBaseURL,
    authCookieDomain: options.cookieDomain ?? cookieDomain,
    authSecureCookies: options.authSecureCookies ?? true,
    nativeAdmin: {
      enabled: options.nativeAdminEnabled ?? true,
      domain: options.nativeDomain ?? nativeDomain,
      sharedCookieDomain: options.cookieDomain ?? cookieDomain,
    },
    nativeAdminGatewayApiKey: async () => nativeGatewayApiKey,
    computeDriver: nativeComputeDriver(upstream.port),
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

  const limitedSession = await createReadOperateSession(context, "native-admin-reader");
  const denied = await nativeStatus(context, { session: limitedSession });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");

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
  assert.equal(stillDenied.status, 403);
  assert.equal(stillDenied.body.error.code, "FORBIDDEN");
  const serviceKey = await issueServiceKeyForNativeAgent(context);
  const serviceDenied = await injectJson(
    context.fixture,
    "GET",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/native-admin`,
    { headers: { "x-api-key": serviceKey } },
  );
  assert.equal(serviceDenied.statusCode, 403);
  assert.equal(serviceDenied.json().error.code, "FORBIDDEN");

  // Redeployment makes the Agent desired-running before a worker selects the new revision.
  const pending = await context.fixture.deployAgent(context.namespace.id, context.agent.id);
  await assert.rejects(controllerStatus, DependencyUnavailableError);
  const unavailable = await nativeStatus(context, { session: exactAdministerOnlySession });
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.data, { status: "unavailable" });
  await context.fixture.activateRevision(context.namespace.id, context.agent.id, pending.id);
  const restored = await nativeStatus(context, { session: exactAdministerOnlySession });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.status, "available");
  assert.equal(restored.data.activeRevisionId, pending.id);
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
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");

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

test("native admin proxy strips browser credentials and preserves the Agent gateway base path", async (t) => {
  const context = await createNativeAdminFixture(t);
  const status = await nativeStatus(context);
  const administerOnlySession = await createExactAgentAdministerSession(
    context,
    "native-admin-proxy-exact-administer",
  );
  const nativeCookie = administerOnlySession.cookie;

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
  assert.equal(context.upstream.requests.length, 3);

  const externalRedirect = await injectJson(context.fixture, "GET", "/redirect-external", {
    headers: nativeHeaders,
  });
  assert.equal(externalRedirect.statusCode, 502, externalRedirect.body);
  assert.equal(externalRedirect.headers.location, undefined);
  assert.equal(context.upstream.requests.length, 4);

  const reservedRedirect = await injectJson(context.fixture, "GET", "/redirect-reserved", {
    headers: nativeHeaders,
  });
  assert.equal(reservedRedirect.statusCode, 502, reservedRedirect.body);
  assert.equal(reservedRedirect.headers.location, undefined);
  assert.equal(context.upstream.requests.length, 5);

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
  assert.equal(iamDenied.headers["set-cookie"], undefined);
  assert.equal(
    context.upstream.requests.length,
    5,
    "authorization-denied proxy requests must not reach native gateway",
  );
});
