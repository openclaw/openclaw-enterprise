import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const diffsVersion = "2026.8.2";
const diffsIntegrity =
  "sha512-5VTDNEo7D3iOgRoL5C31JPTbA/EXQEFRuxOvLy67IMFmOajwroGsUMWeuKkmqzFbPNQxvn7GACDSr/5Vmpx3/g==";

function writeJson(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

function parsePort(args) {
  const index = args.indexOf("--port");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    fail("gateway port is missing");
  }
  return Number(value);
}

function startGateway(args) {
  const port = parsePort(args);
  const server = createServer((request, response) => {
    if (request.url !== "/readyz") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ready: true }));
  });

  server.listen(port, "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

function handlePlugins(args) {
  const [command, ...rest] = args;
  if (
    command === "install" &&
    rest[0] === `@openclaw/diffs@${diffsVersion}` &&
    rest.includes("--pin") &&
    rest.includes("--force")
  ) {
    if (process.env.OPENCLAW_FIXTURE_DIFFS_INSTALL_RESULT === "fail") {
      fail("controlled fixture diffs install failure");
    }
    return;
  }
  if (command === "registry" && rest[0] === "--refresh" && rest.includes("--json")) {
    writeJson({ refreshed: true });
    return;
  }
  if (command === "inspect" && rest[0] === "diffs" && rest.includes("--json")) {
    writeJson({
      plugin: {
        id: "diffs",
        version: diffsVersion,
        rootDir: "/home/node/.openclaw/plugins/@openclaw/diffs",
      },
      install: {
        source: "npm",
        resolvedName: "@openclaw/diffs",
        resolvedVersion: diffsVersion,
        installPath: "/home/node/.openclaw/plugins/@openclaw/diffs",
        integrity: diffsIntegrity,
      },
    });
    return;
  }
  fail(`unsupported fixture plugin command: ${[command, ...rest].join(" ")}`);
}

function handleModels(args) {
  const [command, ...rest] = args;
  if (command === "status" && rest.includes("--json") && rest.includes("--probe")) {
    const model =
      process.env.OPENCLAW_CONFIG_PATH === undefined
        ? "openai/gpt-5"
        : JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")).agents?.defaults
            ?.model;
    writeJson({
      auth: {
        probes: {
          results: [
            {
              provider: "openai",
              model,
              source: "env",
              status: "ok",
            },
          ],
        },
      },
    });
    return;
  }
  fail(`unsupported fixture models command: ${[command, ...rest].join(" ")}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "gateway") {
  startGateway(args);
} else if (command === "plugins") {
  handlePlugins(args);
} else if (command === "models") {
  handleModels(args);
} else {
  fail(`unsupported fixture command: ${command ?? "missing"}`);
}
