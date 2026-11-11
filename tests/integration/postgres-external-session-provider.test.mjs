import assert from "node:assert/strict";
import test from "node:test";
import {
  accountPrincipalId,
  assertProviderAttached,
  clientAddresses,
  consoleOrigin as origin,
  currentSession,
  fakeGoogle,
  fakeOidc,
  fixtureOidcIssuer,
  googleSignIn,
  googleUpgradeSettings,
  oidcSignIn,
  oidcUpgradeSettings,
  passwordSignIn,
  readAccount,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { providerInstanceId } from "../helpers/human-login-transport.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparePostgresSignInInstallation } from "../helpers/postgres-sign-in-installation.mjs";

const googleClientId = "session-provider.apps.googleusercontent.com";
const oidcClientId = "session-provider-oidc-client";
const oidcClientSecret = "session-provider-oidc-client-secret";
const secrets = Object.freeze({
  "occ-auth/secret": "session-provider-auth-test-secret-at-least-32-bytes",
  "occ-google-login/client-id": googleClientId,
  "occ-google-login/client-secret": "session-provider-google-client-secret",
  "occ-oidc-login/client-id": oidcClientId,
  "occ-oidc-login/client-secret": oidcClientSecret,
});
const instances = {
  google: providerInstanceId("google", { clientId: googleClientId }),
  oidc: providerInstanceId("oidc", { issuer: fixtureOidcIssuer.issuer, clientId: oidcClientId }),
};
// The same host with another issuer path: a new OIDC provider instance.
const movedIssuer = Object.freeze({
  ...fixtureOidcIssuer,
  issuer: "https://tenant.idp.example.test/v2/",
});
const subjects = {
  google: "110000000000000000071",
  oidc: "auth0|6500000000000000000000b1",
};
const kinds = ["password", "google", "oidc"];

// Settings for the providers named in `providers` (both by default).
function settingsFor(adminId, { providers = ["google", "oidc"], issuer } = {}) {
  return {
    ...(providers.includes("google") ? googleUpgradeSettings(adminId) : {}),
    ...(providers.includes("oidc") ? oidcUpgradeSettings(adminId, issuer) : {}),
  };
}

// The provider fixtures replace only the providers' own endpoints. State, audit, IAM, Better
// Auth, the guarded human-login profile and Fastify are production code.
test(
  "PostgreSQL sessions end when their external provider instance is no longer configured",
  requiresPostgres,
  async (t) => {
    let app;
    const { pool, state, onboard, composeApp } = await preparePostgresSignInInstallation(
      t,
      () => [app],
      {
        email: "session-provider-recovery@example.test",
        password: "session-provider-member-password",
        secrets,
      },
    );
    const google = fakeGoogle(t, {
      clientId: googleClientId,
      clientSecret: secrets["occ-google-login/client-secret"],
    });
    const idp = fakeOidc(t, { clientId: oidcClientId, clientSecret: oidcClientSecret });
    const address = clientAddresses("198.23");
    const {
      admin,
      accounts: { member },
    } = await onboard({
      remoteAddress: address(),
      accounts: { member: { email: "session-provider-member@example.test" } },
    });
    let adminHeaders;

    async function restart(options = {}, overrides = {}) {
      await app?.close();
      app = undefined;
      app = await composeApp(settingsFor(admin.id, options), {
        secrets: { ...secrets, ...overrides },
      });
    }
    // One session of the member per sign-in method, all under the full configuration.
    async function signInEverywhere() {
      const callbacks = {
        google: (await googleSignIn(app, origin, google, { subject: subjects.google }, address()))
          .callback,
        oidc: (await oidcSignIn(app, origin, idp, { subject: subjects.oidc }, address())).callback,
      };
      const cookies = {
        password: (await signedInHeaders(app, origin, member, address())).cookie,
      };
      for (const [provider, callback] of Object.entries(callbacks)) {
        assert.equal(callback.headers.location, "/console/", `${provider}: ${callback.body}`);
        cookies[provider] = cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
      }
      for (const kind of kinds) {
        assert.equal((await currentSession(app, cookies[kind])).user.id, member.id, kind);
      }
      return cookies;
    }
    async function live(cookies, methods = kinds) {
      const result = {};
      for (const kind of methods) {
        result[kind] = (await currentSession(app, cookies[kind]))?.user?.id === member.id;
      }
      return result;
    }
    async function beginOidcSignIn() {
      const start = await app.inject({
        method: "POST",
        url: "/api/auth/providers/oidc/start",
        headers: { origin },
        remoteAddress: address(),
      });
      assert.equal(start.statusCode, 200, start.body);
      const authorization = new URL(start.json().data.url);
      const code = idp.authorize(authorization.href, { subject: subjects.oidc });
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", code);
      return () =>
        app.inject({
          url: `${callback.pathname}${callback.search}`,
          headers: { cookie: cookieHeaderFromSetCookie(start.headers["set-cookie"]) },
          remoteAddress: address(),
        });
    }
    const ended = async () =>
      (await state.transact((unit) => unit.audit.list())).filter(
        ({ action }) => action === "authentication.session.end",
      );
    const memberPrincipal = () => accountPrincipalId(pool, member.id);
    // Restarts under a changed configuration and expects exactly `gone` to have ended.
    async function assertEnds(cookies, options, overrides, gone) {
      const before = (await ended()).length;
      await restart(options, overrides);
      const audits = (await ended()).slice(before);
      assert.ok(audits.length > 0, `startup ends ${gone} sessions`);
      const principalId = await memberPrincipal();
      for (const audit of audits) {
        assert.equal(audit.kind, "mutation");
        assert.equal(audit.outcome, "success");
        assert.equal(audit.actorId, principalId);
        assert.equal(audit.details.userId, member.id);
        assert.equal(audit.details.providerId, instances[gone]);
        assert.equal(audit.details.reason, "PROVIDER_NOT_CONFIGURED");
        const method = (
          await pool.query("SELECT provider_id FROM occ.account WHERE id = $1", [
            audit.details.methodId,
          ])
        ).rows[0];
        assert.equal(method.provider_id, instances[gone]);
      }
      const unchanged = kinds.filter((kind) => kind !== gone);
      assert.deepEqual(
        await live(cookies, unchanged),
        Object.fromEntries(unchanged.map((kind) => [kind, true])),
      );
      // Do not read the affected session until after restore. The old implementation only
      // ended it on a request while the provider was absent.
      await restart();
      const expected = Object.fromEntries(kinds.map((kind) => [kind, kind !== gone]));
      assert.deepEqual(await live(cookies), expected);
      assert.equal((await ended()).length, before + audits.length);
    }

    await t.test("attached identities sign in under every configured provider", async () => {
      await restart();
      adminHeaders = await signedInHeaders(app, origin, admin, address());
      for (const provider of ["google", "oidc"]) {
        await assertProviderAttached(app, adminHeaders, member.id, provider, subjects[provider]);
      }
      const methods = (await readAccount(app, adminHeaders, member.id)).methods
        .map(({ providerId }) => providerId)
        .filter((providerId) => providerId !== "credential")
        .sort();
      assert.deepEqual(methods, Object.values(instances).sort());
      await signInEverywhere();
    });

    await t.test("an unchanged configuration keeps every session", async () => {
      const cookies = await signInEverywhere();
      const before = (await ended()).length;
      await restart();
      assert.deepEqual(await live(cookies), {
        password: true,
        google: true,
        oidc: true,
      });
      assert.equal((await ended()).length, before);
    });

    await t.test("an OIDC issuer change ends only OIDC sessions", async () => {
      await assertEnds(await signInEverywhere(), { issuer: movedIssuer }, {}, "oidc");
    });

    await t.test("an OIDC client ID change ends only OIDC sessions", async () => {
      await assertEnds(
        await signInEverywhere(),
        {},
        { "occ-oidc-login/client-id": "session-provider-other-oidc-client" },
        "oidc",
      );
    });

    await t.test("an OIDC client secret rotation keeps every session", async () => {
      const cookies = await signInEverywhere();
      const finishOldSignIn = await beginOidcSignIn();
      await restart({}, { "occ-oidc-login/client-secret": "session-provider-rotated-secret" });
      assert.deepEqual(await live(cookies), {
        password: true,
        google: true,
        oidc: true,
      });
      await restart();
      // Reverting a credential change does not resume a sign-in started before the rotation.
      const stale = await finishOldSignIn();
      assert.equal(stale.headers.location, "/console/?authError=oidc");
    });

    await t.test("removing OIDC ends only OIDC sessions", async () => {
      const cookies = await signInEverywhere();
      const finishOldSignIn = await beginOidcSignIn();
      await assertEnds(cookies, { providers: ["google"] }, {}, "oidc");
      const stale = await finishOldSignIn();
      assert.equal(stale.headers.location, "/console/?authError=oidc");
      // The existing attachment still works with a fresh sign-in after restore.
      await signInEverywhere();
    });

    await t.test("a Google client ID change ends only Google sessions", async () => {
      await assertEnds(
        await signInEverywhere(),
        {},
        { "occ-google-login/client-id": "other.apps.googleusercontent.com" },
        "google",
      );
    });

    await t.test("removing Google ends only Google sessions", async () => {
      const finishOidcSignIn = await beginOidcSignIn();
      await assertEnds(await signInEverywhere(), { providers: ["oidc"] }, {}, "google");
      const finished = await finishOidcSignIn();
      assert.equal(finished.headers.location, "/console/");
    });

    await t.test("password sessions survive when only one external provider remains", async () => {
      const cookies = await signInEverywhere();
      await restart({ providers: ["oidc"] });
      assert.deepEqual(await live(cookies), {
        password: true,
        google: false,
        oidc: true,
      });
      // The member's password still signs in; recovery-only is not configured.
      assert.equal((await passwordSignIn(app, origin, member, address())).statusCode, 200);
    });
  },
);
