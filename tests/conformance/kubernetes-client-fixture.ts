import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createSecureServer } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { TLSSocket } from "node:tls";

import type { KubernetesAuthentication } from "../../apps/controller/src/drivers/kubernetes/authentication.ts";
import { selfSigned } from "../helpers/certificates.ts";
import { listen } from "../helpers/listen.ts";

type ApiEndpoint = { readonly url: string; readonly caPath: string };
type ClientCertificate = { readonly certPath: string; readonly keyPath: string };
type IdleRecord = { lastResponseAt?: number; clientClosedAt?: number };
type ApiRequest = { readonly path: string; readonly authorization: string | undefined };

// The API server records the certificate's CN per connection.
export async function selfSignedCertificate(
  directory: string,
  name: string,
  subjectAltName: string,
) {
  return selfSigned(directory, { name, commonName: name, subjectAltName });
}

function peerConnection(socket: TLSSocket) {
  return { protocol: socket.alpnProtocol, client: socket.getPeerCertificate().subject?.CN };
}

// Like kube-apiserver, the TLS listener offers HTTP/2 first and requires a client
// certificate. When it advertises a Keep-Alive hint, only the client closes an idle socket.
export async function apiServer(
  t: TestContext,
  directory: string,
  clientCertificates: readonly string[],
  keepAliveHint?: string,
) {
  const server = await selfSignedCertificate(directory, "api-server", "IP:127.0.0.1");
  const connections: ReturnType<typeof peerConnection>[] = [];
  const open = new Set<ReturnType<typeof peerConnection>>();
  const listener = createSecureServer({
    key: server.key,
    cert: server.cert,
    ca: clientCertificates.map((path) => readFileSync(path)),
    requestCert: true,
    rejectUnauthorized: true,
    allowHTTP1: true,
  });
  listener.on("secureConnection", (socket: TLSSocket) => {
    const connection = peerConnection(socket);
    connections.push(connection);
    open.add(connection);
    socket.on("close", () => open.delete(connection));
  });
  const idle = new Map<Socket, IdleRecord>();
  if (keepAliveHint !== undefined) {
    // The HTTP/1.1 fallback exposes this setting at runtime.
    assert.ok("keepAliveTimeout" in listener && typeof listener.keepAliveTimeout === "number");
    listener.keepAliveTimeout = 0;
  }
  listener.on("request", (request, response) => {
    response.setHeader("content-type", "application/json");
    if (keepAliveHint !== undefined) {
      response.setHeader("keep-alive", keepAliveHint);
      const socket = request.socket;
      let record = idle.get(socket);
      if (record === undefined) {
        const observed: IdleRecord = {};
        idle.set(socket, observed);
        record = observed;
        // A reset can close without a graceful end.
        for (const event of ["end", "close"]) {
          socket.on(event, () => (observed.clientClosedAt ??= Date.now()));
        }
      }
      response.on("finish", () => (record.lastResponseAt = Date.now()));
    }
    response.end(JSON.stringify({ kind: "NamespaceList", apiVersion: "v1", items: [] }));
  });
  const port = await listen(t, listener);
  return { caPath: server.certPath, url: `https://127.0.0.1:${port}`, connections, open, idle };
}

// A loopback HTTP proxy tunnels the client's CONNECT request to the TLS listener.
export async function connectProxy(t: TestContext, target: URL) {
  const tunnels: string[] = [];
  const proxy = createHttpServer();
  const upstreamSockets = new Set<Socket>();
  t.after(() => {
    for (const socket of upstreamSockets) {
      socket.destroy();
    }
  });
  proxy.on("connect", (request, client, head) => {
    assert.ok(request.url, "the proxy received a CONNECT authority");
    assert.equal(request.url, target.host);
    tunnels.push(request.url);
    const upstream = connectTcp(Number(target.port), target.hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstreamSockets.add(upstream);
    upstream.on("close", () => upstreamSockets.delete(upstream));
    for (const socket of [client, upstream]) {
      socket.on("error", () => undefined);
    }
  });
  const port = await listen(t, proxy);
  return { url: `http://127.0.0.1:${port}`, tunnels };
}

export async function recordingApiServer(
  t: TestContext,
  directory: string,
  respond: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const certificate = await selfSignedCertificate(directory, "api-server", "IP:127.0.0.1");
  const requests: ApiRequest[] = [];
  const listener = createHttpsServer(
    { key: certificate.key, cert: certificate.cert },
    (request, response) => {
      assert.ok(request.url, "the API received a request target");
      requests.push({ path: request.url, authorization: request.headers.authorization });
      respond(request, response);
    },
  );
  const port = await listen(t, listener);
  return { caPath: certificate.certPath, url: `https://127.0.0.1:${port}`, requests };
}

export async function writeKubeconfig(
  directory: string,
  server: ApiEndpoint,
  identity: ClientCertificate | "fixture-token",
  proxyUrl?: string,
): Promise<Extract<KubernetesAuthentication, { mode: "kubeconfig" }>> {
  const kubeconfigPath = join(directory, "kubeconfig");
  const proxy = proxyUrl === undefined ? "" : `, proxy-url: "${proxyUrl}"`;
  const user =
    identity === "fixture-token"
      ? "token: fixture-token"
      : `client-certificate: "${identity.certPath}", client-key: "${identity.keyPath}"`;
  await writeFile(
    kubeconfigPath,
    [
      "apiVersion: v1",
      "kind: Config",
      `clusters: [{name: target, cluster: {server: "${server.url}", certificate-authority: "${server.caPath}"${proxy}}}]`,
      `users: [{name: controller, user: {${user}}}]`,
      "contexts: [{name: target, context: {cluster: target, user: controller}}]",
      "current-context: target",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { mode: "kubeconfig", kubeconfigPath, context: "target" };
}
