import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  assertDockerRuntimeOtelSettings,
  createOtelLogObservation,
  OTEL_RESOURCE,
} from "../helpers/logging-otel-observation.mjs";

const executeFile = promisify(execFile);
const tuiPty = fileURLToPath(new URL("../helpers/tui-pty.py", import.meta.url));
const python = process.env.PYTHON ?? "python3";

const podmanSelected = process.env.OCC_TEST_PODMAN_COMPUTE_REAL === "1";
const engineBinary = podmanSelected ? "podman" : "docker";
const engineName = podmanSelected ? "Podman" : "Docker";
const executionModes = ["embedded", "dedicated"];
const selected =
  podmanSelected ||
  process.env.OCC_TEST_DOCKER_COMPUTE_REAL === "1" ||
  process.env.OCC_TEST_OTEL_LOGS === "1" ||
  [
    process.env.OCC_DOCKER_RUNTIME_IMAGE,
    process.env.OCC_DOCKER_GATEWAY_IMAGE,
    process.env.OCC_DOCKER_AGENT_IMAGE,
  ].some((value) => typeof value === "string" && value.trim().length > 0);
const requiresDockerCompute = {
  skip: selected
    ? false
    : "Set OCC_TEST_DOCKER_COMPUTE_REAL=1 or OCC_TEST_PODMAN_COMPUTE_REAL=1 plus Compose runtime image variables and OPENAI_API_KEY to run the real Docker Compute proof.",
};

const DEFAULT_RUNTIME_IMAGE = "oce-harness-real:pr26-compatible-runtime";
const COMPOSE_FILE = "compose.yaml";
const LOGGING_COMPOSE_FILE = "compose.logging.yaml";
const PODMAN_COMPOSE_FILE = "compose.podman.yaml";
const INTERNAL_API_PORT = "3000";
const BOOTSTRAP_SERVICE_KEY_PATH = "/var/lib/openclaw/bootstrap/initial-admin-service-key.json";
const OCC_CLI = join(process.cwd(), "bin", "occ");
const LABEL_COMPOSE_PROJECT = podmanSelected
  ? "io.podman.compose.project"
  : "com.docker.compose.project";
const LABEL_COMPOSE_SERVICE = podmanSelected
  ? "io.podman.compose.service"
  : "com.docker.compose.service";
const LABEL_MANAGED = "org.openclaw.enterprise.managed";
const LABEL_DRIVER = "org.openclaw.enterprise.compute-driver";
const LABEL_NAMESPACE = "org.openclaw.enterprise.namespace-id";
const LABEL_AGENT = "org.openclaw.enterprise.agent-id";
const LABEL_REVISION = "org.openclaw.enterprise.revision-id";
const LABEL_ROLE = "org.openclaw.enterprise.role";

// Dedicated Codex app-server execution sends Codex custom tools, so explicit model overrides
// must support those tools.
const providerModel = (process.env.OCC_TEST_OPENAI_MODEL ?? defaultAgentModel).replace(
  /^(?:openai|codex)\//,
  "",
);

function nonempty(value, name) {
  assert.equal(typeof value, "string", `${name} must be configured.`);
  assert.ok(value.trim().length > 0, `${name} must be nonempty.`);
  return value;
}

function randomComposeSubnet() {
  const octet = 16 + (Number.parseInt(randomUUID().slice(0, 2), 16) % 64);
  return `172.30.${octet}.0/24`;
}

function sanitize(text, secrets) {
  return secrets.reduce(
    (current, secret) => (secret ? current.replaceAll(secret, "[REDACTED]") : current),
    text,
  );
}

function assertNoSecretMaterial(value, secrets, description) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) {
      continue;
    }
    assert.equal(serialized.includes(secret), false, description);
  }
}

async function command(file, args, { env, timeoutMs = 120_000, secrets = [] } = {}) {
  try {
    return await executeFile(file, args, {
      env: env === undefined ? process.env : env,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const display = sanitize(`${file} ${args.join(" ")}`, secrets);
    const stdout = sanitize(String(error.stdout ?? ""), secrets);
    const stderr = sanitize(String(error.stderr ?? ""), secrets);
    throw new Error(`${display} failed with exit ${error.code ?? "unknown"}.\n${stdout}${stderr}`);
  }
}

async function docker(args, options) {
  return command(engineBinary, args, options);
}

async function dockerJson(args, options) {
  const { stdout } = await docker(args, options);
  return JSON.parse(stdout);
}

async function dockerLines(args, options) {
  const { stdout } = await docker(args, options);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
  return port;
}

async function waitFor(description, operation, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined && value !== false) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(750);
  }
  assert.fail(
    `Timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }.`,
  );
}

function composeArguments(project, commandName, args = [], { withLogging = false } = {}) {
  const files = [
    COMPOSE_FILE,
    "deploy/metrics/listeners.compose.yaml",
    ...(withLogging ? [LOGGING_COMPOSE_FILE] : []),
    ...(podmanSelected
      ? [PODMAN_COMPOSE_FILE, "tests/fixtures/docker-compute/compose.podman.yaml"]
      : []),
  ];
  return [
    "compose",
    "--project-name",
    project,
    ...files.flatMap((file) => ["--file", file]),
    commandName,
    ...args,
  ];
}

function labelFilters(labels) {
  return labels.flatMap(([name, value]) => ["--filter", `label=${name}=${value}`]);
}

function managedNamespaceLabels(namespaceId) {
  return [
    [LABEL_MANAGED, "true"],
    [LABEL_DRIVER, "docker"],
    [LABEL_NAMESPACE, namespaceId],
  ];
}

async function composeProjectGatewayPasswords(project) {
  const ids = await dockerLines([
    "ps",
    "-aq",
    ...labelFilters([[LABEL_COMPOSE_PROJECT, project]]),
  ]).catch(() => []);
  if (ids.length === 0) {
    return [];
  }
  const inspected = await dockerJson(["inspect", ...ids]).catch(() => []);
  return inspected
    .flatMap((container) => (Array.isArray(container?.Config?.Env) ? container.Config.Env : []))
    .filter(
      (entry) =>
        typeof entry === "string" &&
        (entry.startsWith("OPENCLAW_GATEWAY_PASSWORD=") || entry.startsWith("GATEWAY_PASSWORD=")),
    )
    .map((entry) => entry.slice(entry.indexOf("=") + 1))
    .filter(Boolean);
}

async function composeFailureLogs(project, env, secrets, options = {}) {
  const discoveredSecrets = [...secrets, ...(await composeProjectGatewayPasswords(project))];
  try {
    const { stdout, stderr } = await docker(
      composeArguments(
        project,
        "logs",
        [
          "--no-color",
          "--tail",
          "80",
          ...(options.withLogging ? ["collector"] : []),
          "controller",
          "worker",
          "migrate",
        ],
        options,
      ),
      { env, timeoutMs: 60_000, secrets: discoveredSecrets },
    );
    return sanitize(`${stdout}${stderr}`, discoveredSecrets);
  } catch (error) {
    return sanitize(
      `Failed to collect Docker Compose logs: ${
        error instanceof Error ? error.message : String(error)
      }`,
      discoveredSecrets,
    );
  }
}

async function cleanupProject(project, env, namespaceIds = [], options = {}) {
  await docker(composeArguments(project, "down", ["--volumes", "--remove-orphans"], options), {
    env,
    timeoutMs: 120_000,
  }).catch(() => {});
  const containers = await idsByNamespace(namespaceIds, ["ps", "-aq"]);
  if (containers.length > 0) {
    await docker(["rm", "-f", ...containers]).catch(() => {});
  }

  const networks = await idsByNamespace(namespaceIds, ["network", "ls", "-q"]);
  for (const network of networks) {
    await docker(["network", "rm", network]).catch(() => {});
  }

  const volumes = await dockerLines([
    "volume",
    "ls",
    "-q",
    ...labelFilters([[LABEL_COMPOSE_PROJECT, project]]),
  ]).catch(() => []);
  if (volumes.length > 0) {
    await docker(["volume", "rm", ...volumes]).catch(() => {});
  }

  const applicationImage = `${project}-application`;
  if (options.removeApplicationImage === true) {
    await docker(["image", "rm", applicationImage]).catch(() => {});
  }

  if (options.verify === true) {
    const [
      runtimeContainers,
      namespaceNetworks,
      projectContainers,
      projectNetworks,
      projectVolumes,
      projectImages,
    ] = await Promise.all([
      idsByNamespace(namespaceIds, ["ps", "-aq"], { ignoreErrors: false }),
      idsByNamespace(namespaceIds, ["network", "ls", "-q"], { ignoreErrors: false }),
      dockerLines(["ps", "-aq", ...labelFilters([[LABEL_COMPOSE_PROJECT, project]])]),
      dockerLines(["network", "ls", "-q", ...labelFilters([[LABEL_COMPOSE_PROJECT, project]])]),
      dockerLines(["volume", "ls", "-q", ...labelFilters([[LABEL_COMPOSE_PROJECT, project]])]),
      options.removeApplicationImage === true
        ? dockerLines(["image", "ls", "-q", "--filter", `reference=${applicationImage}`])
        : Promise.resolve([]),
    ]);
    assert.deepEqual(runtimeContainers, [], "test teardown must remove owned runtime containers");
    assert.deepEqual(namespaceNetworks, [], "test teardown must remove owned Namespace networks");
    assert.deepEqual(projectContainers, [], "test teardown must remove Compose project containers");
    assert.deepEqual(projectNetworks, [], "test teardown must remove Compose project networks");
    assert.deepEqual(projectVolumes, [], "test teardown must remove Compose project volumes");
    assert.deepEqual(projectImages, [], "test teardown must remove the Podman application image");
  }
}

async function idsByNamespace(namespaceIds, baseArgs, { ignoreErrors = true } = {}) {
  return (
    await Promise.all(
      namespaceIds.map((namespaceId) => {
        const listed = dockerLines([
          ...baseArgs,
          ...labelFilters(managedNamespaceLabels(namespaceId)),
        ]);
        return ignoreErrors ? listed.catch(() => []) : listed;
      }),
    )
  ).flat();
}

async function composeServiceContainer(project, service) {
  const ids = await dockerLines([
    "ps",
    "-aq",
    ...labelFilters([
      [LABEL_COMPOSE_PROJECT, project],
      [LABEL_COMPOSE_SERVICE, service],
    ]),
  ]);
  assert.equal(ids.length, 1, `Compose service ${service} must have exactly one container`);
  const [container] = await dockerJson(["inspect", ids[0]]);
  return container;
}

function hasMountDestination(container, destination) {
  return (container.Mounts ?? []).some((mount) => mount.Destination === destination);
}

function serviceKeyHeaders(serviceKey) {
  assert.equal(typeof serviceKey, "string", "an OCC service key is required");
  assert.ok(serviceKey.length > 0, "an OCC service key is required");
  return { "x-api-key": serviceKey };
}

function apiClient(baseUrl, serviceKey) {
  return async function request(method, path, body, options = {}) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        ...(options.serviceKey === false
          ? {}
          : serviceKeyHeaders(options.serviceKey ?? serviceKey)),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    const parsed = text.length === 0 ? undefined : JSON.parse(text);
    return {
      status: response.status,
      headers: response.headers,
      ...(parsed === undefined ? {} : parsed),
    };
  };
}

async function copyBootstrapServiceKey({ project, env, outputDirectory, secrets }) {
  const localFile = join(outputDirectory, "initial-admin-service-key.json");
  const bootstrap = await composeServiceContainer(project, "bootstrap");
  assert.equal(
    hasMountDestination(bootstrap, "/var/lib/openclaw/bootstrap"),
    true,
    "bootstrap service must mount the private bootstrap output volume",
  );
  assert.equal(
    hasMountDestination(
      await composeServiceContainer(project, "controller"),
      "/var/lib/openclaw/bootstrap",
    ),
    false,
    "controller service must not mount the private bootstrap output volume",
  );
  await docker(["cp", `${bootstrap.Id}:${BOOTSTRAP_SERVICE_KEY_PATH}`, localFile], {
    env,
    timeoutMs: 60_000,
    secrets,
  });
  await chmod(localFile, 0o600);
  const outputStatus = await stat(localFile);
  assert.equal(outputStatus.mode & 0o777, 0o600);
  const output = JSON.parse(await readFile(localFile, "utf8"));
  assert.equal(typeof output, "object", "bootstrap service-key output must be JSON");
  assert.equal(typeof output?.meta?.installationId, "string");
  assert.match(output.data?.key ?? "", /^occ_/);
  assert.equal(typeof output.data?.id, "string");
  assert.equal(typeof output.data?.servicePrincipalId, "string");
  assert.equal(output.data?.name, "bootstrap-admin");
  return { localFile, output };
}

async function runOcc({ baseUrl, serviceKeyFile, args, secrets }) {
  const { stdout } = await command(OCC_CLI, [...args, "--output", "json"], {
    env: {
      ...process.env,
      OCC_URL: baseUrl,
      OCC_SERVICE_KEY_FILE: serviceKeyFile,
    },
    timeoutMs: 60_000,
    secrets,
  });
  return JSON.parse(stdout.trim());
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function postgresJson(project, env, sql, { secrets = [] } = {}) {
  const { stdout } = await docker(
    composeArguments(project, "exec", [
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "openclaw_enterprise",
      "-A",
      "-t",
      "-q",
      "-c",
      sql,
    ]),
    { env, timeoutMs: 60_000, secrets },
  );
  return JSON.parse(stdout.trim());
}

async function assertRuntimeDatabaseEvidence({
  project,
  env,
  serviceKeyOutput,
  serviceKey,
  namespaceIds,
  revisionIds,
}) {
  const namespaceArray = namespaceIds.map(sqlLiteral).join(", ");
  const revisionArray = revisionIds.map(sqlLiteral).join(", ");
  const servicePrincipalId = sqlLiteral(serviceKeyOutput.data.servicePrincipalId);
  const expectedOperatorMutationAudits = namespaceIds.length + revisionIds.length * 3;
  const evidence = await postgresJson(
    project,
    env,
    `SELECT json_build_object(
      'operatorMutationAudits', (
        SELECT count(*)::integer
        FROM occ.audit_events
        WHERE actor_id = ${servicePrincipalId}
          AND action IN (
            'openclaw.namespaces.create',
            'openclaw.configurations.create',
            'openclaw.agents.create',
            'openclaw.agents.deploy'
          )
          AND outcome = 'success'
      ),
      'namespaceLifecycleSucceeded', (
        SELECT count(*)::integer
        FROM occ.controller_work
        WHERE namespace_id IN (${namespaceArray})
          AND agent_id IS NULL
          AND revision_id IS NULL
          AND state = 'succeeded'
      ),
      'revisionLifecycleSucceeded', (
        SELECT count(*)::integer
        FROM occ.controller_work
        WHERE revision_id IN (${revisionArray})
          AND state = 'succeeded'
          AND claim_token IS NULL
          AND lease_expires_at IS NULL
          AND completed_at IS NOT NULL
      ),
      'unfinishedLifecycleWork', (
        SELECT count(*)::integer
        FROM occ.controller_work
        WHERE namespace_id IN (${namespaceArray})
          AND state <> 'succeeded'
      )
    )::text`,
    { secrets: [serviceKey] },
  );
  assert.equal(
    evidence.operatorMutationAudits,
    expectedOperatorMutationAudits,
    "service-key operator must be the actor for Namespace, Configuration, Agent, and deploy mutations",
  );
  assert.equal(
    evidence.namespaceLifecycleSucceeded,
    namespaceIds.length,
    "each Namespace must complete its controller lifecycle work",
  );
  assert.equal(
    evidence.revisionLifecycleSucceeded,
    revisionIds.length,
    "each AgentRevision must complete claimed lifecycle work",
  );
  assert.equal(evidence.unfinishedLifecycleWork, 0, "test-owned lifecycle work must be complete");
}

async function assertComposeLogsDoNotLeakBootstrapServiceKey({ project, env, serviceKey }) {
  const { stdout, stderr } = await docker(
    composeArguments(project, "logs", ["--no-color", "bootstrap", "controller", "worker"]),
    { env, timeoutMs: 60_000, secrets: [serviceKey] },
  );
  assertNoSecretMaterial(
    `${stdout}${stderr}`,
    [serviceKey],
    "bootstrap, controller, and worker logs must not leak the bootstrap service key",
  );
}

async function inspectContainers(filters = []) {
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

async function containerCount(filters) {
  return (await inspectContainers(filters)).length;
}

async function inspectNetworks(namespaceId) {
  const ids = await dockerLines([
    "network",
    "ls",
    "-q",
    ...labelFilters(managedNamespaceLabels(namespaceId)),
  ]);
  if (ids.length === 0) {
    return [];
  }
  return dockerJson(["network", "inspect", ...ids]);
}

function inspectedNetworkName(network) {
  return nonempty(network.Name ?? network.name, "inspected container network name");
}

function containerEnv(container, name) {
  const entry = (container.Config?.Env ?? []).find((value) => value.startsWith(`${name}=`));
  return entry === undefined ? undefined : entry.slice(name.length + 1);
}

function hasContainerEnv(container, name) {
  return containerEnv(container, name) !== undefined;
}

function containerSecretValues(containers) {
  const secretNames = new Set([
    "APP_SERVER_TOKEN",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_API_KEY",
    "OPENCLAW_GATEWAY_PASSWORD",
  ]);
  return containers
    .flatMap((container) => container.Config?.Env ?? [])
    .map((entry) => {
      const separator = entry.indexOf("=");
      if (separator === -1) {
        return undefined;
      }
      const name = entry.slice(0, separator);
      if (!secretNames.has(name)) {
        return undefined;
      }
      return entry.slice(separator + 1);
    })
    .filter((value) => typeof value === "string" && value.length > 0);
}

async function containerLogs(containers, extraSecrets = []) {
  const secrets = [...extraSecrets, ...containerSecretValues(containers)];
  const entries = await Promise.all(
    containers.map(async (container) => {
      const name = container.Name ?? container.Id;
      try {
        const { stdout, stderr } = await docker(["logs", "--tail", "160", container.Id], {
          timeoutMs: 60_000,
          secrets,
        });
        return `Logs for ${name}:\n${sanitize(`${stdout}${stderr}`, secrets)}`;
      } catch (error) {
        return `Logs for ${name} unavailable: ${
          error instanceof Error ? sanitize(error.message, secrets) : String(error)
        }`;
      }
    }),
  );
  return entries.join("\n\n");
}

function assertNamespaceOnlyAttachment(container, networkName) {
  const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
  assert.deepEqual(
    networks,
    [networkName],
    `container ${container.Name} must join only ${networkName}`,
  );
  const attachment = container.NetworkSettings.Networks[networkName];
  assert.equal(
    Boolean(attachment?.IPAddress),
    true,
    `container ${container.Name} must have a Namespace network address`,
  );
}

async function waitForNamespaceNetwork(namespaceId) {
  const networks = await waitFor(`${engineName} network for Namespace ${namespaceId}`, async () => {
    const current = await inspectNetworks(namespaceId);
    return current.length === 1 ? current : undefined;
  });
  return networks[0];
}

async function waitForContainers(filters, expected, description) {
  return waitFor(description, async () => {
    const containers = await inspectContainers(filters);
    const running = containers.filter((container) => container.State?.Running === true);
    return running.length === expected ? running : undefined;
  });
}

function gatewayUrl(gateway) {
  const gatewayPort = containerEnv(gateway, "OPENCLAW_GATEWAY_PORT");
  assert.ok(gatewayPort, "gateway container must expose OPENCLAW_GATEWAY_PORT");
  assert.match(String(gatewayPort), /^\d+$/, "gateway port must be inspectable");
  const bindings = gateway.NetworkSettings?.Ports?.[`${gatewayPort}/tcp`];
  assert.equal(
    Array.isArray(bindings) && bindings.length === 1,
    true,
    "gateway port must be published exactly once",
  );
  const binding = bindings[0];
  assert.equal(binding.HostIp, "127.0.0.1", "gateway port must publish only on loopback");
  assert.match(String(binding.HostPort), /^\d+$/, "gateway host port must be inspectable");
  return `http://127.0.0.1:${binding.HostPort}`;
}

async function assertGatewayReady(gateway, description) {
  const response = await fetch(new URL("/readyz", gatewayUrl(gateway)), {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `${description} must leave the gateway ready`);
}

async function invokeGateway({ networkName, gateway, gatewayPassword, mode, onFailure }) {
  assertNamespaceOnlyAttachment(gateway, networkName);
  const nonce = `OCC-DOCKER-${mode.toUpperCase()}-${randomUUID()}`;
  const endpoint = new URL("/v1/chat/completions", gatewayUrl(gateway));
  const denied = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "openclaw/default", messages: [] }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok([401, 403].includes(denied.status), "gateway must reject missing bearer token");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayPassword}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "openclaw/default",
      stream: false,
      messages: [
        {
          role: "user",
          content: `Reply with exactly this nonce and no other text: ${nonce}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(240_000),
  });
  const body = sanitize(await response.text(), [gatewayPassword]);
  if (response.status !== 200) {
    const diagnostics = onFailure === undefined ? "" : `\n\n${await onFailure()}`;
    assert.fail(
      `${mode} gateway model call must succeed: ${body.slice(0, 2000)}\n\n${response.status} !== 200${diagnostics}`,
    );
  }
  const text = JSON.parse(body).choices?.[0]?.message?.content ?? "";
  assert.ok(text.includes(nonce), `${mode} gateway model response must include fresh nonce`);
}

function parseTuiPtyOutput(stdout) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(lines.length > 0, "TUI PTY helper must emit a JSON result");
  return JSON.parse(lines.at(-1));
}

async function runTuiPty(args, { secrets, timeoutMs = 540_000, onFailure } = {}) {
  try {
    const { stdout } = await command(python, [tuiPty, ...args], {
      timeoutMs,
      secrets,
    });
    return parseTuiPtyOutput(stdout);
  } catch (error) {
    const diagnostics = onFailure === undefined ? "" : `\n\n${await onFailure()}`;
    throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnostics}`);
  }
}

function tuiDockerCommand(gateway, stateDir, args, environment = []) {
  return [
    "--",
    engineBinary,
    "exec",
    "--interactive",
    "--tty",
    "-e",
    `OPENCLAW_STATE_DIR=${stateDir}`,
    ...environment.flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    gateway.Id,
    "node",
    "/app/openclaw.mjs",
    "tui",
    ...args,
  ];
}

async function assertInvalidPasswordTuiDenied({ context, gateway, gatewayPassword, onFailure }) {
  const invalidPassword = `invalid-${randomUUID()}`;
  const nonce = `OCC-TUI-DENIED-${randomUUID()}`;
  const prompt = `Reply exactly: ${nonce}`;
  const result = await runTuiPty(
    [
      "expect-failure",
      "--nonce",
      nonce,
      "--prompt",
      prompt,
      "--timeout",
      "60",
      ...tuiDockerCommand(
        gateway,
        `/tmp/occ-tui-denied-${randomUUID()}`,
        ["--session", `occ-tui-denied-${randomUUID()}`, "--message", prompt],
        [["OPENCLAW_GATEWAY_PASSWORD", invalidPassword]],
      ),
    ],
    {
      timeoutMs: 90_000,
      secrets: [gatewayPassword, invalidPassword],
      onFailure,
    },
  );
  assert.equal(
    result.denied,
    true,
    "fresh TUI client state must reject an invalid gateway password",
  );
  assertNoSecretMaterial(
    result,
    [gatewayPassword, invalidPassword],
    "TUI denial output must not leak passwords",
  );
  context.diagnostic(
    `embedded TUI invalid-password denial:\n${result.transcriptTail.slice(-1200)}`,
  );
}

async function assertInteractiveTuiConversation({ context, gateway, gatewayPassword, onFailure }) {
  const firstNonce = `OCC-TUI-FIRST-${randomUUID()}`;
  const secondNonce = `OCC-TUI-SECOND-${randomUUID()}`;
  const firstPrompt = `Reply exactly: ${firstNonce}`;
  const secondPrompt = `Reply exactly: ${secondNonce}`;
  const result = await runTuiPty(
    [
      "conversation",
      "--first-nonce",
      firstNonce,
      "--first-prompt",
      firstPrompt,
      "--second-nonce",
      secondNonce,
      "--second-prompt",
      secondPrompt,
      "--timeout",
      "240",
      ...tuiDockerCommand(gateway, `/tmp/occ-tui-client-${randomUUID()}`, [
        "--session",
        `occ-tui-${randomUUID()}`,
        "--message",
        firstPrompt,
      ]),
    ],
    {
      secrets: [gatewayPassword],
      onFailure,
    },
  );
  assert.equal(result.exitCode, 0, "Ctrl+D must exit the TUI client cleanly");
  assert.match(result.firstReplyLine, new RegExp(firstNonce));
  assert.equal(result.firstReplyLine.includes(firstPrompt), false);
  assert.match(result.secondReplyLine, new RegExp(secondNonce));
  assert.equal(result.secondReplyLine.includes(secondPrompt), false);
  assertNoSecretMaterial(
    result,
    [gatewayPassword],
    "TUI conversation output must not leak passwords",
  );
  context.diagnostic(
    `embedded TUI replies:\nfirst: ${result.firstReplyLine}\nsecond: ${result.secondReplyLine}\n${result.transcriptTail.slice(-1600)}`,
  );
  await assertGatewayReady(gateway, "Ctrl+D after the TUI conversation");
}

async function assertCollectorOutageDoesNotBlockDockerOperations({
  project,
  env,
  composeOptions,
  request,
  cleanupNamespace,
  secrets,
}) {
  let restartError;
  await docker(
    composeArguments(project, "stop", ["--timeout", "10", "collector"], composeOptions),
    {
      env,
      timeoutMs: 60_000,
      secrets,
    },
  );
  try {
    const installation = await request("GET", "/installation", undefined, { timeoutMs: 5_000 });
    assert.equal(installation.status, 200, JSON.stringify(installation.error));
    await deleteEmptyNamespace({
      request,
      cleanupNamespace,
      requestOptions: { timeoutMs: 10_000 },
    });
  } finally {
    await docker(
      composeArguments(project, "up", ["--detach", "--no-deps", "collector"], composeOptions),
      {
        env,
        timeoutMs: 60_000,
        secrets,
      },
    ).catch((error) => {
      restartError = error;
    });
  }
  if (restartError !== undefined) {
    throw restartError;
  }
}

async function deleteEmptyNamespace({ request, cleanupNamespace, requestOptions }) {
  const deleted = await request(
    "DELETE",
    `/namespaces/${cleanupNamespace.id}`,
    undefined,
    requestOptions,
  );
  assert.equal(deleted.status, 202, JSON.stringify(deleted.error));
  await waitFor(`cleanup Namespace ${cleanupNamespace.id} network removal`, async () => {
    return (await inspectNetworks(cleanupNamespace.id)).length === 0 ? true : undefined;
  });
}

async function interruptDedicatedPreparation(project, namespaceId, agentId, revisionId) {
  const worker = await composeServiceContainer(project, "worker");
  const filters = [
    [LABEL_NAMESPACE, namespaceId],
    [LABEL_AGENT, agentId],
    [LABEL_REVISION, revisionId],
  ];
  // Kill the real worker during Codex startup, before it can create the gateway.
  // The surviving container and expired database lease must be recovered by a fresh process.
  let survivingAgent;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    [survivingAgent] = await inspectContainers([...filters, [LABEL_ROLE, "agent"]]);
    if (survivingAgent?.State?.Running) {
      break;
    }
    await delay(25);
  }
  assert.ok(survivingAgent?.State?.Running, "Codex must start before worker interruption");
  await docker(["kill", "--signal", "KILL", worker.Id]);
  try {
    assert.equal(
      await containerCount([...filters, [LABEL_ROLE, "gateway"]]),
      0,
      "interruption must occur before gateway creation",
    );
    await waitFor("surviving Codex container to become healthy", async () => {
      const [current] = await dockerJson(["inspect", survivingAgent.Id]);
      return current.State?.Health?.Status === "healthy";
    });
  } finally {
    await docker(["start", worker.Id]);
  }
  return survivingAgent.Id;
}

async function createAgentJourney({ request, namespaceId, mode, label, afterAdmission }) {
  const initialWorkspaceFiles = {
    "AGENTS.md":
      "# Agent instructions\nAnswer the user directly and preserve supplied nonce values.\n",
    "SOUL.md": "",
    "IDENTITY.md": "# Identity\n- **Name:** Workspace setup proof\n",
    "USER.md": "# User\n- **Name:** Integration operator\n",
  };
  const harnessId = mode === "dedicated" ? "codex" : "openclaw";
  const values = createHarnessConfiguration(harnessId, providerModel);
  const configuration = await request("POST", `/namespaces/${namespaceId}/configurations`, {
    kind: "agent",
    values,
  });
  assert.equal(configuration.status, 201, JSON.stringify(configuration.error));
  const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
    name: `${label}-${randomUUID()}`,
    initialWorkspaceFiles,
    configurationId: configuration.data.id,
    executionMode: mode,
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.error));
  const revision = await request(
    "POST",
    `/namespaces/${namespaceId}/agents/${agent.data.id}/deploy`,
  );
  assert.equal(revision.status, 202, JSON.stringify(revision.error));
  assert.match(
    revision.data.compute.implementation,
    /docker/i,
    "admitted revisions must select the Docker Compute Driver",
  );
  await afterAdmission?.(agent.data, revision.data);
  await waitFor(`Agent ${agent.data.id} to activate ${revision.data.id}`, async () => {
    const current = await request("GET", `/namespaces/${namespaceId}/agents/${agent.data.id}`);
    assert.equal(current.status, 200, JSON.stringify(current.error));
    return current.data.activeRevisionId === revision.data.id ? current.data : undefined;
  });
  // Observe initial files after the normal Agent activation and before any model
  // invocation. Docker does not yet expose the OCC workspace-file proxy.
  const [gateway] = await waitForContainers(
    [
      [LABEL_NAMESPACE, namespaceId],
      [LABEL_AGENT, agent.data.id],
      [LABEL_ROLE, "gateway"],
    ],
    1,
    "initialized Agent gateway",
  );
  const { stdout } = await docker([
    "exec",
    gateway.Id,
    "node",
    "-e",
    "const fs=require('node:fs'); console.log(JSON.stringify(Object.fromEntries(['AGENTS.md','SOUL.md','IDENTITY.md','USER.md'].map(name=>[name,fs.readFileSync('/home/node/.openclaw/workspace/'+name,'utf8')]))));",
  ]);
  assert.deepEqual(JSON.parse(stdout), initialWorkspaceFiles);
  return { agent: agent.data, revision: revision.data };
}

test(
  `${engineName} Compose cleanup preserves the selected engine and removes volumes only when requested`,
  {
    skip: selected
      ? false
      : "Set OCC_TEST_DOCKER_COMPUTE_REAL=1 or OCC_TEST_PODMAN_COMPUTE_REAL=1 for real Compose cleanup.",
    timeout: 300_000,
  },
  async (context) => {
    await command("go", ["build", "-trimpath", "-o", OCC_CLI, "./cmd/occ"]);
    const project = `oce-cleanup-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const env = {
      ...process.env,
      COMPOSE_PROJECT_NAME: project,
      OCC_POSTGRES_PORT: String(await reserveLoopbackPort()),
      OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR: randomComposeSubnet(),
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "docker",
      OCC_DEVELOPMENT_CONTAINER_ENGINE: engineBinary,
      OPENAI_API_KEY: "",
      ...(podmanSelected ? { PODMAN_COMPOSE_PROVIDER: "podman-compose" } : {}),
    };
    if (podmanSelected) {
      const { stdout } = await docker(["info", "--format", "{{.Host.RemoteSocket.Path}}"], {
        env,
      });
      env.OCC_CONTAINER_ENGINE_SOCKET = stdout.trim().replace(/^unix:\/\//, "");
    }
    context.after(() => cleanupProject(project, env, [], { verify: true }));

    // Cleanup must work even when startup stopped after PostgreSQL, before an
    // Installation or Agent exists. Use the shipped Compose files and real engine.
    await docker(composeArguments(project, "up", ["--no-deps", "--detach", "postgres"]), {
      env,
    });
    await waitFor("development PostgreSQL readiness", async () => {
      const postgres = await composeServiceContainer(project, "postgres");
      return postgres.State.Health?.Status === "healthy";
    });
    const composeOptions = composeArguments(project, "down").slice(1, -1);
    const cliEnv = { ...env, OCC_CONTAINER_ENGINE_SOCKET: "" };
    await command(OCC_CLI, ["dev", "down", "--", ...composeOptions], { env: cliEnv });

    const projectLabels = labelFilters([[LABEL_COMPOSE_PROJECT, project]]);
    assert.deepEqual(await dockerLines(["ps", "-aq", ...projectLabels]), []);
    assert.deepEqual(await dockerLines(["network", "ls", "-q", ...projectLabels]), []);
    const databaseVolume = `${project}_occ_postgres_data`;
    assert.equal((await dockerJson(["volume", "inspect", databaseVolume])).length, 1);

    // A second cleanup must still find the retained database through the same
    // connection and delete it only with the operator's explicit --volumes flag.
    await command(OCC_CLI, ["dev", "down", "--volumes", "--", ...composeOptions], {
      env: cliEnv,
    });
    assert.deepEqual(await dockerLines(["volume", "ls", "-q", ...projectLabels]), []);
  },
);

test(
  `${engineName} Compose development drives Docker Compute networks, containers, auth, cleanup, and real model turns`,
  { ...requiresDockerCompute, timeout: 1_200_000 },
  async (context) => {
    // This credentialed proof uses the same compiled CLI operators invoke.
    await command("go", ["build", "-trimpath", "-o", OCC_CLI, "./cmd/occ"], {
      timeoutMs: 120_000,
    });
    assert.equal(
      podmanSelected &&
        (process.env.OCC_TEST_OTEL_LOGS === "1" ||
          Boolean(process.env.OCC_TEST_OTEL_LOGS_JSONL) ||
          Boolean(process.env.OCC_TEST_OTEL_LOGS_URL)),
      false,
      "Podman does not support Docker Fluentd/OTLP logging proof",
    );
    const providerKey = nonempty(
      process.env.OPENAI_API_KEY,
      `OPENAI_API_KEY for real ${engineName} Compute model turns`,
    );
    const runtimeImage = process.env.OCC_DOCKER_RUNTIME_IMAGE ?? DEFAULT_RUNTIME_IMAGE;
    const gatewayImage = process.env.OCC_DOCKER_GATEWAY_IMAGE ?? runtimeImage;
    const agentImage = process.env.OCC_DOCKER_AGENT_IMAGE ?? runtimeImage;
    const podmanComposeProvider = "podman-compose";
    let podmanSocket;
    if (podmanSelected) {
      await command(podmanComposeProvider, ["--version"], { timeoutMs: 30_000 });
      const { stdout } = await docker(["info", "--format", "{{.Host.RemoteSocket.Path}}"], {
        timeoutMs: 30_000,
      });
      podmanSocket = nonempty(stdout.trim().replace(/^unix:\/\//, ""), "Podman API socket path");
      assert.equal(podmanSocket.startsWith("/"), true, "Podman API socket path must be absolute");
    }
    await docker(["version"], { timeoutMs: 30_000 });
    await docker(["compose", "version"], {
      env: podmanSelected
        ? { ...process.env, PODMAN_COMPOSE_PROVIDER: podmanComposeProvider }
        : process.env,
      timeoutMs: 30_000,
    });
    await Promise.all(
      [gatewayImage, agentImage].map((image) =>
        docker(["image", "inspect", image], { timeoutMs: 30_000 }),
      ),
    );

    const apiPort = await reserveLoopbackPort();
    const postgresPort = await reserveLoopbackPort();
    const project = `oce-${engineBinary}-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const namespaceIds = [];
    let cleanupServiceKey;
    const adminEmail = `admin-${project}@example.test`;
    const adminPassword = `${engineBinary}-admin-${randomUUID()}`;
    const baseUrl = `http://127.0.0.1:${apiPort}`;
    const composeSubnet = randomComposeSubnet();
    const otelLogs = createOtelLogObservation(context, {
      description: `${engineName} Compose real-runtime OTel logs`,
    });
    const loggingPort = otelLogs.enabled ? await reserveLoopbackPort() : undefined;
    const loggingMetricsPort = otelLogs.enabled ? await reserveLoopbackPort() : undefined;
    const composeOptions = {
      withLogging: otelLogs.enabled,
      removeApplicationImage: podmanSelected,
    };
    const env = {
      ...process.env,
      COMPOSE_PROJECT_NAME: project,
      NODE_BASE_IMAGE: process.env.NODE_BASE_IMAGE ?? "docker.io/library/node:24-bookworm",
      NODE_ENV: "development",
      OCC_HOST: "0.0.0.0",
      OCC_PORT: INTERNAL_API_PORT,
      OPENCLAW_DEV_PORT: String(apiPort),
      OCC_POSTGRES_PORT: String(postgresPort),
      OCC_DATABASE_URL: syntheticCredentialUrl({
        protocol: "postgresql",
        username: "occ_app",
        password: "occ-app-local",
        host: "postgres",
        port: 5432,
        pathname: "/openclaw_enterprise",
      }),
      OCC_MIGRATION_DATABASE_URL: syntheticCredentialUrl({
        protocol: "postgresql",
        username: "occ_migrator",
        password: "occ-migrator-local",
        host: "postgres",
        port: 5432,
        pathname: "/openclaw_enterprise",
      }),
      OCC_AUTH_BASE_URL: baseUrl,
      OPENCLAW_DEV_EMAIL: adminEmail,
      OPENCLAW_DEV_PASSWORD: adminPassword,
      OPENCLAW_DEV_INSTALLATION_NAME: `OpenClaw ${engineName} Compute ${project}`,
      OCC_DOCKER_RUNTIME_IMAGE: runtimeImage,
      OCC_DOCKER_GATEWAY_IMAGE: gatewayImage,
      OCC_DOCKER_AGENT_IMAGE: agentImage,
      OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR: composeSubnet,
      ...(podmanSelected
        ? {
            PODMAN_COMPOSE_PROVIDER: podmanComposeProvider,
            OCC_CONTAINER_ENGINE_SOCKET: podmanSocket,
          }
        : {}),
      ...(loggingPort === undefined
        ? {}
        : {
            OCC_DOCKER_LOGGING_ADDRESS: `127.0.0.1:${loggingPort}`,
            OTEL_COLLECTOR_PORT: String(loggingPort),
            OTEL_COLLECTOR_METRICS_PORT: String(loggingMetricsPort),
          }),
      OPENAI_API_KEY: providerKey,
    };

    context.after(async () => {
      const cleanupNamespaceIds = new Set(namespaceIds);
      let namespaceDiscoveryError;
      if (cleanupServiceKey !== undefined) {
        try {
          const listed = await apiClient(baseUrl, cleanupServiceKey)("GET", "/namespaces");
          assert.equal(listed.status, 200, JSON.stringify(listed.error));
          assert.ok(Array.isArray(listed.data), "Namespace cleanup discovery must return a list");
          for (const namespace of listed.data) {
            cleanupNamespaceIds.add(namespace.id);
          }
        } catch (error) {
          namespaceDiscoveryError = error;
        }
      }
      await cleanupProject(project, env, [...cleanupNamespaceIds], {
        ...composeOptions,
        verify: podmanSelected,
      });
      if (namespaceDiscoveryError !== undefined) {
        throw namespaceDiscoveryError;
      }
    });
    const bootstrapDirectory = await mkdtemp(
      join(tmpdir(), `openclaw-${engineBinary}-bootstrap-key-`),
    );
    context.after(async () => {
      await rm(bootstrapDirectory, { recursive: true, force: true });
    });
    await cleanupProject(project, env, [], composeOptions);
    const composeSecrets = [providerKey, adminPassword];
    try {
      if (podmanSelected) {
        await docker(composeArguments(project, "build", ["migrate"], composeOptions), {
          env,
          timeoutMs: 600_000,
          secrets: composeSecrets,
        });
      }
      await docker(
        composeArguments(
          project,
          "up",
          podmanSelected ? ["--no-build", "--detach"] : ["--build", "--detach", "--wait"],
          composeOptions,
        ),
        {
          env,
          timeoutMs: 300_000,
          secrets: composeSecrets,
        },
      );
    } catch (error) {
      const logs = await composeFailureLogs(project, env, composeSecrets, composeOptions);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n\n${engineName} Compose failure logs for ${project}:\n${logs}`,
      );
    }

    await waitFor("OCC API to accept HTTP requests", async () => {
      const response = await fetch(new URL("/api/auth/session", baseUrl), {
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
      return response?.status === 200 ? true : undefined;
    });
    assertDockerRuntimeOtelSettings(
      otelLogs,
      await Promise.all(
        ["bootstrap", "controller", "worker"].map((service) =>
          composeServiceContainer(project, service),
        ),
      ),
    );

    const { localFile: serviceKeyFile, output: serviceKeyOutput } = await copyBootstrapServiceKey({
      project,
      env,
      outputDirectory: bootstrapDirectory,
      secrets: composeSecrets,
    });
    const serviceKey = serviceKeyOutput.data.key;
    cleanupServiceKey = serviceKey;
    assert.equal(serviceKeyOutput.meta.installationId.startsWith("ins_"), true);
    const helperInstallation = await runOcc({
      baseUrl,
      serviceKeyFile,
      args: ["installation", "get"],
      secrets: [...composeSecrets, serviceKey],
    });
    assert.equal(helperInstallation.id, serviceKeyOutput.meta.installationId);
    const helperNamespace = await runOcc({
      baseUrl,
      serviceKeyFile,
      args: ["namespace", "create", `cleanup-${project}`],
      secrets: [...composeSecrets, serviceKey],
    });
    assert.equal(helperNamespace.status, "provisioning");
    namespaceIds.push(helperNamespace.id);
    await rm(serviceKeyFile);
    await assert.rejects(
      stat(serviceKeyFile),
      (error) => error instanceof Error && error.code === "ENOENT",
      "temporary local service-key copy must be removed before TUI attachment",
    );

    const request = apiClient(baseUrl, serviceKey);

    const installation = await request("GET", "/installation");
    assert.equal(installation.status, 200, JSON.stringify(installation.error));
    assert.equal(installation.data.name, env.OPENCLAW_DEV_INSTALLATION_NAME);
    assert.equal(installation.data.id, serviceKeyOutput.meta.installationId);

    // Preserve development admission boundaries against the real Compose API listener.
    const unauthenticated = await request(
      "POST",
      "/namespaces",
      { name: `denied-unauthenticated-${project}` },
      { serviceKey: false },
    );
    assert.equal(unauthenticated.status, 401, JSON.stringify(unauthenticated));
    const invalidKey = `occ_invalid_${randomUUID()}`;
    const invalid = await request(
      "POST",
      "/namespaces",
      { name: `denied-invalid-key-${project}` },
      { serviceKey: invalidKey },
    );
    assert.equal(invalid.status, 401, JSON.stringify(invalid));
    assertNoSecretMaterial(invalid, [serviceKey], "invalid-key denial must not leak the valid key");
    const forwarded = await request(
      "POST",
      "/namespaces",
      { name: `denied-forwarded-${project}` },
      { headers: { forwarded: "for=203.0.113.10;proto=https;host=attacker.invalid" } },
    );
    assert.equal(forwarded.status, 403, JSON.stringify(forwarded));

    const namespaces = [];
    for (const label of executionModes) {
      const created = await request("POST", "/namespaces", {
        name: `${label}-${project}`,
      });
      assert.equal(
        created.status,
        201,
        `bootstrap service-key namespace mutation must succeed: ${JSON.stringify(created.error)}`,
      );
      namespaceIds.push(created.data.id);
      namespaces.push(created.data);
    }
    // The CLI emits the Namespace itself; HTTP responses retain the data envelope.
    namespaces.push(helperNamespace);
    await Promise.all(
      namespaces.map((namespace) =>
        waitFor(`Namespace ${namespace.id} to become ready`, async () => {
          const current = await request("GET", `/namespaces/${namespace.id}`);
          assert.equal(current.status, 200, JSON.stringify(current.error));
          return current.data.status === "ready" ? current.data : undefined;
        }),
      ),
    );
    const embeddedNamespace = namespaces.find((namespace) =>
      namespace.name.startsWith("embedded-"),
    );
    const dedicatedNamespace = namespaces.find((namespace) =>
      namespace.name.startsWith("dedicated-"),
    );
    const cleanupNamespace = helperNamespace;
    assert.ok(embeddedNamespace, "embedded Namespace must be provisioned");
    assert.ok(dedicatedNamespace, "dedicated Namespace must be provisioned");
    const embeddedNetwork = await waitForNamespaceNetwork(embeddedNamespace.id);
    const dedicatedNetwork = await waitForNamespaceNetwork(dedicatedNamespace.id);
    const cleanupNetwork = await waitForNamespaceNetwork(cleanupNamespace.id);
    assert.equal(
      new Set([embeddedNetwork, dedicatedNetwork, cleanupNetwork].map(inspectedNetworkName)).size,
      namespaces.length,
      "each Namespace must receive a dedicated Docker network",
    );
    for (const namespace of namespaces) {
      assert.equal(
        await containerCount([[LABEL_NAMESPACE, namespace.id]]),
        0,
        "Namespace provisioning must not start Agent-owned containers",
      );
    }

    const embedded = await createAgentJourney({
      request,
      namespaceId: embeddedNamespace.id,
      mode: "embedded",
      label: "embedded",
    });
    let survivingCodexId;
    const dedicated = await createAgentJourney({
      request,
      namespaceId: dedicatedNamespace.id,
      mode: "dedicated",
      label: "dedicated",
      afterAdmission: async (agent, revision) => {
        survivingCodexId = await interruptDedicatedPreparation(
          project,
          dedicatedNamespace.id,
          agent.id,
          revision.id,
        );
      },
    }).catch(async (error) => {
      const logs = await composeFailureLogs(
        project,
        env,
        [providerKey, adminPassword, serviceKey],
        composeOptions,
      );
      throw new Error(`${error.message}\n${logs}`, { cause: error });
    });

    // Scrape the real API/worker processes after the regular Agent deployment
    // workflow. Loopback metrics remain private inside each container.
    const scrape = async (service) => {
      const container = await composeServiceContainer(project, service);
      const { stdout } = await docker([
        "exec",
        container.Id,
        "node",
        "-e",
        "fetch('http://127.0.0.1:9464/metrics').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))",
      ]);
      return stdout;
    };
    const workerMetrics = await scrape("worker");
    assert.match(
      workerMetrics,
      new RegExp(
        `occ_agents\\{[^\\n]*lifecycle_state="running"[^\\n]*\\} ${executionModes.length}(?:\\n|$)`,
      ),
    );
    assert.match(
      workerMetrics,
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="deploy"/,
    );
    assert.match(workerMetrics, /occ_work_oldest_pending_age_seconds/);
    assert.match(workerMetrics, /occ_reconciliation_attempts_total\{[^\n]*outcome="success"/);
    assert.match(await scrape("controller"), /occ_http_request_duration_seconds_bucket/);

    await assertRuntimeDatabaseEvidence({
      project,
      env,
      serviceKeyOutput,
      serviceKey,
      namespaceIds,
      revisionIds: [embedded.revision.id, dedicated.revision.id],
    });

    const [embeddedGateway] = await waitForContainers(
      [
        [LABEL_NAMESPACE, embeddedNamespace.id],
        [LABEL_AGENT, embedded.agent.id],
        [LABEL_REVISION, embedded.revision.id],
        [LABEL_ROLE, "gateway"],
      ],
      1,
      "embedded OpenClaw gateway container",
    );
    assert.ok(
      hasContainerEnv(embeddedGateway, "OPENAI_API_KEY"),
      "embedded gateway must receive the model credential",
    );
    assert.equal(
      await containerCount([
        [LABEL_NAMESPACE, embeddedNamespace.id],
        [LABEL_AGENT, embedded.agent.id],
        [LABEL_ROLE, "agent"],
      ]),
      0,
      "embedded execution must not start a separate Codex container",
    );

    const embeddedPassword = nonempty(
      containerEnv(embeddedGateway, "OPENCLAW_GATEWAY_PASSWORD"),
      "embedded gateway password",
    );

    const dedicatedGateway = (
      await waitForContainers(
        [
          [LABEL_NAMESPACE, dedicatedNamespace.id],
          [LABEL_AGENT, dedicated.agent.id],
          [LABEL_REVISION, dedicated.revision.id],
          [LABEL_ROLE, "gateway"],
        ],
        1,
        "dedicated gateway container",
      )
    )[0];
    const dedicatedAgent = (
      await waitForContainers(
        [
          [LABEL_NAMESPACE, dedicatedNamespace.id],
          [LABEL_AGENT, dedicated.agent.id],
          [LABEL_REVISION, dedicated.revision.id],
          [LABEL_ROLE, "agent"],
        ],
        1,
        "dedicated Codex app-server container",
      )
    )[0];
    assert.ok(
      !hasContainerEnv(dedicatedGateway, "OPENAI_API_KEY"),
      "dedicated gateway must not receive the model credential",
    );
    assert.ok(
      hasContainerEnv(dedicatedAgent, "OPENAI_API_KEY"),
      "dedicated Codex app-server must receive the model credential",
    );
    assert.ok(
      hasContainerEnv(dedicatedGateway, "APP_SERVER_URL") &&
        hasContainerEnv(dedicatedGateway, "APP_SERVER_TOKEN"),
      "dedicated gateway must receive only authenticated app-server transport",
    );
    assert.ok(
      hasContainerEnv(dedicatedAgent, "APP_SERVER_TOKEN"),
      "dedicated Codex app-server must receive the matching app-server token",
    );
    assert.equal(
      dedicatedAgent.Id,
      survivingCodexId,
      "recovery must reuse the surviving Codex container",
    );
    assert.equal(
      containerEnv(dedicatedGateway, "APP_SERVER_TOKEN") ===
        containerEnv(dedicatedAgent, "APP_SERVER_TOKEN"),
      true,
      "recovered gateway and surviving Codex must share a transport token",
    );
    assertNamespaceOnlyAttachment(dedicatedAgent, inspectedNetworkName(dedicatedNetwork));
    assertDockerRuntimeOtelSettings(otelLogs, [embeddedGateway, dedicatedGateway, dedicatedAgent]);
    const dedicatedPassword = nonempty(
      containerEnv(dedicatedGateway, "OPENCLAW_GATEWAY_PASSWORD"),
      "dedicated gateway password",
    );

    await invokeGateway({
      networkName: inspectedNetworkName(dedicatedNetwork),
      gateway: dedicatedGateway,
      gatewayPassword: dedicatedPassword,
      mode: "dedicated",
      onFailure: () => containerLogs([dedicatedGateway, dedicatedAgent], [dedicatedPassword]),
    });
    if (podmanSelected) {
      await invokeGateway({
        networkName: inspectedNetworkName(embeddedNetwork),
        gateway: embeddedGateway,
        gatewayPassword: embeddedPassword,
        mode: "embedded",
        onFailure: () => containerLogs([embeddedGateway], [embeddedPassword]),
      });
      // Exercise the supported controller cleanup path without inventing Agent deletion semantics.
      await deleteEmptyNamespace({ request, cleanupNamespace });
      assert.equal((await inspectNetworks(embeddedNamespace.id)).length, 1);
      assert.equal(
        await containerCount([
          [LABEL_NAMESPACE, embeddedNamespace.id],
          [LABEL_ROLE, "gateway"],
        ]),
        1,
      );
      const stopped = await request(
        "POST",
        `/namespaces/${embeddedNamespace.id}/agents/${embedded.agent.id}/stop`,
      );
      assert.equal(stopped.status, 202, JSON.stringify(stopped.error));
      await waitFor("stopped Agent and completed stop metrics", async () => {
        const current = await request(
          "GET",
          `/namespaces/${embeddedNamespace.id}/agents/${embedded.agent.id}`,
        );
        if (current.data.activeRevisionId !== undefined) {
          return false;
        }
        const body = await scrape("worker");
        return (
          /occ_agents\{[^\n]*lifecycle_state="stopped"[^\n]*\} 1(?:\n|$)/.test(body) &&
          /occ_agent_operation_duration_seconds_count\{[^\n]*operation="stop"[^\n]*\} 1(?:\n|$)/.test(
            body,
          )
        );
      });
      assert.equal(
        await containerCount([[LABEL_AGENT, embedded.agent.id]]),
        0,
        "supported stop must remove the Agent workload before reporting completion",
      );
      await assertComposeLogsDoNotLeakBootstrapServiceKey({ project, env, serviceKey });
      return;
    }

    await assertInvalidPasswordTuiDenied({
      context,
      gateway: embeddedGateway,
      gatewayPassword: embeddedPassword,
      onFailure: () => containerLogs([embeddedGateway], [embeddedPassword]),
    });
    const [tuiGateway] = await waitForContainers(
      [
        [LABEL_NAMESPACE, embeddedNamespace.id],
        [LABEL_AGENT, embedded.agent.id],
        [LABEL_REVISION, embedded.revision.id],
        [LABEL_ROLE, "gateway"],
      ],
      1,
      "embedded OpenClaw gateway container before TUI attach",
    );
    await assertInteractiveTuiConversation({
      context,
      gateway: tuiGateway,
      gatewayPassword: embeddedPassword,
      onFailure: () => containerLogs([tuiGateway], [embeddedPassword]),
    });
    await invokeGateway({
      networkName: inspectedNetworkName(embeddedNetwork),
      gateway: embeddedGateway,
      gatewayPassword: embeddedPassword,
      mode: "embedded",
      onFailure: () => containerLogs([embeddedGateway], [embeddedPassword]),
    });
    await otelLogs.assertRecords({
      forbidden: [providerKey, adminPassword, serviceKey, embeddedPassword, dedicatedPassword],
      expected: [
        {
          label: "bootstrap service-key creation",
          serviceName: "occ-api",
          resource: {
            [OTEL_RESOURCE.serviceInstanceId]: project,
          },
          attributes: { "event.name": "installation.bootstrapped" },
          body: "installation.bootstrapped",
        },
        {
          label: "OCC API successful request completion",
          serviceName: "occ-api",
          resource: {
            [OTEL_RESOURCE.serviceInstanceId]: project,
          },
          attributes: {
            "event.name": "http.completed",
            "http.request.method": "GET",
            "http.response.status_code": 200,
          },
          body: "http.completed",
        },
        {
          label: "worker embedded revision completion",
          serviceName: "occ-worker",
          resource: {
            [OTEL_RESOURCE.serviceInstanceId]: project,
          },
          attributes: {
            "event.name": "worker.completed",
            "occ.namespace.id": embeddedNamespace.id,
            "occ.agent.id": embedded.agent.id,
            "occ.revision.id": embedded.revision.id,
            "work.outcome": "success",
          },
          body: "worker.completed",
        },
        {
          label: "worker dedicated revision completion",
          serviceName: "occ-worker",
          resource: {
            [OTEL_RESOURCE.serviceInstanceId]: project,
          },
          attributes: {
            "event.name": "worker.completed",
            "occ.namespace.id": dedicatedNamespace.id,
            "occ.agent.id": dedicated.agent.id,
            "occ.revision.id": dedicated.revision.id,
            "work.outcome": "success",
          },
          body: "worker.completed",
        },
        {
          label: "embedded gateway operational record",
          serviceName: "openclaw-gateway",
          resource: {
            [OTEL_RESOURCE.namespaceId]: embeddedNamespace.id,
            [OTEL_RESOURCE.agentId]: embedded.agent.id,
            [OTEL_RESOURCE.revisionId]: embedded.revision.id,
          },
          attributes: { "event.name": "gateway.operational" },
          body: "gateway.operational",
        },
        {
          label: "dedicated gateway operational record",
          serviceName: "openclaw-gateway",
          resource: {
            [OTEL_RESOURCE.namespaceId]: dedicatedNamespace.id,
            [OTEL_RESOURCE.agentId]: dedicated.agent.id,
            [OTEL_RESOURCE.revisionId]: dedicated.revision.id,
          },
          attributes: { "event.name": "gateway.operational" },
          body: "gateway.operational",
        },
        {
          label: "dedicated Codex app-server operational record",
          serviceName: "codex-app-server",
          resource: {
            [OTEL_RESOURCE.namespaceId]: dedicatedNamespace.id,
            [OTEL_RESOURCE.agentId]: dedicated.agent.id,
            [OTEL_RESOURCE.revisionId]: dedicated.revision.id,
          },
          attributes: { "event.name": "codex.operational" },
        },
      ],
    });

    if (otelLogs.enabled) {
      await assertCollectorOutageDoesNotBlockDockerOperations({
        project,
        env,
        composeOptions,
        request,
        cleanupNamespace,
        secrets: [providerKey, adminPassword, serviceKey],
      });
    } else {
      await deleteEmptyNamespace({ request, cleanupNamespace });
    }
    assert.equal((await inspectNetworks(embeddedNamespace.id)).length, 1);
    assert.equal(
      await containerCount([
        [LABEL_NAMESPACE, embeddedNamespace.id],
        [LABEL_ROLE, "gateway"],
      ]),
      1,
    );
    assert.equal((await inspectNetworks(dedicatedNamespace.id)).length, 1);
    assert.equal(
      await containerCount([
        [LABEL_NAMESPACE, dedicatedNamespace.id],
        [LABEL_ROLE, "gateway"],
      ]),
      1,
    );
    await assertComposeLogsDoNotLeakBootstrapServiceKey({ project, env, serviceKey });
  },
);

for (const setupMode of executionModes) {
  test(
    `Docker ${setupMode} workspace setup guards first runtime and preserves files across container replacement`,
    {
      skip:
        selected && !podmanSelected
          ? false
          : "Select the real Docker Compute suite with pinned runtime images.",
      timeout: 300_000,
    },
    async (context) => {
      // This is real Docker Driver evidence; the Compose Agent workflow above remains
      // the separate proof of OCC admission, authorization, and worker delivery.
      const runtimeImage = process.env.OCC_DOCKER_RUNTIME_IMAGE ?? DEFAULT_RUNTIME_IMAGE;
      const driver = new DockerComputeDriver({
        images: {
          gateway: process.env.OCC_DOCKER_GATEWAY_IMAGE ?? runtimeImage,
          agent: process.env.OCC_DOCKER_AGENT_IMAGE ?? runtimeImage,
        },
      });
      const namespace = {
        id: `ns-workspace-${randomUUID()}`,
        name: "Workspace setup proof",
        status: "ready",
        createdAt: new Date().toISOString(),
      };
      const agentId = `agent-workspace-${randomUUID()}`;
      const revision = {
        id: `rev-workspace-${randomUUID()}`,
        namespaceId: namespace.id,
        agentId,
        revision: 1,
        configurationId: `cfg-workspace-${randomUUID()}`,
        configurationKind: "agent",
        configurationGeneration: 1,
        configuration: admitLoggingConfiguration(
          createHarnessConfiguration(
            setupMode === "embedded" ? "openclaw" : "codex",
            providerModel,
          ),
          "info",
        ),
        harness: {
          id: setupMode === "embedded" ? "openclaw" : "codex",
          version: "2026.9.1",
          mode: setupMode,
        },
        compute: { id: driver.id, implementation: driver.implementation },
        servicePrincipalId: `sp-workspace-${randomUUID()}`,
        createdAt: namespace.createdAt,
      };
      const setup = {
        id: `setup-${randomUUID()}`,
        namespaceId: namespace.id,
        agentId,
        completed: false,
        files: {
          "AGENTS.md":
            "# Initial workspace instructions\nPreserve this content before first use.\n",
          "SOUL.md": "",
          "IDENTITY.md": "# Identity\n- **Name:** Workspace proof\n",
          "USER.md": "# User\n- **Name:** Integration operator\n",
        },
      };
      const binding = { namespace, agent: { id: agentId, namespaceId: namespace.id } };
      context.after(async () => {
        const result = await driver.deleteNamespace(namespace);
        assert.equal(
          result.namespaceDeleted,
          true,
          "owned containers, volumes, and network must be removed",
        );
      });
      await driver.preflight();
      assert.equal((await driver.ensureNamespace(namespace)).namespaceReady, true);
      assert.equal((await driver.prepareRevision(revision, { workspaceSetup: setup })).ready, true);
      const filters = [
        [LABEL_NAMESPACE, namespace.id],
        [LABEL_AGENT, agentId],
        [LABEL_ROLE, "gateway"],
      ];
      let [gateway] = await waitForContainers(filters, 1, "initialized gateway");
      const workspace = "/home/node/.openclaw/workspace";
      const readFiles = async () => {
        const { stdout } = await docker([
          "exec",
          gateway.Id,
          "node",
          "-e",
          `const fs=require('node:fs'); console.log(JSON.stringify(Object.fromEntries(['AGENTS.md','SOUL.md','IDENTITY.md','USER.md'].map(n=>[n,fs.readFileSync(${JSON.stringify(workspace)}+'/'+n,'utf8')]))));`,
        ]);
        return JSON.parse(stdout);
      };
      assert.deepEqual(await readFiles(), setup.files);
      if (setupMode === "dedicated") {
        const [harness] = await waitForContainers(
          [
            [LABEL_NAMESPACE, namespace.id],
            [LABEL_AGENT, agentId],
            [LABEL_ROLE, "agent"],
          ],
          1,
          "initialized Harness",
        );
        const { stdout } = await docker([
          "exec",
          harness.Id,
          "node",
          "-e",
          "const fs=require('node:fs'); const pid=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).find(p=>{try{return fs.readFileSync('/proc/'+p+'/comm','utf8').trim()==='codex'}catch{return false}}); if(!pid)throw Error('native Codex process missing'); const cwd=fs.readlinkSync('/proc/'+pid+'/cwd'); console.log(JSON.stringify({cwd,files:Object.fromEntries(['AGENTS.md','SOUL.md','IDENTITY.md','USER.md'].map(n=>[n,fs.readFileSync(cwd+'/'+n,'utf8')]))}));",
        ]);
        const observed = JSON.parse(stdout);
        assert.equal(observed.cwd, "/home/node/workspace");
        assert.deepEqual(
          observed.files,
          setup.files,
          "actual Harness cwd must contain the initialized native workspace",
        );
      }
      assert.equal(
        JSON.stringify(gateway.Config).includes(setup.files["AGENTS.md"]),
        false,
        "initial documents must not leak into container configuration",
      );
      assert.equal(
        await containerCount([
          [LABEL_NAMESPACE, namespace.id],
          [LABEL_ROLE, "workspace-setup"],
        ]),
        0,
        "private initializer container must be removed",
      );
      // A genuine filesystem edit stands in for a later workspace owner; this does not
      // claim native gateway RPC or HTTP authorization proof.
      await docker([
        "exec",
        gateway.Id,
        "node",
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(workspace + "/AGENTS.md")},'later workspace edit\\n')`,
      ]);
      await driver.stopRevision(revision);
      const nextRevision = { ...revision, id: revision.id + "-next", revision: 2 };
      const completed = { ...setup, completed: true };
      delete completed.files;
      assert.equal(
        (await driver.prepareRevision(nextRevision, { workspaceSetup: completed })).ready,
        true,
      );
      [gateway] = await waitForContainers(filters, 1, "replacement gateway");
      assert.equal((await readFiles())["AGENTS.md"], "later workspace edit\n");
      assert.equal(
        (await driver.prepareRevision(nextRevision, { workspaceSetup: setup })).ready,
        true,
      );
      assert.equal(
        (await readFiles())["AGENTS.md"],
        "later workspace edit\n",
        "lost completion acknowledgement cannot replay initial contents",
      );
      await driver.stopRevision(nextRevision);
      await assert.rejects(
        driver.prepareRevision(nextRevision, {
          workspaceSetup: { ...completed, id: completed.id + "-wrong" },
        }),
        /Workspace initialization failed/,
      );
      assert.equal(
        await containerCount(filters),
        0,
        "a mismatched marker must block runtime start",
      );
      assert.equal(
        (await driver.prepareRevision(nextRevision, { workspaceSetup: completed })).ready,
        true,
      );
      [gateway] = await waitForContainers(filters, 1, "gateway for direct restart");
      await docker([
        "exec",
        gateway.Id,
        "node",
        "-e",
        `require('node:fs').unlinkSync(${JSON.stringify(workspace + "/.oce-workspace-setup.json")})`,
      ]);
      // Restart the already-created gateway to exercise its command guard, not Compute reconciliation.
      await docker(["restart", gateway.Id]);
      await waitFor("restart to fail closed after marker loss", async () => {
        const [current] = await dockerJson(["inspect", gateway.Id]);
        return current.State.Running === false && current.State.ExitCode !== 0;
      });
      if (setupMode === "dedicated") {
        const [harness] = await waitForContainers(
          [
            [LABEL_NAMESPACE, namespace.id],
            [LABEL_AGENT, agentId],
            [LABEL_ROLE, "agent"],
          ],
          1,
          "Harness for direct restart",
        );
        await docker(["restart", harness.Id]);
        await waitFor("Harness restart to fail closed after marker loss", async () => {
          const [current] = await dockerJson(["inspect", harness.Id]);
          return current.State.Running === false && current.State.ExitCode !== 0;
        });
      }
      await driver.stopRevision(nextRevision);
      await driver.deleteAgentRuntimeCredentials(binding);
      await assert.rejects(
        driver.prepareRevision(nextRevision, { workspaceSetup: completed }),
        /storage is missing/,
      );
    },
  );
}
