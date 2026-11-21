// Exercise browser session cookies against the real HTTPS listener and stock Agent UI.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin-host.ts";
import type { TestContext } from "node:test";
import { chromium, type Page, type Route } from "playwright";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { PermissionAction, ResourceKind } from "../../packages/contracts/src/index.ts";
import {
  AgentDeploymentStatusSchema,
  AgentSchema,
  ConfigurationSchema,
  IAMAccessBindingSchema,
  IAMRoleSchema,
  InstallationSchema,
  WorkspaceFileResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { launchTrustingBrowser, preflightTrustingBrowser } from "./trusted-chromium.ts";

const execute = promisify(execFile);
const developmentAdmin = "admin@development.openclaw.invalid";

// Project only fields this scenario observes, leaving optional product features
// and unconsumed fields to their owning API contracts.
const agentList = Type.Array(
  Type.Pick(AgentSchema, ["name", "id", "namespaceId", "configurationId", "activeRevisionId"]),
);
const installationIdentity = Type.Pick(InstallationSchema, ["id"]);
const deploymentStatus = Type.Pick(AgentDeploymentStatusSchema, ["status"]);
const configurationSnapshot = Type.Object({
  generation: ConfigurationSchema.properties.generation,
  values: Type.Record(Type.String(), Type.Unknown()),
});
const workspaceInstructions = Type.Pick(WorkspaceFileResponse.properties.data, ["content"]);
const roleIdentity = Type.Pick(IAMRoleSchema, ["id"]);
const bindingIdentity = Type.Object({ id: IAMAccessBindingSchema.anyOf[0].properties.id });
const accountIdentity = Type.Object({ id: Type.String(), principalId: Type.String() });
const authenticatedSession = Type.Object({ user: Type.Object({ id: Type.String() }) });
const nativeAccess = Type.Object({
  status: Type.String(),
  origin: Type.Optional(Type.String()),
  sessionMode: Type.Optional(Type.Unknown()),
});
const podList = Type.Object({
  items: Type.Array(
    Type.Object({
      status: Type.Optional(
        Type.Object({
          containerStatuses: Type.Optional(
            Type.Array(Type.Object({ name: Type.String(), ready: Type.Boolean() })),
          ),
        }),
      ),
    }),
  ),
});
const observedPod = Type.Object({
  metadata: Type.Object({
    name: Type.String({ minLength: 1 }),
    namespace: Type.String({ minLength: 1 }),
  }),
  status: Type.Object({
    containerStatuses: Type.Array(
      Type.Object({ name: Type.String(), ready: Type.Boolean(), imageID: Type.String() }),
    ),
  }),
});

function selectReadyAgentPod(value: unknown) {
  assert.ok(Check(podList, value), "Expected a kubectl Pod list with readiness information");
  const readyPods = value.items.filter((pod) =>
    pod.status?.containerStatuses?.some(
      (container) => container.name === "agent" && container.ready,
    ),
  );
  assert.equal(readyPods.length, 1, "Expected exactly one Pod with a ready agent");
  const pod: unknown = readyPods[0];
  assert.ok(Check(observedPod, pod), "Expected metadata and image IDs for the ready Pod");
  assert.ok(
    pod.status.containerStatuses.every(
      ({ name, ready, imageID }) => imageID !== "" || (name !== "agent" && !ready),
    ),
    "Expected image IDs for the agent and ready containers",
  );
  return pod;
}

const gatewayHello = Type.Object({
  type: Type.Literal("res"),
  ok: Type.Literal(true),
  payload: Type.Object({ type: Type.Literal("hello-ok") }),
});

type PasswordSessionInput = {
  t: TestContext;
  cluster: string;
  browserPort: number;
  stateDirectory: string;
  namespaceId: string;
  kubectl: readonly string[];
  environment: NodeJS.ProcessEnv;
};
type ConsoleMethod = "GET" | "POST" | "DELETE";
type ConsoleBody = {
  [field: string]:
    string | number | readonly { action: PermissionAction; resourceKind: ResourceKind }[];
};

export function assertOpenShellOwnerModelSelection(environment: NodeJS.ProcessEnv) {
  const endpoint = environment.OCC_TEST_OPENSHELL_MODEL_BASE_URL?.trim();
  assert.ok(
    !endpoint || URL.parse(endpoint)?.href.replace(/\/$/u, "") === "https://api.openai.com/v1",
    "The browser Agent requires the public OpenAI endpoint",
  );
  assert.ok(
    !environment.OCC_TEST_LOCAL_FIRST_AGENT_NATIVE_PROVIDER_FILE,
    "The browser Agent does not accept native provider overrides",
  );
}

function ownerBrowserRouting(cluster: string) {
  const consoleHost = `console.${cluster}.oce.localhost`;
  const agentDomain = `agents.${cluster}.oce.localhost`;
  return {
    consoleHost,
    agentDomain,
    hosts: [
      { host: consoleHost, address: "127.0.0.1" },
      { host: `*.${agentDomain}`, address: "127.0.0.1" },
      { host: "*", address: "~NOTFOUND" },
    ],
  };
}

export async function preflightOpenShellOwnerBrowser(root: string, cluster: string) {
  try {
    await preflightTrustingBrowser(chromium, root, ownerBrowserRouting(cluster).hosts);
  } catch (error) {
    throw new Error(
      "OpenShell browser preflight failed before dev-up. Check certutil, sandbox support for " +
        "OCC_TEST_BROWSER_EXECUTABLE, and use a short TMPDIR for Chromium sockets.",
      { cause: error },
    );
  }
}

export async function verifyOpenShellOwnerPasswordSession({
  t,
  cluster,
  browserPort,
  stateDirectory,
  namespaceId,
  kubectl,
  environment,
}: PasswordSessionInput) {
  assertOpenShellOwnerModelSelection(environment);
  const { consoleHost, agentDomain, hosts } = ownerBrowserRouting(cluster);
  const consoleOrigin = `https://${consoleHost}:${browserPort}`;
  const scope = `/namespaces/${namespaceId}`;
  // Install the public CA in the fixture browser's private trust database before
  // startup. Chromium verifies both hostnames and manages the HttpOnly cookies.
  const browser = await launchTrustingBrowser(chromium, dirname(stateDirectory), {
    caFiles: [join(stateDirectory, "browser-ca.crt")],
    hosts,
  });
  t.after(() => browser.close());
  const origins = new Set([consoleOrigin]);
  function allowOwnedRequest(route: Route) {
    return origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort();
  }

  async function consoleRequest(
    page: Page,
    method: ConsoleMethod,
    path: string,
    body?: ConsoleBody,
  ) {
    assert.equal(new URL(page.url()).origin, consoleOrigin);
    const { status, json } = await page.evaluate(
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
        const json: unknown = res.ok && res.status !== 204 ? await res.json() : undefined;
        return { status: res.status, json };
      },
      { method, path, body },
    );
    if (status === 204 || status >= 400) {
      return { status, data: undefined };
    }
    assert.ok(
      json && typeof json === "object" && "data" in json,
      "Expected a Console data envelope",
    );
    return { status, data: json.data };
  }

  async function signIn(email: string, password: string, recovery = false) {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", allowOwnedRequest);
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

  async function signInOwner(recovery: boolean) {
    return signIn(
      developmentAdmin,
      (await readFile(join(stateDirectory, "initial-admin-password"), "utf8")).trim(),
      recovery,
    );
  }
  let owner = await signInOwner(false);
  async function openRecoveryPage() {
    owner = await signInOwner(true);
    return owner;
  }
  async function expectOwnerStatus(
    method: ConsoleMethod,
    path: string,
    body?: ConsoleBody,
    status = 200,
  ) {
    const res = await consoleRequest(owner, method, path, body);
    assert.equal(res.status, status, `${method} ${path}`);
    return res;
  }
  async function api<Schema extends TSchema>(
    schema: Schema,
    method: ConsoleMethod,
    path: string,
    body?: ConsoleBody,
    status = 200,
  ): Promise<Static<Schema>> {
    const { data } = await expectOwnerStatus(method, path, body, status);
    assert.ok(Check(schema, data), `Unexpected Console data for ${method} ${path}`);
    return data;
  }
  async function readRecoveryUserId() {
    const { data } = await expectOwnerStatus("GET", "/api/auth/session");
    assert.ok(Check(authenticatedSession, data), "Expected an authenticated Console session");
    return data.user.id;
  }

  // Use the shipped first-Agent entry point, including its own bootstrap settings,
  // deployment checks and real model verification. The rest of the test never
  // needs the model credential or Git repository authority.
  const name = "browser-onboarding";
  const modelEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    OPENCLAW_FIRST_AGENT_MODEL: process.env.OCC_TEST_OPENAI_MODEL,
  };
  // General browser proof uses the API-key path even when CI also supplies a PAT.
  // Dedicated PAT cases retain their account-policy checks separately.
  delete modelEnvironment.CODEX_ACCESS_TOKEN;
  delete modelEnvironment.CODEX_ACCESS_TOKEN_FILE;
  assert.ok(
    modelEnvironment.OPENAI_API_KEY || modelEnvironment.OPENAI_API_KEY_FILE,
    "Set OPENAI_API_KEY or OPENAI_API_KEY_FILE for the real browser Agent",
  );
  assert.ok(
    modelEnvironment.OPENCLAW_FIRST_AGENT_MODEL,
    "Set OCC_TEST_OPENAI_MODEL for the selected account",
  );
  const runFirstAgent = () =>
    execute(
      process.execPath,
      [
        fileURLToPath(new URL("../../scripts/first-agent.ts", import.meta.url)),
        name,
        "--harness",
        "codex",
        "--control-ui",
      ],
      { env: modelEnvironment, timeout: 600_000, maxBuffer: 1024 * 1024 },
    );
  await runFirstAgent();
  async function findFirstAgent() {
    const agents = (await api(agentList, "GET", scope + "/agents")).filter((a) => a.name === name);
    assert.equal(agents.length, 1, "the helper created one Agent in its own default Namespace");
    const [agent] = agents;
    assert.ok(agent);
    return agent;
  }
  const agent = await findFirstAgent();
  const agentPath = scope + "/agents/" + agent.id;
  const revisionId = agent.activeRevisionId;
  assert.ok(revisionId, "first-Agent reported a serving revision");
  const deployment = await api(deploymentStatus, "GET", agentPath + "/deployments/" + revisionId);
  assert.equal(deployment.status, "succeeded");
  const installation = await api(installationIdentity, "GET", "/installation");
  const host = deriveNativeAdminHost(installation.id, agent, agentDomain);
  const origin = `https://${host}:${browserPort}`;
  origins.add(origin);
  async function grant(
    subjectId: string,
    resourceKind: ResourceKind,
    resourceId: string,
    actions: readonly PermissionAction[],
  ) {
    const role = await api(
      roleIdentity,
      "POST",
      scope + "/iam/roles",
      {
        name: "browser-" + actions.join("-"),
        permissions: actions.map((action) => ({ action, resourceKind })),
      },
      201,
    );
    return api(
      bindingIdentity,
      "POST",
      scope + "/iam/access-bindings",
      { subjectKind: "identity", subjectId, roleId: role.id, resourceKind, resourceId },
      201,
    );
  }
  function readNativeAccess(path: string) {
    return api(nativeAccess, "GET", path + "/native-admin");
  }
  const access = await readNativeAccess(agentPath);
  assert.equal(access.origin, origin);
  assert.equal(access.status, "available");
  // A second invocation must recognize the current saved template and frozen
  // revision, complete its real model check, and leave their configuration intact.
  const configurationPath = scope + "/configurations/" + agent.configurationId;
  const beforeRepeat = await api(configurationSnapshot, "GET", configurationPath);
  await runFirstAgent();
  const repeatedAgent = await findFirstAgent();
  assert.equal(repeatedAgent.id, agent.id);
  assert.equal(repeatedAgent.activeRevisionId, revisionId);
  const afterRepeat = await api(configurationSnapshot, "GET", configurationPath);
  assert.equal(afterRepeat.generation, beforeRepeat.generation);
  assert.deepEqual(afterRepeat.values, beforeRepeat.values);
  const instructions = await api(
    workspaceInstructions,
    "GET",
    agentPath + "/workspace/files/AGENTS.md",
  );
  assert.ok(instructions.content.trim(), "fresh workspace has its real bootstrap instructions");
  const { stdout: pods } = await execute(
    "kubectl",
    [
      ...kubectl,
      "get",
      "pod",
      "-A",
      "-l",
      `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${revisionId}`,
      "-o",
      "json",
    ],
    { env: environment },
  );
  const pod = selectReadyAgentPod(JSON.parse(pods));
  await execute(
    "kubectl",
    [
      ...kubectl,
      "-n",
      pod.metadata.namespace,
      "exec",
      pod.metadata.name,
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
    accountIdentity,
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
  async function navigate(page: Page, marker: string, status: number) {
    const response = await page.goto(origin + "/settings/advanced?probe=" + marker, {
      waitUntil: "domcontentloaded",
    });
    assert.ok(response);
    assert.equal(response.status(), status);
    assert.equal((await response.serverAddr())?.ipAddress, "127.0.0.1");
    if (status === 200) {
      assert.ok(
        await page.locator("html").getAttribute("data-openclaw-bootstrap-config"),
        "stock UI bootstrap present",
      );
    }
  }
  async function connectedTab(person: Page, marker: string) {
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
            const frame: unknown = JSON.parse(String(payload));
            if (frame === null) {
              throw new TypeError("Expected a native Gateway frame");
            }
            return Check(gatewayHello, frame);
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
    expectOwnerStatus("DELETE", scope + "/iam/access-bindings/" + binding.id, undefined, 204),
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
      new Promise<boolean>((resolve, reject: (reason: Error) => void) => {
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
    const stdin = audit.child.stdin;
    assert.ok(stdin);
    stdin.end(`SELECT EXISTS (SELECT 1 FROM occ.audit_events opened JOIN occ.audit_events closed
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
  let observedLogs: string | undefined;
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
      observedLogs = logs;
      break;
    }
    await delay(500);
  }
  assert.ok(
    observedLogs,
    "both authorized requests must be observable at the private Gateway route",
  );
  assert.ok(
    !observedLogs.includes(denied) &&
      !observedLogs.includes(revoked) &&
      !observedLogs.includes(reconnect),
    "denied requests must not reach private Gateway routing",
  );
  t.diagnostic(
    `Agent ${agent.id} revision ${revisionId}: workspace bootstrapped, native UI 200; same reader session 403 -> 200 -> 403, owner 200; Envoy markers denied=0 granted=present revoked=0 owner=present. Authenticated socket closed after ${elapsed} ms (authorization_denied); reconnect refused before Envoy; owner socket stayed connected.`,
  );

  return {
    browser,
    consoleHost,
    consoleOrigin,
    agentDomain,
    host,
    origin,
    agent,
    agentPath,
    rev: { id: revisionId },
    account,
    recoveryUserId: await readRecoveryUserId(),
    runtimeImagesBeforeUpgrade: pod.status.containerStatuses.map(({ name, imageID }) => ({
      name,
      imageID,
    })),
    allowOwnedRequest,
    openRecoveryPage,
    expectOwnerStatus,
    grant,
    consoleRequest,
    readNativeAccess,
  };
}
