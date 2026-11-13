import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { clientAddressConfiguration } from "../../apps/controller/src/auth/index.ts";
import { resolveApprovedProductionHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { cookieHeaderFromSetCookie } from "../../packages/utils/src/index.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createPostgresControllerAuth } from "../helpers/password-hasher.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  injectLocalhost,
  text,
  type Credentials,
} from "../helpers/postgres-sign-in-test-boundaries.ts";

test(
  "sign-in admission keys on the client behind a trusted ingress and ignores other peers' headers",
  requiresPostgres,
  async (t) => {
    assert.ok(databaseUrl);
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const resources: { app?: ReturnType<typeof createFastifyApp> } = {};
    t.after(async () => {
      await resources.app?.close();
      await pool.end();
    });
    const origin = "https://console.example.test";
    const email = "proxy-recovery@example.test";
    const password = "proxy-recovery-test-password";
    const secret = "trusted-proxy-test-secret-at-least-32-bytes";
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      email,
      password,
      authSecret: secret,
      authBaseURL: "https://console.oce.localhost",
      installationName: "Trusted proxy proof",
    });
    const { rows } = await pool.query<{ id: unknown }, [string]>(
      'SELECT id FROM occ."user" WHERE email=$1',
      [email],
    );
    const recoveryUserId = text(rows[0]?.id);
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    assert.ok(installation);
    const iamDriver = new NativeIAMDriver(state);
    const clientAddress = clientAddressConfiguration({
      OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/24",
    });
    assert.ok(clientAddress);
    const auth = await createPostgresControllerAuth({
      mode: "production",
      installationId: installation.id,
      secret,
      baseURL: origin,
      agentDomain: "agents.example.test",
      pool,
      state,
      iamDriver,
      clientAddress,
      google: {
        clientId: "proxy-test-client",
        clientSecret: "proxy-test-secret",
        allowedDomains: [],
        recoveryUserId,
      },
    });
    // Real production auth, State, IAM and Fastify admission; no Controller routes are used.
    const app = createFastifyApp({
      iamDriver,
      auth,
      auditSink: state.auditSink,
      resolveHarness: resolveApprovedProductionHarness,
      publicOrigin: origin,
      development: { enabled: false, installationId: installation.id },
      trustedProxies: clientAddress,
    });
    resources.app = app;
    await app.ready();
    const ingress = "10.0.0.9";
    const outsider = "192.0.2.7";
    const signIn = (peer: string, headers: Record<string, string>, account: Credentials) =>
      injectLocalhost(app, "POST", "/api/auth/sign-in/email", {
        remoteAddress: peer,
        headers: { origin, ...headers },
        body: account,
      });
    const guess = (peer: string, headers: Record<string, string>, index: number) =>
      signIn(peer, headers, {
        email: `guess-${peer}-${index}@example.test`,
        password: "wrong-guess-password",
      });

    await t.test(
      "a flood from one client behind the ingress leaves other clients admitted",
      async () => {
        // Twenty failed sign-ins per client address, each for a different email.
        const client = { "x-forwarded-for": `1.2.3.4, ${ingress}` };
        for (let index = 0; index < 20; index += 1) {
          assert.equal((await guess(ingress, client, index)).statusCode, 401);
        }
        const refused = await guess(ingress, client, 20);
        assert.equal(refused.statusCode, 429);
        assert.ok(Number(refused.headers["retry-after"]) >= 1);
        assert.equal((await guess(ingress, { "x-forwarded-for": "5.6.7.8" }, 21)).statusCode, 401);
      },
    );

    await t.test("an untrusted peer cannot choose its client address", async () => {
      for (let index = 0; index < 20; index += 1) {
        const spoofed = { "x-forwarded-for": `198.51.100.${index}` };
        assert.equal((await guess(outsider, spoofed, index)).statusCode, 401);
      }
      assert.equal(
        (await guess(outsider, { "x-forwarded-for": "198.51.100.99" }, 20)).statusCode,
        429,
      );
    });

    await t.test("protected calls tolerate forwarded headers only from the ingress", async () => {
      const signedIn = await signIn(outsider, {}, { email, password });
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const session = { cookie: cookieHeaderFromSetCookie(signedIn.headers["set-cookie"]), origin };
      const forwarded = {
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "1.2.3.4",
        "x-forwarded-proto": "https",
      };
      const read = (peer: string, headers: Record<string, string>) =>
        injectLocalhost(app, "GET", `/api/auth/accounts/${recoveryUserId}`, {
          remoteAddress: peer,
          headers: { ...session, ...headers },
        });
      const direct = await read(outsider, {});
      assert.equal(direct.statusCode, 200, direct.body);
      const proxied = await read(ingress, forwarded);
      assert.equal(proxied.statusCode, 200, proxied.body);
      assert.equal((await read(outsider, forwarded)).statusCode, 403);
      assert.equal((await read(outsider, { forwarded: "for=1.2.3.4" })).statusCode, 403);
    });

    // postgres-password-sign-in-limit.test.ts proves the same keying with Google off.
  },
);
