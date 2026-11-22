import { authenticatedHeaders } from "../../helpers/auth-session.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { InMemoryAuditSink } from "../../../packages/audit/src/index.ts";
import type {
  AuditEvent,
  AgentAutomationData,
  AgentAutomationCreateInput,
} from "../../../packages/contracts/src/index.ts";
import { createAgentAutomationsAccess } from "../../../apps/controller/src/composition/agent-automations.ts";
import { prepareNativeAdminConfiguration } from "../../../apps/controller/src/gateway/native-admin.ts";
import { createConsoleAppFixture } from "../../helpers/console-app.mjs";
import { createReadyComputeDriver } from "../../helpers/development.ts";
import { createHarnessConfiguration } from "../../helpers/harness-configuration.mjs";
import type { PlatformStateStore } from "../../../packages/occ/src/index.ts";
import { runDocker } from "../../helpers/runtime-image-docker.ts";
import { waitForContainerReady } from "../../helpers/runtime-image-gateway-observations.ts";
import { GatewayClient } from "../../../apps/controller/tests/fixtures/plugin-approval-client.ts";
import { cpuScaledImageTimeoutMs } from "../../helpers/image-smoke-timeout.ts";
import pg from "pg";
import { PostgresPlatformState } from "../../../packages/occ/src/index.ts";
import {
  createControllerWorker,
  type ControllerWorker,
} from "../../../apps/controller/src/worker.ts";
import { createBackendWorkerDrivers } from "../../helpers/postgres-backend-state.mjs";
import { waitFor } from "../../helpers/wait-for.ts";

// Use the SDK's installed WebSocket transport for a transparent, test-owned fault proxy.
// No fixture generates native RPC replies: every successful reply comes from OpenClaw.
interface Peer {
  readyState: number;
  on(event: "message", handler: (value: Buffer) => void): void;
  on(event: "open" | "close" | "error", handler: () => void): void;
  send(value: Buffer): void;
  terminate(): void;
}
interface PeerServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (peer: Peer) => void,
  ): void;
  close(callback: () => void): void;
}
const appRequire = createRequire(new URL("../../../apps/controller/package.json", import.meta.url));
const sdkRequire = createRequire(appRequire.resolve("@openclaw/gateway-client"));
const websocket = sdkRequire("ws") as {
  WebSocket: new (url: string, options: { headers: Record<string, string> }) => Peer;
  WebSocketServer: new (options: { noServer: true }) => PeerServer;
};
assert.equal(typeof websocket.WebSocket, "function");
assert.equal(typeof websocket.WebSocketServer, "function");
const endpoint = process.env.OCC_WORKSPACE_PROOF_ENDPOINT;
const keyPath = process.env.OCC_WORKSPACE_PROOF_KEY_PATH;
const certPath = process.env.OCC_AUTOMATION_PROOF_CERT;
const tlsKeyPath = process.env.OCC_AUTOMATION_PROOF_TLS_KEY;
assert.ok(endpoint && keyPath && certPath && tlsKeyPath);
const apiKey = await readFile(keyPath, "utf8");
const nativeContainer = process.env.OCC_AUTOMATION_PROOF_NATIVE_CONTAINER;
const replacementArgumentsPath = process.env.OCC_AUTOMATION_PROOF_REPLACEMENT_ARGS;
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
assert.ok(nativeContainer && replacementArgumentsPath && databaseUrl);
const platformPool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
const platformState = new PostgresPlatformState(platformPool);
let worker: ControllerWorker | undefined;
const replacementArguments: unknown = JSON.parse(await readFile(replacementArgumentsPath, "utf8"));
assert.ok(
  Array.isArray(replacementArguments) &&
    replacementArguments.every((arg) => typeof arg === "string"),
);
const cleanups: Array<() => unknown | Promise<unknown>> = [];
const scope = {
  after: (cleanup: () => unknown | Promise<unknown>) => {
    cleanups.push(cleanup);
  },
};
const peers = new Set<Peer>();
const sockets = new websocket.WebSocketServer({ noServer: true });
const proxy = createServer({ cert: await readFile(certPath), key: await readFile(tlsKeyPath) });
let nativeCreateRequests = 0;
let nativeUpdates = 0;
let beforeUpdate: undefined | (() => Promise<void>);
let verifyActivationBinding: undefined | ((nativeJobId: string) => Promise<void>);
let verifiedActivations = 0;
let loseCreateReply = false;
let loseUpdateReply = false;
let afterUpdate: undefined | (() => Promise<void>);
proxy.on("upgrade", (request, socket, head) => {
  sockets.handleUpgrade(request, socket, head, (downstream) => {
    const upstream = new websocket.WebSocket(endpoint, { headers: { "x-api-key": apiKey } });
    peers.add(downstream);
    peers.add(upstream);
    const queue: Buffer[] = [];
    const creating = new Set<string>();
    const updating = new Set<string>();
    downstream.on("message", (bytes) => {
      const frame = JSON.parse(bytes.toString()) as {
        type?: string;
        method?: string;
        id?: string;
        params?: {
          id?: string;
          enabled?: boolean;
          payload?: { toolsAllow?: unknown };
          patch?: { enabled?: boolean; payload?: { toolsAllow?: unknown } };
        };
      };
      if (frame.type === "req" && frame.method === "cron.add" && frame.id) {
        nativeCreateRequests++;
        assert.equal(
          frame.params?.enabled,
          false,
          "native creation remains disabled until binding",
        );
        assert.deepEqual(
          frame.params?.payload?.toolsAllow,
          [],
          "OCC native add must explicitly disable every model tool",
        );
        creating.add(frame.id);
      }
      const forward = () => {
        if (upstream.readyState === 1) {
          upstream.send(bytes);
        } else {
          queue.push(bytes);
        }
      };
      if (frame.method === "cron.update") {
        nativeUpdates++;
        assert.deepEqual(
          frame.params?.patch?.payload?.toolsAllow,
          [],
          "every OCC native update must reassert the empty tool cap",
        );
        if (frame.id) {
          updating.add(frame.id);
        }
        const action = beforeUpdate;
        beforeUpdate = undefined;
        void (async () => {
          await action?.();
          if (frame.params?.patch?.enabled === true && frame.params.id) {
            await verifyActivationBinding?.(frame.params.id);
            verifiedActivations++;
          }
        })()
          .then(forward)
          .catch(() => {
            downstream.terminate();
            upstream.terminate();
          });
      } else {
        forward();
      }
    });
    upstream.on("open", () => {
      for (const bytes of queue) {
        upstream.send(bytes);
      }
    });
    upstream.on("message", (bytes) => {
      void (async () => {
        const frame = JSON.parse(bytes.toString()) as {
          type?: string;
          id?: string;
          ok?: boolean;
          error?: { message?: string };
        };
        if (
          frame.type === "res" &&
          frame.id &&
          frame.ok &&
          creating.delete(frame.id) &&
          loseCreateReply
        ) {
          loseCreateReply = false;
          downstream.terminate();
          upstream.terminate();
          return;
        }
        if (frame.type === "res" && frame.id && frame.ok && updating.delete(frame.id)) {
          if (loseUpdateReply) {
            loseUpdateReply = false;
            downstream.terminate();
            upstream.terminate();
            return;
          }
          const action = afterUpdate;
          afterUpdate = undefined;
          await action?.();
        }
        if (downstream.readyState === 1) {
          downstream.send(bytes);
        }
      })().catch(() => {
        downstream.terminate();
        upstream.terminate();
      });
    });
    for (const peer of [downstream, upstream]) {
      peer.on("error", () => {
        downstream.terminate();
        upstream.terminate();
      });
      peer.on("close", () => {
        peers.delete(peer);
        downstream.terminate();
        upstream.terminate();
      });
    }
  });
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const address = proxy.address();
assert.ok(address && typeof address !== "string");
class FaultAudit extends InMemoryAuditSink {
  failSuccess = false;
  override async append(event: AuditEvent): Promise<void> {
    if (this.failSuccess && event.action === "openclaw.agents.automations.update.success") {
      this.failSuccess = false;
      throw new Error("owned audit sink unavailable after native commit");
    }
    await super.append(event);
  }
}
const auditSink = new FaultAudit();
async function inspectRuntimeContainer() {
  const execute = promisify(execFile);
  const result = await execute("docker", [
    "inspect",
    "--format",
    '{"id":{{json .Id}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"hostname":{{json .Config.Hostname}},"running":{{json .State.Running}}}',
    nativeContainer,
  ]);
  return JSON.parse(result.stdout) as {
    id: string;
    image: string;
    imageId: string;
    hostname: string;
    running: boolean;
  };
}

const compute = createReadyComputeDriver("automation-native-probe", {
  implementation: "native-protocol-proof",
  supportsGatewayManagedMode: undefined,
  validateHarnessAuth() {},
  getGatewayEndpoint: () => `wss://127.0.0.1:${address.port}`,
  async getRuntimeImages() {
    const execute = promisify(execFile);
    const container = await inspectRuntimeContainer();
    const result = await execute("docker", [
      "image",
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      container.imageId,
    ]);
    const labels = JSON.parse(result.stdout) as Record<string, string> | null;
    return [
      {
        workload: nativeContainer,
        container: "gateway",
        image: container.image,
        imageId: container.imageId,
        commit: labels?.["org.opencontainers.image.revision"] || null,
        openclawCommit: labels?.["org.openclaw.image.revision"] || null,
      },
    ];
  },
  async evaluateAgentAutomationPolicy() {
    return { grant: { tools: [] }, bindings: [] };
  },
  async openAgentAutomationTransport() {
    const selected = await inspectRuntimeContainer();
    if (!selected.running || !selected.hostname) {
      return undefined;
    }
    let closed = false;
    return {
      url: `wss://127.0.0.1:${address.port}`,
      expectedHostname: selected.hostname,
      async assertCurrent() {
        if (closed) {
          return false;
        }
        const current = await inspectRuntimeContainer().catch(() => undefined);
        if (
          !current?.running ||
          current.id !== selected.id ||
          current.hostname !== selected.hostname
        ) {
          closed = true;
          return false;
        }
        return true;
      },
      async close() {
        closed = true;
      },
    };
  },
});
const publicOrigin = "https://console.oce.example.test";
let holdOwnershipList = false;
const ownershipCaptured = Promise.withResolvers<void>();
const ownershipReleased = Promise.withResolvers<void>();

try {
  const f = await createConsoleAppFixture(scope, {
    provisionedPeople: ["automation-other-creator"],
    state: platformState,
    recordOperations: true,
    wrapState: (state: PlatformStateStore): PlatformStateStore => ({
      async read(work) {
        let captured = false;
        const result = await state.read((view) =>
          work({
            ...view,
            agentAutomations: {
              ...view.agentAutomations,
              async list(...args: Parameters<typeof view.agentAutomations.list>) {
                const records = await view.agentAutomations.list(...args);
                if (holdOwnershipList && args[2] === undefined) {
                  holdOwnershipList = false;
                  captured = true;
                }
                return records;
              },
            },
          }),
        );
        // Hold only the already-read result, after the real repository view closes.
        // IAM revocation can commit normally; no policy decision or data is faked.
        if (captured) {
          ownershipCaptured.resolve();
          await ownershipReleased.promise;
        }
        return result;
      },
      transact: (work) => state.transact(work),
    }),
    computeDriver: compute,
    agentGatewayManagedMode: false,
    auditSink,
    publicOrigin,
    authBaseURL: publicOrigin,
    development: { enabled: false },
    nativeAdmin: { enabled: true, domain: "agents.oce.example.test" },
    nativeAdminGatewayApiKey: async () => apiKey,
    agentAutomations: createAgentAutomationsAccess(compute, keyPath),
  });
  platformState.setBootstrapNativeIAM(f.policy);
  await f.bootstrap("Native automation protocol");
  worker = createControllerWorker({
    pool: new pg.Pool({ connectionString: databaseUrl, max: 6 }),
    drivers: createBackendWorkerDrivers(compute, [], {
      secretDriver: f.controller.selectedDriver("secret"),
    }),
    pollIntervalMs: 15,
    emit() {},
  });
  await worker.start();
  const namespace = await f.createNamespace("Automations", { ready: true });
  const values = createHarnessConfiguration("openclaw", "gpt-4.1");
  const agent = await f.createAgent(namespace.id, "Automation Agent", values);
  await f.updateConfiguration(
    namespace.id,
    agent.configurationId,
    prepareNativeAdminConfiguration(values, {
      publicOrigin,
      installationId: f.controller.installation.id,
      agent,
      domain: "agents.oce.example.test",
    }),
  );
  async function deployAndWait() {
    const deployed = await f.deployAgent(namespace.id, agent.id);
    await waitFor("the real deployment reconcile work to succeed", async () => {
      const work = await platformState.read((unit) =>
        unit.operations.findWork(`agent_revision:${deployed.id}:reconcile`),
      );
      return work?.state === "succeeded" ? true : undefined;
    });
    return deployed;
  }
  let revision = await deployAndWait();
  const base = `/namespaces/${namespace.id}/agents/${agent.id}/automations`;
  const administrator = await f.signIn();
  async function request(
    method: string,
    path: string,
    options: { body?: unknown; session?: typeof administrator } = {},
  ) {
    const result = await f.rawRequest(method, path, {
      body: options.body,
      headers: authenticatedHeaders(options.session ?? administrator, { origin: publicOrigin }),
      timeout: 40_000,
    });
    const body = result.text ? JSON.parse(result.text) : {};
    return {
      status: result.response.status,
      data: body.data,
      body,
      headers: result.response.headers,
    };
  }
  // Native observation reads actual stored caps; it is not a model/tool substitute.
  // Keep ordinary native scheduling enabled and all enabled jobs far in the future.
  async function openObserver() {
    const connected = Promise.withResolvers<void>();
    const client = new GatewayClient({
      url: endpoint,
      clientName: "gateway-client",
      mode: "backend",
      role: "operator",
      deviceIdentity: null,
      scopes: [],
      edgeAuthHeaders: { "x-api-key": apiKey },
      onHelloOk: () => connected.resolve(),
      onConnectError: connected.reject,
      hostDeps: { logError: () => {}, logDebug: () => {} },
    });
    const timer = setTimeout(
      () => connected.reject(new Error("Native observer connection timed out")),
      15_000,
    );
    try {
      client.start();
      await connected.promise;
      return client;
    } catch (error) {
      client.stop();
      await client.stopAndWait({ timeoutMs: 1000 });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  let observer = await openObserver();
  cleanups.push(async () => {
    observer.stop();
    await observer.stopAndWait({ timeoutMs: 1000 });
  });
  assert.equal((await observer.request<{ enabled: boolean }>("cron.status", {})).enabled, true);
  async function storedModelOnly(id: string) {
    const { record } = await f.controller.getAgentAutomationOwnership(
      f.principal.id,
      namespace.id,
      agent.id,
      id,
    );
    assert.ok(record.nativeJobId, "native observation requires the durable OCC binding");
    const stored = await observer.request<{
      configRevision: string;
      payload: {
        kind: string;
        message: string;
        toolsAllow?: unknown;
        toolsAllowIsDefault?: unknown;
      };
      sessionTarget: string;
      wakeMode: string;
      delivery: { mode: string };
    }>("cron.get", { id: record.nativeJobId });
    assert.equal(stored.payload.kind, "agentTurn");
    assert.deepEqual(stored.payload.toolsAllow, []);
    assert.ok(
      stored.payload.toolsAllowIsDefault === undefined ||
        stored.payload.toolsAllowIsDefault === false,
    );
    assert.equal(stored.sessionTarget, "isolated");
    assert.equal(stored.wakeMode, "now");
    assert.equal(stored.delivery.mode, "none");
    return { record, stored };
  }
  verifyActivationBinding = async (nativeJobId) => {
    const records = await f.controller.listAgentAutomationOwnership(
      f.principal.id,
      namespace.id,
      agent.id,
    );
    assert.ok(
      records.some((record) => record.nativeJobId === nativeJobId),
      "activation requires a committed native ID binding",
    );
  };
  const input: AgentAutomationCreateInput = {
    name: "Model-only protocol job",
    enabled: false,
    schedule: { kind: "every", everyMs: 86_400_000 },
    prompt: "This job must not execute during protocol proof.",
  };
  // Closed HTTP bodies cannot supply wildcard, alias, default or automatic grants.
  for (const extra of [
    { toolsAllow: ["*"] },
    { toolsAllow: ["group:runtime"] },
    { payload: { toolsAllow: [] } },
    { toolsAllowIsDefault: true },
  ]) {
    assert.equal((await request("POST", base, { body: { ...input, ...extra } })).status, 400);
  }
  assert.equal(nativeCreateRequests, 0);
  // These are valid OCC envelopes rejected by the actual native scheduler.
  for (const schedule of [
    { kind: "cron", expr: "not a cron expression", tz: "UTC" },
    { kind: "cron", expr: "0 9 * * *", tz: "Invalid/Zone" },
    { kind: "cron", expr: "not a cron expression", tz: "UTC" },
  ]) {
    const before = nativeCreateRequests;
    const rejected = await request("POST", base, { body: { ...input, schedule } });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(nativeCreateRequests, before + 1);
    assert.deepEqual(
      await f.controller.listAgentAutomationOwnership(f.principal.id, namespace.id, agent.id),
      [],
      "definite native rejection must discard the unbound reservation",
    );
  }
  const durableAudit = await platformState.transact((unit) => unit.audit.list());
  assert.equal(durableAudit.filter((event) => event.action.endsWith(".discarded")).length, 3);
  async function create(value: AgentAutomationCreateInput) {
    const response = await request("POST", base, { body: value });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.headers.get("location"), `${base}/${response.data.id}`);
    const job = response.data as AgentAutomationData;
    assert.equal(job.enabled, value.enabled);
    await storedModelOnly(job.id);
    return job;
  }
  const job = await create({ ...input, enabled: true });
  for (const schedule of [
    { kind: "at" as const, at: new Date(Date.now() + 3_600_000).toISOString() },
    { kind: "cron" as const, expr: "0 9 * * *", tz: "UTC" },
  ]) {
    const created = await create({ ...input, schedule });
    assert.equal(created.schedule.kind, schedule.kind);
    assert.equal(
      (await request("GET", `${base}/${created.id}`)).data.configRevision,
      created.configRevision,
    );
  }
  const retainedEnabled = await create({ ...input, name: "Retained future job", enabled: true });
  const updatesBeforeRefusal = nativeUpdates;
  assert.equal(
    (
      await request("PATCH", `${base}/${job.id}`, {
        body: { enabled: false, expectedConfigRevision: job.configRevision, toolsAllow: ["*"] },
      })
    ).status,
    400,
  );
  assert.equal(
    nativeUpdates,
    updatesBeforeRefusal,
    "client tool policy must be rejected before native mutation",
  );

  assert.equal(job.schedule.kind, "every");
  assert.ok("anchorMs" in job.schedule && Number.isSafeInteger(job.schedule.anchorMs));
  const changed = await request("PATCH", `${base}/${job.id}`, {
    body: {
      name: "Updated through OCC",
      prompt: "Model-only updated prompt; this future job must not run.",
      enabled: false,
      expectedConfigRevision: job.configRevision,
    },
  });
  assert.equal(changed.status, 200);
  let current = changed.data as AgentAutomationData;
  assert.notEqual(current.configRevision, job.configRevision);
  assert.equal((await storedModelOnly(job.id)).stored.payload.message, current.prompt);
  const resumed = await request("PATCH", `${base}/${job.id}`, {
    body: { enabled: true, expectedConfigRevision: current.configRevision },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.enabled, true);
  await storedModelOnly(job.id);
  const pausedAgain = await request("PATCH", `${base}/${job.id}`, {
    body: { enabled: false, expectedConfigRevision: resumed.data.configRevision },
  });
  assert.equal(pausedAgain.status, 200);
  current = pausedAgain.data;
  await storedModelOnly(job.id);

  assert.equal(
    (
      await request("PATCH", `${base}/${job.id}`, {
        body: { enabled: false, expectedConfigRevision: job.configRevision },
      })
    ).status,
    409,
  );

  // Both OCC requests read the same revision. Hold the first native update until
  // the second commits, so the native atomic precondition must preserve the winner.
  let releaseUpdate!: () => void;
  let updateHeld!: () => void;
  const updateRelease = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const held = new Promise<void>((resolve) => {
    updateHeld = resolve;
  });
  beforeUpdate = async () => {
    updateHeld();
    await updateRelease;
  };
  const losingEdit = request("PATCH", `${base}/${job.id}`, {
    body: {
      name: "Losing concurrent OCC edit",
      enabled: false,
      expectedConfigRevision: current.configRevision,
    },
  });
  await held;
  let winningEdit: Awaited<ReturnType<typeof request>>;
  try {
    winningEdit = await request("PATCH", `${base}/${job.id}`, {
      body: {
        name: "Winning concurrent OCC edit",
        enabled: false,
        expectedConfigRevision: current.configRevision,
      },
    });
  } finally {
    releaseUpdate();
  }
  assert.equal(winningEdit.status, 200, JSON.stringify(winningEdit.body));
  assert.equal(
    (await losingEdit).status,
    409,
    "native CAS must reject the already-read stale update",
  );
  current = winningEdit.data as AgentAutomationData;
  assert.deepEqual((await request("GET", `${base}/${job.id}`)).data, current);
  assert.equal(
    (
      await request(
        "DELETE",
        `${base}/${job.id}?expectedConfigRevision=${encodeURIComponent(job.configRevision)}`,
      )
    ).status,
    409,
  );

  // A different human can operate the Agent but cannot see or remove this creator's record.
  const guest = f.provisionedAccounts[0];
  assert.ok(guest);
  const iam = `/namespaces/${namespace.id}/iam`;
  const operatorRole = await request("POST", `${iam}/roles`, {
    body: {
      name: "Automation operator",
      permissions: [{ action: "operate", resourceKind: "agent" }],
    },
  });
  assert.equal(operatorRole.status, 201);
  const operatorBinding = await request("POST", `${iam}/access-bindings`, {
    body: {
      subjectKind: "identity",
      subjectId: guest.principal.id,
      roleId: operatorRole.data.id,
      resourceKind: "agent",
      resourceId: agent.id,
    },
  });
  assert.equal(operatorBinding.status, 201);
  const guestSession = await f.signIn(guest.credentials);
  assert.equal((await request("GET", `${base}/${job.id}`, { session: guestSession })).status, 404);
  assert.equal(
    (
      await request(
        "DELETE",
        `${base}/${job.id}?expectedConfigRevision=${encodeURIComponent(current.configRevision)}`,
        { session: guestSession },
      )
    ).status,
    404,
  );
  const guestList = await request("GET", base, { session: guestSession });
  assert.equal(guestList.status, 200);
  assert.deepEqual(guestList.data.jobs, []);
  assert.equal(guestList.data.total, 0);

  // Grant and revoke administration through real HTTP IAM operations while a
  // list holds its all-creator result. Demotion must not disclose that stale view.
  const role = await request("POST", `${iam}/roles`, {
    body: {
      name: "Automation race administrator",
      permissions: [{ action: "administer", resourceKind: "agent" }],
    },
  });
  assert.equal(role.status, 201);
  const binding = await request("POST", `${iam}/access-bindings`, {
    body: {
      subjectKind: "identity",
      subjectId: guest.principal.id,
      roleId: role.data.id,
      resourceKind: "agent",
      resourceId: agent.id,
    },
  });
  assert.equal(binding.status, 201);
  const adminView = await request("GET", `${base}?limit=1`, { session: guestSession });
  assert.equal(adminView.status, 200);
  assert.equal(adminView.data.total, 4);
  assert.equal(adminView.data.jobs.length, 1);
  holdOwnershipList = true;
  const demotedList = request("GET", `${base}?limit=1`, { session: guestSession });
  const timer = setTimeout(
    () => ownershipCaptured.reject(new Error("ownership read barrier timed out")),
    10_000,
  );
  try {
    await ownershipCaptured.promise;
    const revoked = await request("DELETE", `${iam}/access-bindings/${binding.data.id}`);
    assert.equal(revoked.status, 204);
  } finally {
    clearTimeout(timer);
    ownershipReleased.resolve();
  }
  const afterDemotion = await demotedList;
  assert.equal(afterDemotion.status, 200);
  assert.deepEqual(afterDemotion.data.jobs, [], "demoted administrator must not see foreign jobs");
  assert.equal(afterDemotion.data.total, 0);
  assert.equal(afterDemotion.data.nextOffset, null);
  assert.equal(afterDemotion.data.snapshotRevision, guestList.data.snapshotRevision);

  // Lose a real OCC create reply after native commit. It must remain disabled,
  // recover through its reservation and never replay or activate during reads.
  const createsBeforeRecovery = nativeCreateRequests;
  const updatesBeforeRecovery = nativeUpdates;
  loseCreateReply = true;
  const lostCreate = await request("POST", base, {
    body: { ...input, name: "Lost create reply", enabled: true },
  });
  assert.equal(lostCreate.status, 503);
  assert.equal(lostCreate.body.error.code, "UNKNOWN_OUTCOME");
  assert.equal(nativeCreateRequests, createsBeforeRecovery + 1);
  const recovered = (await request("GET", base)).data.jobs.find(
    (entry: { name: string }) => entry.name === "Lost create reply",
  );
  assert.ok(recovered);
  assert.equal(recovered.enabled, false);
  assert.equal(lostCreate.headers.get("location"), `${base}/${recovered.id}`);
  assert.equal(
    nativeUpdates,
    updatesBeforeRecovery,
    "read recovery must not enable or rewrite jobs",
  );
  assert.equal("prompt" in recovered, false);
  await storedModelOnly(recovered.id);

  const beforeLost = nativeUpdates;
  loseUpdateReply = true;
  const lost = await request("PATCH", `${base}/${job.id}`, {
    body: {
      enabled: false,
      name: "Lost pause reply",
      expectedConfigRevision: current.configRevision,
    },
  });
  assert.equal(lost.status, 503);
  assert.equal(lost.body.error.code, "UNKNOWN_OUTCOME");
  assert.equal(lost.headers.get("location"), `${base}/${job.id}`);
  assert.equal(nativeUpdates, beforeLost + 1, "lost pause reply must not replay the mutation");
  current = (await request("GET", `${base}/${job.id}`)).data;
  assert.equal(current.name, "Lost pause reply");
  assert.equal(current.enabled, false);

  auditSink.failSuccess = true;
  const beforeAudit = nativeUpdates;
  const uncertain = await request("PATCH", `${base}/${job.id}`, {
    body: { enabled: false, name: "Audit failure", expectedConfigRevision: current.configRevision },
  });
  assert.equal(uncertain.status, 503);
  assert.equal(uncertain.body.error.code, "UNKNOWN_OUTCOME");
  assert.equal(nativeUpdates, beforeAudit + 1);
  current = (await request("GET", `${base}/${job.id}`)).data;
  assert.equal(current.name, "Audit failure");

  // Change the OCC revision after a real native pause commit and before its reply.
  afterUpdate = async () => {
    const next = await deployAndWait();
    revision = next;
  };
  const beforeRevision = nativeUpdates;
  const replaced = await request("PATCH", `${base}/${job.id}`, {
    body: {
      enabled: false,
      name: "Revision changed",
      expectedConfigRevision: current.configRevision,
    },
  });
  assert.equal(replaced.status, 503);
  assert.equal(replaced.body.error.code, "UNKNOWN_OUTCOME");
  assert.equal(nativeUpdates, beforeRevision + 1);
  current = (await request("GET", `${base}/${job.id}`)).data;
  assert.equal(current.name, "Revision changed");

  // Replace the real Gateway process and container, retaining its named state volume.
  // OCC and Compute remain fixtures: this proves native persistence and broker identity,
  // not PostgreSQL-backed OCC restart or the production Kubernetes cutover workflow.
  const ownershipBefore = await f.controller.getAgentAutomationOwnership(
    f.principal.id,
    namespace.id,
    agent.id,
    job.id,
  );
  assert.ok(ownershipBefore.record.nativeJobId);
  const previousContainerId = (
    await runDocker(["inspect", "--format", "{{.Id}}", nativeContainer])
  ).stdout.trim();
  const previousRevisionId = revision.id;
  const createsBeforeReplacement = nativeCreateRequests;
  const updatesBeforeReplacement = nativeUpdates;
  const callsBeforeReplacement = await runDocker([
    "exec",
    nativeContainer,
    "node",
    "-e",
    'fetch("http://127.0.0.1:18880/counter").then(r=>r.json()).then(v=>console.log(v.modelCalls));',
  ]);
  assert.equal(callsBeforeReplacement.stdout.trim(), "0");
  observer.stop();
  await observer.stopAndWait({ timeoutMs: 1000 });
  await runDocker(["stop", "--time", "30", nativeContainer]);
  await runDocker(["rm", "--volumes", nativeContainer]);
  await runDocker(replacementArguments);
  const replacementContainerId = (
    await runDocker(["inspect", "--format", "{{.Id}}", nativeContainer])
  ).stdout.trim();
  assert.notEqual(
    replacementContainerId,
    previousContainerId,
    "the Gateway must be a new container",
  );
  await waitForContainerReady(nativeContainer, {
    label: "Replacement native Gateway",
    request:
      '() => fetch("http://127.0.0.1:18800/readyz",{signal:AbortSignal.timeout(5000)}).then(r=>r.status)',
    timeoutMs: cpuScaledImageTimeoutMs(75_000),
  });
  observer = await openObserver();
  assert.equal((await observer.request<{ enabled: boolean }>("cron.status", {})).enabled, true);
  const replacementRevision = await deployAndWait();
  revision = replacementRevision;
  assert.notEqual(revision.id, previousRevisionId);
  const retained = await request("GET", `${base}/${job.id}`);
  assert.equal(retained.status, 200, JSON.stringify(retained.body));
  assert.deepEqual(retained.data, current, "paused job and native revision survive replacement");
  assert.equal(retained.data.enabled, false);
  await storedModelOnly(job.id);
  assert.deepEqual(
    (await f.controller.getAgentAutomationOwnership(f.principal.id, namespace.id, agent.id, job.id))
      .record,
    ownershipBefore.record,
    "creator, public ID and bound native ID survive the physical Gateway replacement",
  );
  assert.equal(
    nativeCreateRequests,
    createsBeforeReplacement,
    "replacement must not recreate jobs",
  );
  assert.equal(
    nativeUpdates,
    updatesBeforeReplacement,
    "replacement must not rewrite or activate jobs",
  );

  // Enabled far-future model-only work survives too; its atomic disabling edit
  // must preserve the cap without changing ordinary native scheduling.
  const callsAfterReplacement = await runDocker([
    "exec",
    nativeContainer,
    "node",
    "-e",
    'fetch("http://127.0.0.1:18880/counter").then(r=>r.json()).then(v=>console.log(v.modelCalls));',
  ]);
  assert.equal(callsAfterReplacement.stdout.trim(), "0");
  const queued = await request("GET", `${base}/${retainedEnabled.id}`);
  assert.equal(queued.status, 200);
  assert.equal(queued.data.enabled, true);
  const pausedQueued = await request("PATCH", `${base}/${retainedEnabled.id}`, {
    body: {
      enabled: false,
      name: "Paused retained queue",
      expectedConfigRevision: queued.data.configRevision,
    },
  });
  assert.equal(pausedQueued.status, 200);
  assert.equal(pausedQueued.data.enabled, false);
  await storedModelOnly(retainedEnabled.id);
  assert.ok(
    verifiedActivations >= 3,
    "creation and resume verified durable binding before activation",
  );

  // Model one explicitly trusted writer changing this disposable, paused job.
  // This is outside-contract fixture mutation, not a supported native-edit flow
  // or a tamper-resistance claim. OCC must not activate/adopt the widened cap.
  const beforeExternalWrite = await storedModelOnly(job.id);
  const outside = await observer.request<{
    configRevision: string;
    enabled: boolean;
    payload: { toolsAllow: unknown };
  }>("cron.update", {
    id: beforeExternalWrite.record.nativeJobId,
    expectedConfigRevision: beforeExternalWrite.stored.configRevision,
    patch: {
      enabled: false,
      payload: { kind: "agentTurn", message: current.prompt, toolsAllow: ["*"] },
    },
  });
  assert.equal(outside.enabled, false);
  assert.deepEqual(outside.payload.toolsAllow, ["*"]);
  const updatesBeforeUnsupported = nativeUpdates;
  assert.equal((await request("GET", `${base}/${job.id}`)).status, 409);
  for (const patch of [{ enabled: true }, { prompt: "Do not adopt a widened cap" }]) {
    const refused = await request("PATCH", `${base}/${job.id}`, {
      body: { ...patch, expectedConfigRevision: outside.configRevision },
    });
    assert.equal(refused.status, 409);
  }
  assert.equal(nativeUpdates, updatesBeforeUnsupported);
  const unchangedOutside = await observer.request<{ payload: { toolsAllow: unknown } }>(
    "cron.get",
    { id: beforeExternalWrite.record.nativeJobId },
  );
  assert.deepEqual(
    unchangedOutside.payload.toolsAllow,
    ["*"],
    "OCC does not reconcile trusted writers",
  );

  const all = (await request("GET", base)).data.jobs as AgentAutomationData[];
  assert.equal(all.length, 5);
  for (const entry of all) {
    assert.equal(
      (
        await request(
          "DELETE",
          `${base}/${entry.id}?expectedConfigRevision=${encodeURIComponent(entry.configRevision)}`,
        )
      ).status,
      204,
    );
    assert.equal((await request("GET", `${base}/${entry.id}`)).status, 404);
    const history = await request("GET", `${base}/${entry.id}/runs`);
    assert.equal(
      history.status,
      404,
      "a deleted job that never ran has no retained native history",
    );
  }
  assert.ok(auditSink.events.filter((event) => event.action.endsWith(".unknown")).length >= 3);
  assert.equal(JSON.stringify(auditSink.events).includes(input.prompt), false);
} finally {
  await worker?.stop();
  for (const cleanup of cleanups) {
    await cleanup();
  }
  for (const peer of peers) {
    peer.terminate();
  }
  await new Promise<void>((resolve) => sockets.close(resolve));
  await new Promise<void>((resolve, reject) =>
    proxy.close((error) => (error ? reject(error) : resolve())),
  );
  await platformPool.end();
}
process.stdout.write(
  "OCC_AUTOMATION_PROTOCOL_PROOF " +
    JSON.stringify({
      automationProtocol: true,
      nativeCreateRequests,
      modelOnlyWrites: true,
      modelOnlyReadback: true,
      clientToolPolicyRefused: true,
      rejectedCreateCleanup: true,
      bindingBeforeActivation: true,
      unsupportedCapsRefused: true,
      adminDemotionProtected: true,
      nativeSchedulerUnchanged: true,
      retainedEnabledJobPaused: true,
      concurrentNativeCas: true,
      physicalGatewayReplacement: true,
      pausedJobRetained: true,
      ownershipStorage: "postgresql",
      modelExecution: false,
    }) +
    "\n",
);
