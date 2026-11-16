import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isIPv4 } from "node:net";
import type { GatewayClientOptions } from "@openclaw/gateway-client";

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function gatewayAuthority(startup: unknown): string {
  const message = "Invalid installation Gateway route";
  const config = object(startup, message);
  const drivers = object(config.drivers, message);
  const compute = object(drivers.compute, message);
  const configuration = object(compute.configuration, message);
  const { hostname, endpointPort } = object(configuration.gatewayRouting, message);
  const port = endpointPort ?? 443;
  if (
    typeof hostname !== "string" ||
    hostname.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
      hostname,
    ) ||
    (/(^|\.)(?:0x[0-9a-f]*|[0-9]+)$/.test(hostname) && !isIPv4(hostname)) ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(message);
  }
  return hostname + (port === 443 ? "" : `:${port}`);
}

const require = createRequire("/app/apps/controller/package.json");
const { GatewayClient }: typeof import("@openclaw/gateway-client") = await import(
  require.resolve("@openclaw/gateway-client")
);
const { loadYaml }: Pick<typeof import("@kubernetes/client-node"), "loadYaml"> = await import(
  require.resolve("@kubernetes/client-node")
);
// Read the installed private Gateway route inside the API container.
const config = loadYaml<unknown>(readFileSync(requiredEnv("OCC_CONFIG_PATH"), "utf8"));
const host = gatewayAuthority(config);
const namespace = requiredEnv("OCE_TEST_NAMESPACE_ID");
const agent = requiredEnv("OCE_TEST_AGENT_ID");
const prompt = requiredEnv("OCE_TEST_PROMPT");
type GatewayHello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];
const connected: {
  promise: Promise<GatewayHello>;
  resolve: (hello: GatewayHello) => void;
  reject: (error: Error) => void;
} = Promise.withResolvers<GatewayHello>();
const sessionKey = `agent:main:api-check-${randomUUID()}`;
const url = `wss://${host}/namespaces/${namespace}/agents/${agent}`;
console.error("OpenClaw WebSocket:", url);
const client = new GatewayClient({
  url,
  edgeAuthHeaders: {
    "x-api-key": readFileSync(requiredEnv("OCC_GATEWAY_API_KEY_PATH"), "utf8").trim(),
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
const timer = setTimeout(() => connected.reject(new Error("Hello timeout")), 20_000);
try {
  client.start();
  await connected.promise;
  clearTimeout(timer);
  const signal = AbortSignal.timeout(600_000);
  const call = (method: string, params: Record<string, unknown>) =>
    client.request<unknown>(method, params, { signal, timeoutMs: 30_000 });

  // Submit one user message; poll the same run and return its recorded tool results.
  const sent = await call("chat.send", {
    sessionKey,
    idempotencyKey: randomUUID(),
    message: prompt,
  });
  const { runId } = object(sent, "Invalid chat.send reply");
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Invalid chat.send run ID");
  }
  let outcome: Record<string, unknown>;
  do {
    const result = await call("agent.wait", { runId, timeoutMs: 3_000 });
    outcome = object(result, "Invalid agent.wait reply");
    if (
      typeof outcome.status !== "string" ||
      (outcome.runId !== undefined && outcome.runId !== runId)
    ) {
      throw new Error("Invalid agent.wait outcome");
    }
  } while (outcome.status !== "ok" && outcome.status !== "error");
  const history = object(await call("chat.history", { sessionKey, limit: 200 }), "Invalid history");
  if (!Array.isArray(history.messages)) {
    throw new Error("Invalid chat.history messages");
  }
  console.log(JSON.stringify({ runId, outcome, history }));
  if (outcome.status !== "ok") {
    process.exitCode = 1;
  }
} finally {
  clearTimeout(timer);
  await client.stopAndWait({ timeoutMs: 1_000 });
}
