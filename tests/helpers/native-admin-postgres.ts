import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { IncomingHttpHeaders } from "node:http";
import type { TestContext } from "node:test";
import type {
  ComputeDriver,
  PermissionAction,
  ConfigurationDriver,
  SecretDriver,
} from "../../packages/contracts/src/index.ts";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

import { createPostgresControllerAuth } from "./password-hasher.mjs";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";
import { cookieHeaderFromSetCookie } from "./auth-session.mjs";
import { injectJson } from "./inject-json.mjs";
import {
  ensureDevelopmentBootstrap,
  privateBootstrapDirectory,
} from "./bootstrap-installation.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { grantAgentSecretOperate } from "./postgres-harness-auth.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";
import { waitUntil } from "./wait-for.mjs";

type NativeApp = ReturnType<typeof createFastifyApp>;

// The JavaScript helper does not infer its optional body and session properties.
const inject: (
  app: NativeApp,
  method: "GET" | "POST" | "PATCH",
  url: string,
  options: { body?: unknown; session?: NativeSession; headers?: Record<string, string> },
) => ReturnType<NativeApp["inject"]> = injectJson;

interface NativeSession {
  origin: string;
  sessionKey: string;
  cookie: string;
}
interface NativeTarget {
  origin: string;
}
interface UpstreamRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
}
interface NativeApiOptions {
  origin?: string;
  exchange?: boolean;
  nativeAdminEnabled?: boolean;
}
type NativeApi = Awaited<ReturnType<typeof createApi>>;
type NativeUpstream = Awaited<ReturnType<typeof startNativeHttpsUpstream>>;

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
export const adminEmail = "postgres-admin@openclaw.local";
const adminPassword = "postgres-development-password";
const authSecret = "native-admin-postgres-auth-secret-minimum-32-bytes";
export const publicOrigin = "https://console.example.test:9443";
const authBaseURL = publicOrigin;
const cookieDomain = "example.test";
export const nativeDomain = `native-pg.${cookieDomain}`;
export const nativeGatewayApiKey = `native-postgres-gateway-key-${randomUUID()}`;
// Production renews every 25 s and bounds each renewal at 5 s, which is the documented
// 30 s revocation bound. A short interval proves the same renewal path without the wait.
const leaseIntervalMs = 500;
const leaseRenewalTimeoutMs = 5_000;
export const requiresPostgres = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL to a migrated disposable PostgreSQL database.",
};

function nativeOriginForAgent(
  installationId: string,
  namespaceId: string,
  agentId: string,
  origin: string,
) {
  const publicUrl = new URL(origin);
  publicUrl.hostname = deriveNativeAdminHost(
    installationId,
    { namespaceId, id: agentId },
    nativeDomain,
  );
  return `${publicUrl.protocol}//${publicUrl.host}`;
}

function nativeAdminHarnessConfiguration(nativeOrigin: string) {
  const configuration = createHarnessConfiguration("openclaw", "gpt-4.1");
  return {
    ...configuration,
    gateway: {
      ...configuration.gateway,
      controlUi: { enabled: true, allowedOrigins: [nativeOrigin] },
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-occ-identity",
          allowUsers: ["occ-workspace-files"],
          deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
        },
        identityScopes: { "occ-workspace-files": ["operator.admin"] },
      },
    },
  };
}

function nativeComputeDriver(upstreamPort: number): ComputeDriver {
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
    async stopRevision() {
      throw new Error("This passive native-admin fixture does not stop revisions.");
    },
    getGatewayEndpoint(revision) {
      return `wss://localhost:${upstreamPort}/namespaces/${revision.namespaceId}/agents/${revision.agentId}/`;
    },
  };
}

export async function startNativeHttpsUpstream(t: TestContext) {
  const directory = await temporaryDirectory(t, "openclaw-native-admin-pg-upstream-");
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
      `subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:console.example.test,DNS:*.${nativeDomain}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    generated.status,
    0,
    generated.stderr || generated.error?.message || "openssl failed",
  );

  const requests: UpstreamRequest[] = [];
  const upgrades: Omit<UpstreamRequest, "method">[] = [];
  const upgradedSockets = new Set<Duplex>();
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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    requests,
    upgrades,
    cert,
    key: await readFile(keyPath),
    directory,
    certPath,
  };
}

export async function ensureBootstrap(t: TestContext) {
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

export async function createApi(
  t: TestContext,
  label: string,
  upstreamPort: number,
  options: NativeApiOptions = {},
) {
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
  const iamDriver = new NativeIAMDriver(state, {
    id: `native-admin-iam-${label}`,
  });
  const origin = options.origin ?? publicOrigin;
  const recoveryUserId = options.exchange
    ? (await pool.query<{ id: string }>('SELECT id FROM occ."user" WHERE email=$1', [adminEmail]))
        .rows[0]!.id
    : undefined;
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: installation.id,
    baseURL: origin,
    secret: authSecret,
    pool,
    secureCookies: true,
    ...(options.exchange
      ? {
          state,
          iamDriver,
          github: {
            clientId: "native-browser-fixture",
            clientSecret: "native-browser-fixture-secret",
            recoveryUserId,
          },
        }
      : { sharedCookieDomain: cookieDomain }),
  });
  const computeDriver = nativeComputeDriver(upstreamPort);
  const configurationDriver = createTestConfigurationDriver({
    id: `native-admin-configuration-${label}`,
  }) as ConfigurationDriver;
  const secretDriver = createTestSecretDriver({
    id: `native-admin-secret-${label}`,
  }) as SecretDriver;
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
    publicOrigin: origin,
    nativeAdmin: {
      enabled: options.nativeAdminEnabled ?? true,
      domain: nativeDomain,
      ...(options.exchange
        ? { sessionMode: "host-only-exchange" }
        : { sharedCookieDomain: cookieDomain }),
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
  return { app, auth, controller, iamDriver, state, pool, origin };
}

export async function signIn(
  app: NativeApp,
  credentials = { email: adminEmail, password: adminPassword },
  origin = authBaseURL,
) {
  const response = await inject(app, "POST", "/api/auth/sign-in/email", {
    headers: { origin },
    body: { email: credentials.email, password: credentials.password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const setCookie = response.headers["set-cookie"];
  const session: NativeSession = {
    origin,
    sessionKey: response.json().data.sessionKey,
    cookie: cookieHeaderFromSetCookie(
      Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [String(setCookie)],
    ),
  };
  assert.match(session.cookie, /(?:__Secure-)?openclaw_occ(?:_shared)?\.session_token=/);
  return session;
}

export async function createNativeAgent(
  api: NativeApi,
  session: NativeSession,
  upstream: NativeUpstream,
) {
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
  const nativeOrigin = nativeOriginForAgent(
    api.controller.installation.id,
    namespace.id,
    agent.id,
    api.origin,
  );
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
  return { namespace, agent, revision, native: status.json().data, principal };
}

export async function nativeGet(
  api: NativeApi,
  native: NativeTarget,
  cookie: string,
  path = "/settings/profile?tab=devices",
) {
  return inject(api.app, "GET", path, {
    headers: {
      host: new URL(native.origin).host,
      cookie,
      origin: native.origin,
    },
  });
}

export async function createReadOperateSession(
  api: NativeApi,
  namespaceId: string,
  agentId: string,
  label: string,
  action: PermissionAction = "operate",
) {
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
          { action, resourceKind: "agent" },
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
  return { session: await signIn(api.app, credentials, api.origin), principal: seed.principal };
}

export function trustLocalUpstreamCertificate(t: TestContext, cert: string) {
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, cert]);
  t.after(() => setDefaultCACertificates(previous));
}

export async function listen(app: NativeApp) {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

export async function openNativeWebSocket(
  port: number,
  native: NativeTarget,
  cookie: string,
  path = "/session/socket",
) {
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
  const onData = (chunk: Buffer) => {
    received += chunk.toString("latin1");
  };
  socket.on("data", onData);
  await waitUntil("the WebSocket upgrade response", () => received.includes("\r\n\r\n"), {
    timeoutMs: 5_000,
    intervalMs: 25,
  });
  assert.match(received, /^HTTP\/1\.1 101 /);
  return socket;
}

export async function assertNativeWebSocketRejected(
  port: number,
  native: NativeTarget,
  cookie: string,
  options: { origin?: string | undefined } = {},
) {
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
export async function assertSocketClosesAfterMutation(
  socket: Socket,
  mutate: () => Promise<unknown>,
) {
  await delay(leaseIntervalMs * 2.5);
  assert.equal(socket.destroyed, false, "an admitted socket must survive lease renewals");
  const timeoutMs = leaseIntervalMs + leaseRenewalTimeoutMs;
  let closedAt: number | undefined;
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
  assert.notEqual(closedAt, undefined);
  const closedAfterMs = Math.max(0, closedAt! - mutatedAt);
  assert.ok(
    closedAfterMs <= timeoutMs,
    `lease close took ${closedAfterMs}ms (bound ${timeoutMs}ms)`,
  );
  return closedAfterMs;
}
