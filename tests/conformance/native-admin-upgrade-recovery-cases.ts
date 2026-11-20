import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import test, { type TestContext } from "node:test";

import Fastify from "../../apps/controller/node_modules/fastify/fastify.js";
import type { AdmittedCaller } from "../../apps/controller/src/admission/admission-verifier.ts";
import { createControllerAuth, type ControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { createNativeAdminAccess } from "../../apps/controller/src/http/native-admin.ts";
import {
  AuditEventFactory,
  type AuditEvent,
  type AuditEventCreationInput,
} from "../../packages/audit/src/index.ts";
import type { Agent } from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { waitUntil } from "../helpers/wait-for.ts";

type BrowserSelection = Awaited<
  ReturnType<OpenClawController["getBrowserAccessibleActiveAgentRevision"]>
>;

type AdmissionSelection = {
  readonly agent: Pick<BrowserSelection["agent"], "id" | "namespaceId" | "desiredRuntimeState">;
  readonly revision: Pick<BrowserSelection["revision"], "id" | "compute" | "configuration">;
  readonly mode: BrowserSelection["mode"];
};

type AuthorizationInput = AdmissionSelection & { readonly denied: Error };

export interface DenialOverrides {
  readonly authorize?: (input: AuthorizationInput) => Promise<AdmissionSelection>;
  readonly append?: (event: AuditEventCreationInput) => Promise<void>;
  readonly transport?: () => Promise<string>;
  readonly admissionError?: Error;
}

export interface UpgradeSocket {
  readonly destroyed: boolean;
  readonly writes: readonly (string | Buffer)[];
  destroy(): UpgradeSocket;
  emit(event: "error", error: Error): boolean;
}

interface GatewayRequest {
  emit(
    event: "upgrade",
    reply: { statusCode: number; headers: IncomingHttpHeaders },
    socket: UpgradeSocket,
    head: Buffer,
  ): boolean;
}

interface DenialOwner {
  readonly denied: Error;
  readonly warnings: readonly unknown[];
  readonly upstreams: readonly GatewayRequest[];
  denials(): readonly AuditEventCreationInput[];
  shutdown(): Promise<void>;
  upgrade(): UpgradeSocket;
}

interface RecoveryFixture {
  denialOwner(t: TestContext, overrides: DenialOverrides): Promise<DenialOwner>;
  settleCallbacks(): Promise<void>;
  AdmissionSocket: new () => UpgradeSocket;
}

function acknowledgeUpgrade(owner: DenialOwner, socket: UpgradeSocket): void {
  assert.equal(owner.upstreams.length, 1);
  const [upstream] = owner.upstreams;
  assert.ok(upstream);
  upstream.emit("upgrade", { statusCode: 101, headers: {} }, socket, Buffer.alloc(0));
}

export function registerUpgradeAdmissionRecoveryCases({
  denialOwner,
  settleCallbacks,
  AdmissionSocket,
}: RecoveryFixture): void {
  for (const boundary of ["timeout", "disconnect", "shutdown-wait-expiry"]) {
    test(`native-admin denial ownership consumes a denial after ${boundary}`, async (t) => {
      const admission = Promise.withResolvers<never>();
      const owner = await denialOwner(t, { authorize: () => admission.promise });
      const socket = owner.upgrade();
      let closing: Promise<void> | undefined;
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
            const warning = asRecord(owner.warnings[0]);
            assert.equal(warning?.event, "native_admin.pending_work_unresolved");
            assert.equal(warning?.pending, 1);
          }
        }
        assert.equal(socket.destroyed, true);
        admission.reject(owner.denied);
        await settleCallbacks();
        assert.equal(owner.denials().length, 1);
        assert.equal(owner.denials()[0]?.resource.id, "agent_a");
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
    const admission = Promise.withResolvers<never>();
    const append = Promise.withResolvers<void>();
    const owner = await denialOwner(t, {
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
      assert.equal(asRecord(owner.warnings[0])?.pending, 1);
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
      const admission = Promise.withResolvers<AdmissionSelection>();
      let selection: AuthorizationInput | undefined;
      const owner = await denialOwner(t, {
        authorize(input) {
          selection = input;
          return admission.promise;
        },
      });
      const socket = owner.upgrade();
      let closing: Promise<void> | undefined;
      try {
        await settleCallbacks();
        assert.ok(selection, "authorization must be pending before the connection is closed");
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
        if (selection !== undefined) {
          admission.resolve(selection);
        }
        socket.destroy();
        await settleCallbacks();
        await (closing ?? owner.shutdown());
      }
    });
  }

  test("native-admin denial ownership closes a denied lease before append settles", async (t) => {
    const append = Promise.withResolvers<void>();
    let reads = 0;
    const owner = await denialOwner(t, {
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
      acknowledgeUpgrade(owner, upstreamSocket);
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
}

export function registerUpgradeLeaseAndResetRecoveryCases({
  denialOwner,
  settleCallbacks,
  AdmissionSocket,
}: RecoveryFixture): void {
  for (const order of ["denial-first", "deadline-first"]) {
    test(`native-admin denial ownership attempts one audit at the deadline (${order})`, async (t) => {
      const admission = Promise.withResolvers<never>();
      const owner = await denialOwner(t, { authorize: () => admission.promise });
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
        const denials = owner.denials();
        assert.equal(denials.length, 1);
        const [denial] = denials;
        assert.ok(denial);
        assert.equal(denial.actor?.principalId, "actor_1");
        assert.equal(denial.authorization?.action, "administer");
        assert.equal(denial.resource.id, "agent_a");
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
    const renewal = Promise.withResolvers<never>();
    let reads = 0;
    const owner = await denialOwner(t, {
      authorize(input) {
        reads += 1;
        return reads === 1 ? Promise.resolve(input) : renewal.promise;
      },
    });
    const socket = owner.upgrade();
    const upstreamSocket = new AdmissionSocket();
    try {
      await settleCallbacks();
      acknowledgeUpgrade(owner, upstreamSocket);
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
      const nativeAdmin = asRecord(owner.denials()[0]?.details?.nativeAdmin);
      assert.equal(nativeAdmin?.revisionId, "rev_a");
    } finally {
      renewal.reject(owner.denied);
      socket.destroy();
      upstreamSocket.destroy();
      await settleCallbacks();
      await owner.shutdown();
    }
  });

  test("native-admin denial ownership preserves reset handling while transport is pending", async (t) => {
    const transport = Promise.withResolvers<string>();
    const owner = await denialOwner(t, {
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
    const admission = Promise.withResolvers<never>();
    const owner = await denialOwner(t, { authorize: () => admission.promise });
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
    const owner = await denialOwner(t, { authorize: () => Promise.reject(unavailable) });
    const socket = owner.upgrade();
    try {
      await settleCallbacks();
      assert.equal(socket.destroyed, true);
      assert.equal(owner.denials().length, 0);
      assert.equal(owner.upstreams.length, 0);
    } finally {
      socket.destroy();
      await owner.shutdown();
    }
  });
}

const installation = {
  id: "inst_native_admin_upgrade",
  name: "Native admin reset conformance",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const consoleOrigin = "https://console.example.com";
const domain = "agents.example.com";
type AccessOptions = Omit<Parameters<typeof createNativeAdminAccess>[0], "app">;
type ScenarioOptions = Pick<
  AccessOptions,
  | "publicOrigin"
  | "getController"
  | "selectedIAMDriver"
  | "nativeAdmin"
  | "nativeAdminGatewayApiKey"
  | "auditSink"
>;

function auth(): ControllerAuth {
  return createControllerAuth({
    mode: "development",
    installationId: installation.id,
    baseURL: consoleOrigin,
    agentDomain: domain,
    secret: randomBytes(32).toString("hex"),
  });
}

function options(controllerAuth: ControllerAuth, scenario: ScenarioOptions): AccessOptions {
  return {
    installationId: installation.id,
    factory: new AuditEventFactory(),
    getContext: () => undefined,
    getAdmission: () => undefined,
    auth: controllerAuth,
    webSocketLeaseIntervalMs: undefined,
    ...scenario,
  };
}

function within<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(description)), 1_000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withUpgradeServer(
  access: AccessOptions,
  scenario: (port: number, upgraded: Promise<Duplex>) => Promise<void>,
): Promise<void> {
  const crashes: Error[] = [];
  const onUncaught = (error: Error) => crashes.push(error);
  const upgraded = Promise.withResolvers<Duplex>();
  let upgradedSocket: Duplex | undefined;
  let closing = false;
  const onUpgrade = (_request: IncomingMessage, socket: Duplex) => {
    upgradedSocket = socket;
    upgraded.resolve(socket);
    if (closing) {
      socket.destroy();
    }
  };
  const app = Fastify({ logger: false });
  process.on("uncaughtException", onUncaught);
  try {
    createNativeAdminAccess({ app, ...access });
    app.server.once("upgrade", onUpgrade);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    await scenario(address.port, upgraded.promise);
  } finally {
    closing = true;
    try {
      // Without a production upgrade handler, this accepted socket would stay half-open.
      upgradedSocket?.destroy();
      await app.close();
      await settleCallbacks();
    } finally {
      app.server.off("upgrade", onUpgrade);
      process.off("uncaughtException", onUncaught);
    }
  }
  assert.deepEqual(crashes, []);
}

async function resetUpgrade(
  port: number,
  host: string,
  entered: Promise<void>,
  upgraded: Promise<Duplex>,
): Promise<void> {
  const socket = net.connect(port, "127.0.0.1");
  const failed = Promise.withResolvers<never>();
  const onError = (error: Error) => failed.reject(error);
  socket.on("error", onError);
  try {
    await within(
      Promise.race([
        new Promise<void>((resolve) => socket.once("connect", resolve)),
        failed.promise,
      ]),
      "the upgrade client must connect",
    );
    socket.write(
      `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    );
    await within(Promise.race([entered, failed.promise]), "the upgrade must enter admission");
    const serverSocket = await within(upgraded, "the server must upgrade the client socket");
    assert.equal(
      serverSocket.destroyed,
      false,
      "the server socket must still be open before reset",
    );
    const closed = Promise.withResolvers<void>();
    const onClose = () => closed.resolve();
    // Observe only close: an error listener here would hide a missing production listener.
    serverSocket.once("close", onClose);
    try {
      socket.resetAndDestroy();
      await within(
        Promise.race([closed.promise, failed.promise]),
        "the upgraded server socket must observe the client reset",
      );
    } finally {
      serverSocket.off("close", onClose);
    }
  } finally {
    socket.off("error", onError);
    socket.destroy();
  }
}

export async function settleCallbacks(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function clientResetDuringUpgradeAdmission(t: TestContext): Promise<void> {
  // Reject admission only after the upgraded server socket has observed the TCP reset.
  const verification = Promise.withResolvers<AdmittedCaller>();
  const entered = Promise.withResolvers<void>();
  let verifying = false;
  let cleaningUp = false;
  const controllerAuth = auth();
  t.mock.method(controllerAuth.admissionVerifier, "verify", () => {
    if (cleaningUp) {
      return Promise.reject(new Error("admission fixture cleanup"));
    }
    verifying = true;
    entered.resolve();
    return verification.promise;
  });
  await withUpgradeServer(
    options(controllerAuth, {
      publicOrigin: undefined,
      getController: () => undefined,
      selectedIAMDriver: () => {
        throw new Error("IAM must not be consulted before admission");
      },
      nativeAdmin: { enabled: false, domain: "agents.example.test" },
      nativeAdminGatewayApiKey: undefined,
      auditSink: { async append() {} },
    }),
    async (port, upgraded) => {
      try {
        await resetUpgrade(port, "agent-a.agents.example.test", entered.promise, upgraded);
        verification.reject(new Error("admission settled after the client reset"));
        await settleCallbacks();
      } finally {
        cleaningUp = true;
        if (verifying) {
          verification.reject(new Error("admission fixture cleanup"));
        }
      }
    },
  );
}

export async function clientResetDuringPendingDenial(t: TestContext): Promise<void> {
  const state = new InMemoryPlatformState();
  const agent = {
    id: "agent_a",
    namespaceId: "ns_a",
    name: "Reset Agent",
    configurationId: "cfg_a",
    backendId: null,
    harnessAuth: null,
    executionMode: "embedded",
    gatewayManagedMode: true,
    servicePrincipalId: "service_agent_a",
    desiredRuntimeState: "stopped",
    status: "active",
    createdAt: installation.createdAt,
  } satisfies Agent;
  await state.transact(async (unit) => {
    await unit.installations.createInstallation(installation);
    await unit.namespaces.createNamespace({
      id: agent.namespaceId,
      name: "Reset Namespace",
      status: "ready",
      createdAt: installation.createdAt,
    });
    await unit.configurations.createConfiguration({
      id: agent.configurationId,
      namespaceId: agent.namespaceId,
      kind: "agent",
      generation: 1,
      createdAt: installation.createdAt,
    });
    await unit.agents.createAgent(agent);
  });
  const identity = {
    kind: "principal",
    id: "actor_1",
    issuer: "https://issuer.example",
    subject: "user-1",
  } satisfies NativeIAMState["identities"][number];
  const iam = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => ({
        identities: [identity],
        groups: [],
        memberships: [],
        roles: [],
        bindings: [],
        restrictions: [],
      }),
    },
    { id: "iam_test" },
  );
  const controller = new OpenClawController(installation, { state });
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  // Delay the real selected IAM decision until after the TCP reset.
  const admission = Promise.withResolvers<void>();
  const browserAccess = controller.getBrowserAccessibleActiveAgentRevision.bind(controller);
  const admissionEntered = Promise.withResolvers<void>();
  t.mock.method(
    controller,
    "getBrowserAccessibleActiveAgentRevision",
    async (...args: Parameters<OpenClawController["getBrowserAccessibleActiveAgentRevision"]>) => {
      admissionEntered.resolve();
      await admission.promise;
      return browserAccess(...args);
    },
  );
  const controllerAuth = auth();
  t.mock.method(controllerAuth.admissionVerifier, "verify", async (): Promise<AdmittedCaller> => ({
    method: "session",
    decisionId: "dec_1",
    admittedScope: { installationId: installation.id },
    externalIdentity: { issuer: identity.issuer, subject: identity.subject },
    session: {
      id: "sess_1",
      userId: identity.subject,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  }));
  const host = deriveNativeAdminHost(installation.id, agent, domain);
  const audits: AuditEvent[] = [];
  let gatewayKeyRequests = 0;
  await withUpgradeServer(
    options(controllerAuth, {
      publicOrigin: consoleOrigin,
      getController: () => controller,
      selectedIAMDriver: () => iam,
      nativeAdmin: { enabled: true, domain },
      nativeAdminGatewayApiKey: async () => {
        gatewayKeyRequests += 1;
        throw new Error("a denied upgrade must not request the gateway key");
      },
      auditSink: {
        async append(event) {
          audits.push(event);
        },
      },
    }),
    async (port, upgraded) => {
      try {
        await resetUpgrade(port, host, admissionEntered.promise, upgraded);
        admission.resolve();
        await waitUntil("the denial audit", () => audits.length > 0, { timeoutMs: 1_000 });
        await settleCallbacks();
      } finally {
        admission.resolve();
      }
    },
  );
  assert.equal(gatewayKeyRequests, 0);
  assert.equal(audits.length, 1);
  const [denial] = audits;
  assert.ok(denial);
  assert.equal(denial.kind, "authorization_denial");
  assert.equal(denial.actor?.principalId, identity.id);
  assert.equal(denial.action, "openclaw.agents.native_admin.proxy.authorize");
  assert.equal(denial.authorization?.action, "operate");
  assert.deepEqual(denial.authorization?.resource, {
    kind: "agent",
    id: agent.id,
    namespaceId: agent.namespaceId,
  });
  assert.equal(denial.outcome, "denied");
  const details = asRecord(denial.details?.nativeAdmin);
  assert.ok(details);
  assert.equal(details.reason, "authorization_denied");
  assert.equal(details.host, host);
}
