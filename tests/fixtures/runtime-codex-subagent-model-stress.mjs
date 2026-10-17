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
let connections = 0;
server.on("connection", (socket, request) => {
  const connection = ++connections;
  assert.equal(request.headers.authorization, `Bearer ${process.env.APP_SERVER_TOKEN}`);
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.id === undefined) {
      return;
    }
    requests.push({ ...message, receivedAt: Date.now(), connection });
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
  throw new Error(
    `Timed out waiting for ${description}; methods=${requests.map(({ method }) => method).join(",")}`,
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
  const iterations = Number(process.env.OCC_TEST_SUBAGENT_ITERATIONS ?? 1);
  const describe = (entry) => ({
    t: entry.receivedAt,
    c: entry.connection,
    method: entry.method,
    model: entry.params?.model,
    provider: entry.params?.modelProvider,
    cwd: entry.params?.cwd,
    ephemeral: entry.params?.ephemeral,
    threadSource: entry.params?.threadSource,
    dev:
      typeof entry.params?.developerInstructions === "string"
        ? {
            length: entry.params.developerInstructions.length,
            subagent: /subagent/i.test(entry.params.developerInstructions),
            head: entry.params.developerInstructions.slice(0, 120),
            sessionHints: [
              ...new Set(
                entry.params.developerInstructions.match(/agent:[a-z]+:[A-Za-z0-9:_-]{0,60}/g) ??
                  [],
              ),
            ].slice(0, 6),
          }
        : undefined,
    configKeys: entry.params?.config ? Object.keys(entry.params.config).slice(0, 30) : undefined,
    tools: Array.isArray(entry.params?.dynamicTools)
      ? entry.params.dynamicTools.map((tool) => tool?.name ?? tool?.namespace).slice(0, 20)
      : undefined,
  });
  const anomalies = [];
  const timeline = [];
  let caseCount = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const scenario of cases) {
      caseCount += 1;
      const parentKey = `agent:${scenario.agentId}:routing-parent-${iteration}`;
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
      const spawnAt = Date.now();
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
            ...(process.env.OCC_TEST_SUBAGENT_HANDOFF === "default"
              ? {}
              : { expectsCompletionMessage: false }),
          },
        }),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      const receipt = result.result.details;
      assert.equal(receipt.status, "accepted", JSON.stringify(result));
      const native = await waitFor("native child thread/start", () =>
        requests.slice(offset).find(({ method }) => method === "thread/start"),
      );
      const completed = await callGatewayFromCli(
        "agent.wait",
        {
          url: "ws://127.0.0.1:8080",
          password: process.env.OPENCLAW_GATEWAY_PASSWORD,
          timeout: "45000",
        },
        { runId: receipt.runId, timeoutMs: 30000 },
      );
      const settledAt = Date.now();
      const window = requests.slice(offset).filter(({ method }) => method === "thread/start");
      timeline.push({
        iteration,
        agentId: scenario.agentId,
        spawnAt,
        settledAt,
        status: completed.status,
        models: window.map(({ params, receivedAt, connection }) => [
          params.model,
          receivedAt - spawnAt,
          connection,
        ]),
      });
      if (native.params.model !== scenario.model) {
        anomalies.push({
          iteration,
          agentId: scenario.agentId,
          expected: scenario.model,
          spawnAt,
          settledAt,
          childSessionKey: receipt.childSessionKey,
          runId: receipt.runId,
          completed,
          window: requests.slice(Math.max(0, offset - 12)).map((entry, index) => ({
            beforeOffset: index < Math.min(12, offset),
            ...describe(entry),
          })),
        });
      }
    }
  }
  // Show one ordinary child and one requester-free reference for comparison.
  const reference = requests
    .filter(({ method }) => method === "thread/start")
    .slice(0, 2)
    .map(describe);
  console.log(
    JSON.stringify({
      commit: provenance.commit,
      caseCount,
      anomalies,
      reference,
      timelineTail: timeline.slice(-8),
    }),
  );
} finally {
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise((resolve) => server.close(resolve));
}
