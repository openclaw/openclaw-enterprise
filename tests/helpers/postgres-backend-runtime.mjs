import assert from "node:assert/strict";
import pg from "pg";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createDevelopmentComputeDriver } from "./development.mjs";
import { authorizedPrincipal } from "./development-iam-state.ts";
import { createInstallationDriverConfiguration } from "./installation-driver-configuration.ts";
import { createTestConfigurationDriver } from "./configuration-driver.ts";
import { createTestSecretDriver } from "./secret-driver.mjs";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.mjs";
import { databaseUrl } from "./postgres-database.mjs";
import {
  backendDefinition,
  ensureInstallation,
  serviceAccountDriverId,
  trackNamespaces,
} from "./postgres-backend-state.ts";

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
  if (options.tokenServiceDriverId !== undefined) {
    installation.drivers.token_service = { id: options.tokenServiceDriverId };
  }
  if (backends.length > 0) {
    installation.drivers.service_account = {
      id: backends[0]?.drivers.service_account ?? serviceAccountDriverId,
    };
  }
  return {
    installation,
    computeDriver,
    ...(options.tokenService && { tokenService: options.tokenService }),
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
    driverConfigurations: options.driverConfigurations,
    nativeWorkerSupport: options.nativeWorkerSupport,
    now: options.now,
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
