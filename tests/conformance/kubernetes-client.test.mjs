import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createSecureServer } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createKubernetesClientConfiguration,
  KUBERNETES_KEEP_ALIVE_LIMITS,
  reuseRequestDispatcher,
} from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  withComputeAbortSignal,
  withComputeOperationDeadline,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { kubernetesRequest } from "../../apps/controller/src/drivers/kubernetes/request.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";

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

// A TLS API server stand-in that records each request's path and Authorization
// header. `respond(request, response)` writes every answer.
async function recordingApiServer(directory, respond) {
  const certificate = selfSignedCertificate(directory, "api-server", "IP:127.0.0.1");
  const requests = [];
  const listener = createHttpsServer(
    { key: readFileSync(certificate.keyPath), cert: readFileSync(certificate.certPath) },
    (request, response) => {
      requests.push({ path: request.url, authorization: request.headers.authorization });
      respond(request, response);
    },
  );
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  return {
    caPath: certificate.certPath,
    url: `https://127.0.0.1:${listener.address().port}`,
    requests,
    async close() {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    },
  };
}

/** A kubeconfig whose identity is a bearer token, like an in-cluster ServiceAccount. */
async function writeTokenKubeconfig(directory, server) {
  const kubeconfigPath = join(directory, "kubeconfig");
  await writeFile(
    kubeconfigPath,
    [
      "apiVersion: v1",
      "kind: Config",
      `clusters: [{name: target, cluster: {server: "${server.url}", certificate-authority: "${server.caPath}"}}]`,
      "users: [{name: controller, user: {token: fixture-token}}]",
      "contexts: [{name: target, context: {cluster: target, user: controller}}]",
      "current-context: target",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { mode: "kubeconfig", kubeconfigPath, context: "target" };
}

const STATUS_PROXY_PATH =
  "/api/v1/namespaces/tenant/pods/agent-pod%3A18791/proxy/openclaw%2Fruntime%2Fstatus";

/** The production Driver's runtime status readback through clients built from `authentication`. */
function statusReadback(authentication) {
  const driver = new KubernetesComputeDriver({
    ...conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["10.42.0.0/16"] }),
    authentication,
  });
  // Pod discovery is not under test; the read itself goes through the Pod proxy.
  driver.revisionPods = async () => [
    {
      metadata: { name: "agent-pod", uid: "agent-uid" },
      status: { phase: "Running", podIP: "10.42.0.7" },
    },
  ];
  return driver
    .privateStatusReadback(
      { harness: { mode: "shared" } },
      { name: "tenant", plane: "control" },
      "agent",
      "/openclaw/runtime/status",
    )
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
}

// Finding 1347: whoever runs on a Pod's status port writes the proxied answer, and the
// API server's Pod proxy passes a relative Location, or one naming another host,
// through unchanged. Following it would send the controller's token to another API
// server path, or fetch another origin from the controller's network position. The
// readback must make exactly one request and report the redirect as unreadable.
for (const [target, location] of [
  ["a relative path", () => "../../../../../../../api/v1/namespaces/occ-system/secrets/x"],
  ["another API server path", (api) => `${api.url}/api/v1/namespaces/occ-system/secrets/x`],
  ["another origin", (_api, other) => `${other.url}/collect`],
  ["itself", () => STATUS_PROXY_PATH],
]) {
  test(`runtime status readback does not follow a Pod redirect to ${target} (finding 1347)`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const otherRequests = [];
    const other = createHttpServer((request, response) => {
      otherRequests.push(request.url);
      response.end("{}");
    });
    await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      other.closeAllConnections();
      return new Promise((resolve) => other.close(resolve));
    });
    const api = await recordingApiServer(directory, (request, response) => {
      // The API server's own answer for any other path: a body worth stealing.
      if (request.url !== STATUS_PROXY_PATH) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"kind":"Secret"}');
        return;
      }
      response.writeHead(302, {
        location: location(api, { url: `http://127.0.0.1:${other.address().port}` }),
      });
      response.end();
    });
    t.after(() => api.close());

    const outcome = await statusReadback(await writeTokenKubeconfig(directory, api));
    assert.equal(outcome.error?.message, "Runtime status answered with a redirect.");
    assert.deepEqual(api.requests, [
      { path: STATUS_PROXY_PATH, authorization: "Bearer fixture-token" },
    ]);
    assert.deepEqual(otherRequests, []);
    t.diagnostic(
      `API requests: ${api.requests.length}; other-origin requests: ${otherRequests.length}`,
    );
  });
}

for (const body of ["truncated", "held open"]) {
  test(`runtime status readback stops at a redirect with a ${body} body`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const api = await recordingApiServer(directory, (request, response) => {
      if (request.url !== STATUS_PROXY_PATH) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"kind":"Secret"}');
        return;
      }
      response.writeHead(302, {
        location: "/api/v1/namespaces/occ-system/secrets/x",
        "content-length": "100",
      });
      response.once("close", resolveClosed);
      response.flushHeaders();
      if (body === "truncated") {
        response.write("partial");
        const timer = setTimeout(() => response.destroy(), 25);
        response.once("close", () => clearTimeout(timer));
      }
    });
    t.after(() => api.close());

    // An unfinished body must neither delay the redirect result nor cause a retry.
    const authentication = await writeTokenKubeconfig(directory, api);
    const outcome = await withComputeAbortSignal(AbortSignal.timeout(4_000), () =>
      statusReadback(authentication),
    );
    assert.equal(api.requests.length, 1, "a redirect must not trigger another request");
    assert.equal(outcome.error?.message, "Runtime status answered with a redirect.");
    assert.deepEqual(api.requests, [
      { path: STATUS_PROXY_PATH, authorization: "Bearer fixture-token" },
    ]);
    assert.equal(
      await Promise.race([closed.then(() => true), delay(2_000, false, { ref: false })]),
      true,
      "the redirect response is cancelled",
    );
  });
}

// Finding 1355: undici refuses a 100 Continue or an unrequested 101 with a status-less socket
// error. The Pod chose that answer, so the readback reports it once instead of retrying it.
for (const [interim, write] of [
  [
    "100 Continue",
    (response) => {
      response.writeContinue();
      response.writeHead(302, { location: "/api/v1/namespaces/occ-system/secrets/x" });
      response.end();
    },
  ],
  [
    "101 Switching Protocols",
    (response) =>
      response.socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n",
      ),
  ],
]) {
  test(`runtime status readback reports an unrequested ${interim} once, without a retry`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const api = await recordingApiServer(directory, (request, response) => {
      if (request.url !== STATUS_PROXY_PATH) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"kind":"Secret"}');
        return;
      }
      write(response);
    });
    t.after(() => api.close());
    const authentication = await writeTokenKubeconfig(directory, api);
    const outcome = await withComputeAbortSignal(AbortSignal.timeout(4_000), () =>
      statusReadback(authentication),
    );
    assert.equal(
      outcome.error?.message,
      "Runtime status answered with an unrequested 1xx status.",
      String(outcome.error?.cause ?? outcome.error),
    );
    assert.deepEqual(api.requests, [
      { path: STATUS_PROXY_PATH, authorization: "Bearer fixture-token" },
    ]);
  });
}

test("runtime status readback still retries a dropped connection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const api = await recordingApiServer(directory, (request, response) => {
    // The first read loses its connection mid-request, as when an API server restarts.
    if (api.requests.length === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"revisionId":"revision-1"}');
  });
  t.after(() => api.close());
  assert.deepEqual(await statusReadback(await writeTokenKubeconfig(directory, api)), {
    value: { status: { revisionId: "revision-1" }, podUid: "agent-uid", containerId: undefined },
  });
  assert.equal(api.requests.length, 2);
});

test("runtime status readback through the production client keeps 200 and 404 answers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let status = 200;
  const api = await recordingApiServer(directory, (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(status === 200 ? '{"revisionId":"revision-1"}' : "");
  });
  t.after(() => api.close());
  const authentication = await writeTokenKubeconfig(directory, api);
  assert.deepEqual(await statusReadback(authentication), {
    value: { status: { revisionId: "revision-1" }, podUid: "agent-uid", containerId: undefined },
  });
  // 404 means the status port is not serving yet: no status, no error.
  status = 404;
  assert.deepEqual(await statusReadback(authentication), { value: undefined });
  t.diagnostic("200 returned parsed status; 404 returned no status");
});

test("Kubernetes API clients do not follow a redirect from the API server (finding 1347)", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const api = await recordingApiServer(directory, (request, response) => {
    if (request.url.startsWith("/api/v1/namespaces?")) {
      response.writeHead(302, { location: "/api/v1/namespaces/occ-system/secrets" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"kind":"SecretList","apiVersion":"v1","items":[]}');
  });
  t.after(() => api.close());
  // The Secret and Configuration Drivers build their clients from this same configuration.
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    await writeTokenKubeconfig(directory, api),
    (message) => new Error(message),
  );
  const listed = await new sdk.CoreV1Api(clientConfiguration).listNamespace({ limit: 1 }).then(
    () => undefined,
    (error) => error,
  );
  assert.equal(listed?.code, 302);
  assert.equal(api.requests.length, 1);
});

// The non-redirecting library replaces client-node's own for every client (finding 1347), so it
// must still send each write's method and body, and stop a read when its operation is cancelled.
test("Kubernetes API clients send write bodies and honor cancellation through the shared library", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writes = [];
  const cancel = new AbortController();
  const api = await recordingApiServer(directory, (request, response) => {
    // A read of this Namespace never answers; the operation is cancelled once it is in flight.
    if (request.url === "/api/v1/namespaces/held") {
      cancel.abort();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      writes.push({ method: request.method, body });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(body);
    });
  });
  t.after(() => api.close());
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    await writeTokenKubeconfig(directory, api),
    (message) => new Error(message),
  );
  const core = new sdk.CoreV1Api(clientConfiguration);
  const namespace = { apiVersion: "v1", kind: "Namespace", metadata: { name: "tenant" } };

  const created = await core.createNamespace({ body: namespace });
  assert.equal(created.metadata?.name, "tenant");
  assert.deepEqual(
    writes.map(({ method, body }) => ({ method, body: body && JSON.parse(body) })),
    [{ method: "POST", body: namespace }],
  );

  // Re-scoping for a peer operation must retain the enclosing owner's cancellation.
  const held = withComputeOperationDeadline(
    { signal: cancel.signal, deadlineAt: new Date(Date.now() + 20_000).toISOString() },
    () =>
      withComputeAbortSignal(new AbortController().signal, () =>
        core.readNamespace({ name: "held" }),
      ),
  ).then(
    () => "answered",
    (error) => error.name,
  );
  assert.equal(
    await Promise.race([held, delay(3_000, "still pending", { ref: false })]),
    "AbortError",
  );
});

test("Kubernetes dispatch retains the parent deadline through child and per-attempt scopes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const api = await recordingApiServer(directory, (_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ metadata: { name: "tenant" } }));
  });
  t.after(() => api.close());
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    await writeTokenKubeconfig(directory, api),
    (message) => new Error(message),
  );
  const core = new sdk.CoreV1Api(clientConfiguration);
  const signal = new AbortController().signal;
  const deadline = Date.now() + 20_000;
  const timeout = new Error("request timed out");
  const failures = {
    cancelled: (error) => error,
    failed: (error) => error,
    timedOut: () => timeout,
  };
  await assert.rejects(
    withComputeOperationDeadline({ signal, deadlineAt: new Date(deadline).toISOString() }, () =>
      withComputeOperationDeadline(
        { signal, deadlineAt: new Date(deadline + 60_000).toISOString() },
        () =>
          kubernetesRequest(() => {
            // Only wall time advances after attempt setup. No timeout callback has run,
            // so the actual SDK HTTP dispatch must enforce the enclosing absolute bound.
            t.mock.method(Date, "now", () => deadline);
            return core.readNamespace({ name: "tenant" });
          }, failures),
      ),
    ),
    { name: "TimeoutError" },
  );
  t.mock.restoreAll();
  await assert.rejects(
    withComputeOperationDeadline({ signal, deadlineAt: "invalid" }, () =>
      core.readNamespace({ name: "tenant" }),
    ),
    { name: "TimeoutError" },
  );
  assert.equal(requests, 0, "expired or invalid lifetimes never reach the Kubernetes API");
});
