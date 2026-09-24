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
          totalTargets: 1,
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
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/readyz" ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ fixtureHarness: true }));
  });
  server.listen(port, "0.0.0.0");
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => server.close());
  }
} else {
  process.exitCode = 1;
}
