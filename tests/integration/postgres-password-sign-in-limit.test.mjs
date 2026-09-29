import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  bootstrapProductionInstallation,
  composeProductionSignIn,
  consoleOrigin as origin,
  defaultInstallSettings,
  installationRoles,
  memoryLogger,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const adminEmail = "limit-admin@example.test";
const authSecret = "password-limit-auth-test-secret-at-least-32-bytes";
const secrets = { "occ-auth/secret": authSecret };
const ingress = "10.0.0.9";
const wrongPassword = "wrong-guess-password";

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// The default install (no external provider), composed twice over one database: behind a
// trusted ingress, where admission keys on the resolved client address and the email, and
// with the chart's defaults (no trusted proxy), where only the email lane applies. Only
// failures count; once the budget is spent, administrators are slowed, never refused.
test(
  "password-only sign-in limits failures per client and email with a reserved administrator lane",
  { skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL proof." },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    let app;
    let plainApp;
    t.after(async () => {
      await app?.close();
      await plainApp?.close();
      await pool.end();
    });
    const adminPassword = await bootstrapProductionInstallation(t, {
      databaseUrl,
      email: adminEmail,
      authSecret,
    });
    const admin = { email: adminEmail, password: adminPassword };
    const roles = await installationRoles(state, pool);
    const proxiedLog = memoryLogger();
    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: { ...defaultInstallSettings, OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/24" },
      secrets,
      logger: proxiedLog.logger,
    });
    const plainLog = memoryLogger();
    plainApp = await composeProductionSignIn(t, {
      databaseUrl,
      settings: { ...defaultInstallSettings },
      secrets,
      logger: plainLog.logger,
    });
    // Without a trusted proxy every browser reaches the API from the ingress address.
    const plainSignIn = (account) =>
      plainApp.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress: ingress,
        headers: { origin },
        payload: account,
      });
    const signIn = (client, account) =>
      app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress: ingress,
        headers: { origin, "x-forwarded-for": client },
        payload: account,
      });
    const timed = async (client, account) => {
      const started = performance.now();
      const response = await signIn(client, account);
      return { response, elapsed: performance.now() - started };
    };
    const adminHeaders = await signedInHeaders(app, origin, admin);
    const accountPassword = "limit-account-password";
    const createAccount = async (email, roleId) => {
      const created = await app.inject({
        method: "POST",
        url: "/api/auth/accounts",
        headers: adminHeaders,
        payload: { email, password: accountPassword, roleId },
      });
      assert.equal(created.statusCode, 201, created.body);
      return { email, password: accountPassword };
    };
    const member = await createAccount("limit-member@example.test", roles.reader.id);
    const target = await createAccount("limit-target@example.test", roles.reader.id);
    const secondAdmin = await createAccount("limit-second-admin@example.test", roles.admin.id);
    const plainAdmin = await createAccount("limit-plain-admin@example.test", roles.admin.id);
    const limitWarnings = (events) =>
      events.filter((event) => event.event === "authentication.sign-in-limit-warning");

    await t.test("startup warns once when no trusted proxy enables the address lane", () => {
      assert.equal(limitWarnings(plainLog.events).length, 1);
      assert.equal(limitWarnings(plainLog.events)[0].code, "TRUSTED_PROXY_NOT_CONFIGURED");
      assert.equal(limitWarnings(proxiedLog.events).length, 0);
    });

    await t.test(
      "without a trusted proxy, an administrator is slowed, never refused, by wrong guesses",
      async () => {
        for (let index = 0; index < 10; index += 1) {
          const response = await plainSignIn({ ...plainAdmin, password: wrongPassword });
          assert.equal(response.statusCode, 401, `guess ${index}: ${response.body}`);
        }
        // Two at a time: the email's slow slots. Each is paced and refused.
        const slowed = [];
        for (let pair = 0; pair < 5; pair += 1) {
          slowed.push(
            ...(await Promise.all(
              [0, 1].map(() => plainSignIn({ ...plainAdmin, password: wrongPassword })),
            )),
          );
        }
        assert.deepEqual(
          slowed.map((response) => response.statusCode),
          Array(10).fill(429),
        );
        const started = performance.now();
        const correct = await plainSignIn(plainAdmin);
        assert.equal(correct.statusCode, 200, correct.body);
        assert.ok(performance.now() - started < 20_000, "the administrator is only delayed");
        assert.equal((await plainSignIn(admin)).statusCode, 200);
      },
    );

    await t.test(
      "without a trusted proxy, failures through the shared ingress refuse no other account",
      async () => {
        const junk = [];
        for (let index = 0; index < 25; index += 1) {
          junk.push(
            await plainSignIn({
              email: `ingress-junk-${index}@example.test`,
              password: wrongPassword,
            }),
          );
        }
        const victim = await plainSignIn(member);
        assert.equal(victim.statusCode, 200, victim.body);
        assert.deepEqual(
          junk.map((response) => response.statusCode),
          Array(25).fill(401),
        );
        // The email lane still applies.
        for (let index = 0; index < 10; index += 1) {
          assert.equal((await plainSignIn({ ...target, password: wrongPassword })).statusCode, 401);
        }
        const spent = await plainSignIn(target);
        assert.equal(spent.statusCode, 429, spent.body);
        assert.ok(Number(spent.headers["retry-after"]) >= 1);
      },
    );

    await t.test("repeated successful sign-ins are not limited", async () => {
      for (let index = 0; index < 30; index += 1) {
        const response = await signIn("198.51.100.1", member);
        assert.equal(response.statusCode, 200, `sign-in ${index}: ${response.body}`);
      }
    });

    const attacker = "203.0.113.7";
    await t.test(
      "a flood of wrong passwords from one client gets 429 with Retry-After",
      async () => {
        for (let index = 0; index < 20; index += 1) {
          const response = await signIn(attacker, {
            email: `guess-${index}@example.test`,
            password: wrongPassword,
          });
          assert.equal(response.statusCode, 401, `guess ${index}: ${response.body}`);
        }
        const refused = await signIn(attacker, {
          email: "guess-20@example.test",
          password: wrongPassword,
        });
        assert.equal(refused.statusCode, 429, refused.body);
        assert.equal(refused.json().error.code, "RATE_LIMITED");
        const retryAfter = Number(refused.headers["retry-after"]);
        assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`);
        // A correct password for an ordinary account does not pass the exhausted client.
        assert.equal((await signIn(attacker, member)).statusCode, 429);
      },
    );

    await t.test("another client still signs in", async () => {
      assert.equal((await signIn("198.51.100.2", member)).statusCode, 200);
    });

    await t.test("administrators still sign in from the exhausted client", async () => {
      const bootstrap = await signIn(attacker, admin);
      assert.equal(bootstrap.statusCode, 200, bootstrap.body);
      const second = await signIn(attacker, secondAdmin);
      assert.equal(second.statusCode, 200, second.body);
      // A wrong administrator password there is refused like any other attempt.
      assert.equal((await signIn(attacker, { ...admin, password: wrongPassword })).statusCode, 429);
    });

    await t.test(
      "flooding distinct emails from an exhausted client resets no other budget",
      async () => {
        const guesser = "203.0.113.61";
        const flooder = "203.0.113.62";
        for (let index = 0; index < 10; index += 1) {
          const response = await signIn(guesser, { ...target, password: wrongPassword });
          assert.equal(response.statusCode, 401, `guess ${index}: ${response.body}`);
        }
        assert.equal(
          (await signIn(guesser, { ...target, password: wrongPassword })).statusCode,
          429,
        );
        for (let index = 0; index < 20; index += 1) {
          const response = await signIn(flooder, {
            email: `flood-spend-${index}@example.test`,
            password: wrongPassword,
          });
          assert.equal(response.statusCode, 401, `spend ${index}: ${response.body}`);
        }
        // More distinct emails than the budget table holds; refused attempts create no entries.
        const flood = await Promise.all(
          Array.from({ length: 4200 }, (_, index) =>
            signIn(flooder, { email: `flood-${index}@example.test`, password: wrongPassword }),
          ),
        );
        assert.deepEqual([...new Set(flood.map((response) => response.statusCode))], [429]);
        assert.equal(
          (await signIn(guesser, { ...target, password: wrongPassword })).statusCode,
          429,
        );
        assert.equal((await signIn("198.51.100.62", target)).statusCode, 429);
        assert.equal(
          (await signIn(flooder, { email: "after-flood@example.test", password: wrongPassword }))
            .statusCode,
          429,
        );
      },
    );

    await t.test(
      "guessing an administrator's password from many clients slows but never refuses it",
      async () => {
        for (let index = 0; index < 10; index += 1) {
          const response = await signIn(`203.0.113.${100 + index}`, {
            ...secondAdmin,
            password: wrongPassword,
          });
          assert.equal(response.statusCode, 401, `guess ${index}: ${response.body}`);
        }
        // The email's budget is spent: further guesses from anywhere are paced and refused,
        // but the right password is still checked and admitted.
        const slowed = await Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            signIn(`203.0.113.${120 + index}`, { ...secondAdmin, password: wrongPassword }),
          ),
        );
        assert.deepEqual(
          slowed.map((response) => response.statusCode),
          Array(10).fill(429),
        );
        const correct = await signIn("203.0.113.200", secondAdmin);
        assert.equal(correct.statusCode, 200, correct.body);
      },
    );

    await t.test("existing and unknown emails look the same in status and timing", async () => {
      const client = "203.0.113.50";
      const existing = [];
      const unknown = [];
      // Shared lane: Better Auth hashes the password for unknown emails too.
      for (let index = 0; index < 5; index += 1) {
        const known = await timed(client, { ...member, password: wrongPassword });
        const missing = await timed(client, {
          email: `missing-${index}@example.test`,
          password: wrongPassword,
        });
        assert.equal(known.response.statusCode, 401);
        assert.equal(missing.response.statusCode, 401);
        existing.push(known.elapsed);
        unknown.push(missing.elapsed);
      }
      assert.ok(
        Math.abs(median(existing) - median(unknown)) < 150,
        `shared lane medians ${median(existing)} vs ${median(unknown)} ms`,
      );
      for (let index = 0; index < 10; index += 1) {
        assert.equal(
          (await signIn(client, { email: `filler-${index}@example.test`, password: wrongPassword }))
            .statusCode,
          401,
        );
      }
      // Exhausted client: its refusals are paced by a floor that doubles up to 8 s. Warm it
      // to the cap, then ordinary, unknown and wrong administrator attempts all wait out the
      // same floor and return the same 429.
      const warmUp = await Promise.all(
        [0, 1, 2].map((index) =>
          signIn(client, { email: `warm-${index}@example.test`, password: wrongPassword }),
        ),
      );
      assert.deepEqual(
        warmUp.map((response) => response.statusCode),
        [429, 429, 429],
      );
      const refusals = await Promise.all(
        [
          { ...member, password: wrongPassword },
          { email: "missing-after@example.test", password: wrongPassword },
          { ...admin, password: wrongPassword },
          { ...member, password: wrongPassword },
          { email: "missing-again@example.test", password: wrongPassword },
          { ...admin, password: wrongPassword },
        ].map(async (account) => {
          const { response, elapsed } = await timed(client, account);
          assert.equal(response.statusCode, 429, response.body);
          return { elapsed, retryAfter: response.headers["retry-after"] };
        }),
      );
      const elapsed = refusals.map((refusal) => refusal.elapsed);
      assert.ok(Math.min(...elapsed) >= 7990, `refusal floor: ${elapsed.join(", ")}`);
      assert.ok(Math.max(...elapsed) - Math.min(...elapsed) < 400, `spread: ${elapsed.join(", ")}`);
      for (const { retryAfter } of refusals) {
        assert.ok(Number(retryAfter) >= 1 && Number(retryAfter) <= 60, `Retry-After ${retryAfter}`);
      }
    });
  },
);
