import { submitChatTurnWithAssistantProof, textFromFrame, waitForStockUi } from "../helpers/native-ui-chat.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { chromium } from "playwright";

import { nativeAdminTarget } from "../../apps/controller/src/gateway/native-admin.ts";
import {
  arrangeProductionTopology,
  assertActualModelTurn,
  kubectl,
  requiresNativeAdminRouting,
  resource,
  waitFor,
  waitForReadyGatewayPod,
} from "../helpers/harness-topology-k3d-real.mjs";
import { ADMINISTRATOR_RUNTIME_ROLE } from "../../packages/contracts/src/index.ts";
import { nativeRolesGateway } from "../helpers/runtime-roles.mjs";

const executeFile = promisify(execFile);

function hostSuffixPattern(domain) {
  return new RegExp(`\\.${domain.replaceAll(".", "\\.")}$`);
}

function expectedNativeAdminTarget(topology, publicOrigin, domain) {
  assert.ok(topology.installation?.id, "native admin target derivation requires Installation id");
  return nativeAdminTarget({
    publicOrigin,
    installationId: topology.installation.id,
    agent: topology.agent,
    revision: topology.revision,
    domain,
  });
}

async function createNativeIngress(context, { artifacts, nativeDomain }) {
  const publicHost = `oce-native.${nativeDomain}`;
  const certificate = await createLocalCertificate({ artifacts, nativeDomain, publicHost });
  // Trust only this disposable ingress certificate. Chromium can loop on
  // certificate-error retries for stylesheets with context ignoreHTTPSErrors.
  const certificateSpki = createHash("sha256")
    .update(new X509Certificate(certificate.cert).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  let upstream;
  const sockets = new Set();
  const trackSocket = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createHttpsServer(certificate, (request, response) => {
    if (upstream === undefined) {
      response.writeHead(503).end("native admin ingress upstream not ready");
      return;
    }
    proxyHttpRequest(upstream, request, response);
  });
  server.on("connection", trackSocket);
  server.on("upgrade", (request, socket, head) => {
    trackSocket(socket);
    if (upstream === undefined) {
      socket.destroy();
      return;
    }
    proxyUpgrade(upstream, request, socket, head, trackSocket);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  context.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return {
    origin: `https://${publicHost}:${address.port}`,
    browserArgs: [
      `--host-resolver-rules=MAP ${publicHost} 127.0.0.1,MAP *.${nativeDomain} 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${certificateSpki}`,
    ],
    setUpstream(url) {
      upstream = new URL(url);
      assert.equal(
        upstream.protocol,
        "http:",
        "local native ingress expects controller HTTP port-forward",
      );
    },
  };
}

async function createLocalCertificate({ artifacts, nativeDomain, publicHost }) {
  const keyPath = join(artifacts, "native-ingress.key");
  const certPath = join(artifacts, "native-ingress.crt");
  const configPath = join(artifacts, "native-ingress-openssl.cnf");
  await writeFile(
    configPath,
    `[req]\n` +
      `prompt = no\n` +
      `distinguished_name = dn\n` +
      `x509_extensions = v3_req\n` +
      `[dn]\n` +
      `CN = ${publicHost}\n` +
      `[v3_req]\n` +
      `subjectAltName = @alt_names\n` +
      `[alt_names]\n` +
      `DNS.1 = ${publicHost}\n` +
      `DNS.2 = *.${nativeDomain}\n`,
  );
  await executeFile("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-sha256",
    "-config",
    configPath,
  ]);
  return { key: await readFile(keyPath, "utf8"), cert: await readFile(certPath, "utf8") };
}

function proxyHttpRequest(upstream, incoming, outgoing) {
  const request = httpRequest(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  request.on("error", (error) => {
    outgoing.writeHead(502).end(String(error?.message ?? error));
  });
  incoming.pipe(request);
}

function proxyUpgrade(upstream, request, socket, head, trackSocket) {
  const upstreamSocket = trackSocket(
    connectTcp(Number(upstream.port), upstream.hostname, () => {
      upstreamSocket.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) {
            upstreamSocket.write(`${name}: ${entry}\r\n`);
          }
        } else if (value !== undefined) {
          upstreamSocket.write(`${name}: ${value}\r\n`);
        }
      }
      upstreamSocket.write("\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    }),
  );
  upstreamSocket.on("error", () => socket.destroy());
  socket.on("error", () => upstreamSocket.destroy());
}

async function launchBrowser(context, ingress) {
  const browserExecutable =
    process.env.OCC_TEST_BROWSER_EXECUTABLE === undefined ||
    process.env.OCC_TEST_BROWSER_EXECUTABLE.length === 0
      ? undefined
      : process.env.OCC_TEST_BROWSER_EXECUTABLE;
  const browser = await chromium.launch({
    ...(browserExecutable === undefined ? {} : { executablePath: browserExecutable }),
    args: ingress.browserArgs,
    headless: true,
  });
  context.after(() => browser.close());
  return browser;
}

async function login(page, origin, credentials, path) {
  await page.goto(new URL(path, origin).href);
  await page.getByLabel("Username").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL(/\/console\//);
}

function agentDetailPath(topology) {
  const path = new URL(`/console/agents/${topology.agent.id}`, "https://example.invalid");
  path.searchParams.set("namespace", topology.agent.namespaceId);
  path.searchParams.set("revision", topology.revision.id);
  path.searchParams.set("tab", "workspace");
  return `${path.pathname}${path.search}`;
}

async function nativeAdminStatus(topology) {
  const status = await topology.adminRequest(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/native-admin`,
  );
  assert.equal(status.status, 200, JSON.stringify(status.error));
  return status.data;
}

async function readOceControlState(topology) {
  const [agent, configuration] = await Promise.all([
    topology.request(
      "GET",
      `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
    ),
    topology.request(
      "GET",
      `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
    ),
  ]);
  assert.equal(agent.status, 200, JSON.stringify(agent.error));
  assert.equal(configuration.status, 200, JSON.stringify(configuration.error));
  return {
    activeRevisionId: agent.data.activeRevisionId,
    revisionId: topology.revision.id,
    configuration: configuration.data,
  };
}

async function redeployWithNativeAdminAccess(
  topology,
  publicOrigin,
  nativeDomain,
  { configuredRoles = true } = {},
) {
  const targetForStableOrigin = expectedNativeAdminTarget(topology, publicOrigin, nativeDomain);
  const current = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
  );
  assert.equal(current.status, 200, JSON.stringify(current.error));
  const values = nativeRolesGateway(current.data.values, targetForStableOrigin.origin);
  if (!configuredRoles) {
    delete values.gateway.roles;
    const proxy = values.gateway.auth.trustedProxy;
    delete proxy.roleHeader;
    delete proxy.rolePolicyHashHeader;
    delete proxy.managedIdentityPrefixes;
    delete proxy.managedIdentities;
    proxy.allowUsers = ["occ-workspace-files"];
  }
  const patched = await topology.request(
    "PATCH",
    `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
    {
      values,
      ...(current.data.secretBindings === undefined
        ? {}
        : { secretBindings: current.data.secretBindings }),
    },
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.error));
  const identity = await topology.observerPool.query(
    `SELECT identity.id FROM occ.iam_identities identity
    JOIN occ."user" account ON identity.subject = account.id
    WHERE identity.kind = 'principal' AND account.email = $1`,
    [topology.credentials.email],
  );
  assert.equal(identity.rowCount, 1);
  const policyPath = `/namespaces/${topology.agent.namespaceId}/iam`;
  const bindings = await topology.adminRequest("GET", `${policyPath}/access-bindings`);
  assert.equal(bindings.status, 200);
  if (
    !bindings.data.some(
      (binding) =>
        binding.subjectId === identity.rows[0].id &&
        binding.resourceId === topology.agent.id &&
        binding.runtimeRole !== undefined,
    )
  ) {
    const role = await topology.adminRequest("POST", `${policyPath}/roles`, {
      permissions: [{ action: "use", resourceKind: "agent" }],
    });
    assert.equal(role.status, 201);
    const assignment = await topology.adminRequest("POST", `${policyPath}/access-bindings`, {
      subjectKind: "identity",
      subjectId: identity.rows[0].id,
      roleId: role.data.id,
      resourceKind: "agent",
      resourceId: topology.agent.id,
      runtimeRole: ADMINISTRATOR_RUNTIME_ROLE,
      runtimeRoleConfiguration: (
        await topology.adminRequest(
          "GET",
          `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/runtime-roles`,
        )
      ).data.configuration,
    });
    assert.equal(assignment.status, 201, JSON.stringify(assignment.error));
  }
  const previousGatewayUid = topology.gatewayPod.metadata.uid;
  const deployed = await topology.request(
    "POST",
    `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/deploy`,
  );
  assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
  await waitFor(`native-admin revision ${deployed.data.id} activation`, async () => {
    const observed = await topology.request(
      "GET",
      `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}`,
    );
    assert.equal(observed.status, 200);
    return observed.data.activeRevisionId === deployed.data.id ? observed.data : undefined;
  });
  try {
    await waitFor(`worker completion of native-admin revision ${deployed.data.id}`, () =>
      topology.events.find(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === deployed.data.id &&
          event.outcome === "success",
      ),
    );
  } catch (cause) {
    const events = topology.events
      .filter((event) => event.revisionId === deployed.data.id)
      .slice(-8)
      .map(({ event, code, outcome, revisionId }) => ({ event, code, outcome, revisionId }));
    throw new Error(`Native admin revision did not finish: ${JSON.stringify(events)}`, { cause });
  }
  topology.revision = deployed.data;
  topology.gatewayPod = await waitForReadyGatewayPod(
    topology,
    topology.revision.id,
    previousGatewayUid,
  );
  return expectedNativeAdminTarget(topology, publicOrigin, nativeDomain);
}

async function assertNoNativeCredentialLeak(page, protectedValues) {
  const html = await page.locator("body").innerText({ timeout: 30_000 });
  for (const value of protectedValues.filter(Boolean)) {
    assert.equal(html.includes(value), false, "native browser output must not expose credentials");
  }
}

async function nativeRequest(page, method, params = {}) {
  // Use the shipped UI's current Gateway client, including its real device handshake.
  // No replacement transport or alternate credential may bypass the person's role.
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector("openclaw-app-shell")?.context?.gateway.snapshot.phase ===
      "connected",
    undefined,
    { timeout: 60_000 },
  );
  return page.evaluate(
    async ({ method, params }) => {
      const client =
        globalThis.document.querySelector("openclaw-app-shell").context.gateway.snapshot.client;
      try {
        return { ok: true, payload: await client.request(method, params) };
      } catch (error) {
        return {
          ok: false,
          error: { code: error.gatewayCode, message: error.message, details: error.details },
        };
      }
    },
    { method, params },
  );
}

function assertMissingNativeScope(result, scope) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "FORBIDDEN");
  assert.equal(result.error.details?.missingScope, scope);
}

async function assertServiceWorkerRegistrationBlockedByCsp(page) {
  const result = await page.evaluate(async () => {
    try {
      await globalThis.navigator.serviceWorker.register("/native-admin-proof-worker.js");
      return {
        ok: true,
        registrations: (await globalThis.navigator.serviceWorker.getRegistrations()).map(
          (registration) => registration.scope,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        name: error?.name,
        message: error?.message,
        registrations: (await globalThis.navigator.serviceWorker.getRegistrations()).map(
          (registration) => registration.scope,
        ),
      };
    }
  });
  assert.equal(
    result.ok,
    false,
    `native admin service worker registration must reject: ${JSON.stringify(result)}`,
  );
  assert.equal(result.name, "SecurityError", JSON.stringify(result));
  assert.match(result.message ?? "", /Content Security Policy|worker-src|policy/i);
  assert.deepEqual(result.registrations, [], "native admin must not install a ServiceWorker");
}

async function completeNativeLaunch(nativePage, { nativeOrigin }) {
  await nativePage.waitForLoadState("domcontentloaded");
  assert.equal(await nativePage.evaluate(() => globalThis.window.opener === null), true);
  await nativePage.waitForURL((url) => url.origin === nativeOrigin && url.pathname === "/", {
    timeout: 120_000,
  });
  await waitForStockUi(nativePage);
}

async function openRawEditor(page, nativeOrigin) {
  await page.goto(new URL("/settings/advanced", nativeOrigin).href);
  await waitForStockUi(page);
  await page.locator(".page-title").getByText("Advanced", { exact: true }).waitFor({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  const rawField = page.locator(".config-raw-field").first();
  await rawField.waitFor({ state: "visible", timeout: 60_000 });
  const editor = rawField.locator("textarea").first();
  if (!(await editor.isVisible())) {
    await rawField
      .getByRole("button", { name: "Toggle raw config redaction", exact: true })
      .click();
  }
  await editor.waitFor({ state: "visible", timeout: 60_000 });
  return editor;
}

function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function configAccent(config) {
  const accent = config?.ui?.prefs?.accent;
  return typeof accent === "string" ? accent : null;
}

async function saveRawEditor(page) {
  const saveButton = page.locator(".config-raw-actions button.primary").first();
  await saveButton.click();
  await waitFor("raw config save completion", async () => {
    const busy = await saveButton.getAttribute("aria-busy");
    return busy !== "true" && (await saveButton.isDisabled()) ? true : undefined;
  });
}

async function readRawConfig(page, nativeOrigin) {
  const editor = await openRawEditor(page, nativeOrigin);
  const raw = await editor.inputValue();
  return { editor, raw, parsed: JSON.parse(raw) };
}

async function assertReversibleNativeConfigEdit(page, nativeOrigin) {
  const proofColor = `#${randomUUID().replaceAll("-", "").slice(0, 6)}`;
  const { editor, raw: originalRaw, parsed: original } = await readRawConfig(page, nativeOrigin);
  const changed = structuredClone(original);
  changed.ui = {
    ...(changed.ui ?? {}),
    prefs: { ...(changed.ui?.prefs ?? {}), accent: proofColor },
  };
  let restoreNeeded = false;
  try {
    await editor.fill(serializeConfig(changed));
    restoreNeeded = true;
    await saveRawEditor(page);
    const afterSave = await readRawConfig(page, nativeOrigin);
    assert.equal(configAccent(afterSave.parsed), proofColor);
  } finally {
    if (restoreNeeded) {
      const restore = await openRawEditor(page, nativeOrigin);
      await restore.fill(originalRaw);
      await saveRawEditor(page);
      const restored = await readRawConfig(page, nativeOrigin);
      // Stock config writes can stamp native version metadata. Verify the user
      // preference was restored; OCC state is compared in full by the caller.
      assert.equal(configAccent(restored.parsed), configAccent(original));
    }
  }
}

async function leaveNativeAccentDrift(page, nativeOrigin) {
  const driftAccent = `#${randomUUID().replaceAll("-", "").slice(0, 6)}`;
  const { editor, parsed } = await readRawConfig(page, nativeOrigin);
  const drifted = structuredClone(parsed);
  drifted.ui = {
    ...(drifted.ui ?? {}),
    prefs: { ...(drifted.ui?.prefs ?? {}), accent: driftAccent },
  };
  await editor.fill(serializeConfig(drifted));
  await saveRawEditor(page);
  const afterSave = await readRawConfig(page, nativeOrigin);
  assert.equal(configAccent(afterSave.parsed), driftAccent);
  return driftAccent;
}

async function readRuntimeAccent(topology) {
  const raw = await kubectl(
    "exec",
    topology.gatewayPod.metadata.name,
    "--namespace",
    topology.gatewayPlacement,
    "--",
    "node",
    "-e",
    "const fs=require('node:fs');const path=process.env.OPENCLAW_CONFIG_PATH||'/home/node/.openclaw/openclaw.json';const config=JSON.parse(fs.readFileSync(path,'utf8'));const accent=config?.ui?.prefs?.accent;if(accent!==undefined&&typeof accent!=='string')process.exit(2);process.stdout.write(JSON.stringify(accent??null));",
  );
  return JSON.parse(raw);
}

function agentPath(topology, suffix = "") {
  return `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}${suffix}`;
}

function workspaceFilePath(topology, name) {
  return agentPath(topology, `/workspace/files/${name}`);
}

async function assertStopRedeployPreservesWorkspaceFile(
  topology,
  { expectedManagedAccent, forbiddenRuntimeAccent },
) {
  const filename = "AGENTS.md";
  const content = `Native admin drift recovery proof ${randomUUID()}.\n`;
  const previousRevisionId = topology.revision.id;
  const previousGatewayUid = topology.gatewayPod.metadata.uid;
  const workspacePath = workspaceFilePath(topology, filename);

  const written = await topology.workspaceRequest("PUT", workspacePath, { content });
  assert.equal(written.status, 200, JSON.stringify(written.error));
  assert.deepEqual(written.data, { name: filename, size: Buffer.byteLength(content, "utf8") });

  const beforeStop = await topology.workspaceRequest("GET", workspacePath);
  assert.equal(beforeStop.status, 200, JSON.stringify(beforeStop.error));
  assert.deepEqual(beforeStop.data, { name: filename, content });

  const stopEventStart = topology.events.length;
  const stopped = await topology.request("POST", agentPath(topology, "/stop"));
  assert.equal(stopped.status, 202, JSON.stringify(stopped.error));
  assert.equal(stopped.data.desiredRuntimeState, "stopped");
  topology.agent = { ...topology.agent, ...stopped.data };

  await waitFor("worker completion of native-admin stop", () =>
    topology.events
      .slice(stopEventStart)
      .find(
        (event) =>
          event.event === "worker.completed" &&
          event.agentId === topology.agent.id &&
          event.outcome === "success",
      ),
  );
  const stoppedAgent = await topology.request("GET", agentPath(topology));
  assert.equal(stoppedAgent.status, 200, JSON.stringify(stoppedAgent.error));
  assert.equal(stoppedAgent.data.desiredRuntimeState, "stopped");
  topology.agent = { ...topology.agent, ...stoppedAgent.data };

  // A real worker has cleared the active revision; role editing must not need a live runtime.
  const catalog = await topology.adminRequest("GET", agentPath(topology, "/runtime-roles"));
  assert.equal(catalog.status, 200, JSON.stringify(catalog.error));
  assert.equal(catalog.data.activeRevision, undefined);
  const policyPath = `/namespaces/${topology.agent.namespaceId}/iam/access-bindings`;
  const bindings = await topology.adminRequest("GET", policyPath);
  const assignment = bindings.data.find(
    (binding) =>
      binding.resourceId === topology.agent.id &&
      binding.runtimeRole === ADMINISTRATOR_RUNTIME_ROLE,
  );
  assert.ok(assignment);
  const changed = await topology.adminRequest(
    "PATCH",
    `${policyPath}/${assignment.id}/runtime-role`,
    {
      runtimeRole: ADMINISTRATOR_RUNTIME_ROLE,
      runtimeRoleConfiguration: catalog.data.configuration,
    },
  );
  assert.equal(changed.status, 200, JSON.stringify(changed.error));
  assert.equal(changed.data.id, assignment.id);

  const stoppedRead = await topology.workspaceRequest("GET", workspacePath);
  assert.notEqual(
    stoppedRead.status,
    200,
    "stopped Agent workspace files must not masquerade as an active native workspace",
  );

  const deployEventStart = topology.events.length;
  const redeployed = await topology.request("POST", agentPath(topology, "/deploy"));
  assert.equal(redeployed.status, 202, JSON.stringify(redeployed.error));
  assert.notEqual(
    redeployed.data.id,
    previousRevisionId,
    "redeploy after stop must create a fresh active revision",
  );

  const runningAgent = await waitFor(
    `native-admin drift revision ${redeployed.data.id} activation`,
    async () => {
      const observed = await topology.request("GET", agentPath(topology));
      assert.equal(observed.status, 200, JSON.stringify(observed.error));
      return observed.data.activeRevisionId === redeployed.data.id &&
        observed.data.desiredRuntimeState === "running"
        ? observed.data
        : undefined;
    },
  );
  await waitFor(`worker completion of native-admin drift revision ${redeployed.data.id}`, () =>
    topology.events
      .slice(deployEventStart)
      .find(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === redeployed.data.id &&
          event.outcome === "success",
      ),
  );
  topology.agent = { ...topology.agent, ...runningAgent };
  topology.revision = redeployed.data;
  topology.gatewayPod = await waitForReadyGatewayPod(
    topology,
    topology.revision.id,
    previousGatewayUid,
  );
  if (typeof topology.refreshGatewayUrl === "function") {
    topology.gatewayUrl = await topology.refreshGatewayUrl();
  }
  const runtimeAccent = await readRuntimeAccent(topology);
  assert.equal(
    runtimeAccent,
    expectedManagedAccent,
    "OCE redeploy must restore the managed runtime config after native admin drift",
  );
  assert.notEqual(
    runtimeAccent,
    forbiddenRuntimeAccent,
    "OCE redeploy must not preserve native admin config drift",
  );

  const afterRedeploy = await topology.workspaceRequest("GET", workspacePath);
  assert.equal(afterRedeploy.status, 200, JSON.stringify(afterRedeploy.error));
  assert.deepEqual(afterRedeploy.data, { name: filename, content });
}

async function assertNativeAdminAudit(topology) {
  const expectedActions = [
    "openclaw.agents.native_admin.websocket.connect",
    "openclaw.agents.native_admin.websocket.close",
  ];
  const actions = await waitFor("human-attributable native admin audit events", async () => {
    const result = await topology.observerPool.query(
      `SELECT action, actor_id, outcome, details->'__occAuditMetadata'->'actor' AS actor
       FROM occ.audit_events
       WHERE namespace_id = $1
         AND resource_kind = 'agent'
         AND resource_id = $2
         AND action = ANY($3::text[])
       ORDER BY occurred_at, id`,
      [topology.agent.namespaceId, topology.agent.id, expectedActions],
    );
    const found = new Map(result.rows.map((row) => [row.action, row]));
    return expectedActions.every((action) => found.has(action)) ? found : undefined;
  });
  for (const [action, row] of actions) {
    assert.equal(row.outcome, "success", `${action} audit outcome`);
    assert.ok(row.actor_id, `${action} audit must retain a human actor id`);
    assert.equal(row.actor?.principalId, row.actor_id, `${action} audit actor metadata`);
  }
}

async function assertSharedNativeSessions(context, { topology, browser, ingress, status }) {
  // Enrollment is a precondition: this existing Role permits Installation discovery,
  // but no Namespace or Agent access. Sharing itself uses ordinary policy APIs.
  const readerRoleId = `role-native-reader-${randomUUID()}`;
  await topology.observerPool.query(
    "INSERT INTO occ.iam_roles (id, name, permissions) VALUES ($1, $2, $3)",
    [
      readerRoleId,
      "Installation reader",
      JSON.stringify([{ action: "read", resourceKind: "installation" }]),
    ],
  );
  const namespacePath = `/namespaces/${topology.agent.namespaceId}`;
  const policyPath = `${namespacePath}/iam`;
  const roles = [];
  for (const [name, permissions] of [
    ["Namespace discovery", [{ action: "read", resourceKind: "namespace" }]],
    [
      "Shared native entry",
      [
        { action: "read", resourceKind: "agent" },
        { action: "use", resourceKind: "agent" },
      ],
    ],
  ]) {
    const role = await topology.adminRequest("POST", `${policyPath}/roles`, { name, permissions });
    assert.equal(role.status, 201);
    roles.push(role.data);
  }
  const sibling = await topology.adminRequest("POST", `${namespacePath}/agents`, {
    name: `private-sibling-${randomUUID()}`,
    configurationId: topology.agent.configurationId,
  });
  assert.equal(sibling.status, 201);
  const workspacePath = `${namespacePath}/agents/${topology.agent.id}/workspace/files/USER.md`;
  const workspaceContent = `Native role isolation proof ${randomUUID()}.\n`;
  const written = await topology.workspaceRequest("PUT", workspacePath, {
    content: workspaceContent,
  });
  assert.equal(written.status, 200, JSON.stringify(written.error));
  const people = [];
  for (const label of ["withdrawn", "unaffected"]) {
    const credentials = {
      email: `native-${label}-${randomUUID()}@example.test`,
      password: `native-sharing-${randomUUID()}`,
    };
    const account = await topology.adminRequest("POST", "/api/auth/accounts", {
      ...credentials,
      name: label,
      roleId: readerRoleId,
    });
    assert.equal(account.status, 201);
    let agentBinding;
    for (const [resourceKind, resourceId, roleId] of [
      ["namespace", topology.agent.namespaceId, roles[0].id],
      ["agent", topology.agent.id, roles[1].id],
    ]) {
      const binding = await topology.adminRequest("POST", `${policyPath}/access-bindings`, {
        subjectKind: "identity",
        subjectId: account.data.principalId,
        resourceKind,
        resourceId,
        roleId,
        ...(resourceKind === "agent"
          ? {
              runtimeRole: label === "withdrawn" ? "researcher" : "administrator",
              runtimeRoleConfiguration: (
                await topology.adminRequest(
                  "GET",
                  `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/runtime-roles`,
                )
              ).data.configuration,
            }
          : {}),
      });
      assert.equal(binding.status, 201);
      if (resourceKind === "agent") {
        agentBinding = binding.data;
      }
    }
    const personContext = await browser.newContext();
    context.after(() => personContext.close());
    const frames = [];
    const sockets = [];
    personContext.on("page", (observedPage) =>
      observedPage.on("websocket", (socket) => {
        if (new URL(socket.url()).origin === status.origin.replace(/^http/, "ws")) {
          sockets.push(socket);
          socket.on("framereceived", (frame) => frames.push({ ...frame, socket }));
        }
      }),
    );
    const page = await personContext.newPage();
    await login(page, ingress.origin, credentials, agentDetailPath(topology));
    // Login keeps the Console URL while its cookie request is pending. Observe
    // the authenticated Agent render before sending requests as this person.
    await page.getByRole("heading", { name: topology.agent.name, exact: true }).waitFor();
    const request = (path) =>
      page.evaluate(async (pathname) => {
        const response = await fetch(pathname);
        return { status: response.status, body: await response.json() };
      }, path);
    const listed = await request(`${namespacePath}/agents`);
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.data.map(({ id }) => id),
      [topology.agent.id],
    );
    for (const path of [
      `${namespacePath}/agents/${sibling.data.id}`,
      `${namespacePath}/configurations/${topology.agent.configurationId}`,
      `${policyPath}/roles`,
    ]) {
      assert.equal((await request(path)).status, 403);
    }
    // Configuration remains denied, but the exact Agent-use assignment must still launch
    // the regular native UI. A fixture URL must not stand in for the Console link.
    const popup = page.waitForEvent("popup");
    await page.getByRole("link", { name: "Open OpenClaw" }).click();
    const nativePage = await popup;
    await completeNativeLaunch(nativePage, { nativeOrigin: status.origin });
    const terminalFrame = await submitChatTurnWithAssistantProof(
      nativePage,
      `sharing-${label}-${randomUUID()}`,
      frames,
      waitFor,
    );
    // Bind withdrawal to the connection that delivered the real assistant reply.
    // Records from previous page navigations do not establish a current stream.
    const socket = terminalFrame.socket;
    assert.ok(socket && !socket.isClosed(), "recipient has a confirmed active native stream");
    const sessionKey = JSON.parse(textFromFrame(terminalFrame)).payload.sessionKey;
    assert.equal(typeof sessionKey, "string");
    assert.match(sessionKey, /^agent:main:/);
    const self = await nativeRequest(nativePage, "users.self");
    assert.equal(self.ok, true, JSON.stringify(self));
    assert.ok(self.payload.profile.id, "native entry resolves a canonical person profile");
    people.push({
      request,
      nativePage,
      frames,
      socket,
      sockets,
      sessionKey,
      profileId: self.payload.profile.id,
      agentBinding,
      principalId: account.data.principalId,
    });
  }
  const [withdrawn, unaffected] = people;
  assert.notEqual(withdrawn.profileId, unaffected.profileId);
  const ownLabel = `researcher-owned-${randomUUID()}`;
  const patched = await nativeRequest(withdrawn.nativePage, "sessions.patch", {
    key: withdrawn.sessionKey,
    label: ownLabel,
  });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  const ownSession = await nativeRequest(withdrawn.nativePage, "sessions.describe", {
    key: withdrawn.sessionKey,
  });
  assert.equal(ownSession.ok, true, JSON.stringify(ownSession));
  assert.equal(ownSession.payload.session.label, ownLabel);
  const adminApprovals = await nativeRequest(unaffected.nativePage, "exec.approvals.get");
  assert.equal(adminApprovals.ok, true, JSON.stringify(adminApprovals));
  assertMissingNativeScope(
    await nativeRequest(withdrawn.nativePage, "exec.approvals.get"),
    "operator.admin",
  );
  const otherSession = await nativeRequest(unaffected.nativePage, "sessions.describe", {
    key: unaffected.sessionKey,
  });
  assert.equal(otherSession.ok, true, JSON.stringify(otherSession));
  assert.equal(otherSession.payload.session.key, unaffected.sessionKey);
  const hiddenSession = await nativeRequest(withdrawn.nativePage, "sessions.describe", {
    key: unaffected.sessionKey,
  });
  assert.equal(hiddenSession.ok, false, JSON.stringify(hiddenSession));
  assert.equal(hiddenSession.error.code, "INVALID_REQUEST");
  assert.equal(
    hiddenSession.error.message,
    `Session "${unaffected.sessionKey}" was not found.`,
    "researcher cannot read another person's session",
  );

  // Downgrade the connection that performed the real write, then reconnect with the same profile.
  assert.equal(withdrawn.socket.isClosed(), false);
  const downgradeStarted = performance.now();
  await Promise.all([
    withdrawn.socket.waitForEvent("close", { timeout: 30_000 }),
    (async () => {
      const changed = await topology.adminRequest(
        "PATCH",
        `${policyPath}/access-bindings/${withdrawn.agentBinding.id}/runtime-role`,
        {
          runtimeRole: "reviewer",
          runtimeRoleConfiguration: (
            await topology.adminRequest(
              "GET",
              `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/runtime-roles`,
            )
          ).data.configuration,
        },
      );
      assert.equal(changed.status, 200, JSON.stringify(changed.error));
      assert.equal(changed.data.runtimeRole, "reviewer");
    })(),
  ]);
  const downgradeMs = performance.now() - downgradeStarted;
  assert.ok(downgradeMs <= 30_000, `role downgrade closed the old stream in ${downgradeMs} ms`);
  assert.equal(
    unaffected.socket.isClosed(),
    false,
    "another person's stream survives the downgrade",
  );
  await waitFor("the downgraded connection's role_changed audit", async () => {
    const audit = await topology.observerPool.query(
      `SELECT id FROM occ.audit_events WHERE actor_id = $1 AND resource_id = $2
       AND action = 'openclaw.agents.native_admin.websocket.close'
       AND details->'nativeAdmin'->>'closeReason' = 'role_changed'`,
      [withdrawn.principalId, topology.agent.id],
    );
    return audit.rowCount > 0 ? true : undefined;
  });
  await withdrawn.nativePage.reload();
  await waitForStockUi(withdrawn.nativePage);
  const reconnected = await nativeRequest(withdrawn.nativePage, "users.self");
  assert.equal(reconnected.ok, true, JSON.stringify(reconnected));
  assert.equal(
    reconnected.payload.profile.id,
    withdrawn.profileId,
    "role changes retain the native profile",
  );
  const reviewerScopes = await withdrawn.nativePage.evaluate(
    () =>
      globalThis.document.querySelector("openclaw-app-shell").context.gateway.snapshot.hello.auth
        .scopes,
  );
  assert.deepEqual(reviewerScopes, ["operator.read"]);
  assertMissingNativeScope(
    await nativeRequest(withdrawn.nativePage, "exec.approvals.get"),
    "operator.admin",
  );
  assertMissingNativeScope(
    await nativeRequest(withdrawn.nativePage, "sessions.patch", {
      key: withdrawn.sessionKey,
      label: `forbidden-${randomUUID()}`,
    }),
    "operator.write",
  );
  const unchanged = await nativeRequest(withdrawn.nativePage, "sessions.describe", {
    key: withdrawn.sessionKey,
  });
  assert.equal(unchanged.ok, true, JSON.stringify(unchanged));
  assert.equal(
    unchanged.payload.session.label,
    ownLabel,
    "denied mutation retains the session label",
  );
  const reviewerOther = await nativeRequest(withdrawn.nativePage, "sessions.describe", {
    key: unaffected.sessionKey,
  });
  assert.equal(reviewerOther.ok, true, JSON.stringify(reviewerOther));
  assert.equal(
    reviewerOther.payload.session.key,
    unaffected.sessionKey,
    "reviewer gains view of other sessions",
  );
  const retainedWorkspace = await topology.workspaceRequest("GET", workspacePath);
  assert.equal(retainedWorkspace.status, 200, JSON.stringify(retainedWorkspace.error));
  assert.equal(
    retainedWorkspace.data.content,
    workspaceContent,
    "human downgrade retains the workspace Backend path",
  );
  const nextSocket = withdrawn.sockets.at(-1);
  assert.notEqual(
    nextSocket,
    withdrawn.socket,
    "revocation must observe the new native connection",
  );
  withdrawn.socket = nextSocket;
  assert.equal(withdrawn.socket.isClosed(), false);
  assert.equal(unaffected.socket.isClosed(), false);
  // Observe real existing sockets before policy mutation. No artificial abort,
  // changed cookie, Gateway stop or page navigation may manufacture this close.
  const started = performance.now();
  await Promise.all([
    withdrawn.socket.waitForEvent("close", { timeout: 30_000 }),
    (async () => {
      const revoked = await topology.adminRequest(
        "DELETE",
        `${policyPath}/access-bindings/${withdrawn.agentBinding.id}`,
      );
      assert.equal(revoked.status, 204);
      assert.equal(
        (await withdrawn.request(`${namespacePath}/agents/${topology.agent.id}`)).status,
        403,
      );
    })(),
  ]).catch(async (error) => {
    const audit = await topology.observerPool.query(
      `SELECT action, details->'nativeAdmin'->>'closeReason' AS reason
       FROM occ.audit_events WHERE actor_id = $1 AND resource_id = $2
       AND action LIKE 'openclaw.agents.native_admin.%' ORDER BY occurred_at`,
      [withdrawn.principalId, topology.agent.id],
    );
    context.diagnostic(`withdrawal audit: ${JSON.stringify(audit.rows)}`);
    throw error;
  });
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs <= 30_000, `policy withdrawal closed native streams in ${elapsedMs} ms`);
  assert.ok(!unaffected.socket.isClosed(), "other person's existing streams stay open");
  await waitFor("the withdrawn human's authorization-denied socket audit", async () => {
    const audit = await topology.observerPool.query(
      `SELECT id FROM occ.audit_events WHERE actor_id = $1 AND resource_id = $2
       AND action = 'openclaw.agents.native_admin.websocket.close'
       AND details->'nativeAdmin'->>'closeReason' = 'authorization_denied'`,
      [withdrawn.principalId, topology.agent.id],
    );
    return audit.rowCount > 0 ? true : undefined;
  });
  assert.equal(
    (await withdrawn.request(`${namespacePath}/agents/${topology.agent.id}`)).status,
    403,
  );
  assert.equal(
    (await unaffected.request(`${namespacePath}/agents/${topology.agent.id}`)).status,
    200,
  );
  assert.equal((await withdrawn.request(namespacePath)).status, 200, "discovery grant remains");
  const retainedWrite = await topology.workspaceRequest("PUT", workspacePath, {
    content: `${workspaceContent}After revocation.\n`,
  });
  assert.equal(retainedWrite.status, 200, JSON.stringify(retainedWrite.error));
  const retainedRead = await topology.workspaceRequest("GET", workspacePath);
  assert.equal(retainedRead.status, 200, JSON.stringify(retainedRead.error));
  assert.equal(retainedRead.data.content, `${workspaceContent}After revocation.\n`);
  await submitChatTurnWithAssistantProof(
    unaffected.nativePage,
    `sharing-after-withdrawal-${randomUUID()}`,
    unaffected.frames,
    waitFor,
  );
  context.diagnostic(
    `Selective sharing withdrawal closed the confirmed native stream in ${Math.ceil(elapsedMs)} ms; the other recipient completed a subsequent real model turn.`,
  );
}

test(
  "production native admin UI opens through OCC and preserves Agent boundaries",
  { ...requiresNativeAdminRouting, timeout: 1_200_000 },
  async (context) => {
    const artifacts = await mkdtemp(join(tmpdir(), "openclaw-native-admin-browser-"));
    context.diagnostic(`native admin browser artifacts: ${artifacts}`);
    const nativeDomain = process.env.OCC_TEST_NATIVE_ADMIN_DOMAIN ?? "native.example.test";
    const sharedCookieDomain =
      process.env.OCC_TEST_NATIVE_ADMIN_SHARED_COOKIE_DOMAIN ?? nativeDomain;
    const ingress = await createNativeIngress(context, { artifacts, nativeDomain });
    const topology = await arrangeProductionTopology(context, "dedicated", undefined, {
      publicOrigin: ingress.origin,
      gatewayPassword: true,
      nativeAdmin: { domain: nativeDomain, sharedCookieDomain },
      nativeOptions: {
        controlUi: { enabled: true },
      },
      workspaceGateway: true,
    });
    ingress.setUpstream(topology.controllerUrl);
    await assertActualModelTurn(topology);

    const unadmittedTarget = expectedNativeAdminTarget(topology, ingress.origin, nativeDomain);
    assert.match(unadmittedTarget.host, hostSuffixPattern(nativeDomain));
    const initialStatus = await topology.adminRequest("GET", agentPath(topology, "/native-admin"));
    assert.equal(
      initialStatus.status,
      403,
      "Installation administration alone must not admit native entry",
    );

    const expectedTarget = await redeployWithNativeAdminAccess(
      topology,
      ingress.origin,
      nativeDomain,
      { configuredRoles: false },
    );
    const status = await nativeAdminStatus(topology);
    assert.equal(status.status, "available");
    assert.equal(status.host, expectedTarget.host, "Agent native host must be deterministic");
    assert.equal(
      status.origin,
      expectedTarget.origin,
      "Agent native origin must use HTTPS ingress",
    );
    assert.equal(status.bootstrapUrl, undefined);
    assert.equal(status.url, expectedTarget.origin + "/");
    assert.equal(status.activeRevisionId, topology.revision.id);

    const route = await resource(
      "httproute",
      topology.gatewayServiceName,
      topology.gatewayPlacement,
    );
    assert.ok(
      route.spec.rules.some((rule) =>
        rule.matches?.some(
          (match) =>
            match.path?.type === "PathPrefix" &&
            match.path.value ===
              `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/`,
        ),
      ),
      "Compute must route same-Agent native UI suffixes through the private Gateway route",
    );

    const browser = await launchBrowser(context, ingress);
    const browserContext = await browser.newContext();
    context.after(() => browserContext.close());
    const nativeResponses = [];
    const nativeWebSockets = [];
    const nativeSocketFrames = [];
    browserContext.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === status.origin) {
        nativeResponses.push({
          url,
          status: response.status(),
          resourceType: response.request().resourceType(),
        });
      }
    });
    browserContext.on("page", (observedPage) =>
      observedPage.on("websocket", (socket) => {
        const url = new URL(socket.url());
        if (url.origin === status.origin.replace(/^http/, "ws")) {
          nativeWebSockets.push(socket.url());
          socket.on("framereceived", (frame) => nativeSocketFrames.push(frame));
        }
      }),
    );

    const page = await browserContext.newPage();
    await login(page, ingress.origin, topology.credentials, agentDetailPath(topology));
    await page.getByRole("heading", { name: topology.agent.name }).waitFor();
    await page
      .getByText("OpenClaw uses your assigned role to control conversations, tools and settings.")
      .waitFor();
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("link", { name: "Open OpenClaw" }).click();
    const nativePage = await popupPromise;
    await completeNativeLaunch(nativePage, { nativeOrigin: status.origin });

    const deepLink = new URL("/settings/advanced", status.origin);
    const deepLinkResponse = await nativePage.goto(deepLink.href);
    assert.ok(deepLinkResponse?.status() < 400, "stock UI deep link must be served");
    await waitForStockUi(nativePage);
    await nativePage.locator(".page-title").getByText("Advanced", { exact: true }).waitFor();
    await nativePage.getByRole("button", { name: "Raw", exact: true }).waitFor();
    await nativePage.screenshot({
      path: join(artifacts, "stock-ui-authorized.png"),
      fullPage: true,
    });
    await assertServiceWorkerRegistrationBlockedByCsp(nativePage);

    const beforeNativeEdit = await readOceControlState(topology);
    const expectedManagedAccent = configAccent(beforeNativeEdit.configuration.values);
    await assertReversibleNativeConfigEdit(nativePage, status.origin);
    assert.deepEqual(
      await readOceControlState(topology),
      beforeNativeEdit,
      "native raw-editor changes must not mutate OCC Configuration or active revision state",
    );

    const marker = `native-admin-browser-${randomUUID()}`;
    await submitChatTurnWithAssistantProof(nativePage, marker, nativeSocketFrames, waitFor);
    await nativePage.screenshot({ path: join(artifacts, "stock-ui-chat.png"), fullPage: true });
    await assertNoNativeCredentialLeak(nativePage, [
      topology.gatewayPassword,
      topology.workspaceGateway.apiKey,
      process.env.OPENAI_API_KEY,
    ]);

    const successfulNativeResourceTypes = new Set(
      nativeResponses
        .filter(({ status: responseStatus }) => responseStatus < 400)
        .map(({ resourceType }) => resourceType),
    );
    for (const resourceType of ["document", "script", "stylesheet"]) {
      assert.ok(
        successfulNativeResourceTypes.has(resourceType),
        `stock native UI ${resourceType} must be served from the isolated Agent origin`,
      );
    }
    assert.ok(nativeWebSockets.length > 0, "stock native UI must establish a browser WebSocket");

    const siblingHost = status.host.replace(/^agent-/, "agent-deadbeef");
    const siblingPage = await browserContext.newPage();
    context.after(() => siblingPage.close().catch(() => {}));
    const sibling = await siblingPage
      .goto(`${status.origin.replace(status.host, siblingHost)}/`, {
        waitUntil: "domcontentloaded",
      })
      .catch((error) => error);
    if (!(sibling instanceof Error)) {
      await siblingPage.screenshot({
        path: join(artifacts, "wrong-agent-host-denied.png"),
        fullPage: true,
      });
    }
    assert.ok(
      sibling instanceof Error || [401, 403, 404].includes(sibling.status()),
      "another Agent host must not borrow the native admin session",
    );

    await kubectl(
      "delete",
      "pod",
      topology.gatewayPod.metadata.name,
      "--namespace",
      topology.gatewayPlacement,
      "--wait=true",
      "--timeout=120s",
    );
    topology.gatewayPod = await waitForReadyGatewayPod(
      topology,
      topology.revision.id,
      topology.gatewayPod.metadata.uid,
    );
    await nativePage.reload({ waitUntil: "domcontentloaded" });
    await waitForStockUi(nativePage);
    const driftAccent = await leaveNativeAccentDrift(nativePage, status.origin);
    assert.deepEqual(
      await readOceControlState(topology),
      beforeNativeEdit,
      "native raw-editor drift must not mutate OCC Configuration or active revision state",
    );
    await nativePage.close();
    await assertNativeAdminAudit(topology);
    await assertStopRedeployPreservesWorkspaceFile(topology, {
      expectedManagedAccent,
      forbiddenRuntimeAccent: driftAccent,
    });
    const currentStatus = await nativeAdminStatus(topology);
    assert.equal(currentStatus.status, "available");
    assert.equal(currentStatus.activeRevisionId, topology.revision.id);
    assert.equal(currentStatus.origin, status.origin);
    const currentSessionPage = await browserContext.newPage();
    context.after(() => currentSessionPage.close().catch(() => {}));
    const currentSession = await currentSessionPage.goto(currentStatus.url);
    assert.ok(
      currentSession?.status() < 400,
      "the shared native admin session must reconnect to the current redeployed revision",
    );
    await waitForStockUi(currentSessionPage);
    await currentSessionPage.close();
    context.diagnostic(
      "Native admin browser proof loaded stock assets, opened a deep link, established a WebSocket, sent a real chat turn, made/reverted a native config edit, proved OCE redeploy restores managed config after native drift, denied a sibling host, preserved a workspace file across OCE stop/redeploy, wrote human connect/close audit evidence, reconnected to the current redeployed revision, and reloaded after gateway Pod replacement.",
    );
  },
);

// Sharing is independently useful on the supported embedded topology. Keep the
// dedicated lifecycle case above separate so neither qualification replaces it.
test(
  "two people share an embedded native Gateway with selective stream withdrawal",
  { ...requiresNativeAdminRouting, timeout: 1_200_000 },
  async (context) => {
    const artifacts = await mkdtemp(join(tmpdir(), "openclaw-native-sharing-"));
    context.diagnostic(`native sharing artifacts: ${artifacts}`);
    const nativeDomain = process.env.OCC_TEST_NATIVE_ADMIN_DOMAIN ?? "native.example.test";
    const sharedCookieDomain =
      process.env.OCC_TEST_NATIVE_ADMIN_SHARED_COOKIE_DOMAIN ?? nativeDomain;
    const ingress = await createNativeIngress(context, { artifacts, nativeDomain });
    const topology = await arrangeProductionTopology(context, "embedded", undefined, {
      publicOrigin: ingress.origin,
      gatewayPassword: true,
      nativeAdmin: { domain: nativeDomain, sharedCookieDomain },
      nativeOptions: { controlUi: { enabled: true } },
      workspaceGateway: true,
    });
    ingress.setUpstream(topology.controllerUrl);
    await redeployWithNativeAdminAccess(topology, ingress.origin, nativeDomain);
    const status = await nativeAdminStatus(topology);
    assert.equal(status.status, "available");
    const browser = await launchBrowser(context, ingress);
    await assertSharedNativeSessions(context, { topology, browser, ingress, status });
  },
);
