import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { TestContext } from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

import Fastify, {
  type FastifyInstance,
} from "../../apps/controller/node_modules/fastify/fastify.js";
import type { AdmissionVerifier } from "../../apps/controller/src/admission/admission-verifier.ts";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import type { AuditEventCreationInput } from "../../packages/audit/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { selfSigned } from "../helpers/certificates.ts";
import { nativeAdminGatewayAuth } from "../helpers/harness-configuration.mjs";
import type {
  Selection,
  UpgradeAuditTransport,
  UpgradeAuditTransportOptions,
} from "./native-admin-upgrade-audit-cases.ts";
import { AdmissionSocket } from "./native-admin-upgrade-denial-cases.ts";
import type { DenialOverrides, DenialOwner } from "./native-admin-upgrade-recovery-cases.ts";

// Socket receipts and cleanup must retain real deadlines when shutdown time is mocked.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

export type PendingResetPhase = "admission" | "gateway key";

export function nativeAdminScenario(
  installationId: string,
  overrides?: Pick<DenialOverrides, "admissionError">,
) {
  const agent: Selection["agent"] = {
    id: "agent_a",
    namespaceId: "ns_a",
    desiredRuntimeState: "running",
  };
  const domain = "agents.example.com";
  const host = deriveNativeAdminHost(installationId, agent, domain);
  const origin = `https://${host}`;
  // The active revision opts its Gateway into native admin and allows only this origin.
  const revision: Selection["revision"] = {
    id: "rev_a",
    compute: { id: "compute_test", implementation: "native-admin-reset-test" },
    configuration: {
      gateway: {
        auth: nativeAdminGatewayAuth(),
        controlUi: { enabled: true, allowedOrigins: [origin] },
      },
    },
  };
  const selection: Selection = { agent, revision, mode: "admin" };
  const admissionVerifier: AdmissionVerifier = {
    async verify() {
      if (overrides?.admissionError) {
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
  };
  return { installationId, admissionVerifier, agent, domain, host, origin, revision, selection };
}

type Scenario = ReturnType<typeof nativeAdminScenario>;

export interface AccessRegistration extends Pick<
  Scenario,
  "installationId" | "agent" | "domain" | "admissionVerifier"
> {
  readonly app: FastifyInstance;
  admit(): Selection | Promise<Selection>;
  supportsBrowser?(): boolean;
  gatewayEndpoint(): string;
  readonly browserHeaders?: Readonly<Record<string, string>>;
  gatewayKey(): Promise<string>;
  readonly leaseIntervalMs: number | undefined;
  readonly appendAudit: (event: AuditEventCreationInput) => Promise<void>;
}

interface DenialRegistration extends AccessRegistration {
  readonly t: TestContext;
  readonly upstreams: AdmissionSocket[];
}

function authorizationDenied(agent: Selection["agent"], action: string) {
  return Object.assign(new Error("The exact platform operation was not authorized."), {
    name: "AuthorizationDeniedError",
    authorization: {
      action,
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    },
  });
}

export function within<T>(
  promise: Promise<T>,
  description: string,
  milliseconds = 1_500,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(description)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => realClearTimeout(timer));
}

function listen(gateway: https.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      gateway.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      gateway.off("error", onError);
      resolve();
    };
    gateway.once("listening", onListening);
    gateway.once("error", onError);
  });
}

function connected(socket: net.Socket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off("error", onError);
      resolve();
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

export function gatewayEndpoint(gateway: https.Server | net.Server): string {
  const address = gateway.address();
  assert.ok(address && typeof address === "object");
  return `wss://127.0.0.1:${address.port}/`;
}

export function writeUpgradeRequest(socket: net.Socket, { host, origin }: Scenario): void {
  socket.write(
    `GET / HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\n` +
      "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
}

// The upgrade handler, TLS, relay and lease timer run over real loopback connections.
export function createTransportOwner(register: (input: AccessRegistration) => void) {
  return async (
    t: TestContext,
    {
      authorize,
      append,
      appendSocket = async () => {},
      supportsBrowser = () => true,
    }: UpgradeAuditTransportOptions,
  ): Promise<UpgradeAuditTransport> => {
    const directory = await mkdtemp(join(tmpdir(), "native-admin-audit-transport-"));
    const previousCertificates = getCACertificates("default");
    const sockets = new Set<Duplex>();
    const resources: { app?: FastifyInstance; gateway?: https.Server } = {};
    t.after(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      try {
        const currentGateway = resources.gateway;
        const results = await within(
          Promise.allSettled([
            resources.app?.close(),
            currentGateway && new Promise<void>((resolve) => currentGateway.close(() => resolve())),
          ]),
          "transport cleanup must finish after the shutdown drain",
          6_500,
        );
        for (const result of results) {
          if (result.status === "rejected") {
            const reason: unknown = result.reason;
            assert.fail(reason instanceof Error ? reason.message : "transport cleanup rejected");
          }
        }
        assert.ok([...sockets].every((socket) => socket.destroyed));
      } finally {
        setDefaultCACertificates(previousCertificates);
        await rm(directory, { recursive: true, force: true });
      }
    });
    const { key, cert } = await selfSigned(directory);
    setDefaultCACertificates([...previousCertificates, cert]);
    const peerClosed = Promise.withResolvers<void>();
    let gatewayConnections = 0;
    const gateway = https.createServer({ key, cert });
    resources.gateway = gateway;
    gateway.on("connection", (socket) => {
      gatewayConnections += 1;
      sockets.add(socket);
      socket.on("error", () => {});
    });
    gateway.on("upgrade", (_request, socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once<"close">("close", () => peerClosed.resolve());
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      // A real upstream byte must cross the production relay before lease denial.
      socket.write("peer-ready");
    });
    gateway.listen(0, "127.0.0.1");
    await within(listen(gateway), "the fixture gateway must listen");
    const scenario = nativeAdminScenario("inst_native_admin_transport");
    const { agent, revision } = scenario;
    const denied = authorizationDenied(agent, "openclaw.agents.native_admin.proxy.authorize");
    const entered = Promise.withResolvers<void>();
    const auditEntered = Promise.withResolvers<void>();
    const serverClosed = Promise.withResolvers<boolean>();
    const audits: AuditEventCreationInput[] = [];
    const warnings: unknown[] = [];
    const appClosed = Promise.withResolvers<void>();
    const app = Fastify({ logger: false });
    resources.app = app;
    t.mock.method(app.log, "warn", (fields: unknown) => warnings.push(fields));
    app.addHook("onClose", async () => appClosed.resolve());
    app.server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", serverClosed.resolve);
    });
    register({
      ...scenario,
      app,
      admit() {
        entered.resolve();
        return authorize({ agent, revision, denied, mode: "admin" });
      },
      supportsBrowser,
      gatewayEndpoint: () => gatewayEndpoint(gateway),
      browserHeaders: {
        "x-occ-identity": "test:native-actor-1",
        "x-occ-browser-key": "browser-test-secret",
      },
      gatewayKey: async () => "transport-fixture-key",
      leaseIntervalMs: 50,
      appendAudit(event) {
        audits.push(event);
        if (event.kind === "authorization_denial") {
          auditEntered.resolve();
          assert.ok(append, "the fixture must handle any authorization denial audit");
          return append(event);
        }
        return appendSocket(event);
      },
    });
    await within(app.listen({ host: "127.0.0.1", port: 0 }), "the fixture controller must listen");
    return {
      denied,
      host: scenario.host,
      audits,
      warnings,
      appClosed: appClosed.promise,
      entered: entered.promise,
      auditEntered: auditEntered.promise,
      serverClosed: serverClosed.promise,
      peerClosed: peerClosed.promise,
      gatewayConnections: () => gatewayConnections,
      denials: () => audits.filter((event) => event.kind === "authorization_denial"),
      closeAudit: () =>
        audits.find((event) => asRecord(event.details?.nativeAdmin)?.event === "close"),
      connectionAudits: () =>
        audits.filter((event) => {
          const name = asRecord(event.details?.nativeAdmin)?.event;
          return name === "connect" || name === "close";
        }),
      shutdown: () => app.close(),
      async open() {
        const address = app.server.address();
        assert.ok(address && typeof address === "object");
        const socket = net.connect(address.port, "127.0.0.1");
        sockets.add(socket);
        socket.on("error", () => {});
        const closed = Promise.withResolvers<boolean>();
        socket.once("close", closed.resolve);
        const ready = Promise.withResolvers<string>();
        let received = "";
        socket.on<"data">("data", (chunk) => {
          received += chunk.toString();
          if (received.includes("\r\n\r\npeer-ready")) {
            ready.resolve(received);
          }
        });
        await within(connected(socket), "the fixture client must connect");
        writeUpgradeRequest(socket, scenario);
        return { closed: closed.promise, ready: ready.promise, received: () => received };
      },
    };
  };
}

function denialRequest(scenario: Scenario) {
  return {
    method: "GET",
    url: "/",
    headers: {
      host: scenario.host,
      origin: scenario.origin,
      "sec-websocket-key": "synthetic",
      "sec-websocket-version": "13",
    },
    socket: { remoteAddress: "127.0.0.1" },
    destroyed: false,
  };
}

export function createDenialOwner(
  register: (input: DenialRegistration) => {
    access: DenialOwner["access"];
    emitUpgrade: (
      request: ReturnType<typeof denialRequest>,
      socket: AdmissionSocket,
      head: Buffer<ArrayBuffer>,
    ) => void;
  },
) {
  return async (t: TestContext, overrides: DenialOverrides = {}): Promise<DenialOwner> => {
    const scenario = nativeAdminScenario("inst_native_admin_audit", overrides);
    const { agent, revision } = scenario;
    const denied = authorizationDenied(agent, "administer");
    const audits: AuditEventCreationInput[] = [];
    const warnings: unknown[] = [];
    const upstreams: AdmissionSocket[] = [];
    const app = Fastify({ logger: false });
    t.after(() => app.close());
    t.mock.method(app.log, "warn", (event: unknown) => warnings.push(event));
    const { access, emitUpgrade } = register({
      ...scenario,
      t,
      app,
      upstreams,
      admit: () =>
        overrides.authorize?.({ agent, revision, denied, mode: "admin" }) ?? Promise.reject(denied),
      gatewayEndpoint: () => "wss://gateway.example.test",
      gatewayKey: overrides.transport ?? (async () => "synthetic"),
      leaseIntervalMs: undefined,
      appendAudit(event) {
        audits.push(event);
        return overrides.append?.(event) ?? Promise.resolve();
      },
    });
    await app.ready();
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const request = () => denialRequest(scenario);
    return {
      access,
      warnings,
      upstreams,
      denied,
      request,
      denials: () => audits.filter((event) => event.kind === "authorization_denial"),
      shutdown: () => app.close(),
      upgrade() {
        const socket = new AdmissionSocket();
        emitUpgrade(request(), socket, Buffer.alloc(0));
        return socket;
      },
    };
  };
}
