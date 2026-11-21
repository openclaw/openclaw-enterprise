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
  authBaseURL,
  createNativeAdminSetup,
  createSiblingAgent,
  nativeAuthority,
  nativeDomain,
  nativeStatus,
  publicOrigin,
} from "./native-admin-access-fixture.ts";
import { grantRole } from "../helpers/iam-grants.ts";
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
  registerNativeAdminAvailabilityCases,
  registerNativeAdminCopiedLinkCase,
  registerNativeAdminDeniedBackCase,
  registerNativeAdminHostResolutionCase,
  registerNativeAdminRevisionDecodingCase,
} from "./native-admin-browser-access-cases.ts";
import {
  registerNativeAdminAuthorityStatusCase,
  registerNativeAdminExplicitStopCase,
  registerNativeAdminPresetCase,
  registerNativeAdminProxyCase,
} from "./native-admin-authority-cases.ts";
import { registerNativeAdminComputeOwnerCases } from "./native-admin-compute-owner-cases.ts";

const nativeGatewayApiKey = `native-gateway-private-key-${randomUUID()}`;

/** @param {string} installationId @param {string} namespaceId @param {string} agentId @param {string} [domain] @param {string} [origin] */
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

/** @param {string} nativeOrigin */
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

/** @param {number} upstreamPort @param {{ exclusiveReplacement?: boolean | ((revision: import("../../packages/contracts/src/index.ts").AgentRevision) => boolean) | undefined }} [options] */
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
    /** @param {import("../../packages/contracts/src/index.ts").AgentRevision} revision */
    getGatewayEndpoint(revision) {
      return `wss://localhost:${upstreamPort}/namespaces/${revision.namespaceId}/agents/${revision.agentId}/`;
    },
    /** @param {import("../../packages/contracts/src/index.ts").AgentRevision} revision @param {Parameters<NonNullable<import("../../packages/contracts/src/index.ts").ComputeDriver["getGatewayBrowserRequest"]>>[1]} input */
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
 *   auditSink?: import("../../packages/audit/src/index.ts").InMemoryAuditSink,
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
/**
 * @param {Pick<import("./native-admin-access-fixture.ts").NativeAdminFixture, "fixture" | "namespace" | "agent">} context
 * @param {string} label
 * @param {import("../helpers/iam-grants.ts").ActionsByKind} permissions
 * @param {Parameters<typeof grantRole>[2]["resource"]} [resource]
 */
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

/** @param {import("./native-admin-access-fixture.ts").NativeAdminFixture} context @param {string} [label] */
async function createReadOnlySession(context, label = "native-admin-read-only") {
  return createAgentPermissionSession(context, label, { agent: ["read"] });
}

/** @param {import("./native-admin-access-fixture.ts").NativeAdminFixture} context @param {string} [label] */
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
/** @param {import("./native-admin-access-fixture.ts").NativeAdminFixture} context @param {import("./native-admin-access-fixture.ts").Session} session @param {(resource: string) => string} deniedText */
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

export const nativeAdminCaseDependencies = {
  createNativeAdminFixture,
  nativeOriginForAgent,
  createReadOnlySession,
  createExactAgentAdministerSession,
  createAgentPermissionSession,
  assertSiblingStatusDenied,
  trustLocalUpstreamCertificate,
};

registerNativeAdminAuthorityStatusCase(test, nativeAdminCaseDependencies);

registerNativeAdminPresetCase(
  test,
  nativeAdminCaseDependencies,
  createLiveNativeAgent,
  nativeAdminHarnessConfiguration,
  defaultCodexPreset,
);

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

registerNativeAdminExplicitStopCase(test, nativeAdminCaseDependencies);

registerNativeAdminAvailabilityCases(test, nativeAdminCaseDependencies);

registerNativeAdminSharedCookieCases(test, nativeAdminCaseDependencies);

registerNativeAdminCopiedLinkCase(test, nativeAdminCaseDependencies);

registerNativeAdminSessionRecoveryCase(test, nativeAdminCaseDependencies);

registerNativeAdminProxyCase(
  test,
  nativeAdminCaseDependencies,
  nativeGatewayApiKey,
  createLiveNativeAgent,
);
registerNativeAdminHostResolutionCase(test, nativeAdminCaseDependencies);

registerNativeAdminRevisionDecodingCase(test, nativeAdminCaseDependencies);

registerNativeAdminSessionOriginCases(test, nativeAdminCaseDependencies);

registerNativeAdminComputeOwnerCases(
  test,
  nativeAdminCaseDependencies,
  nativeComputeDriver,
  nativeGatewayApiKey,
  signInToControllerApp,
);

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
