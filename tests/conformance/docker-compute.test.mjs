import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { inflateRawSync } from "node:zlib";
import {
  createDockerDevelopmentComputeDriverFromEnv,
  DockerComputeDriver,
} from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  ComputeGatewaySettingError,
  ConfigurationHarnessError,
} from "../../packages/occ/src/index.ts";
import { assertCleanupFailure } from "../helpers/compute-cleanup-failure.mjs";
import { unreadableGatewayPasswordRefusal } from "../helpers/refusal-text.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

test("Docker preflight rejects an interrupted response and can retry", async () => {
  // Redirect only the socket address in an isolated child. The real Driver,
  // Node HTTP client and response stream run against a local fault server.
  const source = String.raw`
import assert from "node:assert/strict";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
let interrupt = true;
const paths = [];
const server = http.createServer((request, response) => {
  assert.equal(request.method, "GET");
  paths.push(request.url);
  if (request.url === "/_ping") {
    response.end("OK");
  } else if (request.url === "/version" && interrupt) {
    // Send headers and part of the advertised body before the peer closes.
    response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
    response.write('{"Platform":');
    setTimeout(() => response.destroy(), 10);
  } else if (request.url === "/version") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ Platform: { Name: "Docker Engine" } }));
  } else {
    assert.equal(request.url, "/images/fixture-runtime%3Alocal/json");
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const nativeRequest = http.request;
http.request = (options, callback) => {
  assert.equal(options.socketPath, "/var/run/docker.sock");
  return nativeRequest({ ...options, socketPath: undefined, host: "127.0.0.1", port: server.address().port }, callback);
};
syncBuiltinESMExports();
let timer;
try {
  const { DockerComputeDriver } = await import(process.argv[1]);
  const driver = new DockerComputeDriver({ images: { gateway: "fixture-runtime:local", agent: "fixture-runtime:local" } });
  const result = await Promise.race([
    driver.preflight().then(() => ({ status: "resolved" }), (error) => ({ status: "rejected", code: error.code })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ status: "pending" }), 1_500); }),
  ]);
  assert.equal(result.status, "rejected", "Docker preflight remained pending after an interrupted response");
  assert.equal(result.code, "ECONNRESET");
  // A later complete response must still reach image qualification normally.
  interrupt = false;
  await driver.preflight();
  assert.deepEqual(paths, ["/_ping", "/version", "/_ping", "/version", "/images/fixture-runtime%3Alocal/json", "/images/fixture-runtime%3Alocal/json"]);
} finally {
  clearTimeout(timer);
  http.request = nativeRequest;
  syncBuiltinESMExports();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
`;
  const driver = new URL(
    "../../apps/controller/src/drivers/compute/docker/index.ts",
    import.meta.url,
  );
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, driver.href], {
    timeout: 10_000,
  });
});

test("Docker Compute rejects an unbounded API response before its request deadline", async () => {
  const source = String.raw`
import assert from "node:assert/strict";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
let interval;
let versionRequests = 0;
let streamedBytes = 0;
const limit = 4 * 1024 * 1024;
const server = http.createServer((request, response) => {
  if (request.url === "/_ping") {
    response.end("OK");
    return;
  }
  if (request.url.startsWith("/images/")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
    return;
  }
  assert.equal(request.url, "/version");
  versionRequests += 1;
  if (versionRequests === 3) {
    // Exactly at the cap, declared and sent: read whole.
    const empty = JSON.stringify({ Version: "27.0.0", Pad: "" });
    const body = empty.replace('"Pad":""', '"Pad":"' + "x".repeat(limit - empty.length) + '"');
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });
    response.end(body);
    return;
  }
  if (versionRequests === 1) {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(4 * 1024 * 1024 + 1),
    });
    response.flushHeaders();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  interval = setInterval(() => {
    response.write(chunk);
    streamedBytes += chunk.length;
  }, 5);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const nativeRequest = http.request;
http.request = (options, callback) =>
  nativeRequest({ ...options, socketPath: undefined, host: "127.0.0.1", port: server.address().port }, callback);
syncBuiltinESMExports();
try {
  const { DockerComputeDriver } = await import(process.argv[1]);
  const driver = new DockerComputeDriver({ images: { gateway: "fixture:local", agent: "fixture:local" } });
  await assert.rejects(driver.preflight(), { message: "Docker API response is too large." });
  assert.equal(streamedBytes, 0);
  await assert.rejects(driver.preflight(), { message: "Docker API response is too large." });
  assert.ok(streamedBytes > 4 * 1024 * 1024, String(streamedBytes));
  assert.ok(streamedBytes < 6 * 1024 * 1024, String(streamedBytes));
  clearInterval(interval);
  await driver.preflight();
} finally {
  clearInterval(interval);
  http.request = nativeRequest;
  syncBuiltinESMExports();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
`;
  const driver = new URL(
    "../../apps/controller/src/drivers/compute/docker/index.ts",
    import.meta.url,
  );
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, driver.href], {
    timeout: 10_000,
  });
});

test("Docker Agent readiness handles interrupted status responses immediately", async () => {
  // Execute the exact generated container healthcheck against a real loopback peer that
  // sends headers and a partial body before resetting the response stream.
  const source = String.raw`
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
const { AGENT_READINESS_ENTRYPOINT } = await import(process.argv[1]);
const wsStore = readdirSync(join(process.cwd(), "node_modules/.pnpm")).find((entry) =>
  entry.startsWith("ws@"),
);
assert.ok(wsStore);
const wsModules = join(process.cwd(), "node_modules/.pnpm", wsStore, "node_modules");
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
  response.write('{"phase":"ready",');
  setTimeout(() => response.destroy(), 10);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  await assert.rejects(
    promisify(execFile)(process.execPath, ["-e", AGENT_READINESS_ENTRYPOINT], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_PATH: wsModules,
        OPENCLAW_PLUGIN_STATUS_PORT: String(server.address().port),
        OPENCLAW_AGENT_REVISION_ID: "rev_interrupted_status",
        APP_SERVER_TOKEN: "synthetic-token",
        APP_SERVER_PORT: "1",
      },
      encoding: "utf8",
      timeout: 5_000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "");
      assert.equal(error.stdout, "plugin runtime status unavailable: ECONNRESET\n");
      return true;
    },
  );
  await assert.rejects(
    promisify(execFile)(process.execPath, ["-e", AGENT_READINESS_ENTRYPOINT], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_PATH: wsModules,
        OPENCLAW_PLUGIN_READY_MARKER: join(process.cwd(), ".missing-readiness-marker"),
        OPENCLAW_RUNTIME_STATUS_PORT: String(server.address().port),
      },
      encoding: "utf8",
      timeout: 5_000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "");
      assert.equal(error.stdout, "plugin ready marker is missing\n");
      return true;
    },
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
`;
  const runtimeEntrypoints = new URL(
    "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts",
    import.meta.url,
  );
  await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", source, runtimeEntrypoints.href],
    { cwd: process.cwd(), timeout: 10_000 },
  );
});

test("Docker namespace delete treats a network that vanished before DELETE as removed", async () => {
  // A fake engine behind the real Driver and Node HTTP client: the network inspect
  // finds an owned network, then the network DELETE answers with each status below.
  const source = String.raw`
import assert from "node:assert/strict";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
const labels = {
  "org.openclaw.enterprise.managed": "true",
  "org.openclaw.enterprise.compute-driver": "docker",
  "org.openclaw.enterprise.namespace-id": "ns_vanish",
};
let deleteStatus;
const requests = [];
const server = http.createServer((request, response) => {
  const path = request.url.split("?")[0];
  requests.push(request.method + " " + path);
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body === undefined ? "" : JSON.stringify(body));
  };
  if (request.method === "GET" && path.startsWith("/networks/")) return send(200, { Labels: labels });
  if (request.method === "DELETE" && path.startsWith("/networks/")) {
    return deleteStatus === 204 ? send(204) : send(deleteStatus, { message: "network " + deleteStatus });
  }
  if (request.method === "GET" && path === "/containers/json") return send(200, []);
  if (request.method === "GET" && path === "/volumes") return send(200, { Volumes: [] });
  send(500, { message: "unexpected " + request.method + " " + path });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const nativeRequest = http.request;
http.request = (options, callback) =>
  nativeRequest({ ...options, socketPath: undefined, host: "127.0.0.1", port: server.address().port }, callback);
syncBuiltinESMExports();
try {
  const { DockerComputeDriver } = await import(process.argv[1]);
  const driver = new DockerComputeDriver({ images: { gateway: "gateway:local", agent: "agent:local" } });
  const outcomes = {};
  for (const status of [204, 404, 409, 500]) {
    deleteStatus = status;
    requests.length = 0;
    outcomes[status] = await driver.deleteNamespace({ id: "ns_vanish" });
    assert.equal(requests.at(-1), "DELETE /networks/" + driver.networkName("ns_vanish"), String(status));
  }
  process.stdout.write(JSON.stringify(outcomes));
} finally {
  http.request = nativeRequest;
  syncBuiltinESMExports();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
`;
  const driver = new URL(
    "../../apps/controller/src/drivers/compute/docker/index.ts",
    import.meta.url,
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", source, driver.href],
    { timeout: 10_000 },
  );
  const deleted = { namespaceId: "ns_vanish", namespaceDeleted: true };
  const kept = { namespaceId: "ns_vanish", namespaceDeleted: false };
  assert.deepEqual(JSON.parse(stdout), {
    204: deleted,
    // Removed between the inspect and the DELETE: the namespace is gone, not failed.
    404: deleted,
    // Still in use, or the engine failed: keep refusing.
    409: { ...kept, failure: "permanent" },
    500: { ...kept, failure: "retryable" },
  });
});

test("Docker Compute logging forwarding configuration accepts only loopback addresses", () => {
  const base = { OCC_DOCKER_RUNTIME_IMAGE: "openclaw-runtime:local" };
  for (const OCC_DOCKER_LOGGING_ADDRESS of [
    "0.0.0.0:24224",
    "host.docker.internal:24224",
    "127.0.0.1",
    "127.0.0.1:70000",
    "http://127.0.0.1:24224",
  ]) {
    assert.throws(
      () => createDockerDevelopmentComputeDriverFromEnv({ ...base, OCC_DOCKER_LOGGING_ADDRESS }),
      /loopback host:port/,
    );
  }

  assert.doesNotThrow(() => createDockerDevelopmentComputeDriverFromEnv(base));
  for (const OCC_DOCKER_LOGGING_ADDRESS of ["127.0.0.1:24224", "localhost:24224", "[::1]:24224"]) {
    assert.doesNotThrow(() =>
      createDockerDevelopmentComputeDriverFromEnv({ ...base, OCC_DOCKER_LOGGING_ADDRESS }),
    );
  }
});

const tenant = {
  id: "ns_00000000-0000-4000-8000-000000000001",
  name: "Docker conformance tenant",
  status: "ready",
  createdAt: "2026-09-01T00:00:00.000Z",
};

test("Docker stop removes exact runtime containers and is retry-safe", async () => {
  const driver = new DockerComputeDriver({
    images: { gateway: "gateway:local", agent: "agent:local" },
  });
  const revision = {
    id: "revision-docker-stop",
    namespaceId: tenant.id,
    agentId: "agent-docker-stop",
    revision: 1,
    configurationId: "configuration-docker-stop",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: admitLoggingConfiguration({}, "info"),
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-docker-stop",
    createdAt: tenant.createdAt,
  };
  const existing = new Map();
  const stopped = [];
  driver.setLifecycleDrivers([
    {
      id: "docker-stop-hooks",
      capability: "configuration",
      implementation: "test",
      computeLifecycleHooks: {
        async beforeWorkloadStop(candidate) {
          stopped.push(candidate.id);
        },
      },
    },
  ]);
  await assert.rejects(
    driver.stopRevision({
      ...revision,
      compute: { id: "another-driver", implementation: "another-implementation" },
    }),
    /another Compute Driver/i,
  );
  driver.container = async (name) => existing.get(name);
  driver.removeContainer = async (name) => {
    existing.delete(name);
  };
  const agentName = driver.agentContainerName(tenant.id, revision.agentId, revision.id);
  const gatewayName = driver.gatewayContainerName(tenant.id, revision.agentId);
  existing.set(agentName, {
    Config: {
      Labels: {
        "org.openclaw.enterprise.managed": "true",
        "org.openclaw.enterprise.compute-driver": "docker",
        "org.openclaw.enterprise.namespace-id": tenant.id,
        "org.openclaw.enterprise.agent-id": revision.agentId,
        "org.openclaw.enterprise.revision-id": revision.id,
      },
    },
  });
  existing.set(gatewayName, {
    Config: {
      Labels: {
        "org.openclaw.enterprise.managed": "true",
        "org.openclaw.enterprise.compute-driver": "docker",
        "org.openclaw.enterprise.namespace-id": tenant.id,
        "org.openclaw.enterprise.agent-id": revision.agentId,
        "org.openclaw.enterprise.revision-id": revision.id,
      },
    },
  });

  await driver.stopRevision(revision);
  await driver.stopRevision(revision);
  assert.deepEqual([...existing.keys()], []);
  assert.deepEqual(stopped, [revision.id, revision.id]);
});

test("Docker Compute gateway containers use password auth by default and preserve trusted proxy auth", async () => {
  const defaultLaunch = await gatewayContainerLaunch();
  assert.match(defaultLaunch.environment.OPENCLAW_GATEWAY_PASSWORD ?? "", /^[0-9a-f]{64}$/);
  assert.equal(defaultLaunch.environment.OPENCLAW_GATEWAY_PORT, "8080");
  assert.equal(
    JSON.parse(defaultLaunch.environment.OPENCLAW_CONFIG_JSON).gateway.auth.mode,
    "password",
  );
  assert.equal(
    JSON.parse(defaultLaunch.environment.OPENCLAW_CONFIG_JSON).gateway.auth.password,
    "${OPENCLAW_GATEWAY_PASSWORD}",
  );
  assert.equal(defaultLaunch.revision.configuration.gateway, undefined);

  const passwordLaunch = await gatewayContainerLaunch({
    gateway: {
      tls: { enabled: false },
      auth: { password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" } },
    },
  });
  assert.match(passwordLaunch.environment.OPENCLAW_GATEWAY_PASSWORD ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(passwordLaunch.environment.OPENCLAW_CONFIG_JSON).gateway.tls, {
    enabled: false,
  });
  assert.equal(
    JSON.parse(passwordLaunch.environment.OPENCLAW_CONFIG_JSON).gateway.auth.mode,
    "password",
  );
  assert.deepEqual(
    JSON.parse(passwordLaunch.environment.OPENCLAW_CONFIG_JSON).gateway.auth.password,
    { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
  );
  assert.equal(passwordLaunch.revision.configuration.gateway.auth.mode, undefined);

  const staticPasswordLaunch = await gatewayContainerLaunch({
    gateway: { auth: { mode: "password", password: "static-gateway-password" } },
  });
  assert.equal(staticPasswordLaunch.environment.OPENCLAW_GATEWAY_PASSWORD, undefined);
  assert.equal(
    JSON.parse(staticPasswordLaunch.environment.OPENCLAW_CONFIG_JSON).gateway.auth.mode,
    "password",
  );
  assert.equal(
    JSON.parse(staticPasswordLaunch.environment.OPENCLAW_CONFIG_JSON).gateway.auth.password,
    "static-gateway-password",
  );

  const trustedProxyLaunch = await gatewayContainerLaunch({
    gateway: { auth: { mode: "trusted-proxy" } },
  });
  assert.equal(trustedProxyLaunch.environment.OPENCLAW_GATEWAY_PASSWORD, undefined);
  assert.equal(
    JSON.parse(trustedProxyLaunch.environment.OPENCLAW_CONFIG_JSON).gateway.auth.mode,
    "trusted-proxy",
  );

  const trustedProxyWithPasswordLaunch = await gatewayContainerLaunch({
    gateway: {
      auth: {
        mode: "trusted-proxy",
        password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
      },
    },
  });
  assert.match(
    trustedProxyWithPasswordLaunch.environment.OPENCLAW_GATEWAY_PASSWORD ?? "",
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    JSON.parse(trustedProxyWithPasswordLaunch.environment.OPENCLAW_CONFIG_JSON).gateway.auth.mode,
    "trusted-proxy",
  );
  assert.deepEqual(
    JSON.parse(trustedProxyWithPasswordLaunch.environment.OPENCLAW_CONFIG_JSON).gateway.auth
      .password,
    { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
  );
});

const generatedPassword = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" };
const passwordAuth = (password, mode = "password") => ({ gateway: { auth: { mode, password } } });
const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

test("Docker Compute rejects unsupported native gateway settings at admission and before Docker engine access", async () => {
  const driver = new DockerComputeDriver({
    images: { gateway: "gateway:local", agent: "agent:local" },
  });

  for (const [configuration, setting, expected] of [
    [{ gateway: { auth: { mode: "oauth" } } }, "gateway.auth.mode", /password or trusted-proxy/i],
    [{ gateway: { auth: { mode: "token" } } }, "gateway.auth.mode", /password or trusted-proxy/i],
    [{ gateway: { auth: { mode: "none" } } }, "gateway.auth.mode", /password or trusted-proxy/i],
    [
      { gateway: { auth: { token: "gateway-token" } } },
      "gateway.auth.token",
      /gateway\.auth\.token is not a supported native gateway authentication field/,
    ],
    [
      { gateway: { auth: { unsupportedField: true } } },
      "gateway.auth.unsupportedField",
      /gateway\.auth\.unsupportedField is not a supported/,
    ],
    [{ gateway: { auth: null } }, "gateway.auth", /gateway\.auth must be an object/],
    [
      { gateway: { tls: { enabled: true } } },
      "gateway.tls.enabled",
      /gateway\.tls\.enabled must be omitted or false/i,
    ],
    // The published port forwards to the container IP while the healthcheck probes
    // loopback, so a loopback-only listener would pass readiness and serve nothing.
    [
      { gateway: { bind: "loopback" } },
      "gateway.bind",
      /gateway\.bind must listen on all interfaces/,
    ],
    [
      { gateway: { bind: "tailnet" } },
      "gateway.bind",
      /gateway\.bind must listen on all interfaces/,
    ],
    [
      { gateway: { bind: "custom", customBindHost: "127.0.0.1" } },
      "gateway.customBindHost",
      /gateway\.customBindHost must be 0\.0\.0\.0/,
    ],
    [
      { gateway: { tailscale: { mode: "serve" } } },
      "gateway.tailscale.mode",
      /gateway\.tailscale\.mode must be off/,
    ],
    [
      {
        plugins: { entries: { codex: { config: { appServer: { approvalPolicy: "untrusted" } } } } },
      },
      "plugins.entries.codex.config.appServer.approvalPolicy",
      /appServer\.approvalPolicy must not be "untrusted"/,
    ],
    // OpenClaw resolves the password in both auth modes, with the Configuration's own secrets: its
    // schema refuses an object without a text provider or with other keys (exit 78), and the
    // Gateway exits on a provider or allowlist that cannot serve it (finding 3061).
    ...[
      [passwordAuth({ source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" }), "providerless"],
      [
        passwordAuth({ source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" }, "trusted-proxy"),
        "providerless",
      ],
      [
        {
          ...passwordAuth({ source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" }),
          secrets: { defaults: { env: "custom" } },
        },
        "providerless",
        "env",
        "custom",
      ],
      [
        passwordAuth({ source: "env", provider: null, id: "OPENCLAW_GATEWAY_PASSWORD" }),
        "providerless",
      ],
      [passwordAuth({ ...generatedPassword, note: "x" }), "keys"],
      [passwordAuth({ ...generatedPassword, provider: "vault" }), "provider", "vault"],
      [
        {
          ...passwordAuth(generatedPassword),
          secrets: { providers: { default: { source: "env", allowlist: ["OTHER"] } } },
        },
        "allowlist",
        "OPENCLAW_GATEWAY_PASSWORD",
      ],
      [passwordAuth({ source: "vault", provider: "default", id: "X" }), "shape"],
    ].map(([configuration, ...refused]) => [
      configuration,
      "gateway.auth.password",
      exactly(unreadableGatewayPasswordRefusal(...refused)),
    ]),
  ]) {
    const revision = dockerGatewayRevision(driver, configuration);
    let networkAccesses = 0;
    let dockerRequests = 0;
    driver.network = async () => {
      networkAccesses += 1;
      throw new Error("network access must not occur");
    };
    driver.request = async () => {
      dockerRequests += 1;
      throw new Error("Docker API access must not occur");
    };

    let preparationMessage;
    await assert.rejects(
      () => driver.prepareRevision(revision),
      (error) => {
        preparationMessage = error.message;
        return expected.test(error.message);
      },
    );
    assert.equal(networkAccesses, 0);
    assert.equal(dockerRequests, 0);
    // Deployment admission refuses every setting preparation refuses, with the same message and a
    // 409, because the deploy stops the running revision before preparation (finding 2352).
    assert.throws(
      () => driver.validateGatewaySettings(configuration),
      (error) =>
        error instanceof ComputeGatewaySettingError &&
        error.setting === setting &&
        error.message === preparationMessage,
    );
  }
  assert.doesNotThrow(() => driver.validateGatewaySettings({ gateway: { bind: "lan" } }));
  for (const auth of [
    { mode: "password", password: "static-gateway-password" },
    { mode: "trusted-proxy" },
  ]) {
    assert.doesNotThrow(() => driver.validateGatewaySettings({ gateway: { auth } }));
  }
  // References OpenClaw reads: the alias secrets.defaults.env names, a configured env provider
  // whose allowlist lists the name, and another variable the Configuration's bindings may set.
  for (const configuration of [
    {
      ...passwordAuth({ ...generatedPassword, provider: "custom" }),
      secrets: { defaults: { env: "custom" } },
    },
    {
      ...passwordAuth({ ...generatedPassword, provider: "vault" }),
      secrets: {
        providers: { vault: { source: "env", allowlist: ["OPENCLAW_GATEWAY_PASSWORD"] } },
      },
    },
    passwordAuth(
      { source: "env", provider: "default", id: "MY_GATEWAY_PASSWORD" },
      "trusted-proxy",
    ),
  ]) {
    assert.doesNotThrow(
      () => driver.validateGatewaySettings(configuration),
      JSON.stringify(configuration),
    );
  }
});

test("Docker prepares configuration before starting a managed Gateway", async () => {
  const { body, environment } = await gatewayContainerLaunch();
  const program = inflateRawSync(Buffer.from(body.Cmd.slice(2).join(""), "base64")).toString();
  const nativeRequire = createRequire(import.meta.url);
  const events = [];
  runInNewContext(program, {
    process: { env: { ...environment }, on() {} },
    require(specifier) {
      if (specifier === "node:fs") {
        return {
          chmodSync() {},
          mkdirSync() {},
          readdirSync: () => [],
          writeFileSync(path) {
            events.push({ path });
          },
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawn(_command, args, { env }) {
            events.push({ args: [...args], env });
            return { on() {} };
          },
        };
      }
      return nativeRequire(specifier);
    },
  });
  assert.equal(events.length, 2);
  const [configWrite, gatewayLaunch] = events;
  assert.equal(configWrite.path, environment.OPENCLAW_CONFIG_PATH);
  assert.deepEqual(gatewayLaunch.args, [
    "/app/openclaw.mjs",
    "gateway",
    "--port",
    environment.OPENCLAW_GATEWAY_PORT,
  ]);
  assert.equal(gatewayLaunch.env.OPENCLAW_CONFIG_READONLY, "1");
  assert.equal(gatewayLaunch.env.OPENCLAW_DISABLE_GATEWAY_LOCAL_TERMINALS, "1");
  assert.equal(gatewayLaunch.env.OPENCLAW_DISABLE_CRON_HOST_EXECUTION, "1");
  // OCE replaces the Gateway image to upgrade it: OpenClaw runs no update check or
  // install count request of its own (finding 2779).
  assert.equal(gatewayLaunch.env.OPENCLAW_NO_AUTO_UPDATE, "1");
});

async function gatewayContainerLaunch(configuration = {}) {
  const driver = new DockerComputeDriver({
    images: { gateway: "gateway:local", agent: "agent:local" },
  });
  const revision = dockerGatewayRevision(driver, configuration);
  const createdContainers = [];
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-api-key";
  driver.network = async () => ({
    Labels: {
      "org.openclaw.enterprise.managed": "true",
      "org.openclaw.enterprise.compute-driver": "docker",
      "org.openclaw.enterprise.namespace-id": tenant.id,
    },
  });
  driver.container = async () => {
    const latest = createdContainers.at(-1);
    if (latest === undefined) {
      return undefined;
    }
    return {
      Config: { Labels: latest.Labels },
      State: { Running: true, Health: { Status: "healthy" } },
    };
  };
  driver.request = async (method, path, body) => {
    if (method === "POST" && path.startsWith("/containers/create?")) {
      createdContainers.push(structuredClone(body));
      return "";
    }
    if (method === "POST" && path.startsWith("/containers/") && path.endsWith("/start")) {
      return "";
    }
    throw new Error(`Unexpected Docker API request ${method} ${path}`);
  };
  try {
    assert.deepEqual(await driver.prepareRevision(revision), {
      namespaceId: tenant.id,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: true,
    });
  } finally {
    if (previousOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    }
  }

  assert.equal(createdContainers.length, 1);
  return {
    body: createdContainers[0],
    environment: Object.fromEntries(
      createdContainers[0].Env.map((entry) => splitEnvironment(entry)),
    ),
    revision,
  };
}

function dockerGatewayRevision(driver, configuration = {}) {
  return {
    id: `revision-${configuration.gateway?.auth?.mode ?? "default-password"}`,
    namespaceId: tenant.id,
    agentId: "agent-docker-auth",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    executionAdmission: { version: 2, mode: "unprotected" },
    configuration: admitLoggingConfiguration(configuration, "info"),
    gatewayManagedMode: true,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-docker-auth",
    createdAt: tenant.createdAt,
  };
}

function splitEnvironment(entry) {
  const separator = entry.indexOf("=");
  assert.ok(separator > 0, `Docker Env entry must be NAME=value: ${entry}`);
  return [entry.slice(0, separator), entry.slice(separator + 1)];
}

/**
 * Models only the Docker inspect/create/start/delete boundary over one in-memory container map;
 * reconciliation runs in the real Driver. `createDriver()` returns a fresh Driver on that map.
 */
function fakeDockerEngine(inspectCreated) {
  const containers = new Map();
  const createDriver = () => {
    const driver = new DockerComputeDriver({
      images: { gateway: "gateway:local", agent: "agent:local" },
    });
    driver.network = async () => ({
      Labels: {
        "org.openclaw.enterprise.managed": "true",
        "org.openclaw.enterprise.compute-driver": "docker",
        "org.openclaw.enterprise.namespace-id": tenant.id,
      },
    });
    driver.request = async (method, path, body) => {
      const url = new URL(path, "http://docker.invalid");
      if (method === "POST" && url.pathname === "/containers/create") {
        const name = url.searchParams.get("name");
        const created = {
          Config: structuredClone(body),
          State: { Running: true, Health: { Status: "healthy" } },
        };
        containers.set(name, inspectCreated?.(name, created) ?? created);
        return "";
      }
      const [, name, action] = /^\/containers\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname) ?? [];
      if (method === "POST" && action === "start") {
        return "";
      }
      if (method === "POST" && action === "stop") {
        const container = containers.get(name);
        if (container !== undefined) {
          container.State = { Running: false, ExitCode: 0 };
        }
        return "";
      }
      if (method === "DELETE") {
        containers.delete(name);
        return "";
      }
      throw new Error(`Unexpected Docker API request ${method} ${path}`);
    };
    driver.container = async (name) => containers.get(name);
    return driver;
  };
  return { containers, createDriver };
}

function dockerAgentRevision(driver, { id, agentId, revision = 1, mode }) {
  return {
    id,
    namespaceId: tenant.id,
    agentId,
    revision,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    executionAdmission: { version: 2, mode: "unprotected" },
    configuration: admitLoggingConfiguration({}, "info"),
    harness: { id: mode === "dedicated" ? "codex" : "openclaw", version: "1.0.0", mode },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: `service-principal-${agentId}`,
    createdAt: tenant.createdAt,
  };
}

/** Runs `body` with the model credential the Docker runtime requires, then restores it. */
async function withModelKey(body) {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-api-key";
  try {
    return await body();
  } finally {
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  }
}

test("Docker Compute recovery keeps dedicated transport paired across container reuse and replacement", async () => {
  // The Compose integration separately kills a real worker.
  const { containers, createDriver } = fakeDockerEngine();
  const driver = createDriver();
  const revision = dockerAgentRevision(driver, {
    id: "revision-docker-recovery",
    agentId: "agent-recovery",
    mode: "dedicated",
  });
  const role = (name) =>
    [...containers.entries()].find(
      ([, value]) => value.Config.Labels["org.openclaw.enterprise.role"] === name,
    );
  const token = (container) =>
    container.Config.Env.find((value) => value.startsWith("APP_SERVER_TOKEN="));
  await withModelKey(async () => {
    assert.equal((await driver.prepareRevision(revision)).ready, true);
    const [agentName, agent] = role("agent");
    const [gatewayName, gateway] = role("gateway");
    assert.match(token(agent) ?? "", /^APP_SERVER_TOKEN=[0-9a-f]{64}$/);
    assert.equal(token(agent) === token(gateway), true);

    // A fresh Driver sees only the surviving Codex container, as after an interrupted startup.
    containers.delete(gatewayName);
    assert.equal((await createDriver().prepareRevision(revision)).ready, true);
    assert.equal(role("agent")[1], agent);
    assert.equal(
      token(role("gateway")[1]) === token(agent),
      true,
      "recovery must preserve the surviving transport token",
    );
    const recoveredGateway = role("gateway")[1];
    assert.equal((await createDriver().prepareRevision(revision)).ready, true);
    assert.equal(role("gateway")[1], recoveredGateway, "a healthy matching pair must be reused");

    // Replacing Codex rotates its token, so a previously healthy gateway must be refreshed too.
    containers.delete(agentName);
    assert.equal((await createDriver().prepareRevision(revision)).ready, true);
    assert.notEqual(role("gateway")[1], recoveredGateway);
    assert.equal(token(role("gateway")[1]) === token(role("agent")[1]), true);

    const invalidAgent = role("agent")[1];
    invalidAgent.Config.Env = invalidAgent.Config.Env.filter(
      (value) => !value.startsWith("APP_SERVER_TOKEN="),
    );
    await assert.rejects(createDriver().prepareRevision(revision), /transport token/i);
    assert.equal(
      role("agent")[1],
      invalidAgent,
      "missing credentials must fail closed without adopting a new token",
    );
  });
});

// Finding 2268: when preparation fails and its cleanup fails too, the preparation's own failure
// stays first, so the worker classifies the deployment by it. Every cleanup still runs after an
// earlier one fails: the created container's removal, then the lifecycle cleanup.
test("Docker preparation keeps its own failure first when every cleanup also fails", async () => {
  const { containers, createDriver } = fakeDockerEngine();
  const driver = createDriver();
  driver.setLifecycleDrivers([
    {
      id: "hooks",
      capability: "configuration",
      implementation: "test",
      computeLifecycleHooks: {
        async beforeWorkloadStart() {},
        async beforeWorkloadStop() {
          throw new Error("lifecycle cleanup refused");
        },
      },
    },
  ]);
  const revision = dockerAgentRevision(driver, {
    id: "revision-docker-cleanup",
    agentId: "agent-cleanup",
    mode: "dedicated",
  });
  const primary = new Error("gateway reconcile refused");
  driver.reconcileGateway = async () => {
    throw primary;
  };
  const removed = [];
  driver.removeContainer = async (name) => {
    removed.push(name);
    throw new Error("container removal refused");
  };
  const error = await withModelKey(() =>
    driver.prepareRevision(revision).then(
      () => assert.fail("the preparation must fail"),
      (failure) => failure,
    ),
  );
  assertCleanupFailure(error, primary, [
    /container removal refused/,
    /lifecycle hook beforeWorkloadStop failed/,
  ]);
  assert.deepEqual(removed, [driver.agentContainerName(tenant.id, revision.agentId, revision.id)]);
  assert.equal(containers.size, 1, "only the agent container was created");
});

// Every topology keeps one gateway container per Agent, so preparing a redeploy candidate
// replaces the active revision's gateway. The worker stops a refused candidate beside an active
// revision only when Compute declares exclusive replacement; without it the candidate's gateway
// kept serving under the predecessor's active pointer (finding 1800).
for (const mode of ["embedded", "dedicated"]) {
  test(`Docker ${mode} redeploy is exclusive, so a refused candidate leaves nothing serving`, async () => {
    const { containers, createDriver } = fakeDockerEngine();
    const driver = createDriver();
    const agentId = `agent-redeploy-${mode}`;
    const active = dockerAgentRevision(driver, { id: `revision-${mode}-1`, agentId, mode });
    const candidate = dockerAgentRevision(driver, {
      id: `revision-${mode}-2`,
      agentId,
      revision: 2,
      mode,
    });
    const serving = () =>
      [...containers.values()].map(
        ({ Config }) =>
          `${Config.Labels["org.openclaw.enterprise.role"]}:${Config.Labels["org.openclaw.enterprise.revision-id"]}`,
      );
    await withModelKey(async () => {
      assert.equal((await driver.prepareRevision(active)).ready, true);
      assert.ok(serving().includes(`gateway:${active.id}`));

      assert.equal(
        driver.requiresStoppedPredecessors?.(candidate),
        true,
        "the candidate takes the Agent's only gateway, so Docker must declare exclusive replacement",
      );
      // The worker sequence is simulated here (the postgres worker suites cover the worker's
      // side): exclusive replacement stops every predecessor, then prepares the candidate.
      await driver.stopRevision(active);
      assert.deepEqual(serving(), []);
      assert.equal((await driver.prepareRevision(candidate)).ready, true);
      assert.ok(serving().includes(`gateway:${candidate.id}`));
      assert.ok(serving().every((entry) => !entry.endsWith(active.id)));

      // A refused candidate is stopped, so the Agent is unavailable rather than serving it.
      await driver.stopRevision(candidate);
      assert.deepEqual(serving(), []);
    });
  });
}

// Removal stops a container (SIGTERM) before the force DELETE. When the stop itself fails (an
// Engine error, or its request deadline on a container that ignores SIGTERM), the force DELETE
// must still run, or callers such as a failed create's cleanup leave the container behind.
test("Docker removal still force-removes a container whose stop failed, and reports the failure", async () => {
  const { containers, createDriver } = fakeDockerEngine();
  const driver = createDriver();
  const revision = dockerAgentRevision(driver, {
    id: "revision-docker-stop-failure",
    agentId: "agent-stop-failure",
    mode: "dedicated",
  });
  const roles = () =>
    [...containers.values()].map(({ Config }) => Config.Labels["org.openclaw.enterprise.role"]);
  await withModelKey(async () => {
    assert.equal((await driver.prepareRevision(revision)).ready, true);
    assert.deepEqual(roles().sort(), ["agent", "gateway"]);

    const engine = driver.request;
    const stopFailure = new Error("Docker stop request timed out");
    driver.request = async (method, path, body) => {
      if (method === "POST" && /^\/containers\/[^/]+\/stop\?/.test(path)) {
        throw stopFailure;
      }
      return engine(method, path, body);
    };
    // The stop failure stays visible, but only after the agent container is removed.
    await assert.rejects(driver.stopRevision(revision), (error) => error === stopFailure);
    assert.deepEqual(roles(), ["gateway"]);

    // The retry finds the agent gone and removes the gateway the same way.
    await assert.rejects(driver.stopRevision(revision), (error) => error === stopFailure);
    assert.deepEqual(roles(), []);
  });
});

// These checks exercise the real Driver at Docker's API boundary. Container exit
// status is an external observation; native file writes are covered separately by
// the shared initializer and selected real-runtime Agent journey.
for (const mode of ["embedded", "dedicated"]) {
  test(`Docker ${mode} workspace setup blocks execution, delivers privately, and retains Agent storage`, async () => {
    const driver = new DockerComputeDriver({
      images: { gateway: "gateway:local", agent: "agent:local" },
    });
    const revision = {
      id: `revision-workspace-${mode}`,
      namespaceId: tenant.id,
      agentId: `agent-workspace-${mode}`,
      revision: 1,
      configurationId: "cfg-workspace",
      configurationKind: "agent",
      configurationGeneration: 1,
      executionAdmission: { version: 2, mode: "unprotected" },
      configuration: admitLoggingConfiguration(
        mode === "dedicated"
          ? { agents: { entries: { main: { workspace: "/home/node/workspace" } } } }
          : {},
        "info",
      ),
      harness: { id: mode === "embedded" ? "openclaw" : "codex", version: "1", mode },
      compute: { id: driver.id, implementation: driver.implementation },
      servicePrincipalId: "sp-workspace",
      createdAt: tenant.createdAt,
    };
    const setup = {
      id: "setup-private",
      namespaceId: tenant.id,
      agentId: revision.agentId,
      completed: false,
      files: { "AGENTS.md": "private-initial-instructions\n", "USER.md": "" },
    };
    const namespaceLabels = {
      "org.openclaw.enterprise.managed": "true",
      "org.openclaw.enterprise.compute-driver": "docker",
      "org.openclaw.enterprise.namespace-id": tenant.id,
    };
    const volumes = new Map();
    const containers = new Map();
    const creations = [];
    const deliveries = [];
    let initializerExit = 1;
    let setupFinished = false;
    let runtimeStarts = 0;
    driver.request = async (method, path, body) => {
      const url = new URL(path, "http://docker.invalid");
      if (method === "GET" && url.pathname.startsWith("/networks/")) {
        return { Labels: namespaceLabels };
      }
      if (method === "POST" && url.pathname === "/volumes/create") {
        volumes.set(body.Name, structuredClone(body));
        return body;
      }
      if (url.pathname.startsWith("/volumes/")) {
        const name = decodeURIComponent(url.pathname.slice("/volumes/".length));
        if (method === "GET") {
          return volumes.get(name);
        }
        if (method === "DELETE") {
          volumes.delete(name);
          return "";
        }
      }
      if (method === "GET" && url.pathname === "/volumes") {
        const filters = JSON.parse(url.searchParams.get("filters"));
        return {
          Volumes: [...volumes.values()].filter((volume) =>
            filters.label.every((label) => {
              const separator = label.indexOf("=");
              return volume.Labels[label.slice(0, separator)] === label.slice(separator + 1);
            }),
          ),
        };
      }
      if (method === "POST" && url.pathname === "/containers/create") {
        const name = url.searchParams.get("name");
        creations.push(structuredClone(body));
        containers.set(name, { Config: body, State: { Running: false, ExitCode: 0 } });
        return {};
      }
      const [, encodedName, action] =
        /^\/containers\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname) ?? [];
      const name = decodeURIComponent(encodedName ?? "");
      if (method === "GET" && action === "json") {
        return containers.get(name);
      }
      if (method === "PUT" && action === "archive") {
        assert.ok(Buffer.isBuffer(body));
        assert.equal(url.searchParams.get("path"), "/run");
        const length = Number.parseInt(body.subarray(124, 136).toString().replace(/\0.*$/, ""), 8);
        deliveries.push(JSON.parse(body.subarray(512, 512 + length).toString()));
        assert.equal(body.subarray(100, 108).toString(), "0000600\0");
        return "";
      }
      if (method === "POST" && action === "start") {
        const container = containers.get(name);
        if (container.Config.Labels["org.openclaw.enterprise.role"] === "workspace-setup") {
          assert.equal(deliveries.length > 0, true);
          container.State = { Running: false, ExitCode: initializerExit };
          setupFinished = initializerExit === 0;
        } else {
          assert.equal(setupFinished, true, "no runtime process can start before setup succeeds");
          runtimeStarts += 1;
          container.State = { Running: true, Health: { Status: "healthy" } };
        }
        return "";
      }
      if (method === "POST" && action === "stop") {
        const container = containers.get(name);
        if (container !== undefined) {
          container.State = { Running: false, ExitCode: 0 };
        }
        return "";
      }
      if (method === "DELETE" && encodedName !== undefined) {
        containers.delete(name);
        return "";
      }
      throw new Error(`Unexpected Docker API request ${method} ${path}`);
    };
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fixture-model-key";
    try {
      for (const agents of [
        null,
        "invalid",
        { list: [] },
        { entries: null },
        { entries: [] },
        { entries: {} },
        { entries: { main: null } },
        { entries: { other: {} } },
        { entries: { main: {}, other: {} } },
      ]) {
        await assert.rejects(
          driver.prepareRevision(
            { ...revision, configuration: { ...revision.configuration, agents } },
            { workspaceSetup: setup },
          ),
          /Configuration setting agents\.entries must hold only main, or be omitted, for initial workspace files/,
        );
        assert.equal(volumes.size, 0, "invalid roster must not create storage");
        assert.equal(creations.length, 0, "invalid roster must not create containers");
        assert.equal(deliveries.length, 0, "invalid roster must not deliver private content");
      }
      await assert.rejects(
        driver.prepareRevision(revision, { workspaceSetup: setup }),
        /Workspace initialization failed/,
      );
      assert.equal(runtimeStarts, 0);
      assert.equal(containers.size, 0, "failed initializer and private payload must be removed");
      assert.equal(volumes.size, 2, "retry retains exact-Agent durable storage");
      initializerExit = 0;
      assert.equal((await driver.prepareRevision(revision, { workspaceSetup: setup })).ready, true);
      assert.deepEqual(
        deliveries.at(-1),
        setup,
        "empty and nonempty values survive archive delivery",
      );
      assert.equal(JSON.stringify(creations).includes(setup.files["AGENTS.md"]), false);
      const initializer = creations.find(
        (entry) => entry.Labels["org.openclaw.enterprise.role"] === "workspace-setup",
      );
      assert.equal(initializer.HostConfig.NetworkMode, "none");
      assert.equal(initializer.HostConfig.LogConfig.Type, "none");
      const mounts = initializer.HostConfig.Mounts;
      assert.equal(
        mounts.find(({ Target }) => Target === "/home/node/.openclaw/workspace").Source,
        mounts.find(({ Target }) => Target === "/home/node/workspace").Source,
        "native workspace and Harness cwd must refer to the same durable files",
      );
      assert.notEqual(
        mounts.find(({ Target }) => Target === "/home/node/.openclaw").Source,
        mounts.find(({ Target }) => Target === "/home/node/workspace").Source,
      );

      for (const container of containers.values()) {
        assert.deepEqual(container.Config.HostConfig.Mounts, mounts);
      }
      await driver.stopRevision(revision);
      assert.equal(containers.size, 0);
      assert.equal(volumes.size, 2, "stop preserves setup state and user edits");
      const completed = { ...setup, completed: true };
      delete completed.files;
      assert.equal(
        (
          await driver.prepareRevision(
            { ...revision, id: revision.id + "-next", revision: 2 },
            { workspaceSetup: completed },
          )
        ).ready,
        true,
      );
      assert.deepEqual(
        deliveries.at(-1),
        completed,
        "recreation verifies metadata without sending original contents",
      );
      for (const container of containers.values()) {
        assert.deepEqual(container.Config.HostConfig.Mounts, mounts);
      }
      await driver.stopRevision({ ...revision, id: revision.id + "-next", revision: 2 });
      volumes.set("unrelated", {
        Name: "unrelated",
        Labels: {
          ...namespaceLabels,
          "org.openclaw.enterprise.agent-id": "another-agent",
          "org.openclaw.enterprise.role": "workspace",
        },
      });
      await driver.deleteAgentRuntimeCredentials({
        namespace: tenant,
        agent: { id: revision.agentId, namespaceId: tenant.id },
      });
      assert.deepEqual([...volumes.keys()], ["unrelated"]);
      await assert.rejects(
        driver.prepareRevision(revision, { workspaceSetup: completed }),
        /storage is missing/,
      );
      await assert.rejects(
        driver.prepareRevision(revision, {
          workspaceSetup: { ...setup, agentId: "another-agent" },
        }),
        /exact Agent/,
      );
      await assert.rejects(
        driver.prepareRevision(
          {
            ...revision,
            configuration: admitLoggingConfiguration(
              { agents: { entries: { main: { workspace: "/outside" } } } },
              "info",
            ),
          },
          { workspaceSetup: setup },
        ),
        /Configuration setting agents\.entries\.main\.workspace must be \/home\/node\/\.openclaw\/workspace or \/home\/node\/workspace, or unset/,
      );
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });
}

// Docker Compute applies the workspace setup rule Kubernetes Compute shares, so Agent save,
// provisioning and preparation name the same setting with the same text on both Drivers.
test("Docker workspace setup refusals match Kubernetes Compute's and name the setting at save", async () => {
  const docker = new DockerComputeDriver({
    images: { gateway: "gateway:local", agent: "agent:local" },
  });
  const kubernetes = createTestKubernetesComputeDriver("docker-workspace-parity");
  const dedicated = { id: "codex", version: "1", mode: "dedicated" };
  const refusal = (driver, harness, configuration) => {
    try {
      driver.validateWorkspaceSetup(harness, configuration);
    } catch (error) {
      assert.ok(error instanceof ConfigurationHarnessError, String(error));
      return error.message;
    }
    return undefined;
  };
  for (const agents of [
    { list: [] },
    { entries: { other: {} } },
    { entries: { main: {}, other: {} } },
    { entries: { main: { workspace: "/outside" } } },
    { defaults: { workspace: "/home/node/.openclaw/workspace/nested" } },
  ]) {
    const message = refusal(docker, dedicated, { agents });
    assert.match(message ?? "", /^Configuration setting agents\./, JSON.stringify(agents));
    assert.equal(message, refusal(kubernetes, dedicated, { agents }), JSON.stringify(agents));
  }
  for (const agents of [
    undefined,
    { entries: { main: {} } },
    { entries: { main: { workspace: "/home/node/workspace" } } },
    { defaults: { workspace: "/home/node/.openclaw/workspace" } },
  ]) {
    const configuration = agents === undefined ? {} : { agents };
    assert.equal(refusal(docker, dedicated, configuration), undefined, JSON.stringify(agents));
    assert.equal(refusal(kubernetes, dedicated, configuration), undefined);
  }
  // Docker mounts one volume at both paths on every topology, and writes the files after
  // native bootstrap, so it alone accepts the Harness path on embedded OpenClaw and refuses
  // skipped bootstrap; both are named settings too.
  const embedded = { id: "openclaw", version: "1", mode: "embedded" };
  const harnessPath = { agents: { defaults: { workspace: "/home/node/workspace" } } };
  assert.equal(refusal(docker, embedded, harnessPath), undefined);
  assert.equal(
    refusal(kubernetes, embedded, harnessPath),
    "Configuration setting agents.defaults.workspace must be /home/node/.openclaw/workspace, or unset, for initial workspace files.",
  );
  for (const [agents, setting] of [
    [{ defaults: { skipBootstrap: true } }, "agents.defaults.skipBootstrap"],
    [
      { entries: { main: { skipOptionalBootstrapFiles: true } } },
      "agents.entries.main.skipOptionalBootstrapFiles",
    ],
  ]) {
    assert.equal(
      refusal(docker, embedded, { agents }),
      `Configuration setting ${setting} must not be true for initial workspace files: Docker Compute writes them after native bootstrap.`,
    );
  }
});

test("Docker rejects an invalid dedicated Gateway tool policy before engine access", async () => {
  const driver = new DockerComputeDriver({
    images: { gateway: "gateway:local", agent: "agent:local" },
  });
  let requests = 0;
  driver.network = async () => {
    requests += 1;
    return undefined;
  };
  for (const [gatewayPolicy, expected] of [
    [{ allow: ["plugins"] }, /Gateway administrative tools/],
    [{ allow: ["message"], actions: { message: ["set-profile"] } }, /reviewed task actions/],
    [{ allow: ["automations"] }, /actions.automations must list/],
  ]) {
    assert.throws(
      () =>
        driver.validateWorkspaceSetup(
          { id: "codex", version: "1.0.0", mode: "dedicated" },
          { tools: { gatewayPolicy } },
        ),
      expected,
      "Agent admission checks policy when initial workspace files are supplied",
    );
    await assert.rejects(
      () =>
        driver.prepareRevision({
          ...dockerGatewayRevision(driver, { tools: { gatewayPolicy } }),
          harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
        }),
      expected,
    );
  }
  assert.equal(requests, 0);
  await driver.prepareRevision({
    ...dockerGatewayRevision(driver, { tools: { gatewayPolicy: { allow: [] } } }),
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
  });
  assert.equal(requests, 1, "an explicit empty policy is a supported ceiling");
});

function embeddedRecoveryInspection(volumeName = "agent-state") {
  const live = {
    Id: "a".repeat(64),
    State: { Status: "running", Running: true, Pid: 42, StartedAt: "2026-10-20T12:05:00Z" },
    Config: { User: "1000:1000", Env: ["NODE_OPTIONS=--require=/tmp/untrusted", "PATH=/tmp"] },
    HostConfig: {
      PidMode: "",
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/home/node": "", "/tmp": "" },
    },
    Mounts: [{ Type: "volume", Name: volumeName, Destination: "/home/node/.openclaw", RW: true }],
  };
  const volume = {
    Name: volumeName,
    Driver: "local",
    Scope: "local",
    CreatedAt: "2026-10-20T12:00:00Z",
  };
  const namespace = {
    platform: "linux",
    identity: "d64275ef-a30a-4a02-917d-adb75653f494",
    host: "old-gateway",
    pidNsInode: "4026533123",
    pidNsInitStartTicks: 12345,
  };
  const execId = "b".repeat(64);
  const engine = async (method, path, body) => {
    if (method === "GET" && path === "/volumes/" + volumeName) {
      return volume;
    }
    if (method === "POST" && path.endsWith("/exec")) {
      assert.equal(body.User, "65534:65534");
      assert.deepEqual(body.Env, ["NODE_OPTIONS=", "PATH="]);
      return { Id: execId };
    }
    if (method === "POST" && path === "/exec/" + execId + "/start") {
      return JSON.stringify(namespace);
    }
    if (method === "GET" && path === "/exec/" + execId + "/json") {
      return { Running: false, ExitCode: 0, ContainerID: live.Id };
    }
    assert.equal(path, "/containers/" + live.Id + "/json");
    return live;
  };
  const stopped = {
    ...live,
    State: {
      ...live.State,
      Status: "exited",
      Running: false,
      Pid: 0,
      FinishedAt: "2026-10-20T12:10:00Z",
    },
  };
  return { live, stopped, volume, namespace, engine };
}

test("embedded recovery requires the observed container incarnation and its original state mounts", async () => {
  const { observeEmbeddedGateway, terminatedEmbeddedGateway } =
    await import("../../apps/controller/src/drivers/compute/docker/embedded-gateway-recovery.ts");
  const { live, stopped, volume, namespace, engine } = embeddedRecoveryInspection();
  const observed = await observeEmbeddedGateway(engine, live, volume.Name);
  assert.deepEqual(
    await terminatedEmbeddedGateway(engine, observed, stopped, volume.Name),
    namespace,
  );
  for (const candidate of [
    live,
    { ...stopped, State: { ...stopped.State, StartedAt: "2026-10-20T12:08:00Z" } },
    { ...stopped, Id: "c".repeat(64) },
  ]) {
    assert.equal(
      await terminatedEmbeddedGateway(engine, observed, candidate, volume.Name),
      undefined,
    );
  }
  volume.CreatedAt = "2026-10-20T12:10:00Z";
  assert.equal(await terminatedEmbeddedGateway(engine, observed, stopped, volume.Name), undefined);
  for (const candidate of [
    { ...live, HostConfig: { ...live.HostConfig, PidMode: "host" } },
    { ...live, HostConfig: { ...live.HostConfig, SecurityOpt: [] } },
    {
      ...live,
      Mounts: [
        ...live.Mounts,
        { Type: "bind", Destination: "/home/node/.openclaw/state/openclaw.sqlite" },
      ],
    },
    { ...live, HostConfig: { ...live.HostConfig, Tmpfs: { "/usr/local": "" } } },
  ]) {
    assert.equal(await observeEmbeddedGateway(assert.fail, candidate, volume.Name), undefined);
  }
});

test("Docker dispatches embedded recovery only while Engine can verify the old state volume", async () => {
  await withModelKey(async () => {
    for (const unavailable of [undefined, "at removal", "at replacement"]) {
      let previous;
      const { containers, createDriver } = fakeDockerEngine((name, created) => {
        if (previous) {
          return created;
        }
        const state = created.Config.HostConfig.Mounts.find(
          ({ Target }) => Target === "/home/node/.openclaw",
        );
        previous = { name, ...embeddedRecoveryInspection(state.Source) };
        previous.live.Config.Labels = created.Config.Labels;
        previous.live.State.Health = created.State.Health;
        return previous.live;
      });
      const driver = createDriver();
      const revision = dockerGatewayRevision(driver);
      const workspaceSetup = {
        id: "existing",
        namespaceId: tenant.id,
        agentId: revision.agentId,
        completed: true,
      };
      // The workspace already exists. Exercise normal Gateway creation, observation and replacement.
      driver.initializeWorkspace = async () => {};
      const lifecycle = driver.request;
      let removed = false;
      driver.request = async (method, path, data) => {
        if (previous) {
          const { name, live, volume, engine } = previous;
          if (method === "POST" && path.startsWith("/containers/" + live.Id + "/stop?")) {
            // The old Gateway has already exited (304 from Engine).
            return "";
          }
          if (method === "DELETE" && path.startsWith("/containers/" + live.Id + "?")) {
            removed = containers.delete(name);
            return "";
          }
          if (
            method === "GET" &&
            path === "/volumes/" + volume.Name &&
            !live.State.Running &&
            unavailable === (removed ? "at replacement" : "at removal")
          ) {
            throw new Error("Docker volume inspection failed");
          }
          if (path.includes(live.Id) || path.startsWith("/exec/") || path.startsWith("/volumes/")) {
            return engine(method, path, data);
          }
        }
        return lifecycle(method, path, data);
      };
      assert.equal((await driver.prepareRevision(revision, { workspaceSetup })).ready, true);
      previous.live.State = previous.stopped.State;
      const successor = { ...revision, revision: 2, id: revision.id + "-replacement" };
      assert.equal((await driver.prepareRevision(successor, { workspaceSetup })).ready, true);
      assert.equal(removed, true, "an unavailable recovery proof must not prevent normal removal");
      const command = containers.get(previous.name).Config.Cmd;
      const program = inflateRawSync(Buffer.from(command.slice(2).join(""), "base64")).toString(
        "utf8",
      );
      assert.equal(program.includes("--terminated-namespace"), unavailable === undefined);
      if (unavailable === undefined) {
        assert.ok(
          program.includes(JSON.stringify(previous.namespace)),
          "the preamble carries this exact owner",
        );
      }
    }
  });
});
