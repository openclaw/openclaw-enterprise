import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createHumanLogin } from "../../apps/controller/src/auth/github.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/index.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { APIError, betterAuth } = await import(require.resolve("better-auth"));
const { memoryAdapter } = await import(require.resolve("better-auth/adapters/memory"));
const origin = "https://console.example.test";
const binding = "b".repeat(43);
const callbackState = "s".repeat(43);

// The actual Better Auth handler and provider transport run here. State is a
// boundary fixture; these cases make no PostgreSQL or session-commit claims.
function loginFixture(overrides = {}) {
  const subjects = [];
  const denialReasons = [];
  const errors = [];
  const state = {
    createAttempt: async () => {
      const createdAt = new Date("2030-01-01T00:00:00Z");
      return { createdAt, expiresAt: new Date(createdAt.getTime() + 300_000) };
    },
    consumeAttempt: async () => ({ codeVerifier: "v".repeat(43), createdAt: new Date() }),
    snapshotExternal: async (_providerId, subject) => {
      subjects.push(subject);
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
      github: { clientId: "fixture-client", clientSecret: "fixture-client-secret" },
    },
    origin,
  );
  login.designateRecovery("Recovery@example.test");
  const db = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    baseURL: origin,
    secret: "test-only-authentication-secret-with-at-least-32-characters",
    database: login.database(memoryAdapter(db)),
    session: {
      expiresIn: 8 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    plugins: [login.plugin],
    rateLimit: { enabled: false },
    logger: { disabled: true },
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
  return {
    auth,
    db,
    subjects,
    denialReasons,
    errors,
    get denied() {
      return denialReasons.length;
    },
    // The controller wrapper sets x-occ-client-ip from the socket peer or a trusted ingress.
    callback: (query = `state=${callbackState}&code=fixture-code`, ip = "10.0.0.1") =>
      auth.handler(
        new Request(`${origin}/api/auth/oce/providers/github/callback?${query}`, {
          headers: { cookie: `__Host-occ_login_attempt=${binding}`, "x-occ-client-ip": ip },
        }),
      ),
    start: (ip = "10.0.0.1") =>
      auth.handler(
        new Request(`${origin}/api/auth/oce/providers/github/start`, {
          method: "POST",
          headers: { origin, "x-occ-client-ip": ip },
        }),
      ),
    result: (attemptId, cookie, ip = "10.0.0.1") =>
      auth.handler(
        new Request(`${origin}/api/auth/oce/providers/github/result`, {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json", "x-occ-client-ip": ip },
          body: JSON.stringify({ attemptId }),
        }),
      ),
    password: (password = "too-short", { ip = "10.0.0.1", email = "missing@example.test" } = {}) =>
      auth.handler(
        new Request(`${origin}/api/auth/oce/password`, {
          method: "POST",
          headers: { origin, "content-type": "application/json", "x-occ-client-ip": ip },
          body: JSON.stringify({ email, password }),
        }),
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

function token(response) {
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({ access_token: "ghu_fixture_provider_token", token_type: "bearer", scope: "" }),
  );
}

async function until(predicate) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Expected transport observation before deadline");
    await delay(10);
  }
}

test(
  "GitHub login bounds actual provider HTTP transport and local admission",
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
    // Change only the fixed destinations. Real fetch, cancellation, stream reads,
    // response parsing, and redirect handling remain production behavior.
    t.mock.method(globalThis, "fetch", (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.ok(
        url.href === "https://github.com/login/oauth/access_token" ||
          url.href === "https://api.github.com/user",
      );
      return originalFetch(new URL(url.pathname, providerOrigin), init);
    });

    await t.test(
      "nonexpiring App token preserves client authentication, callback and PKCE without email lookup",
      async () => {
        const login = loginFixture();
        let exchange;
        serve = async (request, response) => {
          if (request.url === "/login/oauth/access_token") {
            let body = "";
            for await (const chunk of request) {
              body += chunk;
            }
            exchange = new URLSearchParams(body);
            token(response);
          } else {
            assert.equal(request.headers.authorization, "Bearer ghu_fixture_provider_token");
            response.end(JSON.stringify({ id: 12345678 }));
          }
        };
        const before = requests.length;
        await expectDenied(await login.callback());
        assert.equal(exchange.get("client_id"), "fixture-client");
        assert.equal(exchange.get("client_secret"), "fixture-client-secret");
        assert.equal(exchange.get("redirect_uri"), `${origin}/api/auth/providers/github/callback`);
        assert.equal(exchange.get("code_verifier"), "v".repeat(43));
        assert.equal(exchange.get("grant_type"), "authorization_code");
        assert.deepEqual(login.subjects, ["12345678"]);
        assert.deepEqual(login.denialReasons, ["EXTERNAL_IDENTITY_REJECTED"]);
        assert.deepEqual(requests.slice(before), ["/login/oauth/access_token", "/user"]);
      },
    );

    for (const endpoint of ["/login/oauth/access_token", "/user"]) {
      await t.test(
        `${endpoint} refuses redirects without following their destination`,
        async () => {
          const login = loginFixture();
          serve = (request, response) => {
            if (request.url !== endpoint) {
              return token(response);
            }
            response.writeHead(302, { location: `${providerOrigin}/redirect-target` });
            response.end("fixture-sensitive-error");
          };
          const before = requests.length;
          await expectDenied(await login.callback());
          assert.equal(requests.slice(before).includes("/redirect-target"), false);
          assert.deepEqual(login.subjects, []);
          assert.deepEqual(login.denialReasons, ["PROVIDER_UNAVAILABLE"]);
        },
      );

      for (const declared of [false, true]) {
        await t.test(
          `${endpoint} cancels oversized ${declared ? "declared" : "chunked"} bodies`,
          async () => {
            const login = loginFixture();
            let closed = false;
            serve = (request, response) => {
              if (request.url !== endpoint) {
                return token(response);
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

    await t.test("shared deadline aborts a stalled token response before headers", async () => {
      const login = loginFixture();
      let closed = false;
      serve = (_request, response) => {
        response.on("close", () => {
          closed = true;
        });
      };
      const started = performance.now();
      await expectDenied(await login.callback());
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 9_000 && elapsed < 12_000, `Elapsed: ${elapsed}`);
      await until(() => closed);
      assert.deepEqual(login.subjects, []);
      assert.deepEqual(login.denialReasons, ["PROVIDER_UNAVAILABLE"]);
    });

    await t.test("profile body reads use the remaining overall deadline", async () => {
      const login = loginFixture();
      let closed = false;
      serve = async (request, response) => {
        if (request.url === "/login/oauth/access_token") {
          await delay(3_000);
          return token(response);
        }
        response.on("close", () => {
          closed = true;
        });
        response.write('{"id":');
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

    await t.test(
      "provider errors remain generic and do not proceed to identity lookup",
      async () => {
        const login = loginFixture();
        serve = (_request, response) =>
          response.end(
            JSON.stringify({
              error: "fixture-sensitive-error",
              access_token: "fixture-provider-token",
            }),
          );
        await expectDenied(await login.callback());
        assert.deepEqual(login.subjects, []);
        assert.deepEqual(login.denialReasons, ["EXTERNAL_IDENTITY_REJECTED"]);
      },
    );

    await t.test(
      "callback denials separate invalid attempts, provider outages and rejected identities",
      async () => {
        const profile = (status, body) => (request, response) => {
          if (request.url === "/login/oauth/access_token") {
            return token(response);
          }
          response.writeHead(status).end(body);
        };
        const unreachable = () => assert.fail("The provider must not be called");
        const withState = (query) => `state=${callbackState}&${query}`;
        // [case, expected reason, provider handler, callback query, State overrides]
        const cases = [
          ["malformed state", "INVALID_ATTEMPT", unreachable, "state=short&code=c"],
          [
            "unknown attempt",
            "INVALID_ATTEMPT",
            unreachable,
            undefined,
            {
              consumeAttempt: async () => undefined,
            },
          ],
          [
            "access_denied",
            "EXTERNAL_IDENTITY_REJECTED",
            unreachable,
            withState("error=access_denied"),
          ],
          [
            "provider outage",
            "PROVIDER_UNAVAILABLE",
            unreachable,
            withState("error=temporarily_unavailable"),
          ],
          [
            "token 503",
            "PROVIDER_UNAVAILABLE",
            (_request, response) => response.writeHead(503).end(),
          ],
          [
            "token 429",
            "PROVIDER_UNAVAILABLE",
            (_request, response) => response.writeHead(429).end(),
          ],
          [
            "token not JSON",
            "PROVIDER_UNAVAILABLE",
            (_request, response) => response.end("<html>"),
          ],
          ["profile 500", "PROVIDER_UNAVAILABLE", profile(500, "")],
          ["profile 401", "EXTERNAL_IDENTITY_REJECTED", profile(401, "{}")],
          ["unenrolled subject", "EXTERNAL_IDENTITY_REJECTED", profile(200, '{"id":12345678}')],
        ];
        for (const [name, reason, handler, query, overrides] of cases) {
          const login = loginFixture(overrides);
          serve = handler;
          await expectDenied(await login.callback(query));
          assert.deepEqual(login.denialReasons, [reason], name);
        }
      },
    );

    for (const failurePoint of ["consumeAttempt", "snapshotExternal", "issueSession"]) {
      await t.test(`callback preserves ${failurePoint} failures for its error owner`, async () => {
        const failure =
          failurePoint === "issueSession"
            ? new PostgresCommitOutcomeUnknownError()
            : new Error("fixture-sensitive-dependency-error");
        const createdAt = new Date();
        const user = {
          id: "existing-user",
          name: "Existing user",
          email: "existing@example.test",
          emailVerified: false,
          createdAt,
          updatedAt: createdAt,
        };
        let issueAttempts = 0;
        const login = loginFixture({
          snapshotExternal: async () => ({ user, proof: { userId: user.id } }),
          [failurePoint]: async () => {
            if (failurePoint === "issueSession") {
              issueAttempts += 1;
            }
            throw failure;
          },
        });
        serve = (request, response) => {
          if (request.url === "/login/oauth/access_token") {
            return token(response);
          }
          response.end(JSON.stringify({ id: 12345678 }));
        };
        const before = requests.length;
        const response = await login.callback();
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          message: "Authentication dependency unavailable.",
        });
        // A lost COMMIT acknowledgement may follow a committed login. The callback
        // must preserve that uncertainty without retrying or recording identity denial.
        assert.deepEqual(login.errors, [failure]);
        assert.deepEqual(login.denialReasons, []);
        assert.equal(issueAttempts, failurePoint === "issueSession" ? 1 : 0);
        assert.equal(requests.length - before, failurePoint === "consumeAttempt" ? 0 : 2);
        assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /session_token/);
      });
    }

    await t.test(
      "a GitHub callback flood from one client address leaves other clients admitted",
      async () => {
        const login = loginFixture();
        const before = requests.length;
        for (let i = 0; i < 30; i += 1) {
          await expectDenied(await login.callback("state=invalid", "10.0.0.1"));
        }
        assert.equal((await login.callback(undefined, "10.0.0.1")).status, 429);
        assert.equal((await login.start("10.0.0.1")).status, 429);
        assert.equal((await login.start("10.0.0.2")).status, 200);
        await expectDenied(await login.callback("state=invalid", "10.0.0.2"));
        assert.equal(requests.length, before);
        // Password admission is a separate lane.
        await expectDenied(await login.password(undefined, { ip: "10.0.0.1" }));
      },
    );

    await t.test("password budgets are kept per email and per client address", async () => {
      const login = loginFixture();
      const email = "a@example.test";
      for (let i = 0; i < 10; i += 1) {
        await expectDenied(await login.password(undefined, { ip: `10.0.1.${i}`, email }));
      }
      assert.equal((await login.password(undefined, { ip: "10.0.1.99", email })).status, 429);
      await expectDenied(
        await login.password(undefined, { ip: "10.0.1.0", email: "b@example.test" }),
      );
      for (let i = 0; i < 9; i += 1) {
        await expectDenied(
          await login.password(undefined, { ip: "10.0.2.1", email: `ip-${i}@example.test` }),
        );
      }
      // Case and surrounding space do not create a fresh email budget.
      await expectDenied(
        await login.password(undefined, { ip: "10.0.2.1", email: " B@example.test " }),
      );
      assert.equal(
        (await login.password(undefined, { ip: "10.0.2.1", email: "c@example.test" })).status,
        429,
      );
      await expectDenied(
        await login.password(undefined, { ip: "10.0.2.2", email: "b@example.test" }),
      );
      assert.deepEqual(login.denialReasons, []);
    });

    await t.test(
      "the recovery email keeps a reserved password lane with its own budget",
      async () => {
        const held = [];
        const login = loginFixture({
          snapshotPassword: () => new Promise((resolve) => held.push(resolve)),
        });
        const valid = "valid-length-fixture-password";
        const pending = Array.from({ length: 4 }, (_, i) =>
          login.password(valid, { ip: `10.0.3.${i}`, email: `held-${i}@example.test` }),
        );
        await until(() => held.length === 4);
        assert.equal(
          (await login.password(valid, { ip: "10.0.3.9", email: "fresh@example.test" })).status,
          429,
        );
        pending.push(login.password(valid, { email: "recovery@example.test" }));
        await until(() => held.length === 5);
        // The one reserved slot is taken; recovery cannot exceed the global lane plus reserve.
        assert.equal((await login.password(valid, { email: "recovery@example.test" })).status, 429);
        for (const resolve of held) {
          resolve(undefined);
        }
        await Promise.all((await Promise.all(pending)).map(expectDenied));
        for (let i = 1; i < 20; i += 1) {
          await expectDenied(await login.password(undefined, { email: "recovery@example.test" }));
        }
        assert.equal(
          (await login.password(undefined, { email: "RECOVERY@example.test" })).status,
          429,
        );
        // Recovery attempts spent neither the address budget nor the global lane.
        await expectDenied(await login.password(undefined, { email: "other@example.test" }));
      },
    );

    await t.test("the admission table stays bounded and evicts idle keys", async () => {
      const login = loginFixture();
      const email = "c@example.test";
      for (let i = 0; i < 10; i += 1) {
        await expectDenied(await login.password(undefined, { ip: `10.0.4.${i}`, email }));
      }
      assert.equal((await login.password(undefined, { ip: "10.0.4.99", email })).status, 429);
      for (let i = 0; i < 4096; i += 1) {
        const response = await login.password(undefined, {
          ip: `10.1.${i >> 8}.${i & 255}`,
          email: `cycle-${i}@example.test`,
        });
        assert.equal(response.status, 401);
      }
      await expectDenied(await login.password(undefined, { ip: "10.0.4.99", email }));
    });

    await t.test(
      "eight active GitHub callbacks cap remote work and release capacity on failure",
      async () => {
        const login = loginFixture();
        const held = [];
        serve = (_request, response) => {
          held.push(response);
        };
        const pending = Array.from({ length: 8 }, (_, i) =>
          login.callback(undefined, `10.0.5.${i}`),
        );
        await until(() => held.length === 8);
        assert.equal((await login.callback(undefined, "10.0.5.99")).status, 429);
        assert.equal(held.length, 8);
        for (const response of held) {
          response.writeHead(503).end();
        }
        await Promise.all((await Promise.all(pending)).map(expectDenied));
        serve = (_request, response) => response.writeHead(503).end();
        await expectDenied(await login.callback(undefined, "10.0.5.99"));
      },
    );

    await t.test("four active password checks cap expensive work independently", async () => {
      const held = [];
      const login = loginFixture({
        snapshotPassword: () => new Promise((resolve) => held.push(resolve)),
      });
      const valid = "valid-length-fixture-password";
      const pending = Array.from({ length: 4 }, (_, i) =>
        login.password(valid, { ip: `10.0.6.${i}`, email: `active-${i}@example.test` }),
      );
      await until(() => held.length === 4);
      assert.equal(
        (await login.password(valid, { ip: "10.0.6.99", email: "late@example.test" })).status,
        429,
      );
      assert.equal(held.length, 4);
      for (const resolve of held) {
        resolve(undefined);
      }
      await Promise.all((await Promise.all(pending)).map(expectDenied));
      await expectDenied(await login.password());
    });

    for (const expired of [false, true]) {
      await t.test(
        `session cookie ${expired ? "is refused after delayed completion" : "uses the State duration"}`,
        async () => {
          const createdAt = new Date("2030-01-01T00:00:00Z");
          const user = {
            id: "existing-user",
            name: "Existing user",
            email: "existing@example.test",
            emailVerified: false,
            createdAt,
            updatedAt: createdAt,
          };
          const login = loginFixture({
            snapshotExternal: async () => ({ user, proof: { userId: user.id } }),
            issueSession: async (_proof, session) => {
              if (expired) {
                await delay(30);
              }
              return {
                ...session,
                createdAt,
                updatedAt: createdAt,
                expiresAt: new Date(createdAt.getTime() + (expired ? 10 : 28_800_000)),
              };
            },
          });
          serve = (request, response) => {
            if (request.url === "/login/oauth/access_token") {
              return token(response);
            }
            response.end(JSON.stringify({ id: 12345678 }));
          };
          const response = await login.callback();
          if (expired) {
            await expectDenied(response);
          } else {
            assert.equal(response.status, 200);
            const cookie = response.headers
              .getSetCookie()
              .find((value) => value.includes("session_token="));
            const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie)?.[1]);
            assert.ok(maxAge > 0 && maxAge < 28_800, "Session cookie must subtract elapsed time");
            assert.deepEqual(await response.json(), { authenticated: true });
            assert.match(response.headers.get("set-cookie"), /__Host-occ_login_receipt=/);
          }
        },
      );
    }

    await t.test(
      "callback receipt binds the starting attempt and exchanges once for its session key",
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
        const login = loginFixture({
          snapshotExternal: async () => ({ user, proof: { userId: user.id } }),
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
        serve = (request, response) => {
          if (request.url === "/login/oauth/access_token") {
            return token(response);
          }
          response.end(JSON.stringify({ id: 12345678 }));
        };
        const started = await login.start();
        const other = await (await login.start()).json();
        const { url, attemptId } = await started.json();
        assert.match(attemptId, /^[A-Za-z0-9_-]{43}$/);
        assert.notEqual(attemptId, other.attemptId, "each attempt has its own public id");
        const attemptState = new URL(url).searchParams.get("state");
        assert.equal(url.includes(attemptId), false, "the provider never sees the attemptId");

        const callback = await login.callback(`state=${attemptState}&code=fixture-code`);
        assert.equal(callback.status, 200);
        const receipt = callback.headers
          .getSetCookie()
          .find((value) => value.startsWith("__Host-occ_login_receipt="));
        assert.ok(receipt, "successful callback sets the login receipt");
        assert.match(receipt, /Max-Age=120/);
        assert.match(receipt, /Path=\//);
        assert.match(receipt, /HttpOnly/i);
        assert.match(receipt, /Secure/i);
        assert.match(receipt, /SameSite=Strict/i);
        // The receipt names the session without carrying its bearer token.
        assert.equal(receipt.includes(issued.token), false);
        const cookies = cookiePairs(callback);

        // Another tab's attempt cannot claim this session.
        await expectDenied(await login.result(other.attemptId, cookies));
        const exchanged = await login.result(attemptId, cookies);
        assert.equal(exchanged.status, 200);
        assert.doesNotMatch(exchanged.headers.get("set-cookie") ?? "", /session_token/);
        assert.match(exchanged.headers.get("set-cookie") ?? "", /occ_login_receipt=;.*Max-Age=0/);
        const { sessionKey } = await exchanged.json();
        assert.match(sessionKey, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(sessionKey.includes(issued.id), false);
        // A copied receipt is single-use even while it is still within its lifetime.
        await expectDenied(await login.result(attemptId, cookies));
      },
    );

    await t.test(
      "attempt cookie lifetime uses State duration despite controller clock skew",
      async () => {
        const login = loginFixture();
        const response = await login.start();
        assert.equal(response.status, 200);
        const cookie = response.headers.get("set-cookie");
        const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie)?.[1]);
        assert.ok(maxAge > 0 && maxAge < 300, "Attempt cookie must subtract elapsed time");
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /Secure/i);
        const authorization = new URL((await response.json()).url);
        assert.equal(authorization.searchParams.has("scope"), false);
        assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      },
    );

    await t.test(
      "attempt completion that outlives its State lifetime emits no cookie",
      async () => {
        const login = loginFixture({
          createAttempt: async () => {
            await delay(30);
            const createdAt = new Date();
            return { createdAt, expiresAt: new Date(createdAt.getTime() + 10) };
          },
        });
        const response = await login.start();
        await expectDenied(response);
        assert.equal(response.headers.get("set-cookie"), null);
      },
    );
  },
);

test("guarded adapter never lists, counts or mutates raw session rows", async () => {
  const login = loginFixture({
    // State owns session reads; this row would be rejected by it (for example, revoked).
    currentSession: async () => undefined,
  });
  const now = new Date();
  login.db.user.push({
    id: "stale-user",
    email: "stale@example.test",
    name: "Stale",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  login.db.session.push({
    id: "stale-session",
    userId: "stale-user",
    token: "stale-session-token",
    expiresAt: new Date(now.getTime() + 3_600_000),
    createdAt: now,
    updatedAt: now,
  });
  const context = await login.auth.$context;
  assert.deepEqual(await context.internalAdapter.listSessions("stale-user"), []);
  assert.deepEqual(await context.adapter.findMany({ model: "session" }), []);
  assert.equal(await context.adapter.count({ model: "session" }), 0);
  const where = [{ field: "id", value: "stale-session" }];
  await assert.rejects(context.adapter.consumeOne({ model: "session", where }));
  await assert.rejects(
    context.adapter.incrementOne({ model: "session", where, increment: { version: 1 } }),
  );
  assert.equal(login.db.session.length, 1, "the raw row is untouched");
  // Other models still pass through to the underlying adapter.
  assert.equal(await context.adapter.count({ model: "user" }), 1);
});
