import { readFileSync, mkdirSync } from "node:fs";
import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
import {
  channelId,
  framed,
  relay,
  deliver,
  firstHeader,
  MAX_CHANNELS,
  CHUNK,
  write,
} from "./transport.mjs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const boxProxy = new URL(process.env.HTTPS_PROXY);
if (boxProxy.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(boxProxy.hostname)) {
  throw new Error("Missing Box-owned proxy");
}
const channels = new Map();
const proxySockets = new Set();
let child;
let stopping = false;
function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  proxy.close();
  for (const socket of [...channels.values(), ...proxySockets]) {
    socket.destroy();
  }
  child?.kill("SIGTERM");
  setTimeout(() => process.exit(1), 7000).unref();
}
const send = framed(
  process.stdin,
  process.stdout,
  (message) => {
    if (message.type === "open") {
      if (channels.has(message.id)) {
        throw new Error("Duplicate channel");
      }
      if (channels.size >= MAX_CHANNELS) {
        send({ id: message.id, type: "close" });
        return;
      }
      const socket = connect({ host: "127.0.0.1", port: manifest.port });
      channels.set(message.id, socket);
      relay(socket, message.id, send, () => channels.delete(message.id));
    } else {
      const socket = channels.get(message.id);
      if (socket) {
        deliver(message, socket);
      }
    }
  },
  stop,
);
const proxy = createServer((socket) => {
  if (proxySockets.size >= MAX_CHANNELS) {
    socket.destroy();
    return;
  }
  proxySockets.add(socket);
  socket.once("close", () => proxySockets.delete(socket));
  firstHeader(socket, (lines, bytes) => {
    const target = /^CONNECT ([a-zA-Z0-9.-]+):([0-9]+) HTTP\/1\.[01]$/u.exec(lines[0]);
    const gateway = manifest.gateway;
    let plainGateway;
    try {
      const request =
        /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH) (http:\/\/\S+) (HTTP\/1\.[01])$/u.exec(lines[0]);
      if (request && gateway) {
        const url = new URL(request[2]);
        if (
          url.hostname === gateway.host &&
          Number(url.port || 80) === gateway.port &&
          !url.username &&
          !url.password &&
          !url.hash
        ) {
          plainGateway = Buffer.concat([
            Buffer.from(`${request[1]} ${url.pathname}${url.search} ${request[3]}`),
            bytes.subarray(bytes.indexOf("\r\n")),
          ]);
        }
      }
    } catch {
      /* An invalid URL stays on the policy-controlled proxy path. */
    }
    if (
      gateway &&
      ((target?.[1] === gateway.host && Number(target[2]) === gateway.port) || plainGateway)
    ) {
      if (channels.size >= MAX_CHANNELS) {
        socket.destroy();
        return;
      }
      const id = channelId();
      channels.set(id, socket);
      relay(socket, id, send, () => channels.delete(id));
      send({ id, type: "open" });
      if (!plainGateway) {
        write(socket, Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"));
      }
      const head = plainGateway ?? bytes.subarray(bytes.indexOf("\r\n\r\n") + 4);
      for (let offset = 0; offset < head.length; offset += CHUNK) {
        send({ id, type: "data", data: head.subarray(offset, offset + CHUNK).toString("base64") });
      }
      socket.resume();
      return;
    }
    // All other destinations still pass through the unmodified Box proxy and
    // its loaded policy. This path does not provide an alternate egress route.
    const upstream = connect({ host: boxProxy.hostname, port: Number(boxProxy.port) });
    upstream.setTimeout(10000, () => upstream.destroy());
    upstream.once("connect", () => upstream.setTimeout(0));
    proxySockets.add(upstream);
    upstream.once("close", () => {
      proxySockets.delete(upstream);
      socket.destroy();
    });
    upstream.on("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("connect", () => {
      write(upstream, bytes);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.resume();
    });
  });
});
proxy.maxConnections = MAX_CHANNELS;
proxy.on("error", stop);
await new Promise((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(0, "127.0.0.1", resolve);
});
const environment = { ...process.env, ...manifest.environment };
// Box prepends its governed shell aliases. Keep those ahead of Compute's PATH.
environment.PATH = [
  ...new Set(
    [
      ...(process.env.PATH ?? "").split(":"),
      ...(manifest.environment.PATH ?? "").split(":"),
    ].filter(Boolean),
  ),
].join(":");
for (const [name, file] of Object.entries(manifest.secretEnvironment ?? {})) {
  const value = readFileSync(file);
  if (value.length > 1024 * 1024 || value.includes(0)) {
    throw new Error("Invalid projected environment value");
  }
  environment[name] = value.toString();
}
for (const directory of manifest.privateDirectories ?? []) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
  environment[name] = proxyUrl;
}
environment.NO_PROXY = "";
environment.no_proxy = "";
environment.NODE_USE_ENV_PROXY = "1";
environment.NODE_OPTIONS =
  `${environment.NODE_OPTIONS ?? ""} --jitless --import=/opt/oce/strands-box/proxy-preload.mjs`.trim();
// Compute supplies the complete startup program; Box supplies private PID 1 supervision.
child = spawn(manifest.command[0], manifest.command.slice(1), {
  env: environment,
  cwd: manifest.workspace,
  stdio: ["ignore", 2, 2],
});
// Child logs belong on stderr; stdout is exclusively the transport protocol.
// spawn uses descriptor 2 for both streams, without changing the Harness argv.
child.on("error", stop);
child.once("exit", (code) => {
  const requested = stopping;
  stop();
  process.exit(requested ? 0 : (code ?? 1));
});
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
