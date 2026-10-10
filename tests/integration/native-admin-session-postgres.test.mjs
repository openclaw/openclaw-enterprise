import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { createConnection } from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";

import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { authenticatedHeaders, cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import {
  ensureDevelopmentBootstrap,
  privateBootstrapDirectory,
} from "../helpers/bootstrap-installation.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantAgentSecretOperate } from "../helpers/postgres-harness-auth.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

import { nativeRolesGateway } from "../helpers/runtime-roles.mjs";
import {
  configuredRuntimeRoles,
  humanRuntimeAccess,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-access.ts";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const adminEmail = "postgres-admin@openclaw.local";
const adminPassword = "postgres-development-password";
const authSecret = "native-admin-postgres-auth-secret-minimum-32-bytes";
const publicOrigin = "https://console.example.test:9443";
const authBaseURL = publicOrigin;
const cookieDomain = "example.test";
const nativeDomain = `native-pg.${cookieDomain}`;
const nativeGatewayApiKey = `native-postgres-gateway-key-${randomUUID()}`;
// Production renews every 25 s and bounds each renewal at 5 s, which is the documented
// 30 s revocation bound. A short interval proves the same renewal path without the wait.
const leaseIntervalMs = 500;
const leaseRenewalTimeoutMs = 5_000;
const requiresPostgres = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL to a migrated disposable PostgreSQL database.",
};

function nativeOriginForAgent(installationId, namespaceId, agentId) {
  const publicUrl = new URL(publicOrigin);
  publicUrl.hostname = deriveNativeAdminHost(
    installationId,
    { namespaceId, id: agentId },
    nativeDomain,
  );
  return `${publicUrl.protocol}//${publicUrl.host}`;
}

function nativeAdminHarnessConfiguration(nativeOrigin) {
  return nativeRolesGateway(createHarnessConfiguration("openclaw", "gpt-4.1"), nativeOrigin);
}

function nativeComputeDriver(upstreamPort) {
  return {
    id: "native-admin-postgres-compute",
    capability: "compute",
    implementation: "native-admin-postgres-test-upstream",
    validateHarnessAuth() {},
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async retireRevision() {},
    listAgentRuntimeRoles(configuration) {
      return configuredRuntimeRoles(configuration);
    },
    getAgentRuntimeAccess(revision, principalId, runtimeRole) {
      return humanRuntimeAccess(
        revision,
        `wss://localhost:${upstreamPort}/people/namespaces/${revision.namespaceId}/agents/${revision.agentId}/`,
        principalId,
        runtimeRole,
      );
    },
    getGatewayEndpoint(revision) {
      return `wss://localhost:${upstreamPort}/namespaces/${revision.namespaceId}/agents/${revision.agentId}/`;
    },
  };
}

async function startNativeHttpsUpstream(t) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-native-admin-pg-upstream-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "tls.key");
  const certPath = join(directory, "tls.crt");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);

  const requests = [];
  const upgrades = [];
  const upgradedSockets = new Set();
  const cert = await readFile(certPath, "utf8");
  const server = createServer({ key: await readFile(keyPath), cert }, async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
    });
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "set-cookie": "native_session=must-not-leak; Path=/",
      "x-native-upstream": "reached",
    });
    response.end("native postgres upstream\n");
  });
  server.on("upgrade", (request, socket) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    upgrades.push({ url: request.url, headers: { ...request.headers } });
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "",
        "",
      ].join("\r\n"),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    // Successful reconnects may still be open; close owned upgrades before the server.
    for (const socket of upgradedSockets) {
      socket.destroy();
    }
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return { port: address.port, requests, upgrades, cert };
}

async function ensureBootstrap(t) {
  const observer = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  t.after(() => observer.end());
  const state = new PostgresPlatformState(observer);
  if ((await state.loadInstallation()) !== undefined) {
    return;
  }
  const directory = await privateBootstrapDirectory(t, "openclaw-native-admin-pg-bootstrap-");
  await ensureDevelopmentBootstrap(t, {
    databaseUrl,
    directory,
    email: adminEmail,
    password: adminPassword,
    authSecret,
    authBaseURL: "http://127.0.0.1",
    installationName: "Native admin PostgreSQL session test",
  });
}

async function createApi(t, label, upstreamPort, options = {}) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  let closed = false;
  t.after(async () => {
    if (!closed) {
      closed = true;
      await pool.end();
    }
  });
  const state = new PostgresPlatformState(pool);
  const installation = await state.loadInstallation();
  assert.ok(installation, "the native admin PostgreSQL suite requires a bootstrapped Installation");
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: installation.id,
    baseURL: authBaseURL,
    secret: authSecret,
    pool,
    secureCookies: true,
    sharedCookieDomain: cookieDomain,
  });
  const iamDriver = new NativeIAMDriver(state, {
    id: `native-admin-iam-${label}`,
  });
  const computeDriver = nativeComputeDriver(upstreamPort);
  const configurationDriver = options.configurationRoot
    ? new FilesystemConfigurationDriver(options.configurationRoot)
    : createTestConfigurationDriver({ id: `native-admin-configuration-${label}` });
  const secretDriver = createTestSecretDriver({
    id: `native-admin-secret-${label}`,
  });
  const controller = new OpenClawController(installation, {
    state,
    recordOperations: false,
  });
  for (const driver of [iamDriver, computeDriver, configurationDriver, secretDriver]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const app = createFastifyApp({
    controller,
    iamDriver,
    computeDriver,
    configurationDriver,
    secretDriver,
    resolveHarness: resolveApprovedHarness,
    auditSink: state.auditSink,
    auth,
    development: { enabled: false },
    publicOrigin,
    nativeAdmin: {
      enabled: options.nativeAdminEnabled ?? true,
      domain: nativeDomain,
      sharedCookieDomain: cookieDomain,
    },
    nativeAdminGatewayApiKey: async () => nativeGatewayApiKey,
    nativeAdminWebSocketLeaseIntervalMs: leaseIntervalMs,
  });
  app.addHook("onClose", async () => {
    if (!closed) {
      closed = true;
      await pool.end();
    }
  });
  return { app, auth, controller, iamDriver, state, pool };
}

async function inject(app, method, url, { session, headers = {}, body } = {}) {
  return app.inject({
    method,
    url,
    headers: {
      host: "127.0.0.1",
      ...(session === undefined ? {} : authenticatedHeaders(session)),
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function signIn(app, credentials = { email: adminEmail, password: adminPassword }) {
  const response = await inject(app, "POST", "/api/auth/sign-in/email", {
    body: { email: credentials.email, password: credentials.password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const setCookie = response.headers["set-cookie"];
  const session = {
    origin: authBaseURL,
    cookie: cookieHeaderFromSetCookie(
      Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [String(setCookie)],
    ),
  };
  assert.match(session.cookie, /(?:__Secure-)?openclaw_occ_shared\.session_token=/);
  return session;
}

async function createNativeAgent(api, session, upstream) {
  const adminAccount = await api.pool.query(`SELECT id FROM occ."user" WHERE email = $1 LIMIT 1`, [
    adminEmail,
  ]);
  assert.equal(adminAccount.rowCount, 1, "bootstrap administrator account must exist");
  const principal = (await api.state.loadNativeIAMState()).identities.find(
    (identity) =>
      identity.kind === "principal" &&
      identity.issuer === api.auth.issuer &&
      identity.subject === adminAccount.rows[0].id,
  );
  assert.ok(principal, "bootstrap administrator principal must exist");
  const namespaceResponse = await inject(api.app, "POST", "/namespaces", {
    session,
    body: { name: `Native admin PG ${randomUUID()}` },
  });
  assert.equal(namespaceResponse.statusCode, 201, namespaceResponse.body);
  const namespace = namespaceResponse.json().data;
  await api.controller.handleNamespaceLifecycle(principal.id, namespace.id, "ready");

  const configurationResponse = await inject(
    api.app,
    "POST",
    `/namespaces/${namespace.id}/configurations`,
    {
      session,
      body: {
        kind: "agent",
        values: createHarnessConfiguration("openclaw", "gpt-4.1"),
      },
    },
  );
  assert.equal(configurationResponse.statusCode, 201, configurationResponse.body);
  const configuration = configurationResponse.json().data;

  const secretResponse = await inject(api.app, "POST", `/namespaces/${namespace.id}/secrets`, {
    session,
    body: {
      name: `Native admin harness ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    },
  });
  assert.equal(secretResponse.statusCode, 201, secretResponse.body);
  const secret = secretResponse.json().data;

  const agentResponse = await inject(api.app, "POST", `/namespaces/${namespace.id}/agents`, {
    session,
    body: {
      name: `Native admin Agent ${randomUUID()}`,
      configurationId: configuration.id,
      harnessAuth: { method: "api_key", source: secret.ref },
    },
  });
  assert.equal(agentResponse.statusCode, 201, agentResponse.body);
  const agent = agentResponse.json().data;
  const nativeOrigin = nativeOriginForAgent(api.controller.installation.id, namespace.id, agent.id);
  const compatibleConfiguration = await inject(
    api.app,
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${configuration.id}`,
    {
      session,
      body: { values: nativeAdminHarnessConfiguration(nativeOrigin) },
    },
  );
  assert.equal(compatibleConfiguration.statusCode, 200, compatibleConfiguration.body);
  await grantAgentSecretOperate(api.pool, agent, secret.ref.id);

  const roleResponse = await inject(api.app, "POST", `/namespaces/${namespace.id}/iam/roles`, {
    session,
    body: { permissions: [{ action: "use", resourceKind: "agent" }] },
  });
  assert.equal(roleResponse.statusCode, 201, roleResponse.body);
  const catalogResponse = await inject(
    api.app,
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/runtime-roles`,
    { session },
  );
  assert.equal(catalogResponse.statusCode, 200, catalogResponse.body);
  const bindingResponse = await inject(
    api.app,
    "POST",
    `/namespaces/${namespace.id}/iam/access-bindings`,
    {
      session,
      body: {
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: roleResponse.json().data.id,
        resourceKind: "agent",
        resourceId: agent.id,
        runtimeRole: "administrator",
        runtimeRoleConfiguration: catalogResponse.json().data.configuration,
      },
    },
  );
  assert.equal(bindingResponse.statusCode, 201, bindingResponse.body);
  const revision = await api.controller.deployAgent(
    principal.id,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedHarness,
  );
  await api.state.transact((unit) =>
    unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id),
  );

  const status = await inject(
    api.app,
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
    { session },
  );
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().data.status, "available");
  assert.match(status.json().data.host, new RegExp(`\\.${nativeDomain.replaceAll(".", "\\.")}$`));
  assert.equal(upstream.requests.length, 0);
  return {
    namespace,
    agent,
    revision,
    native: status.json().data,
    principal,
    runtimeBinding: bindingResponse.json().data,
  };
}

async function nativeGet(api, native, cookie, path = "/settings/profile?tab=devices") {
  return inject(api.app, "GET", path, {
    headers: {
      host: new URL(native.origin).host,
      cookie,
      origin: native.origin,
    },
  });
}

async function createReadOperateSession(api, namespaceId, agentId, label) {
  const suffix = randomUUID();
  const credentials = {
    email: `${label}-${suffix}@openclaw.local`,
    password: `native-admin-denial-${suffix}`,
    name: `Native admin ${label}`,
  };
  const account = await api.auth.createAccount(credentials);
  const roleId = `role-${label}-${suffix}`;
  const bindingId = `binding-${label}-${suffix}`;
  const seed = api.auth.principalSeed(account, { roleId });
  const client = await api.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        roleId,
        namespaceId,
        `Native admin ${label}`,
        JSON.stringify([
          { action: "read", resourceKind: "agent" },
          { action: "operate", resourceKind: "agent" },
        ]),
      ],
    );
    await client.query(
      `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
       VALUES ($1, NULL, NULL, 'principal', $2, $3)`,
      [seed.principal.id, seed.principal.issuer, seed.principal.subject],
    );
    await client.query(
      `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, NULL, $4, 'agent', $5)`,
      [bindingId, namespaceId, seed.principal.id, roleId, agentId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { session: await signIn(api.app, credentials), principal: seed.principal };
}

function trustLocalUpstreamCertificate(t, cert) {
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, cert]);
  t.after(() => setDefaultCACertificates(previous));
}

async function listen(app) {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return address.port;
}

async function openNativeWebSocket(port, native, cookie, path = "/session/socket") {
  const socket = createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");
  const key = randomBytes(16).toString("base64");
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: ${new URL(native.origin).host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `Origin: ${native.origin}`,
      `Cookie: ${cookie}`,
      "",
      "",
    ].join("\r\n"),
  );
  let received = "";
  const onData = (chunk) => {
    received += chunk.toString("latin1");
  };
  socket.on("data", onData);
  const deadline = Date.now() + 5_000;
  while (!received.includes("\r\n\r\n") && Date.now() < deadline) {
    await delay(25);
  }
  assert.match(received, /^HTTP\/1\.1 101 /);
  return socket;
}

async function assertNativeWebSocketRejected(port, native, cookie, options = {}) {
  const socket = createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");
  const key = randomBytes(16).toString("base64");
  const origin = Object.hasOwn(options, "origin") ? options.origin : native.origin;
  const headers = [
    "GET /session/socket HTTP/1.1",
    `Host: ${new URL(native.origin).host}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    `Cookie: ${cookie}`,
  ];
  if (origin !== undefined) {
    headers.push(`Origin: ${origin}`);
  }
  socket.write([...headers, "", ""].join("\r\n"));
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk.toString("latin1");
  });
  const closed = once(socket, "close").then(() => true);
  const deadline = Date.now() + 2_000;
  while (!received.includes("\r\n\r\n") && !socket.destroyed && Date.now() < deadline) {
    if (await Promise.race([closed, delay(25).then(() => false)])) {
      break;
    }
  }
  socket.destroy();
  assert.doesNotMatch(received, /^HTTP\/1\.1 101 /);
}

// The socket must survive renewals while its admission holds, then close at the first
// renewal after the mutation: within one interval plus the renewal's own time bound.
async function assertSocketClosesAfterMutation(socket, mutate) {
  await delay(leaseIntervalMs * 2.5);
  assert.equal(socket.destroyed, false, "an admitted socket must survive lease renewals");
  const timeoutMs = leaseIntervalMs + leaseRenewalTimeoutMs;
  let closedAt;
  const closed = Promise.race([
    once(socket, "close").then(() => {
      closedAt = Date.now();
      return true;
    }),
    delay(10_000, false, { ref: false }),
  ]);
  await mutate();
  const mutatedAt = Date.now();
  assert.equal(await closed, true, "socket remained open after the mutation");
  const closedAfterMs = Math.max(0, closedAt - mutatedAt);
  assert.ok(
    closedAfterMs <= timeoutMs,
    `lease close took ${closedAfterMs}ms (bound ${timeoutMs}ms)`,
  );
  return closedAfterMs;
}

async function waitForAuditActions(pool, namespaceId, agentId, actions) {
  const remaining = new Set(actions);
  const deadline = Date.now() + 5_000;
  let rows = [];
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT action, actor_id, outcome, details
         FROM occ.audit_events
        WHERE namespace_id = $1
          AND resource_kind = 'agent'
          AND resource_id = $2
          AND action = ANY($3::text[])
        ORDER BY occurred_at, id`,
      [namespaceId, agentId, actions],
    );
    rows = result.rows;
    for (const row of rows) {
      remaining.delete(row.action);
    }
    if (remaining.size === 0) {
      break;
    }
    await delay(50);
  }
  assert.deepEqual([...remaining], [], `missing audit actions: ${[...remaining].join(", ")}`);
  for (const action of actions) {
    const row = rows.find((candidate) => candidate.action === action);
    assert.ok(row, `${action} audit row must exist`);
    assert.equal(row.outcome, "success", `${action} audit outcome`);
    assert.ok(row.actor_id, `${action} audit must retain the human actor id`);
  }
  return rows;
}

async function waitForAuthorizationDenialAudit(
  pool,
  namespaceId,
  agentId,
  action,
  actorId,
  options = {},
) {
  const deadline = Date.now() + 5_000;
  let row;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT id, kind, action, actor_id, outcome, details
         FROM occ.audit_events
        WHERE namespace_id = $1
          AND resource_kind = 'agent'
          AND resource_id = $2
          AND kind = 'authorization_denial'
          AND action = $3
          AND ($4::text IS NULL OR actor_id = $4)
          AND ($5::text IS NULL OR id <> $5)
          AND ($6::boolean IS NULL OR (details->'nativeAdmin' ? 'revisionId') = $6)
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`,
      [
        namespaceId,
        agentId,
        action,
        actorId ?? null,
        options.excludeId ?? null,
        options.leaseRenewal ?? null,
      ],
    );
    row = result.rows[0];
    if (row !== undefined) {
      break;
    }
    await delay(50);
  }
  assert.ok(row, `${action} authorization-denial audit row must exist`);
  assert.equal(row.kind, "authorization_denial");
  assert.equal(row.outcome, "denied");
  assert.equal(row.details?.__occAuditMetadata?.reasonCode, "AUTHORIZATION_DENIED");
  if (actorId !== undefined) {
    assert.equal(row.actor_id, actorId);
  } else {
    assert.ok(row.actor_id, `${action} denial audit must retain the human actor id`);
  }
  return row;
}

function nativeAdminAuditDetails(row, action) {
  const details = row.details?.nativeAdmin;
  assert.equal(typeof details, "object", `${action} audit must include nativeAdmin details`);
  assert.notEqual(details, null, `${action} audit must include nativeAdmin details`);
  return details;
}

async function assertSocketAuditCloseReason(scenario, closureReason, options = {}) {
  const { connect, close } = await waitFor(
    "the same socket's connect and close audits",
    async () => {
      const result = await scenario.apiA.pool.query(
        `SELECT action, actor_id, outcome, details
         FROM occ.audit_events
        WHERE namespace_id = $1 AND resource_kind = 'agent' AND resource_id = $2
          AND action = ANY($3::text[])
        ORDER BY occurred_at, id`,
        [
          scenario.namespace.id,
          scenario.agent.id,
          [
            "openclaw.agents.native_admin.websocket.connect",
            "openclaw.agents.native_admin.websocket.close",
          ],
        ],
      );
      const connect = result.rows.find(
        (row) =>
          row.action === "openclaw.agents.native_admin.websocket.connect" &&
          row.details?.nativeAdmin?.connectionId !== options.excludeConnectionId,
      );
      const close =
        connect &&
        result.rows.find(
          (row) =>
            row.action === "openclaw.agents.native_admin.websocket.close" &&
            row.details?.nativeAdmin?.connectionId === connect.details?.nativeAdmin?.connectionId,
        );
      return close ? { connect, close } : undefined;
    },
  );
  for (const row of [connect, close]) {
    assert.equal(row.outcome, "success");
    assert.equal(row.actor_id, scenario.principal.id);
  }
  const connectDetails = nativeAdminAuditDetails(connect, connect.action);
  const closeDetails = nativeAdminAuditDetails(close, close.action);
  assert.equal(typeof connectDetails.connectionId, "string");
  assert.ok(connectDetails.connectionId.length > 0);
  assert.equal(closeDetails.connectionId, connectDetails.connectionId);
  assert.equal(closeDetails.closeReason, closureReason);
  for (const details of [connectDetails, closeDetails]) {
    assert.equal(details.parentSessionId, scenario.parentSession.id);
    assert.equal(details.revisionId, scenario.revision.id);
    assert.equal(details.host, scenario.native.host);
  }
  return connectDetails.connectionId;
}

async function parentSessionRow(api) {
  const storedSession = await api.pool.query(
    `SELECT session.id, session.user_id, session.expires_at
       FROM occ.session AS session
       JOIN occ."user" AS account ON account.id = session.user_id
      WHERE account.email = $1
      ORDER BY session.created_at DESC
      LIMIT 1`,
    [adminEmail],
  );
  assert.equal(storedSession.rowCount, 1, "sign-in must persist a parent session row");
  return storedSession.rows[0];
}

async function openNativeAdminSocketScenario(t, label, options = {}) {
  await ensureBootstrap(t);
  const upstream = await startNativeHttpsUpstream(t);
  trustLocalUpstreamCertificate(t, upstream.cert);
  const [apiA, apiB] = await Promise.all([
    createApi(t, `${label}-a`, upstream.port, options),
    createApi(t, `${label}-b`, upstream.port, options),
  ]);
  t.after(() => Promise.allSettled([apiA.app.close(), apiB.app.close()]));
  const session = await signIn(apiA.app);
  const parentSession = await parentSessionRow(apiA);
  const { namespace, agent, revision, native, principal, runtimeBinding } = await createNativeAgent(
    apiA,
    session,
    upstream,
  );
  const nativeCookie = session.cookie;
  const port = await listen(apiB.app);
  const socket = await openNativeWebSocket(port, native, nativeCookie);
  t.after(() => socket.destroy());
  assert.equal(upstream.upgrades.length, 1);
  assert.equal(
    upstream.upgrades[0].url,
    `/people/namespaces/${namespace.id}/agents/${agent.id}/session/socket`,
  );
  assert.equal(upstream.upgrades[0].headers.origin, native.origin);
  assert.equal(upstream.upgrades[0].headers["x-api-key"], nativeGatewayApiKey);
  await waitForAuditActions(apiA.pool, namespace.id, agent.id, [
    "openclaw.agents.native_admin.websocket.connect",
  ]);
  return {
    upstream,
    apiA,
    apiB,
    session,
    parentSession,
    namespace,
    agent,
    revision,
    native,
    nativeCookie,
    principal,
    runtimeBinding,
    port,
    socket,
  };
}

async function assertRevokedHttp(scenario) {
  const requestsBefore = scenario.upstream.requests.length;
  const upgradesBefore = scenario.upstream.upgrades.length;
  const denied = await nativeGet(
    scenario.apiB,
    scenario.native,
    scenario.nativeCookie,
    "/after-revocation",
  );
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().error.code, "FORBIDDEN");
  assert.equal(
    scenario.upstream.requests.length,
    requestsBefore,
    "denied HTTP must not reach the gateway",
  );
  assert.equal(scenario.upstream.upgrades.length, upgradesBefore);
  return denied;
}

test(
  "PostgreSQL native admin shared session and HTTP proxy work across two OCC API replicas",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    await ensureBootstrap(t);
    const upstream = await startNativeHttpsUpstream(t);
    trustLocalUpstreamCertificate(t, upstream.cert);
    const [apiA, apiB] = await Promise.all([
      createApi(t, "a", upstream.port),
      createApi(t, "b", upstream.port),
    ]);
    t.after(() => Promise.allSettled([apiA.app.close(), apiB.app.close()]));
    const session = await signIn(apiA.app);
    const { namespace, agent, revision, native } = await createNativeAgent(apiA, session, upstream);
    assert.equal(native.activeRevisionId, revision.id);
    assert.equal(new URL(native.url).origin, native.origin);
    assert.equal(native.bootstrapUrl, undefined);
    const nativeCookie = session.cookie;
    const proxied = await nativeGet(apiB, native, nativeCookie);
    assert.equal(proxied.statusCode, 200, proxied.body);
    assert.equal(proxied.headers["x-native-upstream"], "reached");
    assert.equal(proxied.headers["set-cookie"], undefined);
    assert.equal(upstream.requests.length, 1);
    assert.equal(
      upstream.requests[0].url,
      `/people/namespaces/${namespace.id}/agents/${agent.id}/settings/profile?tab=devices`,
    );
    assert.equal(upstream.requests[0].headers.origin, native.origin);
    assert.equal(upstream.requests[0].headers["x-api-key"], nativeGatewayApiKey);
    assert.equal(upstream.requests[0].headers.cookie, undefined);

    const keyOnly = await inject(apiB.app, "GET", "/", {
      headers: {
        host: new URL(native.origin).host,
        origin: native.origin,
        "x-api-key": "occ_not-a-human-session",
      },
    });
    assert.equal(keyOnly.statusCode, 403, keyOnly.body);

    const port = await listen(apiB.app);
    const upgradesBeforeOriginChecks = upstream.upgrades.length;
    await assertNativeWebSocketRejected(port, native, nativeCookie, { origin: undefined });
    await assertNativeWebSocketRejected(port, native, nativeCookie, { origin: "null" });
    await assertNativeWebSocketRejected(port, native, nativeCookie, { origin: publicOrigin });
    assert.equal(upstream.upgrades.length, upgradesBeforeOriginChecks);

    const limited = await createReadOperateSession(
      apiA,
      namespace.id,
      agent.id,
      "native-admin-read-operate",
    );
    const deniedStatus = await inject(
      apiA.app,
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
      { session: limited.session },
    );
    assert.equal(deniedStatus.statusCode, 403, deniedStatus.body);
    await waitForAuthorizationDenialAudit(
      apiA.pool,
      namespace.id,
      agent.id,
      "openclaw.agents.native_admin.read",
      limited.principal.id,
    );
  },
);

test(
  "PostgreSQL native admin WebSocket lease closes at the next renewal after parent logout",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "logout");
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      const signOut = await inject(scenario.apiA.app, "POST", "/api/auth/sign-out", {
        session: scenario.session,
      });
      assert.equal(signOut.statusCode, 200, signOut.body);
    });
    t.diagnostic(`parent logout closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "session_invalid");
    await assertRevokedHttp(scenario);
  },
);

test(
  "PostgreSQL native admin WebSocket lease closes at the next renewal after parent session expiry",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "expiry");
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      const expired = await scenario.apiA.pool.query(
        `UPDATE occ.session
            SET expires_at = statement_timestamp() - interval '1 second',
                updated_at = statement_timestamp()
          WHERE id = $1`,
        [scenario.parentSession.id],
      );
      assert.equal(expired.rowCount, 1);
    });
    t.diagnostic(`parent session expiry closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "session_invalid");
    await assertRevokedHttp(scenario);
  },
);

test(
  "PostgreSQL native admin WebSocket lease closes at the next renewal after IAM use restriction",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "iam-restriction");
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      const restricted = await scenario.apiA.pool.query(
        `INSERT INTO occ.iam_restrictions
           (id, namespace_id, action, resource_kind, resource_id, effect)
         VALUES ($1, $2, 'use', 'agent', $3, 'deny')`,
        [`restriction-native-admin-${randomUUID()}`, scenario.namespace.id, scenario.agent.id],
      );
      assert.equal(restricted.rowCount, 1);
    });
    t.diagnostic(`IAM use restriction closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "authorization_denied");
    // Lease renewals check the socket's revision, so their denials record it; the HTTP
    // denial carries none. That keeps a second, overlapping renewal's denial from passing
    // for the HTTP one.
    const leaseDenial = await waitForAuthorizationDenialAudit(
      scenario.apiA.pool,
      scenario.namespace.id,
      scenario.agent.id,
      "openclaw.agents.native_admin.proxy.authorize",
      scenario.principal.id,
      { leaseRenewal: true },
    );
    assert.equal(leaseDenial.details.nativeAdmin.revisionId, scenario.revision.id);
    await assertRevokedHttp(scenario);
    await waitForAuthorizationDenialAudit(
      scenario.apiA.pool,
      scenario.namespace.id,
      scenario.agent.id,
      "openclaw.agents.native_admin.proxy.authorize",
      scenario.principal.id,
      { excludeId: leaseDenial.id, leaseRenewal: false },
    );
  },
);

test(
  "PostgreSQL native admin WebSocket lease closes as a dependency failure during an IAM outage",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "iam-outage");
    // The replica holding the socket loses its IAM Driver at the next lease renewal. An outage
    // is not a revocation: the close names a dependency failure and writes no denial audit.
    const authorize = scenario.apiB.iamDriver.authorize;
    t.after(() => {
      scenario.apiB.iamDriver.authorize = authorize;
    });
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      scenario.apiB.iamDriver.authorize = async () => {
        throw new Error("IAM outage");
      };
    });
    t.diagnostic(`IAM outage closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "dependency_failure");
    const denials = await scenario.apiA.pool.query(
      `SELECT count(*)::int AS count FROM occ.audit_events
        WHERE namespace_id = $1 AND resource_id = $2 AND kind = 'authorization_denial'`,
      [scenario.namespace.id, scenario.agent.id],
    );
    assert.equal(denials.rows[0].count, 0);
  },
);

test(
  "PostgreSQL native admin WebSocket lease closes at the next renewal after Agent stop",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "stop");
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      const stopped = await inject(
        scenario.apiA.app,
        "POST",
        `/namespaces/${scenario.namespace.id}/agents/${scenario.agent.id}/stop`,
        { session: scenario.session },
      );
      assert.equal(stopped.statusCode, 202, stopped.body);
    });
    t.diagnostic(`Agent stop closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "agent_unavailable");
    await assertRevokedHttp(scenario);
  },
);

test(
  "PostgreSQL native admin WebSocket lease closes at the next renewal after active revision replacement",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "revision");
    let nextRevision;
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      nextRevision = await scenario.apiA.controller.deployAgent(
        scenario.principal.id,
        { namespaceId: scenario.namespace.id, agentId: scenario.agent.id },
        resolveApprovedHarness,
      );
      assert.notEqual(nextRevision.id, scenario.revision.id);
      await scenario.apiA.state.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(
          scenario.namespace.id,
          scenario.agent.id,
          scenario.revision.id,
          nextRevision.id,
        ),
      );
    });
    t.diagnostic(`active revision replacement closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "revision_changed");
    assert.ok(nextRevision, "revision replacement must create a successor revision");

    const reconnectedHttp = await nativeGet(
      scenario.apiB,
      scenario.native,
      scenario.nativeCookie,
      "/after-revision",
    );
    assert.equal(reconnectedHttp.statusCode, 200, reconnectedHttp.body);
    const reopened = await openNativeWebSocket(
      scenario.port,
      scenario.native,
      scenario.nativeCookie,
      "/session/reconnected",
    );
    t.after(() => reopened.destroy());
    const latestConnect = await waitFor(
      "reconnected WebSocket audit on replacement revision",
      async () => {
        const result = await scenario.apiA.pool.query(
          `SELECT details
           FROM occ.audit_events
          WHERE namespace_id = $1
            AND resource_kind = 'agent'
            AND resource_id = $2
            AND action = 'openclaw.agents.native_admin.websocket.connect'
            AND details->'nativeAdmin'->>'revisionId' = $3
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1`,
          [scenario.namespace.id, scenario.agent.id, nextRevision.id],
        );
        return result.rows[0];
      },
      5_000,
    );
    assert.equal(
      latestConnect.details.nativeAdmin.revisionId,
      nextRevision.id,
      "shared session reconnect must bind the current active revision",
    );
  },
);

test(
  "PostgreSQL native admin WebSocket closes on API shutdown and disabled redeploy denies reuse",
  { ...requiresPostgres, timeout: 30_000 },
  async (t) => {
    const scenario = await openNativeAdminSocketScenario(t, "shutdown-disabled");
    const closedAfterMs = await assertSocketClosesAfterMutation(scenario.socket, async () => {
      await scenario.apiB.app.close();
    });
    t.diagnostic(`API shutdown closed native admin WebSocket in ${closedAfterMs}ms`);
    await assertSocketAuditCloseReason(scenario, "shutdown");

    const disabledApi = await createApi(t, "shutdown-disabled-off", scenario.upstream.port, {
      nativeAdminEnabled: false,
    });
    t.after(() => disabledApi.app.close());
    const denied = await nativeGet(disabledApi, scenario.native, scenario.nativeCookie);
    assert.equal(denied.statusCode, 403, denied.body);
  },
);

test(
  "PostgreSQL role changes and revocation close existing proxy leases across replicas",
  { ...requiresPostgres, timeout: 75_000 },
  async (t) => {
    // Both replicas read the same real Configuration store as well as PostgreSQL IAM state.
    const configurationRoot = await privateBootstrapDirectory(
      t,
      "openclaw-native-role-configurations-",
    );
    const scenario = await openNativeAdminSocketScenario(t, "role-change", { configurationRoot });
    const policyPath = `/namespaces/${scenario.namespace.id}/iam/access-bindings`;
    const catalog = await inject(
      scenario.apiA.app,
      "GET",
      `/namespaces/${scenario.namespace.id}/agents/${scenario.agent.id}/runtime-roles`,
      { session: scenario.session },
    );
    assert.equal(catalog.statusCode, 200, catalog.body);
    // The duplicate must surface as a conflict and roll back without replacing the assignment.
    const duplicate = await inject(scenario.apiA.app, "POST", policyPath, {
      session: scenario.session,
      body: {
        subjectKind: "identity",
        subjectId: scenario.principal.id,
        roleId: scenario.runtimeBinding.roleId,
        resourceKind: "agent",
        resourceId: scenario.agent.id,
        runtimeRole: "reviewer",
        runtimeRoleConfiguration: catalog.json().data.configuration,
      },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(duplicate.json().error.code, "RESOURCE_CONFLICT");
    const retained = await inject(
      scenario.apiA.app,
      "GET",
      `${policyPath}/${scenario.runtimeBinding.id}`,
      {
        session: scenario.session,
      },
    );
    assert.equal(retained.statusCode, 200, retained.body);
    assert.deepEqual(retained.json().data, scenario.runtimeBinding);
    const bindings = await inject(scenario.apiA.app, "GET", policyPath, {
      session: scenario.session,
    });
    assert.equal(bindings.statusCode, 200, bindings.body);
    assert.deepEqual(
      bindings
        .json()
        .data.filter(
          (binding) =>
            binding.subjectId === scenario.principal.id &&
            binding.resourceId === scenario.agent.id &&
            binding.runtimeRole !== undefined,
        )
        .map((binding) => binding.id),
      [scenario.runtimeBinding.id],
    );
    // A Configuration save on another replica invalidates the reviewed catalog without changing the live lease.
    const configuration = await inject(
      scenario.apiB.app,
      "GET",
      `/namespaces/${scenario.namespace.id}/configurations/${scenario.agent.configurationId}`,
      { session: scenario.session },
    );
    assert.equal(configuration.statusCode, 200, configuration.body);
    const saved = await inject(
      scenario.apiB.app,
      "PATCH",
      `/namespaces/${scenario.namespace.id}/configurations/${scenario.agent.configurationId}`,
      {
        session: scenario.session,
        body: { values: configuration.json().data.values },
      },
    );
    assert.equal(saved.statusCode, 200, saved.body);
    const stale = await inject(
      scenario.apiA.app,
      "PATCH",
      `${policyPath}/${scenario.runtimeBinding.id}/runtime-role`,
      {
        session: scenario.session,
        body: {
          runtimeRole: "reviewer",
          runtimeRoleConfiguration: catalog.json().data.configuration,
        },
      },
    );
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(
      (await nativeGet(scenario.apiB, scenario.native, scenario.nativeCookie)).statusCode,
      200,
    );
    assert.equal(scenario.upstream.requests.at(-1).headers["x-occ-role"], "administrator");
    const freshCatalog = await inject(
      scenario.apiA.app,
      "GET",
      `/namespaces/${scenario.namespace.id}/agents/${scenario.agent.id}/runtime-roles`,
      { session: scenario.session },
    );
    assert.equal(freshCatalog.statusCode, 200, freshCatalog.body);
    await assertSocketClosesAfterMutation(scenario.socket, async () => {
      const changed = await inject(
        scenario.apiA.app,
        "PATCH",
        `/namespaces/${scenario.namespace.id}/iam/access-bindings/${scenario.runtimeBinding.id}/runtime-role`,
        {
          session: scenario.session,
          body: {
            runtimeRole: "reviewer",
            runtimeRoleConfiguration: freshCatalog.json().data.configuration,
          },
        },
      );
      assert.equal(changed.statusCode, 200, changed.body);
      assert.equal(changed.json().data.runtimeRole, "reviewer");
    });
    const previousConnectionId = await assertSocketAuditCloseReason(scenario, "role_changed");
    // A new request receives the new role immediately; no broad administrator fallback remains.
    assert.equal(
      (await nativeGet(scenario.apiB, scenario.native, scenario.nativeCookie)).statusCode,
      200,
    );
    assert.equal(scenario.upstream.requests.at(-1).headers["x-occ-role"], "reviewer");
    const nextSocket = await openNativeWebSocket(
      scenario.port,
      scenario.native,
      scenario.nativeCookie,
    );
    t.after(() => nextSocket.destroy());
    assert.equal(scenario.upstream.upgrades.at(-1).headers["x-occ-role"], "reviewer");
    await assertSocketClosesAfterMutation(nextSocket, async () => {
      const removed = await inject(
        scenario.apiA.app,
        "DELETE",
        `/namespaces/${scenario.namespace.id}/iam/access-bindings/${scenario.runtimeBinding.id}`,
        { session: scenario.session },
      );
      assert.equal(removed.statusCode, 204, removed.body);
    });
    await assertSocketAuditCloseReason(scenario, "authorization_denied", {
      excludeConnectionId: previousConnectionId,
    });
    const leaseDenial = await waitForAuthorizationDenialAudit(
      scenario.apiA.pool,
      scenario.namespace.id,
      scenario.agent.id,
      "openclaw.agents.native_admin.proxy.authorize",
      scenario.principal.id,
    );
    await assertRevokedHttp(scenario);
    await waitForAuthorizationDenialAudit(
      scenario.apiA.pool,
      scenario.namespace.id,
      scenario.agent.id,
      "openclaw.agents.native_admin.proxy.authorize",
      scenario.principal.id,
      { excludeId: leaseDenial.id },
    );
  },
);

test(
  "PostgreSQL persists only one exact human assignment and limits updates to the runtime role",
  requiresPostgres,
  async (t) => {
    await ensureBootstrap(t);
    const upstream = await startNativeHttpsUpstream(t);
    const api = await createApi(t, "constraints", upstream.port);
    t.after(() => api.app.close());
    const session = await signIn(api.app);
    const scenario = await createNativeAgent(api, session, upstream);
    const copy = (id, subjectId, resourceId) =>
      api.pool.query(
        `
    INSERT INTO occ.iam_access_bindings
      (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id, runtime_role)
    SELECT $1, namespace_id, $2, role_id, resource_kind, $3, runtime_role
      FROM occ.iam_access_bindings WHERE id = $4`,
        [id, subjectId, resourceId, scenario.runtimeBinding.id],
      );
    await assert.rejects(
      copy(`binding-${randomUUID()}`, scenario.principal.id, scenario.agent.id),
      (error) =>
        error.code === "23505" && error.constraint === "iam_access_bindings_runtime_assignment",
    );
    await assert.rejects(
      copy(`binding-${randomUUID()}`, scenario.agent.servicePrincipalId, scenario.agent.id),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      copy(`binding-${randomUUID()}`, scenario.principal.id, null),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      api.pool.query(
        "UPDATE occ.iam_access_bindings SET runtime_role = ' reviewer ' WHERE id = $1",
        [scenario.runtimeBinding.id],
      ),
      (error) => error.code === "23514",
    );
    // The application may change only the native assignment; OCE Role replacement remains immutable.
    await assert.rejects(
      api.pool.query("UPDATE occ.iam_access_bindings SET role_id = role_id WHERE id = $1", [
        scenario.runtimeBinding.id,
      ]),
      (error) => error.code === "42501",
    );
    const persisted = await api.pool.query(
      "SELECT runtime_role FROM occ.iam_access_bindings WHERE id = $1",
      [scenario.runtimeBinding.id],
    );
    assert.equal(persisted.rows[0].runtime_role, "administrator");
  },
);
