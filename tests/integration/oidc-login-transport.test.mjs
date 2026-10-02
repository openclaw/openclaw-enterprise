import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { createHumanLogin } from "../../apps/controller/src/auth/github.ts";
import { humanLoginConfiguration } from "../../apps/controller/src/auth/index.ts";
import { oidcLoginConfiguration, oidcNonce } from "../../apps/controller/src/auth/oidc.ts";
import { createOccLogger, emitOccLogEvent } from "../../apps/controller/src/logging.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { APIError, betterAuth } = await import(require.resolve("better-auth"));
const { memoryAdapter } = await import(require.resolve("better-auth/adapters/memory"));
const origin = "https://console.example.test";
const secret = "test-only-authentication-secret-with-at-least-32-characters";
const binding = "b".repeat(43);
const callbackState = "s".repeat(43);
const subject = "auth0|65f0c1d2e3a4b5c6d7e8f901";
const environment = {
  OCC_AUTH_OIDC_ISSUER: "https://tenant.idp.example.test/",
  OCC_AUTH_OIDC_AUTHORIZATION_URL: "https://tenant.idp.example.test/authorize",
  OCC_AUTH_OIDC_TOKEN_URL: "https://tenant.idp.example.test/oauth/token",
  OCC_AUTH_OIDC_JWKS_URL: "https://tenant.idp.example.test/.well-known/jwks.json",
  OCC_AUTH_OIDC_CLIENT_ID: "fixture-oidc-client",
  OCC_AUTH_OIDC_CLIENT_SECRET: "fixture-oidc-client-secret",
};
const oidc = oidcLoginConfiguration(environment);
const pinned = new Set([oidc.tokenUrl, oidc.jwksUrl]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
const providerId = `oidc:${digest(`${oidc.issuer}\0${oidc.clientId}`)}`;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = {
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture-kid", alg: "RS256", use: "sig" }],
};

function idToken(state = callbackState, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", kid: "fixture-kid", typ: "JWT" })}.${encode({
    iss: oidc.issuer,
    aud: oidc.clientId,
    sub: subject,
    iat: now - 5,
    exp: now + 3600,
    nonce: oidcNonce(secret, state),
    ...overrides,
  })}`;
  return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
}

// The actual Better Auth handler and provider transport run here; State is a boundary
// fixture (the PostgreSQL suite covers persistence and sessions).
function loginFixture(providers = { oidc }) {
  // Operational events go through the production logger and sanitizer.
  const logLines = [];
  const logger = createOccLogger({
    component: "occ-api",
    level: "info",
    destination: { write: (chunk) => logLines.push(JSON.parse(chunk)) },
  });
  const subjects = [];
  const denials = [];
  const attempts = [];
  const state = {
    createAttempt: async (attempt) => {
      attempts.push(attempt);
      const createdAt = new Date();
      return { createdAt, expiresAt: new Date(createdAt.getTime() + 300_000) };
    },
    consumeAttempt: async (attempt) => {
      attempts.push(attempt);
      return { codeVerifier: "v".repeat(43), createdAt: new Date() };
    },
    snapshotExternal: async (snapshotProviderId, snapshotSubject) => {
      subjects.push([snapshotProviderId, snapshotSubject]);
    },
    snapshotPassword: async () => undefined,
    recordDenied: async (reason, provider) => {
      denials.push([reason, provider]);
    },
  };
  const login = createHumanLogin(
    state,
    { recoveryUserId: "fixture-recovery", ...providers },
    origin,
    {
      trustedClientAddress: true,
      onOperationalEvent: (event) => emitOccLogEvent(logger, event),
    },
  );
  const auth = betterAuth({
    baseURL: origin,
    secret,
    database: login.database(
      memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    ),
    session: {
      expiresIn: 8 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    plugins: [login.plugin],
    rateLimit: { enabled: false },
    logger: { level: "error", log: () => {} },
    onAPIError: {
      onError(error) {
        if (error instanceof APIError) {
          throw error;
        }
        throw APIError.fromStatus("SERVICE_UNAVAILABLE", { message: "unavailable" });
      },
    },
  });
  const call = (path, init, ip = "10.0.0.1") =>
    auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        ...init,
        headers: { ...init?.headers, "x-occ-client-ip": ip },
      }),
    );
  return {
    login,
    attempts,
    subjects,
    denials,
    // Log records without their timestamp.
    logs: () => logLines.map(({ time, ...line }) => line),
    callback: (query = `state=${callbackState}&code=fixture-code`, ip = "10.0.0.1") =>
      call(
        `/oce/providers/oidc/callback?${query}`,
        { headers: { cookie: `__Host-occ_login_attempt=${binding}` } },
        ip,
      ),
    start: (ip = "10.0.0.1", provider = "oidc") =>
      call(`/oce/providers/${provider}/start`, { method: "POST", headers: { origin } }, ip),
  };
}

async function expectDenied(response) {
  assert.equal(response.status, 401);
  assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /session_token|login_receipt/);
}

test("OIDC sign-in configuration shares the recovery user with GitHub and Google", () => {
  const recovery = { OCC_AUTH_GITHUB_RECOVERY_USER_ID: "recovery-user" };
  assert.deepEqual(humanLoginConfiguration({ ...environment, ...recovery }), {
    oidc: { ...oidc, recoveryUserId: "recovery-user" },
  });
  assert.throws(
    () => humanLoginConfiguration(environment),
    /OIDC sign-in requires its provider settings and a recovery user ID/,
  );
  assert.throws(
    () => humanLoginConfiguration({ ...environment, OCC_AUTH_GITHUB_RECOVERY_USER_ID: " " }),
    /OIDC sign-in requires its provider settings and a recovery user ID/,
  );
});

test("OIDC login fetches only its pinned URLs and binds the ID token to the attempt", async (t) => {
  let serve;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    serve(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const providerOrigin = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  // Only the pinned destinations are redirected to the fake IdP; anything else fails.
  t.mock.method(globalThis, "fetch", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.ok(pinned.has(url.href), `Unexpected provider request: ${url.href}`);
    return originalFetch(new URL(url.pathname, providerOrigin), init);
  });
  let exchange;
  const provider =
    (token = idToken()) =>
    async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/oauth/token") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
        exchange = new URLSearchParams(body);
        response.end(JSON.stringify({ access_token: "fixture-access", id_token: token }));
      } else {
        assert.equal(request.url, "/.well-known/jwks.json");
        response.end(JSON.stringify(jwks));
      }
    };

  await t.test("start requests only openid with PKCE, state and nonce", async () => {
    const fixture = loginFixture();
    const response = await fixture.start();
    assert.equal(response.status, 200);
    const { url } = await response.json();
    const authorization = new URL(url);
    assert.equal(`${authorization.origin}${authorization.pathname}`, oidc.authorizationUrl);
    const parameters = authorization.searchParams;
    assert.equal(parameters.get("scope"), "openid");
    assert.equal(parameters.get("client_id"), oidc.clientId);
    assert.equal(parameters.get("response_type"), "code");
    assert.equal(parameters.get("code_challenge_method"), "S256");
    assert.equal(parameters.get("redirect_uri"), `${origin}/api/auth/providers/oidc/callback`);
    assert.equal(parameters.get("nonce"), oidcNonce(secret, parameters.get("state")));
    const [attempt] = fixture.attempts;
    // Rotating the client secret voids pending attempts but keeps enrollment.
    assert.equal(attempt.providerId, `${providerId}:${digest(oidc.clientSecret)}`);
    assert.equal(fixture.login.oidcProviderId, providerId);
    assert.deepEqual(fixture.login.oidcSignIn, {
      label: "single sign-on",
      authorizationUrl: oidc.authorizationUrl,
    });
    assert.equal(fixture.login.googleProviderId, undefined);
    assert.equal((await fixture.start("10.0.0.1", "google")).status, 404);
  });

  await t.test("callback exchanges a 4,000-character code and snapshots (iss, sub)", async () => {
    const fixture = loginFixture();
    serve = provider();
    const code = "c".repeat(4000);
    const before = requests.length;
    await expectDenied(await fixture.callback(`state=${callbackState}&code=${code}`));
    // No session here (State is a fixture); the exchange and snapshot are what count.
    assert.deepEqual(requests.slice(before), ["/oauth/token", "/.well-known/jwks.json"]);
    assert.equal(exchange.get("code"), code);
    assert.equal(exchange.get("client_secret"), oidc.clientSecret);
    assert.deepEqual(fixture.subjects, [[providerId, subject]]);
    assert.deepEqual(fixture.denials, [["EXTERNAL_IDENTITY_REJECTED", "oidc"]]);
  });

  await t.test("a code over 4,096 characters is refused before any exchange", async () => {
    const fixture = loginFixture();
    const before = requests.length;
    await expectDenied(await fixture.callback(`state=${callbackState}&code=${"c".repeat(4097)}`));
    assert.equal(requests.length, before);
    assert.deepEqual(fixture.denials, [["INVALID_ATTEMPT", "oidc"]]);
  });

  await t.test("tokens for another issuer, client or nonce are rejected", async () => {
    for (const overrides of [
      { iss: "https://tenant.idp.example.test" },
      { aud: "other-client" },
      { nonce: "other" },
    ]) {
      const fixture = loginFixture();
      serve = provider(idToken(callbackState, overrides));
      await expectDenied(await fixture.callback());
      assert.deepEqual(fixture.subjects, []);
      assert.deepEqual(fixture.denials, [["EXTERNAL_IDENTITY_REJECTED", "oidc"]]);
    }
  });

  await t.test("a redirecting token endpoint is not followed", async () => {
    const fixture = loginFixture();
    serve = (_request, response) => {
      response.writeHead(302, { location: `${providerOrigin}/elsewhere` });
      response.end();
    };
    const before = requests.length;
    await expectDenied(await fixture.callback());
    assert.deepEqual(requests.slice(before), ["/oauth/token"]);
    assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
    assert.deepEqual(fixture.logs(), [unavailableLog({ step: "token", cause: "redirect" })]);
  });

  await t.test("an unavailable JWKS logs one warning with the HTTP status", async () => {
    const fixture = loginFixture();
    serve = (request, response) => {
      if (request.url === "/oauth/token") {
        provider()(request, response);
        return;
      }
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "jwks down", detail: "fixture-code" }));
    };
    await expectDenied(await fixture.callback());
    assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
    assert.deepEqual(fixture.logs(), [
      unavailableLog({ step: "jwks", cause: "http_status", status: 503 }),
    ]);
    assertNoSecrets(fixture.logs());
  });

  await t.test("a provider-reported server_error logs the authorization step", async () => {
    const fixture = loginFixture();
    const before = requests.length;
    await expectDenied(
      await fixture.callback(`state=${callbackState}&error=server_error&error_description=x`),
    );
    assert.equal(requests.length, before);
    assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
    assert.deepEqual(fixture.logs(), [
      unavailableLog({ step: "authorization", cause: "provider_error" }),
    ]);
  });

  await t.test("a rejected exchange is audited but logs no provider warning", async () => {
    const fixture = loginFixture();
    serve = (_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_grant" }));
    };
    await expectDenied(await fixture.callback());
    assert.deepEqual(fixture.denials, [["EXTERNAL_IDENTITY_REJECTED", "oidc"]]);
    assert.deepEqual(fixture.logs(), []);
  });

  await t.test("GitHub, Google and OIDC share the start budget", async () => {
    const fixture = loginFixture({
      oidc,
      github: { clientId: "github-client", clientSecret: "github-secret" },
      google: { clientId: "g.apps.googleusercontent.com", clientSecret: "g", allowedDomains: [] },
    });
    for (let i = 0; i < 10; i += 1) {
      for (const name of ["github", "google", "oidc"]) {
        assert.equal((await fixture.start("10.0.8.1", name)).status, 200);
      }
    }
    for (const name of ["github", "google", "oidc"]) {
      assert.equal((await fixture.start("10.0.8.1", name)).status, 429);
    }
    assert.equal((await fixture.start("10.0.8.2")).status, 200);
  });
});

function unavailableLog(fields) {
  return {
    severity: "WARN",
    service: "occ-api",
    event: "authentication.provider-unavailable-warning",
    provider: "oidc",
    providerId,
    ...fields,
  };
}

function assertNoSecrets(lines) {
  const text = JSON.stringify(lines);
  for (const value of [
    "fixture-code",
    oidc.clientSecret,
    "fixture-access",
    "tenant.idp.example.test",
    "127.0.0.1",
    "jwks down",
  ]) {
    assert.ok(!text.includes(value), `log leaked ${value}`);
  }
}

test("an unreachable OIDC token endpoint logs connect_refused with its code", async (t) => {
  // A port that was just released refuses connections.
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.ok(pinned.has(url.href), `Unexpected provider request: ${url.href}`);
    return originalFetch(new URL(url.pathname, `http://127.0.0.1:${port}`), init);
  });
  const fixture = loginFixture();
  await expectDenied(await fixture.callback());
  assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
  assert.deepEqual(fixture.logs(), [
    unavailableLog({ step: "token", cause: "connect_refused", code: "ECONNREFUSED" }),
  ]);
  assertNoSecrets(fixture.logs());
});

test("a TLS failure at the OIDC token endpoint logs cause tls", async (t) => {
  // A plain-HTTP listener answers the TLS handshake with garbage.
  const server = createServer((_request, response) => response.end("{}"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.ok(pinned.has(url.href), `Unexpected provider request: ${url.href}`);
    return originalFetch(new URL(url.pathname, `https://127.0.0.1:${port}`), init);
  });
  const fixture = loginFixture();
  await expectDenied(await fixture.callback());
  assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
  const [line, ...rest] = fixture.logs();
  assert.deepEqual(rest, []);
  assert.equal(line.event, "authentication.provider-unavailable-warning");
  assert.equal(line.step, "token");
  assert.equal(line.cause, "tls");
  assertNoSecrets(fixture.logs());
});
