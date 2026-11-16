import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import { listen } from "../helpers/listen.ts";
import { tlsPeerCertificate } from "../helpers/tls-peer-certificate.ts";
import { within } from "../helpers/wait-for.mjs";

// TCP is reachable, but the peer never answers the TLS ClientHello. This must
// hit the helper's absolute deadline before the test timeout.
const timeoutMs = 200;

test(
  "TLS certificate acquisition times out and closes a stalled handshake",
  { timeout: 15_000 },
  async (t) => {
    const sockets = new Set<Socket>();
    const peerClosed = Promise.withResolvers<void>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.resume();
      socket.once("close", () => {
        sockets.delete(socket);
        peerClosed.resolve();
      });
    });
    const port = await listen(t, server);
    const verifyClosure = async () => {
      await assert.rejects(
        tlsPeerCertificate({ host: "127.0.0.1", port, servername: "localhost", timeoutMs }),
        new RegExp(`TLS certificate handshake timed out after ${timeoutMs} ms`),
      );
      // Observe the remote close before fixture cleanup can hide a leaked socket.
      await peerClosed.promise;
      assert.equal(sockets.size, 0);
    };
    await within(
      verifyClosure(),
      "certificate acquisition and peer close exceeded their deadline",
      5_000,
    );
  },
);
