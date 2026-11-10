// Exercise browser session cookies against the real HTTPS listener and stock Agent UI.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin-host.mjs";
import { chromium } from "playwright";
import { launchTrustingBrowser, publishedJSON } from "./dev-up-keycloak.mjs";
import { enableInstalledOidcNativeAdmin } from "./native-admin-oidc-k3d.mjs";
import { submitChatTurnWithAssistantProof, waitForStockUi } from "./native-ui-chat.mjs";

const execute = promisify(execFile);

export async function verifyOpenShellOwnerSession({
  t,
  cluster,
  browserPort,
  stateDirectory,
  namespaceId,
  kubectl,
  environment,
}) {
  const consoleHost = `console.${cluster}.oce.localhost`;
  const consoleOrigin = `https://${consoleHost}:${browserPort}`;
  const agentDomain = `agents.${cluster}.oce.localhost`;
  const scope = `/namespaces/${namespaceId}`;
  // Install the public CA in the fixture browser's private trust database before
  // startup. Chromium verifies both hostnames and manages the HttpOnly cookies.
  const browser = await launchTrustingBrowser(chromium, dirname(stateDirectory), {
    caFiles: [join(stateDirectory, "browser-ca.crt")],
    hosts: [
      { host: consoleHost, address: "127.0.0.1" },
      { host: "*." + agentDomain, address: "127.0.0.1" },
      { host: "*", address: "~NOTFOUND" },
    ],
  });
  t.after(() => browser.close());
  const origins = new Set([consoleOrigin]);

  async function consoleRequest(page, method, path, body) {
    assert.equal(new URL(page.url()).origin, consoleOrigin);
    return page.evaluate(
      async ({ method, path, body }) => {
        const res = await fetch(path, {
          method,
          mode: "same-origin",
          credentials: "same-origin",
          redirect: "error",
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        return {
          status: res.status,
          data: res.status === 204 ? undefined : (await res.json()).data,
        };
      },
      { method, path, body },
    );
  }

  async function signIn(email, password, recovery = false) {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", (route) =>
      origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    const loaded = await page.goto(consoleOrigin + "/console/");
    assert.ok(loaded);
    assert.equal((await loaded.serverAddr())?.ipAddress, "127.0.0.1");
    if (recovery) {
      await page.getByRole("button", { name: "Recovery sign-in", exact: true }).click();
    }
    await page.getByLabel("Email", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).origin, consoleOrigin);
    const signedOut = await consoleRequest(page, "GET", "/api/auth/session");
    assert.equal(signedOut.status, 200);
    assert.equal(signedOut.data, null);
    await page.getByLabel("Email", { exact: true }).fill(email);
    // Keep credentials out of Playwright call logs if the form stops accepting input.
    try {
      await page.getByLabel("Password", { exact: true }).fill(password);
    } catch {
      assert.fail("Could not enter the password on the verified fixture sign-in form");
    }
    const response = page.waitForResponse(
      (res) =>
        res.url() === consoleOrigin + "/api/auth/sign-in/email" &&
        res.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    assert.equal((await response).status(), 200, "ordinary Console password form");
    await page.getByLabel("Password", { exact: true }).waitFor({ state: "hidden" });
    return page;
  }

  let owner = await signIn(
    "admin@development.openclaw.invalid",
    (await readFile(join(stateDirectory, "initial-admin-password"), "utf8")).trim(),
  );
  async function api(method, path, body, status = 200) {
    const res = await consoleRequest(owner, method, path, body);
    assert.equal(res.status, status, `${method} ${path}`);
    return res.data;
  }

  // Use the shipped first-Agent entry point, including its own bootstrap settings,
  // deployment checks and real model verification. The rest of the test never
  // needs the model credential or Git repository authority.
  const name = "browser-onboarding";
  const modelEnvironment = {
    ...environment,
    OPENCLAW_FIRST_AGENT_MODEL: process.env.OCC_TEST_OPENAI_MODEL,
  };
  delete modelEnvironment.OPENAI_API_KEY;
  delete modelEnvironment.OPENAI_API_KEY_FILE;
  assert.ok(
    modelEnvironment.CODEX_ACCESS_TOKEN || modelEnvironment.CODEX_ACCESS_TOKEN_FILE,
    "Set the existing Codex service-account token or its private file for the real browser Agent",
  );
  assert.ok(
    modelEnvironment.OPENCLAW_FIRST_AGENT_MODEL,
    "Set OCC_TEST_OPENAI_MODEL for the selected account",
  );
  await execute(
    process.execPath,
    [
      fileURLToPath(new URL("../../scripts/first-agent.mjs", import.meta.url)),
      name,
      "--harness",
      "codex",
      "--control-ui",
    ],
    { env: modelEnvironment, timeout: 600_000, maxBuffer: 1024 * 1024 },
  );
  const agents = (await api("GET", scope + "/agents")).filter((a) => a.name === name);
  assert.equal(agents.length, 1, "the helper created one Agent in its own default Namespace");
  const agent = agents[0];
  const agentPath = scope + "/agents/" + agent.id;
  const rev = { id: agent.activeRevisionId };
  assert.ok(rev.id, "first-Agent reported a serving revision");
  const deployment = await api("GET", agentPath + "/deployments/" + rev.id);
  assert.equal(deployment.status, "succeeded");
  const installation = await api("GET", "/installation");
  const host = deriveNativeAdminHost(installation.id, agent, agentDomain);
  const origin = `https://${host}:${browserPort}`;
  origins.add(origin);
  async function grant(subjectId, resourceKind, resourceId, actions) {
    const role = await api(
      "POST",
      scope + "/iam/roles",
      {
        name: "browser-" + actions.join("-"),
        permissions: actions.map((action) => ({ action, resourceKind })),
      },
      201,
    );
    return api(
      "POST",
      scope + "/iam/access-bindings",
      { subjectKind: "identity", subjectId, roleId: role.id, resourceKind, resourceId },
      201,
    );
  }
  const access = await api("GET", agentPath + "/native-admin");
  assert.equal(access.origin, origin);
  assert.equal(access.status, "available");
  const instructions = await api("GET", agentPath + "/workspace/files/AGENTS.md");
  assert.ok(instructions.content.trim(), "fresh workspace has its real bootstrap instructions");
  const { stdout: pods } = await execute(
    "kubectl",
    [
      ...kubectl,
      "get",
      "pod",
      "-A",
      "-l",
      `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${rev.id}`,
      "-o",
      "json",
    ],
    { env: environment },
  );
  const native = JSON.parse(pods).items.filter((p) =>
    p.status.containerStatuses?.some((c) => c.name === "agent" && c.ready),
  );
  assert.equal(native.length, 1);
  await execute(
    "kubectl",
    [
      ...kubectl,
      "-n",
      native[0].metadata.namespace,
      "exec",
      native[0].metadata.name,
      "-c",
      "agent",
      "--",
      "test",
      "-s",
      "/sandbox/enterprise/BOOTSTRAP.md",
    ],
    { env: environment },
  );

  const email = `browser-reader-${randomUUID()}@example.test`;
  const password = "test-owner-" + randomUUID();
  const account = await api(
    "POST",
    "/api/auth/accounts",
    { email, password, name: "Test collaborator" },
    201,
  );
  await grant(account.principalId, "agent", agent.id, ["read"]);
  const collaborator = await signIn(email, password);
  const denied = "before-" + randomUUID();
  const allowed = "grant-" + randomUUID();
  const revoked = "revoked-" + randomUUID();
  const barrier = "owner-" + randomUUID();
  const reconnect = "ws-revoked-" + randomUUID();
  async function navigate(page, marker, status) {
    const response = await page.goto(origin + "/settings/advanced?probe=" + marker, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(response?.status(), status);
    assert.equal((await response.serverAddr())?.ipAddress, "127.0.0.1");
    if (status === 200) {
      assert.ok(
        await page.locator("html").getAttribute("data-openclaw-bootstrap-config"),
        "stock UI bootstrap present",
      );
    }
  }
  async function connectedTab(person, marker) {
    const page = await person.context().newPage();
    // hello-ok is the native Gateway's authenticated response on this exact
    // socket. A successful HTML request or a bare 101 does not establish it.
    const hello = page
      .waitForEvent("websocket", {
        predicate: (ws) => new URL(ws.url()).origin === origin.replace("https:", "wss:"),
        timeout: 30_000,
      })
      .then(async (ws) => {
        await ws.waitForEvent("framereceived", {
          timeout: 30_000,
          predicate: ({ payload }) => {
            const frame = JSON.parse(String(payload));
            return frame.type === "res" && frame.ok === true && frame.payload?.type === "hello-ok";
          },
        });
        return ws;
      });
    const [socket] = await Promise.all([hello, navigate(page, marker, 200)]);
    return { page, socket };
  }
  assert.equal((await consoleRequest(collaborator, "GET", agentPath)).status, 200);
  const deniedPage = await collaborator.context().newPage();
  await navigate(deniedPage, denied, 403);
  const binding = await grant(account.principalId, "agent", agent.id, ["administer"]);
  const shared = await connectedTab(collaborator, allowed);
  const control = await connectedTab(owner, "control-" + randomUUID());
  assert.ok(!shared.socket.isClosed() && !control.socket.isClosed());

  // Keep the original pages, cookies and Gateway alive while removing just the
  // collaborator's administer binding. The owner is an unaffected socket control.
  const started = performance.now();
  await Promise.all([
    shared.socket.waitForEvent("close", { timeout: 30_000 }),
    api("DELETE", scope + "/iam/access-bindings/" + binding.id, undefined, 204),
  ]);
  const elapsed = Math.ceil(performance.now() - started);
  assert.ok(
    elapsed <= 30_000,
    "withdrawal closed the established socket within its authorization lease",
  );
  assert.ok(!control.socket.isClosed(), "the owner's existing socket stays open");

  // Use the revoked browser's same origin and cookies to attempt a new upgrade.
  // A refused upgrade must never open or reach the private Envoy route.
  const opened = await shared.page.evaluate(
    ({ path, marker }) =>
      new Promise((resolve, reject) => {
        const url = new URL(globalThis.location.origin);
        url.pathname = path;
        url.protocol = "wss:";
        url.searchParams.set("probe", marker);
        const ws = new globalThis.WebSocket(url);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("upgrade did not settle"));
        }, 10_000);
        ws.onopen = () => {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        };
        ws.onclose = () => {
          clearTimeout(timeout);
          resolve(false);
        };
      }),
    { path: new URL(shared.socket.url()).pathname, marker: reconnect },
  );
  assert.equal(opened, false, "the withdrawn session cannot reopen its native stream");
  await navigate(deniedPage, revoked, 403);
  assert.equal(
    (await consoleRequest(collaborator, "GET", agentPath)).status,
    200,
    "same signed-in collaborator retains Agent read",
  );
  const barrierPage = await owner.context().newPage();
  await navigate(barrierPage, barrier, 200);
  assert.ok(
    !control.socket.isClosed(),
    "authorized control still connected after the denied retry",
  );

  // Correlate closure to OCC's authorization decision rather than a network
  // interruption. Return a boolean only, scoped to this human and this Agent.
  async function withdrawalAudited() {
    const audit = execute(
      "kubectl",
      [
        ...kubectl,
        "-n",
        "oce-system",
        "exec",
        "-i",
        "statefulset/postgres",
        "--",
        "env",
        "PGOPTIONS=-c default_transaction_read_only=on",
        "psql",
        "-qXAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        environment.OCC_DEVELOPMENT_DATABASE_NAME ?? "openclaw_enterprise",
        "-v",
        "actor=" + account.principalId,
        "-v",
        "agent=" + agent.id,
        "-f",
        "-",
      ],
      { env: environment },
    );
    audit.child.stdin
      .end(`SELECT EXISTS (SELECT 1 FROM occ.audit_events opened JOIN occ.audit_events closed
    ON opened.details->'nativeAdmin'->>'connectionId'=closed.details->'nativeAdmin'->>'connectionId'
    WHERE opened.actor_id=:'actor' AND closed.actor_id=:'actor' AND opened.resource_id=:'agent' AND closed.resource_id=:'agent'
      AND opened.action='openclaw.agents.native_admin.websocket.connect'
      AND closed.action='openclaw.agents.native_admin.websocket.close'
      AND closed.details->'nativeAdmin'->>'closeReason'='authorization_denied');`);
    return (await audit).stdout.trim() === "t";
  }
  const auditDeadline = Date.now() + 10_000;
  let audited = await withdrawalAudited();
  while (!audited && Date.now() < auditDeadline) {
    await delay(250);
    audited = await withdrawalAudited();
  }
  assert.ok(audited, "matched native socket connect and authorization-denied close audit");
  // Require positive controls in the real private Envoy logs before interpreting
  // absence. Both refused request markers must stop at OCC, before the Gateway.
  const observationDeadline = Date.now() + 30_000;
  let reached;
  while (Date.now() < observationDeadline) {
    const { stdout: logs } = await execute(
      "kubectl",
      [
        ...kubectl,
        "-n",
        "envoy-gateway-system",
        "logs",
        "-l",
        "gateway.envoyproxy.io/owning-gateway-namespace=oce-system",
        "-c",
        "envoy",
        "--tail=1500",
      ],
      { env: environment, maxBuffer: 4 * 1024 * 1024 },
    );
    if (logs.includes(allowed) && logs.includes(barrier)) {
      assert.ok(
        !logs.includes(denied) && !logs.includes(revoked) && !logs.includes(reconnect),
        "denied requests must not reach private Gateway routing",
      );
      reached = true;
      break;
    }
    await delay(500);
  }
  assert.ok(reached, "both authorized requests must be observable at the private Gateway route");
  t.diagnostic(
    `Agent ${agent.id} revision ${rev.id}: workspace bootstrapped, native UI 200; same reader session 403 -> 200 -> 403, owner 200; Envoy markers denied=0 granted=present revoked=0 owner=present. Authenticated socket closed after ${elapsed} ms (authorization_denied); reconnect refused before Envoy; owner socket stayed connected.`,
  );

  // The earlier phase proves the shared-cookie/password path. Switch only this
  // disposable installation to guarded OIDC; all native runtime I/O stays real.
  const recoverySession = await api("GET", "/api/auth/session");
  const oidc = await enableInstalledOidcNativeAdmin({
    t,
    cluster,
    stateDirectory,
    kubectl,
    environment,
    recoveryUserId: recoverySession.user.id,
    consoleOrigin,
    agentDomain,
  });
  owner = await signIn(
    "admin@development.openclaw.invalid",
    (await readFile(join(stateDirectory, "initial-admin-password"), "utf8")).trim(),
    true,
  );
  // Account GET requires Origin, which browser fetch cannot set. Dial the
  // owned listener with its CA and hostname; Chromium's trust does not apply to Node.
  const accountResponse = await publishedJSON(
    {
      hostname: consoleHost,
      port: browserPort,
      ca: await readFile(join(stateDirectory, "browser-ca.crt")),
    },
    `/api/auth/accounts/${account.id}`,
    {
      headers: {
        origin: consoleOrigin,
        cookie: (await owner.context().cookies(consoleOrigin))
          .map(({ name, value }) => `${name}=${value}`)
          .join("; "),
      },
    },
  );
  const currentAccount = accountResponse.data;
  await api("POST", `/api/auth/accounts/${account.id}/providers/oidc`, {
    subject: oidc.subject,
    expectedVersion: currentAccount.version,
  });
  await grant(account.principalId, "agent", agent.id, ["administer"]);
  await grant(account.principalId, "namespace", namespaceId, ["read"]);
  const guardedAccess = await api("GET", agentPath + "/native-admin");
  assert.equal(guardedAccess.status, "available");
  assert.equal(guardedAccess.sessionMode, "host-only-exchange");
  assert.equal(guardedAccess.origin, origin);

  const receiptPath =
    process.env.OCC_TEST_NATIVE_BROWSER_RECEIPT ||
    join(await mkdtemp(join(tmpdir(), "oce-native-host-only-real-")), "receipt.json");
  const guarded = await browser.newContext({ serviceWorkers: "block" });
  t.after(() => guarded.close());
  await guarded.route("**/*", (route) =>
    origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort(),
  );
  const received = [];
  const sends = [];
  guarded.on("page", (page) => {
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).origin !== origin.replace("https:", "wss:")) {
        return;
      }
      socket.on("framereceived", (frame) => received.push({ ...frame, page, socket }));
      socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        // Starting a session can submit its first turn in sessions.create;
        // creating an empty session must not count as a submitted turn.
        if (
          frame.type === "req" &&
          (frame.method === "chat.send" ||
            (frame.method === "sessions.create" &&
              typeof frame.params?.message === "string" &&
              frame.params.message.trim().length > 0))
        ) {
          sends.push({ page, socket });
        }
      });
    });
  });
  const consolePage = await guarded.newPage();
  await consolePage.route("https://idp.example.test/authorize*", oidc.authorizeRoute);
  await consolePage.goto(consoleOrigin + "/console/");
  const callback = consolePage.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/auth/providers/oidc/callback",
  );
  await consolePage.getByRole("button", { name: "Continue with Test SSO", exact: true }).click();
  assert.equal((await callback).status(), 302);
  await consolePage.waitForURL(consoleOrigin + "/console/");
  const session = await consoleRequest(consolePage, "GET", "/api/auth/session");
  assert.equal(session.data.user.id, account.id, "OIDC authenticated the attached collaborator");
  const parent = (await guarded.cookies(consoleOrigin)).find(
    (cookie) => cookie.name === oidc.parentCookieName,
  );
  assert.ok(parent?.secure && parent.httpOnly);
  assert.equal(parent.domain, consoleHost, "the guarded parent cookie is host-only");
  await consolePage.goto(
    `${consoleOrigin}/console/agents/${agent.id}?namespace=${namespaceId}&revision=${rev.id}`,
  );

  async function waitFor(description, observe) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const value = await observe();
      if (value) {
        return value;
      }
      await delay(100);
    }
    assert.fail(description);
  }
  async function hello(page, firstFrame = 0) {
    return waitFor("the opened stock Gateway returns hello-ok", () =>
      received.slice(firstFrame).find((frame) => {
        const data = JSON.parse(String(frame.payload));
        return (
          frame.page === page &&
          !frame.socket.isClosed() &&
          data.type === "res" &&
          data.ok === true &&
          data.payload?.type === "hello-ok"
        );
      }),
    );
  }
  async function launch() {
    const popup = consolePage.waitForEvent("popup");
    await consolePage.getByRole("link", { name: "Open Agent UI", exact: true }).click();
    const page = await popup;
    await hello(page);
    await waitForStockUi(page);
    assert.equal(new URL(page.url()).origin, origin);
    assert.equal(await page.evaluate(() => globalThis.opener === null), true);
    return page;
  }
  const first = await launch();
  assert.ok(!(await guarded.cookies(origin)).some((cookie) => cookie.name === parent.name));
  const handle = (await guarded.cookies(origin)).find(
    (cookie) => cookie.name === "__Host-occ_agent_access",
  );
  assert.ok(handle?.secure && handle.httpOnly && handle.sameSite === "Strict");
  assert.equal(handle.domain, host);
  const marker = "host-only-" + randomUUID();
  const terminal = await submitChatTurnWithAssistantProof(first, marker, received, waitFor);
  assert.equal(terminal.page, first);
  assert.ok(!terminal.socket.isClosed());
  const replySelector = `.chat-group.assistant [data-message-text="${marker}"]`;
  await first.locator(replySelector).waitFor({ state: "visible" });
  const conversation = first.url();
  assert.match(new URL(conversation).pathname, /^\/chat\//);
  assert.equal(sends.length, 1, "one real turn was submitted");

  // A repeated exchange for the same binding must preserve the first tab's
  // already-authorized socket through its next renewal.
  const second = await launch();
  const beforeReopen = received.length;
  await second.goto(conversation);
  await waitForStockUi(second);
  const secondHello = await hello(second, beforeReopen);
  assert.notEqual(secondHello.socket, terminal.socket, "each tab owns its Gateway socket");
  await second.locator(replySelector).waitFor({ state: "visible" });
  assert.equal(second.url(), conversation, "the second tab reopened the existing conversation");
  // The production native proxy renews every 25 seconds. Keep both exact
  // sockets untouched for two intervals; reconnects cannot satisfy this check.
  await delay(55_000);
  assert.ok(
    !terminal.socket.isClosed(),
    "the original reply socket survived repeat launch and renewal",
  );
  assert.ok(!secondHello.socket.isClosed(), "the reopened conversation stayed connected");
  assert.equal(sends.length, 1, "reopening never submitted another turn");

  // Sign out through the same Console that launched both windows. Neither
  // native page is navigated or manually closed until both streams are revoked.
  await consolePage.locator(".account-toggle").click();
  const signedOut = consolePage.waitForResponse(
    (res) =>
      res.url() === consoleOrigin + "/api/auth/sign-out" && res.request().method() === "POST",
  );
  const closed = Promise.all([
    terminal.socket.waitForEvent("close", { timeout: 45_000 }),
    secondHello.socket.waitForEvent("close", { timeout: 45_000 }),
  ]);
  await consolePage.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  assert.ok((await signedOut).ok());
  await closed;
  const refused = await second.goto(origin + "/settings/advanced");
  assert.equal(refused.status(), 403, "a revoked parent cannot reuse its native handle");
  assert.equal(sends.length, 1);
  await guarded.close();
  const source = await execute("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname });
  const changes = await execute("git", ["diff", "--name-only", "HEAD"], {
    cwd: import.meta.dirname,
  });
  await writeFile(
    receiptPath,
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        source: source.stdout.trim(),
        trackedChanges: changes.stdout.trim().length > 0,
        releaseRevision: oidc.releaseRevision,
        controllerImage: oidc.controllerImage,
        agentId: agent.id,
        revisionId: rev.id,
        runtimeImagesBeforeUpgrade: native[0].status.containerStatuses.map(({ name, imageID }) => ({
          name,
          imageID,
        })),
        provider: "OIDC protocol fixture; runtime and model are real",
        reopenedSameConversation: true,
        chatSubmissions: sends.length,
        originalReplySocketSurvivedRepeatLaunchAndRenewals: true,
        renewalObservationMs: 55_000,
        distinctSocketsClosedOnParentSignOut: true,
        revokedNativeRequestStatus: refused.status(),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  t.diagnostic(`Guarded native browser receipt: ${receiptPath}`);
  t.diagnostic(
    "Guarded OIDC provider fixture: real host-only browser exchange, Gateway hello and model reply; repeated launch reopened the same conversation without a turn, the original socket survived two renewals, and parent sign-out closed both sockets.",
  );
}
