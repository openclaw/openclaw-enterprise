import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { NativeIAMDriver, createAuthPrincipalSeed } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createDevelopmentComputeDriver } from "./development.mjs";
import { createDevelopmentIAMState } from "./development-iam-state.mjs";
import { createInstallationDriverConfiguration } from "./installation-driver-configuration.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.mjs";
import { stopProcess } from "./stop-process.mjs";
import { waitFor } from "./wait-for.mjs";
import { ensureDevelopmentBootstrap } from "./bootstrap-installation.mjs";
import { reservedPortArgs } from "./available-port.mjs";
import { databaseUrl, requiresPostgres } from "./postgres-database.mjs";

export { databaseUrl, requiresPostgres };

const repository = fileURLToPath(new URL("../..", import.meta.url));
const controllerEntrypoint = fileURLToPath(
  new URL("../../apps/controller/src/server.mjs", import.meta.url),
);
export const backendId = "openai";
export const serviceAccountDriverId = "chatgpt-service-accounts";
export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const alternateWorkspaceId = "22222222-2222-4222-8222-222222222222";
export const apiKeyPath = "/etc/openclaw/chatgpt/admin-key";
export function backendDefinition(options = {}) {
  return {
    id: backendId,
    type: "chatgpt",
    configuration: {
      workspaceId: options.workspaceId ?? workspaceId,
      apiKeyPath: options.apiKeyPath ?? apiKeyPath,
      ...(options.credentialTtlSeconds === undefined
        ? {}
        : { credentialTtlSeconds: options.credentialTtlSeconds }),
    },
    drivers: { service_account: options.serviceAccountDriverId ?? serviceAccountDriverId },
  };
}

export function authorizedPrincipal(iam, required = [["deploy", "agent"]]) {
  const roles = new Set(
    iam.roles
      .filter(({ permissions }) =>
        required.every(([action, resourceKind]) =>
          permissions.some(
            (permission) =>
              permission.action === action && permission.resourceKind === resourceKind,
          ),
        ),
      )
      .map(({ id }) => id),
  );
  return iam.identities.find(
    ({ id, kind }) =>
      kind === "principal" &&
      iam.bindings.some(
        (binding) =>
          binding.subjectKind === "identity" &&
          binding.subjectId === id &&
          binding.namespaceId === undefined &&
          binding.resourceKind === undefined &&
          roles.has(binding.roleId),
      ),
  );
}

export async function ensureInstallation(state, label) {
  const existing = await state.loadInstallation();
  if (existing !== undefined) {
    return existing;
  }

  const installation = {
    id: `ins_${randomUUID()}`,
    name: `${label} PostgreSQL integration`,
    createdAt: new Date().toISOString(),
  };
  state.setBootstrapNativeIAM(
    createDevelopmentIAMState(
      createAuthPrincipalSeed(
        installation.id,
        label,
        {
          id: `account-${label}-${randomUUID()}`,
        },
        { grant: "administrator" },
      ),
    ),
  );
  await state.transact((unit) => unit.installations.createInstallation(installation));
  return installation;
}
async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupNamespaces(pool, namespaceIds) {
  if (namespaceIds.length === 0) {
    return;
  }
  await inTransaction(pool, async (client) => {
    await client.query(
      `UPDATE occ.controller_work
       SET state = 'failed_permanent',
           completed_at = clock_timestamp(),
           reason_code = 'TEST_FIXTURE_CLEANUP',
           claim_token = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
       WHERE namespace_id = ANY($1::text[]) AND state IN ('queued', 'claimed')`,
      [namespaceIds],
    );
    await client.query(
      `UPDATE occ.agents
       SET backend_id = NULL,
           harness_auth = NULL,
           active_revision_id = NULL
       WHERE namespace_id = ANY($1::text[])`,
      [namespaceIds],
    );
    await client.query("DELETE FROM occ.service_accounts WHERE namespace_id = ANY($1::text[])", [
      namespaceIds,
    ]);
  });
}

export async function cleanupBackendFixtures(pool, namespaceId, cleanup) {
  if (
    [cleanup.serviceAccountIds, cleanup.agentIds, cleanup.revisionIds].every(
      (ids) => ids.length === 0,
    )
  ) {
    return;
  }
  await inTransaction(pool, async (client) => {
    await client.query(
      `UPDATE occ.controller_work
       SET state = 'failed_permanent',
           claim_token = NULL,
           lease_expires_at = NULL,
           completed_at = clock_timestamp(),
           reason_code = 'TEST_FIXTURE_CLEANUP',
           updated_at = clock_timestamp()
       WHERE namespace_id = $1
         AND revision_id = ANY($2::text[])
         AND state IN ('queued', 'claimed')`,
      [namespaceId, cleanup.revisionIds],
    );
    await client.query(
      `UPDATE occ.agents
       SET backend_id = NULL, harness_auth = NULL, active_revision_id = NULL
       WHERE namespace_id = $1 AND id = ANY($2::text[])`,
      [namespaceId, cleanup.agentIds],
    );
    await client.query(
      "DELETE FROM occ.service_accounts WHERE namespace_id = $1 AND id = ANY($2::text[])",
      [namespaceId, cleanup.serviceAccountIds],
    );
  });
}

function trackNamespaces(context, pool, close) {
  const namespaceIds = new Set();
  context.after(async () => {
    if (close !== undefined) {
      await close();
    }
    await cleanupNamespaces(pool, [...namespaceIds]);
    await pool.end();
  });
  return {
    track(namespace) {
      namespaceIds.add(namespace.id);
      return namespace;
    },
    async cleanup(...namespaces) {
      const ids = namespaces.filter(Boolean).map(({ id }) => id);
      await cleanupNamespaces(pool, ids);
      for (const id of ids) {
        namespaceIds.delete(id);
      }
    },
  };
}

export async function createAccessTokenServiceAccount(state, namespaceId, label) {
  const id = `sa_${randomUUID()}`;
  return state.transact((unit) =>
    unit.serviceAccounts.createServiceAccount({
      id,
      namespaceId,
      name: `${label}-${randomUUID()}`,
      credential: {
        kind: "access_token",
        secretRef: {
          name: `service-account-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`,
          key: "token",
        },
      },
    }),
  );
}

export async function seedBackendBinding(pool, account, options = {}) {
  await pool.query(
    `INSERT INTO occ.service_account_driver_bindings
       (service_account_id, namespace_id, backend_id, driver_id, external_account_id,
        external_credential_id, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      account.id,
      account.namespaceId,
      options.backendId ?? backendId,
      options.driverId ?? serviceAccountDriverId,
      `external-account-${randomUUID()}`,
      options.credentialIssued === false ? null : `external-credential-${randomUUID()}`,
      options.workspaceId ?? workspaceId,
    ],
  );
}

export function registerCoreDrivers(controller, state, options = {}) {
  const iam = new NativeIAMDriver(state, { id: "native-iam", implementation: "native" });
  const harnessAuthDriver = createTestKubernetesComputeDriver("backend-state-harness-auth");
  const compute = {
    ...createDevelopmentComputeDriver(),
    validateHarnessAuth: harnessAuthDriver.validateHarnessAuth.bind(harnessAuthDriver),
  };
  const configuration = createTestConfigurationDriver();
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  controller.registerDriver(compute);
  controller.selectDriver("compute", compute.id);
  controller.registerDriver(configuration);
  controller.selectDriver("configuration", configuration.id);
  if (options.serviceAccountDriverId !== undefined) {
    const driver = {
      id: options.serviceAccountDriverId,
      capability: "service_account",
      implementation: "chatgpt",
      async create() {
        assert.fail("Backend fixtures seed external account bindings directly.");
      },
      async createCredential() {
        assert.fail("Backend fixtures seed external credentials directly.");
      },
      async delete() {
        assert.fail("Backend fixtures do not delete upstream accounts.");
      },
    };
    controller.registerDriver(driver);
    controller.selectDriver("service_account", driver.id);
  }
  return { compute, configuration };
}

export function createBackendWorkerDrivers(
  computeDriver,
  backends = [backendDefinition()],
  options = {},
) {
  const installation = createInstallationDriverConfiguration();
  installation.backend = backends;
  installation.drivers.compute.id = computeDriver.id;
  if (options.secretDriver !== undefined) {
    installation.drivers.secret.id = options.secretDriver.id;
  }
  if (backends.length > 0) {
    installation.drivers.service_account = {
      id: backends[0]?.drivers.service_account ?? serviceAccountDriverId,
    };
  }
  return {
    installation,
    computeDriver,
    configurationDriver: createTestConfigurationDriver({
      id: installation.drivers.configuration.id,
    }),
    secretDriver:
      options.secretDriver ?? createTestSecretDriver({ id: installation.drivers.secret.id }),
    createIAMDriver(platformState) {
      return new NativeIAMDriver(platformState, {
        id: installation.drivers.iam.id,
        implementation: "native",
      });
    },
  };
}

export function createBackendController(fixture, options = {}) {
  const backends = options.backends ?? [backendDefinition()];
  const controller = new OpenClawController(fixture.installation, {
    state: fixture.state,
    backends,
    nativeWorkerSupport: options.nativeWorkerSupport,
  });
  registerCoreDrivers(controller, fixture.state, {
    serviceAccountDriverId: backends[0]?.drivers.service_account,
  });
  return controller;
}

export async function createBackendFixture(context) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const workerPool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const state = new PostgresPlatformState(pool);
  let worker;
  const namespaces = trackNamespaces(context, pool, async () => {
    if (worker === undefined) {
      await workerPool.end();
    } else {
      await worker.stop();
    }
  });

  const installation = await ensureInstallation(state, "backend-ownership");
  const actor = authorizedPrincipal(await state.loadNativeIAMState(), [
    ["create", "configuration"],
    ["create", "agent"],
    ["update", "agent"],
    ["deploy", "agent"],
    ["read", "configuration"],
    ["read", "service_account"],
    ["read", "agent_revision"],
  ]);
  assert.ok(actor, "persisted IAM must contain an unrestricted backend-ownership Principal");

  function startWorker(options = {}) {
    const calls = [];
    const harnessAuthDriver = createTestKubernetesComputeDriver("backend-worker-harness-auth");
    const compute = {
      ...createDevelopmentComputeDriver(),
      validateHarnessAuth: harnessAuthDriver.validateHarnessAuth.bind(harnessAuthDriver),
    };
    const backends = options.backends ?? [backendDefinition()];
    const drivers = createBackendWorkerDrivers(
      {
        ...compute,
        async prepareRevision(revision, operationContext) {
          calls.push({
            action: "prepare",
            revisionId: revision.id,
            backendId: revision.backendId,
          });
          return compute.prepareRevision(revision, operationContext);
        },
        async retireRevision(revision) {
          calls.push({
            action: "retire",
            revisionId: revision.id,
            backendId: revision.backendId,
          });
          return compute.retireRevision(revision);
        },
      },
      backends,
      options,
    );
    worker = createControllerWorker({
      pool: workerPool,
      drivers,
      pollIntervalMs: 15,
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      emit: () => {},
    });
    return { worker, calls };
  }

  return { pool, state, workerPool, installation, actor, ...namespaces, startWorker };
}

export async function createBootstrappedBackendState(context, options) {
  await ensureDevelopmentBootstrap(context, {
    databaseUrl,
    email: options.email,
    password: options.password,
    authSecret: options.authSecret,
    authBaseURL: options.origin,
    installationName: options.installationName,
    environment: { PATH: process.env.PATH },
  });

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const state = new PostgresPlatformState(pool);
  const namespaces = trackNamespaces(context, pool);
  const configurationRoot = await mkdtemp(join(tmpdir(), "openclaw-backend-repair-config-"));
  context.after(() => rm(configurationRoot, { recursive: true, force: true }));
  return { pool, state, configurationRoot, ...namespaces };
}

export function poolWithOneBackendBindingReadFault(pool) {
  let remainingFailures = 1;
  const shouldFault = (text) =>
    remainingFailures > 0 &&
    typeof text === "string" &&
    text.includes("FROM occ.service_account_driver_bindings AS b") &&
    text.includes("WHERE b.namespace_id = $1 AND b.service_account_id = $2");
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          if (shouldFault(text)) {
            remainingFailures -= 1;
            throw new Error("simulated transient Backend binding metadata read failure");
          }
          return client.query(text, values);
        },
        release: () => client.release(),
      };
    },
    query: (text, values) => pool.query(text, values),
    end: () => pool.end(),
  };
}

export async function startBackendlessDevelopmentServer(context, options) {
  const configurationRoot =
    options.configurationRoot ?? (await mkdtemp(join(tmpdir(), "openclaw-backend-repair-config-")));
  if (options.configurationRoot === undefined) {
    context.after(() => rm(configurationRoot, { recursive: true, force: true }));
  }

  // `options.reservation` (from reservePort) holds the API port. This releases it once the
  // child logs that it is listening; if the child never does, the caller's after-hook must.
  const child = spawn(
    process.execPath,
    [...reservedPortArgs(options.reservation), controllerEntrypoint],
    {
      cwd: repository,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "development",
        OCC_HOST: "127.0.0.1",
        OCC_PORT: String(options.reservation.port),
        OCC_DATABASE_URL: databaseUrl,
        OCC_AUTH_BASE_URL: options.origin,
        OCC_AUTH_SECRET: options.authSecret,
        OCC_DEVELOPMENT_CONFIGURATION_ROOT: configurationRoot,
        OCC_DOCKER_RUNTIME_IMAGE: "openclaw-enterprise-runtime:not-used-by-backend-repair",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  context.after(() => stopProcess(child));

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  await waitFor(
    "backendless development API to start despite stale Backend references",
    async () => {
      assert.equal(child.exitCode, null, `The OCC subprocess exited early:\n${output}`);
      return /"event"\s*:\s*"listening"/.test(output) || undefined;
    },
    15_000,
  );
  await options.reservation.release();
  return { child };
}
