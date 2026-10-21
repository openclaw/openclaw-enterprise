import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { createConsoleAppFixture, backendFixtures } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  authenticatedHeaders,
  cookieHeaderFromSetCookie,
  setCookieHeaders,
} from "../helpers/auth-session.mjs";

const contract = JSON.parse(
  await readFile(
    new URL("../../packages/contracts/openapi/occ-api.openapi.json", import.meta.url),
    "utf8",
  ),
);
const UNTRUSTED_ORIGIN_MESSAGE =
  "A trusted browser origin is required: session-cookie requests that change state must come from the console and send its Origin header.";

function noSecretProviderFields(backend) {
  assert.deepEqual(Object.keys(backend).sort(), ["id", "type"]);
  assert.equal(typeof backend.id, "string");
  assert.equal(backend.type, "chatgpt");
}

test("console Backend API returns only safe Installation-admin summaries", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();

  const backends = await fixture.request("GET", "/backends");
  assert.equal(backends.status, 200);
  assert.deepEqual(backends.data, [{ id: backendFixtures[0].id, type: "chatgpt" }]);
  backends.data.forEach(noSecretProviderFields);
  assert.doesNotMatch(JSON.stringify(backends.body), /apiKey|workspaceId|credential|drivers|path/i);

  const emptyFixture = await createConsoleAppFixture(t, { backends: [] });
  await emptyFixture.bootstrap("Console empty Backend Installation");
  const emptyProviders = await emptyFixture.request("GET", "/backends");
  assert.equal(emptyProviders.status, 200);
  assert.deepEqual(emptyProviders.data, []);

  const unavailableFixture = await createConsoleAppFixture(t, {
    backendSummaries: undefined,
  });
  await unavailableFixture.bootstrap("Console unavailable Backend Installation");
  const unavailable = await unavailableFixture.request("GET", "/backends");
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "DEPENDENCY_UNAVAILABLE");
});

test("observability destination requires Installation administration", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const fixture = await createConsoleAppFixture(t, { observabilityUrl: url });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Observability readers");

  const administrator = await fixture.request("GET", "/observability");
  assert.equal(administrator.status, 200);
  assert.deepEqual(administrator.data, { url });

  // A Namespace reader must not discover the Installation-wide external destination.
  const limited = await fixture.createAccountWithPolicy("namespace-observer", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-observability-reader",
      namespaceId: namespace.id,
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    fixture.policy.bindings.push({
      id: "binding-console-observability-reader",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-observability-reader",
    });
  });
  const session = await fixture.signIn(limited.credentials);
  const denied = await fixture.request("GET", "/observability", { session });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");

  const absent = await createConsoleAppFixture(t);
  await absent.bootstrap("No observability destination");
  const response = await absent.request("GET", "/observability");
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { url: null });
});

test("console collection APIs keep exact Namespace and Agent IAM boundaries", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Alpha");
  const beta = await fixture.createNamespace("Beta");
  const alphaAgent = await fixture.createAgent(alpha.id, "Alpha agent");
  const betaAgent = await fixture.createAgent(beta.id, "Beta agent");

  const limited = await fixture.createAccountWithPolicy("namespace-reader", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-alpha-reader",
      namespaceId: alpha.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-alpha-reader",
      namespaceId: alpha.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-alpha-reader",
    });
  });
  const limitedSession = await fixture.signIn(limited.credentials);

  const visibleNamespaces = await fixture.request("GET", "/namespaces", {
    session: limitedSession,
  });
  assert.equal(visibleNamespaces.status, 200);
  assert.deepEqual(
    visibleNamespaces.data.map((namespace) => namespace.id),
    [alpha.id],
  );

  const visibleAgents = await fixture.request("GET", `/namespaces/${alpha.id}/agents`, {
    session: limitedSession,
  });
  assert.equal(visibleAgents.status, 200);
  assert.deepEqual(
    visibleAgents.data.map((agent) => agent.id),
    [alphaAgent.id],
  );
  assert.equal(visibleAgents.data[0].name, alphaAgent.name);

  const hiddenAgents = await fixture.request("GET", `/namespaces/${beta.id}/agents`, {
    session: limitedSession,
  });
  assert.equal(hiddenAgents.status, 403);
  assert.equal(hiddenAgents.body.error.code, "FORBIDDEN");
  assert.equal(betaAgent.name, "Beta agent");

  const alphaImages = `/namespaces/${alpha.id}/agents/${alphaAgent.id}/runtime-images`;
  const images = await fixture.request("GET", alphaImages, { session: limitedSession });
  assert.equal(images.status, 200);
  assert.deepEqual(images.data, { status: "undeployed", images: [] });
  assert.equal((await fixture.request("GET", alphaImages, { session: null })).status, 401);
  const hiddenImages = await fixture.request(
    "GET",
    `/namespaces/${beta.id}/agents/${betaAgent.id}/runtime-images`,
    { session: limitedSession },
  );
  assert.equal(hiddenImages.status, 403);
  const wrongNamespace = await fixture.request(
    "GET",
    `/namespaces/${alpha.id}/agents/${betaAgent.id}/runtime-images`,
  );
  assert.equal(wrongNamespace.status, 404);

  const providerDenied = await fixture.request("GET", "/backends", { session: limitedSession });
  assert.equal(providerDenied.status, 403);
  assert.equal(providerDenied.body.error.code, "FORBIDDEN");

  fixture.policy.bindings.splice(
    fixture.policy.bindings.findIndex((binding) => binding.id === "binding-console-alpha-reader"),
    1,
  );
  const revokedNamespaces = await fixture.request("GET", "/namespaces", {
    session: limitedSession,
  });
  assert.equal(revokedNamespaces.status, 200);
  assert.deepEqual(revokedNamespaces.data, []);
  assert.equal(
    (await fixture.request("GET", alphaImages, { session: limitedSession })).status,
    403,
  );
});

test("caller permission summaries report primary IAM decisions without authorizing a later operation", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Permission summaries", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Summarized agent");
  const other = await fixture.createAgent(namespace.id, "Unshared agent");
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const permissionsPath = `${agentPath}/permissions`;
  const namespacePath = `/namespaces/${namespace.id}/permissions`;

  const admin = await fixture.request("GET", permissionsPath);
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.data, { update: true, deploy: true, operate: true, delete: true });
  const adminNamespace = await fixture.request("GET", namespacePath);
  assert.equal(adminNamespace.status, 200);
  assert.deepEqual(adminNamespace.data, { agents: { create: true } });

  // Namespace read plus exact read and deploy on one Agent: only deploy is reported.
  const limited = await fixture.createAccountWithPolicy("permission-summary", (principal) => {
    fixture.policy.roles.push(
      {
        id: "role-permission-summary-namespace",
        namespaceId: namespace.id,
        permissions: [{ action: "read", resourceKind: "namespace" }],
      },
      {
        id: "role-permission-summary-agent",
        namespaceId: namespace.id,
        permissions: [
          { action: "read", resourceKind: "agent" },
          { action: "deploy", resourceKind: "agent" },
        ],
      },
    );
    fixture.policy.bindings.push(
      {
        id: "binding-permission-summary-namespace",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: "role-permission-summary-namespace",
      },
      {
        id: "binding-permission-summary-agent",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: "role-permission-summary-agent",
        resourceKind: "agent",
        resourceId: agent.id,
      },
    );
  });
  const session = await fixture.signIn(limited.credentials);
  const summary = await fixture.request("GET", permissionsPath, { session });
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.data, { update: false, deploy: true, operate: false, delete: false });
  const namespaceSummary = await fixture.request("GET", namespacePath, { session });
  assert.equal(namespaceSummary.status, 200);
  assert.deepEqual(namespaceSummary.data, { agents: { create: false } });
  // A false flag is an answer, not an attempted operation, so nothing is audited as denied.
  const denials = () => auditSink.list().filter((event) => event.kind === "authorization_denial");
  assert.equal(denials().length, 0);

  // The summary itself requires Agent read and an existing Agent.
  const unshared = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${other.id}/permissions`,
    { session },
  );
  assert.equal(unshared.status, 403);
  assert.equal(unshared.body.error.code, "FORBIDDEN");
  assert.deepEqual(
    denials().map((event) => event.action),
    ["openclaw.agents.permissions.read"],
  );
  const missing = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/agt_00000000-0000-4000-8000-000000000000/permissions`,
  );
  assert.equal(missing.status, 404);

  // The summary reported deploy: true. This caller lacks the Configuration read needed to deploy.
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  assert.equal((await fixture.request("GET", configurationPath, { session })).status, 403);
  const revisionsPath = `${agentPath}/revisions`;
  const before = await fixture.request("GET", revisionsPath);
  assert.equal(before.status, 200);
  const deploy = await fixture.request("POST", `${agentPath}/deploy`, { session });
  assert.equal(deploy.status, 403);
  assert.equal(deploy.body.error.code, "FORBIDDEN");
  assert.equal(denials().at(-1).action, "openclaw.agents.deploy");
  const after = await fixture.request("GET", revisionsPath);
  assert.equal(after.status, 200);
  assert.deepEqual(after.data, before.data, "denied deployment created no revision");
});

test("console static routes expose only public assets and preserve API JSON failures", async (t) => {
  const fixture = await createConsoleAppFixture(t);

  for (const path of [
    "/console/",
    "/console/login",
    "/console/agents",
    "/console/agents/new",
    "/console/agents/agt_00000000-0000-4000-8000-000000000000",
    "/console/settings",
  ]) {
    const result = await fixture.rawRequest("GET", path);
    assert.equal(result.response.status, 200, path);
    assert.match(result.response.headers.get("content-type") ?? "", /text\/html/i, path);
    assert.match(result.text, /<script[^>]+src="\/console\/console\.mjs"/i, path);
    assert.doesNotMatch(result.text, /\{\s*"error"\s*:/, path);
    assert.match(result.text, /<meta name="occ-build-revision" content="" \/>/, path);
  }

  for (const [path, mime] of [
    ["/console/oce-mascot.png", /image\/png/i],
    ["/console/favicon.ico", /image\/vnd\.microsoft\.icon/i],
    ["/console/workspace-defaults.mjs", /javascript/i],
    ["/console/preset-variables.mjs", /javascript/i],
    ["/console/default-codex-preset.mjs", /javascript/i],
    ["/console/console.css", /text\/css/i],
    ["/console/fonts/instrument-sans-latin.woff2", /font\/woff2/i],
    ["/console/console.mjs", /javascript/i],
    ["/console/agents.mjs", /javascript/i],
    ["/console/agents/harness-auth.mjs", /javascript/i],
    ["/console/channels.mjs", /javascript/i],
    ["/console/dom.mjs", /javascript/i],
    ["/console/channels.css", /text\/css/i],
  ]) {
    const result = await fixture.rawRequest("GET", path);
    assert.equal(result.response.status, 200, path);
    assert.match(result.response.headers.get("content-type") ?? "", mime, path);
    assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  }

  for (const path of [
    "/console/dom.mts",
    "/console/index.ts",
    "/console/%2e%2e/index.ts",
    "/console/missing.css",
  ]) {
    const result = await fixture.rawRequest("GET", path);
    assert.equal(result.response.status, 404, path);
    assert.doesNotMatch(result.text, /createFastifyApp|OCC_AUTH_SECRET|apiKeyPath/, path);
  }

  const apiMiss = await fixture.rawRequest("GET", "/api/does-not-exist");
  assert.equal(apiMiss.response.status, 404);
  assert.match(apiMiss.response.headers.get("content-type") ?? "", /application\/json/i);
  assert.equal(JSON.parse(apiMiss.text).error.code, "NOT_FOUND");

  const methodMiss = await fixture.rawRequest("POST", "/backends");
  assert.equal(methodMiss.response.status, 405);
  assert.equal(JSON.parse(methodMiss.text).error.code, "METHOD_NOT_ALLOWED");
});

test("console scripts and styles are compressed when accepted; the shell and binaries are not", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  const host = new URL(fixture.origin).host;
  const consoleFile = (path) =>
    readFile(new URL(`../../apps/controller/src/console/${path}`, import.meta.url));
  // Read the wire bytes: Fetch decodes content codings before exposing its body.
  const fetchRaw = (url, headers = {}, method = "GET") =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        new URL(url, fixture.origin),
        { method, headers: { host, ...headers } },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              statusCode: response.statusCode,
              headers: response.headers,
              rawPayload: Buffer.concat(chunks),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });

  const script = await consoleFile("agents/detail.mjs");
  const plain = await fetchRaw("/console/agents/detail.mjs");
  assert.equal(plain.statusCode, 200);
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.headers.vary, "Accept-Encoding");
  assert.deepEqual(plain.rawPayload, script);
  const csp = plain.headers["content-security-policy"];
  assert.match(csp, /script-src 'self'/);

  for (const [acceptEncoding, encoding, decode] of [
    ["gzip", "gzip", gunzipSync],
    ["gzip, deflate, br, zstd", "br", brotliDecompressSync],
    ["br;q=0.5, gzip;q=1", "gzip", gunzipSync],
    ["identity;q=0.5, gzip;q=1", "gzip", gunzipSync],
    ["identity;q=0, gzip;q=0.5", "gzip", gunzipSync],
    ["identity;q=1, br;q=1, gzip;q=1", "br", brotliDecompressSync],
    ["*", "br", brotliDecompressSync],
  ]) {
    const result = await fetchRaw("/console/agents/detail.mjs", {
      "accept-encoding": acceptEncoding,
    });
    assert.equal(result.statusCode, 200, acceptEncoding);
    assert.equal(result.headers["content-encoding"], encoding, acceptEncoding);
    assert.equal(result.headers.vary, "Accept-Encoding", acceptEncoding);
    assert.match(result.headers["content-type"], /javascript/, acceptEncoding);
    assert.equal(Number(result.headers["content-length"]), result.rawPayload.length);
    assert.ok(result.rawPayload.length < script.length / 3, acceptEncoding);
    assert.deepEqual(decode(result.rawPayload), script, acceptEncoding);
    // Compression changes neither the CSP nor the API headers that keep assets uncached.
    assert.equal(result.headers["content-security-policy"], csp);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["x-content-type-options"], "nosniff");
  }

  for (const acceptEncoding of [
    "identity",
    "br;q=0, gzip;q=0",
    "deflate",
    "*;q=0",
    "identity;q=1, gzip;q=0.5",
    "br;q=0.5, identity;q=1",
    "identity;q=1, *;q=0.5",
  ]) {
    const result = await fetchRaw("/console/console.css", { "accept-encoding": acceptEncoding });
    assert.equal(result.headers["content-encoding"], undefined, acceptEncoding);
    assert.equal(result.headers.vary, "Accept-Encoding", acceptEncoding);
    assert.deepEqual(result.rawPayload, await consoleFile("console.css"), acceptEncoding);
  }

  // HEAD reports the GET representation. Range is unsupported: it must keep returning the whole
  // encoded body, never a slice of it, until someone adds range support on purpose.
  const gzipGet = await fetchRaw("/console/console.css", { "accept-encoding": "gzip" });
  const head = await fetchRaw("/console/console.css", { "accept-encoding": "gzip" }, "HEAD");
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers["content-encoding"], "gzip");
  assert.equal(head.headers["content-length"], gzipGet.headers["content-length"]);
  assert.equal(head.rawPayload.length, 0);
  const identityHead = await fetchRaw(
    "/console/console.css",
    { "accept-encoding": "identity;q=1, gzip;q=0.5" },
    "HEAD",
  );
  assert.equal(identityHead.statusCode, 200);
  assert.equal(identityHead.headers["content-encoding"], undefined);
  assert.equal(
    identityHead.headers["content-length"],
    String((await consoleFile("console.css")).length),
  );
  assert.equal(identityHead.rawPayload.length, 0);
  const ranged = await fetchRaw("/console/console.css", {
    "accept-encoding": "gzip",
    range: "bytes=0-9",
  });
  assert.equal(ranged.statusCode, 200);
  assert.deepEqual(ranged.rawPayload, gzipGet.rawPayload);

  // The generated preset module is compressed like the files beside it.
  const preset = await fetchRaw("/console/default-codex-preset.mjs", { "accept-encoding": "gzip" });
  assert.equal(preset.headers["content-encoding"], "gzip");
  assert.match(gunzipSync(preset.rawPayload).toString("utf8"), /^export default \{/);

  // The shell also answers the sign-in route; it and binary assets are always identity.
  for (const path of ["/console/login", "/console/", "/console/missing.css"]) {
    const result = await fetchRaw(path, { "accept-encoding": "gzip, br" });
    assert.equal(result.headers["content-encoding"], undefined, path);
    assert.equal(result.headers.vary, undefined, path);
    assert.deepEqual(result.rawPayload, await consoleFile("index.html"), path);
  }
  for (const path of ["/console/oce-mascot.png", "/console/fonts/instrument-sans-latin.woff2"]) {
    const result = await fetchRaw(path, { "accept-encoding": "gzip, br" });
    assert.equal(result.statusCode, 200, path);
    assert.equal(result.headers["content-encoding"], undefined, path);
  }
});

test("console auth routes reject untrusted browser origins and issue production session cookies", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    authMode: "production",
    development: { enabled: false },
  });

  const signInBody = {
    email: fixture.credentials.email,
    password: fixture.credentials.password,
  };
  const rejected = await fixture.rawRequest("POST", "/api/auth/sign-in/email", {
    headers: { origin: "https://attacker.example.test" },
    body: signInBody,
  });
  assert.equal(rejected.response.status, 403);
  assert.equal(rejected.response.headers.get("set-cookie"), null);
  // A correct password with a foreign Origin is refused for the Origin, not the credentials.
  assert.equal(JSON.parse(rejected.text).error.message, UNTRUSTED_ORIGIN_MESSAGE);
  // A browser that omits Origin still names a cross-site request in Sec-Fetch-Site.
  const crossSiteSignIn = await fixture.rawRequest("POST", "/api/auth/sign-in/email", {
    headers: { "sec-fetch-site": "cross-site" },
    body: signInBody,
  });
  assert.equal(crossSiteSignIn.response.status, 403);
  assert.equal(crossSiteSignIn.response.headers.get("set-cookie"), null);
  assert.equal(JSON.parse(crossSiteSignIn.text).error.message, UNTRUSTED_ORIGIN_MESSAGE);

  const cliAccepted = await fixture.rawRequest("POST", "/api/auth/sign-in/email", {
    body: signInBody,
  });
  assert.equal(cliAccepted.response.status, 200, cliAccepted.text);

  const accepted = await fixture.rawRequest("POST", "/api/auth/sign-in/email", {
    headers: { origin: fixture.origin },
    body: signInBody,
  });
  assert.equal(accepted.response.status, 200, accepted.text);
  const setCookies = setCookieHeaders(accepted.response);
  const setCookie = setCookies.join("\n");
  const requestCookie = cookieHeaderFromSetCookie(setCookies);
  assert.ok(requestCookie.length > 0);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);

  const rejectedSignOut = await fixture.rawRequest("POST", "/api/auth/sign-out", {
    headers: {
      cookie: requestCookie,
      origin: "https://attacker.example.test",
    },
  });
  assert.equal(rejectedSignOut.response.status, 403);
  assert.equal(JSON.parse(rejectedSignOut.text).error.message, UNTRUSTED_ORIGIN_MESSAGE);

  const retainedSession = await fixture.rawRequest("GET", "/api/auth/session", {
    headers: { cookie: requestCookie },
  });
  assert.equal(retainedSession.response.status, 200, retainedSession.text);
  assert.equal(JSON.parse(retainedSession.text).data.authenticated, true);

  const crossSiteNoOrigin = await fixture.rawRequest("POST", "/api/auth/sign-out", {
    headers: {
      cookie: requestCookie,
      "sec-fetch-site": "cross-site",
    },
  });
  assert.equal(crossSiteNoOrigin.response.status, 403);
  assert.equal(JSON.parse(crossSiteNoOrigin.text).error.message, UNTRUSTED_ORIGIN_MESSAGE);

  // Without the GitHub profile the session key still only narrows the cookie session.
  const providers = await fixture.rawRequest("GET", "/api/auth/providers");
  assert.deepEqual(JSON.parse(providers.text).data, {
    github: false,
    google: false,
    oidc: false,
    password: true,
    sessionBinding: false,
  });
  const sessionKey = JSON.parse(retainedSession.text).data.sessionKey;
  assert.match(sessionKey, /^[A-Za-z0-9_-]{43}$/);
  const foreignKey = "A".repeat(43);
  const foreignSession = await fixture.rawRequest("GET", "/api/auth/session", {
    headers: { cookie: requestCookie, "x-occ-session-key": foreignKey },
  });
  assert.equal(foreignSession.response.status, 401, foreignSession.text);
  const foreignSignOut = await fixture.rawRequest("POST", "/api/auth/sign-out", {
    headers: { cookie: requestCookie, origin: fixture.origin, "x-occ-session-key": foreignKey },
  });
  assert.equal(foreignSignOut.response.status, 401, foreignSignOut.text);
  assert.equal(foreignSignOut.response.headers.get("set-cookie"), null);
  const keptSession = await fixture.rawRequest("GET", "/api/auth/session", {
    headers: { cookie: requestCookie, "x-occ-session-key": sessionKey },
  });
  assert.equal(JSON.parse(keptSession.text).data.sessionKey, sessionKey);

  // The exact Origin check runs before the session key is considered.
  const originlessSignOut = await fixture.rawRequest("POST", "/api/auth/sign-out", {
    headers: { cookie: requestCookie, "x-occ-session-key": foreignKey },
  });
  assert.equal(originlessSignOut.response.status, 403);
  assert.equal(JSON.parse(originlessSignOut.text).error.message, UNTRUSTED_ORIGIN_MESSAGE);

  const cliSignOut = await fixture.rawRequest("POST", "/api/auth/sign-out", {
    headers: { cookie: requestCookie, origin: fixture.origin, "x-occ-session-key": sessionKey },
  });
  assert.equal(cliSignOut.response.status, 200, cliSignOut.text);

  // A body that fails the sign-in schema is a 400 before any credential check.
  const malformedSignIn = await fixture.rawRequest("POST", "/api/auth/sign-in/email", {
    headers: { origin: fixture.origin },
    body: { email: fixture.credentials.email },
  });
  assert.equal(malformedSignIn.response.status, 400, malformedSignIn.text);
  assert.equal(JSON.parse(malformedSignIn.text).error.code, "INVALID_REQUEST");
  assert.deepEqual(JSON.parse(malformedSignIn.text).error.details, [
    { path: "/password", code: "REQUIRED" },
  ]);

  // Every status answered above is in the checked-in OpenAPI contract, so clients generated
  // from it handle the Origin and schema refusals. The contract once listed neither.
  for (const [path, result] of [
    ["/api/auth/sign-in/email", rejected],
    ["/api/auth/sign-in/email", crossSiteSignIn],
    ["/api/auth/sign-in/email", accepted],
    ["/api/auth/sign-in/email", malformedSignIn],
    ["/api/auth/sign-out", rejectedSignOut],
    ["/api/auth/sign-out", crossSiteNoOrigin],
    ["/api/auth/sign-out", foreignSignOut],
    ["/api/auth/sign-out", originlessSignOut],
    ["/api/auth/sign-out", cliSignOut],
  ]) {
    const status = String(result.response.status);
    assert.ok(
      Object.hasOwn(contract.paths[path].post.responses, status),
      `POST ${path} answered ${status}, which its OpenAPI operation does not list`,
    );
  }
});

test("every /api/auth operation that takes a body answers the 400, 413 and 415 it lists", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    authMode: "production",
    development: { enabled: false },
  });
  const session = await fixture.signIn();
  const operations = Object.entries(contract.paths)
    .filter(([path]) => path.startsWith("/api/auth/"))
    .flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, operation]) => operation.requestBody !== undefined)
        .map(([method, operation]) => ({ method: method.toUpperCase(), path, operation })),
    );
  // Fourteen such operations exist today; an empty scan would prove nothing.
  assert.ok(operations.length >= 14, `found ${operations.length} operations`);
  // An Installation administrator with a trusted Origin passes admission, so each refusal
  // comes from the body itself: the declared size before parsing, then the media type, then
  // the operation's schema.
  for (const { method, path, operation } of operations) {
    for (const [status, code, contentType, payload] of [
      ["413", "PAYLOAD_TOO_LARGE", "application/json", `{"pad":"${"x".repeat(70 * 1024)}"}`],
      ["415", "UNSUPPORTED_MEDIA_TYPE", "text/plain", "expectedVersion=1"],
      ["400", "INVALID_REQUEST", "application/json", JSON.stringify({ unexpected: true })],
    ]) {
      const response = await fixture.app.inject({
        method,
        url: path.replace("{userId}", "usr_unknown").replace("{methodId}", "method_unknown"),
        headers: authenticatedHeaders(session, {
          origin: fixture.origin,
          "content-type": contentType,
        }),
        payload,
      });
      const label = `${operation.operationId} ${status}`;
      assert.equal(String(response.statusCode), status, `${label}: ${response.body}`);
      assert.equal(JSON.parse(response.body).error.code, code, label);
      assert.ok(Object.hasOwn(operation.responses, status), `${label} is not in the contract`);
    }
  }
});

test("untrusted cookie mutations do not clean up an expired session", async (t) => {
  const fixture = await createConsoleAppFixture(t, { development: { enabled: false } });
  await fixture.bootstrap();
  const session = await fixture.signIn();
  const expired = fixture.memoryDatabase.session.at(-1);
  assert.ok(expired);
  expired.expiresAt = new Date(0);

  const denied = await fixture.rawRequest("POST", "/api/auth/service-keys", {
    headers: { cookie: session.cookie, origin: "http://127.0.0.1:1" },
  });
  assert.ok(fixture.memoryDatabase.session.includes(expired), "untrusted request changed session");
  assert.equal(denied.response.status, 403, denied.text);

  const trusted = await fixture.rawRequest("POST", "/api/auth/service-keys", {
    headers: { cookie: session.cookie, origin: fixture.origin },
  });
  assert.equal(trusted.response.status, 401, trusted.text);
  assert.equal(fixture.memoryDatabase.session.includes(expired), false);
});

test("public Agent revisions return the selected binding without private credential resolution metadata", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Public binding snapshot", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Bound Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  assert.deepEqual(revision.harnessAuth, agent.harnessAuth);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
  for (const endpoint of [path, `${path}/${revision.id}`]) {
    const response = await fixture.request("GET", endpoint);
    assert.equal(response.status, 200);
    assert.doesNotMatch(
      JSON.stringify(response.data),
      /backendRef|secretDriverId|workspaceId|secretRef|test-api-key/,
    );
  }
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: null,
  });
  const historical = await fixture.request("GET", `${path}/${revision.id}`);
  assert.deepEqual(historical.data.harnessAuth, agent.harnessAuth);
});
