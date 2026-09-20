import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import test from "node:test";

import { MemoryNativeAdminExchangeStore } from "../../apps/controller/src/auth/native-admin-exchange.ts";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";

const nativeDomain = "native.example.test";
const publicOrigin = "https://127.0.0.1:9443";
const nativeCookieSecret = `native-admin-cookie-secret-${randomUUID()}-${randomUUID()}`;
const nativeGatewayApiKey = `native-gateway-private-key-${randomUUID()}`;

function urlSafe(value) {
  return value.toString("base64url");
}

function challenge(verifier) {
  return urlSafe(createHash("sha256").update(verifier).digest());
}

function nativeOriginForAgent(installationId, namespaceId, agentId) {
  const publicUrl = new URL(publicOrigin);
  publicUrl.hostname = deriveNativeAdminHost(
    installationId,
    { namespaceId, id: agentId },
    nativeDomain,
  );
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

async function createNativeAdminFixture(t) {
  const upstream = await startNativeHttpsUpstream(t);
  const exchangeStore = new MemoryNativeAdminExchangeStore();
  const fixture = await createConsoleAppFixture(t, {
    publicOrigin,
    nativeAdmin: { enabled: true, domain: nativeDomain },
    nativeAdminExchangeStore: exchangeStore,
    nativeAdminCookieSecret: nativeCookieSecret,
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
  return {
    fixture,
    upstream,
    namespace,
    agent: current.data,
    revision,
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

function injectedSetCookie(response) {
  const value = response.headers["set-cookie"];
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined ? [] : [String(value)];
}

function nativeAuthority(native) {
  return new URL(native.origin).host;
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
  assert.equal(new URL(available.data.bootstrapUrl).hostname, available.data.host);

  const limited = await context.fixture.createAccountWithPolicy(
    "native-admin-reader",
    (principal) => {
      context.fixture.policy.roles.push({
        id: `role-native-admin-read-operate-${randomUUID()}`,
        namespaceId: context.namespace.id,
        permissions: [
          { action: "read", resourceKind: "agent" },
          { action: "operate", resourceKind: "agent" },
        ],
      });
      context.fixture.policy.bindings.push({
        id: `binding-native-admin-read-operate-${randomUUID()}`,
        namespaceId: context.namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: context.fixture.policy.roles.at(-1).id,
      });
    },
  );
  const limitedSession = await context.fixture.signIn(limited.credentials);
  const denied = await nativeStatus(context, { session: limitedSession });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");

  const stopped = await context.fixture.request(
    "POST",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  const stoppedStatus = await nativeStatus(context);
  assert.equal(stoppedStatus.status, 200);
  assert.equal(stoppedStatus.data.status, "stopped");
  assert.equal(stoppedStatus.data.host, available.data.host);
});

test("native admin launch uses the real session, CSRF boundary, and one-use callback", async (t) => {
  const context = await createNativeAdminFixture(t);
  const status = await nativeStatus(context);
  const verifier = `verifier-${randomUUID()}`;
  const launchBody = {
    state: `state-${randomUUID()}`,
    challenge: challenge(verifier),
    host: status.data.host,
    revisionId: context.revision.id,
  };
  const launchPath = `/namespaces/${context.namespace.id}/agents/${context.agent.id}/native-admin/launch`;

  const crossSite = await context.fixture.request("POST", launchPath, {
    headers: { origin: publicOrigin, "sec-fetch-site": "cross-site" },
    body: launchBody,
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.body.error.code, "FORBIDDEN");

  const launched = await context.fixture.request("POST", launchPath, {
    headers: { origin: publicOrigin },
    body: launchBody,
  });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  const callback = new URL(launched.data.url);
  assert.equal(callback.hostname, status.data.host);
  assert.equal(callback.pathname, "/__occ/native-admin/callback");

  const redeemed = await injectJson(context.fixture, "POST", callback.pathname, {
    headers: {
      host: nativeAuthority(status.data),
      origin: status.data.origin,
    },
    body: {
      code: callback.searchParams.get("code"),
      state: launchBody.state,
      verifier,
    },
  });
  assert.equal(redeemed.statusCode, 200, redeemed.body);
  const setCookies = injectedSetCookie(redeemed);
  const nativeCookie = setCookies.join("\n");
  assert.match(nativeCookie, /__Host-occ_native_admin=/);
  assert.match(nativeCookie, /HttpOnly/i);
  assert.match(nativeCookie, /Secure/i);
  assert.match(nativeCookie, /SameSite=Lax/i);
  assert.match(nativeCookie, /Path=\//i);
  const maxAge = Number(nativeCookie.match(/Max-Age=(\d+)/i)?.[1]);
  assert.ok(maxAge > 60, "native admin cookie must expire with the parent session");

  const replayed = await injectJson(context.fixture, "POST", callback.pathname, {
    headers: {
      host: nativeAuthority(status.data),
      origin: status.data.origin,
    },
    body: {
      code: callback.searchParams.get("code"),
      state: launchBody.state,
      verifier,
    },
  });
  assert.equal(replayed.statusCode, 403);

  // Each rejected redemption burns its own code; browser binding is not replayable.
  for (const invalid of [
    { label: "state", body: { state: "wrong-state" } },
    { label: "verifier", body: { verifier: "wrong-verifier" } },
    { label: "origin", headers: { origin: "https://untrusted.example.test" } },
    { label: "host", headers: { host: `sibling.${nativeDomain}:9443` } },
  ]) {
    const next = await context.fixture.request("POST", launchPath, {
      headers: { origin: publicOrigin },
      body: launchBody,
    });
    assert.equal(next.status, 200);
    const redemption = {
      code: new URL(next.data.url).searchParams.get("code"),
      state: launchBody.state,
      verifier,
    };
    const headers = { host: nativeAuthority(status.data), origin: status.data.origin };
    const denied = await injectJson(context.fixture, "POST", callback.pathname, {
      headers: { ...headers, ...invalid.headers },
      body: { ...redemption, ...invalid.body },
    });
    assert.equal(denied.statusCode, 403, `${invalid.label}: ${denied.body}`);
    assert.equal(denied.headers["set-cookie"], undefined);
    const retry = await injectJson(context.fixture, "POST", callback.pathname, {
      headers,
      body: redemption,
    });
    assert.equal(retry.statusCode, 403, `${invalid.label} must consume its code`);
  }
});

test("native admin proxy strips browser credentials and preserves the Agent gateway base path", async (t) => {
  const context = await createNativeAdminFixture(t);
  const status = await nativeStatus(context);
  const validState = `state-${randomUUID()}`;
  const validVerifier = `verifier-${randomUUID()}`;
  const launched = await context.fixture.request(
    "POST",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/native-admin/launch`,
    {
      headers: { origin: publicOrigin },
      body: {
        state: validState,
        challenge: challenge(validVerifier),
        host: status.data.host,
        revisionId: context.revision.id,
      },
    },
  );
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  const redeemed = await injectJson(context.fixture, "POST", "/__occ/native-admin/callback", {
    headers: { host: nativeAuthority(status.data), origin: status.data.origin },
    body: {
      code: new URL(launched.data.url).searchParams.get("code"),
      state: validState,
      verifier: validVerifier,
    },
  });
  assert.equal(redeemed.statusCode, 200, redeemed.body);
  const nativeCookie = cookieHeaderFromSetCookie(injectedSetCookie(redeemed));
  assert.match(nativeCookie, /__Host-occ_native_admin=/);

  trustLocalUpstreamCertificate(t, context.upstream.cert);

  const proxied = await injectJson(context.fixture, "GET", "/settings/profile?tab=devices", {
    headers: {
      host: nativeAuthority(status.data),
      origin: status.data.origin,
      cookie: `${nativeCookie}; openclaw_occ.session_token=must-not-forward`,
      authorization: "Bearer must-not-forward",
      "x-api-key": "must-not-forward",
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
  const deniedRequests = [
    { url: "/", headers: { origin: "https://untrusted.example.test" } },
    { url: "/", headers: { origin: "null" } },
    { url: "/", headers: { host: `sibling.${nativeDomain}:9443` } },
    { url: "/", headers: { host: `${status.data.host}:9444` } },
    { url: "/api/auth/get-session", headers: { cookie: "" } },
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
});
