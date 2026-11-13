import assert from "node:assert/strict";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:https";
import test from "node:test";
import pg from "pg";
import { chromium, type Browser } from "playwright";
import { createPostgresControllerAuth } from "../helpers/password-hasher.mjs";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedProductionHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { selfSigned } from "../helpers/certificates.mjs";
import {
  injectLocalhost,
  record,
  recordData,
  text,
} from "../helpers/postgres-sign-in-test-boundaries.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "guarded production sessions share the browser cookie with trusted Agent hosts",
  requiresPostgres,
  async (t) => {
    assert.ok(databaseUrl);
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const resources: {
      app?: ReturnType<typeof createFastifyApp>;
      browser?: Browser;
      proxy?: ReturnType<typeof createServer>;
      upstreamPort?: number;
    } = {};
    t.after(async () => {
      const { app, browser, proxy } = resources;
      await browser?.close();
      await app?.close();
      if (proxy) {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
      await pool.end();
    });
    // Registered after the hook above, so it is removed after the servers close.
    const certificateDirectory = await temporaryDirectory(t, "oce-session-cookie-");
    const { key, cert } = await selfSigned(certificateDirectory, {
      commonName: "console.example.test",
      subjectAltName: "DNS:console.example.test,DNS:sibling.example.test",
    });
    const proxy = createServer({ cert, key }, (incoming, outgoing) => {
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: resources.upstreamPort,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (response) => {
          assert.ok(response.statusCode !== undefined);
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    });
    resources.proxy = proxy;
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== "string");
    const { port } = proxyAddress;
    const origin = `https://console.example.test:${port}`;
    const email = "cookie-owner@example.test";
    const password = "cookie-owner-test-password";
    const secret = "cookie-security-test-secret-at-least-32-bytes";
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      email,
      password,
      authSecret: secret,
      authBaseURL: "https://console.oce.localhost",
      installationName: "Cookie boundary proof",
    });
    const {
      rows: [recoveryUser],
    } = await pool.query<{ id: string }>('SELECT id FROM occ."user" WHERE email=$1', [email]);
    assert.ok(recoveryUser);
    const { id: recoveryUserId } = recoveryUser;
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    assert.ok(installation);
    const iamDriver = new NativeIAMDriver(state);
    const controller = new OpenClawController(installation, { state, recordOperations: true });
    controller.registerDriver(iamDriver);
    const auth = await createPostgresControllerAuth({
      mode: "production",
      installationId: installation.id,
      secret,
      baseURL: origin,
      agentDomain: "sibling.example.test",
      pool,
      state,
      iamDriver,
      google: {
        clientId: "cookie-test-client",
        clientSecret: "cookie-test-secret",
        allowedDomains: [],
        recoveryUserId,
      },
    });
    // Exercise real production auth, State, IAM and Fastify over HTTPS. Compute
    // is not invoked; this component fixture does not qualify a deployment.
    const app = createFastifyApp({
      controller,
      iamDriver,
      auth,
      auditSink: state.auditSink,
      resolveHarness: resolveApprovedProductionHarness,
      publicOrigin: origin,
      development: { enabled: false, installationId: installation.id },
    });
    resources.app = app;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const upstreamAddress = app.server.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    resources.upstreamPort = upstreamAddress.port;
    const signIn = () =>
      injectLocalhost(app, "POST", "/api/auth/sign-in/email", {
        headers: { origin },
        body: { email, password },
      });
    const signedIn = await signIn();
    assert.equal(signedIn.statusCode, 200);
    assert.equal(auth.sessionCookieName, "__Secure-openclaw_occ_shared.session_token");
    const setCookie = signedIn.headers["set-cookie"];
    assert.ok(setCookie);
    const cookies = [setCookie].flat();
    const sessionCookie = cookies.find(
      (value) => value.startsWith(`${auth.sessionCookieName}=`) && !/Max-Age=0(?:;|$)/i.test(value),
    );
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /; Secure(?:;|$)/i);
    assert.match(sessionCookie, /; HttpOnly(?:;|$)/i);
    assert.match(sessionCookie, /; Path=\/(?:;|$)/i);
    assert.match(sessionCookie, /; Domain=example\.test(?:;|$)/i);
    // x-occ-session-key can only narrow which cookie session a request may use:
    // absent keeps the cookie contract, and a key never selects a session.
    const ownKey = text(recordData(signedIn.json()).sessionKey);
    assert.match(ownKey, /^[A-Za-z0-9_-]{43}$/);
    const [ownCookie] = sessionCookie.split(";");
    assert.ok(ownCookie);
    const otherLogin = await signIn();
    const foreignKey = text(recordData(otherLogin.json()).sessionKey);
    assert.notEqual(foreignKey, ownKey);
    const inspect = (url: string, headers: IncomingHttpHeaders) =>
      app.inject({ url, headers: { origin, ...headers } });
    assert.equal(
      recordData((await inspect("/api/auth/session", { cookie: ownCookie })).json<unknown>())
        .sessionKey,
      ownKey,
    );
    // Protected API narrowing is proved with the full composition in
    // postgres-google-sign-in.test.ts; this fixture owns the HTTPS session route.
    const plain = await inspect("/api/auth/session", { cookie: ownCookie });
    assert.equal(record(recordData(plain.json<unknown>()).user).id, recoveryUserId);
    assert.equal(
      recordData(
        (
          await inspect("/api/auth/session", { cookie: ownCookie, "x-occ-session-key": ownKey })
        ).json<unknown>(),
      ).sessionKey,
      ownKey,
    );
    for (const key of [foreignKey, "malformed", [ownKey, ownKey]]) {
      const refused = await inspect("/api/auth/session", {
        cookie: ownCookie,
        "x-occ-session-key": key,
      });
      assert.equal(refused.statusCode, 401, refused.body);
      assert.equal(refused.headers["set-cookie"], undefined);
    }
    // Without a cookie the key selects nothing: no session and no protected access.
    assert.equal(
      record((await inspect("/api/auth/session", { "x-occ-session-key": ownKey })).json<unknown>())
        .data,
      null,
    );
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
        ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
        : {}),
      args: [
        "--no-proxy-server",
        "--host-resolver-rules=MAP console.example.test 127.0.0.1, MAP sibling.example.test 127.0.0.1",
      ],
    });
    resources.browser = browser;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/api/auth/session`);
    const legitimateStatus = await page.evaluate(
      async (credentials) => {
        const response = await fetch("/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(credentials),
        });
        return response.status;
      },
      { email, password },
    );
    assert.equal(legitimateStatus, 200);
    const current = await page.goto(`${origin}/api/auth/session`);
    assert.ok(current);
    assert.equal(record(recordData(await current.json()).user).id, recoveryUserId);
    const saved = (await context.cookies(origin)).find(
      (cookie) => cookie.name === auth.sessionCookieName,
    );
    assert.ok(saved);
    assert.equal(saved.domain, ".example.test");
    assert.equal(saved.secure, true);
    assert.equal(saved.httpOnly, true);
    // Shared sessions reach trusted Agent hosts; account/device hints remain Console-only.
    const agentCookies = await context.cookies(`https://sibling.example.test:${port}`);
    assert.ok(agentCookies.some((cookie) => cookie.name === auth.sessionCookieName));
    assert.ok(!agentCookies.some((cookie) => cookie.name === "__Host-occ_known_device"));
    const knownDevice = (await context.cookies(origin)).find(
      (cookie) => cookie.name === "__Host-occ_known_device",
    );
    assert.equal(knownDevice?.domain, "console.example.test");
    const shared = await page.goto(`https://sibling.example.test:${port}/api/auth/session`);
    assert.ok(shared);
    assert.equal(record(recordData(await shared.json()).user).id, recoveryUserId);
    const originDenied = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { origin: `https://sibling.example.test:${port}`, cookie: ownCookie },
    });
    assert.equal(originDenied.statusCode, 403);
  },
);
