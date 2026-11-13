import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { ExternalProviderName } from "../../apps/controller/src/auth/human-login.ts";
import type { ProviderDenial } from "../../apps/controller/src/auth/provider-transport.ts";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import type { AuditEvent } from "../../packages/contracts/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  bootstrapProductionInstallation,
  composeProductionSignIn,
  consoleOrigin as origin,
  googleUpgradeSettings,
  oidcUpgradeSettings,
} from "../helpers/production-sign-in.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  injectLocalhost,
  parseAuthResponse,
  postgresState,
  recordData,
  text,
  type App,
  type InjectedResponse,
} from "../helpers/postgres-sign-in-test-boundaries.ts";

const adminEmail = "unmatched-recovery@example.test";
const authSecret = "unmatched-callback-auth-test-secret-at-least-32-bytes";
const secrets = {
  "occ-auth/secret": authSecret,
  "occ-google-login/client-id": "unmatched.apps.googleusercontent.com",
  "occ-google-login/client-secret": "unmatched-google-client-secret",
  "occ-oidc-login/client-id": "unmatched-oidc-client",
  "occ-oidc-login/client-secret": "unmatched-oidc-client-secret",
};
const providers = ["google", "oidc"] as const satisfies readonly ExternalProviderName[];
const refusals = [
  ["access_denied", "EXTERNAL_IDENTITY_REJECTED", undefined],
  ["temporarily_unavailable", "PROVIDER_UNAVAILABLE", "provider-unavailable"],
] as const satisfies readonly (readonly [
  error: string,
  reasonCode: ProviderDenial,
  consoleReason: "provider-unavailable" | undefined,
])[];
// Values with the shape of a real attempt state and browser cookie, as a client can mint them.
const minted = () => randomBytes(32).toString("base64url");

// A callback that matches no pending attempt is unauthenticated: anyone can mint its state
// and cookie. It must not write an audit event, or junk callbacks grow the audit table
// without bound (no trusted proxy, so admission keys on the cookie the sender chose). The
// API metric counts it instead. Callbacks that match an attempt keep their audit events.
// No provider is reachable: none of these callbacks may reach a provider.
test(
  "unmatched external sign-in callbacks are counted, not audited",
  requiresPostgres,
  async (t) => {
    const apps: { app?: App } = {};
    const { pool } = postgresState(t, () => [apps.app]);
    const state = new PostgresPlatformState(pool);
    await bootstrapProductionInstallation(t, { databaseUrl, email: adminEmail, authSecret });
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM occ."user" WHERE email = $1',
      [adminEmail],
    );
    const [admin] = rows;
    assert.ok(admin, "Bootstrap must create the administrator");
    const metrics = createOccMetrics("api");
    const app = (apps.app = await composeProductionSignIn(t, {
      databaseUrl,
      passwordHasher: undefined,
      settings: {
        ...googleUpgradeSettings(admin.id),
        ...oidcUpgradeSettings(admin.id),
      },
      secrets,
      metrics,
    }));
    const auditEvents = (): Promise<readonly AuditEvent[]> =>
      state.transact((unit) => unit.audit.list());
    const unmatched = async (provider: ExternalProviderName) => {
      const count = new RegExp(
        `^occ_sign_in_unmatched_callbacks_total\\{[^}]*provider="${provider}"[^}]*\\} (\\d+)$`,
        "m",
      ).exec(await metrics.exposition())?.[1];
      assert.ok(count !== undefined, `${provider}: unmatched callback counter is present`);
      return Number(count);
    };
    const callback = (provider: ExternalProviderName, query: string, cookie?: string) =>
      injectLocalhost(app, "GET", `/api/auth/providers/${provider}/callback?${query}`, {
        remoteAddress: "192.0.2.80",
        headers: cookie === undefined ? {} : { cookie },
      });
    const assertRefused = (
      response: InjectedResponse,
      provider: ExternalProviderName,
      consoleReason?: (typeof refusals)[number][2],
    ) => {
      assert.equal(response.statusCode, 302, response.body);
      assert.equal(
        response.headers.location,
        consoleReason === undefined
          ? `/console/?authError=${provider}`
          : `/console/?authError=${provider}&authReason=${consoleReason}`,
      );
    };
    const start = async (provider: ExternalProviderName) => {
      const started = await injectLocalhost(app, "POST", `/api/auth/providers/${provider}/start`, {
        remoteAddress: "192.0.2.80",
        headers: { origin },
      });
      assert.equal(started.statusCode, 200, `${provider}: sign-in start must succeed`);
      const data = recordData(parseAuthResponse("Provider sign-in start", started));
      const attemptId = text(data.attemptId);
      const redirect = URL.parse(text(data.url));
      assert.ok(redirect, "Provider redirect must be a valid URL");
      const state = redirect.searchParams.get("state");
      assert.ok(state, "Provider redirect must include a state");
      return {
        attemptId,
        state,
        cookie: cookieHeaderFromSetCookie(started.headers["set-cookie"]),
      };
    };
    const cookieName = "__Host-occ_login_attempt";

    const junkPerProvider = 20;
    for (const provider of providers) {
      const auditsBefore = (await auditEvents()).length;
      const countedBefore = await unmatched(provider);
      // Each junk callback carries a fresh, well-formed state and cookie, so the
      // cookie-keyed admission lane never refuses it with 429.
      for (let index = 0; index < junkPerProvider; index += 1) {
        assertRefused(
          await callback(provider, `state=${minted()}&code=junk`, `${cookieName}=${minted()}`),
          provider,
        );
      }
      // Malformed callbacks (no cookie, a short state) are refused before any lookup.
      assertRefused(await callback(provider, `state=${minted()}&code=junk`), provider);
      assertRefused(
        await callback(provider, "state=short&code=junk", `${cookieName}=${minted()}`),
        provider,
      );
      assert.equal((await auditEvents()).length, auditsBefore, `${provider}: no audit rows`);
      // The series starts at zero, so a first burst is visible to rate().
      assert.equal(countedBefore, 0, `${provider}: series starts at zero`);
      assert.equal(await unmatched(provider), junkPerProvider + 2, provider);
    }

    // A callback that matches its pending attempt keeps its audit event when it fails
    // afterwards: the person refused consent, or the provider reported an outage. A replay
    // of that spent state matches nothing and is counted like junk.
    for (const provider of providers) {
      // The outage says so in the Console; a refused consent stays generic.
      for (const [error, reasonCode, consoleReason] of refusals) {
        const countedBefore = await unmatched(provider);
        const auditsBefore = (await auditEvents()).length;
        const attempt = await start(provider);
        assertRefused(
          await callback(provider, `state=${attempt.state}&error=${error}`, attempt.cookie),
          provider,
          consoleReason,
        );
        const added = (await auditEvents()).slice(auditsBefore);
        const details = { provider, attemptId: attempt.attemptId };
        assert.deepEqual(
          added.map((event) => [event.kind, event.action, event.reasonCode, event.details]),
          [["authorization_denial", "authentication.login", reasonCode, details]],
          `${provider} ${error}`,
        );
        assert.equal(await unmatched(provider), countedBefore, `${provider} ${error}`);

        assertRefused(
          await callback(provider, `state=${attempt.state}&error=${error}`, attempt.cookie),
          provider,
        );
        assert.equal((await auditEvents()).length, auditsBefore + 1, `${provider} replay`);
        assert.equal(await unmatched(provider), countedBefore + 1, `${provider} replay`);
      }
    }
  },
);
