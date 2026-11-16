import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { text } from "node:stream/consumers";

// This program runs inside the file node's private mount, PID and network
// namespaces. The host provides only one fixed TLS tunnel. The native node
// still verifies the Gateway certificate and performs ordinary enrollment.
const input: unknown = JSON.parse(await text(process.stdin));
if (
  input === null ||
  typeof input !== "object" ||
  !("code" in input) ||
  typeof input.code !== "string" ||
  !("commands" in input) ||
  typeof input.commands !== "string" ||
  !("displayName" in input) ||
  typeof input.displayName !== "string" ||
  !("port" in input) ||
  typeof input.port !== "number" ||
  !("hasCa" in input) ||
  typeof input.hasCa !== "boolean"
) {
  throw new Error("Invalid file node input.");
}

const workspace = "/home/node/workspace";
const state = "/home/node/.openclaw-node";
const config = "/tmp/openclaw-file-node.json";
const port = input.port;
writeFileSync(
  config,
  JSON.stringify({
    agents: { defaults: { workspace } },
    plugins: {
      allow: ["file-transfer"],
      slots: { memory: "none" },
      entries: { "file-transfer": { enabled: true } },
    },
  }),
  { flag: "wx", mode: 0o600 },
);

const clients = new Set<Socket>();
const relay = createServer((client) => {
  clients.add(client);
  const upstream = createConnection({ path: "/run/oce-file-node/gateway.sock" });
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.once("error", close);
  upstream.once("error", close);
  client.once("close", () => {
    clients.delete(client);
    close();
  });
  upstream.once("close", close);
  client.pipe(upstream).pipe(client);
});
relay.maxConnections = 8;
await new Promise<void>((resolve, reject) => {
  relay.once("error", reject);
  relay.listen(port, "127.0.0.1", resolve);
});
const child = spawn(
  "/usr/local/bin/node",
  [
    "/app/openclaw.mjs",
    "node",
    "run",
    "--pair-or-reconnect",
    input.code,
    "--display-name",
    input.displayName,
    "--commands",
    input.commands,
  ],
  {
    cwd: workspace,
    env: {
      HOME: "/home/node",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      XDG_CACHE_HOME: "/tmp",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: config,
      OPENCLAW_NO_AUTO_UPDATE: "1",
      ...(input.hasCa ? { NODE_EXTRA_CA_CERTS: "/run/oce-file-node/gateway-ca.pem" } : {}),
    },
    stdio: "ignore",
  },
);
child.once("spawn", () => process.stdout.write("file-node-started\n"));
const stop = () => child.kill("SIGTERM");
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
await new Promise<void>((resolve) => {
  child.once("exit", () => resolve());
  child.once("error", () => resolve());
});
for (const client of clients) client.destroy();
relay.close();
process.exitCode = 1;
