import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createRequire } from "node:module";
import { Socket, type Server } from "node:net";
import { Writable, type Duplex } from "node:stream";
import test from "node:test";
import { TLSSocket } from "node:tls";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellServiceTransportError } from "../../apps/controller/src/drivers/sandbox/openshell-service-transport.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { refusingPort } from "../helpers/available-port.ts";
import { selfSigned } from "../helpers/certificates.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";

type RawData = Buffer | ArrayBuffer | Buffer[];

interface WebSocketPeer {
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): void;
  send(message: string): void;
  terminate(): void;
}

interface UpgradePeerServer {
  emit(event: "connection", peer: WebSocketPeer, request: IncomingMessage): boolean;
  clients: Set<WebSocketPeer>;
  handleUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
    callback: (peer: WebSocketPeer) => void,
  ): void;
  close(callback: (error?: Error) => void): void;
}

interface WebSocketReceiver {
  write(chunk: Buffer): boolean;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
  on(event: "conclude", listener: (code: number, reason: Buffer) => void): this;
  once(event: "conclude", listener: (code: number, reason: Buffer) => void): this;
}

interface WebSocketSender {
  close(code: number, reason: Buffer, mask: boolean, callback: () => void): void;
  send(
    data: string,
    options: { binary: boolean; mask: boolean; compress: boolean; fin: boolean },
    callback: () => void,
  ): void;
}

interface WebSocketModule {
  WebSocket: abstract new (address: string | URL) => WebSocketPeer;
  WebSocketServer: new (options: { noServer: true }) => UpgradePeerServer;
  Receiver: new (options: { isServer: true }) => WebSocketReceiver;
  Sender: new (socket: Socket) => WebSocketSender;
}

// Use the peer shipped with the controller's installed Kubernetes SDK.
export function loadWebSocketPeer(): WebSocketModule {
  const controller = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const ws: unknown = createRequire(controller.resolve("@kubernetes/client-node"))("ws");
  assert.ok(
    typeof ws === "function" &&
      "WebSocket" in ws &&
      ws.WebSocket === ws &&
      "WebSocketServer" in ws &&
      typeof ws.WebSocketServer === "function" &&
      "Receiver" in ws &&
      typeof ws.Receiver === "function" &&
      "Sender" in ws &&
      typeof ws.Sender === "function",
    "The installed ws module must provide the server, peer and frame codec",
  );
  return ws as typeof ws & WebSocketModule;
}

export async function waitForWebSocketClose(peer: WebSocketPeer, signal: AbortSignal) {
  assert.ok(peer instanceof EventEmitter);
  const [code, reason]: readonly unknown[] = await once(peer, "close", { signal });
  assert.ok(
    typeof code === "number" && Buffer.isBuffer(reason),
    "expected a WebSocket close event",
  );
  return { code, reason };
}

export async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve, reject: (error: Error) => void) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string", "expected a bound TCP server");
  return address.port;
}

export async function close(server: Server & { closeAllConnections?: () => void }): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export function writeUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  finish: "write" | "end",
): void {
  const key = request.headers["sec-websocket-key"];
  assert.equal(typeof key, "string", "expected a WebSocket handshake key");
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket[finish](
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

export async function upgradedSocket(server: Server, signal: AbortSignal): Promise<Socket> {
  const [, socket]: readonly unknown[] = await once(server, "upgrade", { signal });
  assert.ok(socket instanceof Socket, "expected a TCP upgrade socket");
  return socket;
}

function finishUpgrade(request: IncomingMessage, socket: Duplex): void {
  // Consume the client's close frame so this raw upgrade fixture observes EOF.
  socket.resume();
  writeUpgrade(request, socket, "end");
}

type ServiceRequestObservation = Pick<IncomingMessage, "method" | "url"> & {
  host: IncomingMessage["headers"]["host"];
  authorization: IncomingMessage["headers"]["authorization"];
};

type ServiceUpgradeObservation = Omit<ServiceRequestObservation, "method"> & {
  upgrade: IncomingMessage["headers"]["upgrade"];
};

type TlsObservation = {
  servername: TLSSocket["servername"];
  host: IncomingMessage["headers"]["host"];
};

export function registerOpenShellServiceTransportCases(token: string, serviceUrl: string): void {
  test("the OpenShell client reaches a bearer-passthrough service through the gateway listener", async (t) => {
    const seen: (ServiceRequestObservation | ServiceUpgradeObservation)[] = [];
    let answer: RequestListener = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ runtimeFailure: { code: "MODEL_PROBE_FAILED" } }));
    };
    let upgrade = finishUpgrade;
    const gateway = createServer((request, response) => {
      seen.push({
        method: request.method,
        url: request.url,
        host: request.headers.host,
        authorization: request.headers.authorization,
      });
      answer(request, response);
    });
    gateway.on("upgrade", (request, socket) => {
      seen.push({
        upgrade: request.headers.upgrade,
        url: request.url,
        host: request.headers.host,
        authorization: request.headers.authorization,
      });
      upgrade(request, socket);
    });
    const port = await listen(gateway);
    t.after(() => close(gateway));
    const client = new GrpcOpenShellGatewayClient({ endpoint: `http://127.0.0.1:${port}` });
    const signal = AbortSignal.timeout(5_000);

    assert.deepEqual(
      await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", token, signal),
      { status: 200, json: { runtimeFailure: { code: "MODEL_PROBE_FAILED" } } },
    );
    assert.deepEqual(seen.at(-1), {
      method: "GET",
      url: "/openclaw/runtime/status",
      host: "tenant--sandbox.openshell.localhost:8080",
      authorization: `Bearer ${token}`,
    });

    // OpenShell's own refusals are plain text: never a status document.
    answer = (_request, response) => {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("Service endpoint is not reachable");
    };
    assert.deepEqual(
      await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", token, signal),
      { status: 502 },
    );
    answer = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ padding: "x".repeat(20_000) }));
    };
    assert.deepEqual(
      await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", token, signal),
      { status: 200 },
      "an oversized answer is not parsed",
    );
    answer = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not json");
    };
    assert.deepEqual(
      await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", token, signal),
      { status: 200 },
    );
    // A JSON body under another content type is still not a status document.
    answer = (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(JSON.stringify({ runtimeFailure: { code: "MODEL_PROBE_FAILED" } }));
    };
    assert.deepEqual(
      await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", token, signal),
      { status: 200 },
    );

    assert.equal(await client.serviceWebSocketHandshake(serviceUrl, token, signal), true);
    assert.deepEqual(seen.at(-1), {
      upgrade: "websocket",
      url: "/",
      host: "tenant--sandbox.openshell.localhost:8080",
      authorization: `Bearer ${token}`,
    });
    upgrade = (_request, socket) => {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n",
      );
    };
    assert.equal(
      await client.serviceWebSocketHandshake(serviceUrl, token, signal),
      false,
      "a handshake must echo this request's key",
    );
    upgrade = (_request, socket) => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    assert.equal(await client.serviceWebSocketHandshake(serviceUrl, token, signal), false);

    for (const bearer of ["", "two words", "line\nbreak"]) {
      await assert.rejects(
        client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", bearer, signal),
        /token68/,
      );
    }
    for (const origin of [
      syntheticCredentialUrl({
        protocol: "http",
        username: "user",
        password: "pass",
        host: "host",
        pathname: "/",
      }),
      "http://host/path",
      "http://host/?query",
      "ftp://host/",
      "not a url",
    ]) {
      await assert.rejects(
        client.getServiceDocument(origin, "/x", token, signal),
        /HTTP origin|valid URL/,
        origin,
      );
    }
    for (const path of ["openclaw/runtime/status", "//other.example.test/x"]) {
      await assert.rejects(
        client.getServiceDocument(serviceUrl, path, token, signal),
        /must be absolute/,
        path,
      );
    }

    const aborted = new AbortController();
    answer = () => aborted.abort(new Error("caller cancelled"));
    await assert.rejects(
      client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", token, aborted.signal),
      /caller cancelled/,
    );
  });

  test("an accepted OpenShell probe closes its WebSocket normally without sending a Harness request", async (t) => {
    const { WebSocket, WebSocketServer } = loadWebSocketPeer();
    const peers = new WebSocketServer({ noServer: true });
    const gateway = createServer();
    let requests = 0;
    gateway.on("upgrade", (request, socket, head) => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.ok(socket instanceof Socket);
      peers.handleUpgrade(request, socket, head, (peer) => {
        peer.on("message", () => requests++);
        peers.emit("connection", peer, request);
      });
    });
    const port = await listen(gateway);
    t.after(async () => {
      for (const peer of peers.clients) {
        peer.terminate();
      }
      await new Promise<void>((resolve) => peers.close(() => resolve()));
      await close(gateway);
    });
    const client = new GrpcOpenShellGatewayClient({ endpoint: `http://127.0.0.1:${port}` });
    t.after(() => client.close());
    const deadline = AbortSignal.timeout(5_000);
    const closed = (async () => {
      assert.ok(peers instanceof EventEmitter);
      const [peer]: readonly unknown[] = await once(peers, "connection", { signal: deadline });
      assert.ok(peer instanceof WebSocket, "expected the upgraded peer");
      return waitForWebSocketClose(peer, deadline);
    })();
    const handshake = client
      .serviceWebSocketHandshake(serviceUrl, token, deadline)
      .then((accepted) => assert.equal(accepted, true));
    // The real WebSocket peer reports 1006 when a probe drops TCP without a close frame.
    const [, { code, reason }] = await Promise.all([handshake, closed]);
    assert.equal(code, 1000);
    assert.equal(reason.length, 0);
    assert.equal(requests, 0, "readiness must not invoke the Harness");
  });

  test("an OpenShell probe gives a peer that delays TCP closure its full cleanup deadline", async (t) => {
    const { Receiver, Sender } = loadWebSocketPeer();
    const gateway = createServer();
    const sockets = new Set<Socket>();
    let closeCode: number | undefined;
    let closeReceivedAt: number | undefined;
    gateway.on("upgrade", (request, socket, head) => {
      assert.ok(socket instanceof Socket);
      sockets.add(socket);
      writeUpgrade(request, socket, "write");
      // Use the real protocol codec, but withhold TCP EOF after acknowledging Close.
      const receiver = new Receiver({ isServer: true });
      const sender = new Sender(socket);
      receiver.once("conclude", (code, reason) => {
        closeCode = code;
        closeReceivedAt = performance.now();
        sender.close(code, reason, false, () => {});
      });
      if (head.length > 0) {
        receiver.write(head);
      }
      assert.ok(receiver instanceof Writable);
      socket.pipe(receiver);
    });
    const port = await listen(gateway);
    t.after(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await close(gateway);
    });
    const client = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${port}`,
      requestTimeoutMs: 1_000,
    });
    t.after(() => client.close());
    const deadline = AbortSignal.timeout(5_000);
    let endedAt: number | undefined;
    const ended = upgradedSocket(gateway, deadline).then((socket) =>
      once(socket, "end", { signal: deadline }).then(() => {
        endedAt = performance.now();
      }),
    );
    const started = performance.now();
    const handshake = client
      .serviceWebSocketHandshake(serviceUrl, token, deadline)
      .then((accepted) => {
        assert.equal(accepted, true);
        // Readiness must be visible while the peer still holds TCP open, not after cleanup.
        assert.equal(endedAt, undefined);
        assert.ok(performance.now() - started < 750, "readiness waited for connection cleanup");
      });
    await Promise.all([handshake, ended]);
    assert.equal(closeCode, 1000);
    assert.ok(
      endedAt !== undefined && closeReceivedAt !== undefined,
      "expected both close timestamps",
    );
    const cleanupElapsed = endedAt - closeReceivedAt;
    // Allow scheduling tolerance, but detect both early FIN and a doubled cleanup deadline.
    assert.ok(endedAt - started >= 950, "client ended TCP before the cleanup deadline");
    assert.ok(cleanupElapsed < 1_500, "client exceeded the configured cleanup deadline");
  });

  test("a refused OpenShell WebSocket handshake releases an unfinished HTTP response", async () => {
    const response: { socket?: Duplex } = {};
    const closed = new EventEmitter<{ closed: [] }>();
    const deadline = new AbortController();
    const closing = once(closed, "closed", { signal: deadline.signal }).then(() => {});
    const gateway = createServer();
    gateway.on("upgrade", (_request, peer) => {
      response.socket = peer;
      peer.resume();
      peer.once("end", () => peer.end());
      peer.once("close", () => closed.emit("closed"));
      // Headers already prove refusal; the peer never finishes its advertised body.
      peer.write(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial",
      );
    });
    const port = await listen(gateway);
    try {
      const client = new GrpcOpenShellGatewayClient({
        endpoint: `http://127.0.0.1:${port}`,
        requestTimeoutMs: 1_000,
      });
      assert.equal(
        await client.serviceWebSocketHandshake(serviceUrl, token, AbortSignal.timeout(5_000)),
        false,
      );
      // Disposal must happen even though send() clears the completed request's timer: the socket
      // closes within 1.5 s (the wait ends as soon as it does).
      const timer = setTimeout(() => deadline.abort(), 1_500);
      try {
        await closing;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      deadline.abort();
      // Join the listener on failure before disposing the held response.
      await closing.catch(() => {});
      // Complete the base implementation's held response without manufacturing a reset.
      response.socket?.end("x".repeat(93));
      await close(gateway);
    }
  });

  test("an unreachable OpenShell gateway listener is a dependency failure, not a starting Harness", async (t) => {
    // A released port can be taken by a parallel test's listener; this one keeps refusing.
    const refusing = await refusingPort();
    t.after(() => refusing.release());
    const { port } = refusing;
    const client = new GrpcOpenShellGatewayClient({ endpoint: `http://127.0.0.1:${port}` });
    for (const observe of [
      () =>
        client.getServiceDocument(
          serviceUrl,
          "/openclaw/runtime/status",
          token,
          AbortSignal.timeout(5_000),
        ),
      () => client.serviceWebSocketHandshake(serviceUrl, token, AbortSignal.timeout(5_000)),
    ]) {
      await assert.rejects(observe(), (error) => {
        assert.ok(error instanceof DependencyUnavailableError, String(error));
        // The reason is closed vocabulary for the worker's transient-dependency log.
        assert.ok(error instanceof OpenShellServiceTransportError);
        assert.equal(error.reason, "unreachable");
        return true;
      });
    }
  });

  test("an OpenShell service that never answers times out as a dependency failure", async (t) => {
    const held: (Duplex | ServerResponse)[] = [];
    const gateway = createServer((_request, response) => held.push(response));
    gateway.on("upgrade", (_request, socket) => held.push(socket));
    const port = await listen(gateway);
    t.after(() => {
      for (const socket of held) {
        socket.destroy();
      }
      return close(gateway);
    });
    const client = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${port}`,
      requestTimeoutMs: 1_000,
    });
    for (const observe of [
      (signal: AbortSignal) =>
        client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", token, signal),
      (signal: AbortSignal) => client.serviceWebSocketHandshake(serviceUrl, token, signal),
    ]) {
      // The caller's own deadline is longer: the request bound must fire first.
      await assert.rejects(observe(AbortSignal.timeout(20_000)), (error) => {
        assert.ok(error instanceof DependencyUnavailableError, String(error));
        assert.ok(error instanceof OpenShellServiceTransportError);
        assert.equal(error.reason, "timeout");
        assert.match(error.message, /timed out/);
        return true;
      });
    }
  });

  const selfSignedCertificate = (directory: string, name: string, subjectAltName: string) =>
    selfSigned(directory, { name, commonName: "openshell-gateway", subjectAltName });

  // A TLS gateway listener that records the SNI and Host of every request it receives.
  function tlsGateway(keyPath: string, certPath: string, seen: TlsObservation[]) {
    const gateway = createSecureServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (request, response) => {
        assert.ok(request.socket instanceof TLSSocket);
        seen.push({ servername: request.socket.servername, host: request.headers.host });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ runtimeFailure: { code: "MODEL_PROBE_FAILED" } }));
      },
    );
    gateway.on("upgrade", (request, socket) => {
      assert.ok(socket instanceof TLSSocket);
      seen.push({ servername: socket.servername, host: request.headers.host });
      finishUpgrade(request, socket);
    });
    return gateway;
  }

  test("the OpenShell client verifies a TLS gateway listener against its root certificate and name", async (t) => {
    const directory = temporaryDirectorySync(t, "openshell-service-tls-");
    // The certificate names only the control endpoint, never the service host.
    const { keyPath, certPath } = await selfSignedCertificate(directory, "tls", "DNS:localhost");
    const seen: TlsObservation[] = [];
    const gateway = tlsGateway(keyPath, certPath, seen);
    const port = await listen(gateway);
    t.after(() => close(gateway));
    const signal = AbortSignal.timeout(5_000);
    // SNI needs a name. The listener is IPv4; Node falls back to it if localhost resolves to ::1.
    const endpoint = `https://localhost:${port}`;
    const client = new GrpcOpenShellGatewayClient({ endpoint, rootCertificatePath: certPath });

    // TLS is verified against the control endpoint's name (SNI), while Host names the service.
    assert.deepEqual(
      await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", token, signal),
      { status: 200, json: { runtimeFailure: { code: "MODEL_PROBE_FAILED" } } },
    );
    assert.equal(await client.serviceWebSocketHandshake(serviceUrl, token, signal), true);
    assert.deepEqual(seen, [
      { servername: "localhost", host: "tenant--sandbox.openshell.localhost:8080" },
      { servername: "localhost", host: "tenant--sandbox.openshell.localhost:8080" },
    ]);

    // Without the gateway CA the listener cannot be verified: an outage, not a starting Harness.
    const untrusted = new GrpcOpenShellGatewayClient({ endpoint });
    for (const observe of [
      () => untrusted.getServiceDocument(serviceUrl, "/openclaw/runtime/status", token, signal),
      () => untrusted.serviceWebSocketHandshake(serviceUrl, token, signal),
    ]) {
      await assert.rejects(observe(), (error) => {
        assert.ok(error instanceof DependencyUnavailableError, String(error));
        return true;
      });
    }
    assert.equal(seen.length, 2, "an unverified listener never receives the bearer");
  });

  test("the OpenShell client verifies an IP-literal TLS gateway listener against the endpoint address, not Host", async (t) => {
    const directory = temporaryDirectorySync(t, "openshell-service-tls-ip-");
    // IPv6 loopback is optional on CI hosts; without it the IPv6 cases are skipped.
    const probe = createServer();
    const ipv6 = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(0, "::1", () => probe.close(() => resolve(true)));
    });
    const cases = [
      // TLS forbids an IP in SNI: the certificate must carry the endpoint IP itself.
      { name: "ipv4", san: "IP:127.0.0.1", bind: "127.0.0.1", host: "127.0.0.1", verified: true },
      { name: "ipv6", san: "IP:::1", bind: "::1", host: "[::1]", verified: true, needsIpv6: true },
      // A hex IPv6 literal (IPv4-mapped, so it reaches the IPv4 loopback listener).
      {
        name: "ipv6-hex",
        san: "IP:::ffff:7f00:1",
        bind: "127.0.0.1",
        host: "[::ffff:7f00:1]",
        verified: true,
        needsIpv6: true,
      },
      {
        name: "wrong-ip",
        san: "IP:127.0.0.2",
        bind: "127.0.0.1",
        host: "127.0.0.1",
        verified: false,
      },
      // A certificate for the service host named in Host does not vouch for the endpoint.
      {
        name: "service-host",
        san: "DNS:tenant--sandbox.openshell.localhost",
        bind: "127.0.0.1",
        host: "127.0.0.1",
        verified: false,
      },
    ];
    for (const { name, san, bind, host, verified, needsIpv6 } of cases) {
      await t.test(
        name,
        { skip: needsIpv6 && !ipv6 && "IPv6 loopback ::1 is unavailable" },
        async (t) => {
          const { keyPath, certPath } = await selfSignedCertificate(directory, name, san);
          const seen: TlsObservation[] = [];
          const gateway = tlsGateway(keyPath, certPath, seen);
          const port = await listen(gateway, bind);
          t.after(() => close(gateway));
          const endpoint = `https://${host}:${port}`;
          const client = new GrpcOpenShellGatewayClient({
            endpoint,
            rootCertificatePath: certPath,
          });
          const signal = AbortSignal.timeout(5_000);
          const observations = [
            () => client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", token, signal),
            () => client.serviceWebSocketHandshake(serviceUrl, token, signal),
          ] as const;
          if (verified) {
            assert.deepEqual(await observations[0](), {
              status: 200,
              json: { runtimeFailure: { code: "MODEL_PROBE_FAILED" } },
            });
            assert.equal(await observations[1](), true);
            // No SNI is sent for an IP endpoint, and Host still names the service.
            assert.deepEqual(seen, [
              { servername: false, host: "tenant--sandbox.openshell.localhost:8080" },
              { servername: false, host: "tenant--sandbox.openshell.localhost:8080" },
            ]);
            return;
          }
          for (const observe of observations) {
            await assert.rejects(observe(), (error) => {
              assert.ok(error instanceof DependencyUnavailableError, String(error));
              return true;
            });
          }
          assert.deepEqual(seen, [], "an unverified listener never receives the bearer");
        },
      );
    }
  });
}

export type HarnessHandler = (
  request: { method: string; url: string; headers: { authorization?: string } },
  response: {
    writeHead(code: number, headers?: OutgoingHttpHeaders): void;
    end(chunk?: string): void;
  },
) => void;

export interface HarnessServer {
  handler: HarnessHandler;
  listening: { port: number; host: string } | undefined;
  onError?: (error: Error & { code?: string }) => void;
  real?: HttpServer;
}

export interface NativeEntrypointOptions {
  env?: Record<string, string>;
  upfrontStatus?: number;
  upfrontStdout?: string | undefined;
  probeStatus?: string;
}

interface NativeEntrypointResult {
  servers: HarnessServer[];
  diagnostics: string[];
  events: Record<string, unknown>[];
  connectStarts: number;
}

export function assertHarnessDiagnostics(lines: unknown[]): asserts lines is string[] {
  assert.ok(
    lines.every((line) => typeof line === "string"),
    "expected text diagnostics from the Harness",
  );
}

export function readHarnessRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  assert.ok(record, "expected a JSON object from the Harness");
  return record;
}

export function readRuntimeFailure(body: Record<string, unknown>): Record<string, unknown> {
  return readHarnessRecord(body.runtimeFailure);
}

export function readHarnessEvent(line: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(line);
  return readHarnessRecord(decoded);
}

export type HarnessCall = (
  handler: HarnessHandler,
  options: { method?: string; url?: string; authorization?: string | undefined },
) => {
  status: number | undefined;
  headers: OutgoingHttpHeaders | undefined;
  body: Record<string, unknown>;
};

type NativeBody = { bodyShape?: string; providerErrorCode?: string; providerErrorType?: string };
type NativeHeldCase = readonly [
  name: string,
  upfrontStatus: number,
  providerCode: string | undefined,
  responseHeaderMarker: string,
  upfrontStdout?: string,
  body?: NativeBody,
];

export function nativeHeldCases(hostile: string): readonly NativeHeldCase[] {
  return [
    ["an unclassified 401 without known header names", 3, undefined, "none"],
    [
      "an unclassified 401 whose error carries a closed-set code and type",
      13,
      undefined,
      "provider-like",
      '["json-error-code","no_organization","invalid_request_error"]',
      {
        bodyShape: "json-error-code",
        providerErrorCode: "no_organization",
        providerErrorType: "invalid_request_error",
      },
    ],
    [
      "an unclassified 401 whose error has an off-set code and no type",
      13,
      undefined,
      "provider-like",
      '["json-error-code","other",""]',
      { bodyShape: "json-error-code", providerErrorCode: "other" },
    ],
    [
      "an unclassified non-JSON 401",
      23,
      undefined,
      "openshell-policy",
      '["non-json","",""]',
      { bodyShape: "non-json" },
    ],
    [
      "a 401 whose child output is off-set",
      15,
      "missing_api_key",
      "provider-like",
      JSON.stringify([hostile, hostile, "Bearer " + hostile]),
      {},
    ],
    ["a rejected key with provider-like headers", 14, "invalid_api_key", "provider-like"],
    [
      "a request that arrived at the provider without its credential",
      15,
      "missing_api_key",
      "provider-like",
    ],
    ["a key without the endpoint's scope", 6, "insufficient_permissions", "none"],
    ["an unclassified 401 stamped X-OpenShell-Policy", 23, undefined, "openshell-policy"],
    ["a rejected key forwarded with the relay's stamp", 34, "invalid_api_key", "mixed"],
  ];
}

export function assertNativeHeldFailure(
  { servers, diagnostics, events, connectStarts }: NativeEntrypointResult,
  {
    providerCode,
    responseHeaderMarker,
    body,
  }: {
    providerCode: string | undefined;
    responseHeaderMarker: string;
    body: NativeBody | undefined;
  },
  token: string,
  verifier: string,
  call: HarnessCall,
): void {
  assert.equal(connectStarts, 0, "a held failure never starts the node");
  assert.ok(diagnostics.includes("Harness model authentication probe failed."));
  // The probe event names the HTTP status, a closed-vocabulary code and the
  // responder's closed-vocabulary source only.
  const probe = events.find((event) => event.event === "openclaw.model_probe");
  assert.ok(probe, "expected a model probe event");
  assert.equal(probe.code, "AUTHENTICATION_FAILED");
  assert.equal(probe.providerStatus, 401);
  assert.equal(probe.providerCode, providerCode);
  assert.equal(probe.responseHeaderMarker, responseHeaderMarker);
  // The 401 body's closed-set tokens, each only when the child named it.
  assert.deepEqual(
    {
      bodyShape: probe.bodyShape,
      providerErrorCode: probe.providerErrorCode,
      providerErrorType: probe.providerErrorType,
    },
    {
      bodyShape: undefined,
      providerErrorCode: undefined,
      providerErrorType: undefined,
      ...body,
    },
  );
  assert.equal(probe.cause, undefined);
  for (const line of diagnostics) {
    assert.ok(!line.includes("fixture-model-key"), "the credential never reaches the log");
    assert.ok(!line.includes("Hostile"), "off-set child output never reaches the log");
  }

  const listening = servers.filter((server) => server.listening !== undefined);
  assert.equal(listening.length, 1);
  assert.ok(listening[0]);
  assert.deepEqual(listening[0].listening, { port: 18790, host: "0.0.0.0" });
  const { handler } = listening[0];
  const answer = call(handler, { authorization: `Bearer ${token}` });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers?.["cache-control"], "no-store");
  const { checkedAt, ...failure } = readRuntimeFailure(answer.body);
  assert.ok(typeof checkedAt === "string");
  assert.ok(!Number.isNaN(Date.parse(checkedAt)));
  // The held code and nothing else: no cause, no provider status or text.
  assert.deepEqual(failure, {
    component: "agent",
    check: "model-probe",
    code: "AUTHENTICATION_FAILED",
  });
  assert.deepEqual(Object.keys(answer.body), ["runtimeFailure"]);
  for (const authorization of [undefined, `Bearer ${token}x`, `Bearer ${verifier}`]) {
    const refused = call(handler, { authorization });
    assert.equal(refused.status, 401, String(authorization));
    assert.deepEqual(refused.body, { error: "unauthorized" });
  }
  const unavailable = call(handler, { url: "/", authorization: `Bearer ${token}` });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, {
    error: "runtime_failure_held",
    code: "AUTHENTICATION_FAILED",
  });
}

export function registerNativeStatusCases(
  token: string,
  nativeProviderEnv: Record<string, string>,
  runNativeWorkerEntrypoint: (options: NativeEntrypointOptions) => NativeEntrypointResult,
  call: HarnessCall,
): void {
  const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
  test("a provider-owned native OpenClaw worker serves a full-probe failure with its closed-vocabulary cause only", () => {
    const { servers, diagnostics, events, connectStarts } = runNativeWorkerEntrypoint({
      env: nativeProviderEnv,
      upfrontStatus: 0,
      probeStatus: "rate_limit",
    });
    assert.equal(connectStarts, 0);
    const probe = events.find((event) => event.event === "openclaw.model_probe");
    assert.ok(probe, "expected a model probe event");
    assert.equal(probe.code, "MODEL_PROBE_FAILED");
    assert.deepEqual(probe.cause, { kind: "PROBE_STATUS", detail: "rate_limit" });
    assert.equal(probe.providerStatus, undefined);
    for (const line of diagnostics) {
      assert.doesNotMatch(line, /fixture-model-key|provider-detail/);
    }
    const [listening] = servers.filter((server) => server.listening !== undefined);
    assert.ok(listening);
    const { handler } = listening;
    const answer = call(handler, { authorization: `Bearer ${token}` });
    assert.equal(answer.status, 200);
    const { checkedAt, ...failure } = readRuntimeFailure(answer.body);
    assert.ok(typeof checkedAt === "string");
    assert.ok(!Number.isNaN(Date.parse(checkedAt)));
    assert.deepEqual(failure, {
      component: "agent",
      check: "model-probe",
      code: "MODEL_PROBE_FAILED",
      cause: { kind: "PROBE_STATUS", detail: "rate_limit" },
    });
    assert.doesNotMatch(JSON.stringify(answer.body), /fixture-model-key|provider-detail/);
    assert.deepEqual(call(handler, { url: "/", authorization: `Bearer ${token}` }).body, {
      error: "runtime_failure_held",
      code: "MODEL_PROBE_FAILED",
    });
  });

  test("a native OpenClaw worker without an exposed port, or with a Compute status port, keeps its held failure private", () => {
    // A Sandbox provisioned before Compute asked for the exposure: nothing listens.
    const outboundOnly = runNativeWorkerEntrypoint({});
    assert.equal(outboundOnly.connectStarts, 0);
    assert.deepEqual(
      outboundOnly.servers.filter((server) => server.listening !== undefined),
      [],
    );
    // Compute-owned: the readiness server alone, like the Compute-owned Codex Harness.
    const computeOwned = runNativeWorkerEntrypoint({
      env: { ...nativeProviderEnv, OPENCLAW_RUNTIME_STATUS_PORT: "18789" },
    });
    assert.equal(computeOwned.connectStarts, 0);
    assert.deepEqual(
      computeOwned.servers.map((server) => server.listening),
      [{ port: 18789, host: "0.0.0.0" }],
    );
    // Without Compute's status identity nothing is served there; with it, the readiness
    // server reports the held check on the status path, as the Codex status server does
    // (finding 2686), and readiness stays 503.
    let unidentified: number | undefined;
    assert.ok(computeOwned.servers[0]);
    computeOwned.servers[0].handler(
      { method: "GET", url: "/openclaw/runtime/status", headers: {} },
      {
        writeHead(code) {
          unidentified = code;
        },
        end() {},
      },
    );
    assert.equal(unidentified, 404);
    const identified = runNativeWorkerEntrypoint({
      env: {
        OPENCLAW_RUNTIME_STATUS_PORT: "18789",
        OPENCLAW_AGENT_REVISION_ID: "rev_fixture",
        OPENCLAW_RUNTIME_STATUS_CONTAINER: "agent",
        OPENCLAW_POD_UID: "pod-fixture",
      },
    });
    assert.equal(identified.connectStarts, 0);
    const [identifiedServer] = identified.servers;
    assert.ok(identifiedServer);
    const statusHandler = identifiedServer.handler;
    const status = call(statusHandler, {});
    assert.equal(status.status, 200);
    const { checkedAt, ...heldCheck } = readRuntimeFailure(status.body);
    assert.ok(typeof checkedAt === "string");
    assert.ok(!Number.isNaN(Date.parse(checkedAt)));
    assert.deepEqual(
      { ...status.body, runtimeFailure: heldCheck },
      {
        revisionId: "rev_fixture",
        container: "agent",
        podUid: "pod-fixture",
        runtimeFailure: { component: "agent", check: "model-probe", code: "AUTHENTICATION_FAILED" },
      },
    );
    // A present but malformed verifier or port never starts the server (finding 1661): a
    // loosened check would serve the held failure against a credential nobody can hold.
    const verifier = sha256(token);
    for (const env of [
      { ...nativeProviderEnv, APP_TOKEN_SHA: "" },
      { ...nativeProviderEnv, APP_TOKEN_SHA: verifier.toUpperCase() },
      { ...nativeProviderEnv, APP_TOKEN_SHA: verifier.slice(0, 63) },
      { ...nativeProviderEnv, APP_TOKEN_SHA: `${verifier}a` },
      { ...nativeProviderEnv, APP_TOKEN_SHA: `${verifier.slice(0, 63)}g` },
      { ...nativeProviderEnv, APP_SERVER_PORT: "" },
      { ...nativeProviderEnv, APP_SERVER_PORT: "0" },
      { ...nativeProviderEnv, APP_SERVER_PORT: "65536" },
      { ...nativeProviderEnv, APP_SERVER_PORT: "18790.5" },
      { ...nativeProviderEnv, APP_SERVER_PORT: "-18790" },
      { ...nativeProviderEnv, APP_SERVER_PORT: "port" },
    ]) {
      const malformed = runNativeWorkerEntrypoint({ env });
      assert.equal(malformed.connectStarts, 0, JSON.stringify(env));
      assert.deepEqual(
        malformed.servers.filter((server) => server.listening !== undefined),
        [],
        JSON.stringify(env),
      );
    }
  });
}
