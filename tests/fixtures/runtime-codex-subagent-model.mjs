import assert from "node:assert/strict";
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
// The peer stops at thread/start: no Codex process, model inference or external egress.
const requests = [];
let unsupportedMethod;
const server = new WebSocketServer({ host: "127.0.0.1", port: 4500 });
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
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
        reply({ data: [], nextCursor: null });
        break;
      case "thread/start":
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

async function waitFor(description, read) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    assert.equal(
      unsupportedMethod,
      undefined,
      "The native peer requested an unsupported fixture method.",
    );
    const value = await read();
    if (value) {
      return value;
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
    // Every Agent maps to the same remote root, so cwd cannot tell this child from
    // other native turns on the parent route. The upstream subagent prompt names
    // the child's own session; a missing marker times out naming the child.
    const childMarker = `- Your session: ${receipt.childSessionKey}.`;
    const ownedByChild = ({ params }) =>
      typeof params?.developerInstructions === "string" &&
      params.developerInstructions.includes(childMarker);
    const nativeStarts = () =>
      requests
        .slice(offset)
        .filter(({ method }) => method === "thread/start")
        .map((request) => ({
          model: request.params?.model,
          cwd: request.params?.cwd,
          child: ownedByChild(request),
        }));
    const native = await waitFor(
      `native thread/start whose prompt names ${receipt.childSessionKey}`,
      () =>
        requests
          .slice(offset)
          .find((request) => request.method === "thread/start" && ownedByChild(request)),
    );
    assert.equal(native.params.cwd, scenario.cwd, "Native execution uses the Harness workspace.");
    assert.deepEqual(
      { modelProvider: native.params.modelProvider, model: native.params.model },
      { modelProvider: "openai-compatible", model: scenario.model },
      `${scenario.agentId} thread/starts since its spawn: ${JSON.stringify(nativeStarts())}`,
    );
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
      modelProvider: native.params.modelProvider,
      model: native.params.model,
      cwd: native.params.cwd,
      terminalStatus: completed.status,
    });
  }
  console.log(JSON.stringify({ commit: provenance.commit, observed }));
} finally {
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise((resolve) => server.close(resolve));
}
