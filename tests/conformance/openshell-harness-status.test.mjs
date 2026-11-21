import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, Server as HttpServer } from "node:http";
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
import { temporaryDirectorySync } from "../helpers/temporary-directory.mjs";
import {
  assertCodexHeldFailure,
  assertHeldServiceHost,
  codexHeldCases,
  registerOpenShellCodexReadinessCases,
} from "./openshell-harness-codex-readiness-cases.ts";
import {
  assertHarnessDiagnostics,
  assertNativeHeldFailure,
  close,
  readHarnessRecord,
  nativeHeldCases,
  readHarnessEvent,
  registerNativeStatusCases,
  registerOpenShellServiceTransportCases,
} from "./openshell-harness-service-transport-cases.ts";

// A provider-owned Codex Harness (OpenShell) receives only the transport token's
// verifier and no Compute status port. When it holds a startup failure it serves
// that failure on the app-server port to the token holder, and Compute reads it
// through the provider's bearer-passthrough exposure (finding D546).

const nodeRequire = createRequire(import.meta.url);
const TOKEN = "fixture-transport-token";
const serviceUrl = "http://tenant--sandbox.openshell.localhost:8080/";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const started = { type: "thread.started", thread_id: "thread" };
const turnStarted = { type: "turn.started" };
const assistant = { type: "item.completed", item: { type: "agent_message", text: "READY" } };
const completed = { type: "turn.completed" };

registerOpenShellCodexReadinessCases(TOKEN, serviceUrl);

function runCodexEntrypoint({ env, login = { status: 0 }, probe, http }) {
  const directory = mkdtempSync(join(tmpdir(), "openshell-held-failure-"));
  /** @type {import("./openshell-harness-service-transport-cases.ts").HarnessServer[]} */
  const servers = [];
  /** @type {unknown[]} */
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
          /** @param {import("./openshell-harness-service-transport-cases.ts").HarnessHandler} handler */
          createServer(handler) {
            /** @type {import("./openshell-harness-service-transport-cases.ts").HarnessServer} */
            const server = { handler, listening: undefined };
            servers.push(server);
            if (http !== undefined) {
              /** @type {unknown} */
              const real = http.createServer(handler);
              assert.ok(real instanceof HttpServer, "expected the real HTTP server");
              server.real = real;
              return {
                /** @param {"error"} event @param {(error: Error & { code?: string }) => void} listener */
                on(event, listener) {
                  real.on(event, listener);
                },
                /** @param {number} port @param {string} host */
                listen(port, host) {
                  server.listening = { port, host };
                  // The kernel picks a free loopback port, so no other socket can take it
                  // between the pick and the bind; the test reads it once listening.
                  real.listen(0, "127.0.0.1");
                },
              };
            }
            return {
              /** @param {"error"} event @param {(error: Error & { code?: string }) => void} listener */
              on(event, listener) {
                if (event === "error") {
                  server.onError = listener;
                }
              },
              /** @param {number} port @param {string} host */
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

/**
 * @param {import("./openshell-harness-service-transport-cases.ts").HarnessHandler} handler
 * @param {Parameters<import("./openshell-harness-service-transport-cases.ts").HarnessCall>[1]} options
 */
function call(handler, { method = "GET", url = "/openclaw/runtime/status", authorization }) {
  /** @type {number | undefined} */
  let status;
  /** @type {import("node:http").OutgoingHttpHeaders | undefined} */
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
  /** @type {unknown} */
  const decoded = JSON.parse(body);
  return { status, headers, body: readHarnessRecord(decoded) };
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
    ...codexHeldCases(
      failedProbe("stream error: model unavailable"),
      failedProbe("unexpected status 401 Unauthorized: invalid api key"),
    ),
  ]) {
    await t.test(name, () => {
      const { servers, diagnostics, appServerStarts } = runCodexEntrypoint({
        env: providerEnv,
        login: options.login,
        probe: options.probe,
        http: undefined,
      });
      assertHarnessDiagnostics(diagnostics);
      assertCodexHeldFailure(
        { servers, diagnostics, appServerStarts },
        expected,
        TOKEN,
        sha256(TOKEN),
        call,
      );
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

test("the OpenShell client reads a held failure from the real Harness wrapper through the service host", async (t) => {
  const { servers } = runCodexEntrypoint({
    env: providerEnv,
    probe: failedProbe("stream error: model unavailable"),
    http: { createServer },
  });
  const held = servers.find((server) => server.real !== undefined);
  await assertHeldServiceHost(t, held, TOKEN, serviceUrl);
});

registerOpenShellServiceTransportCases(TOKEN, serviceUrl);

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
    const listening = servers.find((server) => server.listening !== undefined);
    assert.ok(listening);
    const { handler } = listening;
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
    const listening = servers.find((server) => server.listening !== undefined);
    assert.ok(listening);
    const { handler } = listening;
    const answer = call(handler, { url: "//" });
    assert.equal(answer.status, 400);
    assert.deepEqual(answer.body, badRequest);
    assert.equal(
      readHarnessRecord(call(handler, {}).body.runtimeFailure).code,
      "MODEL_PROBE_FAILED",
    );
  });

  await t.test(
    "the dedicated OpenClaw worker readiness port answers before any route check",
    () => {
      const stop = new Error("stop after the readiness server starts");
      let handler;
      const directory = temporaryDirectorySync(t, "native-worker-readiness-");
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
    assert.ok(held?.real);
    const real = held.real;
    t.after(() => close(real));
    if (!real.listening) {
      await new Promise((resolve) => real.once("listening", resolve));
    }
    const address = real.address();
    assert.ok(address !== null && typeof address !== "string");
    const heldPort = address.port;
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
/** @param {import("./openshell-harness-service-transport-cases.ts").NativeEntrypointOptions} options */
function runNativeWorkerEntrypoint({ env = {}, upfrontStatus = 3, upfrontStdout, probeStatus }) {
  const directory = mkdtempSync(join(tmpdir(), "native-held-failure-"));
  /** @type {import("./openshell-harness-service-transport-cases.ts").HarnessServer[]} */
  const servers = [];
  /** @type {unknown[]} */
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
          /** @param {import("./openshell-harness-service-transport-cases.ts").HarnessHandler} handler */
          createServer(handler) {
            /** @type {import("./openshell-harness-service-transport-cases.ts").HarnessServer} */
            const server = { handler, listening: undefined };
            servers.push(server);
            return {
              /** @param {"error"} event @param {(error: Error & { code?: string }) => void} listener */
              on(event, listener) {
                if (event === "error") {
                  server.onError = listener;
                }
              },
              /** @param {number} port @param {string} host */
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
          existsSync: (path) => String(path).startsWith("/app/") || realFs.existsSync(path),
          lstatSync: (path) =>
            String(path).startsWith("/app/") ? { isDirectory: () => true } : realFs.lstatSync(path),
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
            // The CLI loads the CPU window preload from its own probe directory.
            assert.equal(args[0], "--require");
            assert.match(args[1], /\/openclaw-auth-probe-[^/]+\/cpu-window\.cjs$/);
            assert.equal(args[2], "/app/openclaw.mjs");
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
  assertHarnessDiagnostics(diagnostics);
  const events = diagnostics
    .filter((line) => typeof line === "string" && line.startsWith("{"))
    .map(readHarnessEvent);
  return { servers, diagnostics, events, connectStarts };
}

const nativeProviderEnv = { APP_TOKEN_SHA: sha256(TOKEN), APP_SERVER_PORT: "18790" };

test("a provider-owned native OpenClaw worker serves its held model-check failure to the transport token holder", async (t) => {
  const hostile = "sk-proj-HostileFixtureKey0123456789abcdef";
  for (const [name, upfrontStatus, providerCode, responseHeaderMarker, upfrontStdout, body] of [
    ...nativeHeldCases(hostile),
  ]) {
    await t.test(name, () => {
      const { servers, diagnostics, events, connectStarts } = runNativeWorkerEntrypoint({
        env: nativeProviderEnv,
        upfrontStatus,
        upfrontStdout,
      });
      assertNativeHeldFailure(
        { servers, diagnostics, events, connectStarts },
        { providerCode, responseHeaderMarker, body },
        TOKEN,
        sha256(TOKEN),
        call,
      );
    });
  }
});

registerNativeStatusCases(TOKEN, nativeProviderEnv, runNativeWorkerEntrypoint, call);
