import { createServer } from "node:http";
import { createServer as tlsServer } from "node:tls";

export function custodyOriginWire(tls, handle) {
  const http = createServer(handle);
  // Keep the request counter unambiguous even for a keep-alive client.
  http.maxRequestsPerSocket = 1;
  const wireRequests = new WeakMap();
  let wireCount = 0;
  let tcp = 0;
  // Observe decrypted request data before giving the same socket to Node's HTTP
  // parser. A connection that sends nothing is counted only by the TCP observer.
  const sockets = new Set();
  const server = tlsServer(tls, (socket) => {
    socket.once("readable", () => {
      const first = socket.read();
      if (!first?.length) {
        return;
      }
      wireRequests.set(socket, ++wireCount);
      socket.unshift(first);
      http.emit("connection", socket);
      socket.resume();
    });
  });
  server.on("connection", (socket) => {
    tcp++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return Object.assign(server, {
    requestOnWire(socket) {
      return wireRequests.get(socket);
    },
    wireCount() {
      return wireCount;
    },
    tcpCount() {
      return tcp;
    },
    closeAllConnections() {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
  });
}
