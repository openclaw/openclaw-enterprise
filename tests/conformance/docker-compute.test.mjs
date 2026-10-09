import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createDockerDevelopmentComputeDriverFromEnv,
  DockerComputeDriver,
} from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { ComputeGatewaySettingError } from "../../packages/occ/src/index.ts";

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
      auth: { password: { source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" } },
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
    { source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" },
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
        password: { source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" },
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
    { source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" },
  );
});

test("Docker Compute rejects unsupported native gateway settings before Docker engine access", async () => {
  const driver = new DockerComputeDriver({
    images: { gateway: "gateway:local", agent: "agent:local" },
  });

  for (const [configuration, expected] of [
    [{ gateway: { auth: { mode: "oauth" } } }, /password or trusted-proxy/i],
    [{ gateway: { auth: { unsupportedField: true } } }, /unsupported field unsupportedField/i],
    [{ gateway: { auth: null } }, /gateway auth must be an object/i],
    [{ gateway: { tls: { enabled: true } } }, /gateway\.tls\.enabled must be omitted or false/i],
    // The published port forwards to the container IP while the healthcheck probes
    // loopback, so a loopback-only listener would pass readiness and serve nothing.
    [{ gateway: { bind: "loopback" } }, /gateway\.bind must listen on all interfaces/],
    [{ gateway: { bind: "tailnet" } }, /gateway\.bind must listen on all interfaces/],
    [
      { gateway: { bind: "custom", customBindHost: "127.0.0.1" } },
      /gateway\.customBindHost must be 0\.0\.0\.0/,
    ],
    [{ gateway: { tailscale: { mode: "serve" } } }, /gateway\.tailscale\.mode must be off/],
    [
      {
        plugins: { entries: { codex: { config: { appServer: { approvalPolicy: "untrusted" } } } } },
      },
      /appServer\.approvalPolicy must not be "untrusted"/,
    ],
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

    await assert.rejects(() => driver.prepareRevision(revision), expected);
    assert.equal(networkAccesses, 0);
    assert.equal(dockerRequests, 0);
  }
  // Admission names the same listener settings with a 409 before a revision exists.
  for (const [gateway, setting] of [
    [{ bind: "loopback" }, "gateway.bind"],
    [{ bind: "custom", customBindHost: "127.0.0.1" }, "gateway.customBindHost"],
    [{ tailscale: { mode: "funnel" } }, "gateway.tailscale.mode"],
  ]) {
    assert.throws(
      () => driver.validateGatewaySettings({ gateway }),
      (error) => error instanceof ComputeGatewaySettingError && error.setting === setting,
    );
  }
  assert.doesNotThrow(() => driver.validateGatewaySettings({ gateway: { bind: "lan" } }));
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
    configuration: admitLoggingConfiguration(configuration, "info"),
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

test("Docker Compute recovery keeps dedicated transport paired across container reuse and replacement", async () => {
  // Model only the Docker inspect/create boundary; token selection and reconciliation
  // run in the real Driver. The Compose integration separately kills a real worker.
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
        containers.set(url.searchParams.get("name"), {
          Config: structuredClone(body),
          State: { Running: true, Health: { Status: "healthy" } },
        });
        return "";
      }
      const [, name, action] = /^\/containers\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname) ?? [];
      if (method === "POST" && action === "start") {
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
  const driver = createDriver();
  const revision = {
    id: "revision-docker-recovery",
    namespaceId: tenant.id,
    agentId: "agent-recovery",
    revision: 1,
    configurationId: "cfg_00000000-0000-4000-8000-000000000001",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: admitLoggingConfiguration({}, "info"),
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: "service-principal-docker-recovery",
    createdAt: tenant.createdAt,
  };
  const role = (name) =>
    [...containers.entries()].find(
      ([, value]) => value.Config.Labels["org.openclaw.enterprise.role"] === name,
    );
  const token = (container) =>
    container.Config.Env.find((value) => value.startsWith("APP_SERVER_TOKEN="));
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-api-key";
  try {
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
  } finally {
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  }
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
          /native main/,
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
        /managed storage/,
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
