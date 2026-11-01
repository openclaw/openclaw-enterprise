// Exercise browser session cookies against the real HTTPS listener and stock Agent UI.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin-host.mjs";
import { cookieHeaderFromSetCookie } from "../../packages/utils/src/index.ts";

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
  const ca = await readFile(join(stateDirectory, "browser-ca.crt"));
  const consoleHost = `console.${cluster}.oce.localhost`;
  const scope = `/namespaces/${namespaceId}`;
  // The TCP destination and port come from the test, never from the on-disk state.
  // The Host header and TLS SNI still exercise the two distinct browser origins.
  function visit(host, path, { method = "GET", cookie, body } = {}) {
    const authority = `${host}:${browserPort}`;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          agent: false,
          port: browserPort,
          servername: host,
          ca,
          method,
          path,
          signal: AbortSignal.timeout(30_000),
          headers: {
            host: authority,
            origin: `https://${authority}`,
            ...(cookie && { cookie }),
            ...(body && { "content-type": "application/json" }),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("error", reject);
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode, text, cookies: res.headers["set-cookie"] }),
          );
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function signIn(email, password) {
    const res = await visit(consoleHost, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(res.status, 200, "real password sign-in");
    const cookie = cookieHeaderFromSetCookie(res.cookies);
    assert.ok(cookie, "sign-in returned a session cookie");
    return cookie;
  }
  const signedOut = await visit(consoleHost, "/api/auth/session");
  assert.equal(signedOut.status, 200);
  assert.equal(JSON.parse(signedOut.text).data, null);
  const owner = await signIn(
    "admin@development.openclaw.invalid",
    (await readFile(join(stateDirectory, "initial-admin-password"), "utf8")).trim(),
  );
  async function api(method, path, body, status = 200) {
    const res = await visit(consoleHost, path, { method, body, cookie: owner });
    assert.equal(res.status, status, `${method} ${path}: ${res.status}`);
    return res.text ? JSON.parse(res.text).data : undefined;
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
  const host = deriveNativeAdminHost(installation.id, agent, `agents.${cluster}.oce.localhost`);
  const origin = `https://${host}:${browserPort}`;
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
  const probe = (cookie, id) => visit(host, "/settings/advanced?probe=" + id, { cookie });
  assert.equal((await visit(consoleHost, agentPath, { cookie: collaborator })).status, 200);
  assert.equal((await probe(collaborator, denied)).status, 403);
  const binding = await grant(account.principalId, "agent", agent.id, ["administer"]);
  const admitted = await probe(collaborator, allowed);
  assert.equal(admitted.status, 200);
  assert.ok(
    admitted.text.includes("data-openclaw-bootstrap-config="),
    "stock UI HTML contains its Gateway bootstrap configuration",
  );
  await api("DELETE", scope + "/iam/access-bindings/" + binding.id, undefined, 204);
  assert.equal((await probe(collaborator, revoked)).status, 403);
  assert.equal(
    (await visit(consoleHost, agentPath, { cookie: collaborator })).status,
    200,
    "the same signed-in session retains Agent read",
  );
  assert.equal((await probe(owner, barrier)).status, 200, "owner access continues");
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
        !logs.includes(denied) && !logs.includes(revoked),
        "denied requests must not reach private Gateway routing",
      );
      reached = true;
      break;
    }
    await delay(500);
  }
  assert.ok(reached, "both authorized requests must be observable at the private Gateway route");
  t.diagnostic(
    `Agent ${agent.id} revision ${rev.id}: workspace bootstrapped, native UI 200; same reader session 403 -> 200 -> 403, owner 200; Envoy markers denied=0 granted=present revoked=0 owner=present.`,
  );
}
