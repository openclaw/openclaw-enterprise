import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { Duplex } from "node:stream";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createSlackProxyServer } from "../../apps/controller/src/slack-proxy.mjs";
import { refusingPort } from "../helpers/available-port.mjs";
import { connectThroughProxy, startSlackProxy } from "../helpers/slack-proxy.mjs";

// The bundled Slack proxy (apps/controller/src/slack-proxy.mjs) relays CONNECT tunnels only.
// These tests drive the real proxy process against loopback upstreams: startSlackProxy
// redirects its slack.com:443 connections to a local port, so nothing leaves the host.

// Bounds every wait, so a proxy that stops relaying fails the test instead of hanging it.
const WAIT_MS = 10_000;
const testOptions = { timeout: 60_000 };

function bound(promise, what, ms = WAIT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function listen(t, onConnection, options = {}) {
  const server = net.createServer(options, onConnection);
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  });
  return server;
}

// Collects everything a socket reads, and when its peer's EOF ('end') and its own close came.
function record(socket) {
  const chunks = [];
  let sawEnd = false;
  socket.on("data", (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve) => {
    socket.once("end", () => {
      sawEnd = true;
      resolve();
    });
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  return { bytes: () => Buffer.concat(chunks), ended, closed, sawEnd: () => sawEnd };
}

// Sends `CONNECT target` to the proxy, with `early` bytes in the same write (the proxy gets
// them as the CONNECT request's head), and resolves once the response head has arrived.
// `body()` is what the client has received after the response head so far.
async function openTunnel(t, proxyPort, target, early = Buffer.alloc(0)) {
  const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  const received = record(socket);
  await bound(new Promise((resolve) => socket.once("connect", resolve)), "proxy connect");
  socket.write(
    Buffer.concat([Buffer.from(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`), early]),
  );
  const headEnd = await bound(
    new Promise((resolve, reject) => {
      const check = () => {
        const index = received.bytes().indexOf("\r\n\r\n");
        if (index !== -1) {
          socket.off("data", check);
          resolve(index + 4);
        }
      };
      socket.on("data", check);
      socket.once("close", () => reject(new Error(`proxy closed: ${received.bytes()}`)));
    }),
    `CONNECT ${target} response`,
  );
  const head = received.bytes().subarray(0, headEnd).toString("latin1");
  return {
    socket,
    head,
    body: () => received.bytes().subarray(headEnd),
    ended: received.ended,
    closed: received.closed,
    sawEnd: received.sawEnd,
  };
}

const established = /^HTTP\/1\.1 200 Connection Established\r\n/;

test("a CONNECT tunnel relays bytes both ways and both ends see EOF", testOptions, async (t) => {
  // An echo upstream that keeps its write side open after the client's EOF, so the reply can
  // only finish if the proxy relays that EOF upstream. The proxy closes the client once the
  // upstream finishes, both by ending the pipe and on the upstream's close; the client sees
  // the same EOF either way, so this test does not tell those two paths apart.
  const upstreamSeen = [];
  const upstream = await listen(
    t,
    (socket) => {
      socket.on("error", () => {});
      const seen = record(socket);
      upstreamSeen.push(seen);
      socket.pipe(socket);
    },
    { allowHalfOpen: true },
  );
  const { port: proxyPort } = await startSlackProxy(t, { upstreamPort: upstream.address().port });

  // Bytes sent with the CONNECT request itself, then a payload far larger than one TCP read.
  const early = randomBytes(1_024);
  const payload = randomBytes(4 * 1024 * 1024);
  const sent = Buffer.concat([early, payload]);
  const tunnel = await openTunnel(t, proxyPort, "slack.com:443", early);
  assert.match(tunnel.head, established);
  tunnel.socket.end(payload);

  await bound(tunnel.ended, "client EOF");
  assert.equal(upstreamSeen.length, 1);
  await bound(upstreamSeen[0].ended, "upstream EOF");
  assert.ok(upstreamSeen[0].bytes().equals(sent), "the upstream received every byte in order");
  assert.ok(tunnel.body().equals(sent), "the client received every echoed byte in order");
  await bound(tunnel.closed, "client close");
  await bound(upstreamSeen[0].closed, "upstream close");
});

test(
  "a CONNECT tunnel delivers a large upstream reply in full to a slow client",
  testOptions,
  async (t) => {
    const reply = randomBytes(8 * 1024 * 1024);
    const upstream = await listen(t, (socket) => {
      socket.on("error", () => {});
      socket.end(reply);
    });
    const { port: proxyPort } = await startSlackProxy(t, { upstreamPort: upstream.address().port });

    const tunnel = await openTunnel(t, proxyPort, "slack.com:443");
    assert.match(tunnel.head, established);
    // Read nothing for a moment while the upstream writes its reply and closes. The proxy must
    // respect the slow client's backpressure and still deliver the whole reply before EOF.
    tunnel.socket.pause();
    await new Promise((resolve) => setTimeout(resolve, 500));
    tunnel.socket.resume();
    await bound(tunnel.closed, "client close");
    assert.equal(tunnel.body().length, reply.length, "the client received the whole reply");
    assert.ok(tunnel.body().equals(reply), "the client received the reply in order");
    assert.ok(tunnel.sawEnd(), "the client saw a clean EOF");
  },
);

// Drives createSlackProxyServer in this process with a client socket whose writes complete only
// when the test says so, as writes do behind a full TCP send buffer. A real slow client only
// reaches that state when the kernel buffers happen to be full, so the loopback test above
// rarely catches a proxy that drops queued bytes; this one does every time. `upstreamSocket()`
// is the proxy's own socket to the upstream, redirected to `upstreamPort`.
function heldClientTunnel(t, upstreamPort, serverOptions) {
  const connect = net.connect;
  let upstreamSocket;
  t.mock.method(net, "connect", (options, ...rest) => {
    upstreamSocket = connect({ ...options, host: "127.0.0.1", port: upstreamPort }, ...rest);
    return upstreamSocket;
  });
  const chunks = [];
  const held = [];
  let finished = false;
  let reset = false;
  const client = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      held.push(callback);
    },
    final(callback) {
      finished = true;
      callback();
    },
  });
  // A net.Socket closes with a TCP reset here; record it.
  client.resetAndDestroy = () => {
    reset = true;
    return client.destroy();
  };
  client.on("error", () => {});
  t.after(() => client.destroy());
  const closed = new Promise((resolve) => client.once("close", resolve));
  const server = createSlackProxyServer(serverOptions);
  server.emit("connect", { url: "slack.com:443" }, client, Buffer.alloc(0));
  return {
    client,
    closed,
    upstreamSocket: () => upstreamSocket,
    held,
    bytes: () => Buffer.concat(chunks),
    finished: () => finished,
    reset: () => reset,
  };
}

test(
  "a CONNECT tunnel flushes bytes still queued for the client after the upstream closes",
  testOptions,
  async (t) => {
    // Smaller than the client's high-water mark, so the pipe never pauses the upstream: its EOF
    // and close reach the proxy while the reply still waits behind the first held write.
    const reply = randomBytes(1_024);
    const upstream = await listen(t, (socket) => {
      socket.on("error", () => {});
      socket.end(reply);
    });
    const tunnel = heldClientTunnel(t, upstream.address().port);

    await bound(
      new Promise((resolve) => tunnel.upstreamSocket().once("close", resolve)),
      "upstream close",
    );
    // Let the proxy's own close listener on the same socket run.
    await nextTurn();
    assert.ok(tunnel.client.writableEnded, "the proxy ended the client after the upstream EOF");
    assert.ok(tunnel.client.writableLength > 0, "the reply is still queued for the client");
    assert.equal(tunnel.client.destroyed, false, "the proxy keeps a client that is still reading");

    // The client reads everything, then closes its side.
    while (tunnel.held.length > 0) {
      tunnel.held.shift()();
      await nextTurn();
    }
    assert.ok(tunnel.finished(), "the client saw a clean EOF");
    const body = tunnel.bytes().subarray(tunnel.bytes().indexOf("\r\n\r\n") + 4);
    assert.match(tunnel.bytes().toString("latin1"), established);
    assert.ok(body.equals(reply), "the client received the whole reply");
    tunnel.client.push(null);
    await bound(tunnel.closed, "client close");
    assert.equal(tunnel.reset(), false, "a drained client gets a clean close");
  },
);

test(
  "a client byte after the upstream's EOF does not cut the complete reply",
  testOptions,
  async (t) => {
    const reply = randomBytes(1_024);
    const upstream = await listen(t, (socket) => {
      socket.on("error", () => {});
      socket.end(reply);
    });
    const tunnel = heldClientTunnel(t, upstream.address().port);
    // The client sends a byte just as the upstream's EOF has ended the proxy's upstream socket,
    // so piping it upstream fails (EPIPE) after the whole reply has arrived.
    const upstreamErrors = [];
    tunnel.upstreamSocket().once("error", (error) => upstreamErrors.push(error.code));
    tunnel.upstreamSocket().once("finish", () => tunnel.client.push("late-client-byte"));

    await bound(
      new Promise((resolve) => tunnel.upstreamSocket().once("close", resolve)),
      "upstream close",
    );
    await nextTurn();
    assert.deepEqual(upstreamErrors, ["EPIPE"], "the late byte failed upstream");
    assert.equal(tunnel.client.destroyed, false, "the proxy keeps a client that is still reading");

    while (tunnel.held.length > 0) {
      tunnel.held.shift()();
      await nextTurn();
    }
    assert.ok(tunnel.finished(), "the client saw a clean EOF");
    const body = tunnel.bytes().subarray(tunnel.bytes().indexOf("\r\n\r\n") + 4);
    assert.ok(body.equals(reply), "the client received the whole reply");
    tunnel.client.push(null);
    await bound(tunnel.closed, "client close");
    assert.equal(tunnel.reset(), false, "a complete reply gets a clean close");
  },
);

test(
  "a client that never reads its queued bytes is reset after the drain timeout",
  testOptions,
  async (t) => {
    const upstream = await listen(t, (socket) => {
      socket.on("error", () => {});
      socket.end("never-read");
    });
    const tunnel = heldClientTunnel(t, upstream.address().port, { clientDrainTimeoutMs: 1_000 });

    await bound(
      new Promise((resolve) => tunnel.upstreamSocket().once("close", resolve)),
      "upstream close",
    );
    await nextTurn();
    assert.equal(tunnel.client.destroyed, false, "the client gets time to read");
    await bound(tunnel.closed, "client close after the drain timeout");
    assert.equal(tunnel.finished(), false, "the stuck client never got a clean EOF");
    assert.ok(tunnel.reset(), "a cut reply ends in a reset, not a clean close");
  },
);

test("an unreachable upstream gets 502 and the proxy keeps serving", testOptions, async (t) => {
  // A held port refuses connections until the upstream below takes it. A released port could
  // be taken by a test running in parallel.
  const refusing = await refusingPort();
  t.after(() => refusing.release());
  const upstreamPort = refusing.port;
  const { child, port: proxyPort, stderr } = await startSlackProxy(t, { upstreamPort });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await bound(connectThroughProxy(proxyPort, "slack.com:443"), "502 response");
    assert.match(response, /^HTTP\/1\.1 502 Bad Gateway\r\n/);
  }
  assert.match(
    await bound(connectThroughProxy(proxyPort, "example.com:443"), "403 response"),
    /^HTTP\/1\.1 403 Forbidden\r\n/,
  );

  // The same proxy relays once the upstream is reachable.
  const upstream = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.end("upstream-ready");
  });
  const listenUpstream = () =>
    new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(upstreamPort, "127.0.0.1", () => {
        upstream.off("error", reject);
        resolve();
      });
    });
  // Bind while the port is still held, so nothing can take it in between. Linux allows that
  // (both sockets set SO_REUSEADDR and the held one does not listen); where the platform
  // refuses, release the port first.
  try {
    await listenUpstream();
  } catch (error) {
    if (error.code !== "EADDRINUSE") {
      throw error;
    }
    await refusing.release();
    await listenUpstream();
  }
  t.after(() => upstream.close());
  await refusing.release();
  const tunnel = await openTunnel(t, proxyPort, "slack.com:443");
  assert.match(tunnel.head, established);
  await bound(tunnel.closed, "client close");
  assert.equal(tunnel.body().toString(), "upstream-ready");
  assert.equal(child.exitCode, null, stderr());
});

test(
  "an upstream reset closes an open tunnel and the proxy keeps serving",
  testOptions,
  async (t) => {
    let connections = 0;
    const upstream = await listen(t, (socket) => {
      connections += 1;
      socket.on("error", () => {});
      if (connections === 1) {
        socket.once("data", () => socket.resetAndDestroy());
      } else {
        socket.end("second-tunnel");
      }
    });
    const {
      child,
      port: proxyPort,
      stderr,
    } = await startSlackProxy(t, {
      upstreamPort: upstream.address().port,
    });

    const reset = await openTunnel(t, proxyPort, "slack.com:443");
    assert.match(reset.head, established);
    const errors = [];
    reset.socket.on("error", (error) => errors.push(error.code));
    reset.socket.write("ping");
    await bound(reset.closed, "client close after the upstream reset");
    // Once the tunnel is open, a failure only closes it: no status line goes into the stream.
    assert.equal(reset.body().length, 0, `unexpected bytes after the reset: ${reset.body()}`);
    // A reset, not a clean EOF, so the client cannot take a cut reply as whole.
    assert.equal(reset.sawEnd(), false, "the client saw no clean EOF");
    assert.deepEqual(errors, ["ECONNRESET"]);

    const next = await openTunnel(t, proxyPort, "slack.com:443");
    assert.match(next.head, established);
    await bound(next.closed, "second tunnel close");
    assert.equal(next.body().toString(), "second-tunnel");
    assert.equal(child.exitCode, null, stderr());
  },
);

test("the CONNECT allowlist matches whole Slack host names on port 443", testOptions, async (t) => {
  const upstream = await listen(t, (socket) => {
    socket.on("error", () => {});
    socket.end("fixture-upstream");
  });
  const { port: proxyPort } = await startSlackProxy(t, {
    upstreamPort: upstream.address().port,
    upstreamHosts: [
      "slack.com",
      "slack-edge.com",
      "slack-msgs.com",
      "wss-primary.slack.com",
      "a.slack-edge.com",
      "b.slack-msgs.com",
    ],
  });

  // Allowed: the Slack apex, Slack subdomains, and any letter case (DNS names are not
  // case-sensitive). The redirect sends each to the local upstream.
  for (const target of [
    "slack.com:443",
    "slack-edge.com:443",
    "slack-msgs.com:443",
    "wss-primary.slack.com:443",
    "a.slack-edge.com:443",
    "b.slack-msgs.com:443",
    "Slack.COM:443",
    "WSS-Primary.Slack.com:443",
  ]) {
    const tunnel = await openTunnel(t, proxyPort, target);
    assert.match(tunnel.head, established, target);
    await bound(tunnel.closed, `${target} close`);
    assert.equal(tunnel.body().toString(), "fixture-upstream", target);
  }

  // Refused with 403: other hosts, look-alikes, other ports, and targets where a Slack name is
  // only part of the authority.
  for (const target of [
    "example.com:443",
    "evilslack.com:443",
    "slack.com.evil.example:443",
    "a.slack.com.evil.example:443",
    "slack.com:80",
    "slack.com:8443",
    "x@slack.com:443",
    "evil.example/slack.com:443",
    "slack.com:443@evil.example",
    "slack.com:443/x",
    "slack.com:443x",
  ]) {
    assert.match(
      await bound(connectThroughProxy(proxyPort, target), `${target} response`),
      /^HTTP\/1\.1 403 Forbidden\r\n/,
      target,
    );
  }
});
