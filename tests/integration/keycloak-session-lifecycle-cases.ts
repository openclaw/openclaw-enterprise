import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import type { Page, Response as BrowserResponse } from "playwright";
import { oidcLoginConfiguration, type OidcTokenAuth } from "../../apps/controller/src/auth/oidc.ts";
import { providerJSON } from "../../apps/controller/src/auth/provider-transport.ts";
import type { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { integer, record, text } from "../helpers/postgres-sign-in-test-boundaries.ts";

type KeycloakSecrets = {
  admin: { username: string; password: string };
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  users: Record<string, { password: string }>;
};

type BrowserSession = {
  user: { id: string };
  sessionKey: string;
};

type Installation = {
  pool: Pool;
  state: PostgresPlatformState;
  aliceId: string;
  secrets: KeycloakSecrets;
  endpoints: {
    issuer: string;
    authorizationUrl: string;
    tokenUrl: string;
    jwksUrl: string;
  };
};

type OpenedPage<Prepared> = {
  prepared: Prepared;
  page: Page;
  authorizations: URLSearchParams[];
  authorizationStatuses: number[];
  callbacks: URL[];
  callback: Promise<BrowserResponse>;
};

type RealmAdmin<Prepared> = (
  prepared: Prepared,
  method: string,
  path: string,
  body?: unknown,
) => Promise<unknown>;

type LifecycleFixture<Prepared, Opened> = {
  requiresKeycloak: false | string;
  aliceSubject: string;
  callbackPath: string;
  resultPath: string;
  serveConsole(t: TestContext, tokenAuth: OidcTokenAuth): Promise<Prepared>;
  openConsole(t: TestContext, tokenAuth: OidcTokenAuth): Promise<Opened>;
  openPage(t: TestContext, prepared: Prepared): Promise<Opened>;
  nextResponse(page: Page, pathname: string): Promise<BrowserResponse>;
  signInThroughKeycloak(opened: Opened, user: string): Promise<void>;
  signInAlice(opened: Opened): Promise<BrowserSession>;
  assertAliceSignedIn(
    opened: Opened,
    callback: Promise<BrowserResponse>,
    result: Promise<BrowserResponse>,
  ): Promise<BrowserSession>;
  assertAuthorizationRequest(prepared: Prepared, authorizations: URLSearchParams[]): void;
  keycloakAdmin: RealmAdmin<Prepared>;
  aliceSessions(prepared: Prepared): Promise<string[]>;
};

const deniedReason = "EXTERNAL_IDENTITY_REJECTED";
// Keycloak 26's login-form error for a disabled user who enters the right password.
const disabledMessage = /Account is disabled/;

export function readKeycloakSecrets(value: unknown): KeycloakSecrets {
  const secrets = record(value);
  const admin = record(secrets.admin);
  const users = Object.fromEntries(
    Object.entries(record(secrets.users)).map(([name, user]) => [
      name,
      { password: text(record(user).password) },
    ]),
  );
  return {
    admin: { username: text(admin.username), password: text(admin.password) },
    clientId: text(secrets.clientId),
    clientSecret: text(secrets.clientSecret),
    redirectUri: text(secrets.redirectUri),
    users,
  };
}

function assertBrowserSession(value: unknown): asserts value is BrowserSession {
  const session = record(value);
  text(record(session.user).id);
  text(session.sessionKey);
}

export async function readBrowserSession(page: Page): Promise<BrowserSession | null> {
  const value: unknown = await page.evaluate(async (): Promise<unknown> => {
    const response = await fetch("/api/auth/session");
    return response.json();
  });
  const data = record(value).data;
  if (data !== null) {
    assertBrowserSession(data);
  }
  return data;
}

/** The kid Keycloak signs RS256 tokens with: its highest-priority active RS256 key. */
async function activeSigningKid<Prepared>(prepared: Prepared, admin: RealmAdmin<Prepared>) {
  const keys = record(await admin(prepared, "GET", "/keys"));
  const kid = record(keys.active).RS256;
  assert.ok(typeof kid === "string", "the realm has an active RS256 key");
  return kid;
}

async function jwksKids({ endpoints, secrets }: Installation) {
  const config = oidcLoginConfiguration({
    OCC_AUTH_OIDC_ISSUER: endpoints.issuer,
    OCC_AUTH_OIDC_AUTHORIZATION_URL: endpoints.authorizationUrl,
    OCC_AUTH_OIDC_TOKEN_URL: endpoints.tokenUrl,
    OCC_AUTH_OIDC_JWKS_URL: endpoints.jwksUrl,
    OCC_AUTH_OIDC_CLIENT_ID: secrets.clientId,
    OCC_AUTH_OIDC_CLIENT_SECRET: secrets.clientSecret,
  });
  assert.ok(config, "the fixture has an OIDC configuration");
  const jwks = await providerJSON(config.jwksUrl, {}, AbortSignal.timeout(10_000), "jwks");
  assert.ok(Array.isArray(jwks.keys), "the realm publishes a JWKS key set");
  const keys: unknown[] = jwks.keys;
  return keys.map((key) => {
    const { kid } = record(key);
    return kid === undefined ? undefined : text(kid);
  });
}

async function accountCounts(pool: Pool) {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT (SELECT count(*)::int FROM occ."user") AS users,
            (SELECT count(*)::int FROM occ.account) AS methods,
            (SELECT count(*)::int FROM occ.session) AS sessions`,
  );
  const counts = record(rows[0]);
  return {
    users: integer(counts.users),
    methods: integer(counts.methods),
    sessions: integer(counts.sessions),
  };
}

async function setAliceEnabled<Prepared>(
  prepared: Prepared,
  admin: RealmAdmin<Prepared>,
  subject: string,
  enabled: boolean,
) {
  const path = `/users/${subject}`;
  const user = record(await admin(prepared, "GET", path));
  await admin(prepared, "PUT", path, { ...user, enabled });
}

export function registerKeycloakSessionLifecycleCases<
  Prepared extends Installation,
  Opened extends OpenedPage<Prepared>,
>({
  requiresKeycloak,
  aliceSubject,
  callbackPath,
  resultPath,
  serveConsole,
  openConsole,
  openPage,
  nextResponse,
  signInThroughKeycloak,
  signInAlice,
  assertAliceSignedIn,
  assertAuthorizationRequest,
  keycloakAdmin,
  aliceSessions,
}: LifecycleFixture<Prepared, Opened>): void {
  test(
    "a higher-priority Keycloak realm key changes the signing kid and the next sign-in succeeds without a controller restart",
    { skip: requiresKeycloak },
    async (t) => {
      const prepared = await serveConsole(t, "client_secret_post");
      // The controller reads the JWKS at this callback, under the realm's original key.
      await signInAlice(await openPage(t, prepared));
      const before = await activeSigningKid(prepared, keycloakAdmin);
      const kidsBefore = await jwksKids(prepared);
      assert.ok(kidsBefore.includes(before));

      // Keycloak signs with its highest-priority active key; the imported default has 100.
      const realm = record(await keycloakAdmin(prepared, "GET", ""));
      const created = await keycloakAdmin(prepared, "POST", "/components", {
        name: "oce-rotated-rs256",
        providerId: "rsa-generated",
        providerType: "org.keycloak.keys.KeyProvider",
        parentId: text(realm.id),
        config: {
          priority: ["200"],
          enabled: ["true"],
          active: ["true"],
          algorithm: ["RS256"],
          keySize: ["2048"],
        },
      });
      assert.ok(created instanceof Response);
      assert.equal(created.status, 201);
      const location = created.headers.get("location");
      assert.ok(location, "Keycloak identifies the created component");
      const componentId = new URL(location).pathname.split("/").pop();
      assert.ok(componentId, "the component location ends with its ID");
      // Later tests sign in under the realm's original key again.
      t.after(() => keycloakAdmin(prepared, "DELETE", `/components/${componentId}`));

      const rotated = await activeSigningKid(prepared, keycloakAdmin);
      assert.notEqual(rotated, before, "Keycloak signs with the new key");
      assert.ok(!kidsBefore.includes(rotated), "the new kid was not published before rotation");
      assert.ok((await jwksKids(prepared)).includes(rotated), "the JWKS now publishes the new kid");

      // Same composition, same process: the next callback verifies the new kid.
      await signInAlice(await openPage(t, prepared));
    },
  );

  test(
    "unattached carol is refused after Keycloak sign-in, audited and given no account",
    { skip: requiresKeycloak },
    async (t) => {
      const opened = await openConsole(t, "client_secret_post");
      const { prepared, page, authorizations, callback } = opened;
      const denials = async () =>
        (await prepared.state.transact((unit) => unit.audit.list())).filter(
          ({ action, outcome, reasonCode, details }) =>
            action === "authentication.login" &&
            outcome === "denied" &&
            reasonCode === deniedReason &&
            details?.provider === "oidc",
        );
      const before = await accountCounts(prepared.pool);
      const deniedBefore = (await denials()).length;

      await signInThroughKeycloak(opened, "carol");
      const redirect = await callback;
      assert.equal(redirect.status(), 302);
      assert.equal(redirect.headers().location, "/console/?authError=oidc");
      await page.getByText("Could not sign in with Keycloak").first().waitFor();
      assertAuthorizationRequest(prepared, authorizations);

      assert.equal(await readBrowserSession(page), null);
      assert.deepEqual(
        await accountCounts(prepared.pool),
        before,
        "no user, sign-in method or session is created",
      );
      assert.equal((await denials()).length, deniedBefore + 1, "the refusal is audited");
    },
  );

  test(
    "Console sign-out ends alice's OCE session, one click signs her in again while her Keycloak session lives, and disabling her keeps that session but refuses her next sign-in",
    { skip: requiresKeycloak },
    async (t) => {
      const prepared = await serveConsole(t, "client_secret_post");
      const opened = await openPage(t, prepared);
      const { page } = opened;
      const first = await signInAlice(opened);
      const sessionsBefore = await aliceSessions(prepared);
      assert.ok(sessionsBefore.length > 0);

      // Console sign-out deletes exactly this OCE session; Keycloak's session is untouched
      // (RP-initiated logout is a non-goal).
      const signOut = nextResponse(page, "/api/auth/sign-out");
      await page.locator(".account-toggle").click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      assert.equal((await signOut).status(), 200);
      const again = page.getByRole("button", { name: "Continue with Keycloak" });
      await again.waitFor();
      assert.equal(await readBrowserSession(page), null);
      const afterSignOut = await aliceSessions(prepared);
      assert.equal(afterSignOut.length, sessionsBefore.length - 1, "one OCE session was deleted");

      // One click: Keycloak answers the authorization request with a redirect, no login form.
      const callback = nextResponse(page, callbackPath);
      const result = nextResponse(page, resultPath);
      await again.click();
      const second = await assertAliceSignedIn(opened, callback, result);
      assert.notEqual(second.sessionKey, first.sessionKey, "a new OCE session was created");
      assert.deepEqual(
        opened.authorizationStatuses,
        [200, 302],
        "the second request skipped the form",
      );
      assert.equal(opened.authorizations.length, 2);
      const signedIn = await aliceSessions(prepared);
      assert.equal(signedIn.length, sessionsBefore.length);

      // Keycloak decides who may authenticate; OCE sessions it already issued run to their end.
      await setAliceEnabled(prepared, keycloakAdmin, aliceSubject, false);
      t.after(() => setAliceEnabled(prepared, keycloakAdmin, aliceSubject, true));
      const kept = await readBrowserSession(page);
      assert.ok(kept, "the Console still has an OCE session");
      assert.equal(kept.user.id, prepared.aliceId, "the current OCE session still works");
      assert.equal(kept.sessionKey, second.sessionKey);

      const refused = await openPage(t, prepared);
      await signInThroughKeycloak(refused, "alice");
      await refused.page.getByText(disabledMessage).first().waitFor();
      assert.equal(refused.callbacks.length, 0, "Keycloak never redirected to OCE");
      assert.equal(new URL(refused.page.url()).origin, new URL(prepared.endpoints.issuer).origin);
      assert.deepEqual(await aliceSessions(prepared), signedIn, "no OCE session was created");
    },
  );
}
