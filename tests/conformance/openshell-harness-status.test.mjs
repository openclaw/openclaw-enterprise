import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";

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
                  real.listen(http.port, "127.0.0.1");
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
      for (const request of [
        { url: "/" },
        { url: "/openclaw/runtime/diagnostics" },
        { url: "/openclaw/plugin-runtime/status" },
        { method: "POST" },
      ]) {
        const refused = call(handler, request);
        assert.equal(refused.status, 401, JSON.stringify(request));
        assert.deepEqual(refused.body, { error: "unauthorized" });
        const missing = call(handler, { ...request, authorization: `Bearer ${TOKEN}` });
        assert.equal(missing.status, 404);
        assert.deepEqual(missing.body, { error: "not_found" });
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
  const probeServer = createServer();
  const freePort = await listen(probeServer);
  await close(probeServer);
  const { servers } = runCodexEntrypoint({
    env: providerEnv,
    probe: failedProbe("stream error: model unavailable"),
    http: { createServer, port: freePort },
  });
  const held = servers.find((server) => server.real !== undefined);
  t.after(() => close(held.real));
  await new Promise((resolve) =>
    held.real.listening ? resolve() : held.real.once("listening", resolve),
  );
  const client = new GrpcOpenShellGatewayClient({ endpoint: `http://127.0.0.1:${freePort}` });
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

test("an unreachable OpenShell gateway listener is a dependency failure, not a starting Harness", async () => {
  const server = createServer();
  const port = await listen(server);
  await close(server);
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
      assert.match(error.message, /timed out/);
      return true;
    });
  }
});

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
      "/CN=openshell-gateway",
      "-addext",
      `subjectAltName=${subjectAltName}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
  return { keyPath, certPath };
}

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
  const { keyPath, certPath } = selfSignedCertificate(directory, "tls", "DNS:localhost");
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
        const { keyPath, certPath } = selfSignedCertificate(directory, name, san);
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
