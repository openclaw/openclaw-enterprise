import assert from "node:assert/strict";
import test from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  assertProviderAttached,
  clientAddresses,
  consoleOrigin as origin,
  currentSession,
  fakeOidc,
  fixtureOidcIssuer,
  googleUpgradeSettings,
  oidcUpgradeSettings,
} from "../helpers/production-sign-in.mjs";
import { fakeGoogle, googleSignIn } from "../helpers/google-sign-in.ts";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.ts";
import { providerInstanceId } from "../helpers/human-login-transport.ts";
import type { OidcIssuerEndpoints } from "../helpers/oidc-provider.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  preparePostgresSignInInstallation,
  type SignInApp,
} from "../helpers/postgres-sign-in-installation.ts";
import {
  accountPrincipalId,
  first,
  oidcSignIn,
  passwordSignIn,
  readAccount,
  signedInHeaders,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import type { SignInSettings } from "../helpers/sign-in-chart.ts";

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
const externalProviders = ["google", "oidc"] as const;
const kinds = ["password", ...externalProviders] as const;
type ExternalProvider = (typeof externalProviders)[number];
type SignInKind = (typeof kinds)[number];
type SessionCookies = Readonly<Record<SignInKind, string>>;
type ProviderOptions = {
  providers?: readonly ExternalProvider[];
  issuer?: OidcIssuerEndpoints;
};
type SecretOverrides = Readonly<Record<string, string>>;
type ProviderCallback = {
  body: string;
  headers: { location?: string | undefined; "set-cookie"?: string | readonly string[] | undefined };
};

// Settings for the providers named in `providers` (both by default).
function settingsFor(
  adminId: string,
  { providers = externalProviders, issuer }: ProviderOptions = {},
): SignInSettings {
  return {
    ...(providers.includes("google") ? googleUpgradeSettings(adminId) : {}),
    ...(providers.includes("oidc") ? oidcUpgradeSettings(adminId, issuer) : {}),
  };
}

function callbackCookie(provider: ExternalProvider, callback: ProviderCallback): string {
  assert.equal(callback.headers.location, "/console/", `${provider}: ${callback.body}`);
  return cookieHeaderFromSetCookie(callback.headers["set-cookie"]);
}

async function sessionUserId(app: SignInApp, cookie: string): Promise<unknown> {
  const session: unknown = await currentSession(app, cookie);
  return asRecord(asRecord(session)?.user)?.id;
}

// The provider fixtures replace only the providers' own endpoints. State, audit, IAM, Better
// Auth, the guarded human-login profile and Fastify are production code.
test(
  "PostgreSQL sessions end when their external provider instance is no longer configured",
  requiresPostgres,
  async (t) => {
    let app: SignInApp | undefined;
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

    function runningApp(): SignInApp {
      assert.ok(app, "Expected the sign-in application to be running");
      return app;
    }

    async function restart(options: ProviderOptions = {}, overrides: SecretOverrides = {}) {
      await app?.close();
      app = undefined;
      app = await composeApp(settingsFor(admin.id, options), {
        secrets: { ...secrets, ...overrides },
      });
    }
    // One session of the member per sign-in method, all under the full configuration.
    async function signInEverywhere(): Promise<SessionCookies> {
      const app = runningApp();
      const callbacks = {
        google: (await googleSignIn(app, origin, google, { subject: subjects.google }, address()))
          .callback,
        oidc: (await oidcSignIn(app, origin, idp, { subject: subjects.oidc }, address())).callback,
      };
      const cookies = {
        password: (await signedInHeaders(app, origin, member, address())).cookie,
        google: callbackCookie("google", callbacks.google),
        oidc: callbackCookie("oidc", callbacks.oidc),
      };
      for (const kind of kinds) {
        assert.equal(await sessionUserId(app, cookies[kind]), member.id, kind);
      }
      return cookies;
    }
    async function live(cookies: SessionCookies): Promise<Record<SignInKind, boolean>> {
      const app = runningApp();
      return {
        password: (await sessionUserId(app, cookies.password)) === member.id,
        google: (await sessionUserId(app, cookies.google)) === member.id,
        oidc: (await sessionUserId(app, cookies.oidc)) === member.id,
      };
    }
    const ended = async () =>
      (await state.transact((unit) => unit.audit.list())).filter(
        ({ action }) => action === "authentication.session.end",
      );
    const memberPrincipal = () => accountPrincipalId(pool, member.id);
    // Restarts under a changed configuration and expects exactly `gone` to have ended.
    async function assertEnds(
      cookies: SessionCookies,
      options: ProviderOptions,
      overrides: SecretOverrides,
      gone: ExternalProvider,
    ) {
      const before = (await ended()).length;
      await restart(options, overrides);
      const expected = Object.fromEntries(kinds.map((kind) => [kind, kind !== gone]));
      assert.deepEqual(await live(cookies), expected);
      // A second read neither revives the session nor audits it again.
      assert.deepEqual(await live(cookies), expected);
      const audits = (await ended()).slice(before);
      assert.equal(audits.length, 1, `one audit for the ${gone} session`);
      const audit = first(audits);
      assert.equal(audit.kind, "mutation");
      assert.equal(audit.outcome, "success");
      assert.equal(audit.actorId, await memberPrincipal());
      assert.ok(audit.details);
      assert.equal(audit.details.userId, member.id);
      assert.equal(audit.details.providerId, instances[gone]);
      assert.equal(audit.details.reason, "PROVIDER_NOT_CONFIGURED");
      const { rows } = await pool.query<{ provider_id: string }>(
        "SELECT provider_id FROM occ.account WHERE id = $1",
        [audit.details.methodId],
      );
      const method = first(rows);
      assert.equal(method.provider_id, instances[gone]);
      // Restoring the configuration does not revive an ended session.
      await restart();
      assert.deepEqual(await live(cookies), expected);
    }

    await t.test("attached identities sign in under every configured provider", async () => {
      await restart();
      const app = runningApp();
      const adminHeaders = await signedInHeaders(app, origin, admin, address());
      for (const provider of externalProviders) {
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
      await restart({}, { "occ-oidc-login/client-secret": "session-provider-rotated-secret" });
      assert.deepEqual(await live(cookies), {
        password: true,
        google: true,
        oidc: true,
      });
      await restart();
    });

    await t.test("removing OIDC ends only OIDC sessions", async () => {
      await assertEnds(await signInEverywhere(), { providers: ["google"] }, {}, "oidc");
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
      await assertEnds(await signInEverywhere(), { providers: ["oidc"] }, {}, "google");
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
      assert.equal((await passwordSignIn(runningApp(), origin, member, address())).statusCode, 200);
    });
  },
);
