import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { PostgresHumanAuthentication } from "../../packages/occ/src/index.ts";
import {
  attachProvider,
  assertSessionUser,
  authRowCounts,
  consoleOrigin as origin,
  currentSession,
  oidcUpgradeSettings,
} from "../helpers/production-sign-in.mjs";
import {
  authOperation,
  injectLocalhost,
  integer,
  onboarded,
  oidcSignIn,
  passwordSignIn,
  record,
  response,
  signedInHeaders,
  text,
  type InjectedResponse,
  type SignInApp,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import { runPasswordFallbackCases } from "./postgres-oidc-password-fallback-cases.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

const memberSubject = 7_000_001;
// The production slow lane with shorter floors: 250 ms doubling to a 500 ms cap instead of
// 1 s doubling to 8 s. Each paced attempt waits its floor in real time, and spending one
// email three times in a window reaches the 4 s floor otherwise. The slots and budgets stay
// the production values.
const slowLane = { floorMs: 250, maxFloorMs: 500 };

function assertRedirect(location: unknown, expected: string) {
  assert.ok(location === expected, `redirect matches ${expected}`);
}

// OIDC is optional: when it errors or stalls, OIDC sign-in fails closed and password
// sign-in keeps working; strangers can slow the recovery administrator's password but never
// refuse it.
// The provider fixture replaces only remote HTTP to oidc.com and api.oidc.com.
test(
  "a OIDC outage fails OIDC sign-in closed while password sign-in keeps working",
  requiresPostgres,
  async (t) => {
    const apps: { app?: SignInApp } = {};
    // In "hang" mode the OIDC provider never answers; the controller's shared provider
    // deadline must end the wait.
    const {
      pool,
      oidc: provider,
      onboard,
      composeApp,
    } = await preparePostgresSignInInstallation(t, () => [apps.app], {
      oidc: true,
      email: "outage-recovery@example.test",
      password: "outage-member-password",
      secrets: {
        "occ-auth/secret": "outage-auth-test-secret-at-least-32-bytes",
        "occ-oidc-login/client-id": "outage-client-id",
        "occ-oidc-login/client-secret": "outage-client-secret",
      },
    });

    // Password onboarding on the default install, then the OIDC upgrade. Members read the
    // Installation but do not administer it, so a spent email refuses them.
    assert.ok(provider, "OIDC provider fixture is configured");
    const { admin, accounts } = onboarded(
      await authOperation("Password onboarding", () =>
        onboard({
          accounts: {
            member: { email: "outage-member@example.test" },
            other: { email: "outage-other@example.test" },
            resetMember: { email: "outage-reset@example.test" },
            disabledMember: { email: "outage-disabled@example.test" },
          },
        }),
      ),
      ["member", "other", "resetMember", "disabledMember"],
    );
    const { member, other, resetMember, disabledMember } = accounts;
    const app = (apps.app = await authOperation("Production composition", () =>
      composeApp(oidcUpgradeSettings(admin.id), { passwordSlowLaneFloors: slowLane }),
    ));
    const adminHeaders = await authOperation("Administrator sign-in", () =>
      signedInHeaders(app, origin, admin),
    );
    assert.equal(
      response(
        await authOperation("Provider attachment", () =>
          attachProvider(app, adminHeaders, member.id, "oidc", String(memberSubject)),
        ),
      ).statusCode,
      200,
    );

    const memberOIDCSignIn = async (remoteAddress = "192.0.2.70") =>
      (
        await authOperation("OIDC sign-in", () =>
          oidcSignIn(app, origin, provider, { subject: String(memberSubject) }, remoteAddress),
        )
      ).callback;
    const sessionCount = async () => integer(record(await authRowCounts(pool)).sessions);
    async function assertFailedClosed(callback: InjectedResponse, sessionsBefore: number) {
      assert.equal(callback.statusCode, 302);
      assertRedirect(
        callback.headers.location,
        "/console/?authError=oidc&authReason=provider-unavailable",
      );
      assert.ok(callback.headers["set-cookie"] === undefined, "no cookie is issued");
      assert.equal(await sessionCount(), sessionsBefore, "no session is issued");
    }

    await t.test("the fixture provider signs the attached account in while up", async () => {
      const callback = await memberOIDCSignIn();
      assertRedirect(callback.headers.location, "/console/");
      await authOperation("verify the OIDC session", () =>
        assertSessionUser(app, callback, member.id),
      );
    });

    await t.test("provider 5xx fails closed; password sign-in keeps working", async () => {
      provider.mode = "error";
      const before = await sessionCount();
      await assertFailedClosed(await memberOIDCSignIn(), before);
      const signedIn = await passwordSignIn(app, origin, member);
      assert.equal(signedIn.statusCode, 200);
      const cookie = text(
        await authOperation<unknown>("verify the password fallback session", () =>
          assertSessionUser(app, signedIn, member.id),
        ),
      );
      const signedOut = await injectLocalhost(app, "POST", "/api/auth/sign-out", {
        session: { cookie, origin },
      });
      assert.equal(signedOut.statusCode, 200);
      const session = await authOperation<unknown>("read the signed-out session", () =>
        currentSession(app, cookie),
      );
      assert.ok(session === null, "signed-out session is absent");
    });

    await t.test(
      "a hung provider fails closed at the deadline without blocking passwords",
      async () => {
        provider.mode = "hang";
        const before = await sessionCount();
        const started = performance.now();
        const pending = memberOIDCSignIn();
        // Password sign-in proceeds while the provider exchange is stalled.
        const signedIn = await passwordSignIn(app, origin, member, "192.0.2.51");
        assert.equal(signedIn.statusCode, 200);
        const callback = await pending;
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 9_000 && elapsed < 20_000, `deadline elapsed ${elapsed} ms`);
        await assertFailedClosed(callback, before + 1);

        // A fetch that arrives after cancellation must also reject without waiting for another abort event.
        const signal = AbortSignal.abort();
        let aborted = false;
        try {
          await Promise.race([fetch(provider.issuer.tokenUrl, { signal }), nextTurn()]);
        } catch (error: unknown) {
          aborted = error instanceof Error && error.name === "AbortError";
        }
        assert.ok(aborted, "an already-cancelled provider request rejects immediately");
      },
    );

    const wrong = "outage-wrong-password";

    await t.test("successful password sign-ins spend no budget during an outage", async () => {
      provider.mode = "error";
      // Only failed sign-ins count: more successes in one minute than the ten-failure budget
      // from one address all sign in.
      for (let index = 0; index < 12; index += 1) {
        const signedIn = await passwordSignIn(app, origin, other, "198.51.100.1");
        assert.equal(signedIn.statusCode, 200);
      }
      assertRedirect(
        (await memberOIDCSignIn("203.0.113.10")).headers.location,
        "/console/?authError=oidc&authReason=provider-unavailable",
      );
    });

    await t.test(
      "without a trusted proxy, one ingress address is never an Installation-wide budget",
      async () => {
        // The fixture sets no trusted proxy, so every browser reaches the API from one
        // address. Failures there for many emails spend only those emails' budgets.
        const ingress = "198.51.100.1";
        for (let index = 0; index < 25; index += 1) {
          const response = await passwordSignIn(
            app,
            origin,
            { email: `outage-guess-${index}@example.test`, password: wrong },
            ingress,
          );
          assert.equal(response.statusCode, 401);
        }
        const signedIn = await passwordSignIn(app, origin, member, ingress);
        assert.equal(signedIn.statusCode, 200);
        // External start has no per-minute budget to spend, and junk callbacks without the
        // browser's attempt cookie spend only their own key, never a real browser's.
        provider.mode = "up";
        for (let index = 0; index < 35; index += 1) {
          const start = await injectLocalhost(app, "POST", "/api/auth/providers/oidc/start", {
            remoteAddress: ingress,
            headers: { origin },
          });
          assert.equal(start.statusCode, 200);
        }
        for (let index = 0; index < 35; index += 1) {
          const junk = await app.inject({
            url: `/api/auth/providers/oidc/callback?state=${"j".repeat(43)}&code=junk`,
            remoteAddress: ingress,
          });
          assertRedirect(junk.headers.location, "/console/?authError=oidc");
        }
        const callback = await memberOIDCSignIn(ingress);
        assertRedirect(callback.headers.location, "/console/");
      },
    );

    await t.test(
      "a callback that fails inside OCE says sign-in is unavailable, not to get attached",
      async (t) => {
        provider.mode = "error";
        // The provider outage happens, but its denial audit cannot be written: the callback
        // answers 503 inside OCE, which the Console reports as an outage.
        const recordDenied = PostgresHumanAuthentication.prototype.recordDenied;
        t.mock.method(
          PostgresHumanAuthentication.prototype,
          "recordDenied",
          function (
            this: PostgresHumanAuthentication,
            ...args: Parameters<PostgresHumanAuthentication["recordDenied"]>
          ) {
            if (args[0] === "PROVIDER_UNAVAILABLE") {
              return Promise.reject(new Error("fixture audit store outage"));
            }
            return recordDenied.apply(this, args);
          },
        );
        const before = await sessionCount();
        const callback = await memberOIDCSignIn("192.0.2.59");
        assert.equal(callback.statusCode, 302);
        assertRedirect(
          callback.headers.location,
          "/console/?authError=oidc&authReason=unavailable",
        );
        assert.ok(callback.headers["set-cookie"] === undefined, "no cookie is issued");
        assert.equal(await sessionCount(), before, "no session is issued");
      },
    );

    // A State failure while consuming the attempt or capturing the identity reaches the
    // controller unchanged (oidc-login-transport), which reports an outage, not a refusal.
    for (const [method, remoteAddress] of [
      ["consumeAttempt", "192.0.2.61"],
      ["snapshotExternal", "192.0.2.62"],
    ] as const) {
      await t.test(`a callback whose ${method} fails says sign-in is unavailable`, async (t) => {
        provider.mode = "up";
        t.mock.method(PostgresHumanAuthentication.prototype, method, () =>
          Promise.reject(new Error("fixture State outage")),
        );
        const before = await sessionCount();
        const callback = await memberOIDCSignIn(remoteAddress);
        assert.equal(callback.statusCode, 302);
        assertRedirect(
          callback.headers.location,
          "/console/?authError=oidc&authReason=unavailable",
        );
        assert.ok(callback.headers["set-cookie"] === undefined, "no cookie is issued");
        assert.equal(await sessionCount(), before, "no session is issued");
      });
    }

    await t.test("OIDC sign-in recovers without a restart", async () => {
      provider.mode = "up";
      const callback = await memberOIDCSignIn("192.0.2.60");
      assertRedirect(callback.headers.location, "/console/");
    });

    await runPasswordFallbackCases(t, {
      app,
      pool,
      provider,
      admin,
      member,
      other,
      resetMember,
      disabledMember,
      adminHeaders,
      memberOIDCSignIn,
      wrong,
      slowLane,
    });
  },
);
