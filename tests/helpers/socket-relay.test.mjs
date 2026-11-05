import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { Duplex } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { listen } from "./listen.mjs";
import { relaySockets } from "./socket-relay.mjs";

// The client side of the relay. With `hold`, each write completes only when the test
// releases it, as when a slow reader keeps the kernel send buffer full and Node queues the
// chunk. destroy() discards held and buffered writes, as net.Socket cancels queued writes.
function relayClient({ hold }) {
  const held = [];
  const received = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const deliver = () => {
        received.push(chunk);
        callback();
      };
      if (hold) {
        held.push(deliver);
      } else {
        deliver();
      }
    },
  });
  return {
    socket,
    held,
    received: () => Buffer.concat(received),
    releaseOne: () => held.shift()?.(),
  };
}

test(
  "relay writes a closing upstream's queued tail to a slow client",
  { timeout: 20000 },
  async (t) => {
    // The credential gateway sends one response and closes its connection. The tail must
    // reach a slow client after that close; finding 2186 lost it mid TLS record.
    const payload = randomBytes(3 * 65536 + 1000);
    const port = await listen(
      t,
      createServer((socket) => socket.end(payload)),
    );
    const client = relayClient({ hold: true });
    const upstream = connect(port, "127.0.0.1");
    let heldAtUpstreamClose = 0;
    upstream.once("close", () => {
      heldAtUpstreamClose = client.held.length;
    });
    relaySockets(client.socket, upstream);

    // Release one held write at a time until the relay closes the client.
    for (let i = 0; i < 2000 && !client.socket.destroyed; i++) {
      await delay(5);
      client.releaseOne();
    }

    // Without a write still held at the upstream close, the race was not exercised.
    assert.ok(heldAtUpstreamClose > 0, "the upstream must close while a client write is held");
    const received = client.received();
    assert.equal(received.length, payload.length, "the client must receive every upstream byte");
    assert.ok(received.equals(payload), "the client must receive the upstream bytes unchanged");
    // The relay still closes the client, so no half-closed connection outlives the test.
    assert.equal(client.socket.destroyed, true, "the relay must close the client");
    assert.equal(
      client.socket.writableFinished,
      true,
      "the relay must close the client only after its queued writes finish",
    );
  },
);

test("relay destroys the client when the upstream resets", { timeout: 20000 }, async (t) => {
  // A reset must reach the client as a failure, never as a clean end of a truncated stream.
  const port = await listen(
    t,
    createServer((socket) => socket.write("partial", () => socket.resetAndDestroy())),
  );
  const client = relayClient({ hold: false });
  relaySockets(client.socket, connect(port, "127.0.0.1"));

  // An ended Duplex client would finish but never close: it never ends its readable side.
  await once(client.socket, "close", { signal: AbortSignal.timeout(5000) });
  assert.equal(client.socket.writableFinished, false);
});
