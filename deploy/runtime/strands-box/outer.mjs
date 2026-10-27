import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
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
} from "./transport.mjs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const expectedHash = Buffer.from(manifest.transportHash, "hex");
if (
  expectedHash.length !== 32 ||
  !Number.isInteger(manifest.port) ||
  manifest.port < 1 ||
  manifest.port > 65535
) {
  throw new Error("Invalid prepared transport configuration");
}
const channels = new Map();
let stopping = false;
let shutdownRequested = false;
const box = spawn(
  "/opt/strands-box/strands-box",
  ["run", "--config", "/etc/strands-box/box.toml"],
  {
    stdio: ["pipe", "pipe", "inherit"],
    // The supervisor receives no model Secret environment. Private Secret files
    // are opened by the contained bootstrap, not serialized into Box config.
    env: { HOME: "/home/node", PATH: process.env.PATH },
  },
);
function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  server.close();
  for (const socket of channels.values()) {
    socket.destroy();
  }
  box.kill("SIGTERM");
  setTimeout(() => {
    box.kill("SIGKILL");
  }, 8000).unref();
}
const send = framed(
  box.stdout,
  box.stdin,
  (message) => {
    if (message.type === "open") {
      // No host, port, URL, command, or credential chosen by the workload is
      // accepted here. This one route is derived from the exact Agent's setup.
      if (!manifest.gateway || channels.has(message.id) || channels.size >= MAX_CHANNELS) {
        throw new Error("Unapproved channel");
      }
      const socket = connect({ host: manifest.gateway.host, port: manifest.gateway.port });
      socket.setTimeout(30000, () => socket.destroy());
      socket.once("connect", () => socket.setTimeout(0));
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
const server = createServer((socket) => {
  if (channels.size >= MAX_CHANNELS || stopping) {
    socket.destroy();
    return;
  }
  firstHeader(socket, (lines, bytes) => {
    if (!/^GET \/(?:openclaw\/runtime\/status)? HTTP\/1\.[01]$/u.test(lines[0])) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const auth = lines.filter((line) => /^authorization:/iu.test(line));
    const token =
      auth.length === 1 ? /^authorization: Bearer ([^\s]+)$/iu.exec(auth[0])?.[1] : undefined;
    const actual = createHash("sha256")
      .update(token ?? "")
      .digest();
    if (!token || !timingSafeEqual(actual, expectedHash)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (channels.size >= MAX_CHANNELS) {
      socket.destroy();
      return;
    }
    const id = channelId();
    channels.set(id, socket);
    relay(socket, id, send, () => channels.delete(id));
    send({ id, type: "open" });
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      send({ id, type: "data", data: bytes.subarray(offset, offset + CHUNK).toString("base64") });
    }
    socket.resume();
  });
});
server.maxConnections = MAX_CHANNELS;
server.on("error", stop);
server.listen(manifest.port, "0.0.0.0");
box.on("error", stop);
box.on("exit", (code) => {
  stop();
  process.exitCode = shutdownRequested || code === 0 ? 0 : 1;
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    shutdownRequested = true;
    stop();
  });
}
