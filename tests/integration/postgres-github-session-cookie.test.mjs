import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { chromium } from "playwright";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedProductionHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "production GitHub-profile sessions reject cookies planted by a sibling domain",
  requiresPostgres,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const certificateDirectory = await mkdtemp(join(tmpdir(), "oce-session-cookie-"));
    let app;
    let browser;
    let proxy;
    let upstreamPort;
    let plantedCookie;
    t.after(async () => {
      await browser?.close();
      await app?.close();
      if (proxy) {
        await new Promise((resolve) => proxy.close(resolve));
      }
      await pool.end();
      await rm(certificateDirectory, { recursive: true, force: true });
    });
    const certificate = join(certificateDirectory, "certificate.pem");
    const key = join(certificateDirectory, "key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=console.example.test",
        "-addext",
        "subjectAltName=DNS:console.example.test,DNS:sibling.example.test",
      ],
      { stdio: "ignore" },
    );
    proxy = createServer(
      { cert: await readFile(certificate), key: await readFile(key) },
      (incoming, outgoing) => {
        if (incoming.headers.host?.startsWith("sibling.example.test:")) {
          const attributes = "; Domain=example.test; Path=/; Secure; HttpOnly; SameSite=Lax";
          outgoing.setHeader("set-cookie", [
            `${plantedCookie}${attributes}`,
            `${plantedCookie.replace("__Host-", "__Secure-")}${attributes}`,
          ]);
          outgoing.end("Cookies sent");
          return;
        }
        const upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port: upstreamPort,
            method: incoming.method,
            path: incoming.url,
            headers: incoming.headers,
          },
          (response) => {
            outgoing.writeHead(response.statusCode, response.headers);
            response.pipe(outgoing);
          },
        );
        upstream.on("error", () => {
          outgoing.writeHead(502);
          outgoing.end();
        });
        incoming.pipe(upstream);
      },
    );
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const port = proxy.address().port;
    const origin = `https://console.example.test:${port}`;
    const email = "cookie-owner@example.test";
    const password = "cookie-owner-test-password";
    const secret = "cookie-security-test-secret-at-least-32-bytes";
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      email,
      password,
      authSecret: secret,
      authBaseURL: "http://127.0.0.1",
      installationName: "Cookie boundary proof",
    });
    const recoveryUserId = (await pool.query('SELECT id FROM occ."user" WHERE email=$1', [email]))
      .rows[0].id;
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    const iamDriver = new NativeIAMDriver(state);
    const controller = new OpenClawController(installation, { state, recordOperations: true });
    controller.registerDriver(iamDriver);
    const auth = await createPostgresControllerAuth({
      mode: "production",
      installationId: installation.id,
      secret,
      baseURL: origin,
      pool,
      state,
      iamDriver,
      github: {
        clientId: "cookie-test-client",
        clientSecret: "cookie-test-secret",
        recoveryUserId,
      },
    });
    // Exercise real production auth, State, IAM and Fastify over HTTPS. Compute
    // is not invoked; this component fixture does not qualify a deployment.
    app = createFastifyApp({
      controller,
      iamDriver,
      auth,
      auditSink: state.auditSink,
      resolveHarness: resolveApprovedProductionHarness,
      publicOrigin: origin,
      development: { enabled: false, installationId: installation.id },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    upstreamPort = app.server.address().port;
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email, password },
    });
    assert.equal(signedIn.statusCode, 200);
    assert.equal(auth.sessionCookieName, "__Host-openclaw_occ.session_token");
    const cookies = [signedIn.headers["set-cookie"]].flat();
    const sessionCookie = cookies.find((value) => value.startsWith(`${auth.sessionCookieName}=`));
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /; Secure(?:;|$)/i);
    assert.match(sessionCookie, /; HttpOnly(?:;|$)/i);
    assert.match(sessionCookie, /; Path=\/(?:;|$)/i);
    assert.doesNotMatch(sessionCookie, /; Domain=/i);
    // x-occ-session-key can only narrow which cookie session a request may use:
    // absent keeps the cookie contract, and a key never selects a session.
    const ownKey = signedIn.json().data.sessionKey;
    assert.match(ownKey, /^[A-Za-z0-9_-]{43}$/);
    const ownCookie = sessionCookie.split(";")[0];
    const otherLogin = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email, password },
    });
    const foreignKey = otherLogin.json().data.sessionKey;
    assert.notEqual(foreignKey, ownKey);
    const inspect = (url, headers) => app.inject({ url, headers: { origin, ...headers } });
    assert.equal(
      (await inspect("/api/auth/session", { cookie: ownCookie })).json().data.sessionKey,
      ownKey,
    );
    // Protected API narrowing is proved with the full composition in
    // postgres-github-sign-in.test.mjs; this fixture owns the HTTPS session route.
    const plain = await inspect("/api/auth/session", { cookie: ownCookie });
    assert.equal(plain.json().data.user.id, recoveryUserId);
    assert.equal(
      (
        await inspect("/api/auth/session", { cookie: ownCookie, "x-occ-session-key": ownKey })
      ).json().data.sessionKey,
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
      (await inspect("/api/auth/session", { "x-occ-session-key": ownKey })).json().data,
      null,
    );
    plantedCookie = sessionCookie.split(";")[0];
    browser = await chromium.launch({
      chromiumSandbox: true,
      ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
        ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
        : {}),
      args: [
        "--no-proxy-server",
        "--host-resolver-rules=MAP console.example.test 127.0.0.1, MAP sibling.example.test 127.0.0.1",
      ],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`https://sibling.example.test:${port}/plant`);
    const domainCookies = await context.cookies();
    assert.equal(
      domainCookies.some((cookie) => cookie.name === auth.sessionCookieName),
      false,
      "the browser rejects a Domain attribute on a __Host- cookie",
    );
    assert.equal(
      domainCookies.some(
        (cookie) =>
          cookie.name === "__Secure-openclaw_occ.session_token" &&
          cookie.domain === ".example.test",
      ),
      true,
      "the sibling fixture can plant an ordinary parent-domain cookie",
    );
    const anonymous = await page.goto(`${origin}/api/auth/session`);
    assert.equal(anonymous.status(), 200);
    assert.equal((await anonymous.json()).data, null);
    await context.clearCookies();
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
    assert.equal((await current.json()).data.user.id, recoveryUserId);
    const saved = (await context.cookies(origin)).find(
      (cookie) => cookie.name === auth.sessionCookieName,
    );
    assert.equal(saved.domain, "console.example.test");
    assert.equal(saved.secure, true);
    assert.equal(saved.httpOnly, true);
  },
);
