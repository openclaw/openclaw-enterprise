import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

type PeerParams = {
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  threadId?: string | null;
  input?: { type?: string | null; text?: string | null }[];
};
type PeerRequest = { id: string | number; method: string; params: PeerParams };
type PeerSocket = {
  on(event: "message", listener: (bytes: { toString(): string }) => void): void;
  send(data: string): void;
  terminate(): void;
};
type PeerServer = {
  clients: Set<PeerSocket>;
  once(event: "listening", listener: () => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  on(event: "connection", listener: (socket: PeerSocket, request: IncomingMessage) => void): void;
  close(callback: () => void): void;
};
type WebSocketModule = {
  WebSocketServer: new (options: { host: string; port: number }) => PeerServer;
};
type Scenario = { agentId: string; cwd: string; model: string };
type GatewayRuntime = {
  callGatewayFromCli(
    method: string,
    options: { url: string; password: string | undefined; timeout: string },
    params: { key: string; agentId: string } | { runId: string; timeoutMs: number },
  ): Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  assert.ok(typeof value === "string", `${label} must be a string`);
  return value;
}

function requireNullableString(
  value: unknown,
  label: string,
): asserts value is string | null | undefined {
  assert.ok(
    value == null || typeof value === "string",
    `${label} must be a string or null when present`,
  );
}

function requirePeerRequest(value: unknown): PeerRequest | undefined {
  const message = requireRecord(value, "peer request");
  if (message.id === undefined) {
    return undefined;
  }
  assert.ok(
    typeof message.id === "string" || typeof message.id === "number",
    "peer request ID must be a string or number",
  );
  const method = requireString(message.method, "peer request method");
  const params =
    message.params === undefined ? {} : requireRecord(message.params, "peer request params");
  for (const field of ["cwd", "model", "modelProvider", "threadId"]) {
    requireNullableString(params[field], `peer request ${field}`);
  }
  if (params.input !== undefined) {
    assert.ok(Array.isArray(params.input), "peer request input must be an array");
    const input: readonly unknown[] = params.input;
    for (const value of input) {
      const item = requireRecord(value, "peer request input item");
      requireNullableString(item.type, "peer request input type");
      requireNullableString(item.text, "peer request input text");
    }
  }
  return { id: message.id, method, params };
}

function requireGatewayRuntime(value: unknown): asserts value is GatewayRuntime {
  const runtime = requireRecord(value, "Gateway runtime module");
  assert.equal(
    typeof runtime.callGatewayFromCli,
    "function",
    "Gateway runtime must export callGatewayFromCli",
  );
}

function requireWebSocketModule(value: unknown): asserts value is WebSocketModule {
  assert.ok(
    typeof value === "function" || isRecord(value),
    "WebSocket module must be an object or function",
  );
  assert.equal(
    typeof Reflect.get(value, "WebSocketServer"),
    "function",
    "WebSocket module must export WebSocketServer",
  );
}

const require = createRequire("/app/package.json");
const webSocketModule: unknown = require("ws");
requireWebSocketModule(webSocketModule);
const { WebSocketServer } = webSocketModule;
const gatewayRuntime: unknown = await import(
  pathToFileURL(require.resolve("openclaw/plugin-sdk/gateway-runtime")).href
);
requireGatewayRuntime(gatewayRuntime);
const { callGatewayFromCli } = gatewayRuntime;
const rawCases: unknown = JSON.parse(
  requireString(process.env.OCC_TEST_SUBAGENT_CASES, "subagent cases"),
);
assert.ok(Array.isArray(rawCases), "subagent cases must be an array");
const cases: Scenario[] = rawCases.map((value: unknown) => {
  const scenario = requireRecord(value, "subagent case");
  return {
    agentId: requireString(scenario.agentId, "subagent agent ID"),
    cwd: requireString(scenario.cwd, "subagent workspace"),
    model: requireString(scenario.model, "subagent model"),
  };
});
const rawModels: unknown = JSON.parse(
  requireString(process.env.OCC_TEST_SUBAGENT_MODELS, "subagent models"),
);
assert.ok(Array.isArray(rawModels), "subagent models must be an array");
const nativeModels = rawModels.map((value: unknown) => requireString(value, "native model"));
const provenance = requireRecord(
  JSON.parse(await readFile("/opt/oce/runtime/provenance.json", "utf8")),
  "runtime provenance",
);
assert.equal(provenance.commit, process.env.OCC_TEST_OPENCLAW_COMMIT);
const codexVersion = requireString(
  requireRecord(provenance.codex, "Codex provenance").version,
  "Codex version",
);

// Only the external Codex peer is a fixture. The packaged Gateway performs real
// sessions_spawn admission, model preparation, child dispatch and native model resolution.
// The peer rejects turn/start before accepting inference: no Codex process or external egress.
const requests: PeerRequest[] = [];
const threadStarts = new Map<string, PeerRequest>();
const unloadedThreads = new Set<string>();
let unsupportedMethod: string | undefined;
const server = new WebSocketServer({ host: "127.0.0.1", port: 4500 });
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
// Mirror the pinned OC peer fixture; echo the requested selection without choosing its owner.
function threadStartResult(threadId: string, { cwd, model, modelProvider }: PeerParams) {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider,
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd,
      projectId: null,
      cliVersion: codexVersion,
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model,
    modelProvider,
    serviceTier: null,
    cwd,
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

server.on("connection", (socket, request) => {
  assert.equal(request.headers.authorization, `Bearer ${process.env.APP_SERVER_TOKEN}`);
  socket.on("message", (bytes) => {
    const message = requirePeerRequest(JSON.parse(bytes.toString()));
    if (!message) {
      return;
    }
    requests.push(message);
    const reply = (result: object) => socket.send(JSON.stringify({ id: message.id, result }));
    switch (message.method) {
      case "initialize":
        reply({ userAgent: "codex-cli/0.160.0", codexHome: "/home/node/.codex" });
        break;
      case "account/read":
        reply({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
        break;
      case "config/read":
        reply({ config: {}, origins: {}, layers: [] });
        break;
      case "configRequirements/read":
        reply({ requirements: null });
        break;
      case "model/list":
        reply({
          data: nativeModels.map((id) => ({
            id,
            model: id,
            displayName: id,
            description: "Synthetic native routing fixture",
            hidden: false,
            isDefault: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
            inputModalities: ["text"],
          })),
          nextCursor: null,
        });
        break;
      case "skills/list":
      case "thread/list":
      case "mcpServerStatus/list":
        reply({ data: [], nextCursor: null });
        break;
      case "thread/start": {
        const threadId = randomUUID();
        threadStarts.set(threadId, message);
        reply(threadStartResult(threadId, message.params));
        break;
      }
      case "thread/read": {
        const threadId = requireString(message.params.threadId, "peer request thread ID");
        const started = threadStarts.get(threadId);
        assert.ok(started, "The fixture only reads its assigned native threads.");
        const { thread } = threadStartResult(threadId, started.params);
        reply({
          thread: {
            ...thread,
            status: { type: unloadedThreads.has(threadId) ? "notLoaded" : "idle" },
          },
        });
        break;
      }
      case "thread/unsubscribe": {
        const threadId = requireString(message.params.threadId, "peer request thread ID");
        assert.ok(
          threadStarts.has(threadId),
          "The fixture only unloads its assigned native threads.",
        );
        unloadedThreads.add(threadId);
        reply({});
        socket.send(
          JSON.stringify({
            method: "thread/status/changed",
            params: { threadId, status: { type: "notLoaded" } },
          }),
        );
        break;
      }
      case "thread/resume": {
        const threadId = requireString(message.params.threadId, "peer request thread ID");
        const started = threadStarts.get(threadId);
        assert.ok(started, "The fixture only resumes its assigned native threads.");
        unloadedThreads.delete(threadId);
        // Fallback changes current settings, not the recorded primary request used by the oracle.
        reply(threadStartResult(threadId, { ...started.params, ...message.params }));
        break;
      }
      case "thread/inject_items":
        assert.ok(
          threadStarts.has(requireString(message.params.threadId, "peer request thread ID")),
          "The fixture only updates its assigned native threads.",
        );
        reply({});
        break;
      case "turn/start":
        assert.ok(
          threadStarts.has(requireString(message.params.threadId, "peer request thread ID")),
          "A native turn must own a fixture thread.",
        );
        socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32602, message: "Routing fixture stops before native inference." },
          }),
        );
        break;
      default:
        unsupportedMethod = message.method;
        socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32601, message: `Unsupported fixture method: ${message.method}` },
          }),
        );
    }
  });
});

// The deadline is checked after each read, so the last read happens at or past it.
async function waitFor<T>(description: string, read: () => T | Promise<T>) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    assert.equal(
      unsupportedMethod,
      undefined,
      "The native peer requested an unsupported fixture method.",
    );
    const value = await read();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await delay(100);
  }
  const models = requests
    .filter(({ method }) => method === "thread/start")
    .map(({ params }) => params?.model);
  throw new Error(
    `Timed out waiting for ${description}; methods=${requests.map(({ method }) => method).join(",")}; thread/start models=${JSON.stringify(models)}`,
  );
}

try {
  await waitFor("Gateway readiness", async () => {
    try {
      return (await fetch("http://127.0.0.1:8080/readyz")).ok;
    } catch {
      return false;
    }
  });
  const configuration = requireRecord(
    JSON.parse(await readFile("/home/node/.openclaw/openclaw.json", "utf8")),
    "Gateway configuration",
  );
  const agents = requireRecord(configuration.agents, "Gateway agents");
  const entries = requireRecord(agents.entries, "Gateway Agent entries");
  const observed = [];
  for (const scenario of cases) {
    assert.equal(
      requireRecord(entries[scenario.agentId], "Gateway Agent entry").workspace,
      `/home/node/workspace/${scenario.agentId}`,
      "The Gateway keeps its Agent workspace on its own writable filesystem.",
    );
    const parentKey = `agent:${scenario.agentId}:routing-parent`;
    await callGatewayFromCli(
      "sessions.create",
      {
        url: "ws://127.0.0.1:8080",
        password: process.env.OPENCLAW_GATEWAY_PASSWORD,
        timeout: "90000",
      },
      { key: parentKey, agentId: scenario.agentId },
    );
    const offset = requests.length;
    const response = await fetch("http://127.0.0.1:8080/tools/invoke", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENCLAW_GATEWAY_PASSWORD}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tool: "sessions_spawn",
        sessionKey: parentKey,
        args: {
          agentId: scenario.agentId,
          task: "Verify native model routing without running any tools.",
          mode: "run",
          context: "isolated",
          runTimeoutSeconds: 30,
        },
      }),
    });
    const result = requireRecord(await response.json(), "spawn response");
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true, JSON.stringify(result));
    const receipt = requireRecord(
      requireRecord(result.result, "spawn result").details,
      "spawn receipt",
    );
    assert.equal(receipt.status, "accepted", JSON.stringify(result));
    const childSessionKey = requireString(receipt.childSessionKey, "child session key");
    const runId = requireString(receipt.runId, "spawn run ID");
    // Child identity is in the task input, outside the shared thread instructions.
    // Match that exact child turn before inspecting its peer-assigned thread's selection:
    // neither the shared cwd nor the alias model can distinguish it from a parent turn.
    const childMarker = `- Your session: ${childSessionKey}.`;
    const ownedByChild = ({ params }: PeerRequest) =>
      Array.isArray(params?.input) &&
      params.input.some(
        (item) =>
          item.type === "text" && typeof item.text === "string" && item.text.includes(childMarker),
      );
    const nativeStarts = () =>
      requests
        .slice(offset)
        .filter(({ method }) => method === "thread/start")
        .map(({ params }) => ({ model: params?.model, cwd: params?.cwd }));
    const childTurn = await waitFor(`native turn/start whose input names ${childSessionKey}`, () =>
      requests
        .slice(offset)
        .find((request) => request.method === "turn/start" && ownedByChild(request)),
    );
    const native = threadStarts.get(
      requireString(childTurn.params.threadId, "child turn thread ID"),
    );
    assert.ok(
      native && requests.slice(offset).includes(native),
      "The exact child turn must use a native thread created during this spawn.",
    );
    assert.equal(native.params.cwd, scenario.cwd, "Native execution uses the Harness workspace.");
    assert.deepEqual(
      { modelProvider: native.params.modelProvider, model: native.params.model },
      { modelProvider: "openai-compatible", model: scenario.model },
      `${scenario.agentId} thread/starts since its spawn: ${JSON.stringify(nativeStarts())}`,
    );
    assert.equal(childTurn.params.model ?? native.params.model, scenario.model);
    assert.equal(childTurn.params.cwd ?? native.params.cwd, scenario.cwd);
    // Settle this run, including its configured fallbacks, before the next case.
    const completed = requireRecord(
      await callGatewayFromCli(
        "agent.wait",
        {
          url: "ws://127.0.0.1:8080",
          password: process.env.OPENCLAW_GATEWAY_PASSWORD,
          timeout: "45000",
        },
        { runId, timeoutMs: 30000 },
      ),
      "agent wait response",
    );
    assert.equal(completed.runId, runId);
    assert.equal(completed.status, "error", JSON.stringify(completed));
    assert.notEqual(completed.pendingError, true);
    assert.equal(typeof completed.endedAt, "number");
    observed.push({
      agentId: scenario.agentId,
      childSessionKey,
      nativeThreadId: childTurn.params.threadId,
      modelProvider: native.params.modelProvider,
      model: native.params.model,
      cwd: native.params.cwd,
      terminalStatus: completed.status,
    });
  }
  assert.equal(
    unsupportedMethod,
    undefined,
    "The native peer requested an unsupported fixture method.",
  );
  console.log(JSON.stringify({ commit: provenance.commit, observed }));
} finally {
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
