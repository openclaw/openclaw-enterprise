import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { launchTrustingBrowser } from "../helpers/dev-up-keycloak.mjs";
import {
  assertNativeWebSocketRejected,
  assertSocketClosesAfterMutation,
  createApi,
  createNativeAgent,
  createReadOperateSession,
  ensureBootstrap,
  listen,
  nativeGet,
  openNativeWebSocket,
  requiresPostgres,
  signIn,
  startNativeHttpsUpstream,
  trustLocalUpstreamCertificate,
} from "../helpers/native-admin-postgres.ts";
import { assertProviderAttached, startFakeGitHub } from "../helpers/production-sign-in.mjs";

test(
  "a guarded Console opens host-only Agent sessions bound to the browser, live parent and exact revision",
  { ...requiresPostgres, timeout: 90_000 },
  async (t) => {
    await ensureBootstrap(t);
    const upstream = await startNativeHttpsUpstream(t);
    trustLocalUpstreamCertificate(t, upstream.cert);
    // Terminate trusted HTTPS for two public origins at the same real OCC app.
    // Only the private native upstream and the GitHub provider are protocol fixtures.
    const ingress = createServer({ key: upstream.key, cert: upstream.cert }, (req, res) => {
      const proxy = request(
        {
          hostname: "127.0.0.1",
          port: apiPort,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (response) => {
          res.writeHead(response.statusCode!, response.headers);
          response.pipe(res);
        },
      );
      req.pipe(proxy);
    });
    ingress.listen(0, "127.0.0.1");
    await once(ingress, "listening");
    t.after(() => new Promise<void>((resolve) => ingress.close(() => resolve())));
    const origin = `https://console.example.test:${(ingress.address() as AddressInfo).port}`;

    // Begin with an existing Agent and an explicitly provisioned person. Opening a
    // native UI must neither enroll an unknown GitHub subject nor widen these grants.
    const seed = await createApi(t, "browser-seed", upstream.port, { origin });
    const admin = await signIn(seed.app, undefined, origin);
    const target = await createNativeAgent(seed, admin, upstream);
    const other = await createNativeAgent(seed, admin, upstream);
    const { namespace, agent, revision, native } = target;
    const { principal } = await createReadOperateSession(
      seed,
      namespace.id,
      agent.id,
      "browser",
      "administer",
    );
    const role = `native-discovery-${randomUUID()}`;
    await seed.pool.query(
      "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1,$2,'Native browser discovery',$3)",
      [role, namespace.id, JSON.stringify([{ action: "read", resourceKind: "namespace" }])],
    );
    await seed.pool.query(
      "INSERT INTO occ.iam_access_bindings (id,namespace_id,identity_subject_id,role_id,resource_kind,resource_id) VALUES ($1,$2,$3,$4,'namespace',$2)",
      [randomUUID(), namespace.id, principal.id, role],
    );
    await seed.app.close();

    const api = await createApi(t, "browser", upstream.port, { origin, exchange: true });
    t.after(() => api.app.close());
    const apiPort = await listen(api.app);
    await startFakeGitHub(t);
    const recovery = await signIn(api.app, undefined, origin);
    await assertProviderAttached(
      api.app,
      authenticatedHeaders(recovery),
      principal.subject,
      "github",
      "10101",
    );
    const browser: Browser = await launchTrustingBrowser(chromium, upstream.directory, {
      caFiles: [upstream.certPath],
      hosts: [origin, native.origin].map((url) => ({
        host: new URL(url).hostname,
        address: "127.0.0.1",
      })),
    });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/console/login`);
    await page.route("https://github.com/login/oauth/authorize**", async (route) => {
      const state = new URL(route.request().url()).searchParams.get("state");
      await route.fulfill({
        status: 302,
        headers: {
          location: `${origin}/api/auth/providers/github/callback?state=${state}&code=subject-10101`,
        },
      });
    });
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.waitForURL(/\/console\/(agents|namespaces|settings)/);
    const parent = (await context.cookies(origin)).find(
      (cookie) => cookie.name === api.auth.sessionCookieName,
    );
    assert.ok(
      parent && parent.httpOnly && parent.secure && parent.domain === new URL(origin).hostname,
    );
    const nativePath = `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`;
    const parentCookie = `${parent.name}=${parent.value}`;
    // The admission layer compares the tab's session key to its actual cookie, rather
    // than accepting another valid tab's key. Neither parent credential opens an Agent.
    const stale = await api.app.inject({
      method: "POST",
      url: nativePath + "/launch",
      headers: { origin, cookie: parentCookie, "x-occ-session-key": recovery.sessionKey },
      payload: {},
    });
    assert.equal(stale.statusCode, 401);
    assert.equal((await nativeGet(api, native, parentCookie)).statusCode, 403);

    const details = `${origin}/console/agents/${agent.id}?namespace=${namespace.id}&revision=${revision.id}`;
    const second = await context.newPage();
    await Promise.all([page.goto(details), second.goto(details)]);
    const redeem = "/__occ/native-admin/redeem";
    // Hold the first tab's redemption until another tab completes its challenge.
    // A singleton challenge cookie would be overwritten or cleared before the first POST.
    const held = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let body: string | null = null;
    let challengeCookies: string | undefined;
    await context.route("**" + redeem, async (route) => {
      if (body === null) {
        body = route.request().postData();
        challengeCookies = (await route.request().allHeaders()).cookie;
        held.resolve();
        await resume.promise;
      }
      await route.continue();
    });
    const launch = async (tab: Page) => {
      const popup = tab.waitForEvent("popup");
      await tab.getByRole("link", { name: "Open admin console" }).click();
      return popup;
    };
    const firstWindow = launch(page);
    await held.promise;
    const secondWindow = await launch(second);
    await secondWindow.getByText("native postgres upstream").waitFor();
    resume.resolve();
    const popup = await firstWindow;
    await popup.getByText("native postgres upstream").waitFor();
    assert.equal(new URL(popup.url()).origin, native.origin);
    assert.equal(await popup.evaluate("window.opener === null"), true);

    const cookies = await context.cookies(native.origin);
    const handle = cookies.find((cookie) => cookie.name === "__Host-occ_agent_access");
    assert.ok(handle?.httpOnly && handle.secure && handle.sameSite === "Strict");
    assert.equal(handle.domain, new URL(native.origin).hostname);
    assert.ok(!cookies.some((cookie) => cookie.name === parent.name));
    assert.equal(upstream.requests.at(-1)?.headers.cookie, undefined);
    const host = new URL(native.origin).host;
    const replay = await api.app.inject({
      method: "POST",
      url: redeem,
      headers: {
        host,
        origin,
        cookie: challengeCookies!,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: body!,
    });
    assert.equal(replay.statusCode, 403);
    const hash = createHash("sha256").update(handle.value).digest("hex");
    const stored = await api.pool.query(
      `SELECT h.parent_session_id, h.principal_id, h.namespace_id, h.agent_id, h.revision_id,
        h.origin, (h.expires_at <= s.expires_at) AS bounded
        FROM occ.native_browser_handles h JOIN occ.session s ON s.id = h.parent_session_id
        WHERE handle_hash=$1`,
      [hash],
    );
    const binding = stored.rows[0];
    assert.deepEqual(
      [
        binding.principal_id,
        binding.namespace_id,
        binding.agent_id,
        binding.revision_id,
        binding.origin,
        binding.bounded,
      ],
      [principal.id, namespace.id, agent.id, revision.id, native.origin, true],
    );
    const cookie = `${handle.name}=${handle.value}`;
    assert.equal((await nativeGet(api, other.native, cookie)).statusCode, 403);
    await assertNativeWebSocketRejected(apiPort, native, cookie, { origin });

    // A native socket survives a normal renewal. Signing out its actual parent closes
    // the live socket and prevents both HTTP access and a fresh WebSocket upgrade.
    const socket = await openNativeWebSocket(apiPort, native, cookie);
    t.after(() => {
      socket.destroy();
    });
    assert.equal(upstream.upgrades.at(-1)?.headers.cookie, undefined);
    await assertSocketClosesAfterMutation(socket, async () => {
      const ended = await api.app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        headers: { cookie: parentCookie, origin },
        payload: {},
      });
      assert.equal(ended.statusCode, 200);
    });
    assert.equal((await nativeGet(api, native, cookie)).statusCode, 403);
    await assertNativeWebSocketRejected(apiPort, native, cookie);
    const after = await api.pool.query(
      "SELECT 1 FROM occ.native_browser_handles WHERE handle_hash=$1",
      [hash],
    );
    assert.equal(after.rowCount, 0);
  },
);
