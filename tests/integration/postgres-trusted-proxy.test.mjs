import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  clientAddressConfiguration,
  createPostgresControllerAuth,
} from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedProductionHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;

test(
  "sign-in admission keys on the client behind a trusted ingress and ignores other peers' headers",
  {
    skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL proof.",
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    let app;
    t.after(async () => {
      await app?.close();
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
      authBaseURL: "http://127.0.0.1",
      installationName: "Trusted proxy proof",
    });
    const recoveryUserId = (await pool.query('SELECT id FROM occ."user" WHERE email=$1', [email]))
      .rows[0].id;
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    const iamDriver = new NativeIAMDriver(state);
    const clientAddress = clientAddressConfiguration({
      OCC_AUTH_TRUSTED_PROXY_CIDRS: "10.0.0.0/24",
    });
    const auth = await createPostgresControllerAuth({
      mode: "production",
      installationId: installation.id,
      secret,
      baseURL: origin,
      pool,
      state,
      iamDriver,
      clientAddress,
      github: {
        clientId: "proxy-test-client",
        clientSecret: "proxy-test-secret",
        recoveryUserId,
      },
    });
    // Real production auth, State, IAM and Fastify admission; no Controller routes are used.
    app = createFastifyApp({
      iamDriver,
      auth,
      auditSink: state.auditSink,
      resolveHarness: resolveApprovedProductionHarness,
      publicOrigin: origin,
      development: { enabled: false, installationId: installation.id },
      trustedProxies: clientAddress,
    });
    await app.ready();
    const ingress = "10.0.0.9";
    const outsider = "192.0.2.7";
    const signIn = (peer, headers, account) =>
      app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress: peer,
        headers: { origin, ...headers },
        payload: account,
      });
    const guess = (peer, headers, index) =>
      signIn(peer, headers, {
        email: `guess-${peer}-${index}@example.test`,
        password: "wrong-guess-password",
      });

    await t.test(
      "a flood from one client behind the ingress leaves other clients admitted",
      async () => {
        const client = { "x-forwarded-for": `1.2.3.4, ${ingress}` };
        for (let index = 0; index < 10; index += 1) {
          assert.equal((await guess(ingress, client, index)).statusCode, 401);
        }
        assert.equal((await guess(ingress, client, 10)).statusCode, 429);
        assert.equal((await guess(ingress, { "x-forwarded-for": "5.6.7.8" }, 11)).statusCode, 401);
      },
    );

    await t.test("an untrusted peer cannot choose its client address", async () => {
      for (let index = 0; index < 10; index += 1) {
        const spoofed = { "x-forwarded-for": `198.51.100.${index}` };
        assert.equal((await guess(outsider, spoofed, index)).statusCode, 401);
      }
      assert.equal(
        (await guess(outsider, { "x-forwarded-for": "198.51.100.99" }, 10)).statusCode,
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
      const read = (peer, headers) =>
        app.inject({
          url: `/api/auth/accounts/${recoveryUserId}`,
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

    // postgres-password-sign-in-limit.test.mjs proves the same keying with GitHub off.
  },
);
