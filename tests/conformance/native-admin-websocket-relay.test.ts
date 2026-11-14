import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { IncomingMessage } from "node:http";
import { createServer } from "node:https";
import { Socket } from "node:net";
import type { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import {
  proxyNativeAdminWebSocket,
  type NativeAdminWebSocketCloseCause,
} from "../../apps/controller/src/gateway/native-admin-proxy.ts";
import { selfSigned } from "../helpers/certificates.mjs";
import { listen } from "../helpers/listen.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { within } from "../helpers/wait-for.mjs";

// Drives proxyNativeAdminWebSocket in this process against a loopback HTTPS gateway, with a
// browser socket whose writes complete only when the test says so, as writes do behind a full
// TCP send buffer. A real slow browser only reaches that state when the kernel buffers happen
// to be full, so a loopback test would rarely catch a relay that drops queued bytes.

const testOptions = { timeout: 60_000 };
const agentOrigin = "https://agent.native.example";

// A gateway that answers the upgrade with 101, sends `reply` and closes its side.
async function startGateway(t: TestContext, reply: Buffer) {
  const directory = await temporaryDirectory(t, "openclaw-native-admin-relay-");
  const { key, cert } = await selfSigned(directory);
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, cert]);
  t.after(() => setDefaultCACertificates(previous));

  const server = createServer({ key, cert }, (_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (_request, socket) => {
    socket.on("error", () => {});
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    socket.end(reply);
  });
  return listen(t, server);
}

// Hold each write until the test releases it to model a full TCP send buffer.
class HeldBrowserSocket extends Socket {
  readonly chunks: Buffer[] = [];
  readonly heldWrites: Array<(error?: Error | null) => void> = [];
  finished = false;
  reset = false;

  override _read(): void {}

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk);
    this.heldWrites.push(callback);
  }

  override _writev(
    writes: Array<{ chunk: string | Buffer; encoding: BufferEncoding }>,
    callback: (error?: Error | null) => void,
  ): void {
    for (const { chunk, encoding } of writes) {
      this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk);
    }
    this.heldWrites.push(callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.finished = true;
    callback();
  }

  override resetAndDestroy(): this {
    this.reset = true;
    return this.destroy();
  }
}

async function relayToHeldBrowser(
  t: TestContext,
  reply: Buffer,
  options: Pick<Parameters<typeof proxyNativeAdminWebSocket>[0], "clientDrainTimeoutMs"> = {},
) {
  const port = await startGateway(t, reply);
  const socket = new HeldBrowserSocket();
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  const closed = Promise.withResolvers<void>();
  socket.once("close", () => closed.resolve());
  const relayClosed = Promise.withResolvers<NativeAdminWebSocketCloseCause>();
  const request = new IncomingMessage(socket);
  request.method = "GET";
  request.url = "/session/socket";
  request.headers = {
    origin: agentOrigin,
    "sec-websocket-key": randomBytes(16).toString("base64"),
    "sec-websocket-version": "13",
  };

  proxyNativeAdminWebSocket({
    request,
    socket,
    head: Buffer.alloc(0),
    context: {
      gatewayBase: `https://localhost:${port}/`,
      agentOrigin,
      apiKey: "relay-test-key",
    },
    connectionId: "relay-test",
    lease: async () => undefined,
    onConnect: async () => {},
    onClose: relayClosed.resolve,
    ...options,
  });
  return {
    socket,
    closed: closed.promise,
    relayClosed: within(relayClosed.promise, "relay close"),
  };
}

async function assertBrowserDrains(
  browser: Awaited<ReturnType<typeof relayToHeldBrowser>>,
  reply: Buffer,
): Promise<void> {
  assert.ok(browser.socket.writableEnded, "the relay ended the browser after the gateway EOF");
  assert.ok(browser.socket.writableLength > 0, "the frames are still queued for the browser");
  assert.equal(browser.socket.destroyed, false, "the relay keeps a browser that is still reading");

  // Release each pending write before closing the browser's side.
  let write = browser.socket.heldWrites.shift();
  while (write !== undefined) {
    write();
    await nextTurn();
    write = browser.socket.heldWrites.shift();
  }
  assert.ok(browser.socket.finished, "the browser saw a clean EOF");
  const received = Buffer.concat(browser.socket.chunks);
  assert.match(received.toString("latin1"), /^HTTP\/1\.1 101 /);
  const headerEnd = received.indexOf("\r\n\r\n");
  assert.ok(headerEnd >= 0, "the browser received the complete upgrade headers");
  assert.deepEqual(
    received.subarray(headerEnd + 4),
    reply,
    "the browser received every frame byte",
  );
  browser.socket.push(null);
  await within(browser.closed, "browser close");
  assert.equal(browser.socket.reset, false, "a drained browser gets a clean close");
}

test(
  "the native admin WebSocket relay flushes bytes still queued for the browser after the gateway closes",
  testOptions,
  async (t) => {
    // Smaller than the browser socket's high-water mark, so the pipe never pauses the gateway:
    // its EOF and close reach the relay while the frames still wait behind the first held write.
    const reply = randomBytes(1_024);
    const browser = await relayToHeldBrowser(t, reply);

    const cause = await browser.relayClosed;
    assert.equal(cause.reason, "upstream_disconnect");
    await assertBrowserDrains(browser, reply);
  },
);

test(
  "the native admin WebSocket relay resets a browser that never reads after the drain timeout",
  testOptions,
  async (t) => {
    const browser = await relayToHeldBrowser(t, randomBytes(1_024), {
      clientDrainTimeoutMs: 1_000,
    });

    await browser.relayClosed;
    assert.equal(browser.socket.destroyed, false, "the browser gets time to read");
    await within(browser.closed, "browser close after the drain timeout");
    assert.equal(browser.socket.finished, false, "the stuck browser never got a clean EOF");
    assert.ok(browser.socket.reset, "a cut stream ends in a reset, not a clean close");
  },
);

test(
  "the native admin WebSocket relay keeps queued bytes when the gateway socket errors after its clean close",
  testOptions,
  async (t) => {
    const reply = randomBytes(1_024);
    const browser = await relayToHeldBrowser(t, reply);
    // The browser answers the gateway's close frame just after the relay has finished its side
    // of the gateway connection. The relay pipes that late frame into the ended gateway socket,
    // which fails with EPIPE before it closes. The gateway still closed cleanly, so the frames
    // queued for the browser must not be dropped. The 'pipe' listener sees the gateway socket
    // before the relay pipes the browser into it, so the frame is pushed before that pipe ends;
    // the EPIPE assertion fails if the frame ever stops reaching the gateway.
    let gatewayError: unknown;
    browser.socket.once("pipe", (gateway: Readable) => {
      gateway.once("error", (error: unknown) => {
        gatewayError = error;
      });
      gateway.once("finish", () => browser.socket.push(Buffer.from([0x88, 0x80, 0, 0, 0, 0])));
    });

    const cause = await browser.relayClosed;
    assert.equal(cause.reason, "upstream_disconnect");
    assert.ok(gatewayError instanceof Error && "code" in gatewayError);
    assert.equal(gatewayError.code, "EPIPE", "the late browser frame failed the gateway socket");
    await assertBrowserDrains(browser, reply);
  },
);
