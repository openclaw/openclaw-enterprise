import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createSecureServer } from "node:http2";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createKubernetesClientConfiguration,
  KUBERNETES_KEEP_ALIVE_LIMITS,
  reuseRequestDispatcher,
} from "../../apps/controller/src/drivers/kubernetes/client.ts";

function selfSignedCertificate(directory, name, subjectAltName) {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      `/CN=${name}`,
      "-addext",
      `subjectAltName=${subjectAltName}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  return { keyPath, certPath };
}

// A TLS API server that offers HTTP/2 first, like kube-apiserver, requires a
// client certificate, and records every connection it accepts. With
// keepAliveHint, it advertises that Keep-Alive header and never closes an idle
// HTTP/1.1 connection itself, so any close comes from the client.
async function apiServer(directory, clientCertificates, { keepAliveHint } = {}) {
  const server = selfSignedCertificate(directory, "api-server", "IP:127.0.0.1");
  const connections = [];
  const open = new Set();
  const sockets = new Set();
  const listener = createSecureServer({
    key: readFileSync(server.keyPath),
    cert: readFileSync(server.certPath),
    ca: clientCertificates.map((path) => readFileSync(path)),
    requestCert: true,
    rejectUnauthorized: true,
    allowHTTP1: true,
  });
  listener.on("secureConnection", (socket) => {
    const connection = {
      protocol: socket.alpnProtocol,
      client: socket.getPeerCertificate().subject?.CN,
    };
    connections.push(connection);
    open.add(connection);
    socket.on("close", () => open.delete(connection));
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  // Per HTTP/1.1 socket: when its last response finished and when the client
  // closed it.
  const idle = [];
  if (keepAliveHint !== undefined) {
    listener.keepAliveTimeout = 0;
  }
  listener.on("request", (request, response) => {
    response.setHeader("content-type", "application/json");
    if (keepAliveHint !== undefined) {
      response.setHeader("keep-alive", keepAliveHint);
      const socket = request.socket;
      if (socket.idleRecord === undefined) {
        socket.idleRecord = { lastResponseAt: undefined, clientClosedAt: undefined };
        idle.push(socket.idleRecord);
        // "close" covers a client that resets the socket instead of ending it.
        for (const event of ["end", "close"]) {
          socket.on(event, () => (socket.idleRecord.clientClosedAt ??= Date.now()));
        }
      }
      response.on("finish", () => (socket.idleRecord.lastResponseAt = Date.now()));
    }
    response.end(JSON.stringify({ kind: "NamespaceList", apiVersion: "v1", items: [] }));
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  return {
    caPath: server.certPath,
    url: `https://127.0.0.1:${listener.address().port}`,
    connections,
    open,
    idle,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => listener.close(resolve));
    },
  };
}

async function writeKubeconfig(directory, server, client, { proxyUrl } = {}) {
  const kubeconfigPath = join(directory, "kubeconfig");
  const proxy = proxyUrl === undefined ? "" : `, proxy-url: "${proxyUrl}"`;
  await writeFile(
    kubeconfigPath,
    [
      "apiVersion: v1",
      "kind: Config",
      `clusters: [{name: target, cluster: {server: "${server.url}", certificate-authority: "${server.caPath}"${proxy}}}]`,
      `users: [{name: operator, user: {client-certificate: "${client.certPath}", client-key: "${client.keyPath}"}}]`,
      "contexts: [{name: target, context: {cluster: target, user: operator}}]",
      "current-context: target",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { mode: "kubeconfig", kubeconfigPath, context: "target" };
}

async function waitFor(condition, message) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Kubernetes API requests reuse keep-alive HTTP/1.1 connections and reconnect when the client certificate rotates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = selfSignedCertificate(directory, "operator-1", "DNS:operator");
  const second = selfSignedCertificate(directory, "operator-2", "DNS:operator");
  const server = await apiServer(directory, [first.certPath, second.certPath]);
  t.after(() => server.close());
  const active = {
    certPath: join(directory, "operator.crt"),
    keyPath: join(directory, "operator.key"),
  };
  await copyFile(first.certPath, active.certPath);
  await copyFile(first.keyPath, active.keyPath);
  const authentication = await writeKubeconfig(directory, server, active);
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    authentication,
    (message) => new Error(message),
  );
  const core = new sdk.CoreV1Api(clientConfiguration);

  // undici returns a socket to its pool just after the response resolves, so
  // back-to-back requests may alternate between two keep-alive connections.
  // Before the fix, every request opened its own HTTP/2 connection.
  for (let request = 0; request < 20; request += 1) {
    await core.listNamespace();
  }
  const firstConnections = server.connections.length;
  assert.ok(firstConnections <= 2, `20 requests opened ${firstConnections} connections`);
  for (const connection of server.connections) {
    assert.deepEqual(connection, { protocol: "http/1.1", client: "operator-1" });
  }

  // The kubeconfig names certificate files, which the client rereads on every
  // request: a rotated pair gets new connections and the old ones close.
  await copyFile(second.certPath, active.certPath);
  await copyFile(second.keyPath, active.keyPath);
  for (let request = 0; request < 20; request += 1) {
    await core.listNamespace();
  }
  const rotated = server.connections.slice(firstConnections);
  assert.ok(rotated.length >= 1 && rotated.length <= 2, `rotation opened ${rotated.length}`);
  for (const connection of rotated) {
    assert.deepEqual(connection, { protocol: "http/1.1", client: "operator-2" });
  }
  await waitFor(
    () => [...server.open].every((connection) => connection.client === "operator-2"),
    "the connections for the old certificate must close",
  );
});

// An HTTP CONNECT proxy that tunnels to any address, like a corporate egress proxy.
async function connectProxy() {
  const tunnels = [];
  const sockets = new Set();
  const proxy = createHttpServer();
  proxy.on("connect", (request, client, head) => {
    const [host, port] = request.url.split(":");
    tunnels.push(request.url);
    const upstream = connectTcp(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${proxy.address().port}`,
    tunnels,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}

// undici keeps an Agent's options under Symbol("options"), and a ProxyAgent's
// inner Agent under Symbol("proxy agent"). It has no public accessor for them.
function undiciSymbol(object, description) {
  const symbols = Object.getOwnPropertySymbols(object).filter(
    (candidate) => candidate.description === description,
  );
  assert.equal(symbols.length, 1, `undici no longer keeps ${description} where this test reads it`);
  return object[symbols[0]];
}

test("Kubernetes API dispatchers carry the keep-alive limits, directly and through an HTTP proxy", async (t) => {
  assert.deepEqual(KUBERNETES_KEEP_ALIVE_LIMITS, {
    keepAliveTimeout: 4_000,
    keepAliveMaxTimeout: 30_000,
  });
  const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operator = selfSignedCertificate(directory, "operator", "DNS:operator");
  const server = selfSignedCertificate(directory, "api-server", "IP:127.0.0.1");
  const target = { url: "https://127.0.0.1:6443", caPath: server.certPath };
  for (const proxyUrl of [undefined, "http://127.0.0.1:3128"]) {
    const authentication = await writeKubeconfig(directory, target, operator, { proxyUrl });
    const { kubeConfig } = await createKubernetesClientConfiguration(
      authentication,
      (message) => new Error(message),
    );
    const dispatcher = kubeConfig.createDispatcher(kubeConfig.getCurrentCluster(), {
      ca: readFileSync(server.certPath),
    });
    t.after(() => dispatcher.close());
    const agent = proxyUrl === undefined ? dispatcher : undiciSymbol(dispatcher, "proxy agent");
    const options = undiciSymbol(agent, "options");
    assert.equal(options.keepAliveTimeout, 4_000, `proxy ${proxyUrl}`);
    assert.equal(options.keepAliveMaxTimeout, 30_000, `proxy ${proxyUrl}`);
    assert.equal(options.allowH2, false, `proxy ${proxyUrl}`);
  }
});

// Finding 909: undici trusts a server's Keep-Alive timeout hint up to its
// keepAliveMaxTimeout (600 s by default), so a hop advertising more idle time
// than another hop allows lets the other hop close a socket the client is about
// to reuse. The client must close an idle socket by keepAliveMaxTimeout even when
// the server advertises 600 s, and by keepAliveTimeout when it sends no hint.
// The production limits are 4 s and 30 s; small ones keep this test fast.
for (const viaProxy of [false, true]) {
  test(`Kubernetes API clients close idle connections within the keep-alive limits${viaProxy ? " through an HTTP proxy" : ""}`, async (t) => {
    const limits = { keepAliveTimeout: 300, keepAliveMaxTimeout: 800 };
    const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const operator = selfSignedCertificate(directory, "operator", "DNS:operator");
    // A Keep-Alive header without a timeout leaves the client at keepAliveTimeout.
    for (const [keepAliveHint, limit] of [
      ["timeout=600", limits.keepAliveMaxTimeout],
      ["max=100", limits.keepAliveTimeout],
    ]) {
      const server = await apiServer(directory, [operator.certPath], { keepAliveHint });
      t.after(() => server.close());
      const proxy = viaProxy ? await connectProxy() : undefined;
      if (proxy !== undefined) {
        t.after(() => proxy.close());
      }
      const authentication = await writeKubeconfig(directory, server, operator, {
        proxyUrl: proxy?.url,
      });
      const { sdk } = await createKubernetesClientConfiguration(
        authentication,
        (message) => new Error(message),
      );
      const kubeConfig = new sdk.KubeConfig();
      reuseRequestDispatcher(kubeConfig, limits);
      kubeConfig.loadFromFile(authentication.kubeconfigPath);
      const core = kubeConfig.makeApiClient(sdk.CoreV1Api);

      await core.listNamespace();
      assert.equal(server.idle.length, 1, `${keepAliveHint}: one connection`);
      assert.deepEqual(server.connections, [{ protocol: "http/1.1", client: "operator" }]);
      if (proxy !== undefined) {
        assert.equal(proxy.tunnels.length, 1, `${keepAliveHint}: one tunnel`);
      }
      const [record] = server.idle;
      await waitFor(
        () => record.clientClosedAt !== undefined,
        `${keepAliveHint}: the client must close the idle connection`,
      );
      const idleFor = record.clientClosedAt - record.lastResponseAt;
      assert.ok(
        // The upper bound only has to stay under undici's 4 s default.
        idleFor >= limit - 100 && idleFor < limit + 2_500,
        `${keepAliveHint}: the client closed the connection after ${idleFor} ms idle, expected about ${limit} ms`,
      );
    }
  });
}
