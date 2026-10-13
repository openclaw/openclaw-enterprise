import { createServer } from "node:http";

// Deterministic platform coverage does not claim a model turn. Real Git/gh run
// in this Pod using Compute-delivered material; the sibling installed test owns
// genuine OpenClaw authentication, model execution, and persisted tool evidence.
const args = process.argv.slice(2);
if (args[0] === "models" && args[1] === "status") {
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
  if (process.env.OPENAI_API_KEY !== "repository-platform-fixture-key") {
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      auth: {
        probes: {
          results: [
            {
              provider: "openai",
              model: config.agents.defaults.model,
              source: "env",
              status: "ok",
            },
          ],
        },
      },
    }),
  );
} else if (args[0] === "gateway") {
  const port = Number(args[args.indexOf("--port") + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.exit(1);
  }
  // Lifecycle lines for the container log a failed stop wait attaches (finding
  // 795: a stopped gateway once took 29 s to exit). Requests and closed
  // connections are logged only while draining.
  const startedAt = Date.now();
  const log = (event, fields = {}) =>
    process.stdout.write(
      `${JSON.stringify({ event: `fixture_harness.${event}`, sinceStartMs: Date.now() - startedAt, ...fields })}\n`,
    );
  const sockets = new Set();
  let activeRequests = 0;
  let draining = false;
  const state = () => ({
    connections: sockets.size,
    activeRequests,
    peers: [...sockets].slice(0, 8).map((socket) => `${socket.remoteAddress}:${socket.remotePort}`),
  });
  const server = createServer((request, response) => {
    activeRequests += 1;
    response.once("close", () => {
      activeRequests -= 1;
    });
    if (draining) {
      log("request", { method: request.method, readyz: request.url === "/readyz" });
    }
    response.writeHead(request.url === "/readyz" ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ fixtureHarness: true }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      if (draining) {
        log("connection-closed", state());
      }
    });
  });
  server.listen(port, "0.0.0.0", () => log("listening", { port }));
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      if (draining) {
        return;
      }
      draining = true;
      log("signal", { signal, ...state() });
      // Sockets report their own close after this callback; it carries no counts.
      server.close(() => log("closed"));
      setInterval(() => log("draining", state()), 2_000).unref();
    });
  }
  process.once("exit", (code) => log("exit", { code }));
} else {
  process.exitCode = 1;
}
