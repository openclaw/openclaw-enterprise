import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  AGENT_RUNTIME_ENTRYPOINT,
  NATIVE_WORKER_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellServiceTransportError } from "../../apps/controller/src/drivers/sandbox/openshell-service-transport.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { refusingPort } from "../helpers/available-port.mjs";
import { selfSigned } from "../helpers/certificates.mjs";

// A provider-owned Codex Harness (OpenShell) receives only the transport token's
// verifier and no Compute status port. When it holds a startup failure it serves
// that failure on the app-server port to the token holder, and Compute reads it
// through the provider's bearer-passthrough exposure (finding D546).

const nodeRequire = createRequire(import.meta.url);
const TOKEN = "fixture-transport-token";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const started = { type: "thread.started", thread_id: "thread" };
const turnStarted = { type: "turn.started" };
const assistant = { type: "item.completed", item: { type: "agent_message", text: "READY" } };
const completed = { type: "turn.completed" };

function runCodexEntrypoint({ env, login = { status: 0 }, probe, http }) {
  const directory = mkdtempSync(join(tmpdir(), "openshell-held-failure-"));
  const servers = [];
  const diagnostics = [];
  let appServerStarts = 0;
  const sandbox = {
    URL,
    Buffer,
    setTimeout() {},
    setInterval() {},
    console: { error: (message) => diagnostics.push(message) },
    process: {
      env: {
        CODEX_HOME: join(directory, "codex"),
        CODEX_LOGIN_MODE: "api_key",
        OPENAI_API_KEY: "fixture-api-key",
        OPENCLAW_HARNESS_MODEL: "codex/gpt-4.1",
        APP_SERVER_PORT: "4500",
        ...env,
      },
      on() {},
      exit() {
        assert.fail("startup must hold its failure or start the app server");
      },
    },
    require(specifier) {
      if (specifier === "node:http") {
        return {
          createServer(handler) {
            const server = { handler, listening: undefined };
            servers.push(server);
            if (http !== undefined) {
              const real = http.createServer(handler);
              server.real = real;
              return {
                on(event, listener) {
                  real.on(event, listener);
                },
                listen(port, host) {
                  server.listening = { port, host };
                  // The kernel picks a free loopback port, so no other socket can take it
                  // between the pick and the bind; the test reads it once listening.
                  real.listen(0, "127.0.0.1");
                },
              };
            }
            return {
              on(event, listener) {
                if (event === "error") {
                  server.onError = listener;
                }
              },
              listen(port, host) {
                server.listening = { port, host };
              },
            };
          },
        };
      }
      if (specifier === "node:fs") {
        return {
          mkdirSync() {},
          mkdtempSync: () => mkdtempSync(join(directory, "probe-")),
          rmSync,
          readFileSync() {
            throw new Error("no plugin runtime payload is configured");
          },
          writeFileSync() {},
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawnSync(_command, args) {
            if (args.includes("login")) {
              return login;
            }
            return probe;
          },
          spawn(_command, args) {
            assert.ok(args.includes("app-server"));
            appServerStarts++;
            return { on() {}, kill() {}, stderr: undefined };
          },
        };
      }
      return nodeRequire(specifier);
    },
  };
  try {
    vm.runInNewContext(AGENT_RUNTIME_ENTRYPOINT, sandbox);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return { servers, diagnostics, appServerStarts };
}

function call(handler, { method = "GET", url = "/openclaw/runtime/status", authorization }) {
  let status;
  let headers;
  let body = "";
  handler(
    {
      method,
      url,
      headers: authorization === undefined ? {} : { authorization },
    },
    {
      writeHead(code, values) {
        status = code;
        headers = values;
      },
      end(chunk) {
        body += chunk ?? "";
      },
    },
  );
  return { status, headers, body: JSON.parse(body) };
}

const providerEnv = { APP_TOKEN_SHA: sha256(TOKEN) };
const failedProbe = (message) => ({
  status: 1,
  stdout: [started, turnStarted, { type: "turn.failed", error: { message } }]
    .map((event) => JSON.stringify(event))
    .join("\n"),
});

test("a provider-owned Codex Harness serves its held startup failure only to the transport token holder", async (t) => {
  for (const [name, options, expected] of [
    [
      "failed model probe",
      { probe: failedProbe("stream error: model unavailable") },
      {
        check: "model-probe",
        code: "MODEL_PROBE_FAILED",
        cause: { kind: "PROBE_STATUS", detail: "turn-failed" },
      },
    ],
    [
      "rejected model key",
      { probe: failedProbe("unexpected status 401 Unauthorized: invalid api key") },
      { check: "model-probe", code: "AUTHENTICATION_FAILED" },
    ],
    [
      "failed login",
      { login: { status: 1, stderr: "login failed" } },
      { check: "login", code: "LOGIN_FAILED" },
    ],
  ]) {
    await t.test(name, () => {
      const { servers, diagnostics, appServerStarts } = runCodexEntrypoint({
        env: providerEnv,
        ...options,
      });
      assert.equal(appServerStarts, 0, "a held failure never starts the app-server");
      assert.ok(diagnostics.includes("Harness model authentication probe failed."));
      const listening = servers.filter((server) => server.listening !== undefined);
      assert.equal(listening.length, 1);
      assert.deepEqual(listening[0].listening, { port: 4500, host: "0.0.0.0" });
      const { handler } = listening[0];
      // A listen error is logged by code only and the wrapper keeps holding.
      listening[0].onError(
        Object.assign(new Error("listen EADDRINUSE 0.0.0.0:4500"), {
          code: "EADDRINUSE",
        }),
      );
      assert.equal(diagnostics.at(-1), "Held runtime failure server failed: EADDRINUSE");

      const answer = call(handler, { authorization: `Bearer ${TOKEN}` });
      assert.equal(answer.status, 200);
      assert.equal(answer.headers["cache-control"], "no-store");
      const { checkedAt, ...failure } = answer.body.runtimeFailure;
      assert.ok(!Number.isNaN(Date.parse(checkedAt)));
      assert.deepEqual(failure, { component: "agent", ...expected });
      assert.deepEqual(Object.keys(answer.body), ["runtimeFailure"]);
      // Lower-case scheme is the same credential.
      assert.equal(call(handler, { authorization: `bearer ${TOKEN}` }).status, 200);

      for (const authorization of [
        undefined,
        "",
        `Bearer ${TOKEN}x`,
        `Bearer ${sha256(TOKEN)}`,
        `Basic ${TOKEN}`,
        `Bearer  ${TOKEN}`,
        `Bearer ${TOKEN} extra`,
      ]) {
        const refused = call(handler, { authorization });
        assert.equal(refused.status, 401, String(authorization));
        assert.deepEqual(refused.body, { error: "unauthorized" });
      }
      // The token is checked first: without it every other path and method is the same 401.
      // With it, anything but the status read (such as the Agent Gateway's app-server
      // upgrade on /) is told the Harness is unavailable and the held code, nothing more.
      for (const request of [
        { url: "/" },
        { url: "/openclaw/runtime/diagnostics" },
        { url: "/openclaw/plugin-runtime/status" },
        { method: "POST" },
      ]) {
        const refused = call(handler, request);
        assert.equal(refused.status, 401, JSON.stringify(request));
        assert.deepEqual(refused.body, { error: "unauthorized" });
        const unavailable = call(handler, { ...request, authorization: `Bearer ${TOKEN}` });
        assert.equal(unavailable.status, 503, JSON.stringify(request));
        assert.equal(unavailable.headers["cache-control"], "no-store");
        assert.deepEqual(unavailable.body, { error: "runtime_failure_held", code: expected.code });
      }
    });
  }
});

test("a Compute-owned Codex Harness keeps its held failure on the private status port", () => {
  const { servers, appServerStarts } = runCodexEntrypoint({
    env: {
      APP_SERVER_TOKEN: TOKEN,
      OPENCLAW_AGENT_REVISION_ID: "rev_fixture",
      OPENCLAW_RUNTIME_STATUS_CONTAINER: "agent",
      OPENCLAW_RUNTIME_STATUS_PORT: "18791",
      OPENCLAW_POD_UID: "pod-fixture",
    },
    probe: failedProbe("stream error: model unavailable"),
  });
  assert.equal(appServerStarts, 0);
  assert.deepEqual(
    servers.map((server) => server.listening),
    [{ port: 18791, host: "0.0.0.0" }],
    "nothing but the Compute status server listens",
  );
});

test("a provider-owned Codex Harness with a working model starts the app-server and serves no status", () => {
  const { servers, appServerStarts } = runCodexEntrypoint({
    env: providerEnv,
    probe: {
      status: 0,
      stdout: [started, turnStarted, assistant, completed]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    },
  });
  assert.equal(appServerStarts, 1);
  assert.deepEqual(
    servers.filter((server) => server.listening !== undefined),
    [],
  );
});

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

const serviceUrl = "http://tenant--sandbox.openshell.localhost:8080/";

test("the OpenShell client reads a held failure from the real Harness wrapper through the service host", async (t) => {
  const { servers } = runCodexEntrypoint({
    env: providerEnv,
    probe: failedProbe("stream error: model unavailable"),
    http: { createServer },
  });
  const held = servers.find((server) => server.real !== undefined);
  t.after(() => close(held.real));
  await new Promise((resolve) =>
    held.real.listening ? resolve() : held.real.once("listening", resolve),
  );
  const heldPort = held.real.address().port;
  const client = new GrpcOpenShellGatewayClient({ endpoint: `http://127.0.0.1:${heldPort}` });
  const signal = AbortSignal.timeout(5_000);
  const document = await client.getServiceDocument(
    serviceUrl,
    "/openclaw/runtime/status",
    TOKEN,
    signal,
  );
  assert.equal(document.status, 200);
  assert.equal(document.json.runtimeFailure.code, "MODEL_PROBE_FAILED");
  assert.deepEqual(
    await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", "other", signal),
    { status: 401, json: { error: "unauthorized" } },
  );
  // The held wrapper is not a Codex app-server: no WebSocket handshake completes.
  assert.equal(await client.serviceWebSocketHandshake(serviceUrl, TOKEN, signal), false);
  // The Agent Gateway's own upgrade gets 503 naming the held code, not a missing route.
  const upgrade = await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: heldPort,
      path: "/",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "AAAAAAAAAAAAAAAAAAAAAA==",
      },
      signal,
    });
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("the held wrapper must not upgrade"));
    });
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    request.on("error", reject);
    request.end();
  });
  assert.deepEqual(upgrade, {
    status: 503,
    body: JSON.stringify({ error: "runtime_failure_held", code: "MODEL_PROBE_FAILED" }),
  });
});

test("the OpenShell client reaches a bearer-passthrough service through the gateway listener", async (t) => {
  const seen = [];
  let answer = (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ runtimeFailure: { code: "MODEL_PROBE_FAILED" } }));
  };
  let upgrade = (request, socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.end(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  };
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
    await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", TOKEN, signal),
    { status: 200, json: { runtimeFailure: { code: "MODEL_PROBE_FAILED" } } },
  );
  assert.deepEqual(seen.at(-1), {
    method: "GET",
    url: "/openclaw/runtime/status",
    host: "tenant--sandbox.openshell.localhost:8080",
    authorization: `Bearer ${TOKEN}`,
  });

  // OpenShell's own refusals are plain text: never a status document.
  answer = (_request, response) => {
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("Service endpoint is not reachable");
  };
  assert.deepEqual(
    await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", TOKEN, signal),
    { status: 502 },
  );
  answer = (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ padding: "x".repeat(20_000) }));
  };
  assert.deepEqual(
    await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", TOKEN, signal),
    { status: 200 },
    "an oversized answer is not parsed",
  );
  answer = (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{not json");
  };
  assert.deepEqual(
    await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", TOKEN, signal),
    { status: 200 },
  );
  // A JSON body under another content type is still not a status document.
  answer = (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(JSON.stringify({ runtimeFailure: { code: "MODEL_PROBE_FAILED" } }));
  };
  assert.deepEqual(
    await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", TOKEN, signal),
    { status: 200 },
  );

  assert.equal(await client.serviceWebSocketHandshake(serviceUrl, TOKEN, signal), true);
  assert.deepEqual(seen.at(-1), {
    upgrade: "websocket",
    url: "/",
    host: "tenant--sandbox.openshell.localhost:8080",
    authorization: `Bearer ${TOKEN}`,
  });
  upgrade = (_request, socket) => {
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n",
    );
  };
  assert.equal(
    await client.serviceWebSocketHandshake(serviceUrl, TOKEN, signal),
    false,
    "a handshake must echo this request's key",
  );
  upgrade = (_request, socket) => {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  };
  assert.equal(await client.serviceWebSocketHandshake(serviceUrl, TOKEN, signal), false);

  for (const bearer of ["", "two words", "line\nbreak"]) {
    await assert.rejects(
      client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", bearer, signal),
      /token68/,
    );
  }
  for (const origin of [
    "http://user:pass@host/",
    "http://host/path",
    "http://host/?query",
    "ftp://host/",
    "not a url",
  ]) {
    await assert.rejects(
      client.getServiceDocument(origin, "/x", TOKEN, signal),
      /HTTP origin|valid URL/,
      origin,
    );
  }
  for (const path of ["openclaw/runtime/status", "//other.example.test/x"]) {
    await assert.rejects(
      client.getServiceDocument(serviceUrl, path, TOKEN, signal),
      /must be absolute/,
      path,
    );
  }

  const aborted = new AbortController();
  answer = () => aborted.abort(new Error("caller cancelled"));
  await assert.rejects(
    client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", TOKEN, aborted.signal),
    /caller cancelled/,
  );
});

test("a refused OpenShell WebSocket handshake releases an unfinished HTTP response", async () => {
  let socket;
  let closed = false;
  let markClosed;
  const closing = new Promise((resolve) => (markClosed = resolve));
  const gateway = createServer();
  gateway.on("upgrade", (_request, peer) => {
    socket = peer;
    peer.resume();
    peer.once("end", () => peer.end());
    peer.once("close", () => {
      closed = true;
      markClosed();
    });
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
      await client.serviceWebSocketHandshake(serviceUrl, TOKEN, AbortSignal.timeout(5_000)),
      false,
    );
    // Disposal must happen even though send() clears the completed request's timer: the socket
    // closes within 1.5 s (the wait ends as soon as it does).
    let timer;
    await Promise.race([closing, new Promise((resolve) => (timer = setTimeout(resolve, 1_500)))]);
    clearTimeout(timer);
    assert.equal(closed, true, "a completed refusal must not retain its HTTP socket");
  } finally {
    // Complete the base implementation's held response without manufacturing a reset.
    socket?.end("x".repeat(93));
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
        TOKEN,
        AbortSignal.timeout(5_000),
      ),
    () => client.serviceWebSocketHandshake(serviceUrl, TOKEN, AbortSignal.timeout(5_000)),
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
  const held = [];
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
    (signal) => client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", TOKEN, signal),
    (signal) => client.serviceWebSocketHandshake(serviceUrl, TOKEN, signal),
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

const selfSignedCertificate = (directory, name, subjectAltName) =>
  selfSigned(directory, { name, commonName: "openshell-gateway", subjectAltName });

// A TLS gateway listener that records the SNI and Host of every request it receives.
function tlsGateway(keyPath, certPath, seen) {
  const gateway = createSecureServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (request, response) => {
      seen.push({ servername: request.socket.servername, host: request.headers.host });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ runtimeFailure: { code: "MODEL_PROBE_FAILED" } }));
    },
  );
  gateway.on("upgrade", (request, socket) => {
    seen.push({ servername: socket.servername, host: request.headers.host });
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.end(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  return gateway;
}

test("the OpenShell client verifies a TLS gateway listener against its root certificate and name", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "openshell-service-tls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // The certificate names only the control endpoint, never the service host.
  const { keyPath, certPath } = await selfSignedCertificate(directory, "tls", "DNS:localhost");
  const seen = [];
  const gateway = tlsGateway(keyPath, certPath, seen);
  const port = await listen(gateway);
  t.after(() => close(gateway));
  const signal = AbortSignal.timeout(5_000);
  // SNI needs a name. The listener is IPv4; Node falls back to it if localhost resolves to ::1.
  const endpoint = `https://localhost:${port}`;
  const client = new GrpcOpenShellGatewayClient({ endpoint, rootCertificatePath: certPath });

  // TLS is verified against the control endpoint's name (SNI), while Host names the service.
  assert.deepEqual(
    await client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", TOKEN, signal),
    { status: 200, json: { runtimeFailure: { code: "MODEL_PROBE_FAILED" } } },
  );
  assert.equal(await client.serviceWebSocketHandshake(serviceUrl, TOKEN, signal), true);
  assert.deepEqual(seen, [
    { servername: "localhost", host: "tenant--sandbox.openshell.localhost:8080" },
    { servername: "localhost", host: "tenant--sandbox.openshell.localhost:8080" },
  ]);

  // Without the gateway CA the listener cannot be verified: an outage, not a starting Harness.
  const untrusted = new GrpcOpenShellGatewayClient({ endpoint });
  for (const observe of [
    () => untrusted.getServiceDocument(serviceUrl, "/openclaw/runtime/status", TOKEN, signal),
    () => untrusted.serviceWebSocketHandshake(serviceUrl, TOKEN, signal),
  ]) {
    await assert.rejects(observe(), (error) => {
      assert.ok(error instanceof DependencyUnavailableError, String(error));
      return true;
    });
  }
  assert.equal(seen.length, 2, "an unverified listener never receives the bearer");
});

test("the OpenShell client verifies an IP-literal TLS gateway listener against the endpoint address, not Host", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "openshell-service-tls-ip-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // IPv6 loopback is optional on CI hosts; without it the IPv6 cases are skipped.
  const probe = createServer();
  const ipv6 = await new Promise((resolve) => {
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
        const seen = [];
        const gateway = tlsGateway(keyPath, certPath, seen);
        const port = await listen(gateway, bind);
        t.after(() => close(gateway));
        const endpoint = `https://${host}:${port}`;
        const client = new GrpcOpenShellGatewayClient({ endpoint, rootCertificatePath: certPath });
        const signal = AbortSignal.timeout(5_000);
        const observations = [
          () => client.getServiceDocument(serviceUrl, "/openclaw/runtime/status", TOKEN, signal),
          () => client.serviceWebSocketHandshake(serviceUrl, TOKEN, signal),
        ];
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

// Finding 1605: a request target that does not parse as a URL path, such as "//",
// used to throw in a wrapper's HTTP handler. Node then ends the wrapper process,
// the container restarts and the startup model probe runs (and may bill) again.
// Each wrapper status server answers 400 instead and keeps serving.
test("runtime wrapper status servers answer 400 to a request target that is not a path", async (t) => {
  const badRequest = { error: "bad_request" };
  await t.test("the provider-owned held failure checks the token first", () => {
    const { servers } = runCodexEntrypoint({
      env: providerEnv,
      probe: failedProbe("stream error: model unavailable"),
    });
    const { handler } = servers.find((server) => server.listening !== undefined);
    for (const url of ["//", "//:99999"]) {
      const refused = call(handler, { url });
      assert.equal(refused.status, 401, url);
      assert.deepEqual(refused.body, { error: "unauthorized" });
      const malformed = call(handler, { url, authorization: `Bearer ${TOKEN}` });
      assert.equal(malformed.status, 400, url);
      assert.deepEqual(
        { ...malformed.headers },
        {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      );
      assert.deepEqual(malformed.body, badRequest);
    }
    assert.equal(call(handler, { authorization: `Bearer ${TOKEN}` }).status, 200);
  });

  await t.test("the Compute status port answers before any route or token check", () => {
    const { servers } = runCodexEntrypoint({
      env: {
        APP_SERVER_TOKEN: TOKEN,
        OPENCLAW_AGENT_REVISION_ID: "rev_fixture",
        OPENCLAW_RUNTIME_STATUS_CONTAINER: "agent",
        OPENCLAW_RUNTIME_STATUS_PORT: "18791",
        OPENCLAW_POD_UID: "pod-fixture",
      },
      probe: failedProbe("stream error: model unavailable"),
    });
    const { handler } = servers.find((server) => server.listening !== undefined);
    const answer = call(handler, { url: "//" });
    assert.equal(answer.status, 400);
    assert.deepEqual(answer.body, badRequest);
    assert.equal(call(handler, {}).body.runtimeFailure.code, "MODEL_PROBE_FAILED");
  });

  await t.test(
    "the dedicated OpenClaw worker readiness port answers before any route check",
    () => {
      const stop = new Error("stop after the readiness server starts");
      let handler;
      const directory = mkdtempSync(join(tmpdir(), "native-worker-readiness-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      assert.throws(
        () =>
          vm.runInNewContext(NATIVE_WORKER_ENTRYPOINT, {
            URL,
            Buffer,
            console: { error() {} },
            process: {
              execPath: process.execPath,
              env: {
                OPENCLAW_RUNTIME_STATUS_PORT: "18789",
                OPENCLAW_NATIVE_INFERENCE_CONFIG: "{}",
                OPENCLAW_NODE_STATE_DIR: join(directory, "state"),
                OPENCLAW_NODE_SETUP_CODE: "fixture-setup-code",
                OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
                TMPDIR: join(directory, "tmp"),
                OPENCLAW_NATIVE_WORKER_CAPACITY: "1",
              },
            },
            require(specifier) {
              if (specifier === "node:http") {
                return {
                  createServer(value) {
                    handler = value;
                    return { on() {}, listen() {} };
                  },
                };
              }
              if (specifier === "node:fs") {
                // The worker starts its readiness server, then prepares its private TMPDIR
                // with mkdirSync; stopping there leaves only the readiness server running.
                return {
                  ...nodeRequire("node:fs"),
                  mkdirSync() {
                    throw stop;
                  },
                };
              }
              return nodeRequire(specifier);
            },
          }),
        (error) => error === stop,
      );
      assert.equal(typeof handler, "function");
      let status;
      let body = "";
      handler(
        { method: "GET", url: "//", headers: {} },
        {
          writeHead(code) {
            status = code;
          },
          end(chunk) {
            body += chunk ?? "";
          },
        },
      );
      assert.equal(status, 400);
      assert.deepEqual(JSON.parse(body), badRequest);
    },
  );

  await t.test("a raw request target over HTTP leaves the held wrapper serving", async (t) => {
    const { servers } = runCodexEntrypoint({
      env: providerEnv,
      probe: failedProbe("stream error: model unavailable"),
      http: { createServer },
    });
    const held = servers.find((server) => server.real !== undefined);
    t.after(() => close(held.real));
    await new Promise((resolve) =>
      held.real.listening ? resolve() : held.real.once("listening", resolve),
    );
    const heldPort = held.real.address().port;
    // The request line carries "//" verbatim; HTTP clients would normalize it.
    const raw = await new Promise((resolve, reject) => {
      const socket = connect(heldPort, "127.0.0.1");
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        text += chunk;
      });
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
      socket.end(
        `GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`,
      );
    });
    assert.match(raw, /^HTTP\/1\.1 400 /);
    assert.ok(raw.includes(JSON.stringify(badRequest)), raw);
    // The same wrapper still serves its held failure afterwards.
    const signal = AbortSignal.timeout(5_000);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `http://127.0.0.1:${heldPort}` });
    const document = await client.getServiceDocument(
      serviceUrl,
      "/openclaw/runtime/status",
      TOKEN,
      signal,
    );
    assert.equal(document.status, 200);
  });
});

// A provider-owned dedicated OpenClaw worker (finding 1642) holds a failed model
// check the same way: it never connects its node, so without this nothing reports
// the hold and the revision waits for its deadline as WORKSPACE_NODE_PENDING.
function runNativeWorkerEntrypoint({ env = {}, upfrontStatus = 3, upfrontStdout, probeStatus }) {
  const directory = mkdtempSync(join(tmpdir(), "native-held-failure-"));
  const servers = [];
  const diagnostics = [];
  let connectStarts = 0;
  const realFs = nodeRequire("node:fs");
  const sandbox = {
    URL,
    Buffer,
    AbortSignal,
    setTimeout() {},
    setInterval() {},
    console: { error: (message) => diagnostics.push(message) },
    process: {
      execPath: process.execPath,
      env: {
        HOME: join(directory, "home"),
        TMPDIR: join(directory, "tmp"),
        OPENCLAW_NATIVE_INFERENCE_CONFIG: "{}",
        OPENCLAW_NODE_STATE_DIR: join(directory, "state"),
        OPENCLAW_NODE_SETUP_CODE: "fixture-setup-code",
        OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
        OPENCLAW_NATIVE_WORKER_CAPACITY: "1",
        OPENCLAW_HARNESS_MODEL: "openai/gpt-5",
        OPENCLAW_HARNESS_PROVIDER: "openai",
        OPENCLAW_HARNESS_CREDENTIAL_ENV: "OPENAI_API_KEY",
        OPENAI_API_KEY: "fixture-model-key",
        OPENCLAW_HARNESS_PROBE_CONFIG: JSON.stringify({
          agents: { defaults: { model: "openai/gpt-5" } },
          models: { providers: { openai: {} } },
        }),
        ...env,
      },
      on() {},
      exit() {
        assert.fail("a held failure never exits the worker");
      },
    },
    require(specifier) {
      if (specifier === "node:http") {
        return {
          createServer(handler) {
            const server = { handler, listening: undefined };
            servers.push(server);
            return {
              on(event, listener) {
                if (event === "error") {
                  server.onError = listener;
                }
              },
              listen(port, host) {
                server.listening = { port, host };
              },
            };
          },
        };
      }
      if (specifier === "node:fs") {
        // The image asset trees exist and are non-empty; everything else is real
        // under the fixture directory.
        return {
          ...realFs,
          existsSync: () => true,
          lstatSync: () => ({ isDirectory: () => true }),
          readdirSync: (path) => (String(path).startsWith("/app/") ? ["asset"] : []),
          cpSync() {},
          chmodSync() {},
        };
      }
      if (specifier === "node:child_process") {
        return {
          execFile() {},
          // The upfront credential check: the exit status is a 401's header marker
          // (0 none, 10 provider-like, 20 openshell-policy, 30 mixed) plus its class (3 unclassified, 4
          // invalid_api_key, 5 missing_api_key, 6 insufficient_permissions); its
          // stdout is `upfrontStdout`, the 401 body's closed-set tokens. The full
          // probe, when reached, reports `probeStatus` for the model.
          spawnSync(command, args) {
            if (args[0] === "-e") {
              assert.equal(command, process.execPath);
              return { status: upfrontStatus, stdout: upfrontStdout };
            }
            assert.equal(command, "node");
            assert.equal(args[0], "/app/openclaw.mjs");
            return {
              status: 0,
              stdout: JSON.stringify({
                auth: {
                  probes: {
                    results: [
                      {
                        provider: "openai",
                        model: "openai/gpt-5",
                        source: "env",
                        status: probeStatus,
                        error: { message: "provider-detail for key fixture-model-key" },
                      },
                    ],
                  },
                },
              }),
            };
          },
          spawn() {
            connectStarts++;
            return { on() {}, kill() {} };
          },
        };
      }
      return nodeRequire(specifier);
    },
  };
  try {
    vm.runInNewContext(NATIVE_WORKER_ENTRYPOINT, sandbox);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const events = diagnostics
    .filter((line) => typeof line === "string" && line.startsWith("{"))
    .map((line) => JSON.parse(line));
  return { servers, diagnostics, events, connectStarts };
}

const nativeProviderEnv = { APP_TOKEN_SHA: sha256(TOKEN), APP_SERVER_PORT: "18790" };

test("a provider-owned native OpenClaw worker serves its held model-check failure to the transport token holder", async (t) => {
  const hostile = "sk-proj-HostileFixtureKey0123456789abcdef";
  for (const [name, upfrontStatus, providerCode, responseHeaderMarker, upfrontStdout, body] of [
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
  ]) {
    await t.test(name, () => {
      const { servers, diagnostics, events, connectStarts } = runNativeWorkerEntrypoint({
        env: nativeProviderEnv,
        upfrontStatus,
        upfrontStdout,
      });
      assert.equal(connectStarts, 0, "a held failure never starts the node");
      assert.ok(diagnostics.includes("Harness model authentication probe failed."));
      // The probe event names the HTTP status, a closed-vocabulary code and the
      // responder's closed-vocabulary source only.
      const probe = events.find((event) => event.event === "openclaw.model_probe");
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
      assert.deepEqual(listening[0].listening, { port: 18790, host: "0.0.0.0" });
      const { handler } = listening[0];
      const answer = call(handler, { authorization: `Bearer ${TOKEN}` });
      assert.equal(answer.status, 200);
      assert.equal(answer.headers["cache-control"], "no-store");
      const { checkedAt, ...failure } = answer.body.runtimeFailure;
      assert.ok(!Number.isNaN(Date.parse(checkedAt)));
      // The held code and nothing else: no cause, no provider status or text.
      assert.deepEqual(failure, {
        component: "agent",
        check: "model-probe",
        code: "AUTHENTICATION_FAILED",
      });
      assert.deepEqual(Object.keys(answer.body), ["runtimeFailure"]);
      for (const authorization of [undefined, `Bearer ${TOKEN}x`, `Bearer ${sha256(TOKEN)}`]) {
        const refused = call(handler, { authorization });
        assert.equal(refused.status, 401, String(authorization));
        assert.deepEqual(refused.body, { error: "unauthorized" });
      }
      const unavailable = call(handler, { url: "/", authorization: `Bearer ${TOKEN}` });
      assert.equal(unavailable.status, 503);
      assert.deepEqual(unavailable.body, {
        error: "runtime_failure_held",
        code: "AUTHENTICATION_FAILED",
      });
    });
  }
});

test("a provider-owned native OpenClaw worker serves a full-probe failure with its closed-vocabulary cause only", () => {
  const { servers, diagnostics, events, connectStarts } = runNativeWorkerEntrypoint({
    env: nativeProviderEnv,
    upfrontStatus: 0,
    probeStatus: "rate_limit",
  });
  assert.equal(connectStarts, 0);
  const probe = events.find((event) => event.event === "openclaw.model_probe");
  assert.equal(probe.code, "MODEL_PROBE_FAILED");
  assert.deepEqual(probe.cause, { kind: "PROBE_STATUS", detail: "rate_limit" });
  assert.equal(probe.providerStatus, undefined);
  for (const line of diagnostics) {
    assert.doesNotMatch(line, /fixture-model-key|provider-detail/);
  }
  const [{ handler }] = servers.filter((server) => server.listening !== undefined);
  const answer = call(handler, { authorization: `Bearer ${TOKEN}` });
  assert.equal(answer.status, 200);
  const { checkedAt, ...failure } = answer.body.runtimeFailure;
  assert.ok(!Number.isNaN(Date.parse(checkedAt)));
  assert.deepEqual(failure, {
    component: "agent",
    check: "model-probe",
    code: "MODEL_PROBE_FAILED",
    cause: { kind: "PROBE_STATUS", detail: "rate_limit" },
  });
  assert.doesNotMatch(JSON.stringify(answer.body), /fixture-model-key|provider-detail/);
  assert.deepEqual(call(handler, { url: "/", authorization: `Bearer ${TOKEN}` }).body, {
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
  let unidentified;
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
  const [{ handler: statusHandler }] = identified.servers;
  const status = call(statusHandler, {});
  assert.equal(status.status, 200);
  const { checkedAt, ...heldCheck } = status.body.runtimeFailure;
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
  const verifier = sha256(TOKEN);
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
