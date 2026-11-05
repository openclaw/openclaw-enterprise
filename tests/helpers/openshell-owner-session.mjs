// Exercise browser session cookies against the real HTTPS listener and stock Agent UI.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin-host.mjs";
import { chromium } from "playwright";
import { launchTrustingBrowser } from "./dev-up-keycloak.mjs";

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

  async function signIn(email, password) {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", (route) =>
      origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    const loaded = await page.goto(consoleOrigin + "/console/");
    assert.ok(loaded);
    assert.equal((await loaded.serverAddr())?.ipAddress, "127.0.0.1");
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

  const owner = await signIn(
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
}
