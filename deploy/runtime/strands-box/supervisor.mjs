import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, connect } from "node:net";
import {
  channelId,
  framed,
  relay,
  deliver,
  firstHeader,
  MAX_CHANNELS,
  CHUNK,
} from "./transport.mjs";

// The supervisor owns both directions of the bounded relay. The contained
// process supplies bytes; only the prepared manifest selects Gateway routing.
export function serveHarness(manifest, { reader, writer, terminate }) {
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
  const accepted = new Set();
  let stopping = false;
  function stop() {
    if (stopping) {
      return;
    }
    stopping = true;
    server.close();
    for (const socket of [...channels.values(), ...accepted]) {
      socket.destroy();
    }
    terminate();
  }
  const send = framed(
    reader,
    writer,
    (message) => {
      if (message.type === "open") {
        // No host, port, URL, command, or credential chosen by the workload is
        // accepted here. This one route is derived from the exact Agent's setup.
        if (
          stopping ||
          !manifest.gateway ||
          channels.has(message.id) ||
          channels.size >= MAX_CHANNELS
        ) {
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
    accepted.add(socket);
    socket.once("close", () => accepted.delete(socket));
    const reject = (status) => {
      // end() alone leaves the paused readable half alive. Bound flushing and
      // destroy it even when the rejected client never sends FIN or reads.
      const deadline = setTimeout(() => socket.destroy(), 1000);
      deadline.unref();
      socket.once("close", () => clearTimeout(deadline));
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
        socket.destroy(),
      );
    };
    firstHeader(socket, (lines, bytes) => {
      if (stopping) {
        socket.destroy();
        return;
      }
      if (!/^GET \/(?:openclaw\/runtime\/status)? HTTP\/1\.[01]$/u.test(lines[0])) {
        reject("404 Not Found");
        return;
      }
      const auth = lines.filter((line) => /^authorization:/iu.test(line));
      const token =
        auth.length === 1 ? /^authorization: Bearer ([^\s]+)$/iu.exec(auth[0])?.[1] : undefined;
      const actual = createHash("sha256")
        .update(token ?? "")
        .digest();
      if (!token || !timingSafeEqual(actual, expectedHash)) {
        reject("401 Unauthorized");
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
  return { server, stop };
}
