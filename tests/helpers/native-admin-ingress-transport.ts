import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

interface NativeIngressOptions {
  artifacts: string;
  nativeDomain: string;
  publicHost: string;
}

export async function createNativeIngressTransport({
  artifacts,
  nativeDomain,
  publicHost,
}: NativeIngressOptions) {
  const certificate = await createLocalCertificate({ artifacts, nativeDomain, publicHost });
  // Trust only this disposable ingress certificate. Chromium can loop on
  // certificate-error retries for stylesheets with context ignoreHTTPSErrors.
  const certificateSpki = createHash("sha256")
    .update(new X509Certificate(certificate.cert).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  let upstream: URL | undefined;
  const sockets = new Set<Duplex>();
  const trackSocket = (socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createHttpsServer(certificate, (request, response) => {
    if (upstream === undefined) {
      response.writeHead(503).end("native admin ingress upstream not ready");
      return;
    }
    proxyHttpRequest(upstream, request, response);
  });
  server.on("connection", trackSocket);
  server.on("upgrade", (request, socket, head) => {
    trackSocket(socket);
    if (upstream === undefined) {
      socket.destroy();
      return;
    }
    proxyUpgrade(upstream, request, socket, head, trackSocket);
  });
  return {
    server,
    sockets,
    certificateSpki,
    certificateFingerprint: new X509Certificate(certificate.cert).fingerprint256,
    setUpstream(url: string) {
      upstream = new URL(url);
      assert.equal(
        upstream.protocol,
        "http:",
        "local native ingress expects controller HTTP port-forward",
      );
    },
  };
}

async function createLocalCertificate({
  artifacts,
  nativeDomain,
  publicHost,
}: NativeIngressOptions) {
  const keyPath = join(artifacts, "native-ingress.key");
  const certPath = join(artifacts, "native-ingress.crt");
  const configPath = join(artifacts, "native-ingress-openssl.cnf");
  await writeFile(
    configPath,
    `[req]\n` +
      `prompt = no\n` +
      `distinguished_name = dn\n` +
      `x509_extensions = v3_req\n` +
      `[dn]\n` +
      `CN = ${publicHost}\n` +
      `[v3_req]\n` +
      `subjectAltName = @alt_names\n` +
      `[alt_names]\n` +
      `DNS.1 = ${publicHost}\n` +
      `DNS.2 = *.${nativeDomain}\n`,
  );
  await executeFile("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-sha256",
    "-config",
    configPath,
  ]);
  return { key: await readFile(keyPath, "utf8"), cert: await readFile(certPath, "utf8") };
}

function proxyHttpRequest(upstream: URL, incoming: IncomingMessage, outgoing: ServerResponse) {
  const request = httpRequest(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  request.on("error", (error) => {
    outgoing.writeHead(502).end(String(error?.message ?? error));
  });
  incoming.pipe(request);
}

function proxyUpgrade(
  upstream: URL,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  trackSocket: (socket: Socket) => void,
) {
  const upstreamSocket = connectTcp(Number(upstream.port), upstream.hostname, () => {
    upstreamSocket.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          upstreamSocket.write(`${name}: ${entry}\r\n`);
        }
      } else if (value !== undefined) {
        upstreamSocket.write(`${name}: ${value}\r\n`);
      }
    }
    upstreamSocket.write("\r\n");
    if (head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  trackSocket(upstreamSocket);
  upstreamSocket.on("error", () => socket.destroy());
  socket.on("error", () => upstreamSocket.destroy());
}
