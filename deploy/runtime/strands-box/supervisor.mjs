import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createTlsServer } from "node:tls";
import { createServer, connect } from "node:net";
import {
  channelId,
  framed,
  relay,
  deliver,
  firstHeader,
  MAX_CHANNELS,
  PROBE_CHANNELS,
  CHUNK,
} from "./transport.mjs";

// The supervisor owns both directions of the bounded relay. The contained
// process supplies bytes; only the prepared manifest selects Gateway routing.
export function serveHarness(manifest, { reader, writer, terminate, tls, probePath, status }) {
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
  const probes = new Set();
  let stopping = false;
  function stop() {
    if (stopping) {
      return;
    }
    stopping = true;
    server.close();
    probeServer.close();
    diagnostics.close();
    for (const socket of [...channels.values(), ...accepted]) {
      socket.destroy();
    }
    terminate();
  }
  const send =
    reader &&
    writer &&
    framed(
      reader,
      writer,
      (message) => {
        if (message.type === "open") {
          // No host, port, URL, command, or credential chosen by the workload is
          // accepted here. This one route is derived from the exact Agent's setup.
          if (stopping || !manifest.gateway || channels.has(message.id)) {
            throw new Error("Unapproved channel");
          }
          // Both peers may allocate the last slot before receiving the other's
          // open. Refuse that channel without terminating established sessions.
          if (channels.size - probes.size >= MAX_CHANNELS) {
            send({ id: message.id, type: "close" });
            return;
          }
          const socket = connect({ host: manifest.gateway.host, port: manifest.gateway.port });
          socket.setTimeout(30000, () => socket.destroy());
          socket.once("connect", () => {
            socket.setTimeout(0);
            send({ id: message.id, type: "opened" });
          });
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
  const route = "/revisions/" + encodeURIComponent(manifest.revisionId) + "/readiness";
  function accept(socket, probe) {
    if (stopping || (!probe && accepted.size >= MAX_CHANNELS + PROBE_CHANNELS)) {
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
      const path = /^GET ([^ ]+) HTTP\/1\.[01]$/u.exec(lines[0])?.[1];
      const diagnostic = !probe && socket.localPort === diagnostics.address()?.port;
      if (
        diagnostic
          ? path !== route
          : !(path === "/" || (probe && path === "/openclaw/runtime/status"))
      ) {
        reject("404 Not Found");
        return;
      }
      const auth = lines.filter((line) => /^authorization:/iu.test(line));
      const token =
        auth.length === 1 ? /^authorization: Bearer ([^\s]+)$/iu.exec(auth[0])?.[1] : undefined;
      const actual = createHash("sha256")
        .update(token ?? "")
        .digest();
      if (!probe && (!token || !timingSafeEqual(actual, expectedHash))) {
        reject("401 Unauthorized");
        return;
      }
      if (!probe && path === route) {
        status().then(
          (result) => {
            const body = JSON.stringify(result);
            socket.end(
              "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " +
                Buffer.byteLength(body) +
                "\r\n\r\n" +
                body,
            );
          },
          () => reject("503 Service Unavailable"),
        );
        return;
      }
      if (!send) {
        reject("503 Service Unavailable");
        return;
      }
      if (probe ? probes.size >= PROBE_CHANNELS : channels.size - probes.size >= MAX_CHANNELS) {
        socket.destroy();
        return;
      }
      const id = channelId();
      channels.set(id, socket);
      if (probe) {
        probes.add(id);
      }
      relay(socket, id, send, () => {
        channels.delete(id);
        probes.delete(id);
      });
      send({ id, type: probe ? "probe" : "open", path });
      // The inner hop gets its own ephemeral bearer. Only upgrade headers are
      // needed across the private pipe; the external Authorization stays here.
      const forwarded = lines
        .slice(1)
        .filter((line) =>
          /^(?:host|connection|upgrade|sec-websocket-(?:key|version|protocol|extensions)):/iu.test(
            line,
          ),
        );
      const end = bytes.indexOf("\r\n\r\n");
      bytes = Buffer.concat([
        Buffer.from([...forwarded, "", ""].join("\r\n"), "latin1"),
        bytes.subarray(end + 4),
      ]);
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        send({ id, type: "data", data: bytes.subarray(offset, offset + CHUNK).toString("base64") });
      }
      socket.resume();
    });
  }
  const server = createTlsServer(
    { ...tls, minVersion: "TLSv1.2", handshakeTimeout: 5000 },
    (socket) => accept(socket, false),
  );
  // Port-level NetworkPolicies keep the worker on its read-only route. Pass
  // those TCP sockets to the same TLS server; localPort survives the TLS wrap.
  const diagnostics = createServer((socket) => server.emit("connection", socket));
  diagnostics.maxConnections = PROBE_CHANNELS;
  diagnostics.on("error", stop);
  diagnostics.listen(manifest.statusPort, "0.0.0.0");
  const probeServer = createServer((socket) => accept(socket, true));
  probeServer.maxConnections = PROBE_CHANNELS;
  probeServer.on("error", stop);
  probeServer.listen(probePath);
  server.maxConnections = MAX_CHANNELS + PROBE_CHANNELS;
  server.on("error", stop);
  server.listen(manifest.port, "0.0.0.0");
  return { server, diagnostics, probeServer, stop };
}
