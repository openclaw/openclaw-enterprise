import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createHumanLogin } from "../../apps/controller/src/auth/github.ts";
import { googleNonce } from "../../apps/controller/src/auth/google.ts";
import { humanLoginConfiguration } from "../../apps/controller/src/auth/index.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { APIError, betterAuth } = await import(require.resolve("better-auth"));
const { memoryAdapter } = await import(require.resolve("better-auth/adapters/memory"));
const origin = "https://console.example.test";
const secret = "test-only-authentication-secret-with-at-least-32-characters";
const clientId = "fixture-client.apps.googleusercontent.com";
const clientSecret = "fixture-google-client-secret";
const binding = "b".repeat(43);
const callbackState = "s".repeat(43);
const subject = "110169484474386276334";
const accessToken = "ya29.fixture-google-access-token";
const googleURLs = new Set([
  "https://oauth2.googleapis.com/token",
  "https://www.googleapis.com/oauth2/v3/certs",
]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
const providerId = `google:${digest(clientId)}`;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = {
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture-kid", alg: "RS256", use: "sig" }],
};

const minted = [];
function idToken(state = callbackState, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", kid: "fixture-kid", typ: "JWT" })}.${encode({
    iss: "https://accounts.google.com",
    aud: clientId,
    azp: clientId,
    sub: subject,
    email: "person@example.test",
    email_verified: true,
    iat: now - 5,
    exp: now + 3600,
    nonce: googleNonce(secret, state),
    ...overrides,
  })}`;
  const token = `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
  minted.push(token);
  return token;
}

// The actual Better Auth handler and provider transport run here. State is a
// boundary fixture; these cases make no PostgreSQL or session-commit claims.
function loginFixture(overrides = {}, providers = {}) {
  const subjects = [];
  const denialReasons = [];
  const errors = [];
  const logs = [];
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
    recordDenied: async (reason) => {
      denialReasons.push(reason);
    },
    ...overrides,
  };
  const login = createHumanLogin(
    state,
    {
      recoveryUserId: "fixture-recovery",
      google: { clientId, clientSecret, allowedDomains: [] },
      ...providers,
    },
    origin,
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
    logger: { level: "debug", log: (...values) => logs.push(values) },
    onAPIError: {
      onError(error) {
        if (error instanceof APIError) {
          throw error;
        }
        errors.push(error);
        throw APIError.fromStatus("SERVICE_UNAVAILABLE", {
          message: "Authentication dependency unavailable.",
        });
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
    denialReasons,
    errors,
    logs,
    callback: (query = `state=${callbackState}&code=fixture-code`, ip = "10.0.0.1") =>
      call(
        `/oce/providers/google/callback?${query}`,
        { headers: { cookie: `__Host-occ_login_attempt=${binding}` } },
        ip,
      ),
    start: (ip = "10.0.0.1", provider = "google") =>
      call(`/oce/providers/${provider}/start`, { method: "POST", headers: { origin } }, ip),
    result: (attemptId, cookie, ip = "10.0.0.1") =>
      call(
        "/oce/providers/google/result",
        {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: JSON.stringify({ attemptId }),
        },
        ip,
      ),
  };
}

async function expectDenied(response) {
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { message: "Authentication was not accepted." });
  assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /session_token|login_receipt/);
}

function cookiePairs(response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

async function until(predicate) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Expected transport observation before deadline");
    await delay(10);
  }
}

test("Google sign-in configuration shares the recovery user with GitHub", () => {
  const google = {
    OCC_AUTH_GOOGLE_CLIENT_ID: clientId,
    OCC_AUTH_GOOGLE_CLIENT_SECRET: clientSecret,
  };
  const github = {
    OCC_AUTH_GITHUB_CLIENT_ID: "github-client",
    OCC_AUTH_GITHUB_CLIENT_SECRET: "github-secret",
  };
  const recovery = { OCC_AUTH_GITHUB_RECOVERY_USER_ID: "recovery-user" };
  assert.deepEqual(humanLoginConfiguration({}), {});
  assert.deepEqual(humanLoginConfiguration({ ...google, ...recovery }), {
    google: { clientId, clientSecret, allowedDomains: [], recoveryUserId: "recovery-user" },
  });
  assert.deepEqual(humanLoginConfiguration({ ...github, ...recovery }), {
    github: {
      clientId: "github-client",
      clientSecret: "github-secret",
      recoveryUserId: "recovery-user",
    },
  });
  assert.deepEqual(Object.keys(humanLoginConfiguration({ ...github, ...google, ...recovery })), [
    "github",
    "google",
  ]);
  assert.throws(
    () => humanLoginConfiguration(google),
    /Google sign-in requires client ID, client secret and recovery user ID/,
  );
  assert.throws(
    () => humanLoginConfiguration({ ...google, OCC_AUTH_GITHUB_RECOVERY_USER_ID: " " }),
    /Google sign-in requires client ID, client secret and recovery user ID/,
  );
  assert.throws(
    () => humanLoginConfiguration(github),
    /GitHub sign-in requires client ID, client secret and recovery user ID/,
  );
  assert.throws(
    () => humanLoginConfiguration(recovery),
    /requires client ID, client secret and recovery user ID/,
  );
  assert.throws(
    () => createHumanLogin({}, { recoveryUserId: "recovery-user" }, origin),
    /requires a configured external sign-in provider/,
  );
});

test(
  "Google login bounds actual provider HTTP transport and binds the ID token to its attempt",
  { timeout: 60_000 },
  async (t) => {
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
    // Change only the fixed Google destinations. Real fetch, cancellation, stream reads,
    // response parsing, and redirect handling remain production behavior.
    t.mock.method(globalThis, "fetch", (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.ok(googleURLs.has(url.href), `Unexpected provider request: ${url.href}`);
      return originalFetch(new URL(url.pathname, providerOrigin), init);
    });
    let exchange;
    function provider(token = idToken()) {
      return async (request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/token") {
          let body = "";
          for await (const chunk of request) {
            body += chunk;
          }
          exchange = new URLSearchParams(body);
          response.end(
            JSON.stringify({
              access_token: accessToken,
              id_token: token,
              token_type: "Bearer",
              expires_in: 3599,
              scope: "openid https://www.googleapis.com/auth/userinfo.email",
            }),
          );
        } else {
          assert.equal(request.url, "/oauth2/v3/certs");
          assert.equal(request.method, "GET");
          response.end(JSON.stringify(jwks));
        }
      };
    }
    // Neither the client secret nor any provider token may reach logs or errors.
    function assertNoSecrets(login, ...bodies) {
      const text = JSON.stringify([login.logs, login.errors.map(String), ...bodies]);
      for (const value of [clientSecret, accessToken, ...minted]) {
        assert.equal(text.includes(value), false, "a credential reached logs or errors");
      }
    }

    await t.test("start requests exactly openid email with PKCE, state and nonce", async () => {
      const login = loginFixture();
      const response = await login.start();
      assert.equal(response.status, 200);
      const { url, attemptId } = await response.json();
      assert.match(attemptId, /^[A-Za-z0-9_-]{43}$/);
      const authorization = new URL(url);
      assert.equal(
        `${authorization.origin}${authorization.pathname}`,
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      const parameters = authorization.searchParams;
      assert.deepEqual([...parameters.keys()].sort(), [
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "nonce",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
      ]);
      assert.equal(parameters.get("response_type"), "code");
      assert.equal(parameters.get("client_id"), clientId);
      assert.equal(parameters.get("scope"), "openid email");
      assert.equal(parameters.get("redirect_uri"), `${origin}/api/auth/providers/google/callback`);
      assert.equal(parameters.get("code_challenge_method"), "S256");
      const attemptState = parameters.get("state");
      assert.match(attemptState, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(parameters.get("nonce"), googleNonce(secret, attemptState));
      assert.equal(url.includes(attemptId), false, "the provider never sees the attemptId");
      const [attempt] = login.attempts;
      assert.equal(attempt.providerId, `${providerId}:${digest(clientSecret)}`);
      assert.equal(attempt.callbackURL, `${origin}/api/auth/providers/google/callback`);
      assert.equal(
        parameters.get("code_challenge"),
        createHash("sha256").update(attempt.codeVerifier).digest("base64url"),
      );
      const cookie = response.headers.get("set-cookie");
      assert.match(cookie, /^__Host-occ_login_attempt=/);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /Secure/i);
      assert.match(cookie, /SameSite=Lax/i);
      assertNoSecrets(login, url);
    });

    await t.test("only the configured providers have routes", async () => {
      const googleOnly = loginFixture();
      assert.equal(googleOnly.login.googleProviderId, providerId);
      assert.equal(googleOnly.login.githubProviderId, undefined);
      assert.equal((await googleOnly.start("10.0.0.1", "github")).status, 404);
      const both = loginFixture(
        {},
        { github: { clientId: "github-client", clientSecret: "github-secret" } },
      );
      assert.equal(both.login.githubProviderId, `github:${digest("github-client")}`);
      const github = new URL((await (await both.start("10.0.0.1", "github")).json()).url);
      assert.equal(github.origin, "https://github.com");
      assert.equal(github.searchParams.has("nonce"), false);
      assert.equal(both.attempts[0].providerId.startsWith("github:"), true);
    });

    await t.test(
      "callback exchanges the code, verifies the ID token and binds the result once",
      async () => {
        const createdAt = new Date();
        const user = {
          id: "existing-user",
          name: "Existing user",
          email: "existing@example.test",
          emailVerified: false,
          createdAt,
          updatedAt: createdAt,
        };
        let issued;
        const snapshots = [];
        const login = loginFixture({
          snapshotExternal: async (snapshotProviderId, snapshotSubject) => {
            snapshots.push([snapshotProviderId, snapshotSubject]);
            return { user, proof: { userId: user.id } };
          },
          issueSession: async (_proof, session) => {
            issued = {
              ...session,
              createdAt,
              updatedAt: createdAt,
              expiresAt: new Date(createdAt.getTime() + 28_800_000),
            };
            return issued;
          },
          currentSession: async (token) =>
            issued?.token === token ? { ...issued, user } : undefined,
        });
        const started = await login.start();
        const { url, attemptId } = await started.json();
        const attemptState = new URL(url).searchParams.get("state");
        serve = provider(idToken(attemptState));
        const before = requests.length;
        const callback = await login.callback(`state=${attemptState}&code=fixture-code`);
        assert.equal(callback.status, 200);
        assert.deepEqual(requests.slice(before), ["/token", "/oauth2/v3/certs"]);
        assert.equal(exchange.get("client_id"), clientId);
        assert.equal(exchange.get("client_secret"), clientSecret);
        assert.equal(exchange.get("code"), "fixture-code");
        assert.equal(exchange.get("redirect_uri"), `${origin}/api/auth/providers/google/callback`);
        assert.equal(exchange.get("code_verifier"), "v".repeat(43));
        assert.equal(exchange.get("grant_type"), "authorization_code");
        // The identity is the provider-instance key and "sub", never the email.
        assert.deepEqual(snapshots, [[providerId, subject]]);
        assert.equal(login.attempts[1].providerId, `${providerId}:${digest(clientSecret)}`);
        const receipt = callback.headers
          .getSetCookie()
          .find((value) => value.startsWith("__Host-occ_login_receipt="));
        assert.match(receipt, /SameSite=Strict/i);
        const cookies = cookiePairs(callback);
        const exchanged = await login.result(attemptId, cookies);
        assert.equal(exchanged.status, 200);
        const { sessionKey } = await exchanged.json();
        assert.match(sessionKey, /^[A-Za-z0-9_-]{43}$/);
        await expectDenied(await login.result(attemptId, cookies));
        assertNoSecrets(login, cookies, sessionKey);
      },
    );

    await t.test("an ID token minted for another attempt's nonce is rejected", async () => {
      const login = loginFixture();
      serve = provider(idToken("o".repeat(43)));
      await expectDenied(await login.callback());
      assert.equal(exchange.get("code"), "fixture-code");
      assert.deepEqual(login.subjects, []);
      assert.deepEqual(login.denialReasons, ["EXTERNAL_IDENTITY_REJECTED"]);
      // A token without any nonce is rejected the same way.
      serve = provider(idToken(callbackState, { nonce: undefined }));
      await expectDenied(await login.callback());
      assert.deepEqual(login.subjects, []);
      assertNoSecrets(login);
    });

    await t.test("provider errors remain generic and never reach logs", async () => {
      const login = loginFixture();
      serve = (_request, response) =>
        response.end(
          JSON.stringify({
            error: "fixture-sensitive-error",
            access_token: accessToken,
            id_token: idToken(),
          }),
        );
      const response = await login.callback();
      const body = await response.clone().text();
      await expectDenied(response);
      assert.deepEqual(login.subjects, []);
      assert.equal(body.includes("fixture-sensitive-error"), false);
      assertNoSecrets(login, body);
    });

    for (const endpoint of ["/token", "/oauth2/v3/certs"]) {
      await t.test(`${endpoint} refuses redirects without following them`, async () => {
        const login = loginFixture();
        const valid = provider();
        serve = (request, response) => {
          if (request.url !== endpoint) {
            return valid(request, response);
          }
          response.writeHead(302, { location: `${providerOrigin}/redirect-target` });
          response.end("fixture-sensitive-error");
        };
        const before = requests.length;
        await expectDenied(await login.callback());
        assert.equal(requests.slice(before).includes("/redirect-target"), false);
        assert.deepEqual(login.subjects, []);
        assertNoSecrets(login);
      });

      for (const declared of [false, true]) {
        await t.test(
          `${endpoint} cancels oversized ${declared ? "declared" : "chunked"} bodies`,
          async () => {
            const login = loginFixture();
            const valid = provider();
            let closed = false;
            serve = (request, response) => {
              if (request.url !== endpoint) {
                return valid(request, response);
              }
              response.on("close", () => {
                closed = true;
              });
              if (declared) {
                response.setHeader("content-length", String(128 * 1024));
              }
              response.write("x".repeat(64 * 1024 + 1));
              // Leave the stream open: rejection must cancel it without waiting for EOF.
            };
            const started = performance.now();
            await expectDenied(await login.callback());
            assert.ok(performance.now() - started < 2_000);
            await until(() => closed);
            assert.deepEqual(login.subjects, []);
          },
        );
      }
    }

    await t.test("certificate body reads use the remaining overall deadline", async () => {
      const login = loginFixture();
      const valid = provider();
      let closed = false;
      serve = async (request, response) => {
        if (request.url === "/token") {
          await delay(3_000);
          return valid(request, response);
        }
        response.on("close", () => {
          closed = true;
        });
        response.write('{"keys":');
      };
      const started = performance.now();
      await expectDenied(await login.callback());
      const elapsed = performance.now() - started;
      // Separate per-request timers would take about 13 seconds here.
      assert.ok(elapsed >= 9_000 && elapsed < 12_000, `Elapsed: ${elapsed}`);
      await until(() => closed);
      assert.deepEqual(login.subjects, []);
      assert.deepEqual(login.denialReasons, ["PROVIDER_UNAVAILABLE"]);
    });

    await t.test("GitHub and Google share one external admission budget", async () => {
      const login = loginFixture(
        {},
        { github: { clientId: "github-client", clientSecret: "github-secret" } },
      );
      const before = requests.length;
      for (let i = 0; i < 30; i += 1) {
        await expectDenied(await login.callback("state=invalid", "10.0.7.1"));
      }
      assert.equal((await login.callback(undefined, "10.0.7.1")).status, 429);
      assert.equal((await login.start("10.0.7.1", "github")).status, 429);
      assert.equal((await login.start("10.0.7.1")).status, 429);
      assert.equal((await login.start("10.0.7.2")).status, 200);
      assert.equal(requests.length, before);
    });
  },
);
