import assert from "node:assert/strict";
import { randomUUID, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { once } from "node:events";
import { createRequire } from "node:module";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import test from "node:test";

import defaultCodexPreset from "../../deploy/presets/default-codex.json" with { type: "json" };
import { createNativeGatewayPeopleAccess } from "../../apps/controller/src/gateway/people-client.ts";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import {
  adminPrincipal,
  authBaseURL,
  createNativeAdminSetup,
  createSiblingAgent,
  injectJson,
  issueServiceKeyForNativeAgent,
  nativeAuthority,
  nativeDomain,
  nativeStatus,
  publicOrigin,
} from "./native-admin-access-fixture.ts";
import { callerDenied } from "../helpers/refusal-text.mjs";
import { grantRole } from "../helpers/iam-grants.ts";
import { createControllerAuth } from "../helpers/password-hasher.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import {
  InMemoryPlatformState,
  NoActiveAgentRevisionError,
  OpenClawController,
  ResourceConflictError,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture, denialsDuring } from "../helpers/console-app.mjs";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import {
  createHarnessConfiguration,
  withNativeAdminGateway,
} from "../helpers/harness-configuration.mjs";
import { sharedRsaPrivateKeyPem } from "../fixtures/repository-credentials/shared-keys.ts";
import { selfSigned } from "../helpers/certificates.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { registerNativeAdminHttpIntegrityCases } from "./native-admin-http-integrity-cases.ts";
import {
  registerNativeAdminSessionOriginCases,
  registerNativeAdminSessionRecoveryCase,
  registerNativeAdminSharedCookieCases,
} from "./native-admin-shared-session-cases.ts";
import {
  continueNativeAdminProxyCase,
  registerNativeAdminAvailabilityCases,
  registerNativeAdminCopiedLinkCase,
  registerNativeAdminDeniedBackCase,
  registerNativeAdminHostResolutionCase,
  registerNativeAdminRevisionDecodingCase,
} from "./native-admin-browser-access-cases.ts";

const nativeGatewayApiKey = `native-gateway-private-key-${randomUUID()}`;

function nativeOriginForAgent(
  installationId,
  namespaceId,
  agentId,
  domain = nativeDomain,
  origin = publicOrigin,
) {
  const publicUrl = new URL(origin);
  publicUrl.hostname = deriveNativeAdminHost(installationId, { namespaceId, id: agentId }, domain);
  return `${publicUrl.protocol}//${publicUrl.host}`;
}

function nativeAdminHarnessConfiguration(nativeOrigin) {
  const configuration = withNativeAdminGateway(
    createHarnessConfiguration("openclaw", "gpt-4.1"),
    nativeOrigin,
  );
  // Preserve read/write device coverage: the machine identity supplies admin.
  configuration.gateway.auth.trustedProxy.deviceAutoApprove = {
    enabled: true,
    scopes: ["operator.read", "operator.write"],
  };
  return configuration;
}

function nativeComputeDriver(upstreamPort, { exclusiveReplacement = false } = {}) {
  return createReadyComputeDriver("native-admin-compute", {
    // Kubernetes dedicated revisions stop their predecessors before they start.
    ...(exclusiveReplacement
      ? {
          requiresStoppedPredecessors:
            typeof exclusiveReplacement === "function" ? exclusiveReplacement : () => true,
        }
      : {}),
    implementation: "native-admin-test-upstream",
    // The HTTPS upstream is no OC Gateway, so this Compute applies no managed mode.
    supportsGatewayManagedMode: undefined,
    validateHarnessAuth() {},
    getGatewayEndpoint(revision) {
      return `wss://localhost:${upstreamPort}/namespaces/${revision.namespaceId}/agents/${revision.agentId}/`;
    },
    async getGatewayBrowserRequest(revision, { principalId, mode }) {
      return {
        endpoint: `wss://localhost:${upstreamPort}/native-browser/namespaces/${revision.namespaceId}/agents/${revision.agentId}/`,
        subject: `test:${principalId}`,
        headers: {
          "x-occ-identity": `test:${principalId}`,
          "x-occ-browser-key": "server-browser-credential",
          "x-openclaw-scopes": mode === "admin" ? "operator.admin" : "operator.sessions.write",
        },
      };
    },
  });
}

/** @typedef {import("./native-admin-http-integrity-cases.ts").NativeAdminHttpObservations} NativeAdminHttpObservations */
/** @typedef {import("./native-admin-http-integrity-cases.ts").NativeAdminStream} NativeAdminStream */

/**
 * @param {import("node:test").TestContext} t
 * @param {{ captureWire?: boolean, profiles?: object[] | (() => object[] | Promise<object[]>), validConfig?: () => boolean, gatewayConfig?: () => object }} [options]
 */
async function startNativeHttpsUpstream(
  t,
  {
    captureWire = false,
    profiles,
    validConfig = () => true,
    gatewayConfig = () => ({
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-occ-identity",
          allowUsers: ["occ-workspace-files", "oidc:alice"],
        },
      },
    }),
  } = {},
) {
  const directory = await temporaryDirectory(t, "openclaw-native-admin-upstream-");
  const { key, cert } = await selfSigned(directory, {
    // Shared keys still need distinct root subjects: OpenSSL can otherwise select
    // an older same-subject certificate instead of the current trusted leaf.
    commonName: `localhost/OU=${randomUUID()}`,
    keyPem: sharedRsaPrivateKeyPem("native-admin-upstream"),
    days: 2,
  });

  /** @type {NativeAdminHttpObservations["requests"]} */
  const requests = [];
  /** @type {NativeAdminHttpObservations["parsedRequests"]} */
  const parsedRequests = [];
  /** @type {NativeAdminHttpObservations["wire"]} */
  const wire = [];
  /** @type {NativeAdminHttpObservations["streams"]} */
  const streams = new Map();
  /** @type {NativeAdminHttpObservations["parserErrors"]} */
  const parserErrors = [];
  /** @type {Set<import("node:tls").TLSSocket>} */
  const sockets = new Set();
  // While set, every request gets this short 503 text/plain answer, like the route proxy's own
  // reply for a Gateway that refuses connections (a held or restarting container).
  /** @type {{ text: string | undefined }} */
  const routeProxy = { text: undefined };
  /**
   * @param {import("node:http").ServerResponse} response
   * @param {string} name
   * @param {number} statusCode
   * @param {{ contentLength?: number, continuous?: boolean }} [options]
   */
  const startStream = (response, name, statusCode, { contentLength, continuous = false } = {}) => {
    /** @type {(result: Awaited<NativeAdminStream["close"]>) => void} */
    let resolveClosed;
    /** @type {NativeAdminStream} */
    const control = {
      closed: false,
      finished: false,
      watchdogExpired: false,
      writes: 0,
      close: new Promise((resolve) => {
        resolveClosed = resolve;
      }),
      reset: () => response.destroy(),
    };
    streams.set(name, control);
    const prefix = `native-${name}-prefix\n`;
    /** @type {NodeJS.Timeout | undefined} */
    let interval;
    const deadline = setTimeout(() => {
      control.watchdogExpired = true;
      response.destroy();
    }, 4_000);
    response.once("close", () => {
      clearTimeout(deadline);
      clearInterval(interval);
      control.closed = true;
      control.finished = response.writableFinished;
      resolveClosed({ finished: control.finished, writes: control.writes });
    });
    response.writeHead(statusCode, {
      "content-type": "text/plain; charset=utf-8",
      ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
    });
    response.write(prefix);
    control.writes++;
    if (continuous) {
      interval = setInterval(() => {
        if (control.writes >= 100) {
          response.end();
          return;
        }
        response.write(`native-${name}-tick\n`);
        control.writes++;
      }, 20);
    }
  };
  const gateway = { connections: 0, lists: 0 };
  const connectionClosures = [];
  const server = createServer({ key, cert }, async (request, response) => {
    parsedRequests.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
    });
    /** @type {Uint8Array[]} */
    const chunks = [];
    /** @type {AsyncIterable<unknown>} */
    const body = request;
    for await (const chunk of body) {
      assert.ok(chunk instanceof Uint8Array, "the HTTPS request must deliver bytes");
      chunks.push(chunk);
    }
    requests.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (routeProxy.text !== undefined) {
      const text = routeProxy.text;
      response.writeHead(503, { "content-type": "text/plain", "content-length": text.length });
      response.end(text);
      return;
    }
    if (request.url?.endsWith("/integrity-response-reset")) {
      startStream(response, "response-reset", 200);
      return;
    }
    if (request.url?.endsWith("/integrity-response-short")) {
      startStream(response, "response-short", 200, { contentLength: 512 });
      return;
    }
    if (request.url?.endsWith("/integrity-response-pre-header")) {
      request.socket.destroy();
      return;
    }
    if (request.url?.endsWith("/integrity-response-complete")) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("native-complete-body\n");
      return;
    }
    if (request.url?.endsWith("/integrity-response-headers")) {
      response.writeHead(200, {
        "clear-site-data": '"cookies"',
        "set-cookie": "invented_native_integrity=never-publish; Path=/",
        "content-security-policy": "default-src 'self'",
        "content-type": "text/plain; charset=utf-8",
        "x-native-upstream": "integrity-headers",
      });
      response.end("native-header-body\n");
      return;
    }
    if (request.url?.endsWith("/api/users/integrity-avatar-stream/avatar")) {
      startStream(response, "avatar-stream", 502, { continuous: true });
      return;
    }
    if (request.url?.endsWith("/integrity-client-stream")) {
      startStream(response, "client-stream", 200, { continuous: true });
      return;
    }
    if (profiles && request.url?.includes("/api/users/")) {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([137, 80, 78, 71]));
      return;
    }
    if (request.url?.includes("/upstream-unavailable")) {
      // OpenClaw's answer when a Gravatar fallback cannot be fetched.
      response.writeHead(502, { "content-type": "application/json" });
      response.end('{"ok":false,"error":{"type":"avatar_upstream_unavailable"}}');
      return;
    }
    if (request.url?.endsWith("/redirect-root")) {
      response.writeHead(302, {
        "content-security-policy": "default-src 'self'",
        location: "/settings/profile?from=redirect",
      });
      response.end();
      return;
    }
    if (request.url?.endsWith("/redirect-external")) {
      response.writeHead(302, {
        location: "https://attacker.example.test/settings",
      });
      response.end();
      return;
    }
    if (request.url?.endsWith("/redirect-reserved")) {
      response.writeHead(302, {
        location: "/__occ/native-admin/bootstrap",
      });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-security-policy": "default-src 'self'",
      "content-type": "text/plain; charset=utf-8",
      "set-cookie": "native_session=must-not-leak; Path=/",
      "x-native-upstream": "reached",
    });
    response.end("native admin upstream\n");
  });
  // Register after HTTPS installs its parser: Node's data-listener wrapper then
  // leaves optimized socket consumption and exposes the same decrypted bytes.
  server.on("secureConnection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (!captureWire) {
      return;
    }
    /** @type {NativeAdminHttpObservations["wire"][number]} */
    const observation = { chunks: [], bytes: 0, overflow: false };
    wire.push(observation);
    socket.prependListener("data", (/** @type {Buffer} */ chunk) => {
      if (observation.bytes + chunk.length > 65_536) {
        observation.overflow = true;
        return;
      }
      observation.chunks.push(Buffer.from(chunk));
      observation.bytes += chunk.length;
    });
  });
  if (captureWire) {
    server.on("clientError", (error, socket) => {
      parserErrors.push({ code: error.code });
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  }
  if (profiles) {
    const controllerRequire = createRequire(
      new URL("../../apps/controller/package.json", import.meta.url),
    );
    const socketRequire = createRequire(controllerRequire.resolve("@kubernetes/client-node"));
    const { WebSocketServer } = socketRequire("ws");
    const sockets = new WebSocketServer({ server });
    t.after(() => sockets.close());
    sockets.on("connection", (socket) => {
      gateway.connections++;
      connectionClosures.push(once(socket, "close"));
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "people-fixture", ts: Date.now() },
        }),
      );
      socket.on("message", async (raw) => {
        const request = JSON.parse(raw.toString());
        assert.ok(["connect", "config.get", "users.list"].includes(request.method));
        let listed;
        if (request.method === "users.list") {
          gateway.lists++;
          try {
            listed = typeof profiles === "function" ? await profiles() : profiles;
          } catch {
            socket.send(
              JSON.stringify({
                type: "res",
                id: request.id,
                ok: false,
                error: { code: "UNAVAILABLE", message: "Profile read failed." },
              }),
            );
            return;
          }
        }
        let payload;
        if (request.method === "users.list") {
          payload = { profiles: listed };
        } else if (request.method === "config.get") {
          const valid = validConfig();
          payload = { valid, runtimeConfig: valid ? { gateway: gatewayConfig() } : {} };
        } else {
          payload = {
            type: "hello-ok",
            protocol: 4,
            server: { version: "fixture", connId: "people-fixture" },
            features: { methods: ["config.get", "users.list"], events: [] },
            snapshot: {},
            auth: { role: "operator", scopes: ["operator.admin"] },
            policy: {
              maxPayload: 1048576,
              maxBufferedBytes: 1048576,
              tickIntervalMs: 30000,
            },
          };
        }
        socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
      });
    });
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        for (const control of streams.values()) {
          control.reset();
        }
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return {
    port: address.port,
    requests,
    parsedRequests,
    wire,
    streams,
    parserErrors,
    cert,
    gateway,
    connectionClosures,
    routeProxy,
  };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{
 *   state?: import("../../packages/occ/src/index.ts").PlatformStateStore,
 *   upstream?: {captureWire?: boolean},
 *   gatewayPeopleAccess?: import("../../apps/controller/src/gateway/contracts.ts").ControllerGatewayPeopleAccess,
 *   publicOrigin?: string,
 *   authBaseURL?: string,
 *   development?: import("../../apps/controller/src/index.ts").ControllerAppOptions["development"],
 *   auditSink?: InMemoryAuditSink,
 *   logger?: import("../../apps/controller/src/logging.ts").OccLogger,
 *   recordOperations?: boolean,
 *   nativeAdminEnabled?: boolean,
 *   nativeDomain?: string,
 *   configure?: (origin: string) => object,
 *   exclusiveReplacement?: boolean | ((revision: import("../../packages/contracts/src/index.ts").AgentRevision) => boolean),
 * }} [options]
 */
async function createNativeAdminFixture(t, options = {}) {
  const upstream = await startNativeHttpsUpstream(t, options.upstream);
  const fixture = await createConsoleAppFixture(t, {
    ...(options.state === undefined ? {} : { state: options.state }),
    publicOrigin: options.publicOrigin ?? publicOrigin,
    authBaseURL: options.authBaseURL ?? authBaseURL,
    development: options.development ?? { enabled: false },
    auditSink: options.auditSink,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.recordOperations === undefined
      ? {}
      : { recordOperations: options.recordOperations }),
    nativeAdmin: {
      enabled: options.nativeAdminEnabled ?? true,
      domain: options.nativeDomain ?? nativeDomain,
    },
    nativeAdminGatewayApiKey: async () => nativeGatewayApiKey,
    // The HTTPS upstream simulates the native admin endpoint; it is not an OC Gateway.
    gatewayPeopleAccess: options.gatewayPeopleAccess,
    agentGatewayManagedMode: false,
    computeDriver: nativeComputeDriver(upstream.port, {
      exclusiveReplacement: options.exclusiveReplacement,
    }),
  });
  return { fixture, upstream, ...(await completeNativeAdminFixture(fixture, options)) };
}

const { completeFixture: completeNativeAdminFixture, createLiveNativeAgent } =
  createNativeAdminSetup({ nativeOriginForAgent, nativeAdminHarnessConfiguration });

// A signed-in account whose one Role holds `permissions` in the Namespace, bound across it or,
// with `resource`, to that one resource.
async function createAgentPermissionSession(context, label, permissions, resource) {
  const limited = await context.fixture.createAccountWithPolicy(label, (principal) => {
    grantRole(context.fixture.policy, principal.id, {
      id: `role-${label}-${randomUUID()}`,
      bindingId: `binding-${label}-${randomUUID()}`,
      namespaceId: context.namespace.id,
      permissions,
      resource,
    });
  });
  return context.fixture.signIn(limited.credentials);
}

async function createReadOnlySession(context, label = "native-admin-read-only") {
  return createAgentPermissionSession(context, label, { agent: ["read"] });
}

async function createExactAgentAdministerSession(context, label = "native-admin-exact-administer") {
  return createAgentPermissionSession(
    context,
    label,
    { agent: ["administer"] },
    { kind: "agent", id: context.agent.id },
  );
}

// An exact Agent administer binding names one Agent: the same session asking for a second
// Agent's status in the Namespace gets `deniedText` for it, audited once for that Agent.
async function assertSiblingStatusDenied(context, session, deniedText) {
  const sibling = await createSiblingAgent(context);
  const { response, denials } = await denialsDuring(context.fixture.auditSink, () =>
    nativeStatus({ ...context, agent: sibling }, { session }),
  );
  assertApiError(response, 403, "FORBIDDEN");
  assert.equal(response.body.error.message, deniedText(`Agent ${sibling.id}`));
  assert.deepEqual(denials, [{ action: "operate", kind: "agent", id: sibling.id }]);
}

/** @param {import("node:test").TestContext} t @param {string} cert */
function trustLocalUpstreamCertificate(t, cert) {
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, cert]);
  const fingerprint = new X509Certificate(cert).fingerprint256;
  // Remove only this root, after the Console fixture has restored its own trust.
  // A whole earlier snapshot can resurrect certificates from fixtures already closed.
  t.after(() =>
    setDefaultCACertificates(
      getCACertificates("default").filter(
        (candidate) => new X509Certificate(candidate).fingerprint256 !== fingerprint,
      ),
    ),
  );
}

test("native browser status selects exact Agent authority and reports lifecycle availability", async (t) => {
  const context = await createNativeAdminFixture(t);

  const available = await nativeStatus(context);
  assert.equal(available.status, 200);
  assert.equal(available.data.status, "available");
  assert.equal(available.data.mode, "admin");
  assert.equal(available.data.activeRevisionId, context.revision.id);
  assert.match(available.data.host, new RegExp(`\\.${nativeDomain.replaceAll(".", "\\.")}$`));
  assert.equal(new URL(available.data.url).hostname, available.data.host);
  assert.equal(new URL(available.data.url).pathname, "/");
  assert.equal(available.data.bootstrapUrl, undefined);

  const exactAdministerOnlySession = await createExactAgentAdministerSession(
    context,
    "native-admin-status-exact-administer",
  );
  const exactAvailable = await nativeStatus(context, { session: exactAdministerOnlySession });
  assert.equal(exactAvailable.status, 200);
  assert.equal(exactAvailable.data.status, "available");
  await assertSiblingStatusDenied(context, exactAdministerOnlySession, (target) =>
    callerDenied("Agent operate", target),
  );

  // An IAM outage is a dependency failure, never an Agent lifecycle state: the console must
  // not read it as "unavailable" (deploying) for an Agent the caller may not even administer.
  const authorize = context.fixture.iamDriver.authorize;
  context.fixture.iamDriver.authorize = async () => {
    throw new Error("IAM outage");
  };
  let iamOutage;
  try {
    iamOutage = await nativeStatus(context);
  } finally {
    context.fixture.iamDriver.authorize = authorize;
  }
  assert.equal(iamOutage.status, 503);
  assert.equal(iamOutage.body.error.code, "DEPENDENCY_UNAVAILABLE");

  // An exact operate grant opens only the restricted route; it does not imply administration.
  const operatorSession = await createAgentPermissionSession(
    context,
    "exact-operator",
    {
      agent: ["operate"],
    },
    { kind: "agent", id: context.agent.id },
  );
  const chat = await nativeStatus(context, { session: operatorSession });
  assert.equal(chat.status, 200);
  assert.equal(chat.data.mode, "chat");
  trustLocalUpstreamCertificate(t, context.upstream.cert);
  const response = await injectJson(context.fixture, "GET", "/", {
    headers: {
      host: nativeAuthority(chat.data),
      origin: chat.data.origin,
      cookie: operatorSession.cookie,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    context.upstream.requests.at(-1).url,
    `/native-browser/namespaces/${context.namespace.id}/agents/${context.agent.id}`,
  );
  await assertSiblingStatusDenied(context, operatorSession, (target) =>
    callerDenied("Agent operate", target),
  );
  const driver = context.fixture.controller.selectedDriver("compute");
  const chatEndpoint = driver.getGatewayBrowserRequest;
  driver.getGatewayBrowserRequest = undefined;
  try {
    const unsupported = await nativeStatus(context, { session: operatorSession });
    assert.equal(unsupported.data.status, "unsupported");
    // The Configuration is complete; the Compute Driver gives no chat endpoint (finding 3168).
    assert.equal(unsupported.data.reason, "compute");
    assert.equal(unsupported.data.mode, "chat");
  } finally {
    driver.getGatewayBrowserRequest = chatEndpoint;
  }

  const limitedSession = await createReadOnlySession(context, "native-admin-reader");
  const denied = await nativeStatus(context, { session: limitedSession });
  assertApiError(denied, 403, "FORBIDDEN");
  // With native admin on, the grant is all the caller lacks.
  assert.equal(
    denied.body.error.message,
    callerDenied("Agent operate", `Agent ${context.agent.id}`),
  );

  const missingStatus = await context.fixture.request(
    "GET",
    `/namespaces/${context.namespace.id}/agents/agt_${randomUUID()}/native-admin`,
  );
  assert.equal(missingStatus.status, 404);
  assert.equal(missingStatus.body.error.code, "NOT_FOUND");

  const stopped = await context.fixture.request(
    "POST",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  const stoppedStatus = await nativeStatus(context);
  assert.equal(stoppedStatus.status, 200);
  assert.equal(stoppedStatus.data.status, "stopped");
  assert.equal(stoppedStatus.data.host, available.data.host);

  // Completed stop reconciliation clears the selected revision but retains historical revisions.
  const cleared = await context.fixture.controller.transact((state) =>
    state.agents.compareAndClearActiveRevision(
      context.namespace.id,
      context.agent.id,
      context.revision.id,
    ),
  );
  assert.equal(cleared.desiredRuntimeState, "stopped");
  assert.equal(cleared.activeRevisionId, undefined);
  const controllerStatus = () =>
    context.fixture.controller.getAdministerableActiveAgentRevision(
      adminPrincipal(context.fixture).id,
      context.namespace.id,
      context.agent.id,
    );
  await assert.rejects(controllerStatus, ResourceConflictError);
  const fullyStopped = await nativeStatus(context, { session: exactAdministerOnlySession });
  assert.equal(fullyStopped.status, 200);
  assert.deepEqual(fullyStopped.data, { status: "stopped" });
  const stillDenied = await nativeStatus(context, { session: limitedSession });
  assertApiError(stillDenied, 403, "FORBIDDEN");
  const { key: serviceKey } = await issueServiceKeyForNativeAgent(context);
  const serviceDenied = await injectJson(
    context.fixture,
    "GET",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/native-admin`,
    { headers: { "x-api-key": serviceKey } },
  );
  assert.equal(serviceDenied.statusCode, 403);
  assert.equal(serviceDenied.json().error.code, "FORBIDDEN");
  // The denial tells key holders what to use instead; it names no Agent state.
  assert.equal(
    serviceDenied.json().error.message,
    "Native admin UI requires a signed-in console session; service API keys cannot open it.",
  );

  // Redeployment makes the Agent desired-running before a worker selects the new revision.
  const pending = await context.fixture.deployAgent(context.namespace.id, context.agent.id);
  await assert.rejects(controllerStatus, NoActiveAgentRevisionError);
  const unavailable = await nativeStatus(context, { session: exactAdministerOnlySession });
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.data, { status: "unavailable" });
  await context.fixture.activateRevision(context.namespace.id, context.agent.id, pending.id);
  const restored = await nativeStatus(context, { session: exactAdministerOnlySession });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.status, "available");
  assert.equal(restored.data.activeRevisionId, pending.id);
});

// What Create Agent saves from the shipped default Preset (Console `configurationTemplate`):
// its gateway, with Control UI on for loopback port-forward origins only, and the selected
// model. `nativeOrigin` is added to the allowed origins when given.
function defaultPresetConfiguration(nativeOrigin) {
  const { gateway } = structuredClone(defaultCodexPreset.template.configuration.values);
  if (nativeOrigin !== undefined) {
    gateway.controlUi.allowedOrigins.push(nativeOrigin);
  }
  return { ...createHarnessConfiguration("openclaw", "gpt-4.1"), gateway };
}

// Findings 3168 and 3189: an unsupported status names its cause, so the console can say what to
// change. A Configuration without the browser chat opt-in is not-enabled: Control UI off, or on
// without this Agent's origin and trusted-proxy auth. A browser chat setup that refuses for
// another reason is configuration. All Agents are deployed and running.
test("native browser status names why a Configuration is unsupported", async (t) => {
  const context = await createNativeAdminFixture(t);
  for (const [name, configure, reason] of [
    ["Browser chat off", () => createHarnessConfiguration("openclaw", "gpt-4.1"), "not-enabled"],
    // Create Agent from the default Preset with Enable browser chat unchecked (finding 3189).
    ["Default Preset", () => defaultPresetConfiguration(), "not-enabled"],
    // Browser chat is on, but its allowed origin is the console, not this Agent.
    ["Other origin", () => nativeAdminHarnessConfiguration(publicOrigin), "configuration"],
    // This Agent's origin is allowed, but the gateway keeps password auth.
    ["Password auth", defaultPresetConfiguration, "configuration"],
  ]) {
    const { agent } = await createLiveNativeAgent(context.fixture, context.namespace, name, {
      configure,
    });
    const status = await nativeStatus({ ...context, agent });
    assert.equal(status.status, 200, name);
    assert.equal(status.data.status, "unsupported", name);
    assert.equal(status.data.reason, reason, name);
  }
});

test("native admin stays available before the shared stop boundary, then becomes unavailable", async (t) => {
  // The adapter records transport attempts; the real controller owns lifecycle selection.
  const rosterReads = [];
  const gatewayPeopleAccess = {
    async list({ revision }) {
      rosterReads.push(revision.id);
      return [];
    },
    async avatar({ revision }) {
      rosterReads.push(revision.id);
      return undefined;
    },
  };
  const peoplePath = ({ namespace, agent }) =>
    `/namespaces/${namespace.id}/agents/${agent.id}/gateway/people`;
  // Without exclusive replacement the active revision keeps serving during a redeploy.
  const shared = await createNativeAdminFixture(t, { gatewayPeopleAccess });
  await shared.fixture.deployAgent(shared.namespace.id, shared.agent.id);
  const stillServing = await nativeStatus(shared);
  assert.equal(stillServing.status, 200);
  assert.equal(stillServing.data.status, "available");
  assert.equal(stillServing.data.activeRevisionId, shared.revision.id);
  assert.equal((await shared.fixture.request("GET", peoplePath(shared))).status, 200);
  assert.deepEqual(rosterReads, [shared.revision.id]);

  const context = await createNativeAdminFixture(t, {
    exclusiveReplacement: (revision) => revision.revision === 2,
    gatewayPeopleAccess,
  });
  const available = await nativeStatus(context);
  assert.equal(available.data.status, "available");
  const replacement = await context.fixture.deployAgent(context.namespace.id, context.agent.id);
  const waiting = await nativeStatus(context);
  assert.equal(waiting.data.status, "available");
  assert.equal(waiting.data.activeRevisionId, context.revision.id);
  assert.equal((await context.fixture.request("GET", peoplePath(context))).status, 200);
  assert.equal(rosterReads.at(-1), context.revision.id, "the pre-stop predecessor still serves");
  await context.fixture.controller.transact((state) =>
    state.agents.recordPredecessorReplacement(context.namespace.id, context.agent.id, {
      predecessorRevisionId: context.revision.id,
      candidateRevisionId: replacement.id,
      phase: "stopping",
    }),
  );
  // A stopped predecessor stays unavailable even if a newer candidate fails.
  const replacing = await nativeStatus(context);
  assert.equal(replacing.status, 200);
  assert.deepEqual(replacing.data, { status: "unavailable" });
  // Neither roster nor avatar reads may contact the stopped predecessor during replacement.
  const readsBeforeReplacement = rosterReads.length;
  for (const suffix of ["", "/profile-alice/avatar"]) {
    const result = await context.fixture.request("GET", peoplePath(context) + suffix);
    assert.equal(result.status, 409, "the selected predecessor no longer serves the Gateway");
  }
  assert.equal(rosterReads.length, readsBeforeReplacement);
  const agent = await context.fixture.request(
    "GET",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}`,
  );
  assert.equal(agent.data.activeRevisionId, context.revision.id);

  const nextReplacement = await context.fixture.deployAgent(context.namespace.id, context.agent.id);
  assert.deepEqual((await nativeStatus(context)).data, { status: "unavailable" });
  const readsBeforeSuccessor = rosterReads.length;
  assert.equal((await context.fixture.request("GET", peoplePath(context))).status, 409);
  assert.equal(
    rosterReads.length,
    readsBeforeSuccessor,
    "a newer candidate cannot reopen the stopped predecessor",
  );

  await context.fixture.activateRevision(
    context.namespace.id,
    context.agent.id,
    nextReplacement.id,
    context.revision.id,
  );
  const restored = await nativeStatus(context);
  assert.equal(restored.data.status, "available");
  assert.equal(restored.data.activeRevisionId, nextReplacement.id);
  assert.equal((await context.fixture.request("GET", peoplePath(context))).status, 200);
  assert.equal(rosterReads.at(-1), nextReplacement.id);
});

test("redeploy after explicit Stop keeps the old native endpoint closed", async (t) => {
  const context = await createNativeAdminFixture(t, { exclusiveReplacement: true });
  const stop = await context.fixture.request(
    "POST",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/stop`,
  );
  assert.equal(stop.status, 202);
  await context.fixture.deployAgent(context.namespace.id, context.agent.id);
  assert.deepEqual((await nativeStatus(context)).data, { status: "unavailable" });
});

export const nativeAdminCaseDependencies = {
  createNativeAdminFixture,
  nativeOriginForAgent,
  createReadOnlySession,
  createExactAgentAdministerSession,
  createAgentPermissionSession,
  assertSiblingStatusDenied,
  trustLocalUpstreamCertificate,
};
registerNativeAdminAvailabilityCases(test, nativeAdminCaseDependencies);

registerNativeAdminSharedCookieCases(test, nativeAdminCaseDependencies);

registerNativeAdminCopiedLinkCase(test, nativeAdminCaseDependencies);

registerNativeAdminSessionRecoveryCase(test, nativeAdminCaseDependencies);

test("native admin proxy strips browser credentials and preserves the Agent gateway base path", async (t) => {
  const context = await createNativeAdminFixture(t);
  const status = await nativeStatus(context);
  const administerOnlySession = await createExactAgentAdministerSession(
    context,
    "native-admin-proxy-exact-administer",
  );
  const nativeCookie = administerOnlySession.cookie;
  const nativeSessionKey = (
    await injectJson(context.fixture, "GET", "/api/auth/session", {
      headers: { cookie: nativeCookie },
    })
  ).json().data.sessionKey;
  assert.match(nativeSessionKey, /^[A-Za-z0-9_-]{43}$/);

  trustLocalUpstreamCertificate(t, context.upstream.cert);

  const proxied = await injectJson(context.fixture, "GET", "/settings/profile?tab=devices", {
    headers: {
      host: nativeAuthority(status.data),
      origin: status.data.origin,
      cookie: nativeCookie,
      "x-forwarded-for": "203.0.113.1",
      "x-occ-identity": "must-not-forward",
      "x-occ-browser-key": "must-not-forward",
      "x-openclaw-scopes": "must-not-forward",
      "x-safe-client-header": "preserved",
      "x-occ-session-key": nativeSessionKey,
    },
  });
  assert.equal(proxied.statusCode, 200, proxied.body);
  assert.equal(proxied.headers["x-native-upstream"], "reached");
  assert.equal(proxied.headers["set-cookie"], undefined);
  assert.match(String(proxied.headers["content-security-policy"]), /default-src 'self'/);
  assert.match(String(proxied.headers["content-security-policy"]), /worker-src 'none'/);

  assert.equal(context.upstream.requests.length, 1);
  const observed = context.upstream.requests[0];
  assert.equal(
    observed.url,
    `/native-browser/namespaces/${context.namespace.id}/agents/${context.agent.id}/settings/profile?tab=devices`,
  );
  assert.equal(observed.headers.origin, status.data.origin);
  assert.equal(observed.headers["x-safe-client-header"], "preserved");
  assert.equal(observed.headers["x-api-key"], nativeGatewayApiKey);
  assert.equal(observed.headers["x-occ-browser-key"], "server-browser-credential");
  assert.match(observed.headers["x-occ-identity"], /^test:/);
  assert.equal(observed.headers["x-openclaw-scopes"], "operator.admin");
  for (const header of ["authorization", "cookie", "x-forwarded-for", "x-occ-session-key"]) {
    assert.equal(observed.headers[header], undefined, `${header} must not reach native upstream`);
  }

  await continueNativeAdminProxyCase(context, status, nativeCookie, createLiveNativeAgent);
});
registerNativeAdminHostResolutionCase(test, nativeAdminCaseDependencies);

registerNativeAdminRevisionDecodingCase(test, nativeAdminCaseDependencies);

registerNativeAdminSessionOriginCases(test, nativeAdminCaseDependencies);

for (const changedField of [undefined, "id", "implementation"]) {
  test(`native admin retains the revision Compute owner after restart: ${changedField ?? "matching"}`, async (t) => {
    const state = new InMemoryPlatformState();
    const context = await createNativeAdminFixture(t, { state });
    const { fixture, upstream, namespace, agent, revision } = context;
    trustLocalUpstreamCertificate(t, upstream.cert);
    const originalCompute = fixture.controller.selectedDriver("compute");
    assert.deepEqual(revision.compute, {
      id: originalCompute.id,
      implementation: originalCompute.implementation,
    });

    // Reopen the same committed revision with a fresh registry, as on controller restart.
    // In particular, changing only implementation must not mutate a registered Driver.
    const controller = new OpenClawController(fixture.controller.installation, {
      state,
      recordOperations: false,
    });
    controller.registerDriver(fixture.iamDriver);
    controller.selectDriver("iam", fixture.iamDriver.id);
    const calls = { endpoint: 0, key: 0 };
    const compute = {
      ...nativeComputeDriver(upstream.port),
      ...(changedField === undefined ? {} : { [changedField]: `replacement-${changedField}` }),
      async getGatewayBrowserRequest(selectedRevision, input, signal) {
        calls.endpoint += 1;
        assert.equal(selectedRevision.id, revision.id);
        assert.equal(input.installationId, controller.installation.id);
        return originalCompute.getGatewayBrowserRequest(selectedRevision, input, signal);
      },
    };
    controller.registerDriver(compute);
    controller.selectDriver("compute", compute.id);
    const auth = createControllerAuth({
      installationId: controller.installation.id,
      mode: "development",
      baseURL: authBaseURL,
      secret: `native-restart-test-${randomUUID()}-${randomUUID()}`,
      memoryDatabase: fixture.memoryDatabase,
      agentDomain: nativeDomain,
    });
    const logLines = [];
    const app = createFastifyApp({
      controller,
      iamDriver: fixture.iamDriver,
      auth,
      logger: createOccLogger({
        component: "native-admin-test",
        level: "info",
        destination: {
          write(chunk) {
            logLines.push(...String(chunk).split("\n").filter(Boolean));
            return true;
          },
        },
      }),
      auditSink: new InMemoryAuditSink(),
      development: { enabled: false },
      resolveHarness: resolveApprovedHarness,
      publicOrigin,
      nativeAdmin: { enabled: true, domain: nativeDomain },
      nativeAdminGatewayApiKey: async () => {
        calls.key += 1;
        return nativeGatewayApiKey;
      },
    });
    t.after(() => app.close());
    const session = await signInToControllerApp(app, fixture.credentials);
    const headers = { cookie: session.cookie, origin: publicOrigin };
    const status = await injectJson(
      { app },
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
      { headers },
    );
    const host = new URL(nativeOriginForAgent(controller.installation.id, namespace.id, agent.id))
      .host;
    const proxyLogStart = logLines.length;
    const proxy = await injectJson({ app }, "GET", "/", {
      headers: { ...headers, host, origin: `https://${host}` },
    });
    if (changedField === undefined) {
      const proxyCompletions = logLines
        .slice(proxyLogStart)
        .map((line) => JSON.parse(line))
        .filter((line) => line.event === "http.completed");
      assert.equal(proxyCompletions.length, 1);
      assert.equal(proxyCompletions[0].status, 200);
      assert.ok(proxyCompletions[0].requestId);
      assert.equal(proxyCompletions[0].nativeAdmissionReason, undefined);
      const refused = await app.inject({
        method: "GET",
        url: "/?private=discard-query-marker",
        headers: { host, cookie: "discard-cookie-marker=private" },
      });
      assert.equal(refused.statusCode, 403);
      const completions = logLines
        .map((line) => JSON.parse(line))
        .filter((line) => line.event === "http.completed");
      const completed = completions.find(
        (line) => line.requestId === refused.headers["x-request-id"],
      );
      assert.ok(completed, "the refusal must correlate to its existing HTTP request ID");
      assert.equal(completed.nativeAdmissionReason, "session_invalid");
      assert.equal(completed.status, 403);
      assert.ok(!JSON.stringify(completed).includes("discard-"));
    }
    // A console poll repeats the status read; the mismatch is still warned only once.
    const repeated = await injectJson(
      { app },
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
      { headers },
    );
    assert.equal(repeated.statusCode, status.statusCode);
    const mismatchLogs = logLines
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "native_admin.compute_owner_mismatch");
    if (changedField === undefined) {
      assert.deepEqual(mismatchLogs, []);
      assert.equal(status.statusCode, 200);
      assert.equal(status.json().data.status, "available");
      assert.equal(proxy.statusCode, 200);
      assert.equal(proxy.body, "native admin upstream\n");
      assert.equal(calls.endpoint, 3);
      assert.equal(calls.key, 1);
      assert.equal(upstream.requests.length, 1);
    } else {
      assert.equal(status.statusCode, 503);
      assert.equal(status.json().error.code, "DEPENDENCY_UNAVAILABLE");
      // Agent-host admission retains its existing non-disclosing refusal envelope.
      assert.equal(proxy.statusCode, 403);
      assert.deepEqual(calls, { endpoint: 0, key: 0 });
      assert.equal(upstream.requests.length, 0);
      // One operator line names both owners and the recovery; no endpoint or key.
      assert.equal(mismatchLogs.length, 1, logLines.join("\n"));
      const [logged] = mismatchLogs;
      assert.equal(logged.severity, "WARN");
      assert.deepEqual(
        {
          namespaceId: logged.namespaceId,
          agentId: logged.agentId,
          revisionId: logged.revisionId,
          revisionCompute: logged.revisionCompute,
          selectedCompute: logged.selectedCompute,
        },
        {
          namespaceId: namespace.id,
          agentId: agent.id,
          revisionId: revision.id,
          revisionCompute: revision.compute,
          selectedCompute: { id: compute.id, implementation: compute.implementation },
        },
      );
      assert.match(logged.message, /Select that Compute Driver again/);
      const text = logLines.join("\n");
      assert.ok(!text.includes(nativeGatewayApiKey), "the gateway key must not be logged");
      assert.ok(
        !text.includes(originalCompute.getGatewayEndpoint(revision)),
        "the private gateway endpoint must not be logged",
      );
    }
    const persisted = await state.read((view) =>
      view.revisions.findRevision(namespace.id, agent.id, revision.id),
    );
    assert.deepEqual(persisted, revision, "selection changes must not rewrite the active revision");
  });
}

registerNativeAdminDeniedBackCase(test, nativeAdminCaseDependencies);

/** @type {import("./native-admin-http-integrity-cases.ts").CreateNativeAdminHttpFixture} */
async function liveNativeAdminFixture(t, options = {}) {
  const context = await createNativeAdminFixture(t, options);
  // The console fixture returns untyped JSON. Check only the fields the wire cases consume.
  /** @type {unknown} */
  const native = (await nativeStatus(context)).data;
  assert.ok(
    native && typeof native === "object" && "origin" in native && typeof native.origin === "string",
    "the native status must expose an origin",
  );
  /** @type {unknown} */
  const agentId = context.agent.id;
  assert.ok(typeof agentId === "string", "the live Agent must expose an ID");
  const session = await createExactAgentAdministerSession(context, "native-http-integrity");
  trustLocalUpstreamCertificate(t, context.upstream.cert);
  const address = context.fixture.app.server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return {
    upstream: context.upstream,
    namespaceId: context.namespace.id,
    agentId,
    nativeOrigin: native.origin,
    nativeGatewayApiKey,
    createReadOnlySession: (label) => createReadOnlySession(context, label),
    port: address.port,
    nativeHeaders: {
      host: nativeAuthority(native),
      origin: native.origin,
      cookie: session.cookie,
    },
  };
}

registerNativeAdminHttpIntegrityCases(test, liveNativeAdminFixture);
test("Gateway people report an unconfigured adapter without exposing it to unauthorized callers", async (t) => {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["gateway-reader"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unconfigured Gateway people", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Team",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/gateway/people`;
  const denied = await fixture.signIn(fixture.provisionedAccounts[0].credentials);
  assert.equal((await fixture.request("GET", path, { session: denied })).status, 403);
  const result = await fixture.request("GET", path);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { people: null });
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal((await fixture.request("GET", path + "/profile-alice/avatar")).status, 501);
});

test("Gateway people HTTP reads require exact Agent administration and omit adapter internals", async (t) => {
  // The adapter is injected here to isolate HTTP authorization and serialization.
  // Installed Gateway profile/role behavior is covered by the real-runtime proof.
  let calls = 0;
  const fixture = await createConsoleAppFixture(t, {
    provisionedPeople: ["gateway-reader"],
    gatewayPeopleAccess: {
      async list() {
        calls++;
        return [
          {
            identity: "oidc:alice",
            profileId: "profile-alice",
            displayName: "Alice Team",
            role: "member",
            hasAvatar: false,
            privateIdentity: "must-not-leak",
          },
        ];
      },
      async avatar() {
        calls++;
        return undefined;
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Gateway people", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Team",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/gateway/people`;
  const denied = await fixture.signIn(fixture.provisionedAccounts[0].credentials);
  assert.equal((await fixture.request("GET", path, { session: denied })).status, 403);
  assert.equal(
    (await fixture.request("GET", path + "/profile-alice/avatar", { session: denied })).status,
    403,
  );
  assert.equal(calls, 0, "unauthorized callers must not contact the Gateway");
  const people = await fixture.request("GET", path);
  assert.equal(people.status, 200, JSON.stringify(people.body));
  assert.deepEqual(people.data.people, [
    {
      identity: "oidc:alice",
      profileId: "profile-alice",
      displayName: "Alice Team",
      role: "member",
      hasAvatar: false,
    },
  ]);
  assert.equal(people.headers.get("cache-control"), "no-store");
  assert.equal((await fixture.request("GET", path + "/profile-alice/avatar")).status, 404);

  // Roster administration is its own exact action, not an Agent-read or Namespace-read grant.
  const exactAccount = await fixture.createAccountWithPolicy("roster-admin-only", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "roster-exact-admin",
      namespaceId: namespace.id,
      permissions: { agent: ["administer"] },
      resource: { kind: "agent", id: agent.id },
    });
  });
  const exactSession = await fixture.signIn(exactAccount.credentials);
  assert.equal((await fixture.request("GET", path, { session: exactSession })).status, 200);
  assert.equal(
    (
      await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`, {
        session: exactSession,
      })
    ).status,
    403,
  );
  const sibling = await fixture.createAgent(
    namespace.id,
    "Other Gateway",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  assert.equal(
    (
      await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/agents/${sibling.id}/gateway/people`,
        { session: exactSession },
      )
    ).status,
    403,
  );
  // The selected IAM Driver must apply an overriding Restriction before either adapter call.
  fixture.policy.restrictions.push({
    id: "deny-roster-administration",
    namespaceId: namespace.id,
    effect: "deny",
    action: "administer",
    resourceKind: "agent",
    resourceId: agent.id,
  });
  const callsBeforeDenial = calls;
  for (const suffix of ["", "/profile-alice/avatar"]) {
    assert.equal(
      (await fixture.request("GET", path + suffix, { session: exactSession })).status,
      403,
    );
  }
  assert.equal(calls, callsBeforeDenial);
});

test("Gateway avatars exclude service profiles and merged aliases before image fetch", async (t) => {
  // Exercise the production adapter over TLS and WebSocket. The peer supplies
  // profiles, while the adapter must decide which avatars OCC may expose.
  const upstream = await startNativeHttpsUpstream(t, {
    profiles: [
      { id: "gateway-owner", hasAvatar: true },
      { id: "workspace-profile", emails: ["occ-workspace-files"], hasAvatar: true },
      { id: "merged-profile", mergedInto: "profile-alice", hasAvatar: true },
      { id: "profile-alice", emails: ["oidc:alice"], displayName: "Alice", hasAvatar: true },
    ],
  });
  const access = createNativeGatewayPeopleAccess(async () => ({
    url: `wss://localhost:${upstream.port}/`,
    apiKey: nativeGatewayApiKey,
  }));
  const fixture = await createConsoleAppFixture(t, { gatewayPeopleAccess: access });
  // Register native trust after Console trust so cleanup cannot capture a stale root.
  trustLocalUpstreamCertificate(t, upstream.cert);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Filtered avatars", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Team",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const headers = authenticatedHeaders(await fixture.signIn());
  const avatarUrl = (profileId) =>
    `/namespaces/${namespace.id}/agents/${agent.id}/gateway/people/${profileId}/avatar`;
  for (const profileId of [
    "gateway-owner",
    "workspace-profile",
    "merged-profile",
    "unknown-profile",
  ]) {
    const result = await fixture.rawRequest("GET", avatarUrl(profileId), { headers });
    assert.equal(result.response.status, 404, profileId);
  }
  assert.equal(upstream.requests.length, 0, "excluded profiles never reach the avatar endpoint");
  const avatar = await fixture.rawRequest("GET", avatarUrl("profile-alice"), { headers });
  assert.equal(avatar.response.status, 200);
  assert.equal(avatar.response.headers.get("content-type"), "image/png");
  assert.equal(avatar.text.slice(1), "PNG");
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].url, "/api/users/profile-alice/avatar");
});

test("concurrent roster and avatar reads share a pending Gateway list but never a completed result", async (t) => {
  const admitted = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  let profiles = ["alice", "bob", "carol"].map((name) => ({
    id: `profile-${name}`,
    emails: [`oidc:${name}`],
    displayName: name,
    hasAvatar: true,
  }));
  let fail = false;
  const upstream = await startNativeHttpsUpstream(t, {
    gatewayConfig: () => ({
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-occ-identity",
          allowUsers: ["occ-workspace-files", "oidc:alice", "oidc:bob", "oidc:carol"],
        },
      },
    }),
    profiles: async () => {
      await release.promise;
      if (fail) {
        throw new Error("Read refused");
      }
      return profiles;
    },
  });
  let resolutions = 0;
  const access = createNativeGatewayPeopleAccess(async () => {
    if (++resolutions === 4) {
      admitted.resolve();
    }
    return { url: `wss://localhost:${upstream.port}/`, apiKey: nativeGatewayApiKey };
  });
  const fixture = await createConsoleAppFixture(t, {
    gatewayPeopleAccess: access,
    provisionedPeople: ["roster-denied"],
  });
  // Register native trust after Console trust so cleanup cannot capture a stale root.
  trustLocalUpstreamCertificate(t, upstream.cert);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Concurrent avatars", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Team",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const headers = authenticatedHeaders(await fixture.signIn());
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/gateway/people`;
  const deniedSession = await fixture.signIn(fixture.provisionedAccounts[0].credentials);
  // Hold the wire response until all four real HTTP requests reach the adapter.
  const reads = [path, ...profiles.map(({ id }) => `${path}/${id}/avatar`)].map((url) =>
    fixture.rawRequest("GET", url, { headers }),
  );
  await admitted.promise;
  // A pending result does not admit another human: authorization still precedes
  // the adapter, for both the roster and avatar operations.
  for (const url of [path, `${path}/profile-alice/avatar`]) {
    assert.equal((await fixture.request("GET", url, { session: deniedSession })).status, 403);
  }
  assert.equal(resolutions, 4);
  release.resolve();
  const results = await Promise.all(reads);
  assert.deepEqual(
    results.map(({ response }) => response.status),
    [200, 200, 200, 200],
  );
  assert.deepEqual(upstream.gateway, { connections: 1, lists: 1 });
  assert.equal(upstream.requests.length, 3);
  // A completed read cannot keep a profile eligible after its native merge.
  profiles = profiles.map((profile) => ({ ...profile, mergedInto: "other-profile" }));
  const denied = await fixture.rawRequest("GET", `${path}/profile-alice/avatar`, { headers });
  assert.equal(denied.response.status, 404);
  assert.equal(upstream.gateway.lists, 2);
  assert.equal(upstream.requests.length, 3);
  // A failed read is also evicted, allowing the next authorized read to recover.
  fail = true;
  const unavailable = await fixture.rawRequest("GET", path, { headers });
  assert.equal(unavailable.response.status, 200);
  assert.deepEqual(
    JSON.parse(unavailable.text).data.people.map((person) => person.identity),
    ["oidc:alice", "oidc:bob", "oidc:carol"],
  );
  fail = false;
  profiles = [
    { id: "profile-alice", emails: ["oidc:alice"], displayName: "Alice", hasAvatar: true },
  ];
  const recovered = await fixture.rawRequest("GET", path, { headers });
  assert.equal(recovered.response.status, 200);
  assert.equal(JSON.parse(recovered.text).data.people[0].displayName, "Alice");
  assert.equal(upstream.gateway.lists, 4);
});

test("shared Gateway list readers cancel independently and isolate revisions and rotated credentials", async (t) => {
  const started = Array.from({ length: 6 }, () => Promise.withResolvers());
  const gates = Array.from({ length: 6 }, () => Promise.withResolvers());
  const profiles = [
    { id: "profile-alice", emails: ["oidc:alice"], displayName: "Alice", hasAvatar: true },
  ];
  t.after(() => gates.forEach((gate) => gate.resolve(profiles)));
  let lists = 0;
  const upstream = await startNativeHttpsUpstream(t, {
    profiles: async () => {
      const index = lists++;
      started[index].resolve();
      return gates[index].promise;
    },
  });
  const joined = Promise.withResolvers();
  const deadlineJoined = Promise.withResolvers();
  let resolutions = 0;
  let apiKey = nativeGatewayApiKey;
  const access = createNativeGatewayPeopleAccess(async () => {
    if (++resolutions === 2) {
      joined.resolve();
    }
    if (resolutions === 5) {
      deadlineJoined.resolve();
    }
    return { url: `wss://localhost:${upstream.port}/`, apiKey };
  });
  const fixture = await createConsoleAppFixture(t, { gatewayPeopleAccess: access });
  // Register native trust after Console trust so cleanup cannot capture a stale root.
  trustLocalUpstreamCertificate(t, upstream.cert);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("List cancellation", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Team",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const request = (controller, revision = active.revision) => ({
    revision,
    signal: controller.signal,
    deadline: new Date(Date.now() + 5000),
  });
  // Cancel the original caller after another authorized reader has joined it.
  const first = new AbortController();
  const firstRead = access.list(request(first));
  const firstDenied = assert.rejects(firstRead, { name: "AbortError" });
  await started[0].promise;
  const secondRead = access.list(request(new AbortController()));
  await joined.promise;
  first.abort();
  await firstDenied;
  gates[0].resolve(profiles);
  assert.deepEqual(await secondRead, [
    {
      identity: "oidc:alice",
      profileId: "profile-alice",
      displayName: "Alice",
      role: null,
      hasAvatar: true,
    },
  ]);
  assert.equal(upstream.gateway.lists, 1);
  // With no remaining reader, abort the wire operation and discard its entry.
  const only = new AbortController();
  const abandoned = access.list(request(only));
  const abandonedDenied = assert.rejects(abandoned, { name: "AbortError" });
  await started[1].promise;
  only.abort();
  await abandonedDenied;
  await upstream.connectionClosures[1];
  // A shorter HTTP-style deadline also expires only its own reader.
  const shortRead = access.list({
    ...request(new AbortController()),
    deadline: new Date(Date.now() + 1500),
  });
  const expired = assert.rejects(shortRead, { name: "TimeoutError" });
  await started[2].promise;
  const longerRead = access.list(request(new AbortController()));
  await deadlineJoined.promise;
  await expired;
  gates[2].resolve(profiles);
  assert.equal((await longerRead)[0].profileId, "profile-alice");
  // Same revision, rotated credential: never join the old transport's read.
  const oldCredential = access.list(request(new AbortController()));
  await started[3].promise;
  apiKey = `${nativeGatewayApiKey}-rotated`;
  const newCredential = access.list(request(new AbortController()));
  await started[4].promise;
  // A new active revision likewise has an independent read, even at the same URL.
  const next = await fixture.seedActiveAgentRevision(namespace.id, agent.id, active.revision.id);
  const nextRevision = access.list(request(new AbortController(), next.revision));
  await started[5].promise;
  gates[3].resolve(profiles);
  gates[4].resolve([{ ...profiles[0], displayName: "Rotated credential" }]);
  gates[5].resolve([{ ...profiles[0], displayName: "Next revision" }]);
  const results = await Promise.all([oldCredential, newCredential, nextRevision]);
  assert.deepEqual(
    results.map((people) => people[0].displayName),
    ["Alice", "Rotated credential", "Next revision"],
  );
  assert.equal(upstream.gateway.lists, 6);
});

test("configured Gateway identities determine membership independently of retained profiles", async (t) => {
  let allowUsers = ["occ-workspace-files", "oidc:alice", "oidc:never-connected"];
  const upstream = await startNativeHttpsUpstream(t, {
    gatewayConfig: () => ({
      auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-occ-identity", allowUsers } },
    }),
    profiles: [
      {
        id: "profile-alice",
        emails: ["oidc:alice"],
        displayName: "Alice Team",
        effectiveRole: "member",
        hasAvatar: true,
      },
      {
        id: "withdrawn",
        emails: ["oidc:withdrawn"],
        displayName: "Former teammate",
        hasAvatar: true,
      },
      // A chosen display name must never attach this profile to an unvisited identity.
      {
        id: "lookalike",
        emails: ["oidc:unrelated"],
        displayName: "oidc:never-connected",
        hasAvatar: true,
      },
      {
        id: "machine",
        emails: ["occ-workspace-files"],
        displayName: "Service account",
        hasAvatar: true,
      },
    ],
  });
  const access = createNativeGatewayPeopleAccess(async () => ({
    url: `wss://localhost:${upstream.port}/`,
    apiKey: nativeGatewayApiKey,
  }));
  const fixture = await createConsoleAppFixture(t, { gatewayPeopleAccess: access });
  // Register native trust after Console trust so cleanup cannot capture a stale root.
  trustLocalUpstreamCertificate(t, upstream.cert);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Configured people", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Team",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/gateway/people`;
  // Compare membership at the real adapter boundary before HTTP serialization.
  const wirePeople = await access.list({
    revision: active.revision,
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 5000),
  });
  assert.deepEqual(
    wirePeople.map((person) => person.identity),
    ["oidc:alice", "oidc:never-connected"],
  );
  const listed = await fixture.request("GET", path);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.people, [
    {
      identity: "oidc:alice",
      profileId: "profile-alice",
      displayName: "Alice Team",
      role: "member",
      hasAvatar: true,
    },
    {
      identity: "oidc:never-connected",
      profileId: null,
      displayName: "",
      role: null,
      hasAvatar: false,
    },
  ]);
  // Withdraw from the live config without deleting historical profiles.
  allowUsers = ["occ-workspace-files", "oidc:never-connected"];
  assert.deepEqual((await fixture.request("GET", path)).data.people, [
    {
      identity: "oidc:never-connected",
      profileId: null,
      displayName: "",
      role: null,
      hasAvatar: false,
    },
  ]);
  assert.equal((await fixture.request("GET", path + "/profile-alice/avatar")).status, 404);
  assert.equal(upstream.requests.length, 0, "withdrawn avatars are not fetched");
  allowUsers = ["occ-workspace-files"];
  assert.deepEqual((await fixture.request("GET", path)).data.people, []);
});

test("configured identity rows survive merged aliases, case differences and unavailable enrichment", async (t) => {
  let unavailable = false;
  const upstream = await startNativeHttpsUpstream(t, {
    gatewayConfig: () => ({
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-occ-identity",
          allowUsers: ["occ-workspace-files", "OIDC:Alice", "oidc:alice", "oidc:second-login"],
        },
      },
    }),
    profiles: () => {
      if (unavailable) {
        throw new Error("Profiles unavailable");
      }
      return [
        { id: "merged-alice", emails: [], mergedInto: "profile-alice", displayName: "Old name" },
        {
          id: "profile-alice",
          emails: ["oidc:alice", "oidc:second-login", "oidc:other-linked-login"],
          displayName: "Alice",
        },
      ];
    },
  });
  const access = createNativeGatewayPeopleAccess(async () => ({
    url: "wss://localhost:" + upstream.port + "/",
    apiKey: nativeGatewayApiKey,
  }));
  const fixture = await createConsoleAppFixture(t, { gatewayPeopleAccess: access });
  // Register native trust after Console trust so cleanup cannot capture a stale root.
  trustLocalUpstreamCertificate(t, upstream.cert);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Canonical identities", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Team",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id + "/gateway/people";
  const identities = ["OIDC:Alice", "oidc:alice", "oidc:second-login"];
  const listed = await fixture.request("GET", path);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.data.people,
    identities.map((identity) => ({
      identity,
      profileId: "profile-alice",
      displayName: "Alice",
      role: null,
      hasAvatar: false,
    })),
  );
  // Profile availability changes presentation, never configured membership.
  unavailable = true;
  const fallback = await fixture.request("GET", path);
  assert.equal(fallback.status, 200);
  assert.deepEqual(
    fallback.data.people,
    identities.map((identity) => ({
      identity,
      profileId: null,
      displayName: "",
      role: null,
      hasAvatar: false,
    })),
  );
});

test("unreadable or non-enumerating Gateway config never means zero configured users", async (t) => {
  let valid = false;
  let auth = {
    mode: "trusted-proxy",
    trustedProxy: { userHeader: "x-occ-identity", allowUsers: ["occ-workspace-files"] },
  };
  const upstream = await startNativeHttpsUpstream(t, {
    gatewayConfig: () => ({ auth }),
    validConfig: () => valid,
    profiles: [{ id: "profile-alice", emails: ["oidc:alice"], displayName: "Alice" }],
  });
  const access = createNativeGatewayPeopleAccess(async () => ({
    url: "wss://localhost:" + upstream.port + "/",
    apiKey: nativeGatewayApiKey,
  }));
  const fixture = await createConsoleAppFixture(t, { gatewayPeopleAccess: access });
  // Register native trust after Console trust so cleanup cannot capture a stale root.
  trustLocalUpstreamCertificate(t, upstream.cert);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unavailable enumeration", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Team",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id + "/gateway/people";
  assert.equal(
    (await fixture.request("GET", path)).status,
    503,
    "invalid snapshots are withheld by native config.get",
  );
  valid = true;
  // Native empty/omitted allowlists admit arbitrary authenticated proxy identities;
  // neither one can support a complete configured-user enumeration.
  for (const trustedProxy of [
    { userHeader: "x-occ-identity", allowUsers: [] },
    { userHeader: "x-occ-identity" },
    { userHeader: "x-other-identity", allowUsers: ["oidc:alice"] },
  ]) {
    auth = { mode: "trusted-proxy", trustedProxy };
    assert.equal((await fixture.request("GET", path)).status, 503);
  }
  assert.equal(
    upstream.gateway.lists,
    0,
    "profiles must not substitute for unavailable config membership",
  );
  auth = {
    mode: "trusted-proxy",
    trustedProxy: { userHeader: "x-occ-identity", allowUsers: ["occ-workspace-files"] },
  };
  assert.deepEqual((await fixture.request("GET", path)).data.people, []);
});
