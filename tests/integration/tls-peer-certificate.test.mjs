import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { tlsPeerCertificate } from "../helpers/tls-peer-certificate.mjs";

// TCP is reachable, but the peer never answers the TLS ClientHello. This must
// hit the helper's absolute deadline, not the file runner's much longer timeout.
test(
  "TLS certificate acquisition times out and closes a stalled handshake",
  { timeout: 15_000 },
  async () => {
    const sockets = new Set();
    let recordPeerClose;
    const peerClosed = new Promise((resolve) => {
      recordPeerClose = resolve;
    });
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.resume();
      socket.on("close", () => {
        sockets.delete(socket);
        recordPeerClose();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    let watchdog;
    try {
      const acquisition = tlsPeerCertificate({
        host: "127.0.0.1",
        port: server.address().port,
        servername: "localhost",
      });
      const limit = new Promise((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("certificate acquisition exceeded its deadline")),
          12_000,
        );
      });
      await assert.rejects(
        Promise.race([acquisition, limit]),
        /TLS certificate handshake timed out after 10000 ms/,
      );
      // Observe the remote close before fixture cleanup can hide a leaked socket.
      await Promise.race([peerClosed, limit]);
      assert.equal(sockets.size, 0);
    } finally {
      clearTimeout(watchdog);
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
