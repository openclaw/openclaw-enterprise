import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
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
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { refusingPort } from "../helpers/available-port.ts";
import { selfSigned } from "../helpers/certificates.mjs";
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
