import { GatewayClient } from "@openclaw/gateway-client";
import { randomUUID, X509Certificate } from "node:crypto";
import { connect as connectTls } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function connectGateway({ url, apiKey, extraHeaders = {} }) {
  let resolveHello;
  let rejectHello;
  const connected = new Promise((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const client = new GatewayClient({
    url,
    clientName: "gateway-client",
    mode: "backend",
    role: "operator",
    scopes: [],
    deviceIdentity: null,
    edgeAuthHeaders: {
      ...(apiKey === undefined ? {} : { "x-api-key": apiKey }),
      ...extraHeaders,
    },
    onHelloOk: resolveHello,
    onConnectError: rejectHello,
  });
  const timer = setTimeout(() => rejectHello(new Error("gateway hello timed out")), 15_000);
  client.start();
  try {
    return { client, hello: await connected };
  } catch (error) {
    client.stop();
    await client.stopAndWait?.({ timeoutMs: 1_000 }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function certificate(url) {
  const endpoint = new URL(url);
  return await new Promise((resolve, reject) => {
    const socket = connectTls({
      host: endpoint.hostname,
      port: Number(endpoint.port || "443"),
      servername: endpoint.hostname,
      rejectUnauthorized: true,
    });
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(15_000, () => fail(new Error("TLS certificate probe timed out")));
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate(true);
      socket.end();
      if (!(peer.raw instanceof Buffer)) {
        reject(new Error("TLS certificate probe did not return a raw peer certificate"));
        return;
      }
      const parsed = new X509Certificate(peer.raw);
      resolve({ serialNumber: parsed.serialNumber, issuer: parsed.issuer });
    });
  });
}

async function modelTurn({ url, apiKey, expectedMarker, timeoutMs = 240_000 }) {
  const prompt = "What is the configured workspace marker? Reply with only that marker.";
  const sessionKey = `agent:main:workspace-proof-${randomUUID()}`;
  const signal = AbortSignal.timeout(timeoutMs);
  const { client, hello } = await connectGateway({ url, apiKey });
  try {
    if (hello.auth?.role !== "operator" || !hello.auth.scopes.includes("operator.admin")) {
      throw new Error("trusted-proxy gateway authentication did not grant operator.admin");
    }
    if (hello.auth.deviceToken !== undefined) {
      throw new Error("trusted-proxy gateway issued an unexpected device token");
    }
    await client.request(
      "chat.send",
      { sessionKey, idempotencyKey: randomUUID(), message: prompt },
      { signal, timeoutMs: 30_000 },
    );
    while (!signal.aborted) {
      const history = await client.request(
        "chat.history",
        { sessionKey, limit: 20 },
        { signal, timeoutMs: 10_000 },
      );
      for (const message of history.messages ?? []) {
        if (message.role !== "assistant") {
          continue;
        }
        if (message.stopReason === "error") {
          throw new Error("the provider-backed native turn failed");
        }
        const content =
          typeof message.content === "string"
            ? message.content
            : (message.content ?? [])
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        if (content.includes(expectedMarker)) {
          return { sessionKey, content, deviceTokenIssued: false };
        }
      }
      await delay(300, undefined, { signal });
    }
    throw new Error("the fresh native session did not consume the workspace instruction");
  } finally {
    client.stop();
    await client.stopAndWait?.({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}

const input = await readInput();
let result;
switch (input.action) {
  case "certificate":
    result = await certificate(input.url);
    break;
  case "hello": {
    const { client, hello } = await connectGateway(input);
    result = { auth: hello.auth };
    client.stop();
    await client.stopAndWait?.({ timeoutMs: 1_000 }).catch(() => undefined);
    break;
  }
  case "model-turn":
    result = await modelTurn(input);
    break;
  default:
    throw new Error(`unsupported gateway probe action: ${input.action}`);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
