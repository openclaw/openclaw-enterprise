import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";

const require = createRequire("/app/package.json");
const { WebSocketServer } = require("ws");
const cases = JSON.parse(process.env.OCC_TEST_SUBAGENT_CASES);
const nativeModels = JSON.parse(process.env.OCC_TEST_SUBAGENT_MODELS);
const provenance = JSON.parse(await readFile("/opt/oce/runtime/provenance.json", "utf8"));
assert.equal(provenance.commit, process.env.OCC_TEST_OPENCLAW_COMMIT);

// Only the external Codex peer is a fixture. The packaged Gateway performs real
// sessions_spawn admission, model preparation, child dispatch and native model resolution.
// The peer rejects turn/start before accepting inference: no Codex process or external egress.
const requests = [];
const threadStarts = new Map();
const unloadedThreads = new Set();
let unsupportedMethod;
const server = new WebSocketServer({ host: "127.0.0.1", port: 4500 });
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
// Mirror the pinned OC peer fixture; echo the requested selection without choosing its owner.
function threadStartResult(threadId, { cwd, model, modelProvider }) {
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
      cliVersion: provenance.codex.version,
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
    const message = JSON.parse(bytes.toString());
    if (message.id === undefined) {
      return;
    }
    requests.push(message);
    const reply = (result) => socket.send(JSON.stringify({ id: message.id, result }));
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
        const { threadId } = message.params;
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
        const { threadId } = message.params;
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
        const { threadId } = message.params;
        const started = threadStarts.get(threadId);
        assert.ok(started, "The fixture only resumes its assigned native threads.");
        unloadedThreads.delete(threadId);
        // Fallback changes current settings, not the recorded primary request used by the oracle.
        reply(threadStartResult(threadId, { ...started.params, ...message.params }));
        break;
      }
      case "thread/inject_items":
        assert.ok(
          threadStarts.has(message.params?.threadId),
          "The fixture only updates its assigned native threads.",
        );
        reply({});
        break;
      case "turn/start":
        assert.ok(
          threadStarts.has(message.params?.threadId),
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
async function waitFor(description, read) {
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
  const configuration = JSON.parse(await readFile("/home/node/.openclaw/openclaw.json", "utf8"));
  const observed = [];
  for (const scenario of cases) {
    assert.equal(
      configuration.agents.entries[scenario.agentId].workspace,
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
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true, JSON.stringify(result));
    const receipt = result.result.details;
    assert.equal(receipt.status, "accepted", JSON.stringify(result));
    // Child identity is in the task input, outside the shared thread instructions.
    // Match that exact child turn before inspecting its peer-assigned thread's selection:
    // neither the shared cwd nor the alias model can distinguish it from a parent turn.
    const childMarker = `- Your session: ${receipt.childSessionKey}.`;
    const ownedByChild = ({ params }) =>
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
    const childTurn = await waitFor(
      `native turn/start whose input names ${receipt.childSessionKey}`,
      () =>
        requests
          .slice(offset)
          .find((request) => request.method === "turn/start" && ownedByChild(request)),
    );
    const native = threadStarts.get(childTurn.params.threadId);
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
    const completed = await callGatewayFromCli(
      "agent.wait",
      {
        url: "ws://127.0.0.1:8080",
        password: process.env.OPENCLAW_GATEWAY_PASSWORD,
        timeout: "45000",
      },
      { runId: receipt.runId, timeoutMs: 30000 },
    );
    assert.equal(completed.runId, receipt.runId);
    assert.equal(completed.status, "error", JSON.stringify(completed));
    assert.notEqual(completed.pendingError, true);
    assert.equal(typeof completed.endedAt, "number");
    observed.push({
      agentId: scenario.agentId,
      childSessionKey: receipt.childSessionKey,
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
  await new Promise((resolve) => server.close(resolve));
}
