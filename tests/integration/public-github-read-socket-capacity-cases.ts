import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import type { Socket, TcpNetConnectOpts } from "node:net";
import type { TestContext, TestOptions } from "node:test";

export type ReaderResponse = {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
};

type ReaderConnection = { client: Socket; socket: Socket };
type ReaderSocketCapacityFixtures = {
  startReader: (t: TestContext) => Promise<{
    base: string;
    connect: (options?: Partial<TcpNetConnectOpts>) => Promise<ReaderConnection>;
    hold: (count: number, localAddress?: string) => Promise<ReaderConnection[]>;
  }>;
  request: (url: string, localAddress?: string) => Promise<ReaderResponse>;
  aliases: readonly [string, string, ...string[]];
  aliased: boolean;
  multipleCallers: TestOptions;
};

// The fixed answer to a connection over the per-address cap, as the client reads it.
const refusal =
  /^HTTP\/1\.1 429 Too Many Requests\r\n(?=[^]*\r\nretry-after: 1\r\n)(?=[^]*\r\nconnection: close\r\n)[^]*too many reader connections/;
// Unlike events.once, these never reject on the socket errors a reset produces.
function event(socket: Socket, name: "close" | "finish"): Promise<void> {
  return new Promise((resolve) => socket.once(name, () => resolve()));
}

function closed(socket: Socket): true | Promise<void> {
  return socket.closed || event(socket, "close");
}

// Everything a raw client reads until the reader ends or resets the connection.
function received(client: Socket): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    if (client.closed || client.readableEnded) {
      resolve(text);
      return;
    }
    client.setEncoding("utf8").on("data", (chunk) => {
      text += chunk;
    });
    client.once("end", () => resolve(text)).once("close", () => resolve(text));
  });
}

function responseMessage(body: unknown): string {
  assert.ok(
    typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string",
    "the reader returned a JSON message",
  );
  return body.message;
}

export async function runPublicGithubReadSocketCapacityCases(
  t: TestContext,
  { startReader, request, aliases, aliased, multipleCallers }: ReaderSocketCapacityFixtures,
): Promise<void> {
  await t.test(
    "idle sockets from one caller address cannot lock other callers out",
    // Room for the idle sockets' close (about 7 s, at most 15 s) and setup.
    aliased ? { timeout: 30_000 } : multipleCallers,
    async (st) => {
      const reader = await startReader(st);
      const [idler, other] = aliases;
      // One address opens 48 connections, the reader's whole budget without the per-address cap,
      // and never finishes its request headers. The reader keeps four and refuses the rest.
      const idle = await reader.hold(48, idler);
      const idling = Date.now();
      // Without the cap the reader is full and resets another caller until the idle sockets
      // time out (6 s, or about 30 s with Node's default check interval). With it, at once.
      const outcome = await request(reader.base + "/healthz", other).then(
        ({ status }) => status,
        (error: unknown) => {
          if (error instanceof Error && "code" in error && typeof error.code === "string") {
            return error.code;
          }
          throw error;
        },
      );
      assert.equal(outcome, 200, "another caller is answered while one address idles");
      // The idle sockets the reader did accept close at the 6 s headers timeout, checked
      // every second (about 7 s). Node checks that timeout in native code against the real
      // clock, so the wait is real; it ends when the last socket closes. Allow 15 s for loaded
      // runners: with Node's default 30 s check interval they would still be open.
      await Promise.all(idle.map(({ client }) => closed(client)));
      const elapsed = Date.now() - idling;
      assert.ok(elapsed < 15_000, `idle sockets closed after ${elapsed} ms`);
    },
  );
  await t.test(
    "a connection over the per-address cap is answered 429 and closed",
    { timeout: 15_000 },
    async (st) => {
      const reader = await startReader(st);
      // This address holds its four connections with unfinished request headers.
      const held = await reader.hold(4);
      const healthz = () => request(reader.base + "/healthz");
      // The fifth gets the documented retryable answer, not a reset (finding 1475).
      const refused = await healthz();
      assert.equal(refused.status, 429);
      assert.equal(refused.headers["retry-after"], "1");
      assert.equal(refused.headers.connection, "close");
      assert.match(responseMessage(refused.body), /too many reader connections/);
      // Once this address closes its connections, it is served again.
      held.forEach(({ client }) => client.destroy());
      const closing = Date.now();
      await Promise.all(held.map(({ socket }) => closed(socket)));
      assert.ok(Date.now() - closing < 5000, "the reader closes its side when the client does");
      const served = await healthz();
      assert.equal(served.status, 200);
      assert.equal(responseMessage(served.body), "ready");
    },
  );
  await t.test(
    "a refused connection closes when its client does or after one second, and at most eight wait",
    { timeout: 15_000 },
    async (st) => {
      // Only setTimeout is mocked: the one-second refusal timer fires only when this test
      // ticks, so every close before a tick is the client's doing.
      st.mock.timers.enable({ apis: ["setTimeout"] });
      const reader = await startReader(st);
      await reader.hold(4);
      // A refused connection whose client stays half-open until the test closes it.
      const refused = async () => {
        const connection = await reader.connect({ allowHalfOpen: true });
        assert.match(await received(connection.client), refusal);
        return connection;
      };

      // A client that reads the answer and closes frees its refused connection at once.
      const reading = await reader.connect();
      assert.match(await received(reading.client), refusal);
      await closed(reading.socket);

      // A request still arriving after the answer is drained, not reset: the client reads
      // the answer once it has sent the rest of its request.
      const slow = await reader.connect();
      const [start, rest] = ["GET /healthz HTTP/1.1\r\n", "Host: reader\r\n\r\n"];
      slow.client.pause().write(start);
      await Promise.race([
        slow.socket.writableFinished || event(slow.socket, "finish"),
        closed(slow.socket),
      ]);
      slow.client.write(rest);
      // Keep the answer unread until the reader has read the whole request or the
      // connection is gone.
      while (slow.socket.bytesRead < (start + rest).length && !slow.client.closed) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const late = received(slow.client);
      slow.client.resume();
      assert.match(await late, refusal);
      await closed(slow.socket);

      // A client that resets its connection must not crash the reader with an unhandled
      // socket error.
      const reset = await refused();
      reset.client.resetAndDestroy();
      await closed(reset.socket);

      // A client that never closes is closed after one second.
      const lingering = await refused();
      st.mock.timers.tick(999);
      assert.equal(lingering.socket.destroyed, false);
      st.mock.timers.tick(1);
      assert.equal(lingering.socket.destroyed, true);
      await closed(lingering.socket);

      // Eight refused connections can wait for their clients; the ninth closes unanswered
      // until one of them closes.
      const firstWaiting = await refused();
      for (let count = 1; count < 8; count++) {
        await refused();
      }
      const ninth = await reader.connect({ allowHalfOpen: true });
      assert.equal(await received(ninth.client), "");
      firstWaiting.client.end();
      await closed(firstWaiting.socket);
      await refused();
    },
  );
}
