import { randomBytes, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { isAbsolute } from "node:path";
import { connect as tlsConnect } from "node:tls";
import {
  CONNECT_TIMEOUT_MS,
  dnsAuthority,
  MAX_CONNECTIONS,
  privateIPv4,
  TRANSPORT_PORT,
} from "./network.ts";

const CA_LIMIT = 65_536;

function setting(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error("A fixed relay setting is missing.");
  }
  return value;
}

/** The caller binds one listener and closes over one configured upstream. */
export function createFixedRelay(openUpstream: () => Socket): { server: Server; stop(): void } {
  const clients = new Set<Socket>();
  const server = createServer((client) => {
    clients.add(client);
    client.pause();
    // Neither TLS bytes nor client metadata influence the destination.
    const backend = openUpstream();
    const stop = () => {
      clearTimeout(timer);
      client.destroy();
      backend.destroy();
    };
    const timer = setTimeout(stop, CONNECT_TIMEOUT_MS);
    timer.unref();
    client.once("error", stop);
    client.once("close", () => {
      clients.delete(client);
      stop();
    });
    backend.once("error", stop);
    backend.once("close", (hadError) => {
      if (hadError || !backend.readableEnded) {
        stop();
      }
    });
    backend.once("connect", () => {
      clearTimeout(timer);
      client.pipe(backend);
      backend.pipe(client);
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  const stop = () => {
    server.close();
    for (const client of clients) {
      client.destroy();
    }
  };
  return { server, stop };
}

function serve(): void {
  const host = privateIPv4(setting("BOX_RELAY_LISTEN_ADDRESS"));
  const upstream = privateIPv4(setting("BOX_RELAY_UPSTREAM_ADDRESS"));
  if (host === upstream) {
    throw new Error("Relay must not be its own upstream.");
  }
  const { server, stop } = createFixedRelay(() =>
    connect({ host: upstream, port: TRANSPORT_PORT }),
  );
  server.on("error", () => {
    process.exitCode = 1;
    process.stderr.write("Box relay listener failed.\n");
    stop();
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.listen({ host, port: TRANSPORT_PORT }, () => {
    process.stdout.write("Box relay listening.\n");
  });
}

export async function probeRelay({
  host,
  port,
  authority,
  caPath,
}: {
  readonly host: string;
  readonly port: number;
  readonly authority: string;
  readonly caPath: string;
}): Promise<void> {
  if (!isAbsolute(caPath)) {
    throw new Error("Expected an absolute public CA path.");
  }
  // Kubernetes projects the immutable ConfigMap through symlinks.
  const handle = await open(caPath, constants.O_RDONLY | constants.O_NONBLOCK);
  let ca: Buffer;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(CA_LIMIT)) {
      throw new Error("Expected a bounded public CA bundle.");
    }
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(length) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error("Expected a bounded public CA bundle.");
    }
    ca = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  await probeNative({ host, port, authority, ca });
}

export async function probeNative({
  host,
  port,
  authority,
  ca,
}: {
  readonly host: string;
  readonly port: number;
  readonly authority: string;
  readonly ca: Buffer;
}): Promise<void> {
  dnsAuthority(authority);
  const bundle = ca.toString("ascii");
  const pattern = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;
  const certificates = bundle.match(pattern);
  if (
    ca.length > CA_LIMIT ||
    certificates === null ||
    bundle.replace(pattern, "").trim() !== "" ||
    !certificates.every((cert) => new X509Certificate(cert).ca)
  ) {
    throw new Error("Expected a bounded bundle of public CA certificates.");
  }
  await new Promise<void>((resolve, reject) => {
    const socket = tlsConnect({
      host,
      port,
      servername: authority,
      ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ALPNProtocols: ["http/1.1"],
    });
    const deadline = setTimeout(() => finish(new Error("Native readiness deadline.")), 4_000);
    let settled = false;
    let response = Buffer.alloc(0);
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    socket.once("error", finish);
    socket.once("close", () => finish(new Error("Native readiness closed without a response.")));
    socket.once("secureConnect", () => {
      // A positive reachability signal from the live native server without
      // bringing a capability into the relay. The Driver separately requires
      // an authenticated Codex initialize result before reporting serving.
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${authority}:${TRANSPORT_PORT}\r\n` +
          "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      if (response.length + chunk.length > 8_192) {
        finish(new Error("Native readiness reply exceeds its bound."));
        return;
      }
      response = Buffer.concat([response, chunk]);
      if (response.includes("\r\n\r\n")) {
        const firstLine = response.toString("ascii", 0, response.indexOf("\r\n"));
        finish(
          /^HTTP\/1\.1 401(?: [\x20-\x7e]*)?$/.test(firstLine)
            ? undefined
            : new Error("Native did not reject the anonymous upgrade."),
        );
      }
    });
  });
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("Expected exactly one relay operation.");
    }
    if (process.argv[2] === "serve") {
      serve();
    } else if (process.argv[2] === "probe") {
      await probeRelay({
        host: privateIPv4(setting("BOX_RELAY_LISTEN_ADDRESS")),
        port: TRANSPORT_PORT,
        authority: dnsAuthority(setting("BOX_RELAY_AUTHORITY")),
        caPath: setting("BOX_RELAY_CA_FILE"),
      });
    } else {
      throw new Error("Unexpected relay operation.");
    }
  } catch {
    process.exitCode = 1;
    process.stderr.write("Box relay operation refused.\n");
  }
}
