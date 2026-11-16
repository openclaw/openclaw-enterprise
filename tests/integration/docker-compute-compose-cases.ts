import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";

import {
  AgentReadResponse,
  AgentResponse,
  ConfigurationResponse,
  ErrorResponse,
  InstallationResponse,
  InstallationSchema,
  JsonValue,
  NamespaceListResponse,
  NamespaceResponse,
  NamespaceSchema,
  PluginApproversSchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
  type ErrorCode,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { availablePort } from "../helpers/available-port.ts";
import { selectComposeSubnet } from "../helpers/compose-network.ts";
import { browserEnvironment } from "../helpers/compose.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createOtelLogObservation, OTEL_RESOURCE } from "../helpers/logging-otel-observation.ts";
import { assertDockerRuntimeOtelSettings } from "../helpers/logging-otel-runtime-settings.ts";
import {
  command,
  containerCount,
  docker,
  dockerJson,
  dockerLines,
  engineBinary,
  engineName,
  executionModes,
  inspectedObjects,
  labelFilters,
  LABEL_NAMESPACE,
  managedNamespaceLabels,
  nonempty,
  parseJson,
  podmanSelected,
  providerModel,
  runtimeImages,
  sanitize,
  waitFor,
} from "./docker-compute-test-engine.ts";

const COMPOSE_FILE = "compose.yaml";
const LOGGING_COMPOSE_FILE = "compose.logging.yaml";
const PODMAN_COMPOSE_FILE = "compose.podman.yaml";
const INTERNAL_API_PORT = "3000";
const LABEL_COMPOSE_PROJECT = podmanSelected
  ? "io.podman.compose.project"
  : "com.docker.compose.project";
const LABEL_COMPOSE_SERVICE = podmanSelected
  ? "io.podman.compose.service"
  : "com.docker.compose.service";

interface ComposeOptions {
  withLogging?: boolean;
  removeApplicationImages?: boolean;
}

type ExecutionMode = (typeof executionModes)[number];

const responseSchemas = {
  SafeJsonValue: JsonValue,
  PluginApprovers: PluginApproversSchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginDesiredState: PluginDesiredStateSchema,
  PluginDriverIdentity: PluginDriverIdentitySchema,
  PluginToolDefaults: PluginToolDefaultsSchema,
  PluginToolPolicy: PluginToolPolicySchema,
};

function checked<S extends TSchema>(
  schema: S,
  value: unknown,
  description: string,
): Static<S, typeof responseSchemas> {
  assert.ok(
    Check(responseSchemas, schema, value),
    `${description} did not match the expected contract.`,
  );
  return value;
}

async function composeSubnet(env: NodeJS.ProcessEnv): Promise<string> {
  if (podmanSelected) {
    const octet = 16 + (Number.parseInt(randomUUID().slice(0, 2), 16) % 64);
    return `172.30.${octet}.0/24`;
  }
  return selectComposeSubnet({
    runDocker: async (args) => (await docker(args, { env })).stdout,
  });
}

function composeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...browserEnvironment,
    // Keep Docker Compose's project image tags deterministic for teardown.
    COMPOSE_COMPATIBILITY: "0",
    // No Agent can deploy on Docker Compute, so these cases need no model credential.
    OPENAI_API_KEY: "",
    OPENAI_API_KEY_FILE: undefined,
    CODEX_ACCESS_TOKEN: undefined,
    CODEX_ACCESS_TOKEN_FILE: undefined,
  };
}

function throwCleanupFailures(
  results: readonly PromiseSettledResult<unknown>[],
  description: string,
): void {
  const failures = results.flatMap((result) => {
    if (result.status === "fulfilled") {
      return [];
    }
    const reason: unknown = result.reason;
    return [reason];
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, description);
  }
}

async function buildCli(context: TestContext) {
  const owned: { directory?: string; teardownProject?: () => Promise<void> } = {};
  context.after(async () => {
    // Keep file cleanup independent of Compose teardown, even if inventory fails.
    const results = await Promise.allSettled([owned.teardownProject?.()]);
    if (owned.directory !== undefined) {
      results.push(
        ...(await Promise.allSettled([rm(owned.directory, { recursive: true, force: true })])),
      );
    }
    throwCleanupFailures(results, "Compose test teardown failed.");
  });
  const directory = await mkdtemp(join(tmpdir(), `openclaw-${engineBinary}-compose-test-`));
  owned.directory = directory;
  const binary = join(directory, "occ");
  await command("go", ["build", "-trimpath", "-o", binary, "./cmd/occ"]);
  // Prepare inputs before Compose evaluates even a postgres-only command.
  const adminPassword = `${engineBinary}-admin-${randomUUID()}`;
  const serviceKey = `occ_${randomBytes(32).toString("base64url")}`;
  const bootstrapInputs = {
    OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE: join(directory, "admin-password-input"),
    OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE: join(directory, "admin-service-key-input"),
  };
  await writeFile(bootstrapInputs.OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE, adminPassword, {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(bootstrapInputs.OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE, serviceKey, {
    mode: 0o600,
    flag: "wx",
  });
  return { binary, directory, owned, bootstrapInputs, adminPassword, serviceKey };
}

function assertNoSecretMaterial(value: unknown, secrets: readonly string[], description: string) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    assert.equal(serialized.includes(secret), false, description);
  }
}

function composeArguments(
  project: string,
  commandName: string,
  args: readonly string[] = [],
  { withLogging = false }: ComposeOptions = {},
) {
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

async function composeProjectGatewayPasswords(project: string, env: NodeJS.ProcessEnv) {
  const ids = await dockerLines(
    ["ps", "-aq", ...labelFilters([[LABEL_COMPOSE_PROJECT, project]])],
    { env },
  );
  if (ids.length === 0) {
    return [];
  }
  // Skip raw log collection if inspection fails and the extra redaction values are unknown.
  const inspected = inspectedObjects(
    await dockerJson(["inspect", ...ids], { env }),
    "Container inspection",
  );
  return inspected.flatMap((container) => {
    const environment = asRecord(container.Config)?.Env;
    assert.ok(
      Array.isArray(environment),
      "Container inspection must include environment variables.",
    );
    const entries: readonly unknown[] = environment;
    return entries
      .map((entry) => nonempty(entry, "Container environment entry"))
      .filter(
        (entry) =>
          entry.startsWith("OPENCLAW_GATEWAY_PASSWORD=") || entry.startsWith("GATEWAY_PASSWORD="),
      )
      .map((entry) => entry.slice(entry.indexOf("=") + 1))
      .filter(Boolean);
  });
}

async function composeFailureLogs(
  project: string,
  env: NodeJS.ProcessEnv,
  secrets: readonly string[],
  options: ComposeOptions,
) {
  let discoveredSecrets: readonly string[];
  try {
    discoveredSecrets = [...secrets, ...(await composeProjectGatewayPasswords(project, env))];
  } catch {
    return "Could not establish log redaction values from the Compose project.";
  }
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

async function cleanupProject(
  project: string,
  env: NodeJS.ProcessEnv,
  namespaceIds: ReadonlySet<string>,
  options: ComposeOptions = {},
  secrets: readonly string[] = [],
) {
  const commandOptions = { env, secrets };
  const projectLabels = labelFilters([[LABEL_COMPOSE_PROJECT, project]]);
  const applicationServices = podmanSelected
    ? ["application"]
    : ["bootstrap", "controller", "migrate", "worker"];
  const imageTags = options.removeApplicationImages
    ? applicationServices.map((service) => `${project}-${service}:latest`)
    : [];
  const scopes = [
    { name: "Compose project", labels: projectLabels },
    ...[...namespaceIds].map((namespaceId) => ({
      name: `Namespace ${namespaceId}`,
      labels: labelFilters(managedNamespaceLabels(namespaceId)),
    })),
  ];
  const resources = [
    { kind: "containers", list: ["ps", "-aq"], remove: ["rm", "-f"] },
    { kind: "networks", list: ["network", "ls", "-q"], remove: ["network", "rm"] },
    { kind: "volumes", list: ["volume", "ls", "-q"], remove: ["volume", "rm"] },
  ].flatMap(({ kind, list, remove }) =>
    scopes.map(({ name, labels }) => ({
      name: `${name} ${kind}`,
      list: [...list, ...labels],
      remove,
    })),
  );
  // Compose can fail partway through teardown. Fall back to deleting only IDs or
  // volume names inventory tied to the exact run labels. Verification is authoritative.
  await docker(
    composeArguments(project, "down", ["--volumes", "--remove-orphans"], options),
    commandOptions,
  ).catch(() => {});
  for (const { list, remove } of resources) {
    const ids = await dockerLines(list, commandOptions).catch(() => []);
    if (ids.length > 0) {
      await docker([...remove, ...ids], commandOptions).catch(() => {});
    }
  }
  for (const tag of imageTags) {
    await docker(["image", "rm", tag], commandOptions).catch(() => {});
  }
  const checks = resources.map(async ({ name, list }) => {
    const remaining = await dockerLines(list, commandOptions);
    assert.deepEqual(remaining, [], `test teardown must remove owned ${name}`);
  });
  checks.push(
    ...imageTags.map(async (tag) => {
      const remaining = await dockerLines(
        ["image", "ls", "-q", "--filter", `reference=${tag}`],
        commandOptions,
      );
      assert.deepEqual(remaining, [], `test teardown must remove the run-owned image ${tag}`);
    }),
  );
  throwCleanupFailures(await Promise.allSettled(checks), "Compose project inventory is not clean.");
}

async function composeServiceContainer(project: string, service: string, env: NodeJS.ProcessEnv) {
  const ids = await dockerLines(
    [
      "ps",
      "-aq",
      ...labelFilters([
        [LABEL_COMPOSE_PROJECT, project],
        [LABEL_COMPOSE_SERVICE, service],
      ]),
    ],
    { env },
  );
  const id = ids[0];
  assert.ok(id && ids.length === 1, `Compose service ${service} must have exactly one container`);
  const [container, ...others] = inspectedObjects(
    await dockerJson(["inspect", id], { env }),
    "Container inspection",
  );
  assert.ok(container && others.length === 0, "Container inspect must return exactly one object");
  return { id: nonempty(container.Id, "Container ID"), observation: container };
}

function hasMountDestination(container: Record<string, unknown>, destination: string): boolean {
  const mounts = inspectedObjects(container.Mounts, "Container inspect mounts");
  const destinations = mounts.map((mount) => nonempty(mount.Destination, "Mount destination"));
  return destinations.includes(destination);
}

interface RequestOptions {
  serviceKey?: string | false;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

function apiClient(baseUrl: string, serviceKey: string) {
  return async function request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: Readonly<Record<string, unknown>>,
    options: RequestOptions = {},
  ) {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        ...(options.serviceKey === false
          ? {}
          : { "x-api-key": nonempty(options.serviceKey ?? serviceKey, "OCC service key") }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text.length === 0 ? undefined : parseJson(text, "OCC API"),
    };
  };
}

type Request = ReturnType<typeof apiClient>;
type ApiResponse = Awaited<ReturnType<Request>>;

function success<S extends TSchema>(
  response: ApiResponse,
  status: number,
  schema: S,
): Static<S, typeof responseSchemas> {
  assert.equal(response.status, status, "Expected successful OCC API response");
  return checked(schema, response.body, "OCC API");
}

function refusal(response: ApiResponse, status: number, code: ErrorCode, description: string) {
  assert.equal(response.status, status, description);
  const { error } = checked(ErrorResponse, response.body, "OCC API refusal");
  assert.equal(error.code, code, description);
  return error;
}

async function prepareLocalServiceKey({
  project,
  env,
  directory,
  baseUrl,
  serviceKey,
}: {
  project: string;
  env: NodeJS.ProcessEnv;
  directory: string;
  baseUrl: string;
  serviceKey: string;
}) {
  const inputPaths = ["/run/secrets/admin-password", "/run/secrets/admin-service-key"];
  const bootstrap = await composeServiceContainer(project, "bootstrap", env);
  const bootstrapMounts = inspectedObjects(bootstrap.observation.Mounts, "Bootstrap mounts");
  for (const path of inputPaths) {
    const mount = bootstrapMounts.find((mount) => mount.Destination === path);
    assert.ok(mount, "bootstrap must mount each credential input");
    assert.equal(mount.RW, false, "bootstrap credential inputs must be read-only");
  }
  for (const service of ["bootstrap", "migrate", "controller", "worker"]) {
    const { observation } = await composeServiceContainer(project, service, env);
    assert.equal(hasMountDestination(observation, "/var/lib/openclaw/bootstrap"), false);
    if (service !== "bootstrap") {
      for (const path of inputPaths) {
        assert.equal(hasMountDestination(observation, path), false);
      }
    }
  }
  // The local file carries only the precreated key, not invented issuance metadata.
  const localFile = join(directory, "admin-service-key.json");
  await writeFile(localFile, JSON.stringify({ data: { key: serviceKey } }), {
    mode: 0o600,
    flag: "wx",
  });
  assert.equal((await stat(localFile)).mode & 0o777, 0o600);
  const installation = success(
    await apiClient(baseUrl, serviceKey)("GET", "/installation"),
    200,
    InstallationResponse,
  );
  const principal = asRecord(
    await postgresJson(
      project,
      env,
      "SELECT json_build_object('id', reference_id)::text FROM occ.apikey WHERE name = 'bootstrap-admin'",
      [serviceKey],
    ),
  );
  const servicePrincipalId = nonempty(principal?.id, "Bootstrap ServicePrincipal ID");
  return { localFile, installationId: installation.data.id, servicePrincipalId };
}

async function runOcc({
  binary,
  baseUrl,
  serviceKeyFile,
  args,
  secrets,
}: {
  binary: string;
  baseUrl: string;
  serviceKeyFile: string;
  args: readonly string[];
  secrets: readonly string[];
}): Promise<unknown> {
  const { stdout } = await command(binary, [...args, "--output", "json"], {
    env: {
      ...composeEnvironment(),
      OCC_URL: baseUrl,
      OCC_SERVICE_KEY_FILE: serviceKeyFile,
    },
    timeoutMs: 60_000,
    secrets,
  });
  return parseJson(stdout, "OCC CLI");
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function postgresJson(
  project: string,
  env: NodeJS.ProcessEnv,
  sql: string,
  secrets: readonly string[],
) {
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
  return parseJson(stdout, "PostgreSQL evidence");
}

async function assertLifecycleDatabaseEvidence({
  project,
  env,
  bootstrapServicePrincipalId,
  serviceKey,
  namespaceIds,
  agentIds,
}: {
  project: string;
  env: NodeJS.ProcessEnv;
  bootstrapServicePrincipalId: string;
  serviceKey: string;
  namespaceIds: readonly string[];
  agentIds: readonly string[];
}) {
  const namespaceArray = namespaceIds.map(sqlLiteral).join(", ");
  const agentArray = agentIds.map(sqlLiteral).join(", ");
  const servicePrincipalId = sqlLiteral(bootstrapServicePrincipalId);
  // One Configuration and one Agent per refused deployment; no deploy succeeds.
  const expectedOperatorMutationAudits = namespaceIds.length + agentIds.length * 2;
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
      'agentRevisions', (
        SELECT count(*)::integer
        FROM occ.agent_revisions
        WHERE agent_id IN (${agentArray})
      ),
      'agentWork', (
        SELECT count(*)::integer
        FROM occ.controller_work
        WHERE agent_id IN (${agentArray})
      ),
      'unfinishedLifecycleWork', (
        SELECT count(*)::integer
        FROM occ.controller_work
        WHERE namespace_id IN (${namespaceArray})
          AND state <> 'succeeded'
      )
    )::text`,
    [serviceKey],
  );
  const row = asRecord(evidence);
  assert.ok(row, "PostgreSQL evidence must be a count record");
  assert.equal(
    row.operatorMutationAudits,
    expectedOperatorMutationAudits,
    "service-key operator must be the actor for Namespace, Configuration, and Agent mutations, with no successful deploy",
  );
  assert.equal(
    row.namespaceLifecycleSucceeded,
    namespaceIds.length,
    "each Namespace must complete its controller lifecycle work",
  );
  assert.equal(row.agentRevisions, 0, "a refused deployment must not admit an AgentRevision");
  assert.equal(row.agentWork, 0, "a refused deployment must not queue controller work");
  assert.equal(row.unfinishedLifecycleWork, 0, "test-owned lifecycle work must be complete");
}

async function assertComposeLogsDoNotLeakBootstrapServiceKey({
  project,
  env,
  serviceKey,
}: {
  project: string;
  env: NodeJS.ProcessEnv;
  serviceKey: string;
}) {
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

async function inspectNetworks(namespaceId: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const ids = await dockerLines(
    ["network", "ls", "-q", ...labelFilters(managedNamespaceLabels(namespaceId))],
    { env },
  );
  if (ids.length === 0) {
    return [];
  }
  const inspected = inspectedObjects(
    await dockerJson(["network", "inspect", ...ids], { env }),
    "Network inspection",
  );
  assert.equal(inspected.length, ids.length, "Inspection must return each listed network");
  return inspected.map((network) =>
    nonempty(network.Name ?? network.name, "Inspected network name"),
  );
}

function waitForNamespaceNetwork(namespaceId: string, env: NodeJS.ProcessEnv) {
  return waitFor(`${engineName} network for Namespace ${namespaceId}`, async () => {
    const names = await inspectNetworks(namespaceId, env);
    return names.length === 1 ? names[0] : undefined;
  });
}

interface NamespaceDeletion {
  request: Request;
  namespaceId: string;
  env: NodeJS.ProcessEnv;
}

async function assertCollectorOutageDoesNotBlockDockerOperations({
  project,
  env,
  composeOptions,
  request,
  namespaceId,
  secrets,
}: NamespaceDeletion & {
  project: string;
  composeOptions: ComposeOptions;
  secrets: readonly string[];
}) {
  const options = { env, timeoutMs: 60_000, secrets };
  await docker(
    composeArguments(project, "stop", ["--timeout", "10", "collector"], composeOptions),
    options,
  );
  const failures: unknown[] = [];
  try {
    const installation = await request("GET", "/installation", undefined, { timeoutMs: 5_000 });
    success(installation, 200, InstallationResponse);
    await deleteEmptyNamespace({ request, namespaceId, env }, { timeoutMs: 10_000 });
  } catch (error) {
    failures.push(error);
  }
  try {
    await docker(
      composeArguments(project, "up", ["--detach", "--no-deps", "collector"], composeOptions),
      options,
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Collector outage proof or restart failed.");
  }
}

async function deleteEmptyNamespace(
  { request, namespaceId, env }: NamespaceDeletion,
  requestOptions?: RequestOptions,
) {
  const deleted = await request("DELETE", `/namespaces/${namespaceId}`, undefined, requestOptions);
  success(deleted, 202, NamespaceResponse);
  await waitFor(`cleanup Namespace ${namespaceId} network removal`, async () => {
    return (await inspectNetworks(namespaceId, env)).length === 0 ? true : undefined;
  });
}

// Docker Compute supports no Harness authentication binding, and OCC deploys no Agent
// without one. Prove both 409s through the real API: a binding is refused where it is saved,
// and an Agent saved without one is refused at deployment. Returns the refused Agent's ID.
async function assertHarnessAuthRefusal(
  request: Request,
  namespaceId: string,
  mode: ExecutionMode,
) {
  const harnessId = mode === "dedicated" ? "codex" : "openclaw";
  const configuration = success(
    await request("POST", `/namespaces/${namespaceId}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration(harnessId, providerModel),
    }),
    201,
    ConfigurationResponse,
  );
  const agentBody = {
    configurationId: configuration.data.id,
    executionMode: mode,
  };
  const assertDriverRefusal = (response: ApiResponse, description: string) => {
    const error = refusal(response, 409, "RESOURCE_CONFLICT", description);
    assert.equal(
      error.message,
      "The selected Compute Driver cannot deliver this Harness authentication binding to the configured model and topology.",
      description,
    );
  };

  // The runtime binding needs no stored credential; the refusal comes from the Driver.
  assertDriverRefusal(
    await request("POST", `/namespaces/${namespaceId}/agents`, {
      ...agentBody,
      name: `${mode}-bound-${randomUUID()}`,
      harnessAuth: { method: "runtime" },
    }),
    `${mode} Agent create with a Harness authentication binding`,
  );

  const agent = success(
    await request("POST", `/namespaces/${namespaceId}/agents`, {
      ...agentBody,
      name: `${mode}-${randomUUID()}`,
    }),
    201,
    AgentResponse,
  );
  const agentPath = `/namespaces/${namespaceId}/agents/${agent.data.id}`;
  assertDriverRefusal(
    await request("PATCH", agentPath, {
      configurationId: configuration.data.id,
      harnessAuth: { method: "runtime" },
    }),
    `${mode} Agent update to a Harness authentication binding`,
  );

  const deploy = refusal(
    await request("POST", `${agentPath}/deploy`),
    409,
    "RESOURCE_CONFLICT",
    `${mode} deployment without a Harness authentication binding`,
  );
  assert.equal(deploy.message, "Deployment requires an explicit Harness authentication binding.");
  const current = success(await request("GET", agentPath), 200, AgentReadResponse);
  assert.ok(!("configurationReadError" in current.data), "saved Agent settings must be readable");
  assert.equal(current.data.activeRevisionId, undefined, "a refused deployment activates nothing");
  assert.equal(current.data.harnessAuth ?? null, null, "refused updates must not store a binding");
  return agent.data.id;
}

export async function composeCleanupCase(context: TestContext): Promise<void> {
  const { binary, owned, bootstrapInputs } = await buildCli(context);
  const project = `oce-cleanup-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const env: NodeJS.ProcessEnv = {
    ...composeEnvironment(),
    ...bootstrapInputs,
    COMPOSE_PROJECT_NAME: project,
    OCC_POSTGRES_PORT: String(await availablePort()),
    OCC_DEVELOPMENT_COMPUTE_DRIVER: "docker",
    OCC_DEVELOPMENT_CONTAINER_ENGINE: engineBinary,
    ...(podmanSelected ? { PODMAN_COMPOSE_PROVIDER: "podman-compose" } : {}),
  };
  if (podmanSelected) {
    const { stdout } = await docker(["info", "--format", "{{.Host.RemoteSocket.Path}}"], {
      env,
    });
    env.OCC_CONTAINER_ENGINE_SOCKET = stdout.trim().replace(/^unix:\/\//, "");
  }
  env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR = await composeSubnet(env);
  owned.teardownProject = () => cleanupProject(project, env, new Set());

  // Cleanup must work even when startup stopped after PostgreSQL, before an
  // Installation or Agent exists. Use the shipped Compose files and real engine.
  await docker(composeArguments(project, "up", ["--no-deps", "--detach", "postgres"]), {
    env,
  });
  await waitFor("development PostgreSQL readiness", async () => {
    const postgres = await composeServiceContainer(project, "postgres", env);
    const health = asRecord(asRecord(postgres.observation.State)?.Health);
    return nonempty(health?.Status, "PostgreSQL health status") === "healthy";
  });
  const composeOptions = composeArguments(project, "down").slice(1, -1);
  const cliEnv = { ...env, OCC_CONTAINER_ENGINE_SOCKET: "" };
  await command(binary, ["dev", "down", "--", ...composeOptions], { env: cliEnv });

  const projectLabels = labelFilters([[LABEL_COMPOSE_PROJECT, project]]);
  assert.deepEqual(await dockerLines(["ps", "-aq", ...projectLabels], { env }), []);
  assert.deepEqual(await dockerLines(["network", "ls", "-q", ...projectLabels], { env }), []);
  const databaseVolume = `${project}_occ_postgres_data`;
  const [retained, ...others] = inspectedObjects(
    await dockerJson(["volume", "inspect", databaseVolume], { env }),
    "PostgreSQL volume inspection",
  );
  assert.ok(retained && others.length === 0, "Expected exactly one retained PostgreSQL volume");
  assert.equal(retained.Name, databaseVolume);

  // A second cleanup must still find the retained database through the same
  // connection and delete it only with the operator's explicit --volumes flag.
  await command(binary, ["dev", "down", "--volumes", "--", ...composeOptions], {
    env: cliEnv,
  });
  assert.deepEqual(await dockerLines(["volume", "ls", "-q", ...projectLabels], { env }), []);
}

export async function composeDevelopmentCase(context: TestContext): Promise<void> {
  const {
    binary,
    directory: bootstrapDirectory,
    owned,
    bootstrapInputs,
    adminPassword,
    serviceKey,
  } = await buildCli(context);
  assert.equal(
    podmanSelected &&
      (process.env.OCC_TEST_OTEL_LOGS === "1" ||
        Boolean(process.env.OCC_TEST_OTEL_LOGS_JSONL) ||
        Boolean(process.env.OCC_TEST_OTEL_LOGS_URL)),
    false,
    "Podman does not support Docker Fluentd/OTLP logging proof",
  );
  const { runtime: runtimeImage, gateway: gatewayImage, agent: agentImage } = runtimeImages();
  const podmanComposeProvider = "podman-compose";
  let podmanSocket: string | undefined;
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
  // The worker's Driver preflight requires both runtime images, though no Agent starts.
  await Promise.all(
    [gatewayImage, agentImage].map((image) =>
      docker(["image", "inspect", image], { timeoutMs: 30_000 }),
    ),
  );

  const apiPort = await availablePort();
  const postgresPort = await availablePort();
  const project = `oce-${engineBinary}-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const namespaceIds = new Set<string>();
  const custody: { serviceKey?: string } = {};
  const adminEmail = `admin-${project}@example.test`;
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const otelLogs = createOtelLogObservation(context, {
    description: `${engineName} Compose development OTel logs`,
  });
  const loggingPort = otelLogs.enabled ? await availablePort() : undefined;
  const loggingMetricsPort = otelLogs.enabled ? await availablePort() : undefined;
  const composeOptions = {
    withLogging: otelLogs.enabled,
    removeApplicationImages: true,
  };
  const env: NodeJS.ProcessEnv = {
    ...composeEnvironment(),
    ...bootstrapInputs,
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
    OPENCLAW_DEV_EMAIL: adminEmail,
    OPENCLAW_DEV_INSTALLATION_NAME: `OpenClaw ${engineName} Compute ${project}`,
    OCC_DOCKER_RUNTIME_IMAGE: runtimeImage,
    OCC_DOCKER_GATEWAY_IMAGE: gatewayImage,
    OCC_DOCKER_AGENT_IMAGE: agentImage,
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
  };

  env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR = await composeSubnet(env);
  const composeSecrets = [adminPassword, serviceKey];
  owned.teardownProject = async () => {
    const cleanupServiceKey = custody.serviceKey;
    const cleanupNamespaceIds = new Set(namespaceIds);
    const secrets =
      cleanupServiceKey === undefined ? composeSecrets : [...composeSecrets, cleanupServiceKey];
    const discover = async () => {
      if (cleanupServiceKey === undefined) {
        return;
      }
      const listed = success(
        await apiClient(baseUrl, cleanupServiceKey)("GET", "/namespaces"),
        200,
        NamespaceListResponse,
      );
      for (const namespace of listed.data) {
        cleanupNamespaceIds.add(namespace.id);
      }
    };
    const discovery = await Promise.allSettled([discover()]);
    const teardown = await Promise.allSettled([
      cleanupProject(project, env, cleanupNamespaceIds, composeOptions, secrets),
    ]);
    throwCleanupFailures(
      [...discovery, ...teardown],
      "Compose Namespace discovery or teardown failed.",
    );
  };
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
  } catch (cause) {
    const logs = await composeFailureLogs(project, env, composeSecrets, composeOptions);
    throw new Error(`${engineName} Compose startup failed for ${project}:\n${logs}`, { cause });
  }

  await waitFor("OCC API to accept HTTP requests", async () => {
    const response = await fetch(new URL("/api/auth/session", baseUrl), {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
    return response?.status === 200 ? true : undefined;
  });
  const loggingContainers = await Promise.all(
    ["bootstrap", "controller", "worker"].map((service) =>
      composeServiceContainer(project, service, env),
    ),
  );
  assertDockerRuntimeOtelSettings(
    otelLogs,
    loggingContainers.map(({ observation }) => observation),
  );

  const {
    localFile: serviceKeyFile,
    installationId,
    servicePrincipalId: bootstrapServicePrincipalId,
  } = await prepareLocalServiceKey({
    project,
    env,
    directory: bootstrapDirectory,
    baseUrl,
    serviceKey,
  });
  custody.serviceKey = serviceKey;
  assert.equal(installationId.startsWith("ins_"), true);
  const cli = { binary, baseUrl, serviceKeyFile, secrets: [...composeSecrets, serviceKey] };
  const helperInstallation = checked(
    InstallationSchema,
    await runOcc({ ...cli, args: ["installation", "get"] }),
    "OCC CLI Installation",
  );
  assert.equal(helperInstallation.id, installationId);
  const helperNamespace = checked(
    NamespaceSchema,
    await runOcc({ ...cli, args: ["namespace", "create", `cleanup-${project}`] }),
    "OCC CLI Namespace",
  );
  namespaceIds.add(helperNamespace.id);
  assert.equal(helperNamespace.status, "provisioning");
  await rm(serviceKeyFile);
  await assert.rejects(
    stat(serviceKeyFile),
    (error) => error instanceof Error && "code" in error && error.code === "ENOENT",
    "temporary local CLI key file must be removed after CLI use",
  );

  const request = apiClient(baseUrl, serviceKey);

  const installation = success(await request("GET", "/installation"), 200, InstallationResponse);
  assert.equal(installation.data.name, env.OPENCLAW_DEV_INSTALLATION_NAME);
  assert.equal(installation.data.id, installationId);

  // Preserve development admission boundaries against the real Compose API listener.
  const unauthenticated = await request(
    "POST",
    "/namespaces",
    { name: `denied-unauthenticated-${project}` },
    { serviceKey: false },
  );
  refusal(unauthenticated, 401, "UNAUTHENTICATED", "Request without a service key");
  const invalidKey = `occ_invalid_${randomUUID()}`;
  const invalid = await request(
    "POST",
    "/namespaces",
    { name: `denied-invalid-key-${project}` },
    { serviceKey: invalidKey },
  );
  refusal(invalid, 401, "UNAUTHENTICATED", "Request with an invalid service key");
  assertNoSecretMaterial(invalid, [serviceKey], "invalid-key denial must not leak the valid key");
  const forwarded = await request(
    "POST",
    "/namespaces",
    { name: `denied-forwarded-${project}` },
    { headers: { forwarded: "for=203.0.113.10;proto=https;host=attacker.invalid" } },
  );
  refusal(forwarded, 403, "FORBIDDEN", "Request with untrusted forwarding headers");

  const modeNamespaces = new Map<ExecutionMode, Static<typeof NamespaceSchema>>();
  for (const mode of executionModes) {
    const created = success(
      await request("POST", "/namespaces", { name: `${mode}-${project}` }),
      201,
      NamespaceResponse,
    );
    namespaceIds.add(created.data.id);
    modeNamespaces.set(mode, created.data);
  }
  // The CLI emits the Namespace itself; HTTP responses retain the data envelope.
  const namespaces = [...modeNamespaces.values(), helperNamespace];
  await Promise.all(
    namespaces.map((namespace) =>
      waitFor(`Namespace ${namespace.id} to become ready`, async () => {
        const current = success(
          await request("GET", `/namespaces/${namespace.id}`),
          200,
          NamespaceResponse,
        );
        return current.data.status === "ready" ? current.data : undefined;
      }),
    ),
  );
  const networks = await Promise.all(
    namespaces.map((namespace) => waitForNamespaceNetwork(namespace.id, env)),
  );
  assert.equal(
    new Set(networks).size,
    namespaces.length,
    "each Namespace must receive a dedicated Docker network",
  );
  for (const namespace of namespaces) {
    assert.equal(
      await containerCount([[LABEL_NAMESPACE, namespace.id]], { env }),
      0,
      "Namespace provisioning must not start Agent-owned containers",
    );
  }

  // Docker Compute rejects every Harness authentication binding (see
  // docs/reference/drivers/docker-compute.md), so OCC admits no Agent deployment here.
  // TODO: assert real model turns, TUI attach and worker recovery for embedded and dedicated
  // Agents again when Docker Compute supports Harness authentication (a Compute Driver
  // contract change that needs an RFC).
  const agentIds: string[] = [];
  for (const [mode, { id: namespaceId }] of modeNamespaces) {
    agentIds.push(await assertHarnessAuthRefusal(request, namespaceId, mode));
    assert.equal(
      await containerCount([[LABEL_NAMESPACE, namespaceId]], { env }),
      0,
      `refused ${mode} deployment must not start Agent-owned containers`,
    );
  }

  // The worker completed Namespace work and claimed nothing for the refused Agents.
  await assertLifecycleDatabaseEvidence({
    project,
    env,
    bootstrapServicePrincipalId,
    serviceKey,
    namespaceIds: [...namespaceIds],
    agentIds,
  });
  const scrape = async (service: string) => {
    const container = await composeServiceContainer(project, service, env);
    const id = container.id;
    const { stdout } = await docker(
      [
        "exec",
        id,
        "node",
        "-e",
        "fetch('http://127.0.0.1:9464/metrics').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))",
      ],
      { env },
    );
    return stdout;
  };
  // Loopback metrics remain private inside each real API and worker container.
  assert.match(await scrape("worker"), /occ_work_oldest_pending_age_seconds/);
  assert.match(await scrape("controller"), /occ_http_request_duration_seconds_bucket/);

  await otelLogs.assertRecords({
    forbidden: [adminPassword, serviceKey],
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
    ],
  });

  if (otelLogs.enabled) {
    await assertCollectorOutageDoesNotBlockDockerOperations({
      project,
      env,
      composeOptions,
      request,
      namespaceId: helperNamespace.id,
      secrets: [adminPassword, serviceKey],
    });
  } else {
    await deleteEmptyNamespace({ request, namespaceId: helperNamespace.id, env });
  }
  // Deleting one Namespace leaves the other Namespaces' networks in place.
  for (const namespace of modeNamespaces.values()) {
    assert.equal((await inspectNetworks(namespace.id, env)).length, 1);
  }
  await assertComposeLogsDoNotLeakBootstrapServiceKey({ project, env, serviceKey });
}
