import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/index.ts";
import { githubLoginConfiguration } from "../../apps/controller/src/auth/index.ts";
import {
  callbackState,
  cookiePairs,
  createLoginFixture,
  expectDenied,
  loginOrigin as origin,
  redirectProviderFetch,
  startProviderServer,
  testOversizedProviderBodies,
  until,
} from "../helpers/human-login-transport.mjs";

const providerId = `github:${createHash("sha256").update("fixture-client").digest("hex")}`;
// The production deadline is 10 s; the stalled-provider cases shorten it to keep the wait short.
const providerDeadlineMs = 2_000;

function loginFixture(state = {}, { trustedClientAddress = true, ...options } = {}) {
  return createLoginFixture({
    provider: "github",
    providers: { github: { clientId: "fixture-client", clientSecret: "fixture-client-secret" } },
    state,
    trustedClientAddress,
    recoveryEmail: "Recovery@example.test",
    ...options,
  });
}

function token(response) {
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({ access_token: "ghu_fixture_provider_token", token_type: "bearer", scope: "" }),
  );
}

test(
  "GitHub login bounds actual provider HTTP transport and local admission",
  { timeout: 60_000 },
  async (t) => {
    let serve;
    const { requests, port } = await startProviderServer(t, (request, response) =>
      serve(request, response),
    );
    const providerOrigin = `http://127.0.0.1:${port}`;
    redirectProviderFetch(
      t,
      new Set(["https://github.com/login/oauth/access_token", "https://api.github.com/user"]),
      providerOrigin,
    );

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
        assert.deepEqual(login.subjects, [[providerId, "12345678"]]);
        assert.deepEqual(login.denials, [["EXTERNAL_IDENTITY_REJECTED", "github"]]);
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
          assert.deepEqual(login.denials, [["PROVIDER_UNAVAILABLE", "github"]]);
        },
      );
    }

    await testOversizedProviderBodies(t, {
      endpoints: [
        ["/login/oauth/access_token", "token"],
        ["/user", "profile"],
      ],
      serve: (handler) => {
        serve = handler;
      },
      provider: () => (_request, response) => token(response),
      login: loginFixture,
    });

    await t.test("shared deadline aborts a stalled token response before headers", async () => {
      const login = loginFixture({}, { providerDeadlineMs });
      let closed = false;
      serve = (_request, response) => {
        response.on("close", () => {
          closed = true;
        });
      };
      const started = performance.now();
      await expectDenied(await login.callback());
      const elapsed = performance.now() - started;
      assert.ok(
        elapsed >= providerDeadlineMs * 0.9 && elapsed < providerDeadlineMs + 2_000,
        `Elapsed: ${elapsed}`,
      );
      await until(() => closed);
      assert.deepEqual(login.subjects, []);
      assert.deepEqual(login.denials, [["PROVIDER_UNAVAILABLE", "github"]]);
    });

    await t.test("profile body reads use the remaining overall deadline", async () => {
      const login = loginFixture({}, { providerDeadlineMs });
      let closed = false;
      serve = async (request, response) => {
        if (request.url === "/login/oauth/access_token") {
          await delay(1_500);
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
      // Separate per-request timers would take about 3.5 seconds here.
      assert.ok(
        elapsed >= providerDeadlineMs * 0.9 && elapsed < providerDeadlineMs + 1_000,
        `Elapsed: ${elapsed}`,
      );
      await until(() => closed);
      assert.deepEqual(login.subjects, []);
      assert.deepEqual(login.denials, [["PROVIDER_UNAVAILABLE", "github"]]);
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
        assert.deepEqual(login.denials, [["EXTERNAL_IDENTITY_REJECTED", "github"]]);
        assert.deepEqual(login.operationalLogs(), []);
      },
    );

    // GitHub answers token errors with HTTP 200. A wrong client secret or callback
    // registration fails every sign-in, so the operator log must name it.
    for (const code of ["incorrect_client_credentials", "redirect_uri_mismatch"]) {
      await t.test(`token error ${code} is logged as a refused client`, async () => {
        const login = loginFixture();
        serve = (_request, response) =>
          response.end(
            JSON.stringify({ error: code, error_description: "fixture-sensitive-error" }),
          );
        await expectDenied(await login.callback());
        assert.deepEqual(login.subjects, []);
        assert.deepEqual(login.denials, [["PROVIDER_UNAVAILABLE", "github"]]);
        assert.deepEqual(login.operationalLogs(), [
          {
            severity: "WARN",
            service: "occ-api",
            event: "authentication.provider-unavailable-warning",
            provider: "github",
            providerId,
            step: "token",
            cause: "client_rejected",
          },
        ]);
        assert.doesNotMatch(
          JSON.stringify(login.operationalLogs()),
          /fixture-sensitive|fixture-client-secret/,
        );
      });
    }

    await t.test(
      "callbacks count unmatched attempts and audit provider outages and rejected identities",
      async () => {
        const profile = (status, body) => (request, response) => {
          if (request.url === "/login/oauth/access_token") {
            return token(response);
          }
          response.writeHead(status).end(body);
        };
        const unreachable = () => assert.fail("The provider must not be called");
        const withState = (query) => `state=${callbackState}&${query}`;
        // [case, expected audit reason (none: counted as unmatched), provider handler,
        // callback query, State overrides]
        const cases = [
          ["malformed state", undefined, unreachable, "state=short&code=c"],
          [
            "unknown attempt",
            undefined,
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
          assert.deepEqual(login.denials, reason === undefined ? [] : [[reason, "github"]], name);
          assert.deepEqual(login.unmatched, reason === undefined ? ["github"] : [], name);
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
        assert.deepEqual(login.denials, []);
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
        // Each step keeps its own budget, so a callback flood does not spend start's.
        assert.equal((await login.start("10.0.0.1")).status, 200);
        assert.equal((await login.start("10.0.0.2")).status, 200);
        await expectDenied(await login.callback("state=invalid", "10.0.0.2"));
        assert.equal(requests.length, before);
        // Password admission belongs to the controller route, not this endpoint.
        await expectDenied(await login.password(undefined, { ip: "10.0.0.1" }));
      },
    );

    await t.test(
      "without a trusted proxy, external steps never share one Installation-wide budget",
      async () => {
        // Every browser behind the ingress arrives from one address, so it is not a key.
        const login = loginFixture({}, { trustedClientAddress: false });
        const ingress = "10.0.7.1";
        const before = requests.length;
        // Start has no browser state; it is bounded by concurrency and State's attempt cap.
        for (let i = 0; i < 40; i += 1) {
          assert.equal((await login.start(ingress)).status, 200);
        }
        // Junk callbacks without the attempt cookie spend only their own key.
        for (let i = 0; i < 30; i += 1) {
          await expectDenied(await login.callback("state=invalid", ingress, null));
        }
        assert.equal((await login.callback("state=invalid", ingress, null)).status, 429);
        // A forged attempt cookie spends that cookie's key, not a real browser's.
        const forged = `__Host-occ_login_attempt=${"f".repeat(43)}`;
        for (let i = 0; i < 30; i += 1) {
          await expectDenied(await login.callback("state=invalid", ingress, forged));
        }
        assert.equal((await login.callback("state=invalid", ingress, forged)).status, 429);
        await expectDenied(await login.callback("state=invalid", ingress));
        // Result keys on the browser's receipt cookie the same way.
        for (let i = 0; i < 30; i += 1) {
          await expectDenied(await login.result("a".repeat(43), "", ingress));
        }
        assert.equal((await login.result("a".repeat(43), "", ingress)).status, 429);
        await expectDenied(
          await login.result("a".repeat(43), "__Host-occ_login_receipt=receipt", ingress),
        );
        assert.equal(requests.length, before);
      },
    );

    await t.test("the password endpoint leaves admission to the controller route", async () => {
      // Failure-counting admission runs before /oce/password (auth/index.ts); the endpoint
      // itself refuses nothing with 429, so it cannot count successes or refuse recovery.
      const login = loginFixture();
      for (let i = 0; i < 25; i += 1) {
        await expectDenied(
          await login.password(undefined, {
            email: i % 2 === 0 ? "recovery@example.test" : "a@example.test",
          }),
        );
      }
      assert.deepEqual(login.denials, []);
    });

    await t.test("the admission table stays bounded and evicts idle keys", async () => {
      const login = loginFixture();
      for (let i = 0; i < 30; i += 1) {
        await expectDenied(await login.callback("state=invalid", "10.0.4.99"));
      }
      assert.equal((await login.callback("state=invalid", "10.0.4.99")).status, 429);
      for (let i = 0; i < 4096; i += 1) {
        const response = await login.callback("state=invalid", `10.1.${i >> 8}.${i & 255}`);
        assert.equal(response.status, 401);
      }
      await expectDenied(await login.callback("state=invalid", "10.0.4.99"));
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
        // State's clock runs years ahead of the controller's.
        const login = loginFixture({
          createAttempt: async () => {
            const createdAt = new Date("2030-01-01T00:00:00Z");
            return { createdAt, expiresAt: new Date(createdAt.getTime() + 300_000) };
          },
        });
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
  const refused = {
    name: "APIError",
    status: "UNAUTHORIZED",
    message: "Authentication was not accepted.",
  };
  await assert.rejects(context.adapter.consumeOne({ model: "session", where }), refused);
  await assert.rejects(
    context.adapter.incrementOne({ model: "session", where, increment: { version: 1 } }),
    refused,
  );
  assert.equal(login.db.session.length, 1, "the raw row is untouched");
  // Other models still pass through to the underlying adapter.
  assert.equal(await context.adapter.count({ model: "user" }), 1);
});

// RFC-0061: with an allowlist, the callback reads membership with the user token after
// GET /user and before the account lookup, and fails closed when GitHub cannot answer.
test(
  "GitHub org and team allowlist admits only active members and fails closed on lookup outages",
  { timeout: 60_000 },
  async (t) => {
    let serve;
    const { requests, port } = await startProviderServer(t, (request, response) =>
      serve(request, response),
    );
    const providerOrigin = `http://127.0.0.1:${port}`;
    const acme = "/user/memberships/orgs/acme";
    const other = "/user/memberships/orgs/other";
    const team = "/orgs/other/teams/platform/memberships/Octo-Cat";
    redirectProviderFetch(
      t,
      new Set(
        ["https://github.com/login/oauth/access_token", "https://api.github.com/user"].concat(
          [acme, other, team].map((path) => `https://api.github.com${path}`),
        ),
      ),
      providerOrigin,
    );
    function allowlisted(
      state = {},
      allowlist = { allowedOrgs: ["acme"], allowedTeams: ["other/platform"] },
      options = {},
    ) {
      return createLoginFixture({
        ...options,
        provider: "github",
        providers: {
          github: {
            clientId: "fixture-client",
            clientSecret: "fixture-client-secret",
            ...allowlist,
          },
        },
        state,
        recoveryEmail: "Recovery@example.test",
      });
    }
    const membership = (state) => (response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ state, role: "member", organization: { login: "x" } }));
    };
    const notFound = (response) => response.writeHead(404).end('{"message":"Not Found"}');
    // answers: path -> (response) => void; unlisted membership paths fail the test.
    function provider(answers, login = "Octo-Cat") {
      const routes = Object.entries(answers);
      return (request, response) => {
        if (request.url === "/login/oauth/access_token") {
          return token(response);
        }
        if (request.url === "/user") {
          assert.equal(request.headers.authorization, "Bearer ghu_fixture_provider_token");
          return response.end(JSON.stringify({ id: 12345678, login }));
        }
        assert.equal(request.headers.authorization, "Bearer ghu_fixture_provider_token");
        assert.equal(request.headers.accept, "application/vnd.github+json");
        // Compare with the fixed paths; never select a handler by the request's own key.
        for (const [path, answer] of routes) {
          if (path === request.url) {
            return answer(response);
          }
        }
        assert.fail(`unexpected membership request ${request.url}`);
      };
    }
    async function expectRefused(response, code) {
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        code,
        message: "Authentication was not accepted.",
      });
      assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /session_token|login_receipt/);
    }
    const subject = { subject: "12345678" };

    await t.test("an active organization member reaches the account lookup", async () => {
      const login = allowlisted();
      serve = provider({ [acme]: membership("active") });
      const before = requests.length;
      // The fixture State holds no account, so the attached-identity lookup refuses.
      await expectDenied(await login.callback());
      assert.deepEqual(login.subjects, [[providerId, "12345678"]]);
      assert.deepEqual(login.denials, [["EXTERNAL_IDENTITY_REJECTED", "github"]]);
      assert.deepEqual(requests.slice(before), ["/login/oauth/access_token", "/user", acme]);
    });

    await t.test("an active team member is admitted after its organization", async () => {
      const login = allowlisted();
      serve = provider({
        [acme]: notFound,
        [other]: membership("active"),
        [team]: membership("active"),
      });
      const before = requests.length;
      await expectDenied(await login.callback());
      assert.deepEqual(login.subjects, [[providerId, "12345678"]]);
      assert.deepEqual(requests.slice(before), [
        "/login/oauth/access_token",
        "/user",
        acme,
        other,
        team,
      ]);
    });

    const refusals = [
      [
        "a non-member of every entry, without reading the team",
        { [acme]: notFound, [other]: notFound },
      ],
      ["a pending organization invitation", { [acme]: membership("pending"), [other]: notFound }],
      [
        "an organization member outside the team",
        { [acme]: notFound, [other]: membership("active"), [team]: notFound },
      ],
      [
        "a pending team membership",
        { [acme]: notFound, [other]: membership("active"), [team]: membership("pending") },
      ],
    ];
    for (const [label, answers] of refusals) {
      await t.test(`refuses ${label} as MEMBERSHIP_REQUIRED`, async () => {
        const login = allowlisted();
        serve = provider(answers);
        const before = requests.length;
        await expectRefused(await login.callback(), "MEMBERSHIP_REQUIRED");
        assert.deepEqual(login.subjects, [], "no account lookup");
        assert.deepEqual(login.denials, [["MEMBERSHIP_REQUIRED", "github", subject]]);
        assert.deepEqual(login.operationalLogs(), []);
        assert.deepEqual(requests.slice(before).slice(2), Object.keys(answers));
      });
    }

    // [label, acme answer, expected log fields]
    const outages = [
      [
        "a 5xx",
        (response) => response.writeHead(503).end("{}"),
        { cause: "http_status", status: 503 },
      ],
      [
        "a 429",
        (response) => response.writeHead(429).end("{}"),
        { cause: "http_status", status: 429 },
      ],
      [
        "a 401",
        (response) => response.writeHead(401).end("{}"),
        { cause: "http_status", status: 401 },
      ],
      [
        "a 403 (App blocked or Members permission not accepted)",
        (response) =>
          response.writeHead(403).end('{"message":"Resource not accessible by integration"}'),
        { cause: "http_status", status: 403 },
      ],
      [
        "a redirect",
        (response) =>
          response.writeHead(301, { location: `${providerOrigin}/redirect-target` }).end(),
        { cause: "redirect" },
      ],
      [
        "an oversized body",
        (response) => response.end("x".repeat(64 * 1024 + 1)),
        { cause: "oversized_response" },
      ],
      ["a malformed body", (response) => response.end("not json"), { cause: "malformed_response" }],
      [
        "an unknown state",
        (response) => response.end(JSON.stringify({ state: "fixture-sensitive" })),
        { cause: "malformed_response" },
      ],
    ];
    for (const [label, answer, fields] of outages) {
      await t.test(`fails closed on ${label} as MEMBERSHIP_UNAVAILABLE`, async () => {
        const login = allowlisted();
        serve = provider({ [acme]: answer, [other]: notFound });
        await expectRefused(await login.callback(), "MEMBERSHIP_UNAVAILABLE");
        assert.equal(requests.includes("/redirect-target"), false);
        assert.deepEqual(login.subjects, []);
        assert.deepEqual(login.denials, [["MEMBERSHIP_UNAVAILABLE", "github", subject]]);
        assert.deepEqual(login.operationalLogs(), [
          {
            severity: "WARN",
            service: "occ-api",
            event: "authentication.provider-unavailable-warning",
            provider: "github",
            providerId,
            step: "membership",
            ...fields,
          },
        ]);
        assert.doesNotMatch(
          JSON.stringify(login.operationalLogs()),
          /acme|Octo-Cat|ghu_|fixture-sensitive/,
        );
      });
    }

    await t.test("a team check with a malformed profile login fails closed", async () => {
      const login = allowlisted();
      serve = provider({ [acme]: notFound, [other]: membership("active") }, "not a login");
      const before = requests.length;
      await expectRefused(await login.callback(), "MEMBERSHIP_UNAVAILABLE");
      assert.deepEqual(requests.slice(before).slice(2), [acme, other], "no team request");
      assert.equal(login.operationalLogs()[0].cause, "malformed_response");
    });

    // A team's organization lookup is shared with a listed organization, failure included.
    for (const [label, answer, code] of [
      ["a non-member", notFound, "MEMBERSHIP_REQUIRED"],
      [
        "a failed lookup",
        (response) => response.writeHead(503).end("{}"),
        "MEMBERSHIP_UNAVAILABLE",
      ],
    ]) {
      await t.test(`one organization lookup serves its team entries for ${label}`, async () => {
        const login = allowlisted({}, { allowedOrgs: ["acme"], allowedTeams: ["acme/platform"] });
        serve = provider({ [acme]: answer });
        const before = requests.length;
        await expectRefused(await login.callback(), code);
        assert.deepEqual(requests.slice(before).slice(2), [acme]);
        assert.equal(login.operationalLogs().length, code === "MEMBERSHIP_REQUIRED" ? 0 : 1);
      });
    }

    await t.test("a later match admits after an earlier lookup failed", async () => {
      const login = allowlisted();
      serve = provider({
        [acme]: (response) => response.writeHead(502).end("{}"),
        [other]: membership("active"),
        [team]: membership("active"),
      });
      const before = requests.length;
      await expectDenied(await login.callback());
      assert.deepEqual(login.subjects, [[providerId, "12345678"]]);
      assert.deepEqual(requests.slice(before).slice(2), [acme, other, team]);
      assert.deepEqual(login.operationalLogs(), []);
    });

    await t.test("a stalled lookup ends at the shared deadline", async () => {
      const login = allowlisted(undefined, undefined, { providerDeadlineMs });
      let closed = false;
      serve = provider({
        [acme]: (response) => {
          response.on("close", () => {
            closed = true;
          });
        },
      });
      const started = performance.now();
      await expectRefused(await login.callback(), "MEMBERSHIP_UNAVAILABLE");
      const elapsed = performance.now() - started;
      assert.ok(
        elapsed >= providerDeadlineMs * 0.9 && elapsed < providerDeadlineMs + 2_000,
        `Elapsed: ${elapsed}`,
      );
      await until(() => closed);
      assert.deepEqual(login.denials, [["MEMBERSHIP_UNAVAILABLE", "github", subject]]);
      assert.equal(login.operationalLogs()[0].cause, "timeout");
    });
  },
);

test("GitHub allowlist settings parse, normalize and refuse invalid entries", () => {
  const client = {
    OCC_AUTH_GITHUB_CLIENT_ID: "github-client",
    OCC_AUTH_GITHUB_CLIENT_SECRET: "github-secret",
    OCC_AUTH_GITHUB_RECOVERY_USER_ID: "recovery-user",
  };
  const base = { clientId: "github-client", clientSecret: "github-secret" };
  assert.deepEqual(githubLoginConfiguration(client), { ...base, recoveryUserId: "recovery-user" });
  assert.deepEqual(
    githubLoginConfiguration({
      ...client,
      OCC_AUTH_GITHUB_ALLOWED_ORGS: "",
      OCC_AUTH_GITHUB_ALLOWED_TEAMS: " ",
    }),
    { ...base, recoveryUserId: "recovery-user" },
  );
  assert.deepEqual(
    githubLoginConfiguration({
      ...client,
      OCC_AUTH_GITHUB_ALLOWED_ORGS: " Acme , acme-labs,acme",
      OCC_AUTH_GITHUB_ALLOWED_TEAMS: "Other/Platform_Team",
    }),
    {
      ...base,
      recoveryUserId: "recovery-user",
      allowedOrgs: ["acme", "acme-labs"],
      allowedTeams: ["other/platform_team"],
    },
  );
  for (const [name, value] of [
    ["OCC_AUTH_GITHUB_ALLOWED_ORGS", "acme,"],
    ["OCC_AUTH_GITHUB_ALLOWED_ORGS", "-acme"],
    ["OCC_AUTH_GITHUB_ALLOWED_ORGS", "acme/platform"],
    ["OCC_AUTH_GITHUB_ALLOWED_ORGS", "a".repeat(40)],
    ["OCC_AUTH_GITHUB_ALLOWED_TEAMS", "acme"],
    ["OCC_AUTH_GITHUB_ALLOWED_TEAMS", "acme/platform/extra"],
    ["OCC_AUTH_GITHUB_ALLOWED_TEAMS", "acme/plat form"],
    ["OCC_AUTH_GITHUB_ALLOWED_TEAMS", "acme/../user"],
    [
      "OCC_AUTH_GITHUB_ALLOWED_ORGS",
      Array.from({ length: 11 }, (_, index) => `org${index}`).join(","),
    ],
  ]) {
    assert.throws(
      () => githubLoginConfiguration({ ...client, [name]: value }),
      new RegExp(name),
      `${name}=${value}`,
    );
  }
  // Ten entries across both lists is the cap.
  assert.throws(
    () =>
      githubLoginConfiguration({
        ...client,
        OCC_AUTH_GITHUB_ALLOWED_ORGS: Array.from({ length: 6 }, (_, i) => `org${i}`).join(","),
        OCC_AUTH_GITHUB_ALLOWED_TEAMS: Array.from({ length: 5 }, (_, i) => `org/t${i}`).join(","),
      }),
    /at most 10/,
  );
  // An allowlist without the GitHub client is a configuration error, not a no-op.
  assert.throws(
    () => githubLoginConfiguration({ OCC_AUTH_GITHUB_ALLOWED_ORGS: "acme" }),
    /GitHub sign-in requires client ID, client secret and recovery user ID/,
  );
});
