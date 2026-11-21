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
import { InMemoryAuditSink } from "../../../packages/audit/src/index.ts";
import type {
  AuditEvent,
  AgentAutomationData,
  AgentAutomationOwnership,
} from "../../../packages/contracts/src/index.ts";
import { createAgentAutomationsAccess } from "../../../apps/controller/src/composition/agent-automations.ts";
import { prepareNativeAdminConfiguration } from "../../../apps/controller/src/gateway/native-admin.ts";
import { createConsoleAppFixture } from "../../helpers/console-app.mjs";
import { createReadyComputeDriver } from "../../helpers/development.ts";
import { createHarnessConfiguration } from "../../helpers/harness-configuration.mjs";
import { grantRole } from "../../helpers/iam-grants.ts";

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
assert.ok(nativeContainer);
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
let verifiedBindingBeforeActivation = false;
let beforeActivation: undefined | ((id: string) => Promise<void>);
const nativeErrors: string[] = [];
let loseCreateReply = false;
let afterCreate: undefined | (() => Promise<void>);
proxy.on("upgrade", (request, socket, head) => {
  sockets.handleUpgrade(request, socket, head, (downstream) => {
    const upstream = new websocket.WebSocket(endpoint, { headers: { "x-api-key": apiKey } });
    peers.add(downstream);
    peers.add(upstream);
    const queue: Buffer[] = [];
    const creating = new Set<string>();
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
      }
      if (
        frame.method === "cron.update" &&
        frame.params?.patch?.enabled === true &&
        frame.params.id
      ) {
        void beforeActivation?.(frame.params.id)
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
        if (frame.type === "res" && frame.ok === false && nativeErrors.length < 3) {
          nativeErrors.push(String(frame.error?.message).slice(0, 300));
        }
        if (frame.type === "res" && frame.id && frame.ok && creating.delete(frame.id)) {
          if (loseCreateReply) {
            loseCreateReply = false;
            downstream.terminate();
            upstream.terminate();
            return;
          }
          const action = afterCreate;
          afterCreate = undefined;
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
    if (this.failSuccess && event.action === "openclaw.agents.automations.create.success") {
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
  beforeActivation = async (nativeJobId) => {
    const records = await f.controller.listAgentAutomationOwnership(
      f.principal.id,
      namespace.id,
      agent.id,
    );
    assert.ok(
      records.some((entry: AgentAutomationOwnership) => entry.nativeJobId === nativeJobId),
      "native activation requires a committed OCC binding",
    );
    verifiedBindingBeforeActivation = true;
  };
  const input = {
    name: "Inactive protocol job",
    enabled: false,
    schedule: { kind: "every", everyMs: 60_000 },
    prompt: "This job must not execute during protocol proof.",
  };
  const created = await request("POST", base, { body: input });
  assert.equal(created.status, 201, JSON.stringify({ response: created.body, nativeErrors }));
  const job = created.data as AgentAutomationData;
  for (const schedule of [
    { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
    { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
  ]) {
    const response = await request("POST", base, {
      body: {
        ...input,
        name: `Protocol ${schedule.kind}`,
        schedule,
        enabled: schedule.kind === "at",
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.data.schedule.kind, schedule.kind);
    assert.equal(
      (await request("GET", `${base}/${response.data.id}`)).data.configRevision,
      response.data.configRevision,
    );
  }

  assert.equal(job.schedule.kind, "every");
  assert.ok("anchorMs" in job.schedule && Number.isSafeInteger(job.schedule.anchorMs));
  const changed = await request("PATCH", `${base}/${job.id}`, {
    body: { name: "Updated through OCC", expectedConfigRevision: job.configRevision },
  });
  assert.equal(changed.status, 200);
  const current = changed.data as AgentAutomationData;
  assert.notEqual(current.configRevision, job.configRevision);
  assert.equal(
    (
      await request("PATCH", `${base}/${job.id}`, {
        body: { enabled: false, expectedConfigRevision: job.configRevision },
      })
    ).status,
    409,
  );
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

  const beforeLost = nativeCreates;
  const updatesBeforeLost = nativeUpdates;
  loseCreateReply = true;
  const lost = await request("POST", base, {
    body: { ...input, name: "Lost reply", enabled: true },
  });
  assert.equal(lost.status, 503);
  assert.equal(lost.body.error.code, "UNKNOWN_OUTCOME");
  assert.equal(nativeCreates, beforeLost + 1, "a lost reply must not replay native create");
  const inventory = await request("GET", base);
  const recovered = inventory.data.jobs.find(
    (entry: { name: string }) => entry.name === "Lost reply",
  );
  assert.ok(recovered, "the reservation retained before dispatch authorizes discovery");
  assert.equal(recovered.enabled, false, "lost creation cannot activate before binding");
  assert.equal(nativeUpdates, updatesBeforeLost, "read recovery must not replay or enable the job");
  assert.equal(lost.headers.get("location"), `${base}/${recovered.id}`);
  assert.equal("prompt" in recovered, false);

  auditSink.failSuccess = true;
  const beforeAudit = nativeCreates;
  const uncertain = await request("POST", base, { body: { ...input, name: "Audit failure" } });
  assert.equal(uncertain.status, 503);
  assert.equal(uncertain.body.error.code, "UNKNOWN_OUTCOME");
  assert.equal(nativeCreates, beforeAudit + 1);
  assert.ok(
    (await request("GET", base)).data.jobs.some(
      (entry: { name: string }) => entry.name === "Audit failure",
    ),
  );

  // Change the actual OCC revision after native commit and before forwarding its reply.
  // This tests revision fencing, not a physical Gateway replacement (the QA scenario owns that).
  afterCreate = async () => {
    const next = await f.deployAgent(namespace.id, agent.id);
    await f.activateRevision(namespace.id, agent.id, next.id, revision.id);
    revision = next;
  };
  const beforeRevision = nativeCreates;
  const replaced = await request("POST", base, { body: { ...input, name: "Revision changed" } });
  assert.equal(replaced.status, 503);
  assert.equal(replaced.body.error.code, "UNKNOWN_OUTCOME");
  assert.equal(nativeCreates, beforeRevision + 1);

  const all = (await request("GET", base)).data.jobs as AgentAutomationData[];
  assert.equal(all.length, 6);
  assert.ok(verifiedBindingBeforeActivation);
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
    JSON.stringify({ automationProtocol: true, nativeCreates, modelExecution: false }) +
    "\n",
);
