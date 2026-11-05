import { createServer as createHttpServer, type RequestListener } from "node:http";
import { createServer as createTlsServer, type TlsOptions } from "node:tls";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";

interface SocketObservation {
  socketId: number;
  decryptedBytes: number;
  completeRequests: number;
  droppedRequests: number;
}

interface OriginObservation {
  decryptedBytes: number;
  completeRequests: number;
  droppedRequests: number;
  connections: SocketObservation[];
}

/**
 * One test-owned origin per trusted execution/operation. Never attribute traffic
 * using caller-supplied headers. Use separate origins for reachability probes.
 *
 * snapshot() reports cumulative decrypted bytes, complete requests and native
 * parser drops across every socket (including closed sockets). mark()/since(mark)
 * delimit a window; the caller must first acknowledge its sender barrier and drain
 * prior traffic.
 * A mark is synchronous, not a network flush or proof that a sender has stopped.
 * No request contents, addresses, credentials, or parser errors are retained.
 */
export function controlledTlsOrigin(
  tls: TlsOptions,
  handle: RequestListener,
  { maxRequestsPerSocket = 0 }: { maxRequestsPerSocket?: number } = {},
) {
  const connections: SocketObservation[] = [];
  const sockets = new Set<Socket>();
  const marks = new WeakMap<object, OriginObservation>();
  const http = createHttpServer();
  http.maxRequestsPerSocket = maxRequestsPerSocket;
  const records = new WeakMap<Duplex, SocketObservation>();
  http.on("request", (request) => {
    const record = records.get(request.socket);
    if (!record) {
      throw new Error("HTTP request has no origin observation.");
    }
    request.once("end", () => {
      if (request.complete) {
        record.completeRequests++;
        server.emit("observation");
      }
    });
  });
  http.on("dropRequest", (_request, socket) => {
    const record = records.get(socket);
    if (!record) {
      throw new Error("HTTP parser drop has no origin observation.");
    }
    record.droppedRequests++;
    server.emit("observation");
  });
  // Ordinary registration preserves the HTTP server receiver and listener identity.
  // The handler still owns consumption, including delayed reads and dropped replies.
  http.on("request", handle);
  http.on("clientError", (_error, socket) => socket.destroy());
  const server = createTlsServer(tls, (socket) => {
    const record = {
      socketId: connections.length + 1,
      decryptedBytes: 0,
      completeRequests: 0,
      droppedRequests: 0,
    };
    connections.push(record);
    // A plain Duplex keeps Node's HTTP parser from taking over the native TLS
    // handle and bypassing JS data events. Every decrypted byte passes this
    // bridge exactly once, before parsing, with backpressure in both directions.
    const wire = new Duplex({
      read() {
        socket.resume();
      },
      write(chunk, encoding, callback) {
        socket.write(chunk, encoding, callback);
      },
      final(callback) {
        socket.end(callback);
      },
      destroy(error, callback) {
        socket.destroy();
        callback(error);
      },
    });
    Object.assign(wire, {
      setTimeout(timeout: number, callback?: () => void) {
        socket.setTimeout(timeout);
        if (callback) {
          if (timeout === 0) {
            wire.removeListener("timeout", callback);
          } else {
            wire.once("timeout", callback);
          }
        }
        return wire;
      },
    });
    records.set(wire, record);
    socket.on("data", (chunk) => {
      record.decryptedBytes += chunk.length;
      if (!wire.push(chunk)) {
        socket.pause();
      }
      server.emit("observation");
    });
    socket.on("timeout", () => wire.emit("timeout"));
    socket.on("end", () => wire.push(null));
    socket.on("error", () => wire.destroy());
    socket.on("close", () => wire.destroy());
    http.emit("connection", wire);
    server.emit("observation");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  function snapshot(): OriginObservation {
    return {
      decryptedBytes: connections.reduce((n, row) => n + row.decryptedBytes, 0),
      completeRequests: connections.reduce((n, row) => n + row.completeRequests, 0),
      droppedRequests: connections.reduce((n, row) => n + row.droppedRequests, 0),
      connections: connections.map((row) => ({ ...row })),
    };
  }
  return Object.assign(server, {
    snapshot,
    mark() {
      const mark = Object.freeze({});
      marks.set(mark, snapshot());
      return mark;
    },
    since(mark: object): OriginObservation {
      const before = marks.get(mark);
      if (!before) {
        throw new Error("Unknown origin observation mark.");
      }
      const after = snapshot();
      return {
        decryptedBytes: after.decryptedBytes - before.decryptedBytes,
        completeRequests: after.completeRequests - before.completeRequests,
        droppedRequests: after.droppedRequests - before.droppedRequests,
        connections: after.connections.map((row, index) => ({
          socketId: row.socketId,
          decryptedBytes: row.decryptedBytes - (before.connections[index]?.decryptedBytes ?? 0),
          completeRequests:
            row.completeRequests - (before.connections[index]?.completeRequests ?? 0),
          droppedRequests: row.droppedRequests - (before.connections[index]?.droppedRequests ?? 0),
        })),
      };
    },
    closeAllConnections() {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
  });
}
