import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import https from "node:https";
import { EventEmitter, once } from "node:events";
import { IncomingMessage } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { createNativeAdminAccess } from "../../apps/controller/src/http/native-admin.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const Fastify = require("fastify");

function within(promise, description, milliseconds = 1_500) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Only authorization and audit persistence are controlled. Admission, TLS, the
// upgrade relay, its lease timer and both ends of each connection are real.
async function transportOwner(t, { authorize, append }) {
  const directory = await mkdtemp(join(tmpdir(), "native-admin-audit-transport-"));
  const previousCertificates = getCACertificates("default");
  const sockets = new Set();
  let app;
  let gateway;
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    try {
      const results = await Promise.allSettled([
        app?.close(),
        gateway && new Promise((resolve) => gateway.close(resolve)),
      ]);
      for (const result of results) {
        assert.equal(result.status, "fulfilled", result.reason?.message);
      }
      assert.ok([...sockets].every((socket) => socket.destroyed));
    } finally {
      setDefaultCACertificates(previousCertificates);
      await rm(directory, { recursive: true, force: true });
    }
  });
  const keyPath = join(directory, "tls.key");
  const certPath = join(directory, "tls.crt");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  const cert = await readFile(certPath, "utf8");
  setDefaultCACertificates([...previousCertificates, cert]);
  const peerClosed = pendingValue();
  let gatewayConnections = 0;
  gateway = https.createServer({ key: await readFile(keyPath), cert });
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
  await once(gateway, "listening");

  const installationId = "inst_native_admin_transport";
  const agent = { id: "agent_a", namespaceId: "ns_a", desiredRuntimeState: "running" };
  const domain = "agents.example.com";
  const host = deriveNativeAdminHost(installationId, agent, domain);
  const origin = `https://${host}`;
  const revision = {
    id: "rev_a",
    configuration: {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-occ-identity",
            allowUsers: ["occ-workspace-files"],
            deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
          },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
        controlUi: { enabled: true, allowedOrigins: [origin] },
      },
    },
  };
  const denied = new Error("The exact platform operation was not authorized.");
  denied.name = "AuthorizationDeniedError";
  denied.authorization = {
    action: "openclaw.agents.native_admin.proxy.authorize",
    resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
  };
  const entered = pendingValue();
  const auditEntered = pendingValue();
  const serverClosed = pendingValue();
  const audits = [];
  app = Fastify({ logger: false });
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
      getAdministerableActiveAgentRevision() {
        entered.resolve();
        return authorize({ agent, revision, denied });
      },
      selectedDriver: () => ({
        getGatewayEndpoint: () => `wss://127.0.0.1:${gateway.address().port}/`,
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
    nativeAdmin: { enabled: true, domain, sharedCookieDomain: "example.com" },
    nativeAdminGatewayApiKey: async () => "transport-fixture-key",
    webSocketLeaseIntervalMs: 50,
    auditSink: {
      append(event) {
        audits.push(event);
        if (event.kind === "authorization_denial") {
          auditEntered.resolve();
          return append(event);
        }
        return Promise.resolve();
      },
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    denied,
    host,
    entered: entered.promise,
    auditEntered: auditEntered.promise,
    serverClosed: serverClosed.promise,
    peerClosed: peerClosed.promise,
    gatewayConnections: () => gatewayConnections,
    denials: () => audits.filter((event) => event.kind === "authorization_denial"),
    closeAudit: () => audits.find((event) => event.details?.nativeAdmin?.event === "close"),
    shutdown: () => app.close(),
    async open() {
      const socket = net.connect(app.server.address().port, "127.0.0.1");
      sockets.add(socket);
      socket.on("error", () => {});
      const closed = new Promise((resolve) => socket.once("close", resolve));
      const ready = pendingValue();
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("\r\n\r\npeer-ready")) {
          ready.resolve(received);
        }
      });
      await once(socket, "connect");
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\n` +
          "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
      return { closed, ready: ready.promise };
    },
  };
}

function assertTransportDenial(owner, revisionId) {
  assert.equal(owner.denials().length, 1, "one attributable denial audit attempt");
  const event = owner.denials()[0];
  assert.equal(event.actor.principalId, "actor_1");
  assert.equal(event.action, "openclaw.agents.native_admin.proxy.authorize");
  assert.deepEqual(event.resource, { kind: "agent", id: "agent_a", namespaceId: "ns_a" });
  assert.equal(event.details.nativeAdmin.host, owner.host);
  assert.equal(event.details.nativeAdmin.reason, "authorization_denied");
  assert.equal(event.details.nativeAdmin.revisionId, revisionId);
}

test(
  "real native-admin transport closes a refused upgrade while its audit is pending",
  { timeout: 15_000 },
  async (t) => {
    const audit = pendingValue();
    let auditSettled = false;
    const owner = await transportOwner(t, {
      authorize: ({ denied }) => Promise.reject(denied),
      append: () =>
        audit.promise.then(() => {
          auditSettled = true;
        }),
    });
    try {
      const client = await owner.open();
      await within(owner.auditEntered, "denial must reach the audit sink");
      await within(
        Promise.all([client.closed, owner.serverClosed]),
        "refused upgrade must close before audit settlement",
      );
      assert.equal(auditSettled, false);
      assert.equal(owner.gatewayConnections(), 0);
      assertTransportDenial(owner, undefined);
    } finally {
      audit.resolve();
      await owner.shutdown();
    }
    assert.equal(owner.denials().length, 1);
  },
);

test(
  "real native-admin transport closes both relay ends before a denied lease audit settles",
  { timeout: 15_000 },
  async (t) => {
    const audit = pendingValue();
    let auditSettled = false;
    let refuseLease = false;
    const owner = await transportOwner(t, {
      authorize: ({ agent, revision, denied }) =>
        refuseLease ? Promise.reject(denied) : Promise.resolve({ agent, revision }),
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
    } finally {
      audit.resolve();
      await owner.shutdown();
    }
    assert.equal(owner.denials().length, 1);
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
          return new Promise(() => {});
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
    assert.deepEqual(crashes, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    await app.close();
  }
});

// These cases exercise the registered upgrade listener and shutdown hook without
// binding a port. Only the external decision, audit sink and HTTPS transport are controlled.
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

class AdmissionSocket extends EventEmitter {
  destroyed = false;
  readableEnded = false;
  writableEnded = false;
  writableLength = 0;
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

  write(value) {
    this.writes.push(value);
    return true;
  }

  pipe(destination) {
    return destination;
  }
}

function denialOwner(t, overrides = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const installationId = "inst_native_admin_audit";
  const agent = { id: "agent_a", namespaceId: "ns_a", desiredRuntimeState: "running" };
  const domain = "agents.example.com";
  const host = deriveNativeAdminHost(installationId, agent, domain);
  const origin = `https://${host}`;
  const revision = {
    id: "rev_a",
    configuration: {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-occ-identity",
            allowUsers: ["occ-workspace-files"],
            deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
          },
          identityScopes: { "occ-workspace-files": ["operator.admin"] },
        },
        controlUi: { enabled: true, allowedOrigins: [origin] },
      },
    },
  };
  const denied = new Error("The exact platform operation was not authorized.");
  denied.name = "AuthorizationDeniedError";
  denied.authorization = {
    action: "administer",
    resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
  };
  const audits = [];
  const warnings = [];
  const upstreams = [];
  const hooks = new Map();
  const app = {
    server: new EventEmitter(),
    log: { warn: (event) => warnings.push(event) },
    addHook: (name, callback) => hooks.set(name, callback),
  };
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
      getAdministerableActiveAgentRevision() {
        return overrides.authorize?.({ agent, revision, denied }) ?? Promise.reject(denied);
      },
      selectedDriver: () => ({ getGatewayEndpoint: () => "wss://gateway.example.test" }),
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
    nativeAdmin: { enabled: true, domain, sharedCookieDomain: "example.com" },
    nativeAdminGatewayApiKey: overrides.transport ?? (async () => "synthetic"),
    webSocketLeaseIntervalMs: undefined,
    auditSink: {
      append(event) {
        audits.push(event);
        return overrides.append?.(event) ?? Promise.resolve();
      },
    },
  });
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
    shutdown: () => hooks.get("preClose")(),
    upgrade() {
      const socket = new AdmissionSocket();
      app.server.emit("upgrade", request(), socket, Buffer.alloc(0));
      return socket;
    },
  };
}

test("native-admin denial ownership closes before a delayed or rejected append", async (t) => {
  const append = pendingValue();
  const owner = denialOwner(t, { append: () => append.promise });
  const socket = owner.upgrade();
  try {
    await settleCallbacks();
    assert.equal(socket.destroyed, true);
    assert.equal(owner.denials().length, 1);
    assert.equal(owner.denials()[0].actor.principalId, "actor_1");
    assert.equal(owner.denials()[0].authorization.action, "administer");
    append.reject(new Error("synthetic sink failure"));
    await settleCallbacks();
    assert.equal(owner.warnings[0].event, "native_admin.websocket_denial_audit_failed");
    assert.equal(owner.denials().length, 1);
    assert.equal(owner.upstreams.length, 0);
  } finally {
    append.resolve();
    socket.destroy();
    await settleCallbacks();
    await owner.shutdown();
  }
});

for (const boundary of ["timeout", "disconnect", "shutdown-wait-expiry"]) {
  test(`native-admin denial ownership consumes a denial after ${boundary}`, async (t) => {
    const admission = pendingValue();
    const owner = denialOwner(t, { authorize: () => admission.promise });
    const socket = owner.upgrade();
    let closing;
    try {
      await settleCallbacks();
      if (boundary === "disconnect") {
        socket.destroy();
      } else {
        if (boundary === "shutdown-wait-expiry") {
          closing = owner.shutdown();
          await settleCallbacks();
        }
        t.mock.timers.tick(5_000);
        await settleCallbacks();
        if (closing) {
          await closing;
          assert.equal(owner.warnings[0].event, "native_admin.pending_work_unresolved");
          assert.equal(owner.warnings[0].pending, 1);
        }
      }
      assert.equal(socket.destroyed, true);
      admission.reject(owner.denied);
      await settleCallbacks();
      assert.equal(owner.denials().length, 1);
      assert.equal(owner.denials()[0].resource.id, "agent_a");
      assert.equal(owner.upstreams.length, 0);
    } finally {
      admission.reject(owner.denied);
      socket.destroy();
      await settleCallbacks();
      await (closing ?? owner.shutdown());
    }
  });
}

test("native-admin denial ownership drains admission through append under one deadline", async (t) => {
  const admission = pendingValue();
  const append = pendingValue();
  const owner = denialOwner(t, {
    authorize: () => admission.promise,
    append: () => append.promise,
  });
  const socket = owner.upgrade();
  let finished = false;
  await settleCallbacks();
  const closing = owner.shutdown().then(() => {
    finished = true;
  });
  try {
    await settleCallbacks();
    assert.equal(finished, false);
    t.mock.timers.tick(4_000);
    admission.reject(owner.denied);
    await settleCallbacks();
    assert.equal(owner.denials().length, 1);
    assert.equal(finished, false);
    // The transition to append must not get a second five-second shutdown budget.
    t.mock.timers.tick(1_000);
    await settleCallbacks();
    assert.equal(finished, true);
    assert.equal(owner.warnings[0].pending, 1);
    append.resolve();
    await settleCallbacks();
    await owner.shutdown();
    assert.equal(owner.warnings.length, 1);
    assert.equal(owner.denials().length, 1);
  } finally {
    admission.reject(owner.denied);
    append.resolve();
    socket.destroy();
    await settleCallbacks();
    await closing;
  }
});

for (const boundary of ["timeout", "disconnect", "shutdown"]) {
  test(`native-admin denial ownership never opens a gateway after ${boundary}`, async (t) => {
    const admission = pendingValue();
    let selection;
    const owner = denialOwner(t, {
      authorize(input) {
        selection = input;
        return admission.promise;
      },
    });
    const socket = owner.upgrade();
    let closing;
    try {
      await settleCallbacks();
      if (boundary === "timeout") {
        t.mock.timers.tick(5_000);
        await settleCallbacks();
      } else if (boundary === "disconnect") {
        socket.destroy();
      } else {
        closing = owner.shutdown();
        await settleCallbacks();
      }
      admission.resolve(selection);
      await settleCallbacks();
      assert.equal(socket.destroyed, true);
      assert.equal(owner.upstreams.length, 0);
      assert.equal(owner.denials().length, 0);
    } finally {
      admission.resolve(selection);
      socket.destroy();
      await settleCallbacks();
      await (closing ?? owner.shutdown());
    }
  });
}

test("native-admin denial ownership closes a denied lease before append settles", async (t) => {
  const append = pendingValue();
  let reads = 0;
  const owner = denialOwner(t, {
    authorize(input) {
      reads += 1;
      return reads === 1 ? Promise.resolve(input) : Promise.reject(input.denied);
    },
    append(event) {
      return event.kind === "authorization_denial" ? append.promise : Promise.resolve();
    },
  });
  const socket = owner.upgrade();
  const upstreamSocket = new AdmissionSocket();
  try {
    await settleCallbacks();
    assert.equal(owner.upstreams.length, 1);
    owner.upstreams[0].emit(
      "upgrade",
      { statusCode: 101, headers: {} },
      upstreamSocket,
      Buffer.alloc(0),
    );
    await settleCallbacks();
    assert.ok(socket.writes.join("").startsWith("HTTP/1.1 101"));
    t.mock.timers.tick(25_000);
    await settleCallbacks();
    assert.equal(socket.destroyed, true);
    assert.equal(upstreamSocket.destroyed, true);
    assert.equal(owner.denials().length, 1);
    append.resolve();
    await settleCallbacks();
    assert.equal(owner.denials().length, 1);
  } finally {
    append.resolve();
    socket.destroy();
    upstreamSocket.destroy();
    await settleCallbacks();
    await owner.shutdown();
  }
});

test("native-admin denial ownership retains HTTP audit failure and timeout responses", async (t) => {
  const admission = pendingValue();
  let reads = 0;
  const owner = denialOwner(t, {
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
    await owner.access.interceptHttp({ headers: raw.headers, url: "/", raw }, timely);
    assert.equal(timely.statusCode, 503);
    assert.equal(timely.body.error.code, "DEPENDENCY_UNAVAILABLE");
    const late = reply();
    const pending = owner.access.interceptHttp({ headers: raw.headers, url: "/", raw }, late);
    await settleCallbacks();
    t.mock.timers.tick(5_000);
    await pending;
    assert.equal(late.statusCode, 503);
    admission.reject(owner.denied);
    await settleCallbacks();
    assert.equal(owner.denials().length, 2);
    assert.equal(owner.upstreams.length, 0);
  } finally {
    admission.reject(owner.denied);
    await settleCallbacks();
    await owner.shutdown();
  }
});

for (const order of ["denial-first", "deadline-first"]) {
  test(`native-admin denial ownership attempts one audit at the deadline (${order})`, async (t) => {
    const admission = pendingValue();
    const owner = denialOwner(t, { authorize: () => admission.promise });
    if (order === "denial-first") {
      setTimeout(() => admission.reject(owner.denied), 5_000);
    }
    const socket = owner.upgrade();
    try {
      await settleCallbacks();
      if (order === "deadline-first") {
        setTimeout(() => admission.reject(owner.denied), 5_000);
      }
      t.mock.timers.tick(5_000);
      await settleCallbacks();
      assert.equal(socket.destroyed, true);
      assert.equal(owner.denials().length, 1);
      assert.equal(owner.upstreams.length, 0);
      t.mock.timers.tick(5_000);
      await settleCallbacks();
      assert.equal(owner.denials().length, 1);
    } finally {
      admission.reject(owner.denied);
      socket.destroy();
      await settleCallbacks();
      await owner.shutdown();
    }
  });
}

test("native-admin denial ownership audits a lease denial after its timeout closes the connection", async (t) => {
  const renewal = pendingValue();
  let reads = 0;
  const owner = denialOwner(t, {
    authorize(input) {
      reads += 1;
      return reads === 1 ? Promise.resolve(input) : renewal.promise;
    },
  });
  const socket = owner.upgrade();
  const upstreamSocket = new AdmissionSocket();
  try {
    await settleCallbacks();
    owner.upstreams[0].emit(
      "upgrade",
      { statusCode: 101, headers: {} },
      upstreamSocket,
      Buffer.alloc(0),
    );
    await settleCallbacks();
    t.mock.timers.tick(25_000);
    await settleCallbacks();
    assert.equal(reads, 2);
    t.mock.timers.tick(5_000);
    await settleCallbacks();
    assert.equal(socket.destroyed, true);
    renewal.reject(owner.denied);
    await settleCallbacks();
    assert.equal(owner.denials().length, 1);
    assert.equal(owner.denials()[0].details.nativeAdmin.revisionId, "rev_a");
  } finally {
    renewal.reject(owner.denied);
    socket.destroy();
    upstreamSocket.destroy();
    await settleCallbacks();
    await owner.shutdown();
  }
});

test("native-admin denial ownership preserves reset handling while transport is pending", async (t) => {
  const transport = pendingValue();
  const owner = denialOwner(t, {
    authorize: (selection) => Promise.resolve(selection),
    transport: () => transport.promise,
  });
  const socket = owner.upgrade();
  try {
    await settleCallbacks();
    socket.emit("error", new Error("synthetic reset"));
    transport.resolve("synthetic");
    await settleCallbacks();
    assert.equal(socket.destroyed, true);
    assert.equal(owner.upstreams.length, 0);
  } finally {
    transport.resolve("synthetic");
    socket.destroy();
    await settleCallbacks();
    await owner.shutdown();
  }
});

test("native-admin denial ownership preserves reset handling during admission", async (t) => {
  const admission = pendingValue();
  const owner = denialOwner(t, { authorize: () => admission.promise });
  const socket = owner.upgrade();
  try {
    await settleCallbacks();
    socket.emit("error", new Error("synthetic reset"));
    admission.reject(owner.denied);
    await settleCallbacks();
    assert.equal(socket.destroyed, true);
    assert.equal(owner.denials().length, 1);
    assert.equal(owner.upstreams.length, 0);
  } finally {
    admission.reject(owner.denied);
    socket.destroy();
    await settleCallbacks();
    await owner.shutdown();
  }
});

test("native-admin denial ownership keeps dependency failures distinct from denials", async (t) => {
  const unavailable = new Error("synthetic unavailable dependency");
  unavailable.name = "DependencyUnavailableError";
  const owner = denialOwner(t, { authorize: () => Promise.reject(unavailable) });
  const socket = owner.upgrade();
  await settleCallbacks();
  assert.equal(socket.destroyed, true);
  assert.equal(owner.denials().length, 0);
  assert.equal(owner.upstreams.length, 0);
  await owner.shutdown();
});

test("native-admin denial ownership preserves a timely HTTP denial response", async (t) => {
  const owner = denialOwner(t);
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
  const owner = denialOwner(t, {
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
        getAdministerableActiveAgentRevision() {
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
    nativeAdmin: { enabled: true, domain, sharedCookieDomain: "example.com" },
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
        const waitUntil = Date.now() + 1000;
        const waitForAdmission = () => {
          if (admissionEntered || Date.now() > waitUntil) {
            socket.resetAndDestroy();
            setTimeout(resolve, 50);
            return;
          }
          setTimeout(waitForAdmission, 10);
        };
        setTimeout(waitForAdmission, 20);
      });
    });
    const denied = new Error("The exact platform operation was not authorized.");
    denied.name = "AuthorizationDeniedError";
    denied.authorization = {
      action: "openclaw.agents.native_admin.proxy.authorize",
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    };
    rejectAdmission(denied);
    const auditDeadline = Date.now() + 1000;
    while (audits.length === 0 && Date.now() < auditDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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
    const revision = {
      id: "rev_a",
      configuration: {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
              deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
            },
            identityScopes: { "occ-workspace-files": ["operator.admin"] },
          },
          controlUi: { enabled: true, allowedOrigins: [origin] },
        },
      },
    };
    const selection = { agent, revision };
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
          getAdministerableActiveAgentRevision() {
            return phase === "admission" ? gated("admission", selection) : selection;
          },
          selectedDriver() {
            return { getGatewayEndpoint: () => `wss://127.0.0.1:${gateway.address().port}/` };
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
      nativeAdmin: { enabled: true, domain, sharedCookieDomain: "example.com" },
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
          const waitUntil = Date.now() + 1000;
          const waitForPhase = () => {
            if (entered[phase] || Date.now() > waitUntil) {
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
      const resetDeadline = Date.now() + 2000;
      while (!serverSockets.every((socket) => socket.destroyed) && Date.now() < resetDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
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
