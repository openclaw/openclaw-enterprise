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
  configuration.gateway.auth.trustedProxy.deviceAutoApprove.scopes = [
    "operator.read",
    "operator.write",
  ];
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
    getGatewayChatEndpoint(revision) {
      return `wss://localhost:${upstreamPort}/native-chat/namespaces/${revision.namespaceId}/agents/${revision.agentId}/`;
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
  return {
    port: address.port,
    requests,
    parsedRequests,
    wire,
    streams,
    parserErrors,
    cert,
    routeProxy,
  };
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
    `/native-chat/namespaces/${context.namespace.id}/agents/${context.agent.id}`,
  );
  await assertSiblingStatusDenied(context, operatorSession, (target) =>
    callerDenied("Agent operate", target),
  );
  const driver = context.fixture.controller.selectedDriver("compute");
  const chatEndpoint = driver.getGatewayChatEndpoint;
  driver.getGatewayChatEndpoint = undefined;
  try {
    const unsupported = await nativeStatus(context, { session: operatorSession });
    assert.equal(unsupported.data.status, "unsupported");
    // The Configuration is complete; the Compute Driver gives no chat endpoint (finding 3168).
    assert.equal(unsupported.data.reason, "compute");
    assert.equal(unsupported.data.mode, "chat");
  } finally {
    driver.getGatewayChatEndpoint = chatEndpoint;
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

// An Agent upgraded from a release before browser chat: its saved Configuration opts into
// native access but omits gateway.auth.trustedProxy.requiredHeaders. Kubernetes Compute adds
// x-openclaw-scopes to the Gateway configuration it deploys whenever gateway routing is on, so
// that Gateway still refuses requests without the scope ceiling. Availability must judge the
// deployed policy, not the saved spelling: administration and chat stay available after the
// upgrade, with no Configuration edit. Without routing, the Driver neither adds the header nor
// supplies a private endpoint, so access stays unsupported and chat never falls back to admin.
test("native browser access judges the scope header that Kubernetes Compute deploys", async (t) => {
  for (const routed of [true, false]) {
    const fixture = await createConsoleAppFixture(t, {
      publicOrigin,
      authBaseURL,
      development: { enabled: false },
      nativeAdmin: { enabled: true, domain: nativeDomain },
      nativeAdminGatewayApiKey: async () => nativeGatewayApiKey,
      routed,
    });
    await fixture.bootstrap("Native admin deployed scope header test");
    const namespace = await fixture.createNamespace("Native scope header", { ready: true });
    const { agent, revision } = await createLiveNativeAgent(fixture, namespace, "Pre-chat Agent", {
      configure(origin) {
        const configuration = nativeAdminHarnessConfiguration(origin);
        delete configuration.gateway.auth.trustedProxy.requiredHeaders;
        return configuration;
      },
    });
    const context = { fixture, namespace, agent };
    const operatorSession = await createAgentPermissionSession(
      context,
      `pre-chat-operator-${routed}`,
      { agent: ["operate"] },
      { kind: "agent", id: agent.id },
    );
    const admin = await nativeStatus(context);
    const chat = await nativeStatus(context, { session: operatorSession });
    assert.equal(admin.status, 200);
    assert.equal(chat.status, 200);
    assert.equal(admin.data.mode, "admin");
    assert.equal(chat.data.mode, "chat");
    if (routed) {
      assert.equal(admin.data.status, "available", JSON.stringify(admin.data.reason));
      assert.equal(admin.data.activeRevisionId, revision.id);
      assert.equal(chat.data.status, "available", JSON.stringify(chat.data.reason));
      assert.equal(chat.data.activeRevisionId, revision.id);
    } else {
      for (const status of [admin, chat]) {
        assert.equal(status.data.status, "unsupported");
        assert.equal(status.data.reason, "compute");
      }
    }
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
    `/namespaces/${context.namespace.id}/agents/${context.agent.id}/settings/profile?tab=devices`,
  );
  assert.equal(observed.headers.origin, status.data.origin);
  assert.equal(observed.headers["x-safe-client-header"], "preserved");
  assert.equal(observed.headers["x-api-key"], nativeGatewayApiKey);
  for (const header of [
    "authorization",
    "cookie",
    "x-forwarded-for",
    "x-occ-identity",
    "x-occ-session-key",
    "x-openclaw-scopes",
  ]) {
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
      getGatewayEndpoint(selectedRevision) {
        calls.endpoint += 1;
        assert.equal(selectedRevision.id, revision.id);
        return originalCompute.getGatewayEndpoint(selectedRevision);
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
