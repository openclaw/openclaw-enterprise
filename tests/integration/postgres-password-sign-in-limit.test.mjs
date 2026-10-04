import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { hashLocalPassword } from "../../apps/controller/src/auth/index.ts";
import { passwordFailureBudget } from "../../apps/controller/src/auth/admission.ts";
import {
  bootstrapProductionInstallation,
  composeProductionSignIn,
  consoleOrigin as origin,
  defaultInstallSettings,
  installationRoles,
  memoryLogger,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { assertSpentDeviceProofRefusal } from "../helpers/password-proof-refusal.mjs";

const adminEmail = "limit-admin@example.test";
const authSecret = "password-limit-auth-test-secret-at-least-32-bytes";
const secrets = { "occ-auth/secret": authSecret };
const ingress = "10.0.0.9";
const wrongPassword = "wrong-guess-password";

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// A subtest sets this to see the slow-lane floors start and to keep them from ending.
let floorWatch;

// The production slow lane with its floor capped at 2 s instead of 8 s. Every paced attempt
// waits its floor in real time, so the cap sets this suite's length; the 1 s first floor,
// the doubling, the slots and the per-minute budgets stay the production values. An attempt
// holds its email's slot from the start of its floor, which floorWatch observes.
const slowLane = {
  floorMs: passwordFailureBudget.slow.floorMs,
  maxFloorMs: 2000,
  async waitFloor(floorMs) {
    const watch = floorWatch;
    watch?.started();
    await delay(floorMs, undefined, { ref: false });
    await watch?.released;
  },
};

// Counts the floors that start from now on and holds each one past its time until release().
function watchFloors(expected) {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  const watch = {
    count: 0,
    released: release.promise,
    started() {
      watch.count += 1;
      if (watch.count === expected) {
        reached.resolve();
      }
    },
    // Resolves once `expected` floors have started; fails after the deadline.
    async reached(deadlineMs) {
      const timeout = new AbortController();
      try {
        await Promise.race([
          reached.promise,
          delay(deadlineMs, undefined, { signal: timeout.signal }).then(() =>
            assert.fail(`${watch.count} of ${expected} slow-lane floors started`),
          ),
        ]);
      } finally {
        timeout.abort();
      }
    },
    release() {
      floorWatch = undefined;
      release.resolve();
    },
  };
  floorWatch = watch;
  return watch;
}

// The default install (no external provider), composed twice over one database: behind a
// trusted ingress, where admission keys on the resolved client address and the email, and
// with the chart's defaults (no trusted proxy), where only the email lane applies. Only
// failures count; once the budget is spent, administrators are slowed, never refused.
test(
  "password-only sign-in limits failures per client and email with a reserved administrator lane",
  requiresPostgres,
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
      passwordSlowLaneFloors: slowLane,
    });
    const plainLog = memoryLogger();
    plainApp = await composeProductionSignIn(t, {
      databaseUrl,
      settings: { ...defaultInstallSettings },
      secrets,
      logger: plainLog.logger,
      passwordSlowLaneFloors: slowLane,
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

    await t.test("a successful sign-in resets that email's failures", async () => {
      const typist = await createAccount("limit-typist@example.test", roles.reader.id);
      for (let round = 0; round < 2; round += 1) {
        for (let index = 0; index < 9; index += 1) {
          const response = await plainSignIn({ ...typist, password: wrongPassword });
          assert.equal(response.statusCode, 401, `round ${round} typo ${index}: ${response.body}`);
        }
        const correct = await plainSignIn(typist);
        assert.equal(correct.statusCode, 200, `round ${round}: ${correct.body}`);
      }
    });

    await t.test(
      "a limited email lane logs one warning with a keyed hash and no email or address",
      () => {
        const limited = plainLog.events.filter(
          (event) => event.event === "authentication.sign-in-limited",
        );
        for (const event of limited) {
          assert.equal(event.severity, "WARN");
          assert.equal(event.lane, "email");
          assert.match(event.keyHash, /^[a-f0-9]{16}$/);
        }
        // One report per lane per window: the slowed administrator and the spent target.
        assert.equal(limited.length, 2, `reports: ${limited.length}`);
        assert.equal(new Set(limited.map((event) => event.keyHash)).size, limited.length);
        const serialized = JSON.stringify(plainLog.events);
        for (const value of [plainAdmin.email, target.email, "example.test", ingress]) {
          assert.equal(serialized.includes(value), false, value);
        }
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

    await t.test("a limited client address is reported with the address lane", () => {
      const lanes = proxiedLog.events
        .filter((event) => event.event === "authentication.sign-in-limited")
        .map((event) => event.lane);
      assert.ok(lanes.includes("address"), `lanes: ${lanes.join(", ")}`);
      const serialized = JSON.stringify(proxiedLog.events);
      for (const value of [attacker, "example.test"]) {
        assert.equal(serialized.includes(value), false, value);
      }
    });

    // Known-device cookie: a browser that signed in to an account before keeps its own
    // budget for that email, so strangers who know the email cannot keep it out (T1) or
    // crowd an administrator's attempt out of the slow lane (T2).
    const knownDeviceName = "__Host-occ_known_device";
    const knownDeviceOf = (response) =>
      [response.headers["set-cookie"] ?? []]
        .flat()
        .find((value) => value.startsWith(`${knownDeviceName}=`));
    const plainSignInWith = (cookie, account) =>
      plainApp.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress: ingress,
        headers: { origin, cookie },
        payload: account,
      });
    const knownMember = await createAccount("limit-known@example.test", roles.reader.id);
    const knownOther = await createAccount("limit-known-other@example.test", roles.reader.id);
    const knownAdmin = await createAccount("limit-known-admin@example.test", roles.admin.id);
    const knownReset = await createAccount("limit-known-reset@example.test", roles.reader.id);
    let memberDevice;

    await t.test("the known-device cookie is set only after a successful sign-in", async () => {
      const failed = await plainSignIn({ ...knownMember, password: wrongPassword });
      assert.equal(failed.statusCode, 401);
      assert.equal(knownDeviceOf(failed), undefined);
      const signedIn = await plainSignIn(knownMember);
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const setCookie = knownDeviceOf(signedIn);
      assert.ok(setCookie, "a successful sign-in marks the browser");
      assert.match(
        setCookie,
        /^__Host-occ_known_device=v2\.[^;]+; Max-Age=7776000; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
      );
      assert.equal(setCookie.includes("limit-known"), false, "the cookie does not carry the email");
      memberDevice = setCookie.split(";", 1)[0];
    });

    await t.test(
      "a browser that signed in before is not locked out by strangers' failures",
      async () => {
        // Strangers spend the member's email lane from anywhere.
        for (let index = 0; index < 10; index += 1) {
          const response = await plainSignIn({ ...knownMember, password: wrongPassword });
          assert.equal(response.statusCode, 401, `guess ${index}: ${response.body}`);
        }
        assert.equal((await plainSignIn(knownMember)).statusCode, 429, "a new browser is refused");
        // The member's own browser still signs in, at once and repeatedly.
        for (let index = 0; index < 3; index += 1) {
          const started = performance.now();
          const response = await plainSignInWith(memberDevice, knownMember);
          assert.equal(response.statusCode, 200, `sign-in ${index}: ${response.body}`);
          assert.ok(performance.now() - started < 1000, "not paced");
          memberDevice = knownDeviceOf(response).split(";", 1)[0];
        }
        // The cookie is bound to its account: it does not open another account's spent lane.
        for (let index = 0; index < 10; index += 1) {
          const response = await plainSignIn({ ...knownOther, password: wrongPassword });
          assert.equal(response.statusCode, 401, `guess ${index}: ${response.body}`);
        }
        assert.equal((await plainSignInWith(memberDevice, knownOther)).statusCode, 429);
      },
    );

    await t.test(
      "a valid cookie with a wrong password is 401 and spends its own lane",
      async () => {
        for (let index = 0; index < 10; index += 1) {
          const response = await plainSignInWith(memberDevice, {
            ...knownMember,
            password: wrongPassword,
          });
          assert.equal(response.statusCode, 401, `guess ${index}: ${response.body}`);
          assert.equal(knownDeviceOf(response), undefined);
        }
        // That device's lane is now spent too: a stolen cookie buys only its own budget.
        assert.equal((await plainSignInWith(memberDevice, knownMember)).statusCode, 429);
        // A cookie signed under another secret, or forged, is ignored: the shared lane applies.
        const forged = `${knownDeviceName}=v2.AAAAAAAA.${Math.floor(Date.now() / 1000)}.${"A".repeat(16)}.${"A".repeat(43)}.${"A".repeat(43)}`;
        assert.equal((await plainSignInWith(forged, knownMember)).statusCode, 429);
      },
    );

    await t.test(
      "proof-read saturation cannot reopen a throttled cookie's password allowance",
      async (t) => {
        const account = await createAccount("limit-proof-fairness@example.test", roles.reader.id);
        const signedIn = await plainSignIn(account);
        assert.equal(signedIn.statusCode, 200, signedIn.body);
        const cookie = knownDeviceOf(signedIn).split(";", 1)[0];
        // Keep one cookie: changing it would select another device instead of exercising
        // the transition from a verified device to an unavailable proof on the same entry.
        for (let index = 0; index < 10; index += 1) {
          const response = await plainSignInWith(cookie, { ...account, password: wrongPassword });
          assert.equal(response.statusCode, 401, `attempt ${index}: ${response.body}`);
        }
        await assertSpentDeviceProofRefusal({
          installReader(holdRead) {
            const query = pg.Pool.prototype.query;
            return t.mock.method(pg.Pool.prototype, "query", function (...args) {
              const [statement, parameters] = args;
              // This is passwordKnownDeviceState's read, not a replacement SQL result.
              // Unrelated queries, callback signatures and other accounts pass through.
              if (
                typeof statement === "string" &&
                statement.includes(
                  "SELECT u.id AS user_id, m.id AS method_id, m.authentication_version",
                ) &&
                statement.includes("WHERE u.email = $1") &&
                parameters?.[0] === account.email &&
                typeof args[2] !== "function"
              ) {
                return holdRead(() => query.apply(this, args));
              }
              return query.apply(this, args);
            });
          },
          signIn: () => plainSignInWith(cookie, { ...account, password: wrongPassword }),
          knownDeviceOf,
        });
      },
    );

    await t.test("a password reset revokes known-device exemptions issued before it", async () => {
      const before = await plainSignIn(knownReset);
      assert.equal(before.statusCode, 200, before.body);
      const staleDevice = knownDeviceOf(before).split(";", 1)[0];
      // An operator resets the password; the database bumps the method's authentication
      // version, which the entry is bound to.
      const newPassword = "limit-known-reset-new-password";
      const { rows } = await pool.query(
        `UPDATE occ.account m SET password = $1 FROM occ."user" u
           WHERE m.user_id = u.id AND u.email = $2 AND m.provider_id = 'credential'
           RETURNING m.authentication_version`,
        [await hashLocalPassword(newPassword), knownReset.email],
      );
      assert.equal(rows.length, 1);
      assert.ok(rows[0].authentication_version > 1);
      const reset = { ...knownReset, password: newPassword };
      const after = await plainSignIn(reset);
      assert.equal(after.statusCode, 200, after.body);
      const currentDevice = knownDeviceOf(after).split(";", 1)[0];
      for (let index = 0; index < 10; index += 1) {
        const response = await plainSignIn({ ...reset, password: wrongPassword });
        assert.equal(response.statusCode, 401, `guess ${index}: ${response.body}`);
      }
      // The stale entry is ignored and answered exactly like a new browser.
      const stale = await plainSignInWith(staleDevice, reset);
      const fresh = await plainSignIn(reset);
      assert.equal(stale.statusCode, 429, stale.body);
      assert.equal(fresh.statusCode, 429, fresh.body);
      assert.equal(stale.headers["retry-after"] !== undefined, true);
      assert.equal(knownDeviceOf(stale), undefined);
      // The entry issued after the reset keeps its own lane.
      const known = await plainSignInWith(currentDevice, reset);
      assert.equal(known.statusCode, 200, known.body);
    });

    await t.test(
      "an administrator's known browser does not queue behind strangers' slowed attempts",
      async () => {
        const signedIn = await plainSignIn(knownAdmin);
        assert.equal(signedIn.statusCode, 200, signedIn.body);
        const adminDevice = knownDeviceOf(signedIn).split(";", 1)[0];
        for (let index = 0; index < 10; index += 1) {
          const response = await plainSignIn({ ...knownAdmin, password: wrongPassword });
          assert.equal(response.statusCode, 401, `guess ${index}: ${response.body}`);
        }
        // Strangers hold both of the email's slow-lane slots and queue behind them. Each
        // holds its slot from the start of its floor, and the watch keeps those floors from
        // ending until the known browser has its answer.
        const floors = watchFloors(passwordFailureBudget.slow.concurrentPerEmail);
        const deadline = new AbortController();
        let flood;
        let answered;
        try {
          flood = Array.from({ length: 4 }, () =>
            plainSignIn({ ...knownAdmin, password: wrongPassword }),
          );
          await floors.reached(30_000);
          // A browser that queued behind those slots, or was paced itself, would not answer
          // while the floors are held; after the deadline they end and the test fails.
          const signingIn = plainSignInWith(adminDevice, knownAdmin);
          answered = await Promise.race([
            signingIn.then((response) => ({ response, floors: floors.count })),
            delay(30_000, undefined, { signal: deadline.signal }).catch(() => undefined),
          ]);
        } finally {
          deadline.abort();
          floors.release();
        }
        assert.ok(answered !== undefined, "the known browser waited for strangers' floors");
        assert.equal(answered.response.statusCode, 200, answered.response.body);
        // Only the two strangers holding the slots started floors: the others queued, and
        // the known browser was not paced.
        assert.equal(answered.floors, passwordFailureBudget.slow.concurrentPerEmail);
        assert.deepEqual(
          (await Promise.all(flood)).map((refused) => refused.statusCode),
          Array(4).fill(429),
        );
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
      // Exhausted client: its refusals are paced by a floor that doubles up to the cap. Warm
      // it to the cap, then ordinary, unknown and wrong administrator attempts all wait out
      // the same floor, no longer, and return the same 429.
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
      assert.ok(
        Math.min(...elapsed) >= slowLane.maxFloorMs - 10,
        `refusal floor: ${elapsed.join(", ")}`,
      );
      assert.ok(
        Math.max(...elapsed) < slowLane.maxFloorMs + 1000,
        `refusal cap: ${elapsed.join(", ")}`,
      );
      assert.ok(Math.max(...elapsed) - Math.min(...elapsed) < 400, `spread: ${elapsed.join(", ")}`);
      for (const { retryAfter } of refusals) {
        assert.ok(Number(retryAfter) >= 1 && Number(retryAfter) <= 60, `Retry-After ${retryAfter}`);
      }
    });
  },
);
