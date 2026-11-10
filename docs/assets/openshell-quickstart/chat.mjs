import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire("/app/apps/controller/package.json");
const { GatewayClient } = await import(require.resolve("@openclaw/gateway-client"));
const { loadYaml } = require("@kubernetes/client-node");
// Read the installed private Gateway route inside the API container.
const config = loadYaml(readFileSync(process.env.OCC_CONFIG_PATH, "utf8"));
const route = config.drivers.compute.configuration.gatewayRouting;
const port = route.endpointPort ?? 443;
const host = route.hostname + (port === 443 ? "" : `:${port}`);
const namespace = process.env.OCE_TEST_NAMESPACE_ID;
const agent = process.env.OCE_TEST_AGENT_ID;
const connected = Promise.withResolvers();
const sessionKey = `agent:main:api-check-${randomUUID()}`;
const url = `wss://${host}/namespaces/${namespace}/agents/${agent}`;
console.error("OpenClaw WebSocket:", url);
const client = new GatewayClient({
  url,
  edgeAuthHeaders: {
    "x-api-key": readFileSync(process.env.OCC_GATEWAY_API_KEY_PATH, "utf8").trim(),
  },
  clientName: "gateway-client",
  mode: "backend",
  role: "operator",
  scopes: [],
  deviceIdentity: null,
  minProtocol: 4,
  maxProtocol: 4,
  onHelloOk: connected.resolve,
  onConnectError: connected.reject,
});
const timer = setTimeout(() => connected.reject(new Error("Hello timeout")), 20000);
try {
  client.start();
  await connected.promise;
  clearTimeout(timer);
  const signal = AbortSignal.timeout(600000);
  const call = (method, params) =>
    client.request(method, params, {
      signal,
      timeoutMs: 30000,
    });
  // Submit one user message; poll the same run and return its recorded tool results.
  const sent = await call("chat.send", {
    sessionKey,
    idempotencyKey: randomUUID(),
    message: process.env.OCE_TEST_PROMPT,
  });
  let outcome;
  do {
    outcome = await call("agent.wait", { runId: sent.runId, timeoutMs: 3000 });
  } while (!["ok", "error"].includes(outcome.status));
  const history = await call("chat.history", { sessionKey, limit: 200 });
  console.log(JSON.stringify({ runId: sent.runId, outcome, history }));
  if (outcome.status !== "ok") process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.stopAndWait({ timeoutMs: 1000 });
}
