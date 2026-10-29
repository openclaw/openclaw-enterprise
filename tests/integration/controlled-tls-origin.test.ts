import assert from "node:assert/strict";
import { once } from "node:events";
import {
  Server as HttpServer,
  type RequestListener,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Agent, createServer, request as httpsRequest } from "node:https";
import { buffer } from "node:stream/consumers";
import test from "node:test";
import {
  assertSingleRequestWindow,
  verifiedTlsClient,
  assertApplicationConnections,
  observeGrantedSend,
  singleRequestTlsOrigin,
  controlledTlsOriginScenario,
} from "../helpers/controlled-tls-origin-scenario.ts";
import { controlledTlsOrigin } from "../helpers/controlled-tls-origin.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { listen } from "../helpers/listen.mjs";

for (const size of [14, 256 * 1024]) {
  for (const observed of [false, true]) {
    test(
      `TLS ${observed ? "observer" : "ordinary server"} preserves ${size} bytes for a delayed consumer`,
      { timeout: 5000 },
      async (t) => {
        const tls = await harnessTlsFixture(t);
        const entered = Promise.withResolvers<void>();
        const proceed = Promise.withResolvers<void>();
        const consumed = Promise.withResolvers<Buffer>();
        const handle: RequestListener = async (request, response) => {
          request.pause();
          entered.resolve();
          await proceed.promise;
          try {
            consumed.resolve(await buffer(request));
            response.end("ok");
          } catch (error) {
            consumed.reject(error);
          }
        };
        const origin = observed ? controlledTlsOrigin(tls, handle) : createServer(tls, handle);
        const port = await listen(t, origin);
        const client = await verifiedTlsClient(t, port, tls.caBundle);
        const body = Buffer.alloc(size, "x");
        const headers = `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${body.length}\r\n\r\n`;
        client.write(Buffer.concat([Buffer.from(headers), body]));
        await entered.promise;
        // Let the listener return and queued stream work run before it takes ownership
        // of consumption. The larger body also exercises transport backpressure.
        await new Promise<void>((resolve) => setImmediate(resolve));
        proceed.resolve();
        const received = await consumed.promise;
        assert.equal(received.byteLength, body.byteLength);
        assert.ok(received.equals(body));
        if ("snapshot" in origin) {
          assert.equal(origin.snapshot().completeRequests, 1);
          assert.equal(origin.snapshot().decryptedBytes, Buffer.byteLength(headers) + body.length);
        }
      },
    );
  }
}

for (const behavior of ["consume", "drain", "answer"] as const) {
  test(`TLS observer preserves a synchronous ${behavior} handler`, { timeout: 5000 }, async (t) => {
    const tls = await harnessTlsFixture(t);
    const chunks: Buffer[] = [];
    const origin = controlledTlsOrigin(tls, (request, response) => {
      if (behavior === "answer") {
        // Ordinary Node response completion discards an unread request body.
        response.end("ok");
        return;
      }
      request.on("end", () => response.end("ok"));
      if (behavior === "consume") {
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
      } else {
        request.resume();
      }
    });
    const port = await listen(t, origin);
    const body = "public-fixture";
    const reply = new Promise<Buffer>((resolve, reject) => {
      const client = httpsRequest(
        {
          hostname: "127.0.0.1",
          port,
          servername: "localhost",
          ca: tls.caBundle,
          method: "POST",
          headers: { "Content-Length": Buffer.byteLength(body) },
        },
        (response) => {
          buffer(response).then(resolve, reject);
        },
      );
      t.after(() => client.destroy());
      client.on("error", reject);
      client.end(body);
    });
    assert.equal((await reply).toString(), "ok");
    assert.equal(origin.snapshot().completeRequests, 1);
    if (behavior === "consume") {
      assert.equal(Buffer.concat(chunks).toString(), body);
    }
  });
}

// TODO: The sender integration owner must qualify denied-send acceptance with
// an actual product sender. f.send is test-owned transport, so skipping it after
// an authority refusal cannot prove that a sender suppresses outbound bytes.
// The following controls qualify only the observer using real loopback TLS.
const request = "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\nok";

for (const [part, partial] of [
  ["headers", "POST / HTTP/1.1\r\nAuthorization: synthetic"],
  ["body", "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20\r\n\r\npartial"],
] as const) {
  test(
    `TLS origin counts partial ${part} after a drained reusable connection barrier`,
    { timeout: 10000 },
    async (t) => {
      const scenario = await controlledTlsOriginScenario(t);
      const { origin } = scenario;
      const socket = await scenario.connect();
      await scenario.writeAndDrain(socket, request);
      assert.equal(origin.snapshot().completeRequests, 1);
      assert.equal(origin.snapshot().decryptedBytes, Buffer.byteLength(request));
      const connection = origin.snapshot().connections[0];
      assert.ok(connection);
      const socketId = connection.socketId;
      // The complete reply acknowledges the first request. This test owns the
      // next write, so marking before it is a deterministic instrument barrier.
      const mark = origin.mark();
      assert.equal(origin.since(mark).decryptedBytes, 0);
      await scenario.writeAndObserve(
        socket,
        partial,
        (s) => s.decryptedBytes === Buffer.byteLength(request + partial),
      );
      assert.deepEqual(origin.since(mark), {
        decryptedBytes: Buffer.byteLength(partial),
        completeRequests: 0,
        droppedRequests: 0,
        connections: [
          {
            socketId,
            decryptedBytes: Buffer.byteLength(partial),
            completeRequests: 0,
            droppedRequests: 0,
          },
        ],
      });
      assert.equal(
        origin.snapshot().connections.length,
        1,
        "the partial request reused the authenticated socket",
      );
      const closed = once(socket, "close");
      socket.destroy();
      await closed;
      assert.equal(origin.since(mark).decryptedBytes, Buffer.byteLength(partial));
    },
  );
}

test(
  "TLS observer counts duplicate complete requests on new and reused sockets",
  { timeout: 10000 },
  async (t) => {
    const scenario = await controlledTlsOriginScenario(t);
    const { origin } = scenario;
    const first = await scenario.connect();
    const mark = origin.mark();
    await scenario.writeAndDrain(first, request);
    assert.equal(origin.since(mark).completeRequests, 1);
    assert.equal(origin.since(mark).decryptedBytes, Buffer.byteLength(request));
    const second = await scenario.connect();
    await scenario.writeAndDrain(second, request);
    assert.equal(
      origin.since(mark).completeRequests,
      2,
      "a second socket must not hide a duplicate",
    );
    assert.equal(origin.since(mark).decryptedBytes, 2 * Buffer.byteLength(request));
    assert.deepEqual(
      origin.snapshot().connections.map((row) => row.completeRequests),
      [1, 1],
    );
    await scenario.writeAndDrain(first, request);
    assert.equal(
      origin.since(mark).completeRequests,
      3,
      "a reused socket must not hide a duplicate",
    );
  },
);

test(
  "TLS handshake alone has zero application bytes; a new connection's partial request is counted",
  { timeout: 10000 },
  async (t) => {
    const scenario = await controlledTlsOriginScenario(t);
    const { origin } = scenario;
    const mark = origin.mark();
    const socket = await scenario.connect();
    await scenario.observe((s) => s.connections.length === 1);
    assert.equal(origin.since(mark).decryptedBytes, 0);
    assert.equal(origin.since(mark).completeRequests, 0);
    const partial = "GET /";
    await scenario.writeAndObserve(
      socket,
      partial,
      (s) => s.decryptedBytes === Buffer.byteLength(partial),
    );
    assert.equal(origin.since(mark).decryptedBytes, Buffer.byteLength(partial));
    assert.equal(origin.since(mark).completeRequests, 0);
  },
);

test(
  "TLS origin does not count headers as a completed request and counts pipelined requests separately",
  { timeout: 10000 },
  async (t) => {
    const scenario = await controlledTlsOriginScenario(t);
    const { origin } = scenario;
    const socket = await scenario.connect();
    const headers = request.slice(0, -2);
    await scenario.writeAndObserve(
      socket,
      headers,
      (s) => s.decryptedBytes === Buffer.byteLength(headers),
    );
    assert.equal(origin.snapshot().completeRequests, 0);
    await scenario.writeAndObserve(socket, "ok" + request, (s) => s.completeRequests === 2);
    assert.equal(origin.snapshot().decryptedBytes, 2 * Buffer.byteLength(request));
    assert.deepEqual(
      origin.snapshot().connections.map((row) => row.completeRequests),
      [2],
    );
  },
);

for (const observed of [false, true]) {
  test(
    `TLS ${observed ? "observer" : "ordinary server"} delivers incomplete request timeout`,
    { timeout: 3000 },
    async (t) => {
      const tls = await harnessTlsFixture(t);
      let callbacks = 0;
      const handle: RequestListener = (request) => {
        request.setTimeout(30, () => {
          callbacks++;
          request.destroy();
        });
        request.resume();
      };
      const origin = observed ? controlledTlsOrigin(tls, handle) : createServer(tls, handle);
      const port = await listen(t, origin);
      const client = await verifiedTlsClient(t, port, tls.caBundle);
      const closed = once(client, "close");
      client.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nx");
      await closed;
      assert.equal(callbacks, 1, "the HTTP timeout, not teardown, closes the incomplete request");
      if ("snapshot" in origin) {
        assert.equal(origin.snapshot().completeRequests, 0);
      }
    },
  );
}

test(
  "TLS observer socket timeout callbacks retain receiver and once semantics",
  { timeout: 3000 },
  async (t) => {
    const tls = await harnessTlsFixture(t);
    let callbacks = 0;
    let events = 0;
    const receivers: unknown[] = [];
    let parserSocket: unknown;
    const origin = controlledTlsOrigin(tls, (request) => {
      const socket = request.socket;
      parserSocket = socket;
      // Keep the HTTP timeout listener from closing on the first event so that
      // a second real timer expiry can prove the optional callback is once-only.
      request.on("timeout", () => {});
      socket.setTimeout(30, function (this: typeof socket) {
        receivers.push(this);
        callbacks++;
      });
      socket.on("timeout", () => {
        events++;
        if (events === 1) {
          socket.setTimeout(30);
        } else {
          socket.destroy();
        }
      });
      request.resume();
    });
    const port = await listen(t, origin);
    const client = await verifiedTlsClient(t, port, tls.caBundle);
    const closed = once(client, "close");
    client.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nx");
    await closed;
    assert.equal(events, 2);
    assert.equal(callbacks, 1);
    assert.equal(receivers[0], parserSocket);
  },
);

test(
  "TLS observer closes an idle keep-alive connection through HTTP timeout",
  { timeout: 10000 },
  async (t) => {
    const scenario = await controlledTlsOriginScenario(t);
    const client = await scenario.connect();
    const closed = once(client, "close");
    await scenario.writeAndDrain(client, request);
    // Node owns the ordinary keep-alive deadline (including its timeout buffer).
    // The test timeout is only a watchdog; no test timer closes this connection.
    client.resume();
    await closed;
    assert.equal(scenario.origin.snapshot().completeRequests, 1);
  },
);

test(
  "allowed-send assertion rejects a second socket fragment beside a complete request",
  { timeout: 5000 },
  async (t) => {
    const scenario = await controlledTlsOriginScenario(t);
    const complete = await scenario.connect();
    const fragment = await scenario.connect();
    const positive = scenario.origin.mark();
    await scenario.writeAndDrain(complete, request);
    // A handshake-only connection is permissible.
    assertSingleRequestWindow(scenario.origin.since(positive));
    const mixed = scenario.origin.mark();
    const before = scenario.origin.snapshot().decryptedBytes;
    await scenario.writeAndObserve(fragment, "GET /", (s) => s.decryptedBytes === before + 5);
    await scenario.writeAndDrain(complete, request);
    const observation = scenario.origin.since(mixed);
    assert.equal(observation.completeRequests, 1);
    assert.deepEqual(
      observation.connections.map((row) => row.completeRequests),
      [1, 0],
    );
    assert.equal(observation.connections[1]?.decryptedBytes, 5);
    assert.throws(
      () => assertSingleRequestWindow(observation),
      /one application-bearing connection/,
    );
  },
);

for (const priorSend of [false, true]) {
  for (const phase of ["before grant request", "while awaiting grant", "legitimate"] as const) {
    test(
      `TLS granted send ${phase} with ${priorSend ? "acknowledged" : "zero"} baseline`,
      { timeout: 5000 },
      async (t) => {
        const tls = await harnessTlsFixture(t);
        const handled: string[] = [];
        const origin = singleRequestTlsOrigin(tls, async (request, response) => {
          const body = await buffer(request);
          handled.push(body.toString());
          response.end("ok");
        });
        const port = await listen(t, origin);
        const send = (agent: Agent | false) =>
          new Promise<string>((resolve, reject) => {
            const outgoing = httpsRequest(
              {
                host: "127.0.0.1",
                port,
                servername: "localhost",
                ca: tls.caBundle,
                method: "POST",
                agent,
              },
              (response) => {
                buffer(response)
                  .then((body) => {
                    assert.equal(response.statusCode, 200);
                    resolve(body.toString());
                  })
                  .catch(reject);
              },
            );
            outgoing.on("error", reject);
            outgoing.end("public-fixture");
          });
        if (priorSend) {
          assert.equal(await send(false), "ok");
        }
        // Keep the last acknowledged total; never adopt an already dirty snapshot.
        const baseline = origin.snapshot().decryptedBytes;
        const client = await verifiedTlsClient(t, port, tls.caBundle);
        const agent = new Agent({ keepAlive: false });
        agent.createConnection = () => client;
        t.after(() => agent.destroy());
        const earlyBytes = async () => {
          client.write("\r\n");
          while (origin.snapshot().decryptedBytes !== baseline + 2) {
            await once(origin, "observation");
          }
        };
        if (phase === "before grant request") {
          await earlyBytes();
        }
        const grant = Promise.withResolvers<void>();
        const requested = Promise.withResolvers<void>();
        let sends = 0;
        // This gate controls test-owned grant delivery, not IAM behavior. The
        // shared orchestration is also used around the real authorization suite.
        const pending = observeGrantedSend(
          origin,
          baseline,
          async () => {
            requested.resolve();
            await grant.promise;
          },
          () => {
            sends++;
            return send(agent);
          },
        );
        await requested.promise;
        if (phase === "while awaiting grant") {
          await earlyBytes();
        }
        if (phase === "legitimate") {
          grant.resolve();
          assert.equal(await pending, "ok");
          assert.equal(sends, 1);
          assert.equal(handled.length, priorSend ? 2 : 1);
          assert.ok(handled.every((body) => body === "public-fixture"));
        } else {
          const rejected = assert.rejects(pending, /origin bytes changed before granted send/);
          grant.resolve();
          await rejected;
          assert.equal(sends, 0);
          assert.equal(handled.length, priorSend ? 1 : 0);
          assert.equal(origin.snapshot().decryptedBytes, baseline + 2);
        }
      },
    );
  }
}

for (const capped of [false, true]) {
  test(
    `TLS ${capped ? "capped" : "generic"} origin enforces parser admission on a pipelined pair`,
    { timeout: 5000 },
    async (t) => {
      const tls = await harnessTlsFixture(t);
      const dispatched: string[] = [];
      const handle: RequestListener = (request, response) => {
        dispatched.push(request.url ?? "");
        request.resume();
        response.end("ok");
      };
      const origin = capped
        ? singleRequestTlsOrigin(tls, handle)
        : controlledTlsOrigin(tls, handle);
      const port = await listen(t, origin);
      const client = await verifiedTlsClient(t, port, tls.caBundle);
      const beforePair = origin.mark();
      let reply = "";
      const send = async () => {
        // Both requests are available to the parser before either reply.
        client.write(
          "GET /ok HTTP/1.1\r\nHost: localhost\r\n\r\nGET /unexpected HTTP/1.1\r\nHost: localhost\r\n\r\n",
        );
        for await (const chunk of client.iterator({ destroyOnReturn: false })) {
          reply += chunk.toString();
          if ([...reply.matchAll(/HTTP\/1\.1 (\d{3})/g)].length === 2) {
            break;
          }
        }
        return reply;
      };
      if (capped) {
        await assert.rejects(
          observeGrantedSend(origin, 0, async () => {}, send),
          /no native parser drops/,
        );
      } else {
        await send();
      }
      assert.deepEqual(
        [...reply.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) => match[1]),
        capped ? ["200", "503"] : ["200", "200"],
      );
      assert.deepEqual(dispatched, capped ? ["/ok"] : ["/ok", "/unexpected"]);
      assert.equal(origin.snapshot().droppedRequests, capped ? 1 : 0);
      assert.equal(origin.since(beforePair).droppedRequests, capped ? 1 : 0);
      if (capped) {
        const closed = once(client, "close");
        client.destroy();
        await closed;
        // A later mark must not erase a parser drop on the now-closed connection.
        const afterDrop = origin.mark();
        assert.equal(origin.since(afterDrop).droppedRequests, 0);
        assert.throws(
          () => assertApplicationConnections(origin.snapshot(), 1),
          /no native parser drops/,
        );
        assert.deepEqual(
          origin.snapshot().connections.map((row) => row.droppedRequests),
          [1],
        );
      }
    },
  );
}

for (const kind of ["ordinary", "generic", "capped"] as const) {
  test(
    `TLS ${kind} request listener retains its server receiver and registration`,
    { timeout: 5000 },
    async (t) => {
      const tls = await harnessTlsFixture(t);
      const receivers: HttpServer[] = [];
      let registrations = 0;
      function handle(this: HttpServer, request: IncomingMessage, response: ServerResponse) {
        receivers.push(this);
        registrations =
          this?.listeners("request").filter((listener) => listener === handle).length ?? 0;
        request.resume();
        response.end("ok");
      }
      let origin;
      if (kind === "ordinary") {
        origin = createServer(tls, handle);
      } else if (kind === "capped") {
        origin = singleRequestTlsOrigin(tls, handle);
      } else {
        origin = controlledTlsOrigin(tls, handle);
      }
      const port = await listen(t, origin);
      const client = await verifiedTlsClient(t, port, tls.caBundle);
      client.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      assert.match((await buffer(client)).toString(), /^HTTP\/1\.1 200/);
      assert.equal(registrations, 1);
      const receiver = receivers[0];
      if (kind === "ordinary") {
        assert.equal(receiver, origin);
      } else {
        assert.ok(receiver instanceof HttpServer);
        assert.equal(receiver.maxRequestsPerSocket, kind === "capped" ? 1 : 0);
      }
    },
  );
}
