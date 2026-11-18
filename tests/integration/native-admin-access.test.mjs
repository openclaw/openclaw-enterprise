import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { once } from "node:events";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import test from "node:test";

import defaultCodexPreset from "../../deploy/presets/default-codex.json" with { type: "json" };
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import {
  callerDenied,
  GENERIC_DENIAL,
  NATIVE_ADMIN_DENIED,
  nativeAdminOffDenied,
} from "../helpers/refusal-text.mjs";
import { grantRole, restrict } from "../helpers/iam-grants.ts";
import { createControllerAuth } from "../helpers/password-hasher.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { AgentResponse } from "../../packages/contracts/src/api/resources.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import {
  InMemoryPlatformState,
  NoActiveAgentRevisionError,
  OpenClawController,
  ResourceConflictError,
} from "../../packages/occ/src/index.ts";
import { signInToControllerApp } from "../helpers/auth-session.mjs";
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
  issueServiceKeyForNativeAgent,
  registerNativeAdminSessionOriginCases,
  registerNativeAdminSessionRecoveryCase,
  registerNativeAdminSharedCookieCases,
} from "./native-admin-shared-session-cases.ts";

const cookieDomain = "oce.example.test";
const nativeDomain = `agents.${cookieDomain}`;
const publicOrigin = `https://console.${cookieDomain}`;
const authBaseURL = `https://console.${cookieDomain}`;
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
 * @param {{ captureWire?: boolean }} [options]
 */
async function startNativeHttpsUpstream(t, { captureWire = false } = {}) {
  const directory = await temporaryDirectory(t, "openclaw-native-admin-upstream-");
  const { key, cert } = await selfSigned(directory, {
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
  return { port: address.port, requests, parsedRequests, wire, streams, parserErrors, cert };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{
 *   state?: import("../../packages/occ/src/index.ts").PlatformStateStore,
 *   upstream?: {captureWire?: boolean},
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
    agentGatewayManagedMode: false,
    computeDriver: nativeComputeDriver(upstream.port, {
      exclusiveReplacement: options.exclusiveReplacement,
    }),
  });
  await fixture.bootstrap("Native admin access test");
  const namespace = await fixture.createNamespace("Native admin", {
    ready: true,
  });
  const { agent, revision } = await createLiveNativeAgent(
    fixture,
    namespace,
    "Native admin Agent",
    options,
  );
  const session = await fixture.signIn();
  return {
    fixture,
    upstream,
    namespace,
    agent,
    revision,
    session,
  };
}

// An Agent in `namespace` whose active revision serves the native admin UI at its own origin.
/**
 * @param {ConsoleFixture} fixture
 * @param {Pick<import("../../packages/contracts/src/index.ts").Namespace, "id">} namespace
 * @param {string} name
 * @param {{nativeDomain?: string, publicOrigin?: string, configure?: (origin: string) => object}} [options]
 */
async function createLiveNativeAgent(fixture, namespace, name, options = {}) {
  const agent = await fixture.createAgent(
    namespace.id,
    name,
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const nativeOrigin = nativeOriginForAgent(
    fixture.controller.installation.id,
    namespace.id,
    agent.id,
    options.nativeDomain ?? nativeDomain,
    options.publicOrigin ?? publicOrigin,
  );
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    (options.configure ?? nativeAdminHarnessConfiguration)(nativeOrigin),
  );
  const revision = await fixture.controller.deployAgent(
    adminPrincipal(fixture).id,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveApprovedHarness,
  );
  await fixture.activateRevision(namespace.id, agent.id, revision.id, undefined);
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  const { data } = fixture.fixtureResponse(current, 200, AgentResponse, "read live Agent");
  assert.equal(data.desiredRuntimeState, "running");
  return { agent: data, revision };
}

function adminPrincipal(fixture) {
  const principal = fixture.policy.identities.find((identity) => identity.kind === "principal");
  assert.ok(principal, "fixture IAM policy must contain the signed-in administrator");
  return principal;
}

/**
 * @typedef {Awaited<ReturnType<typeof createConsoleAppFixture>>} ConsoleFixture
 * @typedef {NonNullable<Parameters<ConsoleFixture["request"]>[2]>} RequestOptions
 */
/**
 * @param {{fixture: Pick<ConsoleFixture, "request">, namespace: {id: string}, agent: {id: string}}} context
 * @param {RequestOptions} [options]
 */
async function nativeStatus({ fixture, namespace, agent }, options = {}) {
  return fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
    options,
  );
}

/**
 * @param {{app: Pick<ReturnType<typeof createFastifyApp>, "inject">}} fixture
 * @param {"GET" | "POST"} method
 * @param {string} url
 * @param {{headers?: Record<string, string | undefined>, body?: unknown}} [options]
 */
async function injectJson(fixture, method, url, { headers = {}, body } = {}) {
  return fixture.app.inject({
    method,
    url,
    headers: {
      ...Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

/** @param {{origin: string}} native */
function nativeAuthority(native) {
  return new URL(native.origin).host;
}

function sessionCookieName(cookieHeader) {
  const [name] = cookieHeader.split("=", 1);
  assert.ok(name.length > 0, "session cookie header must start with a cookie name");
  return name;
}

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

// A second Agent in the fixture's Namespace, beside the one its exact bindings name.
/** @param {{fixture: Pick<ConsoleFixture, "createAgent">, namespace: {id: string}}} context */
function createSiblingAgent(context) {
  return context.fixture.createAgent(
    context.namespace.id,
    `Native admin sibling ${randomUUID().slice(0, 8)}`,
    createHarnessConfiguration("openclaw", "gpt-4.1"),
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
  t.after(() => setDefaultCACertificates(previous));
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
  // Without exclusive replacement the active revision keeps serving during a redeploy.
  const shared = await createNativeAdminFixture(t);
  await shared.fixture.deployAgent(shared.namespace.id, shared.agent.id);
  const stillServing = await nativeStatus(shared);
  assert.equal(stillServing.status, 200);
  assert.equal(stillServing.data.status, "available");
  assert.equal(stillServing.data.activeRevisionId, shared.revision.id);

  const context = await createNativeAdminFixture(t, {
    exclusiveReplacement: (revision) => revision.revision === 2,
  });
  const available = await nativeStatus(context);
  assert.equal(available.data.status, "available");
  const replacement = await context.fixture.deployAgent(context.namespace.id, context.agent.id);
  const waiting = await nativeStatus(context);
  assert.equal(waiting.data.status, "available");
  assert.equal(waiting.data.activeRevisionId, context.revision.id);
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
  const agent = await context.fixture.request(
    "GET",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}`,
  );
  assert.equal(agent.data.activeRevisionId, context.revision.id);

  const nextReplacement = await context.fixture.deployAgent(context.namespace.id, context.agent.id);
  assert.deepEqual((await nativeStatus(context)).data, { status: "unavailable" });

  await context.fixture.activateRevision(
    context.namespace.id,
    context.agent.id,
    nextReplacement.id,
    context.revision.id,
  );
  const restored = await nativeStatus(context);
  assert.equal(restored.data.status, "available");
  assert.equal(restored.data.activeRevisionId, nextReplacement.id);
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

test("native browser disabled status still requires exact Agent authority", async (t) => {
  const context = await createNativeAdminFixture(t, { nativeAdminEnabled: false });

  const disabled = await nativeStatus(context);
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.status, "disabled");

  const administerOnlySession = await createExactAgentAdministerSession(
    context,
    "native-admin-disabled-exact-administer",
  );
  const administerOnlyDisabled = await nativeStatus(context, { session: administerOnlySession });
  assert.equal(administerOnlyDisabled.status, 200);
  assert.equal(administerOnlyDisabled.data.status, "disabled");
  await assertSiblingStatusDenied(context, administerOnlySession, nativeAdminOffDenied);

  const limitedSession = await createReadOnlySession(context, "native-admin-disabled-reader");
  const denied = await nativeStatus(context, { session: limitedSession });
  assertApiError(denied, 403, "FORBIDDEN");
  // With native admin off, the denial also says the grant alone would not open it (finding D762).
  assert.equal(denied.body.error.message, nativeAdminOffDenied(`Agent ${context.agent.id}`));

  const missingStatus = await context.fixture.request(
    "GET",
    `/namespaces/${context.namespace.id}/agents/agt_${randomUUID()}/native-admin`,
  );
  assert.equal(missingStatus.status, 404);
  assert.equal(missingStatus.body.error.code, "NOT_FOUND");
});

export const sharedSessionDependencies = {
  publicOrigin,
  authBaseURL,
  createNativeAdminFixture,
  nativeStatus,
  injectJson,
  nativeAuthority,
  createSiblingAgent,
  trustLocalUpstreamCertificate,
};
registerNativeAdminSharedCookieCases(test, sharedSessionDependencies);

test("a copied Agent chat link redirects an activated browser navigation to the configured console without granting access", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const context = await createNativeAdminFixture(t, { auditSink });
  const status = await nativeStatus(context);
  const host = nativeAuthority(status.data);
  const navigation = {
    host,
    accept: "text/html,application/xhtml+xml",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };
  const page = await injectJson(context.fixture, "GET", "/chat/main", {
    headers: { ...navigation, "x-forwarded-host": "attacker.example.test" },
  });
  const key = status.data.host.match(/^agent-([a-f0-9]{32})\./)[1];
  const destination = `${publicOrigin}/console/#native-agent=${key}`;
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, destination);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.ok(page.headers["x-request-id"]);
  assert.equal(page.headers["set-cookie"], undefined);
  // The console opens the native root, not only copied chat links.
  const rootPage = await injectJson(context.fixture, "GET", "/?return=https://attacker.example", {
    headers: navigation,
  });
  assert.equal(rootPage.statusCode, 302);
  assert.equal(rootPage.headers.location, destination);
  const sessionSuffix = "a".repeat(32);
  const sessionPage = await injectJson(
    context.fixture,
    "GET",
    `/chat/main/${sessionSuffix}?private=omitted`,
    { headers: navigation },
  );
  assert.equal(sessionPage.statusCode, 302);
  assert.equal(sessionPage.headers.location, destination);
  // Named sessions are valid copied chat URLs too, not only opaque hex IDs.
  const namedSessionPath = `/chat/main/simple-test-session-${sessionSuffix}`;
  const namedSession = await injectJson(context.fixture, "GET", namedSessionPath, {
    headers: navigation,
  });
  assert.equal(namedSession.statusCode, 302, namedSession.body);
  assert.equal(namedSession.headers.location, destination);
  const inventedKey = "f".repeat(32);
  const invented = await injectJson(context.fixture, "GET", "/chat/main", {
    headers: {
      ...navigation,
      host: `agent-${inventedKey}.${nativeDomain}`,
      "x-forwarded-host": "attacker.example.test",
    },
  });
  assert.equal(invented.statusCode, 302);
  assert.equal(invented.headers.location, destination.replace(key, inventedKey));
  // A copied link with a trailing slash is the same page load.
  const trailing = await injectJson(context.fixture, "GET", "/chat/main/", { headers: navigation });
  assert.equal(trailing.statusCode, 302);
  assert.equal(trailing.headers.location, destination);

  // Safari never sends Sec-Fetch-User, and other browsers omit it on navigations without user
  // activation. Such a page load stays 403 without redirecting, but shows a sign-in link instead of
  // the JSON refusal.
  const { "sec-fetch-user": _activation, ...unactivated } = navigation;
  for (const path of [
    "/",
    "/chat/main",
    "/chat/main/",
    `/chat/main/${sessionSuffix}`,
    namedSessionPath,
  ]) {
    const signIn = await injectJson(context.fixture, "GET", path, { headers: unactivated });
    assert.equal(signIn.statusCode, 403, path);
    assert.equal(signIn.headers.location, undefined, path);
    assert.match(signIn.headers["content-type"], /^text\/html/, path);
    assert.equal(signIn.headers["cache-control"], "no-store", path);
    assert.equal(signIn.headers["referrer-policy"], "no-referrer", path);
    assert.equal(signIn.headers["x-content-type-options"], "nosniff", path);
    assert.ok(signIn.headers["x-request-id"], path);
    assert.equal(signIn.headers["set-cookie"], undefined, path);
    assert.match(
      signIn.body,
      new RegExp(`<a href="${publicOrigin}/console/#native-agent=${key}">Sign in</a>`),
      path,
    );
    assert.equal(signIn.body.includes(context.agent.id), false, path);
  }

  for (const [method, path, headers] of [
    ["GET", "/chat/main", { host, accept: "application/json" }],
    // Link unfurlers send no Fetch Metadata: no redirect and no sign-in page.
    ["GET", "/chat/main", { host, accept: "text/html", "user-agent": "Slackbot-LinkExpanding" }],
    [
      "GET",
      "/chat/main",
      { host, accept: "text/html", "user-agent": "Slackbot-LinkExpanding", "sec-fetch-user": "?1" },
    ],
    ["GET", "/chat/main", { ...navigation, host: `agent-${key}.other.${nativeDomain}` }],
    ["GET", "/chat/main", { ...navigation, "sec-fetch-dest": "iframe" }],
    ["GET", "/chat/main", { ...navigation, "sec-fetch-mode": "cors" }],
    ["GET", "/chat/main", { ...navigation, accept: "text/html;q=0,application/json" }],
    ["GET", "/chat/main/session/extra", navigation],
    ["GET", "/settings", navigation],
    ["GET", "/", { ...navigation, "sec-fetch-mode": "cors" }],
    ["GET", "/", { ...navigation, "sec-fetch-dest": "iframe" }],
    ["GET", "/api/status", navigation],
    ["GET", "/auth/callback", navigation],
    ["GET", "//attacker.example/", navigation],
    ["POST", "/chat/main", navigation],
  ]) {
    const denied = await injectJson(context.fixture, method, path, { headers });
    assert.equal(denied.statusCode, 403, `${method} ${path}`);
    assert.equal(denied.headers.location, undefined);
    assert.match(denied.headers["content-type"], /^application\/json/);
    assert.equal(denied.json().error.code, "FORBIDDEN");
  }
  const limited = await createReadOnlySession(context);
  for (const [path, headers] of [
    ["/", navigation],
    ["/chat/main", navigation],
    ["/chat/main", unactivated],
  ]) {
    const unauthorized = await injectJson(context.fixture, "GET", path, {
      headers: { ...headers, cookie: limited.cookie },
    });
    assert.equal(unauthorized.statusCode, 403);
    assert.equal(unauthorized.headers.location, undefined);
    assert.match(unauthorized.headers["content-type"], /^text\/html/);
    assert.match(unauthorized.body, /Go to your Agents/);
    assert.equal(unauthorized.body.includes(context.agent.id), false);
  }
  const endpoint = `/native-admin/return/${key}`;
  const found = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
  });
  assert.equal(found.statusCode, 200, found.body);
  assert.deepEqual(found.json().data, {
    namespaceId: context.namespace.id,
    agentId: context.agent.id,
  });
  assert.equal(found.headers["cache-control"], "no-store");
  const unknown = await injectJson(
    context.fixture,
    "GET",
    `/native-admin/return/${"f".repeat(32)}`,
    {
      headers: { host: new URL(publicOrigin).host, cookie: limited.cookie },
    },
  );
  const forbidden = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host, cookie: limited.cookie },
  });
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.equal(forbidden.statusCode, 404, forbidden.body);
  assert.deepEqual(unknown.json().error, forbidden.json().error);
  assert.ok(
    auditSink.events.some(
      (event) =>
        event.action === "openclaw.agents.native_admin.return.authorize" &&
        event.requestId === forbidden.json().meta.requestId &&
        event.outcome === "denied",
    ),
  );
  const anonymous = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host },
  });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  const invalid = await injectJson(context.fixture, "GET", "/native-admin/return/not-a-key", {
    headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  const forwarded = await injectJson(context.fixture, "GET", endpoint, {
    headers: {
      host: new URL(publicOrigin).host,
      cookie: context.session.cookie,
      "x-forwarded-host": "attacker.example.test",
    },
  });
  assert.equal(forwarded.statusCode, 403);

  // The detail page is the recovery destination even when no revision is serving.
  const stopped = await context.fixture.request(
    "POST",
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  await context.fixture.controller.transact((state) =>
    state.agents.compareAndClearActiveRevision(
      context.namespace.id,
      context.agent.id,
      context.revision.id,
    ),
  );
  const stoppedReturn = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
  });
  assert.equal(stoppedReturn.statusCode, 200, stoppedReturn.body);
  assert.deepEqual(stoppedReturn.json().data, found.json().data);

  // Changing the key must not buy more lookups; another administrator keeps their own budget.
  const burst = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      injectJson(
        context.fixture,
        "GET",
        endpoint.replace(key, index.toString(16).padStart(32, "0")),
        {
          headers: { host: new URL(publicOrigin).host, cookie: limited.cookie },
        },
      ),
    ),
  );
  const throttled = burst.find((response) => response.statusCode === 429);
  assert.ok(
    throttled,
    "expected repeated return lookups to be limited; got " +
      burst.map((response) => response.statusCode).join(", "),
  );
  assert.equal(throttled.json().error.code, "NATIVE_ADMIN_RETURN_RATE_LIMITED");
  assert.ok(Number(throttled.headers["retry-after"]) > 0);
  const independent = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
  });
  assert.equal(independent.statusCode, 200, independent.body);
  assert.equal(context.upstream.requests.length, 0);

  // Expiry of a previously issued cookie takes the same safe route as a missing cookie.
  for (const session of context.fixture.memoryDatabase.session) {
    session.expiresAt = new Date(Date.now() - 1000);
  }
  const expired = await injectJson(context.fixture, "GET", "/", {
    headers: { ...navigation, cookie: context.session.cookie },
  });
  assert.equal(expired.statusCode, 302);
  assert.equal(expired.headers.location, destination);
  const expiredApi = await injectJson(context.fixture, "POST", "/", {
    headers: { ...navigation, cookie: context.session.cookie },
  });
  assert.equal(expiredApi.statusCode, 403);
  assert.equal(expiredApi.headers.location, undefined);

  const renewed = await context.fixture.signIn();
  const resumed = await injectJson(context.fixture, "GET", endpoint, {
    headers: { host: new URL(publicOrigin).host, cookie: renewed.cookie },
  });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.deepEqual(resumed.json().data, found.json().data);
});

registerNativeAdminSessionRecoveryCase(test, sharedSessionDependencies);

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

  const nativeHeaders = {
    host: nativeAuthority(status.data),
    origin: status.data.origin,
    cookie: nativeCookie,
  };
  const nativeCookieName = sessionCookieName(nativeCookie);
  const deniedRequests = [
    { url: "/", headers: { origin: "https://untrusted.example.test" } },
    { url: "/", headers: { origin: "null" } },
    { url: "/", headers: { authorization: "Bearer must-not-forward" } },
    { url: "/", headers: { host: `sibling.${nativeDomain}:9443` } },
    { url: "/", headers: { host: `${status.data.host}:9444` } },
    { url: "/api/auth/get-session", headers: { cookie: "" } },
    { url: "/api/auth/get-session", headers: { cookie: "openclaw_occ.session_token=legacy" } },
    {
      url: "/api/auth/get-session",
      headers: { cookie: `${nativeCookieName}=legacy; ${nativeCookie}` },
    },
    {
      url: "/api/auth/get-session",
      headers: { cookie: `${nativeCookie}; ${nativeCookieName}=legacy` },
    },
    // A session key narrows the shared cookie; a foreign or malformed key is refused.
    { url: "/", headers: { "x-occ-session-key": "A".repeat(43) } },
    { url: "/", headers: { "x-occ-session-key": "malformed" } },
    { url: "/__occ/native-admin/unknown" },
    { url: "/assets/%2e%2e%2fother-agent" },
    { url: "/assets/%252e%252e%252fother-agent" },
    { url: "/assets/%5cother-agent" },
    { url: "/settings", method: "POST", headers: { origin: undefined } },
    { url: "/sw.js", headers: { "service-worker": "script" } },
  ];
  for (const deniedRequest of deniedRequests) {
    const denied = await injectJson(
      context.fixture,
      deniedRequest.method ?? "GET",
      deniedRequest.url,
      {
        headers: { ...nativeHeaders, ...deniedRequest.headers },
      },
    );
    assert.equal(denied.statusCode, 403, `${deniedRequest.url}: ${denied.body}`);
    assert.equal(denied.headers["set-cookie"], undefined);
  }
  assert.equal(
    context.upstream.requests.length,
    1,
    "rejected requests must not reach native gateway",
  );

  // A native-host path that happens to match an OCC route still goes to native.
  const collision = await injectJson(context.fixture, "GET", "/api/auth/get-session", {
    headers: nativeHeaders,
  });
  assert.equal(collision.statusCode, 200);
  assert.equal(collision.body, "native admin upstream\n");
  assert.equal(context.upstream.requests.length, 2);

  // A user photo the Gateway cannot fetch is a missing photo, not a Gateway failure.
  const avatar = await injectJson(
    context.fixture,
    "GET",
    "/api/users/upstream-unavailable/avatar?v=1",
    { headers: nativeHeaders },
  );
  assert.equal(avatar.statusCode, 404, avatar.body);
  assert.equal(avatar.body, "");
  assert.equal(avatar.headers["cache-control"], "no-store");
  assert.equal(context.upstream.requests.length, 3);
  const otherFailure = await injectJson(context.fixture, "GET", "/upstream-unavailable", {
    headers: nativeHeaders,
  });
  assert.equal(otherFailure.statusCode, 502, otherFailure.body);
  assert.match(otherFailure.body, /avatar_upstream_unavailable/);
  assert.equal(context.upstream.requests.length, 4);

  const rootRedirect = await injectJson(context.fixture, "GET", "/redirect-root", {
    headers: nativeHeaders,
  });
  assert.equal(rootRedirect.statusCode, 302, rootRedirect.body);
  assert.equal(
    rootRedirect.headers.location,
    `${status.data.origin}/settings/profile?from=redirect`,
  );
  assert.match(String(rootRedirect.headers["content-security-policy"]), /default-src 'self'/);
  assert.match(String(rootRedirect.headers["content-security-policy"]), /worker-src 'none'/);
  assert.equal(context.upstream.requests.length, 5);

  const externalRedirect = await injectJson(context.fixture, "GET", "/redirect-external", {
    headers: nativeHeaders,
  });
  assert.equal(externalRedirect.statusCode, 502, externalRedirect.body);
  assert.equal(externalRedirect.headers.location, undefined);
  assert.equal(context.upstream.requests.length, 6);

  const reservedRedirect = await injectJson(context.fixture, "GET", "/redirect-reserved", {
    headers: nativeHeaders,
  });
  assert.equal(reservedRedirect.statusCode, 502, reservedRedirect.body);
  assert.equal(reservedRedirect.headers.location, undefined);
  assert.equal(context.upstream.requests.length, 7);

  // The session's binding names one Agent. A second, live Agent of the Namespace has its own
  // host; the same session is refused there by IAM (audited once for that Agent), and nothing
  // reaches the gateway.
  const sibling = await createLiveNativeAgent(
    context.fixture,
    context.namespace,
    `Native admin sibling ${randomUUID().slice(0, 8)}`,
  );
  const siblingNative = (await nativeStatus({ ...context, agent: sibling.agent })).data;
  assert.notEqual(siblingNative.host, status.data.host);
  const { response: siblingDenied, denials } = await denialsDuring(context.fixture.auditSink, () =>
    injectJson(context.fixture, "GET", "/settings/profile", {
      headers: {
        host: nativeAuthority(siblingNative),
        origin: siblingNative.origin,
        cookie: nativeCookie,
      },
    }),
  );
  assert.equal(siblingDenied.statusCode, 403, siblingDenied.body);
  assert.equal(siblingDenied.json().error.message, NATIVE_ADMIN_DENIED);
  assert.deepEqual(denials, [{ action: "operate", kind: "agent", id: sibling.agent.id }]);
  assert.equal(context.upstream.requests.length, 7);

  restrict(context.fixture.policy, "administer", "agent", {
    namespaceId: context.namespace.id,
    resourceId: context.agent.id,
  });
  const iamDenied = await injectJson(context.fixture, "GET", "/settings/profile?after=iam", {
    headers: nativeHeaders,
  });
  assert.equal(iamDenied.statusCode, 403, iamDenied.body);
  // A Restriction reads the same as a missing grant.
  assert.equal(iamDenied.json().error.message, NATIVE_ADMIN_DENIED);
  assert.equal(iamDenied.headers["set-cookie"], undefined);
  assert.equal(
    context.upstream.requests.length,
    7,
    "authorization-denied proxy requests must not reach native gateway",
  );

  // A signed-in person with no platform identity had no grant checked: the refusal names none
  // (finding 2589), and it is decided before the host, so it tells nothing about the Agent.
  const identities = context.fixture.policy.identities;
  const principal = adminPrincipal(context.fixture);
  identities.splice(identities.indexOf(principal), 1);
  const unprovisioned = await injectJson(context.fixture, "GET", "/settings/profile", {
    headers: nativeHeaders,
  });
  assert.equal(unprovisioned.statusCode, 403, unprovisioned.body);
  assert.deepEqual(unprovisioned.json().error, { code: "FORBIDDEN", message: GENERIC_DENIAL });
  identities.push(principal);
  assert.equal(context.upstream.requests.length, 7);
});
test("native admin proxy resolves a host only to the live Agent it names", async (t) => {
  const state = new InMemoryPlatformState();
  const context = await createNativeAdminFixture(t, { state, recordOperations: true });
  const { fixture, namespace, agent, upstream } = context;
  trustLocalUpstreamCertificate(t, upstream.cert);
  const installationId = fixture.controller.installation.id;
  // The installation administrator's session administers every Agent, so each refusal below
  // comes from host resolution, not from IAM.
  const proxied = (namespaceId, agentId, cookie = context.session.cookie) => {
    const origin = nativeOriginForAgent(installationId, namespaceId, agentId);
    return injectJson(fixture, "GET", "/settings/profile", {
      headers: { host: new URL(origin).host, origin, cookie },
    });
  };

  const resolveReference = fixture.controller.resolveAgentReference.bind(fixture.controller);
  const shapeLookups = t.mock.method(fixture.controller, "resolveAgentReference", (...args) =>
    resolveReference(...args),
  );
  try {
    const own = await proxied(namespace.id, agent.id);
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(upstream.requests.length, 1);
    assert.equal(shapeLookups.mock.callCount(), 1, "a valid host uses the real reference lookup");

    const account = await fixture.createAccountWithPolicy("native-host-no-access", () => {});
    const limited = await fixture.signIn(account.credentials);
    const unknown = await proxied(namespace.id, `agt_${randomUUID()}`, limited.cookie);
    const inaccessible = await proxied(namespace.id, agent.id, limited.cookie);
    assert.equal(unknown.statusCode, 403, unknown.body);
    assert.equal(inaccessible.statusCode, 403, inaccessible.body);
    assert.deepEqual(unknown.json().error, inaccessible.json().error);
    assert.equal(shapeLookups.mock.callCount(), 3, "well-formed hosts retain the real lookup");

    const key = deriveNativeAdminHost(installationId, agent, nativeDomain)
      .split(".", 1)[0]
      .slice(6);
    for (const malformedHost of [
      `agent-.${nativeDomain}`,
      `agent-${key.slice(1)}.${nativeDomain}`,
      `agent-${key}0.${nativeDomain}`,
      `agent-${"g".repeat(32)}.${nativeDomain}`,
      `agent-${key}.other.${nativeDomain}`,
    ]) {
      const before = shapeLookups.mock.callCount();
      const denied = await injectJson(fixture, "GET", "/console/", {
        headers: { host: malformedHost, cookie: limited.cookie },
      });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(denied.json().error.code, "FORBIDDEN");
      assert.equal(denied.headers.location, undefined);
      assert.equal(
        shapeLookups.mock.callCount() - before,
        0,
        `malformed native hosts must not enumerate Agent references: ${malformedHost}`,
      );
      assert.equal(upstream.requests.length, 1, "a malformed host must not reach a native gateway");
    }
  } finally {
    shapeLookups.mock.restore();
  }

  const other = await fixture.createNamespace("Native admin other", { ready: true });
  const otherAgent = await fixture.createAgent(
    other.id,
    "Native admin other Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  for (const [label, namespaceId, agentId] of [
    ["an Agent that does not exist", namespace.id, `agt_${randomUUID()}`],
    ["this Agent under another Namespace", other.id, agent.id],
    ["another Namespace's Agent under this Namespace", namespace.id, otherAgent.id],
  ]) {
    const denied = await proxied(namespaceId, agentId);
    assert.equal(denied.statusCode, 403, `${label}: ${denied.body}`);
    // The same text as a caller denied on a live Agent, so a host reveals no Agent.
    assert.deepEqual(denied.json().error, { code: "FORBIDDEN", message: NATIVE_ADMIN_DENIED });
  }
  // Another Namespace's Agent resolves to itself alone; it has no active revision to serve.
  const otherHost = await proxied(other.id, otherAgent.id);
  assert.notEqual(otherHost.statusCode, 200, otherHost.body);
  assert.equal(upstream.requests.length, 1, "no refused host may reach a native gateway");

  const chat = await createAgentPermissionSession(context, "deleting-agent-chat", {
    agent: ["operate"],
  });
  const beforeDeletion = await proxied(namespace.id, agent.id, chat.cookie);
  assert.equal(beforeDeletion.statusCode, 200, beforeDeletion.body);
  const deleted = await fixture.request("DELETE", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(deleted.status, 202);
  const { response: deleting, denials: deletingDenials } = await denialsDuring(
    fixture.auditSink,
    () => proxied(namespace.id, agent.id, chat.cookie),
  );

  // Commit real deletion after the real host lookup, before admission's exact Agent read.
  // The wrapper changes only ordering: no lookup result or failure is invented.
  const resolve = fixture.controller.resolveAgentReference.bind(fixture.controller);
  const lookup = t.mock.method(fixture.controller, "resolveAgentReference", async (...args) => {
    const selected = await resolve(...args);
    assert.equal(selected?.id, agent.id);
    assert.equal(await state.completeAgentDeletion(namespace.id, agent.id), true);
    return selected;
  });
  let racing;
  try {
    racing = await denialsDuring(fixture.auditSink, () => proxied(namespace.id, agent.id));
  } finally {
    lookup.mock.restore();
  }
  const afterDeletion = await proxied(namespace.id, agent.id);
  assert.deepEqual(
    [deleting.statusCode, racing.response.statusCode, afterDeletion.statusCode],
    [403, 403, 403],
    "deleting and deleted Agents are refusals, not temporary dependency outages",
  );
  assert.deepEqual(racing.response.json().error, afterDeletion.json().error);
  assert.deepEqual(deletingDenials, []);
  assert.deepEqual(racing.denials, [], "deletion does not invent an attributable IAM denial");
  assert.equal(upstream.requests.length, 2);
});

test("native admin status decodes only the revisions it uses", async (t) => {
  // bughunt-69: status and proxy admission decoded every revision of the Agent to find the
  // newest. Seed 64 later revisions of about 0.9 MB each; the newest is the only one read.
  const state = new InMemoryPlatformState();
  const context = await createNativeAdminFixture(t, { state });
  const active = await state.read((view) =>
    view.revisions.findRevision(context.namespace.id, context.agent.id, context.revision.id),
  );
  const large = Object.fromEntries(Array.from({ length: 70_000 }, (_, i) => [`k${i}`, "v"]));
  await state.transact(async (transaction) => {
    for (let number = 2; number <= 65; number += 1) {
      await transaction.revisions.createRevision({
        ...active,
        id: `rev_${randomUUID()}`,
        revision: number,
        configuration: { ...active.configuration, env: { vars: large } },
      });
    }
  });
  const timings = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    const status = await nativeStatus(context);
    timings.push(performance.now() - started);
    assert.equal(status.status, 200);
    assert.equal(status.data.status, "available");
    assert.equal(status.data.activeRevisionId, context.revision.id);
  }
  // Decoding all 65 took about 2.5 s on two CPUs; decoding two takes well under a second.
  const fastest = Math.min(...timings);
  assert.ok(fastest < 1_000, `native admin status took ${Math.round(fastest)} ms`);
});

registerNativeAdminSessionOriginCases(test, sharedSessionDependencies);

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

test("a browser Back to a denied Agent gateway stays 403 and links to the console", async (t) => {
  const context = await createNativeAdminFixture(t);
  const status = await nativeStatus(context);
  const host = nativeAuthority(status.data);
  const limited = await createReadOnlySession(context);
  const navigation = {
    host,
    accept: "text/html,application/xhtml+xml",
    cookie: limited.cookie,
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };
  const page = await injectJson(context.fixture, "GET", "/", { headers: navigation });
  assert.equal(page.statusCode, 403);
  assert.equal(page.headers.location, undefined);
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["set-cookie"], undefined);
  assert.match(page.body, /Go to your Agents/);
  assert.match(page.body, new RegExp(`href="${publicOrigin}/console/agents"`));
  assert.equal(page.body.includes(context.agent.id), false);
  assert.equal(page.body.includes(status.data.host), false);

  const api = await injectJson(context.fixture, "GET", "/", {
    headers: { host, accept: "application/json", cookie: limited.cookie },
  });
  assert.equal(api.statusCode, 403);
  assert.match(api.headers["content-type"], /^application\/json/);
  // The JSON refusal names the grant but not the Agent, which the host named, not the caller.
  assert.deepEqual(api.json().error, { code: "FORBIDDEN", message: NATIVE_ADMIN_DENIED });
});

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
