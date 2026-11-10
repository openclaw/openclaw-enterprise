import {
  assertChatStreamStopAndResume,
  submitChatTurnWithAssistantProof,
  textFromFrame,
  waitForStockUi,
} from "../helpers/native-ui-chat.mjs";
import assert from "node:assert/strict";
import { keycloakRealmAdmin } from "./ci-keycloak-realm.mjs";
import { tlsPeerCertificate } from "./tls-peer-certificate.mjs";
import { execFile } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { chromium } from "playwright";

import { nativeAdminTarget } from "../../apps/controller/src/gateway/native-admin.ts";
import {
  arrangeProductionTopology,
  assertActualModelTurn,
  kubectl,
  resource,
  waitFor,
  waitForReadyGatewayPod,
} from "../helpers/harness-topology-k3d-real.mjs";

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

async function login(page, credentials) {
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
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

async function redeployWithNativeAdminAccess(topology, publicOrigin, nativeDomain) {
  const targetForStableOrigin = expectedNativeAdminTarget(topology, publicOrigin, nativeDomain);
  const current = await topology.request(
    "GET",
    `/namespaces/${topology.agent.namespaceId}/configurations/${topology.agent.configurationId}`,
  );
  assert.equal(current.status, 200, JSON.stringify(current.error));
  const values = structuredClone(current.data.values);
  values.gateway = {
    ...values.gateway,
    controlUi: {
      ...(values.gateway?.controlUi ?? {}),
      enabled: true,
      allowedOrigins: [targetForStableOrigin.origin],
    },
    auth: {
      ...(values.gateway?.auth ?? {}),
      trustedProxy: {
        ...(values.gateway?.auth?.trustedProxy ?? {}),
        requiredHeaders: [
          ...new Set([
            ...(values.gateway?.auth?.trustedProxy?.requiredHeaders ?? []),
            "x-openclaw-scopes",
          ]),
        ],
        // Identity grants supply administration; device enrollment need not grant it.
        deviceAutoApprove: { enabled: true, scopes: ["operator.read", "operator.write"] },
      },
    },
  };
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

async function openNativeAdminConsole(page, nativeOrigin, mode = "admin") {
  const link = page.getByRole("link", {
    name: mode === "chat" ? "Open chat" : "Open Agent UI",
    exact: true,
  });
  const root = new URL("/", nativeOrigin).href;
  assert.equal(await link.getAttribute("href"), root);
  const [nativePage] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  await waitForStockUi(nativePage);
  // Navigation Timing keeps the loaded document URL when the stock UI replaces "/" with chat.
  const documentUrl = await nativePage.evaluate(
    () => performance.getEntriesByType("navigation")[0]?.name,
  );
  assert.equal(documentUrl, root, "Open Agent UI must load the native root document");
  assert.equal(new URL(nativePage.url()).origin, nativeOrigin);
  assert.equal(await nativePage.evaluate(() => globalThis.window.opener === null), true);
  return nativePage;
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

async function assertManagedNativeConfigWriteRejected(page, nativeOrigin, topology) {
  let saveRequestId;
  let saveResponse;
  // Observe the real raw-editor write and its matching Gateway response; a
  // toast's placement or lifetime must not substitute for rejecting the write.
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => {
      const message = JSON.parse(textFromFrame(frame));
      if (message.method === "config.set") {
        saveRequestId = message.id;
      }
    });
    socket.on("framereceived", (frame) => {
      const message = JSON.parse(textFromFrame(frame));
      if (saveRequestId !== undefined && message.id === saveRequestId) {
        saveResponse = message;
      }
    });
  });
  const { editor, parsed } = await readRawConfig(page, nativeOrigin);
  const originalAccent = configAccent(parsed);
  parsed.ui = {
    ...(parsed.ui ?? {}),
    prefs: {
      ...(parsed.ui?.prefs ?? {}),
      accent: `#${randomUUID().replaceAll("-", "").slice(0, 6)}`,
    },
  };
  await editor.fill(serializeConfig(parsed));
  // The pinned UI renders the policy identifier in the live status text;
  // the status has no accessible name.
  const retryReadOnlySave = page
    .locator("openclaw-settings-save-indicator")
    .getByRole("status")
    .filter({ hasText: /\bOPENCLAW_CONFIG_READONLY\b/ })
    .getByRole("button", { name: "Retry", exact: true })
    .first();
  await retryReadOnlySave.waitFor({ state: "hidden" });
  await page.locator(".config-raw-actions button.primary").first().click();
  const rejected = await waitFor("managed raw-editor write response", () => saveResponse);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error?.message ?? "", /Config is externally managed/);
  await retryReadOnlySave.waitFor();
  assert.equal(await readRuntimeAccent(topology), originalAccent);
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

async function saveGatewayManagedMode(topology, gatewayManagedMode) {
  const updated = await topology.adminRequest("PATCH", agentPath(topology), {
    configurationId: topology.agent.configurationId,
    gatewayManagedMode,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.error));
  assert.equal(updated.data.gatewayManagedMode, gatewayManagedMode);
  assert.equal(updated.data.activeRevisionId, topology.revision.id);
  topology.agent = { ...topology.agent, ...updated.data };
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
  await saveGatewayManagedMode(topology, true);

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

  const stoppedRead = await topology.workspaceRequest("GET", workspacePath);
  assert.notEqual(
    stoppedRead.status,
    200,
    "stopped Agent workspace files must not masquerade as an active native workspace",
  );

  const deployEventStart = topology.events.length;
  const redeployed = await topology.request("POST", agentPath(topology, "/deploy"));
  assert.equal(redeployed.status, 202, JSON.stringify(redeployed.error));
  assert.equal(redeployed.data.gatewayManagedMode, true);
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

async function enrolledDeviceScopes(topology, deviceId) {
  assert.ok(deviceId, "the real native connection must present a device identity");
  // Inspect only enrollment metadata in the running Gateway's database. Do not
  // export device tokens, public keys, or other runtime state into test output.
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/home/node/.openclaw/state/openclaw.sqlite", { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=5000");
      const row = db.prepare("SELECT approved_scopes_json FROM device_pairing_paired WHERE device_id = ?").get(${JSON.stringify(deviceId)});
      process.stdout.write(JSON.stringify({ enrolled: !!row, scopes: row ? JSON.parse(row.approved_scopes_json) : [] }));
    } finally { db.close(); }
  `;
  const result = JSON.parse(
    await kubectl(
      "exec",
      topology.gatewayPod.metadata.name,
      "--namespace",
      topology.gatewayPlacement,
      "--",
      "node",
      "-e",
      script,
    ),
  );
  assert.equal(result.enrolled, true);
  assert.ok(result.scopes.length > 0, "the enrolled device must retain its approved scopes");
  return result.scopes.sort();
}

async function assertSharedNativeSessions(
  context,
  { topology, browser, ingress, status, artifacts },
) {
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
      "Shared native administration",
      [
        { action: "read", resourceKind: "agent" },
        { action: "administer", resourceKind: "agent" },
      ],
    ],
    [
      "Agent operator",
      [
        { action: "read", resourceKind: "agent" },
        { action: "operate", resourceKind: "agent" },
      ],
    ],
    ["Agent reader", [{ action: "read", resourceKind: "agent" }]],
  ]) {
    const role = await topology.adminRequest("POST", `${policyPath}/roles`, { name, permissions });
    assert.equal(role.status, 201);
    roles.push(role.data);
  }
  const sibling = await topology.adminRequest("POST", `${namespacePath}/agents`, {
    name: `private-sibling-${randomUUID()}`,
    executionMode: topology.agent.executionMode,
    configurationId: topology.agent.configurationId,
  });
  assert.equal(sibling.status, 201, JSON.stringify(sibling.error));
  const people = [];
  const deniedProbes = [];
  let readerPage;
  async function nativeProbe(page, expectedStatus, origin = status.origin) {
    const probe = `native-access-${randomUUID()}`;
    const probePage = await page.context().newPage();
    try {
      const response = await probePage.goto(`${origin}/healthz?probe=${probe}`);
      assert.equal(response.status(), expectedStatus);
      return probe;
    } finally {
      await probePage.close();
    }
  }
  async function assertNativeDenied(page) {
    deniedProbes.push(await nativeProbe(page, 403));
  }
  for (const label of ["reader", "operator", "withdrawn", "unaffected"]) {
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
      [
        "agent",
        topology.agent.id,
        roles[{ reader: 3, operator: 2, withdrawn: 1, unaffected: 1 }[label]].id,
      ],
    ]) {
      const binding = await topology.adminRequest("POST", `${policyPath}/access-bindings`, {
        subjectKind: "identity",
        subjectId: account.data.principalId,
        resourceKind,
        resourceId,
        roleId,
      });
      assert.equal(binding.status, 201);
      if (resourceKind === "agent") {
        agentBinding = binding.data;
      }
    }
    const personContext = await browser.newContext();
    context.after(() => personContext.close());
    const frames = [];
    const deviceIds = new Map();
    personContext.on("page", (observedPage) =>
      observedPage.on("websocket", (socket) => {
        if (new URL(socket.url()).origin === status.origin.replace(/^http/, "ws")) {
          socket.on("framesent", (frame) => {
            const message = JSON.parse(textFromFrame(frame));
            if (message.method === "connect") {
              deviceIds.set(socket, message.params?.device?.id);
            }
          });
          socket.on("framereceived", (frame) =>
            frames.push({ ...frame, socket, page: observedPage }),
          );
        }
      }),
    );
    const page = await personContext.newPage();
    await page.goto(new URL(agentDetailPath(topology), ingress.origin).href);
    await login(page, credentials);
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
    if (label === "reader") {
      assert.equal(
        (await request(`${namespacePath}/agents/${topology.agent.id}/native-admin`)).status,
        403,
      );
      await assertNativeDenied(page);
      readerPage = page;
      continue;
    }
    if (label === "operator") {
      const access = await request(`${namespacePath}/agents/${topology.agent.id}/native-admin`);
      assert.equal(access.status, 200);
      assert.equal(access.body.data.mode, "chat");
      const siblingTarget = nativeAdminTarget({
        publicOrigin: ingress.origin,
        installationId: topology.installation.id,
        agent: sibling.data,
        domain: new URL(status.origin).hostname.split(".").slice(1).join("."),
      });
      deniedProbes.push(await nativeProbe(page, 403, siblingTarget.origin));
      const nativePage = await openNativeAdminConsole(page, status.origin, "chat");
      await submitChatTurnWithAssistantProof(
        nativePage,
        `operator-chat-${randomUUID()}`,
        frames,
        waitFor,
      );
      // Direct native requests exercise server enforcement even if an operator bypasses
      // hidden UI controls or asks for administrative scopes in a raw connect frame.
      await assertChatAdministrationDenied(nativePage);
      await nativePage.screenshot({
        path: join(artifacts, "operator-browser-chat.png"),
        fullPage: true,
      });
      continue;
    }
    // Configuration remains denied, but exact Agent administer must still launch
    // the regular native UI. A fixture URL must not stand in for the Console link.
    const nativePage = await openNativeAdminConsole(page, status.origin);
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
    const deviceId = deviceIds.get(socket);
    // Identity grants supply administration independently of device scopes. Retaining
    // this enrollment must not bypass later permission withdrawal or session expiry.
    const deviceScopes = await enrolledDeviceScopes(topology, deviceId);
    if (label === "withdrawn") {
      await nativePage.screenshot({
        path: join(artifacts, "native-chat-before-withdrawal.png"),
        fullPage: true,
      });
    }
    people.push({
      page,
      deviceId,
      deviceScopes,
      request,
      nativePage,
      frames,
      socket,
      agentBinding,
      credentials,
      userId: account.data.id,
      principalId: account.data.principalId,
    });
  }
  const [withdrawn, unaffected] = people;
  await assertNativeDenied(readerPage);
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
  assert.deepEqual(
    await enrolledDeviceScopes(topology, withdrawn.deviceId),
    withdrawn.deviceScopes,
  );
  await assertNativeDenied(withdrawn.page);
  const lastReply = await submitChatTurnWithAssistantProof(
    unaffected.nativePage,
    `sharing-after-withdrawal-${randomUUID()}`,
    unaffected.frames,
    waitFor,
  );
  context.diagnostic(
    `Selective sharing withdrawal closed the confirmed native stream in ${Math.ceil(elapsedMs)} ms; the other recipient completed a subsequent real model turn.`,
  );

  // Expire only this new user's single session. The scalar subquery rejects an
  // ambiguous fixture. Leave the native tab, its cookies, and all grants alone.
  const { nativePage, userId } = unaffected;
  assert.equal(lastReply.page, nativePage);
  assert.equal(lastReply.socket.isClosed(), false);
  const [, health] = await Promise.all([
    lastReply.socket.waitForEvent("close", { timeout: 45_000 }),
    nativePage.waitForResponse(status.origin + "/healthz", { timeout: 45_000 }),
    topology.observerPool
      .query(
        `UPDATE occ.session SET expires_at = clock_timestamp() - interval '1 second'
         WHERE id = (SELECT id FROM occ.session WHERE user_id = $1)`,
        [userId],
      )
      .then(({ rowCount }) => assert.equal(rowCount, 1, "expired this recipient's session")),
  ]);
  assert.equal(health.status(), 403, "the open native tab observed the session refusal");
  assert.deepEqual(
    await enrolledDeviceScopes(topology, unaffected.deviceId),
    unaffected.deviceScopes,
  );
  await assertNativeDenied(unaffected.page);

  const reconnect = nativePage.getByRole("link", {
    name: "Reconnect in browser",
    exact: true,
  });
  const [root] = await Promise.all([
    nativePage.waitForResponse(
      (response) => response.url() === status.url && response.request().isNavigationRequest(),
    ),
    reconnect.click({ timeout: 15_000 }),
  ]);
  assert.equal(root.status(), 302);
  const agentKey = status.host.split(".")[0].slice("agent-".length);
  // Console removes the fragment before showing sign-in. Check the redirect itself.
  assert.equal(
    await root.headerValue("location"),
    ingress.origin + "/console/#native-agent=" + agentKey,
  );
  const [resolved] = await Promise.all([
    nativePage.waitForResponse(ingress.origin + "/native-admin/return/" + agentKey),
    login(nativePage, unaffected.credentials),
  ]);
  assert.equal(resolved.status(), 200);
  const { agentId, namespaceId } = (await resolved.json()).data;
  assert.equal(agentId, topology.agent.id);
  assert.equal(namespaceId, topology.agent.namespaceId);

  const reopened = await openNativeAdminConsole(nativePage, status.origin);
  await waitFor("a live Gateway hello on the page opened after signing back in", () =>
    unaffected.frames.find(
      (frame) =>
        frame.page === reopened &&
        !frame.socket.isClosed() &&
        JSON.parse(textFromFrame(frame)).payload?.type === "hello-ok",
    ),
  );
  // A positive ingress-log control proves the observer sees real upstream I/O.
  // Denied requests precede it and must never reach Envoy or the native Gateway.
  const allowedProbe = await nativeProbe(reopened, 200);
  const routing = topology.workspaceGateway.routing;
  const ingressLog = await waitFor("authorized native probe in Envoy access log", async () => {
    const log = await kubectl(
      "logs",
      "--namespace",
      routing.envoyNamespace,
      "--selector",
      `gateway.envoyproxy.io/owning-gateway-namespace=${topology.platformNamespace},gateway.envoyproxy.io/owning-gateway-name=${routing.gatewayName}`,
      "--all-containers=true",
      "--tail=-1",
    );
    return log.includes(allowedProbe) ? log : undefined;
  });
  for (const deniedProbe of deniedProbes) {
    assert.equal(
      ingressLog.includes(deniedProbe),
      false,
      "refused native request reached upstream",
    );
  }
  context.diagnostic(
    "Read-only and revoked callers were refused before upstream I/O; an operate-only caller completed a real chat turn while HTTP and WebSocket administration were denied. Both administrator devices remained enrolled with unchanged approved scopes.",
  );
}

export async function runNativeAdminScenario(context) {
  const artifacts = await mkdtemp(join(tmpdir(), "openclaw-native-admin-browser-"));
  context.diagnostic(`native admin browser artifacts: ${artifacts}`);
  const nativeDomain = process.env.OCC_TEST_NATIVE_ADMIN_DOMAIN ?? "native.example.test";
  const ingress = await createNativeIngress(context, { artifacts, nativeDomain });
  const topology = await arrangeProductionTopology(context, "dedicated", undefined, {
    publicOrigin: ingress.origin,
    gatewayPassword: true,
    nativeAdmin: { enabled: true, domain: nativeDomain },
    provisionNativeAdmin: true,
    nativeOptions: {
      controlUi: { enabled: true },
    },
    workspaceGateway: true,
  });
  ingress.setUpstream(topology.controllerUrl);
  assert.equal(topology.revision.gatewayManagedMode, true);
  await assertActualModelTurn(topology);

  const initialStatus = await nativeAdminStatus(topology);
  assert.equal(initialStatus.status, "available", "creation opt-in enables the first revision");
  assert.equal(initialStatus.activeRevisionId, topology.revision.id);
  assert.equal((await readOceControlState(topology)).configuration.generation, 1);
  const browser = await launchBrowser(context, ingress);
  await assertSharedNativeSessions(context, {
    topology,
    browser,
    ingress,
    status: initialStatus,
    artifacts,
  });

  await saveGatewayManagedMode(topology, false);
  const expectedTarget = await redeployWithNativeAdminAccess(
    topology,
    ingress.origin,
    nativeDomain,
  );
  assert.equal(topology.revision.gatewayManagedMode, false);
  const status = await nativeAdminStatus(topology);
  assert.equal(status.status, "available");
  assert.equal(status.host, expectedTarget.host, "Agent native host must be deterministic");
  assert.equal(status.origin, expectedTarget.origin, "Agent native origin must use HTTPS ingress");
  assert.equal(status.bootstrapUrl, undefined);
  assert.equal(status.url, expectedTarget.origin + "/");
  assert.equal(status.activeRevisionId, topology.revision.id);

  const route = await resource("httproute", topology.gatewayServiceName, topology.gatewayPlacement);
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
  await page.goto(new URL(agentDetailPath(topology), ingress.origin).href);
  await login(page, topology.credentials);
  await page.getByRole("heading", { name: topology.agent.name }).waitFor();
  await page
    .getByText("Gateway managed mode restricts administrative changes by default.")
    .waitFor();
  const nativePage = await openNativeAdminConsole(page, status.origin);

  const deepLink = new URL("/settings/advanced", status.origin);
  const deepLinkResponse = await nativePage.goto(deepLink.href);
  assert.ok(deepLinkResponse?.status() < 400, "stock UI deep link must be served");
  await waitForStockUi(nativePage);
  // The Gateway embeds the stock UI's bootstrap configuration in the document it serves,
  // and the UI boots from it. The OCC Agent name must replace the stock "Assistant"; the
  // Gateway cuts a display name to 50 characters.
  const bootstrap = await nativePage.evaluate(() =>
    globalThis.document.documentElement.getAttribute("data-openclaw-bootstrap-config"),
  );
  assert.ok(bootstrap, "the Gateway must serve the stock UI's bootstrap configuration");
  assert.equal(JSON.parse(bootstrap).assistantName, topology.agent.name.slice(0, 50));
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
  const banner = currentSessionPage.getByRole("paragraph").filter({
    hasText: "edit and save the Agent’s draft Configuration, then select Deploy new version",
  });
  await banner.waitFor();
  assert.equal(
    await banner.getByRole("link", { name: "Learn more", exact: true }).getAttribute("href"),
    "https://docs-enterprise.openclaw.org/reference/agents/gateway-managed-mode/",
  );
  await assertManagedNativeConfigWriteRejected(currentSessionPage, currentStatus.origin, topology);
  await currentSessionPage.close();
  context.diagnostic(
    "Native admin browser proof loaded stock assets, opened a deep link, established a WebSocket, sent a real chat turn, made/reverted a native config edit with managed mode off, restored OCE config and rejected a native config write after managed mode was re-enabled, denied a sibling host, preserved a workspace file across OCE stop/redeploy, wrote human connect/close audit evidence, reconnected to the current redeployed revision, and reloaded after gateway Pod replacement.",
  );
}

// Sharing is independently useful on the supported embedded topology. Keep the
// dedicated lifecycle case above separate so neither qualification replaces it.
export async function runSharedNativeScenario(context) {
  const artifacts = await mkdtemp(join(tmpdir(), "openclaw-native-sharing-"));
  context.diagnostic(`native sharing artifacts: ${artifacts}`);
  const nativeDomain = process.env.OCC_TEST_NATIVE_ADMIN_DOMAIN ?? "native.example.test";
  const ingress = await createNativeIngress(context, { artifacts, nativeDomain });
  const topology = await arrangeProductionTopology(context, "embedded", undefined, {
    publicOrigin: ingress.origin,
    gatewayPassword: true,
    nativeAdmin: { enabled: true, domain: nativeDomain },
    nativeOptions: { controlUi: { enabled: true } },
    workspaceGateway: true,
  });
  ingress.setUpstream(topology.controllerUrl);
  const unadmittedTarget = expectedNativeAdminTarget(topology, ingress.origin, nativeDomain);
  assert.match(unadmittedTarget.host, hostSuffixPattern(nativeDomain));
  assert.notEqual(
    (await nativeAdminStatus(topology)).status,
    "available",
    "without opt-in the runtime must admit the exact origin and device policy before access",
  );
  await redeployWithNativeAdminAccess(topology, ingress.origin, nativeDomain);
  const status = await nativeAdminStatus(topology);
  assert.equal(status.status, "available");
  const browser = await launchBrowser(context, ingress);
  await assertSharedNativeSessions(context, { topology, browser, ingress, status, artifacts });
}

async function assertChatAdministrationDenied(nativePage) {
  const denied = await nativePage.evaluate(async () => {
    const http = await fetch("/tools/invoke", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openclaw-scopes": "operator.admin",
        "x-occ-identity": "spoofed-administrator",
      },
      body: JSON.stringify({ tool: "sessions_list", args: {} }),
    });
    const websocket = await new Promise((resolve) => {
      const socket = new WebSocket(globalThis.location.origin.replace(/^http/, "ws"));
      const timer = setTimeout(() => {
        socket.close();
        resolve({ timeout: true });
      }, 15000);
      let scopes;
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.type === "event" && message.event === "connect.challenge") {
          socket.send(
            JSON.stringify({
              type: "req",
              id: "connect",
              method: "connect",
              params: {
                minProtocol: 4,
                maxProtocol: 4,
                client: {
                  id: "gateway-client",
                  version: "1.0.0",
                  platform: "browser",
                  mode: "backend",
                },
                role: "operator",
                scopes: ["operator.admin"],
                caps: [],
                commands: [],
              },
            }),
          );
        } else if (message.type === "res" && message.id === "connect" && message.ok) {
          scopes = message.payload.auth.scopes;
          socket.send(
            JSON.stringify({ type: "req", id: "config", method: "config.get", params: {} }),
          );
        } else if (message.type === "res") {
          clearTimeout(timer);
          socket.close();
          resolve({ scopes, ok: message.ok, error: message.error });
        }
      };
    });
    return { http: http.status, body: await http.text(), websocket };
  });
  assert.equal(denied.http, 403);
  assert.match(denied.body, /missing scope/);
  assert.deepEqual(denied.websocket.scopes, ["operator.sessions.write"]);
  assert.equal(denied.websocket.ok, false);
  assert.match(denied.websocket.error.message, /missing scope/);
}

/** The QA matrix reuses the native browser harness with a real, prepared OIDC provider. */
export async function runOidcAgentChatScenario(context) {
  const issuer = process.env.OCC_TEST_KEYCLOAK_ISSUER;
  const secrets = JSON.parse(await readFile(process.env.OCC_TEST_KEYCLOAK_SECRETS_FILE, "utf8"));
  const caCert = await readFile(process.env.OCC_TEST_KEYCLOAK_CA_CERT, "utf8");
  const artifacts = await mkdtemp(join(tmpdir(), "openclaw-oidc-agent-chat-"));
  context.diagnostic(`OIDC Agent chat artifacts: ${artifacts}`);
  const nativeDomain = process.env.OCC_TEST_NATIVE_ADMIN_DOMAIN ?? "native.example.test";
  const ingress = await createNativeIngress(context, { artifacts, nativeDomain });

  // A disposable client admits this run's exact Console callback without changing
  // the separately prepared sign-in fixture or weakening redirect validation.
  const [preparedClient] = await keycloakRealmAdmin(
    issuer,
    secrets.admin,
    "GET",
    `/clients?clientId=${secrets.clientId}`,
  );
  assert.ok(preparedClient);
  const clientId = `oce-native-${randomUUID()}`;
  const clientSecret = randomUUID() + randomUUID();
  const { id: _preparedId, ...clientSettings } = preparedClient;
  await keycloakRealmAdmin(issuer, secrets.admin, "POST", "/clients", {
    ...clientSettings,
    clientId,
    secret: clientSecret,
    redirectUris: [ingress.origin + "/api/auth/providers/oidc/callback"],
    protocolMappers: [
      ...(clientSettings.protocolMappers ?? []),
      {
        name: "OCE admission groups",
        protocol: "openid-connect",
        protocolMapper: "oidc-group-membership-mapper",
        consentRequired: false,
        config: {
          "claim.name": "groups",
          "full.path": "false",
          "id.token.claim": "true",
          "access.token.claim": "false",
          "userinfo.token.claim": "false",
        },
      },
    ],
  });
  const [client] = await keycloakRealmAdmin(
    issuer,
    secrets.admin,
    "GET",
    `/clients?clientId=${clientId}`,
  );
  context.after(() => keycloakRealmAdmin(issuer, secrets.admin, "DELETE", `/clients/${client.id}`));
  const groupName = `oce-members-${randomUUID()}`;
  await keycloakRealmAdmin(issuer, secrets.admin, "POST", "/groups", { name: groupName });
  const groups = await keycloakRealmAdmin(
    issuer,
    secrets.admin,
    "GET",
    `/groups?search=${groupName}`,
  );
  const group = groups.find((entry) => entry.name === groupName);
  assert.ok(group);
  context.after(() => keycloakRealmAdmin(issuer, secrets.admin, "DELETE", `/groups/${group.id}`));
  for (const subject of [
    "6f1c1e9a-3d4b-4c55-9a2e-0a11ce000001",
    "6f1c1e9a-3d4b-4c55-9a2e-0ca201000002",
  ]) {
    await keycloakRealmAdmin(issuer, secrets.admin, "PUT", `/users/${subject}/groups/${group.id}`);
  }
  const topology = await arrangeProductionTopology(context, "embedded", undefined, {
    publicOrigin: ingress.origin,
    defaultUser: true,
    nativeAdmin: { enabled: true, domain: nativeDomain },
    nativeOptions: { controlUi: { enabled: true } },
    workspaceGateway: true,
    oidc: {
      issuer,
      enrollment: { admission: { groupsClaim: "groups", anyOf: [groupName] } },
      clientId,
      clientSecret,
      caCert,
      container: process.env.OCC_TEST_KEYCLOAK_CONTAINER,
      statePath: process.env.OCC_TEST_KEYCLOAK_STATE ?? process.env.OPENCLAW_ENTERPRISE_CI_STATE,
    },
  });
  ingress.setUpstream(topology.controllerUrl);
  const issuerHost = new URL(issuer).hostname;
  const providerCertificate = await tlsPeerCertificate({
    host: "127.0.0.1",
    port: 443,
    servername: issuerHost,
    ca: caCert,
  });
  const providerSpki = createHash("sha256")
    .update(
      new X509Certificate(providerCertificate).publicKey.export({ type: "spki", format: "der" }),
    )
    .digest("base64");
  ingress.browserArgs[0] += `,MAP ${issuerHost} 127.0.0.1`;
  ingress.browserArgs[1] += `,${providerSpki}`;
  const browser = await launchBrowser(context, ingress);
  const namespacePath = `/namespaces/${topology.agent.namespaceId}`;
  const policyPath = `${namespacePath}/iam`;
  // The supported account API enrolls both people in the configured Default
  // user group, which permits creation in this fresh default Namespace.
  const enroll = async (username, subject) => {
    const account = await topology.adminRequest("POST", "/api/auth/accounts", {
      email: `${username}@example.test`,
      password: randomUUID() + randomUUID(),
    });
    assert.equal(account.status, 201, JSON.stringify(account.error));
    const current = await topology.adminRequest("GET", `/api/auth/accounts/${account.data.id}`);
    assert.equal(current.status, 200);
    const attached = await topology.adminRequest(
      "POST",
      `/api/auth/accounts/${account.data.id}/providers/oidc`,
      {
        subject,
        expectedVersion: current.data.version,
      },
    );
    assert.equal(attached.status, 200, JSON.stringify(attached.error));
    return account.data;
  };
  const alice = await enroll("alice", "6f1c1e9a-3d4b-4c55-9a2e-0a11ce000001");
  const carol = await enroll("carol", "6f1c1e9a-3d4b-4c55-9a2e-0ca201000002");
  const role = async (name, permissions) => {
    const result = await topology.adminRequest("POST", `${policyPath}/roles`, {
      name,
      permissions,
    });
    assert.equal(result.status, 201, JSON.stringify(result.error));
    return result.data.id;
  };
  const bind = async (account, roleId, resourceKind, resourceId) => {
    const result = await topology.adminRequest("POST", `${policyPath}/access-bindings`, {
      subjectKind: "identity",
      subjectId: account.principalId,
      roleId,
      resourceKind,
      resourceId,
    });
    assert.equal(result.status, 201, JSON.stringify(result.error));
  };
  const secretRole = await role("Use selected model", [
    { action: "operate", resourceKind: "secret" },
  ]);
  await bind(alice, secretRole, "secret", topology.secretApi.model.ref.id);

  const signIn = async (username) => {
    const browserContext = await browser.newContext();
    context.after(() => browserContext.close());
    const page = await browserContext.newPage();
    await page.goto(ingress.origin + "/console/");
    await page.getByRole("button", { name: "Continue with Keycloak" }).click();
    await page.waitForURL((url) => url.origin === new URL(issuer).origin);
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(secrets.users[username].password);
    const adopted = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/providers/oidc/result",
    );
    await page.locator("#kc-login").click();
    assert.equal((await adopted).status(), 200);
    await page.waitForURL(
      (url) => url.origin === ingress.origin && url.pathname.startsWith("/console/"),
    );
    return page;
  };
  const requestFor = (page) => (method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const response = await fetch(path, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          ...(response.status === 204 ? {} : await response.json()),
        };
      },
      { method, path, body },
    );
  const ownerPage = await signIn("alice");
  const ownerRequest = requestFor(ownerPage);
  assert.equal((await ownerRequest("GET", "/api/auth/session")).data.user.id, alice.id);
  assert.equal((await ownerRequest("GET", "/installation")).status, 403);
  const capabilities = await ownerRequest("GET", `${namespacePath}/agent-capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.data.capabilities.nativeAdmin, true);

  // The saved embedded draft has no Agent-specific origins or app-server transport.
  // Drop the fixture's Gateway password reference: ordinary create derives the new
  // Agent's browser profile, and the model Secret is separately bound by reference.
  const values = structuredClone(topology.secretApi.configuration.values);
  delete values.gateway.auth.password;
  const configuration = await ownerRequest("POST", `${namespacePath}/configurations`, {
    kind: "agent",
    values,
  });
  assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
  const created = await ownerRequest("POST", `${namespacePath}/agents`, {
    name: `oidc-owned-${randomUUID()}`,
    executionMode: "embedded",
    configurationId: configuration.data.id,
    harnessAuth: topology.agent.harnessAuth,
    nativeAdmin: true,
    expectedConfigurationGeneration: configuration.data.generation,
  });
  assert.equal(created.status, 201, JSON.stringify(created.error));
  const agentPath = `${namespacePath}/agents/${created.data.id}`;
  const deployed = await ownerRequest("POST", agentPath + "/deploy");
  assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
  await waitFor("the OIDC owner's first Agent revision", async () => {
    const observed = await ownerRequest("GET", agentPath);
    assert.equal(observed.status, 200);
    return observed.data.activeRevisionId === deployed.data.id;
  });
  const ownerStatus = await ownerRequest("GET", agentPath + "/native-admin");
  assert.equal(ownerStatus.status, 200);
  assert.equal(ownerStatus.data.status, "available");
  assert.equal(ownerStatus.data.mode, "admin");

  const operatorRole = await role("OIDC chat operator", [
    { action: "read", resourceKind: "agent" },
    { action: "operate", resourceKind: "agent" },
  ]);
  await bind(carol, operatorRole, "agent", created.data.id);
  const operatorPage = await signIn("carol");
  const operatorRequest = requestFor(operatorPage);
  assert.equal((await operatorRequest("GET", "/api/auth/session")).data.user.id, carol.id);
  assert.equal(
    (await operatorRequest("GET", `${namespacePath}/agents/${topology.agent.id}`)).status,
    403,
  );
  assert.equal(
    (await operatorRequest("GET", `${namespacePath}/configurations/${configuration.data.id}`))
      .status,
    403,
  );
  const status = await operatorRequest("GET", agentPath + "/native-admin");
  assert.equal(status.status, 200);
  assert.equal(status.data.mode, "chat");
  const frames = [];
  const sentFrames = [];
  operatorPage.context().on("page", (page) =>
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).origin === status.data.origin.replace(/^http/, "ws")) {
        socket.on("framereceived", (frame) => frames.push({ ...frame, socket, page }));
        socket.on("framesent", (frame) => sentFrames.push({ ...frame, socket, page }));
      }
    }),
  );
  await operatorPage.goto(
    new URL(agentDetailPath({ agent: created.data, revision: deployed.data }), ingress.origin).href,
  );
  const nativePage = await openNativeAdminConsole(operatorPage, status.data.origin, "chat");
  const initialMarker = `oidc-chat-${randomUUID()}`;
  let initialReply;
  try {
    initialReply = await submitChatTurnWithAssistantProof(
      nativePage,
      initialMarker,
      frames,
      waitFor,
    );
  } catch (error) {
    await nativePage.screenshot({ path: join(artifacts, "oidc-chat-failure.png"), fullPage: true });
    throw error;
  }
  const lifecycle = await assertChatStreamStopAndResume({
    page: nativePage,
    initialReply,
    initialMarker,
    receivedFrames: frames,
    sentFrames,
    waitFor,
  });
  context.diagnostic(
    `OIDC chat: ${lifecycle.deltaCount} incremental model frames, exact-run Stop acknowledged and aborted, same persisted session reconnected and completed another real reply.`,
  );
  await assertChatAdministrationDenied(nativePage);
  const siblingTarget = expectedNativeAdminTarget(topology, ingress.origin, nativeDomain);
  const probe = await operatorPage.context().newPage();
  assert.equal((await probe.goto(siblingTarget.origin + "/healthz")).status(), 403);
  await probe.close();
  await nativePage.screenshot({ path: join(artifacts, "oidc-operator-chat.png"), fullPage: true });
  context.diagnostic(
    "Real Keycloak sign-in enabled ordinary-owner create/deploy and an exact-Agent operator model turn; native HTTP/WS administration and sibling access were denied.",
  );
}
