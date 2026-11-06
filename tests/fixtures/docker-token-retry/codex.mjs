#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

// The production launcher supplies settings and disables tools for its probe.
// Parse those prefixes without implementing their native Codex behavior.
const arguments_ = process.argv.slice(2);
while (["-c", "--disable", "-a"].includes(arguments_[0]) && arguments_.length >= 2) {
  arguments_.splice(0, 2);
}
const command = arguments_[0];

// Fixture-only protocol endpoint: verifies the real entrypoint's token digest
// and uses ws automatic pong responses. It never executes Codex or model calls.
if (command === "login") {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} else if (command === "exec") {
  // The real launcher now requires a model-probe transcript before serving.
  // This external protocol stand-in only unblocks transport setup; it does not
  // authenticate a model, contact a provider, or verify native Codex execution.
  for (const event of [
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "READY" } },
    { type: "turn.completed" },
  ]) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
} else if (command === "app-server") {
  const listen = new URL(optionValue("--listen") ?? "ws://0.0.0.0:18790");
  const expectedDigest = optionValue("--ws-token-sha256");
  const sockets = new WebSocketServer({ noServer: true });
  sockets.on("connection", (socket) => {
    socket.on("error", () => {});
    // Current production startup initializes the app server and lists plugins
    // even for an empty selection. This external fixture offers an empty catalog;
    // it does not implement or verify plugin installation or model execution.
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        socket.close(1007, "Invalid fixture request");
        return;
      }
      if (message.method === "initialized" && message.id === undefined) {
        return;
      }
      if (message.id === undefined) {
        return;
      }
      let response;
      if (message.method === "initialize") {
        response = { result: { userAgent: "oce-token-retry-fixture" } };
      } else if (message.method === "plugin/search") {
        response = { result: { data: [], nextCursor: null } };
      } else {
        response = { error: { code: -32601, message: "Unsupported fixture method" } };
      }
      socket.send(JSON.stringify({ id: message.id, ...response }));
    });
  });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    const header = request.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const digest = createHash("sha256").update(token).digest("hex");
    if (!token || !expectedDigest || digest !== expectedDigest) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (connection) =>
      sockets.emit("connection", connection, request),
    );
  });
  server.listen(Number(listen.port), listen.hostname);
} else {
  console.error("Unsupported Codex fixture command.");
  process.exit(64);
}
