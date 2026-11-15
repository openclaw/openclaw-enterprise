#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";

interface AppServerSocket {
  on(event: "open" | "error", listener: () => void): void;
  on(event: "pong", listener: (payload: Buffer) => void): void;
  ping(payload: Buffer): void;
  terminate(): void;
}

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as new (
  address: string,
  options: { headers: { Authorization: string } },
) => AppServerSocket;

// Admit only the startup validator used by the real wrapper. Native image tests
// exercise its schema validation; this synthetic image tests transport retries.
if (
  JSON.stringify(process.argv.slice(2)) === JSON.stringify(["config", "validate", "--json"]) &&
  process.env.OPENCLAW_CONFIG_READONLY === "1"
) {
  process.stdout.write(JSON.stringify({ valid: true }));
  process.exit(0);
}

function optionValue(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function appServerReady(token = process.env.APP_SERVER_TOKEN) {
  return new Promise<boolean>((resolve) => {
    const challenge = Buffer.from(randomUUID());
    const socket = new WebSocket(process.env.APP_SERVER_URL!, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
    });
    const finish = (ready: boolean) => {
      clearTimeout(timeout);
      socket.terminate();
      resolve(ready);
    };
    const timeout = setTimeout(() => finish(false), 2_000);
    socket.on("open", () => socket.ping(challenge));
    socket.on("pong", (payload) => finish(payload.equals(challenge)));
    socket.on("error", () => finish(false));
  });
}

if (process.argv[2] !== "gateway") {
  console.error("Unsupported OpenClaw fixture command.");
  process.exit(64);
}

const port = Number(optionValue("--port") ?? process.env.OPENCLAW_GATEWAY_PORT ?? "8080");
const server = createServer(async (request, response) => {
  // Deliberately separate process health from downstream authentication: a
  // healthy gateway can still hold a stale app-server token after a retry.
  if (request.url === "/readyz") {
    response.writeHead(200).end("ready");
    return;
  }
  if (request.url === "/token-check") {
    const accepted = await appServerReady();
    const wrongTokenAccepted = await appServerReady("fixture-invalid-token");
    const missingTokenAccepted = await appServerReady("");
    response.writeHead(accepted && !wrongTokenAccepted && !missingTokenAccepted ? 200 : 502).end();
    return;
  }
  response.writeHead(404).end();
});
server.listen(port, "0.0.0.0");
