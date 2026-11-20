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
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import type { createNativeAdminAccess } from "../../apps/controller/src/http/native-admin.ts";
import type { AuditEventCreationInput } from "../../packages/audit/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { selfSigned } from "../helpers/certificates.ts";
import { nativeAdminGatewayAuth } from "../helpers/harness-configuration.mjs";
import type {
  UpgradeAuditTransport,
  UpgradeAuditTransportOptions,
} from "./native-admin-upgrade-audit-cases.ts";
import { AdmissionSocket } from "./native-admin-upgrade-denial-cases.ts";
import type { DenialOverrides, DenialOwner } from "./native-admin-upgrade-recovery-cases.ts";

// Socket receipts and cleanup must retain real deadlines when shutdown time is mocked.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

type Selection = Omit<Parameters<UpgradeAuditTransportOptions["authorize"]>[0], "denied">;
export type PendingResetPhase = "admission" | "gateway key";

export function nativeAdminScenario(installationId: string) {
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
  return { installationId, agent, domain, host, origin, revision, selection };
}

type Scenario = ReturnType<typeof nativeAdminScenario>;
type AuditAppend = (event: AuditEventCreationInput) => Promise<void>;

export interface TransportRegistration extends Pick<
  Scenario,
  "installationId" | "agent" | "revision" | "domain"
> {
  readonly app: FastifyInstance;
  readonly denied: Error;
  readonly entered: Pick<PromiseWithResolvers<void>, "resolve">;
  readonly authorize: UpgradeAuditTransportOptions["authorize"];
  supportsBrowser(): boolean;
  gatewayEndpoint(): string;
  readonly appendAudit: AuditAppend;
}

export interface DenialRegistration extends Pick<
  Scenario,
  "installationId" | "agent" | "revision" | "domain"
> {
  readonly t: TestContext;
  readonly app: FastifyInstance;
  readonly denied: Error;
  readonly overrides: DenialOverrides;
  readonly upstreams: AdmissionSocket[];
  readonly appendAudit: AuditAppend;
}

export interface PendingResetRegistration extends Pick<
  Scenario,
  "installationId" | "agent" | "domain"
> {
  readonly app: FastifyInstance;
  admit(): Selection | Promise<Selection>;
  gatewayEndpoint(): string;
  gatewayKey(): Promise<string>;
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

// Only authorization and audit persistence are controlled. Admission, TLS, relay,
// lease timer and both ends of each connection are real.
export function createTransportOwner(register: (input: TransportRegistration) => void) {
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
    const peerClosed = Promise.withResolvers<boolean>();
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
      socket.once("close", peerClosed.resolve);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      // A real upstream byte must cross the production relay before lease denial.
      socket.write("peer-ready");
    });
    gateway.listen(0, "127.0.0.1");
    await within(listen(gateway), "the fixture gateway must listen");
    const scenario = nativeAdminScenario("inst_native_admin_transport");
    const denied = Object.assign(new Error("The exact platform operation was not authorized."), {
      name: "AuthorizationDeniedError",
      authorization: {
        action: "openclaw.agents.native_admin.proxy.authorize",
        resource: { kind: "agent", id: scenario.agent.id, namespaceId: scenario.agent.namespaceId },
      },
    });
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
      denied,
      entered,
      authorize,
      supportsBrowser,
      gatewayEndpoint: () => gatewayEndpoint(gateway),
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
        socket.on("data", (chunk: Buffer) => {
          received += chunk.toString();
          if (received.includes("\r\n\r\npeer-ready")) {
            ready.resolve(received);
          }
        });
        await within(connected(socket), "the fixture client must connect");
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${scenario.host}\r\nOrigin: ${scenario.origin}\r\nConnection: Upgrade\r\n` +
            "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
        return { closed: closed.promise, ready: ready.promise, received: () => received };
      },
    };
  };
}

// The incompatible HTTPS request interception and partial product options stay in JS.
export function createDenialOwner(
  register: (input: DenialRegistration) => ReturnType<typeof createNativeAdminAccess>,
) {
  return async (t: TestContext, overrides: DenialOverrides = {}): Promise<DenialOwner> => {
    const scenario = nativeAdminScenario("inst_native_admin_audit");
    const denied = Object.assign(new Error("The exact platform operation was not authorized."), {
      name: "AuthorizationDeniedError",
      authorization: {
        action: "administer",
        resource: { kind: "agent", id: scenario.agent.id, namespaceId: scenario.agent.namespaceId },
      },
    });
    const audits: AuditEventCreationInput[] = [];
    const warnings: unknown[] = [];
    const upstreams: AdmissionSocket[] = [];
    const app = Fastify({ logger: false });
    t.after(() => app.close());
    t.mock.method(app.log, "warn", (event: unknown) => warnings.push(event));
    const access = register({
      ...scenario,
      t,
      app,
      denied,
      overrides,
      upstreams,
      appendAudit(event) {
        audits.push(event);
        return overrides.append?.(event) ?? Promise.resolve();
      },
    });
    await app.ready();
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const request = () => ({
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
    });
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
        app.server.emit("upgrade", request(), socket, Buffer.alloc(0));
        return socket;
      },
    };
  };
}
