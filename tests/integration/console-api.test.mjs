import assert from "node:assert/strict";
import test from "node:test";

import { createConsoleAppFixture, providerFixtures } from "../helpers/console-app.mjs";
import { cookieHeaderFromSetCookie, setCookieHeaders } from "../helpers/auth-session.mjs";

function noSecretProviderFields(provider) {
  assert.deepEqual(Object.keys(provider).sort(), ["id", "type"]);
  assert.equal(typeof provider.id, "string");
  assert.equal(provider.type, "chatgpt");
}

test("console Provider API returns only safe Installation-admin summaries", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();

  const providers = await fixture.request("GET", "/providers");
  assert.equal(providers.status, 200);
  assert.deepEqual(providers.data, [{ id: providerFixtures[0].id, type: "chatgpt" }]);
  providers.data.forEach(noSecretProviderFields);
  assert.doesNotMatch(
    JSON.stringify(providers.body),
    /apiKey|workspaceId|credential|drivers|path/i,
  );

  const emptyFixture = await createConsoleAppFixture(t, { providers: [] });
  await emptyFixture.bootstrap("Console empty Provider Installation");
  const emptyProviders = await emptyFixture.request("GET", "/providers");
  assert.equal(emptyProviders.status, 200);
  assert.deepEqual(emptyProviders.data, []);

  const unavailableFixture = await createConsoleAppFixture(t, {
    providerSummaries: undefined,
  });
  await unavailableFixture.bootstrap("Console unavailable Provider Installation");
  const unavailable = await unavailableFixture.request("GET", "/providers");
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "DEPENDENCY_UNAVAILABLE");
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

  const providerDenied = await fixture.request("GET", "/providers", { session: limitedSession });
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
  }

  for (const [path, mime] of [
    ["/console/console.css", /text\/css/i],
    ["/console/console.mjs", /javascript/i],
    ["/console/agents.mjs", /javascript/i],
    ["/console/channels.mjs", /javascript/i],
    ["/console/dom.mjs", /javascript/i],
    ["/console/channels.css", /text\/css/i],
  ]) {
    const result = await fixture.rawRequest("GET", path);
    assert.equal(result.response.status, 200, path);
    assert.match(result.response.headers.get("content-type") ?? "", mime, path);
    assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  }

  for (const path of ["/console/index.ts", "/console/%2e%2e/index.ts", "/console/missing.css"]) {
    const result = await fixture.rawRequest("GET", path);
    assert.equal(result.response.status, 404, path);
    assert.doesNotMatch(result.text, /createFastifyApp|OCC_AUTH_SECRET|apiKeyPath/, path);
  }

  const apiMiss = await fixture.rawRequest("GET", "/api/does-not-exist");
  assert.equal(apiMiss.response.status, 404);
  assert.match(apiMiss.response.headers.get("content-type") ?? "", /application\/json/i);
  assert.equal(JSON.parse(apiMiss.text).error.code, "NOT_FOUND");

  const methodMiss = await fixture.rawRequest("POST", "/providers");
  assert.equal(methodMiss.response.status, 405);
  assert.equal(JSON.parse(methodMiss.text).error.code, "METHOD_NOT_ALLOWED");
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

  const cliSignOut = await fixture.rawRequest("POST", "/api/auth/sign-out", {
    headers: { cookie: requestCookie },
  });
  assert.equal(cliSignOut.response.status, 200, cliSignOut.text);
});

test("console email sign-in sanitizes adapter write failures and recovers", async (t) => {
  const fixture = await createConsoleAppFixture(t, { autoSignIn: false });
  const signInBody = {
    email: fixture.credentials.email,
    password: fixture.credentials.password,
  };

  // Make the real memory adapter's session storage read-only after provisioning.
  // Correct credentials reach session creation, whose failed write must become a
  // dependency error rather than an authentication or authorization rejection.
  assert.equal(fixture.memoryDatabase.session.length, 0);
  Object.freeze(fixture.memoryDatabase.session);
  const unavailable = await fixture.request("POST", "/api/auth/sign-in/email", {
    session: null,
    body: signInBody,
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(unavailable.headers.get("set-cookie"), null);
  assert.doesNotMatch(JSON.stringify(unavailable.body), /TypeError|extensible|stack|password/i);

  // Restoring writable storage admits the same credentials and issues a usable session.
  fixture.memoryDatabase.session = [];
  const session = await fixture.signIn();
  const inspected = await fixture.request("GET", "/api/auth/session", { session });
  assert.equal(inspected.status, 200);
  assert.equal(inspected.data.authenticated, true);
  assert.equal(inspected.data.user.email, fixture.credentials.email);
});

test("console email sign-in rate limits repeated password failures by socket address", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const fixture = await createConsoleAppFixture(t, { autoSignIn: false });
  const attemptPassword = (forwardedFor) =>
    fixture.request("POST", "/api/auth/sign-in/email", {
      session: null,
      headers: { "x-forwarded-for": forwardedFor },
      body: { email: fixture.credentials.email, password: "incorrect-password" },
    });

  // The limiter must use the server-observed socket address, not spoofable forwarding headers.
  const statuses = [];
  for (const forwardedFor of ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"]) {
    const result = await attemptPassword(forwardedFor);
    statuses.push(result.status);
    assert.equal(
      result.body.error.code,
      result.status === 429 ? "TOO_MANY_REQUESTS" : "UNAUTHENTICATED",
    );
    if (result.status === 429) {
      // Better Auth supplies its retry delay as X-Retry-After.
      assert.match(result.headers.get("x-retry-after") ?? "", /^\d+$/);
      assert.ok(Number(result.headers.get("x-retry-after")) > 0);
    }
  }
  assert.deepEqual(statuses, [401, 401, 401, 429]);

  // An expired window admits requests again; concurrent failures must consume one shared budget.
  t.mock.timers.tick(60_001);
  const concurrent = await Promise.all(
    ["198.51.100.10", "198.51.100.11", "198.51.100.12", "198.51.100.13"].map(attemptPassword),
  );
  assert.deepEqual(concurrent.map(({ status }) => status).sort(), [401, 401, 401, 429]);

  const isolated = await createConsoleAppFixture(t);
  const session = await isolated.signIn();
  const inspected = await isolated.request("GET", "/api/auth/session", { session });
  assert.equal(inspected.status, 200);
  assert.equal(inspected.data.authenticated, true);
});
