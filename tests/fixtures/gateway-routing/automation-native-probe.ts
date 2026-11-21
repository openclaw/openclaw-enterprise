import { authenticatedHeaders } from "../../helpers/auth-session.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { AuditEventFactory, InMemoryAuditSink } from "../../../packages/audit/src/index.ts";
import type {
  AuditEvent,
  AgentAutomationData,
  AgentAutomationCreateInput,
  AgentAutomationOwnership,
} from "../../../packages/contracts/src/index.ts";
import { createAgentAutomationsAccess } from "../../../apps/controller/src/composition/agent-automations.ts";
import { prepareNativeAdminConfiguration } from "../../../apps/controller/src/gateway/native-admin.ts";
import { createConsoleAppFixture } from "../../helpers/console-app.mjs";
import { createReadyComputeDriver } from "../../helpers/development.ts";
import { createHarnessConfiguration } from "../../helpers/harness-configuration.mjs";
import { grantRole } from "../../helpers/iam-grants.ts";
import { runDocker } from "../../helpers/runtime-image-docker.ts";
import { waitForContainerReady } from "../../helpers/runtime-image-gateway-observations.ts";
import { GatewayClient } from "../../../apps/controller/tests/fixtures/plugin-approval-client.ts";
import { cpuScaledImageTimeoutMs } from "../../helpers/image-smoke-timeout.ts";

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
assert.ok(nativeContainer && replacementArgumentsPath);
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
let nativeCreates = 0;
let nativeUpdates = 0;
let beforeUpdate: undefined | (() => Promise<void>);
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
        params?: { id?: string; enabled?: boolean; patch?: { enabled?: boolean } };
      };
      if (frame.type === "req" && frame.method === "cron.add" && frame.id) {
        nativeCreates++;
        assert.equal(
          frame.params?.enabled,
          false,
          "native creation remains disabled until binding",
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
        if (frame.id) {
          updating.add(frame.id);
        }
        const action = beforeUpdate;
        beforeUpdate = undefined;
        void (async () => {
          await action?.();
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
const compute = createReadyComputeDriver("automation-native-probe", {
  implementation: "native-protocol-proof",
  supportsGatewayManagedMode: undefined,
  validateHarnessAuth() {},
  getGatewayEndpoint: () => `wss://127.0.0.1:${address.port}`,
  async getRuntimeImages() {
    const execute = promisify(execFile);
    const container = JSON.parse((await execute("docker", ["inspect", nativeContainer])).stdout)[0];
    const image = JSON.parse(
      (await execute("docker", ["image", "inspect", container.Image])).stdout,
    )[0];
    return [
      {
        workload: nativeContainer,
        container: "gateway",
        image: container.Config.Image,
        imageId: container.Image,
        commit: image.Config.Labels?.["org.opencontainers.image.revision"] || null,
        openclawCommit: image.Config.Labels?.["org.openclaw.image.revision"] || null,
      },
    ];
  },
});
const publicOrigin = "https://console.oce.example.test";
try {
  const f = await createConsoleAppFixture(scope, {
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
  await f.bootstrap("Native automation protocol");
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
  let revision = await f.deployAgent(namespace.id, agent.id);
  await f.activateRevision(namespace.id, agent.id, revision.id);
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
  // Read-only native observation proves the narrow API gate does not disable
  // ordinary native scheduling. This fixture never qualifies scheduled execution.
  const connected = Promise.withResolvers<void>();
  const observer = new GatewayClient({
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
  cleanups.push(async () => {
    observer.stop();
    await observer.stopAndWait({ timeoutMs: 1000 });
  });
  observer.start();
  await connected.promise;
  assert.equal((await observer.request<{ enabled: boolean }>("cron.status", {})).enabled, true);
  const input: AgentAutomationCreateInput = {
    name: "Retained operator job",
    enabled: false,
    schedule: { kind: "every", everyMs: 86_400_000 },
    prompt: "This job must not execute during protocol proof.",
  };
  for (const enabled of [false, true]) {
    const refused = await request("POST", base, { body: { ...input, enabled } });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, "AUTOMATIONS_UNQUALIFIED");
  }
  assert.equal(nativeCreates, 0, "unqualified HTTP create must never reach native dispatch");
  assert.deepEqual(
    await f.controller.listAgentAutomationOwnership(f.principal.id, namespace.id, agent.id),
    [],
  );

  // Seed retained pre-gate state through real OCC storage and the real native
  // adapter. This is fixture setup, never a qualification bypass or HTTP-create proof.
  const legacyRevisionId = revision.id;
  const legacy = await createAgentAutomationsAccess(compute, keyPath).open({
    revision,
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 120_000),
    assertCurrent: async () => {
      await f.controller.getOperableAgent(f.principal.id, namespace.id, agent.id);
      const selected = await f.controller.getBrowserAccessibleActiveAgentRevision(
        f.principal.id,
        namespace.id,
        agent.id,
      );
      assert.equal(selected.revision.id, legacyRevisionId);
    },
  });
  cleanups.push(() => legacy.close());
  const factory = new AuditEventFactory();
  const fixtureAudit = (record: Readonly<AgentAutomationOwnership>) =>
    factory.create({
      installationId: f.controller.installation.id,
      namespaceId: namespace.id,
      actorId: f.principal.id,
      kind: "mutation",
      action: "fixture.automation.retained",
      resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
      details: { jobId: record.id },
    });
  async function seedLegacy(value: AgentAutomationCreateInput, lost = false) {
    const record = await f.controller.reserveAgentAutomation(
      f.principal.id,
      {
        namespaceId: namespace.id,
        agentId: agent.id,
        revisionId: revision.id,
        nativeAgentId: legacy.nativeAgentId,
      },
      fixtureAudit,
    );
    if (lost) {
      loseCreateReply = true;
    }
    const created = await legacy.create(record.id, value);
    const bound = await f.controller.bindAgentAutomation(
      f.principal.id,
      {
        namespaceId: namespace.id,
        agentId: agent.id,
        id: record.id,
        nativeJobId: created.nativeJobId,
        requireOperate: true,
      },
      fixtureAudit,
    );
    if (value.enabled) {
      // Historical fixture setup only: current OCC routes and its update adapter
      // refuse activation. This retained fixture uses only far-future schedules.
      await observer.request("cron.update", {
        id: bound.nativeJobId,
        expectedConfigRevision: created.job.configRevision,
        patch: { enabled: true },
      });
    }
    return legacy.get(bound);
  }
  const job = await seedLegacy({ ...input, enabled: true });
  const heldCalls = await runDocker([
    "exec",
    nativeContainer,
    "node",
    "-e",
    'fetch("http://127.0.0.1:18880/counter").then(r=>r.json()).then(v=>console.log(v.modelCalls));',
  ]);
  assert.equal(
    heldCalls.stdout.trim(),
    "0",
    "far-future fixture jobs must not run during management proof",
  );
  for (const schedule of [
    { kind: "at" as const, at: new Date(Date.now() + 3_600_000).toISOString() },
    { kind: "cron" as const, expr: "0 9 * * *", tz: "UTC" },
  ]) {
    const retained = await seedLegacy({ ...input, schedule });
    assert.equal(
      (await request("GET", `${base}/${retained.id}`)).data.configRevision,
      retained.configRevision,
    );
  }
  const retainedEnabled = await seedLegacy({
    ...input,
    name: "Retained future job",
    enabled: true,
  });
  const updatesBeforeRefusal = nativeUpdates;
  for (const patch of [{ enabled: true }, { name: "Must explicitly pause" }]) {
    const refused = await request("PATCH", `${base}/${job.id}`, {
      body: { ...patch, expectedConfigRevision: job.configRevision },
    });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, "AUTOMATIONS_UNQUALIFIED");
  }
  assert.equal(nativeUpdates, updatesBeforeRefusal, "unsafe HTTP updates must not dispatch");

  assert.equal(job.schedule.kind, "every");
  assert.ok("anchorMs" in job.schedule && Number.isSafeInteger(job.schedule.anchorMs));
  const changed = await request("PATCH", `${base}/${job.id}`, {
    body: {
      name: "Updated through OCC",
      enabled: false,
      expectedConfigRevision: job.configRevision,
    },
  });
  assert.equal(changed.status, 200);
  let current = changed.data as AgentAutomationData;
  assert.notEqual(current.configRevision, job.configRevision);
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
  const guest = await f.createAccountWithPolicy(
    "automation-other-creator",
    (principal: { id: string }) => {
      grantRole(f.policy, principal.id, {
        id: `role-${randomUUID()}`,
        bindingId: `binding-${randomUUID()}`,
        namespaceId: namespace.id,
        permissions: { agent: ["operate"] },
        resource: { kind: "agent", id: agent.id },
      });
    },
  );
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

  // A retained pre-gate lost create remains discoverable and can bind once.
  const updatesBeforeRecovery = nativeUpdates;
  await assert.rejects(seedLegacy({ ...input, name: "Retained lost reply" }, true), {
    code: "unknown",
  });
  const recovered = (await request("GET", base)).data.jobs.find(
    (entry: { name: string }) => entry.name === "Retained lost reply",
  );
  assert.ok(recovered);
  assert.equal(recovered.enabled, false);
  assert.equal(
    nativeUpdates,
    updatesBeforeRecovery,
    "read recovery must not enable or rewrite jobs",
  );
  assert.equal("prompt" in recovered, false);

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
    const next = await f.deployAgent(namespace.id, agent.id);
    await f.activateRevision(namespace.id, agent.id, next.id, revision.id);
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
  const createsBeforeReplacement = nativeCreates;
  const updatesBeforeReplacement = nativeUpdates;
  const callsBeforeReplacement = await runDocker([
    "exec",
    nativeContainer,
    "node",
    "-e",
    'fetch("http://127.0.0.1:18880/counter").then(r=>r.json()).then(v=>console.log(v.modelCalls));',
  ]);
  assert.equal(callsBeforeReplacement.stdout.trim(), "0");
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
  const replacementRevision = await f.deployAgent(namespace.id, agent.id);
  await f.activateRevision(namespace.id, agent.id, replacementRevision.id, revision.id);
  revision = replacementRevision;
  assert.notEqual(revision.id, previousRevisionId);
  const retained = await request("GET", `${base}/${job.id}`);
  assert.equal(retained.status, 200, JSON.stringify(retained.body));
  assert.deepEqual(retained.data, current, "paused job and native revision survive replacement");
  assert.equal(retained.data.enabled, false);
  assert.deepEqual(
    (await f.controller.getAgentAutomationOwnership(f.principal.id, namespace.id, agent.id, job.id))
      .record,
    ownershipBefore.record,
    "creator, public ID and bound native ID survive the physical Gateway replacement",
  );
  assert.equal(nativeCreates, createsBeforeReplacement, "replacement must not recreate jobs");
  assert.equal(
    nativeUpdates,
    updatesBeforeReplacement,
    "replacement must not rewrite or activate jobs",
  );

  // An enabled far-future record survives on disk too. Its explicit atomic
  // disabling edit must remain available despite the execution qualification gate.
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
}
process.stdout.write(
  "OCC_AUTOMATION_PROTOCOL_PROOF " +
    JSON.stringify({
      automationProtocol: true,
      nativeCreates,
      executionQualified: false,
      unsafeDispatchBlocked: true,
      nativeSchedulerUnchanged: true,
      retainedEnabledJobPaused: true,
      legacyFixtureSetup: true,
      concurrentNativeCas: true,
      physicalGatewayReplacement: true,
      pausedJobRetained: true,
      ownershipStorage: "in-memory",
      modelExecution: false,
    }) +
    "\n",
);
