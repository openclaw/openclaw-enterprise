import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import https from "node:https";
import { EventEmitter, once } from "node:events";
import { IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

import { AdmissionFailure } from "../../apps/controller/src/admission/admission-verifier.ts";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { createNativeAdminAccess } from "../../apps/controller/src/http/native-admin.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { selfSigned } from "../helpers/certificates.ts";
import { nativeAdminGatewayAuth } from "../helpers/harness-configuration.mjs";
import { waitUntil } from "../helpers/wait-for.ts";
import { GENERIC_DENIAL } from "../helpers/refusal-text.mjs";
import {
  registerRefusedUpgradeAuditCase,
  registerUpgradeShutdownAuditCases,
} from "./native-admin-upgrade-audit-cases.ts";
import {
  registerUpgradeAdmissionRecoveryCases,
  registerUpgradeLeaseAndResetRecoveryCases,
} from "./native-admin-upgrade-recovery-cases.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const Fastify = require("fastify");
// Socket receipts and cleanup must retain real deadlines when shutdown time is mocked.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

// The active revision these cases authorize: an Agent Gateway with the native admin opt-in,
// its Control UI allowed only from `origin`.
/** @param {string} origin */
function nativeAdminRevision(origin) {
  return {
    id: "rev_a",
    compute: { id: "compute_test", implementation: "native-admin-reset-test" },
    configuration: {
      gateway: {
        auth: nativeAdminGatewayAuth(),
        controlUi: { enabled: true, allowedOrigins: [origin] },
      },
    },
  };
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {string} description
 * @param {number} [milliseconds]
 * @returns {Promise<T>}
 */
function within(promise, description, milliseconds = 1_500) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {Promise<never>} */
  const timeout = new Promise((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(description)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => realClearTimeout(timer));
}

// Only authorization and audit persistence are controlled. Admission, TLS, the
// upgrade relay, its lease timer and both ends of each connection are real.
/**
 * @param {import("node:test").TestContext} t
 * @param {import("./native-admin-upgrade-audit-cases.ts").UpgradeAuditTransportOptions} options
 */
async function transportOwner(
  t,
  { authorize, append, appendSocket = async () => {}, supportsBrowser = () => true },
) {
  const directory = await mkdtemp(join(tmpdir(), "native-admin-audit-transport-"));
  const previousCertificates = getCACertificates("default");
  /** @type {Set<import("node:stream").Duplex>} */
  const sockets = new Set();
  /** @type {Parameters<typeof createNativeAdminAccess>[0]["app"] | undefined} */
  let app;
  let gateway;
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    try {
      const results = await within(
        Promise.allSettled([
          app?.close(),
          gateway && new Promise((resolve) => gateway.close(resolve)),
        ]),
        "transport cleanup must finish after the shutdown drain",
        6_500,
      );
      for (const result of results) {
        assert.equal(result.status, "fulfilled", result.reason?.message);
      }
      assert.ok([...sockets].every((socket) => socket.destroyed));
    } finally {
      setDefaultCACertificates(previousCertificates);
      await rm(directory, { recursive: true, force: true });
    }
  });
  const { key, cert } = await selfSigned(directory);
  setDefaultCACertificates([...previousCertificates, cert]);
  /** @type {PromiseWithResolvers<boolean>} */
  const peerClosed = Promise.withResolvers();
  let gatewayConnections = 0;
  gateway = https.createServer({ key, cert });
  gateway.on("connection", (socket) => {
    gatewayConnections += 1;
    sockets.add(socket);
    socket.on("error", () => {});
  });
  gateway.on("upgrade", (_request, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", peerClosed.resolve);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    // A real upstream byte must cross the production relay before lease denial.
    socket.write("peer-ready");
  });
  gateway.listen(0, "127.0.0.1");
  await within(once(gateway, "listening"), "the fixture gateway must listen");

  const installationId = "inst_native_admin_transport";
  /** @satisfies {Parameters<import("./native-admin-upgrade-audit-cases.ts").UpgradeAuditTransportOptions["authorize"]>[0]["agent"]} */
  const agent = { id: "agent_a", namespaceId: "ns_a", desiredRuntimeState: "running" };
  const domain = "agents.example.com";
  const host = deriveNativeAdminHost(installationId, agent, domain);
  const origin = `https://${host}`;
  const revision = nativeAdminRevision(origin);
  const denied = new Error("The exact platform operation was not authorized.");
  denied.name = "AuthorizationDeniedError";
  denied.authorization = {
    action: "openclaw.agents.native_admin.proxy.authorize",
    resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
  };
  /** @type {PromiseWithResolvers<void>} */
  const entered = Promise.withResolvers();
  /** @type {PromiseWithResolvers<void>} */
  const auditEntered = Promise.withResolvers();
  /** @type {PromiseWithResolvers<boolean>} */
  const serverClosed = Promise.withResolvers();
  /** @type {import("../../packages/audit/src/index.ts").AuditEventCreationInput[]} */
  const audits = [];
  /** @type {unknown[]} */
  const warnings = [];
  /** @type {PromiseWithResolvers<void>} */
  const appClosed = Promise.withResolvers();
  app = Fastify({ logger: false });
  t.mock.method(app.log, "warn", (/** @type {unknown} */ fields) => warnings.push(fields));
  app.addHook("onClose", async () => appClosed.resolve());
  app.server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", serverClosed.resolve);
  });
  createNativeAdminAccess({
    app,
    installationId,
    publicOrigin: "https://console.example.com",
    factory: { create: (event) => event },
    getController: () => ({
      async resolveAgentReference(predicate) {
        return predicate(agent) ? agent : undefined;
      },
      getBrowserAccessibleActiveAgentRevision() {
        entered.resolve();
        return authorize({ agent, revision, denied, mode: "admin" });
      },
      selectedDriver: () => ({
        id: "compute_test",
        implementation: "native-admin-reset-test",
        getGatewayBrowserRequest: supportsBrowser()
          ? async () => ({
              endpoint: `wss://127.0.0.1:${gateway.address().port}/`,
              subject: "test:native-actor-1",
              headers: {
                "x-occ-identity": "test:native-actor-1",
                "x-occ-browser-key": "browser-test-secret",
              },
            })
          : undefined,
      }),
    }),
    selectedIAMDriver: () => ({
      id: "iam_test",
      async lookupIdentity() {
        return {
          kind: "principal",
          id: "actor_1",
          issuer: "https://issuer.example",
          subject: "user-1",
        };
      },
    }),
    getContext: () => undefined,
    getAdmission: () => undefined,
    auth: {
      sharedCookieDomain: "example.com",
      admissionVerifier: {
        async verify() {
          return {
            method: "session",
            decisionId: "dec_1",
            admittedScope: { installationId },
            externalIdentity: { issuer: "https://issuer.example", subject: "user-1" },
            session: {
              id: "sess_1",
              userId: "user-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        },
      },
    },
    nativeAdmin: { enabled: true, domain },
    nativeAdminGatewayApiKey: async () => "transport-fixture-key",
    webSocketLeaseIntervalMs: 50,
    auditSink: {
      /** @param {import("../../packages/audit/src/index.ts").AuditEventCreationInput} event */
      append(event) {
        audits.push(event);
        if (event.kind === "authorization_denial") {
          auditEntered.resolve();
          assert.ok(append, "the fixture must handle any authorization denial audit");
          return append(event);
        }
        return appendSocket(event);
      },
    },
  });
  await within(app.listen({ host: "127.0.0.1", port: 0 }), "the fixture controller must listen");
  return {
    denied,
    host,
    audits,
    warnings,
    appClosed: appClosed.promise,
    entered: entered.promise,
    auditEntered: auditEntered.promise,
    serverClosed: serverClosed.promise,
    peerClosed: peerClosed.promise,
    gatewayConnections: () => gatewayConnections,
    denials: () => audits.filter((event) => event.kind === "authorization_denial"),
    closeAudit: () => audits.find((event) => event.details?.nativeAdmin?.event === "close"),
    connectionAudits: () =>
      audits.filter((event) => ["connect", "close"].includes(event.details?.nativeAdmin?.event)),
    shutdown: () => app.close(),
    async open() {
      const address = app.server.address();
      assert.ok(address && typeof address === "object");
      /** @type {import("node:net").Socket} */
      const socket = net.connect(address.port, "127.0.0.1");
      sockets.add(socket);
      socket.on("error", () => {});
      /** @type {PromiseWithResolvers<boolean>} */
      const closed = Promise.withResolvers();
      socket.once("close", closed.resolve);
      /** @type {PromiseWithResolvers<string>} */
      const ready = Promise.withResolvers();
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("\r\n\r\npeer-ready")) {
          ready.resolve(received);
        }
      });
      await within(once(socket, "connect"), "the fixture client must connect");
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\n` +
          "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
      return { closed: closed.promise, ready: ready.promise, received: () => received };
    },
  };
}

const auditFixture = { transportOwner, within, settleCallbacks };
registerUpgradeShutdownAuditCases(auditFixture);

/**
 * @param {Pick<import("./native-admin-upgrade-audit-cases.ts").UpgradeAuditTransport, "denials" | "host">} owner
 * @param {string | undefined} revisionId
 */
function assertTransportDenial(owner, revisionId) {
  assert.equal(owner.denials().length, 1, "one attributable denial audit attempt");
  const [event] = owner.denials();
  assert.ok(event);
  assert.equal(event.actor?.principalId, "actor_1");
  assert.equal(event.action, "openclaw.agents.native_admin.proxy.authorize");
  assert.deepEqual(event.resource, { kind: "agent", id: "agent_a", namespaceId: "ns_a" });
  const details = asRecord(event.details?.nativeAdmin);
  assert.ok(details, "the denial audit must include native-admin details");
  assert.equal(details.host, owner.host);
  assert.equal(details.reason, "authorization_denied");
  assert.equal(details.revisionId, revisionId);
}

registerRefusedUpgradeAuditCase({ ...auditFixture, assertTransportDenial });

test(
  "real native-admin transport closes both relay ends before a denied lease audit settles",
  { timeout: 15_000 },
  async (t) => {
    const audit = pendingValue();
    let auditSettled = false;
    let refuseLease = false;
    const owner = await transportOwner(t, {
      authorize: ({ agent, revision, denied }) =>
        refuseLease ? Promise.reject(denied) : Promise.resolve({ agent, revision, mode: "admin" }),
      append: () =>
        audit.promise.then(() => {
          auditSettled = true;
        }),
    });
    try {
      const client = await owner.open();
      assert.match(
        await within(client.ready, "real HTTPS upgrade and relay must open"),
        /^HTTP\/1.1 101 /,
      );
      assert.equal(owner.gatewayConnections(), 1);
      refuseLease = true;
      await within(owner.auditEntered, "lease denial must reach the audit sink");
      await within(
        Promise.all([client.closed, owner.serverClosed, owner.peerClosed]),
        "both relay ends must close before lease audit settlement",
      );
      assert.equal(auditSettled, false);
      assertTransportDenial(owner, "rev_a");
      assert.equal(owner.closeAudit().details.nativeAdmin.closeReason, "authorization_denied");
      assert.deepEqual(
        owner.connectionAudits().map((event) => event.details.nativeAdmin.subject),
        ["test:native-actor-1", "test:native-actor-1"],
      );
      assert.equal(
        JSON.stringify(owner.connectionAudits()).includes("browser-test-secret"),
        false,
        "connection audits must never include the delegation credential",
      );
    } finally {
      audit.resolve();
      await owner.shutdown();
    }
    assert.equal(owner.denials().length, 1);
  },
);

test(
  "native browser lease closes when the selected Compute loses browser delegation",
  { timeout: 15_000 },
  async (t) => {
    let supported = true;
    const owner = await transportOwner(t, {
      authorize: ({ agent, revision }) => Promise.resolve({ agent, revision, mode: "admin" }),
      append: async () => {},
      supportsBrowser: () => supported,
    });
    const client = await owner.open();
    assert.match(await within(client.ready, "browser relay opens"), /^HTTP\/1\.1 101 /);
    supported = false;
    await within(
      Promise.all([client.closed, owner.peerClosed]),
      "withdrawn delegation closes both ends",
    );
    assert.equal(
      owner.gatewayConnections(),
      1,
      "renewal must not open a shared-machine connection",
    );
    await owner.shutdown();
  },
);

test(
  "real native-admin transport audits a late denial once after its admission deadline",
  { timeout: 15_000 },
  async (t) => {
    const admission = pendingValue();
    const owner = await transportOwner(t, {
      authorize: () => admission.promise,
      append: async () => {},
    });
    try {
      const client = await owner.open();
      await within(owner.entered, "authorization must remain pending");
      // Exercise the production five-second deadline, not a mock timer or client reset.
      await within(
        Promise.all([client.closed, owner.serverClosed]),
        "admission deadline must close the client",
        7_500,
      );
      assert.equal(owner.denials().length, 0);
      assert.equal(owner.gatewayConnections(), 0);
      admission.reject(owner.denied);
      await within(owner.auditEntered, "late attributable denial must still be audited");
      assertTransportDenial(owner, undefined);
      await settleCallbacks();
    } finally {
      admission.reject(owner.denied);
      await owner.shutdown();
    }
    assert.equal(owner.denials().length, 1, "settlement and shutdown must not duplicate the audit");
    assert.equal(owner.gatewayConnections(), 0);
  },
);

test("a client reset during native-admin upgrade admission does not crash", async () => {
  // Admission settles only after the reset, so its late result meets a closed socket and
  // app.close() has no pending admission to wait out for the full drain (finding 814).
  const verification = pendingValue();
  let verifying = false;
  const crashes = [];
  const onUncaught = (error) => {
    crashes.push(error);
  };
  process.on("uncaughtException", onUncaught);
  const app = Fastify({ logger: false });
  createNativeAdminAccess({
    app,
    installationId: "inst_native_admin_upgrade",
    publicOrigin: undefined,
    factory: {
      create() {
        return {};
      },
    },
    getController() {
      return undefined;
    },
    selectedIAMDriver() {
      throw new Error("unused");
    },
    getContext() {
      return undefined;
    },
    getAdmission() {
      return undefined;
    },
    auth: {
      admissionVerifier: {
        verify() {
          verifying = true;
          return verification.promise;
        },
      },
    },
    nativeAdmin: { enabled: false, domain: "agents.example.test" },
    nativeAdminGatewayApiKey: undefined,
    webSocketLeaseIntervalMs: undefined,
    auditSink: { async append() {} },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(address.port, "127.0.0.1");
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(
          "GET / HTTP/1.1\r\nHost: agent-a.agents.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        setTimeout(() => {
          socket.resetAndDestroy();
          setTimeout(resolve, 300);
        }, 80);
      });
    });
    assert.equal(verifying, true, "the upgrade must reach admission");
    verification.reject(new Error("admission settled after the client reset"));
    await settleCallbacks();
    assert.deepEqual(crashes, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await app.close();
  }
});

// These cases use real Fastify registration and shutdown without binding a port.
// Upgrade sockets, HTTP replies, deadlines, external decisions and the HTTPS transport
// are controlled; the transport cases above separately prove real network behavior.
function pendingValue() {
  let resolve;
  let reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

async function settleCallbacks() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * @extends {EventEmitter<{
 *   close: [];
 *   error: [Error];
 *   upgrade: [{ statusCode: number, headers: import("node:http").IncomingHttpHeaders }, import("./native-admin-upgrade-recovery-cases.ts").UpgradeSocket, Buffer];
 * }>}
 */
class AdmissionSocket extends EventEmitter {
  destroyed = false;
  readableEnded = false;
  writableEnded = false;
  writableLength = 0;
  /** @type {Array<string | Buffer>} */
  writes = [];

  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }

  end() {
    this.writableEnded = true;
    return this;
  }

  /** @param {string | Buffer} value */
  write(value) {
    this.writes.push(value);
    return true;
  }

  /** @template Destination @param {Destination} destination */
  pipe(destination) {
    return destination;
  }
}

/**
 * @param {import("node:test").TestContext} t
 * @param {import("./native-admin-upgrade-recovery-cases.ts").DenialOverrides} [overrides]
 */
async function denialOwner(t, overrides = {}) {
  const installationId = "inst_native_admin_audit";
  /** @satisfies {Pick<import("../../packages/contracts/src/index.ts").Agent, "id" | "namespaceId" | "desiredRuntimeState">} */
  const agent = { id: "agent_a", namespaceId: "ns_a", desiredRuntimeState: "running" };
  const domain = "agents.example.com";
  const host = deriveNativeAdminHost(installationId, agent, domain);
  const origin = `https://${host}`;
  const revision = nativeAdminRevision(origin);
  const denied = Object.assign(new Error("The exact platform operation was not authorized."), {
    name: "AuthorizationDeniedError",
    authorization: {
      action: "administer",
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    },
  });
  /** @type {import("../../packages/audit/src/index.ts").AuditEventCreationInput[]} */
  const audits = [];
  /** @type {unknown[]} */
  const warnings = [];
  /** @type {AdmissionSocket[]} */
  const upstreams = [];
  /** @type {import("../../apps/controller/node_modules/fastify/fastify.js").FastifyInstance} */
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  /** @param {unknown} event */
  const captureWarning = (event) => warnings.push(event);
  t.mock.method(app.log, "warn", captureWarning);
  // A missing interception fails before any external network request can occur.
  t.mock.method(https, "request", () => {
    const upstream = new AdmissionSocket();
    upstreams.push(upstream);
    return upstream;
  });
  const access = createNativeAdminAccess({
    app,
    installationId,
    publicOrigin: "https://console.example.com",
    factory: { create: (event) => event },
    getController: () => ({
      async resolveAgentReference(predicate) {
        return predicate(agent) ? agent : undefined;
      },
      getBrowserAccessibleActiveAgentRevision() {
        return (
          overrides.authorize?.({ agent, revision, denied, mode: "admin" }) ??
          Promise.reject(denied)
        );
      },
      selectedDriver: () => ({
        id: "compute_test",
        implementation: "native-admin-reset-test",
        getGatewayBrowserRequest: async () => ({
          endpoint: "wss://gateway.example.test",
          subject: "test:native-actor-1",
          headers: {},
        }),
      }),
    }),
    selectedIAMDriver: () => ({
      id: "iam_test",
      async lookupIdentity() {
        return {
          kind: "principal",
          id: "actor_1",
          issuer: "https://issuer.example",
          subject: "user-1",
        };
      },
    }),
    getContext: () => undefined,
    getAdmission: () => undefined,
    auth: {
      sharedCookieDomain: "example.com",
      admissionVerifier: {
        async verify() {
          if (overrides.admissionError) {
            throw overrides.admissionError;
          }
          return {
            method: "session",
            decisionId: "dec_1",
            admittedScope: { installationId },
            externalIdentity: { issuer: "https://issuer.example", subject: "user-1" },
            session: {
              id: "sess_1",
              userId: "user-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        },
      },
    },
    nativeAdmin: { enabled: true, domain },
    nativeAdminGatewayApiKey: overrides.transport ?? (async () => "synthetic"),
    webSocketLeaseIntervalMs: undefined,
    auditSink: {
      /** @param {import("../../packages/audit/src/index.ts").AuditEventCreationInput} event */
      append(event) {
        audits.push(event);
        return overrides.append?.(event) ?? Promise.resolve();
      },
    },
  });
  await app.ready();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  /**
   * @returns {{ method: string, url: string, headers: import("node:http").IncomingHttpHeaders,
   *   socket: { remoteAddress: string }, destroyed: boolean }}
   */
  const request = () => ({
    method: "GET",
    url: "/",
    headers: { host, origin, "sec-websocket-key": "synthetic", "sec-websocket-version": "13" },
    socket: { remoteAddress: "127.0.0.1" },
    destroyed: false,
  });
  return {
    access,
    audits,
    warnings,
    upstreams,
    denied,
    request,
    denials: () => audits.filter((event) => event.kind === "authorization_denial"),
    shutdown: () => app.close(),
    upgrade() {
      const socket = new AdmissionSocket();
      app.server.emit("upgrade", request(), socket, Buffer.alloc(0));
      return socket;
    },
  };
}

test("native-admin denial ownership closes before a delayed or rejected append", async (t) => {
  const append = pendingValue();
  const owner = await denialOwner(t, { append: () => append.promise });
  const socket = owner.upgrade();
  try {
    await settleCallbacks();
    assert.equal(socket.destroyed, true);
    assert.equal(owner.denials().length, 1);
    assert.equal(owner.denials()[0].actor.principalId, "actor_1");
    assert.equal(owner.denials()[0].authorization.action, "administer");
    append.reject(new Error("synthetic sink failure"));
    await settleCallbacks();
    assert.equal(asRecord(owner.warnings[0])?.event, "native_admin.websocket_denial_audit_failed");
    assert.equal(owner.denials().length, 1);
    assert.equal(owner.upstreams.length, 0);
  } finally {
    append.resolve();
    socket.destroy();
    await settleCallbacks();
    await owner.shutdown();
  }
});

const recoveryFixture = { denialOwner, settleCallbacks, AdmissionSocket };
registerUpgradeAdmissionRecoveryCases(recoveryFixture);

test("native-admin denial ownership retains HTTP audit failure and timeout responses", async (t) => {
  const admission = pendingValue();
  let reads = 0;
  const owner = await denialOwner(t, {
    authorize({ denied }) {
      reads += 1;
      return reads === 1 ? Promise.reject(denied) : admission.promise;
    },
    append: () => Promise.reject(new Error("synthetic sink failure")),
  });
  const reply = () => ({
    request: { id: "request_test" },
    header() {
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
    },
  });
  try {
    const timely = reply();
    const raw = owner.request();
    const request = { headers: raw.headers, url: "/", raw };
    await owner.access.interceptHttp(request, timely);
    assert.equal(owner.access.httpAdmissionReason(request), "denial_audit_failed");
    assert.equal(timely.statusCode, 503);
    assert.equal(timely.body.error.code, "DEPENDENCY_UNAVAILABLE");
    const late = reply();
    const lateRequest = { headers: raw.headers, url: "/", raw };
    const pending = owner.access.interceptHttp(lateRequest, late);
    await settleCallbacks();
    t.mock.timers.tick(5_000);
    await pending;
    assert.equal(late.statusCode, 503);
    assert.equal(owner.access.httpAdmissionReason(lateRequest), "admission_unavailable");
    admission.reject(owner.denied);
    await settleCallbacks();
    assert.equal(owner.access.httpAdmissionReason(lateRequest), "admission_unavailable");
    assert.equal(owner.denials().length, 2);
    assert.equal(owner.upstreams.length, 0);
  } finally {
    admission.reject(owner.denied);
    await settleCallbacks();
    await owner.shutdown();
  }
});

registerUpgradeLeaseAndResetRecoveryCases(recoveryFixture);

test("native-admin HTTP admission preserves typed refusals and dependency failures", async (t) => {
  for (const [error, status, reason] of [
    [new AdmissionFailure(401, "UNAUTHENTICATED", "missing session"), 403, "session_invalid"],
    [new AdmissionFailure(403, "FORBIDDEN", "scope refused"), 403, "admission_forbidden"],
    [new Error("session store unavailable"), 503, "dependency_failure"],
  ]) {
    await t.test(reason, async (t) => {
      // The verifier's public failure contract drives the real HTTP admission owner.
      const owner = await denialOwner(t, { admissionError: error });
      const raw = owner.request();
      const request = { headers: raw.headers, url: "/", raw };
      const reply = {
        request: { id: "request_test" },
        header() {
          return this;
        },
        status(code) {
          this.statusCode = code;
          return this;
        },
        send(body) {
          this.body = body;
        },
      };
      await owner.access.interceptHttp(request, reply);
      assert.equal(reply.statusCode, status);
      assert.equal(owner.access.httpAdmissionReason(request), reason);
      assert.equal(owner.denials().length, 0, "no attributed IAM operation was attempted");
      assert.equal(owner.upstreams.length, 0);
      await owner.shutdown();
    });
  }
});

test("native-admin denial ownership preserves a timely HTTP denial response", async (t) => {
  const owner = await denialOwner(t);
  const raw = owner.request();
  const reply = {
    request: { id: "request_test" },
    header() {
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
    },
  };
  await owner.access.interceptHttp({ headers: raw.headers, url: "/", raw }, reply);
  assert.equal(reply.statusCode, 403);
  assert.equal(reply.body.error.code, "FORBIDDEN");
  assert.equal(owner.denials().length, 1);
  assert.equal(owner.upstreams.length, 0);
  await owner.shutdown();
});

test("native-admin denial ownership permits a completed HTTP request on a live connection", async (t) => {
  const transport = pendingValue();
  let transportEntered = false;
  const owner = await denialOwner(t, {
    authorize: (selection) => Promise.resolve(selection),
    transport() {
      transportEntered = true;
      return transport.promise;
    },
  });
  // IncomingMessage may finish and auto-destroy while its connection remains live.
  // Admission must check the connection rather than treating that EOF as disconnect.
  const raw = new IncomingMessage(new AdmissionSocket());
  const request = owner.request();
  raw.method = request.method;
  raw.url = request.url;
  raw.headers = request.headers;
  raw.complete = true;
  raw.push(null);
  raw.resume();
  await settleCallbacks();
  assert.equal(raw.destroyed, true);
  assert.equal(raw.socket.destroyed, false);
  const reply = {
    request: { id: "request_test" },
    header() {
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
    },
  };
  const handling = owner.access.interceptHttp({ headers: raw.headers, url: "/", raw }, reply);
  try {
    await settleCallbacks();
    assert.equal(transportEntered, true);
    // End before proxying; this case proves admission ordering without a real upstream.
    transport.resolve("");
    await handling;
    assert.equal(reply.statusCode, 503);
    assert.equal(owner.upstreams.length, 0);
  } finally {
    transport.resolve("");
    await handling;
    await owner.shutdown();
  }
});

test("a client reset during a pending native-admin denial still records the denial", async () => {
  const installationId = "inst_native_admin_upgrade";
  const agent = { id: "agent_a", namespaceId: "ns_a" };
  const domain = "agents.example.com";
  const host = deriveNativeAdminHost(installationId, agent, domain);
  const audits = [];
  let rejectAdmission = () => {};
  let admissionEntered = false;
  const admissionGate = new Promise((_resolve, reject) => {
    rejectAdmission = reject;
  });
  const crashes = [];
  const onUncaught = (error) => {
    crashes.push(error);
  };
  process.on("uncaughtException", onUncaught);
  const app = Fastify({ logger: false });
  createNativeAdminAccess({
    app,
    installationId,
    publicOrigin: "https://console.example.com",
    factory: {
      create(input) {
        return input;
      },
    },
    getController() {
      return {
        async resolveAgentReference(predicate) {
          return predicate(agent) ? agent : undefined;
        },
        getBrowserAccessibleActiveAgentRevision() {
          admissionEntered = true;
          return admissionGate;
        },
      };
    },
    selectedIAMDriver() {
      return {
        id: "iam_test",
        async lookupIdentity() {
          return {
            kind: "principal",
            id: "actor_1",
            issuer: "https://issuer.example",
            subject: "user-1",
          };
        },
      };
    },
    getContext() {
      return undefined;
    },
    getAdmission() {
      return undefined;
    },
    auth: {
      sharedCookieDomain: "example.com",
      admissionVerifier: {
        async verify() {
          return {
            method: "session",
            decisionId: "dec_1",
            admittedScope: { installationId },
            externalIdentity: { issuer: "https://issuer.example", subject: "user-1" },
            session: {
              id: "sess_1",
              userId: "user-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          };
        },
      },
    },
    nativeAdmin: { enabled: true, domain },
    nativeAdminGatewayApiKey: "gateway-test-key",
    webSocketLeaseIntervalMs: undefined,
    auditSink: {
      async append(event) {
        audits.push(event);
      },
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(address.port, "127.0.0.1");
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        );
        const admissionDeadline = Date.now() + 1000;
        const waitForAdmission = () => {
          if (admissionEntered || Date.now() > admissionDeadline) {
            socket.resetAndDestroy();
            setTimeout(resolve, 50);
            return;
          }
          setTimeout(waitForAdmission, 10);
        };
        setTimeout(waitForAdmission, 20);
      });
    });
    const denied = new Error(GENERIC_DENIAL);
    denied.name = "AuthorizationDeniedError";
    denied.authorization = {
      action: "openclaw.agents.native_admin.proxy.authorize",
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    };
    rejectAdmission(denied);
    await waitUntil("the denial audit", () => audits.length > 0, { timeoutMs: 1000 });
    assert.equal(admissionEntered, true);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].kind, "authorization_denial");
    assert.equal(audits[0].actor.principalId, "actor_1");
    assert.equal(audits[0].outcome, "denied");
    assert.equal(audits[0].details.nativeAdmin.reason, "authorization_denied");
    assert.equal(audits[0].details.nativeAdmin.host, host);
    assert.deepEqual(crashes, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await app.close();
  }
});

for (const phase of ["admission", "gateway key"]) {
  test(`a client reset while the native-admin ${phase} is pending never opens the Agent gateway`, async () => {
    const installationId = "inst_native_admin_upgrade";
    const agent = { id: "agent_a", namespaceId: "ns_a", desiredRuntimeState: "running" };
    const domain = "agents.example.com";
    const host = deriveNativeAdminHost(installationId, agent, domain);
    const origin = `https://${host}`;
    // An Agent gateway that only counts connection attempts.
    const gatewayConnections = [];
    const gateway = net.createServer((connection) => {
      gatewayConnections.push(connection);
      connection.destroy();
    });
    await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gates = {};
    const entered = {};
    const gated = (name, value) => {
      entered[name] = true;
      return new Promise((resolve) => {
        gates[name] = () => resolve(value);
      });
    };
    const revision = nativeAdminRevision(origin);
    const selection = { agent, revision, mode: "admin" };
    const crashes = [];
    const onUncaught = (error) => {
      crashes.push(error);
    };
    process.on("uncaughtException", onUncaught);
    const app = Fastify({ logger: false });
    createNativeAdminAccess({
      app,
      installationId,
      publicOrigin: "https://console.example.com",
      factory: {
        create(input) {
          return input;
        },
      },
      getController() {
        return {
          async resolveAgentReference(predicate) {
            return predicate(agent) ? agent : undefined;
          },
          getBrowserAccessibleActiveAgentRevision() {
            return phase === "admission" ? gated("admission", selection) : selection;
          },
          selectedDriver() {
            return {
              id: "compute_test",
              implementation: "native-admin-reset-test",
              getGatewayBrowserRequest: async () => ({
                endpoint: `wss://127.0.0.1:${gateway.address().port}/`,
                subject: "test:native-actor-1",
                headers: {},
              }),
            };
          },
        };
      },
      selectedIAMDriver() {
        return {
          id: "iam_test",
          async lookupIdentity() {
            return {
              kind: "principal",
              id: "actor_1",
              issuer: "https://issuer.example",
              subject: "user-1",
            };
          },
        };
      },
      getContext() {
        return undefined;
      },
      getAdmission() {
        return undefined;
      },
      auth: {
        sharedCookieDomain: "example.com",
        admissionVerifier: {
          async verify() {
            return {
              method: "session",
              decisionId: "dec_1",
              admittedScope: { installationId },
              externalIdentity: { issuer: "https://issuer.example", subject: "user-1" },
              session: {
                id: "sess_1",
                userId: "user-1",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            };
          },
        },
      },
      nativeAdmin: { enabled: true, domain },
      nativeAdminGatewayApiKey() {
        return gated("gateway key", "gateway-test-key");
      },
      webSocketLeaseIntervalMs: undefined,
      auditSink: { async append() {} },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const serverSockets = [];
    app.server.on("connection", (socket) => serverSockets.push(socket));
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(address.port, "127.0.0.1");
        socket.on("error", reject);
        socket.on("connect", () => {
          socket.write(
            `GET / HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\n` +
              "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
          );
          const phaseDeadline = Date.now() + 1000;
          const waitForPhase = () => {
            if (entered[phase] || Date.now() > phaseDeadline) {
              socket.resetAndDestroy();
              resolve();
              return;
            }
            setTimeout(waitForPhase, 10);
          };
          setTimeout(waitForPhase, 20);
        });
      });
      assert.equal(entered[phase], true, `the upgrade must reach the pending ${phase}`);
      // Release the gate only once the server has seen the reset.
      await waitUntil(
        "the server to observe the reset",
        () => serverSockets.every((socket) => socket.destroyed),
        { timeoutMs: 2000, intervalMs: 10 },
      );
      assert.equal(serverSockets.length, 1);
      assert.equal(serverSockets[0].destroyed, true, "the server must observe the reset");
      gates[phase]();
      // Give a wrongly continued upgrade time to read the key or dial the gateway.
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (phase === "admission") {
        assert.equal(entered["gateway key"], undefined, "a reset upgrade must not read the key");
      }
      assert.equal(gatewayConnections.length, 0);
      assert.deepEqual(crashes, []);
    } finally {
      process.off("uncaughtException", onUncaught);
      await app.close();
      await new Promise((resolve) => gateway.close(resolve));
    }
  });
}
