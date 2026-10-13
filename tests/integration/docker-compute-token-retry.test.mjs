import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const execute = promisify(execFile);
const selected = process.env.OCC_TEST_DOCKER_TOKEN_RETRY === "1";
const requiresDockerTokenRetry = {
  skip: selected
    ? false
    : "Set OCC_TEST_DOCKER_TOKEN_RETRY=1 to run the disposable Docker token retry proof.",
};
const fixtureDirectory = fileURLToPath(new URL("../fixtures/docker-token-retry", import.meta.url));
const LABEL_MANAGED = "org.openclaw.enterprise.managed";
const LABEL_DRIVER = "org.openclaw.enterprise.compute-driver";
const LABEL_NAMESPACE = "org.openclaw.enterprise.namespace-id";
const LABEL_AGENT = "org.openclaw.enterprise.agent-id";
const LABEL_REVISION = "org.openclaw.enterprise.revision-id";
const LABEL_ROLE = "org.openclaw.enterprise.role";

async function docker(args, options = {}) {
  try {
    const env = { ...process.env };
    for (const name of [
      "DOCKER_CONTEXT",
      "DOCKER_HOST",
      "DOCKER_TLS",
      "DOCKER_TLS_VERIFY",
      "DOCKER_CERT_PATH",
    ]) {
      delete env[name];
    }
    return await execute("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
      env,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    // Inspect output includes credentials; never attach raw command errors.
    throw new Error(`Docker ${args[0]} failed; command output withheld.`);
  }
}

async function dockerJson(args, options) {
  const { stdout } = await docker(args, options);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Docker returned invalid JSON; credential-bearing output withheld.");
  }
}

async function dockerLines(args, options) {
  const { stdout } = await docker(args, options);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function labelFilters(labels) {
  return labels.flatMap(([name, value]) => ["--filter", `label=${name}=${value}`]);
}

async function inspectContainers(filters) {
  const ids = await dockerLines([
    "ps",
    "-aq",
    ...labelFilters([[LABEL_MANAGED, "true"], [LABEL_DRIVER, "docker"], ...filters]),
  ]);
  if (ids.length === 0) {
    return [];
  }
  return dockerJson(["inspect", ...ids]);
}

async function networkIds(namespaceId) {
  return dockerLines([
    "network",
    "ls",
    "-q",
    ...labelFilters([
      [LABEL_MANAGED, "true"],
      [LABEL_DRIVER, "docker"],
      [LABEL_NAMESPACE, namespaceId],
    ]),
  ]);
}

async function waitFor(description, operation, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined && value !== false) {
        return value;
      }
    } catch {
      // Containers may disappear between listing and inspection during startup.
    }
    await delay(500);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

function containerEnv(container, name) {
  const entry = (container.Config?.Env ?? []).find((value) => value.startsWith(`${name}=`));
  return entry === undefined ? undefined : entry.slice(name.length + 1);
}

function assertGatewayLoopbackBinding(gateway) {
  const port = containerEnv(gateway, "OPENCLAW_GATEWAY_PORT");
  const bindings = gateway.NetworkSettings?.Ports?.[`${port}/tcp`];
  assert.equal(Array.isArray(bindings) && bindings.length === 1, true);
  assert.equal(bindings[0].HostIp, "127.0.0.1");
}

async function waitForRuntime(namespaceId, agentId, revisionId) {
  const [gateway] = await waitFor("dedicated gateway container", async () => {
    const containers = await inspectContainers([
      [LABEL_NAMESPACE, namespaceId],
      [LABEL_AGENT, agentId],
      [LABEL_REVISION, revisionId],
      [LABEL_ROLE, "gateway"],
    ]);
    const running = containers.filter(
      (container) =>
        container.State?.Running === true && container.State?.Health?.Status === "healthy",
    );
    return running.length === 1 ? running : undefined;
  });
  const [agent] = await waitFor("dedicated app-server container", async () => {
    const containers = await inspectContainers([
      [LABEL_NAMESPACE, namespaceId],
      [LABEL_AGENT, agentId],
      [LABEL_REVISION, revisionId],
      [LABEL_ROLE, "agent"],
    ]);
    const running = containers.filter(
      (container) =>
        container.State?.Running === true && container.State?.Health?.Status === "healthy",
    );
    return running.length === 1 ? running : undefined;
  });
  return { agent, gateway };
}

async function assertGatewayCanReachAgent(gateway) {
  assertGatewayLoopbackBinding(gateway);
  // Probe inside the owned gateway so the test also works when the Docker
  // daemon and test runner have different network namespaces. The fixture
  // endpoint still performs real gateway-to-app-server WebSocket requests.
  await docker([
    "exec",
    gateway.Id,
    "node",
    "-e",
    `fetch("http://127.0.0.1:" + process.env.OPENCLAW_GATEWAY_PORT + "/token-check", {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => process.exit(response.status === 200 ? 0 : 1))
      .catch(() => process.exit(1));`,
  ]);
}

async function buildFixtureImage(tag) {
  const baseImage = process.env.NODE_BASE_IMAGE ?? "node:24-bookworm";
  const context = await mkdtemp(join(tmpdir(), "oce-token-retry-"));
  try {
    // Use the installed production WebSocket dependency without installing or
    // changing the workspace graph. The fixture runs the actual readiness script.
    const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
    const kubernetesRequire = createRequire(require.resolve("@kubernetes/client-node"));
    const wsDirectory = dirname(kubernetesRequire.resolve("ws/package.json"));
    await cp(fixtureDirectory, context, { recursive: true });
    await cp(wsDirectory, join(context, "ws"), { recursive: true });
    await docker(
      [
        "build",
        "--pull=false",
        "--build-arg",
        `NODE_BASE_IMAGE=${baseImage}`,
        "--tag",
        tag,
        context,
      ],
      { timeoutMs: 180_000 },
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

async function dockerApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: "/var/run/docker.sock",
        method,
        path,
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 201 && response.statusCode !== 204) {
            reject(new Error(`Docker fixture API returned HTTP ${response.statusCode}.`));
            return;
          }
          try {
            const text = Buffer.concat(chunks).toString();
            resolve(text ? JSON.parse(text) : undefined);
          } catch {
            reject(new Error("Docker fixture API returned invalid JSON."));
          }
        });
        response.on("error", () => reject(new Error("Docker fixture API response failed.")));
      },
    );
    request.on("error", () => reject(new Error("Docker fixture API request failed.")));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function replaceWithForeignOwner(container, cleanupIds) {
  const name = container.Name.slice(1);
  const network = container.HostConfig.NetworkMode;
  await docker(["rm", "-f", container.Id]);
  // A manually created collision keeps the same revision and real runtime
  // configuration but belongs to a different Agent. Docker owns these labels.
  const created = await dockerApi("POST", `/containers/create?name=${encodeURIComponent(name)}`, {
    ...container.Config,
    Labels: { ...container.Config.Labels, [LABEL_AGENT]: `agt_${randomUUID()}` },
    HostConfig: {
      ...container.HostConfig,
      PortBindings:
        container.Config.Labels[LABEL_ROLE] === "gateway"
          ? { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] }
          : {},
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [name] } } },
  });
  cleanupIds.add(created.Id);
  await dockerApi("POST", `/containers/${created.Id}/start`);
  return waitFor("healthy foreign-owned fixture container", async () => {
    const [observed] = await dockerJson(["inspect", created.Id]);
    return observed.State?.Running === true && observed.State?.Health?.Status === "healthy"
      ? observed
      : undefined;
  });
}

function namespace(label) {
  return {
    id: `ns_${randomUUID()}`,
    name: label,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
}

function revision(driver, owner) {
  const agentId = `agt_${randomUUID()}`;
  return {
    id: `rev_${randomUUID()}`,
    namespaceId: owner.id,
    agentId,
    revision: 1,
    providerId: null,
    configurationId: `cfg_${randomUUID()}`,
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: admitLoggingConfiguration(
      createHarnessConfiguration("codex", "gpt-4.1"),
      "info",
    ),
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: `service-agent-${agentId}`,
    createdAt: new Date().toISOString(),
  };
}

// These disposable binaries implement token authentication, WebSocket ping/pong,
// and an empty plugin catalog for startup. This exercises Docker reconciliation,
// not genuine Codex, plugin installation, or model turns.
test(
  "Docker driver keeps dedicated transport coherent and rejects foreign owners across retries",
  { ...requiresDockerTokenRetry, timeout: 360_000 },
  async (context) => {
    await docker(["version"], { timeoutMs: 30_000 });
    const image = `oce-docker-token-retry:${randomUUID()}`;
    const foreignIds = new Set();
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    // The fixture login consumes this inert value; no model endpoint is called.
    process.env.OPENAI_API_KEY = "docker-token-retry-fixture-key";
    let built = false;
    let owner;
    let driver;
    context.after(async () => {
      if (previousOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAIKey;
      }
      const failures = [];
      for (const id of foreignIds) {
        try {
          await docker(["rm", "-f", id]);
        } catch (error) {
          failures.push(error);
        }
      }
      if (owner !== undefined) {
        try {
          assert.equal((await driver.deleteNamespace(owner)).namespaceDeleted, true);
          // Inspect contains tokens; assert counts so failed cleanup cannot print it.
          assert.equal((await inspectContainers([[LABEL_NAMESPACE, owner.id]])).length, 0);
          assert.equal((await networkIds(owner.id)).length, 0);
        } catch (error) {
          failures.push(error);
        }
      }
      if (built) {
        try {
          await docker(["rmi", image], { timeoutMs: 60_000 });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Disposable Docker fixture cleanup failed.");
      }
    });
    await buildFixtureImage(image);
    built = true;
    driver = new DockerComputeDriver({ images: { gateway: image, agent: image } });
    await driver.preflight();
    owner = namespace("token-retry");
    const candidate = revision(driver, owner);
    const expected = {
      namespaceId: owner.id,
      agentId: candidate.agentId,
      revisionId: candidate.id,
      ready: true,
    };
    assert.deepEqual(await driver.ensureNamespace(owner), {
      namespaceId: owner.id,
      namespaceReady: true,
    });
    assert.deepEqual(await driver.prepareRevision(candidate), expected);
    const first = await waitForRuntime(owner.id, candidate.agentId, candidate.id);
    const originalToken = containerEnv(first.agent, "APP_SERVER_TOKEN");
    assert.ok(
      typeof originalToken === "string" && originalToken.length > 0,
      "app server owns a nonempty transport token",
    );
    assert.ok(
      originalToken === containerEnv(first.gateway, "APP_SERVER_TOKEN"),
      "initial gateway uses the app-server token",
    );
    await assertGatewayCanReachAgent(first.gateway);

    // Losing only the gateway preserves the healthy owned app server and its
    // credential; a fresh per-attempt token must not reach the replacement gateway.
    await docker(["rm", "-f", first.gateway.Id]);
    assert.deepEqual(await driver.prepareRevision(candidate), expected);
    const afterGatewayRetry = await waitForRuntime(owner.id, candidate.agentId, candidate.id);
    await assertGatewayCanReachAgent(afterGatewayRetry.gateway);
    assert.equal(afterGatewayRetry.agent.Id, first.agent.Id);
    assert.notEqual(afterGatewayRetry.gateway.Id, first.gateway.Id);
    assert.ok(
      containerEnv(afterGatewayRetry.agent, "APP_SERVER_TOKEN") === originalToken,
      "retained app-server token is unchanged",
    );
    assert.ok(
      containerEnv(afterGatewayRetry.gateway, "APP_SERVER_TOKEN") === originalToken,
      "replacement gateway uses retained app-server token",
    );

    // Losing the app server rotates its credential. The still-healthy gateway
    // must be replaced because the app server, not the gateway, owns the token.
    await docker(["kill", afterGatewayRetry.agent.Id]);
    assert.deepEqual(await driver.prepareRevision(candidate), expected);
    const afterAgentRetry = await waitForRuntime(owner.id, candidate.agentId, candidate.id);
    await assertGatewayCanReachAgent(afterAgentRetry.gateway);
    assert.notEqual(afterAgentRetry.agent.Id, afterGatewayRetry.agent.Id);
    assert.notEqual(afterAgentRetry.gateway.Id, afterGatewayRetry.gateway.Id);
    const replacementToken = containerEnv(afterAgentRetry.agent, "APP_SERVER_TOKEN");
    assert.ok(
      typeof replacementToken === "string" &&
        replacementToken.length > 0 &&
        replacementToken !== originalToken,
      "replacement app server rotates its transport token",
    );
    assert.ok(
      containerEnv(afterAgentRetry.gateway, "APP_SERVER_TOKEN") === replacementToken,
      "gateway follows the replacement app-server token",
    );

    for (const role of ["agent", "gateway"]) {
      const before = await waitForRuntime(owner.id, candidate.agentId, candidate.id);
      const foreign = await replaceWithForeignOwner(before[role], foreignIds);
      // Same-name, same-revision collisions must be refused before reading a
      // token, reusing the container, or deleting another Agent's workload.
      await assert.rejects(driver.prepareRevision(candidate), /Refusing unowned Docker container/);
      const [preserved] = await dockerJson(["inspect", foreign.Id]);
      assert.equal(preserved.Id, foreign.Id);
      assert.equal(preserved.State.Running, true);
      const sibling = role === "agent" ? before.gateway : before.agent;
      const [retainedSibling] = await dockerJson(["inspect", sibling.Id]);
      assert.equal(retainedSibling.Id, sibling.Id);
      assert.equal(retainedSibling.State.Running, true);
      await docker(["rm", "-f", foreign.Id]);
      foreignIds.delete(foreign.Id);
      assert.deepEqual(await driver.prepareRevision(candidate), expected);
      const recovered = await waitForRuntime(owner.id, candidate.agentId, candidate.id);
      await assertGatewayCanReachAgent(recovered.gateway);
    }
  },
);

test(
  "Docker Namespace deletion cleans up owned containers after its network is removed",
  { ...requiresDockerTokenRetry, timeout: 60_000 },
  async (context) => {
    const image = process.env.NODE_BASE_IMAGE ?? "node:24-bookworm";
    const driver = new DockerComputeDriver({ images: { gateway: image, agent: image } });
    const owner = namespace("namespace-cleanup");
    const sibling = namespace("namespace-cleanup-sibling");
    const containers = [];
    const networks = [];
    const volume = `oce-namespace-cleanup-${randomUUID()}`;
    let volumeCreated = false;
    context.after(async () => {
      // Cleanup must work even on the pre-fix Driver, which leaks the container.
      for (const id of containers) {
        await docker(["rm", "-f", id]);
      }
      for (const id of networks) {
        const remaining = await dockerLines(["network", "ls", "-q", "--filter", `id=${id}`]);
        if (remaining.length > 0) {
          await docker(["network", "rm", id]);
        }
      }
      if (volumeCreated) {
        await docker(["volume", "rm", "-f", volume]);
      }
    });
    await driver.preflight();
    for (const candidate of [owner, sibling]) {
      assert.equal((await driver.ensureNamespace(candidate)).namespaceReady, true);
      const [network] = await networkIds(candidate.id);
      assert.ok(network);
      networks.push(network);
      const { stdout } = await docker([
        "create",
        "--network",
        network,
        ...labelFiltersForCreate(candidate.id),
        "--label",
        `${LABEL_AGENT}=agt_${randomUUID()}`,
        "--label",
        `${LABEL_REVISION}=rev_${randomUUID()}`,
        "--label",
        `${LABEL_ROLE}=gateway`,
        image,
        "node",
        "-e",
        "setInterval(() => {}, 1000)",
      ]);
      containers.push(stdout.trim());
    }
    await docker([
      "volume",
      "create",
      ...labelFiltersForCreate(owner.id),
      "--label",
      `${LABEL_ROLE}=workspace`,
      volume,
    ]);
    volumeCreated = true;
    // External network cleanup can leave an owned container disconnected. The
    // worker must not settle deletion solely because the network is absent.
    await docker(["network", "disconnect", "--force", networks[0], containers[0]]);
    await docker(["network", "rm", networks[0]]);
    assert.deepEqual(await driver.deleteNamespace(owner), {
      namespaceId: owner.id,
      namespaceDeleted: true,
    });
    assert.equal((await inspectContainers([[LABEL_NAMESPACE, owner.id]])).length, 0);
    assert.equal(
      (await dockerLines(["volume", "ls", "-q", "--filter", `name=${volume}`])).length,
      0,
    );
    assert.equal((await inspectContainers([[LABEL_NAMESPACE, sibling.id]])).length, 1);
    assert.equal((await networkIds(sibling.id)).length, 1);
    // Normal deletion and repeated deletion retain the same cleanup contract.
    assert.equal((await driver.deleteNamespace(sibling)).namespaceDeleted, true);
    assert.equal((await inspectContainers([[LABEL_NAMESPACE, sibling.id]])).length, 0);
    assert.equal((await networkIds(sibling.id)).length, 0);
    assert.equal((await driver.deleteNamespace(owner)).namespaceDeleted, true);
  },
);

function labelFiltersForCreate(namespaceId) {
  return [
    [LABEL_MANAGED, "true"],
    [LABEL_DRIVER, "docker"],
    [LABEL_NAMESPACE, namespaceId],
  ].flatMap(([name, value]) => ["--label", `${name}=${value}`]);
}
