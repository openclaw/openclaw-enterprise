import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { constants, watch } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { request } from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { createServer } from "node:https";
import type { Server } from "node:https";
import { connect, Socket } from "node:net";
import { isAbsolute } from "node:path";
import { TLSSocket } from "node:tls";
import { openOriginalSocket } from "./generation.ts";
import type { OriginalSocket } from "./generation.ts";
import {
  CONNECT_TIMEOUT_MS,
  dnsAuthority,
  MAX_CONNECTIONS,
  privateIPv4,
  TRANSPORT_PORT,
} from "./network.ts";

const MAX_HEADER_BYTES = 8_192;
const LEASE_INTERVAL_MS = 500;
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const BOX_OWNER_HEADER = "x-openclaw-box-owner";
const CONFIG_FIELDS = [
  "authority",
  "bindAddress",
  "certFile",
  "keyFile",
  "readySha256",
  "runtimeDir",
];

interface Config {
  readonly authority: string;
  readonly bindAddress: string;
  readonly certFile: string;
  readonly keyFile: string;
  readonly readySha256: string;
  readonly runtimeDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new Error("Invalid ingress configuration field.");
  }
  return value;
}

async function readFileOwned(path: string, limit: number, privateFile: boolean): Promise<Buffer> {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0 || !isAbsolute(path) || (await realpath(path)) !== path) {
    throw new Error("Expected a canonical configuration file and nonroot owner.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > limit ||
      (privateFile
        ? before.uid !== uid ||
          ((before.mode & 0o7777) !== 0o600 && (before.mode & 0o7777) !== 0o400)
        : (before.uid !== uid && before.uid !== 0) || (before.mode & 0o7022) !== 0)
    ) {
      throw new Error("Unexpected file owner, mode or size.");
    }
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (
      bytesRead !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("Ingress input changed during its read.");
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function load(path: string): Promise<{ config: Config; cert: Buffer; key: Buffer }> {
  const value: unknown = JSON.parse((await readFileOwned(path, 8_192, true)).toString("utf8"));
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== CONFIG_FIELDS.join(",")) {
    throw new Error("Unexpected ingress configuration fields.");
  }
  const config: Config = {
    authority: dnsAuthority(stringField(value, "authority")),
    bindAddress: privateIPv4(stringField(value, "bindAddress")),
    certFile: stringField(value, "certFile"),
    keyFile: stringField(value, "keyFile"),
    readySha256: stringField(value, "readySha256"),
    runtimeDir: stringField(value, "runtimeDir"),
  };
  const [cert, key] = await Promise.all([
    readFileOwned(config.certFile, 65_536, false),
    readFileOwned(config.keyFile, 16_384, true),
  ]);
  return { config, cert, key };
}

function validateTls(authority: string, cert: Buffer, key: Buffer): void {
  const leaf = new X509Certificate(cert);
  if (
    leaf.ca ||
    !leaf.checkHost(authority, { subject: "never", wildcards: false }) ||
    !leaf.checkPrivateKey(createPrivateKey(key)) ||
    Date.now() < Date.parse(leaf.validFrom) ||
    Date.now() >= Date.parse(leaf.validTo)
  ) {
    throw new Error("TLS key or exact DNS leaf certificate is invalid.");
  }
}

function header(message: IncomingMessage, name: string): string | undefined {
  const values = message.headersDistinct[name];
  if (values !== undefined && values.length !== 1) {
    throw new Error("Duplicate handshake header.");
  }
  return values?.[0];
}

function upgradeHeaders(message: IncomingMessage, authority: string): OutgoingHttpHeaders {
  const secKey = header(message, "sec-websocket-key");
  const connection = header(message, "connection")
    ?.toLowerCase()
    .split(",")
    .map((token) => token.trim());
  if (
    message.method !== "GET" ||
    message.url !== "/" ||
    message.httpVersion !== "1.1" ||
    header(message, "host")?.toLowerCase() !== `${authority}:${TRANSPORT_PORT}` ||
    !(message.socket instanceof TLSSocket) ||
    message.socket.servername !== authority ||
    header(message, "upgrade")?.toLowerCase() !== "websocket" ||
    !connection?.includes("upgrade") ||
    connection.some((token) => token !== "upgrade" && token !== "keep-alive") ||
    header(message, "sec-websocket-version") !== "13" ||
    secKey === undefined ||
    !/^[A-Za-z0-9+/]{22}==$/.test(secKey) ||
    Buffer.from(secKey, "base64").toString("base64") !== secKey ||
    message.headersDistinct["transfer-encoding"] !== undefined ||
    message.headersDistinct["content-length"] !== undefined
  ) {
    throw new Error("Only the fixed root WebSocket upgrade is admitted.");
  }
  const headers: OutgoingHttpHeaders = {
    Host: `${authority}:${TRANSPORT_PORT}`,
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Key": secKey,
    "Sec-WebSocket-Version": "13",
  };
  for (const name of [
    "authorization",
    "origin",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]) {
    const value = header(message, name);
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  return headers;
}

function reject(socket: Socket, status: 400 | 401 | 403 | 404 | 502 | 503): void {
  const reasons = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    502: "Bad Gateway",
    503: "Service Unavailable",
  };
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${reasons[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

function nativeUpgrade(response: IncomingMessage, key: string, generationSha256: string): string {
  const accept = createHash("sha1")
    .update(key + WS_MAGIC)
    .digest("base64");
  if (
    response.statusCode !== 101 ||
    header(response, "upgrade")?.toLowerCase() !== "websocket" ||
    !header(response, "connection")
      ?.toLowerCase()
      .split(",")
      .map((token) => token.trim())
      .includes("upgrade") ||
    header(response, "sec-websocket-accept") !== accept
  ) {
    throw new Error("Unexpected native upgrade response.");
  }
  let text = `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n`;
  for (const name of ["sec-websocket-protocol", "sec-websocket-extensions"]) {
    const value = header(response, name);
    if (value !== undefined) {
      text += `${name}: ${value}\r\n`;
    }
  }
  return `${text}${BOX_OWNER_HEADER}: ${generationSha256}\r\n\r\n`;
}

function forward(
  client: Socket,
  headers: OutgoingHttpHeaders,
  original: OriginalSocket,
  generationSha256: string,
): void {
  const secKey = headers["Sec-WebSocket-Key"];
  if (typeof secKey !== "string") {
    reject(client, 400);
    return;
  }
  const upstream = connect(original.pinnedPath);
  let upgraded = false;
  let settled = false;
  const timer = setTimeout(() => {
    finish(502);
  }, CONNECT_TIMEOUT_MS);
  timer.unref();

  const finish = (status?: 401 | 403 | 502 | 503) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    upstream.destroy();
    if (status !== undefined && !upgraded) {
      reject(client, status);
    } else {
      client.destroy();
    }
  };
  client.once("close", () => finish());
  upstream.once("error", () => finish(502));
  upstream.once("connect", () => {
    void (async () => {
      if (!(await original.valid()) || settled || client.destroyed) {
        finish(503);
        return;
      }
      // The connected socket is the retained original inode. Do not resolve the
      // public pathname a second time or put the bearer in a local file or log.
      const handshake = request({
        method: "GET",
        path: "/",
        headers,
        maxHeaderSize: MAX_HEADER_BYTES,
        createConnection: () => upstream,
      });
      handshake.once("error", () => finish(502));
      handshake.once("response", (response) => {
        const status = response.statusCode;
        response.destroy();
        void original
          .valid()
          .then((valid) => {
            finish(valid ? (status === 401 || status === 403 ? status : 502) : 503);
          })
          .catch(() => finish(502));
      });
      handshake.once("upgrade", (response, socket, head) => {
        // Node's HTTP client returns the same connected Duplex supplied above.
        if (socket !== upstream) {
          socket.destroy();
          finish(502);
          return;
        }
        upstream.pause();
        void (async () => {
          if (!(await original.valid()) || settled || client.destroyed) {
            finish(503);
            return;
          }
          const reply = nativeUpgrade(response, secKey, generationSha256);
          clearTimeout(timer);
          upgraded = true;
          client.write(reply);
          if (head.length > 0) {
            client.write(head);
          }
          upstream.once("end", () => client.end());
          upstream.once("close", (hadError) => {
            if (hadError || !upstream.readableEnded) {
              finish();
            }
          });
          client.pipe(upstream);
          upstream.pipe(client);
        })().catch(() => finish(502));
      });
      handshake.end();
    })().catch(() => finish(502));
  });
}

/** Build the one-generation TLS handler; the executable owns the private bind. */
export async function createFixedIngress(
  config: Pick<Config, "authority" | "runtimeDir" | "readySha256">,
  { cert, key }: { readonly cert: Buffer; readonly key: Buffer },
): Promise<{ readonly server: Server; stop(): void }> {
  validateTls(dnsAuthority(config.authority), cert, key);
  const original = await openOriginalSocket(config.runtimeDir, config.readySha256);
  const clients = new Set<Socket>();
  const server = createServer(
    {
      cert,
      key,
      minVersion: "TLSv1.2",
      ALPNProtocols: ["http/1.1"],
      maxHeaderSize: MAX_HEADER_BYTES,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      headersTimeout: 5_000,
      requestTimeout: 5_000,
      keepAliveTimeout: 1_000,
    },
    (_message, response) => {
      response.writeHead(404, { Connection: "close", "Content-Length": "0" }).end();
    },
  );
  server.maxConnections = MAX_CONNECTIONS;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 1;
  let stopped = false;
  let checking = false;
  let watcher: ReturnType<typeof watch> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (lostGeneration: boolean) => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
    }
    watcher?.close();
    server.close();
    for (const socket of clients) {
      socket.destroy();
    }
    void original.close().catch(() => server.emit("generationLost"));
    if (lostGeneration) {
      server.emit("generationLost");
    }
  };
  server.on("connection", (socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.on("error", () => socket.destroy());
    if (stopped) {
      socket.destroy();
    }
  });
  server.on("secureConnection", (socket: TLSSocket) => {
    // Reject unrelated TLS origins before reading any request headers.
    if (socket.servername !== config.authority) {
      socket.destroy();
    }
  });
  server.on("upgrade", (message, duplex, head) => {
    if (!(duplex instanceof Socket)) {
      duplex.destroy();
      return;
    }
    const socket = duplex;
    socket.on("error", () => socket.destroy());
    if (stopped) {
      reject(socket, 503);
      return;
    }
    try {
      if (head.length > 0) {
        reject(socket, 400);
        return;
      }
      forward(socket, upgradeHeaders(message, config.authority), original, config.readySha256);
    } catch {
      reject(socket, 400);
    }
  });
  server.on("connect", (_message, duplex) => duplex.destroy());
  server.on("clientError", (_error, duplex) => duplex.destroy());
  server.on("error", () => stop(true));
  server.on("listening", () => {
    if (stopped) {
      server.close();
    }
  });

  try {
    watcher = watch(config.runtimeDir, (_event, filename) => {
      if (filename === null || filename === "app-server.sock" || filename === "ready.json") {
        stop(true);
      }
    });
    watcher.on("error", () => stop(true));
    timer = setInterval(() => {
      if (checking || stopped) {
        return;
      }
      checking = true;
      void original
        .valid()
        .then((valid) => {
          if (!valid) {
            stop(true);
          }
        })
        .finally(() => {
          checking = false;
        });
    }, LEASE_INTERVAL_MS);
    timer.unref();
    if (!(await original.valid()) || stopped) {
      throw new Error("Original listener changed during startup.");
    }
    return { server, stop: () => stop(false) };
  } catch (error) {
    stop(false);
    throw error;
  }
}

async function serve({ config, cert, key }: Awaited<ReturnType<typeof load>>): Promise<void> {
  const { server, stop } = await createFixedIngress(config, { cert, key });
  server.once("generationLost", () => {
    process.exitCode = 1;
    process.stderr.write("Box ingress lost its original listener.\n");
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.listen({ host: privateIPv4(config.bindAddress), port: TRANSPORT_PORT }, () => {
    if (server.listening) {
      process.stdout.write("Box ingress listening.\n");
    }
  });
}

if (import.meta.main) {
  try {
    const config = process.argv[2];
    if (config === undefined || process.argv.length !== 3) {
      throw new Error("Expected a configuration file.");
    }
    await serve(await load(config));
  } catch {
    process.exitCode = 1;
    process.stderr.write(
      "Box ingress startup refused. Check configuration, TLS and original generation.\n",
    );
  }
}
