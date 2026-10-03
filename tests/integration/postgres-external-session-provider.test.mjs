import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  bootstrapProductionInstallation,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin as origin,
  currentSession,
  defaultInstallSettings,
  fakeGoogle,
  fakeOidc,
  fixtureOidcIssuer,
  githubSignIn,
  githubUpgradeSettings,
  googleSignIn,
  googleUpgradeSettings,
  installationRoles,
  oidcSignIn,
  oidcUpgradeSettings,
  passwordSignIn,
  readAccount,
  signedInHeaders,
  startFakeGitHub,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const adminEmail = "session-provider-recovery@example.test";
const password = "session-provider-member-password";
const authSecret = "session-provider-auth-test-secret-at-least-32-bytes";
const githubClientId = "session-provider-github-client-id";
const googleClientId = "session-provider.apps.googleusercontent.com";
const oidcClientId = "session-provider-oidc-client";
const oidcClientSecret = "session-provider-oidc-client-secret";
const secrets = Object.freeze({
  "occ-auth/secret": authSecret,
  "occ-github-login/client-id": githubClientId,
  "occ-github-login/client-secret": "session-provider-github-client-secret",
  "occ-google-login/client-id": googleClientId,
  "occ-google-login/client-secret": "session-provider-google-client-secret",
  "occ-oidc-login/client-id": oidcClientId,
  "occ-oidc-login/client-secret": oidcClientSecret,
});
const digest = (value) => createHash("sha256").update(value).digest("hex");
const instances = {
  github: `github:${digest(githubClientId)}`,
  google: `google:${digest(googleClientId)}`,
  oidc: `oidc:${digest(`${fixtureOidcIssuer.issuer}\0${oidcClientId}`)}`,
};
// The same host with another issuer path: a new OIDC provider instance.
const movedIssuer = Object.freeze({
  ...fixtureOidcIssuer,
  issuer: "https://tenant.idp.example.test/v2/",
});
const subjects = {
  github: "9700001",
  google: "110000000000000000071",
  oidc: "auth0|6500000000000000000000b1",
};
const kinds = ["password", "github", "google", "oidc"];

// Settings for the providers named in `providers` (all three by default).
function settingsFor(adminId, { providers = ["github", "google", "oidc"], issuer } = {}) {
  return {
    ...(providers.includes("github") ? githubUpgradeSettings(adminId) : {}),
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
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const state = new PostgresPlatformState(pool);
    let app;
    t.after(async () => {
      await app?.close();
      await pool.end();
    });
    await startFakeGitHub(t);
    const google = fakeGoogle(t, {
      clientId: googleClientId,
      clientSecret: secrets["occ-google-login/client-secret"],
    });
    const idp = fakeOidc(t, { clientId: oidcClientId, clientSecret: oidcClientSecret });
    const address = clientAddresses("198.23");
    const adminPassword = await bootstrapProductionInstallation(t, {
      databaseUrl,
      email: adminEmail,
      authSecret,
    });
    const admin = { email: adminEmail, password: adminPassword };
    const roles = await installationRoles(state, pool);

    app = await composeProductionSignIn(t, {
      databaseUrl,
      settings: defaultInstallSettings,
      secrets,
    });
    let adminHeaders = await signedInHeaders(app, origin, admin, address());
    admin.id = (await currentSession(app, adminHeaders.cookie)).user.id;
    const member = { email: "session-provider-member@example.test", password };
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers: adminHeaders,
      payload: { ...member, roleId: roles.reader.id },
    });
    assert.equal(created.statusCode, 201, created.body);
    member.id = created.json().data.id;
    await app.close();
    app = undefined;

    async function restart(options = {}, overrides = {}) {
      await app?.close();
      app = undefined;
      app = await composeProductionSignIn(t, {
        databaseUrl,
        settings: settingsFor(admin.id, options),
        secrets: { ...secrets, ...overrides },
      });
    }
    // One session of the member per sign-in method, all under the full configuration.
    async function signInEverywhere() {
      const callbacks = {
        github: (await githubSignIn(app, origin, subjects.github, address())).callback,
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
    async function live(cookies) {
      const result = {};
      for (const kind of kinds) {
        result[kind] = (await currentSession(app, cookies[kind]))?.user?.id === member.id;
      }
      return result;
    }
    const ended = async () =>
      (await state.transact((unit) => unit.audit.list())).filter(
        ({ action }) => action === "authentication.session.end",
      );
    const memberPrincipal = async () =>
      (
        await pool.query(
          "SELECT principal_id FROM occ.human_authentication_accounts WHERE user_id = $1",
          [member.id],
        )
      ).rows[0].principal_id;
    // Restarts under a changed configuration and expects exactly `gone` to have ended.
    async function assertEnds(cookies, options, overrides, gone) {
      const before = (await ended()).length;
      await restart(options, overrides);
      const expected = Object.fromEntries(kinds.map((kind) => [kind, kind !== gone]));
      assert.deepEqual(await live(cookies), expected);
      // A second read neither revives the session nor audits it again.
      assert.deepEqual(await live(cookies), expected);
      const audits = (await ended()).slice(before);
      assert.equal(audits.length, 1, `one audit for the ${gone} session`);
      const [audit] = audits;
      assert.equal(audit.kind, "mutation");
      assert.equal(audit.outcome, "success");
      assert.equal(audit.actorId, await memberPrincipal());
      assert.equal(audit.details.userId, member.id);
      assert.equal(audit.details.providerId, instances[gone]);
      assert.equal(audit.details.reason, "PROVIDER_NOT_CONFIGURED");
      const method = (
        await pool.query("SELECT provider_id FROM occ.account WHERE id = $1", [
          audit.details.methodId,
        ])
      ).rows[0];
      assert.equal(method.provider_id, instances[gone]);
      // Restoring the configuration does not revive an ended session.
      await restart();
      assert.deepEqual(await live(cookies), expected);
    }

    await t.test("attached identities sign in under every configured provider", async () => {
      await restart();
      adminHeaders = await signedInHeaders(app, origin, admin, address());
      for (const provider of ["github", "google", "oidc"]) {
        const attached = await app.inject({
          method: "POST",
          url: `/api/auth/accounts/${member.id}/providers/${provider}`,
          headers: adminHeaders,
          payload: {
            subject: subjects[provider],
            expectedVersion: (await readAccount(app, adminHeaders, member.id)).version,
          },
        });
        assert.equal(attached.statusCode, 200, attached.body);
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
        github: true,
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
      await restart({}, { "occ-oidc-login/client-secret": "session-provider-rotated-secret" });
      assert.deepEqual(await live(cookies), {
        password: true,
        github: true,
        google: true,
        oidc: true,
      });
      await restart();
    });

    await t.test("removing OIDC ends only OIDC sessions", async () => {
      await assertEnds(await signInEverywhere(), { providers: ["github", "google"] }, {}, "oidc");
    });

    await t.test("a GitHub client ID change ends only GitHub sessions", async () => {
      await assertEnds(
        await signInEverywhere(),
        {},
        { "occ-github-login/client-id": "session-provider-other-github-client" },
        "github",
      );
    });

    await t.test("removing GitHub ends only GitHub sessions", async () => {
      await assertEnds(await signInEverywhere(), { providers: ["google", "oidc"] }, {}, "github");
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
      await assertEnds(await signInEverywhere(), { providers: ["github", "oidc"] }, {}, "google");
    });

    await t.test("password sessions survive when only one external provider remains", async () => {
      const cookies = await signInEverywhere();
      await restart({ providers: ["oidc"] });
      assert.deepEqual(await live(cookies), {
        password: true,
        github: false,
        google: false,
        oidc: true,
      });
      // The member's password still signs in; recovery-only is not configured.
      assert.equal((await passwordSignIn(app, origin, member, address())).statusCode, 200);
    });
  },
);
